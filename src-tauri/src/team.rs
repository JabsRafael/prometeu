//! O time mora no front: quem fala com o relay é a webview (`src/team.ts`),
//! que já recebe todo byte de todo terminal e já sabe escrever neles. O back
//! só guarda `team.json` — o segredo do time, com permissão restrita, fora do
//! `localStorage` — e não lê o que há dentro: o formato é do front.

use crate::{i18n, paths};
use serde::Serialize;
use serde_json::Value;

/// O que o front recebe ao subir: o arquivo, se existe, e um nome para
/// sugerir a quem ainda não escolheu o seu — o usuário deste Mac.
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
    TeamFile { config, default_name }
}

/// `None` é sair do time: o arquivo some.
#[tauri::command]
pub fn team_config_set(config: Option<Value>) -> Result<(), String> {
    let path = paths::team_path();
    let wrap = |cause: String| i18n::ta("err.team.write", &[("path", path.display().to_string()), ("cause", cause)]);
    match config {
        None => match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(wrap(e.to_string())),
        },
        Some(value) => {
            let body = serde_json::to_string_pretty(&value).map_err(|e| wrap(e.to_string()))?;
            paths::write_private(&path, &body).map_err(wrap)
        }
    }
}
