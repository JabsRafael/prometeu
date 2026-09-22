//! Read current conversation size from provider transcripts. Claude reports input and cache usage
//! on assistant responses; Codex reports last_token_usage.input_tokens in token_count events.
//! Interpret either format from the supplied path without requiring callers to identify its
//! provider.

use serde_json::Value;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// Search a bounded file tail first, falling back to the full transcript when no usable response
/// appears there.
const TAIL: u64 = 512 * 1024;

/// Return context tokens from the latest assistant response, or None for missing files or
/// conversations without responses.
pub fn context(path: &Path) -> Option<u64> {
    let mut file = File::open(path).ok()?;
    let len = file.metadata().ok()?.len();

    let start = len.saturating_sub(TAIL);
    let mut tail = String::new();
    file.seek(SeekFrom::Start(start)).ok()?;
    file.read_to_string(&mut tail).ok()?;
    // Discard the first partial line when tail reading begins inside a JSON record.
    let tail = if start > 0 {
        tail.split_once('\n').map(|(_, rest)| rest).unwrap_or("")
    } else {
        &tail
    };
    if let Some(n) = last_context(tail) {
        return Some(n);
    }
    if start == 0 {
        return None;
    }
    let mut whole = String::new();
    file.seek(SeekFrom::Start(0)).ok()?;
    file.read_to_string(&mut whole).ok()?;
    last_context(&whole)
}

/// Find the latest usable record in either format. Ignore all-zero API failure usage rather than
/// treating it as an emptied conversation.
fn last_context(jsonl: &str) -> Option<u64> {
    jsonl.lines().rev().find_map(|line| {
        let v: Value = serde_json::from_str(line).ok()?;
        claude(&v).or_else(|| codex(&v)).filter(|n| *n > 0)
    })
}

/// Read primary Claude response usage without counting subagent context.
fn claude(v: &Value) -> Option<u64> {
    if v["isSidechain"].as_bool() == Some(true) {
        return None;
    }
    let usage = &v["message"]["usage"];
    let n = [
        "input_tokens",
        "cache_read_input_tokens",
        "cache_creation_input_tokens",
    ]
    .iter()
    .filter_map(|k| usage[k].as_u64())
    .sum::<u64>();
    (n > 0).then_some(n)
}

/// Codex input_tokens already includes cached input, so no extra sum is needed.
fn codex(v: &Value) -> Option<u64> {
    let payload = &v["payload"];
    if payload["type"].as_str() != Some("token_count") {
        return None;
    }
    payload["info"]["last_token_usage"]["input_tokens"].as_u64()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn turn(input: u64, read: u64, create: u64, out: u64) -> String {
        format!(
            r#"{{"type":"assistant","isSidechain":false,"message":{{"role":"assistant","usage":{{"input_tokens":{input},"cache_read_input_tokens":{read},"cache_creation_input_tokens":{create},"output_tokens":{out}}}}}}}"#
        )
    }

    #[test]
    fn sums_input_tokens_from_the_last_response() {
        let jsonl = [
            r#"{"type":"user","message":{"role":"user","content":"hello"}}"#.to_string(),
            turn(2, 10_000, 500, 80),
            r#"{"type":"user","message":{"role":"user","content":"and then"}}"#.to_string(),
            turn(3, 30_000, 1_000, 120),
        ]
        .join("\n");
        assert_eq!(last_context(&jsonl), Some(31_003));
    }

    #[test]
    fn ignores_api_errors_and_subagents() {
        let jsonl = [
            turn(1, 5_000, 0, 10),
            r#"{"type":"assistant","isSidechain":true,"message":{"usage":{"input_tokens":9,"cache_read_input_tokens":99}}}"#.to_string(),
            r#"{"type":"assistant","isApiErrorMessage":true,"message":{"usage":{"input_tokens":0,"output_tokens":0}}}"#.to_string(),
        ]
        .join("\n");
        assert_eq!(last_context(&jsonl), Some(5_001));
    }

    /// Use Codex's native rollout format.
    #[test]
    fn reads_codex_token_count() {
        let count = |input: u64| {
            format!(
                r#"{{"type":"event_msg","payload":{{"type":"token_count","info":{{"last_token_usage":{{"input_tokens":{input},"cached_input_tokens":{},"total_tokens":{input}}},"model_context_window":258400}}}}}}"#,
                input / 2
            )
        };
        let jsonl = [
            r#"{"type":"session_meta","payload":{"id":"abc"}}"#.to_string(),
            count(14_835),
            r#"{"type":"response_item","payload":{"type":"message","role":"assistant"}}"#
                .to_string(),
            count(30_180),
        ]
        .join("\n");
        assert_eq!(last_context(&jsonl), Some(30_180));
    }

    #[test]
    fn returns_none_without_a_response() {
        assert_eq!(
            last_context(r#"{"type":"user","message":{"content":"hello"}}"#),
            None
        );
        assert_eq!(last_context(""), None);
        assert_eq!(context(Path::new("/does/not/exist.jsonl")), None);
    }

    /// Fall back to the full file when the latest usable response precedes the bounded tail.
    #[test]
    fn empty_tail_falls_back_to_the_complete_file() {
        let path =
            std::env::temp_dir().join(format!("prometeu-transcript-{}.jsonl", std::process::id()));
        let filler = format!(
            r#"{{"type":"user","message":{{"content":"{}"}}}}"#,
            "x".repeat(100_000)
        );
        let mut lines = vec![turn(1, 7_000, 0, 5)];
        lines.extend(std::iter::repeat_n(filler, 8));
        std::fs::write(&path, lines.join("\n")).unwrap();
        assert_eq!(context(&path), Some(7_001));
        std::fs::remove_file(&path).unwrap();
    }
}
