# ADR 0058 — Optional context evaluation behind an application-owned port

Date: 2026-09-24
Status: Accepted

## Context

A task can start with an unresolved product decision or missing information
that changes the implementation. Discovering that after the agent has started
costs clarification turns and rework. TypeSafe can classify a text context and
answer several narrow, closed questions in one call with a confidence per
answer. Prometeu runs local CLIs and has no model of its own; any external
evaluation is a new trust boundary: it needs the person's own credential,
sends their draft off the machine and can fail independently of the app.

The first consumer is a missing-context review in the launcher for new local
workspaces. Other bounded classification features may follow, so the boundary
must not be shaped around one vendor payload or one screen.

## Options considered

1. **Call TypeSafe from the launcher.** Smallest change, but the key would
   reach the webview, vendor payloads would reach the presentation, and a second
   feature would copy the transport and error handling.
2. **A new conversational provider in the agent catalog.** Reuses accounts and
   the runtime port, but evaluation is not a conversation, has no process and
   must stay independent of the chosen coding agent.
3. **An application-owned evaluation port with one HTTP adapter at the edge.**
   The feature asks closed questions and applies its own rules; the adapter owns
   the credential, transport, retries, response validation and error
   translation.
4. **A general provider marketplace or orchestration layer.** Premature: one
   adapter and one consumer exist.

## Decision

Adopt option 3.

- `src-tauri/src/evaluation.rs` owns the port: `EvaluationRequest` (bounded
  context text plus at most eight closed questions), answers with outcome and
  confidence, request and response validation against the closed sets, the
  configuration generation that invalidates in-flight results, and the
  application error codes `disabled`, `auth`, `rate_limited`, `unavailable`,
  `malformed`, `invalid` and `stale`. It has a fake for tests and a disabled
  path that makes no call.
- `src-tauri/src/typesafe.rs` is the only place that knows TypeSafe: the private
  credential file, the explicit enable flag, the HTTP adapter with timeouts and
  bounded retries, and the translation of vendor statuses into the codes above.
- `src/evaluation.ts` mirrors the port for the frontend without I/O;
  `src/typesafe.ts` is the desktop shell (IPC port and configuration status).
- The missing-context review (`src/context-review.ts`) is a pure consumer: it
  builds the context, asks its own closed questions, and selects a question from
  an app-owned localized catalog with conservative thresholds and an explicit
  no-suggestion result. It never generates or rewrites text.
- The integration starts disabled. Saving a key never enables it; removing the
  key disables it. Only an explicit **Review request** action sends context.
  Creating workspaces, sending prompts and running agents never depend on it,
  and a failure never falls back to another service or provider.

The public TypeSafe documentation was not reachable from the environment in
which the adapter was written. The request/response shape is an explicit,
isolated assumption in `typesafe.rs::wire`, described in the
[contract](../contracts/context-evaluation.md#assumed-typesafe-wire-shape). The
endpoint origin can be overridden with `PROMETEU_TYPESAFE_URL` (HTTPS, or
loopback HTTP for local testing). A correction changes only that module and its
fixtures.

## Consequences

- The feature and the foundation are tested separately: the port with a fake,
  the adapter against a local HTTP server with synthetic responses, and the
  review rules with a fake port in TypeScript.
- The key stays in a private backend file and never crosses IPC, the board, the
  relay, transcripts, logs or error messages.
- A second bounded classification feature can reuse the port and the adapter by
  supplying its own closed questions and selection rules.
- Thresholds are hypotheses. Suggestion usefulness, avoided rework, extra user
  effort and latency must be measured against ordinary submission; a clicked
  suggestion is not evidence of better outcomes.
- Until the wire shape is confirmed against the live service, the integration
  should be treated as unverified outside the automated suite.
- Automatic review while typing, ongoing-chat review, mobile and remote
  sessions, repository indexing, image interpretation and free-form question
  generation are deferred.

## Evidence

- [Port validation, disabled path and stale generations](../../src-tauri/src/evaluation.rs).
- [Credential lifecycle, secret redaction and adapter failures](../../src-tauri/src/typesafe.rs).
- [Selection rules, English and Portuguese examples and stale results](../../src/context-review.test.ts).
- [Contract](../contracts/context-evaluation.md).
