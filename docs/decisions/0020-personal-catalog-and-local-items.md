# ADR 0020 — Catalog in the SaaS and explicit sharing on the desktop

Date: 2026-09-07
Status: Partially superseded by [ADR 0021](0021-cloud-organizations.md)
(institutional ownership)
Supersedes: [ADR 0019](0019-cloud-catalog.md)

## Context

The previous catalog had persistence in the SaaS, but authoring stayed
exclusively on the desktop. Connecting an account published the local hubs;
portable MCPs and plugins could not stay private by choice.

The need is to register MCPs, plugins and skills in the browser, receive them on
the desktops and combine that set with optional local definitions. Catalogs for
teams, projects and organizations are a future evolution.

## Options considered

1. Just add forms to the previous document. It offers no local privacy.
2. Immediately create organizations, teams, permissions and offline
   synchronization with merge.
3. Keep the account as the catalog's owner, add web authoring and explicit links
   between remote definitions and local records.

## Decision

Adopt option 3. Desktop creations are private by default. Sharing is an explicit
action; editing a linked definition publishes it to the account. A local copy
gets another ID and does not change the shared item.

The SaaS uses conventional Rails, Design System forms, cookies and CSRF. The
desktop keeps the Bearer. The existing revisioned document is still the storage
unit; web operations change only the chosen item, preserving the other
collections. Conflicts are visible and keep drafts. No stale edit is
automatically resent over a new revision.

Skills are text definitions, materialized as packages to reuse the existing
plugin adapters and selectors. Plugin code still comes from a remote source
through an explicit installation; there is no directory upload.

Receiving definitions does not enable tools in conversations. Remote deletion
does not delete files or credentials from the Macs. Private names are preserved
through a link map that separates the account's ID from the ID in the local hub.

## Consequences

- Management in the browser and local choice work without a new service,
  dependency or database migration.
- The whole JSON and its 256 KB limit remain. Concurrent edits on different
  items may also require an explicit retry.
- Old clients preserve new skills by omitting the collection; their old
  automatic publication behavior only changes when the desktop is updated.
- A plugin copy shares the clone's files, but not its online definition. Copied
  skills have independently materialized content.
- Legacy Actions stay synchronized as before and get no web editor at this
  stage.
- Future permissions and institutional catalogs require an identity composed of
  the owner, the catalog and the item. This stage does not simulate those
  scopes.
- A rollback restores the previous code while keeping the JSON and local files.
  An old desktop ignores skills; do not use a rollback as a way to remove new
  data.

## Evidence

The [catalog contract](../contracts/cloud-catalog.md) describes formats,
compatibility, observable behavior and tests in both repositories.
