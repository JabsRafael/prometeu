# ADR 0007 — Persistent comments alongside the session

Date: 2026-09-04
Status: Accepted

## Context

Collaboration notes were inserted into the transcript at the instant they
arrived. With the session in progress, they scrolled out of the visible area and
lost their role of following a decision through to its conclusion. To create a
note, the person also had to switch the main box from agent mode to note mode.
That switch hid the destination of the next message at the most sensitive moment
of the interaction.

The need is not to add another message to the chat. It is to keep a human
conversation about a piece of the work, make open items findable and state when
they no longer require attention.

## Options considered

1. Keep notes in the transcript and improve their visual markers.
2. Represent comments as ordinary messages sent to the agent.
3. Keep persistent threads in a side panel, anchored to the conversation and
   with an explicit state.

## Decision

Comments live in their own side panel. The main box always sends messages to the
agent.

Each thread has a root, zero or more replies and an open or resolved state. It
can be general to the tab or store `tab` and `Piece.key` as the anchor of an
excerpt. The quote is readable context, not identity. Markers in the transcript
open the thread and the thread can lead back to the excerpt.

Mentions create assignments in **For me**. Opening an assignment does not mean
finishing work; only resolving the root removes the thread from everyone's
inbox. Any collaborator who still has access to the workspace can resolve it.

The v3 relay protocol receives optional fields and the additive `note_reply` and
`note_resolve` frames. The `welcome` announces `comments: 1`; without that
capability, the app keeps simple comments and hides replies and resolution. In
that fallback, opening still completes an inbox entry. There is no destructive
migration: previous notes become open general roots.

## Consequences

Positive:

- open items stay visible as the session grows;
- writing to the team does not silently change the destination of the agent's
  box;
- replies preserve the context and resolution closes the item for everyone;
- previous v3 data and clients stay readable.

Negative:

- the relay now persists thread state and replies;
- an anchor may become unavailable after retention or a transcript change; the
  quote stays visible in that case;
- old clients may show replies as independent notes;
- resolution has no additional roles: access to the workspace is the authority.

## Evidence

- `src/notes.test.ts` covers grouping, tab, legacy data and ordering by
  activity;
- `src/team.test.ts` covers capability, creation, reply, resolution and inbox;
- `relay/src/protocol.test.ts` and `relay/src/logic.test.ts` cover validation,
  persistence, audience, assignment and compatibility;
- `e2e/critical-flows.spec.ts` covers contextual creation, reply, resolution and
  the main box staying on the agent.
