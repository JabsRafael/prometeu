# ADR 0017 — Executable Design System components

Date: 2026-09-06
Status: accepted. Supersedes the separation of behavior from
[ADR 0016](0016-company-design-system.md). Preserves the contracts of
[ADR 0011](0011-shared-ui.md).

## Context

Distributing CSS and SVG unified the appearance, but kept rendering and
interaction inside each product. The Design System needs to provide ready
components, including state, events, focus, keyboard, validation and lifecycle.

## Decision

`@prometeu/design-system` 0.2.0 now owns the DOM primitives, menus, generic
icons, forms and the styles required by the interactions. `src/ui.ts` and
`src/menu.ts` on the desktop remain as compatibility re-exports. No component of
the package imports application modules or provider rules.

The package distributes ESM modules, TypeScript types and a browser bundle. The
TypeScript and Vite already present in the project generate the artifact;
consumers need no framework and no runtime JavaScript dependencies.

For Rails, the same package provides a FormBuilder and helpers that render
complete fields, buttons and containers. Views compose those APIs instead of
repeating the controls' markup. The shared runtime wires menus, passwords,
optional confirmations, validation and double-submit protection. Forms keep
Rails submission, the submitter's values and CSRF. Without JavaScript, the
essential controls stay native; authorization never depends on the runtime.

The Cloud vendors the compiled assets and the Ruby adapter, with hashes and a
version. Only `vendor/design-system/assets` enters the public pipeline. Its CSP
allows local scripts and a nonce, without free inline scripts, `eval` or
external sources. Ruby code, the database, tokens and credentials do not enter
the bundle.

## Alternatives and consequences

Adopting React would require replacing the desktop's and Rails' presentation.
Web Components would require rewriting existing primitives and adapting fields
to native submission. Extracting the existing DOM code and adding a Rails
adapter keeps both products conventional and preserves the tested behaviors.

There are two renderers in the package, DOM and Action View, suited to their
environments. Classes and accessibility have a shared contract and tests in
Chromium and WebKit. Browser interactions have a single JavaScript
implementation. Product layout, business rules and translations stay external.

Building the package becomes necessary to distribute new versions. The Cloud
does not need Node to build or run the service. A rollback reverts the runtime,
styles, adapter and manifest together. There is no change to the API, IPC,
persisted data or the content sent to the service.

## Evidence

- [API and integration](../../packages/design-system/README.md).
- [Executable components](../../packages/design-system/src/index.ts).
- [Rails adapter](../../packages/design-system/rails/prometeu_design_system.rb).
- [Standalone gallery](../../packages/design-system/index.html).
- [Behavior tests](../../e2e/design-system.spec.ts).
- [Screen compatibility](../../e2e/actions.spec.ts).
