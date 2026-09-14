# ADR 0025 — Completion sound per accepted execution

Date: 2026-09-08
Status: Partially superseded by [ADR 0029](0029-remove-alert-sound.md) regarding
the sound; the tracking of visual pending items and the adapters' events remain.

## Context

The sound alert shared the tab's unread state. Looking at the conversation or
answering a request re-armed that state; an intermediate result or an automatic
continuation could play again while the agent was still working. Questions also
used the completion sound. In Codex, the isolation of child threads discarded
the information needed to track subagents.

## Options considered

1. Adjust the unread state or infer completion from the board's status. Both mix
   the person's attention with execution and stale snapshots.
2. Infer completion from an interval without output. A slow tool may stay silent
   while it keeps working.
3. Track the accepted execution with live V1 events and require a main terminal
   event, with no background tasks, before notifying.

## Decision

Adopt the third option. `chat.rs` emits the existing ephemeral `session.state`
event with `starting` when the process starts and `busy` after accepting
`message.send`. Publishing `busy`, the message and the echoes happens under the
same lock, before concurrent responses. An unsuccessful write does not arm a
notice.

`alert.ts` keeps the per-tab execution state separate from the unread state.
Only a live local `busy` arms the notice; assistant activity confirms the
execution. A `turn.completed` with success or error and without background tasks
schedules the notice for 1 second later. New activity cancels the candidate.
Silence without a terminal event schedules no notice. An interruption and a
terminal event without activity consume the execution without sound; an error
may notify even without previous activity.

A visible completion or one with the sound turned off also consumes the
execution. Looking, answering requests, echoes and events synthesized in the
snapshot do not re-arm it. Questions and permissions keep the Dock indication,
without a completion sound.

The adapters keep responsibility for subagents. Claude already emits
`background.changed`. Codex normalizes `collabAgentToolCall.agentsStates`,
`subAgentActivity` and known child events, without inserting the children's
content into the main conversation. The end of a background task does not play a
sound: another terminal event from the main agent is required.

## Consequences

The notice no longer depends on navigation and the unread mark. The common rule
covers Claude and Codex without external payloads in the presentation. The V1,
IPC, transcript and relay formats do not change; there is no data migration and
no new commands.

The 1-second window absorbs immediate continuations and adds that latency to the
notice. Detection depends on the signals the CLI emits: there is no guarantee
against a later, unannounced continuation. A background task that ends without a
new final answer from the main agent produces no sound.

## Evidence

- [State and sound regressions](../../src/alert.test.ts): intermediate events,
  subagents, reading, answers, interruptions, visibility and sound turned off.
- [Desk and workspace flows](../../e2e/alerts.spec.ts): Chromium and WebKit.
- [chat.rs](../../src-tauri/src/chat.rs) tests: `busy`, the message and the echo
  precede concurrent responses; a write failure publishes neither `busy` nor the
  message.
- [codex.rs](../../src-tauri/src/codex.rs) tests: child isolation, spawn,
  activity and partial subagent states.
- [V1 contract](../contracts/conversation-events-v1.md) and the
  [provider matrix](../quality/provider-matrix.md).
