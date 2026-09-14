# ADR 0011 — Shared interface primitives

Status: the location of the tokens and of the shared CSS is superseded by
[ADR 0016](0016-company-design-system.md). Interaction contracts preserved.

## Context

The Actions editors duplicated fields and used native selectors different from
the launcher's. CSS rules for text inputs reached checkboxes. Fixing each screen
in isolation kept the divergences in appearance and interaction.

## Decision

Consolidate the existing tokens and DOM primitives in `ui-tokens.css`, `ui.css`
and `ui.ts`. Extract the existing dropdown from the launcher, keeping `menu.ts`
and `icons.ts` shared. Actions starts using the base; the MCP and plugin hubs'
fields too. An executable gallery and tests on both engines document the states
and behaviors.

New forms use `dialog.showModal()` for native modality and focus, with an
explicit Tab cycle for consistency between engines. Dialog menus are inserted
into the same layer. Components receive translated text and callbacks; they do
not know about IPC or agent rules.

## Consequences

No framework and no additional dependency. Changes to the primitives require
checking the consuming screens. The migration is incremental: composition styles
and old modals stay until a change requires their adoption. Old tokens keep
their values, and the change does not alter persistence or IPC; data
compatibility tests do not apply.

## Evidence

- [Guide and gallery](../architecture/design-system.md).
- [Primitive tests](../../e2e/ui.spec.ts).
- [Actions tests](../../e2e/actions.spec.ts).
