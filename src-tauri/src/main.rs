#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agents;
mod browser;
mod chat;
mod codex;
mod dock;
mod domain;
mod github;
mod i18n;
mod linear;
mod lock;
mod naming;
mod paths;
mod pty;
mod scripts;
mod session;
mod state;
mod team;
mod transcript;

use state::Board;
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

pub struct AppState {
    pub board: Mutex<Board>,
    /// Para onde o quadro vai quando muda: uma thread só, que junta as
    /// gravações. Ver `state::spawn_saver`.
    pub save: state::Saver,
    /// Toda conversa de todo workspace continua rodando com o quadro na
    /// frente. Chave é o id da sessão, que é o id da aba.
    pub chats: Mutex<HashMap<String, chat::Chat>>,
    /// Os terminais do dock — setup, run, shells —, por `<workspace>:<tipo>`.
    pub ptys: Mutex<HashMap<String, pty::Pty>>,
    /// Qual workspace está na tela. O que acontece nele não vira novidade —
    /// você está vendo acontecer.
    pub looking: Mutex<Option<String>>,
    /// Sessões cujo Claude Code já avisou que está de pé — só nessas a primeira
    /// fala pode ir. Importa quando a fala espera o `setup` acabar: o fim dele
    /// não pode escrever num processo que ainda está subindo.
    pub ready: Mutex<HashSet<String>>,
}

/// O app aberto pelo Finder nasce com o PATH mínimo do launchd —
/// `/usr/bin:/bin:/usr/sbin:/sbin`, sem o `claude` que mora em `~/.local/bin`
/// e sem nada do Homebrew. Pergunta ao shell de login qual é o PATH de verdade
/// e adota: toda sessão nasce herdando o ambiente deste processo.
///
/// Rodando do terminal o PATH já está certo e isto só confirma o que veio.
fn adopt_login_path() {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let out = std::process::Command::new(shell)
            .args(["-ilc", r#"printf %s "$PATH""#])
            .output();
        let path = out
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
        let _ = tx.send(path);
    });
    // O profile do usuário é código arbitrário: se ele travar, o app não trava com ele.
    if let Ok(Some(path)) = rx.recv_timeout(std::time::Duration::from_secs(5)) {
        if !path.is_empty() {
            std::env::set_var("PATH", path);
        }
    }
}

fn main() {
    adopt_login_path();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(AppState {
            board: Mutex::new(Board::load()),
            save: state::spawn_saver(),
            chats: Mutex::new(HashMap::new()),
            ptys: Mutex::new(HashMap::new()),
            looking: Mutex::new(None),
            ready: Mutex::new(HashSet::new()),
        })
        .invoke_handler(tauri::generate_handler![
            i18n::set_lang,
            agents::agents,
            session::load_board,
            session::add_project,
            session::remove_project,
            session::list_branches,
            session::create_workspace,
            session::set_stage,
            session::archive_workspace,
            session::finish_workspace,
            session::cleanup_worktree,
            session::cleanup_list,
            session::pin_workspace,
            session::set_unread,
            session::set_shared,
            session::look_at,
            session::rename_workspace,
            session::remove_workspace,
            session::diff::workspace_diff,
            session::diff::workspace_branch,
            session::find::find_paths,
            session::files::list_dir,
            session::files::read_file,
            dock::open_dock,
            dock::close_dock,
            dock::reveal,
            dock::workspace_scripts,
            dock::dock_state,
            dock::create_scripts_file,
            dock::scripts_prompt,
            dock::open_run,
            browser::browser_open,
            browser::browser_url,
            browser::browser_navigate,
            browser::browser_bounds,
            browser::browser_hide,
            browser::browser_reload,
            browser::browser_close,
            browser::open_external,
            session::pr_prompt,
            github::pr_open,
            github::refresh_prs,
            github::open_pr,
            session::new_tab,
            session::close_tab,
            session::focus_tab,
            session::rename_tab,
            session::resume_tab,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_buffer,
            chat::chat_send,
            chat::chat_control,
            chat::chat_control_remote,
            chat::chat_buffer,
            chat::chat_snapshot,
            linear::linear_status,
            linear::linear_connect,
            linear::linear_disconnect,
            linear::linear_issues,
            linear::linear_open,
            team::team_config,
            team::team_config_set,
        ])
        .build(tauri::generate_context!())
        .expect("erro ao subir o Prometheus")
        .run(|app, event| {
            // A gravação do quadro é adiada para não pesar no caminho quente.
            // Sair é o único momento em que não existe "daqui a pouco".
            if matches!(event, tauri::RunEvent::Exit) {
                state::save_now(app);
            }
        });
}
