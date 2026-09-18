# Embedded Prometeu MCP and delegation

Status: implemented. Decision: [ADR 0049](../decisions/0049-embedded-delegation-mcp.md).

## Catalog and transport

`prometeu` is a virtual built-in MCP entry. Every installation exposes it in the
existing hub/pickers; no default selection is changed. The entry cannot be
edited, removed or shared as a cloud catalog item. Existing global, reviewed
project and workspace selection rules apply. Selection changes apply on the
next process spawn/resume, not to an idle process that is still alive.

Only selection materializes `Prometeu --prometeu-mcp`, using the running app's
executable path. This entry point runs without a webview or login-shell startup.
Claude gets a private MCP config; Codex uses the existing private environment
file wrapper. Credentials are never stored in the hub or command-line arguments.

The subprocess speaks newline-delimited JSON-RPC over stdio, negotiates MCP
`2025-06-18`, and supports initialization, ping, tools/list and tools/call.
Notifications do not receive responses. Protocol errors use JSON-RPC errors;
operation failures use `isError` tool results. Successful results include both
text JSON and structuredContent. See the official
[transport](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports),
[lifecycle](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle)
and [tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)
contracts.

A private Unix socket in a randomly named 0700 directory under `/tmp` connects
that subprocess to the open desktop app. Its path stays below macOS's socket
pathname limit. The socket is 0600; a random process credential binds every
request to one conversation. Spawning replaces that conversation's credential;
process removal revokes it; app exit clears all credentials and removes the
socket. Calls also require a live owner process and an existing owner tab.
Transport input is limited to 1 MiB; responses to 768 KiB. Socket reads/writes
have deadlines. The server serializes tool operations; preparation and agent
execution continue asynchronously. No HTTP listener or relay route is added.

This is application authorization, not an OS sandbox. Agent processes retain
the local user's permissions and can access files outside MCP using their
ordinary tools. Other code running as that user can read the private session
configuration. The contract limits operations through this MCP.

## Identities and ownership

- Workspace: repositories, worktrees, branch and the person's manual stage.
- Delegated agent: one task responsibility, with a stable `agent_id`.
- Conversation: the transcript, identified by `conversation_id`; in this version
  it has the same ID as its delegated agent.
- Execution: one coordinator message or observed turn, with its own `execution.id`.
  Ordinary follow-up input accepted during a running execution retains that ID
  until the next observed turn completion.

`Board.delegations` stores owner conversation, agent, workspace, initial task,
creation request key/hash, repository starting commits, executions, last
observed background tasks and pending requests. The field defaults to an empty
list on old boards. No transcript is rewritten. Ownership survives a process
restart and is never inferred from tab order, the active tab, or workspace
membership. Opening another tab in the delegated workspace grants no authority
over that tab. Unowned and nonexistent targets both return
`delegation_not_found`. Deleting the coordinator tab makes its delegations
inaccessible through MCP; their workspaces remain available to the person.

## Tools

Every target is an `agent_id` returned by `delegate`. No tool accepts an owner
identity, arbitrary workspace ID, or arbitrary repository path.

| Tool | Inputs | Behavior |
| --- | --- | --- |
| `delegate` | `request_key`, `title`, `task`, optional `provider`, `model`, `effort` | Creates one agent and one isolated workspace; returns immediately during preparation. |
| `list_delegations` | optional `offset`, `limit` (1–100) | Lists only this conversation's delegations. |
| `get_delegation` | `agent_id` | Returns workspace preparation/failure/manual stage, conversation status, latest execution, background, pending requests and setup/run runtime. |
| `get_execution` | `agent_id`, `execution_id` | Reads a specific recorded execution. |
| `send_message` | `agent_id`, `request_key`, `text` | Sends to an idle agent or resumes its stopped process. Returns an execution. |
| `interrupt` | `agent_id` | Requests interruption of the main turn; does not promise to stop every provider background task. |
| `read_conversation` | `agent_id`, optional `limit` (1–200) | Returns a bounded tail of canonical V1 events, never another tab's transcript. |
| `list_files` | `agent_id`, optional relative `path`, `offset`, `limit` (1–500) | Lists entries within the owned workspace. |
| `read_file` | `agent_id`, relative `path`, optional `start_line`, `limit` (1–500) | Reads text with zero-based line pagination. |
| `run_workspace_script` | `agent_id`, `kind` (`setup` or `run`), optional `name` | Starts a configured script or reuses the same live script. `name` selects a configured Run entry. |
| `read_workspace_script_log` | `agent_id`, `kind` (`setup` or `run`), optional `limit_bytes` (1–65,536) | Reads a bounded tail of retained terminal output, with process state and exit code. |
| `open_workspace_preview` | `agent_id` | Requests opening the delegated conversation and workspace preview in the desktop app. Does not start a service. |

Delegation uses the coordinator's repositories and each repository's committed
HEAD. Uncommitted changes are not copied. Non-Git directories and repositories
without a commit cannot be delegated in this version. Branch names are generated
by the backend. Provider/model/effort default to the coordinator conversation’s effective
choice; switching provider without specifying a model uses that provider’s
default. An action-profile permission policy is copied and retained on resume;
ordinary conversations retain the existing default permission behavior.
Existing workspace creation, worktree rollback and setup scripts
apply; failed preparation remains visible. Initial workers explicitly select no
MCP servers, plugins or standalone skills, so they do not inherit the
coordinator's delegation ability or global/project tool defaults. The person
can change their selections normally. Provider-native behavior beyond those
existing selection guarantees is unchanged.

Creation retries with the same owner and request key return the original
result; changed creation arguments return `request_key_conflict`. Message keys
are scoped to the target agent and compare a text hash. Retrying returns the
original execution rather than sending twice. Keys are 1–128 bytes; task and
message text are nonblank and at most 64 KiB. Ownership is flushed to disk before
preparation, and execution reservation before message dispatch. This does not
promise exactly-once provider delivery across a crash: a reserved execution may
be stopped without delivery, or a provider may have accepted before persistence.
Inspect pending input and history rather than automatically using a new key.

Busy conversations, pending input/questions, archived/cleaned/failed workspaces
and known active background tasks reject new MCP messages. There is no steering
or scheduling API. Person and MCP sends share a per-conversation input gate;
the immediate process write checks idleness again under the process lock.
A failed spawn can retain the existing pending message for ordinary recovery.
There are no deletion, Git publishing, approval-answer, automatic orchestration,
or remote-control tools.

## Workspace scripts and preview

Creation already runs the existing setup, including configured file copies and
multi-repository setup. The explicit setup tool is useful for retries. It
accepts no script name; Run accepts only names declared in the existing
repository settings, with the same primary-repository/default selection as the
desktop. Neither tool accepts shell commands, arbitrary paths or workspace IDs.
The exact delegated conversation must still exist, and mutations reject
preparing, failed, archived or cleaned workspaces.

Scripts use the existing dock PTYs, worktree environment and reserved port.
Starts from the desktop and MCP share the process check and insertion. A live
script is reused; requesting another Run name while one is alive fails with
`err.dock.running`. MCP Run refuses to start while setup is running. After a
script exits, another call explicitly starts it again, replacing its old log;
script calls have no durable request-key deduplication. Commands return after
process startup rather than waiting for setup or a long-running service to exit.
Existing desktop controls stop scripts; archive/removal keep their existing
cleanup behavior.

`get_delegation.runtime` contains `port`, `url`, `run_names`, and `setup`/`run`
objects with `state` (`not_started`, `running`, `exited`), `name` and `exit_code`.
The runtime is `null` if the workspace no longer exists. No retained PTY means
`not_started`, including after app restart or closing that dock; it does not
prove that a script has never run. Exit code `null` means no observed exit code,
not success. Runtime data is process-local and adds no persisted board fields.
A live process and an allocated URL do not prove HTTP readiness.

Log reads default to the last 16 KiB, capped at 64 KiB of retained bytes. They
return `text`, `truncated`, `seq`, `running`, `name` and `exit_code`. Text retains
ANSI escapes and uses lossy UTF-8 decoding at byte boundaries. `seq` belongs to
the current PTY and is not a durable cursor. The existing 512 KiB scrollback
limit still applies. Missing logs return `script_not_started`.

Preview opening emits a local `workspace-preview` event to the main webview,
with the owned workspace and conversation IDs. The desktop rechecks their
presence and availability, navigates through its existing workspace flow and
opens the existing embedded preview. It derives the URL from the workspace
port; the MCP cannot supply a URL or JavaScript. The tool returns `requested`
and `url`, acknowledging the navigation request rather than page load or server
readiness. Opening is explicit because it changes the person's visible workspace.

## Observed execution state

Execution states are `queued`, `running`, `completed`, `stopped`. A completed
execution has outcome `ok`, `error` or `interrupted`. Its source distinguishes
coordinator input, ordinary conversation input and observed background
continuation. A process stopping or the app restarting does not invent success. A queued
execution with a persisted pending message retains its ID on recovery; other
unfinished executions become stopped.
Requests remain for the person to answer in Prometeu.

Accepted ordinary input does not identify a separate provider turn in V1, so
overlapping input does not create concurrent execution records. The active ID
keeps its original source and receives the next observed terminal outcome. If
the provider starts responding again afterward without another accepted input
event, the existing background-continuation rule creates a separate execution;
this does not claim which earlier message caused it. MCP sends still reject
busy conversations and retain a distinct ID for each accepted request key.

Background `null` means no current authoritative observation; `[]` is an
observed empty set. A successful main turn does not clear background tasks, and
an empty background update does not complete a turn. Claude and Codex supply the
existing normalized signals; neither promises complete visibility into every
native child process. Native provider subagents are distinct from other
Prometeu delegations.

Execution observation updates only memory under the conversation publication
lock, in canonical event order. The lock order is chats → conversation buffer →
board; delegation never takes a conversation lock while holding the board.
Publication and persistence remain outside the conversation locks. This prevents
a fast completion from being overwritten by a delayed busy reaction.

History uses the existing bounded transcript tail, normalized at the provider
edge. A response is capped at 256 KiB of whole events and reports `truncated`;
an individual oversized trailing event can produce an empty truncated tail.
The returned transport sequence is process-local, not a durable pagination
cursor. Files reuse the existing canonical-path/symlink boundary, limit files
to 2 MiB, and cap each page at 128 KiB. Overlong individual lines return an
error. Directory pages reflect the filesystem at call time, not a snapshot.

## Evidence

- `delegation.rs` tests ownership, old/new board compatibility, separate
  execution/background state, overlapping ordinary input, restart behavior and
  input limits, workspace availability, preview payloads and bounded script logs.
- `embedded_mcp.rs` tests handshake, schema enforcement, tool failures,
  notification handling, bounded framing and credential placement.
- MCP materialization tests cover both provider configuration formats.
- `e2e/tools.spec.ts` covers built-in availability without default activation.
- `pty.rs` tests retain real process output and exit status; `e2e/browser.spec.ts`
  covers the preview navigation event over the browser mock in both engines.
- Existing `session/files.rs` tests cover path/symlink confinement.
