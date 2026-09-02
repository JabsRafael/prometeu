//! O hub de plugins: quais plugins do Claude Code esta máquina conhece, e
//! quais entram nas conversas de cada workspace.
//!
//! Um plugin é um pacote de skill, comando, agente e — o que só ele faz —
//! *hook*: o pedaço de código que o CLI roda antes de cada fala, ao abrir a
//! sessão, depois de cada ferramenta. É o que segura um jeito de trabalhar
//! turno após turno, em vez de depender de a instrução antiga continuar
//! ganhando a atenção do modelo (o caveman é o exemplo: sem o hook de
//! `UserPromptSubmit` reinjetando a regra, ela se dissolve na conversa).
//!
//! Até aqui quem decidia isso era o CLI, e só ele: plugin de escopo `user`
//! entra em toda sessão, em todo workspace, sempre; plugin de escopo de
//! projeto nunca entra, porque o worktree que o Prometheus cria é um caminho
//! que o cadastro do CLI não conhece. Nenhum dos dois é o que se quer — o
//! plugin de revisão de front não tem o que fazer num workspace de Rails, e o
//! que o time combinou para um repositório tem que valer no worktree dele.
//!
//! O hub é a lista de plugins que o Prometheus guarda, e a escolha é do
//! workspace — como o modelo, o esforço e o MCP já são. Na hora de subir a
//! conversa cada escolhido vira um `--plugin-dir` (pasta ou `.zip` desta
//! máquina) ou um `--plugin-url` (um `.zip` na rede): flags de sessão, que não
//! mexem em cadastro nenhum do CLI. Marcar um que o CLI já carrega por conta
//! própria não o carrega duas vezes — a deduplicação é por nome, e é dele.
//!
//! `None` é workspace que nunca escolheu — todo quadro gravado antes disto
//! existir —, e aí nada é passado: vale o que o CLI sempre fez.
//!
//! O cadastro não começa vazio: `plugin_found` lê o que o `claude plugin
//! install` já pôs em `~/.claude/plugins/installed_plugins.json` e oferece
//! para importar. Ninguém recadastra o que já tem.
//!
//! O que o hub não faz: instalar. Quem baixa, descompacta e atualiza plugin é
//! o CLI (ou o `git clone` de quem escreve um). O hub aponta para onde ele
//! está.
//!
//! Vale só no Claude Code, e por ora. O Codex também tem plugin e hook (`codex
//! plugin`, o `hooks` do `plugin.json` dele, o `~/.codex/hooks.json`), mas o
//! caminho é outro: lá não há flag de sessão que aponte para uma pasta — o
//! plugin entra pelo cadastro do próprio CLI. Enquanto isso não for traduzido
//! (como `codex_config` fez com o MCP), workspace de GPT não mostra o seletor:
//! um botão que promete o que não acontece é pior que botão nenhum.

use crate::i18n;
use crate::paths;
use serde_json::Value;
use std::path::{Path, PathBuf};

/// Um plugin como o hub o guarda.
#[derive(serde::Serialize, serde::Deserialize, Clone, PartialEq)]
pub struct Plugin {
    /// O nome do plugin — o mesmo que está no `plugin.json` dele, que é o que
    /// o CLI usa para deduplicar e o que a pessoa lê na lista.
    pub id: String,
    /// De onde ele sai: o caminho de uma pasta (ou de um `.zip`) nesta
    /// máquina, ou a URL de um `.zip`. É o que vira flag na linha de comando.
    pub source: String,
    /// De onde veio, ou para que serve. Livre — é a linha embaixo do nome.
    #[serde(default)]
    pub note: String,
}

/// Onde o cadastro mora. Sem segredo dentro (é caminho e URL), mas fica
/// privado como o resto do `~/.prometheus`.
fn hub_path() -> PathBuf {
    paths::root().join("plugins.json")
}

pub fn load() -> Vec<Plugin> {
    std::fs::read_to_string(hub_path())
        .ok()
        .and_then(|raw| serde_json::from_str::<Vec<Plugin>>(&raw).ok())
        .unwrap_or_default()
}

fn store(plugins: &[Plugin]) -> Result<(), String> {
    let body = serde_json::to_string_pretty(plugins).map_err(|e| e.to_string())?;
    paths::write_private(&hub_path(), &body)
        .map_err(|cause| i18n::ta("err.plugin.save", &[("cause", cause)]))
}

/// O cadastro inteiro, para a tela de Configurações e para os seletores.
#[tauri::command]
pub fn plugin_hub() -> Vec<Plugin> {
    load()
}

/// Grava um plugin — novo, ou por cima do que tinha o mesmo nome. O nome é a
/// identidade: é por ele que o CLI deduplica, e dois plugins com o mesmo nome
/// numa sessão seriam um só de qualquer jeito.
#[tauri::command]
pub fn plugin_save(plugin: Plugin) -> Result<Vec<Plugin>, String> {
    let plugin = Plugin {
        id: plugin.id.trim().to_string(),
        source: plugin.source.trim().to_string(),
        note: plugin.note.trim().to_string(),
    };
    if plugin.id.is_empty() {
        return Err(i18n::t("err.plugin.noName"));
    }
    check_source(&plugin.source)?;
    let mut plugins = load();
    match plugins.iter_mut().find(|p| p.id == plugin.id) {
        Some(old) => *old = plugin,
        None => plugins.push(plugin),
    }
    plugins.sort_by_key(|p| p.id.to_lowercase());
    store(&plugins)?;
    Ok(plugins)
}

#[tauri::command]
pub fn plugin_remove(id: String) -> Result<Vec<Plugin>, String> {
    let mut plugins = load();
    plugins.retain(|p| p.id != id);
    store(&plugins)?;
    Ok(plugins)
}

/// O que uma origem tem que ser para o CLI aceitá-la. Recusar aqui é o que
/// evita a conversa subir sem o plugin e ninguém saber por quê: o
/// `--plugin-dir` de uma pasta que não é plugin some num aviso do CLI que a
/// tela não mostra.
fn check_source(source: &str) -> Result<(), String> {
    if source.is_empty() {
        return Err(i18n::t("err.plugin.noSource"));
    }
    if remote(source) {
        return Ok(());
    }
    let path = PathBuf::from(expand(source));
    if !path.exists() {
        return Err(i18n::ta(
            "err.plugin.noPath",
            &[("path", path.display().to_string())],
        ));
    }
    // Um `.zip` o CLI abre sozinho; uma pasta tem que ser um plugin, e o que
    // diz isso é o manifesto.
    if path.is_dir() && !manifest_path(&path).exists() {
        return Err(i18n::ta(
            "err.plugin.notPlugin",
            &[("path", path.display().to_string())],
        ));
    }
    Ok(())
}

/// O que o Prometheus consegue ler de uma origem antes de gravá-la: o nome e a
/// descrição que o próprio plugin declara. É o que preenche o formulário
/// sozinho — ninguém tem que copiar à mão um nome que já está escrito no
/// disco.
///
/// Origem que não é pasta (um `.zip` daqui, uma URL) não tem manifesto para
/// ler sem baixar: o nome sai do nome do arquivo, e a pessoa corrige se
/// quiser. Origem inválida devolve erro — é o mesmo exame do `plugin_save`,
/// só que antes.
#[tauri::command]
pub fn plugin_look(source: String) -> Result<Plugin, String> {
    let source = source.trim().to_string();
    check_source(&source)?;
    let path = PathBuf::from(expand(&source));
    let manifest = (!remote(&source) && path.is_dir())
        .then(|| read_json(&manifest_path(&path)))
        .flatten();
    let text = |key: &str| {
        manifest
            .as_ref()
            .and_then(|m| m.get(key))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    let id = match text("name") {
        name if !name.is_empty() => name,
        _ => guessed_name(&source),
    };
    Ok(Plugin {
        id,
        source,
        note: text("description"),
    })
}

/// O nome de um `.zip` (daqui ou da rede) sem a extensão. Palpite, e só: quem
/// manda é o `plugin.json` de dentro, que só o CLI vai ler.
fn guessed_name(source: &str) -> String {
    source
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or_default()
        .trim_end_matches(".zip")
        .to_string()
}

/// O que dá para importar: o que o `claude plugin install` já pôs nesta
/// máquina e ainda não está no hub. Não mexe em arquivo nenhum do usuário —
/// só lê.
#[tauri::command]
pub fn plugin_found() -> Vec<Plugin> {
    let known = load();
    let mut found: Vec<Plugin> = Vec::new();
    for plugin in installed() {
        if known.iter().any(|p| p.id == plugin.id) || found.iter().any(|p| p.id == plugin.id) {
            continue;
        }
        found.push(plugin);
    }
    found
}

/// O `installed_plugins.json` do CLI: para cada `nome@marketplace`, onde cada
/// instalação dele mora. O nome antes do `@` é o nome do plugin; o depois é a
/// origem, que a tela mostra embaixo. Mais de uma instalação do mesmo plugin é
/// a mais nova primeiro — é a que o CLI usaria.
fn installed() -> Vec<Plugin> {
    let path = paths::home()
        .join(".claude")
        .join("plugins")
        .join("installed_plugins.json");
    let Some(root) = read_json(&path) else {
        return vec![];
    };
    let Some(plugins) = root.get("plugins").and_then(Value::as_object) else {
        return vec![];
    };
    let mut out = Vec::new();
    for (key, installs) in plugins {
        let (name, market) = key.split_once('@').unwrap_or((key.as_str(), ""));
        let newest = installs
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|install| {
                let path = install.get("installPath").and_then(Value::as_str)?;
                let when = install
                    .get("lastUpdated")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                Some((when.to_string(), path.to_string()))
            })
            .max();
        if let Some((_, source)) = newest {
            out.push(Plugin {
                id: name.to_string(),
                source,
                note: market.to_string(),
            });
        }
    }
    out.sort_by_key(|p| p.id.to_lowercase());
    out
}

/// As flags desta sessão: um par por plugin escolhido que o hub ainda tem.
/// Plugin apagado do hub depois de escolhido some da sessão em vez de
/// derrubá-la — a mesma regra do MCP, e pelo mesmo motivo.
///
/// `None` é workspace que nunca escolheu, e aí nada é passado.
pub fn args_for(chosen: Option<&Vec<String>>) -> Vec<String> {
    match chosen {
        Some(chosen) => args_from(&load(), chosen),
        None => vec![],
    }
}

/// A tradução em si, com o hub na mão — parâmetro, e não chamada direta, para
/// o teste dela não depender de arquivo nenhum.
fn args_from(hub: &[Plugin], chosen: &[String]) -> Vec<String> {
    chosen
        .iter()
        .filter_map(|name| hub.iter().find(|p| &p.id == name))
        .flat_map(flags)
        .collect()
}

/// A flag de um plugin. `--plugin-url` para o que está na rede,
/// `--plugin-dir` para o que está no disco — e o `~` vira caminho aqui, e não
/// no cadastro: quem digitou `~/plugins/x` quis dizer a casa desta máquina.
fn flags(plugin: &Plugin) -> [String; 2] {
    let source = plugin.source.trim();
    if remote(source) {
        ["--plugin-url".to_string(), source.to_string()]
    } else {
        ["--plugin-dir".to_string(), expand(source)]
    }
}

fn remote(source: &str) -> bool {
    source.starts_with("http://") || source.starts_with("https://")
}

fn manifest_path(dir: &Path) -> PathBuf {
    dir.join(".claude-plugin").join("plugin.json")
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

fn expand(source: &str) -> String {
    match source.strip_prefix("~/") {
        Some(rest) => paths::home().join(rest).display().to_string(),
        None => source.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plugin(id: &str, source: &str) -> Plugin {
        Plugin {
            id: id.into(),
            source: source.into(),
            note: String::new(),
        }
    }

    /// Pasta vira `--plugin-dir`, endereço vira `--plugin-url`. É a única
    /// diferença entre os dois, e é ela que decide se o CLI baixa alguma coisa.
    #[test]
    fn a_origem_decide_a_flag() {
        assert_eq!(
            flags(&plugin("caveman", "/opt/caveman")),
            ["--plugin-dir".to_string(), "/opt/caveman".to_string()]
        );
        assert_eq!(
            flags(&plugin("x", "https://exemplo.com/x.zip")),
            [
                "--plugin-url".to_string(),
                "https://exemplo.com/x.zip".to_string()
            ]
        );
    }

    /// O `~` é da casa desta máquina, e quem o resolve é o app — o `claude`
    /// recebe caminho inteiro, que é o que ele entende.
    #[test]
    fn o_til_vira_caminho() {
        let [_, path] = flags(&plugin("x", "~/plugins/x"));
        assert_eq!(path, paths::home().join("plugins/x").display().to_string());
        assert!(!path.starts_with('~'));
    }

    /// A linha de comando de uma escolha: um par por plugin marcado, na ordem
    /// em que foram marcados. Nome que já não está no hub (apagado depois de
    /// escolhido) some da linha em vez de derrubar a conversa — o que o agente
    /// perde é um plugin, e dizer isso é trabalho da tela.
    #[test]
    fn a_escolha_vira_linha_de_comando() {
        let hub = vec![
            plugin("caveman", "/opt/caveman"),
            plugin("ponytail", "https://exemplo.com/ponytail.zip"),
        ];
        let chosen = ["ponytail".to_string(), "apagado".into(), "caveman".into()];
        assert_eq!(
            args_from(&hub, &chosen),
            [
                "--plugin-url",
                "https://exemplo.com/ponytail.zip",
                "--plugin-dir",
                "/opt/caveman",
            ]
        );
        // Marcar nenhum é escolha, e não vira flag nenhuma.
        assert!(args_from(&hub, &[]).is_empty());
    }

    /// Nome vazio não grava: é a identidade do plugin, e o CLI dedupe por ele.
    #[test]
    fn sem_nome_nao_grava() {
        assert!(plugin_save(plugin("  ", "/opt/x")).is_err());
    }

    /// Pasta que não é plugin é recusada no cadastro, e não descoberta no
    /// silêncio de uma sessão que subiu sem ele.
    #[test]
    fn pasta_sem_manifesto_e_recusada() {
        let dir = std::env::temp_dir().join(format!("prometheus-plug-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(check_source(&dir.display().to_string()).is_err());

        std::fs::create_dir_all(dir.join(".claude-plugin")).unwrap();
        std::fs::write(
            dir.join(".claude-plugin").join("plugin.json"),
            r#"{"name":"exemplo","description":"o que ele faz"}"#,
        )
        .unwrap();
        assert!(check_source(&dir.display().to_string()).is_ok());

        // E o manifesto é quem preenche o formulário.
        let looked = plugin_look(dir.display().to_string()).unwrap();
        assert_eq!(looked.id, "exemplo");
        assert_eq!(looked.note, "o que ele faz");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Caminho que não existe também é recusado — cadastrar aponta para algo.
    #[test]
    fn caminho_que_nao_existe_e_recusado() {
        assert!(check_source("/nao/existe/plugin").is_err());
        assert!(check_source("https://exemplo.com/x.zip").is_ok());
    }

    /// `.zip` sem manifesto para ler ganha o nome do arquivo como palpite.
    #[test]
    fn zip_ganha_o_nome_do_arquivo() {
        assert_eq!(guessed_name("https://exemplo.com/caveman.zip"), "caveman");
        assert_eq!(guessed_name("/tmp/meu-plugin.zip"), "meu-plugin");
    }
}
