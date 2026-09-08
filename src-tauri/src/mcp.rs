//! The MCP hub stores known servers and workspace selections. Explicit selections restrict
//! available tools, reducing context cost and unnecessary access; None preserves CLI defaults.
//! Claude receives a private 0600 config file with strict selection, while Codex receives a
//! configuration override and protected secrets. Never place secrets in process arguments. Discover
//! existing user/project CLI configuration for read-only import; mcp_auth owns OAuth and token
//! refresh.

use crate::i18n;
use crate::mcp_auth;
use crate::paths;
use serde_json::{json, Map, Value};
use std::io::{BufRead, Read, Write};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Store each server's full mcpServers configuration object so new CLI-supported fields do not
/// require an app release.
#[derive(serde::Serialize, serde::Deserialize, Clone, PartialEq)]
pub struct Server {
    /// The server name is its mcpServers key and the prefix of exported tool names.
    pub id: String,
    pub config: Value,
    /// Free-form source or purpose shown below the server name.
    #[serde(default)]
    pub note: String,
}

/// Persist the registry privately because configurations may contain API keys.
fn hub_path() -> PathBuf {
    paths::root().join("mcp.json")
}

/// Use one generated config file per tab so simultaneous launches cannot overwrite each other's
/// input.
fn session_path(id: &str) -> PathBuf {
    paths::root().join("mcp").join(format!("{id}.json"))
}

/// Private environment file for a Codex stdio server; see codex_config.
fn codex_env_path(id: &str, server: &str) -> PathBuf {
    paths::root()
        .join("mcp")
        .join(format!("{id}.{}.env", slug(server)))
}

pub fn load() -> Vec<Server> {
    std::fs::read_to_string(hub_path())
        .ok()
        .and_then(|raw| serde_json::from_str::<Vec<Server>>(&raw).ok())
        .unwrap_or_default()
}

pub(crate) fn store(servers: &[Server]) -> Result<(), String> {
    let body = serde_json::to_string_pretty(servers).map_err(|e| e.to_string())?;
    paths::write_private(&hub_path(), &body)
        .map_err(|cause| i18n::ta("err.mcp.save", &[("cause", cause)]))
}

/// Expose the registry to settings and selectors.
#[tauri::command(async)]
pub fn mcp_hub() -> Vec<Server> {
    let _sync = crate::catalog::guard();
    load()
}

/// Save or replace a server by name, which is also its tool-prefix identity within a session.
#[tauri::command(async)]
pub fn mcp_save(
    app: tauri::AppHandle,
    server: Server,
    revision: Option<u64>,
) -> Result<Vec<Server>, String> {
    let _sync = crate::catalog::guard();
    let id = server.id.trim().to_string();
    if id.is_empty() {
        return Err(i18n::t("err.mcp.noName"));
    }
    if !server.config.is_object() {
        return Err(i18n::t("err.mcp.badConfig"));
    }
    let server = Server { id, ..server };
    crate::catalog::save_mcp(&app, &server, revision)?;
    let mut servers = load();
    match servers.iter_mut().find(|s| s.id == server.id) {
        Some(old) => *old = server,
        None => servers.push(server),
    }
    servers.sort_by_key(|s| s.id.to_lowercase());
    store(&servers)?;
    Ok(servers)
}

#[tauri::command(async)]
pub fn mcp_remove(app: tauri::AppHandle, id: String) -> Result<Vec<Server>, String> {
    let _sync = crate::catalog::guard();
    crate::catalog::remove_shared(&app, "mcp", &id)?;
    let mut servers = load();
    servers.retain(|s| s.id != id);
    store(&servers)?;
    Ok(servers)
}

/// Discover importable CLI configuration absent from the hub without modifying user files.
#[tauri::command]
pub fn mcp_found() -> Vec<Server> {
    let known = load();
    let mut found: Vec<Server> = Vec::new();
    for server in from_claude_json().into_iter().chain(from_repo_files()) {
        // Deduplicate identical named configurations across registered entries and discovered
        // projects.
        if known.iter().any(|s| s.id == server.id)
            || found
                .iter()
                .any(|s| s.id == server.id && s.config == server.config)
        {
            continue;
        }
        // Keep different configurations with the same original name by assigning distinct import
        // names.
        let clash = found.iter().any(|s| s.id == server.id);
        let id = match (clash, server.note.trim()) {
            (true, origin) if !origin.is_empty() => format!("{}-{}", server.id, slug(origin)),
            (true, _) => format!("{}-2", server.id),
            _ => server.id.clone(),
        };
        found.push(Server { id, ..server });
    }
    found
}

/// Sanitize source labels into suffixes valid in server and tool names.
fn slug(text: &str) -> String {
    let cleaned: String = text
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    cleaned.trim_matches('-').replace("--", "-")
}

/// Read user and project mcpServers from ~/.claude.json. Use the final project path component for
/// source labels and name collisions; an empty source represents user configuration for the
/// frontend to label.
fn from_claude_json() -> Vec<Server> {
    let path = paths::home().join(".claude.json");
    let Some(root) = read_json(&path) else {
        return vec![];
    };
    let mut out = servers_in(&root, "");
    if let Some(projects) = root.get("projects").and_then(Value::as_object) {
        for (path, project) in projects {
            let name = Path::new(path)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| path.clone());
            out.extend(servers_in(project, &name));
        }
    }
    out
}

/// Read versioned .mcp.json files from repositories listed in ~/.claude.json.
fn from_repo_files() -> Vec<Server> {
    let path = paths::home().join(".claude.json");
    let Some(root) = read_json(&path) else {
        return vec![];
    };
    let Some(projects) = root.get("projects").and_then(Value::as_object) else {
        return vec![];
    };
    let mut out = Vec::new();
    for path in projects.keys() {
        let Some(file) = read_json(&Path::new(path).join(".mcp.json")) else {
            continue;
        };
        let name = Path::new(path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| path.clone());
        out.extend(servers_in(&file, &name));
    }
    out
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

/// Extract mcpServers from a user, project, or repository configuration object.
fn servers_in(value: &Value, origin: &str) -> Vec<Server> {
    value
        .get("mcpServers")
        .and_then(Value::as_object)
        .map(|servers| {
            servers
                .iter()
                .filter(|(_, config)| config.is_object())
                .map(|(id, config)| Server {
                    id: id.clone(),
                    config: config.clone(),
                    note: origin.to_string(),
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Generate a Claude session config only for explicit selections. None preserves CLI defaults; an
/// empty list still generates an empty file for strict MCP exclusion.
pub fn config_for(id: &str, chosen: Option<&Vec<String>>) -> Result<Option<PathBuf>, String> {
    let Some(chosen) = chosen else {
        return Ok(None);
    };
    let path = session_path(id);
    // Refresh OAuth tokens while materializing session configuration, without persisting them in
    // the registry; see mcp_auth.rs.
    let body = serde_json::to_string_pretty(&config_body(&load(), chosen, mcp_auth::bearer))
        .map_err(|e| e.to_string())?;
    paths::write_private(&path, &body)
        .map_err(|cause| i18n::ta("err.mcp.session", &[("cause", cause)]))?;
    Ok(Some(path))
}

/// Include selected servers still present in the hub, skipping deleted entries for compatibility.
/// Inject token lookup so configuration tests do not require disk state.
fn config_body(
    hub: &[Server],
    chosen: &[String],
    bearer: impl Fn(&str) -> Option<String>,
) -> Value {
    let mut servers = Map::new();
    for name in chosen {
        let Some(server) = hub.iter().find(|s| &s.id == name) else {
            continue;
        };
        let mut config = server.config.clone();
        // Inject the OAuth bearer header so the CLI can use an authenticated server without owning
        // the login flow.
        if let Some(token) = bearer(&server.id) {
            if let Some(object) = config.as_object_mut() {
                let mut headers = object
                    .get("headers")
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                headers.insert("Authorization".into(), json!(format!("Bearer {token}")));
                object.insert("headers".into(), Value::Object(headers));
            }
        }
        servers.insert(server.id.clone(), config);
    }
    json!({ "mcpServers": servers })
}

/* Codex configuration */

/// Override Codex's complete mcp_servers table for explicit selections, preserving its defaults for
/// None. Remote headers reference process environment variables. Stdio secrets use a private 0600
/// environment file sourced by a shell wrapper before exec. Commands without environment overrides
/// run directly. Secrets must never appear in process arguments.
pub type CodexMcp = (String, Vec<(String, String)>);

pub fn codex_config(id: &str, chosen: Option<&Vec<String>>) -> Result<Option<CodexMcp>, String> {
    let Some(chosen) = chosen else {
        return Ok(None);
    };
    let hub = load();
    let mut env: Vec<(String, String)> = Vec::new();
    let mut entries: Vec<String> = Vec::new();
    for name in chosen {
        let Some(server) = hub.iter().find(|s| &s.id == name) else {
            continue;
        };
        let entry = match server.config.get("url").and_then(Value::as_str) {
            Some(url) => remote_entry(server, url, &mut env),
            None => local_entry(id, server)?,
        };
        entries.push(format!("{}={entry}", toml_key(&server.id)));
    }
    Ok(Some((format!("{{{}}}", entries.join(",")), env)))
}

impl Server {
    fn args(&self) -> Vec<String> {
        self.config
            .get("args")
            .and_then(Value::as_array)
            .map(|args| {
                args.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default()
    }

    fn env_pairs(&self) -> Vec<(String, String)> {
        pairs(self.config.get("env"))
    }
}

fn pairs(value: Option<&Value>) -> Vec<(String, String)> {
    value
        .and_then(Value::as_object)
        .map(|map| {
            map.iter()
                .filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_string())))
                .collect()
        })
        .unwrap_or_default()
}

/// Generate portable uppercase environment-variable names for header values.
fn env_var_name(server: &str, header: &str) -> String {
    format!(
        "PROMETEU_MCP_{}_{}",
        slug(server).to_uppercase().replace('-', "_"),
        slug(header).to_uppercase().replace('-', "_")
    )
}

fn remote_entry(server: &Server, url: &str, env: &mut Vec<(String, String)>) -> String {
    let mut headers = pairs(server.config.get("headers"));
    if let Some(token) = mcp_auth::bearer(&server.id) {
        headers.retain(|(k, _)| !k.eq_ignore_ascii_case("authorization"));
        headers.push(("Authorization".into(), format!("Bearer {token}")));
    }
    let mut fields = vec![format!("url={}", toml_str(url))];
    if !headers.is_empty() {
        let mapped: Vec<String> = headers
            .into_iter()
            .map(|(header, value)| {
                let var = env_var_name(&server.id, &header);
                let line = format!("{}={}", toml_key(&header), toml_str(&var));
                env.push((var, value));
                line
            })
            .collect();
        fields.push(format!("env_http_headers={{{}}}", mapped.join(",")));
    }
    format!("{{{}}}", fields.join(","))
}

fn local_entry(id: &str, server: &Server) -> Result<String, String> {
    let command = server
        .config
        .get("command")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let args = server.args();
    let vars = server.env_pairs();
    let (command, args) = if vars.is_empty() {
        (command.to_string(), args)
    } else {
        let path = codex_env_path(id, &server.id);
        let body = vars
            .iter()
            .map(|(k, v)| format!("export {k}='{}'\n", v.replace('\'', "'\\''")))
            .collect::<String>();
        paths::write_private(&path, &body)
            .map_err(|cause| i18n::ta("err.mcp.session", &[("cause", cause)]))?;
        // Pass the original command and arguments through "$@" without additional interpolation;
        // exec replaces the wrapper shell.
        let script = format!(". '{}' && exec \"$@\"", path.display());
        let mut wrapped = vec![
            "-c".to_string(),
            script,
            "prometeu-mcp".to_string(),
            command.to_string(),
        ];
        wrapped.extend(args);
        ("/bin/sh".to_string(), wrapped)
    };
    let args = args
        .iter()
        .map(|a| toml_str(a))
        .collect::<Vec<_>>()
        .join(",");
    Ok(format!("{{command={},args=[{args}]}}", toml_str(&command)))
}

/// Quote TOML strings for configuration values without introducing another dependency.
fn toml_str(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04X}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Always quote TOML keys so server and header names containing dots or hyphens remain literal.
fn toml_key(s: &str) -> String {
    toml_str(s)
}

/* Server inspection */

/// Inspect the server directly to validate its configuration without adding an agent process to the
/// diagnostic path.
#[derive(serde::Serialize, Default)]
pub struct Probe {
    /// The connection succeeded and tools were listed.
    pub ok: bool,
    /// HTTP 401 distinguishes a server requiring login from a failed connection.
    pub auth: bool,
    pub tools: usize,
    /// The returned server identity confirms which server answered.
    pub name: String,
    /// Raw system or server error details; the frontend supplies the surrounding localized message.
    pub detail: String,
}

/// Record each inspection stage so the UI can distinguish startup, handshake, tools, and OAuth
/// discovery failures. Keys are translated codes; notes hold observed data; details preserve raw
/// errors.
#[derive(serde::Serialize)]
pub struct Step {
    pub key: &'static str,
    pub ok: bool,
    pub note: String,
    pub detail: String,
}

impl Step {
    fn ok(key: &'static str, note: impl Into<String>) -> Self {
        Step {
            key,
            ok: true,
            note: note.into(),
            detail: String::new(),
        }
    }

    fn bad(key: &'static str, detail: impl Into<String>) -> Self {
        Step {
            key,
            ok: false,
            note: String::new(),
            detail: detail.into(),
        }
    }
}

/// Return all inspection steps and a summary used to offer saving, login, or configuration repair.
#[derive(serde::Serialize, Default)]
pub struct Check {
    pub steps: Vec<Step>,
    pub probe: Probe,
}

/// Results of a remote-server exchange.
struct Http {
    probe: Probe,
    /// Preserve WWW-Authenticate from HTTP 401 to start OAuth discovery.
    challenge: Option<String>,
    steps: Vec<Step>,
}

/// Bound inspection time while allowing initial npx downloads and remote requests.
const PROBE_WAIT: Duration = Duration::from_secs(25);

/// Advertise a fixed MCP revision; the handshake negotiates an older revision when needed.
const PROTOCOL: &str = "2025-06-18";

fn hello() -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": PROTOCOL,
            "capabilities": {},
            "clientInfo": { "name": "Prometeu", "version": env!("CARGO_PKG_VERSION") }
        }
    })
}

/// Inspect the unsaved configuration directly from the form.
#[tauri::command]
pub async fn mcp_check(server: Server) -> Check {
    // Run synchronous HTTP and subprocess work outside async runtime workers; see linear::blocking.
    tauri::async_runtime::spawn_blocking(move || check(&server))
        .await
        .unwrap_or_else(|e| Check {
            probe: Probe {
                detail: e.to_string(),
                ..Probe::default()
            },
            ..Check::default()
        })
}

/// Start MCP OAuth discovery with an unauthenticated 401 response; mcp_auth.rs owns the login flow.
#[tauri::command]
pub async fn mcp_login(server: Server) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let url = server
            .config
            .get("url")
            .and_then(Value::as_str)
            .ok_or_else(|| i18n::t("err.mcp.auth.notRemote"))?
            .to_string();
        // Omit the token deliberately to obtain the OAuth challenge.
        let http = probe_http(&url, &server.config, None);
        mcp_auth::login(&server.id, &url, http.challenge.as_deref())
    })
    .await
    .map_err(|e| i18n::ta("err.mcp.auth.taskDied", &[("cause", e.to_string())]))?
}

#[tauri::command]
pub fn mcp_logout(id: String) -> Result<(), String> {
    mcp_auth::forget(&id)
}

/// Expose servers with stored login state for connection indicators.
#[tauri::command]
pub fn mcp_logins() -> Vec<String> {
    mcp_auth::logged_in()
}

/// For servers requiring login, also inspect OAuth endpoint discovery and dynamic client
/// registration support before offering a browser login that cannot succeed.
fn check(server: &Server) -> Check {
    let Some(url) = server.config.get("url").and_then(Value::as_str) else {
        let (probe, steps) = probe_stdio(&server.config);
        return Check { steps, probe };
    };
    // Use stored authentication during inspection so a successful login does not keep reporting
    // that login is required.
    let mut http = probe_http(url, &server.config, mcp_auth::bearer(&server.id).as_deref());
    if http.probe.auth {
        match mcp_auth::discover(url, http.challenge.as_deref()) {
            Ok(ends) => {
                http.steps.push(Step::ok("oauth", String::new()));
                http.steps.push(match ends.register {
                    Some(_) => Step::ok("client", String::new()),
                    None => Step::bad("client", i18n::t("err.mcp.auth.noRegister")),
                });
            }
            Err(why) => http.steps.push(Step::bad("oauth", why)),
        }
    }
    Check {
        steps: http.steps,
        probe: http.probe,
    }
}

/// POST initialize, then tools/list with the returned session. Accept both JSON and event-stream
/// response envelopes.
fn probe_http(url: &str, config: &Value, token: Option<&str>) -> Http {
    /// The initial connection failed before a protocol exchange began.
    fn broke(key: &'static str, detail: String) -> Http {
        Http {
            probe: Probe {
                detail: detail.clone(),
                ..Probe::default()
            },
            challenge: None,
            steps: vec![Step::bad(key, detail)],
        }
    }

    let client = match reqwest::blocking::Client::builder()
        .timeout(PROBE_WAIT)
        .build()
    {
        Ok(client) => client,
        Err(e) => return broke("connect", e.to_string()),
    };
    let headers = config
        .get("headers")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let post = |body: &Value, session: Option<&str>| {
        let mut req = client
            .post(url)
            .header("Content-Type", "application/json")
            // Streamable HTTP permits either JSON or event-stream responses.
            .header("Accept", "application/json, text/event-stream")
            .header("MCP-Protocol-Version", PROTOCOL);
        for (key, value) in &headers {
            if let Some(value) = value.as_str() {
                req = req.header(key.as_str(), value);
            }
        }
        if let Some(token) = token {
            req = req.header("Authorization", format!("Bearer {token}"));
        }
        if let Some(id) = session {
            req = req.header("Mcp-Session-Id", id);
        }
        req.json(body).send()
    };

    let first = match post(&hello(), None) {
        Ok(response) => response,
        Err(e) => return broke("connect", e.to_string()),
    };
    let code = first.status().as_u16().to_string();
    // Treat HTTP 401 as an authentication requirement rather than a malformed server configuration.
    if first.status() == reqwest::StatusCode::UNAUTHORIZED {
        let challenge = first
            .headers()
            .get("www-authenticate")
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        return Http {
            probe: Probe {
                auth: true,
                ..Probe::default()
            },
            challenge,
            steps: vec![Step::ok("connect", code)],
        };
    }
    let session = first
        .headers()
        .get("mcp-session-id")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    if !first.status().is_success() {
        let status = first.status();
        return broke(
            "connect",
            format!("{status} {}", short(&first.text().unwrap_or_default())),
        );
    }
    let mut steps = vec![Step::ok("connect", code)];
    let hello_body = first.text().unwrap_or_default();
    let Some(result) = frame(&hello_body) else {
        let detail = short(&hello_body);
        steps.push(Step::bad("handshake", detail.clone()));
        return Http {
            probe: Probe {
                detail,
                ..Probe::default()
            },
            challenge: None,
            steps,
        };
    };
    let name = result["result"]["serverInfo"]["name"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    steps.push(Step::ok("handshake", name.clone()));

    // Send initialized without waiting for a response; servers may require it before later
    // requests.
    let _ = post(
        &json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
        session.as_deref(),
    );
    let listed = post(
        &json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }),
        session.as_deref(),
    )
    .and_then(|r| r.text());
    let tools = listed
        .as_ref()
        .ok()
        .and_then(|body| frame(body))
        .and_then(|value| value["result"]["tools"].as_array().map(Vec::len))
        .unwrap_or(0);
    steps.push(tools_step(listed.err().map(|e| e.to_string()), tools));
    Http {
        probe: Probe {
            ok: true,
            auth: false,
            tools,
            name,
            detail: String::new(),
        },
        challenge: None,
        steps,
    }
}

/// A successful handshake without any tools is not a usable inspection result.
fn tools_step(failed: Option<String>, tools: usize) -> Step {
    match (failed, tools) {
        (Some(why), _) => Step::bad("tools", why),
        (None, 0) => Step::bad("tools", String::new()),
        (None, n) => Step::ok("tools", n.to_string()),
    }
}

/// Unwrap plain JSON or the first event-stream data line containing the request result.
fn frame(body: &str) -> Option<Value> {
    if let Ok(value) = serde_json::from_str::<Value>(body) {
        return Some(value);
    }
    body.lines()
        .filter_map(|line| line.strip_prefix("data:"))
        .find_map(|data| serde_json::from_str::<Value>(data.trim()).ok())
}

/// Start a local server, complete its stdio handshake, and list tools. Always stop the inspection
/// process afterward.
fn probe_stdio(config: &Value) -> (Probe, Vec<Step>) {
    let Some(command) = config.get("command").and_then(Value::as_str) else {
        let detail = "sem command nem url".to_string();
        return (
            Probe {
                detail: detail.clone(),
                ..Probe::default()
            },
            vec![Step::bad("spawn", detail)],
        );
    };
    let mut cmd = Command::new(command);
    if let Some(args) = config.get("args").and_then(Value::as_array) {
        cmd.args(args.iter().filter_map(Value::as_str));
    }
    if let Some(env) = config.get("env").and_then(Value::as_object) {
        for (key, value) in env {
            if let Some(value) = value.as_str() {
                cmd.env(key, value);
            }
        }
    }
    // Use a separate process group so npx descendants cannot survive inspection cleanup.
    cmd.process_group(0)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => {
            return (
                Probe {
                    detail: e.to_string(),
                    ..Probe::default()
                },
                vec![Step::bad("spawn", e.to_string())],
            )
        }
    };

    let mut probe = Probe::default();
    // Distinguish a tools/list response from an empty list or a missing response.
    let mut answered = false;
    if let (Some(mut stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            for line in std::io::BufReader::new(stdout)
                .lines()
                .map_while(Result::ok)
            {
                if tx.send(line).is_err() {
                    return;
                }
            }
        });
        let mut write = |value: &Value| writeln!(stdin, "{value}").and_then(|()| stdin.flush());
        let sent = write(&hello())
            .and_then(|()| {
                write(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))
            })
            .and_then(|()| write(&json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" })));
        match sent {
            Ok(()) => {
                let until = Instant::now() + PROBE_WAIT;
                // Accept logs, notifications, and requested responses in any order.
                while let Ok(line) =
                    rx.recv_timeout(until.saturating_duration_since(Instant::now()))
                {
                    let Ok(value) = serde_json::from_str::<Value>(&line) else {
                        continue;
                    };
                    if let Some(name) = value["result"]["serverInfo"]["name"].as_str() {
                        probe.name = name.to_string();
                        probe.ok = true;
                    }
                    if let Some(tools) = value["result"]["tools"].as_array() {
                        probe.tools = tools.len();
                        probe.ok = true;
                        answered = true;
                        break;
                    }
                    if let Some(error) = value["error"]["message"].as_str() {
                        probe.detail = error.to_string();
                    }
                }
            }
            Err(e) => probe.detail = e.to_string(),
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    if !probe.ok && probe.detail.is_empty() {
        // When no valid response arrives, retain stderr as the diagnostic for missing commands,
        // packages, or variables.
        probe.detail = child
            .stderr
            .take()
            .map(|err| {
                let mut text = String::new();
                let _ = std::io::BufReader::new(err).read_to_string(&mut text);
                short(&text)
            })
            .unwrap_or_default();
    }

    // Finalize inspection steps after process exit so stderr can explain failures.
    let mut steps = vec![Step::ok("spawn", String::new())];
    if !probe.ok {
        steps.push(Step::bad("handshake", probe.detail.clone()));
        return (probe, steps);
    }
    steps.push(Step::ok("handshake", probe.name.clone()));
    steps.push(tools_step(
        (!answered).then(|| probe.detail.clone()),
        probe.tools,
    ));
    (probe, steps)
}

/// Truncate diagnostic text to fit a single UI line.
fn short(text: &str) -> String {
    let line = text.trim().lines().next().unwrap_or_default().trim();
    if line.chars().count() > 200 {
        line.chars().take(199).collect::<String>() + "…"
    } else {
        line.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_serve_de_sufixo() {
        assert_eq!(slug("capim-backend"), "capim-backend");
        assert_eq!(slug("Meu Projeto!"), "meu-projeto");
    }

    #[test]
    fn servidores_de_um_objeto() {
        let value = json!({
            "mcpServers": {
                "notion": { "type": "http", "url": "https://mcp.notion.com/mcp" },
                "quebrado": "isto não é um objeto"
            }
        });
        let found = servers_in(&value, "origem");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, "notion");
        assert_eq!(found[0].note, "origem");
    }

    /// JSON and event-stream envelopes expose the same server identity object.
    #[test]
    fn desembrulha_json_e_fluxo_de_eventos() {
        let puro = frame(r#"{"result":{"serverInfo":{"name":"x"}}}"#).expect("json");
        assert_eq!(puro["result"]["serverInfo"]["name"], "x");
        let fluxo =
            frame("event: message\ndata: {\"result\":{\"serverInfo\":{\"name\":\"y\"}}}\n\n")
                .expect("fluxo");
        assert_eq!(fluxo["result"]["serverInfo"]["name"], "y");
        assert!(frame("não é json").is_none());
    }

    #[test]
    fn erro_cabe_numa_linha() {
        assert_eq!(short("  falhou\nmais coisa  "), "falhou");
        assert_eq!(short(&"a".repeat(300)).chars().count(), 200);
    }

    /// Ignored integration tests contact real MCP servers and may download packages: cargo test --
    /// --ignored sonda. Install the crypto provider explicitly because main does not run here.
    #[test]
    #[ignore]
    fn sonda_servidores_de_verdade() {
        let stdio = Server {
            id: "eco".into(),
            config: json!({ "command": "npx", "args": ["-y", "@modelcontextprotocol/server-everything"], "env": {} }),
            note: String::new(),
        };
        let got = check(&stdio).probe;
        println!(
            "stdio: ok={} tools={} nome={} detalhe={}",
            got.ok, got.tools, got.name, got.detail
        );
        assert!(got.ok && got.tools > 0);

        // Test a remote server without authentication using an event-stream handshake response.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let remoto = Server {
            id: "deepwiki".into(),
            config: json!({ "type": "http", "url": "https://mcp.deepwiki.com/mcp" }),
            note: String::new(),
        };
        let got = check(&remoto).probe;
        println!(
            "http: ok={} auth={} tools={} nome={} detalhe={}",
            got.ok, got.auth, got.tools, got.name, got.detail
        );
        assert!(got.ok && got.tools > 0);

        // Distinguish a reachable server requiring login from a failed connection.
        let precisa_login = Server {
            id: "notion".into(),
            config: json!({ "type": "http", "url": "https://mcp.notion.com/mcp" }),
            note: String::new(),
        };
        let got = check(&precisa_login).probe;
        println!("login: auth={} detalhe={}", got.auth, got.detail);
        assert!(got.auth);

        let nao_existe = Server {
            id: "fantasma".into(),
            config: json!({ "command": "comando-que-nao-existe", "args": [], "env": {} }),
            note: String::new(),
        };
        let got = check(&nao_existe).probe;
        assert!(!got.ok && !got.detail.is_empty());
    }

    /// Verify Codex header environment references and stdio wrappers keep secrets out of process
    /// arguments.
    #[test]
    fn a_tabela_do_codex_nao_carrega_segredo() {
        let root = std::env::temp_dir().join(format!("prometeu-codex-{}", uuid::Uuid::new_v4()));
        std::env::set_var("PROMETEU_ROOT", &root);
        let hub = vec![
            Server {
                id: "remoto".into(),
                config: json!({ "type": "http", "url": "https://x/mcp", "headers": { "X-Key": "abracadabra" } }),
                note: String::new(),
            },
            Server {
                id: "aqui".into(),
                config: json!({ "command": "npx", "args": ["-y", "coisa"], "env": { "TOKEN": "abracadabra" } }),
                note: String::new(),
            },
            Server {
                id: "simples".into(),
                config: json!({ "command": "node", "args": ["s.js"], "env": {} }),
                note: String::new(),
            },
        ];
        let body = serde_json::to_string(&hub).expect("hub");
        paths::write_private(&hub_path(), &body).expect("gravar hub");

        let chosen = vec![
            "remoto".to_string(),
            "aqui".to_string(),
            "simples".to_string(),
        ];
        let (table, env) = codex_config("aba", Some(&chosen))
            .expect("sem erro")
            .expect("há escolha");
        std::env::remove_var("PROMETEU_ROOT");

        // No secret may appear anywhere in the command line.
        assert!(!table.contains("abracadabra"), "{table}");
        // The header references an environment variable carrying its value.
        assert!(table.contains("env_http_headers"), "{table}");
        assert!(env.iter().any(|(_, v)| v == "abracadabra"));
        // Only commands with environment overrides need a shell wrapper.
        assert!(table.contains("/bin/sh"), "{table}");
        assert!(table.contains("\"node\",args=[\"s.js\"]"), "{table}");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Without an explicit selection, do not generate a configuration file or change legacy startup
    /// behavior.
    #[test]
    fn sem_escolha_nao_ha_arquivo() {
        assert!(config_for("aba", None).expect("sem erro").is_none());
    }

    #[test]
    fn so_os_escolhidos_entram() {
        let hub = vec![
            Server {
                id: "notion".into(),
                config: json!({ "type": "http", "url": "https://mcp.notion.com/mcp" }),
                note: String::new(),
            },
            Server {
                id: "drive".into(),
                config: json!({ "type": "http", "url": "https://drive" }),
                note: String::new(),
            },
        ];
        let body = config_body(&hub, &["notion".to_string(), "sumiu".to_string()], |_| None);
        let servers = body["mcpServers"].as_object().expect("objeto");
        assert_eq!(servers.len(), 1);
        assert!(servers.contains_key("notion"));
    }

    /// An empty selection still generates strict empty configuration. Inject OAuth authorization
    /// without discarding other configured headers.
    #[test]
    fn o_token_vira_cabecalho_no_arquivo_da_sessao() {
        let hub = vec![Server {
            id: "capisce".into(),
            config: json!({ "type": "http", "url": "https://x/mcp", "headers": { "X-Id": "7" } }),
            note: String::new(),
        }];
        let body = config_body(&hub, &["capisce".to_string()], |id| {
            (id == "capisce").then(|| "abc123".to_string())
        });
        let headers = &body["mcpServers"]["capisce"]["headers"];
        assert_eq!(headers["Authorization"], "Bearer abc123");
        assert_eq!(headers["X-Id"], "7");
    }

    #[test]
    fn escolher_nenhum_tem_arquivo_vazio() {
        let body = config_body(&[], &[], |_| None);
        assert_eq!(body["mcpServers"].as_object().expect("objeto").len(), 0);
    }
}
