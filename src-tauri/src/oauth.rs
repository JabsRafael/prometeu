//! O OAuth que não é de ninguém: o que dois fluxos diferentes fazem igual.
//!
//! O Prometeu tem dois. O do Linear (`linear.rs`) é o clássico: um app
//! registrado uma vez, endpoints escritos no código, escopo fixo. O de um
//! servidor de MCP (`mcp_auth.rs`) não tem nada disso — os endereços saem de
//! uma descoberta a partir do 401, e o cliente é registrado na hora, no
//! servidor de quem quer que seja.
//!
//! O que os dois compartilham é a mecânica: PKCE, abrir o navegador, esperar
//! ele voltar num socket local, e trocar o `code` por um token. É isso que
//! mora aqui.
//!
//! O que **não** mora aqui é frase: a espera devolve `Denied`, e cada fluxo
//! traduz o motivo com os códigos da tela dele. A única exceção é a página que
//! o navegador mostra no fim — quem a lê está longe do catálogo do front, e o
//! texto vem de quem chamou.

use crate::i18n;
use base64::Engine;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::Command;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Por que a espera acabou sem um `code`. Sem frase: cada fluxo tem os códigos
/// da tela dele, e é lá que isto vira texto.
pub enum Denied {
    /// A pessoa disse não na tela de consentimento.
    Refused,
    /// O servidor recusou por outro motivo — o que ele mandou vai junto.
    Error(String),
    /// Voltou sem `code` e sem `error`.
    NoCode,
    /// O prazo acabou: ninguém aprovou nem negou.
    Timeout,
    /// O socket morreu no meio.
    Broken(String),
}

/// A página que o navegador mostra quando o fluxo acaba: título e uma linha.
/// Cada fluxo escreve a sua, nos dois idiomas.
pub type Page = dyn Fn(bool, &str) -> String;

pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 64 caracteres hexadecimais de duas UUIDs v4 — que saem do gerador seguro
/// do sistema. Serve de `code_verifier` (43 a 128 caracteres, RFC 7636) e de
/// `state`.
pub fn random() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

/// `code_challenge` S256: base64url sem `=` do SHA-256 do verifier.
pub fn challenge(verifier: &str) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

pub fn browse(url: &str) -> Result<(), String> {
    let ok = Command::new("open")
        .arg(url)
        .status()
        .map_err(i18n::io)?
        .success();
    ok.then_some(()).ok_or_else(|| String::from("open"))
}

/// Corpo `application/x-www-form-urlencoded`, que é como o OAuth fala. À mão
/// porque é uma linha: o `.form()` do reqwest é uma feature a mais para isso.
pub fn form(fields: &[(&str, &str)]) -> String {
    fields
        .iter()
        .map(|(k, v)| format!("{}={}", escape(k), escape(v)))
        .collect::<Vec<_>>()
        .join("&")
}

/// Percent-encoding do que vai na URL e no corpo. O redirect precisa; o
/// resto é hexadecimal e base64url, e passa intacto.
pub fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

pub fn unescape(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
                match hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                    Some(byte) => {
                        out.push(byte);
                        i += 2;
                    }
                    None => out.push(bytes[i]),
                }
            }
            other => out.push(other),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

pub fn parse_query(q: &str) -> HashMap<String, String> {
    q.split('&')
        .filter(|p| !p.is_empty())
        .map(|p| {
            let (k, v) = p.split_once('=').unwrap_or((p, ""));
            (unescape(k), unescape(v))
        })
        .collect()
}

/// A primeira linha de um GET: o caminho pedido. Qualquer outro método é
/// alguém que não é o navegador voltando do consentimento.
pub fn request_target(req: &str) -> Option<String> {
    let mut words = req.lines().next()?.split_whitespace();
    let method = words.next()?;
    let target = words.next()?;
    (method == "GET").then(|| target.to_string())
}

/// Fica no socket até o navegador voltar com o `code`, ou até o prazo. O
/// navegador pede outras coisas pelo caminho (`/favicon.ico`); tudo que não é
/// o redirect ganha 404 e a espera continua.
pub fn wait_for_code(
    listener: &TcpListener,
    route: &str,
    state: &str,
    deadline: Instant,
    page: &Page,
) -> Result<String, Denied> {
    loop {
        match listener.accept() {
            Ok((mut stream, _)) => {
                let _ = stream.set_nonblocking(false);
                let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                let mut buf = vec![0u8; 8192];
                let n = stream.read(&mut buf).unwrap_or(0);
                let Some(target) = request_target(&String::from_utf8_lossy(&buf[..n])) else {
                    respond(&mut stream, "404 Not Found", "");
                    continue;
                };
                let (path, query) = target.split_once('?').unwrap_or((&target, ""));
                if path != route {
                    respond(&mut stream, "404 Not Found", "");
                    continue;
                }
                let q = parse_query(query);
                // Mesmo uma resposta de erro pertence ao fluxo só depois de
                // provar o state. Sem isto qualquer request local podia matar
                // uma autorização que ainda estava esperando o navegador.
                if q.get("state").map(String::as_str) != Some(state) {
                    respond(&mut stream, "400 Bad Request", &page(false, ""));
                    continue;
                }
                if let Some(err) = q.get("error") {
                    let why = q.get("error_description").cloned().unwrap_or_default();
                    respond(&mut stream, "200 OK", &page(false, &why));
                    return Err(match err.as_str() {
                        "access_denied" => Denied::Refused,
                        _ => Denied::Error(format!("{err} {why}").trim().to_string()),
                    });
                }
                let Some(code) = q.get("code").filter(|c| !c.is_empty()) else {
                    respond(&mut stream, "400 Bad Request", &page(false, ""));
                    return Err(Denied::NoCode);
                };
                respond(&mut stream, "200 OK", &page(true, ""));
                return Ok(code.clone());
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if Instant::now() > deadline {
                    return Err(Denied::Timeout);
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) => return Err(Denied::Broken(e.to_string())),
        }
    }
}

pub fn respond(stream: &mut TcpStream, status: &str, body: &str) {
    let _ = write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\n\
         Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'\r\n\
         X-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.flush();
}

/// A única página que o Prometeu serve: a que diz para fechar a aba. O
/// título e a linha vêm de quem chamou, já no idioma da pessoa.
pub fn page(title: &str, text: &str) -> String {
    let lang = html(&i18n::lang());
    let title = html(title);
    let text = html(text);
    format!(
        "<!doctype html><html lang=\"{lang}\"><meta charset=\"utf-8\"><title>{title}</title>\
         <body style=\"margin:0;height:100vh;display:grid;place-items:center;background:#141110;\
         color:#eae8e6;font:16px/1.5 -apple-system,system-ui,sans-serif\">\
         <div style=\"text-align:center\"><div style=\"font-size:22px;font-weight:600\">{title}</div>\
         <div style=\"color:#a4a09d;margin-top:8px\">{text}</div></div></body></html>"
    )
}

pub fn html(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// O vetor de teste da RFC 7636, apêndice B.
    #[test]
    fn o_challenge_e_o_da_rfc() {
        assert_eq!(
            challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn a_query_volta_decodificada() {
        let q = parse_query("code=abc%20def&state=xyz");
        assert_eq!(q.get("code").map(String::as_str), Some("abc def"));
        assert_eq!(q.get("state").map(String::as_str), Some("xyz"));
    }

    #[test]
    fn so_get_e_alvo() {
        assert_eq!(
            request_target("GET /mcp?code=1 HTTP/1.1\r\n"),
            Some("/mcp?code=1".to_string())
        );
        assert_eq!(request_target("POST /mcp HTTP/1.1\r\n"), None);
    }
}
