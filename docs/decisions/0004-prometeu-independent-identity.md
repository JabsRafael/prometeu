# ADR 0004 — Prometeu's independent identity

Date: 2026-09-04
Status: Accepted

## Context

The product's public name became Prometeu and its domain is `prometeu.co`.
Changing the previous application's identity in place would mix bundle, updater,
local state, worktrees and script contracts during the transition. It would also
prevent installing both applications side by side to check the new line before
migrating real data.

The code and the Git history were copied into a new repository. The previous
ADRs and changelog remain historical records and are not rewritten to pretend
the new name always existed.

## Options considered

1. Rename the existing application and migrate its data during an update.
2. Share the same state roots between the two names.
3. Create Prometeu as an independent application and import data later.

## Decision

Prometeu has its own repository, bundle, executable, updater, local namespace,
project configuration and environment variables:

- bundle id `co.prometeu.desktop`;
- state in `~/.prometeu` and `~/.prometeu-dev`;
- worktrees in `~/prometeu/worktrees[-dev]`;
- configuration in `.prometeu/settings.toml`;
- public variables with the `PROMETEU_` prefix;
- branches created with the `prometeu/` prefix;
- releases published in `prometeucorp/prometeu-releases`.

The application neither reads nor modifies Prometheus data automatically. The
migration will be a later use case, explicit and idempotent, that creates a
backup, preserves the source and handles worktrees with Git operations instead
of moving folders directly.

Prometeu stops writing the rollback projection defined in ADR 0002. There is no
previous Prometeu version that depends on it. The reader keeps supporting the
historical `prometheusV1Mirror` and `type: "prometheus"` tokens to allow a
future import without rewriting transcripts. This decision supersedes only ADR
0002's temporary mirror policy; the V1 protocol remains.

## Consequences

Positive:

- both products can be installed and run side by side;
- developing Prometeu does not risk the existing state;
- a failure in the future migration does not erase the source;
- new names do not accidentally carry public contracts.

Negative:

- existing data does not appear before the import;
- `.prometheus` configurations of other repositories must be recreated or
  imported consciously;
- external integrations, signing and release infrastructure need new
  credentials;
- the legacy reader still contains two identifiers with the previous name.

Linear's OAuth registration is a temporary exception: the first development
cycle reuses its previous client id so the feature is not disabled. Before the
first public release, it must be replaced by a Prometeu registration; until
then, Linear's consent screen may show the old brand.

Implementation update on 2026-09-04: the exception ended. Prometeu started using
its own OAuth registration before the first public release, preserving the
Authorization Code flow with PKCE and the read scope.

Implementation update on 2026-09-04: the later import was implemented by
[ADR 0006](0006-explicit-prometheus-import.md), keeping the source independent
and adopting the old worktrees without moving them.

Update on 2026-09-11: [ADR 0040](0040-open-source.md) supersedes the releases
item. The code is public in `prometeucorp/prometeu` and releases come from that
same repository; `prometeucorp/prometeu-releases` is archived.

## Evidence

- `paths.rs` tests cover the new roots;
- `scripts.rs` tests cover the new file and variables;
- `branch.ts` tests cover the new prefix;
- conversation tests keep fixtures of the historical tokens;
- the Tauri configuration defines an independent product, binary and bundle id.
