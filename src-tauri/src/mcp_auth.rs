//! Entrar num servidor de MCP que pede login.
//!
//! É OAuth como o do Linear (`linear.rs`), com duas diferenças que mudam tudo:
//! aqui não há endereço escrito no código nem app registrado antes. O servidor
//! é de quem quer que seja, e o caminho até ele começa no `401` que ele
//! devolve:
//!
//!   1. o `401` traz `WWW-Authenticate: … resource_metadata="…"`;
//!   2. esses metadados dizem qual é o authorization server;
//!   3. o `.well-known` dele diz onde autorizar, onde trocar o token e onde
//!      registrar um cliente;
//!   4. o Prometeu se registra ali na hora — registro dinâmico, RFC 7591 —,
//!      e o `client_id` que sai disso é guardado e reusado;
//!   5. daí é o de sempre: navegador, consentimento, `code` no socket local,
//!      troca por token com PKCE.
//!
//! Quem usa o token depois **não é o Prometeu**: é o `claude` da conversa. O
//! app põe o `Authorization: Bearer …` nos cabeçalhos do servidor ao escrever
//! o `--mcp-config` da sessão (`mcp::config_body`), e renova antes de escrever.
//! O CLI nunca sabe que houve OAuth — para ele é um servidor com um cabeçalho.
//!
//! O que isso deixa de fora, e é honesto dizer: token que vence com a conversa
//! de pé não se renova sozinho lá dentro, porque o arquivo já foi lido. Vence
//! no meio do trabalho, a ferramenta falha e a próxima conversa nasce com um
//! token novo.

use crate::i18n;
use crate::oauth::{self, challenge, escape, form, now, random};
use crate::paths;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::net::TcpListener;
use std::time::{Duration, Instant};

/// A porta do redirect. Fixa como a do Linear, e por outro motivo: o cliente é
/// registrado com este endereço exato, e um cliente guardado com a porta de
/// ontem não serviria amanhã.
const PORT: u16 = 17421;
const REDIRECT: &str = "http://127.0.0.1:17421/mcp";
const ROUTE: &str = "/mcp";
/// Quanto tempo o socket espera o navegador voltar. Aprovar leva segundos;
/// cinco minutos é para quem foi buscar a senha.
const WAIT: Duration = Duration::from_secs(5 * 60);
/// Renova o token com esta folga: uma sessão que nasce com o token válido não
/// pode começar com ele vencido.
const SLACK: u64 = 5 * 60;
const HTTP: Duration = Duration::from_secs(20);

/// O que ficou guardado de um servidor em que já se entrou.
#[derive(Serialize, Deserialize, Clone)]
pub struct Auth {
    /// O cliente que registramos naquele servidor. Vale para as próximas vezes
    /// — registrar de novo a cada login encheria o servidor de clientes iguais.
    pub client_id: String,
    /// Onde trocar e renovar. Guardado com o token: a descoberta já foi feita,
    /// e refazê-la a cada renovação seria três chamadas de rede para nada.
    pub token_endpoint: String,
    /// A quem este token dá acesso (RFC 8707). Vai na troca e na renovação.
    pub resource: String,
    pub access_token: String,
    pub refresh_token: Option<String>,
    /// Unix, em segundos.
    pub expires_at: u64,
}

type Store = HashMap<String, Auth>;

fn path() -> std::path::PathBuf {
    paths::root().join("mcp-auth.json")
}

fn load() -> Store {
    std::fs::read_to_string(path())
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn store(all: &Store) -> Result<(), String> {
    let body = serde_json::to_string_pretty(all).map_err(|e| e.to_string())?;
    paths::write_private(&path(), &body)
        .map_err(|cause| i18n::ta("err.mcp.auth.write", &[("cause", cause)]))
}

/// Em quais servidores já se entrou. É o que a tela marca como conectado.
pub fn logged_in() -> Vec<String> {
    let mut ids: Vec<String> = load().into_keys().collect();
    ids.sort();
    ids
}

pub fn forget(id: &str) -> Result<(), String> {
    let mut all = load();
    all.remove(id);
    store(&all)
}

/// Um token bom para usar agora: renovado se está para vencer, e gravado de
/// volta quando renova. `None` é servidor em que ninguém entrou — e aí não há
/// cabeçalho a pôr.
///
/// Renovação que falha não é erro de quem chamou: o token velho já não serve,
/// e o servidor vai responder `401` — que é o que a tela sabe explicar.
pub fn bearer(id: &str) -> Option<String> {
    let auth = load().get(id)?.clone();
    if auth.expires_at > now() + SLACK {
        return Some(auth.access_token);
    }
    let fresh = renew(&auth).ok()?;
    let mut all = load();
    all.insert(id.to_string(), fresh.clone());
    let _ = store(&all);
    Some(fresh.access_token)
}

/* ---------- a descoberta ---------- */

/// Onde este servidor manda autorizar. Sai do `401`: o cabeçalho aponta os
/// metadados do recurso, que apontam o authorization server, que diz o resto.
///
/// Cada passo tem um plano B, porque nem todo servidor publica tudo: sem
/// `WWW-Authenticate` válido, tenta-se o `.well-known` na raiz da própria URL.
#[derive(Debug, Clone)]
pub struct Endpoints {
    pub authorize: String,
    pub token: String,
    pub register: Option<String>,
    pub scopes: Option<String>,
}

pub fn discover(url: &str, challenge_header: Option<&str>) -> Result<Endpoints, String> {
    let client = http()?;
    let metadata = challenge_header
        .and_then(resource_metadata_url)
        .unwrap_or_else(|| well_known(url, "oauth-protected-resource"));

    // O authorization server é o que os metadados do recurso disserem; sem
    // eles, o palpite é o próprio host — que é o caso comum de servidor que
    // hospeda as duas coisas.
    let issuer = client
        .get(&metadata)
        .timeout(HTTP)
        .send()
        .ok()
        .and_then(|r| r.json::<Value>().ok())
        .and_then(|meta| {
            meta["authorization_servers"][0]
                .as_str()
                .map(str::to_string)
        })
        .unwrap_or_else(|| origin(url));

    // O `.well-known` do authorization server, nas duas formas que a RFC 8414
    // prevê — há servidor que só publica a de OpenID.
    for probe in [
        well_known(&issuer, "oauth-authorization-server"),
        well_known(&issuer, "openid-configuration"),
    ] {
        let Some(meta) = client
            .get(&probe)
            .timeout(HTTP)
            .send()
            .ok()
            .filter(|r| r.status().is_success())
            .and_then(|r| r.json::<Value>().ok())
        else {
            continue;
        };
        let (Some(authorize), Some(token)) = (
            meta["authorization_endpoint"].as_str(),
            meta["token_endpoint"].as_str(),
        ) else {
            continue;
        };
        return Ok(Endpoints {
            authorize: authorize.to_string(),
            token: token.to_string(),
            register: meta["registration_endpoint"].as_str().map(str::to_string),
            scopes: meta["scopes_supported"]
                .as_array()
                .map(|all| {
                    all.iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join(" ")
                })
                .filter(|s| !s.is_empty()),
        });
    }
    Err(i18n::ta("err.mcp.auth.noMetadata", &[("url", issuer)]))
}

/// O `resource_metadata="…"` de dentro do `WWW-Authenticate`.
fn resource_metadata_url(header: &str) -> Option<String> {
    let at = header.find("resource_metadata=")? + "resource_metadata=".len();
    let rest = header[at..].trim_start_matches('"');
    let end = rest.find('"').unwrap_or(rest.len());
    Some(rest[..end].to_string())
}

/// O `.well-known` de uma URL. O caminho entra depois do nome, como a RFC
/// manda para recurso que não está na raiz: `https://x/mcp` vira
/// `https://x/.well-known/oauth-protected-resource/mcp`.
fn well_known(url: &str, name: &str) -> String {
    let base = origin(url);
    let path = url
        .strip_prefix(&base)
        .unwrap_or("")
        .trim_end_matches('/')
        .to_string();
    format!("{base}/.well-known/{name}{path}")
}

/// Só o esquema e o host de uma URL.
fn origin(url: &str) -> String {
    let (scheme, rest) = url.split_once("://").unwrap_or(("https", url));
    let host = rest.split('/').next().unwrap_or(rest);
    format!("{scheme}://{host}")
}

fn http() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(HTTP)
        .build()
        .map_err(|e| i18n::ta("err.mcp.auth.http", &[("cause", e.to_string())]))
}

/* ---------- o fluxo ---------- */

/// Entra num servidor: descobre, registra um cliente se preciso, abre o
/// navegador e guarda o token. Devolve quando a pessoa aprovou — ou quando
/// desistiu, e aí o motivo é o que a tela mostra.
pub fn login(id: &str, url: &str, challenge_header: Option<&str>) -> Result<(), String> {
    let ends = discover(url, challenge_header)?;
    let saved = load().get(id).cloned();
    // Cliente já registrado neste servidor vale de novo — desde que o token
    // endpoint ainda seja o mesmo. Mudou, o servidor mudou, e registrar de
    // novo é o certo.
    let client_id = match saved.filter(|a| a.token_endpoint == ends.token) {
        Some(auth) => auth.client_id,
        None => register(&ends)?,
    };

    let listener = TcpListener::bind(("127.0.0.1", PORT)).map_err(|e| {
        i18n::ta(
            "err.mcp.auth.port",
            &[("port", PORT.to_string()), ("cause", e.to_string())],
        )
    })?;
    listener.set_nonblocking(true).map_err(|e| {
        i18n::ta(
            "err.mcp.auth.port",
            &[("port", PORT.to_string()), ("cause", e.to_string())],
        )
    })?;

    let verifier = random();
    let state = random();
    let scope = ends
        .scopes
        .as_ref()
        .map(|s| format!("&scope={}", escape(s)))
        .unwrap_or_default();
    // `resource` é a RFC 8707: o token vale para este servidor de MCP e não
    // para outro que o mesmo authorization server proteja.
    let authorize = format!(
        "{}?response_type=code&client_id={}&redirect_uri={}&state={state}\
         &code_challenge={}&code_challenge_method=S256&resource={}{scope}",
        ends.authorize,
        escape(&client_id),
        escape(REDIRECT),
        challenge(&verifier),
        escape(url),
    );
    oauth::browse(&authorize).map_err(|_| i18n::t("err.mcp.auth.noBrowser"))?;

    let code = oauth::wait_for_code(&listener, ROUTE, &state, Instant::now() + WAIT, &page)
        .map_err(|denied| match denied {
            oauth::Denied::Refused => i18n::t("err.mcp.auth.denied"),
            oauth::Denied::Error(why) => i18n::ta("err.mcp.auth.refused", &[("why", why)]),
            oauth::Denied::NoCode => i18n::t("err.mcp.auth.noCode"),
            oauth::Denied::Timeout => i18n::t("err.mcp.auth.timeout"),
            oauth::Denied::Broken(cause) => i18n::ta(
                "err.mcp.auth.port",
                &[("port", PORT.to_string()), ("cause", cause)],
            ),
        })?;

    let auth = exchange(&ends, &client_id, url, &code, &verifier)?;
    let mut all = load();
    all.insert(id.to_string(), auth);
    store(&all)
}

/// Registro dinâmico: o Prometeu não é um app cadastrado no servidor de
/// ninguém, então ele se apresenta na hora e recebe um `client_id`. Servidor
/// que não aceita isto precisa de um cliente feito à mão — e aí o caminho é
/// outro, que a tela explica.
fn register(ends: &Endpoints) -> Result<String, String> {
    let Some(endpoint) = &ends.register else {
        return Err(i18n::t("err.mcp.auth.noRegister"));
    };
    let body = serde_json::json!({
        "client_name": "Prometeu",
        "redirect_uris": [REDIRECT],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        // Sem segredo: um `.app` não guarda segredo de cliente, e o PKCE é a
        // prova que substitui — o mesmo desenho do Linear.
        "token_endpoint_auth_method": "none"
    });
    let reply: Value = http()?
        .post(endpoint)
        .json(&body)
        .send()
        .map_err(|e| i18n::ta("err.mcp.auth.unreachable", &[("cause", e.to_string())]))?
        .json()
        .map_err(|e| i18n::ta("err.mcp.auth.garbled", &[("cause", e.to_string())]))?;
    reply["client_id"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| {
            i18n::ta(
                "err.mcp.auth.noClient",
                &[("why", reply.to_string().chars().take(200).collect())],
            )
        })
}

fn exchange(
    ends: &Endpoints,
    client_id: &str,
    resource: &str,
    code: &str,
    verifier: &str,
) -> Result<Auth, String> {
    let got = token_request(
        &ends.token,
        &[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", REDIRECT),
            ("client_id", client_id),
            ("code_verifier", verifier),
            ("resource", resource),
        ],
    )?;
    Ok(Auth {
        client_id: client_id.to_string(),
        token_endpoint: ends.token.clone(),
        resource: resource.to_string(),
        access_token: got.0,
        refresh_token: got.1,
        expires_at: now() + got.2,
    })
}

fn renew(auth: &Auth) -> Result<Auth, String> {
    let refresh = auth
        .refresh_token
        .as_deref()
        .ok_or_else(|| i18n::t("err.mcp.auth.expired"))?;
    let got = token_request(
        &auth.token_endpoint,
        &[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh),
            ("client_id", &auth.client_id),
            ("resource", &auth.resource),
        ],
    )?;
    Ok(Auth {
        access_token: got.0,
        // Servidor que não devolve refresh novo mantém o velho valendo.
        refresh_token: got.1.or_else(|| auth.refresh_token.clone()),
        expires_at: now() + got.2,
        ..auth.clone()
    })
}

/// O token, o refresh e quanto ele dura.
fn token_request(
    endpoint: &str,
    fields: &[(&str, &str)],
) -> Result<(String, Option<String>, u64), String> {
    let reply: Value = http()?
        .post(endpoint)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(form(fields))
        .send()
        .map_err(|e| i18n::ta("err.mcp.auth.unreachable", &[("cause", e.to_string())]))?
        .json()
        .map_err(|e| i18n::ta("err.mcp.auth.garbled", &[("cause", e.to_string())]))?;
    if let Some(error) = reply["error"].as_str() {
        let why = reply["error_description"].as_str().unwrap_or_default();
        return Err(i18n::ta(
            "err.mcp.auth.refused",
            &[("why", format!("{error} {why}").trim().to_string())],
        ));
    }
    let token = reply["access_token"]
        .as_str()
        .ok_or_else(|| i18n::t("err.mcp.auth.noToken"))?
        .to_string();
    Ok((
        token,
        reply["refresh_token"].as_str().map(str::to_string),
        reply["expires_in"].as_u64().unwrap_or(3600),
    ))
}

/// O que a página do fim do fluxo diz. Como a do Linear: quem lê está no
/// navegador, longe do catálogo do front.
fn page(ok: bool, why: &str) -> String {
    let (title, text) = match (ok, i18n::pt()) {
        (true, true) => (
            "Conectado",
            "Pode fechar esta aba e voltar ao Prometeu.".to_string(),
        ),
        (true, false) => (
            "Connected",
            "You can close this tab and go back to Prometeu.".to_string(),
        ),
        (false, true) => (
            "Não deu",
            format!("O servidor não autorizou o Prometeu. {why}")
                .trim()
                .to_string(),
        ),
        (false, false) => (
            "Did not work",
            format!("The server did not authorize Prometeu. {why}")
                .trim()
                .to_string(),
        ),
    };
    oauth::page(title, &text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acha_os_metadados_no_cabecalho() {
        let header = r#"Bearer realm="OAuth", resource_metadata="https://x.dev/.well-known/oauth-protected-resource/mcp""#;
        assert_eq!(
            resource_metadata_url(header).as_deref(),
            Some("https://x.dev/.well-known/oauth-protected-resource/mcp")
        );
        assert!(resource_metadata_url(r#"Bearer realm="OAuth""#).is_none());
    }

    /// O caminho do recurso vai depois do nome do `.well-known`, e não antes —
    /// é o que a RFC 9728 pede para recurso que não mora na raiz.
    #[test]
    fn o_well_known_carrega_o_caminho() {
        assert_eq!(
            well_known("https://mcp.exemplo.com/mcp", "oauth-protected-resource"),
            "https://mcp.exemplo.com/.well-known/oauth-protected-resource/mcp"
        );
        assert_eq!(
            well_known("https://mcp.exemplo.com", "oauth-authorization-server"),
            "https://mcp.exemplo.com/.well-known/oauth-authorization-server"
        );
    }

    #[test]
    fn a_origem_e_so_esquema_e_host() {
        assert_eq!(origin("https://a.b/c/d?x=1"), "https://a.b");
        assert_eq!(origin("http://127.0.0.1:3000/mcp"), "http://127.0.0.1:3000");
    }

    /// Fala com um servidor de verdade: descobre os endpoints e registra um
    /// cliente. Sem navegador — o que se prova aqui é tudo que acontece antes
    /// do consentimento. `cargo test -- --ignored descobre`.
    #[test]
    #[ignore]
    fn descobre_e_registra_num_servidor_de_verdade() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let ends = discover("https://mcp.apps.capim.tech/mcp", None).expect("descoberta");
        println!(
            "authorize={} token={} register={:?}",
            ends.authorize, ends.token, ends.register
        );
        assert!(ends.authorize.starts_with("https://"));
        let client = register(&ends).expect("registro dinâmico");
        println!("client_id={client}");
        assert!(!client.is_empty());
    }
}
