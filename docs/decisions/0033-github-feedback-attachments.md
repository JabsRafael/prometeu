# ADR 0033 — Feedback text and images in GitHub

Date: 2026-09-10
Status: superseded by [ADR 0035](0035-feedback-requires-account.md), which
started requiring an account on submission. Supersedes
[ADR 0032](0032-private-feedback.md).

## Context

The maintainer wants to read the text and the capture in the same private issue.
Storing attachments in the Cloud required another login, a reviewer list and
image retention. GitHub offers a native image upload associated with the
repository, used by GitHub CLI 2.99.0, with access controlled by the
repository's permissions.

## Decision

The Cloud stays as the intermediary to keep the PAT out of anonymous clients.
After confirming the privacy and identity of `prometeucorp/prometeu-cloud`, it
sends the bytes to the native `uploads.github.com/user-attachments/assets`
endpoint, with the repository's numeric ID. It only creates the issue after
receiving a valid URL, embedded in the body as a Markdown image. It uses
`Net::HTTP`, already present in the integration; it installs no CLI and no other
dependency.

Text and image are not persisted in the Cloud. The table keeps only receipts:
ID, the content's SHA-256, GitHub URLs, the attempt's timestamp and timestamps.
That preserves idempotency and prevents automatically repeating an uncertain
creation. The image route, the login redirect and `FEEDBACK_REVIEWER_IDS` are
removed. The anonymous `POST /api/feedback` contract, the limits and the
`{ id }` receipt remain.

## Consequences

Reviewers need only access to the private repository. Content removal happens on
GitHub, without copies of images or descriptions in the Cloud's backups. The
Cloud still processes content during the request; that flow is not E2EE.

An upload failure prevents creating an issue without the chosen attachment. A
retry reuses the already-saved URL; an interruption before saving the URL may
leave an attachment without an issue. An uncertain creation result requires
reconciliation through the `Feedback: <id>` marker. Since there is no copy on
the server, resending depends on the form preserved in the client.

The upload endpoint follows GitHub CLI's official implementation; changes in
that service require updating the adapter. The chosen PAT needs validation in
the activation smoke test; local tests replace the transport and do not publish
content.

The previous migration had not been published yet and was adjusted to create
receipts. There are no production reports to migrate. Local prototype databases
are preserved; tests use a new, disposable database. A rollback must not restore
content storage or a public attachment route.

## Evidence

`FeedbackTest` in the Cloud covers the private upload, the embedded image, a
receipt without content, the removed route, limits, idempotency, upload and
creation rejection, retry and an ambiguous failure. Clients keep the contract
covered by `e2e/feedback.spec.ts`.

References: [contract](../contracts/feedback.md),
[official upload](https://github.com/cli/cli/blob/v2.99.0/internal/attachments/client.go),
[attachment privacy](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/attaching-files).
