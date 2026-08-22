//! prometheus-hook — o único ponto de contato entre o Claude Code e o app.
//!
//! Roda como comando de hook: lê o payload JSON no stdin, entrega ao app pelo
//! socket unix, e bloqueia até o app responder. O que o app responder vai para o
//! stdout — que é exatamente o canal que o Claude Code lê para decidir.
//!
//! Regra de ouro: nunca travar o agente para sempre. Se o app não estiver no ar,
//! ou demorar demais, sai calado com status 0 e o Claude Code segue o fluxo normal
//! (pergunta na própria TUI).

use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::time::Duration;

/// Teto de espera. O `timeout` configurado no settings.json do Claude Code é quem
/// manda de verdade; isto é só a rede de segurança para o caso de o app morrer
/// com a conexão aberta.
const MAX_WAIT: Duration = Duration::from_secs(3 * 60 * 60);

fn socket_path() -> PathBuf {
    if let Ok(p) = std::env::var("PROMETHEUS_SOCKET") {
        return PathBuf::from(p);
    }
    // Mesma conta do app: o hook de debug fala com o app de dev, o hook que
    // viaja dentro do .app fala com o app instalado.
    let root = if cfg!(debug_assertions) { ".prometheus-dev" } else { ".prometheus" };
    dirs::home_dir()
        .expect("sem HOME")
        .join(root)
        .join("run/prometheus.sock")
}

fn main() {
    let kind = std::env::args().nth(1).unwrap_or_else(|| "perm".into());

    let mut payload = String::new();
    if std::io::stdin().read_to_string(&mut payload).is_err() {
        return; // sem payload não há o que decidir
    }

    if let Some(reply) = ask_app(&kind, payload.trim()) {
        if !reply.trim().is_empty() && reply.trim() != "{}" {
            print!("{reply}");
        }
    }
}

/// Uma conexão por invocação: manda uma linha, espera uma linha. Sem ids de
/// correlação, porque a própria conexão já é a correlação.
fn ask_app(kind: &str, payload: &str) -> Option<String> {
    let mut stream = UnixStream::connect(socket_path()).ok()?;
    stream.set_read_timeout(Some(MAX_WAIT)).ok()?;

    let envelope = serde_json::json!({ "kind": kind, "payload": payload });
    writeln!(stream, "{envelope}").ok()?;
    stream.flush().ok()?;

    let mut line = String::new();
    BufReader::new(&stream).read_line(&mut line).ok()?;
    Some(line)
}
