# Runtime gate

Build, lint and unit tests prove the code compiles. They don't prove the app
still works once a dependency update changes runtime behaviour, for example:

- a hydration mismatch
- a lazy chunk that 404s
- a menu that throws when clicked
- a page that renders blank

Renovate opens a stream of exactly those updates. `runtime-gate.yml` boots the
app, uses it in a real browser and reports what broke. There are no test
cases to write or maintain.

## What it does

| Layer | Blocks merge? | What it catches |
|---|---|---|
| **Crawl** | **Yes** | See below. |
| **Visual diff** | No (advisory) | Every screenshot is compared with the last successful run on the base branch. Changes over 0.2% of pixels are listed in the PR comment, with diff images in the artifact. |
| **AI explorer** | No (advisory) | See below. |

**Crawl.** It finds pages from `/`, any `routes` you list, `sitemap.xml` and
followed links, capped at 3 pages per URL shape and `max-pages` in total. It
opens each page in the full Chromium browser in new headless mode, which is
the same engine people use rather than Playwright's stripped-down shell. Then
it:

- operates up to 12 safe controls per page: buttons, tabs, disclosures,
  menus, switches, checkboxes and selects, and types a query into search
  boxes. It never presses anything that submits a form or reads as
  destructive (delete, pay, sign out, send and similar);
- fills up to 3 forms per page with dummy data and submits them, the way a
  person trying the app would. It skips forms whose button says send, pay,
  delete and the like. A 4xx answer to a dummy submission, such as a
  rejected sign-in, is expected and only reported as a warning; exceptions,
  console errors and 5xx responses still fail;
- follows links client-side, so routing and hydration run as they do for a
  person;
- probes a missing route;
- repeats the first pages at phone size.

A page fails the crawl if any of these happen:

- an uncaught exception
- a console error from the app
- a React hydration error (`#418`, `#423` and similar)
- a failed same-origin request, or a 4xx/5xx response
- a blank render
- a framework crash screen

Third-party failures and layout overflow are reported as warnings and don't
fail it.

With a test login (see [Signed in](#signed-in)) the crawl signs in and runs
again over the pages behind the login. It also replays any
[recorded flows](#recorded-flows), and it reports how much of the app it
reached (see [Coverage](#coverage)).

**AI explorer.** Gemini uses the app the way a person would. It reads the
accessibility tree, looks at a screenshot after every action, fills forms
with fake data, and reports anything that looks or behaves wrong. Runtime
errors that happen while it explores are recorded deterministically, as hard
evidence alongside its opinion.

The PR gets one sticky comment with all three results. The `runtime-gate`
artifact holds every screenshot, the explorer's step-by-step screenshots and
the app's own log.

Hydration detection was verified against Next.js 16.4 with React 19.3: a
production build reports the mismatch as `Minified React error #418`
through `window.reportError`, and the crawler fails on it.

## Using it

```yaml
# .github/workflows/runtime.yml
name: runtime

on:
  pull_request:
  push:
    branches: [main]          # each main run becomes the visual baseline
  schedule:
    - cron: "17 5 * * 1"      # weekly AI exploration of main
  workflow_dispatch:

concurrency:
  group: runtime-${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  runtime:
    uses: rishitank/.github/.github/workflows/runtime-gate.yml@<sha>
    permissions:
      contents: read
      actions: read
      pull-requests: write
    with:
      mode: docker            # build and run the production Dockerfile
      port: 3000
    secrets:
      gemini-api-key: ${{ secrets.GEMINI_API_KEY }}
```

Make the `Runtime gate` job a required check, or add it to the repo's
`ci-gate` `needs`. Renovate then cannot auto-merge an update that breaks
the running app.

### Choosing a mode

| `mode` | When to use it | Key inputs |
|---|---|---|
| `docker` | The repo has the production `Dockerfile` that Coolify deploys. This is the most faithful option, because it tests the same artefact. | `dockerfile`, `docker-context`, `docker-build-args`, `env` |
| `command` | Install, build and start on the runner. | `setup`, `package-manager`, `install`, `build`, `start` |
| `static` | The build output is plain files (CRA, Vite, webpack, exported sites). | `build`, `static-dir`, `spa` |

Two inputs apply across modes:

- **`build-image`** (`command` and `static` modes): runs the install and build
  inside an old toolchain image such as `node:14-bullseye`. This is for legacy
  apps whose toolchain no longer builds on current Node. The browser checks
  still run on the runner.
- **`postgres: "17"`**: starts Postgres and exports `DATABASE_URL`. Use
  `migrate` to run migrations and seed data before start.

In `docker` mode, `env` reaches the running container only. Values the image
needs at build time, such as `NEXT_PUBLIC_*`, go in `docker-build-args`.

Everything in `env` must be a CI-only dummy value. The gate never needs real
credentials, and an app that can't boot without them should get a fake or
dry-run mode.

### Tuning

| Input | Use it to |
|---|---|
| `routes` | Visit pages that nothing links to. |
| `exclude` | Skip paths with side effects. |
| `quarantine` | Show a known problem without blocking on it (see below). |
| `ignore` | Tolerate a known, accepted console message or URL. Each entry hides a whole class of error, so keep the list short and comment why. |
| `http-user`, `http-password` | Get past a staging basic-auth gate. Use dummy CI values. |
| `browser` | Choose `chromium` (the default), `chrome`, `firefox` or `webkit`. |
| `headed` | Set to `true` to run the browser with a visible window on a virtual display. |

### When the AI explorer runs

With `explore: auto`, the default, the explorer runs when any of these is
true:

- the run is a schedule or a manual dispatch;
- the PR has the `major-upgrade` label (the Renovate preset adds it) or the
  `ai-explore` label;
- the PR title names a framework or a major update.

The `explore-match` input holds that title pattern. A typical match is
"Update dependency next to v16.4".

The explorer uses the Gemini API free tier, with the `gemini-flash-latest`
model by default. It sends at most 8 requests a minute and makes 30 steps per
run. Get a key from Google AI Studio and store it as the `GEMINI_API_KEY`
secret. Without the secret the explorer reports itself skipped and the crawl
still gates.

For UK users, Google applies its paid-service data terms even to free-quota
usage, so prompts are not used for training.

### Signed in

Most of an app usually sits behind a login. Give the gate a test account and
the crawl runs twice, signed out and signed in; the explorer starts signed in.

| Input | Use it to |
|---|---|
| `login-path` | The sign-in page, e.g. `/login`. Turns the signed-in crawl on. |
| `login-username`, `login-password` | The test account. CI-only dummies, never a real account: seed it with `migrate`, or let the gate register it. |
| `signup-path` | Register the account through the app's own sign-up page first, for apps without seed data. |
| `login-check` | A path only signed-in users can open. The gate opens it after signing in and fails if it is sent back to the sign-in page. Without it, the sign-in form must be gone after submitting. |
| `login-script` | A module in the repo for sign-ins a plain form can't do (multi-step, OAuth stubs). Its default export receives `{ page, context, base, username, password }`. |

A sign-in that stops working is a blocking `login-failed` finding: if a
dependency update breaks sign-in, that is what the gate is for.

The gate signs in before the signed-out crawl starts, because that crawl
fills sign-up forms with its own dummy address (`ci@example.com`) and could
otherwise claim the test account's address first. A `login-check` page may
contain a change-password form: only a form with a single password field
counts as "still on the sign-in page".

The signed-in crawl skips public pages that already rendered fine for a
visitor, never opens sign-out links, and never submits a form with a password
field (that would change the test account or sign in as someone else).

### Recorded flows

When the explorer completes a sequence of actions without a runtime error, it
records it as a flow: a start page and up to 10 steps, such as "open
/dashboard, click Add item, click All items". On scheduled and manual runs of
the default branch, `runtime-gate-flows.yml` saves new flows to
`.github/runtime-gate-flows.json` on the branch `runtime-gate/flows` and opens
one PR for a person to review. Recorded flows become part of the gate only
once someone has looked at them and merged them.

The crawl then replays every saved flow on every PR, exactly as recorded and
with no model calls. A flow that can no longer be done (a button that is gone,
a dialog that no longer opens) is a `flow-broken` finding. With
`flows-strict: auto`, the default, that blocks dependency-update PRs (from
Renovate or Dependabot, where the interface should not change) and is a
warning on other PRs (where the change may be intended and the flow just
needs re-recording or deleting). Runtime errors during a replay always count.

```yaml
  flows:
    needs: runtime
    if: ${{ !cancelled() && (github.event_name == 'schedule' || github.event_name == 'workflow_dispatch') }}
    uses: rishitank/.github/.github/workflows/runtime-gate-flows.yml@<sha>
    permissions:
      contents: write        # push the runtime-gate/flows branch
      pull-requests: write   # open or update its PR
      actions: write         # start CI on that branch
    with:
      ci-workflows: ci.yml   # workflows to start on the flows PR (need workflow_dispatch)
```

PRs opened by GitHub Actions don't start `pull_request` workflows, so the
workflows named in `ci-workflows` are started on the branch instead. If the
repository doesn't allow GitHub Actions to create pull requests, the branch is
still pushed and the run prints a link to open the PR by hand.

### Flaky findings and quarantine

A page with a blocking finding is opened once more in a clean browser. A
finding that doesn't happen again is reported as **flaky**: still shown in
the PR comment, but not blocking. This is deliberately conservative: if the
retry shows any blocking problem of the same kind on that page, nothing is
downgraded. Turn it off with `retry: false`.

`quarantine` takes regexes for known problems you have decided to live with
for now. They are matched against `kind: message @ /path`, stay visible in
the comment, and don't block. Put an issue link in a YAML comment next to
each entry, and remove it when the issue is fixed.

### Coverage

Each run reports how much of the app the crawl reached:

- routes visited out of routes discovered, and the ones it didn't reach;
- controls operated out of distinct controls found;
- forms submitted out of forms found;
- the share of the app's own JavaScript that actually ran (V8 block coverage,
  Chromium only).

The default branch's numbers travel with the visual baseline, so a PR shows
the change, for example "routes −2, JS −6.3 pts". A drop means the crawl
reached less of the app than before: a route that now redirects, a menu that
no longer opens, a code-split chunk that no longer loads. It is advisory.

### Giving the explorer hints

Add `.github/runtime-gate.md` to the app repo, covering:

- what the app is for;
- the flows that matter most;
- any test login seeded by `migrate`.

The explorer reads this file as operator instructions.

## Safety

- **Page content is untrusted.** The explorer prompt says so, and the
  explorer cannot leave the app's origin. Its only tools are browser actions:
  there is no shell and no file access.
- **Pages are screened for prompt injection before the model sees them.**
  Every observation goes through pattern checks (instructions aimed at AI
  agents, chat-template tokens, invisible Unicode) and, with
  `explore-guard: model`, a separate small classifier model
  (`gemini-flash-lite-latest`, its own free-tier budget). Long pages are
  checked in overlapping chunks, and one flagged chunk withholds the whole
  page. A flagged page is replaced by a placeholder with no screenshot, and
  the PR comment lists it. This follows the BrowseSafe pattern
  (arXiv 2511.20597). Text drawn only inside images is not screened; that is
  why the validation below exists.
- **Every action is validated before it runs.** Roles and keys come from
  allowlists, navigation must stay on the app, typed text is capped and may
  not contain links to other sites or encoded payloads, and a signed-in
  explorer can't sign itself out. Recorded flows are validated the same way
  when they are replayed.
- **The Gemini key is scoped to one step.** It goes only to the explorer
  step. The app, its dependencies and the build never see it.
- **The AI never decides pass/fail.** Its findings are advisory. Only the
  deterministic crawl blocks merges.

## Files

- `.github/actions/runtime-gate/`: the toolkit, as a composite action:
  - `src/crawl.mjs`: the deterministic crawl, signed out and signed in,
    flow replay, coverage, retry and quarantine
  - `src/explore.mjs`: the AI explorer
  - `src/login.mjs`: signing in
  - `src/actions.mjs`: browser actions and their validation, shared by the
    explorer and the flow replayer
  - `src/injection.mjs`: prompt-injection screening
  - `src/flows.mjs`: recording and merging flows
  - `src/static-server.mjs`
  - self-tests with good and broken fixture sites, and a small dynamic app
    with sign-up, sign-in, a flaky page and an injection page
- `.github/workflows/runtime-gate.yml`: the reusable workflow. It pins the
  toolkit by commit, so move both together.
- `.github/workflows/runtime-gate-flows.yml`: saves recorded flows to the
  repo through a reviewed PR.
- `.github/workflows/runtime-gate-selftest.yml`: proves the crawler passes a
  healthy site and catches each kind of breakage in a broken one, and runs
  the reusable workflow end to end, signed out and signed in, on every change
  to the toolkit.
