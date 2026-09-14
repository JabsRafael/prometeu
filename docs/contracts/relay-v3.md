# Relay protocol v3

Status: historical; superseded by [relay v4](relay-v4.md).
This document describes the previous behavior, without E2EE.

The current executable source, already at v4, is `relay/src/protocol.ts`. This
document explains ownership and compatibility; it does not duplicate every union
or limit.

## Topology

The frontend talks directly to the relay. The Rust backend keeps the local
configuration and runs authorized actions, but does not hold the team's
WebSocket.

Each team is routed to a Durable Object. The relay knows members, presence,
shared workspaces, audience, viewers, comments and inbox.

## Authentication

The `pm2`/v3 protocol invitation contains the team id and the enrollment secret.
On joining, the relay issues an identity and an individual credential.
WebSockets use the individual credential, never the invitation's collective
secret.

A credential proves identity; it does not make the content trusted for
execution. Every input is still subject to the parser, limits, audience and
validation on the owner's side.

Cloud organizations use a separate handshake at `/organization/:id`, with a
single-use ticket, an identity and a roster verified by the Cloud and a
60-second lease. The storage namespace is distinct; team codes do not grant
institutional access. The v3 frames and audience rules stay the same.
See [organizations](cloud-organizations.md) for revocation and migration.

## Formats

- control uses JSON text frames with the `t` discriminant;
- terminal and live conversation use segmented binary frames;
- `Up` describes app → relay;
- `Down` describes relay → app;
- parsers receive `unknown` and only return types after validating;
- limits for ids, texts, collections, frames and rate live next to the protocol.

Adding a variant requires a parser, pure logic, a protocol test and a test of
the routing effect. The client must refuse an incompatible version in the
handshake.

## Persistent comments

Comments reuse the historical `note` frame family to keep compatibility inside
the v3 protocol:

- `note` creates a root with `ws`, `text`, `mentions`, `quote` and, when there is
  context, `tab` and `anchor`;
- `note_reply` adds a reply to an open root;
- `note_resolve` marks the root as resolved and removes its assignments from the
  inbox;
- `notes` returns the workspace's snapshot;
- `note` in the relay → app direction works as an upsert. A resolution repeats
  the root's id with `resolved: true`.

The persisted record has `parent: null` in the root and `parent: <root id>` in
the replies. Threads are flat in the protocol. Replies inherit the root's
workspace and tab. Old data without `tab`, `anchor`, `parent` or `resolved` is
normalized as a general comment, a root and open.

`tab` identifies the conversation. `anchor` identifies a stable `Piece.key` in
that tab's transcript and has a 128-character limit. `quote` is presentation
context and a fallback; it grants no authority and does not take part in the
agent's execution.

A mention creates an inbox entry pointing to the root. Replies can assign the
thread to the root's author and to newly mentioned people. In a relay with
`comments: 1`, opening only navigates to the thread; the entry stays until any
collaborator with access resolves the root. The old `inbox_read` frame is still
accepted and the client uses it as a fallback when the capability does not
exist, since that relay offers no resolution.

The inbox entry stores `id`, `ws`, `author` and `ts`; `tab` leads to the correct
conversation and `text` allows showing the preview before loading the thread.
Both new fields are optional for the storage and for previous clients.

The `welcome` announces `comments: 1`. Without that capability, a current client
still sends simple roots to an old v3 relay, but does not offer replies or
resolution and keeps reading as the inbox's completion. A root's extra fields
are optional, so old clients keep reading the comment as a simple note. An old
client may show a new reply as a separate item; that is visual degradation, not
data loss and not an increase in authority.

## Snapshot and live stream

The owner gets `{ text, seq }` from the backend under the numbering lock. The
snapshot is segmented into whole lines to respect the frame limit. The viewer
discards live segments whose sequence is already contained in the snapshot and
splices the rest.

The sequence belongs to the current transport and may restart when the process
or the app restarts. It is not a global message id.

## Authority

- the relay decides who can see a share based on `audience`;
- the owner is the authority over the process and the worktree;
- a remote message is forwarded to the local `chat_send`;
- remote control is sanitized in `chat_control_remote` against a request
  actually open in the buffer;
- a peer does not supply an arbitrary command or input for execution;
- an offline owner means the remote session is frozen.

## Persistence and privacy

The relay persists what is needed for offline members: registry, shares,
comments and inbox, subject to limits and TTL. Retention removes a thread as a
unit so replies are not left orphaned. Live conversation content is forwarded;
the session stays local.

The protocol offers no end-to-end encryption. The relay's operator can read
metadata and the text content that passes through the service. Changing that
property requires a security ADR and an incompatible protocol change.

## Evidence

- `relay/src/protocol.test.ts`: parsing, limits, invitations and binary frames;
- `relay/src/logic.test.ts`: audience, presence, quotas, comments and routing;
- `relay/src/worker.integration.test.ts`: a real local Worker/Durable Object;
- `src/team-transport.test.ts`: the client's lifecycle and transport;
- `src/team-control.test.ts`: remote control transformation.
