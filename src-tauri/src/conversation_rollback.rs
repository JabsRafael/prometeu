//! Projeção temporária de rollback do contrato canônico para stream-json.
//!
//! O log administrado pelo Prometheus para o Codex grava esta projeção ao lado
//! do evento V1 para que uma versão anterior consiga reabrir a conversa. A
//! exceção é explícita e removível; o contrato canônico não depende dela.

use serde_json::{json, Value};

/// Projeção de compatibilidade gravada ao lado do evento V1 no log do Codex.
/// Versões novas ignoram a linha marcada; uma versão anterior ignora o V1 e
/// ainda consegue reabrir o que aconteceu depois de um rollback do app.
pub fn mirror(value: &Value) -> Option<Value> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::conversation::event;

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
        let mirror = mirror(&canonical).unwrap();
        assert_eq!(mirror["type"], "assistant");
        assert_eq!(mirror["message"]["content"][0]["text"], "olá");
        assert_eq!(mirror["prometheusV1Mirror"], true);
        assert!(crate::claude::Adapter::default()
            .translate(&mirror)
            .is_empty());
    }
}
