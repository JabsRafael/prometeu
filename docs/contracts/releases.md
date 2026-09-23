# Desktop release and update contract

One version and tag (`v<version>`) identify both desktop builds in
`prometeucorp/prometeu`. A release stays a draft until both builds, signature
verification and native installation checks finish. The operational procedure
is in [release](../operations/release.md); distribution choices are in
[ADR 0055](../decisions/0055-linux-desktop.md).

## Assets and manifest

Stable install names are `Prometeu_aarch64.dmg` for macOS Apple Silicon and
`Prometeu_x86_64.AppImage` for Linux x86_64. They live alongside the updater
packages, their `.sig` files and `latest.json` in the same release.

The app keeps the endpoint
`https://github.com/prometeucorp/prometeu/releases/latest/download/latest.json`.
The manifest uses Tauri's static format:

- `version` matches the tag without its `v` prefix;
- `notes` carries the version's changelog section;
- `platforms.darwin-aarch64` points to `Prometeu_aarch64.app.tar.gz`;
- `platforms.linux-x86_64` points to `Prometeu_x86_64.AppImage`;
- every entry has a version-specific GitHub download `url` and a `signature`
  containing the base64-encoded minisign signature, not a file path;
- installer-specific entries emitted by Tauri (`darwin-aarch64-app` and
  `linux-x86_64-appimage`) point to the same verified packages.

Both builds use the existing signing key. Linux support is additive: the macOS
asset names, endpoint, public key and platform entry remain compatible with
installed versions. Drafts are not exposed through the latest release endpoint.
Recovery from a published defect requires a newer version.

## Installation ownership

macOS and Linux AppImage installations check at startup and hourly. Download
and restart remain explicit user actions, and Tauri verifies the signature
before installation. AppImage files must be writable by the user.

On Linux, Tauri's built-in `plugin:app|bundle_type` command selects this behavior;
no application IPC payload changes. An `appimage` result enables the updater.
Debian, RPM, Arch and unpackaged builds keep updates external; unknown or failed
bundle detection also disables the updater. The browser mock returns `appimage`
and no available update, so UI tests never download packages.

## Verification

`scripts/verify-release.py` checks both platforms, exact versioned URLs, assets,
signature-file consistency and minisign signatures against the embedded key.
`scripts/test_release.py` covers missing platforms/assets, wrong versions/URLs,
signature failures and refusal to publish incomplete or failed builds.
`src/update-init.test.ts` preserves package-manager ownership and macOS behavior;
`src/update.test.ts` covers download and restart. CI cannot prove native desktop
integration or real replacement/relaunch; those require the release smoke test.
