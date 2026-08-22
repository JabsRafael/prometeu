#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod paths;
mod pty;
mod session;
mod socket;
mod state;

use state::Board;
use std::collections::HashMap;
use std::os::unix::net::UnixStream;
use std::sync::atomic::AtomicU64;
use std::sync::Mutex;
use std::time::Instant;

pub struct AppState {
    pub board: Mutex<Board>,
    /// Toda aba de todo workspace continua rodando com o quadro na frente.
    /// Chave é o id da sessão, que é o id da aba.
    pub ptys: Mutex<HashMap<String, pty::Pty>>,
    /// Hooks bloqueados esperando o clique do usuário, por id.
    pub pending: Mutex<HashMap<u64, UnixStream>>,
    pub seq: AtomicU64,
    /// Qual workspace está na tela. O que acontece nele não vira novidade —
    /// você está vendo acontecer.
    pub looking: Mutex<Option<String>>,
    /// Quando cada sessão mostrou a última pergunta — usado para não mandar a
    /// tecla antes de a TUI ter desenhado o seletor.
    pub asked_at: Mutex<HashMap<String, Instant>>,
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            board: Mutex::new(Board::load()),
            ptys: Mutex::new(HashMap::new()),
            pending: Mutex::new(HashMap::new()),
            seq: AtomicU64::new(0),
            asked_at: Mutex::new(HashMap::new()),
            looking: Mutex::new(None),
        })
        .setup(|app| {
            socket::listen(app.handle().clone())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            session::load_board,
            session::add_project,
            session::remove_project,
            session::list_branches,
            session::create_workspace,
            session::set_stage,
            session::archive_workspace,
            session::pin_workspace,
            session::set_unread,
            session::look_at,
            session::rename_workspace,
            session::remove_workspace,
            session::workspace_diff,
            session::list_dir,
            session::read_file,
            session::open_dock,
            session::close_dock,
            session::reveal,
            session::run_script,
            session::new_tab,
            session::close_tab,
            session::focus_tab,
            session::resume_tab,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_buffer,
            socket::decide_permission,
            socket::answer_questions,
        ])
        .run(tauri::generate_context!())
        .expect("erro ao subir o Prometheus");
}
