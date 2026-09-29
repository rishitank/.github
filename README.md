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
| `lighthouse-ci.yml` | Node / web frontends | `lhci autorun` against a locally built app, plus a sticky PR comment with the score table; advisory by default |
| `lockfile.yml` | Node / TypeScript | `workflow_dispatch` lockfile regeneration that proves the result before committing |
| `workflows-lint.yml` | any | actionlint over `.github/workflows/`, self-updating and cached |

Every job sets `timeout-minutes` and a least-privilege `permissions` block.
Callers still need their own `permissions` block, because the caller's grant is
the ceiling for everything it calls.

### Advisory-first inputs

`python-ci.yml` takes `lint-strict`, `security.yml` takes `audit-strict`,
`lighthouse-ci.yml` takes `strict`. All three default to `false`, so a repo
that has never been linted, audited, or Lighthouse-checked can adopt these
today without a wall of red. They print a step summary (or, for Lighthouse, a
PR comment) saying so.

Leaving them `false` forever is how a quality gate becomes decoration. Clear the
backlog, flip the flag.

`lighthouse-ci.yml` doesn't set its own performance/accessibility/SEO budgets —
those live in the consuming repo's own `lighthouserc.json` (or `.js`/`.cjs`),
which `lhci autorun` discovers on its own. See `lighthouserc.example.json` in
this repository for a starting point. A repo that wants "advisory on PRs,
blocking on protected branches" rather than one fixed value can compute
`strict` from the triggering event instead of hardcoding it:
`strict: ${{ github.event_name != 'pull_request' }}`.

## Repository policy: settings, rulesets and auto-merge

`settings.yml` is this account's policy for every **public, non-archived,
non-fork** repository it owns. No repository is named anywhere: both
workflows below find the repositories afresh on every run, so a repository
created tomorrow is covered by the next run with nothing to add. Private
repositories are left as they are, because on the Free plan GitHub drops
auto-merge and refuses rulesets there.

| Workflow | When | Does |
|---|---|---|
| `repo-settings-reconcile.yml` | push to `settings.yml`, nightly, by hand (dry run by default) | Writes the `repository:` settings (auto-merge, squash, delete branch on merge) and each `repo_rulesets:` entry into every repository, then reads every write back |
| `auto-merge-sweep.yml` | every 20 minutes, by hand (dry run by default) | Turns on auto-merge for the owner's open pull requests where the base branch is gated |

The rulesets, one body each, written into every repository:

- **`review-gate`** on the default branch: CodeRabbit's approval of the
  latest commit (dismissed on push), every thread resolved, the `CodeRabbit`
  check green on an up-to-date branch, squash only, no force-push, no
  deletion. Only Renovate may merge its own pull requests past it. The copies
  put on by hand on 2026-09-25 have the same name, so they are updated in
  place, not duplicated.
- **`ci-gate`** on the default branch: requires one check named `ci-gate`
  from GitHub Actions. It is **written active only on repositories that
  publish that check** (a top-level job named `ci-gate` in a workflow on the
  default branch) and disabled everywhere else, re-checked every run. So a
  repository is never blocked on a check it doesn't run, and one that adds
  the job is gated from the next run on. The job to copy is the one in
  TanksterAI/.github's README, "The `ci-gate` contract".
- **`long-lived-branches`**: `main`, `master`, `develop` and everything under
  `release/` can't be deleted. `delete_branch_on_merge` deletes a merged pull
  request's head branch, so without this a pull request from `develop` into
  `main` would take `develop` with it.

Any repository ruleset with another name (holocron's "Main Branch
Protection", say) is never touched, and keeps applying alongside these.

**Auto-merge arms only behind a gate.** For each of the owner's pull requests,
`auto-merge-sweep.yml` reads the rules that actually apply to its base branch
(every ruleset, whatever its name) and arms `gh pr merge --auto --squash` only
if they require an approval **and** a status check other than CodeRabbit's.
Otherwise it disarms. GitHub then merges by itself once every rule is met. It
never arms a stranger's pull request (these repositories are public), a
bot's (Renovate merges its own), a draft, or one labelled
`needs-human-review`; adding that label later disarms it on the next run.

**Token.** Both need the `PERSONAL_ADMIN_TOKEN` secret here: a fine-grained
token for **All repositories** with **Administration**, **Contents** and **Pull
requests** (read and write). Without it, or when GitHub refuses it, they
report `NEEDS-TOKEN` and change nothing, rather than failing every run.
Merges armed with it are made as the owner, so `on: push` workflows fire
after them, and the review gate still applies: it has no bypass for the owner.

**Before the first run,** check that CodeRabbit's GitHub App can see every
public repository (Settings > Applications > CodeRabbit > Repository access:
All repositories). On a repository it can't see, `review-gate` waits for an
approval and a check that never come. It also stops direct pushes to the
default branch there, which matters for a repository you edit in the browser
(this account's profile README, say).

The scenario tests for both are in `tests/`, and run in `self-check.yml`:
`bash tests/reconcile/test.sh .` and `bash tests/auto-merge-sweep/test.sh .`
(they need jq, yq v4 and python3).

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

1. Open a PR. `self-check.yml` runs actionlint over the change, and the
   scenario tests in `tests/` for the reconciler and the sweep.
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
