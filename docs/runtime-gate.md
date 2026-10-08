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
- **The Gemini key is scoped to one step.** It goes only to the explorer
  step. The app, its dependencies and the build never see it.
- **The AI never decides pass/fail.** Its findings are advisory. Only the
  deterministic crawl blocks merges.

## Files

- `.github/actions/runtime-gate/`: the toolkit, as a composite action:
  - `src/crawl.mjs`
  - `src/explore.mjs`
  - `src/static-server.mjs`
  - self-tests with good and broken fixture sites
- `.github/workflows/runtime-gate.yml`: the reusable workflow. It pins the
  toolkit by commit, so move both together.
- `.github/workflows/runtime-gate-selftest.yml`: proves the crawler passes a
  healthy site and catches each kind of breakage in a broken one, on every
  change to the toolkit.
