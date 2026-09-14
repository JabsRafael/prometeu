# Dependency rules

Status: rules in force and direction of evolution.

## Principle

An interface exists when it separates a policy of ours from a technology or
protocol that may vary. Interfaces are not required between internal functions
only to increase the number of layers.

## Conceptual layers

| Layer | Current examples | May know about |
| --- | --- | --- |
| presentation | `chat.ts`, `workspace.ts`, `workspace-changes.ts`, `sidebar.ts` | view models, use cases and IPC contracts |
| derived domain | `timeline.ts`, `relay/src/logic.ts` | domain types and pure functions |
| application | `session.rs`, coordination in `main.ts` | domain and external ports |
| adapters | `claude.rs`, `codex.rs`, IPC, relay transport, Git/files | external protocols and core contracts |

The current directories do not literally represent these layers. The table
serves to decide ownership and dependency direction during incremental changes.

## Rules in force

1. `timeline.ts` does not depend on DOM, Tauri or network.
2. `relay/src/logic.ts` performs no I/O; `room.ts` interprets its effects.
3. `relay/src/protocol.ts` does not depend on APIs exclusive to the app or the Worker.
4. Persisted state is changed in the backend and republished by the `board` event.
5. Filesystem, Git and process access happens in the backend.
6. Remote input is validated again on the side that owns the authority.
7. Backend errors cross IPC as codes/data and are translated in the frontend.
8. Presentation decides visibility through `AgentCapabilities`; provider name
   comparisons stay in the catalog or in the adapters.

## Rules in force for agents

1. Claude, Codex or any other vendor protocol appears only in the corresponding
   adapter and in that adapter's fixtures.
2. The core receives `ConversationCommand` and produces `ConversationEvent`,
   both owned by Prometeu.
3. A new provider implements the same port and passes the conformance suite.
4. Unknown events do not take a session down; they stay observable and are
   ignored compatibly until they have an explicit translation.

The legacy transcript reader is an explicit exception to the first rule. It is
isolated in `conversation-legacy.ts` and in the Claude adapter's replay path,
without reaching the timeline or the canonical protocol. Prometeu does not
produce new lines in the legacy format.

## Boundaries that justify interfaces

### Agent runtime

Varies per installation, catalog, protocol, resume and capabilities. It must
expose discovery, start/resume, commands, events and shutdown without leaking
the vendor's payload.

### IPC

Separates TypeScript and Rust. Name, arguments, return value, error and events
form a single contract. The web mock is another adapter of that same contract.
`src/ipc.ts` owns the command argument/result map consumed by frontend callers
and `IpcHandlers` in the mock. Exact command-name parity with Rust is tested;
Rust payload shapes remain manually synchronized. See the
[IPC contract](../contracts/ipc.md).

### Collaboration

`team-transport.ts` abstracts the socket; `team-control.ts` turns frames into
local actions. The protocol and its validation stay shared.

The core (`team-member.ts` and the features `team-owner.ts`, `team-viewer.ts`,
`team-comments.ts`) receives the ports from `team-ports.ts` through the shell:
`Membership`, `SecurityStore` and `OwnerHost`. Features are hooks registered on
the member, in the order chosen by the composition root. `src/team.ts` is the
desktop shell; no `team-*.ts` imports `@tauri-apps`, `./ipc`, `./mock` or
`./team`. See [ADR 0026](../decisions/0026-portable-collaboration-core.md).

### Local system

Git, files, PTY, processes and the embedded browser are external effects. Rules
that choose when to run those effects must stay testable without them.

## Feature-based organization

When splitting a large file, extract a complete responsibility, with its types
and tests, instead of splitting by size. A feature may contain:

```text
feature/
  model.ts        state and pure rules
  service.ts      use-case coordination
  view.ts         DOM and interaction
  contract.ts     types that cross the boundary, if any
  *.test.ts
```

The project does not need to adopt this whole tree at once. A new module should
be born in it only when the change already requires the boundary.

## How to verify

The rules are protected by review, focused tests and small fitness functions:

- `npm run architecture:check` blocks per-provider UI conditionals outside the
  catalog/capability and coupling of the collaboration core to the desktop;
- exhaustive types for `ProviderId` and canonical events;
- a parity test between IPC commands, Rust handlers and the mock;
- conformance fixtures per adapter.

Do not introduce a dependency-analysis tool before a concrete rule exists that
it can actually verify.
