# ADR 0024 — Command-owned IPC argument and result types

Date: 2026-09-07
Status: Accepted

## Context

The previous TypeScript wrapper checked command names but let callers choose
any return type and pass unrestricted arguments. The browser mock could drift
from those assumptions while command-name parity tests still passed.

## Options considered

1. Keep the name list and rely on caller annotations and runtime tests.
2. Share a TypeScript command map between callers and browser handlers.
3. Introduce generated Rust bindings for commands and events immediately.

## Decision

Use `src/ipc.ts` as the TypeScript command map. Each command owns its arguments
and result. `invoke` infers both from the command name, and the browser mock
implements the same `IpcHandlers` map. Wrappers use exported command-derived
types instead of choosing arbitrary result generics.

Keep the existing Tauri transport, Rust handlers, error representation, and
command-name parity test. Generate bindings only after a separate proof covers
serde enums/defaults, optional values, errors, and events.

## Consequences

Wrong arguments and mock results fail compilation without adding a dependency.
All registered application commands have explicit browser handlers. Dynamic
plugin dispatch stays outside the application map.

Rust argument/result shapes still require manual synchronization and boundary
tests. This map does not validate untrusted runtime data or Tauri event payloads.
No wire or persisted format changes; rollback only reverts source code.

## Evidence

- [IPC contract](../contracts/ipc.md).
- [Invocation and compile-time regressions](../../src/ipc.test.ts).
- [Exact command-name parity](../../src-tauri/tests/mock.rs).
- `npm run typecheck` validates callers and mock handlers.
