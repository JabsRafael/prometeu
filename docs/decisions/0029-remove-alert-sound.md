# ADR 0029 — Visual pending indicators without sound alerts

Date: 2026-09-08
Status: Accepted

## Context

Even after adjustments to completion detection, the sound alerts keep
interrupting the person repeatedly. Removing the feature was requested.

## Options considered

1. Keep adjusting the detection or turn the sound off by default.
2. Remove the audio and its configuration, preserving the visual indicators.

## Decision

Adopt the second option. Remove the pling synthesis, the Web Audio
initialization on interaction, the completion and comment triggers, the sound
preference and its row in Settings. Also remove the comment memory used
exclusively to avoid repeating the sound.

Execution tracking in `alert.ts` remains for the Dock's dot, including
questions, reading, visibility, background and the workspace count. The
adapters' and the backend's events stay the same.

Only an accepted local `session.state: busy` arms a completion. Assistant
activity confirms the execution; a successful or failed `turn.completed`
without background work schedules the visual indication after one second.
New activity cancels it. An error may notify without earlier activity;
interruptions and successful turns without activity do not. Reading or
answering a request does not re-arm a completed execution. Requests can create
their own visual pending state. Visible completions are consumed without
creating a pending indication.

`chat.rs` records accepted input before concurrent responses. Claude and Codex
normalize background activity into V1 events; child content does not enter the
main conversation. Ending a background task alone does not count as the main
agent's completion. The Dock counts workspaces with unread or pending activity,
plus inbox comments.

## Consequences

Prometeu no longer offers sound alerts for completions and comments. The person
follows pending items through the existing visual indicators.

The legacy `prometeu:som` key stays inert in localStorage. There is no
migration, state rewriting or change in the V1, IPC, transcript and relay
formats; therefore no format compatibility test applies.

## Evidence

- [Pending-item tests](../../src/alert.test.ts): Dock counting and reading,
  questions, completions and comments; every case asserts that no audio context
  was created.
- [Conversation ordering](../../src-tauri/src/chat.rs) and
  [Codex subagent normalization](../../src-tauri/src/codex.rs).
