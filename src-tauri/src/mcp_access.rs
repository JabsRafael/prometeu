//! Transport-independent MCP client identity and private, revocable local credentials.

use crate::{paths, state::Board};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

#[derive(Clone, Serialize, Deserialize)]
pub struct Client {
    pub id: String,
    pub conversation: Option<String>,
    pub projects: Vec<String>,
}

impl Client {
    pub fn conversation(id: &str) -> Self {
        Self {
            id: id.into(),
            conversation: Some(id.into()),
            projects: vec![],
        }
    }

    pub fn validate(&self, board: &Board) -> Result<(), String> {
        if self
            .conversation
            .as_ref()
            .is_some_and(|id| board.workspace_of(id).is_none())
        {
            return Err("coordinator_unavailable".into());
        }
        Ok(())
    }

    pub fn allows(&self, board: &Board, path: &str) -> bool {
        match &self.conversation {
            Some(id) => board.workspace_of(id).is_some_and(|workspace| {
                workspace.primary().path == path
                    || workspace.repos.iter().any(|repo| repo.path == path)
            }),
            None => self.projects.iter().any(|project| project == path),
        }
    }
}

#[derive(Serialize, Deserialize)]
struct Credential {
    version: u8,
    name: String,
    token: String,
    client: Client,
}

fn credential_path(root: &Path, id: &str) -> Result<PathBuf, String> {
    let id = uuid::Uuid::parse_str(id).map_err(|_| "invalid_client_id")?;
    Ok(root.join("mcp-clients").join(format!("{id}.json")))
}

pub fn authenticate(root: &Path, token: &str) -> Result<Client, String> {
    let (id, _) = token.split_once('.').ok_or("unauthorized")?;
    let read = || -> Result<Client, String> {
        let file = credential_path(root, id)?;
        let credential: Credential =
            serde_json::from_str(&std::fs::read_to_string(file).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        if credential.version != 1
            || credential.token != token
            || credential.client.id != format!("client:{id}")
            || credential.client.conversation.is_some()
            || credential.client.projects.is_empty()
        {
            return Err("unauthorized".into());
        }
        Ok(credential.client)
    };
    read().map_err(|_| "unauthorized".into())
}

fn register(root: &Path, name: &str, projects: Vec<String>) -> Result<(String, String), String> {
    if name.trim().is_empty() || name.len() > 200 || projects.is_empty() {
        return Err("A client name and at least one project are required".into());
    }
    let id = uuid::Uuid::new_v4().to_string();
    let token = format!("{id}.{}", uuid::Uuid::new_v4());
    let credential = Credential {
        version: 1,
        name: name.into(),
        token: token.clone(),
        client: Client {
            id: format!("client:{id}"),
            conversation: None,
            projects,
        },
    };
    paths::write_private(
        &credential_path(root, &id)?,
        &serde_json::to_string(&credential).map_err(|e| e.to_string())?,
    )?;
    Ok((id, token))
}

/// Local administration is deliberately outside the agent-facing tools. Only explicit registration
/// grants access; listing clients never prints their credentials.
pub fn cli(args: &[String]) -> Result<Value, String> {
    let root = paths::root();
    match args.first().map(String::as_str) {
        Some("projects") if args.len() == 1 => {
            Ok(json!({"projects": projects(&root)?}))
        }
        Some("register") if args.len() >= 3 => {
            let available = projects(&root)?;
            let scope = args[2..].iter().map(|id| {
                available.iter().find(|project| project.id == *id)
                    .map(|project| project.path.clone()).ok_or_else(|| format!("Unknown project: {id}"))
            }).collect::<Result<Vec<_>, _>>()?;
            let executable = std::env::current_exe().map_err(|e| e.to_string())?;
            let root = root.canonicalize().map_err(|e| e.to_string())?;
            let (id, token) = register(&root, &args[1], scope)?;
            Ok(json!({"client_id":id, "mcpServers":{"prometeu":{
                "type":"stdio", "command":executable, "args":["--prometeu-mcp"],
                "env":{"PROMETEU_ROOT":root,"PROMETEU_MCP_TOKEN":token}
            }}}))
        }
        Some("list") if args.len() == 1 => {
            let directory = root.join("mcp-clients");
            if !directory.exists() { return Ok(json!({"clients":[]})); }
            let mut clients = vec![];
            for entry in std::fs::read_dir(directory).map_err(|e| e.to_string())? {
                let path = entry.map_err(|e| e.to_string())?.path();
                if path.extension().is_none_or(|extension| extension != "json") { continue; }
                let credential: Credential = serde_json::from_str(&std::fs::read_to_string(&path).map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?;
                clients.push(json!({"id":path.file_stem().and_then(|id| id.to_str()),"name":credential.name,"projects":credential.client.projects}));
            }
            Ok(json!({"clients":clients}))
        }
        Some("revoke") if args.len() == 2 => {
            std::fs::remove_file(credential_path(&root, &args[1])?).map_err(|e| e.to_string())?;
            Ok(json!({"revoked":args[1]}))
        }
        _ => Err("Usage: --prometeu-mcp-client projects | register NAME PROJECT_ID... | list | revoke CLIENT_ID".into()),
    }
}

fn projects(root: &Path) -> Result<Vec<crate::state::Project>, String> {
    // Read only the project catalog. Never revive, save or mutate the running app's board.
    let board: Value = serde_json::from_str(
        &std::fs::read_to_string(root.join("board.json")).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    serde_json::from_value(board["projects"].clone()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn independent_clients_survive_reload_and_fail_closed_after_revocation() {
        let root = std::env::temp_dir().join(format!("prometeu-access-{}", uuid::Uuid::new_v4()));
        let (id, token) = register(&root, "external agent", vec!["/repo".into()]).unwrap();
        let (_, other) = register(&root, "other agent", vec!["/other".into()]).unwrap();
        let board: Board = serde_json::from_value(json!({"stages":[],"workspaces":[]})).unwrap();
        let client = authenticate(&root, &token).unwrap();
        assert_eq!(client.id, format!("client:{id}"));
        assert!(client.validate(&board).is_ok());
        assert!(client.allows(&board, "/repo"));
        assert!(!client.allows(&board, "/other"));
        assert!(authenticate(&root, &format!("{id}.wrong")).is_err());
        assert!(authenticate(&root, "../escape.secret").is_err());
        let path = credential_path(&root, &id).unwrap();
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            std::fs::metadata(path.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(authenticate(&root, &token).unwrap().id, client.id);
        paths::write_private(&path, "broken").unwrap();
        assert!(authenticate(&root, &token).is_err());
        std::fs::remove_file(path).unwrap();
        assert!(authenticate(&root, &token).is_err());
        assert!(authenticate(&root, &other).is_ok());
        std::fs::remove_dir_all(root).unwrap();
    }
}
