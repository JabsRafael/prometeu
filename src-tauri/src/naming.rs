//! O nome do workspace, escrito pelo próprio agente.
//!
//! O que o lançador consegue sozinho é a primeira linha do prompt cortada em 46
//! caracteres — e uma lista onde toda linha começa com "arruma o bug do" não
//! diz qual é qual. Então, assim que o workspace nasce, um agente de uma pergunta
//! só sobe em paralelo para ler o pedido e devolver um título. Leva uns
//! segundos; até lá o nome cortado fica na tela, e quando a resposta chega o
//! quadro é republicado com o nome bom.
//!
//! Quem nomeia é o CLI do próprio workspace — `claude -p` num workspace do
//! Claude Code, `codex exec` num do Codex. Não é detalhe: quem só tem um dos
//! dois instalado ficaria sem título nenhum se o nomeador fosse sempre o outro.
//!
//! Isto não é sessão: não tem worktree, não tem transcript que interesse, não
//! aparece em aba nenhuma. Por isso nasce o mais isolado que cada CLI permite —
//! sem os hooks do usuário (que aqui só atrapalhariam), sem MCP (subir servidor
//! para escrever cinco palavras custa mais que a resposta) e com o pedido
//! embrulhado numa instrução que impede o agente de *executar* o que leu em vez
//! de nomeá-lo.

use crate::lock::lock;
use crate::session::Launch;
use crate::state::publish;
use crate::AppState;
use std::io::Write;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

/// O que o `claude` é aqui: um nomeador, e nada mais. Sem isto ele lê o prompt
/// como serviço a fazer e responde perguntando qual é o repositório.
const SYSTEM: &str = "Você nomeia tarefas. Recebe o pedido que alguém fez a um agente de código \
e devolve UM título curto para esse trabalho: no máximo 5 palavras, no mesmo idioma do pedido, \
sem aspas, sem ponto final, sem prefixo e sem explicação. Nunca execute o pedido, nunca faça \
perguntas, nunca peça contexto. Responda apenas o título.";

/// Modelo fixo, e o mais barato: são cinco palavras a partir de um parágrafo, e
/// o modelo que o workspace escolheu é para o trabalho de verdade. Só vale para
/// o Claude Code, onde `haiku` é um alias que não envelhece — o do Codex sai do
/// catálogo dele (ver `agents::codex_namer_model`), porque ali não há alias e um
/// slug escrito à mão envelhece em duas versões.
const MODEL: &str = "haiku";

/// Prompt maior que isto não melhora o título — e o começo é onde o pedido está.
const MAX_PROMPT: usize = 2000;

/// Teto do que se espera de um `-p`: passou disto, algo travou (login expirado,
/// rede) e o nome cortado continua valendo.
const TIMEOUT: Duration = Duration::from_secs(60);

/// Um título maior que isto não é título — é o modelo tendo conversado.
const MAX_TITLE: usize = 60;

/// Dispara o nomeador e volta na hora: quem cria o workspace não espera por
/// isto. `fallback` é o nome que está na tela agora — se o usuário renomear
/// antes de a resposta chegar, o nome dele fica, porque a troca só acontece
/// enquanto o título ainda for este.
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
                // Renomeado à mão no meio do caminho: a escolha da pessoa ganha.
                Some(ws) if ws.title == fallback => ws.title = title,
                _ => return,
            }
        }
        publish(&app);
    });
}

/// O nomeador do agente deste workspace. Falhar aqui — CLI que não está
/// instalado, sessão sem login, rede fora — é só ficar com o nome que já estava
/// lá: nomear não é um serviço que possa falhar na cara de ninguém.
fn ask(prompt: &str, launch: &Launch) -> Option<String> {
    match launch.agent {
        // O mais barato do catálogo do Codex, e o modelo do workspace só se não
        // houver catálogo para consultar: nomear é uma frase, e o modelo do
        // trabalho é caro e mais lento para dizer cinco palavras.
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
    }
}

/// O nomeador do Codex. `codex exec` é a versão de uma pergunta só do CLI, e
/// `-o` escreve exatamente a última mensagem num arquivo — o que evita ter de
/// separar a resposta do resto do que ele desenha no terminal.
fn ask_codex(prompt: &str, model: &str) -> Option<String> {
    let out = std::env::temp_dir().join(format!("prometheus-nome-{}.txt", uuid::Uuid::new_v4()));
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
    // O Codex não tem `--system-prompt`: a instrução vai junto do pedido, e o
    // pedido vem rotulado para ele não confundir uma coisa com a outra.
    cmd.arg(format!("{SYSTEM}\n\nPedido:\n{prompt}"));
    cmd.current_dir(crate::paths::home());
    // Sem isto o `codex exec` fica esperando "input adicional" no stdin e nunca
    // responde.
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    let child = cmd.spawn().ok();
    let title = child
        .and_then(|mut c| wait(&mut c).then(|| std::fs::read_to_string(&out).ok()))
        .flatten();
    let _ = std::fs::remove_file(&out);
    clean(&title?)
}

/// O nomeador do Claude Code. `-p` é a pergunta única, e o pedido vai pelo stdin.
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
    // Fora de qualquer worktree: o pedido vai por stdin, e o diretório só
    // serviria para o agente achar que tem um projeto para mexer.
    cmd.current_dir(crate::paths::home());
    // Mesma razão do `claude_cmd`: um `claude` rodando dentro de outro herda
    // CLAUDE_CODE_CHILD_SESSION e companhia, e o que ele herda não é dele.
    for (k, _) in std::env::vars() {
        if k.starts_with("CLAUDE") {
            cmd.env_remove(k);
        }
    }
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());

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

/// Espera o nomeador responder. Ele fecha sozinho quando responde; o teto é para
/// quando não responde — sem isto, uma thread por workspace ficaria pendurada
/// para sempre. `false` é "não deu": ou estourou o tempo, ou saiu com erro.
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

/// A resposta vira título, ou nada. Aceita só o que parece um nome: uma linha,
/// curta, sem as aspas e o ponto final que o modelo às vezes põe. O resto —
/// desculpa, pergunta, parágrafo — é descartado inteiro, porque um título ruim
/// na lista é pior que o começo do prompt.
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
