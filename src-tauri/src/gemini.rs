//! Gemini CLI 0.30 ACP boundary. Prometeu keeps V1 display history separately from native sessions.
use crate::lock::lock;
use crate::session::Launch;
use crate::{accounts, chat, conversation, i18n, paths};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    io::Write,
    path::{Path, PathBuf},
    process::Command,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
mod account;
pub use account::{account_env, account_status, login, prepare_profile, update_key, user_home};

pub fn installed() -> bool {
    Command::new("gemini")
        .arg("--version")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| semver::Version::parse(String::from_utf8_lossy(&o.stdout).trim()).ok())
        .is_some_and(|v| v >= semver::Version::new(0, 30, 0))
}
pub fn spawn(
    app: &tauri::AppHandle,
    id: &str,
    _workspace: &str,
    cwd: &Path,
    resume: Option<String>,
    launch: &Launch,
) -> Result<chat::Chat, String> {
    if !installed() {
        return Err(i18n::t("err.gemini.version"));
    }
    if [&launch.mcp, &launch.plugins, &launch.skills]
        .iter()
        .any(|v| v.as_ref().is_some_and(|ids| !ids.is_empty()))
    {
        return Err(i18n::t("err.gemini.tools"));
    }
    let profile = accounts::active(crate::state::ProviderId::Gemini)?;
    profile.prepare()?;
    let replay = match &resume {
        Some(id) => history_count(&profile.home.join(".gemini/tmp"), id)?,
        None => 0,
    };
    let mut cmd = Command::new("gemini");
    profile.apply(&mut cmd)?;
    cmd.args([
        "--experimental-acp",
        "--approval-mode",
        if launch.plan {
            "plan"
        } else if launch.permission == Some(crate::actions::Permission::Ask) {
            "default"
        } else {
            "yolo"
        },
    ])
    .current_dir(cwd);
    if !launch.model.is_empty() {
        cmd.args(["--model", &launch.model]);
    }
    let start = Start {
        cwd: cwd.display().to_string(),
        resume,
        replay,
        auth: if profile.auth_method.as_deref() == Some("apiKey") {
            "gemini-api-key"
        } else {
            "oauth-personal"
        }
        .into(),
        instructions: launch.instructions.clone(),
        plan: launch.plan,
        plan_root: Some(profile.home.join(".gemini/tmp")),
    };
    let io = chat::ProcessIo::new(
        |_| None,
        move |stdin| {
            let link = Arc::new(Mutex::new(Link::new(Box::new(stdin), start)));
            let weak = Arc::downgrade(&link);
            // Startup has a bounded lifetime even if a CLI never finishes history replay. Closing stdin
            // triggers its official ACP cleanup and lets ProcessIo report process exit.
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(60));
                if let Some(link) = weak.upgrade() {
                    let mut link = lock(&link);
                    if !link.ready() {
                        link.failed = true;
                        link.close();
                    }
                }
            });
            let reader = link.clone();
            (
                chat::Wire::Gemini(link),
                Box::new(move |line: &str| {
                    lock(&reader)
                        .on_line(line)
                        .into_iter()
                        .map(|v| v.to_string())
                        .collect()
                }) as chat::Translate,
            )
        },
        profile,
    );
    let log = paths::chat_log(id);
    chat::launch(
        app,
        id,
        cmd,
        &log,
        Some(log.clone()),
        "err.gemini.spawn",
        io,
    )
}

/// Count the exact notifications emitted by 0.30's Session.streamHistory. The load response is
/// not a barrier: the implementation starts streamHistory without awaiting it.
fn history_count(root: &Path, id: &str) -> Result<usize, String> {
    for project in std::fs::read_dir(root)
        .map_err(|_| i18n::t("err.gemini.history"))?
        .flatten()
    {
        let Ok(files) = std::fs::read_dir(project.path().join("chats")) else {
            continue;
        };
        for file in files.flatten() {
            if file.path().extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let Ok(raw) = std::fs::read_to_string(file.path()) else {
                continue;
            };
            let Ok(v) = serde_json::from_str::<Value>(&raw) else {
                continue;
            };
            if v["sessionId"] == id {
                return replay_count(&v);
            }
        }
    }
    Err(i18n::t("err.gemini.history"))
}
fn replay_count(v: &Value) -> Result<usize, String> {
    let messages = v["messages"]
        .as_array()
        .ok_or_else(|| i18n::t("err.gemini.history"))?;
    let mut n = 0;
    for msg in messages {
        let has_text = history_has_text(&msg["content"]);
        match msg["type"].as_str() {
            Some("user") => {
                n += usize::from(has_text);
            }
            Some("gemini") => {
                n += usize::from(has_text);
                n += msg["thoughts"].as_array().map_or(0, Vec::len);
                n += msg["toolCalls"].as_array().map_or(0, Vec::len);
            }
            _ => {}
        }
    }
    Ok(n)
}
fn history_has_text(value: &Value) -> bool {
    match value {
        Value::String(s) => !s.trim().is_empty(),
        Value::Array(parts) => parts.iter().any(history_has_text),
        Value::Object(part) => {
            [
                "videoMetadata",
                "thought",
                "codeExecutionResult",
                "executableCode",
                "fileData",
                "functionCall",
                "functionResponse",
                "inlineData",
            ]
            .iter()
            .any(|key| part.contains_key(*key))
                || part
                    .get("text")
                    .and_then(Value::as_str)
                    .is_some_and(|s| !s.trim().is_empty())
        }
        _ => false,
    }
}
fn read_native_plan(root: &Path, path: &Path) -> Option<String> {
    let root = root.canonicalize().ok()?;
    let path = path.canonicalize().ok()?;
    if !path.starts_with(root)
        || path.extension().and_then(|s| s.to_str()) != Some("md")
        || !path.components().any(|c| c.as_os_str() == "plans")
    {
        return None;
    }
    std::fs::read_to_string(path).ok()
}
pub struct Start {
    pub plan: bool,
    pub plan_root: Option<PathBuf>,
    pub cwd: String,
    pub resume: Option<String>,
    pub replay: usize,
    pub auth: String,
    pub instructions: String,
}
#[derive(Clone, Copy)]
enum Sent {
    Init,
    Auth,
    Open,
    Prompt,
}
struct Ask {
    rpc: Value,
    allow: Option<String>,
    deny: Option<String>,
}
pub struct Link {
    out: Box<dyn Write + Send>,
    start: Start,
    next: u64,
    sent: HashMap<u64, Sent>,
    session: Option<String>,
    remaining: usize,
    opened: bool,
    failed: bool,
    queue: VecDeque<String>,
    busy: bool,
    asks: HashMap<String, Ask>,
    message: String,
    index: usize,
    open: Option<(String, String, usize)>,
    tools: std::collections::HashSet<String>,
    deadline: Instant,
    plan_request: Option<String>,
    plan_text: String,
    bypass: bool,
    plan_transition: Option<crate::actions::Permission>,
    native_plan_stop: bool,
    user_interrupted: bool,
}
fn event(kind: &str, fields: Value) -> Value {
    conversation::event(kind, conversation::now(), fields)
}
fn complete(outcome: &str, message: &str) -> Value {
    event(
        "turn.completed",
        json!({"outcome":outcome,"message":message,"durationMs":null,"costUsd":null}),
    )
}
impl Link {
    pub fn new(out: Box<dyn Write + Send>, start: Start) -> Self {
        let remaining = start.replay;
        let mut start = start;
        if start.plan {
            start.instructions.push_str("\nIn plan mode, present the full plan in your final reply and do not call exit_plan_mode. Prometeu asks the person for approval after your turn and resumes execution only after approval.");
        }
        let mut s = Self {
            out,
            start,
            next: 0,
            sent: HashMap::new(),
            session: None,
            remaining,
            opened: false,
            failed: false,
            queue: VecDeque::new(),
            busy: false,
            asks: HashMap::new(),
            message: String::new(),
            index: 0,
            open: None,
            tools: Default::default(),
            deadline: Instant::now() + Duration::from_secs(60),
            plan_request: None,
            plan_text: String::new(),
            bypass: false,
            plan_transition: None,
            native_plan_stop: false,
            user_interrupted: false,
        };
        if s.call("initialize",json!({"protocolVersion":1,"clientCapabilities":{},"clientInfo":{"name":"prometeu","version":env!("CARGO_PKG_VERSION")}}),Sent::Init).is_err(){s.failed=true;}
        s
    }
    pub fn take_plan_transition(&mut self) -> Option<crate::actions::Permission> {
        self.plan_transition.take()
    }
    pub fn close(&mut self) {
        self.out = Box::new(std::io::sink());
    }
    fn ready(&self) -> bool {
        self.opened && self.remaining == 0 && !self.failed
    }
    fn send(&mut self, v: Value) -> Result<(), String> {
        writeln!(self.out, "{v}")
            .and_then(|_| self.out.flush())
            .map_err(|_| i18n::t("err.gemini.transport"))
    }
    fn call(&mut self, method: &str, params: Value, sent: Sent) -> Result<(), String> {
        self.next += 1;
        self.sent.insert(self.next, sent);
        self.send(json!({"jsonrpc":"2.0","id":self.next,"method":method,"params":params}))
    }
    pub fn write(&mut self, v: &Value) -> Result<Vec<Value>, String> {
        if v["v"] != 1 {
            return Err(i18n::t("err.team.bad"));
        }
        if self.failed || (!self.ready() && Instant::now() > self.deadline) {
            return Err(i18n::t("err.gemini.start"));
        }
        match v["type"].as_str() {
            Some("message.send") => {
                if self.plan_request.is_some() {
                    return Err(i18n::t("err.gemini.planPending"));
                }

                let text = v["text"].as_str().ok_or_else(|| i18n::t("err.team.bad"))?;
                if text.starts_with('/')
                    && !text
                        .split_whitespace()
                        .next()
                        .unwrap_or("")
                        .trim_start_matches('/')
                        .contains('/')
                {
                    return Ok(vec![
                        event(
                            "system.notice",
                            json!({"level":"error","code":"command.unsupported","detail":i18n::t("err.gemini.command")}),
                        ),
                        complete("ok", ""),
                    ]);
                }
                self.queue.push_back(text.into());
                self.flush()?;
                Ok(vec![])
            }
            Some("turn.interrupt") => {
                self.queue.clear();
                self.native_plan_stop = false;
                self.user_interrupted = true;
                for (_, ask) in std::mem::take(&mut self.asks) {
                    self.send(json!({"jsonrpc":"2.0","id":ask.rpc,"result":{"outcome":{"outcome":"cancelled"}}}))?;
                }
                if let Some(id) = &self.session {
                    self.send(json!({"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":id}}))?;
                }
                Ok(vec![])
            }
            Some("commands.list") => Ok(vec![event("commands.updated", json!({"commands":[]}))]),
            Some("permission.mode.set") if v["mode"] == "bypass" => {
                self.bypass = true;
                Ok(vec![])
            }
            Some("request.respond")
                if v["requestId"].as_str() == self.plan_request.as_deref()
                    && self.plan_request.is_some() =>
            {
                match v["response"]["outcome"].as_str() {
                    Some("allow") => {
                        self.plan_request = None;
                        self.plan_transition = Some(if self.bypass {
                            crate::actions::Permission::Auto
                        } else {
                            crate::actions::Permission::Ask
                        });
                        Ok(vec![])
                    }
                    Some("deny") => {
                        self.plan_request = None;
                        if let Some(text) = v["response"]["message"]
                            .as_str()
                            .filter(|s| !s.trim().is_empty())
                        {
                            self.queue.push_back(text.into());
                            self.flush()?;
                        }
                        Ok(vec![])
                    }
                    _ => Err(i18n::t("err.team.bad")),
                }
            }
            Some("request.respond") => {
                let id = v["requestId"]
                    .as_str()
                    .ok_or_else(|| i18n::t("err.team.bad"))?;
                let outcome = v["response"]["outcome"].as_str().unwrap_or("");
                if !matches!(outcome, "allow" | "deny") {
                    return Err(i18n::t("err.team.bad"));
                }
                let ask = self
                    .asks
                    .remove(id)
                    .ok_or_else(|| i18n::t("err.team.bad"))?;
                let selected = if outcome == "allow" {
                    ask.allow
                } else {
                    ask.deny
                };
                let outcome = match selected {
                    Some(id) => json!({"outcome":"selected","optionId":id}),
                    None => json!({"outcome":"cancelled"}),
                };
                self.send(json!({"jsonrpc":"2.0","id":ask.rpc,"result":{"outcome":outcome}}))?;
                Ok(vec![])
            }
            _ => Err(i18n::t("err.team.bad")),
        }
    }
    fn flush(&mut self) -> Result<(), String> {
        if self.ready() && !self.busy && self.plan_request.is_none() {
            if let Some(mut text) = self.queue.pop_front() {
                if !self.start.instructions.is_empty() {
                    text = format!("{}\n\n{text}", self.start.instructions);
                    self.start.instructions.clear();
                }
                self.message = uuid::Uuid::new_v4().to_string();
                self.index = 0;
                self.tools.clear();
                self.plan_text.clear();
                self.user_interrupted = false;
                self.native_plan_stop = false;
                self.busy = true;
                self.call(
                    "session/prompt",
                    json!({"sessionId":self.session,"prompt":[{"type":"text","text":text}]}),
                    Sent::Prompt,
                )?;
            }
        }
        Ok(())
    }
    fn failure(&mut self) -> Vec<Value> {
        self.failed = true;
        self.close();
        self.busy = false;
        self.queue.clear();
        let mut out = self.seal();
        out.push(complete("error", &i18n::t("err.gemini.start")));
        out
    }
    pub fn on_line(&mut self, line: &str) -> Vec<Value> {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            return vec![];
        };
        if v["method"] == "session/update" {
            if self.remaining > 0 {
                self.remaining -= 1;
                if self.flush().is_err() {
                    return self.failure();
                }
                return vec![];
            }
            if !self.ready()
                || !self.busy
                || v["params"]["sessionId"].as_str() != self.session.as_deref()
            {
                return vec![];
            }
            return self.update(&v["params"]["update"]);
        }
        if v["method"] == "session/request_permission" {
            return self.permission(&v);
        }
        if v.get("method").is_some() {
            if v.get("id").is_some() {
                let _=self.send(json!({"jsonrpc":"2.0","id":v["id"],"error":{"code":-32601,"message":"Unsupported client method"}}));
            }
            return vec![];
        }
        let Some(sent) = v["id"].as_u64().and_then(|id| self.sent.remove(&id)) else {
            return vec![];
        };
        if v.get("error").is_some() {
            return self.failure();
        }
        let result = match sent {
            Sent::Init => {
                let result = &v["result"];
                if result["protocolVersion"] != 1
                    || (self.start.resume.is_some()
                        && result["agentCapabilities"]["loadSession"] != true)
                    || !result["authMethods"]
                        .as_array()
                        .is_some_and(|methods| methods.iter().any(|m| m["id"] == self.start.auth))
                {
                    return self.failure();
                }
                self.call(
                    "authenticate",
                    json!({"methodId":self.start.auth}),
                    Sent::Auth,
                )
            }
            Sent::Auth => {
                let mut params = json!({"cwd":self.start.cwd,"mcpServers":[]});
                let method = if let Some(id) = &self.start.resume {
                    params["sessionId"] = json!(id);
                    "session/load"
                } else {
                    "session/new"
                };
                self.call(method, params, Sent::Open)
            }
            Sent::Open => {
                self.session = self
                    .start
                    .resume
                    .clone()
                    .or_else(|| v["result"]["sessionId"].as_str().map(str::to_owned));
                if self.session.is_none() {
                    return self.failure();
                }
                self.opened = true;
                let identity = event("session.identity", json!({"providerSession":self.session}));
                if self.flush().is_err() {
                    return self.failure();
                }
                return vec![identity];
            }
            Sent::Prompt => {
                self.busy = false;
                self.asks.clear();
                let mut out = self.seal();
                out.push(complete(
                    if self.user_interrupted
                        || (v["result"]["stopReason"] == "cancelled" && !self.native_plan_stop)
                    {
                        "interrupted"
                    } else {
                        "ok"
                    },
                    "",
                ));
                if self.start.plan
                    && !self.user_interrupted
                    && self.queue.is_empty()
                    && (self.native_plan_stop || v["result"]["stopReason"] != "cancelled")
                {
                    self.native_plan_stop = false;
                    let id = format!("gemini-plan-{}", self.message);
                    self.plan_request = Some(id.clone());
                    out.push(event("request.opened", json!({"requestId":id,"kind":"plan","tool":"ExitPlanMode","toolId":null,"input":{"plan":self.plan_text}})));
                }
                if self.flush().is_err() {
                    out.extend(self.failure());
                }
                return out;
            }
        };
        if result.is_err() {
            self.failure()
        } else {
            vec![]
        }
    }
    fn seal(&mut self) -> Vec<Value> {
        match self.open.take() {
            Some((kind, text, index)) => vec![event(
                "assistant.block",
                json!({"messageId":self.message,"index":index,"block":{"kind":kind,"text":text}}),
            )],
            None => vec![],
        }
    }
    fn update(&mut self, v: &Value) -> Vec<Value> {
        match v["sessionUpdate"].as_str() {
            Some("agent_message_chunk" | "agent_thought_chunk") => {
                let Some(text) = v["content"]["text"].as_str() else {
                    return vec![];
                };
                if v["sessionUpdate"] == "agent_message_chunk" {
                    self.plan_text.push_str(text);
                }
                let kind = if v["sessionUpdate"] == "agent_thought_chunk" {
                    "thinking"
                } else {
                    "text"
                };
                let mut out = vec![];
                if self.open.as_ref().is_none_or(|o| o.0 != kind) {
                    out.extend(self.seal());
                    if self.index == 0 {
                        out.push(event(
                            "assistant.started",
                            json!({"messageId":self.message}),
                        ));
                    }
                    let index = self.index;
                    self.index += 1;
                    self.open = Some((kind.into(), String::new(), index));
                    out.push(event("assistant.block.started",json!({"messageId":self.message,"index":index,"block":{"kind":kind,"text":""}})));
                }
                let open = self.open.as_mut().unwrap();
                open.1.push_str(text);
                out.push(event(
                    "assistant.delta",
                    json!({"messageId":self.message,"index":open.2,"kind":kind,"delta":text}),
                ));
                out
            }
            Some("tool_call" | "tool_call_update") => {
                let Some(id) = v["toolCallId"].as_str() else {
                    return vec![];
                };
                let mut out = self.seal();
                if self.tools.insert(id.into()) {
                    let index = self.index;
                    self.index += 1;
                    out.push(event("assistant.block",json!({"messageId":self.message,"index":index,"block":{"kind":"tool","id":id,"name":v["title"].as_str().unwrap_or("Gemini"),"input":{"description":v["title"].as_str().unwrap_or("")}}})));
                }
                if matches!(v["status"].as_str(), Some("completed" | "failed")) {
                    let output = v["content"]
                        .as_array()
                        .map(|c| {
                            c.iter()
                                .filter_map(|b| {
                                    b["content"]["text"]
                                        .as_str()
                                        .map(str::to_owned)
                                        .or_else(|| {
                                            b["newText"].as_str().map(|new| {
                                                format!(
                                                    "{}\n{new}",
                                                    b["path"].as_str().unwrap_or("")
                                                )
                                            })
                                        })
                                })
                                .collect::<Vec<_>>()
                                .join("\n")
                        })
                        .unwrap_or_default();
                    out.push(event(
                        "tool.completed",
                        json!({"toolId":id,"output":output,"error":v["status"]=="failed","background":false}),
                    ));
                }
                out
            }
            _ => vec![],
        }
    }
    fn permission(&mut self, v: &Value) -> Vec<Value> {
        if !self.ready() || !self.busy {
            return vec![];
        }
        if self.user_interrupted {
            let _ = self.send(
                json!({"jsonrpc":"2.0","id":v["id"],"result":{"outcome":{"outcome":"cancelled"}}}),
            );
            return vec![];
        }
        if self.start.plan {
            if let Some(path) = v["params"]["toolCall"]["title"]
                .as_str()
                .and_then(|title| title.strip_prefix("Requesting plan approval for: "))
            {
                let Some(plan) = self
                    .start
                    .plan_root
                    .as_ref()
                    .and_then(|root| read_native_plan(root, Path::new(path)))
                else {
                    return self.failure();
                };
                self.plan_text = plan;
                self.native_plan_stop = true;
                if self.send(json!({"jsonrpc":"2.0","id":v["id"],"result":{"outcome":{"outcome":"cancelled"}}})).is_err()
                    || self.send(json!({"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":self.session}})).is_err() { return self.failure(); }
                return vec![];
            }
        }
        let id = v["id"].to_string();
        let options = v["params"]["options"].as_array();
        let option = |kind: &str| {
            options
                .and_then(|o| o.iter().find(|o| o["kind"] == kind))
                .and_then(|o| o["optionId"].as_str())
                .map(str::to_owned)
        };
        if self.bypass && !self.start.plan {
            if let Some(selected) = option("allow_once") {
                if self.send(json!({"jsonrpc":"2.0","id":v["id"],"result":{"outcome":{"outcome":"selected","optionId":selected}}})).is_err() {return self.failure();}
                return vec![];
            }
        }
        self.asks.insert(
            id.clone(),
            Ask {
                rpc: v["id"].clone(),
                allow: option("allow_once"),
                deny: option("reject_once"),
            },
        );
        let tool = &v["params"]["toolCall"];
        let mut call = tool.clone();
        call["sessionUpdate"] = json!("tool_call");
        let mut out = self.update(&call);
        out.push(event(
            "request.opened",
            json!({"requestId":id,"kind":"approval","tool":tool["title"].as_str().unwrap_or("Gemini"),"toolId":tool["toolCallId"],"input":{"description":tool["title"]}}),
        ));
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[derive(Clone, Default)]
    struct Output(Arc<Mutex<Vec<u8>>>);
    impl Write for Output {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
            lock(&self.0).extend_from_slice(b);
            Ok(b.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    impl Output {
        fn take(&self) -> Vec<Value> {
            String::from_utf8(std::mem::take(&mut *lock(&self.0)))
                .unwrap()
                .lines()
                .map(|l| serde_json::from_str(l).unwrap())
                .collect()
        }
    }
    fn link(replay: usize) -> (Link, Output) {
        let out = Output::default();
        (
            Link::new(
                Box::new(out.clone()),
                Start {
                    cwd: "/work".into(),
                    resume: Some("native".into()),
                    replay,
                    auth: "oauth-personal".into(),
                    instructions: String::new(),
                    plan: false,
                    plan_root: None,
                },
            ),
            out,
        )
    }
    // Deterministic fixtures derived from the installed 0.30 source; these are not live model recordings.
    #[test]
    fn replay_is_barrier_even_after_load_response() {
        let (mut l, o) = link(2);
        o.take();
        l.write(&json!({"v":1,"type":"message.send","text":"next"}))
            .unwrap();
        l.on_line(r#"{"id":1,"result":{"protocolVersion":1,"agentCapabilities":{"loadSession":true},"authMethods":[{"id":"oauth-personal"},{"id":"gemini-api-key"}]}}"#);
        assert_eq!(o.take()[0]["method"], "authenticate");
        l.on_line(r#"{"id":2,"result":{}}"#);
        assert_eq!(o.take()[0]["method"], "session/load");
        assert_eq!(
            l.on_line(r#"{"id":3,"result":{}}"#)[0]["type"],
            "session.identity"
        );
        assert!(o.take().is_empty());
        for _ in 0..2 {
            assert!(l.on_line(r#"{"method":"session/update","params":{"sessionId":"native","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"old"}}}}"#).is_empty());
        }
        assert_eq!(o.take()[0]["method"], "session/prompt");
        let e=l.on_line(r#"{"method":"session/update","params":{"sessionId":"native","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"new"}}}}"#);
        assert_eq!(e.last().unwrap()["delta"], "new");
        let e = l.on_line(r#"{"id":4,"result":{"stopReason":"end_turn"}}"#);
        assert_eq!(e[0]["block"]["text"], "new");
        assert_eq!(e[1]["type"], "turn.completed");
    }
    #[test]
    fn history_skips_blank_text_and_counts_tools_and_thoughts() {
        assert_eq!(replay_count(&json!({"messages":[{"type":"user","content":" "},{"type":"gemini","content":[{"text":"hello"}],"thoughts":[{},{}],"toolCalls":[{}]},{"type":"info","content":"ignored"}]})).unwrap(),4);
    }
    #[test]
    fn startup_errors_never_expose_provider_credentials() {
        let (mut l, _) = link(0);
        let out = l.on_line(r#"{"id":1,"error":{"message":"secret-api-key"}}"#);
        assert!(!serde_json::to_string(&out)
            .unwrap()
            .contains("secret-api-key"));
        assert!(l
            .write(&json!({"v":1,"type":"message.send","text":"no"}))
            .is_err());
    }
    fn opened(l: &mut Link, out: &Output) {
        out.take();
        l.on_line(r#"{"id":1,"result":{"protocolVersion":1,"agentCapabilities":{"loadSession":true},"authMethods":[{"id":"oauth-personal"},{"id":"gemini-api-key"}]}}"#);
        out.take();
        l.on_line(r#"{"id":2,"result":{}}"#);
        out.take();
        l.on_line(r#"{"id":3,"result":{}}"#);
        out.take();
    }
    #[test]
    fn replay_notifications_before_response_do_not_release_prompt() {
        let (mut l, out) = link(1);
        out.take();
        l.write(&json!({"v":1,"type":"message.send","text":"next"}))
            .unwrap();
        l.on_line(r#"{"id":1,"result":{"protocolVersion":1,"agentCapabilities":{"loadSession":true},"authMethods":[{"id":"oauth-personal"},{"id":"gemini-api-key"}]}}"#);
        out.take();
        l.on_line(r#"{"id":2,"result":{}}"#);
        out.take();
        l.on_line(r#"{"method":"session/update","params":{"sessionId":"native","update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"old"}}}}"#);
        assert!(out.take().is_empty());
        l.on_line(r#"{"id":3,"result":{}}"#);
        assert_eq!(out.take()[0]["method"], "session/prompt");
    }
    #[test]
    fn plan_approval_is_local_and_requests_restart_with_selected_permission() {
        let (mut l, out) = link(0);
        l.start.plan = true;
        opened(&mut l, &out);
        l.write(&json!({"v":1,"type":"message.send","text":"plan"}))
            .unwrap();
        out.take();
        l.on_line(r#"{"method":"session/update","params":{"sessionId":"native","update":{"sessionUpdate":"agent_message_chunk","content":{"text":"approved steps"}}}}"#);
        let events = l.on_line(r#"{"id":4,"result":{"stopReason":"end_turn"}}"#);
        let request = events.last().unwrap();
        assert_eq!(request["kind"], "plan");
        assert_eq!(request["input"]["plan"], "approved steps");
        l.write(&json!({"v":1,"type":"permission.mode.set","mode":"bypass"}))
            .unwrap();
        l.write(&json!({"v":1,"type":"request.respond","requestId":request["requestId"],"response":{"outcome":"allow"}})).unwrap();
        assert!(matches!(
            l.take_plan_transition(),
            Some(crate::actions::Permission::Auto)
        ));
        assert!(l.take_plan_transition().is_none());
        assert!(out.take().is_empty());
    }
    #[test]
    fn plan_interruption_never_requests_approval() {
        let (mut l, out) = link(0);
        l.start.plan = true;
        opened(&mut l, &out);
        l.write(&json!({"v":1,"type":"message.send","text":"plan"}))
            .unwrap();
        l.write(&json!({"v":1,"type":"turn.interrupt"})).unwrap();
        assert_eq!(out.take().last().unwrap()["method"], "session/cancel");
        let e = l.on_line(r#"{"id":4,"result":{"stopReason":"cancelled"}}"#);
        assert_eq!(e.len(), 1);
        assert_eq!(e[0]["outcome"], "interrupted");
        assert!(l.plan_request.is_none());
    }
    #[test]
    fn permission_preserves_rpc_id_and_only_uses_offered_options() {
        let (mut l, out) = link(0);
        opened(&mut l, &out);
        l.write(&json!({"v":1,"type":"message.send","text":"go"}))
            .unwrap();
        out.take();
        let e=l.on_line(r#"{"jsonrpc":"2.0","id":"opaque-7","method":"session/request_permission","params":{"sessionId":"native","toolCall":{"toolCallId":"t1","title":"Write file"},"options":[{"kind":"allow_once","optionId":"proceed_once"},{"kind":"reject_once","optionId":"cancel"}]}}"#);
        assert_eq!(e[0]["block"]["name"], "Write file");
        let id = e.last().unwrap()["requestId"].clone();
        l.write(
            &json!({"v":1,"type":"request.respond","requestId":id,"response":{"outcome":"allow"}}),
        )
        .unwrap();
        let reply = &out.take()[0];
        assert_eq!(reply["id"], "opaque-7");
        assert_eq!(reply["result"]["outcome"]["optionId"], "proceed_once");
        let e=l.on_line(r#"{"method":"session/update","params":{"sessionId":"native","update":{"sessionUpdate":"tool_call_update","toolCallId":"t1","status":"completed","content":[{"type":"content","content":{"type":"text","text":"saved"}}]}}}"#);
        assert_eq!(e.len(), 1);
        assert_eq!(e[0]["type"], "tool.completed");
        assert_eq!(e[0]["output"], "saved");
    }
    #[test]
    fn verbose_native_parts_are_counted_even_without_text() {
        assert_eq!(replay_count(&json!({"messages":[{"type":"user","content":[{"inlineData":{"mimeType":"image/png"}}]},{"type":"gemini","content":{"functionCall":{"name":"read_file"}}}]})).unwrap(),2);
    }
    #[test]
    fn native_exit_plan_is_cancelled_and_replaced_with_one_local_approval() {
        let dir =
            std::env::temp_dir().join(format!("prometeu-native-plan-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("session/plans")).unwrap();
        let path = dir.join("session/plans/plan.md");
        std::fs::write(&path, "1. Update the adapter\n2. Test it").unwrap();
        let (mut l, out) = link(0);
        l.start.plan = true;
        l.start.plan_root = Some(dir.clone());
        opened(&mut l, &out);
        l.write(&json!({"v":1,"type":"message.send","text":"plan"}))
            .unwrap();
        out.take();
        let native = json!({"id":"native-plan","method":"session/request_permission","params":{"sessionId":"native","toolCall":{"title":format!("Requesting plan approval for: {}",path.display())},"options":[]}});
        assert!(l.on_line(&native.to_string()).is_empty());
        let sent = out.take();
        assert_eq!(sent[0]["result"]["outcome"]["outcome"], "cancelled");
        assert_eq!(sent[1]["method"], "session/cancel");
        let events = l.on_line(r#"{"id":4,"result":{"stopReason":"cancelled"}}"#);
        assert_eq!(
            events
                .iter()
                .filter(|e| e["type"] == "request.opened")
                .count(),
            1
        );
        assert_eq!(
            events.last().unwrap()["input"]["plan"],
            "1. Update the adapter\n2. Test it"
        );
        assert!(l
            .write(&json!({"v":1,"type":"message.send","text":"queued"}))
            .is_err());
        assert!(out.take().is_empty());
        assert!(read_native_plan(&dir, Path::new("/etc/passwd")).is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn incompatible_initialization_fails_before_authentication() {
        for result in [
            json!({}),
            json!({"protocolVersion":2,"agentCapabilities":{"loadSession":true},"authMethods":[{"id":"oauth-personal"}]}),
            json!({"protocolVersion":1,"agentCapabilities":{},"authMethods":[{"id":"oauth-personal"}]}),
            json!({"protocolVersion":1,"agentCapabilities":{"loadSession":true},"authMethods":[{"id":"vertex-ai"}]}),
        ] {
            let (mut l, out) = link(0);
            out.take();
            let e = l.on_line(&json!({"id":1,"result":result}).to_string());
            assert_eq!(e.last().unwrap()["outcome"], "error");
            assert!(out.take().is_empty());
        }
    }
    #[test]
    fn queued_plan_prompts_run_before_the_final_approval() {
        let (mut l, out) = link(0);
        l.start.plan = true;
        opened(&mut l, &out);
        l.write(&json!({"v":1,"type":"message.send","text":"first"}))
            .unwrap();
        l.write(&json!({"v":1,"type":"message.send","text":"adjust"}))
            .unwrap();
        out.take();
        let events = l.on_line(r#"{"id":4,"result":{"stopReason":"end_turn"}}"#);
        assert!(events.iter().all(|v| v["type"] != "request.opened"));
        assert_eq!(out.take()[0]["params"]["prompt"][0]["text"], "adjust");
        let events = l.on_line(r#"{"id":5,"result":{"stopReason":"end_turn"}}"#);
        assert_eq!(events.last().unwrap()["kind"], "plan");
    }
    #[test]
    fn interruption_answers_outstanding_permission_before_cancelling_prompt() {
        let (mut l, out) = link(0);
        opened(&mut l, &out);
        l.write(&json!({"v":1,"type":"message.send","text":"go"}))
            .unwrap();
        out.take();
        l.on_line(r#"{"id":99,"method":"session/request_permission","params":{"sessionId":"native","toolCall":{"toolCallId":"tool","title":"Write"},"options":[{"kind":"allow_once","optionId":"once"}]}}"#);
        l.write(&json!({"v":1,"type":"turn.interrupt"})).unwrap();
        let sent = out.take();
        assert_eq!(sent[0]["id"], 99);
        assert_eq!(sent[0]["result"]["outcome"]["outcome"], "cancelled");
        assert_eq!(sent[1]["method"], "session/cancel");
        assert!(l.asks.is_empty());
    }
    #[test]
    fn canonical_events_match_the_cross_language_fixture() {
        let (mut l, out) = link(0);
        l.start.plan = true;
        out.take();
        l.on_line(r#"{"id":1,"result":{"protocolVersion":1,"agentCapabilities":{"loadSession":true},"authMethods":[{"id":"oauth-personal"}]}}"#);
        l.on_line(r#"{"id":2,"result":{}}"#);
        let mut events = l.on_line(r#"{"id":3,"result":{}}"#);
        l.write(&json!({"v":1,"type":"message.send","text":"plan"}))
            .unwrap();
        l.message = "fixture-message".into();
        for frame in [
            json!({"method":"session/update","params":{"sessionId":"native","update":{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"Check the file"}}}}),
            json!({"method":"session/update","params":{"sessionId":"native","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Update the adapter and test it."}}}}),
            json!({"id":7,"method":"session/request_permission","params":{"sessionId":"native","toolCall":{"toolCallId":"t1","title":"Read file"},"options":[{"kind":"allow_once","optionId":"once"}]}}),
        ] {
            events.extend(l.on_line(&frame.to_string()));
        }
        l.write(
            &json!({"v":1,"type":"request.respond","requestId":"7","response":{"outcome":"allow"}}),
        )
        .unwrap();
        events.extend(l.on_line(&json!({"method":"session/update","params":{"sessionId":"native","update":{"sessionUpdate":"tool_call_update","toolCallId":"t1","status":"completed","content":[{"type":"content","content":{"type":"text","text":"file contents"}}]}}}).to_string()));
        events.extend(l.on_line(r#"{"id":4,"result":{"stopReason":"end_turn"}}"#));
        events.extend(l.write(&json!({"v":1,"type":"commands.list"})).unwrap());
        for event in &mut events {
            event["at"] = json!(0);
        }
        let fixture = json!({"provenance":"Deterministic installed Gemini CLI 0.30 source-derived ACP translation; not a live model recording.","events":events});
        if std::env::var_os("PROMETEU_UPDATE_GEMINI_FIXTURE").is_some() {
            std::fs::write(
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("src/gemini/fixtures/canonical-events.json"),
                serde_json::to_string_pretty(&fixture).unwrap() + "\n",
            )
            .unwrap();
        } else {
            let expected: Value =
                serde_json::from_str(include_str!("gemini/fixtures/canonical-events.json"))
                    .unwrap();
            assert_eq!(fixture, expected);
        }
    }
}
