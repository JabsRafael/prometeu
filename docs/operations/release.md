# CI and release

## Commits

The repository uses Conventional Commits in English:

```text
type(scope): description
```

`feat`, `fix` and `perf` appear in the changelog. During the 0.x series, normal
changes bump the patch and breaking changes bump the minor according to
`cliff.toml`. The description is the public release line: write what the person
sees, in lowercase and without a trailing period.

The `.githooks/commit-msg` hook validates locally and the `commits` job checks
every commit of the PR.

## CI

`.github/workflows/ci.yml` runs on PRs, including from forks, and on pushes to
`main`, on GitHub-hosted macOS runners. The job installs dependencies, installs
Chromium and WebKit and runs `npm run check`. Hosted runners are disposable and
the workflow has no secrets, so fork code runs without risk. Do not register a
self-hosted runner in this repository: the code is public and a fork's PR
controls what the job runs. See
[ADR 0040](../decisions/0040-open-source.md).

## Create a release

```sh
sh scripts/release.sh
sh scripts/release.sh 0.5.0
```

The script requires a clean tree, the `main` branch, parity with `origin/main`
and at least one public note since the previous tag. It computes or receives the
version, updates the manifests and the changelog, runs the tests, creates the
commit/tag and pushes to the remote.

The release workflow builds and signs the artifacts and creates a draft in this
same repository, with the job's `GITHUB_TOKEN`. There is no release PAT.

## Publish

Between the build and the publication there is a human check:

1. download the `.dmg` from the draft;
2. install and open the app;
3. validate the flows affected by the version;
4. confirm that every asset and the workflow are complete;
5. publish with:

```sh
sh scripts/release.sh publish
```

The assets do not carry the version in their name (`Prometeu_aarch64.dmg`). That
keeps `releases/latest/download/Prometeu_aarch64.dmg` valid forever, which is
the site's link: publishing changes the version the download button delivers,
without touching the site's repository.

The updater has no rollback to a lower version. A release published with a
defect must be fixed by a later version.

## Keys

The private signing key never enters the repository. The local copy lives in
`~/.tauri/prometeu.key`; its password lives in the Keychain under the
`prometeu-tauri-signing` service. CI uses the `TAURI_SIGNING_PRIVATE_KEY` and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secrets. Losing the local copy and the
secrets makes it impossible to update existing installations.

That signature protects the updater. Distribution on macOS also uses the
`Developer ID Application: Gustavo Brancaglione (6MQT6A482B)` certificate from
the Keychain and Apple notarization. CI imports a `.p12` copy into a temporary
Keychain using `APPLE_CERTIFICATE` and `APPLE_CERTIFICATE_PASSWORD`, adds that
Keychain to the search list without changing the Mac's default Keychain and then
removes it. Notarization uses `APPLE_ID` and `APPLE_PASSWORD`; the second
contains an app-specific password, never the normal Apple account password. The
job fails before the build if the certificate or the secrets are missing. The
bundler notarizes the app; the workflow notarizes and staples the final DMG,
replaces the asset created before that step and then uses `stapler` and `spctl`
to validate the copy downloaded from the draft.

Do not run a cut, tag, push or publication as part of an ordinary task without
an explicit request.
