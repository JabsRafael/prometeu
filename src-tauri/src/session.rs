use crate::domain::Pr;
use crate::lock::lock;
use crate::state::{publish, Board, Project, Repo, Status, Tab, Workspace};
use crate::{chat, dock, i18n, paths, scripts, AppState};
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
pub fn add_project(
    app: AppHandle,
    state: State<AppState>,
    path: String,
) -> Result<Project, String> {
    let path = PathBuf::from(expand(&path));
    if !path.join(".git").exists() {
        return Err(i18n::ta(
            "err.session.notGit",
            &[("path", path.display().to_string())],
        ));
    }
    let id = path.display().to_string();
    let project = Project {
        id: id.clone(),
        name: path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("repo")
            .to_string(),
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
        dock::kill_docks(state, id);
        if let Some(ws) = workspace_copy(state, id) {
            if let Some(command) = dock::scripts_of(&ws).archive {
                let mut cmd = Command::new("/bin/sh");
                cmd.args(["-lc", &command])
                    .current_dir(&ws.primary().worktree);
                for (key, value) in dock::script_env(&ws) {
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

/// Encerra as sessões destas abas: o processo morre. Transcript e worktree
/// ficam — a próxima fala retoma.
fn stop(state: &State<AppState>, tabs: &[String]) {
    for tab in tabs {
        chat::kill(state, tab);
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
pub fn set_shared(
    app: AppHandle,
    state: State<AppState>,
    id: String,
    shared: bool,
    audience: Option<Vec<String>>,
) {
    {
        let mut board = lock(&state.board);
        if let Some(ws) = board.workspace_mut(&id) {
            ws.shared = shared;
            ws.audience = if shared { audience } else { None };
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
    dock::kill_docks(&state, &id);
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
///
/// Workspace que roda no próprio clone fica de fora: não há pasta para
/// devolver, e medi-lo seria um `du` do repositório inteiro por linha — era
/// isso que fazia a lista demorar. As linhas que sobram são medidas em
/// paralelo: cada `du` anda numa árvore diferente, e o disco aguenta.
#[tauri::command(async)]
pub fn cleanup_list(state: State<AppState>) -> Vec<Cleanable> {
    let mine: Vec<Workspace> = lock(&state.board)
        .workspaces
        .iter()
        .filter(|w| has_worktree(w))
        .cloned()
        .collect();

    std::thread::scope(|scope| {
        let handles: Vec<_> = mine
            .into_iter()
            .map(|ws| {
                scope.spawn(move || {
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
            })
            .collect();
        handles.into_iter().filter_map(|h| h.join().ok()).collect()
    })
}

/// Arquivado que ainda tem um worktree só dele para devolver. O que já foi
/// devolvido não conta, e o que roda no próprio clone nunca contou: a pasta
/// é o repositório.
fn has_worktree(ws: &Workspace) -> bool {
    ws.archived && !ws.cleaned && ws.worktree != ws.repo
}

/// Devolve o worktree ao disco: a pasta sai, a branch local sai, o card fica.
/// Destrutivo e sem volta.
///
/// `force` é a tela dizendo que a pessoa leu o motivo em vermelho e marcou
/// assim mesmo — mudança fora de commit e trabalho que não entrou no alvo vão
/// junto. O que `force` não desliga é o que nem a pessoa quer: arquivar antes,
/// e nunca apagar o próprio clone.
#[tauri::command(async)]
pub fn cleanup_worktree(
    app: AppHandle,
    state: State<AppState>,
    id: String,
    force: bool,
) -> Result<(), String> {
    let ws = workspace_copy(&state, &id).ok_or_else(|| i18n::t("err.session.noWorkspace"))?;
    if ws.cleaned {
        return Ok(());
    }
    if force {
        hard(&ws)?;
    } else {
        check(&ws)?;
    }
    if ws.multi() {
        validate_multi_root(&ws)?;
    }

    // O agente e os docks caem antes de a pasta sumir debaixo deles. O script
    // `archive` do repositório não roda aqui: ele já rodou quando este
    // workspace foi arquivado, e ele sobe solto — dispará-lo agora seria soltar
    // um processo no worktree ao mesmo tempo que o git o apaga.
    dock::kill_docks(&state, &id);
    let dead: Vec<String> = lock(&state.board)
        .workspace_mut(&id)
        .map(|ws| ws.tabs.iter().map(|t| t.id.clone()).collect())
        .unwrap_or_default();
    stop(&state, &dead);

    // Um worktree por repositório, e cada um sai do seu clone.
    for r in &ws.repos {
        let repo = PathBuf::from(&r.path);
        let wt = PathBuf::from(&r.worktree);
        if wt.exists() {
            // `--force` porque o que sobrou é o que o `.gitignore` esconde:
            // `node_modules`, `target`, `.env` — e, quando a pessoa marcou o
            // vermelho, também a mudança fora de commit que ela decidiu perder.
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
                        (
                            "cause",
                            String::from_utf8_lossy(&out.stderr).trim().to_string(),
                        ),
                    ],
                ));
            }
        }
        // `-D` e não `-d`: sem `force` a branch já não tem nada que o alvo não
        // tenha, e com `force` perdê-la é justamente o que foi marcado. Se o git
        // recusar — ela está em check-out em outro lugar —, o worktree já foi e o
        // trabalho aqui está feito: uma branch a mais no repositório não é motivo
        // para devolver erro a quem só queria o disco de volta.
        if !ws.branch.is_empty() {
            let _ = git(&repo, &["branch", "-D", &ws.branch]);
        }
        let _ = git(&repo, &["worktree", "prune"]);
    }
    // A pasta que reunia os worktrees é do Prometheus: sem eles, só sobra o
    // que o app escreveu nela, e ela vai junto.
    if ws.multi() {
        let _ = std::fs::remove_dir_all(&ws.worktree);
    }

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
    hard(ws)?;
    // Cada repositório responde por si, e basta um segurar para nenhum sair:
    // os worktrees são de um trabalho só, e devolver metade dele não é limpar.
    for r in &ws.repos {
        let wt = PathBuf::from(&r.worktree);
        if !wt.exists() {
            continue;
        }
        let dirty = git(&wt, &["status", "--porcelain"]).lines().count();
        if dirty > 0 {
            return Err(i18n::ta("err.cleanup.dirty", &[("n", dirty.to_string())]));
        }
        // O PR que o quadro guarda é o do principal; os outros só têm o git.
        let pr = (r.path == ws.repo).then_some(ws.pr.as_ref()).flatten();
        if !merged(pr, &wt) {
            return Err(i18n::ta(
                "err.cleanup.unmerged",
                &[("branch", ws.branch.clone())],
            ));
        }
    }
    Ok(())
}

/// As duas guardas que `force` não levanta: nem a pessoa mais decidida quer
/// apagar um worktree que ainda está em uso, nem o clone dela.
fn hard(ws: &Workspace) -> Result<(), String> {
    // Arquivar primeiro é o que faz o `archive` do repositório rodar com o
    // worktree ainda de pé. Devolver o disco é o passo depois dele, nunca no
    // lugar dele.
    if !ws.archived {
        return Err(i18n::t("err.cleanup.notArchived"));
    }
    if ws.worktree == ws.repo {
        return Err(i18n::t("err.cleanup.isRepo"));
    }
    Ok(())
}

/// A raiz agregadora é a única pasta que removemos diretamente; os worktrees
/// individuais são removidos pelo próprio Git. Por isso o caminho precisa ser
/// exatamente o que `create_workspace` teria produzido, e cada filho precisa
/// estar imediatamente abaixo dele. Um `board.json` editado ou corrompido não
/// pode transformar `remove_dir_all` numa remoção de pasta arbitrária.
fn validate_multi_root(ws: &Workspace) -> Result<(), String> {
    use std::path::Component;

    let normal = |name: &str| {
        let mut components = Path::new(name).components();
        matches!(components.next(), Some(Component::Normal(_))) && components.next().is_none()
    };
    if ws.repos.len() < 2 || ws.repos.iter().any(|repo| !normal(&repo.name)) {
        return Err(i18n::t("err.cleanup.badRoot"));
    }
    let names: Vec<String> = ws.repos.iter().map(|repo| repo.name.clone()).collect();
    let expected = paths::multi_dir(&names, &ws.branch);
    let root = Path::new(&ws.worktree);
    let children_match = ws.repos.iter().all(|repo| {
        let child = Path::new(&repo.worktree);
        child.parent() == Some(root) && child.file_name() == Some(repo.name.as_ref())
    });
    if root == expected && children_match {
        Ok(())
    } else {
        Err(i18n::t("err.cleanup.badRoot"))
    }
}

/// O trabalho já está em outro lugar? Duas respostas servem: o `gh` dizendo que
/// o PR mergeou, ou o git dizendo que o que está aqui já é ancestral do alvo —
/// que é o que sobra quando o merge foi por fora do GitHub, ou o `gh` não
/// existe nesta máquina.
fn merged(pr: Option<&Pr>, wt: &Path) -> bool {
    if pr.is_some_and(|pr| pr.merged()) {
        return true;
    }
    let head = git(wt, &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
        .trim()
        .to_string();
    let target = if head.is_empty() {
        "origin/main".to_string()
    } else {
        head
    };
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
    /// Os outros repositórios do workspace, quando a funcionalidade atravessa
    /// mais de um: cada um ganha um worktree na mesma branch, lado a lado com
    /// o do `project`. Só existe com `worktree` ligado — o agente precisa de
    /// uma pasta que contenha todos, e clones espalhados não têm uma.
    #[serde(default)]
    extras: Vec<String>,
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
    /// Qual CLI sobe na aba: vazio (ou `claude`) é o Claude Code, `codex` é o
    /// Codex. Sai do modelo escolhido no lançador, e não de um botão à parte —
    /// escolher um GPT é escolher o Codex.
    #[serde(default)]
    pub agent: String,
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
        Launch {
            agent: self.agent.clone(),
            model: self.model.clone(),
            effort: self.effort.clone(),
            plan: false,
        }
    }
}

/// Criar é otimista: o card entra no quadro agora, e o que demora acontece
/// atrás.
///
/// O que demora é o disco — `git worktree add` de um repositório com milhares
/// de arquivos passa de um segundo, e o `fetch` da base soma rede a isso. Antes
/// tudo isso ficava entre o clique e a resposta, e o lançador fechava para uma
/// tela parada. Aqui só fica o que dá para saber sem tocar em disco: se o
/// caminho é um repositório, onde o worktree vai ficar, qual é a branch, qual é
/// a porta. Com isso o `Workspace` já é inteiro o bastante para desenhar, entra
/// no quadro marcado como `preparing`, e a resposta volta em milissegundos.
///
/// A montagem de verdade é `prepare`, numa thread, e cada etapa dela chega à
/// tela pelo `publish` — que é o mesmo caminho por onde toda mudança do quadro
/// já chegava.
#[tauri::command(async)]
pub fn create_workspace(
    app: AppHandle,
    state: State<AppState>,
    draft: Draft,
    cols: u16,
    rows: u16,
) -> Result<Workspace, String> {
    let repo_path = PathBuf::from(expand(&draft.project));
    let repo_name = repo_named(&repo_path)?;

    // Os outros repositórios, conferidos do mesmo jeito. Dois clones com a
    // mesma pasta de nome cairiam no mesmo worktree, e o principal repetido
    // seria o mesmo repo duas vezes: os dois são erro, não dedução.
    let mut extras: Vec<(PathBuf, String)> = Vec::new();
    for extra in &draft.extras {
        let path = PathBuf::from(expand(extra));
        let name = repo_named(&path)?;
        if path == repo_path || extras.iter().any(|(p, n)| *p == path || *n == name) {
            return Err(i18n::ta("err.session.dupRepo", &[("name", name)]));
        }
        extras.push((path, name));
    }
    if !extras.is_empty() && !draft.worktree {
        return Err(i18n::t("err.session.extrasNeedWorktree"));
    }

    // Branch vazia é a escolha de não criar branch nenhuma: a sessão abre no
    // repositório onde ele estiver. Worktree, esse, sempre precisa de uma —
    // é a branch que dá nome e destino à pasta.
    //
    // Os dois saem de conta, não de disco: o destino é função do nome do repo e
    // da branch, e a branch ou veio digitada ou é o HEAD do clone. Dá para
    // saber os dois antes de existir pasta nenhuma, e é isso que deixa o card
    // nascer já com o nome e o caminho certos.
    //
    // Com mais de um repositório, a raiz é uma pasta que reúne o worktree de
    // cada um: é nela que o agente roda, e é ela que a árvore mostra.
    let (root, branch) = match (draft.worktree, draft.branch.trim().is_empty()) {
        (true, true) => return Err(i18n::t("err.session.worktreeNeedsBranch")),
        (true, false) if extras.is_empty() => (
            paths::worktree_dir(&repo_name, &draft.branch),
            draft.branch.clone(),
        ),
        (true, false) => {
            let names: Vec<String> = std::iter::once(repo_name.clone())
                .chain(extras.iter().map(|(_, n)| n.clone()))
                .collect();
            (
                paths::multi_dir(&names, &draft.branch),
                draft.branch.clone(),
            )
        }
        (false, false) => (repo_path.clone(), draft.branch.clone()),
        (false, true) => (
            repo_path.clone(),
            head_branch(&repo_path).unwrap_or_else(|| "HEAD".into()),
        ),
    };
    let repos: Vec<Repo> = match extras.is_empty() {
        true => vec![Repo {
            path: repo_path.display().to_string(),
            name: repo_name.clone(),
            worktree: root.display().to_string(),
        }],
        false => std::iter::once((repo_path.clone(), repo_name.clone()))
            .chain(extras)
            .map(|(path, name)| Repo {
                worktree: root.join(&name).display().to_string(),
                path: path.display().to_string(),
                name,
            })
            .collect(),
    };

    // A porta sai antes de qualquer script, porque é ela que o `setup` e o `run`
    // recebem no ambiente — e é o que deixa dois worktrees do mesmo projeto
    // subirem o servidor ao mesmo tempo sem um matar o outro.
    //
    // O lock sai antes dos binds: `alloc_port` é syscall, e é neste mesmo lock
    // que todo `publish` de toda sessão espera.
    let taken: Vec<u16> = lock(&state.board)
        .workspaces
        .iter()
        .filter_map(|w| w.port)
        .collect();
    let port = scripts::alloc_port(&root, &taken);

    let ws = Workspace {
        id: uuid::Uuid::new_v4().to_string(),
        title: if draft.title.trim().is_empty() {
            branch.clone()
        } else {
            draft.title.clone()
        },
        issue: draft.issue.clone(),
        project: repo_path.display().to_string(),
        repo: repo_path.display().to_string(),
        repo_name,
        branch,
        worktree: root.display().to_string(),
        repos,
        stage: draft.stage.clone(),
        archived: false,
        pinned: false,
        unread: false,
        pr: None,
        cleaned: false,
        shared: false,
        audience: None,
        preparing: true,
        failed: None,
        agent: draft.launch.agent.clone(),
        model: draft.launch.model.clone(),
        effort: draft.launch.effort.clone(),
        port,
        active: None,
        tabs: Vec::new(),
    };

    // O workspace entra no quadro antes de qualquer coisa subir: é no quadro
    // que o fim do setup vai procurar as abas com fala guardada — e é ele que a
    // tela abre enquanto o resto não chega.
    lock(&state.board).workspaces.push(ws.clone());
    publish(&app);

    // O nome que veio do lançador é a primeira linha do prompt cortada; o bom
    // vem de um agente lendo o pedido inteiro, em paralelo. Ele começa aqui, e
    // não depois de montar a pasta: nomear não depende do worktree, e esperar o
    // `git worktree add` de um repositório grande só para *começar* a pensar num
    // título é somar segundos que ninguém precisava esperar.
    // Workspace que saiu de uma issue já tem o nome que a issue deu.
    if ws.issue.is_none() {
        crate::naming::rename_later(&app, &ws.id, &draft.prompt, &ws.title, &draft.launch);
    }

    let (bg, id) = (app.clone(), ws.id.clone());
    std::thread::spawn(move || prepare(&bg, &id, draft, cols, rows));

    Ok(ws)
}

/// A parte demorada de criar um workspace, fora da thread que respondeu ao
/// lançador: montar a pasta, subir o agente, subir o setup.
///
/// Falhar aqui não desfaz nada e não apaga o card. Quem falha é quase sempre o
/// `git worktree add`, e quase sempre porque a branch pedida está viva em outro
/// worktree — desfazer sozinho apagaria a única pista disso. O erro fica
/// escrito no card, que é de onde se decide o que fazer com a branch.
fn prepare(app: &AppHandle, id: &str, draft: Draft, cols: u16, rows: u16) {
    let Err(err) = build(app, id, &draft, cols, rows) else {
        return;
    };
    let state = app.state::<AppState>();
    {
        let mut board = lock(&state.board);
        let Some(ws) = board.workspace_mut(id) else {
            return;
        };
        ws.preparing = false;
        ws.failed = Some(err);
    }
    publish(app);
}

fn build(app: &AppHandle, id: &str, draft: &Draft, cols: u16, rows: u16) -> Result<(), String> {
    let state = app.state::<AppState>();
    let (repo, root, branch, repos) = {
        let board = lock(&state.board);
        let ws = board
            .workspaces
            .iter()
            .find(|w| w.id == id)
            .ok_or_else(|| i18n::t("err.session.noWorkspace"))?;
        (
            PathBuf::from(&ws.repo),
            PathBuf::from(&ws.worktree),
            ws.branch.clone(),
            ws.repos.clone(),
        )
    };

    // A pasta. É o segundo que se sentia ao criar, e é por isso que ele mora
    // aqui atrás e não entre o clique e a resposta.
    //
    // Com mais de um repositório é um worktree por repo, todos na mesma
    // branch. A base escolhida no lançador é do principal — a lista de
    // branches era dele —, e nos outros a branch nova sai do que cada um tem
    // como principal (`origin/main`, ou o que o clone gravou). Branch que já
    // existe no repo ignora a base de qualquer jeito.
    if draft.worktree {
        for r in &repos {
            let base = match r.path == repo.display().to_string() {
                true => draft.base.clone(),
                false => default_base(Path::new(&r.path)),
            };
            add_worktree(Path::new(&r.path), &branch, &base, Path::new(&r.worktree))?;
        }
        if repos.len() > 1 {
            describe_root(&root, &repos, &branch);
        }
    } else if !draft.branch.trim().is_empty() {
        switch_branch(&repo, &branch, &draft.base)?;
    }

    let tab = spawn_tab(
        app,
        &state,
        &root,
        "conversa",
        first_message(&draft.prompt, &draft.inject),
        &draft.launch,
    )?;

    // Tirado do quadro no meio da montagem: o agente que acabou de subir não
    // tem mais card nenhum a que pertencer, e deixá-lo vivo seria um `claude`
    // rodando num worktree que ninguém vê.
    let ws = {
        let mut board = lock(&state.board);
        let Some(ws) = board.workspace_mut(id) else {
            drop(board);
            chat::kill(&state, &tab.id);
            return Ok(());
        };
        ws.preparing = false;
        ws.active = Some(tab.id.clone());
        ws.tabs.push(tab);
        ws.clone()
    };
    publish(app);

    // Worktree recém-nascido não tem nada que o `.gitignore` esconde:
    // dependências, `.env`, banco, build. O que dá para reconstruir é o setup
    // que reconstrói; o que não dá — segredo, chave — vem copiado do clone,
    // antes dele. Os dois são a aba Setup. O processo do agente sobe junto,
    // mas a primeira fala só vai quando o setup termina (ver
    // `release_prompts`): agente que roda teste antes de haver `node_modules`
    // conclui coisa errada. Falhar aqui não desfaz o worktree; o erro fica
    // escrito na aba Setup, que é onde se conserta.
    let _ = dock::start_setup(app, &state, &ws, cols, rows);
    // Com o setup de pé a fala espera por ele; sem setup, vai agora.
    if let Some(tab) = ws.tabs.last() {
        chat::ready_now(app, &tab.id);
    }

    Ok(())
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
) -> Result<Tab, String> {
    // Modelo e esforço são do workspace: conversa nova nos mesmos arquivos
    // nasce com os mesmos que as irmãs. Plan mode não — é escolha de uma fala.
    let (worktree, n, launch) = {
        let board = lock(&state.board);
        let ws = board
            .workspaces
            .iter()
            .find(|w| w.id == workspace)
            .ok_or_else(|| i18n::t("err.session.noWorkspace"))?;
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
    let tab = spawn_tab(&app, &state, &worktree, &title, pending, &launch)?;

    {
        let mut board = lock(&state.board);
        if let Some(ws) = board.workspace_mut(&workspace) {
            ws.active = Some(tab.id.clone());
            ws.tabs.push(tab.clone());
        }
    }
    publish(&app);
    chat::ready_now(&app, &tab.id);
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
/// reboot — então `--resume` devolve a conversa inteira de onde parou. `true`
/// é retomou; `false` é conversa que nunca falou, reaberta nova no mesmo lugar.
#[tauri::command]
pub fn resume_tab(app: AppHandle, state: State<AppState>, tab: String) -> Result<bool, String> {
    revive(&app, &state, &tab)
}

/// Sobe de novo o processo de uma aba. É o `resume_tab`, e é o que a primeira
/// fala numa aba desligada faz por conta própria (`chat::chat_send`).
pub fn revive(app: &AppHandle, state: &State<AppState>, tab: &str) -> Result<bool, String> {
    let (worktree, launch, cleaned, agent_session) = lock(&state.board)
        .workspace_of(tab)
        .map(|w| {
            let previous = w
                .tabs
                .iter()
                .find(|t| t.id == tab)
                .and_then(|t| t.agent_session.clone());
            (PathBuf::from(&w.worktree), w.launch(), w.cleaned, previous)
        })
        .ok_or_else(|| i18n::t("err.session.noTab"))?;
    if cleaned {
        return Err(i18n::t("err.session.cleaned"));
    }
    if !worktree.exists() {
        return Err(i18n::ta(
            "err.session.noWorktree",
            &[("path", worktree.display().to_string())],
        ));
    }

    // O que sobrou da sessão anterior sai antes: o processo já morreu, mas o
    // `Chat` continua no mapa até alguém tirar.
    chat::kill(state, tab);

    // Conversa que nunca falou não tem transcript, e retomar morre nela. Aí a
    // aba renasce com o mesmo id: não há nada perdido, e travar a tela num erro
    // por causa de uma conversa vazia seria pior. No Codex a pergunta é outra —
    // se ele já contou qual thread abriu —, porque o transcript dele não mora
    // num caminho que dê para adivinhar.
    let (resume, handle) = match launch.agent.as_str() {
        "codex" => (
            agent_session.is_some(),
            crate::codex::spawn(app, tab, &worktree, agent_session, &launch)?,
        ),
        _ => {
            let resume = paths::transcript(tab, &worktree).exists();
            (
                resume,
                chat::spawn(app, tab, &worktree, claude_args(tab, resume, &launch))?,
            )
        }
    };
    lock(&state.chats).insert(tab.to_string(), handle);
    chat::ready_now(app, tab);
    {
        let mut board = lock(&state.board);
        if let Some(t) = board.tab_mut(tab) {
            t.status = Status::Pronta;
            t.note = None;
        }
    }
    publish(app);
    Ok(resume)
}

fn spawn_tab(
    app: &AppHandle,
    state: &State<AppState>,
    worktree: &Path,
    title: &str,
    pending_prompt: Option<String>,
    launch: &Launch,
) -> Result<Tab, String> {
    let id = uuid::Uuid::new_v4().to_string();
    // O modelo escolhido diz qual CLI sobe (ver `agents.rs`); a aba é a mesma.
    let handle = match launch.agent.as_str() {
        "codex" => crate::codex::spawn(app, &id, worktree, None, launch)?,
        _ => chat::spawn(app, &id, worktree, claude_args(&id, false, launch))?,
    };
    lock(&state.chats).insert(id.clone(), handle);
    // Quem chama põe a aba no quadro e só então libera a fala
    // (`chat::ready_now`): a fala guardada mora na aba, e a aba nasce aqui.
    Ok(Tab {
        id,
        agent_session: None,
        title: title.to_string(),
        status: Status::Pronta,
        note: None,
        pending_prompt,
        tokens: None,
    })
}

/* ---------- plumbing ---------- */

/// Os argumentos do `claude`. `resume` decide se a sessão nasce nova ou
/// continua a que já existe — o id é o mesmo nos dois casos.
///
/// O modo é o headless com JSON dos dois lados: cada coisa que o agente faz
/// sai como uma linha, cada fala entra como uma linha, e o processo fica de pé
/// entre um turno e outro (`chat.rs`). `--permission-prompt-tool stdio` é o
/// que faz pergunta, plano e pedido de permissão chegarem pelo mesmo cano, em
/// vez de a sessão morrer sem ninguém para responder.
///
/// O agente roda solto: cada sessão vive no seu worktree e não para a cada
/// ferramenta — que é o motivo de existir o quadro. Em plan mode nasce
/// perguntando, e é a aprovação do plano que o solta: a tela manda um
/// `set_permission_mode` para bypass junto com o "sim" (ver `chat.ts`). Aqui
/// vai o `--allow-…`, sem o qual o `claude` recusa a troca — e sem o
/// `--dangerously-…`, que junto do `--permission-mode plan` ganha do plan.
fn claude_args(id: &str, resume: bool, launch: &Launch) -> Vec<String> {
    let mut args: Vec<String> = [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--include-partial-messages",
        "--verbose",
        "--permission-prompt-tool",
        "stdio",
        if resume { "--resume" } else { "--session-id" },
        id,
    ]
    .map(String::from)
    .to_vec();
    if launch.plan {
        args.extend(
            [
                "--permission-mode",
                "plan",
                "--allow-dangerously-skip-permissions",
            ]
            .map(String::from),
        );
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
                &[
                    ("path", dest.display().to_string()),
                    ("head", head),
                    ("branch", branch.to_string()),
                ],
            )),
            None => Err(i18n::ta(
                "err.session.worktreeDetached",
                &[("path", dest.display().to_string())],
            )),
        };
    }
    let parent = dest
        .parent()
        .ok_or_else(|| i18n::t("err.session.noParent"))?;
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

    let out = cmd
        .output()
        .map_err(|e| i18n::ta("err.git.spawn", &[("cause", e.to_string())]))?;
    if !out.status.success() {
        return Err(i18n::ta(
            "err.git",
            &[
                ("command", "git worktree add".into()),
                (
                    "cause",
                    String::from_utf8_lossy(&out.stderr).trim().to_string(),
                ),
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

    let out = cmd
        .output()
        .map_err(|e| i18n::ta("err.git.spawn", &[("cause", e.to_string())]))?;
    if !out.status.success() {
        return Err(i18n::ta(
            "err.git",
            &[
                ("command", "git switch".into()),
                (
                    "cause",
                    String::from_utf8_lossy(&out.stderr).trim().to_string(),
                ),
            ],
        ));
    }
    Ok(())
}

fn head_branch(repo: &Path) -> Option<String> {
    let name = git(repo, &["rev-parse", "--abbrev-ref", "HEAD"])
        .trim()
        .to_string();
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
            &[
                ("base", base.to_string()),
                ("path", repo.display().to_string()),
            ],
        )),
    }
}

/// `git fetch` com coleira: rede pendurada não pode virar app pendurado, e a
/// base local velha ainda dá um worktree utilizável.
fn fetch(repo: &Path, remote: &str, branch: &str) -> Result<(), String> {
    let mut child = Command::new("git")
        .arg("-C")
        .arg(repo)
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
        .arg("-C")
        .arg(repo)
        .args(["rev-parse", "--verify", "--quiet"])
        .arg(format!("{reference}^{{commit}}"))
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// O nome de um clone, conferindo antes que ele é um repositório git.
fn repo_named(path: &Path) -> Result<String, String> {
    if !path.join(".git").exists() {
        return Err(i18n::ta(
            "err.session.notGit",
            &[("path", path.display().to_string())],
        ));
    }
    path.file_name()
        .and_then(|s| s.to_str())
        .map(str::to_string)
        .ok_or_else(|| i18n::t("err.session.badPath"))
}

/// O que um agente encontra ao abrir a pasta de um workspace com mais de um
/// repositório: qual é qual, e que todos estão na mesma branch. O Claude Code
/// lê `CLAUDE.md` de onde roda e o Codex lê `AGENTS.md`; os dois recebem o
/// mesmo texto. Nunca sobrescreve — a pessoa pode ter escrito o dela.
fn describe_root(root: &Path, repos: &[Repo], branch: &str) {
    let list: String = repos
        .iter()
        .map(|r| {
            format!(
                "- `{}/` — {} `{}`\n",
                r.name,
                i18n::pick("clone em", "clone at"),
                r.path
            )
        })
        .collect();
    let text = i18n::pick(
        &format!(
            "# Workspace com {} repositórios\n\nEsta pasta reúne um worktree por repositório, todos na branch `{branch}`:\n\n{list}\nCada um é um repositório git independente: commits, `git status` e PRs são por pasta. Leia o `CLAUDE.md` ou `AGENTS.md` de cada um antes de mexer nele.\n",
            repos.len()
        ),
        &format!(
            "# Workspace with {} repositories\n\nThis folder holds one worktree per repository, all on branch `{branch}`:\n\n{list}\nEach one is an independent git repository: commits, `git status` and PRs are per folder. Read each one's `CLAUDE.md` or `AGENTS.md` before working on it.\n",
            repos.len()
        ),
    );
    for name in ["CLAUDE.md", "AGENTS.md"] {
        let file = root.join(name);
        if !file.exists() {
            let _ = std::fs::write(&file, &text);
        }
    }
}

/// De onde uma branch nova sai neste repositório quando ninguém escolheu:
/// `origin/HEAD` como o clone gravou, senão os nomes de sempre, senão a branch
/// em que ele está. É a mesma conta que encabeça a lista do lançador.
fn default_base(repo: &Path) -> String {
    list_branches(repo.display().to_string()).default
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
        git(
            &repo,
            &[
                "for-each-ref",
                "--sort=-committerdate",
                "--format=%(refname:short)",
                pattern,
            ],
        )
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
    let head = git(
        &repo,
        &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    )
    .trim()
    .to_string();
    let default = [head, "origin/main".to_string(), "origin/master".to_string()]
        .into_iter()
        .find(|r| !r.is_empty() && remotes.contains(r))
        .or_else(|| {
            let head = git(&repo, &["rev-parse", "--abbrev-ref", "HEAD"])
                .trim()
                .to_string();
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
    let mut patches = patch_map(&git(
        wt,
        &["diff", "--no-color", "--no-renames", "-U3", "HEAD"],
    ));

    let mut out: Vec<FileChange> = git(wt, &["diff", "--numstat", "--no-renames", "HEAD"])
        .lines()
        .filter_map(|l| {
            let mut f = l.split('\t');
            let added = f.next()?.parse().unwrap_or(0);
            let removed = f.next()?.parse().unwrap_or(0);
            let path = f.next()?.to_string();
            let patch = patches.remove(&path).unwrap_or_default();
            Some(FileChange {
                path,
                added,
                removed,
                new_file: false,
                patch,
            })
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
        out.push(FileChange {
            path: path.to_string(),
            added,
            removed: 0,
            new_file: true,
            patch: cap(patch),
        });
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
    use super::{claude_args, patch_map, pr_text, Launch, Pr, Repo};
    use crate::dock::{is_terminal, multi_setup, quoted};
    use std::path::Path;

    fn pr(number: u64, branch: &str, state: &str) -> Pr {
        Pr {
            number,
            title: format!("PR {number}"),
            is_draft: false,
            state: state.into(),
            head_ref_name: branch.into(),
        }
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
            let out = Command::new("git")
                .arg("-C")
                .arg(dir)
                .args(args)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "git {args:?}: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        };
        run(&origin, &["init", "-q", "-b", "main"]);
        run(&origin, &["config", "user.email", "t@t"]);
        run(&origin, &["config", "user.name", "t"]);
        std::fs::write(origin.join("a.txt"), "a").unwrap();
        run(&origin, &["add", "-A"]);
        run(&origin, &["commit", "-qm", "a"]);

        let out = Command::new("git")
            .args(["clone", "-q"])
            .arg(&origin)
            .arg(&local)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );

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
            repos: vec![Repo {
                path: local.display().to_string(),
                name: "clone".into(),
                worktree: dest.display().to_string(),
            }],
            stage: "Feito".into(),
            agent: String::new(),
            archived: true,
            pinned: false,
            unread: false,
            pr: None,
            cleaned: false,
            shared: false,
            audience: None,
            preparing: false,
            failed: None,
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
        // Mas é justamente o que `force` atravessa: quem marcou o vermelho na
        // tela sabe que essa mudança vai junto.
        super::hard(&ws).unwrap();
        std::fs::remove_file(dest.join("c.txt")).unwrap();
        super::check(&ws).unwrap();

        // Ainda na frente de todo mundo: arquivar é o passo de antes, e nem
        // `force` pula ele.
        ws.archived = false;
        assert!(super::check(&ws).unwrap_err().contains("notArchived"));
        assert!(super::hard(&ws).unwrap_err().contains("notArchived"));
        ws.archived = true;

        // O próprio clone também não sai por `force` nenhum.
        ws.worktree = ws.repo.clone();
        assert!(super::hard(&ws).unwrap_err().contains("isRepo"));

        // Com um segundo repositório, ele responde pelas mesmas guardas: um
        // commit fora do alvo *nele* segura o workspace inteiro.
        ws.worktree = dest.display().to_string();
        let dest2 = root.join("wt2");
        super::add_worktree(&local, "trabalho-2", "origin/main", &dest2).unwrap();
        ws.repos.push(Repo {
            path: local.display().to_string(),
            name: "clone-2".into(),
            worktree: dest2.display().to_string(),
        });
        super::check(&ws).unwrap();
        std::fs::write(dest2.join("d.txt"), "d").unwrap();
        assert!(super::check(&ws).unwrap_err().contains("dirty"));

        // A pasta agregadora, que o app apaga com `remove_dir_all`, só vale no
        // formato exato criado pelo Prometheus e com os worktrees como filhos.
        let names: Vec<String> = ws.repos.iter().map(|repo| repo.name.clone()).collect();
        let multi = super::paths::multi_dir(&names, &ws.branch);
        ws.worktree = multi.display().to_string();
        for repo in &mut ws.repos {
            repo.worktree = multi.join(&repo.name).display().to_string();
        }
        super::validate_multi_root(&ws).unwrap();
        ws.worktree = super::paths::home().display().to_string();
        assert!(super::validate_multi_root(&ws)
            .unwrap_err()
            .contains("badRoot"));

        let _ = std::fs::remove_dir_all(&root);
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
        Launch {
            agent: String::new(),
            model: model.into(),
            effort: effort.into(),
            plan,
        }
    }

    /// Bypass e plan não convivem na mesma linha: `--dangerously-skip-permissions`
    /// engole o plan. Plan mode é `--allow-…` mais `--permission-mode plan`.
    #[test]
    fn plan_mode_nao_leva_o_bypass_junto() {
        let solto = claude_args("id", false, &launch("", "", false));
        assert!(solto.contains(&"--dangerously-skip-permissions".to_string()));
        assert!(!solto.contains(&"--permission-mode".to_string()));

        let plano = claude_args("id", false, &launch("", "", true));
        assert!(!plano.contains(&"--dangerously-skip-permissions".to_string()));
        assert!(plano.contains(&"--allow-dangerously-skip-permissions".to_string()));
        let at = plano.iter().position(|a| a == "--permission-mode").unwrap();
        assert_eq!(plano[at + 1], "plan");
    }

    /// Vazio é não passar a flag — o Claude Code escolhe. Cheio vai como veio.
    #[test]
    fn modelo_e_esforco_so_quando_escolhidos() {
        let padrao = claude_args("id", true, &launch("", " ", false));
        assert!(!padrao.contains(&"--model".to_string()));
        assert!(!padrao.contains(&"--effort".to_string()));
        let at = padrao.iter().position(|a| a == "--resume").unwrap();
        assert_eq!(padrao[at + 1], "id");

        let escolhido = claude_args("id", false, &launch("opus[1m]", "max", false));
        assert_eq!(
            escolhido[escolhido.len() - 4..],
            ["--model", "opus[1m]", "--effort", "max"]
        );
        let at = escolhido.iter().position(|a| a == "--session-id").unwrap();
        assert_eq!(escolhido[at + 1], "id");
    }

    /// O que faz a conversa ser JSON dos dois lados, e o pedido de permissão
    /// chegar pelo mesmo cano em vez de matar a sessão.
    #[test]
    fn a_conversa_e_stream_json_com_permissao_por_stdio() {
        let args = claude_args("id", false, &launch("", "", false));
        let has = |pair: [&str; 2]| args.windows(2).any(|w| w[0] == pair[0] && w[1] == pair[1]);
        assert_eq!(args[0], "-p");
        assert!(has(["--input-format", "stream-json"]));
        assert!(has(["--output-format", "stream-json"]));
        assert!(has(["--permission-prompt-tool", "stdio"]));
        assert!(args.contains(&"--include-partial-messages".to_string()));
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
        let wt = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap();
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
            let out = Command::new("git")
                .arg("-C")
                .arg(dir)
                .args(args)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "git {args:?}: {}",
                String::from_utf8_lossy(&out.stderr)
            );
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
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );

        let branches = super::list_branches(local.display().to_string());
        assert_eq!(branches.default, "origin/main");
        assert_eq!(branches.all.first().unwrap(), "origin/main");
        assert!(
            branches.all.contains(&"origin/velha".to_string()),
            "{:?}",
            branches.all
        );

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

    /// O `setup` de cada repo entra num subshell com o caminho entre aspas:
    /// pasta com espaço ou apóstrofo não pode virar dois argumentos.
    #[test]
    fn quoted_aguenta_espaco_e_apostrofo() {
        assert_eq!(quoted("/a b"), "'/a b'");
        assert_eq!(quoted("/d'x"), "'/d'\\''x'");
    }

    /// Dois repos, cada um com o seu `setup`: o comando composto roda um depois
    /// do outro, cada um no seu worktree e vendo as suas variáveis — provado
    /// rodando o comando de verdade num `sh` e lendo o que cada um escreveu.
    #[test]
    fn setup_de_varios_repos_roda_cada_um_na_sua_pasta() {
        let root = std::env::temp_dir().join(format!("prometheus-multi-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let mk = |name: &str, setup: &str| {
            let repo = root.join("clones").join(name);
            let wt = root.join("ws").join(name);
            std::fs::create_dir_all(repo.join(".prometheus")).unwrap();
            std::fs::create_dir_all(&wt).unwrap();
            // String literal do TOML: o comando tem aspas duplas dentro.
            std::fs::write(
                repo.join(".prometheus/settings.toml"),
                format!("[scripts]\nsetup = '{setup}'\n"),
            )
            .unwrap();
            Repo {
                path: repo.display().to_string(),
                name: name.into(),
                worktree: wt.display().to_string(),
            }
        };
        let repos = vec![
            mk(
                "back end",
                "echo \"$PROMETHEUS_WORKSPACE_PATH\" > saida.txt",
            ),
            mk("front", "echo \"$PROMETHEUS_ROOT_PATH:$PORT\" > saida.txt"),
        ];
        let ws = super::Workspace {
            id: "w".into(),
            title: "t".into(),
            project: repos[0].path.clone(),
            repo: repos[0].path.clone(),
            repo_name: repos[0].name.clone(),
            branch: "b".into(),
            worktree: root.join("ws").display().to_string(),
            repos: repos.clone(),
            stage: "Fazendo".into(),
            agent: String::new(),
            archived: false,
            pinned: false,
            unread: false,
            pr: None,
            cleaned: false,
            shared: false,
            audience: None,
            preparing: false,
            failed: None,
            model: String::new(),
            effort: String::new(),
            port: Some(3100),
            issue: None,
            tabs: Vec::new(),
            active: None,
        };

        let (header, command) = multi_setup(&ws).unwrap();
        // Nenhum dos dois declara cópia: não há cabeçalho.
        assert!(header.is_none());
        let out = Command::new("/bin/sh")
            .args(["-c", &command])
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        let read =
            |r: &Repo| std::fs::read_to_string(Path::new(&r.worktree).join("saida.txt")).unwrap();
        assert_eq!(read(&repos[0]).trim(), repos[0].worktree);
        assert_eq!(read(&repos[1]).trim(), format!("{}:3100", repos[1].path));

        // Só um com setup ainda é uma aba; nenhum, não.
        std::fs::remove_file(Path::new(&repos[1].path).join(".prometheus/settings.toml")).unwrap();
        assert!(multi_setup(&ws).unwrap().1.contains("back end"));
        std::fs::remove_file(Path::new(&repos[0].path).join(".prometheus/settings.toml")).unwrap();
        assert!(multi_setup(&ws).is_none());

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
    let Some(root) = cwd_of(&state, &id) else {
        return Vec::new();
    };
    // Não deixa `..` no caminho escapar do worktree.
    let Ok(dir) = inside(&root, &rel) else {
        return Vec::new();
    };

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
    let head = git(
        &worktree,
        &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    )
    .trim()
    .to_string();
    let target = if head.is_empty() {
        "origin/main".to_string()
    } else {
        head
    };
    let upstream = !git(&worktree, &["rev-parse", "--abbrev-ref", "@{upstream}"])
        .trim()
        .is_empty();
    // Com PR já aberto o pedido é outro: não criar de novo, e sim empurrar o
    // que falta e conferir se o que está escrito lá ainda cobre a branch.
    let open = branch
        .as_deref()
        .and_then(|branch| crate::github::pr_for_branch(&worktree, branch))
        .filter(|pr| pr.open())
        .map(|pr| pr.number);
    Ok(pr_text(branch.as_deref(), dirty, &target, upstream, open))
}

fn pr_text(
    branch: Option<&str>,
    dirty: usize,
    target: &str,
    upstream: bool,
    open: Option<u64>,
) -> String {
    let estado = match dirty {
        0 => "O worktree está limpo — nada fora de commit.".to_string(),
        1 => "Há 1 arquivo com mudanças fora de commit.".to_string(),
        n => format!("Há {n} arquivos com mudanças fora de commit."),
    };
    let onde = match branch {
        Some(b) => format!("A branch atual é `{b}`"),
        None => "O worktree está em HEAD solto — crie uma branch antes de commitar".to_string(),
    };
    let up = if upstream {
        "A branch já tem upstream."
    } else {
        "Ainda não há branch upstream."
    };
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

fn workspace_copy(state: &State<AppState>, id: &str) -> Option<Workspace> {
    lock(&state.board)
        .workspaces
        .iter()
        .find(|w| w.id == id)
        .cloned()
}

/// O worktree do repositório principal, se ainda houver um — é dele que saem
/// diff, branch e PR. Devolvido ao disco é o mesmo que não existir: quem lê
/// daqui recebe o vazio, e não um caminho que já não é de ninguém.
fn worktree_of(state: &State<AppState>, id: &str) -> Option<PathBuf> {
    lock(&state.board)
        .workspaces
        .iter()
        .find(|w| w.id == id && !w.cleaned)
        .map(|w| PathBuf::from(w.primary().worktree))
}

/// Onde o agente trabalha: o worktree, ou a pasta que reúne os worktrees
/// quando há mais de um repositório. É daqui que a árvore de arquivos e o
/// Finder partem — a pessoa quer ver todos, não só o principal.
fn cwd_of(state: &State<AppState>, id: &str) -> Option<PathBuf> {
    lock(&state.board)
        .workspaces
        .iter()
        .find(|w| w.id == id && !w.cleaned)
        .map(|w| PathBuf::from(&w.worktree))
}
