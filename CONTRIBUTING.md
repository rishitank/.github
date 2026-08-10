# Contributing

## Before you open a pull request

- CI must be green. Whatever the repo's quality gate is — `verify.py`, `npm
  test`, `cargo test` — it is the definition of done, not a suggestion.
- Keep the change to one thing. A refactor bundled with a behaviour change is
  two reviews wearing a trenchcoat.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/):
  `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`. Release tooling
  reads these.

## Branching

Branch off the default branch, open a PR back into it. Direct pushes to the
default branch are reserved for automation.

## Dependencies

Renovate manages upgrades. Do not hand-edit a lockfile; if one needs
regenerating, run the repo's `lockfile` workflow from the Actions tab so the
result is proven to install and build before it is committed.

## CI configuration

CI lives in the shared `.github` repository for this account, not in each repo.
A repo's `.github/workflows/ci.yml` should be a short caller. If you find
yourself copying workflow logic between repos, that logic belongs in the shared
repository instead.
