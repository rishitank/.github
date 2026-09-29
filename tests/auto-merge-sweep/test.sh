#!/usr/bin/env bash
# Scenario tests for auto-merge-sweep.yml's run block against a mock `gh`
# (./gh). Extracted with yq, so the code tested is the code that ships.
# Needs bash, jq, yq (v4) and python3.
# Usage: tests/auto-merge-sweep/test.sh <path-to-this-repository>
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
SRC=$(cd "${1:?path to the repository}" && pwd)
export PATH="${HERE}:${PATH}"
# Files pushed through the API lose their executable bit.
chmod +x "${HERE}/gh"
WORK=$(mktemp -d)
yq '.jobs.sweep.steps[] | select(.name == "Sweep") | .run' \
  "${SRC}/.github/workflows/auto-merge-sweep.yml" > "${WORK}/run.sh"

pass=0; fail=0
check() { if eval "$2"; then echo "  PASS  $1"; pass=$((pass + 1)); else echo "  FAIL  $1"; echo "${OUT}" | sed 's/^/        /'; fail=$((fail + 1)); fi; }

GATED='[{"type":"pull_request","parameters":{"required_approving_review_count":1}},
        {"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"CodeRabbit"},{"context":"ci-gate"}]}}]'
REVIEW_ONLY='[{"type":"pull_request","parameters":{"required_approving_review_count":1}},
        {"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"CodeRabbit"}]}}]'
U=https://github.com/rishitank

# One pull request of each kind. gated/* repos require approval and CI;
# loose/* requires only CodeRabbit.
fresh_state() {
  jq -n --argjson gated "${GATED}" --argjson loose "${REVIEW_ONLY}" --arg u "${U}" '
    def pr($login; $bot; $head; $base): {state: "OPEN", isDraft: false, author: {login: $login, is_bot: $bot},
      headRepositoryOwner: {login: $head}, baseRefName: $base, labels: [], armed: false};
    {prs: {
      ($u + "/gated/pull/1"):  pr("rishitank"; false; "rishitank"; "main"),
      ($u + "/gated/pull/2"):  pr("rishitank"; false; "rishitank"; "main"),
      ($u + "/gated/pull/3"):  (pr("rishitank"; false; "rishitank"; "main") + {isDraft: true}),
      ($u + "/gated/pull/4"):  pr("stranger"; false; "stranger"; "main"),
      ($u + "/gated/pull/5"):  pr("app/renovate"; true; "rishitank"; "main"),
      ($u + "/gated/pull/6"):  (pr("rishitank"; false; "rishitank"; "main") + {labels: [{name: "needs-human-review"}], armed: true}),
      ($u + "/gated/pull/7"):  (pr("rishitank"; false; "rishitank"; "main") + {armed: true}),
      ($u + "/gated/pull/8"):  pr("rishitank"; false; "someone-fork"; "main"),
      ($u + "/loose/pull/1"):  (pr("rishitank"; false; "rishitank"; "main") + {armed: true}),
      ($u + "/loose/pull/2"):  pr("rishitank"; false; "rishitank"; "main"),
      ($u + "/gated/pull/9"):  (pr("stranger"; false; "stranger"; "main") + {armed: true}),
      ($u + "/gated/pull/10"): pr("rishitank"; false; "rishitank"; "release/2026.10"),
      ($u + "/gated/pull/11"): pr("collaborator"; false; "rishitank"; "main")
    },
    rules: {"rishitank/gated:main": $gated, "rishitank/loose:main": $loose, "rishitank/gated:release/2026.10": $gated}}' \
    > "${WORK}/state.json"
  : > "${WORK}/state.json.log"
}
set_state() { jq "$1" "${WORK}/state.json" > "${WORK}/t" && mv "${WORK}/t" "${WORK}/state.json"; }
run() { # $1 dry-run; optional $2 token
  : > "${WORK}/summary.md"
  OUT=$(GH_TOKEN="${2-x}" OWNER=rishitank DRY_RUN="$1" OPT_OUT=needs-human-review \
        GITHUB_STEP_SUMMARY="${WORK}/summary.md" MOCK_STATE="${WORK}/state.json" bash "${WORK}/run.sh" 2>&1); RC=$?
}
armed()   { [ "$(jq -r --arg u "${U}/$1" '.prs[$u].armed' "${WORK}/state.json")" = true ]; }
calls()   { grep -c -- "$1" "${WORK}/state.json.log" || true; }
has()     { grep -qF -- "$1" <<< "${OUT}"; }

echo "== 1. a live sweep"
fresh_state; run false
check "exit 0" '[ "$RC" = 0 ]'
check "owner PR on a gated base: armed" 'armed gated/pull/1 && armed gated/pull/2'
check "gated release/ base (slash in the name): armed" 'armed gated/pull/10'
check "draft: not armed" '! armed gated/pull/3'
check "stranger: not armed" '! armed gated/pull/4'
check "someone else's branch in the owner's repo: not armed" '! armed gated/pull/11'
check "bot: not armed" '! armed gated/pull/5'
check "head branch in a fork owned by someone else: not armed" '! armed gated/pull/8'
check "labelled needs-human-review: disarmed" '! armed gated/pull/6 && has "disarmed ${U}/gated/pull/6: labelled needs-human-review"'
check "already armed: no second arm" '[ "$(calls "pr merge ${U}/gated/pull/7 --auto")" = 0 ] && armed gated/pull/7'
check "base without required CI: owner PR disarmed, and not armed" '! armed loose/pull/1 && ! armed loose/pull/2 && has "main requires 1 approval(s) and CI checks: none"'
check "stranger armed by hand: left alone" 'armed gated/pull/9 && [ "$(calls "pr merge ${U}/gated/pull/9")" = 0 ]'
check "rules read once per repository and base" '[ "$(calls "api repos/rishitank/gated/rules/branches/main")" = 1 ]'
check "only merge writes, and only --auto --squash or --disable-auto" '! grep "pr merge" "${WORK}/state.json.log" | grep -vqE -- "--auto --squash$|--disable-auto$"'
check "summary counts" 'has "armed 3, disarmed 2"'
: > "${WORK}/state.json.log"; run false
check "second run: nothing new armed" '[ "$RC" = 0 ] && [ "$(calls "--auto --squash")" = 0 ]'

echo "== 2. dry run"
fresh_state; run true
check "reports, writes nothing" '[ "$RC" = 0 ] && has "would arm ${U}/gated/pull/1" && [ "$(calls "pr merge")" = 0 ]'

echo "== 3. rules unreadable: not armed, run continues"
fresh_state; set_state '.rules["rishitank/gated:main"] = "error"'
run false
check "exit 0, warned, nothing on gated/main armed, release base still armed" '[ "$RC" = 0 ] && has "could not read the rules on main" && ! armed gated/pull/1 && armed gated/pull/10'

echo "== 4. token"
fresh_state; run false ""
check "no secret: NEEDS-TOKEN, exit 0, gh never called" '[ "$RC" = 0 ] && has "NEEDS-TOKEN" && [ ! -s "${WORK}/state.json.log" ]'
set_state '.deny_search = 401'; run false
check "search refused: NEEDS-TOKEN, exit 0" '[ "$RC" = 0 ] && has "::warning title=NEEDS-TOKEN::GitHub refused the search"'
fresh_state
jq --arg u "${U}/gated/pull/1" '.prs[$u].merge_error = "HTTP 403: Resource not accessible by personal access token"' "${WORK}/state.json" > "${WORK}/t" && mv "${WORK}/t" "${WORK}/state.json"
run false
check "arm refused (403): NEEDS-TOKEN, exit 0, others still armed" '[ "$RC" = 0 ] && has "NEEDS-TOKEN" && armed gated/pull/2'

echo "== 5. real failures fail the run"
fresh_state; set_state '.deny_search = 502'; run false
check "search 502: exit 1" '[ "$RC" = 1 ]'
fresh_state
jq --arg u "${U}/gated/pull/1" '.prs[$u].merge_error = "GraphQL: something broke (HTTP 500)"' "${WORK}/state.json" > "${WORK}/t" && mv "${WORK}/t" "${WORK}/state.json"
run false
check "arm 500: exit 1, the rest still processed" '[ "$RC" = 1 ] && armed gated/pull/2'

echo
echo "${pass} passed, ${fail} failed"
rm -rf "${WORK}"
[ "${fail}" = 0 ]
