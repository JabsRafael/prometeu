//! Contrato canônico da conversa e compatibilidade com o stream-json legado.
//!
//! Os processos podem falar protocolos diferentes; tudo que cruza o `Pump`
//! já é um evento V1 do Prometheus. Transcripts antigos não são reescritos:
//! a UI mantém um leitor de rollback e logs novos podem coexistir com linhas
//! antigas no mesmo arquivo.

use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

#[derive(Default)]
pub struct LegacyAdapter {
    message: String,
    next_block: usize,
    tools: HashMap<String, String>,
    pending_skill: Option<String>,
    tasks: HashMap<String, Value>,
    commands: Vec<Value>,
    terminal: HashSet<String>,
}

impl LegacyAdapter {
    pub fn translate_line(&mut self, line: &str) -> Vec<String> {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            return vec![];
        };
        self.translate(&value)
            .into_iter()
            .map(|event| event.to_string())
            .collect()
    }

    pub fn translate(&mut self, value: &Value) -> Vec<Value> {
        if value["v"] == 1 {
            return vec![value.clone()];
        }
        if value["prometheusV1Mirror"] == true
            || value["isSidechain"] == true
            || !value["parent_tool_use_id"].is_null()
        {
            return vec![];
        }
        let at = value["ts"].as_u64().unwrap_or_else(now);
        match value["type"].as_str() {
            Some("user") => self.user(value, at),
            Some("assistant") => self.assistant(value, at),
            Some("stream_event") => self.stream(value, at),
            Some("control_request") => self.request(value, at),
            Some("control_response") => self.command_list(value, at),
            Some("result") => vec![event(
                "turn.completed",
                at,
                json!({
                    "outcome": if value["is_error"] == true {
                        if turn_message(value).is_empty() { "interrupted" } else { "error" }
                    } else { "ok" },
                    "message": turn_message(value),
                    "durationMs": value["duration_ms"].as_u64(),
                    "costUsd": value["total_cost_usd"].as_f64(),
                }),
            )],
            Some("system") => self.system(value, at),
            Some("prometheus") => self.prometheus(value, at),
            Some("rate_limit_event") => vec![event(
                "usage.updated",
                at,
                json!({ "provider": "claude", "usage": value["rate_limit_info"] }),
            )],
            _ => vec![],
        }
    }

    fn user(&mut self, value: &Value, at: u64) -> Vec<Value> {
        let content = &value["message"]["content"];
        if let Some(blocks) = content.as_array() {
            let mut out = vec![];
            let mut texts = vec![];
            for block in blocks {
                match block["type"].as_str() {
                    Some("tool_result") => {
                        let tool_id = block["tool_use_id"].as_str().unwrap_or("");
                        if tool_id.is_empty() {
                            continue;
                        }
                        out.push(event(
                            "tool.completed",
                            at,
                            json!({
                                "toolId": tool_id,
                                "output": result_text(&block["content"]),
                                "error": block["is_error"] == true,
                                "background": self.tasks.values().any(|task| task["toolId"] == tool_id),
                            }),
                        ));
                        if self.tools.get(tool_id).is_some_and(|name| name == "Skill")
                            && block["is_error"] != true
                        {
                            self.pending_skill = Some(tool_id.to_string());
                        }
                    }
                    Some("text") => {
                        if let Some(text) = block["text"].as_str() {
                            texts.push(text.to_string());
                        }
                    }
                    Some("image") => texts.push("[imagem]".to_string()),
                    _ => {}
                }
            }
            if !texts.is_empty() {
                out.extend(self.spoken(&texts.join("\n\n"), value, at));
            }
            return out;
        }
        content
            .as_str()
            .map(|text| self.spoken(text, value, at))
            .unwrap_or_default()
    }

    fn spoken(&mut self, text: &str, value: &Value, at: u64) -> Vec<Value> {
        if let Some(tool_id) = self.pending_skill.clone() {
            let source = value["sourceToolUseID"].as_str();
            if (value["isSynthetic"] == true || value["isMeta"] == true)
                && source.is_none_or(|source| source == tool_id)
            {
                self.pending_skill = None;
                return vec![event(
                    "tool.completed",
                    at,
                    json!({ "toolId": tool_id, "output": text, "error": false, "background": false }),
                )];
            }
        }
        let trim = text.trim_start();
        if value["isMeta"] == true
            || trim.starts_with("<command-name>")
            || trim.starts_with("<local-command-stdout>")
            || trim.starts_with("<local-command-caveat>")
        {
            return vec![];
        }
        if value["isCompactSummary"] == true
            || text.starts_with("This session is being continued from a previous conversation")
        {
            return vec![event("system.summary", at, json!({ "text": text }))];
        }
        if trim.starts_with("<task-notification>") {
            if let Some(summary) = between(text, "<summary>", "</summary>") {
                return vec![event(
                    "system.notice",
                    at,
                    json!({ "level": "info", "code": "background.completed", "detail": summary.trim() }),
                )];
            }
        }
        (!text.trim().is_empty())
            .then(|| {
                event(
                    "user.message",
                    at,
                    json!({ "content": [{ "kind": "text", "text": text }] }),
                )
            })
            .into_iter()
            .collect()
    }

    fn assistant(&mut self, value: &Value, at: u64) -> Vec<Value> {
        self.pending_skill = None;
        let message = &value["message"];
        if message["model"] == "<synthetic>" {
            let markdown = message["content"]
                .as_array()
                .and_then(|blocks| blocks.iter().find(|block| block["type"] == "text"))
                .and_then(|block| block["text"].as_str());
            return markdown
                .map(|markdown| event("context.reported", at, json!({ "markdown": markdown })))
                .into_iter()
                .collect();
        }
        let message_id = message["id"]
            .as_str()
            .or_else(|| value["uuid"].as_str())
            .unwrap_or("");
        if message_id.is_empty() {
            return vec![];
        }
        self.select_message(message_id);
        let mut out = vec![];
        for raw in message["content"].as_array().into_iter().flatten() {
            let Some(block) = block(raw) else { continue };
            if block["kind"] == "tool" {
                if let (Some(id), Some(name)) = (block["id"].as_str(), block["name"].as_str()) {
                    self.tools.insert(id.to_string(), name.to_string());
                }
            }
            out.push(event(
                "assistant.block",
                at,
                json!({ "messageId": message_id, "index": self.next_block, "block": block }),
            ));
            self.next_block += 1;
        }
        out
    }

    fn stream(&mut self, value: &Value, at: u64) -> Vec<Value> {
        let raw = &value["event"];
        if raw["type"] == "message_start" {
            let message_id = raw["message"]["id"].as_str().unwrap_or("");
            if message_id.is_empty() {
                return vec![];
            }
            self.message = message_id.to_string();
            self.next_block = 0;
            return vec![event(
                "assistant.started",
                at,
                json!({ "messageId": message_id }),
            )];
        }
        let Some(index) = raw["index"].as_u64() else {
            return vec![];
        };
        if self.message.is_empty() {
            return vec![];
        }
        if raw["type"] == "content_block_start" {
            let Some(block) = block(&raw["content_block"]) else {
                return vec![];
            };
            if block["kind"] == "tool" {
                if let (Some(id), Some(name)) = (block["id"].as_str(), block["name"].as_str()) {
                    self.tools.insert(id.to_string(), name.to_string());
                }
            }
            return vec![event(
                "assistant.block.started",
                at,
                json!({ "messageId": self.message, "index": index, "block": block }),
            )];
        }
        if raw["type"] != "content_block_delta" {
            return vec![];
        }
        let delta = &raw["delta"];
        match delta["type"].as_str() {
            Some("text_delta") => vec![event(
                "assistant.delta",
                at,
                json!({ "messageId": self.message, "index": index, "kind": "text", "delta": delta["text"].as_str().unwrap_or("") }),
            )],
            Some("thinking_delta") => vec![event(
                "assistant.delta",
                at,
                json!({ "messageId": self.message, "index": index, "kind": "thinking", "delta": delta["thinking"].as_str().unwrap_or("") }),
            )],
            Some("input_json_delta") => vec![event(
                "tool.input.delta",
                at,
                json!({
                    "messageId": self.message,
                    "index": index,
                    "toolId": raw["tool_use_id"].as_str().unwrap_or(""),
                    "delta": delta["partial_json"].as_str().unwrap_or(""),
                }),
            )],
            _ => vec![],
        }
    }

    fn select_message(&mut self, message_id: &str) {
        if self.message != message_id {
            self.message = message_id.to_string();
            self.next_block = 0;
        }
    }

    fn request(&self, value: &Value, at: u64) -> Vec<Value> {
        let request = &value["request"];
        let request_id = value["request_id"].as_str().unwrap_or("");
        if request["subtype"] != "can_use_tool" || request_id.is_empty() {
            return vec![];
        }
        let tool = request["tool_name"].as_str();
        let kind = match tool {
            Some("AskUserQuestion") => "question",
            Some("ExitPlanMode") => "plan",
            _ => "approval",
        };
        vec![event(
            "request.opened",
            at,
            json!({
                "requestId": request_id,
                "kind": kind,
                "toolId": request["tool_use_id"].as_str(),
                "tool": tool,
                "input": request["input"].as_object().cloned().unwrap_or_default(),
            }),
        )]
    }

    fn command_list(&mut self, value: &Value, at: u64) -> Vec<Value> {
        let Some(commands) = value
            .pointer("/response/response/commands")
            .and_then(Value::as_array)
        else {
            return vec![];
        };
        self.commands = commands
            .iter()
            .filter_map(|command| {
                Some(json!({
                    "name": command["name"].as_str()?,
                    "description": command["description"].as_str().unwrap_or(""),
                    "hint": command["argumentHint"].as_str().unwrap_or(""),
                }))
            })
            .collect();
        vec![self.commands_event(at)]
    }

    fn system(&mut self, value: &Value, at: u64) -> Vec<Value> {
        match value["subtype"].as_str() {
            Some("init") => {
                self.terminal = value["terminal_slash_commands"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect();
                vec![self.commands_event(at)]
            }
            Some("status") => vec![event(
                "context.compaction",
                at,
                json!({
                    "state": if value["compact_result"] == "failed" { "failed" } else if value["status"] == "compacting" { "started" } else { "stopped" },
                    "detail": value["compact_error"].as_str().unwrap_or(""),
                }),
            )],
            Some("compact_boundary") => vec![event(
                "context.compacted",
                at,
                json!({
                    "before": value["compact_metadata"]["pre_tokens"].as_u64(),
                    "after": value["compact_metadata"]["post_tokens"].as_u64(),
                }),
            )],
            Some("task_started") => {
                let id = value["task_id"].as_str().unwrap_or("");
                if id.is_empty() {
                    return vec![];
                }
                self.tasks.insert(
                    id.to_string(),
                    json!({
                        "id": id,
                        "description": value["description"].as_str().unwrap_or(""),
                        "toolId": value["tool_use_id"].as_str(),
                    }),
                );
                vec![self.background(at)]
            }
            Some("background_tasks_changed") => {
                let mut next = HashMap::new();
                for raw in value["tasks"].as_array().into_iter().flatten() {
                    let id = raw["task_id"].as_str().unwrap_or("");
                    if id.is_empty() {
                        continue;
                    }
                    next.insert(
                        id.to_string(),
                        self.tasks.get(id).cloned().unwrap_or_else(|| {
                            json!({ "id": id, "description": raw["description"].as_str().unwrap_or(""), "toolId": null })
                        }),
                    );
                }
                self.tasks = next;
                vec![self.background(at)]
            }
            Some("task_notification") => {
                if let Some(id) = value["task_id"].as_str() {
                    self.tasks.remove(id);
                }
                let mut out = vec![self.background(at)];
                let detail = value["summary"].as_str().unwrap_or("").trim();
                if !detail.is_empty() {
                    out.push(event(
                        "system.notice",
                        at,
                        json!({
                            "level": if value["status"] == "completed" { "info" } else { "error" },
                            "code": "background.completed",
                            "detail": detail,
                        }),
                    ));
                }
                out
            }
            _ => vec![],
        }
    }

    fn prometheus(&self, value: &Value, at: u64) -> Vec<Value> {
        let mapped = match value["subtype"].as_str() {
            Some("stderr") => event(
                "system.notice",
                at,
                json!({ "level": "error", "code": "provider.stderr", "detail": value["text"].as_str().unwrap_or("") }),
            ),
            Some("state") => event(
                "session.state",
                at,
                json!({ "state": if value["busy"] == true { "busy" } else { "ready" } }),
            ),
            Some("tokens") => event(
                "context.updated",
                at,
                json!({ "used": value["tokens"].as_u64().unwrap_or(0), "window": null }),
            ),
            Some("session") => event(
                "session.identity",
                at,
                json!({ "providerSession": value["session"].as_str().unwrap_or("") }),
            ),
            Some("usage") => event(
                "usage.updated",
                at,
                json!({ "provider": "codex", "usage": value["usage"] }),
            ),
            _ => return vec![],
        };
        vec![mapped]
    }

    fn commands_event(&self, at: u64) -> Value {
        let commands: Vec<&Value> = self
            .commands
            .iter()
            .filter(|command| {
                command["name"]
                    .as_str()
                    .is_some_and(|name| !self.terminal.contains(name))
            })
            .collect();
        event("commands.updated", at, json!({ "commands": commands }))
    }

    fn background(&self, at: u64) -> Value {
        event(
            "background.changed",
            at,
            json!({ "tasks": self.tasks.values().collect::<Vec<_>>() }),
        )
    }
}

/// Traduz o comando comum para a entrada stream-json do Claude. Durante o
/// rollback, comandos antigos ainda atravessam sem alteração.
pub fn claude_command(frame: &Value, buffer: &str) -> Option<Value> {
    if frame["v"] != 1 {
        return Some(frame.clone());
    }
    match frame["type"].as_str()? {
        "message.send" => Some(json!({
            "type": "user",
            "message": { "role": "user", "content": frame["text"].as_str()? },
        })),
        "turn.interrupt" => Some(json!({
            "type": "control_request",
            "request_id": format!("interrupt-{}", now()),
            "request": { "subtype": "interrupt" },
        })),
        "permission.mode.set" if frame["mode"] == "bypass" => Some(json!({
            "type": "control_request",
            "request_id": format!("permission-{}", now()),
            "request": { "subtype": "set_permission_mode", "mode": "bypassPermissions" },
        })),
        "commands.list" => Some(json!({
            "type": "control_request",
            "request_id": "initialize",
            "request": { "subtype": "initialize" },
        })),
        "request.respond" => {
            let id = frame["requestId"].as_str()?;
            let request = request_in(buffer, id)?;
            let response = &frame["response"];
            let answer = match response["outcome"].as_str()? {
                "allow" => json!({ "behavior": "allow", "updatedInput": request["input"] }),
                "answer" => {
                    let mut input = request["input"].clone();
                    input
                        .as_object_mut()?
                        .insert("answers".into(), response["answers"].clone());
                    json!({ "behavior": "allow", "updatedInput": input })
                }
                "deny" => json!({
                    "behavior": "deny",
                    "message": response["message"].as_str().unwrap_or("Denied"),
                }),
                _ => return None,
            };
            Some(json!({
                "type": "control_response",
                "response": { "subtype": "success", "request_id": id, "response": answer },
            }))
        }
        _ => None,
    }
}

pub fn request_in(buffer: &str, id: &str) -> Option<Value> {
    for line in buffer.lines().rev() {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if value["v"] == 1 && value["type"] == "request.closed" && value["requestId"] == id {
            return None;
        }
        if value["v"] == 1 && value["type"] == "request.opened" && value["requestId"] == id {
            return Some(value);
        }
        if value["type"] == "control_request"
            && value["request_id"] == id
            && value["request"]["subtype"] == "can_use_tool"
        {
            return Some(json!({
                "requestId": id,
                "tool": value["request"]["tool_name"],
                "toolId": value["request"]["tool_use_id"],
                "input": value["request"]["input"],
            }));
        }
    }
    None
}

pub fn event(kind: &str, at: u64, fields: Value) -> Value {
    let mut out = fields.as_object().cloned().unwrap_or_default();
    out.insert("v".into(), json!(1));
    out.insert("type".into(), json!(kind));
    out.insert("at".into(), json!(at));
    Value::Object(out)
}

/// Projeção de compatibilidade gravada ao lado do evento V1 no log do Codex.
/// Versões novas ignoram a linha marcada; uma versão anterior ignora o V1 e
/// ainda consegue reabrir o que aconteceu depois de um rollback do app.
pub fn legacy_mirror(value: &Value) -> Option<Value> {
    let mut legacy = match value["type"].as_str()? {
        "user.message" => {
            let text = value["content"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|part| match part["kind"].as_str() {
                    Some("text") => part["text"].as_str().map(str::to_string),
                    Some("image") => Some("[imagem]".to_string()),
                    Some("file") => Some(format!(
                        "[arquivo: {}]",
                        part["name"].as_str().unwrap_or("")
                    )),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("\n\n");
            json!({ "type": "user", "message": { "role": "user", "content": text }, "ts": value["at"] })
        }
        "assistant.block" => {
            let block = match value["block"]["kind"].as_str()? {
                "text" => json!({ "type": "text", "text": value["block"]["text"] }),
                "thinking" => json!({ "type": "thinking", "thinking": value["block"]["text"] }),
                "tool" => json!({
                    "type": "tool_use",
                    "id": value["block"]["id"],
                    "name": value["block"]["name"],
                    "input": value["block"]["input"],
                }),
                _ => return None,
            };
            json!({
                "type": "assistant",
                "message": { "id": value["messageId"], "role": "assistant", "content": [block] },
                "ts": value["at"],
            })
        }
        "tool.completed" => json!({
            "type": "user",
            "message": { "role": "user", "content": [{
                "type": "tool_result",
                "tool_use_id": value["toolId"],
                "content": value["output"],
                "is_error": value["error"],
            }] },
            "ts": value["at"],
        }),
        "request.opened" => json!({
            "type": "control_request",
            "request_id": value["requestId"],
            "request": {
                "subtype": "can_use_tool",
                "tool_name": value["tool"],
                "tool_use_id": value["toolId"],
                "input": value["input"],
            },
            "ts": value["at"],
        }),
        "turn.completed" => json!({
            "type": "result",
            "subtype": if value["outcome"] == "ok" { "success" } else { "error_during_execution" },
            "is_error": value["outcome"] != "ok",
            "result": value["message"],
            "duration_ms": value["durationMs"],
            "total_cost_usd": value["costUsd"],
            "ts": value["at"],
        }),
        "context.compacted" => json!({
            "type": "system",
            "subtype": "compact_boundary",
            "compact_metadata": { "pre_tokens": value["before"], "post_tokens": value["after"] },
            "ts": value["at"],
        }),
        "background.changed" => {
            let tasks: Vec<Value> = value["tasks"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|task| {
                    json!({
                        "task_id": task["id"],
                        "description": task["description"],
                        "tool_use_id": task["toolId"],
                    })
                })
                .collect();
            json!({ "type": "system", "subtype": "background_tasks_changed", "tasks": tasks, "ts": value["at"] })
        }
        "system.notice" if value["level"] == "error" => json!({
            "type": "prometheus", "subtype": "stderr", "text": value["detail"], "ts": value["at"],
        }),
        "system.notice" => json!({
            "type": "system", "subtype": "task_notification", "status": "completed", "summary": value["detail"], "ts": value["at"],
        }),
        "system.summary" => json!({
            "type": "user", "isCompactSummary": true, "message": { "role": "user", "content": value["text"] }, "ts": value["at"],
        }),
        "context.reported" => json!({
            "type": "assistant",
            "message": { "id": "context", "model": "<synthetic>", "content": [{ "type": "text", "text": value["markdown"] }] },
            "ts": value["at"],
        }),
        _ => return None,
    };
    legacy["prometheusV1Mirror"] = json!(true);
    Some(legacy)
}

pub fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn block(value: &Value) -> Option<Value> {
    match value["type"].as_str()? {
        "text" => Some(json!({ "kind": "text", "text": value["text"].as_str().unwrap_or("") })),
        "thinking" => {
            Some(json!({ "kind": "thinking", "text": value["thinking"].as_str().unwrap_or("") }))
        }
        "tool_use" => Some(json!({
            "kind": "tool",
            "id": value["id"].as_str().unwrap_or(""),
            "name": value["name"].as_str().unwrap_or(""),
            "input": value["input"],
        })),
        _ => None,
    }
}

fn result_text(value: &Value) -> String {
    if let Some(text) = value.as_str() {
        return text.to_string();
    }
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|part| match part["type"].as_str() {
            Some("text") => part["text"].as_str().map(str::to_string),
            Some("image") => Some("[imagem]".to_string()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn turn_message(value: &Value) -> String {
    let errors = value["errors"]
        .as_array()
        .map(|errors| {
            errors
                .iter()
                .filter_map(|error| error.as_str().map(str::to_string))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if !errors.is_empty() {
        errors.join("\n")
    } else if value["is_error"] == true {
        value["result"].as_str().unwrap_or("").to_string()
    } else {
        String::new()
    }
}

fn between<'a>(text: &'a str, start: &str, end: &str) -> Option<&'a str> {
    let rest = text.split_once(start)?.1;
    Some(rest.split_once(end)?.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normaliza_stream_e_bloco_final() {
        let mut adapter = LegacyAdapter::default();
        let started = adapter.translate(&json!({
            "type": "stream_event",
            "ts": 10,
            "event": { "type": "message_start", "message": { "id": "m1" } },
        }));
        assert_eq!(started[0]["type"], "assistant.started");
        let final_block = adapter.translate(&json!({
            "type": "assistant",
            "ts": 11,
            "message": { "id": "m1", "content": [{ "type": "text", "text": "oi" }] },
        }));
        assert_eq!(final_block[0]["type"], "assistant.block");
        assert_eq!(final_block[0]["index"], 0);
        assert_eq!(final_block[0]["block"]["text"], "oi");
    }

    #[test]
    fn comando_de_resposta_reusa_o_input_do_pedido() {
        let buffer = event(
            "request.opened",
            1,
            json!({
                "requestId": "r1",
                "kind": "approval",
                "toolId": "t1",
                "tool": "Bash",
                "input": { "command": "rm arquivo" },
            }),
        )
        .to_string();
        let command = json!({
            "v": 1,
            "type": "request.respond",
            "requestId": "r1",
            "response": { "outcome": "allow" },
        });
        let provider = claude_command(&command, &buffer).unwrap();
        assert_eq!(
            provider.pointer("/response/response/updatedInput/command"),
            Some(&json!("rm arquivo"))
        );

        let closed = format!(
            "{}\n{}",
            buffer,
            event(
                "request.closed",
                2,
                json!({ "requestId": "r1", "outcome": "allowed" })
            )
        );
        assert!(claude_command(&command, &closed).is_none());
    }

    #[test]
    fn evento_desconhecido_nao_vira_conversa() {
        assert!(LegacyAdapter::default()
            .translate(&json!({ "type": "provider/new-event" }))
            .is_empty());
    }

    #[test]
    fn normaliza_pedido_background_e_compactacao() {
        let mut adapter = LegacyAdapter::default();
        let request = adapter.translate(&json!({
            "type": "control_request",
            "ts": 1,
            "request_id": "r1",
            "request": { "subtype": "can_use_tool", "tool_name": "Bash", "tool_use_id": "t1", "input": { "command": "ls" } },
        }));
        assert_eq!(request[0]["type"], "request.opened");
        assert_eq!(request[0]["kind"], "approval");

        let background = adapter.translate(&json!({
            "type": "system",
            "subtype": "task_started",
            "ts": 2,
            "task_id": "bg1",
            "tool_use_id": "t1",
            "description": "mapear",
        }));
        assert_eq!(background[0]["type"], "background.changed");
        assert_eq!(background[0]["tasks"][0]["toolId"], "t1");

        let compact = adapter.translate(&json!({
            "type": "system",
            "subtype": "compact_boundary",
            "ts": 3,
            "compact_metadata": { "pre_tokens": 100, "post_tokens": 20 },
        }));
        assert_eq!(compact[0]["type"], "context.compacted");
        assert_eq!(compact[0]["before"], 100);
        assert_eq!(compact[0]["after"], 20);
    }

    #[test]
    fn espelho_de_rollback_e_legivel_por_versao_antiga_e_ignorado_pela_nova() {
        let canonical = event(
            "assistant.block",
            1,
            json!({
                "messageId": "m1",
                "index": 0,
                "block": { "kind": "text", "text": "olá" },
            }),
        );
        let mirror = legacy_mirror(&canonical).unwrap();
        assert_eq!(mirror["type"], "assistant");
        assert_eq!(mirror["message"]["content"][0]["text"], "olá");
        assert_eq!(mirror["prometheusV1Mirror"], true);
        assert!(LegacyAdapter::default().translate(&mirror).is_empty());
    }
}
