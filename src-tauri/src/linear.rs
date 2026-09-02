//! Conexão com o Linear: OAuth 2.0 com PKCE, inteira no Mac de quem usa.
//!
//! Não há servidor do Prometheus no meio. O app OAuth foi registrado uma vez
//! no Linear — é o `CLIENT_ID` abaixo, público por definição — e cada pessoa
//! só clica em "Conectar", aprova no navegador e volta. O que substitui o
//! `client_secret`, que num `.app` qualquer um extrai, é o PKCE: um segredo
//! aleatório gerado na hora, que nunca sai deste processo.
//!
//! O fluxo, na ordem:
//!
//!   1. abre um socket em `127.0.0.1:17420`, gera `code_verifier` e `state`;
//!   2. abre `linear.app/oauth/authorize` no navegador padrão;
//!   3. o Linear devolve o navegador para `localhost:17420/linear?code=…`;
//!   4. troca o `code` pelo token em `api.linear.app/oauth/token`, provando
//!      com o verifier que quem pede é quem começou;
//!   5. guarda em `~/.prometheus/linear.json`, que só o dono lê, e avisa a
//!      tela pelo evento `linear`.
//!
//! A porta é fixa porque o Linear exige o redirect exato que foi registrado
//! no app OAuth. O socket só existe enquanto o fluxo dura, então o app de dev
//! e o instalado não brigam por ela.
//!
//! O token vale 24h e vem com um `refresh_token`; `token()` renova sozinho
//! antes de cada uso. Fica num arquivo e não no Keychain de propósito: o
//! `.app` não é assinado pela Apple, então cada atualização seria um binário
//! novo aos olhos do Keychain — e um "Prometheus quer usar sua senha" a cada
//! versão. O escopo é só leitura.

use crate::i18n;
use crate::lock::lock;
use crate::oauth::{self, challenge, escape, form, now, random};
use crate::paths;
use serde::{Deserialize, Serialize};
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

/// O id do app OAuth "Prometheus" registrado no Linear. É público: é o que a
/// tela de consentimento mostra, e não abre nada sem o consentimento.
pub const CLIENT_ID: &str = "f5450b36b19aab8193b7d8da649231be";
const PORT: u16 = 17420;
const REDIRECT: &str = "http://localhost:17420/linear";
const AUTHORIZE: &str = "https://linear.app/oauth/authorize";
const TOKEN: &str = "https://api.linear.app/oauth/token";
const REVOKE: &str = "https://api.linear.app/oauth/revoke";
pub const GRAPHQL: &str = "https://api.linear.app/graphql";
/// Quanto tempo o socket espera o navegador voltar. Aprovar leva segundos;
/// cinco minutos é para quem foi buscar a senha.
const WAIT: Duration = Duration::from_secs(5 * 60);
/// Renova o token com esta folga: uma chamada que começa com o token válido
/// não pode terminar com ele vencido.
const SLACK: u64 = 5 * 60;

/// Quem está do outro lado, para a tela dizer "conectado como…".
#[derive(Serialize, Deserialize, Clone, Default, PartialEq)]
pub struct Who {
    pub name: String,
    pub email: String,
    /// O workspace do Linear (a organização), e o `urlKey` dele.
    pub org: String,
    pub org_key: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Auth {
    pub access_token: String,
    pub refresh_token: Option<String>,
    /// Unix, em segundos.
    pub expires_at: u64,
    pub who: Who,
}

/// O que a tela de configurações desenha.
#[derive(Serialize, Clone)]
pub struct Status {
    pub connected: bool,
    pub who: Option<Who>,
    /// Há um fluxo esperando o navegador. A tela mostra isso mesmo que você
    /// saia e volte no meio.
    pub busy: bool,
}

/// Só um fluxo por vez: o segundo clique em "Conectar" com o primeiro ainda
/// esperando o navegador ganharia a porta ocupada como erro, e isso é pior do
/// que dizer o que está acontecendo.
static PENDING: AtomicBool = AtomicBool::new(false);

/* ---------- comandos ---------- */

#[tauri::command]
pub fn linear_status() -> Status {
    status()
}

/// Espera o navegador por minutos, e faz HTTP bloqueante — as duas coisas
/// fora do runtime async, em `spawn_blocking`. Um `command(async)` comum
/// roda numa worker do tokio, e o `reqwest::blocking` derruba o runtime
/// interno dele ao sair: dentro de uma worker isso é panic ("Cannot drop a
/// runtime in a context where blocking is not allowed").
#[tauri::command]
pub async fn linear_connect(app: AppHandle) -> Result<Status, String> {
    if PENDING.swap(true, Ordering::SeqCst) {
        return Err(i18n::t("err.linear.waiting"));
    }
    let result = blocking(connect).await;
    PENDING.store(false, Ordering::SeqCst);
    // De volta para a frente: o navegador ficou com o foco, e o que vem depois
    // de aprovar acontece aqui.
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.set_focus();
    }
    let now = status();
    let _ = app.emit("linear", &now);
    result.map(|_| now)
}

#[tauri::command]
pub async fn linear_disconnect(app: AppHandle) -> Status {
    let _ = blocking(|| {
        if let Some(auth) = load() {
            // Melhor esforço: o token morre sozinho em 24h, e o refresh some
            // com o arquivo. Revogar é cortesia com quem olha a lista de apps
            // no Linear.
            let _ = reqwest::blocking::Client::new()
                .post(REVOKE)
                .bearer_auth(&auth.access_token)
                .header("Content-Type", "application/x-www-form-urlencoded")
                .body(form(&[("token", auth.access_token.as_str())]))
                .timeout(Duration::from_secs(10))
                .send();
        }
        *lock(&CACHE) = None;
        let _ = std::fs::remove_file(issues_path());
        std::fs::remove_file(path()).map_err(i18n::io)
    })
    .await;
    let now = status();
    let _ = app.emit("linear", &now);
    now
}

/// Roda `work` numa thread de bloqueio do runtime e devolve o resultado.
/// Todo `token()` e `graphql()` tem que passar por aqui quando chamado de um
/// comando: são HTTP síncrono, e síncrono dentro de worker async é panic.
pub async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| i18n::ta("err.linear.taskDied", &[("cause", e.to_string())]))?
}

/* ---------- o fluxo ---------- */

fn connect() -> Result<Auth, String> {
    let listener = TcpListener::bind(("127.0.0.1", PORT)).map_err(|e| {
        i18n::ta(
            "err.linear.port",
            &[("port", PORT.to_string()), ("cause", e.to_string())],
        )
    })?;
    listener.set_nonblocking(true).map_err(i18n::io)?;

    let verifier = random();
    let state = random();
    let url = format!(
        "{AUTHORIZE}?client_id={CLIENT_ID}&redirect_uri={}&response_type=code&scope=read\
         &state={state}&code_challenge={}&code_challenge_method=S256&prompt=consent",
        escape(REDIRECT),
        challenge(&verifier),
    );
    oauth::browse(&url).map_err(|_| i18n::t("err.linear.noBrowser"))?;

    let code = wait_for_code(&listener, &state, Instant::now() + WAIT)?;
    let mut auth = exchange(&code, &verifier)?;
    auth.who = whoami(&auth.access_token)?;
    save(&auth)?;
    Ok(auth)
}

/// A espera é a genérica (`oauth::wait_for_code`); o que é do Linear é como
/// cada recusa se chama na tela.
fn wait_for_code(listener: &TcpListener, state: &str, deadline: Instant) -> Result<String, String> {
    oauth::wait_for_code(listener, "/linear", state, deadline, &page).map_err(|denied| match denied
    {
        oauth::Denied::Refused => i18n::t("err.linear.denied"),
        oauth::Denied::Error(why) => i18n::ta("err.linear.refused", &[("why", why)]),
        oauth::Denied::NoCode => i18n::t("err.linear.noCode"),
        oauth::Denied::Timeout => i18n::t("err.linear.timeout"),
        oauth::Denied::Broken(cause) => i18n::ta(
            "err.linear.portDied",
            &[("port", PORT.to_string()), ("cause", cause)],
        ),
    })
}

/// O que a página do fim do fluxo diz, nos dois idiomas. O HTML é do
/// `oauth::page`; daqui saem só as duas linhas — que são das poucas frases que
/// o back escreve por inteiro, porque quem as lê está no navegador, longe do
/// catálogo do front.
fn page(ok: bool, why: &str) -> String {
    let (title, text) = match (ok, i18n::pt()) {
        (true, true) => (
            "Linear conectado",
            "Pode fechar esta aba e voltar ao Prometheus.".to_string(),
        ),
        (true, false) => (
            "Linear connected",
            "You can close this tab and go back to Prometheus.".to_string(),
        ),
        (false, true) => (
            "Não deu",
            format!("O Linear não autorizou o Prometheus. {why}")
                .trim()
                .to_string(),
        ),
        (false, false) => (
            "Did not work",
            format!("Linear did not authorize Prometheus. {why}")
                .trim()
                .to_string(),
        ),
    };
    oauth::page(title, &text)
}

/// Troca o `code` pelo token. Sem `client_secret`: o verifier é a prova.
fn exchange(code: &str, verifier: &str) -> Result<Auth, String> {
    let got = token_request(&[
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", REDIRECT),
        ("client_id", CLIENT_ID),
        ("code_verifier", verifier),
    ])?;
    Ok(got)
}

fn refresh(auth: &Auth) -> Result<Auth, String> {
    let rt = auth
        .refresh_token
        .as_deref()
        .ok_or_else(|| i18n::t("err.linear.expired"))?;
    let mut got = token_request(&[
        ("grant_type", "refresh_token"),
        ("refresh_token", rt),
        ("client_id", CLIENT_ID),
    ])?;
    // Alguns servidores não devolvem refresh novo na renovação; o velho segue valendo.
    if got.refresh_token.is_none() {
        got.refresh_token = auth.refresh_token.clone();
    }
    got.who = auth.who.clone();
    Ok(got)
}

#[derive(Deserialize)]
struct TokenReply {
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
    error: Option<String>,
    error_description: Option<String>,
}

fn token_request(fields: &[(&str, &str)]) -> Result<Auth, String> {
    let reply: TokenReply = reqwest::blocking::Client::new()
        .post(TOKEN)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(form(fields))
        .timeout(Duration::from_secs(20))
        .send()
        .map_err(|e| i18n::ta("err.linear.unreachable", &[("cause", e.to_string())]))?
        .json()
        .map_err(|e| i18n::ta("err.linear.garbled", &[("cause", e.to_string())]))?;
    if let Some(err) = reply.error {
        return Err(format!(
            "o Linear recusou: {err} {}",
            reply.error_description.unwrap_or_default()
        )
        .trim()
        .to_string());
    }
    let access_token = reply
        .access_token
        .ok_or_else(|| i18n::t("err.linear.noToken"))?;
    Ok(Auth {
        access_token,
        refresh_token: reply.refresh_token,
        expires_at: now() + reply.expires_in.unwrap_or(86_400),
        who: Who::default(),
    })
}

/* ---------- GraphQL ---------- */

/// Um token bom para usar agora: renovado se está para vencer, e gravado de
/// volta quando renova. É por aqui que toda chamada ao Linear passa — a
/// lista de issues é quem chama.
pub fn token() -> Result<String, String> {
    let auth = load().ok_or_else(|| i18n::t("err.linear.off"))?;
    if auth.expires_at > now() + SLACK {
        return Ok(auth.access_token);
    }
    let fresh = refresh(&auth)?;
    save(&fresh)?;
    Ok(fresh.access_token)
}

/// Uma query, com variáveis. Devolve o `data`; erros do GraphQL viram `Err`.
pub fn graphql(
    token: &str,
    query: &str,
    vars: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let reply: serde_json::Value = reqwest::blocking::Client::new()
        .post(GRAPHQL)
        .bearer_auth(token)
        .json(&serde_json::json!({ "query": query, "variables": vars }))
        .timeout(Duration::from_secs(30))
        .send()
        .map_err(|e| i18n::ta("err.linear.unreachable", &[("cause", e.to_string())]))?
        .error_for_status()
        .map_err(|e| match e.status() {
            Some(reqwest::StatusCode::UNAUTHORIZED) => i18n::t("err.linear.rejected"),
            Some(reqwest::StatusCode::TOO_MANY_REQUESTS) => i18n::t("err.linear.slowDown"),
            _ => i18n::ta("err.linear.http", &[("status", e.to_string())]),
        })?
        .json()
        .map_err(|e| i18n::ta("err.linear.garbled", &[("cause", e.to_string())]))?;
    if let Some(errs) = reply.get("errors").and_then(|e| e.as_array()) {
        let msg = errs
            .iter()
            .filter_map(|e| e.get("message").and_then(|m| m.as_str()))
            .collect::<Vec<_>>()
            .join("; ");
        return Err(i18n::ta("err.linear.queryRefused", &[("why", msg)]));
    }
    reply
        .get("data")
        .cloned()
        .ok_or_else(|| i18n::t("err.linear.noData"))
}

fn whoami(token: &str) -> Result<Who, String> {
    let data = graphql(
        token,
        "{ viewer { name email organization { name urlKey } } }",
        serde_json::json!({}),
    )?;
    let v = &data["viewer"];
    let s = |x: &serde_json::Value| x.as_str().unwrap_or("").to_string();
    Ok(Who {
        name: s(&v["name"]),
        email: s(&v["email"]),
        org: s(&v["organization"]["name"]),
        org_key: s(&v["organization"]["urlKey"]),
    })
}

/* ---------- o arquivo ---------- */

fn path() -> PathBuf {
    paths::root().join("linear.json")
}

pub fn load() -> Option<Auth> {
    serde_json::from_str(&std::fs::read_to_string(path()).ok()?).ok()
}

fn save(auth: &Auth) -> Result<(), String> {
    let body = serde_json::to_string_pretty(auth).map_err(|e| e.to_string())?;
    paths::write_private(&path(), &body).map_err(|cause| {
        i18n::ta(
            "err.linear.write",
            &[("path", path().display().to_string()), ("cause", cause)],
        )
    })
}

pub fn status() -> Status {
    let who = load().map(|a| a.who);
    Status {
        connected: who.is_some(),
        who,
        busy: PENDING.load(Ordering::SeqCst),
    }
}

/* ---------- issues ---------- */

/// O que da issue o workspace guarda: o bastante para o chip no card, o link
/// e para a aba saber que "esta já tem workspace". O resto vive no cache.
#[derive(Serialize, Deserialize, Clone, Default, PartialEq)]
pub struct IssueRef {
    pub id: String,
    pub identifier: String,
    pub title: String,
    pub url: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct IssueState {
    pub name: String,
    /// `backlog`, `unstarted`, `started`, `triage` — os tipos do Linear. É
    /// o que agrupa a aba; o `name` é o que o time escolheu chamar.
    pub kind: String,
    pub color: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Label {
    pub name: String,
    pub color: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Issue {
    pub id: String,
    pub identifier: String,
    pub title: String,
    pub description: Option<String>,
    pub url: String,
    /// O nome de branch que o próprio Linear sugere. Usar esse é o que faz
    /// o Linear reconhecer o PR como desta issue.
    pub branch_name: String,
    /// 0 sem, 1 urgente, 2 alta, 3 média, 4 baixa — a escala do Linear.
    pub priority: u8,
    pub priority_label: String,
    pub state: IssueState,
    pub team: String,
    pub project: Option<String>,
    pub labels: Vec<Label>,
    pub updated_at: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Issues {
    pub issues: Vec<Issue>,
    /// Unix, segundos. É o "atualizado há" da aba.
    pub fetched_at: u64,
}

/// Quanto tempo a lista vale sem perguntar de novo. Abrir a aba dez vezes
/// num minuto é uma chamada; o botão de atualizar ignora isto.
const FRESH: u64 = 120;
/// Páginas de 50: dez é o teto — 500 issues no seu nome é mais do que
/// qualquer lista mostra.
const PAGES: usize = 10;

/// A lista em memória; o arquivo é a cópia que faz o app abrir já com ela.
static CACHE: Mutex<Option<Issues>> = Mutex::new(None);

const ISSUES_QUERY: &str = r#"query Mine($after: String) {
  viewer {
    assignedIssues(first: 50, after: $after, orderBy: updatedAt,
      filter: { state: { type: { nin: ["completed", "canceled"] } } }) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id identifier title description url branchName priority priorityLabel updatedAt
        state { name type color } team { key } project { name } labels { nodes { name color } }
      }
    }
  }
}"#;

/// As issues no seu nome, fora concluídas e canceladas. `force` é o botão
/// de atualizar; sem ele, o que foi buscado há menos de dois minutos serve.
#[tauri::command]
pub async fn linear_issues(force: bool) -> Result<Issues, String> {
    blocking(move || issues(force)).await
}

fn issues(force: bool) -> Result<Issues, String> {
    let cached = lock(&CACHE).clone().or_else(load_issues);
    if let Some(c) = &cached {
        if !force && c.fetched_at + FRESH > now() {
            *lock(&CACHE) = Some(c.clone());
            return Ok(c.clone());
        }
    }
    let fresh = fetch_issues()?;
    *lock(&CACHE) = Some(fresh.clone());
    // Cache que não grava não é erro: a lista chegou, e é isso que importa.
    if let Ok(body) = serde_json::to_string(&fresh) {
        let _ = paths::write_private(&issues_path(), &body);
    }
    Ok(fresh)
}

fn fetch_issues() -> Result<Issues, String> {
    let token = token()?;
    let mut all = Vec::new();
    let mut after: Option<String> = None;
    for _ in 0..PAGES {
        let data = graphql(&token, ISSUES_QUERY, serde_json::json!({ "after": after }))?;
        let page: Page = serde_json::from_value(data["viewer"]["assignedIssues"].clone())
            .map_err(|e| i18n::ta("err.linear.garbled", &[("cause", e.to_string())]))?;
        all.extend(page.nodes.into_iter().map(Issue::from));
        if !page.page_info.has_next_page {
            break;
        }
        after = page.page_info.end_cursor;
    }
    Ok(Issues {
        issues: all,
        fetched_at: now(),
    })
}

fn issues_path() -> PathBuf {
    paths::root().join("linear-issues.json")
}

fn load_issues() -> Option<Issues> {
    serde_json::from_str(&std::fs::read_to_string(issues_path()).ok()?).ok()
}

/// Abrir uma issue no navegador. Só links do Linear: é o único lugar de onde
/// esta URL vem, e `open` com qualquer coisa é `open` com qualquer coisa.
#[tauri::command]
pub fn linear_open(url: String) -> Result<(), String> {
    if !url.starts_with("https://linear.app/") {
        return Err(i18n::t("err.linear.notALink"));
    }
    oauth::browse(&url).map_err(|_| i18n::t("err.linear.noBrowser"))
}

/* O formato do GraphQL, e a tradução para o nosso. */

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Page {
    page_info: PageInfo,
    nodes: Vec<Raw>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageInfo {
    has_next_page: bool,
    end_cursor: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Raw {
    id: String,
    identifier: String,
    title: String,
    description: Option<String>,
    url: String,
    branch_name: String,
    priority: u8,
    priority_label: String,
    updated_at: String,
    state: RawState,
    team: Option<RawKey>,
    project: Option<RawName>,
    labels: RawLabels,
}

#[derive(Deserialize)]
struct RawState {
    name: String,
    #[serde(rename = "type")]
    kind: String,
    color: String,
}

#[derive(Deserialize)]
struct RawKey {
    key: String,
}

#[derive(Deserialize)]
struct RawName {
    name: String,
}

#[derive(Deserialize)]
struct RawLabels {
    nodes: Vec<Label>,
}

impl From<Raw> for Issue {
    fn from(r: Raw) -> Issue {
        Issue {
            id: r.id,
            identifier: r.identifier,
            title: r.title,
            description: r.description.filter(|d| !d.trim().is_empty()),
            url: r.url,
            branch_name: r.branch_name,
            priority: r.priority,
            priority_label: r.priority_label,
            state: IssueState {
                name: r.state.name,
                kind: r.state.kind,
                color: r.state.color,
            },
            team: r.team.map(|t| t.key).unwrap_or_default(),
            project: r.project.map(|p| p.name),
            labels: r.labels.nodes,
            updated_at: r.updated_at,
        }
    }
}

/* ---------- miudezas ---------- */

#[cfg(test)]
mod tests {
    use super::*;
    // Estas eram daqui e agora são de todo fluxo de OAuth (`oauth.rs`); os
    // testes ficaram porque o que eles conferem é o redirect do Linear.
    use crate::oauth::{parse_query, request_target, unescape};

    #[test]
    fn o_verifier_tem_o_tamanho_da_rfc() {
        let v = random();
        assert!((43..=128).contains(&v.len()), "{}", v.len());
        assert!(v.bytes().all(|b| b.is_ascii_hexdigit()));
        assert_ne!(random(), random());
    }

    #[test]
    fn o_corpo_do_token_e_urlencoded() {
        assert_eq!(
            form(&[
                ("grant_type", "authorization_code"),
                ("redirect_uri", REDIRECT)
            ]),
            "grant_type=authorization_code&redirect_uri=http%3A%2F%2Flocalhost%3A17420%2Flinear"
        );
    }

    #[test]
    fn o_redirect_vai_escapado_e_volta() {
        assert_eq!(escape(REDIRECT), "http%3A%2F%2Flocalhost%3A17420%2Flinear");
        assert_eq!(unescape(&escape(REDIRECT)), REDIRECT);
        assert_eq!(unescape("a+b%20c%zz"), "a b c%zz");
        assert_eq!(unescape("fim%2"), "fim%2");
    }

    #[test]
    fn le_o_alvo_do_pedido_e_a_query() {
        let req = "GET /linear?code=abc&state=xyz&error_description=User+denied HTTP/1.1\r\nHost: localhost\r\n\r\n";
        let target = request_target(req).unwrap();
        let (route, query) = target.split_once('?').unwrap();
        assert_eq!(route, "/linear");
        let q = parse_query(query);
        assert_eq!(q["code"], "abc");
        assert_eq!(q["state"], "xyz");
        assert_eq!(q["error_description"], "User denied");
        assert!(request_target("POST /linear HTTP/1.1").is_none());
        assert!(request_target("").is_none());
    }

    /// Uma página como o Linear manda, com os campos opcionais vazios: sem
    /// projeto, sem time, descrição em branco — nada disso pode derrubar a
    /// lista inteira.
    #[test]
    fn le_uma_pagina_de_issues() {
        let json = serde_json::json!({
            "pageInfo": { "hasNextPage": false, "endCursor": null },
            "nodes": [{
                "id": "abc", "identifier": "MES-7", "title": "Conectar o Linear",
                "description": "  ", "url": "https://linear.app/mesonn/issue/MES-7/x",
                "branchName": "gustavo/mes-7-conectar-o-linear", "priority": 2,
                "priorityLabel": "High", "updatedAt": "2026-08-23T20:00:00.000Z",
                "state": { "name": "In Progress", "type": "started", "color": "#f2c94c" },
                "team": null, "project": null, "labels": { "nodes": [{ "name": "bug", "color": "#eb5757" }] }
            }]
        });
        let page: Page = serde_json::from_value(json).unwrap();
        assert!(!page.page_info.has_next_page);
        let issue = Issue::from(page.nodes.into_iter().next().unwrap());
        assert_eq!(issue.identifier, "MES-7");
        assert_eq!(issue.description, None);
        assert_eq!(issue.state.kind, "started");
        assert_eq!(issue.team, "");
        assert_eq!(issue.project, None);
        assert_eq!(issue.labels[0].name, "bug");
        assert_eq!(issue.branch_name, "gustavo/mes-7-conectar-o-linear");
    }

    #[test]
    fn a_pagina_diz_o_que_aconteceu() {
        let _guard = i18n::TEST_LANG.lock().unwrap_or_else(|e| e.into_inner());
        i18n::set_lang("pt-BR".into());
        assert!(page(true, "").contains("Pode fechar esta aba"));
        assert!(page(false, "sem código").contains("sem código"));
        i18n::set_lang("en".into());
        assert!(page(true, "").contains("You can close this tab"));
        assert!(page(false, "no code").contains("no code"));
        i18n::set_lang("pt-BR".into());
    }
}
