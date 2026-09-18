# ADR 0049 — Built-in MCP for conversation-owned delegation

Date: 2026-09-18
Status: Accepted

## Context

An agent should be able to delegate work through Prometeu and inspect progress.
A workspace is an environment and may contain unrelated conversations. Treating
all tabs in a created workspace as subordinate agents would give the coordinator
control over conversations the person opened later. Process identity also
cannot express ownership because transcripts outlive their processes.

## Decision

Ship a virtual `prometeu` MCP in every installation, without adding it to any
default selection. Existing selectors activate it. The first version creates
one task-bound agent/conversation and an isolated workspace per delegation.
Ownership is persisted against the coordinator conversation and the exact
created conversation. It does not extend to other workspaces, other tabs or
transitive descendants. Workers explicitly start with empty tool selections;
further delegation requires a person's tool selection.

Use a stdio mode of the existing executable, bridged to the open desktop app
through a private Unix socket and a per-process credential. The desktop remains
the owner of worktrees, processes and state. Provider adapters keep their
existing MCP materialization; the built-in registry row contains no credential.
No provider-native config is edited and no relay or Cloud API is added.

`delegation.rs` owns authorization and use cases, `embedded_mcp.rs` owns the
protocol/transport. Workspace creation remains in `session.rs`. Add an optional
owner record to its internal creation path; allocate the worker conversation ID
before preparation and persist ownership together with the new workspace.
Execution IDs remain separate from conversation IDs. Observe canonical events
under their publication lock with only an in-memory board mutation, then
publish outside the conversation locks. This explicitly extends the previous
rule that all board reactions happened after unlocking: ordered execution
observation needs to precede a fast subsequent response. Lock order remains
chats → buffer → board, with no process/file operations while holding the board.

Creation and messages have request keys to make ordinary retries idempotent.
New MCP messages reject busy targets. Native pending-message recovery remains;
there is no exactly-once promise across provider/persistence crashes. Main turn
completion and observed background activity remain separate facts. Workspace
stage remains the person's decision.

## Alternatives and consequences

A generic workspace CRUD/IPC bridge was rejected because it exposes unrelated
state and couples agents to presentation commands. A standalone daemon would
create a second lifecycle owner; an HTTP server adds an unnecessary network
boundary for the initial local-only feature. Pure stdio without a bridge could
not coordinate the already-running desktop state safely.

The shared executable avoids installation dependencies. It requires the desktop
to stay open, and app restarts require a fresh agent process/credential. The
socket credential authorizes the MCP API but is not a sandbox against local
processes with the user's filesystem permissions.

Persisted delegation records and explicit execution IDs add compatibility and
storage responsibilities. No new scheduler, automatic manager agent, hierarchy
UI, deletion tool, approval proxy or distributed execution is introduced.
Later support for several delegated agents sharing an environment can reuse the
separate identities without reinterpreting every existing workspace as an agent.

## Contract and verification

See [embedded MCP](../contracts/embedded-mcp.md) and the
[provider matrix](../quality/provider-matrix.md). Tests cover ownership of exact
conversations, restart/migration, MCP framing/lifecycle, tool selection and both
provider materialization paths. The implementation does not require a new IPC
command: existing hub and board responses gain additive data.
