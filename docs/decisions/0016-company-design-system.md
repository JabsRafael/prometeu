# ADR 0016 — The company's shared Design System

Date: 2026-09-06
Status: the separation of behavior is superseded by
[ADR 0017](0017-executable-design-system.md). Supersedes the location of the
tokens and of the shared CSS from [ADR 0011](0011-shared-ui.md); keeps its
interaction contracts.

## Context

The desktop has its own tokens, brand and primitives. The Rails Cloud kept a
second palette and divergent controls. Copying styles between screens makes each
product responsible for maintaining the company's identity.

## Decision

The canonical source lives in `packages/design-system` in the Prometeu
repository, distributed as `@prometeu/design-system`. The package contains CSS
tokens, class-based components, the SVG brand and a standalone HTML gallery. It
does not depend on a framework, a backend, JavaScript or compilation. The
artifact can be produced with `npm pack`, without publishing to a registry in
this change.

The desktop imports that source directly; `src/ui-tokens.css` keeps the
application's exclusive geometry. The Cloud imports an explicit version into
`vendor/design-system`, with SHA-256 hashes and a check in CI. The Rails
pipeline publishes those assets without Node and without access to the desktop
repository in production. Edits are made in the source and re-imported, never in
the vendored artifact.

The shared CSS uses opt-in classes and preserves the existing tokens' names and
values. `ui-comfortable` offers 44px controls for the web. Page composition,
domain rules and translation stay in each product. Menus, dialogs and DOM
helpers stay in the desktop's local adapters.

## Alternatives and consequences

A component framework would exclude ERB or add unnecessary runtime and build
steps. A CDN would make the look depend on the network and make rollback harder.
A third repository is unnecessary while this package already provides an
independent distribution boundary.

Vendoring requires explicitly adopting new versions, but keeps builds
reproducible. The manifest detects changes in the artifact; comparing with the
source directory verifies its origin. The desktop's values are preserved; the
Cloud starts using the same identity on every account page. A rollback reverts
the assets and their manifest. There is no data or API change.

## Evidence

- [Package and consumption contract](../../packages/design-system/README.md).
- [Design System guide](../architecture/design-system.md).
- [Standalone gallery](../../packages/design-system/index.html).
- [Isolated consumption check](../../e2e/design-system.spec.ts).
- [Desktop interactions](../../e2e/ui.spec.ts).
