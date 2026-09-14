# ADR 0031 — Public feedback through the Cloud and GitHub Issues

Status: superseded by [ADR 0032](0032-private-feedback.md).

## Context

The [widget suggestion](https://github.com/prometeucorp/prometeu-releases/issues/2)
asks for feedback in the app and on the site, with text, an image and a capture.
The person must not have to configure a management tool or provide GitHub
credentials. The releases repository already receives public suggestions.

## Decision

Use a portable widget with Design System controls, a public endpoint in the
Cloud and issue creation in the releases repository. The integration credential
stays on the server. Do not introduce Linear to receive these reports.

Only the typed text and the chosen image are sent, along with the kind, the
source and the version. The public nature of the content is explicit before
sending. Captures require an action by the person and a review of the thumbnail;
they are not automatic telemetry. This is an explicit exception to the absence of
uploads in the Cloud, limited to feedback, and it does not change the E2EE
collaboration channels.

The Cloud persists the report before calling GitHub. A submission ID avoids
repetition after a lost response. An ambiguous result is preserved for
operational reconciliation, without repeating a POST that may have been
accepted. Images use the same SQLite persistence, with a public route limited to
the chosen file.

## Consequences

There is no new dependency or account required from whoever submits. The server
needs a credential with Issues: write and starts storing explicitly public
images. Configuration and operational publication are required to enable
delivery.

Rate limiting and the mutex are local and follow the current single Puma
process. Before scaling horizontally, both will need to be shared. The flow does
not include a support portal, its own notifications or automatic triage by
models.

Contract, retention, failures and tests: [feedback](../contracts/feedback.md).
