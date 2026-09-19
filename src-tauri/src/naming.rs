//! Generate a workspace title asynchronously from the full prompt while displaying the truncated
//! first line as fallback. Use the workspace's installed provider and a short-lived naming process
//! without worktree access, user hooks, or MCP servers. Explicit instructions treat the supplied
//! prompt as text to name, not work to execute.

use crate::lock::lock;
use crate::session::Launch;
use crate::state::publish;
use crate::AppState;
use std::io::Write;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

/// Constrain Claude to title generation so it does not treat the prompt as a request to execute.
const SYSTEM: &str = "Você nomeia tarefas. Recebe o pedido que alguém fez a um agente de código \
e devolve UM título curto para esse trabalho: no máximo 5 palavras, no mesmo idioma do pedido, \
sem aspas, sem ponto final, sem prefixo e sem explicação. Nunca execute o pedido, nunca faça \
perguntas, nunca peça contexto. Responda apenas o título.";

/// Use Claude's stable haiku alias for cheap naming. Choose Codex's model from its catalog because
/// it has no equivalent stable alias.
const MODEL: &str = "haiku";

/// Limit prompt size; its beginning supplies enough context for a title.
const MAX_PROMPT: usize = 2000;

/// Bound naming time and retain the existing fallback on network or authentication stalls.
const TIMEOUT: Duration = Duration::from_secs(60);

/// Reject responses too long to be titles.
const MAX_TITLE: usize = 60;

/// Start naming without blocking workspace creation. Replace only the unchanged fallback title so
/// manual renames win.
pub fn rename_later(app: &AppHandle, id: &str, prompt: &str, fallback: &str, launch: &Launch) {
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return;
    }
    let (app, id, prompt, fallback, launch) = (
        app.clone(),
        id.to_string(),
        prompt.chars().take(MAX_PROMPT).collect::<String>(),
        fallback.to_string(),
        launch.clone(),
    );
    std::thread::spawn(move || {
        let Some(title) = ask(&prompt, &launch) else {
            return;
        };
        let state = app.state::<AppState>();
        {
            let mut board = lock(&state.board);
            match board.workspace_mut(&id) {
                // Preserve a manual rename made while generation was pending.
                Some(ws) if ws.title == fallback => ws.title = title,
                _ => return,
            }
        }
        publish(&app);
    });
}

/// Naming failures retain the existing title rather than surfacing an error for an optional
/// enhancement.
fn ask(prompt: &str, launch: &Launch) -> Option<String> {
    match launch.agent {
        // Use Codex's cheapest catalog model, falling back to the workspace model only when no
        // catalog exists.
        crate::state::ProviderId::Codex => {
            let model = crate::agents::codex_namer_model();
            ask_codex(
                prompt,
                if model.is_empty() {
                    &launch.model
                } else {
                    &model
                },
            )
        }
        crate::state::ProviderId::Claude => ask_claude(prompt),
        crate::state::ProviderId::Gemini => None,
    }
}

/// Use codex exec with -o to capture only the final answer without parsing terminal output.
fn ask_codex(prompt: &str, model: &str) -> Option<String> {
    let out = std::env::temp_dir().join(format!("prometeu-nome-{}.txt", uuid::Uuid::new_v4()));
    let mut cmd = Command::new("codex");
    cmd.args([
        "exec",
        "--ephemeral",
        "--skip-git-repo-check",
        "-s",
        "read-only",
    ]);
    cmd.args(["-c", "model_reasoning_effort=low", "-c", "mcp_servers={}"]);
    cmd.arg("-o").arg(&out);
    if !model.trim().is_empty() {
        cmd.args(["-m", model.trim()]);
    }
    // Label the instructions and source prompt because codex exec has no system-prompt flag.
    cmd.arg(format!("{SYSTEM}\n\nPedido:\n{prompt}"));
    cmd.current_dir(crate::paths::home());
    // Close stdin so codex exec does not wait indefinitely for additional input.
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    let profile = crate::accounts::active(crate::state::ProviderId::Codex).ok()?;
    profile.prepare().ok()?;
    profile.apply(&mut cmd).ok()?;
    let child = cmd.spawn().ok();
    let title = child
        .and_then(|mut c| wait(&mut c).then(|| std::fs::read_to_string(&out).ok()))
        .flatten();
    let _ = std::fs::remove_file(&out);
    clean(&title?)
}

/// Use Claude's single-prompt mode with the naming request supplied through stdin.
fn ask_claude(prompt: &str) -> Option<String> {
    let mut cmd = Command::new("claude");
    cmd.args([
        "-p",
        "--model",
        MODEL,
        "--setting-sources",
        "",
        "--strict-mcp-config",
        "--mcp-config",
        r#"{"mcpServers":{}}"#,
        "--system-prompt",
        SYSTEM,
    ]);
    // Run outside worktrees so the naming process cannot mistake the prompt for project work.
    cmd.current_dir(crate::paths::home());
    // Remove inherited Claude child-session settings that belong to the parent process.
    for (k, _) in std::env::vars() {
        if k.starts_with("CLAUDE") {
            cmd.env_remove(k);
        }
    }
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());

    let profile = crate::accounts::active(crate::state::ProviderId::Claude).ok()?;
    profile.prepare().ok()?;
    profile.apply(&mut cmd).ok()?;
    let mut child = cmd.spawn().ok()?;
    child.stdin.take()?.write_all(prompt.as_bytes()).ok()?;
    if !wait(&mut child) {
        return None;
    }
    let out = child.wait_with_output().ok()?;
    out.status
        .success()
        .then(|| clean(&String::from_utf8_lossy(&out.stdout)))?
}

/// Wait only until the naming deadline. Return false on timeout or process failure instead of
/// retaining one stalled thread per workspace.
fn wait(child: &mut std::process::Child) -> bool {
    let deadline = Instant::now() + TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(100)),
            _ => {
                let _ = child.kill();
                return false;
            }
        }
    }
}

/// Accept only short single-line titles, trimming wrapping quotes and final punctuation. Reject
/// questions, explanations, and paragraphs in favor of the fallback.
fn clean(raw: &str) -> Option<String> {
    let line = raw.trim().lines().last()?.trim();
    let line = line
        .trim_matches(['"', '\'', '`', '*'])
        .trim_end_matches('.')
        .trim();
    let ok = !line.is_empty() && line.chars().count() <= MAX_TITLE;
    ok.then(|| line.to_string())
}

#[cfg(test)]
mod tests {
    use super::clean;

    #[test]
    fn tira_aspas_ponto_e_espaco() {
        assert_eq!(
            clean("  \"Corrigir arrastar entre colunas.\"  ").unwrap(),
            "Corrigir arrastar entre colunas"
        );
    }

    #[test]
    fn fica_com_a_ultima_linha() {
        assert_eq!(
            clean("pensando...\n\nSubir modelo no rodapé").unwrap(),
            "Subir modelo no rodapé"
        );
    }

    #[test]
    fn recusa_vazio_e_parágrafo() {
        assert!(clean("   ").is_none());
        assert!(clean(&"palavra ".repeat(20)).is_none());
    }
}
