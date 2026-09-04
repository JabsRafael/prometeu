//! Primitivas do contrato canônico de conversa no backend.
//!
//! Adapters de provider dependem deste módulo para produzir eventos V1. Este
//! módulo não conhece transporte, processo nem protocolo externo.

use serde_json::{json, Value};

pub fn event(kind: &str, at: u64, fields: Value) -> Value {
    let mut out = fields.as_object().cloned().unwrap_or_default();
    out.insert("v".into(), json!(1));
    out.insert("type".into(), json!(kind));
    out.insert("at".into(), json!(at));
    Value::Object(out)
}

pub fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelope_v1_conserva_os_campos_do_evento() {
        let value = event("system.notice", 12, json!({ "detail": "oi" }));
        assert_eq!(value["v"], 1);
        assert_eq!(value["type"], "system.notice");
        assert_eq!(value["at"], 12);
        assert_eq!(value["detail"], "oi");
    }
}
