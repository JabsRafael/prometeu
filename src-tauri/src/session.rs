use crate::state::{Board, Project, Status, Tab, Workspace};
use crate::{paths, pty, AppState};
use portable_pty::CommandBuilder;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Emitter, State};

#[tauri::command]
pub fn load_board(state: State<AppState>) -> Board {
    state.board.lock().unwrap().clone()
}

fn publish(app: &AppHandle, state: &State<AppState>) {
    let board = state.board.lock().unwrap();
    board.save();
    let _ = app.emit("board", board.clone());
}

/* ---------- projetos ---------- */

/// Registrar o repositório uma vez é o que torna criar workspace rápido depois:
/// o lançador vira um seletor e uma caixa de texto.
#[tauri::command]
pub fn add_project(app: AppHandle, state: State<AppState>, path: String) -> Result<Project, String> {
    let path = PathBuf::from(expand(&path));
    if !path.join(".git").exists() {
        return Err(format!("{} não é um repositório git", path.display()));
    }
    let id = path.display().to_string();
    let project = Project {
        id: id.clone(),
        name: path.file_name().and_then(|s| s.to_str()).unwrap_or("repo").to_string(),
        path: id.clone(),
    };
    {
        let mut board = state.board.lock().unwrap();
        if !board.projects.iter().any(|p| p.id == id) {
            board.projects.push(project.clone());
        }
    }
    publish(&app, &state);
    Ok(project)
}

#[tauri::command]
pub fn remove_project(app: AppHandle, state: State<AppState>, id: String) {
    {
        let mut board = state.board.lock().unwrap();
        board.projects.retain(|p| p.id != id);
    }
    publish(&app, &state);
}

/* ---------- workspaces ---------- */

#[tauri::command]
pub fn move_workspace(app: AppHandle, state: State<AppState>, id: String, column: String) {
    {
        let mut board = state.board.lock().unwrap();
        if let Some(ws) = board.workspace_mut(&id) {
            ws.column = column;
        }
    }
    publish(&app, &state);
}

/// Tira o workspace do quadro. Não mexe no worktree nem na branch de propósito:
/// apagar trabalho é decisão sua, feita no git, não num clique de limpeza.
#[tauri::command]
pub fn remove_workspace(app: AppHandle, state: State<AppState>, id: String) {
    {
        let mut board = state.board.lock().unwrap();
        if let Some(ws) = board.workspace_mut(&id) {
            let ids: Vec<String> = ws.tabs.iter().map(|t| t.id.clone()).collect();
            let mut ptys = state.ptys.lock().unwrap();
            for id in ids {
                ptys.remove(&id);
            }
        }
        board.workspaces.retain(|w| w.id != id);
    }
    publish(&app, &state);
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn create_workspace(
    app: AppHandle,
    state: State<AppState>,
    project: String,
    branch: String,
    title: String,
    column: String,
    prompt: String,
    inject: Vec<String>,
    cols: u16,
    rows: u16,
) -> Result<Workspace, String> {
    let repo_path = PathBuf::from(expand(&project));
    if !repo_path.join(".git").exists() {
        return Err(format!("{} não é um repositório git", repo_path.display()));
    }
    let repo_name = repo_path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or("caminho de repo inválido")?
        .to_string();

    let worktree = paths::worktree_dir(&repo_name, &branch);
    add_worktree(&repo_path, &branch, &worktree)?;

    let tab = spawn_tab(&app, &state, &worktree, "conversa", first_message(&prompt, &inject), cols, rows)?;

    let ws = Workspace {
        id: uuid::Uuid::new_v4().to_string(),
        title: if title.trim().is_empty() { branch.clone() } else { title },
        project: repo_path.display().to_string(),
        repo: repo_path.display().to_string(),
        repo_name,
        branch,
        worktree: worktree.display().to_string(),
        column,
        active: Some(tab.id.clone()),
        tabs: vec![tab],
    };

    state.board.lock().unwrap().workspaces.push(ws.clone());
    publish(&app, &state);
    Ok(ws)
}

/* ---------- abas ---------- */

/// Conversa nova nos mesmos arquivos. É o ⌘T: quando o contexto encheu, ou
/// quando o assunto virou outro, mas o worktree é o mesmo.
#[tauri::command]
pub fn new_tab(
    app: AppHandle,
    state: State<AppState>,
    workspace: String,
    prompt: String,
    cols: u16,
    rows: u16,
) -> Result<Tab, String> {
    let (worktree, n) = {
        let board = state.board.lock().unwrap();
        let ws = board.workspaces.iter().find(|w| w.id == workspace).ok_or("workspace sumiu")?;
        (PathBuf::from(&ws.worktree), ws.tabs.len() + 1)
    };

    let title = if prompt.trim().is_empty() {
        format!("conversa {n}")
    } else {
        summarize(&prompt)
    };
    let pending = (!prompt.trim().is_empty()).then(|| prompt.trim().to_string());
    let tab = spawn_tab(&app, &state, &worktree, &title, pending, cols, rows)?;

    {
        let mut board = state.board.lock().unwrap();
        if let Some(ws) = board.workspace_mut(&workspace) {
            ws.active = Some(tab.id.clone());
            ws.tabs.push(tab.clone());
        }
    }
    publish(&app, &state);
    Ok(tab)
}

#[tauri::command]
pub fn close_tab(app: AppHandle, state: State<AppState>, workspace: String, tab: String) {
    state.ptys.lock().unwrap().remove(&tab);
    {
        let mut board = state.board.lock().unwrap();
        if let Some(ws) = board.workspace_mut(&workspace) {
            ws.tabs.retain(|t| t.id != tab);
            if ws.active.as_deref() == Some(tab.as_str()) {
                ws.active = ws.tabs.first().map(|t| t.id.clone());
            }
        }
    }
    publish(&app, &state);
}

#[tauri::command]
pub fn focus_tab(app: AppHandle, state: State<AppState>, workspace: String, tab: String) {
    {
        let mut board = state.board.lock().unwrap();
        if let Some(ws) = board.workspace_mut(&workspace) {
            ws.active = Some(tab);
        }
    }
    publish(&app, &state);
}

/// Retoma uma aba desligada. O transcript vive em
/// `~/.claude/projects/<slug>/<id>.jsonl` e sobrevive ao app, ao worktree e ao
/// reboot — então `--resume` devolve a conversa inteira de onde parou.
#[tauri::command]
pub fn resume_tab(
    app: AppHandle,
    state: State<AppState>,
    tab: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let worktree = state
        .board
        .lock()
        .unwrap()
        .workspace_of(&tab)
        .map(|w| PathBuf::from(&w.worktree))
        .ok_or("aba não encontrada")?;
    if !worktree.exists() {
        return Err(format!("worktree sumiu: {}", worktree.display()));
    }

    let handle = pty::spawn(&app, &tab, claude_cmd(&tab, &worktree, true)?, cols, rows)?;
    state.ptys.lock().unwrap().insert(tab.clone(), handle);
    {
        let mut board = state.board.lock().unwrap();
        if let Some(t) = board.tab_mut(&tab) {
            t.status = Status::Pronta;
            t.note = None;
        }
    }
    publish(&app, &state);
    Ok(())
}

fn spawn_tab(
    app: &AppHandle,
    state: &State<AppState>,
    worktree: &Path,
    title: &str,
    pending_prompt: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<Tab, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let handle = pty::spawn(app, &id, claude_cmd(&id, worktree, false)?, cols, rows)?;
    state.ptys.lock().unwrap().insert(id.clone(), handle);
    Ok(Tab {
        id,
        title: title.to_string(),
        status: Status::Pronta,
        note: None,
        pending_prompt,
    })
}

/* ---------- plumbing ---------- */

/// Monta a linha de comando do Claude Code. `resume` decide se a sessão nasce
/// nova ou continua a que já existe — o id é o mesmo nos dois casos.
fn claude_cmd(id: &str, worktree: &Path, resume: bool) -> Result<CommandBuilder, String> {
    let settings = write_settings(id)?;
    let mut cmd = CommandBuilder::new("claude");
    cmd.args([
        "--settings",
        settings.to_str().ok_or("caminho de settings inválido")?,
        if resume { "--resume" } else { "--session-id" },
        id,
        // Sessão do Prometheus roda solta: cada uma vive no seu worktree isolado,
        // e parar a cada permissão derruba o motivo de existir o quadro.
        // O hook de PermissionRequest continua instalado porque AskUserQuestion
        // passa por ele mesmo em bypass — testado: o seletor aparece e o dígito
        // acerta. Só o card de "quer permissão" deixa de existir.
        // ponytail: virar opção no lançador é uma linha, quando doer.
        "--dangerously-skip-permissions",
    ]);
    cmd.cwd(worktree);
    // O CommandBuilder herda o ambiente inteiro por padrão, e `env()` só sobrescreve
    // chave por chave — não remove nada. Sem o env_clear, um `claude` rodando dentro
    // de outro herda CLAUDE_CODE_CHILD_SESSION e desliga o salvamento do transcript,
    // que é justamente o que a aba guarda como ponteiro.
    cmd.env_clear();
    for (k, v) in std::env::vars() {
        if !k.starts_with("CLAUDE") {
            cmd.env(k, v);
        }
    }
    cmd.env("TERM", "xterm-256color");
    Ok(cmd)
}

/// Contexto injetado vira menção `@caminho` na primeira fala — que é como o
/// próprio Claude Code já lê arquivo. Nada de mecanismo novo.
fn first_message(prompt: &str, inject: &[String]) -> Option<String> {
    let mentions = inject
        .iter()
        .filter(|p| !p.trim().is_empty())
        .map(|p| format!("@{}", p.trim()))
        .collect::<Vec<_>>()
        .join(" ");

    let parts: Vec<String> = [mentions, prompt.trim().to_string()]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect();
    (!parts.is_empty()).then(|| parts.join("\n\n"))
}

fn summarize(prompt: &str) -> String {
    let line = prompt.trim().lines().next().unwrap_or("").trim();
    match line.chars().count() > 34 {
        true => line.chars().take(33).collect::<String>() + "…",
        false => line.to_string(),
    }
}

fn add_worktree(repo: &Path, branch: &str, dest: &Path) -> Result<(), String> {
    if dest.exists() {
        return Ok(());
    }
    std::fs::create_dir_all(dest.parent().ok_or("worktree sem pai")?).map_err(|e| e.to_string())?;

    let exists = Command::new("git")
        .arg("-C").arg(repo)
        .args(["rev-parse", "--verify", "--quiet"])
        .arg(format!("refs/heads/{branch}"))
        .status()
        .map(|s| s.success())
        .unwrap_or(false);

    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(repo).arg("worktree").arg("add");
    if exists {
        cmd.arg(dest).arg(branch);
    } else {
        cmd.arg("-b").arg(branch).arg(dest);
    }

    let out = cmd.output().map_err(|e| format!("git não rodou: {e}"))?;
    if !out.status.success() {
        return Err(format!("git worktree add: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(())
}

/// Um settings por sessão, nunca o global — senão o Prometheus briga com qualquer
/// outra ferramenta que também instale hooks (Vibe Island, por exemplo).
fn write_settings(id: &str) -> Result<PathBuf, String> {
    let dir = paths::session_dir(id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let bin = paths::hook_bin();
    let bin = bin.to_str().ok_or("caminho do hook inválido")?;
    let hook = |kind: &str, timeout: Option<u32>| {
        let mut h = serde_json::json!({ "type": "command", "command": format!("{bin:?} {kind}") });
        if let Some(t) = timeout {
            h["timeout"] = t.into();
        }
        serde_json::json!([{ "matcher": "*", "hooks": [h] }])
    };

    let cfg = serde_json::json!({
        "hooks": {
            // 24h: o hook fica parado de propósito enquanto o card espera clique.
            "PermissionRequest": hook("perm", Some(86400)),
            "Notification":      hook("notif", None),
            "SessionStart":      hook("start", None),
            // PreToolUse é o que dá a linha "o que ele está fazendo agora".
            "PreToolUse":        hook("tool", None),
            "UserPromptSubmit":  hook("run", None),
            "Stop":              hook("idle", None),
            "SessionEnd":        hook("end", None),
        }
    });

    let path = dir.join("settings.json");
    std::fs::write(&path, serde_json::to_vec_pretty(&cfg).unwrap()).map_err(|e| e.to_string())?;
    Ok(path)
}

#[derive(serde::Serialize)]
pub struct FileChange {
    pub path: String,
    pub added: u32,
    pub removed: u32,
    pub new_file: bool,
}

/// O que mudou no worktree deste workspace — compartilhado por todas as abas,
/// que é justamente o motivo de elas existirem.
#[tauri::command]
pub fn workspace_diff(state: State<AppState>, id: String) -> Vec<FileChange> {
    let Some(worktree) = state
        .board
        .lock()
        .unwrap()
        .workspaces
        .iter()
        .find(|w| w.id == id)
        .map(|w| w.worktree.clone())
    else {
        return Vec::new();
    };
    let wt = Path::new(&worktree);

    let mut out: Vec<FileChange> = git(wt, &["diff", "--numstat", "HEAD"])
        .lines()
        .filter_map(|l| {
            let mut f = l.split('\t');
            let added = f.next()?.parse().unwrap_or(0);
            let removed = f.next()?.parse().unwrap_or(0);
            Some(FileChange { path: f.next()?.to_string(), added, removed, new_file: false })
        })
        .collect();

    // Arquivo novo ainda não está no índice, então o numstat não o vê. Conta as
    // linhas direto — é barato e evita mexer no índice do usuário.
    for path in git(wt, &["ls-files", "--others", "--exclude-standard"]).lines() {
        let added = std::fs::read_to_string(wt.join(path))
            .map(|s| s.lines().count() as u32)
            .unwrap_or(0);
        out.push(FileChange { path: path.to_string(), added, removed: 0, new_file: true });
    }

    out.sort_by(|a, b| (b.added + b.removed).cmp(&(a.added + a.removed)));
    out
}

fn git(dir: &Path, args: &[&str]) -> String {
    Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default()
}

fn expand(p: &str) -> String {
    match p.strip_prefix("~/") {
        Some(rest) => paths::home().join(rest).display().to_string(),
        None => p.to_string(),
    }
}

#[derive(serde::Serialize)]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub dir: bool,
}

/// Lista uma pasta do worktree. Um nível por chamada: árvore inteira de um repo
/// grande custa caro e quase nunca é olhada além do primeiro galho.
#[tauri::command]
pub fn list_dir(state: State<AppState>, id: String, rel: String) -> Vec<Entry> {
    let Some(root) = worktree_of(&state, &id) else { return Vec::new() };
    let dir = root.join(&rel);
    // Não deixa `..` no caminho escapar do worktree.
    if !dir.canonicalize().map(|d| d.starts_with(&root)).unwrap_or(false) {
        return Vec::new();
    }

    let mut out: Vec<Entry> = std::fs::read_dir(&dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            if name == ".git" {
                return None;
            }
            let dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
            let path = match rel.is_empty() {
                true => name.clone(),
                false => format!("{rel}/{name}"),
            };
            Some(Entry { name, path, dir })
        })
        .collect();

    out.sort_by(|a, b| (!a.dir, a.name.to_lowercase()).cmp(&(!b.dir, b.name.to_lowercase())));
    out
}

/// Segundo terminal do workspace, no mesmo worktree: um shell para você, ou o
/// script de run do repositório. Não é sessão de agente — não tem hook, não
/// aparece como aba, não entra no quadro.
#[tauri::command]
pub fn open_dock(
    app: AppHandle,
    state: State<AppState>,
    id: String,
    kind: String,
    cols: u16,
    rows: u16,
) -> Result<String, String> {
    let root = worktree_of(&state, &id).ok_or("workspace sumiu")?;
    let key = format!("{id}:{kind}");

    if state.ptys.lock().unwrap().contains_key(&key) {
        return Ok(key); // já está de pé; o buffer redesenha
    }

    let mut cmd = match kind.as_str() {
        "run" => {
            let script = script_for(root.clone()).ok_or(
                "nenhum script de run: crie .conductor/settings.toml com [scripts] run = \"...\"",
            )?;
            let mut c = CommandBuilder::new("/bin/sh");
            c.args(["-lc", &script]);
            c
        }
        _ => CommandBuilder::new(std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into())),
    };
    cmd.cwd(&root);
    cmd.env("TERM", "xterm-256color");

    let handle = pty::spawn(&app, &key, cmd, cols, rows)?;
    state.ptys.lock().unwrap().insert(key.clone(), handle);
    Ok(key)
}

#[tauri::command]
pub fn close_dock(state: State<AppState>, id: String, kind: String) {
    state.ptys.lock().unwrap().remove(&format!("{id}:{kind}"));
}

/// Reaproveita o `.conductor/settings.toml` que o repositório já tem — quem usa
/// Conductor não precisa configurar nada de novo. `.prometheus` tem prioridade
/// para quem quiser um comando diferente aqui.
#[tauri::command]
pub fn run_script(state: State<AppState>, id: String) -> Option<String> {
    script_for(worktree_of(&state, &id)?)
}

fn script_for(root: PathBuf) -> Option<String> {
    for file in [".prometheus/settings.toml", ".conductor/settings.toml"] {
        let Ok(text) = std::fs::read_to_string(root.join(file)) else { continue };
        if let Some(script) = toml_scripts_run(&text) {
            return Some(format!("exec {script}"));
        }
    }
    None
}

/// Um `toml` inteiro por causa de uma chave não se paga; isto lê `run = "..."`
/// dentro de `[scripts]` e ignora o resto.
fn toml_scripts_run(text: &str) -> Option<String> {
    let mut in_scripts = false;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_scripts = line == "[scripts]";
            continue;
        }
        if !in_scripts {
            continue;
        }
        if let Some(value) = line.strip_prefix("run") {
            let value = value.trim_start().strip_prefix('=')?.trim();
            return Some(value.trim_matches(['"', '\'']).to_string());
        }
    }
    None
}

fn worktree_of(state: &State<AppState>, id: &str) -> Option<PathBuf> {
    state
        .board
        .lock()
        .unwrap()
        .workspaces
        .iter()
        .find(|w| w.id == id)
        .map(|w| PathBuf::from(&w.worktree))
}
