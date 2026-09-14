# ADR 0006 — Explicit Prometheus import

Date: 2026-09-04
Status: Accepted; interface and importer removed on 2026-09-10

## Context

Prometeu was born with an independent identity and roots so that it could be
validated without risking the previous installation. The few people who already
used Prometheus, however, have a board, conversations, plugins and worktrees
that should not be abandoned in the switch.

Copying the whole root is not enough: Claude's transcripts depend on the
worktree's path, managed plugins store absolute paths, credentials belong to the
external identity that issued them and worktrees can take dozens of gigabytes.
Moving everything would also take the old installation out of its role as a
backup.

## Options considered

1. Make Prometeu read `~/.prometheus` automatically on every launch.
2. Copy the whole root and move the worktrees into the new namespace.
3. Offer a single, explicit import, only into an empty destination.

## Decision

Prometeu temporarily offers **Settings → Application → Migrate from Prometheus**
when it finds `~/.prometheus/board.json`.

The operation:

- requires that Prometeu's board has no projects or workspaces yet;
- shows a preview and requires confirmation that Prometheus is closed;
- creates a private snapshot and manifest under `~/.prometeu/imports/`;
- deserializes and normalizes the board through the current model, shutting down
  processes and removing the sharing marks;
- copies every Codex log to `~/.prometeu/chats/` without overwriting on
  conflict;
- keeps Claude's transcripts in `~/.claude`, since the working paths do not
  change;
- copies managed plugins into the new root, rewrites only their sources in the
  registry and refuses collisions;
- creates `.prometeu/settings.toml` only when a `.prometheus/settings.toml`
  exists and the destination does not, changing only the public variable prefix
  `PROMETHEUS_` to `PROMETEU_`;
- does not import Linear/team credentials, quotas, caches, WebKit or temporary
  processes;
- preserves branches and worktrees at the old path. Cleaning a multi-repo
  workspace accepts the old root only when it is exactly the one Prometheus
  would have computed.

The board is written last. The manifest carries the source's SHA-256 hash and
the imported ids; a repetition recognizes the result and does not duplicate
data. The source is never written to or deleted.

The interface may be removed when the transition window ends. Read support for
the imported state and the safety of the old paths remain.

On 2026-09-10 the window ended: whoever was going to migrate has migrated. The
interface, the `legacy_import_plan`/`legacy_import_run` commands and
`migration.rs` were removed. What this decision foresaw as permanent stays in
the code: reading the already-imported state and `paths::prometheus_multi_dir`,
which lets cleaning a multi-repo workspace accept the inherited worktree. Boards
not yet migrated require the previous application version or a manual copy.

## Consequences

Positive:

- the migration has a preview, a rollback and visible conflicts;
- gigabytes of worktrees are not duplicated;
- conversations and plugins stay available;
- credentials of one OAuth or relay identity do not leak into another.

Negative:

- while a worktree is not moved or cleaned, both applications point to the same
  folder and must not operate that workspace at the same time;
- a Prometeu that already has data needs a manual migration; this feature does
  not implement board merging;
- Linear must be authorized again;
- `.prometeu/settings.toml` files created in repositories may appear in
  `git status` when the directory is not ignored.

## Evidence

While the importer existed, Rust tests covered the preview, the copy,
normalization, idempotency, an occupied destination and a transcript conflict,
and the E2E covered the preview and the interface's confirmation. After the
removal, what remains is `src-tauri/src/session.rs`, which tests the acceptance
of the inherited worktree in
`check_so_deixa_sair_o_que_ja_entrou_e_esta_limpo`.
