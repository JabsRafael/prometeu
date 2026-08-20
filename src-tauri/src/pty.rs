use crate::AppState;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

/// Quanto da saída fica guardado para redesenhar o terminal quando o usuário
/// volta do quadro para a sessão. 512 KB cobre bastante rolagem e não pesa.
const SCROLLBACK: usize = 512 * 1024;

pub struct Pty {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    /// Últimos bytes da sessão, para reidratar a tela ao reabrir.
    pub buffer: Arc<Mutex<Vec<u8>>>,
    #[allow(dead_code)]
    child: Box<dyn Child + Send + Sync>,
}

impl Pty {
    pub fn write(&mut self, data: &str) -> Result<(), String> {
        self.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
        self.writer.flush().map_err(|e| e.to_string())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        self.master
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| e.to_string())
    }
}

/// Sobe um processo num pseudo-terminal e bombeia a saída para o front.
/// Cada pedaço vai carimbado com o id da sessão — o front só desenha o que é
/// da sessão aberta, mas todas continuam correndo por trás.
pub fn spawn(
    app: &AppHandle,
    session_id: &str,
    cmd: CommandBuilder,
    cols: u16,
    rows: u16,
) -> Result<Pty, String> {
    let pair = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("openpty falhou: {e}"))?;

    let child = pair.slave.spawn_command(cmd).map_err(|e| format!("spawn falhou: {e}"))?;
    drop(pair.slave); // sem isso o EOF nunca chega quando o filho morre

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone do reader falhou: {e}"))?;
    let writer = pair.master.take_writer().map_err(|e| format!("writer falhou: {e}"))?;

    let buffer = Arc::new(Mutex::new(Vec::<u8>::new()));
    let sink = buffer.clone();
    let app = app.clone();
    let id = session_id.to_string();

    std::thread::spawn(move || {
        let mut chunk = [0u8; 8192];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    {
                        let mut buf = sink.lock().unwrap();
                        buf.extend_from_slice(&chunk[..n]);
                        if buf.len() > SCROLLBACK {
                            let cut = buf.len() - SCROLLBACK;
                            buf.drain(..cut);
                        }
                    }
                    // ponytail: bytes crus viram array JSON. Gordo, mas deixa o
                    // TextDecoder do front juntar UTF-8 partido no meio de graça.
                    // Se pesar, trocar por base64.
                    let _ = app.emit("pty", (id.clone(), chunk[..n].to_vec()));
                }
            }
        }
        // O processo morreu: o card não some, vira desligado. O transcript
        // continua no disco e o botão de retomar reabre de onde parou.
        crate::socket::set(&app, &id, Some(crate::state::Status::Desligada), None);
        let _ = app.emit("pty-closed", id);
    });

    Ok(Pty { master: pair.master, writer, buffer, child })
}

#[tauri::command]
pub fn pty_write(state: State<AppState>, session: String, data: String) -> Result<(), String> {
    let mut ptys = state.ptys.lock().unwrap();
    ptys.get_mut(&session).ok_or("sessão não está rodando")?.write(&data)
}

#[tauri::command]
pub fn pty_resize(state: State<AppState>, session: String, cols: u16, rows: u16) -> Result<(), String> {
    let ptys = state.ptys.lock().unwrap();
    ptys.get(&session).ok_or("sessão não está rodando")?.resize(cols, rows)
}

/// Devolve a rolagem guardada, para o terminal voltar como estava.
#[tauri::command]
pub fn pty_buffer(state: State<AppState>, session: String) -> Vec<u8> {
    state
        .ptys
        .lock()
        .unwrap()
        .get(&session)
        .map(|p| p.buffer.lock().unwrap().clone())
        .unwrap_or_default()
}
