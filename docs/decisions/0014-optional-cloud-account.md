# ADR 0014 — optional account and separate SaaS

Date: 2026-09-06
Status: Superseded by [ADR 0015](0015-cloud-rails.md) in the choice of stack.
The guarantees of an optional account, relay isolation and browser-based
connection remain.

## Context

Personal access from several devices needs its own identity. The current relay
identifies team members and forwards conversations; it has no personal accounts
and no transcript persistence. Local use must keep working without registration
or a connection to the SaaS.

## Options considered

1. Reuse the relay's enrollment as the account: it mixes people and devices and
   changes the authority of the existing sharing.
2. Implement our own passwords and sessions: it creates security maintenance
   that does not belong to the product.
3. A separate service with existing authentication and a browser-based
   connection.

## Decision

Create the independent `prometeu-cloud` project with Better Auth, Node 24 and
SQLite, prepared for the existing VPS. Use Better Auth's device authorization
flow to connect the desktop. Keep the token in the backend, outside the webview,
with the same private-file guarantees as the existing integrations.

The sidebar shows the account's name and menu; without an account, it offers
optional registration. Registration, editing and deletion happen on the
responsive site. A Prometeu account does not select a provider account and does
not change the team's enrollment.

## Consequences

SQLite and a single process are enough for this first stage; there is no Redis,
queue or cloud execution. Horizontal scale requires re-evaluating the database
and coordination. SMTP enables account verification and recovery and is a
production requirement.

The flow adds a code confirmation in the browser, but avoids a password on the
desktop and redirects to local ports. Session tokens last up to 30 days, with
renewal on activity and server-side revocation. A cached identity keeps the UI
usable during SaaS unavailability.

Persisting transcripts is a later stage. This decision does not change the
relay's trust boundary, does not promise end-to-end encryption and does not
authorize automatic upload of conversations when an account is created.

## Evidence

See the [account contract](../contracts/cloud-account.md), the `cloud.rs` tests
and `e2e/cloud.spec.ts`, and the HTTP suite of the `prometeu-cloud` project.
