# Contributing to Black Cat Reseller

Thank you for helping improve Black Cat. Bug reports, feature ideas, documentation,
and focused code fixes are welcome. Keep discussions respectful and practical.

## Report a bug or propose a feature

Use the GitHub issue templates. For a bug, include the app version, Windows version,
steps to reproduce, expected result, and actual result. Describe the item or workflow
without sharing customer details, account credentials, cookies, or private photos.
Remove private details from screenshots and log excerpts before posting them.

For a substantial feature or a new dependency, start with an issue so the maintainer
can discuss the intended behavior and scope with you.

## Make a code change

1. Fork the repository and create a branch for one focused change.
2. Follow [the source setup instructions](README.md#run-from-source).
3. Use synthetic test inventory and fixtures. Keep your production databases,
   marketplace sessions, and photos out of development and out of Git.
4. Preserve listing identity checks, sold-item protection, user confirmation, and
   handling of uncertain publication outcomes. Keep browser work on the second monitor.
5. Run `npm.cmd test` before committing. Do not skip, delete, or weaken tests to
   obtain a passing result; explain a suspected incorrect test in the issue instead.
6. Run `npm.cmd run build:next` when changing runtime behavior, dependencies,
   configuration, packaging, or build files. Close the app first.
7. Open a pull request explaining the problem, resulting behavior, and validation.

Keep changes small and match the surrounding code. Do not commit `.env` files,
credentials, cookies, local databases, photos, models, dependencies, build output,
logs, or machine reports. Contributions are reviewed before being merged.

By contributing, you confirm that you can license your contribution under this
project's [MIT License](LICENSE.txt). Third-party components keep their own notices
and license requirements.
