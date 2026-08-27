//! Quais agentes esta máquina tem, e o que cada um aceita.
//!
//! São dois CLIs: o `claude` e o `codex`. O lançador só oferece o que está
//! instalado — quem tem um só não pode ver a lista do outro e escolher um modelo
//! que nunca vai rodar.
//!
//! A aba é a mesma nos dois: um pty, um card, uma nota de atividade, um
//! transcript. O que troca é o CLI que roda dentro dela. Do lado do Claude Code
//! não há o que explicar (é o que o `session.rs` sempre fez); o resto deste
//! módulo é o que o Codex faz diferente:
//!
//! - **Modelo e esforço** são flags diferentes: `-m <slug>` e
//!   `-c model_reasoning_effort=<nível>`, e não `--model`/`--effort`. Os níveis
//!   são os mesmos do Claude Code menos o `ultracode`, que ali é `ultra`.
//! - **Id da sessão não se impõe.** O Claude Code aceita `--session-id`, e é por
//!   isso que a aba e a sessão têm o mesmo id. O Codex escolhe o dele; o hook
//!   `SessionStart` conta qual foi, o quadro guarda no `Tab`, e é ele que volta
//!   como `codex resume <id>`.
//! - **Hooks não são por sessão.** Não há `--settings <arquivo>`: o Codex lê
//!   `$CODEX_HOME/hooks.json` e nada mais. Então o app escreve nesse arquivo — e
//!   como ele vale para o `codex` do terminal também, quem identifica a aba é a
//!   variável `PROMETHEUS_TAB` do processo, que os hooks herdam. Sessão que não é
//!   do quadro chega ao app sem `tab`, e o app não faz nada com ela.
//!
//! A lista de modelos não está escrita aqui: o CLI mantém o catálogo em
//! `models_cache.json`, e é dele que o lançador tira o que oferecer. Modelo novo
//! da OpenAI aparece no dropdown sem release do Prometheus.

use crate::paths;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// Os eventos que o quadro escuta, e o `kind` com que cada um chega ao
/// `prometheus-hook`. São os mesmos do `settings.json` do Claude Code: o payload
/// do Codex traz os mesmos campos (`session_id`, `transcript_path`, `tool_name`,
/// `tool_input`), então o socket não precisa saber de qual CLI veio.
const EVENTS: [(&str, &str); 6] = [
    ("PermissionRequest", "perm"),
    ("SessionStart", "start"),
    ("PreToolUse", "tool"),
    ("UserPromptSubmit", "run"),
    ("Stop", "idle"),
    ("SessionEnd", "end"),
];

/// Quais dos dois CLIs estão no PATH. É o `command -v` de um shell de login, e
/// não um teste de arquivo: o `claude` e o `codex` moram onde o profile da
/// pessoa disser. Um shell só para os dois — abrir um shell de login custa
/// perto de um segundo, e isto acontece com a janela subindo.
fn installed() -> (bool, bool) {
    let out = std::process::Command::new("sh")
        .args(["-lc", "command -v claude && echo TEM_CLAUDE; command -v codex && echo TEM_CODEX; true"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default();
    (out.contains("TEM_CLAUDE"), out.contains("TEM_CODEX"))
}

/// `$CODEX_HOME`, ou o `~/.codex` de sempre. É o home do usuário de propósito:
/// conta, skills, memórias e config do Codex continuam valendo dentro do app.
fn home() -> PathBuf {
    std::env::var("CODEX_HOME").map(PathBuf::from).unwrap_or_else(|_| paths::home().join(".codex"))
}

/// Um modelo como o lançador o mostra.
#[derive(serde::Serialize)]
pub struct Model {
    pub slug: String,
    pub name: String,
    /// Os níveis de esforço que este modelo aceita — o Sol vai até `ultra`, o
    /// 5.4 para no `xhigh`. O lançador não deixa escolher o que o CLI recusaria.
    pub efforts: Vec<String>,
}

/// O que o lançador tem para oferecer.
#[derive(serde::Serialize)]
pub struct Agents {
    /// O `claude` está instalado. Falso esconde a lista de modelos dele — e o
    /// "Modelo padrão", que é dele também.
    pub claude: bool,
    /// Os modelos do Codex. Vazio é "não há Codex aqui", e some do dropdown.
    pub codex: Vec<Model>,
}

/// Roda uma vez por sessão do app: nem CLI se instala, nem catálogo muda com a
/// janela aberta.
#[tauri::command]
pub fn agents() -> Agents {
    let (claude, codex) = installed();
    Agents { claude, codex: if codex { codex_models() } else { vec![] } }
}

/// O catálogo do Codex, filtrado pelo que ele mesmo marca como visível. Lista
/// vazia é "não há Codex nesta máquina" — o `codex` fora do PATH, ou instalado e
/// nunca aberto (o catálogo só existe depois do primeiro login).
fn codex_models() -> Vec<Model> {
    let Ok(raw) = std::fs::read_to_string(home().join("models_cache.json")) else { return vec![] };
    let Ok(cache) = serde_json::from_str::<Value>(&raw) else { return vec![] };
    cache["models"]
        .as_array()
        .map(|models| {
            models
                .iter()
                .filter(|m| m["visibility"].as_str() == Some("list"))
                .filter_map(|m| {
                    let slug = m["slug"].as_str()?.to_string();
                    let name = m["display_name"].as_str().unwrap_or(&slug).to_string();
                    let efforts = m["supported_reasoning_levels"]
                        .as_array()
                        .map(|ls| ls.iter().filter_map(|l| l["effort"].as_str()).map(str::to_string).collect())
                        .unwrap_or_default();
                    Some(Model { slug, name, efforts })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// O modelo com que o Codex nomeia um workspace: o mais barato que o catálogo
/// oferece, que é o de maior `priority` — o catálogo ordena do carro-chefe (1)
/// para o mini (23). São cinco palavras a partir de um parágrafo, e gastar o
/// modelo do trabalho nisso é caro e mais lento. Vazio é catálogo ausente: aí o
/// nomeador cai no modelo do próprio workspace.
pub fn codex_namer_model() -> String {
    let Ok(raw) = std::fs::read_to_string(home().join("models_cache.json")) else { return String::new() };
    let Ok(cache) = serde_json::from_str::<Value>(&raw) else { return String::new() };
    cache["models"]
        .as_array()
        .and_then(|models| {
            models
                .iter()
                .filter(|m| m["visibility"].as_str() == Some("list"))
                .max_by_key(|m| m["priority"].as_u64().unwrap_or(0))
                .and_then(|m| m["slug"].as_str())
                .map(str::to_string)
        })
        .unwrap_or_default()
}

/// O nível de esforço como o Codex o chama. A escada da tela é a do Claude Code,
/// e o último degrau tem nome diferente aqui: `ultracode` é a orquestração de
/// subagentes de lá, `ultra` é a de cá.
fn effort(level: &str) -> &str {
    match level.trim() {
        "ultracode" => "ultra",
        other => other,
    }
}

/// Os argumentos do `codex`. `resume` é o id que o Codex escolheu na primeira
/// vez — sem ele a conversa nasce nova, que é o que acontece na primeira aba e
/// no que sobrou de uma sessão que nunca falou. `first` é a primeira fala, que
/// no Codex vai por argumento em vez de ser digitada (ver `spawn_tab`).
pub fn codex_args(
    worktree: &Path,
    resume: Option<&str>,
    model: &str,
    level: &str,
    first: Option<&str>,
) -> Vec<String> {
    let mut args: Vec<String> = vec![];
    if let Some(session) = resume {
        args.extend(["resume".into(), session.to_string()]);
    }
    args.extend(["-C".into(), worktree.display().to_string()]);
    // Solto, como toda aba do quadro: agente que para a cada comando não
    // trabalha enquanto você olha outra coisa. O segundo é o que permite os
    // hooks rodarem sem o app ter de gravar a digital de cada um deles no
    // estado do Codex.
    args.push("--dangerously-bypass-approvals-and-sandbox".into());
    args.push("--dangerously-bypass-hook-trust".into());
    // Pasta que o Codex nunca viu abre com "do you trust this directory?" — e um
    // worktree é sempre uma pasta que ele nunca viu. A pergunta trava a TUI
    // antes de qualquer coisa, inclusive antes da primeira fala. Quem escolheu
    // trabalhar aqui foi a pessoa, no lançador; não há uma segunda pergunta a
    // fazer sobre isso.
    args.extend([
        "-c".into(),
        format!("projects.{:?}.trust_level=\"trusted\"", worktree.display().to_string()),
    ]);
    if !model.trim().is_empty() {
        args.extend(["-m".into(), model.trim().into()]);
    }
    if !level.trim().is_empty() {
        args.extend(["-c".into(), format!("model_reasoning_effort={}", effort(level))]);
    }
    // Por último, porque é posicional: o `[PROMPT]` do `codex`, e o `[PROMPT]`
    // depois do id no `codex resume`.
    if let Some(first) = first.map(str::trim).filter(|p| !p.is_empty()) {
        args.push(first.to_string());
    }
    args
}

/// Instala os hooks do quadro no `hooks.json` do Codex, sem apagar o que já
/// estava ali.
///
/// O arquivo é do usuário e pode ter hooks dele. A regra é: dentro de cada
/// evento, tira as entradas que apontam para *este* binário e põe a de agora.
/// "Este" e não "qualquer prometheus-hook" porque o app de dev e o instalado têm
/// binários diferentes, cada um falando com o seu socket — um não pode
/// desinstalar o outro.
pub fn install_codex_hooks(hook_bin: &str) -> Result<(), String> {
    write_hooks(&home().join("hooks.json"), hook_bin)
}

/// O arquivo, num caminho qualquer — é o que dá para testar sem tocar no
/// `~/.codex` de ninguém.
fn write_hooks(path: &Path, hook_bin: &str) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let mut file: Value = std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));

    let updated = merged(&file["hooks"], hook_bin);
    if file["hooks"] == updated {
        return Ok(()); // já está instalado: não reescreve o arquivo do usuário
    }
    file["hooks"] = updated;
    std::fs::write(path, serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

/// O bloco `hooks` do arquivo com as entradas deste binário no lugar. Separado
/// para dar para testar sem tocar no `~/.codex` de ninguém.
fn merged(current: &Value, hook_bin: &str) -> Value {
    let mut hooks = current.as_object().cloned().unwrap_or_default();
    for (event, kind) in EVENTS {
        let ours = json!({ "matcher": "*", "hooks": [{ "type": "command", "command": command(hook_bin, kind) }] });
        let mut entries: Vec<Value> = hooks
            .get(event)
            .and_then(Value::as_array)
            .map(|list| list.iter().filter(|e| !is_ours(e, hook_bin)).cloned().collect())
            .unwrap_or_default();
        entries.push(ours);
        hooks.insert(event.to_string(), Value::Array(entries));
    }
    Value::Object(hooks)
}

fn command(hook_bin: &str, kind: &str) -> String {
    format!("{hook_bin:?} {kind}")
}

/// Uma entrada é nossa quando qualquer comando dela chama este binário.
fn is_ours(entry: &Value, hook_bin: &str) -> bool {
    entry["hooks"]
        .as_array()
        .is_some_and(|hs| hs.iter().any(|h| h["command"].as_str().is_some_and(|c| c.contains(hook_bin))))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ultracode_vira_ultra() {
        assert_eq!(effort("ultracode"), "ultra");
        assert_eq!(effort("max"), "max");
    }

    #[test]
    fn conversa_nova_nao_passa_resume() {
        let args = codex_args(Path::new("/tmp/wt"), None, "gpt-5.6-sol", "high", None);
        assert!(!args.contains(&"resume".to_string()));
        assert_eq!(args[..2], ["-C", "/tmp/wt"]);
        assert_eq!(args[args.len() - 4..], ["-m", "gpt-5.6-sol", "-c", "model_reasoning_effort=high"]);
    }

    #[test]
    fn retomar_comeca_pelo_subcomando() {
        let args = codex_args(Path::new("/tmp/wt"), Some("abc-123"), "", "", None);
        assert_eq!(args[..2], ["resume", "abc-123"]);
        assert!(!args.contains(&"-m".to_string()));
        // O único `-c` de uma retomada sem modelo nem esforço é o do trust.
        assert_eq!(args.iter().filter(|a| *a == "-c").count(), 1);
        assert!(!args.iter().any(|a| a.starts_with("model_reasoning_effort")));
    }

    /// O arquivo que o Codex vai ler, escrito de verdade — e o `hooks` por fora
    /// dos eventos, que é o envelope que ele exige (sem isto ele recusa o
    /// arquivo inteiro com "unknown field `PreToolUse`").
    #[test]
    fn escreve_o_arquivo_no_formato_que_o_codex_le() {
        let path = std::env::temp_dir()
            .join(format!("prometheus-codex-{}.json", std::process::id()))
            .to_path_buf();
        write_hooks(&path, "/apps/prometheus-hook").unwrap();
        let file: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();

        assert!(file["hooks"]["PreToolUse"].is_array());
        let cmd = file["hooks"]["PreToolUse"][0]["hooks"][0]["command"].as_str().unwrap();
        assert_eq!(cmd, "\"/apps/prometheus-hook\" tool");
        assert_eq!(file["hooks"]["PreToolUse"][0]["matcher"], "*");
        std::fs::remove_file(&path).unwrap();
    }

    /// A fala é posicional, então tem de ser o último argumento — antes de
    /// qualquer flag ela viraria valor da flag anterior.
    #[test]
    fn o_worktree_ja_nasce_confiavel() {
        let args = codex_args(Path::new("/tmp/wt"), None, "", "", None);
        assert!(args.contains(&r#"projects."/tmp/wt".trust_level="trusted""#.to_string()));
    }

    #[test]
    fn a_primeira_fala_vai_no_fim() {
        let args = codex_args(Path::new("/tmp/wt"), None, "gpt-5.6-sol", "max", Some("arruma o login"));
        assert_eq!(args.last().unwrap(), "arruma o login");
        let vazia = codex_args(Path::new("/tmp/wt"), None, "", "", Some("   "));
        assert!(vazia.last().unwrap().starts_with("projects."));
    }

    #[test]
    fn instalar_preserva_o_que_era_do_usuario() {
        let user = json!({
            "SessionStart": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "meu-script.sh" }] }],
        });
        let out = merged(&user, "/apps/prometheus-hook");

        let start = out["SessionStart"].as_array().unwrap();
        assert_eq!(start.len(), 2);
        assert_eq!(start[0]["hooks"][0]["command"], "meu-script.sh");
        assert!(start[1]["hooks"][0]["command"].as_str().unwrap().contains("start"));
        assert_eq!(out["Stop"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn instalar_duas_vezes_nao_duplica() {
        let once = merged(&json!({}), "/apps/prometheus-hook");
        let twice = merged(&once, "/apps/prometheus-hook");
        assert_eq!(once, twice);
    }

    #[test]
    fn o_hook_do_app_de_dev_nao_desinstala_o_do_instalado() {
        let installed = merged(&json!({}), "/Applications/Prometheus.app/prometheus-hook");
        let both = merged(&installed, "/dev/target/debug/prometheus-hook");
        assert_eq!(both["Stop"].as_array().unwrap().len(), 2);
    }
}
