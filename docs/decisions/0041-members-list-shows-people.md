# ADR 0041 — The members list shows people, not devices

Date: 2026-09-10
Status: Accepted

Supersedes [ADR 0027](0027-companion-devices.md) regarding how the members list
is presented in the Settings. The `person` field and the rest of 0027 remain in
effect.

## Context

The Organization tab listed one chip per roster member and a "Security code"
button next to each one. Since companions are members, the same person showed
up three or four times — "(iPhone)", "(MacBook Air)", "(you)" — and the
interleaved buttons broke the list's alignment. Whoever reads the screen wants
to know who is in the organization and who is available now, not the inventory
of each person's devices.

The per-device security code assumes a comparison through another channel
before the first contact. In practice nobody compares: ADR 0022 already adopts
trust on first use, and a key change — the case where the comparison matters —
still blocks sharing and opens the review with both codes.

## Options considered

1. Keep one chip per device and only fix the layout.
2. Group by person and keep the per-device security code in an expandable
   detail.
3. Group by person and remove the permanent security code, preserving the
   review of a changed key.

## Decision

Option 3. The list uses `people()`: one chip per person, with companions only
lending their online state — a person is online when at least one of their
devices is connected. The per-member code button goes away, along with the
comparison dialog and the `code()` method of `TeamSecurity`.

The review of a changed key stays unchanged: it remains per device, names the
device, shows the old and new codes and blocks sharing until acceptance.

## Consequences

The Organization tab now answers "who is in the organization and who is
online". The voluntary fingerprint check before the first contact disappears;
whoever wants to check a new key still has the change review.

There is no change to a persisted format, IPC, the relay protocol or the
encrypted channel's trust boundary — the roster and the keys remain per device.
A format compatibility test therefore does not apply.

## Evidence

- [Collaboration core](../../src/team-channel.test.ts): companions fold into the
  person for the audience, mentions and box recipients.
- [Channel security](../../src/team-security.test.ts): a key change blocks
  sharing until the persisted acceptance.
