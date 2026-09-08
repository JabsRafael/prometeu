//! The frontend owns relay transport and terminal forwarding. The backend only stores private
//! team.json outside localStorage, preserving the frontend-owned format without interpreting it.

use crate::{i18n, paths};
use serde::Serialize;
use serde_json::Value;

/// Return stored team configuration and the local username as a suggested display name.
#[derive(Serialize)]
pub struct TeamFile {
    pub config: Option<Value>,
    pub default_name: String,
}

#[tauri::command]
pub fn team_config() -> TeamFile {
    let config = std::fs::read_to_string(paths::team_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok());
    let default_name = std::env::var("USER").unwrap_or_default();
    TeamFile {
        config,
        default_name,
    }
}

/// None leaves the team by removing its configuration file.
#[tauri::command]
pub fn team_config_set(config: Option<Value>) -> Result<(), String> {
    let path = paths::team_path();
    let wrap = |cause: String| {
        i18n::ta(
            "err.team.write",
            &[("path", path.display().to_string()), ("cause", cause)],
        )
    };
    match config {
        None => match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(wrap(e.to_string())),
        },
        Some(value) => {
            if value.get("cloud").is_some() {
                if let Ok(previous) = std::fs::read_to_string(&path) {
                    if serde_json::from_str::<Value>(&previous)
                        .ok()
                        .is_some_and(|old| old.get("cloud").is_none())
                    {
                        let backup = path
                            .with_file_name(format!("team-legacy-{}.json", uuid::Uuid::new_v4()));
                        paths::write_private(&backup, &previous).map_err(wrap)?;
                    }
                }
            }
            let body = serde_json::to_string_pretty(&value).map_err(|e| wrap(e.to_string()))?;
            paths::write_private(&path, &body).map_err(wrap)
        }
    }
}
