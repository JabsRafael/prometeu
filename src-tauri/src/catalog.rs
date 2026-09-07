//! O catálogo portátil: o que a pessoa declarou (plugins, MCP e Ações), sem
//! segredo nem caminho local. Com conta, o SaaS é a fonte e `<root>/catalog.json`
//! é cache; cada edição vai primeiro à nuvem. Sem conta, nada daqui roda e os
//! hubs continuam locais como sempre. Instalação e segredos são deste Mac.
use crate::lock::lock;
use crate::state::publish;
use crate::{actions, cloud, i18n, mcp, paths, plugins, AppState};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

static SYNC: Mutex<()> = Mutex::new(());

/// Um plugin como a nuvem o guarda: só o endereço de onde ele vem.
#[derive(Serialize, Deserialize, Clone, PartialEq, Default)]
pub struct Portable {
    pub id: String,
    pub source: String,
    #[serde(default)]
    pub note: String,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Default)]
pub struct Doc {
    #[serde(default)]
    pub plugins: Vec<Portable>,
    #[serde(default)]
    pub mcp: Vec<mcp::Server>,
    #[serde(default)]
    pub actions: Option<actions::Catalog>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
struct Cache {
    revision: Option<u64>,
    doc: Doc,
}

#[derive(Serialize)]
pub struct CatalogState {
    connected: bool,
    plugins: Vec<Portable>,
    mcp: Vec<String>,
}

fn cache_path() -> std::path::PathBuf {
    paths::root().join("catalog.json")
}

fn load_cache() -> Option<Cache> {
    std::fs::read_to_string(cache_path())
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
}

fn save_cache(cache: &Cache) -> Result<(), String> {
    paths::write_private(&cache_path(), &serde_json::to_string(cache).unwrap())
        .map_err(|_| i18n::t("err.cloud.storage"))
}

/// Sair da conta esquece o cache; o que está instalado neste Mac fica.
pub fn forget() {
    let _ = std::fs::remove_file(cache_path());
}

/// O que deste plugin pode ir para a nuvem. Pasta e `.zip` locais ficam aqui.
pub fn portable(p: &plugins::Plugin) -> Option<Portable> {
    let source = if !p.from.is_empty() {
        &p.from
    } else if plugins::remote(&p.source) {
        &p.source
    } else {
        return None;
    };
    Some(Portable {
        id: p.id.clone(),
        source: source.clone(),
        note: p.note.clone(),
    })
}

/// Só o `.zip` por URL o CLI abre sozinho; repositório precisa ser clonado
/// por quem instala.
fn direct(source: &str) -> bool {
    source.to_lowercase().ends_with(".zip")
}

/// O servidor sem segredo: as chaves de `env` e `headers` vão, os valores não.
pub fn blank(server: &mcp::Server) -> mcp::Server {
    let mut config = server.config.clone();
    for key in ["env", "headers"] {
        if let Some(map) = config.get_mut(key).and_then(Value::as_object_mut) {
            for value in map.values_mut() {
                *value = json!("");
            }
        }
    }
    mcp::Server {
        id: server.id.clone(),
        config,
        note: server.note.clone(),
    }
}

/// A forma vem da nuvem; os valores que este Mac já tinha voltam para o lugar.
fn merge(cloud: &Value, local: &Value) -> Value {
    let mut out = cloud.clone();
    for key in ["env", "headers"] {
        let Some(mine) = local.get(key).and_then(Value::as_object) else {
            continue;
        };
        if let Some(target) = out.get_mut(key).and_then(Value::as_object_mut) {
            for (name, value) in target.iter_mut() {
                if value.as_str() == Some("") {
                    if let Some(kept) = mine.get(name) {
                        *value = kept.clone();
                    }
                }
            }
        }
    }
    out
}

fn export_local(app: &AppHandle) -> Doc {
    Doc {
        plugins: plugins::load().iter().filter_map(portable).collect(),
        mcp: mcp::load().iter().map(blank).collect(),
        actions: Some(lock(&app.state::<AppState>().board).actions.clone()),
    }
}

/// Traz o documento da nuvem para os hubs deste Mac. `old` é o que este Mac
/// já sabia: o que sumiu de lá sai daqui; o que chegou entra.
fn apply(app: &AppHandle, old: &Doc, new: &Doc) -> Result<(), String> {
    let mut hub = plugins::load();
    let before = hub.clone();
    for p in &new.plugins {
        match hub.iter_mut().find(|l| l.id == p.id) {
            Some(local) => local.note = p.note.clone(),
            None if direct(&p.source) => hub.push(plugins::Plugin {
                id: p.id.clone(),
                source: p.source.clone(),
                note: p.note.clone(),
                made: false,
                from: String::new(),
            }),
            None => {}
        }
    }
    for gone in old
        .plugins
        .iter()
        .filter(|o| !new.plugins.iter().any(|n| n.id == o.id))
    {
        hub = plugins::remove_local(hub, &gone.id);
    }
    if hub != before {
        hub.sort_by_key(|p| p.id.to_lowercase());
        plugins::write_hub(&hub)?;
    }

    let mut servers = mcp::load();
    for s in &new.mcp {
        match servers.iter_mut().find(|l| l.id == s.id) {
            Some(local) => {
                local.config = merge(&s.config, &local.config);
                local.note = s.note.clone();
            }
            None => servers.push(s.clone()),
        }
    }
    servers
        .retain(|l| new.mcp.iter().any(|n| n.id == l.id) || !old.mcp.iter().any(|o| o.id == l.id));
    servers.sort_by_key(|s| s.id.to_lowercase());
    mcp::store(&servers)?;

    if let Some(actions) = &new.actions {
        if actions::validate(actions).is_ok() {
            let state = app.state::<AppState>();
            lock(&state.board).actions = actions.clone();
            publish(app);
        }
    }
    let _ = app.emit("catalog", ());
    Ok(())
}

fn parse(value: &Value) -> Result<(Option<u64>, Option<Doc>), String> {
    let revision = value["revision"].as_u64();
    let doc = match &value["catalog"] {
        Value::Null => None,
        v => Some(serde_json::from_value(v.clone()).map_err(|_| i18n::t("err.cloud.response"))?),
    };
    Ok((revision, doc))
}

fn put(doc: &Doc, revision: Option<u64>) -> Result<(u16, Value), String> {
    let body = json!({ "catalog": doc, "revision": revision });
    cloud::api(Method::PUT, "/api/catalog", Some(body))?.ok_or_else(|| i18n::t("err.cloud.network"))
}

/// Lê a nuvem e traz para cá. Nuvem vazia recebe o que este Mac tem: é a
/// primeira conexão. Nuvem com catálogo ganha; o local vai para
/// `catalog.local.json` uma vez, para não perder o que havia aqui.
pub fn pull(app: &AppHandle) -> Result<(), String> {
    let _sync = lock(&SYNC);
    let Some((code, value)) = cloud::api(Method::GET, "/api/catalog", None)? else {
        return Ok(());
    };
    if code != 200 {
        return Err(i18n::t("err.cloud.network"));
    }
    let (revision, doc) = parse(&value)?;
    let cache = load_cache();
    match doc {
        None => {
            let doc = export_local(app);
            let (code, value) = put(&doc, None)?;
            if code != 200 {
                return Err(i18n::t("err.cloud.network"));
            }
            save_cache(&Cache {
                revision: parse(&value)?.0,
                doc,
            })?;
            let _ = app.emit("catalog", ());
        }
        Some(doc) => {
            if cache.as_ref().is_some_and(|c| c.revision == revision) {
                return Ok(());
            }
            let old = match &cache {
                Some(c) => c.doc.clone(),
                None => {
                    let mine = export_local(app);
                    if mine != Doc::default() {
                        let _ = paths::write_private(
                            &paths::root().join("catalog.local.json"),
                            &serde_json::to_string_pretty(&mine).unwrap(),
                        );
                    }
                    Doc::default()
                }
            };
            apply(app, &old, &doc)?;
            save_cache(&Cache { revision, doc })?;
        }
    }
    Ok(())
}

/// Uma edição: vai à nuvem antes de valer aqui. Sem conta, não faz nada e o
/// hub local segue. Revisão velha (o outro Mac gravou antes) traz o documento
/// dele, aplica aqui, refaz a edição em cima e tenta uma vez mais.
pub fn mutate(app: &AppHandle, change: impl Fn(&mut Doc)) -> Result<(), String> {
    if !cloud::connected() {
        return Ok(());
    }
    let _sync = lock(&SYNC);
    let mut cache = load_cache().unwrap_or_default();
    for _ in 0..2 {
        let mut doc = cache.doc.clone();
        change(&mut doc);
        if doc == cache.doc && cache.revision.is_some() {
            return Ok(());
        }
        let (code, value) = put(&doc, cache.revision)?;
        let (revision, server) = parse(&value)?;
        match code {
            200 => return save_cache(&Cache { revision, doc }),
            409 => {
                let server = server.unwrap_or_default();
                apply(app, &cache.doc, &server)?;
                cache = Cache {
                    revision,
                    doc: server,
                };
                save_cache(&cache)?;
            }
            _ => return Err(i18n::t("err.cloud.network")),
        }
    }
    Err(i18n::t("err.cloud.network"))
}

pub fn has_plugin(id: &str) -> bool {
    load_cache().is_some_and(|c| c.doc.plugins.iter().any(|p| p.id == id))
}

pub fn has_mcp(id: &str) -> bool {
    load_cache().is_some_and(|c| c.doc.mcp.iter().any(|s| s.id == id))
}

/// O que a tela precisa para marcar cada linha: quem está na nuvem, e quais
/// plugins de lá ainda não foram instalados aqui.
#[tauri::command]
pub fn catalog_state() -> CatalogState {
    let connected = cloud::connected();
    let cache = if connected {
        load_cache().unwrap_or_default()
    } else {
        Cache::default()
    };
    CatalogState {
        connected,
        plugins: cache.doc.plugins,
        mcp: cache.doc.mcp.into_iter().map(|s| s.id).collect(),
    }
}

#[tauri::command]
pub async fn catalog_refresh(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || pull(&app))
        .await
        .map_err(|_| i18n::t("err.cloud.network"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn segredo_fica_no_mac_e_volta_no_merge() {
        let local = mcp::Server {
            id: "x".into(),
            config: json!({"command": "npx", "env": {"TOKEN": "s3cret", "MODE": "dev"}, "headers": {"Authorization": "Bearer t"}}),
            note: "n".into(),
        };
        let cloud = blank(&local);
        assert_eq!(cloud.config["env"]["TOKEN"], "");
        assert_eq!(cloud.config["headers"]["Authorization"], "");
        assert_eq!(cloud.config["command"], "npx");
        let mut changed = cloud.config.clone();
        changed["command"] = json!("bunx");
        let merged = merge(&changed, &local.config);
        assert_eq!(merged["command"], "bunx");
        assert_eq!(merged["env"]["TOKEN"], "s3cret");
        assert_eq!(merged["headers"]["Authorization"], "Bearer t");
        assert_eq!(
            merge(&json!({"url": "u"}), &local.config),
            json!({"url": "u"})
        );
    }

    #[test]
    fn so_o_que_tem_endereco_e_portatil() {
        let p = |source: &str, from: &str| plugins::Plugin {
            id: "p".into(),
            source: source.into(),
            note: "".into(),
            made: !from.is_empty(),
            from: from.into(),
        };
        assert!(portable(&p("~/dev/x", "")).is_none());
        assert_eq!(
            portable(&p("~/.prometeu/plugins/x", "https://github.com/a/x"))
                .unwrap()
                .source,
            "https://github.com/a/x"
        );
        assert_eq!(
            portable(&p("https://x.test/p.zip", "")).unwrap().source,
            "https://x.test/p.zip"
        );
        assert!(direct("https://x.test/p.ZIP") && !direct("https://github.com/a/x"));
    }
}
