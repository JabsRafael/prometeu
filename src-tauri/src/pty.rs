use crate::i18n;
use crate::lock::lock;
use crate::AppState;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

/// Quanto da saída fica guardado para redesenhar o terminal quando o usuário
/// volta do quadro para a sessão. 512 KB cobre bastante rolagem e não pesa.
const SCROLLBACK: usize = 512 * 1024;

/// Do desligamento educado até insistir. Folga de sobra para quem sai sozinho:
/// o `claude` fecha o transcript no Ctrl-D, um servidor de dev cai no SIGHUP.
const GRACE: Duration = Duration::from_secs(1);

/// E daí até o SIGKILL. Quem ignora SIGTERM não vai mudar de ideia esperando
/// mais.
const REAP: Duration = Duration::from_millis(500);

/// O que roda quando o processo sai, com o código dele. É por aqui que o fim
/// do `setup` solta a primeira fala do agente.
pub type OnExit = Box<dyn FnOnce(Option<u32>) + Send>;

/// O que acompanha o pty de um dock — script ou shell. Conversa não passa por
/// aqui: ela é `chat.rs`, e não tem terminal nenhum.
#[derive(Default)]
pub struct Dock {
    pub on_exit: Option<OnExit>,
    /// Texto que o Prometheus escreveu, e não o processo: o que a aba Setup diz
    /// ter copiado do clone. Entra antes de a thread de leitura começar, e não
    /// depois de `spawn` voltar, para não se intercalar com os primeiros bytes
    /// do comando.
    pub header: Option<String>,
}

/// A rolagem guardada e o número do último pedaço que entrou nela. Os dois
/// vivem sob o mesmo lock de propósito: um snapshot é "estes bytes, até o
/// pedaço N", e quem recebe os pedaços numerados sabe exatamente quais já
/// estavam dentro — é o que deixa o front compartilhar a tela sem duplicar
/// nem perder um chunk que cruzou com o snapshot no caminho.
#[derive(Default)]
pub struct Scroll {
    pub bytes: Vec<u8>,
    pub seq: u64,
}

impl Scroll {
    /// Guarda um pedaço, corta o que passou do teto, e devolve o número dele.
    pub fn absorb(&mut self, chunk: &[u8]) -> u64 {
        self.bytes.extend_from_slice(chunk);
        if self.bytes.len() > SCROLLBACK {
            let cut = self.bytes.len() - SCROLLBACK;
            self.bytes.drain(..cut);
        }
        self.seq += 1;
        self.seq
    }
}

pub struct Pty {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    /// Últimos bytes da sessão, para reidratar a tela ao reabrir.
    pub buffer: Arc<Mutex<Scroll>>,
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
}

impl Pty {
    pub fn write(&mut self, data: &str) -> Result<(), String> {
        self.writer.write_all(data.as_bytes()).map_err(i18n::io)?;
        self.writer.flush().map_err(i18n::io)
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        self.master
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(i18n::io)
    }

    pub fn alive(&self) -> bool {
        self.alive.load(Ordering::Relaxed)
    }
}

/// Manda um sinal para o **grupo** do processo, e não só para ele.
///
/// O portable-pty dá `setsid()` no filho antes do exec — e aborta se falhar —,
/// então o filho é sempre líder da própria sessão e do próprio grupo, e os
/// netos nascem dentro dele. O grupo é a única forma de alcançá-los: em
/// `npm run dev`, o `npm` é o filho, mas quem segura a porta é o `node` que ele
/// subiu. Como o pgid é o pid do filho, e o filho é líder de sessão, o sinal
/// nunca escapa para o grupo do próprio app.
///
/// Só enquanto o filho não foi colhido: pid de morto é reaproveitado, e o sinal
/// iria parar num estranho. `alive` cai antes do `wait`, então verdadeiro aqui
/// é filho vivo, e o pid é dele.
pub(crate) fn signal_group(pid: u32, alive: &AtomicBool, sig: i32) {
    if pid == 0 || !alive.load(Ordering::Relaxed) {
        return;
    }
    // SAFETY: `killpg` é uma chamada de sistema sem contrato de memória, e o
    // pgid é o pid de um filho ainda não colhido — logo, ainda reservado.
    unsafe { libc::killpg(pid as libc::pid_t, sig) };
}

/// Espera o processo sair, até o teto. `true` se saiu.
pub(crate) fn wait_exit(alive: &AtomicBool, until: Duration) -> bool {
    let deadline = Instant::now() + until;
    while Instant::now() < deadline {
        if !alive.load(Ordering::Relaxed) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    !alive.load(Ordering::Relaxed)
}

/// Sair do mapa é morrer, e morrer é em degraus.
///
/// Dropar sozinho não bastava: `Child` do Rust não mata no drop, então fechar o
/// dock deixava vivo o `npm run dev` que o botão dizia encerrar, segurando a
/// porta até o app fechar. Só o SIGHUP também não basta — quem o ignora fica, e
/// é justamente o caso de um servidor de dev sob `nohup`.
///
/// Então: SIGHUP no grupo — `sh -c` não lê o terminal, então o Ctrl-D que o
/// writer manda ao ser largado não chega a ninguém — e, para quem não sair
/// sozinho, SIGTERM e depois SIGKILL. Sempre no grupo, que é a única forma de
/// alcançar os netos.
///
/// A insistência mora numa thread à parte porque é feita de espera, e ninguém
/// que fecha uma aba tem o que fazer nessa espera.
impl Drop for Pty {
    fn drop(&mut self) {
        self.gone.store(true, Ordering::Relaxed);
        signal_group(self.pid, &self.alive, libc::SIGHUP);
        let (pid, alive) = (self.pid, self.alive.clone());
        std::thread::spawn(move || {
            if wait_exit(&alive, GRACE) {
                return;
            }
            signal_group(pid, &alive, libc::SIGTERM);
            if wait_exit(&alive, REAP) {
                return;
            }
            signal_group(pid, &alive, libc::SIGKILL);
        });
    }
}

/// Tira o PTY do mapa — e, com isso, encerra o processo.
pub fn kill(state: &AppState, key: &str) {
    lock(&state.ptys).remove(key);
}

/// O que sai de `open`: o `Pty` para o mapa, e o par que a bomba consome.
type Opened = (Pty, Box<dyn Read + Send>, Box<dyn Child + Send + Sync>);

/// Abre o pseudo-terminal e sobe o processo. Devolve o `Pty`, o leitor da saída
/// e o filho: quem bombeia é que decide o que fazer com os dois últimos.
///
/// Separado do `spawn` porque é aqui que mora o ciclo de vida do processo — e
/// esta metade não sabe o que é Tauri, então o teste consegue rodá-la.
fn open(cmd: CommandBuilder, cols: u16, rows: u16) -> Result<Opened, String> {
    let pair = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| i18n::ta("err.pty.openpty", &[("cause", e.to_string())]))?;

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| i18n::ta("err.pty.spawn", &[("cause", e.to_string())]))?;
    let pid = child.process_id().unwrap_or(0);
    drop(pair.slave); // sem isso o EOF nunca chega quando o filho morre

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| i18n::ta("err.pty.reader", &[("cause", e.to_string())]))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| i18n::ta("err.pty.writer", &[("cause", e.to_string())]))?;

    let pty = Pty {
        master: pair.master,
        writer,
        buffer: Arc::new(Mutex::new(Scroll::default())),
        alive: Arc::new(AtomicBool::new(true)),
        gone: Arc::new(AtomicBool::new(false)),
        pid,
    };
    Ok((pty, reader, child))
}

/// Sobe um processo num pseudo-terminal e bombeia a saída para o front.
/// Cada pedaço vai carimbado com a chave do dock — o front só desenha o que
/// está na frente, mas todos continuam correndo por trás.
///
/// O fim vai escrito no próprio buffer: um `setup` que falhou tem que
/// continuar dizendo isso amanhã, quando você reabrir a aba, e o buffer é a
/// única coisa que sobrevive a fechar o painel.
pub fn spawn(
    app: &AppHandle,
    session_id: &str,
    cmd: CommandBuilder,
    cols: u16,
    rows: u16,
    dock: Dock,
) -> Result<Pty, String> {
    let Dock { on_exit, header } = dock;
    let (pty, mut reader, mut child) = open(cmd, cols, rows)?;

    if let Some(text) = header {
        let seq = lock(&pty.buffer).absorb(text.as_bytes());
        let _ = app.emit("pty", (session_id.to_string(), text.into_bytes(), seq));
    }

    let sink = pty.buffer.clone();
    let (alive_t, gone_t) = (pty.alive.clone(), pty.gone.clone());
    let app = app.clone();
    let id = session_id.to_string();

    std::thread::spawn(move || {
        let mut chunk = [0u8; 8192];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let seq = lock(&sink).absorb(&chunk[..n]);
                    // ponytail: bytes crus viram array JSON. Gordo, mas deixa o
                    // TextDecoder do front juntar UTF-8 partido no meio de graça.
                    // Se pesar, trocar por base64. O número vai junto: é o que o
                    // compartilhamento usa para casar pedaço com snapshot.
                    if !gone_t.load(Ordering::Relaxed) {
                        let _ = app.emit("pty", (id.clone(), chunk[..n].to_vec(), seq));
                    }
                }
            }
        }
        // Já houve EOF, então o filho ou morreu ou está a um suspiro disso —
        // `wait` aqui é a colheita do código de saída, não uma espera de verdade.
        // `alive` cai antes dela, para ninguém sinalizar um pid já colhido.
        alive_t.store(false, Ordering::Relaxed);
        let code = child.wait().ok().map(|s| s.exit_code());
        if !gone_t.load(Ordering::Relaxed) {
            let line = match code {
                Some(0) => format!("\r\n\x1b[32m✓ {}\x1b[0m\r\n", i18n::pick("terminou", "finished")),
                Some(n) => format!(
                    "\r\n\x1b[31m✗ {}\x1b[0m\r\n",
                    i18n::pick(&format!("saiu com código {n}"), &format!("exited with code {n}")),
                ),
                None => format!("\r\n\x1b[31m✗ {}\x1b[0m\r\n", i18n::pick("encerrado", "stopped")),
            };
            let seq = lock(&sink).absorb(line.as_bytes());
            let _ = app.emit("pty", (id.clone(), line.into_bytes(), seq));
        }
        if let Some(on_exit) = on_exit {
            on_exit(code);
        }
        let _ = app.emit("pty-closed", (id, code));
    });

    Ok(pty)
}

#[tauri::command]
pub fn pty_write(state: State<AppState>, session: String, data: String) -> Result<(), String> {
    let mut ptys = lock(&state.ptys);
    ptys.get_mut(&session).ok_or_else(|| i18n::t("err.pty.gone"))?.write(&data)
}

#[tauri::command]
pub fn pty_resize(state: State<AppState>, session: String, cols: u16, rows: u16) -> Result<(), String> {
    let ptys = lock(&state.ptys);
    ptys.get(&session).ok_or_else(|| i18n::t("err.pty.gone"))?.resize(cols, rows)
}

/// Devolve a rolagem guardada, para o terminal voltar como estava.
#[tauri::command]
pub fn pty_buffer(state: State<AppState>, session: String) -> Vec<u8> {
    lock(&state.ptys)
        .get(&session)
        .map(|p| lock(&p.buffer).bytes.clone())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Cada pedaço ganha o número seguinte, e o snapshot diz até qual foi:
    /// quem tirou o snapshot depois do segundo sabe que o terceiro não está
    /// nele — sem olhar byte nenhum.
    #[test]
    fn pedacos_numerados_e_o_snapshot_diz_ate_qual() {
        let mut s = Scroll::default();
        assert_eq!(s.absorb(b"a"), 1);
        assert_eq!(s.absorb(b"b"), 2);
        assert_eq!((s.bytes.as_slice(), s.seq), (&b"ab"[..], 2));
        assert_eq!(s.absorb(b"c"), 3);
        assert_eq!(s.bytes, b"abc");
    }

    /// O teto corta o começo, e o número continua subindo: cortar não é
    /// esquecer que houve pedaço.
    #[test]
    fn o_teto_corta_o_comeco_sem_mexer_no_numero() {
        let mut s = Scroll::default();
        s.absorb(&vec![b'x'; SCROLLBACK]);
        assert_eq!(s.absorb(b"fim"), 2);
        assert_eq!(s.bytes.len(), SCROLLBACK);
        assert!(s.bytes.ends_with(b"fim"));
    }

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

    fn parou(pid: i32, until: Duration) -> bool {
        let deadline = Instant::now() + until;
        while Instant::now() < deadline {
            if !running(pid) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        !running(pid)
    }

    /// A numeração contra um processo de verdade: o que o snapshot leva, e o
    /// que sobra para ir ao vivo, é decidido por número — e é isto que faz a
    /// tela de um colega não repetir nem perder um trecho.
    ///
    /// O `Scroll` é o mesmo que a thread de leitura usa; aqui ele é alimentado
    /// pelos chunks de um pty real, com uma pausa no meio para garantir que a
    /// leitura acontece em dois pedaços.
    #[test]
    fn snapshot_tirado_no_meio_da_saida_sabe_o_que_ja_levou() {
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.args(["-c", "printf primeiro; sleep 0.4; printf segundo"]);
        let (pty, mut reader, _child) = open(cmd, 80, 24).expect("pty não abriu");
        let scroll = pty.buffer.clone();

        let read_chunk = |reader: &mut Box<dyn Read + Send>| -> u64 {
            let mut chunk = [0u8; 1024];
            let n = reader.read(&mut chunk).expect("leitura falhou");
            lock(&scroll).absorb(&chunk[..n])
        };

        // Primeiro pedaço, e o snapshot que um colega receberia agora.
        assert_eq!(read_chunk(&mut reader), 1);
        let (bytes, seq) = {
            let s = lock(&scroll);
            (s.bytes.clone(), s.seq)
        };
        assert_eq!(String::from_utf8_lossy(&bytes), "primeiro");
        assert_eq!(seq, 1, "o snapshot leva o primeiro pedaço, e diz isso");

        // O que vem depois é justamente o que tem de ir ao vivo.
        assert_eq!(read_chunk(&mut reader), 2);
        assert!(lock(&scroll).bytes.ends_with(b"segundo"));
        assert!(seq < lock(&scroll).seq, "o pedaço novo tem número maior que o do snapshot");
    }

    /// O bug que este arquivo existe para não ter de novo: fechar o dock
    /// deixava vivo o `npm run dev` que o botão dizia encerrar, segurando a
    /// porta até o app fechar.
    ///
    /// A montagem tem os dois que escapavam:
    ///
    ///   - um **filho** que fica de pé (o `exec sleep`), como o servidor de dev;
    ///   - um **neto** que ignora SIGHUP (o `nohup`), como o `node` que o `npm`
    ///     sobe e que não cai quando o terminal fecha.
    ///
    /// Os dois têm de sumir. O neto só é alcançável pelo grupo de processos —
    /// sinalizar o pid do filho nunca chegaria nele —, e só o SIGHUP não o
    /// tira: é a escalação para SIGTERM que resolve.
    #[test]
    fn encerrar_uma_sessao_leva_filho_e_neto() {
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.args(["-c", "nohup sleep 30 >/dev/null 2>&1 & echo NETO=$!; exec sleep 30"]);
        let (pty, mut reader, _child) = open(cmd, 80, 24).expect("pty não abriu");
        let filho = pty.pid as i32;

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

        // A escalação é feita de espera, e roda fora desta thread.
        let teto = GRACE + REAP + Duration::from_secs(2);
        assert!(parou(filho, teto), "o filho {filho} sobreviveu ao fechamento da sessão");
        assert!(parou(neto, teto), "o neto {neto} sobreviveu ao fechamento da sessão");
    }
}
