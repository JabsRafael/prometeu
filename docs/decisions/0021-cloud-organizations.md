# ADR 0021 — Organizations and invitations in the Cloud

Date: 2026-09-07
Status: Accepted; protocol and content boundary extended by
[ADR 0022](0022-end-to-end-encryption.md).
The requirement of a personal copy before installing was superseded by
[ADR 0039](0039-organization-catalog-on-desktop.md).
The mandatory reconnection when each lease expires was superseded by the renewal
in [ADR 0034](0034-mobile-pairing-continuity.md).
Extends [ADR 0015](0015-cloud-rails.md) and supersedes the exclusively personal
ownership limitation of [ADR 0020](0020-personal-catalog-and-local-items.md).

## Context

Team creation and enrollment existed on the desktop, through a shared secret.
The Cloud had only a static organization preview. The product needs to manage
organizations in the browser, require invitation acceptance by email and share
both live workspaces and tool catalogs.

## Decision

The organization in Rails becomes the authority over identity, memberships,
roles and catalogs. We do not introduce a second team layer. We use existing
Active Record, SQLite constraints, signed tokens and Action Mailer. Catalogs
reuse the revisioned document and the portability validation; sharing between
catalogs is an explicit, independent copy.

We preserve the relay and the conversation protocol. Single-use individual
tickets authenticate 60-second leases, with a Cloud query in the handshake. That
avoids new service secrets, custom JWT signing and a revocation webhook, at the
cost of renewing connections and snapshots periodically. Traffic stops after the
deadline even when the Durable Object's alarm is late.

Consent to send a workspace includes the organization and the membership.
Switching context does not send old work to another group. Legacy teams keep
their namespace and credentials during the transition; selecting an organization
keeps a local backup. Anonymous identities are not converted into inferred
emails.

## Consequences

The desktop stays useful without an account. Institutional collaboration
requires the Cloud to be available to renew authorization. Revocation has a
60-second limit. Organizations support the same 64 members as the relay.
Personal catalogs stay synchronized as before; copying from the organization is
an explicit adoption, without automatically subscribing to the next edits.
Received code is never activated just by accepting an invitation.

A rollback keeps the expanded schema and the legacy storage. Publication follows
Cloud, relay, desktop; there is no implicit destructive contraction. Contracts,
configuration, limits and evidence are in
[cloud-organizations.md](../contracts/cloud-organizations.md).
