//! Read Git state for the changes UI: branch, counters, and structured diffs. Workspace lifecycle
//! remains in the parent module.

use super::{default_base, git, head_branch, repos_of, worktree_of};
use crate::lock::lock;
use crate::state::publish;
use crate::AppState;
use std::path::Path;
use tauri::{AppHandle, State};

#[derive(serde::Serialize)]
pub struct FileChange {
    pub path: String,
    pub added: u32,
    pub removed: u32,
    pub new_file: bool,
    pub deleted: bool,
    pub dirty: bool,
    pub patch: String,
}

#[tauri::command(async)]
pub fn workspace_branch(state: State<AppState>, id: String) -> Option<String> {
    head_branch(&worktree_of(&state, &id)?)
}

#[derive(serde::Serialize)]
pub struct RepoDiff {
    pub name: String,
    pub base: String,
    pub ahead: u32,
    pub unpushed: u32,
    pub dirty: u32,
    pub files: Vec<FileChange>,
}

#[tauri::command(async)]
pub fn workspace_diff(app: AppHandle, state: State<AppState>, id: String) -> Vec<RepoDiff> {
    let mut repos = repos_of(&state, &id);

    let mut learned = false;
    for repo in &mut repos {
        if repo.base.is_empty() {
            repo.base = default_base(Path::new(&repo.path));
            learned |= !repo.base.is_empty();
        }
    }
    if learned {
        {
            let mut board = lock(&state.board);
            if let Some(workspace) = board.workspace_mut(&id) {
                for (mine, found) in workspace.repos.iter_mut().zip(&repos) {
                    if mine.base.is_empty() {
                        mine.base = found.base.clone();
                    }
                }
            }
        }
        publish(&app);
    }

    std::thread::scope(|scope| {
        let handles: Vec<_> = repos
            .iter()
            .map(|repo| {
                scope.spawn(move || repo_diff(&repo.name, Path::new(&repo.worktree), &repo.base))
            })
            .collect();
        // A panic while reading one repository must not abort the entire command.
        handles
            .into_iter()
            .filter_map(|handle| handle.join().ok())
            .collect()
    })
}

pub(super) fn repo_diff(name: &str, worktree: &Path, base: &str) -> RepoDiff {
    let (since, ahead) = ahead_of(worktree, base);
    let mut files = changes_since(worktree, &since);
    let uncommitted: std::collections::HashSet<String> =
        git(worktree, &["diff", "--name-only", "--no-renames", "HEAD"])
            .lines()
            .map(str::to_string)
            .collect();
    for file in &mut files {
        file.dirty |= uncommitted.contains(&file.path);
    }
    let dirty = files.iter().filter(|file| file.dirty).count() as u32;
    RepoDiff {
        name: name.to_string(),
        base: base.to_string(),
        ahead,
        unpushed: unpushed_of(worktree, ahead),
        dirty,
        files,
    }
}

fn unpushed_of(worktree: &Path, ahead: u32) -> u32 {
    if git(worktree, &["rev-parse", "--abbrev-ref", "@{upstream}"])
        .trim()
        .is_empty()
    {
        return ahead;
    }
    git(worktree, &["rev-list", "--count", "@{upstream}..HEAD"])
        .trim()
        .parse()
        .unwrap_or(0)
}

pub(super) fn ahead_of(worktree: &Path, base: &str) -> (String, u32) {
    let since = match base.is_empty() {
        true => String::new(),
        false => git(worktree, &["merge-base", base, "HEAD"])
            .trim()
            .to_string(),
    };
    match since.is_empty() {
        true => ("HEAD".to_string(), 0),
        false => {
            let count = git(
                worktree,
                &["rev-list", "--count", &format!("{since}..HEAD")],
            )
            .trim()
            .parse()
            .unwrap_or(0);
            (since, count)
        }
    }
}

pub(super) fn changes_in(worktree: &Path) -> Vec<FileChange> {
    changes_since(worktree, "HEAD")
}

fn changes_since(worktree: &Path, since: &str) -> Vec<FileChange> {
    let mut patches = patch_map(&git(
        worktree,
        &["diff", "--no-color", "--no-renames", "-U3", since],
    ));

    let mut out: Vec<FileChange> = git(worktree, &["diff", "--numstat", "--no-renames", since])
        .lines()
        .filter_map(|line| {
            let mut fields = line.split('\t');
            let added = fields.next()?.parse().unwrap_or(0);
            let removed = fields.next()?.parse().unwrap_or(0);
            let path = fields.next()?.to_string();
            let patch = patches.remove(&path).unwrap_or_default();
            Some(FileChange {
                path,
                added,
                removed,
                new_file: patch.new,
                deleted: patch.deleted,
                dirty: false,
                patch: patch.body,
            })
        })
        .collect();

    for path in git(worktree, &["ls-files", "--others", "--exclude-standard"]).lines() {
        let text = std::fs::read_to_string(worktree.join(path)).unwrap_or_default();
        let added = text.lines().count() as u32;
        let patch = match added {
            0 => String::new(),
            count => std::iter::once(format!("@@ -0,0 +1,{count} @@"))
                .chain(text.lines().map(|line| format!("+{line}")))
                .collect::<Vec<_>>()
                .join("\n"),
        };
        out.push(FileChange {
            path: path.to_string(),
            added,
            removed: 0,
            new_file: true,
            deleted: false,
            dirty: true,
            patch: cap(patch),
        });
    }

    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

#[derive(Default)]
pub(super) struct Patch {
    pub(super) body: String,
    pub(super) new: bool,
    pub(super) deleted: bool,
}

pub(super) fn patch_map(text: &str) -> std::collections::HashMap<String, Patch> {
    let mut out = std::collections::HashMap::new();
    let mut path = String::new();
    let mut old = String::new();
    let mut body: Vec<&str> = Vec::new();
    let mut flags = (false, false);
    let mut in_hunk = false;

    let mut flush = |path: &mut String, body: &mut Vec<&str>, flags: &mut (bool, bool)| {
        if !path.is_empty() {
            let (new, deleted) = std::mem::take(flags);
            out.insert(
                std::mem::take(path),
                Patch {
                    body: cap(body.join("\n")),
                    new,
                    deleted,
                },
            );
        }
        body.clear();
        *flags = (false, false);
    };

    for line in text.lines() {
        if line.starts_with("diff --git ") {
            flush(&mut path, &mut body, &mut flags);
            old.clear();
            in_hunk = false;
        } else if line.starts_with("new file mode") {
            flags.0 = true;
        } else if line.starts_with("deleted file mode") {
            flags.1 = true;
        } else if let Some(value) = line.strip_prefix("--- a/") {
            old = value.to_string();
        } else if let Some(value) = line.strip_prefix("+++ ") {
            path = match value.strip_prefix("b/") {
                Some(value) => value.to_string(),
                None => std::mem::take(&mut old),
            };
        } else if line.starts_with("@@") {
            in_hunk = true;
            body.push(line);
        } else if in_hunk {
            body.push(line);
        }
    }
    flush(&mut path, &mut body, &mut flags);
    out
}

fn cap(patch: String) -> String {
    match patch.len() > 400_000 {
        true => String::new(),
        false => patch,
    }
}
