//! Se este teste passa, o botão nativo funciona. Ele cobre o único caminho que
//! não pode falhar: payload entra pelo stdin do hook, atravessa o socket, e a
//! decisão do app sai pelo stdout do hook — que é o que o Claude Code lê.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixListener;
use std::process::{Command, Stdio};

const PAYLOAD: &str = r#"{"hook_event_name":"PermissionRequest","tool_name":"Write","tool_input":{"file_path":"/tmp/x","content":"oi"}}"#;
const DECISION: &str = r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","permissionDecision":"deny"}}"#;

fn sock_path(name: &str) -> std::path::PathBuf {
    // Socket unix estoura em ~104 bytes de caminho, então nada de nomes longos.
    std::env::temp_dir().join(format!("prm-t-{name}-{}.sock", std::process::id()))
}

fn run_hook(socket: &std::path::Path) -> std::process::Child {
    let mut child = Command::new(env!("CARGO_BIN_EXE_prometheus-hook"))
        .arg("perm")
        .env("PROMETHEUS_SOCKET", socket)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("hook não subiu");
    child.stdin.take().unwrap().write_all(PAYLOAD.as_bytes()).unwrap();
    child
}

#[test]
fn decisao_do_app_vira_stdout_do_hook() {
    let path = sock_path("ok");
    let _ = std::fs::remove_file(&path);
    let listener = UnixListener::bind(&path).unwrap();

    let child = run_hook(&path);

    let (stream, _) = listener.accept().unwrap();
    let mut line = String::new();
    BufReader::new(&stream).read_line(&mut line).unwrap();

    // O envelope carrega o payload como string, para newline não quebrar o protocolo.
    let envelope: serde_json::Value = serde_json::from_str(&line).unwrap();
    assert_eq!(envelope["kind"], "perm");
    let inner: serde_json::Value =
        serde_json::from_str(envelope["payload"].as_str().unwrap()).unwrap();
    assert_eq!(inner["tool_name"], "Write");

    writeln!(&stream, "{DECISION}").unwrap();

    let out = child.wait_with_output().unwrap();
    assert!(out.status.success());
    assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), DECISION);

    let _ = std::fs::remove_file(&path);
}

#[test]
fn app_fora_do_ar_nao_trava_o_agente() {
    // Sem socket nenhum: o hook precisa sair calado e com sucesso, para o Claude
    // Code seguir perguntando na própria TUI em vez de ficar pendurado.
    let child = run_hook(&sock_path("inexistente"));
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success());
    assert!(out.stdout.is_empty());
}
