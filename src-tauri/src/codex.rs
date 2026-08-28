//! O Codex do outro lado da conversa.
//!
//! O `codex app-server` fala JSON-RPC pelo stdio: o app pede (`thread/start`,
//! `turn/start`, `turn/interrupt`, `thread/compact/start`), ele avisa
//! (`item/started`, `item/agentMessage/delta`, `item/completed`,
//! `turn/completed`…) e às vezes pergunta (`item/tool/requestUserInput`,
//! `item/commandExecution/requestApproval`). Nada disso chega à tela como é:
//! o `Link` traduz cada coisa para a linha equivalente do stream-json do
//! Claude Code, e a tela desenha o Codex com o mesmo reducer que desenha o
//! Claude (`src/timeline.ts`). No sentido contrário, uma fala vira
//! `turn/start`, uma resposta a pedido vira a resposta JSON-RPC, uma
//! interrupção vira `turn/interrupt`.
//!
//! O que não tem tradução é decidido aqui:
//!
//! - **O id da sessão é dele.** O `thread/start` devolve o id, o quadro guarda
//!   no `Tab` (`agent_session`), e é ele que volta como `thread/resume`.
//! - **A conversa no disco é a que o app gravou.** O rollout do Codex tem
//!   outra forma; o que a aba reabre amanhã é o que a tela viu hoje, linha por
//!   linha, em `paths::chat_log` (ver `chat::Pump`).
//! - **Os comandos de barra são do app.** O app-server não tem `/compact` nem
//!   `/context`: `/compact` vira `thread/compact/start`, `/context` vira um
//!   relatório montado do `thread/tokenUsage/updated`, e o resto é recusado com
//!   uma linha na tela.
//! - **Solto, como o Claude Code das abas.** `approvalPolicy: never` e sandbox
//!   aberta — o agente não para a cada comando. A pergunta ao usuário
//!   (`request_user_input`) o Codex só oferece ao modelo no modo de plano; a
//!   feature `default_mode_request_user_input` a libera no modo comum, e é
//!   ligada no spawn — sem ela o agente diz que "a ferramenta não está
//!   disponível" e segue sem perguntar.
//!
//! O `Link` não tem thread nem AppHandle: recebe uma linha e devolve linhas.
//! É o que deixa testá-lo com strings — e o que deixa o `chat.rs` não saber
//! que existe um Codex.

use crate::lock::lock;
use crate::session::Launch;
use crate::{agents, chat, i18n, paths};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Write;
use std::path::Path;
use std::process::Command;
use std::sync::{Arc, Mutex};
use tauri::AppHandle;

/// Sobe o `codex app-server` numa aba. `resume` é a thread que o Codex escolheu
/// da outra vez; sem ela a conversa nasce nova.
pub fn spawn(
    app: &AppHandle,
    id: &str,
    worktree: &Path,
    resume: Option<String>,
    launch: &Launch,
) -> Result<chat::Chat, String> {
    let mut cmd = Command::new("codex");
    cmd.args(["app-server", "--enable", "default_mode_request_user_input"]).current_dir(worktree);
    let log = paths::chat_log(id);
    let start = Start {
        cwd: worktree.display().to_string(),
        resume,
        model: launch.model.trim().to_string(),
        effort: agents::effort(&launch.effort).to_string(),
    };
    let io = chat::ProcessIo::new(process_stderr, move |stdin| {
        let link = Arc::new(Mutex::new(Link::new(Box::new(stdin), start)));
        let reader = link.clone();
        let translate = move |line: &str| lock(&reader).on_line(line).iter().map(Value::to_string).collect();
        (chat::Wire::Codex(link), Box::new(translate) as chat::Translate)
    });
    chat::launch(app, id, cmd, &log, Some(log.clone()), "err.codex.spawn", io)
}

/// Com o que a thread abre.
pub struct Start {
    pub cwd: String,
    pub resume: Option<String>,
    /// Vazio é deixar o Codex escolher.
    pub model: String,
    /// Já no nome do Codex (`ultra`, não `ultracode`). Vazio é não passar.
    pub effort: String,
}

/// O que cada pedido nosso em voo era, para saber o que fazer com a resposta.
enum Sent {
    Init,
    /// `resumed` é `thread/resume`: se falhar, a conversa abre nova em vez de a
    /// aba morrer — o rollout pode ter sido apagado, e a aba vale mais.
    Thread { resumed: bool },
    Turn,
    Compact,
    Interrupt,
}

/// Um pedido do servidor esperando a tela responder.
struct Ask {
    /// O id JSON-RPC dele, que volta na resposta.
    rpc: Value,
    kind: AskKind,
}

enum AskKind {
    Command,
    Patch,
    /// As perguntas: o texto que a tela mostra e o id que o Codex espera.
    Input(Vec<(String, String)>),
}

/// Um bloco de texto (ou pensamento) chegando letra a letra.
struct Open {
    item: String,
    index: usize,
    thinking: bool,
    text: String,
}

pub struct Link {
    out: Box<dyn Write + Send>,
    start: Start,
    next: u64,
    sent: HashMap<u64, Sent>,
    thread: Option<String>,
    /// A thread não abriu, e o motivo. Toda fala daqui em diante é recusada
    /// com ele — é o que a barra mostra.
    failed: Option<String>,
    /// Falas que chegaram antes de a thread existir. Vão na ordem, assim que
    /// ela abrir.
    queue: Vec<Value>,
    model: String,
    window: Option<u64>,
    /// Quanto a conversa pesa agora, pelo último `tokenUsage`.
    ctx: Option<u64>,
    turn: Option<String>,
    asks: HashMap<String, Ask>,
    /// Os arquivos de cada `fileChange` aberto: é o que o pedido de aprovação
    /// dele não repete.
    patches: HashMap<String, Vec<String>>,
    /// O índice do próximo bloco na mensagem deste turno — a linha `assistant`
    /// da tela numera os blocos na ordem em que fecham, e o rascunho em
    /// streaming precisa nascer com o mesmo número.
    block: usize,
    message_open: bool,
    open: Option<Open>,
    /// O tamanho da conversa quando a compactação começou.
    compact_pre: Option<u64>,
}

impl Link {
    pub fn new(out: Box<dyn Write + Send>, start: Start) -> Link {
        let mut link = Link {
            out,
            start,
            next: 0,
            sent: HashMap::new(),
            thread: None,
            failed: None,
            queue: vec![],
            model: String::new(),
            window: None,
            ctx: None,
            turn: None,
            asks: HashMap::new(),
            patches: HashMap::new(),
            block: 0,
            message_open: false,
            open: None,
            compact_pre: None,
        };
        let _ = link.call(
            "initialize",
            json!({
                "clientInfo": { "name": "prometheus", "title": "Prometheus", "version": env!("CARGO_PKG_VERSION") },
                "capabilities": { "experimentalApi": true },
            }),
            Sent::Init,
        );
        link
    }

    /// Fecha o stdin do processo: é o sinal para ele sair.
    pub fn close(&mut self) {
        self.out = Box::new(std::io::sink());
    }

    /* ---------- da tela para o Codex ---------- */

    /// Uma linha da tela. Devolve o que ela rendeu sem ir ao processo.
    pub fn write(&mut self, frame: &Value) -> Result<Vec<Value>, String> {
        match frame["type"].as_str() {
            Some("user") => {
                if let Some(cause) = &self.failed {
                    return Err(i18n::ta("err.codex.thread", &[("cause", cause.clone())]));
                }
                if self.thread.is_none() {
                    self.queue.push(frame.clone());
                    return Ok(vec![]);
                }
                self.speak(&spoken(frame))
            }
            Some("control_response") => {
                let id = frame["response"]["request_id"].as_str().unwrap_or("").to_string();
                let Some(ask) = self.asks.remove(&id) else { return Ok(vec![]) };
                let answer = &frame["response"]["response"];
                let allowed = answer["behavior"].as_str() == Some("allow");
                let result = match ask.kind {
                    AskKind::Command | AskKind::Patch => {
                        json!({ "decision": if allowed { "accept" } else { "decline" } })
                    }
                    AskKind::Input(questions) => {
                        let given = &answer["updatedInput"]["answers"];
                        let mut answers = serde_json::Map::new();
                        for (question, qid) in questions {
                            let text = given[&question].as_str().unwrap_or("").trim().to_string();
                            let list: Vec<String> = if text.is_empty() { vec![] } else { vec![text] };
                            answers.insert(qid, json!({ "answers": list }));
                        }
                        json!({ "answers": answers })
                    }
                };
                self.reply(&ask.rpc, result)?;
                Ok(vec![])
            }
            Some("control_request") if frame["request"]["subtype"] == "interrupt" => {
                if let (Some(thread), Some(turn)) = (self.thread.clone(), self.turn.clone()) {
                    self.call("turn/interrupt", json!({ "threadId": thread, "turnId": turn }), Sent::Interrupt)?;
                }
                Ok(vec![])
            }
            // Troca de modo de permissão é coisa do Claude Code: aqui o agente
            // já roda solto.
            _ => Ok(vec![]),
        }
    }

    /// Uma fala. As que começam com um nome depois da barra são comandos do
    /// app; caminhos absolutos continuam sendo texto para o agente.
    fn speak(&mut self, text: &str) -> Result<Vec<Value>, String> {
        let text = text.trim();
        if let Some(cmd) = text.strip_prefix('/') {
            let cmd = cmd.split_whitespace().next().unwrap_or("");
            if !cmd.contains('/') {
                return self.slash(cmd);
            }
        }
        let mut params = json!({
            "threadId": self.thread.clone().unwrap_or_default(),
            "input": [{ "type": "text", "text": text, "text_elements": [] }],
            "summary": "auto",
        });
        if !self.start.effort.is_empty() {
            params["effort"] = Value::String(self.start.effort.clone());
        }
        self.call("turn/start", params, Sent::Turn)?;
        Ok(vec![])
    }

    fn slash(&mut self, cmd: &str) -> Result<Vec<Value>, String> {
        match cmd {
            "compact" => {
                let thread = self.thread.clone().unwrap_or_default();
                self.call("thread/compact/start", json!({ "threadId": thread }), Sent::Compact)?;
                Ok(vec![stamp(json!({ "type": "system", "subtype": "status", "status": "compacting" }))])
            }
            "context" => Ok(vec![
                stamp(json!({
                    "type": "assistant",
                    "message": { "id": "context", "model": "<synthetic>", "content": [{ "type": "text", "text": self.context_report() }] },
                })),
                result(true, "", None),
            ]),
            other => Ok(vec![
                stderr(&i18n::pick(
                    &format!("o Codex não tem o comando /{other}"),
                    &format!("Codex has no /{other} command"),
                )),
                result(true, "", None),
            ]),
        }
    }

    /// O `/context` do Codex: o que o `tokenUsage` conta, no mesmo markdown que
    /// o Claude Code devolve — é o que a tela sabe desenhar como painel.
    fn context_report(&self) -> String {
        let used = self.ctx.unwrap_or(0);
        let total = self.window.unwrap_or(0);
        let pct = if total > 0 { (used as f64 / total as f64 * 100.0).round() as u64 } else { 0 };
        let free = total.saturating_sub(used);
        let conversation = i18n::pick("Conversa", "Conversation");
        format!(
            "## Context Usage\n**Model:** {}\n**Tokens:** {} / {} ({}%)\n\n### Estimated usage by category\n| Category | Tokens | Percentage |\n|---|---|---|\n| {} | {} | {}% |\n| Free space | {} | {}% |\n",
            if self.model.is_empty() { self.start.model.clone() } else { self.model.clone() },
            kilo(used),
            kilo(total),
            pct,
            conversation,
            kilo(used),
            pct,
            kilo(free),
            100 - pct.min(100),
        )
    }

    fn call(&mut self, method: &str, params: Value, sent: Sent) -> Result<(), String> {
        self.next += 1;
        let id = self.next;
        self.sent.insert(id, sent);
        self.send(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))
    }

    fn notify(&mut self, method: &str, params: Value) -> Result<(), String> {
        self.send(&json!({ "jsonrpc": "2.0", "method": method, "params": params }))
    }

    fn reply(&mut self, rpc: &Value, result: Value) -> Result<(), String> {
        self.send(&json!({ "jsonrpc": "2.0", "id": rpc, "result": result }))
    }

    fn refuse(&mut self, rpc: &Value, message: &str) -> Result<(), String> {
        self.send(&json!({ "jsonrpc": "2.0", "id": rpc, "error": { "code": -32601, "message": message } }))
    }

    fn send(&mut self, msg: &Value) -> Result<(), String> {
        let mut line = msg.to_string();
        line.push('\n');
        self.out.write_all(line.as_bytes()).map_err(i18n::io)?;
        self.out.flush().map_err(i18n::io)
    }

    /* ---------- do Codex para a tela ---------- */

    /// Uma linha do processo. Devolve as linhas da tela que ela vale.
    pub fn on_line(&mut self, line: &str) -> Vec<Value> {
        let Ok(msg) = serde_json::from_str::<Value>(line) else { return vec![] };
        match (msg.get("method").and_then(Value::as_str), msg.get("id")) {
            (Some(method), Some(id)) => self.request(id.clone(), method, &msg["params"]),
            (Some(method), None) => self.notification(method, &msg["params"]),
            (None, Some(id)) => self.response(id.as_u64().unwrap_or(0), &msg),
            (None, None) => vec![],
        }
    }

    fn response(&mut self, id: u64, msg: &Value) -> Vec<Value> {
        let error = msg["error"]["message"].as_str().map(str::to_string);
        match self.sent.remove(&id) {
            Some(Sent::Init) => {
                let _ = self.notify("initialized", json!({}));
                self.open_thread();
                vec![]
            }
            Some(Sent::Thread { resumed }) => {
                if let Some(cause) = error {
                    // Retomar falhou: a conversa de antes ficou para trás, mas a
                    // aba continua servindo — abre nova e avisa.
                    if resumed {
                        self.start.resume = None;
                        self.open_thread();
                        return vec![stderr(&i18n::pick(
                            &format!("não deu para retomar a conversa no Codex ({cause}); esta é nova"),
                            &format!("could not resume the Codex conversation ({cause}); this one is new"),
                        ))];
                    }
                    self.failed = Some(cause.clone());
                    self.queue.clear();
                    return vec![stderr(&cause)];
                }
                let thread = msg["result"]["thread"]["id"].as_str().unwrap_or("").to_string();
                self.model = msg["result"]["model"].as_str().unwrap_or("").to_string();
                self.thread = Some(thread.clone());
                let mut out = vec![json!({ "type": "prometheus", "subtype": "session", "session": thread })];
                for frame in std::mem::take(&mut self.queue) {
                    if let Ok(more) = self.write(&frame) {
                        out.extend(more);
                    }
                }
                out
            }
            Some(Sent::Turn) => match error {
                Some(cause) => vec![stderr(&cause), result(false, &cause, None)],
                None => {
                    if let Some(turn) = msg["result"]["turn"]["id"].as_str() {
                        self.turn = Some(turn.to_string());
                    }
                    vec![]
                }
            },
            Some(Sent::Compact) => match error {
                Some(cause) => vec![
                    stamp(json!({ "type": "system", "subtype": "status", "status": null, "compact_result": "failed", "compact_error": cause })),
                    result(false, &cause, None),
                ],
                None => vec![],
            },
            Some(Sent::Interrupt) | None => vec![],
        }
    }

    fn open_thread(&mut self) {
        let mut params = json!({
            "cwd": self.start.cwd,
            "approvalPolicy": "never",
            "sandbox": "danger-full-access",
        });
        if !self.start.model.is_empty() {
            params["model"] = Value::String(self.start.model.clone());
        }
        match self.start.resume.clone() {
            Some(thread) => {
                params["threadId"] = Value::String(thread);
                let _ = self.call("thread/resume", params, Sent::Thread { resumed: true });
            }
            None => {
                let _ = self.call("thread/start", params, Sent::Thread { resumed: false });
            }
        }
    }

    /// Um pedido do servidor: vira um card que espera resposta, com o
    /// `request_id` que a tela devolve.
    fn request(&mut self, rpc: Value, method: &str, params: &Value) -> Vec<Value> {
        let id = match &rpc {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        };
        let item = params["itemId"].as_str().unwrap_or("").to_string();
        let (kind, tool, input) = match method {
            "item/commandExecution/requestApproval" => {
                let command = params["command"].as_str().unwrap_or("").to_string();
                (AskKind::Command, "Bash", json!({ "command": pretty(&command, &params["commandActions"]) }))
            }
            "item/fileChange/requestApproval" => {
                let paths = self.patches.get(&item).cloned().unwrap_or_default();
                (AskKind::Patch, "Edit", json!({ "file_path": paths.join(", ") }))
            }
            "item/tool/requestUserInput" => {
                let mut ids = vec![];
                let questions: Vec<Value> = params["questions"]
                    .as_array()
                    .map(|qs| {
                        qs.iter()
                            .map(|q| {
                                let question = q["question"].as_str().unwrap_or("").to_string();
                                ids.push((question.clone(), q["id"].as_str().unwrap_or("").to_string()));
                                let options: Vec<Value> = q["options"]
                                    .as_array()
                                    .map(|os| {
                                        os.iter()
                                            .map(|o| json!({ "label": o["label"], "description": o["description"] }))
                                            .collect()
                                    })
                                    .unwrap_or_default();
                                json!({ "question": question, "header": q["header"], "multiSelect": false, "options": options })
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                (AskKind::Input(ids), "AskUserQuestion", json!({ "questions": questions }))
            }
            _ => {
                let _ = self.refuse(&rpc, "unsupported by prometheus");
                return vec![];
            }
        };
        self.asks.insert(id.clone(), Ask { rpc, kind });
        vec![stamp(json!({
            "type": "control_request",
            "request_id": id,
            "request": { "subtype": "can_use_tool", "tool_name": tool, "input": input, "tool_use_id": item },
        }))]
    }

    fn notification(&mut self, method: &str, p: &Value) -> Vec<Value> {
        match method {
            "turn/started" => {
                self.turn = p["turn"]["id"].as_str().map(str::to_string);
                self.block = 0;
                self.message_open = false;
                self.open = None;
                vec![]
            }
            "item/started" => self.started(&p["item"]),
            "item/completed" => self.completed(&p["item"]),
            "item/agentMessage/delta" | "item/plan/delta" => self.delta(p["itemId"].as_str(), p["delta"].as_str()),
            "item/reasoning/summaryTextDelta" => self.delta(p["itemId"].as_str(), p["delta"].as_str()),
            "item/reasoning/summaryPartAdded" => match p["summaryIndex"].as_u64() {
                Some(n) if n > 0 => self.delta(p["itemId"].as_str(), Some("\n\n")),
                _ => vec![],
            },
            "thread/tokenUsage/updated" => {
                let usage = &p["tokenUsage"];
                self.window = usage["modelContextWindow"].as_u64().or(self.window);
                match usage["last"]["totalTokens"].as_u64() {
                    Some(n) if n > 0 => {
                        self.ctx = Some(n);
                        vec![json!({ "type": "prometheus", "subtype": "tokens", "tokens": n })]
                    }
                    _ => vec![],
                }
            }
            "turn/completed" => {
                let mut out = self.seal(None);
                self.turn = None;
                self.block = 0;
                self.message_open = false;
                let turn = &p["turn"];
                let ms = turn["durationMs"].as_u64();
                out.push(match turn["status"].as_str() {
                    Some("failed") => {
                        let cause = turn["error"]["message"].as_str().unwrap_or("").to_string();
                        result(false, &cause, ms)
                    }
                    Some("interrupted") => result(false, "", ms),
                    _ => result(true, "", ms),
                });
                out
            }
            "error" => {
                let cause = p["error"]["message"].as_str().unwrap_or("").to_string();
                let retry = p["willRetry"].as_bool() == Some(true);
                let text = match retry {
                    true => i18n::pick(&format!("{cause} (tentando de novo)"), &format!("{cause} (retrying)")),
                    false => cause,
                };
                vec![stderr(&text)]
            }
            "warning" => p["message"].as_str().map(stderr).into_iter().collect(),
            _ => vec![],
        }
    }

    fn started(&mut self, item: &Value) -> Vec<Value> {
        let id = item["id"].as_str().unwrap_or("").to_string();
        match item["type"].as_str() {
            Some("agentMessage" | "plan") => self.open_text(&id, false),
            Some("reasoning") => self.open_text(&id, true),
            Some("commandExecution") => {
                let command = pretty(item["command"].as_str().unwrap_or(""), &item["commandActions"]);
                self.tool_use(&id, "Bash", json!({ "command": command }))
            }
            Some("fileChange") => {
                let paths: Vec<String> = item["changes"]
                    .as_array()
                    .map(|cs| cs.iter().filter_map(|c| c["path"].as_str()).map(|p| self.relative(p)).collect())
                    .unwrap_or_default();
                self.patches.insert(id.clone(), paths.clone());
                self.tool_use(&id, "Edit", json!({ "file_path": paths.join(", ") }))
            }
            Some("mcpToolCall") => {
                let name = format!("mcp__{}__{}", item["server"].as_str().unwrap_or(""), item["tool"].as_str().unwrap_or(""));
                self.tool_use(&id, &name, item["arguments"].clone())
            }
            Some("dynamicToolCall") => {
                let name = item["tool"].as_str().unwrap_or("tool").to_string();
                self.tool_use(&id, &name, item["arguments"].clone())
            }
            Some("webSearch") => self.tool_use(&id, "WebSearch", json!({ "query": item["query"] })),
            Some("collabAgentToolCall") => {
                self.tool_use(&id, "Agent", json!({ "description": item["tool"], "prompt": item["prompt"] }))
            }
            Some("imageView") => self.tool_use(&id, "Read", json!({ "file_path": item["path"] })),
            Some("contextCompaction") => {
                self.compact_pre = self.ctx;
                vec![stamp(json!({ "type": "system", "subtype": "status", "status": "compacting" }))]
            }
            _ => vec![],
        }
    }

    fn completed(&mut self, item: &Value) -> Vec<Value> {
        let id = item["id"].as_str().unwrap_or("").to_string();
        match item["type"].as_str() {
            Some("agentMessage" | "plan") => {
                let text = item["text"].as_str().unwrap_or("").to_string();
                self.close_text(&id, text, false)
            }
            Some("reasoning") => {
                let parts = |key: &str| -> Vec<String> {
                    item[key]
                        .as_array()
                        .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
                        .unwrap_or_default()
                };
                let mut summary = parts("summary");
                if summary.is_empty() {
                    summary = parts("content");
                }
                self.close_text(&id, summary.join("\n\n"), true)
            }
            Some("commandExecution") => {
                let ok = item["status"].as_str() == Some("completed");
                let mut text = item["aggregatedOutput"].as_str().unwrap_or("").to_string();
                if let (false, Some(code)) = (ok, item["exitCode"].as_i64()) {
                    text = format!("{text}\n(exit {code})").trim().to_string();
                }
                vec![tool_result(&id, &text, !ok)]
            }
            Some("fileChange") => {
                self.patches.remove(&id);
                let ok = item["status"].as_str() == Some("completed");
                let diff: Vec<String> = item["changes"]
                    .as_array()
                    .map(|cs| cs.iter().map(|c| patch(c, &self.start.cwd)).collect())
                    .unwrap_or_default();
                vec![tool_result(&id, &diff.join("\n"), !ok)]
            }
            Some("mcpToolCall") => {
                let failed = item["status"].as_str() == Some("failed") || !item["error"].is_null();
                let text = match item["error"]["message"].as_str() {
                    Some(m) => m.to_string(),
                    None => texts(&item["result"]["content"]),
                };
                vec![tool_result(&id, &text, failed)]
            }
            Some("dynamicToolCall") => {
                let failed = item["success"].as_bool() == Some(false);
                vec![tool_result(&id, &texts(&item["contentItems"]), failed)]
            }
            Some("webSearch" | "collabAgentToolCall" | "imageView") => vec![tool_result(&id, "", false)],
            Some("contextCompaction") => {
                let post = self.ctx;
                vec![
                    stamp(json!({ "type": "system", "subtype": "status", "status": null, "compact_result": "success" })),
                    stamp(json!({
                        "type": "system",
                        "subtype": "compact_boundary",
                        "compact_metadata": { "trigger": "manual", "pre_tokens": self.compact_pre, "post_tokens": post },
                    })),
                ]
            }
            _ => vec![],
        }
    }

    /// Abre um bloco de texto em streaming. Um bloco que ainda estava aberto
    /// fecha antes com o que tinha — a tela numera os blocos na ordem, e dois
    /// abertos ao mesmo tempo é o que o Codex não faz, mas o número não pode
    /// depender disso.
    fn open_text(&mut self, id: &str, thinking: bool) -> Vec<Value> {
        let mut out = self.seal(None);
        if !self.message_open {
            self.message_open = true;
            out.push(self.event(json!({ "type": "message_start", "message": { "id": self.msg(), "role": "assistant", "content": [] } })));
        }
        let index = self.block;
        self.block += 1;
        let block = if thinking { json!({ "type": "thinking", "thinking": "" }) } else { json!({ "type": "text", "text": "" }) };
        out.push(self.event(json!({ "type": "content_block_start", "index": index, "content_block": block })));
        self.open = Some(Open { item: id.to_string(), index, thinking, text: String::new() });
        out
    }

    fn delta(&mut self, id: Option<&str>, text: Option<&str>) -> Vec<Value> {
        let (Some(id), Some(text)) = (id, text) else { return vec![] };
        let Some(open) = self.open.as_mut().filter(|o| o.item == id) else { return vec![] };
        open.text.push_str(text);
        let (index, thinking) = (open.index, open.thinking);
        let delta = match thinking {
            true => json!({ "type": "thinking_delta", "thinking": text }),
            false => json!({ "type": "text_delta", "text": text }),
        };
        vec![self.event(json!({ "type": "content_block_delta", "index": index, "delta": delta }))]
    }

    /// Fecha o bloco deste item com o texto final, ou entrega o bloco inteiro
    /// de uma vez quando nunca houve rascunho (a linha chegou sem `started`).
    fn close_text(&mut self, id: &str, text: String, thinking: bool) -> Vec<Value> {
        if self.open.as_ref().is_some_and(|o| o.item == id) {
            return self.seal(Some(text));
        }
        self.block += 1;
        vec![self.assistant(block_of(&text, thinking))]
    }

    /// Fecha o bloco aberto, se há um: o `content_block_stop` e a linha
    /// `assistant` inteira que a tela guarda. `text` é o texto final; sem ele
    /// vai o que chegou.
    fn seal(&mut self, text: Option<String>) -> Vec<Value> {
        let Some(open) = self.open.take() else { return vec![] };
        let text = text.unwrap_or(open.text);
        vec![
            self.event(json!({ "type": "content_block_stop", "index": open.index })),
            self.assistant(block_of(&text, open.thinking)),
        ]
    }

    /// Uma ferramenta começando: o card já nasce inteiro, porque o Codex conta
    /// o comando de uma vez.
    fn tool_use(&mut self, id: &str, name: &str, input: Value) -> Vec<Value> {
        let mut out = self.seal(None);
        self.message_open = true;
        self.block += 1;
        out.push(self.assistant(json!({ "type": "tool_use", "id": id, "name": name, "input": input })));
        out
    }

    fn assistant(&self, block: Value) -> Value {
        stamp(json!({ "type": "assistant", "message": { "id": self.msg(), "role": "assistant", "content": [block] } }))
    }

    fn event(&self, event: Value) -> Value {
        stamp(json!({ "type": "stream_event", "event": event }))
    }

    /// Todos os blocos de um turno são uma mensagem só na tela.
    fn msg(&self) -> String {
        self.turn.clone().unwrap_or_default()
    }

    /// O caminho como a pessoa o lê: dentro do worktree, sem o worktree.
    fn relative(&self, path: &str) -> String {
        relative(path, &self.start.cwd)
    }
}

fn relative(path: &str, cwd: &str) -> String {
    let cwd = cwd.trim_end_matches('/');
    path.strip_prefix(cwd)
        .and_then(|rest| rest.strip_prefix('/'))
        .filter(|rest| !rest.is_empty())
        .unwrap_or(path)
        .to_string()
}

/* ---------- linhas prontas ---------- */

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Com a hora: o Codex não a põe nas linhas que a tela vai guardar, e é ela
/// que ordena as notas do time entre os itens.
fn stamp(mut frame: Value) -> Value {
    frame["ts"] = json!(now());
    frame
}

fn stderr(text: &str) -> Value {
    stamp(json!({ "type": "prometheus", "subtype": "stderr", "text": text }))
}

fn result(ok: bool, text: &str, ms: Option<u64>) -> Value {
    stamp(json!({
        "type": "result",
        "subtype": if ok { "success" } else { "error_during_execution" },
        "is_error": !ok,
        "result": text,
        "duration_ms": ms,
    }))
}

fn tool_result(id: &str, text: &str, error: bool) -> Value {
    stamp(json!({
        "type": "user",
        "message": { "role": "user", "content": [{ "type": "tool_result", "tool_use_id": id, "content": text, "is_error": error }] },
    }))
}

fn block_of(text: &str, thinking: bool) -> Value {
    match thinking {
        true => json!({ "type": "thinking", "thinking": text }),
        false => json!({ "type": "text", "text": text }),
    }
}

/// O texto de uma fala da tela: string, ou blocos de texto.
fn spoken(frame: &Value) -> String {
    match &frame["message"]["content"] {
        Value::String(s) => s.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter_map(|b| b["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n\n"),
        _ => String::new(),
    }
}

/// O app-server escreve no stderr os mesmos erros de ferramenta que já manda
/// pelo JSON-RPC. São linhas de tracing com timestamp e nível, frequentemente
/// coloridas; repassá-las duplica o card com uma faixa vermelha ilegível. O que
/// não tem essa forma continua aparecendo, porque pode explicar um processo que
/// morreu antes de conseguir responder pelo protocolo.
fn process_stderr(line: &str) -> Option<String> {
    let plain = strip_ansi(line);
    let mut fields = plain.split_whitespace();
    let timestamp = fields.next().unwrap_or("");
    let level = fields.next().unwrap_or("");
    let tracing = timestamp.contains('T')
        && timestamp.ends_with('Z')
        && matches!(level, "TRACE" | "DEBUG" | "INFO" | "WARN" | "ERROR");
    (!tracing).then_some(plain)
}

fn strip_ansi(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut chars = line.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' && chars.peek() == Some(&'[') {
            chars.next();
            for code in chars.by_ref() {
                if ('@'..='~').contains(&code) {
                    break;
                }
            }
        } else {
            out.push(ch);
        }
    }
    out
}

/// O comando como a pessoa o leria. O Codex embrulha tudo em
/// `/bin/zsh -lc "…"`; o `commandActions` traz o de dentro.
fn pretty(command: &str, actions: &Value) -> String {
    actions
        .as_array()
        .and_then(|a| a.first())
        .and_then(|a| a["command"].as_str())
        .filter(|c| !c.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| command.to_string())
}

/// Um arquivo mudado, como diff que a tela colore. O Codex manda só o hunk de
/// uma alteração, e o conteúdo cru de um arquivo novo (ou apagado): o
/// cabeçalho é o que diz de qual arquivo é, e o sinal é o que diz o que
/// aconteceu com cada linha.
fn patch(change: &Value, cwd: &str) -> String {
    let path = relative(change["path"].as_str().unwrap_or(""), cwd);
    let diff = change["diff"].as_str().unwrap_or("").trim_end_matches('\n');
    if diff.starts_with("diff --git") || diff.starts_with("--- ") {
        return diff.to_string();
    }
    let kind = change["kind"]["type"].as_str().unwrap_or("update");
    let signed = |sign: char| -> String {
        let n = diff.lines().count();
        let body: Vec<String> = diff.lines().map(|l| format!("{sign}{l}")).collect();
        let range = match sign {
            '+' => format!("@@ -0,0 +1,{n} @@"),
            _ => format!("@@ -1,{n} +0,0 @@"),
        };
        format!("{range}\n{}", body.join("\n"))
    };
    let (from, to, hunk) = match kind {
        "add" if !diff.starts_with("@@") => ("/dev/null".to_string(), format!("b/{path}"), signed('+')),
        "add" => ("/dev/null".to_string(), format!("b/{path}"), diff.to_string()),
        "delete" if !diff.starts_with("@@") => (format!("a/{path}"), "/dev/null".to_string(), signed('-')),
        "delete" => (format!("a/{path}"), "/dev/null".to_string(), diff.to_string()),
        _ => (format!("a/{path}"), format!("b/{path}"), diff.to_string()),
    };
    format!("diff --git a/{path} b/{path}\n--- {from}\n+++ {to}\n{hunk}")
}

/// Os textos de uma lista de blocos de conteúdo (MCP e ferramentas dinâmicas).
fn texts(content: &Value) -> String {
    content
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|c| c["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

/// `24k`, `3.1k`, `1.2m` — o mesmo desenho do `kilo` da tela.
fn kilo(n: u64) -> String {
    match n {
        0..=999 => n.to_string(),
        1000..=9999 => format!("{:.1}k", n as f64 / 1000.0),
        10000..=999_999 => format!("{}k", n / 1000),
        _ => format!("{:.1}m", n as f64 / 1_000_000.0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    /// Um stdin de mentira: o que o `Link` escreveu, para conferir.
    #[derive(Clone, Default)]
    struct Out(Arc<Mutex<Vec<Value>>>);

    impl Write for Out {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            let text = String::from_utf8_lossy(buf);
            for line in text.lines().filter(|l| !l.trim().is_empty()) {
                self.0.lock().unwrap().push(serde_json::from_str(line).unwrap());
            }
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl Out {
        fn take(&self) -> Vec<Value> {
            std::mem::take(&mut *self.0.lock().unwrap())
        }
    }

    fn link(resume: Option<&str>) -> (Link, Out) {
        let out = Out::default();
        let start = Start { cwd: "/wt".into(), resume: resume.map(str::to_string), model: "gpt-5.4".into(), effort: "high".into() };
        (Link::new(Box::new(out.clone()), start), out)
    }

    /// Abre a thread: responde o `initialize` e o `thread/start`. Nada vai ao
    /// processo antes disso além do próprio `initialize`.
    fn opened(link: &mut Link, out: &Out) -> Vec<Value> {
        let before = out.take();
        assert!(before.iter().all(|m| m["method"] == "initialize"), "{before:?}");
        link.on_line(r#"{"id":1,"result":{}}"#);
        let sent = out.take();
        assert_eq!(sent[0]["method"], "initialized");
        assert_eq!(sent[1]["method"], "thread/start");
        assert_eq!(sent[1]["params"]["approvalPolicy"], "never");
        assert_eq!(sent[1]["params"]["model"], "gpt-5.4");
        link.on_line(r#"{"id":2,"result":{"thread":{"id":"t-1"},"model":"gpt-5.4"}}"#)
    }

    fn user(text: &str) -> Value {
        json!({ "type": "user", "message": { "role": "user", "content": text } })
    }

    #[test]
    fn a_thread_abre_e_a_fala_que_esperava_vai() {
        let (mut link, out) = link(None);
        assert_eq!(out.take()[0]["method"], "initialize");
        assert!(link.write(&user("oi")).unwrap().is_empty());
        let frames = opened(&mut link, &out);
        assert_eq!(frames[0]["subtype"], "session");
        assert_eq!(frames[0]["session"], "t-1");
        let sent = out.take();
        assert_eq!(sent[0]["method"], "turn/start");
        assert_eq!(sent[0]["params"]["threadId"], "t-1");
        assert_eq!(sent[0]["params"]["input"][0]["text"], "oi");
        assert_eq!(sent[0]["params"]["effort"], "high");
    }

    #[test]
    fn retomar_passa_o_id_e_cai_para_nova_se_falhar() {
        let (mut link, out) = link(Some("velha"));
        out.take();
        link.on_line(r#"{"id":1,"result":{}}"#);
        let sent = out.take();
        assert_eq!(sent[1]["method"], "thread/resume");
        assert_eq!(sent[1]["params"]["threadId"], "velha");
        let frames = link.on_line(r#"{"id":2,"error":{"code":1,"message":"no such thread"}}"#);
        assert_eq!(frames[0]["subtype"], "stderr");
        assert_eq!(out.take()[0]["method"], "thread/start");
    }

    #[test]
    fn um_turno_vira_rascunho_linha_inteira_e_result() {
        let (mut link, out) = link(None);
        opened(&mut link, &out);
        link.on_line(r#"{"method":"turn/started","params":{"threadId":"t-1","turn":{"id":"turn-1"}}}"#);
        let f = link.on_line(r#"{"method":"item/started","params":{"item":{"type":"agentMessage","id":"m1","text":""}}}"#);
        assert_eq!(f[0]["event"]["type"], "message_start");
        assert_eq!(f[0]["event"]["message"]["id"], "turn-1");
        assert_eq!(f[1]["event"]["type"], "content_block_start");
        assert_eq!(f[1]["event"]["index"], 0);
        let f = link.on_line(r#"{"method":"item/agentMessage/delta","params":{"itemId":"m1","delta":"Ol"}}"#);
        assert_eq!(f[0]["event"]["delta"]["text"], "Ol");
        let f = link.on_line(r#"{"method":"item/completed","params":{"item":{"type":"agentMessage","id":"m1","text":"Olá"}}}"#);
        assert_eq!(f[0]["event"]["type"], "content_block_stop");
        assert_eq!(f[1]["type"], "assistant");
        assert_eq!(f[1]["message"]["id"], "turn-1");
        assert_eq!(f[1]["message"]["content"][0]["text"], "Olá");
        assert!(f[1]["ts"].is_number());
        let f = link.on_line(r#"{"method":"turn/completed","params":{"turn":{"id":"turn-1","status":"completed","durationMs":900}}}"#);
        assert_eq!(f[0]["type"], "result");
        assert_eq!(f[0]["is_error"], false);
        assert_eq!(f[0]["duration_ms"], 900);
    }

    #[test]
    fn comando_vira_bash_e_o_resultado_acha_o_bloco() {
        let (mut link, out) = link(None);
        opened(&mut link, &out);
        link.on_line(r#"{"method":"turn/started","params":{"turn":{"id":"turn-1"}}}"#);
        let f = link.on_line(r#"{"method":"item/started","params":{"item":{"type":"commandExecution","id":"c1","command":"/bin/zsh -lc \"ls -la\"","commandActions":[{"type":"unknown","command":"ls -la"}],"status":"inProgress"}}}"#);
        let block = &f[0]["message"]["content"][0];
        assert_eq!(block["type"], "tool_use");
        assert_eq!(block["name"], "Bash");
        assert_eq!(block["id"], "c1");
        assert_eq!(block["input"]["command"], "ls -la");
        let f = link.on_line(r#"{"method":"item/completed","params":{"item":{"type":"commandExecution","id":"c1","status":"completed","aggregatedOutput":"a.txt\n","exitCode":0}}}"#);
        let res = &f[0]["message"]["content"][0];
        assert_eq!(f[0]["type"], "user");
        assert_eq!(res["tool_use_id"], "c1");
        assert_eq!(res["content"], "a.txt\n");
        assert_eq!(res["is_error"], false);
    }

    /// O texto que estava chegando fecha antes de a ferramenta entrar: os
    /// índices dos blocos são os que a tela vai contar.
    #[test]
    fn ferramenta_no_meio_do_texto_fecha_o_texto_antes() {
        let (mut link, out) = link(None);
        opened(&mut link, &out);
        link.on_line(r#"{"method":"turn/started","params":{"turn":{"id":"turn-1"}}}"#);
        link.on_line(r#"{"method":"item/started","params":{"item":{"type":"reasoning","id":"r1"}}}"#);
        link.on_line(r#"{"method":"item/reasoning/summaryTextDelta","params":{"itemId":"r1","delta":"pensando"}}"#);
        let f = link.on_line(r#"{"method":"item/started","params":{"item":{"type":"commandExecution","id":"c1","command":"ls","commandActions":[]}}}"#);
        assert_eq!(f[0]["event"]["type"], "content_block_stop");
        assert_eq!(f[1]["message"]["content"][0]["thinking"], "pensando");
        assert_eq!(f[2]["message"]["content"][0]["type"], "tool_use");
        // O próximo texto nasce no índice 2: pensamento (0), ferramenta (1).
        let f = link.on_line(r#"{"method":"item/started","params":{"item":{"type":"agentMessage","id":"m1"}}}"#);
        assert_eq!(f[0]["event"]["type"], "content_block_start");
        assert_eq!(f[0]["event"]["index"], 2);
    }

    #[test]
    fn a_pergunta_vira_card_e_a_resposta_volta_no_id_do_codex() {
        let (mut link, out) = link(None);
        opened(&mut link, &out);
        let f = link.on_line(r#"{"id":7,"method":"item/tool/requestUserInput","params":{"itemId":"q1","questions":[{"id":"cor","header":"Cor","question":"Qual cor?","options":[{"label":"azul","description":"frio"}]}]}}"#);
        assert_eq!(f[0]["type"], "control_request");
        assert_eq!(f[0]["request_id"], "7");
        assert_eq!(f[0]["request"]["tool_name"], "AskUserQuestion");
        assert_eq!(f[0]["request"]["input"]["questions"][0]["options"][0]["label"], "azul");
        link.write(&json!({
            "type": "control_response",
            "response": { "subtype": "success", "request_id": "7", "response": { "behavior": "allow", "updatedInput": { "answers": { "Qual cor?": "azul" } } } },
        }))
        .unwrap();
        let sent = out.take();
        assert_eq!(sent[0]["id"], 7);
        assert_eq!(sent[0]["result"]["answers"]["cor"]["answers"][0], "azul");
    }

    #[test]
    fn aprovacao_de_comando_responde_accept_ou_decline() {
        let (mut link, out) = link(None);
        opened(&mut link, &out);
        let f = link.on_line(r#"{"id":"r-9","method":"item/commandExecution/requestApproval","params":{"itemId":"c1","command":"rm -rf x"}}"#);
        assert_eq!(f[0]["request"]["tool_name"], "Bash");
        assert_eq!(f[0]["request"]["input"]["command"], "rm -rf x");
        link.write(&json!({ "type": "control_response", "response": { "request_id": "r-9", "response": { "behavior": "deny" } } })).unwrap();
        let sent = out.take();
        assert_eq!(sent[0]["id"], "r-9");
        assert_eq!(sent[0]["result"]["decision"], "decline");
    }

    #[test]
    fn compact_e_a_compactacao_contam_o_antes_e_o_depois() {
        let (mut link, out) = link(None);
        opened(&mut link, &out);
        link.on_line(r#"{"method":"thread/tokenUsage/updated","params":{"tokenUsage":{"last":{"totalTokens":20000},"modelContextWindow":258400}}}"#);
        let f = link.write(&user("/compact")).unwrap();
        assert_eq!(f[0]["status"], "compacting");
        assert_eq!(out.take()[0]["method"], "thread/compact/start");
        link.on_line(r#"{"method":"turn/started","params":{"turn":{"id":"turn-c"}}}"#);
        link.on_line(r#"{"method":"item/started","params":{"item":{"type":"contextCompaction","id":"k1"}}}"#);
        link.on_line(r#"{"method":"thread/tokenUsage/updated","params":{"tokenUsage":{"last":{"totalTokens":4000},"modelContextWindow":258400}}}"#);
        let f = link.on_line(r#"{"method":"item/completed","params":{"item":{"type":"contextCompaction","id":"k1"}}}"#);
        assert_eq!(f[0]["compact_result"], "success");
        assert_eq!(f[1]["subtype"], "compact_boundary");
        assert_eq!(f[1]["compact_metadata"]["pre_tokens"], 20000);
        assert_eq!(f[1]["compact_metadata"]["post_tokens"], 4000);
    }

    #[test]
    fn context_vira_o_relatorio_que_a_tela_desenha() {
        let (mut link, out) = link(None);
        opened(&mut link, &out);
        let f = link.on_line(r#"{"method":"thread/tokenUsage/updated","params":{"tokenUsage":{"last":{"totalTokens":12300},"modelContextWindow":258400}}}"#);
        assert_eq!(f[0]["subtype"], "tokens");
        assert_eq!(f[0]["tokens"], 12300);
        let f = link.write(&user("/context")).unwrap();
        assert_eq!(f[0]["message"]["model"], "<synthetic>");
        let text = f[0]["message"]["content"][0]["text"].as_str().unwrap();
        assert!(text.starts_with("## Context Usage"));
        assert!(text.contains("**Model:** gpt-5.4"));
        assert!(text.contains("**Tokens:** 12k / 258k (5%)"));
        assert_eq!(f[1]["type"], "result");
        assert!(out.take().is_empty(), "/context não vai ao processo");
    }

    #[test]
    fn comando_que_o_codex_nao_tem_e_recusado_na_tela() {
        let (mut link, out) = link(None);
        opened(&mut link, &out);
        let f = link.write(&user("/cost")).unwrap();
        assert_eq!(f[0]["subtype"], "stderr");
        assert!(f[0]["text"].as_str().unwrap().contains("/cost"));
        assert_eq!(f[1]["type"], "result");
    }

    #[test]
    fn caminho_absoluto_nao_vira_comando_de_barra() {
        let (mut link, out) = link(None);
        opened(&mut link, &out);
        let path = r#"/var/folders/q7/TemporaryItems/Captura\ de\ Tela.png"#;
        assert!(link.write(&user(path)).unwrap().is_empty());
        let sent = out.take();
        assert_eq!(sent[0]["method"], "turn/start");
        assert_eq!(sent[0]["params"]["input"][0]["text"], path);
    }

    #[test]
    fn log_do_app_server_nao_duplica_erro_da_ferramenta() {
        let log = "\u{1b}[2m2026-08-28T16:54:16.210466Z\u{1b}[0m \u{1b}[31mERROR\u{1b}[0m \u{1b}[2mcodex_core::tools::router\u{1b}[0m: error=apply_patch verification failed";
        assert_eq!(process_stderr(log), None);
        assert_eq!(process_stderr("codex: not logged in"), Some("codex: not logged in".into()));
    }

    #[test]
    fn interromper_precisa_do_turno() {
        let (mut link, out) = link(None);
        opened(&mut link, &out);
        let stop = json!({ "type": "control_request", "request_id": "x", "request": { "subtype": "interrupt" } });
        link.write(&stop).unwrap();
        assert!(out.take().is_empty());
        link.on_line(r#"{"method":"turn/started","params":{"turn":{"id":"turn-1"}}}"#);
        link.write(&stop).unwrap();
        let sent = out.take();
        assert_eq!(sent[0]["method"], "turn/interrupt");
        assert_eq!(sent[0]["params"]["turnId"], "turn-1");
        let f = link.on_line(r#"{"method":"turn/completed","params":{"turn":{"id":"turn-1","status":"interrupted"}}}"#);
        assert_eq!(f[0]["is_error"], true);
        assert_eq!(f[0]["result"], "");
    }

    /// Como o Codex manda: caminho absoluto, hunk cru na alteração, e o
    /// conteúdo do arquivo (sem sinal) no arquivo novo.
    #[test]
    fn o_patch_vira_diff_com_cabecalho_e_sinal() {
        let change = json!({ "path": "/wt/src/a.rs", "kind": { "type": "update", "move_path": null }, "diff": "@@ -1 +1 @@\n-a\n+b\n" });
        let text = patch(&change, "/wt");
        assert_eq!(text, "diff --git a/src/a.rs b/src/a.rs\n--- a/src/a.rs\n+++ b/src/a.rs\n@@ -1 +1 @@\n-a\n+b");
        let add = json!({ "path": "/wt/n.txt", "kind": { "type": "add" }, "diff": "novo\nlinha\n" });
        assert_eq!(patch(&add, "/wt"), "diff --git a/n.txt b/n.txt\n--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,2 @@\n+novo\n+linha");
        let del = json!({ "path": "/outro/x.txt", "kind": { "type": "delete" }, "diff": "fim\n" });
        assert!(patch(&del, "/wt").starts_with("diff --git a//outro/x.txt b//outro/x.txt\n--- a//outro/x.txt\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-fim"));
    }

    #[test]
    fn kilo_como_na_tela() {
        assert_eq!(kilo(368), "368");
        assert_eq!(kilo(3140), "3.1k");
        assert_eq!(kilo(24000), "24k");
        assert_eq!(kilo(1_200_000), "1.2m");
    }
}
