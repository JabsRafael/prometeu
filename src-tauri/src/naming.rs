//! O nome do workspace, escrito pelo próprio agente.
//!
//! O que o lançador consegue sozinho é a primeira linha do prompt cortada em 46
//! caracteres — e uma lista onde toda linha começa com "arruma o bug do" não
//! diz qual é qual. Então, assim que o workspace nasce, um `claude -p` sobe em
//! paralelo só para ler o pedido e devolver um título. Leva uns segundos; até
//! lá o nome cortado fica na tela, e quando a resposta chega o quadro é
//! republicado com o nome bom.
//!
//! Este `claude` não é sessão: não tem worktree, não tem transcript que
//! interesse, não aparece em aba nenhuma. Por isso nasce isolado —
//! `--setting-sources ""` (sem hook do usuário, que aqui só atrapalharia),
//! `--strict-mcp-config` com a lista vazia (subir MCP para escrever cinco
//! palavras custa mais que a resposta) e `--system-prompt` no lugar do de
//! sempre, que faria ele tentar *executar* o pedido em vez de nomeá-lo.

use crate::lock::lock;
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
/// o modelo que o workspace escolheu é para o trabalho de verdade.
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
pub fn rename_later(app: &AppHandle, id: &str, prompt: &str, fallback: &str) {
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return;
    }
    let (app, id, prompt, fallback) = (
        app.clone(),
        id.to_string(),
        prompt.chars().take(MAX_PROMPT).collect::<String>(),
        fallback.to_string(),
    );
    std::thread::spawn(move || {
        let Some(title) = ask(&prompt) else { return };
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

/// Roda o `claude` e devolve o título, ou nada — `claude` que não está
/// instalado, sessão sem login, rede fora: tudo isso é só ficar com o nome que
/// já estava lá. Nomear não é um serviço que possa falhar na cara de ninguém.
fn ask(prompt: &str) -> Option<String> {
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
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());

    let mut child = cmd.spawn().ok()?;
    child.stdin.take()?.write_all(prompt.as_bytes()).ok()?;

    // O `-p` fecha sozinho quando responde; o teto é para quando ele não
    // responde. Sem isto, uma thread por workspace ficaria pendurada para sempre.
    let deadline = Instant::now() + TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(100)),
            _ => {
                let _ = child.kill();
                return None;
            }
        }
    }
    let out = child.wait_with_output().ok()?;
    out.status.success().then(|| clean(&String::from_utf8_lossy(&out.stdout)))?
}

/// A resposta vira título, ou nada. Aceita só o que parece um nome: uma linha,
/// curta, sem as aspas e o ponto final que o modelo às vezes põe. O resto —
/// desculpa, pergunta, parágrafo — é descartado inteiro, porque um título ruim
/// na lista é pior que o começo do prompt.
fn clean(raw: &str) -> Option<String> {
    let line = raw.trim().lines().last()?.trim();
    let line = line.trim_matches(['"', '\'', '`', '*']).trim_end_matches('.').trim();
    let ok = !line.is_empty() && line.chars().count() <= MAX_TITLE;
    ok.then(|| line.to_string())
}

#[cfg(test)]
mod tests {
    use super::clean;

    #[test]
    fn tira_aspas_ponto_e_espaco() {
        assert_eq!(clean("  \"Corrigir arrastar entre colunas.\"  ").unwrap(), "Corrigir arrastar entre colunas");
    }

    #[test]
    fn fica_com_a_ultima_linha() {
        assert_eq!(clean("pensando...\n\nSubir modelo no rodapé").unwrap(), "Subir modelo no rodapé");
    }

    #[test]
    fn recusa_vazio_e_parágrafo() {
        assert!(clean("   ").is_none());
        assert!(clean(&"palavra ".repeat(20)).is_none());
    }
}
