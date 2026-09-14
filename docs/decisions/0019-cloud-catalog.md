# ADR 0019 — Portable catalog in the Prometeu account

Date: 2026-09-06
Status: Superseded by [ADR 0020](0020-personal-catalog-and-local-items.md)

## Context

With the optional account published, the maintainer now uses Prometeu on two
Macs. Plugins, MCP servers and Actions were registered per machine, in
`plugins.json`, `mcp.json` and `board.actions`. Repeating the registration by
hand diverges over time, and nothing said which Mac had the right version.

At the same time, the account stays optional: the desktop must work without a
network and without registration. And the SaaS receives no provider secrets.

## Options considered

1. Bidirectional synchronization with merge: each Mac edits offline and
   reconciles later. It requires conflict resolution and a UI to explain it.
2. Exporting and importing a file by hand. It does not diverge any less; it only
   changes who does the copying.
3. The SaaS is the catalog's repository; the desktop is a cache and
   materializer. Editing goes to the cloud first; installation and secrets stay
   per Mac.

## Decision

Adopt option 3. The SaaS stores one document per account with what is
declaration: plugins with an address (`from` or a `.zip` URL), the shape of each
MCP server without the `env` and `headers` values, and the whole Actions
catalog. The desktop stores the document in `<root>/catalog.json` with the
revision read last.

Every write of a plugin with an address, an MCP server or Actions goes to the
cloud first through `PUT /api/catalog` with the known revision. The cloud
answers 409 with the current document when another Mac wrote first; the desktop
applies that document, redoes the edit on top and tries once more. Without a
response from the cloud, the edit fails with a visible error and the local hub
does not change. Without an account, none of this happens and the hubs stay
local.

`cloud_status` with `refresh` and the completion of a login pull the document.
An empty cloud receives this Mac's catalog. A cloud with a catalog wins: what
this Mac had goes once into `<root>/catalog.local.json`. A `.zip` plugin by URL
enters the local hub by itself; a repository appears as "not installed" until
the person asks to clone it. An MCP server enters with empty keys and values;
values already filled in on this Mac survive updates of the shape. A plugin
pointing at a local folder never goes to the cloud and is marked "only on this
Mac".

Signing out deletes the cache and keeps what is installed. Deleting the account
in the SaaS deletes the document along with it.

## Consequences

Positive:

- one registry applies to all of the person's Macs, without merge and without a
  conflict UI;
- secrets, clones, `codex-workspaces/` and the per-workspace selection stay per
  machine, as before;
- the account stays optional: without it, no line of network code runs.

Negative:

- with an account and no network, registering a plugin with an address, an MCP
  or an Action fails until the network is back; reading and sessions keep
  working;
- Actions `overrides` are keyed by the project id, which belongs to this board;
  on another Mac they have no effect until a stable project id exists;
- the document is written as a whole, with a 256 KB limit;
- an edit made on Mac B between Mac A's read and write costs one extra attempt,
  never a silent loss.

## Evidence

- `src-tauri/src/catalog.rs`: the secret-free shape, merging of local values and
  the portability rule in unit tests;
- `prometeu-cloud/test/integration/catalog_test.rb`: per-account isolation,
  revision, 409 with the current document, limits and cascading deletion;
- [`contracts/cloud-catalog.md`](../contracts/cloud-catalog.md).
