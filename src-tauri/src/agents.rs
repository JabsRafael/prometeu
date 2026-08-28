//! Quais agentes esta máquina tem, e o que cada um aceita.
//!
//! São dois CLIs: o `claude` e o `codex`. O lançador só oferece o que está
//! instalado — quem tem um só não pode ver a lista do outro e escolher um modelo
//! que nunca vai rodar.
//!
//! A aba é a mesma nos dois: uma conversa desenhada pelo app, um card, uma nota
//! de atividade, um transcript. O que troca é o processo por trás dela — o
//! `claude -p` falando stream-json (`chat.rs`) ou o `codex app-server` falando
//! JSON-RPC (`codex.rs`), traduzido para as mesmas linhas. Aqui fica só o que
//! é catálogo: quem está instalado, quais modelos o Codex oferece, e o nome
//! que ele dá a cada degrau de esforço.
//!
//! A lista de modelos não está escrita aqui: o CLI mantém o catálogo em
//! `models_cache.json`, e é dele que o lançador tira o que oferecer. Modelo novo
//! da OpenAI aparece no dropdown sem release do Prometheus.

use crate::paths;
use serde_json::Value;
use std::path::PathBuf;

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
pub fn effort(level: &str) -> &str {
    match level.trim() {
        "ultracode" => "ultra",
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ultracode_vira_ultra() {
        assert_eq!(effort("ultracode"), "ultra");
        assert_eq!(effort("max"), "max");
    }
}
