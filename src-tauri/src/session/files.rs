//! Navegação segura dos arquivos do workspace para árvore e viewer.

use super::cwd_of;
use crate::{i18n, AppState};
use std::path::{Path, PathBuf};
use tauri::State;

#[derive(serde::Serialize)]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub dir: bool,
}

fn inside(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let root = root.canonicalize().map_err(i18n::io)?;
    let real = root.join(rel).canonicalize().map_err(i18n::io)?;
    match real.starts_with(&root) {
        true => Ok(real),
        false => Err(i18n::t("err.session.outside")),
    }
}

#[tauri::command]
pub fn list_dir(state: State<AppState>, id: String, rel: String) -> Vec<Entry> {
    let Some(root) = cwd_of(&state, &id) else {
        return Vec::new();
    };
    let Ok(dir) = inside(&root, &rel) else {
        return Vec::new();
    };

    let mut out: Vec<Entry> = std::fs::read_dir(&dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name == ".git" {
                return None;
            }
            let dir = entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
            let path = match rel.is_empty() {
                true => name.clone(),
                false => format!("{rel}/{name}"),
            };
            Some(Entry { name, path, dir })
        })
        .collect();

    out.sort_by_key(|entry| (!entry.dir, entry.name.to_lowercase()));
    out
}

#[tauri::command]
pub fn read_file(state: State<AppState>, id: String, rel: String) -> Result<String, String> {
    let root = cwd_of(&state, &id).ok_or_else(|| i18n::t("err.session.noWorkspace"))?;
    let file = inside(&root, &rel)?;
    let meta = std::fs::metadata(&file).map_err(i18n::io)?;
    if meta.len() > 2 * 1024 * 1024 {
        return Err(i18n::ta(
            "err.session.tooBig",
            &[("kb", (meta.len() / 1024).to_string())],
        ));
    }
    let bytes = std::fs::read(&file).map_err(i18n::io)?;
    String::from_utf8(bytes).map_err(|_| i18n::t("err.session.binary"))
}
