#!/usr/bin/env bash
# Scenario tests for repo-settings-reconcile.yml against a mock `gh` (./gh).
# They run the workflow's real `run:` block, extracted with yq, so the code
# tested is the code that ships. Needs bash, jq, yq (v4) and python3.
# Usage: tests/reconcile/test.sh <path-to-this-repository>
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
SRC=$(cd "${1:?path to the repository}" && pwd)
export PATH="${HERE}:${PATH}"
# Files pushed through the API lose their executable bit.
chmod +x "${HERE}/gh"
WORK=$(mktemp -d)
yq '.jobs.reconcile.steps[] | select(.name == "Reconcile") | .run' \
  "${SRC}/.github/workflows/repo-settings-reconcile.yml" > "${WORK}/run.sh"
cp "${SRC}/settings.yml" "${WORK}/settings.yml"

pass=0; fail=0
check() { if eval "$2"; then echo "  PASS  $1"; pass=$((pass + 1)); else echo "  FAIL  $1"; fail=$((fail + 1)); fi; }

OK='{"allow_auto_merge": true, "allow_squash_merge": true, "delete_branch_on_merge": true}'
CI_WF='jobs:
  test:
    runs-on: ubuntu-latest
    steps: [{run: "true"}]
  ci-gate:
    name: ci-gate
    needs: [test]
    runs-on: ubuntu-latest
    steps: [{run: "true"}]'
PLAIN_WF='jobs:
  test:
    runs-on: ubuntu-latest
    steps: [{run: "true"}]'
# A hand-made review-gate from 2026-09-25: same name, but no Renovate bypass.
HAND_GATE='{"name": "review-gate", "target": "branch", "enforcement": "active",
  "conditions": {"ref_name": {"include": ["~DEFAULT_BRANCH"], "exclude": []}},
  "bypass_actors": [], "rules": [{"type": "deletion"}]}'
OTHER='{"name": "Main Branch Protection", "target": "branch", "enforcement": "active",
  "conditions": {"ref_name": {"include": ["~DEFAULT_BRANCH"], "exclude": []}}, "rules": [{"type": "deletion"}]}'

# alpha: public, drifted settings, a hand-made review-gate and an unrelated ruleset, CI with ci-gate.
# beta: public, clean settings, no rulesets, CI without ci-gate, default branch master.
# fork, archived, private, someone-else's: never touched.
fresh_state() {
  jq -n --argjson ok "${OK}" --argjson hand "${HAND_GATE}" --argjson other "${OTHER}" \
     --arg ci "${CI_WF}" --arg plain "${PLAIN_WF}" '{
    repos: {
      "rishitank/alpha":   {settings: ($ok + {allow_auto_merge: false}), rulesets: {"11": $hand, "12": $other},
                            workflows: {".github/workflows/ci.yml": $ci}},
      "rishitank/beta":    {settings: $ok, rulesets: {}, default_branch: "master",
                            workflows: {".github/workflows/ci.yml": $plain}},
      "rishitank/forked":  {settings: {}, rulesets: {}, fork: true},
      "rishitank/old":     {settings: {}, rulesets: {}, archived: true},
      "rishitank/secret":  {settings: {}, rulesets: {}, private: true},
      "someone/else":      {settings: {}, rulesets: {}, owner: "someone"}
    }}' > "${WORK}/state.json"
  : > "${WORK}/state.json.log"
}
set_state() { jq "$1" "${WORK}/state.json" > "${WORK}/t" && mv "${WORK}/t" "${WORK}/state.json"; }

run() { # $1 dry-run; optional $2 token (default x)
  : > "${WORK}/summary.md"
  OUT=$(cd "${WORK}" && GH_TOKEN="${2-x}" OWNER=rishitank GITHUB_EVENT_NAME=test DRY_RUN="$1" \
        GITHUB_STEP_SUMMARY="${WORK}/summary.md" MOCK_STATE="${WORK}/state.json" \
        bash -e run.sh 2>&1); RC=$?
}
writes()  { grep -cE '^(POST|PUT|PATCH|DELETE) ' "${WORK}/state.json.log" || true; }
st()      { jq -r "$1" "${WORK}/state.json"; }
rs()      { st "[.repos[\"rishitank/$1\"].rulesets[] | select(.name == \"$2\")] | first"; }
has()     { grep -qF -- "$1" <<< "${OUT}"; }
touched() { grep -qE " repos/$1(/|\$|\?)" "${WORK}/state.json.log"; }

echo "== 1. dry run"
fresh_state; before=$(cat "${WORK}/state.json")
run true
check "exit 0" '[ "$RC" = 0 ]'
check "reports alpha settings drift" 'has "drift     rishitank/alpha: settings:{\"allow_auto_merge\":true}"'
check "reports hand-made review-gate update, ci-gate active on alpha" 'has "ruleset:review-gate:update(active)" && has "ruleset:ci-gate:create(active)"'
check "reports ci-gate disabled on beta" 'grep -q "rishitank/beta: .*ruleset:ci-gate:create(disabled)" <<< "${OUT}"'
check "no writes, state untouched" '[ "$(writes)" = 0 ] && [ "$(cat "${WORK}/state.json")" = "${before}" ]'

echo "== 2. apply"
fresh_state
run false
check "exit 0" '[ "$RC" = 0 ]'
check "alpha allow_auto_merge set" '[ "$(st ".repos[\"rishitank/alpha\"].settings.allow_auto_merge")" = true ]'
check "alpha review-gate updated in place (same id 11)" '[ "$(st ".repos[\"rishitank/alpha\"].rulesets[\"11\"].bypass_actors | map(.actor_id) | join(\",\")")" = 2740 ] && grep -q "^PUT repos/rishitank/alpha/rulesets/11" "${WORK}/state.json.log"'
check "alpha has exactly one review-gate" '[ "$(st "[.repos[\"rishitank/alpha\"].rulesets[] | select(.name == \"review-gate\")] | length")" = 1 ]'
check "review-gate body: 1 approval, stale dismissed, threads, squash" '[ "$(rs alpha review-gate | jq -c "[.rules[] | select(.type==\"pull_request\")][0].parameters | [.required_approving_review_count, .dismiss_stale_reviews_on_push, .required_review_thread_resolution, .allowed_merge_methods]")" = "[1,true,true,[\"squash\"]]" ]'
check "review-gate: CodeRabbit pinned to 347564, strict" '[ "$(rs alpha review-gate | jq -c "[.rules[] | select(.type==\"required_status_checks\")][0].parameters | [.strict_required_status_checks_policy, .required_status_checks]")" = "[true,[{\"context\":\"CodeRabbit\",\"integration_id\":347564}]]" ]'
check "unrelated ruleset untouched" '[ "$(st ".repos[\"rishitank/alpha\"].rulesets[\"12\"].name")" = "Main Branch Protection" ] && ! grep -q "rulesets/12" "${WORK}/state.json.log"'
check "alpha ci-gate active, pinned to github-actions" '[ "$(rs alpha ci-gate | jq -c "[.enforcement, .rules[0].parameters.required_status_checks]")" = "[\"active\",[{\"context\":\"ci-gate\",\"integration_id\":15368}]]" ]'
check "beta ci-gate written disabled" '[ "$(rs beta ci-gate | jq -r .enforcement)" = disabled ]'
check "long-lived-branches: deletion only, 4 patterns, no bypass" '[ "$(rs beta long-lived-branches | jq -c "[[.rules[].type], (.conditions.ref_name.include | sort), .bypass_actors]")" = "[[\"deletion\"],[\"refs/heads/develop\",\"refs/heads/main\",\"refs/heads/master\",\"refs/heads/release/**/*\"],[]]" ]'
check "fork, archived, private and others untouched" '! touched rishitank/forked && ! touched rishitank/old && ! touched rishitank/secret && ! touched someone/else'
check "reports 2 repositories" 'has "2 repositories"'

echo "== 3. idempotent"
: > "${WORK}/state.json.log"; run false
check "exit 0, no writes, both ok" '[ "$RC" = 0 ] && [ "$(writes)" = 0 ] && has "ok        rishitank/alpha" && has "ok        rishitank/beta"'

echo "== 4. ci-gate follows the repository's workflows"
jq --arg ci "${CI_WF}" --arg plain "${PLAIN_WF}" '.repos["rishitank/beta"].workflows[".github/workflows/ci.yml"] = $ci
  | .repos["rishitank/alpha"].workflows[".github/workflows/ci.yml"] = $plain' "${WORK}/state.json" > "${WORK}/t" && mv "${WORK}/t" "${WORK}/state.json"
: > "${WORK}/state.json.log"; run false
check "beta starts publishing: ci-gate active" '[ "$RC" = 0 ] && [ "$(rs beta ci-gate | jq -r .enforcement)" = active ]'
check "alpha stops publishing: ci-gate disabled, never blocking" '[ "$(rs alpha ci-gate | jq -r .enforcement)" = disabled ]'
set_state '.repos["rishitank/beta"].workflows = {}'
run false
check "no workflows at all: disabled" '[ "$(rs beta ci-gate | jq -r .enforcement)" = disabled ]'
jq --arg ci "${CI_WF}" '.repos["rishitank/beta"].workflows[".github/workflows/ci.yml"] = $ci' "${WORK}/state.json" > "${WORK}/t" && mv "${WORK}/t" "${WORK}/state.json"
run false >/dev/null
set_state '.repos["rishitank/beta"].workflows = null'
before=$(rs beta ci-gate); : > "${WORK}/state.json.log"; run false
check "workflows unreadable: active ci-gate left alone, said so" '[ "$RC" = 0 ] && has "rishitank/beta: could not read workflows, ci-gate left as it is" && [ "$(rs beta ci-gate)" = "${before}" ] && [ "$(rs beta ci-gate | jq -r .enforcement)" = active ] && [ "$(writes)" = 0 ]'

echo "== 5. drift repaired"
fresh_state; run false >/dev/null
set_state '(.repos["rishitank/alpha"].rulesets["11"].conditions.ref_name.exclude) = ["refs/heads/main"]
  | (.repos["rishitank/beta"].rulesets[] | select(.name == "long-lived-branches") | .conditions.ref_name.include) = ["refs/heads/main"]'
: > "${WORK}/state.json.log"; run false
check "exit 0, two PUTs" '[ "$RC" = 0 ] && [ "$(grep -c "^PUT " "${WORK}/state.json.log")" = 2 ]'
check "exclude removed, branch list restored" '[ "$(rs alpha review-gate | jq -c .conditions.ref_name.exclude)" = "[]" ] && [ "$(rs beta long-lived-branches | jq ".conditions.ref_name.include | length")" = 4 ]'

echo "== 6. token problems never fail the run"
fresh_state
run false ""
check "no secret: NEEDS-TOKEN, exit 0, gh never called" '[ "$RC" = 0 ] && has "::warning title=NEEDS-TOKEN::PERSONAL_ADMIN_TOKEN is not set." && [ ! -s "${WORK}/state.json.log" ]'
set_state '.deny_list = 401'
run false
check "listing refused (401): NEEDS-TOKEN, exit 0, no writes" '[ "$RC" = 0 ] && has "NEEDS-TOKEN" && [ "$(writes)" = 0 ]'
fresh_state; set_state '.repos["rishitank/alpha"].deny_rulesets = 403'
run false
check "ruleset write refused (403) on alpha: NEEDS-TOKEN, exit 0" '[ "$RC" = 0 ] && has "::warning title=NEEDS-TOKEN::rishitank/alpha: GitHub refused"'
check "beta still reconciled" '[ "$(rs beta review-gate | jq -r .enforcement)" = active ]'

echo "== 7. real failures do fail it"
fresh_state; set_state '.deny_list = 500'
run false
check "listing 500: exit 1" '[ "$RC" = 1 ] && has "could not list repositories"'
fresh_state; set_state '.repos["rishitank/alpha"].deny_rulesets = 500'
run false
check "ruleset write 500 on alpha: exit 1, beta still reconciled" '[ "$RC" = 1 ] && [ "$(rs beta review-gate | jq -r .enforcement)" = active ]'
fresh_state; set_state '.drop_bypass = true'
run false
check "read-back mismatch: exit 1, NOT-APPLIED" '[ "$RC" = 1 ] && has "was accepted but does not read back as the policy" && has "(NOT-APPLIED)"'
fresh_state; set_state '.repos["rishitank/alpha"].drop_settings = ["allow_auto_merge"]'
run false
check "setting silently dropped: exit 1, NOT-APPLIED named" '[ "$RC" = 1 ] && has "NOT-APPLIED:allow_auto_merge"'
fresh_state; set_state '.repos = {"rishitank/forked": {settings: {}, rulesets: {}, fork: true}}'
run false
check "nothing to reconcile: exit 1, not a silent success" '[ "$RC" = 1 ] && has "No repositories returned"'

echo "== 8. policy validation"
cp "${WORK}/settings.yml" "${WORK}/settings.yml.bak"
for case in ".repo_rulesets.review-gate.enforcement = \"evaluate\"" \
            "del(.repo_rulesets.long-lived-branches.branches)" \
            ".repo_rulesets.ci-gate.required_checks.checks += [{\"context\": \"x\"}]" \
            ".repo_rulesets.review-gate.bypass_apps = [\"no-such-app\"]"; do
  fresh_state; cp "${WORK}/settings.yml.bak" "${WORK}/settings.yml"; yq -i "${case}" "${WORK}/settings.yml"
  run false
  check "invalid (${case}): exit 1 before any write" '[ "$RC" = 1 ] && [ "$(writes)" = 0 ]'
done
mv "${WORK}/settings.yml.bak" "${WORK}/settings.yml"

echo
echo "${pass} passed, ${fail} failed"
rm -rf "${WORK}"
[ "${fail}" = 0 ]
