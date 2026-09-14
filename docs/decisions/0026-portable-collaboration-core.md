# ADR 0026 — portable collaboration core and phone access through the relay

Date: 2026-09-08
Status: Accepted for the portable core, implemented in this change. The
per-device identity stage was decided in
[ADR 0027](0027-companion-devices.md) as an additive field in v4, without a v5
protocol. The web app served by the Cloud was decided and implemented in
[ADR 0028](0028-mobile-web-app.md).
Extends [ADR 0021](0021-cloud-organizations.md) and
[ADR 0022](0022-end-to-end-encryption.md); it does not change
[relay v4](../contracts/relay-v4.md).

## Context

The product wants to follow and nudge a conversation from the phone. The session
still runs only on the owner's Mac; the relay already forwards ciphertext to any
authorized member, and the encryption uses WebCrypto. In theory, a browser on
the phone is just another relay member.

In practice, `src/team.ts` concentrated three distinct roles in one file: the
desktop's configuration (team.json, Cloud organizations, Tauri IPC), the owner
role (announcing workspaces, streaming the conversation, executing remote input
in the local agent) and the member role (identity, presence, watching,
commenting, inbox). A mobile client built on top of that file would be born with
per-platform conditionals spread across the flow.

There is also a limit in the identity model: the relay stores one key per member
and the owner does not encrypt boxes for themselves. A phone with the same
membership would replace the Mac's key and would not receive content.

## Options considered

1. Screen sharing from the Mac (VNC/Tailscale): zero code, no product.
2. Serving the desktop interface from the Mac through Tailscale, with IPC over
   WebSocket: a complete interface, but it requires a private network and an
   awake Mac, with no persisted comments and no peers.
3. A PWA served by `prometeu-cloud` connecting to the relay as an ordinary
   member, on top of a collaboration core with no Tauri dependency.

## Decision

Adopt option 3 in stages. This change delivers the first one: the core.

**Split by role and by feature, not by platform.** `src/team-member.ts` owns the
reconnectable connection, the identity handshake, the encrypted queue and the
member directory. Each capability is a module with hooks registered on the
member (`connecting`, `outgoing`, `frame`, `binary`, `closed`, `reset`), defined
in `src/team-ports.ts`:

- `team-owner.ts`: announcements, snapshots, live stream and remote input. Only
  the machine that runs agents installs it.
- `team-viewer.ts`: remote shares, attach, mirroring and `write`.
- `team-comments.ts`: threads, mentions and inbox.

The member calls the hooks in registration order; the composition root chooses
the features and that order. A new feature is a new file and one line in each
root that wants it. Frames that no feature handles are ignored. The outgoing
gate (`outgoing`) lets the owner block content during an audience switch without
the member knowing about the audience.

**Ports instead of conditionals.** The shell hands the member a `Membership`
(scopes, `shareScope`, `legacy` and a `url()` function that obtains a ticket or
credential) and a `SecurityStore`. The owner receives an `OwnerHost` with the
local actions. `src/team.ts` becomes the desktop's shell: it resolves team.json
and organizations, injects Tauri's ports, registers the three features and
exposes the facade used by the interface, including the translation between
board IDs and relay IDs. No `team-*.ts` imports `@tauri-apps`, `./ipc`, `./mock`
or `./team`; `npm run architecture:check` fails if that changes.

**No package yet.** The core stays in `src/team-*.ts`. When the second real
consumer exists (the PWA), the files move to `packages/team-core` through
`git mv`, in the pattern of `packages/design-system`. Creating the package
before that would only add a build step.

## Proposed stages

1. **Per-device identity** (new ADR, v5 contract). The relay's member becomes a
   device; the Cloud's roster returns `{ id, name, person }` and issues
   per-device tickets. The audience chooses people; the owner expands a person
   into device keys at the same point where it expands `audience: null` today.
   TOFU stays per device.
2. **PWA in `prometeu-cloud`.** A composition root with `member` + `viewer` +
   `comments`, a `SecurityStore` over IndexedDB with a non-extractable
   `CryptoKey` and a `url()` over the cookie session. Rails gains a per-session
   ticket endpoint, with the same response as the Bearer one. No owner feature.

## Consequences

- The desktop's behavior does not change; the existing tests pass through the
  facade unchanged. Two deliberate differences: a failure to load
  `team-security.json` does not enter a retry (retry was Cloud-only), and when
  disconnecting by choice the announcement state is cleared as in a network
  drop.
- The phone will only see explicitly shared workspaces, with the Mac awake, the
  app open and the Cloud and relay available. It does not create conversations
  and does not run Git.
- Comments and inbox come for free to any shell that registers
  `team-comments.ts`.
- The registration order is a contract: the owner before comments keeps `share`
  before `notes` after the welcome.

## Evidence

- `src/team-member.test.ts`: composition without Tauri with member, viewer and
  comments over the simulated relay, watching a share and answering a mention.
- `src/team.test.ts` and `src/team-organizations.test.ts`: the desktop's
  behavior preserved through the facade.
- `scripts/check-architecture.mjs`: the core boundary's fitness function.
