//! Discover installed CLIs and their account-specific model catalogs. The UI shares one
//! conversation model; provider adapters translate process protocols into canonical events. Query
//! each CLI's own catalog so new models appear without an app release: Codex uses
//! models_cache.json, while Claude uses list_models.

use crate::paths;
use crate::state::ProviderId;
use serde_json::Value;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;

/// Discover both CLIs through one login shell so user-defined PATH locations are respected without
/// paying the shell startup cost twice.
fn installed() -> (bool, bool) {
    let out = std::process::Command::new("sh")
        .args([
            "-lc",
            "command -v claude && echo TEM_CLAUDE; command -v codex && echo TEM_CODEX; true",
        ])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default();
    (out.contains("TEM_CLAUDE"), out.contains("TEM_CODEX"))
}

/// The catalog belongs to the selected account. Selection failures must not silently query the
/// terminal account.
fn home() -> Option<PathBuf> {
    crate::accounts::active(ProviderId::Codex)
        .ok()
        .map(|profile| profile.home)
}

/// A model as exposed to the launcher.
#[derive(serde::Serialize, Clone, Debug, PartialEq, Eq)]
pub struct Model {
    pub id: String,
    pub label: String,
    /// Supported effort levels prevent the launcher from offering values the CLI rejects.
    pub efforts: Vec<String>,
}

/// Provider-independent features exposed to the app. Serde maps contract field names to camelCase.
#[derive(serde::Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentCapabilities {
    pub initial_plan_mode: bool,
    pub workspace_mcp_selection: bool,
    pub workspace_plugin_selection: bool,
    pub resume: bool,
    pub compact: bool,
    pub context_report: bool,
    pub approvals: bool,
    pub user_questions: bool,
    pub attachments: bool,
}

/// Return both providers even when unavailable, distinguishing missing installations from
/// temporarily empty catalogs.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDescriptor {
    pub id: ProviderId,
    pub label: String,
    pub installed: bool,
    pub models: Vec<Model>,
    pub capabilities: AgentCapabilities,
    pub auth_methods: Vec<AuthMethod>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<String>,
    pub account_notice: Option<String>,
}

#[derive(serde::Serialize)]
pub struct AuthMethod {
    pub id: String,
    pub kind: String,
    pub label: String,
}

#[derive(serde::Serialize)]
pub struct Agents {
    pub providers: Vec<AgentDescriptor>,
}

fn capabilities(id: ProviderId) -> AgentCapabilities {
    let common = AgentCapabilities {
        initial_plan_mode: false,
        workspace_mcp_selection: true,
        workspace_plugin_selection: true,
        resume: true,
        compact: true,
        context_report: true,
        approvals: true,
        user_questions: true,
        // The app injects local file paths into messages. Both runtimes can read the same worktree;
        // no provider upload or binary payload is involved.
        attachments: true,
    };
    match id {
        ProviderId::Claude => AgentCapabilities {
            initial_plan_mode: true,
            ..common
        },
        ProviderId::Codex => common,
        ProviderId::Antigravity | ProviderId::RetiredGemini => AgentCapabilities {
            initial_plan_mode: false,
            approvals: false,
            workspace_mcp_selection: false,
            workspace_plugin_selection: false,
            compact: false,
            context_report: false,
            user_questions: false,
            ..common
        },
    }
}

fn descriptor(id: ProviderId, installed: bool, models: Vec<Model>) -> AgentDescriptor {
    AgentDescriptor {
        id,
        label: match id {
            ProviderId::Claude => "Claude".into(),
            ProviderId::Codex => "Codex".into(),
            ProviderId::Antigravity => "Antigravity".into(),
            ProviderId::RetiredGemini => "Gemini CLI".into(),
        },
        installed,
        models,
        capabilities: capabilities(id),
        unavailable_reason: (id == ProviderId::Antigravity && !installed)
            .then(|| crate::i18n::t("err.antigravity.version")),
        account_notice: (id == ProviderId::Antigravity)
            .then(|| crate::i18n::t("account.external.notice")),
        auth_methods: match id {
            ProviderId::RetiredGemini => vec![],
            ProviderId::Antigravity => vec![AuthMethod {
                id: "external".into(),
                kind: "external".into(),
                label: crate::i18n::t("account.external.attach"),
            }],
            other => vec![AuthMethod {
                id: "browser".into(),
                kind: "browser".into(),
                label: if other == ProviderId::Claude {
                    "Claude"
                } else {
                    "Codex"
                }
                .into(),
            }],
        },
    }
}

/// Discover CLIs and the selected account's catalog. The UI queries again after account changes.
#[tauri::command]
pub fn agents() -> Agents {
    let (claude, codex) = installed();
    Agents {
        providers: vec![
            descriptor(
                ProviderId::Antigravity,
                crate::antigravity::installed(),
                crate::antigravity::models(),
            ),
            descriptor(ProviderId::Claude, claude, vec![]),
            descriptor(
                ProviderId::Codex,
                codex,
                if codex { codex_models() } else { vec![] },
            ),
        ],
    }
}

/// Query Claude's list_models control request for the same catalog shown by /model. Keep this slow
/// subprocess separate from basic provider discovery. An empty result allows the launcher to use
/// its existing fallback for old CLIs or missing responses.
#[tauri::command]
pub async fn claude_models() -> Vec<Model> {
    tauri::async_runtime::spawn_blocking(ask_claude_models)
        .await
        .unwrap_or_default()
}

fn ask_claude_models() -> Vec<Model> {
    let mut cmd = Command::new("claude");
    // Catalog discovery must not persist a session or trigger user hooks on every window opening.
    cmd.args([
        "-p",
        "--verbose",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--no-session-persistence",
        "--settings",
        r#"{"hooks":{}}"#,
    ])
    .current_dir(paths::home())
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::null());
    // Remove inherited CLAUDE_* settings that change nested CLI behavior, while retaining the rest
    // of the environment, including PATH.
    cmd.env_clear();
    for (k, v) in std::env::vars() {
        if !k.starts_with("CLAUDE") {
            cmd.env(k, v);
        }
    }
    let Ok(profile) = crate::accounts::active(ProviderId::Claude) else {
        return vec![];
    };
    if profile.prepare().is_err() {
        return vec![];
    }
    if profile.apply(&mut cmd).is_err() {
        return vec![];
    }
    let Ok(mut child) = cmd.spawn() else {
        return vec![];
    };
    let (Some(mut stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
        let _ = child.kill();
        return vec![];
    };
    let asked = stdin
        .write_all(
            b"{\"type\":\"control_request\",\"request_id\":\"models\",\"request\":{\"subtype\":\"list_models\"}}\n",
        )
        .is_ok();
    // Keep stdin open until the response arrives; closing it ends the session.
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if line.contains("\"control_response\"") {
                let _ = tx.send(parse_claude_models(&line));
                return;
            }
        }
        let _ = tx.send(vec![]);
    });
    let models = if asked {
        rx.recv_timeout(Duration::from_secs(20)).unwrap_or_default()
    } else {
        vec![]
    };
    let _ = child.kill();
    let _ = child.wait();
    models
}

/// Exclude the unnamed default entry and disabled model advertisements from selectable catalog
/// entries.
fn parse_claude_models(line: &str) -> Vec<Model> {
    let Ok(v) = serde_json::from_str::<Value>(line) else {
        return vec![];
    };
    v["response"]["response"]["models"]
        .as_array()
        .map(|models| {
            models
                .iter()
                .filter(|m| m["value"].as_str() != Some("default"))
                .filter(|m| m["disabled"].as_bool() != Some(true))
                .filter_map(|m| {
                    let id = m["value"].as_str()?.to_string();
                    let label = m["displayName"].as_str().unwrap_or(&id).to_string();
                    let efforts = m["supportedEffortLevels"]
                        .as_array()
                        .map(|ls| {
                            ls.iter()
                                .filter_map(Value::as_str)
                                .map(str::to_string)
                                .collect()
                        })
                        .unwrap_or_default();
                    Some(Model { id, label, efforts })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Filter Codex's catalog by its own visibility flags. An unavailable CLI or absent cache before
/// first login returns an empty list.
fn codex_models() -> Vec<Model> {
    let Some(home) = home() else {
        return vec![];
    };
    let Ok(raw) = std::fs::read_to_string(home.join("models_cache.json")) else {
        return vec![];
    };
    let Ok(cache) = serde_json::from_str::<Value>(&raw) else {
        return vec![];
    };
    cache["models"]
        .as_array()
        .map(|models| {
            models
                .iter()
                .filter(|m| m["visibility"].as_str() == Some("list"))
                .filter_map(|m| {
                    let id = m["slug"].as_str()?.to_string();
                    let label = m["display_name"].as_str().unwrap_or(&id).to_string();
                    let efforts = m["supported_reasoning_levels"]
                        .as_array()
                        .map(|ls| {
                            ls.iter()
                                .filter_map(|l| l["effort"].as_str())
                                .map(str::to_string)
                                .collect()
                        })
                        .unwrap_or_default();
                    Some(Model { id, label, efforts })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Use the model with the largest priority value for cheap workspace naming; the catalog orders
/// flagship models before smaller ones. Without a catalog, fall back to the workspace model.
pub fn codex_namer_model() -> String {
    let Some(home) = home() else {
        return String::new();
    };
    let Ok(raw) = std::fs::read_to_string(home.join("models_cache.json")) else {
        return String::new();
    };
    let Ok(cache) = serde_json::from_str::<Value>(&raw) else {
        return String::new();
    };
    cache["models"]
        .as_array()
        .and_then(|models| {
            models
                .iter()
                .filter(|m| m["visibility"].as_str() == Some("list"))
                .max_by_key(|m| m["priority"].as_u64().unwrap_or(0))
                .and_then(|m| m["slug"].as_str())
                .map(str::to_string)
        })
        .unwrap_or_default()
}

/// Map the UI's top effort level ultracode to Codex's native ultra value.
pub fn effort(level: &str) -> &str {
    match level.trim() {
        "ultracode" => "ultra",
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ultracode_vira_ultra() {
        assert_eq!(effort("ultracode"), "ultra");
        assert_eq!(effort("max"), "max");
    }

    // A shortened Claude 2.1.251 response excludes Default and disabled advertisements while
    // preserving usable models.
    #[test]
    fn le_o_catalogo_do_claude() {
        let line = r#"{"type":"control_response","response":{"subtype":"success","request_id":"models","response":{"models":[
            {"value":"default","resolvedModel":"claude-opus-5[1m]","displayName":"Default (recommended)","supportsEffort":true,"supportedEffortLevels":["low","medium","high","xhigh","max"]},
            {"value":"opus[1m]","resolvedModel":"claude-opus-5[1m]","displayName":"Opus (1M context)","supportsEffort":true,"supportedEffortLevels":["low","medium","high","xhigh","max"]},
            {"value":"haiku","resolvedModel":"claude-haiku-4-5","displayName":"Haiku"},
            {"value":"cc-update-required-1","resolvedModel":"cc-update-required-1","displayName":"Fable 5.1 (disabled)","disabled":true}
        ]}}}"#;
        let models = parse_claude_models(line);
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "opus[1m]");
        assert_eq!(models[0].label, "Opus (1M context)");
        assert_eq!(models[0].efforts, ["low", "medium", "high", "xhigh", "max"]);
        assert_eq!(models[1].id, "haiku");
        assert!(models[1].efforts.is_empty());
    }

    /// Query a real Claude installation. This ignored test needs the CLI and takes seconds: cargo
    /// test -- --ignored pergunta.
    #[test]
    #[ignore]
    fn pergunta_o_catalogo_de_verdade() {
        let models = ask_claude_models();
        for m in &models {
            println!("{} = {} [{}]", m.id, m.label, m.efforts.join(","));
        }
        assert!(!models.is_empty());
    }

    #[test]
    fn resposta_estranha_e_catalogo_vazio() {
        assert!(parse_claude_models("nem json").is_empty());
        assert!(parse_claude_models(
            r#"{"type":"control_response","response":{"subtype":"error"}}"#
        )
        .is_empty());
    }

    #[test]
    fn capacidades_sao_do_descriptor_e_nao_da_tela() {
        let claude = descriptor(ProviderId::Claude, true, vec![]);
        let codex = descriptor(ProviderId::Codex, true, vec![]);

        assert!(claude.capabilities.initial_plan_mode);
        assert!(claude.capabilities.workspace_plugin_selection);
        assert!(!codex.capabilities.initial_plan_mode);
        assert!(codex.capabilities.workspace_plugin_selection);
        assert!(codex.capabilities.workspace_mcp_selection);
        assert!(codex.capabilities.resume);

        let json = serde_json::to_value(codex).unwrap();
        assert_eq!(json["id"], "codex");
        assert_eq!(json["capabilities"]["initialPlanMode"], false);
        assert_eq!(json["capabilities"]["workspaceMcpSelection"], true);
    }
    #[test]
    fn antigravity_advertises_only_supported_controls_and_external_account() {
        let g = descriptor(ProviderId::Antigravity, false, vec![]);
        assert!(!g.capabilities.initial_plan_mode);
        assert!(g.capabilities.resume);
        assert!(!g.capabilities.approvals);
        assert!(!g.capabilities.compact);
        assert!(!g.capabilities.context_report);
        assert!(!g.capabilities.user_questions);
        assert!(!g.capabilities.workspace_mcp_selection);
        assert!(!g.capabilities.workspace_plugin_selection);
        let v = serde_json::to_value(g).unwrap();
        assert_eq!(v["authMethods"][0]["id"], "external");
        assert_eq!(v["authMethods"].as_array().unwrap().len(), 1);
        assert!(v["unavailableReason"]
            .as_str()
            .unwrap()
            .contains("err.antigravity.version"));
        assert_eq!(
            serde_json::to_value(descriptor(ProviderId::Claude, true, vec![])).unwrap()
                ["authMethods"][0]["id"],
            "browser"
        );
    }
}
