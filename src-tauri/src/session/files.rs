//! Safely expose workspace files to the tree and viewer.

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

/// Resolve files inside the worktree and enforce a size limit because the complete contents cross
/// IPC.
fn open(state: &State<AppState>, id: &str, rel: &str, limit: u64) -> Result<PathBuf, String> {
    let root = cwd_of(state, id).ok_or_else(|| i18n::t("err.session.noWorkspace"))?;
    let file = inside(&root, rel)?;
    let meta = std::fs::metadata(&file).map_err(i18n::io)?;
    if meta.len() > limit {
        return Err(i18n::ta(
            "err.session.tooBig",
            &[("kb", (meta.len() / 1024).to_string())],
        ));
    }
    Ok(file)
}

#[tauri::command]
pub fn read_file(state: State<AppState>, id: String, rel: String) -> Result<String, String> {
    let file = open(&state, &id, &rel, 2 * 1024 * 1024)?;
    let bytes = std::fs::read(&file).map_err(i18n::io)?;
    String::from_utf8(bytes).map_err(|_| i18n::t("err.session.binary"))
}

/// Return raw bytes for non-text viewers such as PDF and CSV, with a larger limit than editable
/// code files.
#[tauri::command]
pub fn read_bytes(
    state: State<AppState>,
    id: String,
    rel: String,
) -> Result<tauri::ipc::Response, String> {
    let file = open(&state, &id, &rel, 100 * 1024 * 1024)?;
    let bytes = std::fs::read(&file).map_err(i18n::io)?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Use modification time and size to avoid rereading large files on every board event.
#[tauri::command]
pub fn file_stamp(state: State<AppState>, id: String, rel: String) -> Result<String, String> {
    let file = open(&state, &id, &rel, u64::MAX)?;
    let meta = std::fs::metadata(&file).map_err(i18n::io)?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .unwrap_or_default();
    Ok(format!(
        "{}.{}-{}",
        mtime.as_secs(),
        mtime.subsec_nanos(),
        meta.len()
    ))
}

/// Save only if disk contents still match the text originally opened. Reject conflicting agent
/// edits instead of overwriting their work.
pub fn save(file: &Path, text: &str, was: &str) -> Result<(), String> {
    let bytes = std::fs::read(file).map_err(i18n::io)?;
    let now = String::from_utf8(bytes).map_err(|_| i18n::t("err.session.binary"))?;
    if now != was {
        return Err(i18n::t("err.session.changed"));
    }
    std::fs::write(file, text).map_err(i18n::io)
}

#[tauri::command]
pub fn write_file(
    state: State<AppState>,
    id: String,
    rel: String,
    text: String,
    was: String,
) -> Result<(), String> {
    let root = cwd_of(&state, &id).ok_or_else(|| i18n::t("err.session.noWorkspace"))?;
    let file = inside(&root, &rel)?;
    save(&file, &text, &was)
}

/// Finder selects the entry with -R, so the person sees which file the tree meant. Systems served
/// by xdg-open have no selection flag; opening the file there would launch another application
/// over it, so open the folder holding it instead.
fn reveal_args(target: &Path, dir: bool, mac: bool) -> Vec<std::ffi::OsString> {
    let own = |path: &Path| path.as_os_str().to_os_string();
    if dir {
        return vec![own(target)];
    }
    match mac {
        true => vec![std::ffi::OsString::from("-R"), own(target)],
        false => vec![own(target.parent().unwrap_or(target))],
    }
}

/// Show a workspace or project entry in the system file manager. An empty relative path opens its
/// root; a file path selects or locates the entry.
#[tauri::command]
pub fn reveal_path(state: State<AppState>, id: String, rel: String) -> Result<(), String> {
    let root = cwd_of(&state, &id).ok_or_else(|| i18n::t("err.session.noWorkspace"))?;
    let target = inside(&root, &rel)?;
    let ok = crate::platform::opener()
        .args(reveal_args(
            &target,
            target.is_dir(),
            cfg!(target_os = "macos"),
        ))
        .status()
        .map_err(i18n::io)?
        .success();
    ok.then_some(()).ok_or_else(|| {
        i18n::ta(
            "err.session.openFailed",
            &[("path", target.display().to_string())],
        )
    })
}

#[cfg(test)]
mod tests {
    use super::{inside, reveal_args, save};

    fn tmp(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("prometeu-files-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Save when disk contents still match the opened version.
    #[test]
    fn save_writes_when_disk_content_is_unchanged() {
        let dir = tmp("save");
        let file = dir.join("nota.md");
        std::fs::write(&file, "line one\nline two\n").unwrap();

        save(&file, "line one\n", "line one\nline two\n").unwrap();

        assert_eq!(std::fs::read_to_string(&file).unwrap(), "line one\n");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Preserve agent changes made while the person was editing by rejecting the stale save.
    #[test]
    fn save_rejects_concurrent_agent_writes() {
        let dir = tmp("race");
        let file = dir.join("nota.md");
        std::fs::write(&file, "o que o agente escreveu\n").unwrap();

        let err = save(&file, "o que eu escrevi\n", "o que eu abri\n").unwrap_err();

        assert_eq!(err, "i18n:{\"code\":\"err.session.changed\"}");
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "o que o agente escreveu\n"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Finder selects the file so the person sees which one the tree meant.
    #[test]
    fn reveal_selects_the_file_in_finder() {
        let file = std::path::Path::new("/wt/app/src/main.ts");

        assert_eq!(
            reveal_args(file, false, true),
            vec![
                std::ffi::OsString::from("-R"),
                std::ffi::OsString::from(file)
            ]
        );
    }

    /// xdg-open cannot select an entry, so open the folder holding the file instead of the file,
    /// which would launch another application over it.
    #[test]
    fn reveal_opens_the_holding_folder_where_selection_is_unavailable() {
        let file = std::path::Path::new("/wt/app/src/main.ts");

        assert_eq!(
            reveal_args(file, false, false),
            vec![std::ffi::OsString::from("/wt/app/src")]
        );
    }

    /// A folder is already the destination on either system.
    #[test]
    fn reveal_opens_a_folder_directly() {
        let dir = std::path::Path::new("/wt/app/src");

        assert_eq!(
            reveal_args(dir, true, true),
            vec![std::ffi::OsString::from(dir)]
        );
        assert_eq!(
            reveal_args(dir, true, false),
            vec![std::ffi::OsString::from(dir)]
        );
    }

    /// An empty relative path targets the workspace or project root, not a file to select.
    #[test]
    fn reveal_opens_root_for_empty_relative_path() {
        let root = tmp("reveal-root");
        let target = inside(&root, "").unwrap();
        let expected = root.canonicalize().unwrap();

        assert_eq!(target, expected);
        for mac in [true, false] {
            assert_eq!(
                reveal_args(&target, target.is_dir(), mac),
                vec![expected.as_os_str().to_os_string()]
            );
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A symlink outside the worktree must not authorize writing there.
    #[test]
    fn inside_rejects_links_escaping_the_worktree() {
        let dir = tmp("outside");
        let (root, outside) = (dir.join("worktree"), dir.join("fora"));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.txt"), "x").unwrap();
        std::os::unix::fs::symlink(outside.join("secret.txt"), root.join("atalho.txt")).unwrap();

        assert!(inside(&root, "atalho.txt").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
