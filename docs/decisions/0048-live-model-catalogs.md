# ADR 0048 — Runtime catalogs own selectable models

Date: 2026-09-17
Status: Accepted

## Context

Hardcoded Claude aliases remained selectable after retirement and overrode live
labels. Discovery failures silently restored those aliases. Codex selection read
an external cache without asking the runtime, and neither catalog refreshed while
the app stayed open.

## Decision

Keep installation discovery fast and query each selected account through the
shared `agent_models` IPC. Claude uses `list_models`; Codex uses every page of
`model/list` without hidden entries. Reuse the existing bounded process lifecycle
and Codex JSON-RPC client. Querying models never opens a conversation or sends a
prompt.

Keep the descriptor wire shape unchanged. The frontend owns transient loading,
ready, empty and error states. Clear selectable models on refresh and failure;
never treat historical labels as evidence of availability. Retain persisted
choices and prefer live labels whenever present.

Refresh at startup and account changes, then every five minutes while visible and
on focus when due. Coalesce background calls and discard previous generations.
Expose status in the shared pickers. An open launcher updates as discovery
completes and refuses an unavailable model.

## Alternatives and consequences

Keeping a last-known list would improve offline selection but could offer retired
models. Clearing it causes a brief unavailable picker while querying and prevents
new launches when discovery fails. Existing conversations remain usable.

Direct provider HTTP calls would duplicate authentication and model-access rules.
The CLI remains authoritative, including its own refresh/fallback policy; the app
cannot claim independent proof of remote freshness. Hidden Codex entries are not
part of its advertised default picker and remain excluded.

Polling on every menu click would spawn too many processes. Five-minute refreshes
bound routine staleness without changing running conversations. Existing history
and action choices need no migration. Only the internal IPC command changes;
frontend/backend/mock parity and provider fixtures cover that replacement.

## Evidence

[Runtime contract](../contracts/agent-runtime.md),
[provider matrix](../quality/provider-matrix.md), `src/agents.test.ts`,
`src-tauri/src/agents.rs`, `src-tauri/src/codex/account.rs` and
`e2e/models.spec.ts` cover live labels, retirement, errors, pagination, refresh and
account-switch races.
