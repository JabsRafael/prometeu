//! O socket é a espinha do projeto: é por aqui que uma decisão tomada com o
//! mouse volta para dentro do agente, e por aqui que o quadro fica sabendo o
//! que cada sessão está fazendo.

use crate::state::Status;
use crate::{paths, AppState};
use serde_json::Value;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

/// Folga entre liberar o hook e mandar a tecla. O Claude Code só desenha o
/// seletor depois que o hook retorna; escrever antes disso perde a tecla.
const PICKER_GRACE: Duration = Duration::from_millis(400);

pub fn listen(app: AppHandle) -> std::io::Result<()> {
    let path = paths::socket_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let _ = std::fs::remove_file(&path); // socket órfão de um crash anterior
    let listener = UnixListener::bind(&path)?;

    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            handle(&app, stream);
        }
    });
    Ok(())
}

fn handle(app: &AppHandle, stream: UnixStream) {
    let mut line = String::new();
    if BufReader::new(&stream).read_line(&mut line).is_err() {
        return;
    }
    let Ok(envelope) = serde_json::from_str::<Value>(&line) else { return };
    let kind = envelope["kind"].as_str().unwrap_or("perm").to_string();
    let payload: Value = envelope["payload"]
        .as_str()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or(Value::Null);
    let session = payload["session_id"].as_str().unwrap_or("").to_string();

    match kind.as_str() {
        "perm" => return permission(app, stream, session, payload),
        // A sessão ficou de pé: é agora que a primeira fala pode ser digitada.
        // Esperar por este hook em vez de chutar um sleep também cobre o caso de
        // o Claude Code parar antes para perguntar se você confia na pasta.
        "start" => {
            reply(&stream, "{}");
            send_pending_prompt(app, &session);
            return;
        }
        "run" => set(app, &session, Some(Status::Rodando), None),
        "tool" => set(app, &session, Some(Status::Rodando), Some(activity(&payload))),
        "idle" => set(app, &session, Some(Status::Pronta), None),
        "end" => set(app, &session, Some(Status::Desligada), None),
        "notif" => {
            let msg = payload["message"].as_str().unwrap_or("").to_string();
            set(app, &session, Some(Status::Querendo), Some(msg));
        }
        _ => {}
    }
    reply(&stream, "{}");
}

fn permission(app: &AppHandle, stream: UnixStream, session: String, payload: Value) {
    // AskUserQuestion é o caso especial: o hook NÃO decide nada. Ele solta o
    // agente na hora para a TUI desenhar o seletor, e a resposta do usuário
    // volta como tecla no PTY. Testado: devolver a escolha em `updatedInput`
    // não funciona — o Claude Code aceita a primeira opção e ignora o resto.
    if payload["tool_name"].as_str() == Some("AskUserQuestion") {
        reply(&stream, "{}");
        let question = payload["tool_input"]["questions"][0]["question"]
            .as_str()
            .unwrap_or("quer sua resposta")
            .to_string();
        app.state::<AppState>()
            .asked_at
            .lock()
            .unwrap()
            .insert(session.clone(), Instant::now());
        set(app, &session, Some(Status::Querendo), Some(question));
        let _ = app.emit("question", serde_json::json!({ "session": session, "payload": payload }));
        return;
    }

    let state = app.state::<AppState>();
    let id = state.seq.fetch_add(1, Ordering::Relaxed);
    state.pending.lock().unwrap().insert(id, stream);
    set(app, &session, Some(Status::Querendo), Some(format!(
        "quer permissão para {}",
        payload["tool_name"].as_str().unwrap_or("uma ferramenta")
    )));
    let _ = app.emit(
        "permission",
        serde_json::json!({ "id": id, "session": session, "payload": payload }),
    );
}

/// Uma linha do tipo "Bash cd /Users/…", que é o que faz o card parecer vivo.
fn activity(payload: &Value) -> String {
    let tool = payload["tool_name"].as_str().unwrap_or("");
    let input = &payload["tool_input"];
    let detail = ["command", "file_path", "pattern", "path", "prompt", "url", "query"]
        .iter()
        .find_map(|k| input[k].as_str())
        .unwrap_or("");

    let detail: String = match detail.chars().count() > 70 {
        true => detail.chars().take(69).collect::<String>() + "…",
        false => detail.to_string(),
    };
    format!("{tool} {detail}").trim().to_string()
}

pub fn set(app: &AppHandle, session: &str, status: Option<Status>, note: Option<String>) {
    if session.is_empty() {
        return;
    }
    let state = app.state::<AppState>();
    let mut board = state.board.lock().unwrap();
    let Some(tab) = board.tab_mut(session) else { return };
    if let Some(s) = status {
        tab.status = s;
    }
    if let Some(n) = note {
        tab.note = Some(n);
    }
    board.save();
    let _ = app.emit("board", board.clone());
}

/// Manda a primeira fala montada no lançador, uma vez só.
fn send_pending_prompt(app: &AppHandle, session: &str) {
    let state = app.state::<AppState>();
    let prompt = {
        let mut board = state.board.lock().unwrap();
        let Some(tab) = board.tab_mut(session) else { return };
        let Some(p) = tab.pending_prompt.take() else { return };
        board.save();
        p
    };

    let app = app.clone();
    let session = session.to_string();
    std::thread::spawn(move || {
        // O prompt e o Enter vão separados: mandados juntos, o Enter se perde
        // no meio da colagem e o texto fica parado na caixa.
        let type_in = |text: &str| {
            let state = app.state::<AppState>();
            let mut ptys = state.ptys.lock().unwrap();
            if let Some(pty) = ptys.get_mut(&session) {
                let _ = pty.write(text);
            }
        };
        std::thread::sleep(Duration::from_millis(800));
        type_in(&prompt);
        std::thread::sleep(Duration::from_millis(300));
        type_in("\r");
    });
}

fn reply(mut stream: &UnixStream, body: &str) {
    let _ = writeln!(stream, "{body}");
    let _ = stream.flush();
}

/// Responde um pedido de permissão comum (Write, Bash, …).
#[tauri::command]
pub fn decide_permission(state: State<AppState>, id: u64, decision: String) -> Result<(), String> {
    let stream = state
        .pending
        .lock()
        .unwrap()
        .remove(&id)
        .ok_or("esse pedido já não está mais esperando")?;

    let body = serde_json::json!({
        "hookSpecificOutput": {
            "hookEventName": "PermissionRequest",
            "permissionDecision": decision
        }
    });
    reply(&stream, &body.to_string());
    Ok(())
}

/// Uma resposta por pergunta do AskUserQuestion.
#[derive(serde::Deserialize)]
pub struct Answer {
    /// Índices das opções escolhidas, na ordem em que vieram no payload.
    pub picks: Vec<usize>,
    /// Quantas opções a pergunta tem — o texto livre entra logo depois da última.
    pub options: usize,
    pub multi: bool,
    pub free: Option<String>,
}

/// Intervalo entre teclas. O seletor redesenha entre uma e outra; teclas
/// grudadas se perdem no meio do render.
const KEYSTROKE: Duration = Duration::from_millis(130);

/// Responde um AskUserQuestion inteiro — todas as perguntas e o envio.
///
/// A gramática do seletor foi levantada na marra, e as duas metades diferem:
///
///   escolha única   o dígito seleciona **e avança** sozinho para a próxima
///   multiSelect     o dígito só marca a caixa; avançar exige Tab
///
/// Nos dois casos o Enter final é quem envia. Mandar só o dígito num
/// multiSelect deixa a caixa marcada e o agente parado — foi esse o bug.
///
/// Dígito e não seta: seta é relativa e erra acumulado se um evento se perder.
/// Nada é lido da tela; os índices vêm do payload do hook.
#[tauri::command]
pub fn answer_questions(
    state: State<AppState>,
    session: String,
    answers: Vec<Answer>,
) -> Result<(), String> {
    grace(&state, &session);

    for answer in &answers {
        for &pick in &answer.picks {
            key(&state, &session, &digit(pick + 1)?)?;
        }
        if let Some(text) = answer.free.as_deref().filter(|t| !t.trim().is_empty()) {
            // "Type something" é sempre a opção logo depois da última.
            key(&state, &session, &digit(answer.options + 1)?)?;
            key(&state, &session, text)?;
            key(&state, &session, "\r")?;
        }
        if answer.multi {
            key(&state, &session, "\t")?;
        }
    }

    key(&state, &session, "\r")
}

fn digit(n: usize) -> Result<String, String> {
    char::from_digit(n as u32, 10).map(String::from).ok_or("opções demais".into())
}

fn key(state: &State<AppState>, session: &str, text: &str) -> Result<(), String> {
    {
        let mut ptys = state.ptys.lock().unwrap();
        ptys.get_mut(session).ok_or("sessão não está rodando")?.write(text)?;
    }
    std::thread::sleep(KEYSTROKE);
    Ok(())
}

fn grace(state: &State<AppState>, session: &str) {
    let asked = state.asked_at.lock().unwrap().get(session).copied();
    if let Some(asked) = asked {
        let waited = asked.elapsed();
        if waited < PICKER_GRACE {
            std::thread::sleep(PICKER_GRACE - waited);
        }
    }
}
