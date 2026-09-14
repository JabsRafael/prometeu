# Development and testing

## Prerequisites

- Node and npm at the versions declared in `package.json`;
- the Rust toolchain declared in `src-tauri/rust-toolchain.toml`;
- Playwright's Chromium for E2E tests;
- Claude Code and/or Codex installed to test real sessions.

```sh
npm install
npx playwright install chromium webkit
```

## Run modes

```sh
npm run app
npm run dev
PORT=1421 npm run dev
```

`npm run app` starts Tauri through `scripts/app.sh` and isolates the port and
the state root per worktree. `npm run dev` opens only the frontend over
`src/mock.ts`, useful for UI work and for the Playwright-driven tests.

The mock does not prove process lifecycle, filesystem behavior or Rust
serialization. The Tauri app is not driven by Playwright on macOS because
WKWebView does not expose CDP.

The mock's interactive preview uses a controlled page in an iframe and the app's
own selection script. The `browser` tests cover Chromium and WebKit; the native
PNG and AppKit gestures stay outside that proof. See the
[browser contract](../contracts/browser.md).

## Validation commands

```sh
npm run docs:check
npm run architecture:check
npm run typecheck
npm run build
npm run test:web
npm run test:rust
npm run test:e2e
npm run format:check
npm run lint:rust
npm run check
```

`npm run check` runs Rust formatting, build/typecheck, the whole test suite and
Clippy with warnings as errors, plus the documentation's integrity. It is the
same main validation as CI.

The phone app is a separate bundle: `npm run build:mobile` generates
`dist-mobile/` from `src/mobile/`; in `prometeu-cloud`,
`bin/mobile <path to prometeu>` vendors the files in `vendor/mobile/assets`
with a hash manifest and `bin/mobile --check` flags a divergence. The Cloud does
not need Node to serve it. See
[ADR 0028](../decisions/0028-mobile-web-app.md).

During development, run the smallest suite that covers the change first. Use
`npm run check` before finishing a cross-cutting change or opening a PR.

## What each level proves

- Vitest: reducers, pure presentation, parsing, the relay's protocol and the
  TypeScript adapters.
- Rust tests: lifecycle, Codex translation, state, paths, Git, internal IPC and
  processes.
- Worker integration: authentication and the real behavior of the local relay.
- Playwright: critical UI flows against the mock.
- Typecheck/build: imports, types, the i18n catalog and the bundle.
- Architecture check: presentation decisions do not go back to comparing
  provider names directly.
- Clippy/rustfmt: backend discipline.

## Simultaneous instances

Debug and release use different roots. Each development worktree gets its own
configuration through `scripts/app.sh`; that avoids collisions of `board.json`
and the Vite port. Do not replace that initialization with a direct `tauri dev`
without understanding the isolation.

This repository's `.prometeu/settings.toml` offers the app itself and the mock
as dogfooding scripts.

## Capturing agent fixtures

Protocol fixtures must:

- come from real output of the CLI version stated in the test;
- remove personal prompts, user paths, tokens and credentials;
- preserve the ids and ordering the scenario needs;
- contain the smallest set of frames that reproduces the behavior;
- record the provider, the CLI version and the capability proven;
- never depend on the network during the suite.

A CLI update that breaks a fixture is a signal to review the adapter and the
contract, not to delete the assertion until the test passes.

## Interface text

Portuguese is the source catalog in `src/i18n.pt.ts`; English implements the
same keys in `src/i18n.en.ts`. TypeScript uses `t`/`tn`; Rust emits codes that
the frontend translates with `fromBack`.

Agent output, terminal output and text provided by the person are not
translated.
