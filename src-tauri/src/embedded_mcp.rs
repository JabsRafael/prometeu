//! Bundled MCP stdio entry point and private local bridge to the running application. Provider
//! configuration carries a per-process credential; tools never accept a caller identity.

use crate::{delegation, lock::lock, mcp::Server, paths, AppState};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Manager};

pub const ID: &str = "prometeu";
const MAX_FRAME: usize = 1024 * 1024;
const VERSION: &str = "2025-06-18";

struct Runtime {
    directory: PathBuf,
    credentials: Mutex<HashMap<String, String>>,
    calls: Mutex<()>,
}
static RUNTIME: OnceLock<Arc<Runtime>> = OnceLock::new();

impl Runtime {
    fn grant(&self, session: &str) -> String {
        let token = uuid::Uuid::new_v4().to_string();
        let mut credentials = lock(&self.credentials);
        credentials.retain(|_, owner| owner != session);
        credentials.insert(token.clone(), session.into());
        token
    }

    fn owner(&self, token: &str) -> Result<String, String> {
        lock(&self.credentials)
            .get(token)
            .cloned()
            .ok_or_else(|| "unauthorized".into())
    }

    fn revoke(&self, session: &str) {
        lock(&self.credentials).retain(|_, owner| owner != session);
    }
}

pub fn builtin() -> Server {
    Server {
        id: ID.into(),
        config: json!({"type": "stdio", "builtin": true}),
        note: String::new(),
    }
}

pub fn start(app: AppHandle) -> Result<(), String> {
    // Keep the Unix socket below macOS's short pathname limit even with a long PROMETEU_ROOT.
    let directory = PathBuf::from("/tmp").join(format!("prometeu-mcp-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&directory).map_err(|e| e.to_string())?;
    paths::ensure_private_dir(&directory)?;
    let listener = UnixListener::bind(directory.join("socket")).map_err(|e| e.to_string())?;
    std::fs::set_permissions(
        directory.join("socket"),
        std::fs::Permissions::from_mode(0o600),
    )
    .map_err(|e| e.to_string())?;
    let runtime = Arc::new(Runtime {
        directory,
        credentials: Mutex::new(HashMap::new()),
        calls: Mutex::new(()),
    });
    RUNTIME
        .set(runtime.clone())
        .map_err(|_| "MCP already started")?;
    std::thread::spawn(move || {
        // A stdio bridge makes one local request at a time; accepting sequentially also serializes
        // idempotency checks and mutations from different coordinators.
        for mut stream in listener.incoming().flatten() {
            let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
            let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));
            let response = handle_connection(&app, &runtime, &mut stream);
            let _ = writeln!(
                stream,
                "{}",
                match response {
                    Ok(value) => json!({"result": value}),
                    Err(error) => json!({"error": error}),
                }
            );
        }
    });
    Ok(())
}

fn handle_connection(
    app: &AppHandle,
    runtime: &Runtime,
    stream: &mut UnixStream,
) -> Result<Value, String> {
    let raw = frame(&mut BufReader::new(stream))?.ok_or("empty_request")?;
    let request: Value = serde_json::from_str(&raw).map_err(|_| "invalid_request")?;
    let token = request["token"].as_str().ok_or("unauthorized")?;
    let owner = runtime.owner(token)?;
    let state = app.state::<AppState>();
    if !lock(&state.chats)
        .get(&owner)
        .is_some_and(|chat| chat.alive())
    {
        return Err("coordinator_unavailable".into());
    }
    let name = request["name"].as_str().ok_or("invalid_tool")?;
    let definition = tools()
        .into_iter()
        .find(|t| t["name"] == name)
        .ok_or("invalid_tool")?;
    if !valid_args(&definition["inputSchema"], &request["arguments"]) {
        return Err("invalid_arguments".into());
    }
    let _call = lock(&runtime.calls);
    let result = delegation::call(
        app,
        &owner,
        request["name"].as_str().ok_or("invalid_tool")?,
        &request["arguments"],
    )?;
    if result.to_string().len() > 768 * 1024 {
        return Err("response_too_large: request fewer items".into());
    }
    Ok(result)
}

pub fn shutdown() {
    if let Some(runtime) = RUNTIME.get() {
        lock(&runtime.credentials).clear();
        let _ = std::fs::remove_file(runtime.directory.join("socket"));
        let _ = std::fs::remove_dir(&runtime.directory);
    }
}

pub fn revoke(session: &str) {
    if let Some(runtime) = RUNTIME.get() {
        runtime.revoke(session);
    }
}

/// Materialize only after selection. The registry itself never contains paths or credentials.
pub fn materialize(session: &str) -> Result<Server, String> {
    let runtime = RUNTIME
        .get()
        .ok_or("Prometeu MCP is unavailable: open the desktop app")?;
    let token = runtime.grant(session);
    Ok(server_config(
        std::env::current_exe().map_err(|e| e.to_string())?,
        runtime.directory.join("socket"),
        token,
    ))
}

pub(crate) fn server_config(executable: PathBuf, socket: PathBuf, token: String) -> Server {
    Server {
        id: ID.into(),
        note: String::new(),
        config: json!({
            "type": "stdio", "command": executable, "args": ["--prometeu-mcp"],
            "env": {"PROMETEU_MCP_SOCKET": socket, "PROMETEU_MCP_TOKEN": token}
        }),
    }
}

fn frame(reader: &mut impl BufRead) -> Result<Option<String>, String> {
    let mut line = String::new();
    let count = reader
        .take((MAX_FRAME + 1) as u64)
        .read_line(&mut line)
        .map_err(|e| e.to_string())?;
    if count > MAX_FRAME {
        return Err("MCP frame exceeds 1 MiB".into());
    }
    if count == 0 {
        return Ok(None);
    }
    Ok(Some(line))
}

fn forward(name: &str, args: &Value) -> Result<Value, String> {
    let socket = std::env::var("PROMETEU_MCP_SOCKET").map_err(|_| "Missing MCP connection")?;
    let token = std::env::var("PROMETEU_MCP_TOKEN").map_err(|_| "Missing MCP credential")?;
    let mut stream = UnixStream::connect(socket).map_err(|_| "Prometeu is not running")?;
    stream
        .set_read_timeout(Some(Duration::from_secs(60)))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(10)))
        .map_err(|e| e.to_string())?;
    writeln!(
        stream,
        "{}",
        json!({"token": token, "name": name, "arguments": args})
    )
    .map_err(|e| e.to_string())?;
    let raw = frame(&mut BufReader::new(stream))?.ok_or("Prometeu disconnected")?;
    let response: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    if let Some(error) = response["error"].as_str() {
        return Err(error.into());
    }
    Ok(response["result"].clone())
}

fn tool(
    name: &str,
    description: &str,
    properties: Value,
    required: &[&str],
    read_only: bool,
) -> Value {
    json!({"name": name, "description": description,
        "inputSchema": {"type":"object", "properties": properties, "required": required, "additionalProperties": false},
        "annotations": {"readOnlyHint": read_only}})
}

pub fn tools() -> Vec<Value> {
    let text = json!({"type":"string", "minLength":1});
    let index = json!({"type":"integer", "minimum":0});
    vec![
        tool("delegate", "Create a task-bound agent in its own isolated workspace using the coordinator's repositories. Returns immediately while preparation runs. Reuse request_key when retrying. Workers receive no MCP, plugins or skills by default.",
            json!({"request_key":text, "title":text, "task":text, "provider":{"type":"string","enum":["claude","codex"]},"model":text,"effort":text}), &["request_key","title","task"], false),
        tool("list_delegations", "List only agents created by this conversation, including preparation, execution and background status.",
            json!({"offset":index,"limit":{"type":"integer","minimum":1,"maximum":100}}), &[], true),
        tool("get_delegation", "Inspect an owned agent. Workspace stage, conversation status, executions and provider background tasks are separate. Null background means unknown. Pending questions require the person in Prometeu.",
            json!({"agent_id":text}), &["agent_id"], true),
        tool("get_execution", "Read the state of a specific execution of an owned agent. Completion of a turn does not imply that background tasks have stopped.",
            json!({"agent_id":text,"execution_id":text}), &["agent_id","execution_id"], true),
        tool("send_message", "Send another instruction to an owned agent. Rejects busy conversations; does not steer or silently queue behind a running turn. Reuse request_key on retries. Returns an execution identifier.",
            json!({"agent_id":text,"request_key":text,"text":text}), &["agent_id","request_key","text"], false),
        tool("interrupt", "Request interruption of an owned agent's current turn. This does not delete its environment or promise to stop every background task.",
            json!({"agent_id":text}), &["agent_id"], false),
        tool("read_conversation", "Read a bounded tail of the owned conversation as canonical Prometeu events. Does not include unrelated tabs or child-provider transcripts. seq is process-local, not a durable cursor.",
            json!({"agent_id":text,"limit":{"type":"integer","minimum":1,"maximum":200}}), &["agent_id"], true),
        tool("list_files", "List entries within the owned workspace. Paths are relative to its root.",
            json!({"agent_id":text,"path":{"type":"string"},"offset":index,"limit":{"type":"integer","minimum":1,"maximum":500}}), &["agent_id"], true),
        tool("read_file", "Read text within the owned workspace, up to 500 lines and 128 KiB per response. Files are limited to 2 MiB. Line numbers are zero-based.",
            json!({"agent_id":text,"path":text,"start_line":index,"limit":{"type":"integer","minimum":1,"maximum":500}}), &["agent_id","path"], true),
    ]
}

fn error(id: Value, code: i32, message: &str) -> Value {
    json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}})
}

#[derive(Default)]
struct Protocol {
    initialized: bool,
    ready: bool,
}

impl Protocol {
    fn reply(
        &mut self,
        request: Value,
        call: impl FnOnce(&str, &Value) -> Result<Value, String>,
    ) -> Option<Value> {
        let id = request.get("id").cloned();
        let method = request["method"].as_str();
        if request["jsonrpc"] != "2.0"
            || method.is_none()
            || id
                .as_ref()
                .is_some_and(|id| !(id.is_null() || id.is_string() || id.is_number()))
        {
            return Some(error(id.unwrap_or(Value::Null), -32600, "Invalid Request"));
        }
        if id.is_none() {
            if method == Some("notifications/initialized") && self.initialized {
                self.ready = true;
            }
            return None;
        }
        let id = id.unwrap();
        let result = match method.unwrap() {
            "initialize" => {
                self.initialized = true;
                json!({"protocolVersion": VERSION,"capabilities":{"tools":{}},
                    "serverInfo":{"name":"prometeu","version":env!("CARGO_PKG_VERSION")},
                    "instructions":"Delegate tasks to isolated workspaces. Control is limited to agents created by your conversation. Work continues in the open Prometeu app; poll get_delegation for progress."})
            }
            "ping" => json!({}),
            _ if !self.ready => {
                return Some(error(id, -32000, "Initialize the MCP connection first"))
            }
            "tools/list" => json!({"tools":tools()}),
            "tools/call" => {
                let name = request["params"]["name"].as_str().unwrap_or("");
                let definition = tools().into_iter().find(|t| t["name"] == name);
                let Some(definition) = definition else {
                    return Some(error(id, -32602, "Unknown tool"));
                };
                let args = request["params"]
                    .get("arguments")
                    .cloned()
                    .unwrap_or(json!({}));
                if !valid_args(&definition["inputSchema"], &args) {
                    return Some(error(id, -32602, "Invalid tool arguments"));
                }
                match call(name, &args) {
                    Ok(value) => {
                        json!({"content":[{"type":"text","text":value.to_string()}],"structuredContent":value,"isError":false})
                    }
                    Err(message) => {
                        json!({"content":[{"type":"text","text":message}],"isError":true})
                    }
                }
            }
            _ => return Some(error(id, -32601, "Method not found")),
        };
        Some(json!({"jsonrpc":"2.0","id":id,"result":result}))
    }
}

fn valid_args(schema: &Value, args: &Value) -> bool {
    let Some(object) = args.as_object() else {
        return false;
    };
    if schema["required"]
        .as_array()
        .unwrap()
        .iter()
        .any(|k| !object.contains_key(k.as_str().unwrap()))
    {
        return false;
    }
    object.iter().all(|(key, value)| {
        let property = &schema["properties"][key];
        match property["type"].as_str() {
            Some("string") => value.as_str().is_some_and(|s| {
                s.len() >= property["minLength"].as_u64().unwrap_or(0) as usize
                    && property
                        .get("enum")
                        .is_none_or(|e| e.as_array().unwrap().contains(value))
            }),
            Some("integer") => value.as_u64().is_some_and(|n| {
                n >= property["minimum"].as_u64().unwrap_or(0)
                    && n <= property["maximum"].as_u64().unwrap_or(u64::MAX)
            }),
            _ => false,
        }
    })
}

pub fn stdio() -> Result<(), String> {
    let mut protocol = Protocol::default();
    let mut input = std::io::stdin().lock();
    let mut output = std::io::stdout().lock();
    while let Some(line) = frame(&mut input)? {
        let response = match serde_json::from_str(&line) {
            Ok(request) => protocol.reply(request, forward),
            Err(_) => Some(error(Value::Null, -32700, "Parse error")),
        };
        if let Some(response) = response {
            writeln!(output, "{response}").map_err(|e| e.to_string())?;
            output.flush().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(method: &str, params: Value) -> Value {
        json!({"jsonrpc":"2.0","id":7,"method":method,"params":params})
    }

    fn ready() -> Protocol {
        let mut protocol = Protocol::default();
        let reply = protocol
            .reply(
                request("initialize", json!({"protocolVersion":VERSION})),
                |_, _| panic!(),
            )
            .unwrap();
        assert_eq!(reply["result"]["protocolVersion"], VERSION);
        assert!(reply["result"]["capabilities"]["tools"].is_object());
        assert!(protocol
            .reply(
                json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
                |_, _| panic!()
            )
            .is_none());
        protocol
    }

    #[test]
    fn lifecycle_discovery_and_tool_results_are_mcp_messages() {
        let mut protocol = ready();
        let reply = protocol
            .reply(request("tools/list", json!({})), |_, _| panic!())
            .unwrap();
        assert_eq!(reply["result"]["tools"].as_array().unwrap().len(), 9);
        let reply = protocol
            .reply(
                request(
                    "tools/call",
                    json!({"name":"get_delegation","arguments":{"agent_id":"worker"}}),
                ),
                |name, args| {
                    assert_eq!(name, "get_delegation");
                    assert_eq!(args["agent_id"], "worker");
                    Ok(json!({"state":"working"}))
                },
            )
            .unwrap();
        assert_eq!(reply["id"], 7);
        assert_eq!(reply["result"]["structuredContent"]["state"], "working");
        assert_eq!(reply["result"]["isError"], false);
        let text = reply["result"]["content"][0]["text"].as_str().unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(text).unwrap(),
            reply["result"]["structuredContent"]
        );
    }

    #[test]
    fn rejects_spoofed_owner_invalid_arguments_and_unknown_methods_before_dispatch() {
        let mut protocol = ready();
        for arguments in [
            json!({"agent_id":"worker","owner":"victim"}),
            json!({}),
            json!({"agent_id":42}),
        ] {
            let reply = protocol
                .reply(
                    request(
                        "tools/call",
                        json!({"name":"get_delegation","arguments":arguments}),
                    ),
                    |_, _| panic!(),
                )
                .unwrap();
            assert_eq!(reply["error"]["code"], -32602);
        }
        let reply = protocol
            .reply(
                request("tools/call", json!({"name":"delete_workspace"})),
                |_, _| panic!(),
            )
            .unwrap();
        assert_eq!(reply["error"]["code"], -32602);
        let reply = protocol
            .reply(request("unsupported", json!({})), |_, _| panic!())
            .unwrap();
        assert_eq!(reply["error"]["code"], -32601);
    }

    #[test]
    fn business_failures_are_tool_errors_and_notifications_have_no_response() {
        let mut protocol = ready();
        let reply = protocol
            .reply(
                request(
                    "tools/call",
                    json!({"name":"get_delegation","arguments":{"agent_id":"unowned"}}),
                ),
                |_, _| Err("delegation_not_found".into()),
            )
            .unwrap();
        assert_eq!(reply["result"]["isError"], true);
        assert!(reply.get("error").is_none());
        assert!(protocol
            .reply(
                json!({"jsonrpc":"2.0","method":"notifications/cancelled"}),
                |_, _| panic!()
            )
            .is_none());
        let reply = Protocol::default()
            .reply(request("tools/list", json!({})), |_, _| panic!())
            .unwrap();
        assert_eq!(reply["error"]["code"], -32000);
    }

    #[test]
    fn stdio_frames_are_bounded_and_preserve_escaped_newlines() {
        let input = b"{\"text\":\"one\\ntwo\"}\n{\"id\":2}\n";
        let mut reader = BufReader::new(&input[..]);
        assert_eq!(
            serde_json::from_str::<Value>(&frame(&mut reader).unwrap().unwrap()).unwrap()["text"],
            "one\ntwo"
        );
        assert!(frame(&mut reader).unwrap().is_some());
        assert!(frame(&mut reader).unwrap().is_none());
        assert!(frame(&mut BufReader::new(&vec![b'x'; MAX_FRAME + 1][..])).is_err());
    }

    #[test]
    fn credentials_bind_exact_owners_and_rotation_revokes_only_that_process() {
        let runtime = Runtime {
            directory: PathBuf::new(),
            credentials: Mutex::new(HashMap::new()),
            calls: Mutex::new(()),
        };
        let first = runtime.grant("first");
        let second = runtime.grant("second");
        assert_eq!(runtime.owner(&first).unwrap(), "first");
        assert_eq!(runtime.owner(&second).unwrap(), "second");
        assert!(runtime.owner("first").is_err());
        let resumed = runtime.grant("first");
        assert!(runtime.owner(&first).is_err());
        assert_eq!(runtime.owner(&resumed).unwrap(), "first");
        runtime.revoke("first");
        assert!(runtime.owner(&resumed).is_err());
        assert_eq!(runtime.owner(&second).unwrap(), "second");
    }

    #[test]
    fn builtin_is_credential_free_and_materialization_uses_environment_not_arguments() {
        let entry = builtin();
        assert!(entry.config.get("env").is_none());
        assert!(entry.config.get("command").is_none());
        let server = server_config(
            "/Applications/Prometeu.app/Contents/MacOS/Prometeu".into(),
            "/tmp/test/socket".into(),
            "secret".into(),
        );
        assert_eq!(server.config["env"]["PROMETEU_MCP_TOKEN"], "secret");
        assert!(!server.config["args"].to_string().contains("secret"));
        assert_eq!(server.config["args"], json!(["--prometeu-mcp"]));
    }
}
