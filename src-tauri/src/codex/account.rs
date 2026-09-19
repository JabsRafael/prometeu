//! Use official app-server authentication without opening a thread or sending prompts.

use crate::{
    accounts::{self, AuthProcess, Identity, Profile},
    i18n, oauth, paths,
};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{atomic::AtomicBool, Arc};
use std::time::Duration;

pub fn user_home() -> PathBuf {
    let configured = std::env::var_os("CODEX_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| paths::home().join(".codex"));
    if configured.is_absolute() {
        configured
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| paths::home())
            .join(configured)
    }
}

pub fn account_env(command: &mut Command, profile: &Profile) {
    command.env("CODEX_HOME", &profile.home);
    if profile.managed {
        for key in [
            "OPENAI_API_KEY",
            "CODEX_API_KEY",
            "CODEX_ACCESS_TOKEN",
            "OPENAI_BASE_URL",
            "CODEX_CHATGPT_BASE_URL",
        ] {
            command.env_remove(key);
        }
    }
}

pub fn prepare_profile(profile: &Profile) -> Result<(), String> {
    prepare_profile_at(&user_home(), &profile.home)
}

fn prepare_profile_at(base: &Path, home: &Path) -> Result<(), String> {
    // Share the same rollout and native index across account changes. Never link auth.json into the
    // profile.
    for name in [
        "sessions",
        "archived_sessions",
        "skills",
        "plugins",
        "packages",
        "agents",
        "rules",
        "memories",
        "thread-writer-locks",
    ] {
        accounts::share(base, home, name, true)?;
    }
    for name in ["AGENTS.md", "hooks.json"] {
        accounts::share(base, home, name, false)?;
    }
    let body = match std::fs::read_to_string(base.join("config.toml")) {
        Ok(body) => body,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(i18n::io(error)),
    };
    let mut config: toml::Table = toml::from_str(&body).map_err(i18n::io)?;
    config.insert("cli_auth_credentials_store".into(), "file".into());
    config.insert("model_provider".into(), "openai".into());
    for name in ["openai_base_url", "chatgpt_base_url", "profile"] {
        config.remove(name);
    }
    if let Some(providers) = config
        .get_mut("model_providers")
        .and_then(toml::Value::as_table_mut)
    {
        providers.remove("openai");
    }
    let sqlite = config
        .get("sqlite_home")
        .and_then(toml::Value::as_str)
        .map(PathBuf::from)
        .unwrap_or_else(|| base.to_path_buf());
    let sqlite = if sqlite.is_absolute() {
        sqlite
    } else {
        base.join(sqlite)
    };
    config.insert(
        "sqlite_home".into(),
        sqlite.to_string_lossy().to_string().into(),
    );
    paths::write_private(
        &home.join("config.toml"),
        &toml::to_string(&config).map_err(i18n::io)?,
    )
    .map_err(i18n::io)
}

struct Server {
    process: AuthProcess,
    next: u64,
    completed: Option<Value>,
}

impl Server {
    fn start(
        profile: &Profile,
        timeout: Duration,
        cancel: Arc<AtomicBool>,
    ) -> Result<Self, String> {
        let mut command = Command::new("codex");
        command.arg("app-server").current_dir(paths::home());
        account_env(&mut command, profile);
        Self::from_command(command, timeout, cancel)
    }

    fn from_command(
        command: Command,
        timeout: Duration,
        cancel: Arc<AtomicBool>,
    ) -> Result<Self, String> {
        let mut server = Self {
            process: AuthProcess::spawn(command, timeout, cancel)?,
            next: 0,
            completed: None,
        };
        server.call(
            "initialize",
            json!({"clientInfo":{"name":"prometeu-accounts","version":env!("CARGO_PKG_VERSION")}}),
        )?;
        server.process.send(&json!({"method":"initialized"}))?;
        Ok(server)
    }

    fn message(&mut self) -> Result<Value, String> {
        loop {
            let line = self
                .process
                .line()?
                .ok_or_else(|| i18n::t("err.account.status"))?;
            if let Ok(value) = serde_json::from_str(&line) {
                return Ok(value);
            }
        }
    }

    fn call(&mut self, method: &str, params: Value) -> Result<Value, String> {
        self.next += 1;
        self.process
            .send(&json!({"id":self.next,"method":method,"params":params}))?;
        loop {
            let value = self.message()?;
            if value["id"].as_u64() == Some(self.next) {
                if value.get("error").is_some() {
                    return Err(i18n::t("err.account.status"));
                }
                return value
                    .get("result")
                    .cloned()
                    .ok_or_else(|| i18n::t("err.account.status"));
            }
            if value["method"] == "account/login/completed" {
                self.completed = Some(value["params"].clone());
            }
        }
    }

    fn identity(&mut self) -> Result<Identity, String> {
        parse_account(&self.call("account/read", json!({"refreshToken":true}))?)
    }
}

fn parse_account(value: &Value) -> Result<Identity, String> {
    let account = value
        .get("account")
        .ok_or_else(|| i18n::t("err.account.status"))?;
    Ok(Identity {
        connected: !account.is_null(),
        email: account["email"].as_str().map(str::to_string),
        plan: account["planType"].as_str().map(str::to_string),
    })
}

pub fn account_probe(profile: &Profile) -> Result<(Identity, Option<Value>), String> {
    let mut server = Server::start(
        profile,
        Duration::from_secs(20),
        Arc::new(AtomicBool::new(false)),
    )?;
    let identity = server.identity()?;
    let usage = if identity.connected {
        server.call("account/rateLimits/read", json!({})).ok()
    } else {
        None
    };
    Ok((identity, usage))
}

pub fn login(profile: &Profile, cancel: Arc<AtomicBool>) -> Result<Identity, String> {
    let mut server = Server::start(profile, Duration::from_secs(600), cancel)?;
    let started = server.call("account/login/start", json!({"type":"chatgpt"}))?;
    let url = started["authUrl"]
        .as_str()
        .ok_or_else(|| i18n::t("err.account.login"))?;
    let parsed = reqwest::Url::parse(url).map_err(|_| i18n::t("err.account.login"))?;
    if parsed.scheme() != "https"
        || !matches!(parsed.host_str(), Some("auth.openai.com" | "chatgpt.com"))
    {
        return Err(i18n::t("err.account.login"));
    }
    oauth::browse(url)?;
    loop {
        let completed = match server.completed.take() {
            Some(value) => value,
            None => {
                let message = server.message()?;
                if message["method"] != "account/login/completed" {
                    continue;
                }
                message["params"].clone()
            }
        };
        if completed["loginId"] != started["loginId"] {
            continue;
        }
        if completed["success"] != true {
            return Err(i18n::t("err.account.login"));
        }
        let identity = server.identity()?;
        if !identity.connected {
            return Err(i18n::t("err.account.login"));
        }
        return Ok(identity);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "precisa do Codex instalado; não faz login nem envia prompts"]
    fn perfil_vazio_nao_herda_login_do_terminal() {
        let id = uuid::Uuid::new_v4().to_string();
        let home = std::env::temp_dir().join(format!("prometeu-codex-auth-{id}"));
        paths::ensure_private_dir(&home).unwrap();
        let profile = Profile {
            auth_method: None,
            id,
            provider: crate::state::ProviderId::Codex,
            home: home.clone(),
            managed: true,
            revision: 0,
        };
        let result = account_probe(&profile);
        std::fs::remove_dir_all(home).unwrap();
        assert!(!result.unwrap().0.connected);
    }

    #[test]
    fn perfis_retoman_o_mesmo_rollout_com_credenciais_separadas() {
        let root =
            std::env::temp_dir().join(format!("prometeu-codex-accounts-{}", uuid::Uuid::new_v4()));
        let base = root.join("base");
        let first = root.join("first");
        let second = root.join("second");
        for home in [&base, &first, &second] {
            paths::ensure_private_dir(home).unwrap();
        }
        std::fs::write(base.join("auth.json"), "login original").unwrap();
        std::fs::write(base.join("config.toml"), "cli_auth_credentials_store = 'keyring'\nmodel_provider = 'custom'\n[features]\nplugins = true\n").unwrap();
        prepare_profile_at(&base, &first).unwrap();
        prepare_profile_at(&base, &second).unwrap();
        std::fs::write(first.join("auth.json"), "conta um").unwrap();
        std::fs::write(second.join("auth.json"), "conta dois").unwrap();
        std::fs::write(first.join("sessions/rollout.jsonl"), "mesma thread").unwrap();
        prepare_profile_at(&base, &first).unwrap();
        assert_eq!(
            std::fs::read_to_string(second.join("sessions/rollout.jsonl")).unwrap(),
            "mesma thread"
        );
        assert_eq!(
            std::fs::read_to_string(base.join("auth.json")).unwrap(),
            "login original"
        );
        assert_eq!(
            std::fs::read_to_string(first.join("auth.json")).unwrap(),
            "conta um"
        );
        assert_eq!(
            std::fs::read_to_string(second.join("auth.json")).unwrap(),
            "conta dois"
        );
        let config: toml::Table =
            toml::from_str(&std::fs::read_to_string(first.join("config.toml")).unwrap()).unwrap();
        assert_eq!(config["sqlite_home"].as_str(), base.to_str());
        assert_eq!(config["cli_auth_credentials_store"].as_str(), Some("file"));
        assert_eq!(config["model_provider"].as_str(), Some("openai"));
        assert_eq!(config["features"]["plugins"].as_bool(), Some(true));
        std::fs::write(base.join("config.toml"), "sqlite_home = 'state'\n").unwrap();
        prepare_profile_at(&base, &second).unwrap();
        let config: toml::Table =
            toml::from_str(&std::fs::read_to_string(second.join("config.toml")).unwrap()).unwrap();
        assert_eq!(config["sqlite_home"].as_str(), base.join("state").to_str());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn protocolo_de_conta_153_nao_abre_thread_e_correlaciona_respostas() {
        let mut command = Command::new("python3");
        command.args(["-u", "-c", r#"
import sys,json
def read(): return json.loads(sys.stdin.readline())
first=read()
assert first['method']=='initialize'
print(json.dumps({'id':first['id'],'result':{'userAgent':'fixture'}}),flush=True)
assert read()['method']=='initialized'
account=read()
assert account['method']=='account/read'
assert account['params']['refreshToken'] is True
print(json.dumps({'method':'account/updated','params':{'authMode':'chatgpt','planType':'pro'}}),flush=True)
print(json.dumps({'id':account['id'],'result':{'account':{'type':'chatgpt','email':'pessoa@example.com','planType':'pro'},'requiresOpenaiAuth':True}}),flush=True)
read()
"#]);
        let mut server = Server::from_command(
            command,
            Duration::from_secs(5),
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap();
        let identity = server.identity().unwrap();
        assert!(identity.connected);
        assert_eq!(identity.email.as_deref(), Some("pessoa@example.com"));
        assert!(
            !parse_account(&json!({"account":null,"requiresOpenaiAuth":true}))
                .unwrap()
                .connected
        );
        assert!(parse_account(&json!({})).is_err());
    }
}
