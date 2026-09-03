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
//! Instalar é daqui, e não de fora. `plugin_install` recebe o endereço de um
//! repositório — `github.com/JuliusBrussee/caveman`, ou só o
//! `JuliusBrussee/caveman` —, clona em `~/.prometheus/plugins/` e cadastra o
//! que veio dentro: o próprio repositório, quando ele é o plugin, ou os
//! plugins que o `marketplace.json` dele lista. Depois é `plugin_update`, que
//! é o `git pull` da mesma pasta. Ninguém precisa instalar nada no CLI antes —
//! era isso que fazia o plugin ser um assunto de fora do app.
//!
//! `plugin_make` é o outro caminho, para o plugin que ainda não existe: um
//! agente de uma pergunta só escreve o manifesto, as skills e os hooks numa
//! pasta do mesmo lugar.
//!
//! Cadastrar à mão continua existindo, para o plugin que alguém escreve num
//! repositório seu: aí a origem é a pasta dele, e quem a atualiza é quem a
//! escreve.
//!
//! Vale só no Claude Code, e por ora. O Codex também tem plugin e hook (`codex
//! plugin`, o `hooks` do `plugin.json` dele, o `~/.codex/hooks.json`), mas o
//! caminho é outro: lá não há flag de sessão que aponte para uma pasta — o
//! plugin entra pelo cadastro do próprio CLI. Enquanto isso não for traduzido
//! (como `codex_config` fez com o MCP), workspace de GPT não mostra o seletor:
//! um botão que promete o que não acontece é pior que botão nenhum.

use crate::i18n;
use crate::lock::lock;
use crate::paths;
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

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
    /// Se a pasta dele é do Prometheus — quer dizer, se o app a clonou ou a
    /// escreveu. É o que decide se remover apaga arquivo ou só tira da lista:
    /// pasta que alguém escreveu não é do app para apagar.
    #[serde(default)]
    pub made: bool,
    /// O endereço de onde ele veio, quando veio de um. É o que a lista mostra
    /// embaixo do nome e o que dá sentido ao botão de atualizar.
    #[serde(default)]
    pub from: String,
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

fn write_hub(plugins: &[Plugin]) -> Result<(), String> {
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
        made: plugin.made,
        from: plugin.from.trim().to_string(),
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
    write_hub(&plugins)?;
    Ok(plugins)
}

/// Tira do cadastro — e apaga a pasta, se ela for a que o Prometheus criou:
/// ela só existe por causa deste cadastro, e deixá-la seria guardar no escuro
/// o que a tela já não mostra. Plugin cadastrado à mão só sai da lista; a
/// pasta é de quem a escreveu.
#[tauri::command]
pub fn plugin_remove(id: String) -> Result<Vec<Plugin>, String> {
    let mut plugins = load();
    if let Some(gone) = plugins.iter().find(|p| p.id == id) {
        let dir = PathBuf::from(expand(&gone.source));
        if gone.made && dir.starts_with(store()) && dir != store() {
            std::fs::remove_dir_all(&dir).ok();
        }
    }
    plugins.retain(|p| p.id != id);
    write_hub(&plugins)?;
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
        made: false,
        from: String::new(),
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

/* ---------- instalar o que já existe ---------- */

/// O que um endereço trouxe: a pasta que o clone ocupa, e os plugins que
/// vieram dentro dela. Um só é o caso comum — o repositório *é* o plugin, e ele
/// já entra no hub aqui mesmo (`saved`). Mais de um é um marketplace, e aí
/// quem escolhe é quem instalou; até escolher, nada foi cadastrado.
#[derive(serde::Serialize)]
pub struct Found {
    pub dir: String,
    pub plugins: Vec<Plugin>,
    pub saved: bool,
}

/// Instala: clona o repositório numa pasta do Prometheus e olha o que veio.
/// É `async` porque clonar leva segundos, e a janela não pode parar enquanto
/// isso acontece.
#[tauri::command(async)]
pub fn plugin_install(source: String) -> Result<Found, String> {
    let url = git_url(&source);
    if url.is_empty() {
        return Err(i18n::t("err.plugin.noSource"));
    }
    let dir = store().join(repo_name(&url));
    if dir.exists() {
        // Pasta ocupada: se algum plugin do hub mora nela, o que se quer é
        // atualizar, e não instalar de novo. Se não mora ninguém, é sobra de
        // uma escolha que ninguém terminou, e pode sair da frente.
        if lives_in(&dir) {
            return Err(i18n::ta("err.plugin.exists", &[("name", repo_name(&url))]));
        }
        std::fs::remove_dir_all(&dir).ok();
    }
    std::fs::create_dir_all(store())
        .map_err(|e| i18n::ta("err.plugin.clone", &[("cause", e.to_string())]))?;
    clone(&url, &dir)?;
    let plugins = plugins_in(&dir, &url);
    if plugins.is_empty() {
        std::fs::remove_dir_all(&dir).ok();
        return Err(i18n::ta("err.plugin.noPluginIn", &[("url", url)]));
    }
    // Um plugin só não é escolha: instalar já é dizer que se quer aquele.
    let saved = plugins.len() == 1;
    if saved {
        plugin_save(plugins[0].clone())?;
    }
    Ok(Found {
        dir: dir.display().to_string(),
        plugins,
        saved,
    })
}

/// Desfaz o clone que ninguém escolheu — a folha fechada sem marcar nada. Só
/// apaga dentro da pasta do Prometheus, e só o que não está no hub.
#[tauri::command]
pub fn plugin_scrap(dir: String) {
    let dir = PathBuf::from(expand(&dir));
    if dir.starts_with(store()) && dir != store() && !lives_in(&dir) {
        std::fs::remove_dir_all(&dir).ok();
    }
}

/// Atualizar é o `git pull` da pasta que o Prometheus clonou, e só
/// `--ff-only`: se alguém mexeu no plugin à mão, o certo é dizer que não deu,
/// e não desmanchar o que a pessoa escreveu. A descrição é relida depois — é
/// dela que sai a linha embaixo do nome, e ela envelhece junto com o plugin.
#[tauri::command(async)]
pub fn plugin_update(id: String) -> Result<Vec<Plugin>, String> {
    let plugin = load()
        .into_iter()
        .find(|p| p.id == id)
        .ok_or_else(|| i18n::t("err.plugin.gone"))?;
    let dir = PathBuf::from(expand(&plugin.source));
    let root = git_root(&dir).ok_or_else(|| i18n::t("err.plugin.noGit"))?;
    let out = git(&root, &["pull", "--ff-only", "-q"])?;
    if !out.status.success() {
        return Err(i18n::ta(
            "err.plugin.pull",
            &[("cause", last_line(&String::from_utf8_lossy(&out.stderr)))],
        ));
    }
    let fresh = read_plugin(&dir, &plugin.from);
    if fresh.id == plugin.id {
        return plugin_save(fresh);
    }
    Ok(load())
}

/// Algum plugin do hub mora nesta pasta?
fn lives_in(dir: &Path) -> bool {
    load()
        .iter()
        .any(|p| PathBuf::from(expand(&p.source)).starts_with(dir))
}

/// O que a pessoa cola virando endereço de clone. `owner/repo` é GitHub,
/// porque é de lá que vem quase todo plugin; o resto vai como veio, e é assim
/// que GitLab, Bitbucket e `git@…` funcionam sem o app saber deles. O
/// `/tree/branch` que o navegador põe na barra some: o que se clona é o
/// repositório.
fn git_url(source: &str) -> String {
    let mut text = source.trim().trim_end_matches('/');
    if let Some(cut) = text.find("/tree/") {
        text = &text[..cut];
    }
    let bare = text
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_start_matches("www.");
    if text.contains("://") || text.contains('@') {
        return text.to_string();
    }
    let path = bare.strip_prefix("github.com/").unwrap_or(bare);
    // `owner/repo`, e nada mais: qualquer outra coisa não é endereço nenhum.
    let parts: Vec<&str> = path.split('/').filter(|p| !p.is_empty()).collect();
    match parts.as_slice() {
        [owner, repo] => format!("https://github.com/{owner}/{repo}"),
        _ => String::new(),
    }
}

/// O nome da pasta que o clone vai ocupar: o do repositório.
fn repo_name(url: &str) -> String {
    let name = url
        .trim_end_matches('/')
        .rsplit(['/', ':'])
        .next()
        .unwrap_or_default()
        .trim_end_matches(".git");
    slug(name)
}

/// O clone. `--depth 1` porque ninguém quer o histórico de um plugin, e sem
/// terminal nenhum: git que pede senha numa janela sem terminal ficaria
/// pendurado para sempre — melhor falhar e dizer que o repositório é privado.
fn clone(url: &str, dir: &Path) -> Result<(), String> {
    let out = Command::new("git")
        .args(["clone", "--depth", "1", "-q", url])
        .arg(dir)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_SSH_COMMAND", "ssh -oBatchMode=yes")
        .output()
        .map_err(|e| i18n::ta("err.plugin.clone", &[("cause", e.to_string())]))?;
    if out.status.success() {
        return Ok(());
    }
    std::fs::remove_dir_all(dir).ok();
    Err(i18n::ta(
        "err.plugin.clone",
        &[("cause", last_line(&String::from_utf8_lossy(&out.stderr)))],
    ))
}

fn git(root: &Path, args: &[&str]) -> Result<std::process::Output, String> {
    Command::new("git")
        .current_dir(root)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_SSH_COMMAND", "ssh -oBatchMode=yes")
        .output()
        .map_err(|e| i18n::ta("err.plugin.pull", &[("cause", e.to_string())]))
}

/// De qual clone esta pasta faz parte. Um plugin de marketplace mora numa
/// subpasta, e quem tem `.git` é a raiz do clone — é ela que o `pull` puxa.
fn git_root(dir: &Path) -> Option<PathBuf> {
    let mut at = dir;
    loop {
        if at.join(".git").exists() {
            return Some(at.to_path_buf());
        }
        at = at.parent()?;
        if !at.starts_with(store()) {
            return None;
        }
    }
}

/// O erro do git tem parágrafos; o que interessa é a última linha, que é a que
/// diz o que houve.
fn last_line(text: &str) -> String {
    text.trim()
        .lines()
        .rev()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or_default()
        .to_string()
}

/// O que veio no clone. Um `plugin.json` na raiz é o caso comum: o repositório
/// é o plugin. Um `marketplace.json` é uma lista, e dela vale o que mora neste
/// mesmo clone (`"./plugins/x"`) — entrada que aponta para outro repositório é
/// outra instalação, pelo endereço dela. Sem nenhum dos dois, ainda se olha uma
/// pasta abaixo: repositório que guarda plugins em `plugins/` e não declara
/// nada é comum o bastante para não obrigar ninguém a saber disso.
fn plugins_in(dir: &Path, from: &str) -> Vec<Plugin> {
    if manifest_path(dir).exists() {
        return vec![read_plugin(dir, from)];
    }
    let mut found: Vec<Plugin> = Vec::new();
    let market = read_json(&dir.join(".claude-plugin").join("marketplace.json"));
    for entry in market
        .as_ref()
        .and_then(|m| m.get("plugins"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(rel) = entry.get("source").and_then(Value::as_str) else {
            continue;
        };
        if let Some(at) = within(dir, rel) {
            if manifest_path(&at).exists() {
                found.push(read_plugin(&at, from));
            }
        }
    }
    if found.is_empty() {
        found = scan(dir, from);
    }
    found.sort_by_key(|p| p.id.to_lowercase());
    found.dedup_by(|a, b| a.source == b.source);
    found
}

/// Uma pasta abaixo, e a de `plugins/` também: o suficiente para achar o que um
/// repositório sem manifesto na raiz guarda, sem sair varrendo o clone inteiro.
fn scan(dir: &Path, from: &str) -> Vec<Plugin> {
    let mut found = Vec::new();
    for root in [dir.to_path_buf(), dir.join("plugins")] {
        let Ok(entries) = std::fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.flatten() {
            let at = entry.path();
            if at.is_dir() && manifest_path(&at).exists() {
                found.push(read_plugin(&at, from));
            }
        }
    }
    found
}

/// Um caminho do `marketplace.json` resolvido dentro do clone. `..` não passa:
/// o que um repositório de fora escreve não pode apontar para outro lugar do
/// disco.
fn within(dir: &Path, rel: &str) -> Option<PathBuf> {
    let rel = rel.trim().trim_start_matches("./");
    if rel.is_empty() {
        return Some(dir.to_path_buf());
    }
    let at = dir.join(rel);
    (!rel.starts_with('/') && !at.components().any(|c| c.as_os_str() == "..")).then_some(at)
}

/// O plugin como o hub o guarda, lido do manifesto dele. Sem `name` no
/// manifesto vale o nome da pasta — que é o que o CLI também faria.
fn read_plugin(dir: &Path, from: &str) -> Plugin {
    let manifest = read_json(&manifest_path(dir));
    let text = |key: &str| {
        manifest
            .as_ref()
            .and_then(|m| m.get(key))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string()
    };
    let id = match text("name") {
        name if !name.is_empty() => name,
        _ => dir
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default()
            .to_string(),
    };
    Plugin {
        id,
        source: dir.display().to_string(),
        note: text("description"),
        made: true,
        from: from.to_string(),
    }
}

/* ---------- criar um plugin aqui dentro ---------- */

/// A pasta de que o Prometheus é dono: um plugin por subpasta, com o nome
/// dele. Fora dela ficam os que alguém escreve num repositório seu e cadastra
/// à mão — e é por isso que remover só apaga arquivo quando o plugin nasceu
/// aqui.
pub fn store() -> PathBuf {
    paths::root().join("plugins")
}

/// Quem escreve o plugin não é o nomeador: aqui saem frontmatter e JSON que o
/// CLI vai ler, e manifesto torto é plugin que não carrega em lugar nenhum.
/// `sonnet` é alias, e alias não envelhece.
const MAKER_MODEL: &str = "sonnet";

/// Teto de uma criação. Passou disto algo travou — e um `claude` esquecido
/// continuaria escrevendo numa pasta que ninguém está mais olhando.
const MAKER_TIMEOUT: Duration = Duration::from_secs(600);

/// Pedido maior que isto não é o que um plugin faz — é um projeto.
const MAX_ASK: usize = 4000;

/// Linha de progresso não é parágrafo.
const MAX_STEP: usize = 140;

/// O que o agente que escreve o plugin precisa saber e não adivinha: o nome de
/// cada arquivo, o que vai no frontmatter de cada um, e como um hook aponta
/// para o script dele em qualquer máquina. O pedido da pessoa vai depois
/// disto, como prompt — este texto é o que impede que ele vire um projeto de
/// software em vez de um plugin.
const MAKER: &str = r#"Você escreve um plugin do Claude Code, do zero, dentro da pasta em que está — e nada além disso.

O formato, que é o que o CLI vai ler:

- `.claude-plugin/plugin.json`, obrigatório: {"name": "<NOME>", "description": "…", "version": "0.1.0"}. O `name` tem que ser exatamente <NOME>.
- `skills/<assunto>/SKILL.md`: a instrução que o agente carrega quando o assunto aparece. Frontmatter YAML com `name` e `description`; é a `description` que decide se a skill é carregada, então diga nela quando usar.
- `commands/<nome>.md`: um comando de barra. Frontmatter opcional com `description` e `argument-hint`; o corpo é o prompt, e `$ARGUMENTS` recebe o que a pessoa escreveu depois do comando.
- `agents/<nome>.md`: um subagente. Frontmatter com `name`, `description` e, se for o caso, `tools`.
- `hooks/hooks.json`: o que roda sozinho, turno após turno, sem depender da atenção do modelo. Formato:
  {"hooks": {"UserPromptSubmit": [{"hooks": [{"type": "command", "command": "sh ${CLAUDE_PLUGIN_ROOT}/hooks/nome.sh"}]}]}}
  Os eventos são PreToolUse, PostToolUse, UserPromptSubmit, SessionStart, SessionEnd, Stop, SubagentStop, PreCompact e Notification; PreToolUse e PostToolUse aceitam `matcher` com o nome da ferramenta. O script recebe um JSON no stdin, e o que ele escreve no stdout de UserPromptSubmit e de SessionStart entra na conversa como contexto. Chame todo script por `sh` ou por `python3` — nunca conte com bit de execução. `${CLAUDE_PLUGIN_ROOT}` é a pasta do plugin em qualquer máquina: nunca escreva caminho absoluto.

Escreva só o que o pedido pede: um plugin de uma skill é uma skill, e não um pacote de exemplos. Nada de README, LICENSE, .gitignore, teste ou CHANGELOG. Não rode comando, não instale nada, não use a rede. Ao terminar, responda em uma linha só o que o plugin faz."#;

/// Uma linha de progresso. `file` é um arquivo que ele acabou de escrever;
/// `say` é o que ele mesmo disse. O back não escreve frase: a de fora de um é
/// a tela que põe, e o outro é palavra do agente, que fica como veio.
#[derive(Clone, serde::Serialize)]
pub struct Step {
    pub kind: String,
    pub text: String,
}

/// O que a tela precisa para acompanhar uma criação: por onde os eventos vêm,
/// e o nome que a pasta levou.
#[derive(serde::Serialize)]
pub struct Make {
    pub run: u64,
    pub slug: String,
}

/// Os agentes que estão escrevendo agora, por corrida. É o que deixa cancelar
/// — e o teto de tempo matar — sem que uma corrida velha derrube a nova.
fn running() -> &'static Mutex<HashMap<u64, Child>> {
    static RUNS: OnceLock<Mutex<HashMap<u64, Child>>> = OnceLock::new();
    RUNS.get_or_init(Default::default)
}

fn next_run() -> u64 {
    static SEQ: AtomicU64 = AtomicU64::new(1);
    SEQ.fetch_add(1, Ordering::Relaxed)
}

/// Cria um plugin e volta na hora: escrever leva minutos, e quem clicou
/// precisa ver a folha andar. O que acontece depois chega por `plugin-make`
/// (cada passo) e `plugin-made` (o fim, com o erro dentro se houve).
#[tauri::command]
pub fn plugin_make(app: AppHandle, name: String, ask: String) -> Result<Make, String> {
    let slug = slug(&name);
    let ask: String = ask.trim().chars().take(MAX_ASK).collect();
    if slug.is_empty() {
        return Err(i18n::t("err.plugin.noName"));
    }
    if ask.is_empty() {
        return Err(i18n::t("err.plugin.noAsk"));
    }
    let dir = store().join(&slug);
    if dir.exists() || load().iter().any(|p| p.id == slug) {
        return Err(i18n::ta("err.plugin.exists", &[("name", slug)]));
    }
    std::fs::create_dir_all(&dir)
        .map_err(|e| i18n::ta("err.plugin.make", &[("cause", e.to_string())]))?;
    let run = next_run();
    let (slug, place) = (slug, dir.clone());
    let mine = slug.clone();
    std::thread::spawn(move || {
        let end = make(&app, run, &place, &mine, &ask);
        // Pasta que não virou plugin não fica: o hub não a mostraria, e uma
        // pasta que ninguém acha é lixo que só cresce.
        if end.is_err() {
            std::fs::remove_dir_all(&place).ok();
        }
        let _ = app.emit("plugin-made", (run, end.err().unwrap_or_default()));
    });
    Ok(Make { run, slug })
}

/// Cancelar. O processo morre, o `for` das linhas acaba com o stdout fechado,
/// e o fim de `make` trata isso como qualquer outra saída ruim — inclusive
/// apagando a pasta pela metade.
#[tauri::command]
pub fn plugin_make_stop(run: u64) {
    stop(run);
}

fn stop(run: u64) {
    if let Some(mut child) = lock(running()).remove(&run) {
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// A criação em si: um `claude -p` dentro da pasta nova, com as ferramentas de
/// arquivo e nada mais — sem os hooks e os plugins de quem está usando o app
/// (que aqui só atrapalhariam), sem MCP, e sem poder rodar comando. O que ele
/// escreve fora da pasta o CLI não aceita sozinho, e em `-p` não há ninguém
/// para aceitar.
fn make(app: &AppHandle, run: u64, dir: &Path, slug: &str, ask: &str) -> Result<(), String> {
    let mut cmd = Command::new("claude");
    cmd.args([
        "-p",
        "--model",
        MAKER_MODEL,
        "--setting-sources",
        "",
        "--strict-mcp-config",
        "--mcp-config",
        r#"{"mcpServers":{}}"#,
        "--permission-mode",
        "acceptEdits",
        "--allowedTools",
        "Read Write Edit Glob Grep",
        "--output-format",
        "stream-json",
        "--verbose",
        "--system-prompt",
    ]);
    cmd.arg(MAKER.replace("<NOME>", slug));
    cmd.arg(ask);
    cmd.current_dir(dir);
    // Mesma razão do nomeador: um `claude` rodando dentro de outro herda
    // CLAUDE_CODE_CHILD_SESSION e companhia, e o que ele herda não é dele.
    for (k, _) in std::env::vars() {
        if k.starts_with("CLAUDE") {
            cmd.env_remove(k);
        }
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());

    let mut child = cmd
        .spawn()
        .map_err(|e| i18n::ta("err.plugin.make", &[("cause", e.to_string())]))?;
    let out = child.stdout.take();
    lock(running()).insert(run, child);
    watch(run);
    if let Some(out) = out {
        for line in BufReader::new(out).lines().map_while(Result::ok) {
            if let Some(step) = step(dir, &line) {
                let _ = app.emit("plugin-make", (run, step));
            }
        }
    }
    let ended = lock(running())
        .remove(&run)
        .and_then(|mut child| child.wait().ok())
        .map(|status| status.success())
        .unwrap_or(false);
    if !ended {
        return Err(i18n::t("err.plugin.make.failed"));
    }
    born(dir, slug)
}

/// O teto de tempo de uma corrida, numa thread que só dorme. Corrida que
/// acabou já saiu do mapa, e aí isto não faz nada.
fn watch(run: u64) {
    std::thread::spawn(move || {
        std::thread::sleep(MAKER_TIMEOUT);
        stop(run);
    });
}

/// O que nasceu na pasta só é plugin se o manifesto estiver lá e for legível —
/// e é o próprio manifesto que diz o nome e a descrição que vão para o hub,
/// como em qualquer plugin cadastrado à mão.
fn born(dir: &Path, slug: &str) -> Result<(), String> {
    let manifest =
        read_json(&manifest_path(dir)).ok_or_else(|| i18n::t("err.plugin.made.empty"))?;
    let text = |key: &str| {
        manifest
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string()
    };
    let id = match text("name") {
        name if !name.is_empty() => name,
        _ => slug.to_string(),
    };
    plugin_save(Plugin {
        id,
        source: dir.display().to_string(),
        note: text("description"),
        made: true,
        from: String::new(),
    })?;
    Ok(())
}

/// Uma linha do `stream-json` virando o que a tela mostra: o arquivo que ele
/// acabou de escrever, ou a frase que ele disse. O resto do stream — o que ele
/// leu, o que gastou, o resultado — não é progresso para ninguém.
fn step(dir: &Path, line: &str) -> Option<Step> {
    let value: Value = serde_json::from_str(line).ok()?;
    if value.get("type").and_then(Value::as_str)? != "assistant" {
        return None;
    }
    for item in value.get("message")?.get("content")?.as_array()? {
        match item.get("type").and_then(Value::as_str) {
            Some("tool_use") => {
                let wrote = matches!(
                    item.get("name").and_then(Value::as_str),
                    Some("Write") | Some("Edit")
                );
                let path = item
                    .get("input")
                    .and_then(|input| input.get("file_path"))
                    .and_then(Value::as_str);
                if let (true, Some(path)) = (wrote, path) {
                    return Some(Step {
                        kind: "file".into(),
                        text: inside(dir, path),
                    });
                }
            }
            Some("text") => {
                let said = item.get("text").and_then(Value::as_str).unwrap_or_default();
                if let Some(first) = said.lines().map(str::trim).find(|l| !l.is_empty()) {
                    return Some(Step {
                        kind: "say".into(),
                        text: first.chars().take(MAX_STEP).collect(),
                    });
                }
            }
            _ => {}
        }
    }
    None
}

/// O caminho como ele vale dentro do plugin. O agente escreve caminho inteiro,
/// e o que interessa na tela é `skills/x/SKILL.md`.
fn inside(dir: &Path, path: &str) -> String {
    Path::new(path)
        .strip_prefix(dir)
        .unwrap_or(Path::new(path))
        .display()
        .to_string()
}

/// O nome vira pasta e vira plugin: minúsculas, sem acento e sem espaço,
/// porque é ele que vai para o disco e para a linha de comando do CLI. O
/// acento cai em cima da letra que ele acentua — "revisão" é "revisao", e não
/// "revis-o".
fn slug(name: &str) -> String {
    let mut out = String::new();
    for ch in name.trim().to_lowercase().chars().map(fold) {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
    }
    out.trim_matches('-').to_string()
}

/// O acento cai em cima da letra que ele acentua. Não é normalização de
/// Unicode inteira — é o que um nome de plugin em português e espanhol traz.
fn fold(ch: char) -> char {
    match ch {
        'á' | 'à' | 'â' | 'ã' | 'ä' => 'a',
        'é' | 'è' | 'ê' | 'ë' => 'e',
        'í' | 'ì' | 'î' | 'ï' => 'i',
        'ó' | 'ò' | 'ô' | 'õ' | 'ö' => 'o',
        'ú' | 'ù' | 'û' | 'ü' => 'u',
        'ç' => 'c',
        'ñ' => 'n',
        other => other,
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
            made: false,
            from: String::new(),
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

    /// O que a pessoa cola na caixa vira endereço de clone: o que o navegador
    /// dá, o `owner/repo` que se diz em voz alta, e o endereço de git de
    /// qualquer outro servidor.
    #[test]
    fn o_endereco_colado_vira_clone() {
        let git = "https://github.com/JuliusBrussee/caveman";
        assert_eq!(git_url("JuliusBrussee/caveman"), git);
        assert_eq!(git_url("github.com/JuliusBrussee/caveman"), git);
        assert_eq!(git_url("https://github.com/JuliusBrussee/caveman/"), git);
        assert_eq!(
            git_url("https://github.com/JuliusBrussee/caveman/tree/main"),
            git
        );
        // O que já é endereço de git vai como veio.
        assert_eq!(
            git_url("git@github.com:dietrichgebert/ponytail.git"),
            "git@github.com:dietrichgebert/ponytail.git"
        );
        assert_eq!(
            git_url("https://gitlab.com/time/x.git"),
            "https://gitlab.com/time/x.git"
        );
        // E o que não é endereço nenhum não vira um.
        assert!(git_url("  ").is_empty());
        assert!(git_url("caveman").is_empty());
    }

    /// A pasta do clone tem o nome do repositório, com ou sem `.git`.
    #[test]
    fn a_pasta_tem_o_nome_do_repositorio() {
        assert_eq!(
            repo_name("https://github.com/JuliusBrussee/caveman"),
            "caveman"
        );
        assert_eq!(
            repo_name("git@github.com:dietrichgebert/ponytail.git"),
            "ponytail"
        );
    }

    /// O que o clone traz: o repositório que é o plugin, o marketplace que
    /// lista os do mesmo clone, e o repositório que só tem uma pasta `plugins`.
    /// Entrada que aponta para outro repositório não é deste clone, e fica de
    /// fora — instalá-la é instalar o endereço dela.
    #[test]
    fn o_clone_diz_quais_plugins_vieram() {
        let root = std::env::temp_dir().join(format!("prometheus-inst-{}", uuid::Uuid::new_v4()));
        let manifest = |at: &Path, name: &str| {
            std::fs::create_dir_all(at.join(".claude-plugin")).unwrap();
            std::fs::write(
                at.join(".claude-plugin").join("plugin.json"),
                format!(r#"{{"name":"{name}","description":"o que ele faz"}}"#),
            )
            .unwrap();
        };

        // O repositório é o plugin.
        let one = root.join("um");
        manifest(&one, "caveman");
        let found = plugins_in(&one, "https://exemplo/caveman");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, "caveman");
        assert_eq!(found[0].note, "o que ele faz");
        assert!(found[0].made);
        assert_eq!(found[0].from, "https://exemplo/caveman");

        // Um marketplace, com um plugin daqui e um de outro repositório.
        let many = root.join("muitos");
        manifest(&many.join("plugins").join("a"), "a");
        manifest(&many.join("plugins").join("b"), "b");
        std::fs::create_dir_all(many.join(".claude-plugin")).unwrap();
        std::fs::write(
            many.join(".claude-plugin").join("marketplace.json"),
            r#"{"plugins":[{"name":"a","source":"./plugins/a"},{"name":"fora","source":{"source":"git-subdir","url":"https://exemplo/outro.git"}}]}"#,
        )
        .unwrap();
        let found = plugins_in(&many, "https://exemplo/muitos");
        assert_eq!(
            found.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(),
            ["a"]
        );

        // Sem manifesto e sem marketplace, uma pasta abaixo ainda é achada.
        let loose = root.join("solto");
        manifest(&loose.join("plugins").join("c"), "c");
        assert_eq!(
            plugins_in(&loose, "")
                .iter()
                .map(|p| p.id.as_str())
                .collect::<Vec<_>>(),
            ["c"]
        );

        // E o que não tem plugin nenhum não devolve nada.
        std::fs::create_dir_all(root.join("vazio")).unwrap();
        assert!(plugins_in(&root.join("vazio"), "").is_empty());
        std::fs::remove_dir_all(&root).ok();
    }

    /// A instalação de verdade, contra o GitHub: clona, acha o plugin na raiz
    /// e cadastra. Fica `ignore` porque depende de rede e do endereço continuar
    /// existindo — `cargo test -- --ignored instala_de_verdade` quando se mexe
    /// no clone ou na leitura do manifesto.
    #[test]
    #[ignore]
    fn instala_de_verdade() {
        let root = std::env::temp_dir().join(format!("prometheus-net-{}", uuid::Uuid::new_v4()));
        // Só este teste roda quando se pede `--ignored`; o env é do processo.
        std::env::set_var("PROMETHEUS_ROOT", &root);

        let found = plugin_install("JuliusBrussee/caveman".into()).unwrap();
        assert!(found.saved);
        assert_eq!(found.plugins.len(), 1);
        assert_eq!(found.plugins[0].id, "caveman");
        assert!(found.plugins[0].note.len() > 10);
        assert_eq!(
            found.plugins[0].from,
            "https://github.com/JuliusBrussee/caveman"
        );
        assert!(manifest_path(Path::new(&found.plugins[0].source)).exists());

        // E ele entrou no hub, com a linha de comando que a sessão vai receber.
        assert_eq!(
            args_from(&load(), &["caveman".to_string()]),
            ["--plugin-dir", &found.plugins[0].source]
        );

        // Instalar de novo é atualizar, e o hub diz isso em vez de clonar por
        // cima do que já está lá.
        assert!(plugin_install("https://github.com/JuliusBrussee/caveman".into()).is_err());
        plugin_update("caveman".into()).unwrap();

        // Remover leva a pasta junto, porque ela é do Prometheus.
        plugin_remove("caveman".into()).unwrap();
        assert!(!store().join("caveman").exists());
        std::env::remove_var("PROMETHEUS_ROOT");
        std::fs::remove_dir_all(&root).ok();
    }

    /// Caminho de marketplace não sai do clone: o que um repositório de fora
    /// escreve não aponta para outro lugar do disco.
    #[test]
    fn caminho_de_marketplace_nao_sai_do_clone() {
        let dir = Path::new("/tmp/clone");
        assert_eq!(within(dir, "./plugins/a"), Some(dir.join("plugins/a")));
        assert_eq!(within(dir, "./"), Some(dir.to_path_buf()));
        assert!(within(dir, "../../etc").is_none());
        assert!(within(dir, "/etc").is_none());
    }

    /// O nome que a pessoa escreve vira pasta: sem acento, sem espaço e sem
    /// dois traços seguidos, porque é ele que o CLI vai ler.
    #[test]
    fn o_nome_vira_pasta() {
        assert_eq!(slug("Revisão de front"), "revisao-de-front");
        assert_eq!(slug("  Caveman!!  "), "caveman");
        assert_eq!(slug("padrões — do time"), "padroes-do-time");
        assert_eq!(slug("!!!"), "");
    }

    /// O que a tela mostra enquanto ele escreve: o arquivo que saiu, ou a
    /// primeira frase dele. Ler não é progresso, e o caminho aparece como ele
    /// vale dentro do plugin.
    #[test]
    fn o_stream_vira_progresso() {
        let dir = Path::new("/tmp/plug");
        let wrote = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"/tmp/plug/skills/x/SKILL.md"}}]}}"#;
        let wrote = step(dir, wrote).unwrap();
        assert_eq!(
            (wrote.kind.as_str(), wrote.text.as_str()),
            ("file", "skills/x/SKILL.md")
        );

        let read = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"/tmp/plug/x"}}]}}"#;
        assert!(step(dir, read).is_none());

        let said = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"\n  Vou começar pelo manifesto.\nDepois as skills."}]}}"#;
        let said = step(dir, said).unwrap();
        assert_eq!(
            (said.kind.as_str(), said.text.as_str()),
            ("say", "Vou começar pelo manifesto.")
        );

        // O resto do stream não é progresso de ninguém, e linha que não é JSON
        // não pode derrubar a leitura.
        assert!(step(dir, r#"{"type":"result","subtype":"success"}"#).is_none());
        assert!(step(dir, "não é json").is_none());
    }

    /// Sem manifesto não nasceu plugin nenhum, e o que não nasceu não entra no
    /// hub — é o que separa "o agente escreveu" de "o agente respondeu".
    #[test]
    fn pasta_sem_manifesto_nao_vira_plugin() {
        let dir = std::env::temp_dir().join(format!("prometheus-made-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(born(&dir, "exemplo").is_err());
        std::fs::remove_dir_all(&dir).ok();
    }
}
