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
    /// Os trechos `@@` do diff, sem o cabeçalho `diff --git`/`index`, que a
    /// tela não mostra. Vem vazio quando não há o que desenhar: binário, ou
    /// patch grande demais para valer a viagem até a webview.
    pub patch: String,
}

/// O que mudou no worktree deste workspace — compartilhado por todas as abas,
/// que é justamente o motivo de elas existirem. A conta fica em `changes_in`,
/// que é o que o teste consegue rodar contra um worktree de verdade.
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
    changes_in(Path::new(&worktree))
}

fn changes_in(wt: &Path) -> Vec<FileChange> {
    // `--no-renames` para o caminho do numstat e o do patch serem o mesmo: com
    // detecção de rename o numstat diz `src/{a => b}.ts` e o patch diz `b`.
    let mut patches = patch_map(&git(wt, &["diff", "--no-color", "--no-renames", "-U3", "HEAD"]));

    let mut out: Vec<FileChange> = git(wt, &["diff", "--numstat", "--no-renames", "HEAD"])
        .lines()
        .filter_map(|l| {
            let mut f = l.split('\t');
            let added = f.next()?.parse().unwrap_or(0);
            let removed = f.next()?.parse().unwrap_or(0);
            let path = f.next()?.to_string();
            let patch = patches.remove(&path).unwrap_or_default();
            Some(FileChange { path, added, removed, new_file: false, patch })
        })
        .collect();

    // Arquivo novo ainda não está no índice, então o numstat não o vê. Conta as
    // linhas direto — é barato e evita mexer no índice do usuário. O patch dele
    // também não existe: é o arquivo inteiro entrando, então nasce aqui.
    for path in git(wt, &["ls-files", "--others", "--exclude-standard"]).lines() {
        let text = std::fs::read_to_string(wt.join(path)).unwrap_or_default();
        let added = text.lines().count() as u32;
        let patch = match added {
            0 => String::new(),
            n => std::iter::once(format!("@@ -0,0 +1,{n} @@"))
                .chain(text.lines().map(|l| format!("+{l}")))
                .collect::<Vec<_>>()
                .join("\n"),
        };
        out.push(FileChange { path: path.to_string(), added, removed: 0, new_file: true, patch: cap(patch) });
    }

    out.sort_by(|a, b| (b.added + b.removed).cmp(&(a.added + a.removed)));
    out
}

/// Corta a saída de um `git diff` em um patch por arquivo. Guarda só as linhas
/// dos trechos: o caminho sai do `+++ b/…` (ou do `--- a/…`, quando o arquivo
/// foi apagado e o destino é `/dev/null`), que aguenta nome com espaço.
fn patch_map(text: &str) -> std::collections::HashMap<String, String> {
    let mut out = std::collections::HashMap::new();
    let mut path = String::new();
    let mut old = String::new();
    let mut body: Vec<&str> = Vec::new();
    let mut in_hunk = false;

    let mut flush = |path: &mut String, body: &mut Vec<&str>| {
        if !path.is_empty() {
            out.insert(std::mem::take(path), cap(body.join("\n")));
        }
        body.clear();
    };

    for line in text.lines() {
        if line.starts_with("diff --git ") {
            flush(&mut path, &mut body);
            old.clear();
            in_hunk = false;
        } else if let Some(p) = line.strip_prefix("--- a/") {
            old = p.to_string();
        } else if let Some(p) = line.strip_prefix("+++ ") {
            path = match p.strip_prefix("b/") {
                Some(p) => p.to_string(),
                None => std::mem::take(&mut old), // +++ /dev/null: arquivo apagado
            };
        } else if line.starts_with("@@") {
            in_hunk = true;
            body.push(line);
        } else if in_hunk {
            body.push(line);
        }
    }
    flush(&mut path, &mut body);
    out
}

/// Diff de arquivo gerado (lock, bundle, snapshot) não se lê na tela e trava a
/// webview. Passando disto, a tela mostra só o resumo com o +/−.
fn cap(patch: String) -> String {
    match patch.len() > 400_000 {
        true => String::new(),
        false => patch,
    }
}

#[cfg(test)]
mod tests {
    use super::patch_map;

    /// Saída de `git diff HEAD` com três arquivos: um mexido, um apagado e um
    /// com espaço no nome. O caminho tem de sair certo nos três.
    const DIFF: &str = "\
diff --git a/src/main.ts b/src/main.ts
index 1c1c1c1..2d2d2d2 100644
--- a/src/main.ts
+++ b/src/main.ts
@@ -12,3 +12,4 @@ const $ = (id: string) => document.getElementById(id)!;
 let state: Board;
-let openWs = null;
+let openWs: string | null = null;
+let sidePane = \"files\";
diff --git a/src/old.ts b/src/old.ts
deleted file mode 100644
index 3e3e3e3..0000000
--- a/src/old.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-const gone = true;
-export default gone;
diff --git a/docs/com espaco.md b/docs/com espaco.md
--- a/docs/com espaco.md
+++ b/docs/com espaco.md
@@ -1 +1 @@
-antes
+depois
";

    /// Contra o git de verdade, no worktree onde este teste está rodando: todo
    /// arquivo que a lista mostra com linhas contadas tem de vir com trecho para
    /// desenhar. Binário conta 0/0 e não tem patch — esse é o caso de fora.
    #[test]
    fn a_lista_e_o_patch_falam_do_mesmo_arquivo() {
        let wt = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        for change in super::changes_in(wt) {
            if change.added + change.removed == 0 {
                continue;
            }
            assert!(
                change.patch.contains("@@"),
                "{} tem {}+/{}- e nenhum trecho",
                change.path,
                change.added,
                change.removed
            );
        }
    }

    #[test]
    fn separa_um_patch_por_arquivo() {
        let map = patch_map(DIFF);
        assert_eq!(map.len(), 3);

        let main = &map["src/main.ts"];
        assert!(main.starts_with("@@ -12,3 +12,4 @@ const $"), "{main}");
        assert!(main.contains("+let openWs: string | null = null;"));
        // Cabeçalho `index`/`---`/`+++` não entra: a tela não mostra.
        assert!(!main.contains("index 1c1c1c1"));
        assert!(!main.contains("--- a/src/main.ts"));

        // Apagado: o destino é /dev/null, então o caminho vem do `--- a/`.
        assert!(map["src/old.ts"].contains("-export default gone;"));
        assert_eq!(map["docs/com espaco.md"].lines().count(), 3);
    }
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

/// Conteúdo de um arquivo do worktree, para o viewer. Só texto: binário e
/// arquivo enorme viram erro legível em vez de travar a webview.
#[tauri::command]
pub fn read_file(state: State<AppState>, id: String, rel: String) -> Result<String, String> {
    let root = worktree_of(&state, &id).ok_or("workspace sumiu")?;
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let file = root.join(&rel);
    if !file.canonicalize().map(|f| f.starts_with(&root)).unwrap_or(false) {
        return Err("caminho fora do worktree".into());
    }
    let meta = std::fs::metadata(&file).map_err(|e| e.to_string())?;
    if meta.len() > 2 * 1024 * 1024 {
        return Err(format!("arquivo grande demais ({} KB)", meta.len() / 1024));
    }
    let bytes = std::fs::read(&file).map_err(|e| e.to_string())?;
    String::from_utf8(bytes).map_err(|_| "arquivo binário".to_string())
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

/// Abre o worktree no Finder.
#[tauri::command]
pub fn reveal(state: State<AppState>, id: String) -> Result<(), String> {
    let root = worktree_of(&state, &id).ok_or("workspace sumiu")?;
    let ok = Command::new("open").arg(&root).status().map_err(|e| e.to_string())?.success();
    ok.then_some(()).ok_or_else(|| format!("não abriu {}", root.display()))
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
