# Shared CI

Reusable GitHub Actions workflows and Renovate presets for every repository under this account.

The point is that CI lives in one place. A repo that adopts these gets a caller
workflow of roughly fifteen lines instead of a hundred-and-fifty-line `ci.yml`
that drifts away from its siblings the moment someone fixes a bug in one copy
and not the other four.

## Using a workflow

```yaml
# .github/workflows/ci.yml in a consuming repo
name: ci

on:
  push:
    branches: [main]
  pull_request:
  workflow_dispatch:

# Cancel superseded runs. This belongs in the caller, not the reusable
# workflow, because the group has to be keyed on the caller's ref.
concurrency:
  group: ci-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  ci:
    uses: rishitank/.github/.github/workflows/python-ci.yml@v1
    with:
      python-version: "3.12"
      verify: python verify.py
```

The doubled `.github/.github/` is not a typo: the first is the repository name,
the second is the directory inside it.

Pin to `@v1`. That tag moves forward as these workflows improve, so consuming
repos pick up fixes without a PR each. Pin to a commit SHA instead if a repo
needs to be insulated from that.

## Available workflows

| Workflow | For | Notable |
|---|---|---|
| `python-ci.yml` | Python | ruff + optional mypy + your `verify.py` gate; optional graceful checkout of a private sibling repo |
| `node-ci.yml` | Node / TypeScript | npm or pnpm, single job, `.nvmrc` as the version source of truth |
| `rust-ci.yml` | Rust | fmt, clippy `-D warnings`, test, release build, and the no-panics-in-production gate |
| `security.yml` | any | osv-scanner + gitleaks + ecosystem audit |
| `lockfile.yml` | Node / TypeScript | `workflow_dispatch` lockfile regeneration that proves the result before committing |
| `workflows-lint.yml` | any | actionlint over `.github/workflows/`, self-updating and cached |

Every job sets `timeout-minutes` and a least-privilege `permissions` block.
Callers still need their own `permissions` block, because the caller's grant is
the ceiling for everything it calls.

### Advisory-first inputs

`python-ci.yml` takes `lint-strict`, `security.yml` takes `audit-strict`. Both
default to `false`, so a repo that has never been linted or audited can adopt
these today without a wall of red. They print a step summary saying so.

Leaving them `false` forever is how a quality gate becomes decoration. Clear the
backlog, flip the flag.

## Security tooling, and what is deliberately absent

There is no CodeQL here and nothing uploads SARIF. Both require GitHub Code
Security on private repositories, and most of this estate is private, so a
CodeQL workflow would fail on the repos that need it most. What is here works on
every repo at no cost:

- **osv-scanner** — vulnerable dependencies across npm, PyPI, crates and Go.
  Uses the `osv-scanner-action` sub-action, not the reusable workflow, because
  the reusable one uploads SARIF.
- **gitleaks** — secrets, in CLI form. The gitleaks *Action* requires a licence
  key for organisation-owned repositories; the MIT-licensed CLI does not.
- **npm audit / pip-audit / cargo-audit** — ecosystem advisories.

Public repos can and should keep a CodeQL workflow of their own alongside this.

## Renovate

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["github>rishitank/.github:node"]
}
```

Presets: `default` (implied by `github>rishitank/.github`), `node`, `python`, `rust`.

`default.json` includes `helpers:pinGitHubActionDigests`, which converts every
`uses: some/action@v1.2.3` into a commit digest with the version as a trailing
comment, and then keeps those digests current. That is how this estate gets
SHA-pinned actions without anyone hand-maintaining a list of hashes.

If this repository is private, the Renovate app must be installed on it as well
as on the consuming repos, or preset resolution will fail.

## Changing a workflow

A change here lands on every consuming repo at once. Treat it accordingly:

1. Open a PR. `workflows-lint.yml` runs actionlint over the change.
2. Test against one consuming repo by pinning it to the branch
   (`@my-branch` instead of `@v1`) and watching a real run go green.
3. Merge, then move the `v1` tag:
   `git tag -f v1 && git push -f origin v1`.

## Visibility

Reusable workflows in a **private** repository can only be called by other
**private** repositories owned by the same account, and only once
Settings → Actions → General → Access is set to allow it.

A **public** repository has no such restriction and additionally makes
`SECURITY.md`, `CONTRIBUTING.md` and the issue/PR templates here apply
automatically to every repo on the account that lacks its own.
