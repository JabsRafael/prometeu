# ADR 0032 — Private feedback in the Cloud repository

Date: 2026-09-10
Status: superseded by
[ADR 0033](0033-github-feedback-attachments.md). Supersedes
[ADR 0031](0031-public-feedback.md).

## Context

Reports and captures may contain personal data or code. The maintainer chose to
receive the issues in the private repository `prometeucorp/prometeu-cloud`.
Changing only the issue's destination would leave the images public in the
Cloud.

## Decision

Create issues only in `prometeucorp/prometeu-cloud`, after checking through the
GitHub API that the repository keeps `private: true` and the expected name. A
query failure or a public repository prevents the POST with the feedback's
content. The PAT stays on the server, with Issues: write and access to the
repository's metadata.

Submission still requires no login, but returns only the `{ id }` receipt,
without an internal URL. The form states that the handling is private and does
not offer a link the sender cannot open. There is no automatic publication in
the releases repository.

Images stay in SQLite. The issue contains an ordinary link to the Cloud, without
an embedded image, a signed URL or a credential. The route requires a browser
session and a user ID explicitly authorized in `FEEDBACK_REVIEWER_IDS`. An
ordinary account, even the owner of its own organization, cannot query
attachments. An empty list denies access. Responses must not be cached.

## Consequences

Whoever submits needs no GitHub or Prometeu account. Reviewers need access to
the private repository and, to open images, a Cloud login and an authorized ID.
The list of IDs is explicit operational configuration; there is no implicit
support role and no new per-organization permission system.

The upload exception in the Cloud stays limited to the image chosen by the
person. That content is private through access control, not E2EE: the Cloud
processes the image and the text, and GitHub processes the issue. Captures must
be reviewed before sending.

The table does not change. The old public route now requires authorization,
including for old images. A previous public publication cannot be undone by this
change: operators must remove old issues and caches separately. A rollback must
not restore a version that serves attachments publicly.

## Evidence

`FeedbackTest` in the Cloud covers the privacy query, submission to the correct
repository, a receipt without a URL, an ordinary user blocked, an authorized
reviewer, revocation, caching disabled and recoverable failures.
`e2e/feedback.spec.ts` covers the private notice and a confirmation without a
link in Chromium and WebKit.

Contract: [feedback](../contracts/feedback.md).
