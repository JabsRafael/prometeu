# Contributing to Prometeu

Bug reports, documentation changes and code contributions are welcome. Search
[existing issues](https://github.com/prometeucorp/prometeu/issues) before opening
a report. Include reproduction steps, expected and actual behavior, macOS and
Prometeu versions, and the agent CLI version when relevant. Public reports must
not contain credentials or private conversations.

## Make a change

1. Fork the repository and create a branch from `main`.
2. Follow the [development guide](docs/operations/development.md) to install
   dependencies and run the app or browser mock.
3. Read the [architecture map](ARCHITECTURE.md) and the contract for your area.
   Use the [contributor recipes](docs/operations/contributing.md) for provider,
   IPC, collaboration and Cloud changes.
4. Keep the change focused. Update affected contracts and tests in the same PR.
   Follow the [decision lifecycle](docs/decisions/README.md) when changing an
   architectural choice.
5. Run the closest tests first, then `npm run check` for a code PR. Report any
   check you cannot run and why. Browser tests use the mock; native changes need
   a desktop check too.
6. Open a PR against `main`. Explain the problem, resulting behavior, validation
   and remaining limitations. Link a related issue when one exists.

Write comments and documentation in English. Add interface text to both i18n
catalogs and reuse the [design system](docs/architecture/design-system.md).
Commits follow [Conventional Commits](docs/operations/release.md); the repository
hook and CI validate them. The short [agent guide](AGENTS.md) applies the same
boundaries to automated contributions.
