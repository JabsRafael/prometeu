use crate::AppState;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

/// Quanto da saída fica guardado para redesenhar o terminal quando o usuário
/// volta do quadro para a sessão. 512 KB cobre bastante rolagem e não pesa.
const SCROLLBACK: usize = 512 * 1024;

/// O que roda quando o processo sai, com o código dele. É por aqui que o fim
/// do `setup` solta a primeira fala do agente.
pub type OnExit = Box<dyn FnOnce(Option<u32>) + Send>;

pub struct Pty {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    /// Últimos bytes da sessão, para reidratar a tela ao reabrir.
    pub buffer: Arc<Mutex<Vec<u8>>>,
    /// O processo ainda está rodando. A entrada continua no mapa depois de ele
    /// morrer — é a rolagem dela, com o `✗ saiu com código` no fim, que a aba
    /// mostra amanhã — e é este bit que separa "de pé" de "só a rolagem".
    alive: Arc<AtomicBool>,
    /// Este `Pty` foi derrubado: kill, ou outro subiu no lugar com a mesma
    /// chave. A thread que lê o processo velho vê isto e para de emitir, senão
    /// os últimos suspiros dele sujariam o terminal do novo.
    gone: Arc<AtomicBool>,
    /// Grupo de processos do filho, para o `Drop` derrubar. Zero é "não sei".
    pid: u32,
    /// Derrubar é SIGHUP no grupo inteiro. Vale para dock: `sh -c` não lê o
    /// terminal, então o Ctrl-D que o writer manda ao ser largado não chega a
    /// ninguém, e o servidor de dev ficaria órfão. Não vale para conversa: o
    /// Claude Code sai limpo no Ctrl-D, e avisa o hook no caminho.
    hangup: bool,
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

    pub fn alive(&self) -> bool {
        self.alive.load(Ordering::Relaxed)
    }
}

impl Drop for Pty {
    fn drop(&mut self) {
        self.gone.store(true, Ordering::Relaxed);
        // Só enquanto o filho não foi colhido: pid de morto é reaproveitado, e
        // o sinal iria parar num estranho. `alive` cai antes do `wait`, então
        // verdadeiro aqui é filho vivo, e o pid é dele.
        if self.hangup && self.pid != 0 && self.alive.load(Ordering::Relaxed) {
            unsafe { libc::kill(-(self.pid as libc::pid_t), libc::SIGHUP) };
        }
    }
}

/// Sobe um processo num pseudo-terminal e bombeia a saída para o front.
/// Cada pedaço vai carimbado com o id da sessão — o front só desenha o que é
/// da sessão aberta, mas todas continuam correndo por trás.
///
/// `dock` é script ou shell do dock, e não conversa. Muda duas coisas: o fim
/// vai escrito no próprio buffer — um `setup` que falhou tem que continuar
/// dizendo isso amanhã, quando você reabrir a aba, e o buffer é a única coisa
/// que sobrevive a fechar o painel —, e derrubar é SIGHUP no grupo. Conversa
/// não precisa de nenhum dos dois: aba desligada já tem a tela de "Retomar
/// conversa" por cima.
pub fn spawn(
    app: &AppHandle,
    session_id: &str,
    cmd: CommandBuilder,
    cols: u16,
    rows: u16,
    dock: bool,
    on_exit: Option<OnExit>,
) -> Result<Pty, String> {
    let pair = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("openpty falhou: {e}"))?;

    let mut child = pair.slave.spawn_command(cmd).map_err(|e| format!("spawn falhou: {e}"))?;
    let pid = child.process_id().unwrap_or(0);
    drop(pair.slave); // sem isso o EOF nunca chega quando o filho morre

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone do reader falhou: {e}"))?;
    let writer = pair.master.take_writer().map_err(|e| format!("writer falhou: {e}"))?;

    let buffer = Arc::new(Mutex::new(Vec::<u8>::new()));
    let alive = Arc::new(AtomicBool::new(true));
    let gone = Arc::new(AtomicBool::new(false));
    let sink = buffer.clone();
    let (alive_t, gone_t) = (alive.clone(), gone.clone());
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
                    if !gone_t.load(Ordering::Relaxed) {
                        let _ = app.emit("pty", (id.clone(), chunk[..n].to_vec()));
                    }
                }
            }
        }
        // Já houve EOF, então o filho ou morreu ou está a um suspiro disso —
        // `wait` aqui é a colheita do código de saída, não uma espera de verdade.
        // `alive` cai antes dela, para ninguém sinalizar um pid já colhido.
        alive_t.store(false, Ordering::Relaxed);
        let code = child.wait().ok().map(|s| s.exit_code());
        // Esta sessão não está mais de pé para receber fala nenhuma.
        app.state::<AppState>().ready.lock().unwrap().remove(&id);
        if dock && !gone_t.load(Ordering::Relaxed) {
            let line = match code {
                Some(0) => "\r\n\x1b[32m✓ terminou\x1b[0m\r\n".to_string(),
                Some(n) => format!("\r\n\x1b[31m✗ saiu com código {n}\x1b[0m\r\n"),
                None => "\r\n\x1b[31m✗ encerrado\x1b[0m\r\n".to_string(),
            };
            sink.lock().unwrap().extend_from_slice(line.as_bytes());
            let _ = app.emit("pty", (id.clone(), line.into_bytes()));
        }
        if let Some(on_exit) = on_exit {
            on_exit(code);
        }
        // O processo morreu: o card não some, vira desligado. O transcript
        // continua no disco e o botão de retomar reabre de onde parou.
        crate::socket::set(&app, &id, Some(crate::state::Status::Desligada), None);
        let _ = app.emit("pty-closed", (id, code));
    });

    Ok(Pty { master: pair.master, writer, buffer, alive, gone, pid, hangup: dock })
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
