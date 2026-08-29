use crate::lock::lock;
use crate::state::{publish, Board, Workspace};
use crate::{i18n, scripts, AppState};
use std::collections::HashSet;
use std::path::Path;
use tauri::{AppHandle, State};

/// O que será executável depois de confiar num clone. A tela mostra isto antes
/// da confirmação; ler o arquivo é seguro, rodá-lo é que depende da escolha.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustPreview {
    pub id: String,
    pub name: String,
    pub path: String,
    pub file: Option<String>,
    pub setup: Option<String>,
    pub runs: Vec<scripts::Run>,
    pub archive: Option<String>,
    pub copy: Vec<String>,
}

#[tauri::command]
pub fn project_trust_preview(
    state: State<AppState>,
    ids: Vec<String>,
) -> Result<Vec<TrustPreview>, String> {
    let board = lock(&state.board);
    ids.into_iter()
        .map(|id| {
            let project = board
                .projects
                .iter()
                .find(|project| project.id == id)
                .ok_or_else(|| i18n::t("err.session.noProject"))?;
            let found = scripts::read_for(Path::new(&project.path), Path::new(&project.path));
            Ok(TrustPreview {
                id: project.id.clone(),
                name: project.name.clone(),
                path: project.path.clone(),
                file: found.file,
                setup: found.setup,
                runs: found.runs,
                archive: found.archive,
                copy: found.copy,
            })
        })
        .collect()
}

/// Confiar é uma decisão persistida e explícita. `false` existe para a futura
/// tela de revogação e, desde já, deixa o contrato correto para automações.
#[tauri::command]
pub fn set_projects_trusted(
    app: AppHandle,
    state: State<AppState>,
    ids: Vec<String>,
    trusted: bool,
) -> Result<(), String> {
    let wanted: HashSet<String> = ids.into_iter().collect();
    if wanted.is_empty() {
        return Err(i18n::t("err.session.noProject"));
    }
    {
        let mut board = lock(&state.board);
        if wanted
            .iter()
            .any(|id| !board.projects.iter().any(|project| &project.id == id))
        {
            return Err(i18n::t("err.session.noProject"));
        }
        for project in &mut board.projects {
            if wanted.contains(&project.id) {
                project.trusted = trusted;
            }
        }
    }
    publish(&app);
    Ok(())
}

fn untrusted(names: impl IntoIterator<Item = String>) -> String {
    i18n::ta(
        "err.session.untrusted",
        &[("names", names.into_iter().collect::<Vec<_>>().join(", "))],
    )
}

pub(crate) fn ensure_paths_trusted(
    board: &Board,
    paths: impl IntoIterator<Item = String>,
) -> Result<(), String> {
    let missing: Vec<String> = paths
        .into_iter()
        .filter_map(|path| {
            if board
                .projects
                .iter()
                .any(|project| project.path == path && project.trusted)
            {
                None
            } else {
                Some(
                    board
                        .projects
                        .iter()
                        .find(|project| project.path == path)
                        .map(|project| project.name.clone())
                        .unwrap_or(path),
                )
            }
        })
        .collect();
    if missing.is_empty() {
        Ok(())
    } else {
        Err(untrusted(missing))
    }
}

pub(crate) fn ensure_workspace_trusted(board: &Board, ws: &Workspace) -> Result<(), String> {
    if board.trusts_workspace(ws) {
        Ok(())
    } else {
        Err(untrusted(ws.repos.iter().filter_map(|repo| {
            if board
                .projects
                .iter()
                .any(|project| project.path == repo.path && project.trusted)
            {
                None
            } else {
                Some(repo.name.clone())
            }
        })))
    }
}

#[cfg(test)]
mod tests {
    use super::ensure_paths_trusted;
    use crate::state::{Board, Project};

    #[test]
    fn executar_exige_confianca_explicita_em_todos_os_repositorios() {
        let mut board = Board {
            projects: vec![
                Project {
                    id: "a".into(),
                    name: "A".into(),
                    path: "/a".into(),
                    trusted: true,
                },
                Project {
                    id: "b".into(),
                    name: "B".into(),
                    path: "/b".into(),
                    trusted: false,
                },
            ],
            ..Board::default()
        };
        assert!(ensure_paths_trusted(&board, ["/a".to_string()]).is_ok());
        assert!(ensure_paths_trusted(&board, ["/a".to_string(), "/b".to_string()]).is_err());
        board.projects[1].trusted = true;
        assert!(ensure_paths_trusted(&board, ["/a".to_string(), "/b".to_string()]).is_ok());
    }
}
