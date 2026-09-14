# ADR 0015 — SaaS in Rails with the desktop contract preserved

Date: 2026-09-06
Status: Accepted
Supersedes the technical choice of [ADR 0014](0014-optional-cloud-account.md).

## Context

The maintainer explicitly asked for Rails, a stack they know and already use in
other projects. The Node/Better Auth prototype was prepared on the VPS but not
published, with no users and no production database. The desktop client already
has a small browser-based connection contract.

## Decision

The separate `prometeu-cloud` project uses Rails 8.1, Ruby 4.0, SQLite and ERB.
Authentication starts from Rails' native generator: `has_secure_password`,
persisted sessions, signed cookies, CSRF protection and Action Mailer. The site
needs no SPA, no Node on the server, no Redis and no job process.

Preserve the four routes used by the desktop: issuing and exchanging the code,
querying the session and logging out. `DeviceGrant` stores only the hash of the
private code, expires in 10 minutes and requires confirmation by the
authenticated person. Issuing the Bearer and consuming the code happen in the
same transaction. The database stores only the Bearer's hash. Sessions expire
after a fixed 30 days; the previous prototype's renewal on activity is not kept.

Registration, editing and deletion use conventional Rails controllers and forms.
The Better Auth site's internal endpoints are not kept, since there are no
published consumers. The IPC, `cloud.json`, relay, board and transcript formats
do not change. Previous test tokens require reconnecting.

## Consequences and rollback

The maintainer can evolve the SaaS with their usual tools. The small device flow
becomes project code, covered by contract and concurrency tests. Encryption and
passwords use Rails/Ruby/bcrypt primitives.

SQLite and in-memory rate limiting assume a single Puma process. Horizontal
scale requires a shared database and shared limits. SMTP delivery is synchronous
with a timeout; a durable queue will be needed only when volume/retries justify
it. SMTP and an HTTPS origin are production requirements.

There is no production data to convert. The Node source is preserved in
`prometeu-cloud-node-backup-20260906`, locally and on the VPS; the previous
image stays available. Rails uses another database file. No destructive
migration of the previous database is run. Future migrations require a
consistent backup and a coordinated rollback of the image, database and
`SECRET_KEY_BASE`.

This decision does not implement transcript synchronization, a native mobile
app, remote commands or changes to the relay's trust boundary.

## Evidence

Operational note from 2026-09-06: after the migration, the maintainer asked for
the Node prototype to be removed. The local source was moved to the Mac's Trash;
the copy on the VPS and the old image were deleted. The Node rollback described
above records the decision's initial state and is no longer prepared on the VPS.

See the [account contract](../contracts/cloud-account.md), `cloud.rs`,
`e2e/cloud.spec.ts` and the `prometeu-cloud` project's Rails integration,
concurrency and browser suites.
