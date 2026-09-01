//! Quanto da cota já foi.
//!
//! Os dois CLIs contam sozinhos e o app só escuta. O Claude Code manda um
//! `rate_limit_event` a cada resposta, com a janela de 5 horas, a da semana e,
//! quando existe, a semanal do Fable (`utilization` de 0 a 1); o
//! `codex app-server` manda
//! `account/rateLimits/updated` quando muda, e responde
//! `account/rateLimits/read` assim que a thread abre — senão a barra ficaria
//! vazia esperando o primeiro turno.
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
    note(app, "codex", codex_windows(limits));
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
        })
    })
    .collect()
}

/// `usedPercent` do Codex já vem de 0 a 100. A janela dele vem em minutos e
/// não em nome: 300 é a sessão, o resto é a semana.
fn codex_windows(limits: &Value) -> Vec<Window> {
    [("primary", "session"), ("secondary", "weekly")]
        .iter()
        .filter_map(|(from, kind)| {
            let window = &limits[from];
            Some(Window {
                kind: (*kind).to_string(),
                pct: window["usedPercent"].as_f64()?.clamp(0.0, 100.0),
                resets: window["resetsAt"].as_u64()?,
            })
        })
        .collect()
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
    fn codex_traduz_primary_e_secondary() {
        let limits = json!({
            "primary": { "usedPercent": 0, "windowDurationMins": 300, "resetsAt": 1788245287u64 },
            "secondary": { "usedPercent": 13, "windowDurationMins": 10080, "resetsAt": 1788789678u64 }
        });
        let windows = codex_windows(&limits);
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0].kind, "session");
        assert!((windows[0].pct - 0.0).abs() < 0.001);
        assert!((windows[1].pct - 13.0).abs() < 0.001);
        assert_eq!(windows[1].resets, 1788789678);
    }
}
