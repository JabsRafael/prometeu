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

/// A new or renamed entry's name: one plain path component, never Git's own folder.
fn valid_name(name: &str) -> Result<&str, String> {
    let bad = name.is_empty()
        || name == "."
        || name == ".."
        || name.contains(['/', '\\', '\0'])
        || name.eq_ignore_ascii_case(".git");
    match bad {
        true => Err(i18n::t("err.files.name")),
        false => Ok(name),
    }
}

/// Resolve `rel` without following its last component, so a symlink is renamed or trashed itself
/// rather than its target. The parent must still resolve inside the root.
fn entry(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let (parent, name) = rel.rsplit_once('/').unwrap_or(("", rel));
    Ok(inside(root, parent)?.join(valid_name(name)?))
}

fn taken(path: &Path) -> Result<(), String> {
    match path.symlink_metadata().is_ok() {
        true => Err(i18n::ta(
            "err.files.exists",
            &[(
                "name",
                path.file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_default(),
            )],
        )),
        false => Ok(()),
    }
}

fn create(root: &Path, rel: &str, dir: bool) -> Result<(), String> {
    let path = entry(root, rel)?;
    taken(&path)?;
    match dir {
        true => std::fs::create_dir(&path),
        false => std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map(drop),
    }
    .map_err(i18n::io)
}

fn rename(root: &Path, from: &str, to: &str) -> Result<(), String> {
    let (source, target) = (entry(root, from)?, entry(root, to)?);
    source.symlink_metadata().map_err(i18n::io)?;
    if source == target {
        return Ok(());
    }
    // A case-only rename on a case-insensitive disk resolves to the same entry, which is allowed.
    let same = |a: &Path, b: &Path| {
        a.canonicalize()
            .ok()
            .is_some_and(|a| b.canonicalize().ok() == Some(a))
    };
    if !same(&source, &target) {
        taken(&target)?;
    }
    if target.starts_with(&source) {
        return Err(i18n::t("err.files.name"));
    }
    std::fs::rename(&source, &target).map_err(i18n::io)
}

fn trash_entry(root: &Path, rel: &str) -> Result<(), String> {
    let path = entry(root, rel)?;
    path.symlink_metadata().map_err(i18n::io)?;
    trash::delete(&path)
        .map_err(|error| i18n::ta("err.files.trash", &[("cause", error.to_string())]))
}

/// The folder the system file manager should open for a tree entry.
pub(crate) fn folder_of(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let path = inside(root, rel)?;
    match path.is_dir() {
        true => Ok(path),
        false => Ok(path.parent().map(Path::to_path_buf).unwrap_or(path)),
    }
}

/// Tree actions accept a workspace or a project id, like `list_dir`, and paths relative to it.
#[tauri::command]
pub fn create_path(
    state: State<AppState>,
    id: String,
    rel: String,
    dir: bool,
) -> Result<(), String> {
    let root = cwd_of(&state, &id).ok_or_else(|| i18n::t("err.session.noWorkspace"))?;
    create(&root, &rel, dir)
}

#[tauri::command]
pub fn rename_path(
    state: State<AppState>,
    id: String,
    from: String,
    to: String,
) -> Result<(), String> {
    let root = cwd_of(&state, &id).ok_or_else(|| i18n::t("err.session.noWorkspace"))?;
    rename(&root, &from, &to)
}

/// Move to the system trash instead of deleting, so untracked work can still be recovered.
#[tauri::command]
pub fn trash_path(state: State<AppState>, id: String, rel: String) -> Result<(), String> {
    let root = cwd_of(&state, &id).ok_or_else(|| i18n::t("err.session.noWorkspace"))?;
    trash_entry(&root, &rel)
}

#[cfg(test)]
mod tests {
    use super::{create, entry, inside, rename, save};

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

    #[test]
    fn create_makes_files_and_folders_without_replacing_anything() {
        let dir = tmp("create");
        create(&dir, "notes.md", false).unwrap();
        create(&dir, "docs", true).unwrap();
        create(&dir, "docs/guide.md", false).unwrap();
        assert!(dir.join("notes.md").is_file() && dir.join("docs/guide.md").is_file());

        std::fs::write(dir.join("notes.md"), "kept").unwrap();
        assert!(create(&dir, "notes.md", false).is_err());
        assert!(create(&dir, "docs", true).is_err());
        assert_eq!(
            std::fs::read_to_string(dir.join("notes.md")).unwrap(),
            "kept"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn names_stay_one_component_inside_the_root() {
        let dir = tmp("names");
        for bad in ["", ".", "..", "a/../../x", ".git", ".GIT", "../escape"] {
            assert!(create(&dir, bad, false).is_err(), "{bad:?}");
        }
        assert!(create(&dir, "missing/new.md", false).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rename_moves_entries_but_refuses_to_overwrite() {
        let dir = tmp("rename");
        std::fs::write(dir.join("a.md"), "a").unwrap();
        std::fs::write(dir.join("b.md"), "b").unwrap();
        std::fs::create_dir(dir.join("src")).unwrap();

        assert!(rename(&dir, "a.md", "b.md").is_err());
        assert!(rename(&dir, "src", "src/inner").is_err());
        rename(&dir, "a.md", "src/c.md").unwrap();
        rename(&dir, "src", "lib").unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("lib/c.md")).unwrap(), "a");
        assert_eq!(std::fs::read_to_string(dir.join("b.md")).unwrap(), "b");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Acting on a link must touch the link, never the file it points to.
    #[test]
    fn entry_does_not_follow_the_last_symlink() {
        let dir = tmp("link");
        std::fs::write(dir.join("target.md"), "x").unwrap();
        std::os::unix::fs::symlink(dir.join("target.md"), dir.join("link.md")).unwrap();
        let root = dir.canonicalize().unwrap();
        assert_eq!(entry(&dir, "link.md").unwrap(), root.join("link.md"));
        rename(&dir, "link.md", "renamed.md").unwrap();
        assert!(dir
            .join("renamed.md")
            .symlink_metadata()
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(dir.join("target.md").is_file());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
