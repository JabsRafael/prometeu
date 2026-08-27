//! O socket é a espinha do projeto: é por aqui que uma decisão tomada com o
//! mouse volta para dentro do agente, e por aqui que o quadro fica sabendo o
//! que cada sessão está fazendo.

use crate::i18n;
use crate::lock::lock;
use crate::state::{publish, Note, Status};
use crate::{paths, transcript, AppState};
use serde_json::Value;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::time::Duration;
use tauri::{AppHandle, Manager};

/// Quanto o app espera pela linha que o hook manda ao conectar. Sem isto, um
/// cliente que conecta e não escreve pendurava o loop de accept — e com ele
/// **todos** os hooks de **todas** as sessões. O hook escreve na hora; 10s é
/// folga de sobra para o caso de a máquina estar sob carga.
const READ_TIMEOUT: Duration = Duration::from_secs(10);

/// Teto do payload de um hook. `PreToolUse` de um `Write` carrega o arquivo
/// inteiro, então precisa ser grande — mas não ilimitado, que é o que um
/// `read_line` sem coleira é.
const MAX_PAYLOAD: u64 = 8 * 1024 * 1024;

pub fn listen(app: AppHandle) -> std::io::Result<()> {
    let path = paths::socket_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let _ = std::fs::remove_file(&path); // socket órfão de um crash anterior
    let listener = UnixListener::bind(&path)?;

    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            // Uma thread por conexão. Serial, um hook lento — ou um cliente
            // calado — parava a fila inteira, e a fila é o app inteiro.
            let app = app.clone();
            std::thread::spawn(move || handle(&app, stream));
        }
    });
    Ok(())
}

fn handle(app: &AppHandle, stream: UnixStream) {
    let _ = stream.set_read_timeout(Some(READ_TIMEOUT));

    let mut line = String::new();
    if BufReader::new((&stream).take(MAX_PAYLOAD)).read_line(&mut line).is_err() {
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
            let _ = reply(&stream, "{}");
            send_pending_prompt(app, &session);
            return;
        }
        // Fala nova: o que o agente estava fazendo antes não vale mais.
        "run" => set(app, &session, Some(Status::Rodando), Note::Clear),
        "tool" => set(app, &session, Some(Status::Rodando), Note::Set(activity(&payload))),
        // Parou. Deixar a última ferramenta escrita aqui fazia o card dizer
        // "pronta" embaixo de uma linha que parecia trabalho acontecendo agora.
        // Parar é também quando a conversa cresceu: é a hora de ler quanto.
        "idle" => update(app, &session, Some(Status::Pronta), Note::Clear, context(app, &session, &payload)),
        "end" => update(app, &session, Some(Status::Desligada), Note::Clear, context(app, &session, &payload)),
        "notif" => {
            let msg = payload["message"].as_str().unwrap_or("").to_string();
            set(app, &session, Some(Status::Querendo), Note::Set(msg));
        }
        _ => {}
    }
    let _ = reply(&stream, "{}");
}

/// Um pedido de permissão — e AskUserQuestion e ExitPlanMode, que passam por
/// aqui mesmo em bypass. O hook não decide nada: solta o agente na hora e a TUI
/// desenha o seletor dentro do terminal, que é onde a pessoa responde. O que o
/// app faz com isso é uma coisa só: contar ao quadro que a sessão parou
/// esperando alguém.
fn permission(app: &AppHandle, stream: UnixStream, session: String, payload: Value) {
    let _ = reply(&stream, "{}");
    // Sem nome de ferramenta a frase é outra, e não a mesma com um buraco
    // tapado: código não entra dentro de código.
    let note = match payload["tool_name"].as_str() {
        Some("AskUserQuestion") => payload["tool_input"]["questions"][0]["question"]
            .as_str()
            .map(str::to_string)
            .unwrap_or_else(|| i18n::t("note.question")),
        Some("ExitPlanMode") => i18n::t("note.plan"),
        Some(tool) => i18n::ta("note.permission", &[("tool", tool.to_string())]),
        None => i18n::t("note.permissionAny"),
    };
    set(app, &session, Some(Status::Querendo), Note::Set(note));
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

pub fn set(app: &AppHandle, session: &str, status: Option<Status>, note: Note) {
    update(app, session, status, note, None);
}

/// Quanto a conversa pesa agora, lido do transcript. O hook diz onde ele está;
/// hook antigo sem esse campo cai na conta do `paths::transcript`. `None` é
/// "não mexe": conversa que ainda não respondeu não zera o número que tinha.
fn context(app: &AppHandle, session: &str, payload: &Value) -> Option<u64> {
    let path = match payload["transcript_path"].as_str() {
        Some(p) => PathBuf::from(p),
        None => {
            let state = app.state::<AppState>();
            let worktree = lock(&state.board).workspace_of(session)?.worktree.clone();
            paths::transcript(session, std::path::Path::new(&worktree))
        }
    };
    transcript::context(&path)
}

fn update(app: &AppHandle, session: &str, status: Option<Status>, note: Note, tokens: Option<u64>) {
    if session.is_empty() {
        return;
    }
    let state = app.state::<AppState>();
    let looking = lock(&state.looking).clone();
    {
        let mut board = lock(&state.board);
        let Some(ws) = board.workspace_of_mut(session) else { return };
        // Novidade é o agente ter parado de trabalhar enquanto você olhava outra
        // coisa: terminou, ou travou numa pergunta. "Rodando" não é notícia.
        if matches!(status, Some(Status::Pronta | Status::Querendo))
            && looking.as_deref() != Some(ws.id.as_str())
        {
            ws.unread = true;
        }
        let Some(tab) = ws.tabs.iter_mut().find(|t| t.id == session) else { return };
        if let Some(s) = status {
            tab.status = s;
        }
        tab.note = match note {
            Note::Clear => None,
            Note::Set(n) => Some(n),
        };
        if tokens.is_some() {
            tab.tokens = tokens;
        }
    }
    publish(app);
}

/// A sessão avisou que está de pé. A primeira fala montada no lançador vai
/// agora — a não ser que o setup do worktree ainda esteja rodando: aí fica
/// guardada, e é o fim dele que a solta (`session::release_prompts`). Agente
/// que roda teste antes de haver `node_modules` conclui coisa errada.
fn send_pending_prompt(app: &AppHandle, session: &str) {
    let state = app.state::<AppState>();
    lock(&state.ready).insert(session.to_string());
    // O lock do quadro sai antes do dos PTYs: dois locks aninhados é como
    // nasce um travamento, e aqui não há motivo para segurar os dois.
    let key = lock(&state.board)
        .workspace_of(session)
        .map(|ws| format!("{}:setup", ws.id));
    let setup_running = key
        .is_some_and(|key| lock(&state.ptys).get(&key).is_some_and(|p| p.alive()));
    if !setup_running {
        type_prompt(app, session, None);
    }
}

/// Digita a primeira fala da aba, uma vez só. `prefix` vai na frente, na mesma
/// linha: Enter no meio mandaria metade.
pub fn type_prompt(app: &AppHandle, session: &str, prefix: Option<String>) {
    let state = app.state::<AppState>();
    let prompt = {
        let mut board = lock(&state.board);
        let Some(tab) = board.tab_mut(session) else { return };
        let Some(p) = tab.pending_prompt.take() else { return };
        format!("{}{p}", prefix.unwrap_or_default())
    };
    publish(app);

    let app = app.clone();
    let session = session.to_string();
    std::thread::spawn(move || {
        // O prompt e o Enter vão separados: mandados juntos, o Enter se perde
        // no meio da colagem e o texto fica parado na caixa.
        let type_in = |text: &str| {
            let state = app.state::<AppState>();
            let mut ptys = lock(&state.ptys);
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

fn reply(mut stream: &UnixStream, body: &str) -> std::io::Result<()> {
    writeln!(stream, "{body}")?;
    stream.flush()
}
