//! A conversa: o `claude -p` falando stream-json por stdin e stdout.
//!
//! Não é um terminal. O Claude Code roda em modo headless e cada coisa que
//! acontece — o texto que ele escreve, a ferramenta que chama, o resultado
//! dela, a permissão que pede — chega como uma linha de JSON. O app guarda as
//! linhas, repassa cada uma para a tela e para quem estiver olhando do outro
//! lado do relay, e é a tela quem desenha. O que uma TUI faria com escape
//! codes, aqui é um reducer em cima de JSON (`src/timeline.ts`).
//!
//! O que vai para dentro é a mesma coisa ao contrário: uma fala é uma linha
//! `{"type":"user",…}`, uma resposta a pedido de permissão é um
//! `control_response`, interromper é um `control_request`. Tudo pelo mesmo
//! cano, e o processo fica de pé entre um turno e outro — a sessão não é o
//! processo, é o transcript no disco, e ele sobrevive a tudo.

use crate::i18n;
use crate::lock::lock;
use crate::state::{publish, Note, Status};
use crate::{paths, transcript, AppState};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

/// Quanto de conversa fica em memória por aba. Linha de JSON é gorda — um
/// `tool_result` carrega o arquivo inteiro que o agente leu —, então é bem mais
/// que a rolagem de um terminal. Passou disto, o começo sai por linha inteira:
/// meia linha de JSON não é nada.
const KEEP: usize = 4 * 1024 * 1024;

/// Do stdin fechado até insistir com SIGTERM, e daí até SIGKILL. O `claude`
/// termina o turno em que estiver e sai sozinho quando o stdin acaba; quem não
/// sair nesse tempo não vai sair esperando mais.
const GRACE: Duration = Duration::from_secs(2);
const REAP: Duration = Duration::from_millis(500);

/// As linhas guardadas e o número da última. É o mesmo desenho da rolagem do
/// pty (`pty::Scroll`): um snapshot é "estas linhas, até a de número N", e quem
/// recebe as linhas numeradas ao vivo sabe quais já estavam dentro — é o que
/// deixa um colega abrir a conversa no meio sem repetir nem perder nada.
#[derive(Default)]
pub struct Lines {
    pub text: String,
    pub seq: u64,
}

impl Lines {
    /// Guarda uma linha, corta o começo se passou do teto, e devolve o número.
    pub fn absorb(&mut self, line: &str) -> u64 {
        self.text.push_str(line);
        self.text.push('\n');
        if self.text.len() > KEEP {
            let cut = self.text.len() - KEEP;
            let at = self.text.as_bytes()[cut..]
                .iter()
                .position(|&b| b == b'\n')
                .map_or(self.text.len(), |i| cut + i + 1);
            self.text.drain(..at);
        }
        self.seq += 1;
        self.seq
    }

    /// Numera sem guardar: o pedaço vai ao vivo para quem está olhando, mas não
    /// vale a memória — é o caso dos deltas de streaming, que o `assistant`
    /// inteiro logo atrás torna redundantes.
    pub fn skip(&mut self) -> u64 {
        self.seq += 1;
        self.seq
    }

    /// Nasce com o fim do transcript: é a conversa até aqui, no mesmo formato
    /// que o processo vai continuar escrevendo. Vale para a tela deste app e
    /// para o snapshot que vai a um colega.
    fn seeded(path: &Path) -> Lines {
        let mut text = std::fs::read_to_string(path).unwrap_or_default();
        if text.len() > KEEP {
            let cut = text.len() - KEEP;
            let at = text.as_bytes()[cut..]
                .iter()
                .position(|&b| b == b'\n')
                .map_or(text.len(), |i| cut + i + 1);
            text.drain(..at);
        }
        if !text.is_empty() && !text.ends_with('\n') {
            text.push('\n');
        }
        Lines { text, seq: 0 }
    }
}

/// O que `chat_snapshot` devolve: as linhas e até que número elas vão.
#[derive(serde::Serialize)]
pub struct Snapshot {
    pub text: String,
    pub seq: u64,
}

pub struct Chat {
    stdin: ChildStdin,
    pub buffer: Arc<Mutex<Lines>>,
    /// O processo ainda está rodando. A entrada continua no mapa depois de ele
    /// morrer — são as linhas dela que a aba mostra amanhã.
    alive: Arc<AtomicBool>,
    /// Este `Chat` foi derrubado: a thread que lê o processo velho para de
    /// emitir, senão os últimos suspiros dele sujariam a conversa do novo.
    gone: Arc<AtomicBool>,
    /// Há um turno em andamento: uma fala entrou e o `result` não saiu. É o
    /// que a tela precisa saber ao abrir a conversa — as linhas sozinhas não
    /// dizem, porque o transcript não guarda `result`.
    turn: Arc<AtomicBool>,
    pid: u32,
}

impl Chat {
    /// Uma linha de JSON para dentro do processo. É o único jeito de falar com
    /// ele: fala, resposta de permissão, interrupção — tudo é uma linha.
    pub fn write(&mut self, frame: &Value) -> Result<(), String> {
        let mut line = frame.to_string();
        line.push('\n');
        self.stdin.write_all(line.as_bytes()).map_err(i18n::io)?;
        self.stdin.flush().map_err(i18n::io)
    }

    pub fn alive(&self) -> bool {
        self.alive.load(Ordering::Relaxed)
    }
}

/// Sair do mapa é morrer, e morrer é em degraus: o stdin fecha (o `claude`
/// termina o turno e sai), e quem não sair leva SIGTERM e depois SIGKILL — no
/// grupo, para alcançar o que ele subiu por baixo.
impl Drop for Chat {
    fn drop(&mut self) {
        self.gone.store(true, Ordering::Relaxed);
        let (pid, alive) = (self.pid, self.alive.clone());
        std::thread::spawn(move || {
            if crate::pty::wait_exit(&alive, GRACE) {
                return;
            }
            crate::pty::signal_group(pid, &alive, libc::SIGTERM);
            if crate::pty::wait_exit(&alive, REAP) {
                return;
            }
            crate::pty::signal_group(pid, &alive, libc::SIGKILL);
        });
    }
}

/// Tira a conversa do mapa — e, com isso, encerra o processo.
pub fn kill(state: &AppState, id: &str) {
    lock(&state.chats).remove(id);
}

/// Sobe o `claude` numa conversa e bombeia a saída para a tela. Cada linha vai
/// carimbada com o id da sessão e o número dela — a tela só desenha a conversa
/// aberta, mas todas continuam correndo por trás, e o compartilhamento usa o
/// número para casar linha com snapshot.
pub fn spawn(app: &AppHandle, id: &str, worktree: &Path, args: Vec<String>) -> Result<Chat, String> {
    let mut cmd = Command::new("claude");
    cmd.args(args)
        .current_dir(worktree)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Um `claude` rodando dentro de outro herda CLAUDE_CODE_CHILD_SESSION e
    // desliga o salvamento do transcript — que é justamente o que a aba guarda
    // como ponteiro. O resto do ambiente vai inteiro: é dele que sai o PATH.
    cmd.env_clear();
    for (k, v) in std::env::vars() {
        if !k.starts_with("CLAUDE") {
            cmd.env(k, v);
        }
    }
    // Grupo próprio: é o que deixa o `Drop` alcançar os netos.
    cmd.process_group(0);

    let mut child = cmd.spawn().map_err(|e| i18n::ta("err.chat.spawn", &[("cause", e.to_string())]))?;
    let pid = child.id();
    let stdin = child.stdin.take().ok_or_else(|| i18n::t("err.chat.pipe"))?;
    let stdout = child.stdout.take().ok_or_else(|| i18n::t("err.chat.pipe"))?;
    let stderr = child.stderr.take().ok_or_else(|| i18n::t("err.chat.pipe"))?;

    let chat = Chat {
        stdin,
        buffer: Arc::new(Mutex::new(Lines::seeded(&paths::transcript(id, worktree)))),
        alive: Arc::new(AtomicBool::new(true)),
        gone: Arc::new(AtomicBool::new(false)),
        turn: Arc::new(AtomicBool::new(false)),
        pid,
    };

    // O stderr vira linha também: é por ele que o `claude` conta que não achou
    // a sessão para retomar, ou que não está logado. Escondê-lo seria uma aba
    // que morre calada.
    {
        let (sink, gone, app, id) = (chat.buffer.clone(), chat.gone.clone(), app.clone(), id.to_string());
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                if line.trim().is_empty() {
                    continue;
                }
                let frame = json!({ "type": "prometheus", "subtype": "stderr", "text": line }).to_string();
                let seq = lock(&sink).absorb(&frame);
                if !gone.load(Ordering::Relaxed) {
                    let _ = app.emit("chat", (id.clone(), frame, seq));
                }
            }
        });
    }

    let sink = chat.buffer.clone();
    let (alive_t, gone_t, turn_t) = (chat.alive.clone(), chat.gone.clone(), chat.turn.clone());
    let app = app.clone();
    let id = id.to_string();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        let mut ready = false;
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            let text = line.trim_end();
            if text.is_empty() {
                continue;
            }
            let Ok(frame) = serde_json::from_str::<Value>(text) else { continue };
            let seq = match keep(&frame) {
                true => lock(&sink).absorb(text),
                false => lock(&sink).skip(),
            };
            if gone_t.load(Ordering::Relaxed) {
                continue;
            }
            let _ = app.emit("chat", (id.clone(), text.to_string(), seq));
            if frame["type"] == "result" {
                turn_t.store(false, Ordering::Relaxed);
            }
            react(&app, &id, &frame, &mut ready);
        }
        // EOF: o filho morreu ou está a um suspiro disso. `alive` cai antes do
        // `wait`, para ninguém sinalizar um pid já colhido.
        alive_t.store(false, Ordering::Relaxed);
        let _ = child.wait();
        lock(&app.state::<AppState>().ready).remove(&id);
        // O processo morreu: o card não some, vira desligado. O transcript
        // continua no disco e a próxima fala reabre de onde parou.
        update(&app, &id, Some(Status::Desligada), Note::Clear, None);
        let _ = app.emit("chat-closed", id);
    });

    Ok(chat)
}

/// O que vale guardar. Os deltas de streaming são o texto chegando letra a
/// letra, e a linha `assistant` que vem logo atrás traz o bloco inteiro; os
/// hooks e a contagem de tokens de pensamento são ruído de progresso. Tudo
/// isso vai ao vivo para a tela — e só.
fn keep(frame: &Value) -> bool {
    match frame["type"].as_str() {
        Some("stream_event") | Some("rate_limit_event") => false,
        Some("system") => !matches!(
            frame["subtype"].as_str(),
            Some("hook_started" | "hook_response" | "thinking_tokens")
        ),
        _ => true,
    }
}

/// O que cada linha conta ao quadro. É o que os hooks contavam antes, lido
/// direto do stream: a ferramenta que está rodando, a pergunta que travou a
/// sessão, o fim do turno.
fn react(app: &AppHandle, id: &str, frame: &Value, ready: &mut bool) {
    match frame["type"].as_str() {
        // O `init` só sai depois de a primeira fala entrar — não serve de
        // aviso de "pode falar". Quem libera a fala é `ready`, no spawn. Aqui
        // é só a confirmação, uma vez, para o caso de a fala ter ficado presa
        // no setup e o setup já ter acabado.
        Some("system") if frame["subtype"] == "init" && !*ready => {
            *ready = true;
            ready_now(app, id);
        }
        Some("assistant") => {
            let blocks = frame["message"]["content"].as_array();
            let tool = blocks.and_then(|b| b.iter().find(|c| c["type"] == "tool_use"));
            match tool {
                Some(t) => update(app, id, Some(Status::Rodando), Note::Set(activity(t)), None),
                None => update(app, id, Some(Status::Rodando), Note::Keep, None),
            }
        }
        // Um pedido de permissão — e AskUserQuestion e ExitPlanMode, que passam
        // por aqui mesmo em bypass. O quadro fica sabendo que a sessão parou
        // esperando alguém; quem responde é a tela.
        Some("control_request") if frame["request"]["subtype"] == "can_use_tool" => {
            let req = &frame["request"];
            let note = match req["tool_name"].as_str() {
                Some("AskUserQuestion") => req["input"]["questions"][0]["question"]
                    .as_str()
                    .map(str::to_string)
                    .unwrap_or_else(|| i18n::t("note.question")),
                Some("ExitPlanMode") => i18n::t("note.plan"),
                Some(tool) => i18n::ta("note.permission", &[("tool", tool.to_string())]),
                None => i18n::t("note.permissionAny"),
            };
            update(app, id, Some(Status::Querendo), Note::Set(note), None);
        }
        // Parou. Deixar a última ferramenta escrita aqui fazia o card dizer
        // "pronta" embaixo de uma linha que parecia trabalho acontecendo agora.
        // Parar é também quando a conversa cresceu: é a hora de ler quanto.
        Some("result") => update(app, id, Some(Status::Pronta), Note::Clear, context(app, id)),
        _ => {}
    }
}

/// Uma linha do tipo "Bash cd /Users/…", que é o que faz o card parecer vivo.
fn activity(block: &Value) -> String {
    let tool = block["name"].as_str().unwrap_or("");
    let input = &block["input"];
    let detail = ["command", "file_path", "pattern", "path", "prompt", "url", "query", "description"]
        .iter()
        .find_map(|k| input[k].as_str())
        .unwrap_or("");
    let detail: String = match detail.chars().count() > 70 {
        true => detail.chars().take(69).collect::<String>() + "…",
        false => detail.to_string(),
    };
    format!("{tool} {detail}").trim().to_string()
}

/// Quanto a conversa pesa agora, lido do transcript. `None` é "não mexe":
/// conversa que ainda não respondeu não zera o número que tinha.
fn context(app: &AppHandle, session: &str) -> Option<u64> {
    let state = app.state::<AppState>();
    let worktree = lock(&state.board).workspace_of(session)?.worktree.clone();
    transcript::context(&paths::transcript(session, Path::new(&worktree)))
}

fn update(app: &AppHandle, session: &str, status: Option<Status>, note: Note, tokens: Option<u64>) {
    let state = app.state::<AppState>();
    let looking = lock(&state.looking).clone();
    {
        let mut board = lock(&state.board);
        let Some(ws) = board.workspace_of_mut(session) else { return };
        // Novidade é o agente ter parado de trabalhar enquanto você olhava outra
        // coisa: terminou, ou travou numa pergunta. "Rodando" não é notícia.
        if matches!(status, Some(Status::Pronta | Status::Querendo)) && looking.as_deref() != Some(ws.id.as_str()) {
            ws.unread = true;
        }
        let Some(tab) = ws.tabs.iter_mut().find(|t| t.id == session) else { return };
        if let Some(s) = status {
            tab.status = s;
        }
        match note {
            Note::Clear => tab.note = None,
            Note::Set(n) => tab.note = Some(n),
            Note::Keep => {}
        }
        if tokens.is_some() {
            tab.tokens = tokens;
        }
    }
    publish(app);
}

/// A conversa está no mapa e aceita fala. A primeira, montada no lançador, vai
/// agora — a não ser que o setup do worktree ainda esteja rodando: aí fica
/// guardada, e é o fim dele que a solta (`session::release_prompts`). Agente
/// que roda teste antes de haver `node_modules` conclui coisa errada.
///
/// Chamado por quem pôs o `Chat` no mapa, logo depois de pôr: o processo
/// ainda está subindo, mas o stdin é um cano — o que entrar agora ele lê
/// quando estiver de pé. Esperar um sinal dele não dá: o `init` do stream só
/// sai depois da primeira fala.
pub fn ready_now(app: &AppHandle, session: &str) {
    let state = app.state::<AppState>();
    lock(&state.ready).insert(session.to_string());
    // O lock do quadro sai antes do dos PTYs: dois locks aninhados é como
    // nasce um travamento, e aqui não há motivo para segurar os dois.
    let key = lock(&state.board).workspace_of(session).map(|ws| format!("{}:setup", ws.id));
    let setup_running = key.is_some_and(|key| lock(&state.ptys).get(&key).is_some_and(|p| p.alive()));
    if !setup_running {
        send_prompt(app, session, None);
    }
}

/// Manda a fala guardada da aba, uma vez só. `prefix` vai na frente, na mesma
/// fala: é o aviso de que o setup não terminou bem.
pub fn send_prompt(app: &AppHandle, session: &str, prefix: Option<String>) {
    let state = app.state::<AppState>();
    let prompt = {
        let mut board = lock(&state.board);
        let Some(tab) = board.tab_mut(session) else { return };
        let Some(p) = tab.pending_prompt.take() else { return };
        format!("{}{p}", prefix.unwrap_or_default())
    };
    publish(app);
    let _ = say(app, &state, session, &prompt);
}

/// Uma fala, no formato do stream — com a hora, que o Claude Code não põe
/// nas linhas que emite. O stream não ecoa o que entra, então quem a guarda e
/// a repassa à tela (e ao colega olhando) é o app, na hora de mandar.
fn user(text: &str) -> Value {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    json!({ "type": "user", "message": { "role": "user", "content": text }, "ts": ts })
}

fn write(state: &AppState, session: &str, frame: &Value) -> Result<(), String> {
    let mut chats = lock(&state.chats);
    let chat = chats.get_mut(session).filter(|c| c.alive()).ok_or_else(|| i18n::t("err.chat.gone"))?;
    chat.write(frame)
}

/// Uma fala para dentro, e a mesma fala para fora: no buffer e na tela.
fn say(app: &AppHandle, state: &AppState, session: &str, text: &str) -> Result<(), String> {
    let frame = user(text);
    write(state, session, &frame)?;
    let line = frame.to_string();
    let seq = match lock(&state.chats).get(session) {
        Some(chat) => {
            chat.turn.store(true, Ordering::Relaxed);
            lock(&chat.buffer).absorb(&line)
        }
        None => 0,
    };
    let _ = app.emit("chat", (session.to_string(), line, seq));
    Ok(())
}

/// Uma fala. Se o processo não está de pé — o app reabriu, a aba foi
/// arquivada, ele caiu —, sobe de novo com `--resume` e a fala vai assim que
/// ele avisar que está pronto. É o que faz "desligada" não ser uma parede:
/// escrever é retomar.
#[tauri::command]
pub fn chat_send(app: AppHandle, state: State<AppState>, session: String, text: String) -> Result<(), String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Ok(());
    }
    let up = lock(&state.chats).get(&session).is_some_and(|c| c.alive());
    let ready = lock(&state.ready).contains(&session);
    if up && ready {
        say(&app, &state, &session, &text)?;
        update(&app, &session, Some(Status::Rodando), Note::Clear, None);
        return Ok(());
    }
    {
        let mut board = lock(&state.board);
        let Some(tab) = board.tab_mut(&session) else { return Err(i18n::t("err.session.noTab")) };
        tab.pending_prompt = Some(text);
    }
    if !up {
        crate::session::revive(&app, &state, &session)?;
    }
    publish(&app);
    Ok(())
}

/// Uma linha qualquer para dentro do processo: resposta a pedido de permissão,
/// interrupção, troca de modo. O front monta o JSON; aqui só passa.
#[tauri::command]
pub fn chat_control(state: State<AppState>, session: String, frame: Value) -> Result<(), String> {
    write(&state, &session, &frame)
}

/// A conversa até aqui, para a tela desenhar. Com o processo de pé (ou morto
/// há pouco) é o que ele escreveu; sem nada no mapa — o app acabou de abrir —
/// é o transcript no disco, que é a mesma coisa em repouso.
#[tauri::command]
pub fn chat_buffer(state: State<AppState>, session: String) -> String {
    snapshot(&state, &session).text
}

/// As linhas, mais uma no fim que as linhas não sabem dizer: se há turno em
/// andamento. Sem ele, a tela assenta o que parecia estar chegando — o
/// transcript não guarda `result`, então uma conversa reaberta terminaria
/// sempre numa mensagem "chegando".
fn snapshot(state: &AppState, session: &str) -> Snapshot {
    let (mut text, seq, busy) = match lock(&state.chats).get(session) {
        Some(chat) => {
            let b = lock(&chat.buffer);
            (b.text.clone(), b.seq, chat.alive() && chat.turn.load(Ordering::Relaxed))
        }
        None => match lock(&state.board).workspace_of(session).map(|w| w.worktree.clone()) {
            Some(worktree) => (Lines::seeded(&paths::transcript(session, Path::new(&worktree))).text, 0, false),
            None => (String::new(), 0, false),
        },
    };
    text.push_str(&json!({ "type": "prometheus", "subtype": "state", "busy": busy }).to_string());
    text.push('\n');
    Snapshot { text, seq }
}

/// As linhas e o número da última — para mandar a um colega que acabou de
/// abrir a conversa. Tirado sob o mesmo lock que numera, então "até o N" é
/// exato.
#[tauri::command]
pub fn chat_snapshot(state: State<AppState>, session: String) -> Snapshot {
    snapshot(&state, &session)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Cada linha ganha o número seguinte; o que vai ao vivo sem ficar guardado
    /// também conta — o snapshot diz "até o N", e N tem de ser o mesmo dos dois
    /// lados.
    #[test]
    fn linhas_numeradas_guardadas_ou_nao() {
        let mut l = Lines::default();
        assert_eq!(l.absorb("a"), 1);
        assert_eq!(l.skip(), 2);
        assert_eq!(l.absorb("b"), 3);
        assert_eq!(l.text, "a\nb\n");
    }

    /// O teto corta por linha inteira: meia linha de JSON não é nada.
    #[test]
    fn o_teto_corta_linhas_inteiras() {
        let mut l = Lines::default();
        let fat = "x".repeat(KEEP);
        l.absorb(&fat);
        l.absorb("fim");
        assert_eq!(l.text, "fim\n");
        assert_eq!(l.seq, 2);
    }

    /// O que fica: falas, ferramentas, pedidos, fim de turno. O que não fica:
    /// o texto letra a letra e o ruído de progresso.
    #[test]
    fn guarda_o_que_a_tela_precisa_amanha() {
        let f = |s: &str| serde_json::from_str::<Value>(s).unwrap();
        assert!(keep(&f(r#"{"type":"assistant"}"#)));
        assert!(keep(&f(r#"{"type":"user"}"#)));
        assert!(keep(&f(r#"{"type":"result"}"#)));
        assert!(keep(&f(r#"{"type":"control_request"}"#)));
        assert!(keep(&f(r#"{"type":"system","subtype":"init"}"#)));
        assert!(keep(&f(r#"{"type":"system","subtype":"compact_boundary"}"#)));
        assert!(!keep(&f(r#"{"type":"stream_event"}"#)));
        assert!(!keep(&f(r#"{"type":"rate_limit_event"}"#)));
        assert!(!keep(&f(r#"{"type":"system","subtype":"hook_started"}"#)));
        assert!(!keep(&f(r#"{"type":"system","subtype":"thinking_tokens"}"#)));
    }

    #[test]
    fn a_linha_de_atividade_diz_a_ferramenta_e_o_alvo() {
        let f = |s: &str| serde_json::from_str::<Value>(s).unwrap();
        assert_eq!(activity(&f(r#"{"name":"Bash","input":{"command":"ls -la","description":"lista"}}"#)), "Bash ls -la");
        assert_eq!(activity(&f(r#"{"name":"Read","input":{"file_path":"/a/b.rs"}}"#)), "Read /a/b.rs");
        let long = format!(r#"{{"name":"Bash","input":{{"command":"{}"}}}}"#, "x".repeat(100));
        assert!(activity(&f(&long)).ends_with('…'));
    }
}
