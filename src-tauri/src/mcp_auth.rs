//! Authenticate MCP servers through discovered OAuth endpoints and dynamic client registration.
//! Follow resource metadata from a 401 challenge, discover authorization-server metadata, register
//! and reuse a client, then use browser consent and loopback PKCE. Refresh tokens before session
//! configuration is written. Running sessions retain their startup token, so expiry during a
//! session can require restarting with fresh configuration.

use crate::i18n;
use crate::oauth::{self, challenge, escape, form, now, random};
use crate::paths;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::net::TcpListener;
use std::time::{Duration, Instant};

/// Keep a fixed callback port because dynamically registered clients retain the exact redirect URI
/// for future logins.
const PORT: u16 = 17421;
const REDIRECT: &str = "http://127.0.0.1:17421/mcp";
const ROUTE: &str = "/mcp";
/// Allow five minutes for browser authorization.
const WAIT: Duration = Duration::from_secs(5 * 60);
/// Refresh early enough to avoid launching sessions with nearly expired tokens.
const SLACK: u64 = 5 * 60;
const HTTP: Duration = Duration::from_secs(20);

/// Persisted login state for one server.
#[derive(Serialize, Deserialize, Clone)]
pub struct Auth {
    /// Reuse the registered OAuth client instead of creating duplicates on every login.
    pub client_id: String,
    /// Persist discovered token endpoints so refresh does not repeat endpoint discovery.
    pub token_endpoint: String,
    /// The RFC 8707 resource identifier is included in token exchange and refresh.
    pub resource: String,
    pub access_token: String,
    pub refresh_token: Option<String>,
    /// Unix timestamp in seconds.
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

/// Expose stored server logins to the UI.
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

/// Refresh expiring tokens and persist replacements. Return None when no login exists or refresh
/// fails, allowing the server's 401 response to request authentication.
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

/* Discovery */

/// Discover authorization endpoints through the 401 resource metadata and authorization-server
/// metadata. Fall back to well-known metadata at the resource origin when advertised metadata is
/// unavailable.
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

    // Use the resource metadata's authorization server, falling back to the resource host when it
    // serves both roles.
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

    // Try OAuth and OpenID discovery metadata locations supported by the server.
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

/// Extract the resource_metadata parameter from WWW-Authenticate.
fn resource_metadata_url(header: &str) -> Option<String> {
    let at = header.find("resource_metadata=")? + "resource_metadata=".len();
    let rest = header[at..].trim_start_matches('"');
    let end = rest.find('"').unwrap_or(rest.len());
    Some(rest[..end].to_string())
}

/// Append the resource path after the well-known metadata name, preserving discovery for resources
/// below the origin root.
fn well_known(url: &str, name: &str) -> String {
    let base = origin(url);
    let path = url
        .strip_prefix(&base)
        .unwrap_or("")
        .trim_end_matches('/')
        .to_string();
    format!("{base}/.well-known/{name}{path}")
}

/// Extract the URL origin.
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

/* Authorization flow */

/// Discover endpoints, register a client when needed, open consent, and persist the resulting
/// token. Return a failure reason when authorization is declined or fails.
pub fn login(id: &str, url: &str, challenge_header: Option<&str>) -> Result<(), String> {
    let ends = discover(url, challenge_header)?;
    let saved = load().get(id).cloned();
    // Reuse a registered client only while its token endpoint remains unchanged.
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
    // Include the RFC 8707 resource so the token is scoped to this MCP server rather than another
    // resource sharing its authorization server.
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

/// Register a client dynamically. Servers without registration support require separately
/// configured clients, which the UI explains.
fn register(ends: &Endpoints) -> Result<String, String> {
    let Some(endpoint) = &ends.register else {
        return Err(i18n::t("err.mcp.auth.noRegister"));
    };
    let body = serde_json::json!({
        "client_name": "Prometeu",
        "redirect_uris": [REDIRECT],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        // Use PKCE without a client secret because a desktop bundle cannot keep an embedded secret
        // private.
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
        // Preserve the current refresh token if the server omits a replacement.
        refresh_token: got.1.or_else(|| auth.refresh_token.clone()),
        expires_at: now() + got.2,
        ..auth.clone()
    })
}

/// Token response with refresh credential and lifetime.
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

/// Provide localized OAuth completion text for the browser, outside the frontend catalog.
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

    /// RFC 9728 places a nested resource path after the well-known metadata name.
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

    /// Ignored integration test discovers endpoints and registers a client without opening browser
    /// consent: cargo test -- --ignored descobre.
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
