//! Account-scoped, bounded discovery. Raw provider responses never cross IPC.
use super::Model;
use crate::{accounts, paths, state::ProviderId};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    io::{BufRead, BufReader, Read, Write},
    os::unix::{io::AsRawFd, process::CommandExt},
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc::{self, Receiver, RecvTimeoutError},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const TIMEOUT: Duration = Duration::from_secs(20);
const MAX_OUTPUT: usize = 1_048_576;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct CatalogError {
    pub code: String,
}
impl CatalogError {
    pub(crate) fn new(kind: &str) -> Self {
        Self {
            code: format!("err.modelsCatalog.{kind}"),
        }
    }
}
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCatalog {
    pub models: Vec<Model>,
    pub fetched_at: u64,
}

pub(super) fn fetch(agent: ProviderId) -> Result<ModelCatalog, CatalogError> {
    if agent == ProviderId::RetiredGemini {
        return Err(CatalogError::new("unavailable"));
    }
    fetch_for_profile(agent, accounts::active(agent))
}

fn fetch_for_profile(
    agent: ProviderId,
    profile: Result<accounts::Profile, String>,
) -> Result<ModelCatalog, CatalogError> {
    let profile = profile.map_err(|_| CatalogError::new("noAccount"))?;
    profile.prepare().map_err(|_| CatalogError::new("failed"))?;
    let mut command = match agent {
        ProviderId::Claude => {
            let mut cmd = Command::new("claude");
            cmd.args([
                "-p",
                "--verbose",
                "--input-format",
                "stream-json",
                "--output-format",
                "stream-json",
                "--no-session-persistence",
                "--settings",
                r#"{"hooks":{}}"#,
            ]);
            cmd.env_clear();
            for (key, value) in std::env::vars_os() {
                if !key.to_string_lossy().starts_with("CLAUDE") {
                    cmd.env(key, value);
                }
            }
            cmd
        }
        ProviderId::Codex => {
            let mut cmd = Command::new("codex");
            cmd.arg("app-server");
            cmd
        }
        ProviderId::Antigravity => {
            let mut cmd = Command::new("agy");
            cmd.arg("models");
            cmd
        }
        ProviderId::RetiredGemini => unreachable!(),
    };
    command.current_dir(paths::home());
    profile
        .apply(&mut command)
        .map_err(|_| CatalogError::new("failed"))?;
    let models = match agent {
        ProviderId::Claude => query_claude(&mut command, TIMEOUT)?,
        ProviderId::Codex => query_codex(&mut command, TIMEOUT)?,
        ProviderId::Antigravity => {
            crate::antigravity::parse_catalog(&command_output(&mut command, TIMEOUT)?)?
        }
        ProviderId::RetiredGemini => unreachable!(),
    };
    Ok(ModelCatalog {
        models,
        fetched_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
    })
}

/// Own the process group until every success/error path has killed and reaped it.
struct CatalogProcess {
    child: Child,
    input: Option<ChildStdin>,
    lines: Receiver<Result<String, CatalogError>>,
    deadline: Instant,
}
impl Drop for CatalogProcess {
    fn drop(&mut self) {
        unsafe {
            libc::kill(-(self.child.id() as i32), libc::SIGKILL);
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
impl CatalogProcess {
    fn spawn(command: &mut Command, timeout: Duration) -> Result<Self, CatalogError> {
        let deadline = Instant::now() + timeout;
        let child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .process_group(0)
            .spawn()
            .map_err(|error| {
                CatalogError::new(if error.kind() == std::io::ErrorKind::NotFound {
                    "unavailable"
                } else {
                    "failed"
                })
            })?;
        let (tx, lines) = mpsc::channel();
        let mut process = Self {
            child,
            input: None,
            lines,
            deadline,
        };
        process.input = process.child.stdin.take();
        if let Some(input) = &process.input {
            // A provider that stops reading must not turn a catalog write into an unbounded wait.
            let fd = input.as_raw_fd();
            let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
            if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0
            {
                return Err(CatalogError::new("failed"));
            }
        }
        let stdout = process
            .child
            .stdout
            .take()
            .ok_or_else(|| CatalogError::new("failed"))?;
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut total = 0;
            loop {
                let mut line = String::new();
                let read = reader
                    .by_ref()
                    .take((MAX_OUTPUT + 1) as u64)
                    .read_line(&mut line);
                match read {
                    Ok(0) => break,
                    Ok(size) if total + size <= MAX_OUTPUT => {
                        total += size;
                        if tx.send(Ok(line)).is_err() {
                            break;
                        }
                    }
                    _ => {
                        let _ = tx.send(Err(CatalogError::new("invalid")));
                        break;
                    }
                }
            }
        });
        Ok(process)
    }
    fn send(&mut self, value: Value) -> Result<(), CatalogError> {
        let input = self
            .input
            .as_mut()
            .ok_or_else(|| CatalogError::new("failed"))?;
        let data = format!("{value}\n");
        let mut remaining = data.as_bytes();
        while !remaining.is_empty() {
            if Instant::now() >= self.deadline {
                return Err(CatalogError::new("timeout"));
            }
            match input.write(remaining) {
                Ok(0) => return Err(CatalogError::new("failed")),
                Ok(size) => remaining = &remaining[size..],
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(5))
                }
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => return Err(CatalogError::new("failed")),
            }
        }
        Ok(())
    }

    fn next(&mut self) -> Result<Option<String>, CatalogError> {
        let remaining = self
            .deadline
            .checked_duration_since(Instant::now())
            .ok_or_else(|| CatalogError::new("timeout"))?;
        match self.lines.recv_timeout(remaining) {
            Ok(line) => line.map(Some),
            Err(RecvTimeoutError::Timeout) => Err(CatalogError::new("timeout")),
            Err(RecvTimeoutError::Disconnected) => Ok(None),
        }
    }
    fn response(&mut self, id: u64) -> Result<Value, CatalogError> {
        while let Some(line) = self.next()? {
            let value: Value =
                serde_json::from_str(&line).map_err(|_| CatalogError::new("invalid"))?;
            if value["id"].as_u64() != Some(id) {
                continue;
            }
            if value.get("error").is_some() {
                return Err(CatalogError::new("failed"));
            }
            return value
                .get("result")
                .filter(|v| v.is_object())
                .cloned()
                .ok_or_else(|| CatalogError::new("invalid"));
        }
        Err(CatalogError::new("failed"))
    }
}

fn command_output(command: &mut Command, timeout: Duration) -> Result<String, CatalogError> {
    let mut process = CatalogProcess::spawn(command, timeout)?;
    process.input.take();
    let mut output = String::new();
    while let Some(line) = process.next()? {
        output.push_str(&line);
    }
    loop {
        match process.child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(output),
            Ok(Some(_)) | Err(_) => return Err(CatalogError::new("failed")),
            Ok(None) if Instant::now() >= process.deadline => {
                return Err(CatalogError::new("timeout"))
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(5)),
        }
    }
}
fn query_claude(command: &mut Command, timeout: Duration) -> Result<Vec<Model>, CatalogError> {
    let mut process = CatalogProcess::spawn(command, timeout)?;
    process.send(
        json!({"type":"control_request","request_id":"models","request":{"subtype":"list_models"}}),
    )?;
    while let Some(line) = process.next()? {
        let value: Value = serde_json::from_str(&line).map_err(|_| CatalogError::new("invalid"))?;
        if value["type"] == "control_response" && value["response"]["request_id"] == "models" {
            return parse_claude(&value);
        }
    }
    Err(CatalogError::new("failed"))
}
fn text_field<'a>(value: &'a Value, key: &str) -> Result<&'a str, CatalogError> {
    value[key]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| CatalogError::new("invalid"))
}
fn strings(value: Option<&Value>) -> Result<Vec<String>, CatalogError> {
    match value {
        None | Some(Value::Null) => Ok(vec![]),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| {
                item.as_str()
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
                    .ok_or_else(|| CatalogError::new("invalid"))
            })
            .collect(),
        _ => Err(CatalogError::new("invalid")),
    }
}
pub(super) fn parse_claude(value: &Value) -> Result<Vec<Model>, CatalogError> {
    if value["response"]["subtype"] == "error" {
        return Err(CatalogError::new("failed"));
    }
    if value["response"]["subtype"] != "success" {
        return Err(CatalogError::new("invalid"));
    }
    let items = value["response"]["response"]["models"]
        .as_array()
        .ok_or_else(|| CatalogError::new("invalid"))?;
    items
        .iter()
        .filter(|item| item["value"] != "default" && item["disabled"] != true)
        .map(|item| {
            let id = text_field(item, "value")?.to_owned();
            Ok(Model {
                label: item
                    .get("displayName")
                    .map(|_| text_field(item, "displayName"))
                    .transpose()?
                    .unwrap_or(&id)
                    .to_owned(),
                id,
                efforts: strings(item.get("supportedEffortLevels"))?,
                additional: false,
            })
        })
        .collect()
}
fn parse_codex_page(value: &Value) -> Result<(Vec<Model>, Option<String>), CatalogError> {
    let items = value["data"]
        .as_array()
        .ok_or_else(|| CatalogError::new("invalid"))?;
    let models = items
        .iter()
        .map(|item| {
            let id = text_field(item, "model")?.to_owned();
            let label = text_field(item, "displayName")?.to_owned();
            let efforts = item["supportedReasoningEfforts"]
                .as_array()
                .ok_or_else(|| CatalogError::new("invalid"))?
                .iter()
                .map(|effort| text_field(effort, "reasoningEffort").map(str::to_owned))
                .collect::<Result<_, _>>()?;
            let additional = match item.get("hidden") {
                None => false,
                Some(Value::Bool(hidden)) => *hidden,
                _ => return Err(CatalogError::new("invalid")),
            };
            Ok(Model {
                id,
                label,
                efforts,
                additional,
            })
        })
        .collect::<Result<_, _>>()?;
    let next = match value.get("nextCursor") {
        None | Some(Value::Null) => None,
        Some(Value::String(cursor)) if !cursor.is_empty() && cursor.len() <= 4096 => {
            Some(cursor.clone())
        }
        _ => return Err(CatalogError::new("invalid")),
    };
    Ok((models, next))
}
fn query_codex(command: &mut Command, timeout: Duration) -> Result<Vec<Model>, CatalogError> {
    let mut process = CatalogProcess::spawn(command, timeout)?;
    process.send(json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"prometeu","title":"Prometeu","version":env!("CARGO_PKG_VERSION")},"capabilities":{"experimentalApi":true}}}))?;
    process.response(1)?;
    process.send(json!({"method":"initialized","params":{}}))?;
    let mut id = 2;
    let mut cursor: Option<String> = None;
    let mut seen = HashSet::new();
    let mut models = Vec::new();
    loop {
        process.send(
            json!({"id":id,"method":"model/list","params":{"includeHidden":true,"cursor":cursor}}),
        )?;
        let (page, next) = parse_codex_page(&process.response(id)?)?;
        models.extend(page);
        match next {
            None => return Ok(models),
            Some(next) if seen.insert(next.clone()) => cursor = Some(next),
            _ => return Err(CatalogError::new("invalid")),
        }
        id += 1;
    }
}

#[cfg(test)]
#[path = "catalog_tests.rs"]
mod tests;
