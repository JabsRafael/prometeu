# ADR 0051 — Gemini ACP and account authentication methods

Date: 2026-09-19
Status: Accepted

## Context

Gemini CLI is the third external runtime. Version 0.30.0 is the compatibility
baseline available for local inspection. Its one-way stream-json mode cannot
answer tool approvals, whereas ACP supports a persistent session, requests and
resume. Google login and API keys also cannot fit a single browser-login action.

## Options considered

- Start a headless CLI for each prompt: simpler transport, but loses interactive
  approval semantics and relies on a weaker continuation model.
- Integrate model APIs directly: duplicates the CLI's tools, context and auth.
- Adapt ACP at the edge and expose auth-method metadata: preserves V1 and the
  existing process/session boundary, but requires version checks and explicit
  handling of history replay and credential isolation.

## Decision

Use the Gemini CLI ACP adapter with minimum version 0.30.0 and validate its
handshake. Keep vendor payloads within the adapter. Persist the native session
ID for resume; retain V1 separately for presentation. Consume the native replay
before sending new prompts so historical content cannot create duplicate UI or
notifications. Plan mode is a persisted launch choice and leaving it restarts/resumes.
Approval stores the execution permission and continuation before restarting, so
a failed process launch does not silently lose the decision or next prompt.
Only evidenced capabilities are exposed; hub MCP/plugins/skills stay unavailable.

Extend provider descriptors with authentication methods. Settings and the footer
share account state and cards. Connecting still requires an explicit later
selection. Active-account removal confirms the consequences and never selects
an alternative automatically.

Managed Gemini homes share history, not identity. Google authentication uses the
CLI's official flow, with a dedicated terminal for consent if non-TTY ACP is
insufficient. API-key entry is a narrowly scoped amendment to
[ADR 0012](0012-provider-accounts.md): the credential crosses IPC once from UI to
backend and is stored in macOS Keychain per account UUID through native APIs.
Only method and suffix return to the UI. No key enters process arguments, board,
transcripts or relay. Child environments prevent alternative credentials from
replacing the account, including `.env` and Gemini's fixed global OAuth keychain.
Other account-selection and removal guarantees from ADRs 0012/0013 remain intact.

Preserve unknown-provider account values and selections during registry updates,
without exposing them to older runtime catalogs. This protects builds containing
the compatibility patch; it cannot repair binaries already distributed without it.

## Consequences

The baseline uses CLI model aliases rather than claiming a live ACP model catalog.
API-key accounts show no quota windows. No relay format change is needed.
Credentials and native histories survive deregistration, following ADR 0013.
Real OAuth and cross-account resume need manual evidence in addition to fixtures.

## Evidence

- `accounts.rs`: unknown-provider round-trip and known-entry validation tests.
- `gemini.rs` and `gemini/account.rs`: protocol, replay and profile tests.
- `src/agents.test.ts`: unavailable bootstrap behavior.
- `e2e/accounts.spec.ts`: shared cards, method choice, active removal and secret-free snapshots.
- [Provider matrix](../quality/provider-matrix.md): current evidence and live-test limits.
