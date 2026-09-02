//! O hub de MCP: quais servidores esta máquina conhece, e quais entram em cada
//! sessão.
//!
//! Um servidor de MCP é uma ferramenta a mais na mão do agente — o Notion, o
//! Metabase, o design system. Até aqui quem decidia isso era o CLI: o que
//! estivesse no `~/.claude.json` entrava em toda conversa, em todo workspace,
//! sempre. Duas contas ruins vinham daí. A janela de contexto: uma dúzia de
//! servidores é um catálogo de ferramentas que o agente lê a cada turno, mesmo
//! sem usar nenhuma (o `context.ts` mostra a conta). E o alcance: o agente
//! roda solto, e um workspace de Rails não precisa poder escrever no Notion.
//!
//! O hub é a lista de servidores que o Prometheus guarda, e a escolha é do
//! workspace — como o modelo e o esforço já são. Na hora de subir a conversa,
//! os escolhidos viram um arquivo e o `claude` recebe `--mcp-config` mais
//! `--strict-mcp-config`: a sessão vê exatamente o que foi marcado, e mais
//! nada. Sem escolha nenhuma (`None`, que é todo workspace criado antes disto)
//! nada é passado, e vale o que o CLI sempre fez.
//!
//! O arquivo gerado tem segredo dentro (chave de API, header de autorização),
//! e por isso é `write_private` — `0600`, em `~/.prometheus`. É também o motivo
//! de ser arquivo e não texto no comando: argumento de processo qualquer um lê
//! com `ps`, e `--mcp-config` aceita os dois.
//!
//! O cadastro não começa vazio: `mcp_found` lê o que já está configurado no
//! `~/.claude.json` (o do usuário e o de cada projeto) e no `.mcp.json` de cada
//! repositório, e oferece para importar. Ninguém recadastra o que já tem.
//!
//! O que o hub não faz: OAuth. Servidor remoto que pede consentimento continua
//! sendo autenticado pelo CLI (`claude mcp`), e o hub só o marca ou desmarca.
//! Ele também só vale para o Claude Code — o Codex tem o cadastro dele em
//! `~/.codex/config.toml`, e uma aba de Codex continua vendo o que está lá.

use crate::i18n;
use crate::mcp_auth;
use crate::paths;
use serde_json::{json, Map, Value};
use std::io::{BufRead, Read, Write};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Um servidor como o hub o guarda. `config` é o objeto do `mcpServers` como o
/// Claude Code o entende — guardado inteiro, e não em campos nossos, porque a
/// forma é dele: um `type` novo do CLI passa por aqui sem release do
/// Prometheus.
#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct Server {
    /// O nome do servidor, que é a chave dentro de `mcpServers` e o prefixo de
    /// toda ferramenta que ele oferece (`mcp__notion__…`).
    pub id: String,
    pub config: Value,
    /// De onde veio, ou para que serve. Livre — é a linha embaixo do nome.
    #[serde(default)]
    pub note: String,
}

/// Onde o cadastro mora. Tem chave de API dentro, então é dos arquivos que só
/// o dono lê.
fn hub_path() -> PathBuf {
    paths::root().join("mcp.json")
}

/// O arquivo que uma sessão recebe. Um por aba: a escolha é do workspace, mas
/// quem sobe processo é a aba, e duas abas subindo ao mesmo tempo não podem
/// disputar o mesmo nome.
fn session_path(id: &str) -> PathBuf {
    paths::root().join("mcp").join(format!("{id}.json"))
}

pub fn load() -> Vec<Server> {
    std::fs::read_to_string(hub_path())
        .ok()
        .and_then(|raw| serde_json::from_str::<Vec<Server>>(&raw).ok())
        .unwrap_or_default()
}

fn store(servers: &[Server]) -> Result<(), String> {
    let body = serde_json::to_string_pretty(servers).map_err(|e| e.to_string())?;
    paths::write_private(&hub_path(), &body)
        .map_err(|cause| i18n::ta("err.mcp.save", &[("cause", cause)]))
}

/// O cadastro inteiro, para a tela de Configurações e para os seletores.
#[tauri::command]
pub fn mcp_hub() -> Vec<Server> {
    load()
}

/// Grava um servidor — novo, ou por cima do que tinha o mesmo nome. O nome é a
/// identidade: é ele que o agente vê no prefixo das ferramentas, e dois
/// servidores com o mesmo nome numa sessão seriam um só.
#[tauri::command]
pub fn mcp_save(server: Server) -> Result<Vec<Server>, String> {
    let id = server.id.trim().to_string();
    if id.is_empty() {
        return Err(i18n::t("err.mcp.noName"));
    }
    if !server.config.is_object() {
        return Err(i18n::t("err.mcp.badConfig"));
    }
    let mut servers = load();
    let server = Server { id, ..server };
    match servers.iter_mut().find(|s| s.id == server.id) {
        Some(old) => *old = server,
        None => servers.push(server),
    }
    servers.sort_by_key(|s| s.id.to_lowercase());
    store(&servers)?;
    Ok(servers)
}

#[tauri::command]
pub fn mcp_remove(id: String) -> Result<Vec<Server>, String> {
    let mut servers = load();
    servers.retain(|s| s.id != id);
    store(&servers)?;
    Ok(servers)
}

/// O que dá para importar: o que já está configurado nos arquivos do CLI e
/// ainda não está no hub. Não mexe em arquivo nenhum do usuário — só lê.
#[tauri::command]
pub fn mcp_found() -> Vec<Server> {
    let known = load();
    let mut found: Vec<Server> = Vec::new();
    for server in from_claude_json().into_iter().chain(from_repo_files()) {
        // Já cadastrado, ou já visto neste mesmo varrimento com a mesma
        // configuração: o `capim-ds` de três projetos é um servidor só.
        if known.iter().any(|s| s.id == server.id)
            || found
                .iter()
                .any(|s| s.id == server.id && s.config == server.config)
        {
            continue;
        }
        // Mesmo nome, configuração diferente (o `whatsapp` local e o de
        // produção): os dois cabem, mas não com o mesmo nome.
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

/// Um nome de origem virando sufixo de nome de servidor: o agente vê isto no
/// prefixo de cada ferramenta, então só o que passa em qualquer lugar.
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

/// O `~/.claude.json`: o `mcpServers` do usuário, e o de cada projeto que ele
/// guarda lá dentro. O nome do projeto (a última pasta do caminho) vira a
/// origem, que é o que a tela mostra e o que desempata nome repetido. Origem
/// vazia é o cadastro do usuário — o back não escreve frase, e "do usuário" é
/// frase; quem a escreve é a tela.
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

/// O `.mcp.json` na raiz de cada repositório que o `~/.claude.json` conhece —
/// o cadastro que o time versiona junto do código.
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

/// O `mcpServers` de um objeto qualquer — a raiz do `~/.claude.json`, um
/// projeto dele, ou um `.mcp.json`.
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

/// O arquivo que vai no `--mcp-config` desta aba, quando o workspace escolheu.
/// `None` é workspace que nunca escolheu — e aí nada é passado, que é o que o
/// app fazia antes disto existir.
///
/// Escolher e marcar nenhum é escolha: o arquivo sai vazio, e com o
/// `--strict-mcp-config` do lado é uma sessão sem MCP nenhum.
pub fn config_for(id: &str, chosen: Option<&Vec<String>>) -> Result<Option<PathBuf>, String> {
    let Some(chosen) = chosen else {
        return Ok(None);
    };
    let path = session_path(id);
    // O token entra aqui, e não no cadastro: é neste instante que ele é
    // renovado, e é este arquivo que a sessão vai ler. Ver `mcp_auth.rs`.
    let body = serde_json::to_string_pretty(&config_body(&load(), chosen, mcp_auth::bearer))
        .map_err(|e| e.to_string())?;
    paths::write_private(&path, &body)
        .map_err(|cause| i18n::ta("err.mcp.session", &[("cause", cause)]))?;
    Ok(Some(path))
}

/// O conteúdo do arquivo: os escolhidos que o hub ainda tem, na forma que o
/// CLI espera. Servidor apagado do hub depois de escolhido some da sessão em
/// vez de derrubá-la — o que o agente perde é uma ferramenta, e dizer isso é
/// trabalho da tela, não motivo para a conversa não subir.
/// `bearer` é quem sabe o token de cada servidor — parâmetro, e não chamada
/// direta, para o teste desta função não depender de arquivo nenhum.
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
        // Quem entrou pelo OAuth entra na sessão com o cabeçalho pronto: o
        // `claude` não sabe (nem precisa saber) que houve login.
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

/* ---------- testar um servidor ---------- */

/// O que o teste descobriu. É o Prometheus falando com o servidor, e não o
/// `claude` — o que se quer saber é se o cadastro está certo, e um agente no
/// meio só somaria um jeito de errar.
#[derive(serde::Serialize, Default)]
pub struct Probe {
    /// Conectou e listou as ferramentas.
    pub ok: bool,
    /// Respondeu 401: o cadastro está certo, falta login. É outro problema, e
    /// a tela diz outra coisa.
    pub auth: bool,
    pub tools: usize,
    /// Como o servidor se chama — a prova de que quem respondeu é ele.
    pub name: String,
    /// A causa crua, quando não deu: o erro do sistema, o corpo do servidor.
    /// Não é frase de tela; quem escreve a frase é o front.
    pub detail: String,
}

/// Quanto se espera um servidor responder. Um stdio sobe `npx`, que baixa
/// pacote na primeira vez; um remoto atravessa a internet. Passou disto, o
/// problema é ele, e o teste tem que devolver a tela para quem clicou.
const PROBE_WAIT: Duration = Duration::from_secs(25);

/// A revisão do protocolo com que nos apresentamos. O servidor responde com a
/// dele, e quem não fala esta negocia para baixo — é o handshake que o MCP
/// prevê, e por isso um número fixo aqui não envelhece mal.
const PROTOCOL: &str = "2025-06-18";

fn hello() -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": PROTOCOL,
            "capabilities": {},
            "clientInfo": { "name": "Prometheus", "version": env!("CARGO_PKG_VERSION") }
        }
    })
}

/// Testa o servidor como ele está no formulário — antes de gravar, e sem
/// depender de estar cadastrado em lugar nenhum.
#[tauri::command]
pub async fn mcp_test(server: Server) -> Probe {
    // HTTP bloqueante e processo filho não podem rodar numa worker do runtime
    // async (ver `linear::blocking`).
    tauri::async_runtime::spawn_blocking(move || probe(&server))
        .await
        .unwrap_or_else(|e| Probe {
            detail: e.to_string(),
            ..Probe::default()
        })
}

/// Entrar num servidor que pede login. O caminho inteiro está em
/// `mcp_auth.rs`; daqui sai só o `401` que dá a partida — é o cabeçalho dele
/// que diz onde ficam os metadados do OAuth.
#[tauri::command]
pub async fn mcp_login(server: Server) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let url = server
            .config
            .get("url")
            .and_then(Value::as_str)
            .ok_or_else(|| i18n::t("err.mcp.auth.notRemote"))?
            .to_string();
        // Sem token de propósito: o que se quer aqui é justamente o `401`.
        let (_, challenge) = probe_http(&url, &server.config, None);
        mcp_auth::login(&server.id, &url, challenge.as_deref())
    })
    .await
    .map_err(|e| i18n::ta("err.mcp.auth.taskDied", &[("cause", e.to_string())]))?
}

#[tauri::command]
pub fn mcp_logout(id: String) -> Result<(), String> {
    mcp_auth::forget(&id)
}

/// Em quais servidores já se entrou — a tela marca esses como conectados.
#[tauri::command]
pub fn mcp_logins() -> Vec<String> {
    mcp_auth::logged_in()
}

fn probe(server: &Server) -> Probe {
    match server.config.get("url").and_then(Value::as_str) {
        // Com o token de quem já entrou: testar depois do login tem que dizer
        // "conectou", e não repetir "precisa de login".
        Some(url) => probe_http(url, &server.config, mcp_auth::bearer(&server.id).as_deref()).0,
        None => probe_stdio(&server.config),
    }
}

/// Um servidor remoto: `initialize` por POST, e depois `tools/list` com a
/// sessão que ele devolveu. A resposta vem como JSON ou como um fluxo de
/// eventos — os dois são o mesmo objeto, e `frame` desembrulha os dois.
/// Devolve o que descobriu e, quando o servidor pediu login, o
/// `WWW-Authenticate` dele — é por esse cabeçalho que a descoberta do OAuth
/// começa (`mcp_auth::discover`).
fn probe_http(url: &str, config: &Value, token: Option<&str>) -> (Probe, Option<String>) {
    let client = match reqwest::blocking::Client::builder()
        .timeout(PROBE_WAIT)
        .build()
    {
        Ok(client) => client,
        Err(e) => {
            return (
                Probe {
                    detail: e.to_string(),
                    ..Probe::default()
                },
                None,
            )
        }
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
            // O transporte novo pode responder das duas formas, e recusar uma
            // delas é recusar metade dos servidores que existem hoje.
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
        Err(e) => {
            return (
                Probe {
                    detail: e.to_string(),
                    ..Probe::default()
                },
                None,
            )
        }
    };
    // 401 é o servidor dizendo "sei quem você quer ser, prove". O cadastro
    // está certo; o que falta é login, e isso a tela resolve de outro jeito.
    if first.status() == reqwest::StatusCode::UNAUTHORIZED {
        let challenge = first
            .headers()
            .get("www-authenticate")
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        return (
            Probe {
                auth: true,
                ..Probe::default()
            },
            challenge,
        );
    }
    let session = first
        .headers()
        .get("mcp-session-id")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    if !first.status().is_success() {
        let status = first.status();
        return (
            Probe {
                detail: format!("{status} {}", short(&first.text().unwrap_or_default())),
                ..Probe::default()
            },
            None,
        );
    }
    let hello_body = first.text().unwrap_or_default();
    let Some(result) = frame(&hello_body) else {
        return (
            Probe {
                detail: short(&hello_body),
                ..Probe::default()
            },
            None,
        );
    };
    let name = result["result"]["serverInfo"]["name"]
        .as_str()
        .unwrap_or_default()
        .to_string();

    // O `initialized` não tem resposta: é o aviso de que o aperto de mão
    // acabou, e sem ele há servidor que recusa o resto.
    let _ = post(
        &json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
        session.as_deref(),
    );
    let listed = post(
        &json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }),
        session.as_deref(),
    );
    let tools = listed
        .ok()
        .and_then(|r| r.text().ok())
        .and_then(|body| frame(&body))
        .and_then(|value| value["result"]["tools"].as_array().map(Vec::len))
        .unwrap_or(0);
    (
        Probe {
            ok: true,
            auth: false,
            tools,
            name,
            detail: String::new(),
        },
        None,
    )
}

/// A resposta de um POST, seja ela JSON puro ou um fluxo de eventos — no fluxo,
/// o que interessa está depois de `data:`, e é a primeira linha dessas que
/// carrega o resultado do pedido.
fn frame(body: &str) -> Option<Value> {
    if let Ok(value) = serde_json::from_str::<Value>(body) {
        return Some(value);
    }
    body.lines()
        .filter_map(|line| line.strip_prefix("data:"))
        .find_map(|data| serde_json::from_str::<Value>(data.trim()).ok())
}

/// Um servidor que roda aqui: sobe o processo, aperta a mão pelo stdin e conta
/// as ferramentas. O processo morre no fim do teste — testar não é deixar nada
/// de pé.
fn probe_stdio(config: &Value) -> Probe {
    let Some(command) = config.get("command").and_then(Value::as_str) else {
        return Probe {
            detail: "sem command nem url".into(),
            ..Probe::default()
        };
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
    // Grupo próprio: o `npx` de um servidor vira `node`, e matar o pai sem o
    // grupo deixaria o filho de pé depois do teste.
    cmd.process_group(0)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => {
            return Probe {
                detail: e.to_string(),
                ..Probe::default()
            }
        }
    };

    let mut probe = Probe::default();
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
                // Um servidor fala mais do que responde: log, notificação, e as
                // duas respostas que pedimos, em qualquer ordem.
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
        // Nada de válido em tempo nenhum: o que ele reclamou no stderr é a
        // única pista que sobra, e costuma ser a certa (comando não achado,
        // pacote inexistente, variável faltando).
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
    probe
}

/// O bastante de uma mensagem para caber numa linha da tela.
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

    /// O que uma resposta de fluxo de eventos tem dentro é o mesmo objeto que
    /// a de JSON puro — e é dele que sai o nome do servidor.
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

    /// Sobe um servidor de MCP de verdade e aperta a mão com ele. Fora do
    /// `cargo test` de sempre porque baixa pacote com `npx`:
    /// `cargo test -- --ignored sonda`.
    ///
    /// O caminho HTTP precisa do provedor de criptografia que o `main` instala
    /// — fora do app ninguém o instalou, e o teste o instala por conta.
    #[test]
    #[ignore]
    fn sonda_servidores_de_verdade() {
        let stdio = Server {
            id: "eco".into(),
            config: json!({ "command": "npx", "args": ["-y", "@modelcontextprotocol/server-everything"], "env": {} }),
            note: String::new(),
        };
        let got = probe(&stdio);
        println!(
            "stdio: ok={} tools={} nome={} detalhe={}",
            got.ok, got.tools, got.name, got.detail
        );
        assert!(got.ok && got.tools > 0);

        // Um servidor remoto que não pede login: o aperto de mão inteiro pela
        // rede, com a resposta chegando como fluxo de eventos.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let remoto = Server {
            id: "deepwiki".into(),
            config: json!({ "type": "http", "url": "https://mcp.deepwiki.com/mcp" }),
            note: String::new(),
        };
        let got = probe(&remoto);
        println!(
            "http: ok={} auth={} tools={} nome={} detalhe={}",
            got.ok, got.auth, got.tools, got.name, got.detail
        );
        assert!(got.ok && got.tools > 0);

        // Um que pede login: o cadastro está certo, e é isso que a tela precisa
        // distinguir de "não conectou".
        let precisa_login = Server {
            id: "notion".into(),
            config: json!({ "type": "http", "url": "https://mcp.notion.com/mcp" }),
            note: String::new(),
        };
        let got = probe(&precisa_login);
        println!("login: auth={} detalhe={}", got.auth, got.detail);
        assert!(got.auth);

        let nao_existe = Server {
            id: "fantasma".into(),
            config: json!({ "command": "comando-que-nao-existe", "args": [], "env": {} }),
            note: String::new(),
        };
        let got = probe(&nao_existe);
        assert!(!got.ok && !got.detail.is_empty());
    }

    /// Sem escolha nenhuma não há arquivo — é o workspace de antes desta
    /// funcionalidade, e ele tem que continuar subindo como sempre subiu.
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

    /// Marcar nenhum é uma escolha, e ela tem arquivo: vazio, que com o
    /// `--strict-mcp-config` do lado é uma sessão sem MCP nenhum.
    /// Quem entrou pelo OAuth chega à sessão com o cabeçalho pronto, e o que
    /// já tinha cabeçalho não perde o que tinha.
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
