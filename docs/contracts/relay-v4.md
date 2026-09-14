# Relay protocol v4

Status: current contract; decision in
[ADR 0022](../decisions/0022-end-to-end-encryption.md).
Executable source: `relay/src/protocol.ts`, imported by the app and the Worker.
[v3](relay-v3.md) stays documented as history.

## Boundary and authentication

The webview encrypts and decrypts; Rust persists the identity privately and runs
only authorized actions. The relay forwards ciphertext and keeps audience,
quotas, presence, comments and inbox. The agent stays on the owner's Mac.

`pm2` enrollment, individual credentials and Cloud tickets keep their formats.
The WebSocket requires `p=4`. `welcome` announces `e2ee: 1`, `comments: 1` and a
random per-socket challenge. Before any other send, the client answers
`identity { key, proof }`. The proof is ECDSA P-256/SHA-256 over the UTF-8 JSON
`["prometeu-identity-v4", member, challenge]`, using the private identity.
The Worker verifies possession before publishing `Member.key` or allowing
traffic. Presence with the confirmed key ends the handshake. The Worker does not
send other updates to a socket that has not identified itself yet.

The client records each member/key link before use. A changed key replaces the
link automatically, with no local acceptance ([ADR 0042](../decisions/0042-automatic-key-rotation.md)). Missing keys receive no
content and do not erase links. Renewing tickets does not reset TOFU.
See [organizations](cloud-organizations.md) for leases and Cloud authorization.

After the identity, organization sockets receive `lease { expires_in }` (1 to
60,000 ms). `renew { ticket }` consumes another 256-bit Cloud ticket, encoded in
43 base64url characters, and requires the original organization and member. The
relay refuses renewal before the identity, after expiration or with an invalid,
consumed or foreign-membership ticket. A renewal preserves the key, challenge,
watchers and streaming; an identical roster generates no presence. The
confirmation is another `lease`. These are additive controls in v4: old clients
ignore the capability, and new clients keep reconnecting when an old relay does
not announce it.

## Envelope and content

`Encrypted = { id, boxes: { [member]: { enc, ct } } }`. IDs are random; `enc` and
`ct` use canonical base64url without padding. Each box uses HPKE Auth,
DHKEM(P-256, HKDF-SHA256), HKDF-SHA256, AES-256-GCM. The `info` binds the JSON
`["prometeu-e2ee-v4", scope, author, recipient, id]`. `scope` is the JSON of
`["organization", cloudOrigin, organizationId]` or
`["team", relayOrigin, teamId]`. The author's key comes from the local link,
never from a free field of the envelope.

The plaintext contains `{ frame: Up }` or `{ binary: base64url }`. `share`
includes `revision`, monotonic and persisted by the owner. `write` includes
`expires`, at most two minutes ahead. The client validates the payload again
after opening the box and checks the workspace, tab, author, recipient and
audience.

In the outer frame:

- `share`: titles, repository, branch and stage empty; issue null; tab text and
  tokens null/empty and a constant status. IDs, the active tab, dimensions and
  the explicit audience stay visible. `audience: null` is expanded to members
  with an available key before encrypting.
- `note`/`note_reply`: empty text; quotes and anchors null. The persisted ID is
  the envelope's ID, unique within the team. Mentions and parentage stay
  visible.
- `note_resolve`: the envelope authenticates the workspace and the root. Storage
  keeps the original ciphertext and adds `resolution: { author, encrypted }`.
- `write`: empty data, envelope for the owner only.
- Binary: the envelope travels through an outer unicast `SNAPSHOT` frame, with
  sequence zero and `more=false`. The box contains the complete original binary
  frame, including kind, sequence and destination. The recipient accepts only
  its own attached tab.

`room.ts` refuses cleartext content fields, invalid envelopes and legacy binary.
Domain parsers still accept cleartext payloads for internal validation after
decryption; that does not authorize the Worker to receive them on the socket.
`downForMember` sends only that member's box, including in the `welcome`,
`notes` and `inbox` aggregates. There are no private keys in the relay.

## Authority and replay

The owner uses their board to authorize the snapshot, the live stream and a
received message. An announcement echoed by the relay does not change the local
audience. For remote shares, the client persists the owner, key, revision and ID
of the last accepted announcement; it rejects an owner change and old revisions,
while allowing the same announcement to be repeated on reconnection. After a
manual acceptance of a new key, that owner's sequence may restart.

Remote messages persist an ID and a deadline before executing. A repetition,
expiration, write failure and a clock earlier than the last consumption block
the action. The receipts survive reconnection and restart. Local card validation
is still mandatory. Conversation sequences handle snapshot/live duplicates; the
relay may still omit content or present an incomplete history.

An authenticated message from a companion whose `person` is the conversation's
owner reaches the agent with the original text, as a message from the person
themselves. Peers and legacy teams keep the team's authorship prefix. That
distinction uses the authorized roster, never the name or a field sent freely in
the message.

Peers' comments use the last authenticated audience they received. If the relay
omits an update, revocation may be delayed for those senders. Content already
received and previously authorized snapshots are not revocable.

## Companion devices

`Member.person` is optional and links a companion device to the person's
membership; primary members and legacy teams do not have it. The Cloud delivers
the field in the roster and the relay validates it (an ID present in the same
roster, without chains), persists it under `member:` and re-emits it in
`welcome` and `presence`. Old parsers ignore the field.

Audiences, the local `share.audience` and mentions name people. Before
encrypting, the client expands each person into their devices that have a key:
the boxes, the audience published in the relay and the frame's `mentions` come
to list devices, so the relay applies `watch`, `attach`, `write` and inbox per
device without knowing the rule. The owner accepts `watch` and `write` from a
device through the person it belongs to. Key links and receipts stay per device. Decision and limits in
[ADR 0027](../decisions/0027-companion-devices.md).

The owner's companion devices enter the recipient list only when the local
`Workspace.remote_control` is active. That permission does not cross the
protocol: the outer frame already contains an explicit per-device audience. An
empty local audience allows a share aimed only at the owner's devices. See
[ADR 0030](../decisions/0030-remote-control.md).

## Persistence, limits and compatibility

Credentials and enrollment metadata preserve their storage keys. v4
collaboration state uses the `v4:` prefix; only that prefix is hydrated. v3 data
stays preserved and invisible to the new client. Local shares already consented
to are announced encrypted on reconnection. Old comments are not converted or
redistributed automatically.

The limits live in the protocol: up to 64 members, a 2 MiB input JSON, 1 MiB
binary, 16 MiB output aggregates and 16 MiB per 10-second window. Each box has a
1 MiB limit of ciphertext. The app's cryptographic queue is limited to 16 MiB.
Snapshots use 128 Ki-character parts, with binary limits checked after
expansion. The comment TTL is still 90 days, with the existing thread retention
and count quotas. Persisted ciphertext is limited to 1536 KiB per
share/comment (including resolution), 4 MiB across the set of shares and 8 MiB
across the set of comments per team. The inbox stores only the recipient's own
box. These limits contain per-recipient expansion and leave room for metadata
below the row limit of the
[Durable Object SQLite storage](https://developers.cloudflare.com/durable-objects/platform/limits/).

V3 and v4 do not negotiate a downgrade. Publishing a compatible Worker precedes
distributing the desktop. A v3 rollback keeps v4 data, but restores cleartext
content in v3 collaboration; see the limits and the operation in ADR 0022.

## Evidence

`team-crypto.test.ts`, `team-security.test.ts` and `team-channel.test.ts` check
the client's boundary with real cryptography. `protocol.test.ts` and
`logic.test.ts` check the relay's contracts and rules. The real local Worker is
exercised in `relay/src/worker.integration.test.ts`, and the web mock uses the
same encrypted channel for the E2E flows. There has been no independent security
audit. `team-organizations.test.ts` covers renewal on the same socket, discarding
after an organization switch and companion authorship; the real Worker covers
expiration and the rejection of invalid renewal tickets.

## Bounded HTTP bodies

`/init` and `/enroll` use `relay/src/http.ts::smallJson` with a 1,024-byte body
limit. The helper counts bytes as the body arrives and cancels the reader as
soon as the limit is exceeded, even without `Content-Length` or when that header
understates the body. An oversized declared length is rejected before reading.
Incremental UTF-8 decoding preserves characters split across chunks. Invalid
JSON returns 400; oversized input returns 413. Endpoint schemas, authentication,
and the v4 WebSocket encryption requirements remain unchanged.

`http.test.ts` covers cancellation, inaccurate headers, malformed JSON, and
UTF-8 chunk boundaries; the Worker integration test covers streamed enrollment.
