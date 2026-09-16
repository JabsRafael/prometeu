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

`npm run app:bundle` builds the app in debug mode as a `.app` and opens it
through LaunchServices. It is the only way to test dictation on macOS: TCC reads
`NSSpeechRecognitionUsageDescription` only from a bundle the app launched
itself, and a binary run by `tauri dev` (or executed directly from inside the
`.app`) is aborted on the first recognition request. That is why the microphone
button stays hidden under `npm run app`; there is no hot reload in this mode.

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
npm run build:mobile
npm run test:web
npm run test:rust
npm run test:e2e
npm run format:check
npm run lint:rust
npm run check
```

`npm run check` runs documentation and architecture checks, Rust formatting,
desktop and mobile builds/typecheck, the whole test suite and Clippy with
warnings as errors. It is the same main validation as CI.
`npm run architecture:check` first runs its
dependency-checker fixtures with Node's test runner, then checks the repository.

The phone app is a separate bundle: `npm run build:mobile` generates
`dist-mobile/` from `src/mobile/`; in `prometeu-cloud`,
`bin/mobile <path to prometeu>` vendors the files in `vendor/mobile/assets`
with a hash manifest and `bin/mobile --check` flags a divergence. The Cloud does
not need Node to serve it. See
[ADR 0028](../decisions/0028-mobile-web-app.md).

The desktop CI builds the mobile entry on every run. The Cloud CI verifies its
vendored mobile hashes and tests the Rails page with that pinned bundle. These
checks do not claim the Cloud bundle matches the latest desktop source. When
updating the mobile client, build it in the intended desktop checkout, then run
`bin/mobile ../prometeu` and `bin/mobile --check ../prometeu` in the Cloud. Commit
the assets and manifest together. A desktop build does not publish or replace
the Cloud's bundle.

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
- Mobile build: the production browser entry and its portable dependencies
  bundle successfully; it does not exercise Rails authentication or deployment.
- Architecture check: runtime imports remain acyclic, portable boundaries hold
  through intermediate modules, selected pure modules stay free of known
  effects, and presentation/protocol checks stay in force. The exact scope and
  limits are in the [dependency rules](../architecture/dependency-rules.md).
- Clippy/rustfmt: backend discipline.

## Shared Cloud API fixtures

[`fixtures/cloud-api.json`](../../fixtures/cloud-api.json) contains synthetic
HTTP payloads shared with the Rails service. Rust tests in `cloud.rs` and
`catalog.rs` feed them through the production profile decoder and catalog
parser. Cloud's `DesktopContractTest` checks real Bearer-authenticated endpoints
against its vendored copy. Each repository runs independently; desktop CI does
not need access to the Cloud repository.

The fixture covers session profiles, signed-out responses, empty/current/legacy
catalogs, revision conflicts and rejection of credential-bearing catalog input.
It does not replace organization, relay, device-login or feedback integration
tests. These are executable examples of the current wire contract, not a new
API version or a complete schema.

For a paired contract change, update the public fixture and consumer tests here,
then import it into the Cloud checkout and run its producer tests:

```sh
# In prometeu:
npm run test:rust -- shared_cloud_contract

# In prometeu-cloud, with prometeu as a sibling checkout:
bin/contracts ../prometeu
bin/contracts --check ../prometeu
bin/rails test test/integration/desktop_contract_test.rb test/contracts_test.rb
```

Commit the fixture, copied fixture, hash manifest and affected tests in their
respective repositories. Cloud CI runs `bin/contracts --check` to verify its
pinned copy. With a source path, the same command additionally checks that both
repositories use identical fixture bytes. Link the paired PRs and record the
tested revisions; a hash check alone does not prove either server behavior or
deployed compatibility.

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
