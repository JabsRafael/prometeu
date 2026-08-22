use crate::lock::lock;
use crate::AppState;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

/// Quanto da saída fica guardado para redesenhar o terminal quando o usuário
/// volta do quadro para a sessão. 512 KB cobre bastante rolagem e não pesa.
const SCROLLBACK: usize = 512 * 1024;

/// Quanto se espera o desligamento educado antes de apelar para o SIGKILL.
const HANGUP: Duration = Duration::from_millis(300);

/// E quanto se espera o SIGKILL fazer efeito. Só para colher o filho: quem
/// ignora SIGKILL está preso no kernel, e esperar mais não ajudaria.
const REAP: Duration = Duration::from_millis(200);

pub struct Pty {
    /// `Option` porque os dois fds do master precisam sair no começo do `Drop`,
    /// antes da espera — e não no fim dele, que é quando um campo cairia
    /// sozinho.
    master: Option<Box<dyn MasterPty + Send>>,
    writer: Option<Box<dyn Write + Send>>,
    /// Últimos bytes da sessão, para reidratar a tela ao reabrir.
    pub buffer: Arc<Mutex<Vec<u8>>>,
    child: Box<dyn Child + Send + Sync>,
}

impl Pty {
    pub fn write(&mut self, data: &str) -> Result<(), String> {
        let Some(writer) = &mut self.writer else { return Err("sessão encerrada".into()) };
        writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
        writer.flush().map_err(|e| e.to_string())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        let Some(master) = &self.master else { return Err("sessão encerrada".into()) };
        master
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| e.to_string())
    }

    /// Espera o filho morrer, até o teto. `true` se morreu.
    fn reap(&mut self, until: Duration) -> bool {
        let deadline = Instant::now() + until;
        while Instant::now() < deadline {
            match self.child.try_wait() {
                Ok(None) => std::thread::sleep(Duration::from_millis(10)),
                _ => return true,
            }
        }
        false
    }

}

/// Manda um sinal para o **grupo** inteiro, e não só para o filho.
///
/// O portable-pty dá `setsid()` no filho antes do exec — e aborta se falhar —,
/// então o filho é sempre líder da própria sessão e do próprio grupo, e os
/// netos nascem dentro dele. O grupo é a única forma de alcançá-los: em
/// `npm run dev`, o `npm` é o filho, mas quem segura a porta é o `node` que ele
/// subiu. Como o pgid é o pid do filho, e o filho é líder de sessão, o sinal
/// nunca escapa para o grupo do próprio app.
fn signal_group(pgid: Option<i32>, sig: i32) {
    let Some(pgid) = pgid else { return };
    // SAFETY: `killpg` é uma chamada de sistema sem contrato de memória. O pgid
    // é o pid do filho que este `Pty` criou e ainda não colheu, então continua
    // reservado; no pior caso o grupo já se esvaziou e volta ESRCH.
    unsafe { libc::killpg(pgid, sig) };
}

/// Sair do mapa é morrer. Dropar sozinho não matava: `Child` do Rust não mata
/// no drop, então fechar o dock deixava vivo o `npm run dev` que o botão dizia
/// encerrar — segurando a porta, invisível, até o app fechar.
///
/// Desliga em três degraus, e nenhum é dispensável:
///
///   1. os fds do master saem. Fechado o último, o kernel manda SIGHUP para o
///      grupo de primeiro plano — o desligamento que a sessão espera, e o que
///      faz o `claude` fechar o transcript direito. Fechar só o `master` não
///      basta: o `writer` guarda um fd duplicado, e enquanto ele viver o SIGHUP
///      não sai;
///   2. SIGTERM no grupo, com uma folga para quem quiser sair sozinho;
///   3. SIGKILL no grupo, para o que sobrou.
///
/// Os dois últimos degraus valem **mesmo que o filho já tenha morrido** — foi
/// exatamente esse o bug. O filho cai no SIGHUP e o neto fica: `npm` morre,
/// `node` continua com a porta na mão. Sair cedo por ver o filho morto era
/// declarar vitória olhando para o processo errado.
impl Drop for Pty {
    fn drop(&mut self) {
        // O pgid sai antes de qualquer colheita: colhido o filho, o pid volta
        // para o sistema e pode ser reciclado — e aí o sinal iria para o grupo
        // de outra pessoa.
        let group = self.child.process_id().map(|pid| pid as i32);

        self.master.take();
        self.writer.take();

        signal_group(group, libc::SIGTERM);
        std::thread::sleep(HANGUP);
        signal_group(group, libc::SIGKILL);

        // Sem colher o filho ele fica zumbi até o app morrer, e uma aba aberta
        // e fechada muitas vezes viraria uma fila de zumbis.
        self.reap(REAP);
    }
}

/// Tira o PTY do mapa e o encerra.
///
/// Fora do lock e fora da thread de quem chamou: desligar é esperar morrer, e
/// nem o mapa nem a tela têm o que fazer nessa espera. Quem fechou a aba já
/// seguiu em frente.
pub fn kill(state: &AppState, key: &str) {
    let pty = lock(&state.ptys).remove(key);
    if let Some(pty) = pty {
        std::thread::spawn(move || drop(pty));
    }
}

/// Abre o pseudo-terminal e sobe o processo. Devolve o `Pty` e o leitor da
/// saída, ainda sem ninguém escutando.
///
/// Separado do `spawn` porque é aqui que mora o ciclo de vida do processo — e
/// esta metade não sabe o que é Tauri, então o teste consegue rodá-la.
fn open(cmd: CommandBuilder, cols: u16, rows: u16) -> Result<(Pty, Box<dyn Read + Send>), String> {
    let pair = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("openpty falhou: {e}"))?;

    let child = pair.slave.spawn_command(cmd).map_err(|e| format!("spawn falhou: {e}"))?;
    drop(pair.slave); // sem isso o EOF nunca chega quando o filho morre

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone do reader falhou: {e}"))?;
    let writer = pair.master.take_writer().map_err(|e| format!("writer falhou: {e}"))?;

    let pty = Pty {
        master: Some(pair.master),
        writer: Some(writer),
        buffer: Arc::new(Mutex::new(Vec::new())),
        child,
    };
    Ok((pty, reader))
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
    let (pty, mut reader) = open(cmd, cols, rows)?;

    let sink = pty.buffer.clone();
    let app = app.clone();
    let id = session_id.to_string();

    std::thread::spawn(move || {
        let mut chunk = [0u8; 8192];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    {
                        let mut buf = lock(&sink);
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
        crate::socket::set(
            &app,
            &id,
            Some(crate::state::Status::Desligada),
            crate::state::Note::Clear,
        );
        let _ = app.emit("pty-closed", id);
    });

    Ok(pty)
}

#[tauri::command]
pub fn pty_write(state: State<AppState>, session: String, data: String) -> Result<(), String> {
    let mut ptys = lock(&state.ptys);
    ptys.get_mut(&session).ok_or("sessão não está rodando")?.write(&data)
}

#[tauri::command]
pub fn pty_resize(state: State<AppState>, session: String, cols: u16, rows: u16) -> Result<(), String> {
    let ptys = lock(&state.ptys);
    ptys.get(&session).ok_or("sessão não está rodando")?.resize(cols, rows)
}

/// Devolve a rolagem guardada, para o terminal voltar como estava.
#[tauri::command]
pub fn pty_buffer(state: State<AppState>, session: String) -> Vec<u8> {
    lock(&state.ptys)
        .get(&session)
        .map(|p| lock(&p.buffer).clone())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// O processo ainda está rodando?
    ///
    /// Não dá para perguntar isso com `kill(pid, 0)`: um zumbi responde que
    /// sim, e zumbi é o estado normal de quem acabou de morrer. Para o que
    /// importa aqui — segurar uma porta, gastar CPU — zumbi é morto, então quem
    /// responde é o estado e não a existência do pid.
    fn running(pid: i32) -> bool {
        let out = std::process::Command::new("ps")
            .args(["-o", "stat=", "-p", &pid.to_string()])
            .output()
            .expect("ps não rodou");
        let stat = String::from_utf8_lossy(&out.stdout).trim().to_string();
        !stat.is_empty() && !stat.starts_with('Z')
    }

    /// O bug que este arquivo existe para não ter de novo: fechar o dock
    /// deixava vivo o `npm run dev` que o botão dizia encerrar, segurando a
    /// porta até o app fechar. Dropar o `Pty` não matava ninguém — `Child` do
    /// Rust não mata no drop.
    ///
    /// A montagem tem os dois que escapavam:
    ///
    ///   - um **filho** que fica de pé (o `exec sleep`), como o servidor de dev;
    ///   - um **neto** que ignora SIGHUP (o `nohup`), como o `node` que o `npm`
    ///     sobe e que não cai quando o terminal fecha.
    ///
    /// Os dois têm de sumir. O neto só é alcançável pelo grupo de processos —
    /// matar o pid do filho nunca chegaria nele.
    #[test]
    fn encerrar_uma_sessao_leva_filho_e_neto() {
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.args(["-c", "nohup sleep 30 >/dev/null 2>&1 & echo NETO=$!; exec sleep 30"]);
        let (pty, mut reader) = open(cmd, 80, 24).expect("pty não abriu");
        let filho = pty.child.process_id().expect("filho sem pid") as i32;

        // Lê até o neto dizer o pid.
        let mut saida = String::new();
        let mut chunk = [0u8; 512];
        let deadline = Instant::now() + Duration::from_secs(5);
        let neto: i32 = loop {
            assert!(Instant::now() < deadline, "o neto nunca disse o pid: {saida:?}");
            let n = reader.read(&mut chunk).expect("leitura falhou");
            saida.push_str(&String::from_utf8_lossy(&chunk[..n]));
            let digits: String = saida
                .split("NETO=")
                .nth(1)
                .unwrap_or("")
                .chars()
                .take_while(char::is_ascii_digit)
                .collect();
            if saida.contains('\n') && !digits.is_empty() {
                break digits.parse().expect("pid ilegível");
            }
        };

        // Como em produção: quem drena a saída é quem solta o último fd do
        // master. Sem isso o filho trava no meio da saída, esperando o terminal
        // que ninguém fechou — e o teste mediria o cano, não o código.
        std::thread::spawn(move || {
            let mut buf = [0u8; 1024];
            while matches!(reader.read(&mut buf), Ok(n) if n > 0) {}
        });

        assert!(running(filho), "o filho devia estar de pé antes do teste começar");
        assert!(running(neto), "o neto devia estar de pé antes do teste começar");

        drop(pty);

        assert!(!running(filho), "o filho {filho} sobreviveu ao fechamento da sessão");
        assert!(!running(neto), "o neto {neto} sobreviveu ao fechamento da sessão");
    }
}
