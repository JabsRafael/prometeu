use crate::state::{Board, Project, Status, Tab, Workspace};
use crate::{paths, pty, scripts, AppState};
use portable_pty::CommandBuilder;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Emitter, Manager, State};

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

/// A etapa é propriedade do workspace, não o lugar onde ele está: muda pelo
/// menu, pelo cabeçalho ou arrastando o card — dá no mesmo.
#[tauri::command]
pub fn set_stage(app: AppHandle, state: State<AppState>, id: String, stage: String) {
    {
        let mut board = state.board.lock().unwrap();
        if let Some(ws) = board.workspace_mut(&id) {
            ws.stage = stage;
        }
    }
    publish(&app, &state);
}

/// Arquivar é sair da lista, não morrer: worktree, branch e transcript ficam, e
/// desarquivar traz tudo de volta. Os processos, esses, param — agente vivo num
/// workspace que ninguém vê é pergunta esperando resposta que ninguém lê.
#[tauri::command]
pub fn archive_workspace(app: AppHandle, state: State<AppState>, id: String, archived: bool) {
    // O `archive` derruba o que o workspace deixou fora do worktree — container,
    // banco, túnel. Roda antes de arquivar, enquanto o que ele precisa apagar
    // ainda existe, e solto: é limpeza, e prender a janela nela seria pior do
    // que ela demorar. Sem pty, porque ninguém vai ler a saída.
    if archived {
        // Os docks caem primeiro: o `archive` não pode derrubar o banco com o
        // servidor de dev ainda de pé em cima dele — e servidor de workspace
        // arquivado é processo que ninguém vê.
        kill_docks(&state, &id);
        if let Some(ws) = workspace_copy(&state, &id) {
            if let Some(command) = scripts::read(Path::new(&ws.worktree)).archive {
                let mut cmd = Command::new("/bin/sh");
                cmd.args(["-lc", &command]).current_dir(&ws.worktree);
                for (key, value) in script_env(&ws) {
                    cmd.env(key, value);
                }
                let _ = cmd.spawn();
            }
        }
    }
    {
        let mut board = state.board.lock().unwrap();
        if let Some(ws) = board.workspace_mut(&id) {
            ws.archived = archived;
            if archived {
                let ids: Vec<String> = ws.tabs.iter().map(|t| t.id.clone()).collect();
                for tab in &mut ws.tabs {
                    tab.status = Status::Desligada;
                    tab.note = None;
                }
                let mut ptys = state.ptys.lock().unwrap();
                for id in ids {
                    ptys.remove(&id);
                }
            }
        }
    }
    publish(&app, &state);
}

/// O nome nasce da primeira frase do prompt, que quase nunca é o nome que o
/// trabalho tem no fim. Nome vazio é desistência, não apagar o que já existe.
#[tauri::command]
pub fn rename_workspace(app: AppHandle, state: State<AppState>, id: String, title: String) {
    let title = title.trim();
    if title.is_empty() {
        return;
    }
    {
        let mut board = state.board.lock().unwrap();
        if let Some(ws) = board.workspace_mut(&id) {
            ws.title = title.to_string();
        }
    }
    publish(&app, &state);
}

/// Fixar é a etiqueta de "é neste que eu volto agora" — sobe para o topo da
/// lista sem mentir sobre a etapa em que o trabalho está.
#[tauri::command]
pub fn pin_workspace(app: AppHandle, state: State<AppState>, id: String, pinned: bool) {
    {
        let mut board = state.board.lock().unwrap();
        if let Some(ws) = board.workspace_mut(&id) {
            ws.pinned = pinned;
        }
    }
    publish(&app, &state);
}

/// Marcar como não lido à mão: dar de cara com a novidade e não poder lidar com
/// ela agora é o caso mais comum de todos.
#[tauri::command]
pub fn set_unread(app: AppHandle, state: State<AppState>, id: String, unread: bool) {
    {
        let mut board = state.board.lock().unwrap();
        if let Some(ws) = board.workspace_mut(&id) {
            ws.unread = unread;
        }
    }
    publish(&app, &state);
}

/// Qual workspace está na tela — e, por isso, deixa de ter novidade. Sem isto o
/// back marcaria como não lido o que você está vendo acontecer na sua frente.
#[tauri::command]
pub fn look_at(app: AppHandle, state: State<AppState>, id: Option<String>) {
    *state.looking.lock().unwrap() = id.clone();
    let Some(id) = id else { return };
    let had = {
        let mut board = state.board.lock().unwrap();
        match board.workspace_mut(&id) {
            Some(ws) => std::mem::replace(&mut ws.unread, false),
            None => false,
        }
    };
    if had {
        publish(&app, &state);
    }
}

/// Tira o workspace do quadro. Não mexe no worktree nem na branch de propósito:
/// apagar trabalho é decisão sua, feita no git, não num clique de limpeza.
#[tauri::command]
pub fn remove_workspace(app: AppHandle, state: State<AppState>, id: String) {
    kill_docks(&state, &id);
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

/// `async` aqui é o threadpool do Tauri, não uma corotina: `git worktree add`
/// e o `fetch` da base levam segundos, e na thread principal isso é a janela
/// inteira congelada enquanto o worktree monta.
#[allow(clippy::too_many_arguments)]
#[tauri::command(async)]
pub fn create_workspace(
    app: AppHandle,
    state: State<AppState>,
    project: String,
    branch: String,
    base: String,
    // Ligado, a branch nasce num worktree só dela; desligado, ela nasce no
    // próprio repositório — e é o diretório de trabalho dele que troca.
    worktree: bool,
    title: String,
    stage: String,
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

    // Branch vazia é a escolha de não criar branch nenhuma: a sessão abre no
    // repositório onde ele estiver. Worktree, esse, sempre precisa de uma —
    // é a branch que dá nome e destino à pasta.
    let (root, branch) = match (worktree, branch.trim().is_empty()) {
        (true, true) => return Err("um worktree precisa de uma branch própria".into()),
        (true, false) => {
            let dir = paths::worktree_dir(&repo_name, &branch);
            add_worktree(&repo_path, &branch, &base, &dir)?;
            (dir, branch)
        }
        (false, false) => {
            switch_branch(&repo_path, &branch, &base)?;
            (repo_path.clone(), branch)
        }
        (false, true) => {
            let head = head_branch(&repo_path).unwrap_or_else(|| "HEAD".into());
            (repo_path.clone(), head)
        }
    };

    // A porta sai antes de qualquer script, porque é ela que o `setup` e o `run`
    // recebem no ambiente — e é o que deixa dois worktrees do mesmo projeto
    // subirem o servidor ao mesmo tempo sem um matar o outro.
    let port = {
        let board = state.board.lock().unwrap();
        let taken: Vec<u16> = board.workspaces.iter().filter_map(|w| w.port).collect();
        scripts::alloc_port(&taken)
    };

    let tab = spawn_tab(&app, &state, &root, "conversa", first_message(&prompt, &inject), cols, rows)?;

    let ws = Workspace {
        id: uuid::Uuid::new_v4().to_string(),
        title: if title.trim().is_empty() { branch.clone() } else { title },
        project: repo_path.display().to_string(),
        repo: repo_path.display().to_string(),
        repo_name,
        branch,
        worktree: root.display().to_string(),
        stage,
        archived: false,
        pinned: false,
        unread: false,
        port,
        active: Some(tab.id.clone()),
        tabs: vec![tab],
    };

    // O workspace entra no quadro antes de o setup subir: é no quadro que o fim
    // dele vai procurar as abas com fala guardada.
    state.board.lock().unwrap().workspaces.push(ws.clone());

    // Worktree recém-nascido não tem nada que o `.gitignore` esconde:
    // dependências, `.env`, banco, build. O setup é o que faz dele um lugar onde
    // dá para trabalhar. O processo do agente sobe junto — é agora que ele
    // pergunta se você confia na pasta, e isso não precisa esperar o `npm
    // install` —, mas a primeira fala só é digitada quando o setup termina (ver
    // `release_prompts`): agente que roda teste antes de haver `node_modules`
    // conclui coisa errada. Falhar aqui não desfaz o worktree; o erro fica
    // escrito na aba Setup, que é onde se conserta.
    if let Some(command) = scripts::read(&root).setup {
        let _ = start_script(&app, &state, &ws, "setup", &command, cols, rows);
    }

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

/// O nome da conversa nasce da primeira frase do prompt, ou de um "conversa 2"
/// quando não houve prompt — e nenhum dos dois é o assunto que ela acaba tendo.
/// Nome vazio é desistência, não apagar o que já existe, como no workspace.
#[tauri::command]
pub fn rename_tab(
    app: AppHandle,
    state: State<AppState>,
    workspace: String,
    tab: String,
    title: String,
) {
    let title = title.trim();
    if title.is_empty() {
        return;
    }
    {
        let mut board = state.board.lock().unwrap();
        if let Some(t) = board
            .workspace_mut(&workspace)
            .and_then(|ws| ws.tabs.iter_mut().find(|t| t.id == tab))
        {
            t.title = title.to_string();
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
) -> Result<bool, String> {
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

    // Conversa que nunca falou não tem transcript, e `--resume` morre nela. Aí a
    // aba renasce com o mesmo id: não há nada perdido, e travar a tela num erro
    // por causa de uma conversa vazia seria pior.
    let resume = paths::transcript(&tab, &worktree).exists();
    let handle = pty::spawn(&app, &tab, claude_cmd(&tab, &worktree, resume)?, cols, rows, false, None)?;
    state.ptys.lock().unwrap().insert(tab.clone(), handle);
    {
        let mut board = state.board.lock().unwrap();
        if let Some(t) = board.tab_mut(&tab) {
            t.status = Status::Pronta;
            t.note = None;
        }
    }
    publish(&app, &state);
    Ok(resume)
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
    let handle = pty::spawn(app, &id, claude_cmd(&id, worktree, false)?, cols, rows, false, None)?;
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

/// `base` é de onde a branch nova sai — `origin/main`, por padrão. Branch que
/// já existe ignora a base: aí o worktree só a traz de volta para o disco, e
/// mudar o ponto de partida de trabalho que já começou não é criar workspace.
fn add_worktree(repo: &Path, branch: &str, base: &str, dest: &Path) -> Result<(), String> {
    if dest.exists() {
        return Ok(());
    }
    std::fs::create_dir_all(dest.parent().ok_or("worktree sem pai")?).map_err(|e| e.to_string())?;

    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(repo).arg("worktree").arg("add");
    if has_commit(repo, &format!("refs/heads/{branch}")) {
        cmd.arg(dest).arg(branch);
    } else {
        cmd.arg("-b").arg(branch).arg(dest);
        if !base.is_empty() {
            prepare_base(repo, base)?;
            cmd.arg(base);
        }
    }

    let out = cmd.output().map_err(|e| format!("git não rodou: {e}"))?;
    if !out.status.success() {
        return Err(format!("git worktree add: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(())
}

/// Worktree desligado: a branch nasce no próprio repositório e é o diretório de
/// trabalho dele que troca de branch. Serve para quem quer o agente mexendo no
/// clone de sempre — o preço é que o repo sai de onde estava, e mudança não
/// commitada vai junto (ou o git recusa, e o erro sobe para a tela).
fn switch_branch(repo: &Path, branch: &str, base: &str) -> Result<(), String> {
    if head_branch(repo).as_deref() == Some(branch) {
        return Ok(());
    }

    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(repo).arg("switch");
    if has_commit(repo, &format!("refs/heads/{branch}")) {
        cmd.arg(branch);
    } else {
        cmd.arg("-c").arg(branch);
        if !base.is_empty() {
            prepare_base(repo, base)?;
            cmd.arg(base);
        }
    }

    let out = cmd.output().map_err(|e| format!("git não rodou: {e}"))?;
    if !out.status.success() {
        return Err(format!("git switch: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(())
}

fn head_branch(repo: &Path) -> Option<String> {
    let name = git(repo, &["rev-parse", "--abbrev-ref", "HEAD"]).trim().to_string();
    (!name.is_empty() && name != "HEAD").then_some(name)
}

/// Deixa a base pronta para virar ponto de partida: um `origin/main` velho é o
/// lugar errado, então atualiza só aquela ref — e segue mesmo se a rede não
/// deixar, porque base local desatualizada ainda é melhor que não criar nada.
fn prepare_base(repo: &Path, base: &str) -> Result<(), String> {
    if let Some((remote, rest)) = base.split_once('/') {
        if has_commit(repo, &format!("refs/remotes/{base}")) {
            let _ = fetch(repo, remote, rest);
        }
    }
    match has_commit(repo, base) {
        true => Ok(()),
        false => Err(format!("a branch base '{base}' não existe em {}", repo.display())),
    }
}

/// `git fetch` com coleira: rede pendurada não pode virar app pendurado, e a
/// base local velha ainda dá um worktree utilizável.
fn fetch(repo: &Path, remote: &str, branch: &str) -> Result<(), String> {
    let mut child = Command::new("git")
        .arg("-C").arg(repo)
        .args(["fetch", "--quiet", remote, branch])
        .stdin(std::process::Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return Ok(()),
            Err(e) => return Err(e.to_string()),
            Ok(None) if std::time::Instant::now() >= deadline => {
                let _ = child.kill();
                return Err("fetch demorou demais".into());
            }
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(50)),
        }
    }
}

/// Se a ref existe e aponta para um commit — `--verify` sozinho aceita coisas
/// que o `worktree add` depois recusa.
fn has_commit(repo: &Path, reference: &str) -> bool {
    Command::new("git")
        .arg("-C").arg(repo)
        .args(["rev-parse", "--verify", "--quiet"])
        .arg(format!("{reference}^{{commit}}"))
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// As branches do repositório, para o lançador escolher de onde a nova sai.
/// Mais recente primeiro: a que você mexeu ontem é a que você quer hoje.
#[derive(serde::Serialize)]
pub struct Branches {
    pub all: Vec<String>,
    pub default: String,
}

#[tauri::command(async)]
pub fn list_branches(project: String) -> Branches {
    let repo = PathBuf::from(expand(&project));
    let refs = |pattern: &str| -> Vec<String> {
        git(&repo, &["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", pattern])
            .lines()
            .map(str::trim)
            .filter(|r| !r.is_empty() && !r.ends_with("/HEAD"))
            .map(str::to_string)
            .collect()
    };
    let locals = refs("refs/heads");
    let remotes = refs("refs/remotes");

    // `origin/HEAD` é o que o clone gravou como principal do remoto. Sem ele,
    // os nomes de sempre; sem eles, a branch em que o repo está agora.
    let head = git(&repo, &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).trim().to_string();
    let default = [head, "origin/main".to_string(), "origin/master".to_string()]
        .into_iter()
        .find(|r| !r.is_empty() && remotes.contains(r))
        .or_else(|| {
            let head = git(&repo, &["rev-parse", "--abbrev-ref", "HEAD"]).trim().to_string();
            (!head.is_empty() && head != "HEAD").then_some(head)
        })
        .or_else(|| locals.first().cloned())
        .unwrap_or_default();

    // A base escolhida encabeça a lista; o resto vem local antes de remoto,
    // que é a ordem em que se pensa em branch.
    let mut all: Vec<String> = Vec::new();
    for name in [default.clone()].into_iter().chain(locals).chain(remotes) {
        if !name.is_empty() && !all.contains(&name) {
            all.push(name);
        }
    }
    Branches { all, default }
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

/// Em que branch o worktree está agora. Não é `ws.branch`, que é a branch com
/// que o workspace nasceu: o agente comita, troca, rebaseia — e o que importa
/// na tela é onde o próximo commit vai cair, não o nome de quando foi criado.
/// `None` é HEAD solto (detached), que também é uma resposta.
#[tauri::command(async)]
pub fn workspace_branch(state: State<AppState>, id: String) -> Option<String> {
    head_branch(&worktree_of(&state, &id)?)
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
    use std::process::Command;

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

    /// Um repo de mentira com remoto de verdade (o "origin" é uma pasta ao
    /// lado): é o único jeito de provar que a base escolhida no lançador é de
    /// onde a branch nasce, e que `origin/main` é o padrão que o clone gravou.
    #[test]
    fn a_branch_nova_sai_da_base_escolhida() {
        let root = std::env::temp_dir().join(format!("prometheus-base-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let (origin, local) = (root.join("origin"), root.join("clone"));
        std::fs::create_dir_all(&origin).unwrap();

        let run = |dir: &std::path::Path, args: &[&str]| {
            let out = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
            assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };

        run(&origin, &["init", "-q", "-b", "main"]);
        run(&origin, &["config", "user.email", "t@t"]);
        run(&origin, &["config", "user.name", "t"]);
        std::fs::write(origin.join("a.txt"), "a").unwrap();
        run(&origin, &["add", "-A"]);
        run(&origin, &["commit", "-qm", "a"]);
        run(&origin, &["checkout", "-qb", "velha"]);
        std::fs::write(origin.join("b.txt"), "b").unwrap();
        run(&origin, &["add", "-A"]);
        run(&origin, &["commit", "-qm", "b"]);
        let velha = run(&origin, &["rev-parse", "HEAD"]);
        run(&origin, &["checkout", "-q", "main"]);

        let out = Command::new("git")
            .args(["clone", "-q"])
            .arg(&origin)
            .arg(&local)
            .output()
            .unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));

        let branches = super::list_branches(local.display().to_string());
        assert_eq!(branches.default, "origin/main");
        assert_eq!(branches.all.first().unwrap(), "origin/main");
        assert!(branches.all.contains(&"origin/velha".to_string()), "{:?}", branches.all);

        let dest = root.join("wt");
        super::add_worktree(&local, "nova", "origin/velha", &dest).unwrap();
        assert_eq!(run(&dest, &["rev-parse", "HEAD"]), velha);
        assert_eq!(run(&dest, &["rev-parse", "--abbrev-ref", "HEAD"]), "nova");

        // Base que não existe não vira worktree de lugar nenhum: dá erro.
        let erro = super::add_worktree(&local, "outra", "origin/fantasma", &root.join("wt2"));
        assert!(erro.unwrap_err().contains("fantasma"));

        // Worktree desligado: a branch nasce no próprio clone, e é o HEAD dele
        // que anda. Nenhuma pasta nova, mesmo commit da base.
        super::switch_branch(&local, "aqui", "origin/velha").unwrap();
        assert_eq!(run(&local, &["rev-parse", "--abbrev-ref", "HEAD"]), "aqui");
        assert_eq!(run(&local, &["rev-parse", "HEAD"]), velha);
        // Já estar na branch pedida é um no-op, não um erro.
        super::switch_branch(&local, "aqui", "origin/main").unwrap();
        assert_eq!(run(&local, &["rev-parse", "HEAD"]), velha);

        let _ = std::fs::remove_dir_all(&root);
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

/// Os terminais do workspace que não são conversa: o `setup` que preparou o
/// worktree, o `run` que sobe o projeto, e um shell para você. Nenhum tem hook,
/// nenhum aparece como aba do agente, nenhum entra no quadro.
///
/// Um pty por tipo, com a chave `<workspace>:<tipo>`: reabrir a aba não
/// reinicia nada, e trocar de workspace não derruba servidor de dev.
#[tauri::command]
pub fn open_dock(
    app: AppHandle,
    state: State<AppState>,
    id: String,
    kind: String,
    // `name` escolhe qual `[scripts.run.<nome>]` subir; vazio é o padrão do repo.
    name: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<String, String> {
    ensure_port(&state, &id);
    let ws = workspace_copy(&state, &id).ok_or("workspace sumiu")?;
    let key = format!("{id}:{kind}");

    if state.ptys.lock().unwrap().get(&key).is_some_and(|p| p.alive()) {
        return Ok(key); // já está de pé; o buffer redesenha
    }

    // O shell também recebe as variáveis do contrato: conferir o que o script
    // vai ver é `echo $PROMETHEUS_PORT`, e não ler o código do Prometheus.
    if kind == "terminal" {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let mut cmd = CommandBuilder::new(shell);
        cmd.cwd(&ws.worktree);
        cmd.env("TERM", "xterm-256color");
        for (key, value) in script_env(&ws) {
            cmd.env(key, value);
        }
        let handle = pty::spawn(&app, &key, cmd, cols, rows, true, None)?;
        state.ptys.lock().unwrap().insert(key.clone(), handle);
        return Ok(key);
    }

    let found = scripts::read(Path::new(&ws.worktree));
    let command = match kind.as_str() {
        "setup" => found.setup.clone(),
        "run" => found.run(name.as_deref()).map(|r| r.command.clone()),
        other => return Err(format!("dock desconhecido: {other}")),
    }
    .ok_or_else(|| format!("nenhum script de {kind} em {}", scripts::FILES[0]))?;

    start_script(&app, &state, &ws, &kind, &command, cols, rows)?;
    Ok(key)
}

/// Sobe um script do repositório num pty do dock. Se já houver um de pé com a
/// mesma chave, não faz nada: o buffer que redesenha é o dele.
fn start_script(
    app: &AppHandle,
    state: &State<AppState>,
    ws: &Workspace,
    kind: &str,
    command: &str,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let key = format!("{}:{kind}", ws.id);
    // Entrada morta não conta: é só a rolagem do que rodou antes, e subir de
    // novo a substitui.
    if state.ptys.lock().unwrap().get(&key).is_some_and(|p| p.alive()) {
        return Ok(());
    }
    // `-l` porque um `setup` que chama `nvm`, `rbenv` ou `mise` precisa do que o
    // perfil de login exporta, e o app pode ter nascido do Finder.
    let mut cmd = CommandBuilder::new("/bin/sh");
    cmd.args(["-lc", command]);
    cmd.cwd(&ws.worktree);
    cmd.env("TERM", "xterm-256color");
    for (key, value) in script_env(ws) {
        cmd.env(key, value);
    }
    // O fim do setup é o que solta a primeira fala do agente. Os outros scripts
    // não têm ninguém esperando por eles.
    let on_exit: Option<pty::OnExit> = (kind == "setup").then(|| {
        let app = app.clone();
        let id = ws.id.clone();
        Box::new(move |code| release_prompts(&app, &id, code)) as pty::OnExit
    });
    let handle = pty::spawn(app, &key, cmd, cols, rows, true, on_exit)?;
    state.ptys.lock().unwrap().insert(key, handle);
    Ok(())
}

/// O setup acabou: a primeira fala de cada aba que esperava por ele vai agora.
/// Só para aba cujo Claude Code já avisou que está de pé — as outras mandam a
/// sua no próprio `start`, e aí já vão achar o setup terminado. Setup que falhou
/// não segura a fala: solta com um aviso na frente, porque agente parado sem
/// saber por quê é pior do que agente avisado de que pode faltar dependência.
fn release_prompts(app: &AppHandle, workspace: &str, code: Option<u32>) {
    let state = app.state::<AppState>();
    let pending: Vec<String> = {
        let board = state.board.lock().unwrap();
        board
            .workspaces
            .iter()
            .find(|w| w.id == workspace)
            .map(|w| w.tabs.iter().filter(|t| t.pending_prompt.is_some()).map(|t| t.id.clone()).collect())
            .unwrap_or_default()
    };
    let waiting: Vec<String> = {
        let ready = state.ready.lock().unwrap();
        pending.into_iter().filter(|t| ready.contains(t)).collect()
    };
    let warning = match code {
        Some(0) => None,
        Some(n) => Some(format!(
            "(O setup deste worktree saiu com código {n} — veja a aba Setup; pode faltar dependência.) "
        )),
        None => Some(
            "(O setup deste worktree foi encerrado antes de terminar — veja a aba Setup; pode faltar dependência.) "
                .to_string(),
        ),
    };
    for tab in &waiting {
        crate::socket::type_prompt(app, tab, warning.clone());
    }
}

fn script_env(ws: &Workspace) -> Vec<(String, String)> {
    // O nome que o script vê é o da pasta do worktree, e não o título do card: o
    // título muda quando você renomeia, e script que batiza container ou banco
    // com ele veria o nome trocar debaixo dos pés.
    let name = Path::new(&ws.worktree)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| ws.branch.replace('/', "-"));
    scripts::env(Path::new(&ws.worktree), Path::new(&ws.repo), &name, ws.port)
}

/// Workspace criado antes de as portas existirem não tem uma. Em vez de pedir
/// para recriar, ganha a sua na primeira vez que é aberto — o painel pede os
/// scripts, e a porta vai junto, porque é ela que ele mostra.
fn ensure_port(state: &State<AppState>, id: &str) -> Option<u16> {
    let mut board = state.board.lock().unwrap();
    let current = board.workspaces.iter().find(|w| w.id == id)?.port;
    if current.is_some() {
        return current;
    }
    let taken: Vec<u16> = board.workspaces.iter().filter_map(|w| w.port).collect();
    let port = scripts::alloc_port(&taken)?;
    board.workspace_mut(id)?.port = Some(port);
    board.save();
    Some(port)
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

/// Derruba todo dock do workspace — setup, run e terminal. Sem isto, arquivar
/// ou remover deixava o servidor de dev rodando num worktree que o quadro não
/// conhece mais.
fn kill_docks(state: &State<AppState>, id: &str) {
    let prefix = format!("{id}:");
    state.ptys.lock().unwrap().retain(|key, _| !key.starts_with(&prefix));
}

/// O que este repositório declara, mais a porta reservada a este worktree. O
/// front lê isto para escolher entre abrir o terminal e desenhar o estado vazio
/// que pede um script.
#[derive(serde::Serialize)]
pub struct ScriptsView {
    #[serde(flatten)]
    pub scripts: scripts::Scripts,
    pub port: Option<u16>,
}

/// Um dock deste workspace: o tipo, e se o processo ainda está vivo. Morto
/// continua na lista enquanto ninguém sobe outro no lugar — é a rolagem dele,
/// com o `✗ saiu com código` no fim, que a aba mostra.
#[derive(serde::Serialize)]
pub struct DockView {
    pub kind: String,
    pub alive: bool,
}

/// Quais docks deste workspace existem, e quais estão de pé. O front precisa
/// disto porque abrir a aba não pode ser o que dispara o `run`: olhar o log
/// viraria subir servidor, e o botão de começar deixaria de existir.
#[tauri::command]
pub fn dock_state(state: State<AppState>, id: String) -> Vec<DockView> {
    let prefix = format!("{id}:");
    state
        .ptys
        .lock()
        .unwrap()
        .iter()
        .filter_map(|(key, pty)| {
            Some(DockView { kind: key.strip_prefix(&prefix)?.to_string(), alive: pty.alive() })
        })
        .collect()
}

#[tauri::command]
pub fn workspace_scripts(state: State<AppState>, id: String) -> ScriptsView {
    let port = ensure_port(&state, &id);
    let scripts = worktree_of(&state, &id).map(|root| scripts::read(&root)).unwrap_or_default();
    ScriptsView { scripts, port }
}

/// Escreve o exemplo comentado em `.prometheus/settings.toml` e devolve o
/// caminho relativo, para o front abrir no visualizador. Nunca sobrescreve:
/// arquivo que já existe só é apontado — inclusive o do Conductor, que é onde a
/// pessoa vai querer mexer se é lá que a configuração dela mora.
#[tauri::command]
pub fn create_scripts_file(state: State<AppState>, id: String) -> Result<String, String> {
    let root = worktree_of(&state, &id).ok_or("workspace sumiu")?;
    if let Some(file) = scripts::read(&root).file {
        return Ok(file);
    }
    let rel = scripts::FILES[0];
    let path = root.join(rel);
    std::fs::create_dir_all(path.parent().ok_or("caminho inválido")?).map_err(|e| e.to_string())?;
    std::fs::write(&path, scripts::TEMPLATE).map_err(|e| e.to_string())?;
    Ok(rel.to_string())
}

/// O texto que o botão "Perguntar ao agente" manda numa conversa nova. Sai daqui
/// e não do front porque quem sabe o nome do arquivo que já existe é quem leu o
/// disco.
#[tauri::command]
pub fn scripts_prompt(state: State<AppState>, id: String) -> String {
    let file = worktree_of(&state, &id)
        .and_then(|root| scripts::read(&root).file)
        .unwrap_or_else(|| scripts::FILES[0].to_string());
    scripts::ask_prompt(&file)
}

fn workspace_copy(state: &State<AppState>, id: &str) -> Option<Workspace> {
    state.board.lock().unwrap().workspaces.iter().find(|w| w.id == id).cloned()
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
