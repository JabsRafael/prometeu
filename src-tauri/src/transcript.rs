//! O que o transcript de uma conversa conta sobre ela.
//!
//! No Claude Code, cada resposta do assistente vai para o `.jsonl` com o `usage`
//! da chamada: quanto entrou, quanto veio do cache, quanto saiu. A soma do que
//! entrou na última chamada é o tamanho da conversa agora — é o número que diz
//! "essa sessão está pesada" olhando o quadro, e que despenca quando o agente
//! compacta.
//!
//! O Codex grava outro arquivo (o `rollout-….jsonl`) e diz a mesma coisa de
//! outro jeito: um evento `token_count` por resposta, com o total já somado em
//! `last_token_usage.input_tokens`. As duas formas são lidas na mesma passada —
//! quem chama tem um caminho de transcript nas mãos e nada mais, e não precisa
//! saber qual CLI o escreveu.

use serde_json::Value;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// Quanto do fim do arquivo ler antes de desistir e ler inteiro. A última
/// resposta do assistente quase sempre está nos últimos KB; o que separa uma da
/// outra é saída de ferramenta, e essa cabe aqui dentro.
const TAIL: u64 = 512 * 1024;

/// Tokens de contexto da última resposta do assistente, ou `None` se o arquivo
/// não existe ou ainda não tem resposta nenhuma.
pub fn context(path: &Path) -> Option<u64> {
    let mut file = File::open(path).ok()?;
    let len = file.metadata().ok()?.len();

    let start = len.saturating_sub(TAIL);
    let mut tail = String::new();
    file.seek(SeekFrom::Start(start)).ok()?;
    file.read_to_string(&mut tail).ok()?;
    // O corte caiu no meio de uma linha: ela não é JSON inteiro.
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

/// A última linha que conte alguma coisa, no formato que ela estiver. Resposta
/// que deu erro na API vem com tudo zerado, e zero não é "a conversa esvaziou".
fn last_context(jsonl: &str) -> Option<u64> {
    jsonl.lines().rev().find_map(|line| {
        let v: Value = serde_json::from_str(line).ok()?;
        claude(&v).or_else(|| codex(&v)).filter(|n| *n > 0)
    })
}

/// O `usage` de uma resposta do Claude Code. Subagente não conta: o contexto que
/// interessa é o da conversa que está na tela.
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

/// O `token_count` do Codex. `input_tokens` do último turno já é a conversa
/// inteira — o que veio do cache está dentro dele, e por isso não se soma nada.
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
    fn soma_o_que_entrou_na_ultima_resposta() {
        let jsonl = [
            r#"{"type":"user","message":{"role":"user","content":"oi"}}"#.to_string(),
            turn(2, 10_000, 500, 80),
            r#"{"type":"user","message":{"role":"user","content":"e aí"}}"#.to_string(),
            turn(3, 30_000, 1_000, 120),
        ]
        .join("\n");
        assert_eq!(last_context(&jsonl), Some(31_003));
    }

    #[test]
    fn ignora_erro_de_api_e_subagente() {
        let jsonl = [
            turn(1, 5_000, 0, 10),
            r#"{"type":"assistant","isSidechain":true,"message":{"usage":{"input_tokens":9,"cache_read_input_tokens":99}}}"#.to_string(),
            r#"{"type":"assistant","isApiErrorMessage":true,"message":{"usage":{"input_tokens":0,"output_tokens":0}}}"#.to_string(),
        ]
        .join("\n");
        assert_eq!(last_context(&jsonl), Some(5_001));
    }

    /// O rollout do Codex, no formato que ele grava.
    #[test]
    fn le_o_token_count_do_codex() {
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
    fn sem_resposta_nenhuma_e_none() {
        assert_eq!(
            last_context(r#"{"type":"user","message":{"content":"oi"}}"#),
            None
        );
        assert_eq!(last_context(""), None);
        assert_eq!(context(Path::new("/nao/existe.jsonl")), None);
    }

    /// Arquivo maior que a cauda, com a última resposta lá no começo: a cauda
    /// não acha nada e a leitura inteira tem que achar.
    #[test]
    fn cauda_vazia_cai_para_o_arquivo_inteiro() {
        let path = std::env::temp_dir().join(format!(
            "prometheus-transcript-{}.jsonl",
            std::process::id()
        ));
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
