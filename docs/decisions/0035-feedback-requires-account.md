# ADR 0035 — Feedback requires a Prometeu account

Date: 2026-09-10
Status: accepted. Supersedes
[ADR 0033](0033-github-feedback-attachments.md).

## Context

ADR 0031 opened anonymous submission and ADRs 0032 and 0033 kept that contract
while changing only the destination and the storage. None of that ever ran in
production: `POST /api/feedback` never existed in the Cloud and the desktop
received 404 on every attempt, with the generic send error.

Creating an issue on GitHub requires a token, and there is no anonymous
creation. Distributing that token in the client would hand it to anyone who
opened the binary, with write and read access to the private repository. The
intermediary is mandatory.

Feedback is a Prometeu product channel, not a public form. Whoever submits must
be identifiable so the team can answer and so the channel does not become a spam
target.

## Decision

`POST /api/feedback` requires a session: the desktop sends the connected
account's Bearer and a Cloud page sends the signed session cookie. Without a
session, 401. The limit becomes per account, five reports per hour, replacing
the per-IP limit and the global daily quota.

The desktop delivers through the Rust backend, in the `feedback_send` command,
because the account's token has lived outside the webview since the optional
account ADR. The webview assembles the report and never sees the credential.

Without a connected account, the panel replaces the form with a notice and the
button that starts the same device authorization as the sidebar. The feedback
button stays visible: hiding the channel also hides the path to using it.

The endpoint stops answering CORS and preflight. The desktop arrives without
`Origin` and the Cloud page is same-origin; requiring `application/json` without
enabling CORS prevents a third-party page from posting with the cookie of
whoever is logged in.

The rest of ADR 0033 stays in force: the private repository check, the native
attachment upload, the issue with the embedded image, the `{ id }` receipt
without an internal URL, idempotency by ID and no copy of the content in the
Cloud.

## Consequences

Whoever has no account cannot submit feedback. The site's anonymous widget loses
the channel: the bundle still exists for authenticated Cloud pages, and the
landing page needs another route if it wants to hear from visitors.

The team now knows which account each report came from, through the request's
session. That does not enter the table: the receipt still has no content, no
image and no identification of a person. The association exists only during the
request.

Resending depends on the form preserved in the client, as before. The per-account
limit uses the in-memory cache of one Puma process; multiple replicas require a
shared cache, like the Cloud's other limits.

## Evidence

`FeedbackTest` in the Cloud covers 401 without a session, the desktop's Bearer,
the browser's cookie, the per-account limit, the private repository check, the
upload, the issue with the marker, idempotency, conflict, uncertain delivery,
the absence of content in the table and the refusal of a foreign origin.
[`e2e/feedback.spec.ts`](../../e2e/feedback.spec.ts) covers the notice without
an account, connecting from the panel, the draft preserved on error and
resending the same report.

References: [contract](../contracts/feedback.md),
[optional account](../contracts/cloud-account.md).
