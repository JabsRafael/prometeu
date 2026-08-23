//! O socket é a espinha do projeto: é por aqui que uma decisão tomada com o
//! mouse volta para dentro do agente, e por aqui que o quadro fica sabendo o
//! que cada sessão está fazendo.

use crate::lock::lock;
use crate::state::{publish, Note, Status};
use crate::{paths, transcript, AppState};
use serde_json::Value;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

/// Folga entre liberar o hook e mandar a tecla. O Claude Code só desenha o
/// seletor depois que o hook retorna; escrever antes disso perde a tecla.
const PICKER_GRACE: Duration = Duration::from_millis(400);

/// Quanto o app espera pela linha que o hook manda ao conectar. Sem isto, um
/// cliente que conecta e não escreve pendurava o loop de accept — e com ele
/// **todos** os hooks de **todas** as sessões. O hook escreve na hora; 10s é
/// folga de sobra para o caso de a máquina estar sob carga.
const READ_TIMEOUT: Duration = Duration::from_secs(10);

/// Teto do payload de um hook. `PreToolUse` de um `Write` carrega o arquivo
/// inteiro, então precisa ser grande — mas não ilimitado, que é o que um
/// `read_line` sem coleira é.
const MAX_PAYLOAD: u64 = 8 * 1024 * 1024;

/// Depois disto o hook do outro lado já desistiu por conta própria (o
/// `MAX_WAIT` dele), e o que sobrou aqui é um stream morto ocupando memória.
const GIVE_UP: Duration = Duration::from_secs(3 * 60 * 60);

/// Um hook parado esperando o clique. A conexão é a correlação — não há id de
/// mensagem —, então o que se guarda é o stream.
pub struct Waiting {
    stream: UnixStream,
    since: Instant,
    session: String,
}

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

fn permission(app: &AppHandle, stream: UnixStream, session: String, payload: Value) {
    // AskUserQuestion é o caso especial: o hook NÃO decide nada. Ele solta o
    // agente na hora para a TUI desenhar o seletor, e a resposta do usuário
    // volta como tecla no PTY. Testado: devolver a escolha em `updatedInput`
    // não funciona — o Claude Code aceita a primeira opção e ignora o resto.
    if payload["tool_name"].as_str() == Some("AskUserQuestion") {
        let _ = reply(&stream, "{}");
        let question = payload["tool_input"]["questions"][0]["question"]
            .as_str()
            .unwrap_or("quer sua resposta")
            .to_string();
        lock(&app.state::<AppState>().asked_at).insert(session.clone(), Instant::now());
        set(app, &session, Some(Status::Querendo), Note::Set(question));
        let _ = app.emit("question", serde_json::json!({ "session": session, "payload": payload }));
        return;
    }

    // ExitPlanMode é o outro: o "Would you like to proceed?" é um seletor da
    // TUI, e ela o desenha de qualquer jeito — `allow` pelo hook não o pula,
    // só atrasa (testado). Então o hook solta na hora e o card responde com o
    // dígito, como na pergunta. A primeira opção é "switch to BYPASS
    // PERMISSIONS", que é o solto de sempre: é para lá que "Executar" manda.
    if payload["tool_name"].as_str() == Some("ExitPlanMode") {
        let _ = reply(&stream, "{}");
        set(app, &session, Some(Status::Querendo), Note::Set("plano pronto: executar?".into()));
        let _ = app.emit(
            "plan",
            serde_json::json!({ "session": session, "plan": payload["tool_input"]["plan"] }),
        );
        return;
    }

    let state = app.state::<AppState>();
    let id = state.seq.fetch_add(1, Ordering::Relaxed);
    {
        let mut pending = lock(&state.pending);
        // Quem já esperou mais do que o hook aguenta não vai mais responder:
        // do outro lado o processo desistiu e saiu. Sem esta varrida o mapa só
        // crescia — um stream morto por permissão nunca clicada.
        pending.retain(|_, w| w.since.elapsed() < GIVE_UP);
        pending.insert(id, Waiting { stream, since: Instant::now(), session: session.clone() });
    }
    set(app, &session, Some(Status::Querendo), Note::Set(format!(
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

/// Esquece o que estava pendurado numa sessão que não existe mais. O hook do
/// outro lado morreu com ela — era filho do `claude` que acabou de sair.
pub fn forget(state: &AppState, session: &str) {
    lock(&state.pending).retain(|_, w| w.session != session);
    lock(&state.asked_at).remove(session);
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

/// Responde um pedido de permissão comum (Write, Bash, …).
#[tauri::command]
pub fn decide_permission(state: State<AppState>, id: u64, decision: String) -> Result<(), String> {
    let waiting = lock(&state.pending)
        .remove(&id)
        .ok_or("esse pedido já não está mais esperando")?;

    let body = serde_json::json!({
        "hookSpecificOutput": {
            "hookEventName": "PermissionRequest",
            "permissionDecision": decision
        }
    });
    // Escrever num hook que já desistiu falha aqui, e calar isso seria pior: o
    // agente segue esperando no terminal e você acha que respondeu.
    reply(&waiting.stream, &body.to_string())
        .map_err(|_| "esse pedido expirou — o agente voltou a perguntar no terminal".to_string())
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

/// A sequência de teclas que responde um AskUserQuestion inteiro.
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
///
/// Função pura porque é a única parte do projeto que adivinha o estado de uma
/// TUI: se a gramática mudar, o teste é quem conta.
pub fn keystrokes(answers: &[Answer]) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    for answer in answers {
        for &pick in &answer.picks {
            if pick >= answer.options {
                return Err(format!("a opção {} não existe nessa pergunta", pick + 1));
            }
            out.push(digit(pick + 1)?);
        }
        if let Some(text) = answer.free.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
            // Sem opções não há seletor na tela, e "logo depois da última" não
            // quer dizer nada — o dígito cairia numa opção que não existe.
            if answer.options == 0 {
                return Err("essa pergunta não tem opções: responda no terminal".into());
            }
            // "Type something" é sempre a opção logo depois da última.
            out.push(digit(answer.options + 1)?);
            out.push(text.to_string());
            out.push("\r".into());
        }
        if answer.multi {
            out.push("\t".into());
        }
    }
    out.push("\r".into());
    Ok(out)
}

/// `async` porque isto dorme: a folga do seletor mais 130ms por tecla. Na
/// thread principal, era a janela inteira congelada durante a resposta.
#[tauri::command(async)]
pub fn answer_questions(
    state: State<AppState>,
    session: String,
    answers: Vec<Answer>,
) -> Result<(), String> {
    // Antes da folga: pedido malformado tem de falhar na hora, não meio
    // segundo depois com metade das teclas já escritas.
    let keys = keystrokes(&answers)?;
    grace(&state, &session);
    for k in &keys {
        key(&state, &session, k)?;
    }
    Ok(())
}

fn digit(n: usize) -> Result<String, String> {
    char::from_digit(n as u32, 10).map(String::from).ok_or("opções demais".into())
}

fn key(state: &State<AppState>, session: &str, text: &str) -> Result<(), String> {
    {
        let mut ptys = lock(&state.ptys);
        ptys.get_mut(session).ok_or("sessão não está rodando")?.write(text)?;
    }
    std::thread::sleep(KEYSTROKE);
    Ok(())
}

/// Espera o que falta da folga e consome a marca: ela serviu, e guardar
/// `Instant` de toda pergunta já respondida é só mapa crescendo.
fn grace(state: &State<AppState>, session: &str) {
    let asked = lock(&state.asked_at).remove(session);
    if let Some(asked) = asked {
        let waited = asked.elapsed();
        if waited < PICKER_GRACE {
            std::thread::sleep(PICKER_GRACE - waited);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{keystrokes, Answer};

    fn answer(picks: &[usize], options: usize, multi: bool, free: Option<&str>) -> Answer {
        Answer {
            picks: picks.to_vec(),
            options,
            multi,
            free: free.map(String::from),
        }
    }

    /// Uma pergunta, escolha única: o dígito seleciona e avança, o Enter envia.
    #[test]
    fn escolha_unica_e_um_digito_e_um_enter() {
        let keys = keystrokes(&[answer(&[1], 3, false, None)]).unwrap();
        assert_eq!(keys, vec!["2", "\r"]);
    }

    /// multiSelect: um dígito por caixa marcada, e o Tab é quem avança. Sem o
    /// Tab a caixa fica marcada e o agente parado — foi esse o bug.
    #[test]
    fn multi_marca_com_digito_e_avanca_com_tab() {
        let keys = keystrokes(&[answer(&[0, 2], 4, true, None)]).unwrap();
        assert_eq!(keys, vec!["1", "3", "\t", "\r"]);
    }

    /// Duas perguntas de escolha única: os dígitos saem na ordem das perguntas,
    /// sem Tab entre elas, porque cada dígito já avançou sozinho.
    #[test]
    fn duas_perguntas_saem_na_ordem() {
        let keys = keystrokes(&[answer(&[0], 2, false, None), answer(&[1], 2, false, None)]).unwrap();
        assert_eq!(keys, vec!["1", "2", "\r"]);
    }

    /// Texto livre entra pela opção logo depois da última, e cada pergunta tem
    /// o seu. Antes o front mandava tudo em `answers[0]`: as outras perguntas
    /// iam sem resposta nenhuma e o Enter final enviava o que a TUI tinha.
    #[test]
    fn texto_livre_e_por_pergunta() {
        let keys = keystrokes(&[
            answer(&[], 2, false, Some("outra coisa")),
            answer(&[1], 3, false, None),
        ])
        .unwrap();
        assert_eq!(keys, vec!["3", "outra coisa", "\r", "2", "\r"]);
    }

    /// Texto em branco não é resposta: não vira tecla nenhuma.
    #[test]
    fn texto_em_branco_e_ignorado() {
        let keys = keystrokes(&[answer(&[0], 2, false, Some("   "))]).unwrap();
        assert_eq!(keys, vec!["1", "\r"]);
    }

    /// Índice fora da lista é erro, não uma tecla que a TUI vai interpretar
    /// como outra coisa.
    #[test]
    fn opcao_que_nao_existe_e_erro() {
        assert!(keystrokes(&[answer(&[5], 3, false, None)]).is_err());
        assert!(keystrokes(&[answer(&[], 0, false, Some("oi"))]).is_err());
    }
}
