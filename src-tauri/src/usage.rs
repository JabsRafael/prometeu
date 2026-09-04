//! Quanto da cota já foi.
//!
//! O número chega por dois caminhos. Enquanto alguém conversa, os CLIs contam
//! sozinhos e o app escuta: o Claude Code manda um `rate_limit_event` a cada
//! resposta, com a janela de 5 horas, a da semana e, quando existe, a semanal
//! do Fable (`utilization` de 0 a 1); o `codex app-server` manda
//! `account/rateLimits/updated` quando muda, e responde
//! `account/rateLimits/read` assim que a thread abre.
//!
//! Só que sem conversa não chega nada, e a barra passaria a manhã com o número
//! de ontem. Por isso o `watch` também pergunta direto, de tempos em tempos,
//! aos mesmos servidores que os CLIs consultam — com as credenciais que os
//! próprios CLIs guardam nesta máquina (Keychain do Claude Code,
//! `~/.codex/auth.json`). São endpoints internos deles, não API pública: se um
//! dia mudarem, o poll falha calado e a escuta continua valendo.
//!
//! O número é da conta, não da sessão: qualquer aba que responda atualiza a
//! barra inteira. Por isso o estado é um só — e por isso ele fica no disco,
//! porque abrir o app de manhã sem barra nenhuma até alguém falar com um
//! agente pareceria defeito.

use crate::lock::lock;
use crate::paths;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

/// Uma janela de cota: quanto já foi (0 a 100) e quando ela zera.
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct Window {
    /// `session` são as 5 horas, `weekly` são os 7 dias, `fable` é a janela
    /// semanal própria do Fable. Quem traduz para a tela é o front.
    pub kind: String,
    pub pct: f64,
    /// Unix, em segundos. É o que vira "zera em 3h 14m".
    pub resets: u64,
    /// Bucket estável da cota. Ausente é o formato antigo, em que cada agente
    /// tinha uma única cota. `general` é a cota comum; outros ids separam
    /// limites próprios de modelo ou feature sem levar o payload do provider
    /// até o frontend.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    /// Nome que o provider dá ao bucket, quando há um. É dado externo e a UI
    /// escapa antes de mostrar; `scope` continua sendo a identidade usada para
    /// mesclar updates esparsos.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

/// O que se sabe de um agente, e de quando.
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct Agent {
    pub windows: Vec<Window>,
    /// Quando este número mudou pela última vez (unix, em segundos). É o
    /// "atualizado há 4 min" do painel: leitura repetida não conta como
    /// novidade, e é por isso que ela também não regrava o arquivo.
    pub at: u64,
}

/// Por agente: `claude`, `codex`.
pub type Usage = BTreeMap<String, Agent>;

fn state() -> &'static Mutex<Usage> {
    static STATE: OnceLock<Mutex<Usage>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(read()))
}

/// O que a tela pede ao abrir, antes de qualquer agente responder.
#[tauri::command]
pub fn usage() -> Usage {
    lock(state()).clone()
}

/// O `rate_limit_info` de uma linha `rate_limit_event`.
pub fn claude(app: &AppHandle, info: &Value) {
    note(app, "claude", claude_windows(info));
}

/// O `rateLimits` do `account/rateLimits/{read,updated}`.
pub fn codex(app: &AppHandle, limits: &Value) {
    let (windows, complete) = codex_windows(limits);
    if complete {
        note(app, "codex", windows);
    } else {
        note_codex_update(app, windows);
    }
}

/// `utilization` do Claude Code vai de 0 a 1 — os 0,5 da semana são 50%.
fn claude_windows(info: &Value) -> Vec<Window> {
    let windows = &info["unifiedWindows"];
    [
        ("five_hour", "session"),
        ("seven_day", "weekly"),
        // O nome do protocolo diz "overage included", mas esta é a cota
        // semanal própria do Fable nos planos em que ele vem incluído.
        ("seven_day_overage_included", "fable"),
    ]
    .iter()
    .filter_map(|(from, kind)| {
        let window = &windows[from];
        Some(Window {
            kind: (*kind).to_string(),
            pct: (window["utilization"].as_f64()? * 100.0).clamp(0.0, 100.0),
            resets: window["resetsAt"].as_u64()?,
            scope: None,
            label: None,
        })
    })
    .collect()
}

/// O snapshot completo novo traz um mapa por `limitId`; versões anteriores
/// traziam só `rateLimits`. Uma notificação continua sendo um único snapshot
/// esparso, por isso o booleano diz se pode substituir o estado inteiro.
fn codex_windows(value: &Value) -> (Vec<Window>, bool) {
    if value.get("rateLimits").is_none() {
        return (codex_snapshot_windows(value, None), false);
    }

    let mut windows = vec![];
    if let Some(by_id) = value["rateLimitsByLimitId"].as_object() {
        for (id, snapshot) in by_id {
            windows.extend(codex_snapshot_windows(snapshot, Some(id)));
        }
    }
    // O mapa é a visão autoritativa. Se o CLI antigo não o mandar, cai para o
    // bucket histórico em vez de duplicar a mesma cota.
    if windows.is_empty() {
        windows.extend(codex_snapshot_windows(&value["rateLimits"], None));
    }
    (windows, true)
}

fn codex_snapshot_windows(snapshot: &Value, map_id: Option<&String>) -> Vec<Window> {
    let id = snapshot["limitId"].as_str().or(map_id.map(String::as_str));
    let scope = match id {
        None | Some("codex") => "general".to_string(),
        Some(id) => id.to_string(),
    };
    let label = snapshot["limitName"].as_str().map(str::to_string);
    [("primary", "session"), ("secondary", "weekly")]
        .iter()
        .filter_map(|(from, fallback)| {
            let window = &snapshot[from];
            Some(Window {
                kind: codex_kind(
                    window["windowDurationMins"].as_u64().map(|mins| mins * 60),
                    fallback,
                ),
                pct: window["usedPercent"].as_f64()?.clamp(0.0, 100.0),
                resets: window["resetsAt"].as_u64()?,
                scope: Some(scope.clone()),
                label: label.clone(),
            })
        })
        .collect()
}

fn codex_kind(seconds: Option<u64>, fallback: &str) -> String {
    match seconds {
        Some(18_000) => "session".to_string(),
        Some(604_800) => "weekly".to_string(),
        Some(seconds) => format!("duration:{seconds}"),
        None => fallback.to_string(),
    }
}

/* ---------- o poll ---------- */

/// De quanto em quanto tempo perguntar. Um minuto acompanha o reset das
/// janelas sem pesar em ninguém: são dois GETs pequenos.
const POLL: std::time::Duration = std::time::Duration::from_secs(60);

/// A thread que pergunta. Uma só, do começo do app ao fim, e fora do tokio de
/// propósito: o `reqwest::blocking` não pode rodar numa worker do runtime
/// (ver `linear::watch`). A primeira leitura sai já no boot — é ela que troca
/// o número de ontem pelo de agora sem esperar ninguém conversar.
pub fn watch(app: AppHandle) {
    std::thread::spawn(move || loop {
        if let Some(info) = fetch_claude() {
            note(&app, "claude", claude_api_windows(&info));
        }
        if let Some(reply) = fetch_codex() {
            note(&app, "codex", codex_api_windows(&reply));
        }
        std::thread::sleep(POLL);
    });
}

/// O endpoint que o próprio Claude Code consulta para o `/usage` dele. Sem
/// credencial ou com token vencido não há o que perguntar: fica a última
/// leitura, e o próximo turno de conversa corrige.
fn fetch_claude() -> Option<Value> {
    reqwest::blocking::Client::new()
        .get("https://api.anthropic.com/api/oauth/usage")
        .bearer_auth(claude_token()?)
        .header("anthropic-beta", "oauth-2025-04-20")
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .ok()?
        .error_for_status()
        .ok()?
        .json()
        .ok()
}

/// O token OAuth do Claude Code: no macOS ele mora no Keychain, em outros
/// sistemas num arquivo. O arquivo vem primeiro por ser mais barato; o
/// Keychain responde ao `security` sem perguntar nada porque foi o próprio
/// `security` que gravou o item.
fn claude_token() -> Option<String> {
    let body = std::fs::read_to_string(paths::home().join(".claude/.credentials.json"))
        .ok()
        .or_else(keychain)?;
    let creds: Value = serde_json::from_str(&body).ok()?;
    Some(creds["claudeAiOauth"]["accessToken"].as_str()?.to_string())
}

fn keychain() -> Option<String> {
    let out = std::process::Command::new("security")
        .args([
            "find-generic-password",
            "-s",
            "Claude Code-credentials",
            "-w",
        ])
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// O endpoint que informa o `/status` do Codex. O User-Agent é o do CLI:
/// sem ele o Cloudflare devolve a página de desafio em vez do JSON.
fn fetch_codex() -> Option<Value> {
    let (token, account) = codex_auth()?;
    reqwest::blocking::Client::new()
        .get("https://chatgpt.com/backend-api/wham/usage")
        .bearer_auth(token)
        .header("chatgpt-account-id", account)
        .header("User-Agent", "codex_cli_rs")
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .ok()?
        .error_for_status()
        .ok()?
        .json()
        .ok()
}

fn codex_auth() -> Option<(String, String)> {
    let body = std::fs::read_to_string(paths::home().join(".codex/auth.json")).ok()?;
    let auth: Value = serde_json::from_str(&body).ok()?;
    let tokens = &auth["tokens"];
    Some((
        tokens["access_token"].as_str()?.to_string(),
        tokens["account_id"].as_str()?.to_string(),
    ))
}

/// O `limits` da resposta do endpoint do Claude. É outro formato: `percent`
/// já de 0 a 100, reset em RFC 3339, e a janela do Fable aparece como a
/// semanal com escopo de modelo.
fn claude_api_windows(info: &Value) -> Vec<Window> {
    info["limits"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|limit| {
            let kind = match limit["kind"].as_str()? {
                "session" => "session",
                "weekly_all" => "weekly",
                "weekly_scoped" => "fable",
                _ => return None,
            };
            Some(Window {
                kind: kind.to_string(),
                pct: limit["percent"].as_f64()?.clamp(0.0, 100.0),
                resets: rfc3339(limit["resets_at"].as_str()?)?,
                scope: None,
                label: None,
            })
        })
        .collect()
}

/// O endpoint do Codex separa a cota comum, limites extras por modelo/feature
/// e revisão de código. Cada janela declara a duração; `primary` deixou de
/// significar necessariamente 5 horas em planos novos.
fn codex_api_windows(reply: &Value) -> Vec<Window> {
    let mut windows = codex_api_bucket(&reply["rate_limit"], "general", None);
    if let Some(additional) = reply["additional_rate_limits"].as_array() {
        for limit in additional {
            let id = limit["metered_feature"]
                .as_str()
                .or(limit["normal_model_slug"].as_str())
                .unwrap_or("additional");
            let label = limit["limit_name"].as_str();
            windows.extend(codex_api_bucket(&limit["rate_limit"], id, label));
        }
    }
    if !reply["code_review_rate_limit"].is_null() {
        let review = &reply["code_review_rate_limit"];
        let rate = review.get("rate_limit").unwrap_or(review);
        windows.extend(codex_api_bucket(rate, "code_review", None));
    }
    windows
}

fn codex_api_bucket(rate: &Value, scope: &str, label: Option<&str>) -> Vec<Window> {
    [
        ("primary_window", "session"),
        ("secondary_window", "weekly"),
    ]
    .iter()
    .filter_map(|(from, fallback)| {
        let window = &rate[from];
        Some(Window {
            kind: codex_kind(window["limit_window_seconds"].as_u64(), fallback),
            pct: window["used_percent"].as_f64()?.clamp(0.0, 100.0),
            resets: window["reset_at"].as_u64()?,
            scope: Some(scope.to_string()),
            label: label.map(str::to_string),
        })
    })
    .collect()
}

/// "2026-09-02T05:10:00.504892+00:00" → unix, em segundos. Só o que o
/// endpoint manda — data, hora, fração ignorada e um offset (ou `Z`) — para
/// não trazer um crate de datas por causa de um campo.
fn rfc3339(text: &str) -> Option<u64> {
    let (date, rest) = text.split_once('T')?;
    let mut ymd = date.splitn(3, '-').map(|part| part.parse::<i64>().ok());
    let (y, m, d) = (ymd.next()??, ymd.next()??, ymd.next()??);
    let at = rest.find(['Z', '+', '-'])?;
    let (clock, zone) = rest.split_at(at);
    let mut hms = clock
        .splitn(3, ':')
        .map(|part| part.split('.').next()?.parse::<i64>().ok());
    let (h, min, s) = (hms.next()??, hms.next()??, hms.next()??);
    let offset = match zone {
        "Z" | "z" => 0,
        _ => {
            let (oh, om) = zone[1..].split_once(':')?;
            let secs = oh.parse::<i64>().ok()? * 3600 + om.parse::<i64>().ok()? * 60;
            if zone.starts_with('-') {
                -secs
            } else {
                secs
            }
        }
    };
    let unix = days(y, m, d) * 86400 + h * 3600 + min * 60 + s - offset;
    u64::try_from(unix).ok()
}

/// Dias entre 1970-01-01 e a data, pelo calendário civil (algoritmo de
/// Howard Hinnant, `days_from_civil`).
fn days(y: i64, m: i64, d: i64) -> i64 {
    let y = y - i64::from(m <= 2);
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// Guarda o que mudou e avisa a tela. Leitura idêntica à anterior não é
/// novidade: não regrava o disco (o `rate_limit_event` chega a cada pedido ao
/// modelo, várias vezes por turno) e não mexe no relógio do painel.
fn note(app: &AppHandle, agent: &str, windows: Vec<Window>) {
    if windows.is_empty() {
        return;
    }
    let mut all = lock(state());
    if all.get(agent).is_some_and(|old| old.windows == windows) {
        return;
    }
    all.insert(agent.to_string(), Agent { windows, at: now() });
    let snapshot = all.clone();
    drop(all);
    write(&snapshot);
    let _ = app.emit("usage", &snapshot);
}

/// A notificação do app-server atualiza um bucket por vez. Preserva os outros
/// buckets e, dentro do mesmo bucket, a janela que não veio neste update.
/// Campos de apresentação ausentes também herdam o snapshot completo.
fn merge_codex(old: &[Window], mut updates: Vec<Window>) -> Vec<Window> {
    if updates.is_empty() {
        return old.to_vec();
    }
    // Um Codex antigo não dá identidade ao bucket. Nesse formato não há como
    // distinguir update esparso de snapshot; mantém a semântica antiga.
    if updates.iter().any(|window| window.scope.is_none()) {
        return updates;
    }
    for update in &mut updates {
        if update.label.is_none() {
            update.label = old
                .iter()
                .find(|window| same_scope(window, update))
                .and_then(|window| window.label.clone());
        }
    }
    let mut merged: Vec<Window> = old
        .iter()
        .filter(|window| {
            !updates
                .iter()
                .any(|update| same_scope(update, window) && update.kind == window.kind)
        })
        .cloned()
        .collect();
    merged.extend(updates);
    merged.sort_by_key(|window| {
        old.iter()
            .position(|known| same_scope(known, window) && known.kind == window.kind)
            .unwrap_or(old.len())
    });
    merged
}

fn same_scope(a: &Window, b: &Window) -> bool {
    a.scope.as_deref().unwrap_or("general") == b.scope.as_deref().unwrap_or("general")
}

fn note_codex_update(app: &AppHandle, windows: Vec<Window>) {
    if windows.is_empty() {
        return;
    }
    let current = lock(state())
        .get("codex")
        .map(|agent| agent.windows.clone())
        .unwrap_or_default();
    note(app, "codex", merge_codex(&current, windows));
}

fn path() -> std::path::PathBuf {
    paths::root().join("usage.json")
}

fn read() -> Usage {
    std::fs::read_to_string(path())
        .ok()
        .and_then(|body| serde_json::from_str(&body).ok())
        .unwrap_or_default()
}

/// Falhar aqui custa a barra vazia no próximo boot, e nada mais: a cota do
/// disco não é a cota de verdade.
fn write(usage: &Usage) {
    let Ok(json) = serde_json::to_string(usage) else {
        return;
    };
    if let Err(error) = paths::write_private(&path(), &json) {
        eprintln!("não gravei usage.json: {error}");
    }
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn claude_traduz_as_janelas_que_vieram() {
        let info = json!({
            "status": "allowed",
            "unifiedWindows": {
                "five_hour": { "utilization": 0.22, "resetsAt": 1788238200u64 },
                "seven_day": { "utilization": 0.5, "resetsAt": 1788501600u64 },
                "seven_day_overage_included": {
                    "utilization": 0.72,
                    "resetsAt": 1788501600u64
                }
            }
        });
        let windows = claude_windows(&info);
        assert_eq!(windows.len(), 3);
        assert_eq!(windows[0].kind, "session");
        // 0,22 é 22% — não 0,22%.
        assert!((windows[0].pct - 22.0).abs() < 0.001);
        assert_eq!(windows[1].kind, "weekly");
        assert_eq!(windows[1].resets, 1788501600);
        assert_eq!(windows[2].kind, "fable");
        assert!((windows[2].pct - 72.0).abs() < 0.001);
    }

    #[test]
    fn claude_sem_janela_nenhuma_nao_inventa() {
        assert!(claude_windows(&json!({ "status": "allowed" })).is_empty());
    }

    #[test]
    fn poll_do_claude_traduz_os_limits() {
        let info = json!({
            "limits": [
                { "kind": "session", "percent": 26, "resets_at": "2026-09-02T05:10:00.504892+00:00" },
                { "kind": "weekly_all", "percent": 7, "resets_at": "2026-09-04T06:00:00+00:00" },
                { "kind": "weekly_scoped", "percent": 4, "resets_at": "2026-09-04T06:00:00Z",
                  "scope": { "model": { "display_name": "Fable" } } },
                { "kind": "outra_coisa", "percent": 1, "resets_at": "2026-09-04T06:00:00Z" }
            ]
        });
        let windows = claude_api_windows(&info);
        assert_eq!(windows.len(), 3);
        assert_eq!(windows[0].kind, "session");
        assert!((windows[0].pct - 26.0).abs() < 0.001);
        assert_eq!(windows[1].kind, "weekly");
        assert_eq!(windows[2].kind, "fable");
        assert_eq!(windows[1].resets, windows[2].resets);
    }

    #[test]
    fn poll_do_codex_separa_cota_geral_e_modelo() {
        let reply = json!({
            "rate_limit": {
                "primary_window": { "used_percent": 6, "limit_window_seconds": 604800, "reset_at": 1789079183u64 },
                "secondary_window": null
            },
            "additional_rate_limits": [{
                "limit_name": "GPT-5.3-Codex-Spark",
                "metered_feature": "codex_bengalfox",
                "rate_limit": {
                    "primary_window": { "used_percent": 1, "limit_window_seconds": 18000, "reset_at": 1788503277u64 },
                    "secondary_window": { "used_percent": 0, "limit_window_seconds": 604800, "reset_at": 1789090077u64 }
                }
            }],
            "code_review_rate_limit": null
        });
        let windows = codex_api_windows(&reply);
        assert_eq!(windows.len(), 3);
        // `primary` não é sinônimo de 5 horas: no plano novo a cota geral é
        // uma única janela semanal.
        assert_eq!(windows[0].kind, "weekly");
        assert_eq!(windows[0].scope.as_deref(), Some("general"));
        assert!((windows[0].pct - 6.0).abs() < 0.001);
        assert_eq!(windows[1].kind, "session");
        assert_eq!(windows[1].scope.as_deref(), Some("codex_bengalfox"));
        assert_eq!(windows[1].label.as_deref(), Some("GPT-5.3-Codex-Spark"));
        assert_eq!(windows[2].kind, "weekly");
    }

    #[test]
    fn rfc3339_vira_unix() {
        // date -u -j -f "%Y-%m-%dT%H:%M:%S" "2026-09-02T05:10:00" +%s
        assert_eq!(
            rfc3339("2026-09-02T05:10:00.504892+00:00"),
            Some(1788325800)
        );
        assert_eq!(rfc3339("2026-09-02T05:10:00Z"), Some(1788325800));
        // Meia-noite UTC do epoch, e um offset que atravessa o dia.
        assert_eq!(rfc3339("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(rfc3339("2026-09-02T02:10:00-03:00"), Some(1788325800));
        assert_eq!(rfc3339("2026-09-02T07:10:00+02:00"), Some(1788325800));
        assert_eq!(rfc3339("sem data nenhuma"), None);
    }

    #[test]
    fn codex_traduz_primary_e_secondary() {
        let limits = json!({
            "primary": { "usedPercent": 0, "windowDurationMins": 300, "resetsAt": 1788245287u64 },
            "secondary": { "usedPercent": 13, "windowDurationMins": 10080, "resetsAt": 1788789678u64 }
        });
        let (windows, complete) = codex_windows(&limits);
        assert!(!complete);
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0].kind, "session");
        assert!((windows[0].pct - 0.0).abs() < 0.001);
        assert!((windows[1].pct - 13.0).abs() < 0.001);
        assert_eq!(windows[1].resets, 1788789678);
    }

    #[test]
    fn codex_prefere_snapshot_com_todos_os_buckets() {
        let limits = json!({
            "rateLimits": {
                "limitId": "codex",
                "primary": { "usedPercent": 6, "windowDurationMins": 10080, "resetsAt": 1789079183u64 }
            },
            "rateLimitsByLimitId": {
                "codex": {
                    "limitId": "codex",
                    "primary": { "usedPercent": 6, "windowDurationMins": 10080, "resetsAt": 1789079183u64 }
                },
                "codex_bengalfox": {
                    "limitId": "codex_bengalfox",
                    "limitName": "GPT-5.3-Codex-Spark",
                    "primary": { "usedPercent": 1, "windowDurationMins": 300, "resetsAt": 1788503277u64 },
                    "secondary": { "usedPercent": 0, "windowDurationMins": 10080, "resetsAt": 1789090077u64 }
                }
            }
        });
        let (windows, complete) = codex_windows(&limits);
        assert!(complete);
        assert_eq!(windows.len(), 3);
        assert_eq!(windows[0].scope.as_deref(), Some("general"));
        assert_eq!(windows[0].kind, "weekly");
        assert_eq!(windows[1].scope.as_deref(), Some("codex_bengalfox"));
        assert_eq!(windows[1].kind, "session");
    }

    #[test]
    fn update_esparso_do_codex_preserva_outros_buckets_e_janelas() {
        let full = json!({
            "rateLimits": {},
            "rateLimitsByLimitId": {
                "codex": {
                    "limitId": "codex",
                    "primary": { "usedPercent": 6, "windowDurationMins": 10080, "resetsAt": 1789079183u64 }
                },
                "spark": {
                    "limitId": "spark",
                    "limitName": "Spark",
                    "primary": { "usedPercent": 1, "windowDurationMins": 300, "resetsAt": 1788503277u64 },
                    "secondary": { "usedPercent": 2, "windowDurationMins": 10080, "resetsAt": 1789090077u64 }
                }
            }
        });
        let (old, _) = codex_windows(&full);
        let (update, complete) = codex_windows(&json!({
            "limitId": "spark",
            "primary": { "usedPercent": 9, "windowDurationMins": 300, "resetsAt": 1788504277u64 }
        }));
        assert!(!complete);
        let merged = merge_codex(&old, update);
        assert_eq!(merged.len(), 3);
        assert_eq!(merged[0].scope.as_deref(), Some("general"));
        assert_eq!(merged[1].pct, 9.0);
        assert_eq!(merged[1].label.as_deref(), Some("Spark"));
        assert_eq!(merged[2].kind, "weekly");
        assert_eq!(merged[2].pct, 2.0);
    }

    #[test]
    fn usage_antigo_sem_scope_continua_legivel() {
        let window: Window = serde_json::from_value(json!({
            "kind": "session", "pct": 4, "resets": 1788330820u64
        }))
        .unwrap();
        assert_eq!(window.scope, None);
        assert_eq!(window.label, None);
        let (update, _) = codex_windows(&json!({
            "limitId": "codex",
            "primary": { "usedPercent": 7, "windowDurationMins": 300, "resetsAt": 1788331820u64 }
        }));
        let merged = merge_codex(&[window], update);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].pct, 7.0);
    }
}
