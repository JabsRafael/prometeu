//! Optional TypeSafe integration: the person's own API key, explicit enablement and the HTTP
//! adapter for the evaluation port (ADR 0058).
//!
//! The key lives only in `<root>/typesafe.json` (private 0600, atomic writes), like the other local
//! credentials. IPC returns configuration and availability, never the key. Every vendor detail —
//! endpoint, request/response wire shape, status codes and retries — stays in this file; callers
//! see only `evaluation::EvaluationError` codes.
//!
//! The wire shape below is an assumption: the public documentation was not reachable when this
//! adapter was written. It is isolated in `wire` with synthetic fixtures so a correction changes
//! only this module.

use crate::evaluation::{self, Answer, EvaluationError, EvaluationRequest, Evaluator, Generation};
use crate::{i18n, paths};
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

const DEFAULT_ORIGIN: &str = "https://api.typesafe.ai";
const ENDPOINT: &str = "/v1/evaluate";
const TIMEOUT: Duration = Duration::from_secs(15);
const CONNECT: Duration = Duration::from_secs(5);
const ATTEMPTS: usize = 3;
const BACKOFF: [Duration; 2] = [Duration::from_millis(400), Duration::from_millis(1200)];
const MAX_RETRY_AFTER: Duration = Duration::from_secs(3);
const MAX_RESPONSE: u64 = 256 * 1024;
const MIN_KEY: usize = 8;
const MAX_KEY: usize = 512;

static GENERATION: Generation = Generation::new();
static STORAGE: Mutex<()> = Mutex::new(());

/// Persisted choices. Old installations and a missing file default to disabled without a key.
#[derive(Default, Deserialize, Serialize)]
struct Saved {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    enabled: bool,
    #[serde(default)]
    key: Option<String>,
}

/// What the UI may know: whether a key exists, whether evaluation is on, and a configuration
/// problem code. The key itself never crosses IPC.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Status {
    pub configured: bool,
    pub enabled: bool,
    pub problem: Option<String>,
}

fn file() -> PathBuf {
    paths::root().join("typesafe.json")
}

fn load(path: &Path) -> Result<Saved, String> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| i18n::t("err.evaluation.storage")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Saved::default()),
        Err(_) => Err(i18n::t("err.evaluation.storage")),
    }
}

fn store(path: &Path, saved: &Saved) -> Result<(), String> {
    let body = serde_json::to_string(&Saved {
        version: 1,
        enabled: saved.enabled,
        key: saved.key.clone(),
    })
    .map_err(|_| i18n::t("err.evaluation.storage"))?;
    paths::write_private(path, &body).map_err(|_| i18n::t("err.evaluation.storage"))
}

fn status_of(path: &Path) -> Status {
    match load(path) {
        Ok(saved) => {
            let configured = saved.key.is_some();
            Status {
                configured,
                enabled: configured && saved.enabled,
                problem: None,
            }
        }
        Err(problem) => Status {
            configured: false,
            enabled: false,
            problem: Some(problem),
        },
    }
}

/// Accept a pasted key without surrounding whitespace; reject anything that could not be a header
/// value. The error never echoes the input.
fn clean_key(key: &str) -> Result<String, String> {
    let key = key.trim();
    if !(MIN_KEY..=MAX_KEY).contains(&key.len()) || !key.bytes().all(|b| b.is_ascii_graphic()) {
        return Err(i18n::t("err.evaluation.key"));
    }
    Ok(key.to_string())
}

/// Saving or replacing a key keeps the current enablement; a first key therefore stays disabled.
fn save_key(path: &Path, generation: &Generation, key: &str) -> Result<Status, String> {
    let key = clean_key(key)?;
    let _guard = STORAGE.lock().unwrap_or_else(|e| e.into_inner());
    let mut saved = load(path).unwrap_or_default();
    saved.key = Some(key);
    store(path, &saved)?;
    generation.bump();
    Ok(status_of(path))
}

/// Removing the key also disables evaluation, so a later key needs an explicit enable again.
fn remove_key(path: &Path, generation: &Generation) -> Result<Status, String> {
    let _guard = STORAGE.lock().unwrap_or_else(|e| e.into_inner());
    generation.bump();
    match std::fs::remove_file(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(i18n::t("err.evaluation.storage")),
    }
    Ok(status_of(path))
}

fn set_enabled(path: &Path, generation: &Generation, enabled: bool) -> Result<Status, String> {
    let _guard = STORAGE.lock().unwrap_or_else(|e| e.into_inner());
    let mut saved = load(path)?;
    if enabled && saved.key.is_none() {
        return Err(i18n::t("err.evaluation.noKey"));
    }
    saved.enabled = enabled;
    store(path, &saved)?;
    generation.bump();
    Ok(status_of(path))
}

/// The credential is usable only when the person enabled the integration with a key.
fn credential(path: &Path) -> Option<String> {
    let saved = load(path).ok()?;
    saved.key.filter(|_| saved.enabled)
}

fn origin() -> Option<String> {
    let value =
        std::env::var("PROMETEU_TYPESAFE_URL").unwrap_or_else(|_| DEFAULT_ORIGIN.to_string());
    let url = reqwest::Url::parse(&value).ok()?;
    let loopback = matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
    let secure = url.scheme() == "https" || (url.scheme() == "http" && loopback);
    (secure && url.username().is_empty() && url.password().is_none() && url.query().is_none())
        .then(|| value.trim_end_matches('/').to_string())
}

/* Commands */

#[tauri::command]
pub fn typesafe_status() -> Status {
    status_of(&file())
}

#[tauri::command]
pub fn typesafe_save_key(key: String) -> Result<Status, String> {
    save_key(&file(), &GENERATION, &key)
}

#[tauri::command]
pub fn typesafe_remove_key() -> Result<Status, String> {
    remove_key(&file(), &GENERATION)
}

#[tauri::command]
pub fn typesafe_set_enabled(enabled: bool) -> Result<Status, String> {
    set_enabled(&file(), &GENERATION, enabled)
}

/// Explicit evaluation only. The blocking HTTP call runs off the UI and async threads.
#[tauri::command]
pub async fn context_evaluate(
    request: EvaluationRequest,
) -> Result<evaluation::EvaluationResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let adapter = credential(&file()).and_then(|key| Some(TypeSafe::new(origin()?, key)));
        evaluation::run(
            &request,
            adapter.as_ref().map(|a| a as &dyn Evaluator),
            &GENERATION,
        )
        .map_err(EvaluationError::to_ipc)
    })
    .await
    .map_err(|_| EvaluationError::Unavailable.to_ipc())?
}

/* HTTP adapter */

/// Assumed vendor wire shape; see the module note and the evaluation contract.
mod wire {
    use crate::evaluation::{Answer, EvaluationRequest};
    use serde::Serialize;
    use serde_json::Value;

    #[derive(Serialize)]
    struct Question<'a> {
        id: &'a str,
        question: &'a str,
        #[serde(rename = "type")]
        kind: &'static str,
        options: &'a [String],
    }

    #[derive(Serialize)]
    struct Body<'a> {
        state: &'a str,
        questions: Vec<Question<'a>>,
    }

    pub fn body(request: &EvaluationRequest) -> Value {
        serde_json::to_value(Body {
            state: &request.context,
            questions: request
                .questions
                .iter()
                .map(|q| Question {
                    id: &q.id,
                    question: &q.prompt,
                    kind: "enum",
                    options: &q.outcomes,
                })
                .collect(),
        })
        .unwrap_or(Value::Null)
    }

    /// `{ "answers": [{ "id", "value", "confidence" }] }`. A null value is an abstention; any other
    /// shape is malformed. Closed-set validation happens in `evaluation::accept`.
    pub fn answers(value: &Value) -> Option<Vec<Answer>> {
        let mut answers = Vec::new();
        for item in value.get("answers")?.as_array()? {
            let id = item.get("id")?.as_str()?;
            let outcome = match item.get("value")? {
                Value::Null => continue,
                Value::String(outcome) => outcome,
                _ => return None,
            };
            answers.push(Answer {
                id: id.to_string(),
                outcome: outcome.clone(),
                confidence: item.get("confidence")?.as_f64()?,
            });
        }
        Some(answers)
    }
}

pub struct TypeSafe {
    origin: String,
    key: String,
    backoff: Vec<Duration>,
    timeout: Duration,
}

impl TypeSafe {
    fn new(origin: String, key: String) -> Self {
        Self {
            origin,
            key,
            backoff: BACKOFF.to_vec(),
            timeout: TIMEOUT,
        }
    }
}

enum Attempt {
    Done(Result<Vec<Answer>, EvaluationError>),
    Retry(EvaluationError, Option<Duration>),
}

impl TypeSafe {
    fn attempt(&self, client: &Client, body: &serde_json::Value) -> Attempt {
        let response = match client
            .post(format!("{}{ENDPOINT}", self.origin))
            .bearer_auth(&self.key)
            .json(body)
            .send()
        {
            Ok(response) => response,
            // Offline, DNS and timeout errors are retried; their text may contain the URL and is
            // dropped.
            Err(_) => return Attempt::Retry(EvaluationError::Unavailable, None),
        };
        let status = response.status().as_u16();
        let wait = response
            .headers()
            .get("retry-after")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.trim().parse::<u64>().ok())
            .map(|seconds| Duration::from_secs(seconds).min(MAX_RETRY_AFTER));
        match status {
            200 => {}
            401 | 403 => return Attempt::Done(Err(EvaluationError::Auth)),
            429 => return Attempt::Retry(EvaluationError::RateLimited, wait),
            400 | 413 | 422 => return Attempt::Done(Err(EvaluationError::Invalid)),
            500 | 502 | 503 | 504 => return Attempt::Retry(EvaluationError::Unavailable, wait),
            _ => return Attempt::Done(Err(EvaluationError::Unavailable)),
        }
        use std::io::Read;
        let mut bytes = Vec::new();
        if response
            .take(MAX_RESPONSE + 1)
            .read_to_end(&mut bytes)
            .is_err()
        {
            return Attempt::Retry(EvaluationError::Unavailable, None);
        }
        if bytes.len() as u64 > MAX_RESPONSE {
            return Attempt::Done(Err(EvaluationError::Malformed));
        }
        let parsed = serde_json::from_slice(&bytes)
            .ok()
            .and_then(|value| wire::answers(&value));
        Attempt::Done(parsed.ok_or(EvaluationError::Malformed))
    }
}

impl Evaluator for TypeSafe {
    fn evaluate(
        &self,
        request: &EvaluationRequest,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Vec<Answer>, EvaluationError> {
        let client = Client::builder()
            .timeout(self.timeout)
            .connect_timeout(CONNECT)
            .redirect(reqwest::redirect::Policy::none())
            .user_agent("Prometeu Desktop")
            .build()
            .map_err(|_| EvaluationError::Unavailable)?;
        let body = wire::body(request);
        let mut last = EvaluationError::Unavailable;
        for attempt in 0..ATTEMPTS {
            if cancelled() {
                return Err(EvaluationError::Stale);
            }
            match self.attempt(&client, &body) {
                Attempt::Done(result) => return result,
                Attempt::Retry(error, wait) => {
                    last = error;
                    if attempt + 1 < ATTEMPTS {
                        let backoff = self.backoff.get(attempt).copied().unwrap_or_default();
                        std::thread::sleep(wait.unwrap_or(backoff).max(backoff));
                    }
                }
            }
        }
        Err(last)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::evaluation::Question;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex as StdMutex};

    const KEY: &str = "ts_live_secret_key_123";

    fn temp() -> PathBuf {
        std::env::temp_dir()
            .join(format!("prometeu-typesafe-{}", uuid::Uuid::new_v4()))
            .join("typesafe.json")
    }

    fn request() -> EvaluationRequest {
        EvaluationRequest {
            context: "Request: fix the CSV import".into(),
            questions: vec![Question {
                id: "business_rule".into(),
                prompt: "Is a business rule unresolved?".into(),
                outcomes: vec!["present".into(), "absent".into()],
            }],
        }
    }

    #[test]
    fn missing_or_old_configuration_is_disabled() {
        let path = temp();
        assert_eq!(
            status_of(&path),
            Status {
                configured: false,
                enabled: false,
                problem: None
            }
        );
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{}").unwrap();
        assert!(!status_of(&path).enabled);
        assert!(credential(&path).is_none());
        std::fs::write(&path, r#"{"enabled":true}"#).unwrap();
        assert!(
            !status_of(&path).enabled,
            "enabled without a key stays unavailable"
        );
        std::fs::write(&path, "not json").unwrap();
        let broken = status_of(&path);
        assert!(!broken.enabled);
        assert_eq!(
            broken.problem.as_deref(),
            Some(r#"i18n:{"code":"err.evaluation.storage"}"#)
        );
    }

    #[test]
    fn saving_a_key_does_not_enable_evaluation() {
        let path = temp();
        let generation = Generation::new();
        let status = save_key(&path, &generation, &format!("  {KEY}\n")).unwrap();
        assert!(status.configured && !status.enabled);
        assert!(credential(&path).is_none());
        let status = set_enabled(&path, &generation, true).unwrap();
        assert!(status.enabled);
        assert_eq!(credential(&path).as_deref(), Some(KEY));
        // Replacing the key keeps the explicit choice but invalidates pending work.
        let before = generation.current();
        assert!(
            save_key(&path, &generation, "ts_live_other_key_456")
                .unwrap()
                .enabled
        );
        assert!(generation.current() > before);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[test]
    fn enabling_requires_a_key_and_removing_it_disables() {
        let path = temp();
        let generation = Generation::new();
        assert_eq!(
            set_enabled(&path, &generation, true).unwrap_err(),
            r#"i18n:{"code":"err.evaluation.noKey"}"#
        );
        save_key(&path, &generation, KEY).unwrap();
        set_enabled(&path, &generation, true).unwrap();
        let before = generation.current();
        let status = remove_key(&path, &generation).unwrap();
        assert!(!status.configured && !status.enabled);
        assert!(generation.current() > before);
        assert!(!path.exists());
        // A later key starts disabled again.
        assert!(!save_key(&path, &generation, KEY).unwrap().enabled);
    }

    #[test]
    fn the_key_never_appears_in_status_or_errors() {
        let path = temp();
        let generation = Generation::new();
        let status = save_key(&path, &generation, KEY).unwrap();
        let json = serde_json::to_string(&status).unwrap();
        assert!(!json.contains(KEY));
        assert!(!json.contains("key\":"));
        let error = save_key(&path, &generation, "short").unwrap_err();
        assert!(!error.contains("short"));
        let error = save_key(&path, &generation, "has spaces inside key").unwrap_err();
        assert_eq!(error, r#"i18n:{"code":"err.evaluation.key"}"#);
    }

    /// Serve one scripted HTTP response per connection and record the raw requests.
    fn server(responses: Vec<&'static str>) -> (String, Arc<StdMutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(StdMutex::new(Vec::new()));
        let log = seen.clone();
        std::thread::spawn(move || {
            for response in responses {
                let Ok((mut stream, _)) = listener.accept() else {
                    return;
                };
                stream
                    .set_read_timeout(Some(Duration::from_millis(500)))
                    .unwrap();
                let mut raw = Vec::new();
                let mut chunk = [0; 8192];
                // Read headers and the declared body.
                loop {
                    let Ok(n) = stream.read(&mut chunk) else {
                        break;
                    };
                    if n == 0 {
                        break;
                    }
                    raw.extend_from_slice(&chunk[..n]);
                    let text = String::from_utf8_lossy(&raw);
                    if let Some(end) = text.find("\r\n\r\n") {
                        let length = text
                            .lines()
                            .find_map(|l| {
                                l.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .map(|v| v.trim().parse::<usize>().unwrap_or(0))
                            })
                            .unwrap_or(0);
                        if raw.len() >= end + 4 + length {
                            break;
                        }
                    }
                }
                log.lock()
                    .unwrap()
                    .push(String::from_utf8_lossy(&raw).into_owned());
                let _ = stream.write_all(response.as_bytes());
            }
        });
        (origin, seen)
    }

    fn adapter(origin: String) -> TypeSafe {
        crate::install_crypto();
        TypeSafe {
            origin,
            key: KEY.into(),
            backoff: vec![Duration::ZERO, Duration::ZERO],
            timeout: Duration::from_secs(3),
        }
    }

    fn reply(body: &'static str) -> &'static str {
        // Leak once per fixture; tests only.
        Box::leak(
            format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .into_boxed_str(),
        )
    }

    const RATE: &str =
        "HTTP/1.1 429 Too Many Requests\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}";
    const DOWN: &str = "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 18\r\nConnection: close\r\n\r\n{\"key\":\"ts_live\"}";
    const AUTH: &str = "HTTP/1.1 401 Unauthorized\r\nContent-Length: 33\r\nConnection: close\r\n\r\n{\"error\":\"bad ts_live_secret_key\"}";

    #[test]
    fn adapter_sends_the_assumed_shape_and_parses_answers() {
        let (origin, seen) = server(vec![reply(
            r#"{"answers":[{"id":"business_rule","value":"absent","confidence":0.91}]}"#,
        )]);
        let answers = adapter(origin).evaluate(&request(), &|| false).unwrap();
        assert_eq!(answers[0].outcome, "absent");
        let raw = seen.lock().unwrap()[0].clone();
        assert!(raw.starts_with("POST /v1/evaluate "));
        assert!(raw.to_ascii_lowercase().contains(&format!(
            "authorization: bearer {}",
            KEY.to_ascii_lowercase()
        )));
        assert!(raw.contains(r#""options":["present","absent"]"#));
        assert!(raw.contains(r#""state":"Request: fix the CSV import""#));
    }

    #[test]
    fn adapter_translates_failures_into_application_codes() {
        let (origin, _) = server(vec![AUTH]);
        assert_eq!(
            adapter(origin).evaluate(&request(), &|| false),
            Err(EvaluationError::Auth)
        );
        let (origin, seen) = server(vec![RATE, RATE, RATE]);
        assert_eq!(
            adapter(origin).evaluate(&request(), &|| false),
            Err(EvaluationError::RateLimited)
        );
        assert_eq!(seen.lock().unwrap().len(), ATTEMPTS, "retries are bounded");
        let (origin, _) = server(vec![DOWN, DOWN, DOWN]);
        assert_eq!(
            adapter(origin).evaluate(&request(), &|| false),
            Err(EvaluationError::Unavailable)
        );
        let (origin, _) = server(vec![reply(r#"{"result":"ok"}"#)]);
        assert_eq!(
            adapter(origin).evaluate(&request(), &|| false),
            Err(EvaluationError::Malformed)
        );
        let (origin, _) = server(vec![reply("<html>")]);
        assert_eq!(
            adapter(origin).evaluate(&request(), &|| false),
            Err(EvaluationError::Malformed)
        );
        // Nothing listens on this port: offline maps to unavailable.
        let closed = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", closed.local_addr().unwrap());
        drop(closed);
        assert_eq!(
            adapter(origin).evaluate(&request(), &|| false),
            Err(EvaluationError::Unavailable)
        );
    }

    #[test]
    fn adapter_recovers_after_a_transient_failure() {
        let (origin, seen) = server(vec![
            DOWN,
            reply(r#"{"answers":[{"id":"business_rule","value":null,"confidence":0.2}]}"#),
        ]);
        let answers = adapter(origin).evaluate(&request(), &|| false).unwrap();
        assert!(answers.is_empty(), "a null value abstains");
        assert_eq!(seen.lock().unwrap().len(), 2);
    }

    #[test]
    fn adapter_stops_retrying_when_configuration_changes() {
        let (origin, seen) = server(vec![DOWN, DOWN, DOWN]);
        let calls = std::cell::Cell::new(0);
        let cancelled = || {
            calls.set(calls.get() + 1);
            calls.get() > 1
        };
        assert_eq!(
            adapter(origin).evaluate(&request(), &cancelled),
            Err(EvaluationError::Stale)
        );
        assert_eq!(seen.lock().unwrap().len(), 1);
    }

    #[test]
    fn a_timeout_is_unavailable() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let hold = std::thread::spawn(move || {
            let mut open = Vec::new();
            for _ in 0..ATTEMPTS {
                if let Ok((stream, _)) = listener.accept() {
                    open.push(stream);
                }
            }
            std::thread::sleep(Duration::from_millis(400));
        });
        let mut slow = adapter(origin);
        slow.timeout = Duration::from_millis(100);
        assert_eq!(
            slow.evaluate(&request(), &|| false),
            Err(EvaluationError::Unavailable)
        );
        hold.join().unwrap();
    }

    #[test]
    fn origins_require_https_except_loopback() {
        for (value, ok) in [
            ("https://api.typesafe.ai", true),
            ("http://127.0.0.1:9", true),
            ("http://example.com", false),
            ("https://user:pw@api.typesafe.ai", false),
            ("https://api.typesafe.ai?key=x", false),
        ] {
            std::env::set_var("PROMETEU_TYPESAFE_URL", value);
            assert_eq!(origin().is_some(), ok, "{value}");
        }
        std::env::remove_var("PROMETEU_TYPESAFE_URL");
    }
}
