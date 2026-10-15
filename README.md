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
| `python-ci.yml` | Python | one job: ruff + optional mypy + your `verify.py` gate; optional graceful checkout of a private sibling repo |
| `node-ci.yml` | Node / TypeScript | npm or pnpm, single job, `.nvmrc` as the version source of truth |
| `rust-ci.yml` | Rust | fmt, clippy `-D warnings`, test, release build, and the no-panics-in-production gate |
| `security.yml` | any | osv-scanner + gitleaks in one job, both blocking; the advisory ecosystem audit runs weekly (every run if `audit-strict`) |
| `lighthouse-ci.yml` | Node / web frontends | `lhci autorun` against a locally built app, plus a sticky PR comment with the score table; advisory by default |
| `runtime-gate.yml` | web apps (any stack) | boots the app (Dockerfile, command or static), crawls it in a real browser and **fails on runtime errors**: exceptions, console errors, hydration errors, failed requests, 4xx/5xx, blank pages; plus advisory screenshot diffs and an advisory Gemini explorer that uses the app like a person. See `docs/runtime-gate.md` |
| `lockfile.yml` | Node / TypeScript | `workflow_dispatch` lockfile regeneration that proves the result before committing; the proof runs read-only and a separate job commits, so dependency install scripts never share a job with the write token |
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

## Runtime gate: does the app still work?

`runtime-gate.yml` exists because a dependency update can pass build, lint and
unit tests and still break the running app. It boots the app the way it is
deployed, uses it in a real browser, and fails the check on runtime errors, so
Renovate cannot merge an update that breaks a page. There are no test cases to
write or maintain. An advisory AI explorer (Gemini free tier, `GEMINI_API_KEY`
secret) uses the app like a person for major and framework updates. Full
guide, inputs and examples: [`docs/runtime-gate.md`](docs/runtime-gate.md).

The Renovate presets set `platformAutomerge: false`, so Renovate itself checks
that every status (this gate included) is green before it merges. GitHub's
native auto-merge only waits for checks that branch protection or a ruleset
makes required. A repository that has neither, for example a private
repository on a plan that does not offer them (see GitHub's
[protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)
and [rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets)
pages for which plans do), has no required checks, so native auto-merge would
merge the moment the PR opened.

```yaml
jobs:
  runtime:
    uses: rishitank/.github/.github/workflows/runtime-gate.yml@<sha>
    permissions: { contents: read, actions: read, pull-requests: write }
    with:
      mode: docker
    secrets:
      gemini-api-key: ${{ secrets.GEMINI_API_KEY }}
```

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
- **npm audit / pip-audit / cargo-audit** — ecosystem advisories. Advisory,
  and their databases are OSV sources already, so they run on the weekly
  schedule and on manual runs only (on every run with `audit-strict: true`).
  cargo-audit comes as a prebuilt binary, not `cargo install`.

All three run as steps of one job: a finding in one does not stop the others,
and a final verdict step fails the job if osv-scanner or gitleaks found
anything.

Public repos can and should keep a CodeQL workflow of their own alongside this.

## Renovate

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["github>rishitank/.github:node"]
}
```

Presets: `default` (implied by `github>rishitank/.github`), `node`, `python`, `rust`.

Updates come **once a month**, in a window on the 1st-3rd (London time), and
normally as two pull requests per repository: `non-major (automerge)`
(non-major GitHub Actions bumps, dev and test tooling, cargo patches; merged by
Renovate on green CI inside the window) and `non-major (review)` (everything
else non-major, Docker digests included). The scientific stack keeps its own
group. Majors, GitHub Actions majors included, open no pull request until they
are ticked on the Dependency Dashboard. Lockfile maintenance is quarterly.
Branches are not updated or rebased outside the window, so a reviewed pull
request merged later needs "Update branch" first. Security fixes are
unaffected: `vulnerabilityAlerts` ignores the schedule and grouping and opens
a pull request at once. Every Renovate pull
request costs a full CI run plus another on merge, so this is the difference
between about 450 and about 100 pull requests a month across the estate.

`default.json` includes `helpers:pinGitHubActionDigests`, which converts every
`uses: some/action@v1.2.3` into a commit digest with the version as a trailing
comment, and then keeps those digests current. That is how this estate gets
SHA-pinned actions without anyone hand-maintaining a list of hashes.

The exception is this repository's own reusable workflows: Renovate leaves
`TanksterAI/.github` and `rishitank/.github` refs alone, so they stay at `@v1`
and a change reaches every repository by moving the tag, with no pull request
anywhere. A caller still pinned to a commit SHA must be moved to `@v1` once by
hand: Renovate will not touch it again.

If this repository is private, the Renovate app must be installed on it as well
as on the consuming repos, or preset resolution will fail.

## CI minute budget

GitHub bills every job rounded up to a whole minute, and a fallback runner
boots a VM per job. In October 2026 the average private job ran 51 seconds, so
46% of the minutes billed were rounding. Rules for anything added here or in a
consuming repo:

- **One job per concern, steps not jobs.** A check that takes seconds belongs
  as a step of a job that is already running.
- **Cancel superseded runs.** Every caller that runs on `pull_request` sets
  `concurrency` with `cancel-in-progress: true`, keyed on the caller's ref.
- **No duplicate runs.** Merges are squash-only from up-to-date branches, so a
  `push: main` run re-checks a tree the pull request already checked. Keep a
  push trigger only where something needs it: a deployment, a visual
  baseline, or `rust-ci.yml`, whose release build follows the caller's trigger
  and `build-release` input.
- **Schedules weekly at most** unless the job is the product.
- **Reference this repository at `@v1`**, never by SHA: a SHA pin turns every
  change into a pull request in every consuming repository.

## Changing a workflow

A change here lands on every consuming repo at once. Treat it accordingly:

1. Open a PR. `workflows-lint.yml` runs actionlint over the change.
2. Test against one consuming repo by pinning it to the branch
   (`@my-branch` instead of `@v1`) and watching a real run go green.
3. Merge, then move the `v1` tag: run the `move-major-tag` workflow (it
   refuses any commit that is not on main), or by hand
   `git push -f origin <sha>:refs/tags/v1`. Always the full `refs/tags/`
   path: this repository also has a stale branch named `v1`.

## Visibility

Reusable workflows in a **private** repository can only be called by other
**private** repositories owned by the same account, and only once
Settings → Actions → General → Access is set to allow it.

A **public** repository has no such restriction and additionally makes
`SECURITY.md`, `CONTRIBUTING.md` and the issue/PR templates here apply
automatically to every repo on the account that lacks its own.
