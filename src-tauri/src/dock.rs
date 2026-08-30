//! Docks e scripts de workspace: shell, setup, run e a porta reservada.
//! Este módulo é a borda de execução configurada pelo próprio repositório.

use crate::lock::lock;
use crate::state::Workspace;
use crate::{chat, i18n, pty, scripts, AppState};
use portable_pty::CommandBuilder;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Manager, State};

/// Um shell do dock. `terminal` é o primeiro; do segundo em diante o front
/// numera — `terminal-2`, `terminal-3` —, porque cada aba aberta pelo + precisa
/// de uma chave própria no mapa de ptys. O número é conferido aqui e não
/// confiado: chave torta viraria pty com nome arbitrário, e `dock_state`
/// devolveria aba que o front não sabe desenhar.
pub(crate) fn is_terminal(kind: &str) -> bool {
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
        let handle = pty::spawn(&app, &key, cmd, cols, rows, pty::Dock::default())?;
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
        i18n::ta(
            "err.dock.noScript",
            &[
                ("kind", kind.clone()),
                ("file", scripts::FILES[0].to_string()),
            ],
        )
    })?;

    let script = Script {
        kind: &kind,
        command: &command,
        header: None,
    };
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
pub(crate) fn start_setup(
    app: &AppHandle,
    state: &State<AppState>,
    ws: &Workspace,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    if ws.multi() {
        return start_multi_setup(app, state, ws, cols, rows);
    }
    let found = scripts_of(ws);
    let notes = scripts::hydrate(Path::new(&ws.worktree), Path::new(&ws.repo), &found.copy);
    let report = scripts::report(&notes);
    if found.setup.is_none() && report.is_none() {
        let holes = [
            ("kind", "setup".to_string()),
            ("file", scripts::FILES[0].to_string()),
        ];
        return Err(i18n::ta("err.dock.noScript", &holes));
    }
    let script = Script {
        kind: "setup",
        command: found.setup.as_deref().unwrap_or("true"),
        header: report,
    };
    start_script(app, state, ws, script, cols, rows)
}

/// A aba Setup de um workspace com mais de um repositório: a cópia e o `setup`
/// de cada um, em sequência, no mesmo terminal. Uma aba só porque é uma espera
/// só — a primeira fala do agente sai quando o último terminar —, e porque o
/// que se quer ler ali é "o ambiente está de pé", não um log por repo. O
/// primeiro que falhar para a fila: o código de saída é o dele, e o cabeçalho
/// diz em qual repo parou.
fn start_multi_setup(
    app: &AppHandle,
    state: &State<AppState>,
    ws: &Workspace,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let (header, command) = multi_setup(ws).ok_or_else(|| {
        let holes = [
            ("kind", "setup".to_string()),
            ("file", scripts::FILES[0].to_string()),
        ];
        i18n::ta("err.dock.noScript", &holes)
    })?;
    let script = Script {
        kind: "setup",
        command: &command,
        header,
    };
    start_script(app, state, ws, script, cols, rows)
}

/// O que a aba Setup de vários repositórios mostra e roda: o cabeçalho com o
/// que cada um recebeu do clone, e um comando só com o `setup` de cada um em
/// sequência. `None` é nenhum repo ter setup nem cópia — não há aba a abrir.
/// Fora do `start_multi_setup` para o teste conferir o comando sem pty.
pub(crate) fn multi_setup(ws: &Workspace) -> Option<(Option<String>, String)> {
    let mut header = String::new();
    let mut steps: Vec<String> = Vec::new();
    for r in &ws.repos {
        let found = scripts::read_for(Path::new(&r.worktree), Path::new(&r.path));
        let notes = scripts::hydrate(Path::new(&r.worktree), Path::new(&r.path), &found.copy);
        if let Some(report) = scripts::report(&notes) {
            header.push_str(&format!("\x1b[1m{}\x1b[0m\r\n{report}", r.name));
        }
        let Some(setup) = found.setup else { continue };
        // Cada `setup` roda num subshell, no seu worktree e com as variáveis
        // apontando para ele — o comando entra como está, do mesmo jeito que
        // entraria sozinho num `sh -lc`.
        let env: String = scripts::env(
            Path::new(&r.worktree),
            Path::new(&r.path),
            &script_name(ws),
            ws.port,
        )
        .into_iter()
        .map(|(k, v)| format!("export {k}={}; ", quoted(&v)))
        .collect();
        steps.push(format!(
            "(printf '\\n\\033[1m── {} ──\\033[0m\\n'; cd {} && {env}{setup})",
            r.name,
            quoted(&r.worktree)
        ));
    }
    if steps.is_empty() && header.is_empty() {
        return None;
    }
    let command = match steps.is_empty() {
        true => "true".to_string(),
        false => steps.join(" && "),
    };
    Some(((!header.is_empty()).then_some(header), command))
}

/// Um caminho ou valor entre aspas simples, do jeito que o `sh` lê: o único
/// caractere que precisa de cuidado é a própria aspa.
pub(crate) fn quoted(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
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
    let Script {
        kind,
        command,
        header,
    } = script;
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
    // O script é do repositório principal e roda nele — com mais de um repo, a
    // raiz do workspace é só a pasta que os reúne.
    cmd.cwd(&ws.primary().worktree);
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
    let handle = pty::spawn(app, &key, cmd, cols, rows, pty::Dock { on_exit, header })?;
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
            .map(|w| {
                w.tabs
                    .iter()
                    .filter(|t| t.pending_prompt.is_some())
                    .map(|t| t.id.clone())
                    .collect()
            })
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
        chat::send_prompt(app, tab, warning.clone());
    }
}

/// Os scripts que valem para este workspace: os do worktree, e sem eles os do
/// clone de origem (ver `scripts::read_for`).
pub(crate) fn scripts_of(ws: &Workspace) -> scripts::Scripts {
    let main = ws.primary();
    scripts::read_for(Path::new(&main.worktree), Path::new(&main.path))
}

/// O nome que o script vê: o da pasta do workspace, e não o título do card. O
/// título muda quando você renomeia, e script que batiza container ou banco
/// com ele veria o nome trocar debaixo dos pés.
fn script_name(ws: &Workspace) -> String {
    Path::new(&ws.worktree)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| ws.branch.replace('/', "-"))
}

/// As variáveis do repositório principal — é nele que `run` e `archive` rodam.
pub(crate) fn script_env(ws: &Workspace) -> Vec<(String, String)> {
    let main = ws.primary();
    scripts::env(
        Path::new(&main.worktree),
        Path::new(&main.path),
        &script_name(ws),
        ws.port,
    )
}

/// Workspace criado antes de as portas existirem não tem uma. Em vez de pedir
/// para recriar, ganha a sua na primeira vez que é aberto — o painel pede os
/// scripts, e a porta vai junto, porque é ela que ele mostra.
pub(crate) fn ensure_port(state: &State<AppState>, id: &str) -> Option<u16> {
    let mut board = lock(&state.board);
    let ws = board.workspaces.iter().find(|w| w.id == id)?;
    // Porta guardada por uma versão que ainda entregava as proibidas (5060,
    // 6000…) é trocada aqui: o run que já está de pé fica na velha até ser
    // reiniciado, mas o próximo nasce numa que o navegador abre.
    if let Some(port) = ws.port.filter(|p| scripts::usable(*p)) {
        return Some(port);
    }
    let worktree = ws.worktree.clone();
    let taken: Vec<u16> = board.workspaces.iter().filter_map(|w| w.port).collect();
    let port = scripts::alloc_port(Path::new(&worktree), &taken)?;
    board.workspace_mut(id)?.port = Some(port);
    if let Err(error) = board.save() {
        eprintln!("não gravei a porta do workspace: {error}");
    }
    Some(port)
}

/// Abre o worktree no Finder.
#[tauri::command]
pub fn reveal(state: State<AppState>, id: String) -> Result<(), String> {
    let root = cwd_of(&state, &id).ok_or_else(|| i18n::t("err.session.noWorkspace"))?;
    let ok = Command::new("open")
        .arg(&root)
        .status()
        .map_err(i18n::io)?
        .success();
    ok.then_some(()).ok_or_else(|| {
        i18n::ta(
            "err.session.openFailed",
            &[("path", root.display().to_string())],
        )
    })
}

/// Abre o navegador de fora na porta do run: é lá que o agente enxerga a
/// página (a extensão do Chrome) e que se confere o que só o Chrome faz. A aba
/// de dentro é o `browser`. A porta sai do estado, e não do front: URL
/// arbitrária não viaja pelo IPC.
#[tauri::command]
pub fn open_run(state: State<AppState>, id: String) -> Result<(), String> {
    let port = ensure_port(&state, &id).ok_or_else(|| i18n::t("err.session.noPort"))?;
    let url = format!("http://localhost:{port}");
    let ok = Command::new("open")
        .arg(&url)
        .status()
        .map_err(i18n::io)?
        .success();
    ok.then_some(())
        .ok_or_else(|| i18n::ta("err.session.openFailed", &[("path", url)]))
}

#[tauri::command]
pub fn close_dock(state: State<AppState>, id: String, kind: String) {
    pty::kill(&state, &format!("{id}:{kind}"));
}

/// Derruba todo dock do workspace — setup, run e terminal. Sem isto, arquivar
/// ou remover deixava o servidor de dev rodando num worktree que o quadro não
/// conhece mais.
pub(crate) fn kill_docks(state: &State<AppState>, id: &str) {
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
            Some(DockView {
                kind: key.strip_prefix(&prefix)?.to_string(),
                alive: pty.alive(),
            })
        })
        .collect()
}

#[tauri::command]
pub fn workspace_scripts(state: State<AppState>, id: String) -> ScriptsView {
    let port = ensure_port(&state, &id);
    let scripts = workspace_copy(&state, &id)
        .map(|ws| scripts_of(&ws))
        .unwrap_or_default();
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
    let main = ws.primary();
    let root = Path::new(&main.worktree);
    let found = scripts_of(&ws);
    let (rel, text) = match found.file {
        Some(file) if !found.inherited => return Ok(file),
        Some(file) => {
            let text = std::fs::read_to_string(Path::new(&main.path).join(&file))
                .map_err(|e| e.to_string())?;
            (file, text)
        }
        None => (scripts::FILES[0].to_string(), scripts::TEMPLATE.to_string()),
    };
    let path = root.join(&rel);
    let parent = path
        .parent()
        .ok_or_else(|| i18n::t("err.session.badPath"))?;
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

fn workspace_copy(state: &State<AppState>, id: &str) -> Option<Workspace> {
    lock(&state.board).workspace(id).cloned()
}

fn cwd_of(state: &State<AppState>, id: &str) -> Option<PathBuf> {
    lock(&state.board)
        .workspace(id)
        .filter(|workspace| !workspace.cleaned)
        .map(|workspace| PathBuf::from(&workspace.worktree))
}
