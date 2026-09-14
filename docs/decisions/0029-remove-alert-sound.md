# ADR 0029 — Removal of sound alerts

Date: 2026-09-08
Status: Accepted

Supersedes [ADR 0025](0025-completion-sound-per-execution.md) regarding the
sound.

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

## Consequences

Prometeu no longer offers sound alerts for completions and comments. The person
follows pending items through the existing visual indicators.

The legacy `prometeu:som` key stays inert in localStorage. There is no
migration, state rewriting or change in the V1, IPC, transcript and relay
formats; therefore no format compatibility test applies.

## Evidence

- [Pending-item tests](../../src/alert.test.ts): Dock counting and reading,
  questions, completions and comments without creating an audio context.
- [Interface flows](../../e2e/alerts.spec.ts): no audio on the desk, in the
  workspace and with subagents, plus the removal of the option in Settings.
