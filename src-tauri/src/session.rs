use crate::lock::lock;
use crate::state::{publish, Board, Project, Status, Tab, Workspace};
use crate::{i18n, paths, pty, scripts, socket, AppState};
use portable_pty::CommandBuilder;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Manager, State};

#[tauri::command]
pub fn load_board(state: State<AppState>) -> Board {
    lock(&state.board).clone()
}


/* ---------- projetos ---------- */

/// Registrar o repositório uma vez é o que torna criar workspace rápido depois:
/// o lançador vira um seletor e uma caixa de texto.
#[tauri::command]
pub fn add_project(app: AppHandle, state: State<AppState>, path: String) -> Result<Project, String> {
    let path = PathBuf::from(expand(&path));
    if !path.join(".git").exists() {
        return Err(i18n::ta("err.session.notGit", &[("path", path.display().to_string())]));
    }
    let id = path.display().to_string();
    let project = Project {
        id: id.clone(),
        name: path.file_name().and_then(|s| s.to_str()).unwrap_or("repo").to_string(),
        path: id.clone(),
    };
    {
        let mut board = lock(&state.board);
        if !board.projects.iter().any(|p| p.id == id) {
            board.projects.push(project.clone());
        }
    }
    publish(&app);
    Ok(project)
}

#[tauri::command]
pub fn remove_project(app: AppHandle, state: State<AppState>, id: String) {
    {
        let mut board = lock(&state.board);
        board.projects.retain(|p| p.id != id);
    }
    publish(&app);
}

/* ---------- workspaces ---------- */

/// A etapa é propriedade do workspace, não o lugar onde ele está: muda pelo
/// menu, pelo cabeçalho ou arrastando o card — dá no mesmo.
#[tauri::command]
pub fn set_stage(app: AppHandle, state: State<AppState>, id: String, stage: String) {
    {
        let mut board = lock(&state.board);
        if let Some(ws) = board.workspace_mut(&id) {
            ws.stage = stage;
        }
    }
    publish(&app);
}

/// Arquivar é sair da lista, não morrer: worktree, branch e transcript ficam, e
/// desarquivar traz tudo de volta. Os processos, esses, param — agente vivo num
/// workspace que ninguém vê é pergunta esperando resposta que ninguém lê.
#[tauri::command]
pub fn archive_workspace(app: AppHandle, state: State<AppState>, id: String, archived: bool) {
    archive(&state, &id, archived);
    publish(&app);
}

/// Concluir: a etapa vai para a última da lista e o workspace sai da frente,
/// num gesto só. São os dois que sempre andavam juntos quando o PR entrava —
/// e arquivar já derruba o agente, os docks e o que o script `archive` tiver
/// para derrubar. O worktree fica: devolver o disco é outra decisão, tomada
/// depois e com o diff ainda ao alcance.
#[tauri::command]
pub fn finish_workspace(app: AppHandle, state: State<AppState>, id: String) {
    {
        let mut board = lock(&state.board);
        let last = board.stages.last().cloned();
        if let (Some(stage), Some(ws)) = (last, board.workspace_mut(&id)) {
            ws.stage = stage;
        }
    }
    archive(&state, &id, true);
    publish(&app);
}

fn archive(state: &State<AppState>, id: &str, archived: bool) {
    let mut dead: Vec<String> = Vec::new();
    // O `archive` derruba o que o workspace deixou fora do worktree — container,
    // banco, túnel. Roda antes de arquivar, enquanto o que ele precisa apagar
    // ainda existe, e solto: é limpeza, e prender a janela nela seria pior do
    // que ela demorar. Sem pty, porque ninguém vai ler a saída.
    if archived {
        // Os docks caem primeiro: o `archive` não pode derrubar o banco com o
        // servidor de dev ainda de pé em cima dele — e servidor de workspace
        // arquivado é processo que ninguém vê.
        kill_docks(state, id);
        if let Some(ws) = workspace_copy(state, id) {
            if let Some(command) = scripts_of(&ws).archive {
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
        let mut board = lock(&state.board);
        if let Some(ws) = board.workspace_mut(id) {
            ws.archived = archived;
            if archived {
                dead = ws.tabs.iter().map(|t| t.id.clone()).collect();
                for tab in &mut ws.tabs {
                    tab.status = Status::Desligada;
                    tab.note = None;
                }
            }
        }
    }
    // Fora do lock do quadro: encerrar é sinalizar e esperar, e isso com o
    // quadro trancado pararia as outras sessões.
    stop(state, &dead);
}

/// Encerra as sessões destas abas: o processo morre, o que estava pendurado no
/// socket é esquecido. Transcript e worktree ficam — retomar é outro caminho.
fn stop(state: &State<AppState>, tabs: &[String]) {
    for tab in tabs {
        pty::kill(state, tab);
        socket::forget(state, tab);
    }
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
        let mut board = lock(&state.board);
        if let Some(ws) = board.workspace_mut(&id) {
            ws.title = title.to_string();
        }
    }
    publish(&app);
}

/// Fixar é a etiqueta de "é neste que eu volto agora" — sobe para o topo da
/// lista sem mentir sobre a etapa em que o trabalho está.
#[tauri::command]
pub fn pin_workspace(app: AppHandle, state: State<AppState>, id: String, pinned: bool) {
    {
        let mut board = lock(&state.board);
        if let Some(ws) = board.workspace_mut(&id) {
            ws.pinned = pinned;
        }
    }
    publish(&app);
}

/// Marcar como não lido à mão: dar de cara com a novidade e não poder lidar com
/// ela agora é o caso mais comum de todos.
#[tauri::command]
pub fn set_unread(app: AppHandle, state: State<AppState>, id: String, unread: bool) {
    {
        let mut board = lock(&state.board);
        if let Some(ws) = board.workspace_mut(&id) {
            ws.unread = unread;
        }
    }
    publish(&app);
}

/// Compartilhar com o time é uma marca no workspace: quem anuncia ao relay e
/// repassa a saída é o front, que é quem tem os bytes. Fica gravada para o
/// dono que fecha o app voltar compartilhando sozinho.
#[tauri::command]
pub fn set_shared(app: AppHandle, state: State<AppState>, id: String, shared: bool) {
    {
        let mut board = lock(&state.board);
        if let Some(ws) = board.workspace_mut(&id) {
            ws.shared = shared;
        }
    }
    publish(&app);
}

/// Qual workspace está na tela — e, por isso, deixa de ter novidade. Sem isto o
/// back marcaria como não lido o que você está vendo acontecer na sua frente.
#[tauri::command]
pub fn look_at(app: AppHandle, state: State<AppState>, id: Option<String>) {
    *lock(&state.looking) = id.clone();
    let Some(id) = id else { return };
    let had = {
        let mut board = lock(&state.board);
        match board.workspace_mut(&id) {
            Some(ws) => std::mem::replace(&mut ws.unread, false),
            None => false,
        }
    };
    if had {
        publish(&app);
    }
}

/// Tira o workspace do quadro. Não mexe no worktree nem na branch de propósito:
/// apagar trabalho é decisão sua, feita no git, não num clique de limpeza.
#[tauri::command]
pub fn remove_workspace(app: AppHandle, state: State<AppState>, id: String) {
    kill_docks(&state, &id);
    let dead: Vec<String> = {
        let mut board = lock(&state.board);
        let dead = board
            .workspace_mut(&id)
            .map(|ws| ws.tabs.iter().map(|t| t.id.clone()).collect())
            .unwrap_or_default();
        board.workspaces.retain(|w| w.id != id);
        dead
    };
    stop(&state, &dead);
    publish(&app);
}

/* ---------- devolver o disco ---------- */

/// Um worktree que já pode sair do disco, e o que ele ocupa. `blocked` é o
/// motivo de não poder — mudança fora de commit, trabalho que não entrou no
/// alvo — e vem como código para a tela traduzir.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cleanable {
    pub id: String,
    pub title: String,
    pub repo_name: String,
    pub branch: String,
    pub worktree: String,
    /// Quanto o worktree ocupa, em kilobytes. `node_modules` e `target` são a
    /// maior parte disso, e é por eles que a limpeza vale a pena.
    pub size_kb: u64,
    pub pr: Option<u64>,
    pub blocked: Option<String>,
}

/// Os arquivados que ainda têm worktree, com o motivo de cada um poder ou não
/// sair. Uma varredura só, pedida quando a tela de limpeza abre: cada linha
/// custa um `git status` e um `du`, e isso não é coisa para o redesenho do
/// quadro fazer.
#[tauri::command(async)]
pub fn cleanup_list(state: State<AppState>) -> Vec<Cleanable> {
    let mine: Vec<Workspace> = lock(&state.board)
        .workspaces
        .iter()
        .filter(|w| w.archived && !w.cleaned)
        .cloned()
        .collect();

    mine.into_iter()
        .map(|ws| {
            let wt = PathBuf::from(&ws.worktree);
            Cleanable {
                size_kb: size_of(&wt),
                blocked: check(&ws).err(),
                pr: ws.pr.as_ref().map(|p| p.number),
                id: ws.id,
                title: ws.title,
                repo_name: ws.repo_name,
                branch: ws.branch,
                worktree: ws.worktree,
            }
        })
        .collect()
}

/// Devolve o worktree ao disco: a pasta sai, a branch local sai, o card fica.
/// Destrutivo e sem volta — por isso as guardas moram aqui e não na tela: nada
/// sai enquanto houver mudança fora de commit, e nada sai antes de o trabalho
/// estar no alvo (ou no PR que mergeou).
#[tauri::command(async)]
pub fn cleanup_worktree(app: AppHandle, state: State<AppState>, id: String) -> Result<(), String> {
    let ws = workspace_copy(&state, &id).ok_or_else(|| i18n::t("err.session.noWorkspace"))?;
    if ws.cleaned {
        return Ok(());
    }
    check(&ws)?;

    // O agente e os docks caem antes de a pasta sumir debaixo deles. O script
    // `archive` do repositório não roda aqui: ele já rodou quando este
    // workspace foi arquivado, e ele sobe solto — dispará-lo agora seria soltar
    // um processo no worktree ao mesmo tempo que o git o apaga.
    kill_docks(&state, &id);
    let dead: Vec<String> = lock(&state.board)
        .workspace_mut(&id)
        .map(|ws| ws.tabs.iter().map(|t| t.id.clone()).collect())
        .unwrap_or_default();
    stop(&state, &dead);

    let repo = PathBuf::from(&ws.repo);
    let wt = PathBuf::from(&ws.worktree);
    if wt.exists() {
        // `--force` porque o que sobrou é o que o `.gitignore` esconde:
        // `node_modules`, `target`, `.env`. Mudança de verdade não chega aqui —
        // o `check` recusa antes.
        let out = Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args(["worktree", "remove", "--force"])
            .arg(&wt)
            .output()
            .map_err(|e| i18n::ta("err.git.spawn", &[("cause", e.to_string())]))?;
        if !out.status.success() {
            return Err(i18n::ta(
                "err.git",
                &[
                    ("command", "git worktree remove".into()),
                    ("cause", String::from_utf8_lossy(&out.stderr).trim().to_string()),
                ],
            ));
        }
    }
    // A branch local já não tem nada que o alvo não tenha. Se o git recusar —
    // ela está em check-out em outro lugar —, o worktree já foi e o trabalho
    // aqui está feito: uma branch a mais no repositório não é motivo para
    // devolver erro a quem só queria o disco de volta.
    if !ws.branch.is_empty() {
        let _ = git(&repo, &["branch", "-D", &ws.branch]);
    }
    let _ = git(&repo, &["worktree", "prune"]);

    {
        let mut board = lock(&state.board);
        if let Some(ws) = board.workspace_mut(&id) {
            ws.cleaned = true;
            for tab in &mut ws.tabs {
                tab.status = Status::Desligada;
                tab.note = None;
            }
        }
    }
    publish(&app);
    Ok(())
}

/// Este worktree pode sair? O erro é o motivo, como código para a tela dizer a
/// frase. Worktree que já sumiu do disco passa: limpar o que não existe mais é
/// só acertar o quadro.
fn check(ws: &Workspace) -> Result<(), String> {
    // Arquivar primeiro é o que faz o `archive` do repositório rodar com o
    // worktree ainda de pé. Devolver o disco é o passo depois dele, nunca no
    // lugar dele.
    if !ws.archived {
        return Err(i18n::t("err.cleanup.notArchived"));
    }
    if ws.worktree == ws.repo {
        return Err(i18n::t("err.cleanup.isRepo"));
    }
    let wt = PathBuf::from(&ws.worktree);
    if !wt.exists() {
        return Ok(());
    }
    let dirty = git(&wt, &["status", "--porcelain"]).lines().count();
    if dirty > 0 {
        return Err(i18n::ta("err.cleanup.dirty", &[("n", dirty.to_string())]));
    }
    if merged(ws, &wt) {
        return Ok(());
    }
    Err(i18n::ta("err.cleanup.unmerged", &[("branch", ws.branch.clone())]))
}

/// O trabalho já está em outro lugar? Duas respostas servem: o `gh` dizendo que
/// o PR mergeou, ou o git dizendo que o que está aqui já é ancestral do alvo —
/// que é o que sobra quando o merge foi por fora do GitHub, ou o `gh` não
/// existe nesta máquina.
fn merged(ws: &Workspace, wt: &Path) -> bool {
    if ws.pr.as_ref().is_some_and(|pr| pr.merged()) {
        return true;
    }
    let head = git(wt, &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).trim().to_string();
    let target = if head.is_empty() { "origin/main".to_string() } else { head };
    has_commit(wt, &target) && git_ok(wt, &["merge-base", "--is-ancestor", "HEAD", &target])
}

/// Quanto a pasta ocupa, em kilobytes — o `du` do sistema, que é quem já sabe
/// andar em árvore grande. Sem resposta, zero: o número é para você decidir se
/// vale a pena, e não saber o tamanho não impede a limpeza.
fn size_of(wt: &Path) -> u64 {
    if !wt.exists() {
        return 0;
    }
    let out = Command::new("du").arg("-sk").arg(wt).output().ok();
    out.and_then(|o| {
        String::from_utf8_lossy(&o.stdout)
            .split_whitespace()
            .next()
            .and_then(|n| n.parse().ok())
    })
    .unwrap_or(0)
}

/// O que o lançador montou. Um struct, e não doze parâmetros soltos: o front já
/// tem esse objeto inteiro, e passá-lo como um só é o que impede a lista de
/// argumentos de crescer a cada chavinha nova na tela.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    project: String,
    /// Vazia é a escolha de não criar branch nenhuma.
    branch: String,
    /// De onde a branch nova sai.
    base: String,
    /// Ligado, a branch nasce num worktree só dela; desligado, ela nasce no
    /// próprio repositório — e é o diretório de trabalho dele que troca.
    worktree: bool,
    title: String,
    stage: String,
    prompt: String,
    inject: Vec<String>,
    /// A issue do Linear que deu origem, quando o lançador saiu de uma.
    #[serde(default)]
    issue: Option<crate::linear::IssueRef>,
    /// `--model`, `--effort` e plan mode da primeira conversa. Modelo e
    /// esforço ficam no workspace; plan mode é só desta primeira fala.
    #[serde(flatten)]
    launch: Launch,
}

/// As chavinhas que viram argumento do `claude`. O que o lançador escolhe e o
/// que o workspace guarda para as próximas conversas são o mesmo conjunto.
#[derive(serde::Deserialize, Clone, Default)]
pub struct Launch {
    /// Vazio é não passar `--model`: o Claude Code escolhe.
    #[serde(default)]
    pub model: String,
    /// Vazio é não passar `--effort`.
    #[serde(default)]
    pub effort: String,
    /// Nasce em plan mode: o agente lê e planeja, e aprovar o plano é o que o
    /// solta. Só vale para a conversa que o lançador abre.
    #[serde(default)]
    pub plan: bool,
}

impl Workspace {
    /// Com o que uma conversa nova ou retomada nasce aqui: o modelo e o
    /// esforço do workspace, e nunca em plan mode — isso é escolha do lançador.
    pub fn launch(&self) -> Launch {
        Launch { model: self.model.clone(), effort: self.effort.clone(), plan: false }
    }
}

/// `async` aqui é o threadpool do Tauri, não uma corotina: `git worktree add`
/// e o `fetch` da base levam segundos, e na thread principal isso é a janela
/// inteira congelada enquanto o worktree monta.
#[tauri::command(async)]
pub fn create_workspace(
    app: AppHandle,
    state: State<AppState>,
    draft: Draft,
    cols: u16,
    rows: u16,
) -> Result<Workspace, String> {
    let repo_path = PathBuf::from(expand(&draft.project));
    if !repo_path.join(".git").exists() {
        return Err(i18n::ta("err.session.notGit", &[("path", repo_path.display().to_string())]));
    }
    let repo_name = repo_path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| i18n::t("err.session.badPath"))?
        .to_string();

    // Branch vazia é a escolha de não criar branch nenhuma: a sessão abre no
    // repositório onde ele estiver. Worktree, esse, sempre precisa de uma —
    // é a branch que dá nome e destino à pasta.
    let (root, branch) = match (draft.worktree, draft.branch.trim().is_empty()) {
        (true, true) => return Err(i18n::t("err.session.worktreeNeedsBranch")),
        (true, false) => {
            let dir = paths::worktree_dir(&repo_name, &draft.branch);
            add_worktree(&repo_path, &draft.branch, &draft.base, &dir)?;
            (dir, draft.branch)
        }
        (false, false) => {
            switch_branch(&repo_path, &draft.branch, &draft.base)?;
            (repo_path.clone(), draft.branch)
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
        let board = lock(&state.board);
        let taken: Vec<u16> = board.workspaces.iter().filter_map(|w| w.port).collect();
        scripts::alloc_port(&root, &taken)
    };

    let tab = spawn_tab(
        &app,
        &state,
        &root,
        "conversa",
        first_message(&draft.prompt, &draft.inject),
        &draft.launch,
        cols,
        rows,
    )?;

    let ws = Workspace {
        id: uuid::Uuid::new_v4().to_string(),
        title: if draft.title.trim().is_empty() { branch.clone() } else { draft.title },
        issue: draft.issue,
        project: repo_path.display().to_string(),
        repo: repo_path.display().to_string(),
        repo_name,
        branch,
        worktree: root.display().to_string(),
        stage: draft.stage,
        archived: false,
        pinned: false,
        unread: false,
        pr: None,
        cleaned: false,
        shared: false,
        model: draft.launch.model,
        effort: draft.launch.effort,
        port,
        active: Some(tab.id.clone()),
        tabs: vec![tab],
    };

    // O workspace entra no quadro antes de o setup subir: é no quadro que o fim
    // dele vai procurar as abas com fala guardada.
    lock(&state.board).workspaces.push(ws.clone());

    // Worktree recém-nascido não tem nada que o `.gitignore` esconde:
    // dependências, `.env`, banco, build. O que dá para reconstruir é o setup
    // que reconstrói; o que não dá — segredo, chave — vem copiado do clone,
    // antes dele. Os dois são a aba Setup. O processo do agente sobe junto — é
    // agora que ele pergunta se você confia na pasta, e isso não precisa esperar
    // o `npm install` —, mas a primeira fala só é digitada quando o setup
    // termina (ver `release_prompts`): agente que roda teste antes de haver
    // `node_modules` conclui coisa errada. Falhar aqui não desfaz o worktree; o erro fica
    // escrito na aba Setup, que é onde se conserta.
    let _ = start_setup(&app, &state, &ws, cols, rows);

    // O nome que veio do lançador é a primeira linha do prompt cortada. Ela
    // serve até o agente ler o pedido inteiro e devolver um título — o que
    // acontece em paralelo, alguns segundos depois de a tela já estar de pé.
    // Workspace que saiu de uma issue já tem o nome que a issue deu.
    if ws.issue.is_none() {
        crate::naming::rename_later(&app, &ws.id, &draft.prompt, &ws.title);
    }

    publish(&app);
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
    // Modelo e esforço são do workspace: conversa nova nos mesmos arquivos
    // nasce com os mesmos que as irmãs. Plan mode não — é escolha de uma fala.
    let (worktree, n, launch) = {
        let board = lock(&state.board);
        let ws = board.workspaces.iter().find(|w| w.id == workspace).ok_or_else(|| i18n::t("err.session.noWorkspace"))?;
        if ws.cleaned {
            return Err(i18n::t("err.session.cleaned"));
        }
        (PathBuf::from(&ws.worktree), ws.tabs.len() + 1, ws.launch())
    };

    let title = if prompt.trim().is_empty() {
        format!("conversa {n}")
    } else {
        tab_title(&prompt)
    };
    let pending = (!prompt.trim().is_empty()).then(|| prompt.trim().to_string());
    let tab = spawn_tab(&app, &state, &worktree, &title, pending, &launch, cols, rows)?;

    {
        let mut board = lock(&state.board);
        if let Some(ws) = board.workspace_mut(&workspace) {
            ws.active = Some(tab.id.clone());
            ws.tabs.push(tab.clone());
        }
    }
    publish(&app);
    Ok(tab)
}

#[tauri::command]
pub fn close_tab(app: AppHandle, state: State<AppState>, workspace: String, tab: String) {
    stop(&state, std::slice::from_ref(&tab));
    {
        let mut board = lock(&state.board);
        if let Some(ws) = board.workspace_mut(&workspace) {
            ws.tabs.retain(|t| t.id != tab);
            if ws.active.as_deref() == Some(tab.as_str()) {
                ws.active = ws.tabs.first().map(|t| t.id.clone());
            }
        }
    }
    publish(&app);
}

#[tauri::command]
pub fn focus_tab(app: AppHandle, state: State<AppState>, workspace: String, tab: String) {
    {
        let mut board = lock(&state.board);
        if let Some(ws) = board.workspace_mut(&workspace) {
            ws.active = Some(tab);
        }
    }
    publish(&app);
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
        let mut board = lock(&state.board);
        if let Some(t) = board
            .workspace_mut(&workspace)
            .and_then(|ws| ws.tabs.iter_mut().find(|t| t.id == tab))
        {
            t.title = title.to_string();
        }
    }
    publish(&app);
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
    let (worktree, launch, cleaned) = lock(&state.board)
        .workspace_of(&tab)
        .map(|w| (PathBuf::from(&w.worktree), w.launch(), w.cleaned))
        .ok_or_else(|| i18n::t("err.session.noTab"))?;
    if cleaned {
        return Err(i18n::t("err.session.cleaned"));
    }
    if !worktree.exists() {
        return Err(i18n::ta("err.session.noWorktree", &[("path", worktree.display().to_string())]));
    }

    // O que sobrou da sessão anterior sai antes: o processo já morreu, mas o
    // `Pty` continua no mapa até alguém tirar.
    pty::kill(&state, &tab);

    // Conversa que nunca falou não tem transcript, e `--resume` morre nela. Aí a
    // aba renasce com o mesmo id: não há nada perdido, e travar a tela num erro
    // por causa de uma conversa vazia seria pior.
    let resume = paths::transcript(&tab, &worktree).exists();
    let handle = pty::spawn(&app, &tab, claude_cmd(&tab, &worktree, resume, &launch)?, cols, rows, None)?;
    lock(&state.ptys).insert(tab.clone(), handle);
    {
        let mut board = lock(&state.board);
        if let Some(t) = board.tab_mut(&tab) {
            t.status = Status::Pronta;
            t.note = None;
        }
    }
    publish(&app);
    Ok(resume)
}

#[allow(clippy::too_many_arguments)]
fn spawn_tab(
    app: &AppHandle,
    state: &State<AppState>,
    worktree: &Path,
    title: &str,
    pending_prompt: Option<String>,
    launch: &Launch,
    cols: u16,
    rows: u16,
) -> Result<Tab, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let handle = pty::spawn(app, &id, claude_cmd(&id, worktree, false, launch)?, cols, rows, None)?;
    lock(&state.ptys).insert(id.clone(), handle);
    Ok(Tab {
        id,
        title: title.to_string(),
        status: Status::Pronta,
        note: None,
        pending_prompt,
        tokens: None,
    })
}

/* ---------- plumbing ---------- */

/// Monta a linha de comando do Claude Code. `resume` decide se a sessão nasce
/// nova ou continua a que já existe — o id é o mesmo nos dois casos.
///
/// O agente roda sempre solto: cada sessão vive no seu worktree e não para a
/// cada ferramenta — que é o motivo de existir o quadro. O hook de
/// PermissionRequest fica instalado mesmo assim, porque AskUserQuestion e
/// ExitPlanMode passam por ele em bypass — testado: o seletor aparece e o
/// dígito acerta.
fn claude_cmd(id: &str, worktree: &Path, resume: bool, launch: &Launch) -> Result<CommandBuilder, String> {
    let settings = write_settings(id)?;
    let mut cmd = CommandBuilder::new("claude");
    cmd.args(cli_args(
        id,
        settings.to_str().ok_or_else(|| i18n::t("err.session.badSettings"))?,
        resume,
        launch,
    ));
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

/// Os argumentos do `claude`, separados do `CommandBuilder` para dar para
/// testar — e porque a parte do plan mode foi levantada na marra (2.1.240):
///
/// - `--dangerously-skip-permissions` junto de `--permission-mode plan` ganha
///   do plan: a sessão nasce em bypass e o plano nunca acontece.
/// - `--allow-dangerously-skip-permissions` com `--permission-mode plan` nasce
///   em plan, e o "Would you like to proceed?" do ExitPlanMode já vem com
///   "switch to BYPASS PERMISSIONS" como primeira opção. Aprovar é o dígito 1,
///   e daí em diante é o mesmo solto de sempre.
fn cli_args(id: &str, settings: &str, resume: bool, launch: &Launch) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "--settings".into(),
        settings.into(),
        if resume { "--resume" } else { "--session-id" }.into(),
        id.into(),
    ];
    if launch.plan {
        args.extend(["--permission-mode", "plan", "--allow-dangerously-skip-permissions"].map(String::from));
    } else {
        args.push("--dangerously-skip-permissions".into());
    }
    if !launch.model.trim().is_empty() {
        args.extend(["--model".into(), launch.model.trim().into()]);
    }
    if !launch.effort.trim().is_empty() {
        args.extend(["--effort".into(), launch.effort.trim().into()]);
    }
    args
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

/// Rótulo de aba a partir da primeira frase do prompt. Corta mais curto que o
/// nome do workspace (que o lançador monta): a barra de abas é estreita e
/// várias delas dividem a linha.
fn tab_title(prompt: &str) -> String {
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
    // Pasta que já está lá é reaproveitada — mas só se for a branch pedida.
    // Antes qualquer pasta com o nome certo servia, então um worktree na branch
    // errada era adotado calado e o quadro passava a mentir em que branch a
    // sessão estava mexendo.
    if dest.exists() {
        return match head_branch(dest) {
            Some(head) if head == branch => Ok(()),
            Some(head) => Err(i18n::ta(
                "err.session.worktreeElsewhere",
                &[("path", dest.display().to_string()), ("head", head), ("branch", branch.to_string())],
            )),
            None => Err(i18n::ta(
                "err.session.worktreeDetached",
                &[("path", dest.display().to_string())],
            )),
        };
    }
    let parent = dest.parent().ok_or_else(|| i18n::t("err.session.noParent"))?;
    std::fs::create_dir_all(parent).map_err(i18n::io)?;

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

    let out = cmd.output().map_err(|e| i18n::ta("err.git.spawn", &[("cause", e.to_string())]))?;
    if !out.status.success() {
        return Err(i18n::ta(
            "err.git",
            &[
                ("command", "git worktree add".into()),
                ("cause", String::from_utf8_lossy(&out.stderr).trim().to_string()),
            ],
        ));
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

    let out = cmd.output().map_err(|e| i18n::ta("err.git.spawn", &[("cause", e.to_string())]))?;
    if !out.status.success() {
        return Err(i18n::ta(
            "err.git",
            &[
                ("command", "git switch".into()),
                ("cause", String::from_utf8_lossy(&out.stderr).trim().to_string()),
            ],
        ));
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
        false => Err(i18n::ta(
            "err.session.noBase",
            &[("base", base.to_string()), ("path", repo.display().to_string())],
        )),
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
        .map_err(i18n::io)?;

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return Ok(()),
            Err(e) => return Err(i18n::io(e)),
            Ok(None) if std::time::Instant::now() >= deadline => {
                let _ = child.kill();
                return Err(i18n::t("err.git.fetchSlow"));
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
    let bin = bin.to_str().ok_or_else(|| i18n::t("err.session.badHook"))?;
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
/// `async` porque isto é o caminho mais quente do app: dois `git` e a leitura
/// de todo arquivo novo, e a tela pede de novo a cada ferramenta que o agente
/// usa. Na thread principal, era a janela travando em rajada — o front ainda
/// junta as chamadas por cima disto.
#[tauri::command(async)]
pub fn workspace_diff(state: State<AppState>, id: String) -> Vec<FileChange> {
    match worktree_of(&state, &id) {
        Some(worktree) => changes_in(&worktree),
        None => Vec::new(),
    }
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

    out.sort_by_key(|c| std::cmp::Reverse(c.added + c.removed));
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
    use super::{cli_args, is_terminal, patch_map, pick, pr_text, Launch, Pr};

    fn pr(number: u64, branch: &str, state: &str) -> Pr {
        Pr {
            number,
            title: format!("PR {number}"),
            is_draft: false,
            state: state.into(),
            head_ref_name: branch.into(),
        }
    }

    /// Entre os PRs do repositório, o desta branch — e, na mesma branch, o
    /// aberto manda mais que o fechado, que é o que reaproveitar uma branch
    /// deixa para trás.
    #[test]
    fn pick_prefere_o_aberto_da_branch() {
        let all = vec![
            pr(9, "outra/coisa", "OPEN"),
            pr(8, "meu/ajuste", "CLOSED"),
            pr(7, "meu/ajuste", "OPEN"),
        ];
        assert_eq!(pick(&all, "meu/ajuste").unwrap().number, 7);
        assert!(pick(&all, "nao/existe").is_none());
    }

    /// As guardas de devolver o disco, contra um git de verdade: nada sai antes
    /// de o trabalho ter entrado no alvo, nada sai com mudança fora de commit, e
    /// nada sai antes de o workspace estar arquivado — que é quando o `archive`
    /// do repositório rodou.
    #[test]
    fn check_so_deixa_sair_o_que_ja_entrou_e_esta_limpo() {
        let root = std::env::temp_dir().join(format!("prometheus-clean-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let (origin, local) = (root.join("origin"), root.join("clone"));
        std::fs::create_dir_all(&origin).unwrap();

        let run = |dir: &std::path::Path, args: &[&str]| {
            let out = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
            assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        };
        run(&origin, &["init", "-q", "-b", "main"]);
        run(&origin, &["config", "user.email", "t@t"]);
        run(&origin, &["config", "user.name", "t"]);
        std::fs::write(origin.join("a.txt"), "a").unwrap();
        run(&origin, &["add", "-A"]);
        run(&origin, &["commit", "-qm", "a"]);

        let out = Command::new("git").args(["clone", "-q"]).arg(&origin).arg(&local).output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));

        let dest = root.join("wt");
        super::add_worktree(&local, "trabalho", "origin/main", &dest).unwrap();

        let mut ws = super::Workspace {
            id: "w".into(),
            title: "trabalho".into(),
            project: local.display().to_string(),
            repo: local.display().to_string(),
            repo_name: "clone".into(),
            branch: "trabalho".into(),
            worktree: dest.display().to_string(),
            stage: "Feito".into(),
            archived: true,
            pinned: false,
            unread: false,
            pr: None,
            cleaned: false,
            shared: false,
            model: String::new(),
            effort: String::new(),
            port: None,
            issue: None,
            tabs: Vec::new(),
            active: None,
        };

        // Branch nova sem commit próprio já é o alvo: pode sair.
        super::check(&ws).unwrap();

        // Um commit que não está no alvo segura o worktree.
        std::fs::write(dest.join("b.txt"), "b").unwrap();
        run(&dest, &["config", "user.email", "t@t"]);
        run(&dest, &["config", "user.name", "t"]);
        run(&dest, &["add", "-A"]);
        run(&dest, &["commit", "-qm", "b"]);
        assert!(super::check(&ws).unwrap_err().contains("unmerged"));

        // Mas o `gh` dizendo que o PR entrou é a outra resposta que serve — o
        // merge por squash não deixa a branch ancestral de nada.
        ws.pr = Some(pr(3, "trabalho", "MERGED"));
        super::check(&ws).unwrap();

        // Mudança fora de commit segura de qualquer jeito.
        std::fs::write(dest.join("c.txt"), "c").unwrap();
        assert!(super::check(&ws).unwrap_err().contains("dirty"));
        std::fs::remove_file(dest.join("c.txt")).unwrap();
        super::check(&ws).unwrap();

        // Ainda na frente de todo mundo: arquivar é o passo de antes.
        ws.archived = false;
        assert!(super::check(&ws).unwrap_err().contains("notArchived"));

        let _ = std::fs::remove_dir_all(&root);
    }

    /// Sem nenhum aberto, vale o mais novo — que é a ordem em que o `gh`
    /// responde. Mergeado é justamente o que faz a barra oferecer "Concluir".
    #[test]
    fn pick_sem_aberto_pega_o_mais_novo() {
        let all = vec![pr(12, "meu/ajuste", "MERGED"), pr(4, "meu/ajuste", "CLOSED")];
        let got = pick(&all, "meu/ajuste").unwrap();
        assert_eq!(got.number, 12);
        assert!(got.merged());
    }

    /// O prompt de PR diz o estado e os passos com os nomes certos: a branch
    /// no push, o alvo sem o remoto no `--base`, e a sujeira contada.
    #[test]
    fn pr_text_diz_o_estado_e_os_passos() {
        let t = pr_text(Some("meu/ajuste"), 3, "origin/main", false, None);
        assert!(t.contains("Há 3 arquivos"));
        assert!(t.contains("git push -u origin HEAD:meu/ajuste"));
        assert!(t.contains("gh pr create --base main"));
        assert!(t.contains("Ainda não há branch upstream."));

        let limpo = pr_text(None, 0, "origin/master", true, None);
        assert!(limpo.contains("limpo"));
        assert!(limpo.contains("HEAD solto"));
        assert!(limpo.contains("--base master"));
        assert!(limpo.contains("A branch já tem upstream."));
    }

    /// Com PR aberto o pedido é outro: atualizar o #42, e não criar um segundo.
    #[test]
    fn pr_text_com_pr_aberto_pede_atualizacao() {
        let t = pr_text(Some("meu/ajuste"), 1, "origin/main", true, Some(42));
        assert!(t.contains("Quero atualizar o PR #42"));
        assert!(t.contains("gh pr view 42"));
        assert!(t.contains("gh pr edit 42"));
        assert!(!t.contains("gh pr create"));
        // O caminho até lá é o mesmo: commitar e empurrar continua sendo o miolo.
        assert!(t.contains("git push -u origin HEAD:meu/ajuste"));
    }
    use std::process::Command;

    fn launch(model: &str, effort: &str, plan: bool) -> Launch {
        Launch { model: model.into(), effort: effort.into(), plan }
    }

    /// Bypass e plan não convivem na mesma linha: `--dangerously-skip-permissions`
    /// engole o plan. Plan mode é `--allow-…` mais `--permission-mode plan`.
    #[test]
    fn plan_mode_nao_leva_o_bypass_junto() {
        let solto = cli_args("id", "s.json", false, &launch("", "", false));
        assert!(solto.contains(&"--dangerously-skip-permissions".to_string()));
        assert!(!solto.contains(&"--permission-mode".to_string()));

        let plano = cli_args("id", "s.json", false, &launch("", "", true));
        assert!(!plano.contains(&"--dangerously-skip-permissions".to_string()));
        assert!(plano.contains(&"--allow-dangerously-skip-permissions".to_string()));
        let at = plano.iter().position(|a| a == "--permission-mode").unwrap();
        assert_eq!(plano[at + 1], "plan");
    }

    /// Vazio é não passar a flag — o Claude Code escolhe. Cheio vai como veio.
    #[test]
    fn modelo_e_esforco_so_quando_escolhidos() {
        let padrao = cli_args("id", "s.json", true, &launch("", " ", false));
        assert!(!padrao.contains(&"--model".to_string()));
        assert!(!padrao.contains(&"--effort".to_string()));
        assert_eq!(padrao[2], "--resume");

        let escolhido = cli_args("id", "s.json", false, &launch("opus[1m]", "max", false));
        assert_eq!(escolhido[escolhido.len() - 4..], ["--model", "opus[1m]", "--effort", "max"]);
        assert_eq!(escolhido[2], "--session-id");
    }

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

        // Pasta que já existe na branch pedida é reaproveitada — é o que faz
        // criar duas vezes o mesmo workspace não estourar.
        super::add_worktree(&local, "nova", "origin/velha", &dest).unwrap();
        // Mas na branch errada, não: adotar calado era o quadro passar a mentir
        // em que branch a sessão estava mexendo.
        let erro = super::add_worktree(&local, "outra-branch", "origin/main", &dest).unwrap_err();
        assert!(erro.contains("nova"), "{erro}");

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

    /// O front numera as abas de terminal, mas quem abre pty é o back: chave
    /// que não seja `terminal` ou `terminal-<número>` não pode virar shell,
    /// senão qualquer string entra no mapa de ptys com nome próprio.
    #[test]
    fn so_terminal_numerado_vira_shell() {
        assert!(is_terminal("terminal"));
        assert!(is_terminal("terminal-2"));
        assert!(is_terminal("terminal-10"));
        assert!(!is_terminal("terminal-"));
        assert!(!is_terminal("terminal-2x"));
        assert!(!is_terminal("terminalzinho"));
        assert!(!is_terminal("setup"));
        assert!(!is_terminal("run"));
    }
}

/// O git só pelo sim ou não da saída — `merge-base --is-ancestor` e afins, que
/// não escrevem nada e respondem no código de saída.
fn git_ok(dir: &Path, args: &[&str]) -> bool {
    Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
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

/// Resolve um caminho relativo dentro do worktree, ou recusa.
///
/// As duas pontas são canonicalizadas antes de comparar. Só a de dentro era, e
/// aí bastava um symlink no caminho do worktree — `/tmp` no macOS é um deles —
/// para o `starts_with` dar falso e a árvore vir vazia sem erro nenhum.
fn inside(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let root = root.canonicalize().map_err(i18n::io)?;
    let real = root.join(rel).canonicalize().map_err(i18n::io)?;
    match real.starts_with(&root) {
        true => Ok(real),
        false => Err(i18n::t("err.session.outside")),
    }
}

/// Lista uma pasta do worktree. Um nível por chamada: árvore inteira de um repo
/// grande custa caro e quase nunca é olhada além do primeiro galho.
#[tauri::command]
pub fn list_dir(state: State<AppState>, id: String, rel: String) -> Vec<Entry> {
    let Some(root) = worktree_of(&state, &id) else { return Vec::new() };
    // Não deixa `..` no caminho escapar do worktree.
    let Ok(dir) = inside(&root, &rel) else { return Vec::new() };

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

    out.sort_by_key(|e| (!e.dir, e.name.to_lowercase()));
    out
}

/// Conteúdo de um arquivo do worktree, para o viewer. Só texto: binário e
/// arquivo enorme viram erro legível em vez de travar a webview.
#[tauri::command]
pub fn read_file(state: State<AppState>, id: String, rel: String) -> Result<String, String> {
    let root = worktree_of(&state, &id).ok_or_else(|| i18n::t("err.session.noWorkspace"))?;
    let file = inside(&root, &rel)?;
    let meta = std::fs::metadata(&file).map_err(i18n::io)?;
    if meta.len() > 2 * 1024 * 1024 {
        return Err(i18n::ta("err.session.tooBig", &[("kb", (meta.len() / 1024).to_string())]));
    }
    let bytes = std::fs::read(&file).map_err(i18n::io)?;
    String::from_utf8(bytes).map_err(|_| i18n::t("err.session.binary"))
}

/// Um shell do dock. `terminal` é o primeiro; do segundo em diante o front
/// numera — `terminal-2`, `terminal-3` —, porque cada aba aberta pelo + precisa
/// de uma chave própria no mapa de ptys. O número é conferido aqui e não
/// confiado: chave torta viraria pty com nome arbitrário, e `dock_state`
/// devolveria aba que o front não sabe desenhar.
fn is_terminal(kind: &str) -> bool {
    kind == "terminal"
        || kind
            .strip_prefix("terminal-")
            .is_some_and(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()))
}

/// Os terminais do workspace que não são conversa: o `setup` que preparou o
/// worktree, o `run` que sobe o projeto, e os shells que você abriu. Nenhum tem
/// hook, nenhum aparece como aba do agente, nenhum entra no quadro.
///
/// Um pty por chave `<workspace>:<tipo>`: reabrir a aba não reinicia nada, e
/// trocar de workspace não derruba servidor de dev.
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
    let ws = workspace_copy(&state, &id).ok_or_else(|| i18n::t("err.session.noWorkspace"))?;
    let key = format!("{id}:{kind}");

    if lock(&state.ptys).get(&key).is_some_and(|p| p.alive()) {
        return Ok(key); // já está de pé; o buffer redesenha
    }

    // O shell também recebe as variáveis do contrato: conferir o que o script
    // vai ver é `echo $PROMETHEUS_PORT`, e não ler o código do Prometheus.
    if is_terminal(&kind) {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let mut cmd = CommandBuilder::new(shell);
        cmd.cwd(&ws.worktree);
        cmd.env("TERM", "xterm-256color");
        for (key, value) in script_env(&ws) {
            cmd.env(key, value);
        }
        let handle = pty::spawn(&app, &key, cmd, cols, rows, Some(pty::Dock::default()))?;
        lock(&state.ptys).insert(key.clone(), handle);
        return Ok(key);
    }

    // Setup tem caminho próprio porque não é só um comando: é a cópia do que vem
    // do clone, e ela vale mesmo num repositório que não declara `setup` nenhum.
    if kind == "setup" {
        start_setup(&app, &state, &ws, cols, rows)?;
        return Ok(key);
    }

    let found = scripts_of(&ws);
    let command = match kind.as_str() {
        "run" => found.run(name.as_deref()).map(|r| r.command.clone()),
        other => return Err(i18n::ta("err.dock.unknown", &[("kind", other.to_string())])),
    }
    .ok_or_else(|| {
        i18n::ta("err.dock.noScript", &[("kind", kind.clone()), ("file", scripts::FILES[0].to_string())])
    })?;

    let script = Script { kind: &kind, command: &command, header: None };
    start_script(&app, &state, &ws, script, cols, rows)?;
    Ok(key)
}

/// A aba Setup inteira: primeiro o que este worktree recebe do clone, depois o
/// `setup` que o repositório declara.
///
/// Os dois valem sozinhos. Worktree que só precisa do `.env` também ganha a aba
/// — é ela que diz o que veio, e cópia calada é mágica. Sem script, o processo é
/// um `true`: o que importa ali é o cabeçalho, e uma aba que funciona pela
/// metade seria pior que a mágica.
fn start_setup(
    app: &AppHandle,
    state: &State<AppState>,
    ws: &Workspace,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let found = scripts_of(ws);
    let notes = scripts::hydrate(Path::new(&ws.worktree), Path::new(&ws.repo), &found.copy);
    let report = scripts::report(&notes);
    if found.setup.is_none() && report.is_none() {
        let holes = [("kind", "setup".to_string()), ("file", scripts::FILES[0].to_string())];
        return Err(i18n::ta("err.dock.noScript", &holes));
    }
    let script =
        Script { kind: "setup", command: found.setup.as_deref().unwrap_or("true"), header: report };
    start_script(app, state, ws, script, cols, rows)
}

/// O que subir num pty do dock: qual aba, o que rodar nela, e o que o Prometheus
/// escreve antes de o processo abrir a boca.
struct Script<'a> {
    kind: &'a str,
    command: &'a str,
    header: Option<String>,
}

/// Sobe um script do repositório num pty do dock. Se já houver um de pé com a
/// mesma chave, não faz nada: o buffer que redesenha é o dele.
fn start_script(
    app: &AppHandle,
    state: &State<AppState>,
    ws: &Workspace,
    script: Script,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    if ws.cleaned {
        return Err(i18n::t("err.session.cleaned"));
    }
    let Script { kind, command, header } = script;
    let key = format!("{}:{kind}", ws.id);
    // Entrada morta não conta: é só a rolagem do que rodou antes, e subir de
    // novo a substitui.
    if lock(&state.ptys).get(&key).is_some_and(|p| p.alive()) {
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
    let handle = pty::spawn(app, &key, cmd, cols, rows, Some(pty::Dock { on_exit, header }))?;
    lock(&state.ptys).insert(key, handle);
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
        let board = lock(&state.board);
        board
            .workspaces
            .iter()
            .find(|w| w.id == workspace)
            .map(|w| w.tabs.iter().filter(|t| t.pending_prompt.is_some()).map(|t| t.id.clone()).collect())
            .unwrap_or_default()
    };
    let waiting: Vec<String> = {
        let ready = lock(&state.ready);
        pending.into_iter().filter(|t| ready.contains(t)).collect()
    };
    let warning = match code {
        Some(0) => None,
        Some(n) => Some(i18n::pick(
            &format!("(O setup deste worktree saiu com código {n} — veja a aba Setup; pode faltar dependência.) "),
            &format!("(This worktree's setup exited with code {n} — see the Setup tab; a dependency may be missing.) "),
        )),
        None => Some(i18n::pick(
            "(O setup deste worktree foi encerrado antes de terminar — veja a aba Setup; pode faltar dependência.) ",
            "(This worktree's setup was stopped before it finished — see the Setup tab; a dependency may be missing.) ",
        )),
    };
    for tab in &waiting {
        crate::socket::type_prompt(app, tab, warning.clone());
    }
}

/// Os scripts que valem para este workspace: os do worktree, e sem eles os do
/// clone de origem (ver `scripts::read_for`).
fn scripts_of(ws: &Workspace) -> scripts::Scripts {
    scripts::read_for(Path::new(&ws.worktree), Path::new(&ws.repo))
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
    let mut board = lock(&state.board);
    let ws = board.workspaces.iter().find(|w| w.id == id)?;
    if ws.port.is_some() {
        return ws.port;
    }
    let worktree = ws.worktree.clone();
    let taken: Vec<u16> = board.workspaces.iter().filter_map(|w| w.port).collect();
    let port = scripts::alloc_port(Path::new(&worktree), &taken)?;
    board.workspace_mut(id)?.port = Some(port);
    board.save();
    Some(port)
}

/// Abre o worktree no Finder.
#[tauri::command]
pub fn reveal(state: State<AppState>, id: String) -> Result<(), String> {
    let root = worktree_of(&state, &id).ok_or_else(|| i18n::t("err.session.noWorkspace"))?;
    let ok = Command::new("open").arg(&root).status().map_err(i18n::io)?.success();
    ok.then_some(())
        .ok_or_else(|| i18n::ta("err.session.openFailed", &[("path", root.display().to_string())]))
}

/// Abre o navegador na porta do run. A porta sai do estado, e não do front:
/// URL arbitrária não viaja pelo IPC.
#[tauri::command]
pub fn open_run(state: State<AppState>, id: String) -> Result<(), String> {
    let port = ensure_port(&state, &id).ok_or_else(|| i18n::t("err.session.noPort"))?;
    let url = format!("http://localhost:{port}");
    let ok = Command::new("open").arg(&url).status().map_err(i18n::io)?.success();
    ok.then_some(()).ok_or_else(|| i18n::ta("err.session.openFailed", &[("path", url)]))
}

#[tauri::command]
pub fn close_dock(state: State<AppState>, id: String, kind: String) {
    pty::kill(&state, &format!("{id}:{kind}"));
}

/// Derruba todo dock do workspace — setup, run e terminal. Sem isto, arquivar
/// ou remover deixava o servidor de dev rodando num worktree que o quadro não
/// conhece mais.
fn kill_docks(state: &State<AppState>, id: &str) {
    let prefix = format!("{id}:");
    lock(&state.ptys).retain(|key, _| !key.starts_with(&prefix));
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
/// com o `✗ saiu com código` no fim, que a aba mostra. É desta lista que o
/// front tira quais abas de terminal existem: elas não são fixas como Setup e
/// Run, e trocar de workspace não pode inventar nem perder nenhuma.
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
    lock(&state.ptys)
        .iter()
        .filter_map(|(key, pty)| {
            Some(DockView { kind: key.strip_prefix(&prefix)?.to_string(), alive: pty.alive() })
        })
        .collect()
}

#[tauri::command]
pub fn workspace_scripts(state: State<AppState>, id: String) -> ScriptsView {
    let port = ensure_port(&state, &id);
    let scripts = workspace_copy(&state, &id).map(|ws| scripts_of(&ws)).unwrap_or_default();
    ScriptsView { scripts, port }
}

/// Escreve o exemplo comentado em `.prometheus/settings.toml` e devolve o
/// caminho relativo, para o front abrir no visualizador. Nunca sobrescreve:
/// arquivo que já existe só é apontado — inclusive o do Conductor, que é onde a
/// pessoa vai querer mexer se é lá que a configuração dela mora.
///
/// Worktree que está herdando o do clone ganha uma cópia dele, e não o exemplo:
/// o que a pessoa quer abrir é o que está valendo, e o visualizador só enxerga
/// o worktree. A cópia passa a mandar dali em diante — é assim que um worktree
/// muda o `run` sem mexer no dos outros.
#[tauri::command]
pub fn create_scripts_file(state: State<AppState>, id: String) -> Result<String, String> {
    let ws = workspace_copy(&state, &id).ok_or_else(|| i18n::t("err.session.noWorkspace"))?;
    let root = Path::new(&ws.worktree);
    let found = scripts_of(&ws);
    let (rel, text) = match found.file {
        Some(file) if !found.inherited => return Ok(file),
        Some(file) => {
            let text = std::fs::read_to_string(Path::new(&ws.repo).join(&file)).map_err(|e| e.to_string())?;
            (file, text)
        }
        None => (scripts::FILES[0].to_string(), scripts::TEMPLATE.to_string()),
    };
    let path = root.join(&rel);
    let parent = path.parent().ok_or_else(|| i18n::t("err.session.badPath"))?;
    std::fs::create_dir_all(parent).map_err(i18n::io)?;
    std::fs::write(&path, text).map_err(|e| e.to_string())?;
    Ok(rel)
}

/// O texto que o botão "Perguntar ao agente" manda numa conversa nova. Sai daqui
/// e não do front porque quem sabe o nome do arquivo que já existe é quem leu o
/// disco.
#[tauri::command]
pub fn scripts_prompt(state: State<AppState>, id: String) -> String {
    let file = workspace_copy(&state, &id)
        .and_then(|ws| scripts_of(&ws).file)
        .unwrap_or_else(|| scripts::FILES[0].to_string());
    scripts::ask_prompt(&file)
}

/// O texto que o botão "Open PR" injeta na conversa ativa: o estado do git e
/// os passos até o PR. Sai daqui e não do front porque quem sabe a branch, o
/// alvo e o que falta commitar é quem tem o worktree. Quem commita, empurra e
/// cria o PR é o agente — e uma skill de PR do repositório, quando existe,
/// manda mais que este texto.
#[tauri::command(async)]
pub fn pr_prompt(state: State<AppState>, id: String) -> Result<String, String> {
    let worktree = worktree_of(&state, &id).ok_or_else(|| i18n::t("err.session.noWorkspace"))?;
    let branch = head_branch(&worktree);
    let dirty = changes_in(&worktree).len();
    // O alvo é o principal do remoto; sem `origin/HEAD` gravado, o de sempre.
    let head = git(&worktree, &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).trim().to_string();
    let target = if head.is_empty() { "origin/main".to_string() } else { head };
    let upstream = !git(&worktree, &["rev-parse", "--abbrev-ref", "@{upstream}"]).trim().is_empty();
    // Com PR já aberto o pedido é outro: não criar de novo, e sim empurrar o
    // que falta e conferir se o que está escrito lá ainda cobre a branch.
    let open = branch
        .as_deref()
        .and_then(|b| gh_pr(&worktree, b))
        .filter(|pr| pr.open())
        .map(|pr| pr.number);
    Ok(pr_text(branch.as_deref(), dirty, &target, upstream, open))
}

fn pr_text(branch: Option<&str>, dirty: usize, target: &str, upstream: bool, open: Option<u64>) -> String {
    let estado = match dirty {
        0 => "O worktree está limpo — nada fora de commit.".to_string(),
        1 => "Há 1 arquivo com mudanças fora de commit.".to_string(),
        n => format!("Há {n} arquivos com mudanças fora de commit."),
    };
    let onde = match branch {
        Some(b) => format!("A branch atual é `{b}`"),
        None => "O worktree está em HEAD solto — crie uma branch antes de commitar".to_string(),
    };
    let up = if upstream { "A branch já tem upstream." } else { "Ainda não há branch upstream." };
    let base = target.split_once('/').map_or(target, |(_, b)| b);
    let push = match branch {
        Some(b) => format!("git push -u origin HEAD:{b}"),
        None => "git push -u origin HEAD:<nome-da-branch>".to_string(),
    };
    let (abertura, fim) = match open {
        Some(n) => (
            format!("Quero atualizar o PR #{n} desta branch."),
            format!(
                "5. Revise o diff inteiro da branch contra `{target}` e confira com `gh pr view {n}` se o título e a \
                 descrição ainda cobrem tudo.\n6. Se não cobrirem mais, atualize com `gh pr edit {n}`. Título com \
                 menos de 80 caracteres; descrição com até cinco frases, cobrindo todas as mudanças da branch — não \
                 só as desta conversa."
            ),
        ),
        None => (
            "Quero abrir um PR deste worktree.".to_string(),
            format!(
                "5. Revise o diff inteiro da branch contra `{target}` antes de escrever o PR.\n6. Crie o PR com \
                 `gh pr create --base {base}`. Título com menos de 80 caracteres; descrição com até cinco frases, \
                 cobrindo todas as mudanças da branch — não só as desta conversa."
            ),
        ),
    };
    format!(
        r#"{abertura}

{estado} {onde}; o alvo é `{target}`. {up}

Siga estes passos:

1. Se este repositório tiver uma skill ou comando de abrir PR (ex.: /open-pr), invoque-a agora — as instruções dela têm precedência sobre as daqui.
2. Revise o que está fora de commit com `git status` e `git diff`.
3. Commite seguindo as convenções de commit do repositório.
4. Empurre com `{push}`.
{fim}

Se algum passo falhar, pare e me pergunte."#
    )
}

/// O PR desta branch, se houver um. Quem sabe é o `gh`: é ele que está
/// autenticado no remoto, e o app não guarda credencial de GitHub nenhuma. Sem
/// `gh` instalado, sem login ou sem PR a resposta é a mesma — `None`, e a barra
/// volta a oferecer o "Open PR" de sempre.
#[derive(serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Pr {
    pub number: u64,
    pub title: String,
    #[serde(default)]
    pub is_draft: bool,
    /// `OPEN`, `MERGED` ou `CLOSED`, como o `gh` escreve. É o que faz a barra
    /// oferecer "Concluir" em vez de "Atualizar PR" — mergeado é trabalho que
    /// acabou, e o que vem depois é sair da frente, não empurrar mais commit.
    #[serde(default)]
    pub state: String,
    /// A branch de origem. Só serve para casar o PR com o workspace quando a
    /// pergunta foi feita para o repositório inteiro, e não para uma branch.
    #[serde(default, skip_serializing)]
    pub head_ref_name: String,
}

impl Pr {
    pub fn merged(&self) -> bool {
        self.state == "MERGED"
    }
    pub fn open(&self) -> bool {
        self.state == "OPEN"
    }
}

/// Pergunta o PR desta branch e grava no quadro. É o caminho rápido de quem
/// abriu o workspace: `refresh_prs` varre tudo de minuto em minuto, e voltar do
/// navegador de mergear não precisa esperar a próxima varredura.
#[tauri::command(async)]
pub fn pr_open(app: AppHandle, state: State<AppState>, id: String) -> Option<Pr> {
    let worktree = worktree_of(&state, &id)?;
    let pr = gh_pr(&worktree, &head_branch(&worktree)?);
    remember_pr(&app, &state, &id, pr.clone());
    pr
}

/// O PR de cada workspace vivo, numa pergunta por repositório em vez de uma por
/// branch: quem responde é o `gh`, que fala com a rede, e são as branches do
/// mesmo repo que cabem na mesma resposta. O front chama de tempos em tempos —
/// é assim que o selo de mergeado aparece no card de um workspace que ninguém
/// abriu desde que o PR entrou.
#[tauri::command(async)]
pub fn refresh_prs(app: AppHandle, state: State<AppState>) {
    // Arquivado limpo não tem mais branch para perguntar por; arquivado que
    // ainda tem worktree, sim — é dele que sai a limpeza, e ela quer saber se
    // mergeou.
    let alive: Vec<Workspace> = lock(&state.board)
        .workspaces
        .iter()
        .filter(|w| !w.cleaned && !w.branch.is_empty())
        .cloned()
        .collect();

    let mut by_repo: BTreeMap<String, Vec<Workspace>> = BTreeMap::new();
    for ws in alive {
        by_repo.entry(ws.repo.clone()).or_default().push(ws);
    }

    let mut found: Vec<(String, Option<Pr>)> = Vec::new();
    for (repo, list) in by_repo {
        let prs = gh_prs(Path::new(&repo));
        // Sem `gh`, sem login ou sem rede a resposta é vazia — e aí não se
        // apaga o que já se sabia: PR que existia não deixou de existir porque
        // o wifi caiu.
        if prs.is_empty() {
            continue;
        }
        for ws in list {
            found.push((ws.id, pick(&prs, &ws.branch)));
        }
    }

    // Publicar é gravar o quadro e redesenhar a tela. De minuto em minuto, sem
    // nada ter mudado, isso é escrita em disco por nada.
    let mut moved = false;
    {
        let mut board = lock(&state.board);
        for (id, pr) in found {
            if let Some(ws) = board.workspace_mut(&id) {
                if same(ws.pr.as_ref(), pr.as_ref()) {
                    continue;
                }
                ws.pr = pr;
                moved = true;
            }
        }
    }
    if moved {
        publish(&app);
    }
}

fn same(a: Option<&Pr>, b: Option<&Pr>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => a.number == b.number && a.state == b.state && a.is_draft == b.is_draft,
        _ => false,
    }
}

/// Guarda no quadro o que o `gh` respondeu. Resposta vazia com PR já conhecido
/// é `gh` mudo — sem rede, sem login —, e esquecer o PR por causa disso faria o
/// botão da barra piscar entre "Atualizar PR" e "Open PR".
fn remember_pr(app: &AppHandle, state: &State<AppState>, id: &str, pr: Option<Pr>) {
    {
        let mut board = lock(&state.board);
        let Some(ws) = board.workspace_mut(id) else { return };
        if pr.is_none() && ws.pr.is_some() {
            return;
        }
        ws.pr = pr;
    }
    publish(app);
}

/// Entre os PRs do repositório, o desta branch: um aberto manda mais que um
/// fechado, e entre iguais vale o mais novo — que é a ordem em que o `gh`
/// responde.
fn pick(prs: &[Pr], branch: &str) -> Option<Pr> {
    let mine = || prs.iter().filter(|p| p.head_ref_name == branch);
    mine().find(|p| p.open()).or_else(|| mine().next()).cloned()
}

fn gh_pr(wt: &Path, branch: &str) -> Option<Pr> {
    pick(&gh_list(wt, &["--head", branch, "--limit", "5"]), branch)
}

fn gh_prs(repo: &Path) -> Vec<Pr> {
    gh_list(repo, &["--limit", "60"])
}

/// `--state all` porque mergeado é a resposta que mais importa: é ela que
/// transforma o botão da barra em "Concluir" e libera a limpeza do worktree.
fn gh_list(dir: &Path, extra: &[&str]) -> Vec<Pr> {
    let out = Command::new("gh")
        .current_dir(dir)
        .args(["pr", "list", "--state", "all", "--json", "number,title,isDraft,state,headRefName"])
        .args(extra)
        .output();
    let Ok(out) = out else { return Vec::new() };
    if !out.status.success() {
        return Vec::new();
    }
    serde_json::from_slice::<Vec<Pr>>(&out.stdout).unwrap_or_default()
}

/// Abre no navegador o PR desta branch. Quem descobre a URL é o `gh`, e é ele
/// mesmo quem abre — assim nenhuma URL atravessa o IPC, em direção nenhuma.
#[tauri::command(async)]
pub fn open_pr(state: State<AppState>, id: String) -> Result<(), String> {
    let ws = workspace_copy(&state, &id).ok_or_else(|| i18n::t("err.session.noWorkspace"))?;
    // Com o worktree devolvido, quem tem o número é o quadro e quem abre é o
    // `gh` de dentro do clone: PR mergeado continua sendo lugar aonde se volta.
    let (dir, what) = match (ws.cleaned, ws.pr.as_ref()) {
        (false, _) => (ws.worktree.clone(), head_branch(Path::new(&ws.worktree)).ok_or_else(|| i18n::t("err.session.noPr"))?),
        (true, Some(pr)) => (ws.repo.clone(), pr.number.to_string()),
        (true, None) => return Err(i18n::t("err.session.noPr")),
    };
    let ok = Command::new("gh")
        .current_dir(&dir)
        .args(["pr", "view", what.as_str(), "--web"])
        .status()
        .map_err(i18n::io)?
        .success();
    ok.then_some(()).ok_or_else(|| i18n::t("err.session.noPr"))
}

fn workspace_copy(state: &State<AppState>, id: &str) -> Option<Workspace> {
    lock(&state.board).workspaces.iter().find(|w| w.id == id).cloned()
}

/// O worktree deste workspace, se ainda houver um. Devolvido ao disco é o mesmo
/// que não existir: quem lê arquivo, diff ou branch daqui recebe o vazio, e não
/// um caminho que já não é de ninguém.
fn worktree_of(state: &State<AppState>, id: &str) -> Option<PathBuf> {
    lock(&state.board)
        .workspaces
        .iter()
        .find(|w| w.id == id && !w.cleaned)
        .map(|w| PathBuf::from(&w.worktree))
}
