#!/usr/bin/env bash
# prune-merged-branches.sh -- delete branches whose pull request was merged
# (no other branch is ever deleted), and turn on "Automatically delete head
# branches" wherever every long-lived branch is protected from deletion, so
# those repositories clean up after their own merges from then on.
# Everything it will not delete or change is reported, with a reason.
#
# Usage:
#   prune-merged-branches.sh (--org NAME | --user NAME) [--mode dry-run|apply]
#                            [--report FILE]
#
#   --org NAME    every repository of organisation NAME (orgs/NAME/repos?type=all)
#   --user NAME   every repository the token's user owns (user/repos?affiliation=owner),
#                 filtered to owner NAME
#   --mode        dry-run (the default) reports only; apply also deletes and
#                 turns the auto-delete setting on
#   --report      JSON report path (default: branch-prune-report.json)
#
# Needs gh and jq, and GH_TOKEN (or a logged-in gh). Writes a markdown table to
# $GITHUB_STEP_SUMMARY when that is set, and to stdout otherwise.
#
# Token permissions (fine-grained): Contents: Read and write (branches, ref
# deletion, and GitHub only shows a repository's merge settings to a token
# that can write contents); Pull requests: Read; Administration: Read and
# write (GET repos/R/branches/B/protection to read classic branch
# protection, and PATCH repos/R to turn the setting on); Metadata: Read
# (repositories and rulesets).
#
# "Automatically delete head branches" (delete_branch_on_merge), for every
# repository that passes rule 1 below.
#
# GitHub's automatic deletion knows nothing of KEEP_RE. Its documentation
# names only branch protection rules and repository rules (rulesets) as
# things that stop a merged head branch being deleted; it does not say that
# an open pull request based on the branch, or a long-lived name, keeps it.
# And a protection rule only stops deletion when it says so: "By default, you
# cannot delete a protected branch. When you enable deletion of a protected
# branch, anyone with at least write permissions to the repository can delete
# the branch", unless the branch is locked. So a merged develop -> main pull
# request deletes `develop` unless a rule forbids deleting it, and private
# repositories on the Free plan cannot protect branches at all. The setting
# is therefore only turned on where every long-lived branch is verifiably
# safe from deletion:
#   - long-lived: a branch other than the default branch that matches KEEP_RE
#     (the default branch is left out, as in rule 2: GitHub does not let a
#     repository's default branch be deleted);
#   - safe: a ruleset applies a `deletion` rule to it (rule 8), or classic
#     branch protection (GET repos/R/branches/B/protection, read only when
#     the branch API says `protected`) has allow_deletions.enabled false or
#     lock_branch.enabled true. The `protected` flag alone proves nothing: a
#     rule that allows deletions sets it too;
#   - unsafe: neither, and both answers are certain: no deletion rule (404,
#     or the Free-plan 403, as in rule 8) and no classic protection that
#     blocks deletion (not `protected`, a 404 "Branch not protected", or a
#     rule that allows deletions);
#   - unverified: anything that could not be read for certain (a protection
#     read that fails, an unparseable answer, a ruleset lookup that fails
#     where classic protection does not settle it). Never treated as safe.
# Then, per repository:
#   - read with GET repos/R, never from the repository list, which may omit
#     it. A missing field is "unknown", never "off";
#   - on, every long-lived branch safe: already_on;
#   - on, some long-lived branch unsafe: at_risk. Left on (turning it off is
#     a decision for a person), with a ::warning naming the branches;
#   - off, some long-lived branch unsafe: unsafe. Left off and reported with
#     the branch names. Not a failure: protect the branches, and the next run
#     turns the setting on;
#   - otherwise, some long-lived branch unverified: unknown, with a
#     ::warning naming the branches. Never turned on;
#   - off, every long-lived branch safe, dry-run: would_enable;
#   - off, every long-lived branch safe, apply: PATCH repos/R with
#     delete_branch_on_merge=true, then read it back. Only a read-back of true
#     counts as enabled: a 2xx is a claim, the setting is the evidence;
#   - a read that fails, branches that cannot be listed, or a PATCH refused
#     with 403 (the token lacks Administration: Read and write), is unknown: a
#     ::warning, never fatal, so a token without that permission does not
#     turn every run red;
#   - any other PATCH failure, or a read-back that is not true, is failed and
#     counts toward exit 1 like a failed deletion.
# There is no per-repository opt-out: in apply mode a safe repository where
# the setting was switched off by hand is switched back on, and reported.
#
# A branch B in repository R is deletable only if ALL of these hold:
#   1. R is not archived and not a fork;
#   2. B is not R's default branch;
#   3. B is not protected (branch API `protected` is false);
#   4. B does not match the keep pattern (KEEP_RE below);
#   5. no OPEN pull request in R uses B as its head or its base;
#   6. at least one MERGED pull request in R has head ref B and head repo R;
#   7. B's tip SHA equals that merged pull request's head SHA, so nothing was
#      pushed after the merge and the commits are already in the base;
#   8. no ruleset applies a `deletion` rule to B
#      (GET repos/R/rules/branches/B). 404, and 403 because the plan has no
#      rulesets for the repository (private repositories on Free), mean "no
#      rules". Any OTHER failure means unknown, and unknown is never deleted;
#   9. re-read immediately before acting, B's live tip still equals the SHA
#      checked above (in dry-run too, which also proves the URL-encoded ref
#      path resolves before apply ever relies on it).
# The first rule a branch fails decides its report category: keep/protected,
# open, no-pr, closed-unmerged or merged-but-moved.
#
# In apply mode a branch is deleted with
#   gh api -X DELETE repos/R/git/refs/heads/<urlencoded B>
# where 422 and 404 mean "already gone". Every outcome is then confirmed by
# reading the ref back: a ref that still exists is a failure, never a success.
#
# Exit status: 0 done; 1 some repository could not be read, some deletion
# failed, or the auto-delete setting failed to turn on (nothing unsafe
# happened, but the sweep is incomplete); 2 bad usage or a missing dependency.
# An unknown, unsafe or at_risk auto-delete setting alone does not make the
# exit status 1.
set -euo pipefail

KEEP_RE='^(main|master|develop|staging|test|gh-pages|v[0-9][0-9.]*|deploy-.*|release/.*)$'

fail_usage() {
  echo "::error title=prune-merged-branches::$*"
  exit 2
}

mode=dry-run
scope=""
owner=""
report="branch-prune-report.json"
while [ $# -gt 0 ]; do
  case "$1" in
    --org) scope=org; owner="${2:-}"; shift 2 || fail_usage "--org needs a value" ;;
    --user) scope=user; owner="${2:-}"; shift 2 || fail_usage "--user needs a value" ;;
    --mode) mode="${2:-}"; shift 2 || fail_usage "--mode needs a value" ;;
    --report) report="${2:-}"; shift 2 || fail_usage "--report needs a value" ;;
    -h|--help)
      # The whole leading comment block: usage, permissions and every rule.
      sed -n '2,/^[^#]/{/^#/p;}' "$0"
      exit 0
      ;;
    *) fail_usage "unknown argument '$1'" ;;
  esac
done

# Only the exact word "apply" deletes anything. Anything else is refused
# outright rather than quietly treated as one or the other.
case "${mode}" in
  dry-run|apply) ;;
  *) fail_usage "--mode must be dry-run or apply, not '${mode}'" ;;
esac
[ -n "${scope}" ] && [ -n "${owner}" ] || fail_usage "one of --org NAME or --user NAME is required"
[ -n "${report}" ] || fail_usage "--report must not be empty"

for dep in gh jq; do
  command -v "${dep}" >/dev/null 2>&1 || fail_usage "'${dep}' is required but is not on PATH"
done
if [ -z "${GH_TOKEN:-}" ] && [ -z "${GITHUB_TOKEN:-}" ] && ! gh auth status >/dev/null 2>&1; then
  fail_usage "no GitHub credentials: set GH_TOKEN"
fi

work=$(mktemp -d)
trap 'rm -rf "${work}"' EXIT
: > "${work}/results.jsonl"
: > "${work}/skipped.jsonl"
: > "${work}/unreadable.jsonl"
: > "${work}/settings.jsonl"

# api OUTFILE ARGS... -- gh api, body to OUTFILE. On failure returns 1 and sets
# API_STATUS to the HTTP status (or "error" when there is none) and API_ERROR
# to gh's message. No command substitution, so these survive into the caller.
API_STATUS=""
API_ERROR=""
api() {
  local out="$1"
  shift
  if gh api "$@" > "${out}" 2> "${work}/stderr"; then
    API_STATUS=ok
    API_ERROR=""
    return 0
  fi
  API_STATUS=$(grep -oE 'HTTP [0-9]{3}' "${work}/stderr" | tail -n 1 | cut -d' ' -f2 || true)
  [ -n "${API_STATUS}" ] || API_STATUS=error
  API_ERROR=$(head -c 300 "${work}/stderr" | tr '\n\r' '  ')
  return 1
}

urlencode() { jq -rn --arg v "$1" '$v | @uri'; }

# record JSON -- append one result line.
record() { printf '%s\n' "$1" >> "${work}/results.jsonl"; }

# rules_state REPO ENCODED_BRANCH -> sets RULES to none | deletion | unknown:<why>
rules_state() {
  RULES=""
  if api "${work}/rules.json" --paginate "repos/$1/rules/branches/$2?per_page=100"; then
    local hit
    if hit=$(jq -s 'flatten | any(.[]; .type == "deletion")' "${work}/rules.json" 2>/dev/null); then
      case "${hit}" in
        true) RULES=deletion ;;
        false) RULES=none ;;
        *) RULES="unknown:unexpected rules response" ;;
      esac
    else
      RULES="unknown:unparseable rules response"
    fi
    return 0
  fi
  case "${API_STATUS}" in
    404) RULES=none ;;
    403)
      # Free-plan private repositories cannot have rulesets at all, and the
      # endpoint says so. A 403 for any other reason (a token missing a
      # permission, an SSO block) says nothing about the rules: unknown.
      if grep -qiE 'upgrade to github|make this repository public' "${work}/stderr"; then
        RULES=none
      else
        RULES="unknown:rules endpoint 403: ${API_ERROR}"
      fi
      ;;
    *) RULES="unknown:rules endpoint ${API_STATUS}: ${API_ERROR}" ;;
  esac
}

# live_tip REPO ENCODED_BRANCH -> sets TIP to a SHA, "gone" or "error:<why>"
live_tip() {
  TIP=""
  if api "${work}/ref.json" "repos/$1/git/ref/heads/$2"; then
    TIP=$(jq -r '.object.sha // empty' "${work}/ref.json" 2>/dev/null || true)
    [ -n "${TIP}" ] || TIP="error:ref response had no object.sha"
  elif [ "${API_STATUS}" = 404 ]; then
    TIP=gone
  else
    TIP="error:ref lookup ${API_STATUS}: ${API_ERROR}"
  fi
}

# settings_record REPO STATE DETAIL -- append one auto-delete result line.
# STATE is already_on | enabled | would_enable | unsafe | at_risk | unknown |
# failed.
settings_record() {
  jq -cn --arg repo "$1" --arg state "$2" --arg detail "$3" \
    '{repo: $repo, state: $state, detail: $detail}' >> "${work}/settings.jsonl"
}

# auto_delete_state REPO -> sets AUTO_DELETE to true | false | unknown:<why>
auto_delete_state() {
  AUTO_DELETE=""
  if ! api "${work}/repo.json" "repos/$1"; then
    AUTO_DELETE="unknown:GET repos/$1 ${API_STATUS}: ${API_ERROR}"
    return 0
  fi
  # Only a JSON boolean counts. GitHub leaves merge settings out of the
  # response for a token without Contents: Read and write, and an absent
  # field must not read as "off".
  case "$(jq -r '.delete_branch_on_merge | if type == "boolean" then tostring else "missing" end' \
    "${work}/repo.json" 2>/dev/null || echo unparseable)" in
    true) AUTO_DELETE=true ;;
    false) AUTO_DELETE=false ;;
    missing) AUTO_DELETE="unknown:delete_branch_on_merge not in GET repos/$1 (GitHub returns it only to a token with Contents: Read and write)" ;;
    *) AUTO_DELETE="unknown:unparseable GET repos/$1 response" ;;
  esac
}

# deletion_guard REPO BRANCH PROTECTED -> sets GUARD to safe | unsafe:<why>
# | unknown:<why>: whether GitHub could delete BRANCH (rules in the header).
# PROTECTED is the branch API's `protected` flag, true or false.
deletion_guard() {
  GUARD=""
  local enc classic state
  enc=$(urlencode "$2")
  rules_state "$1" "${enc}"
  if [ "${RULES}" = deletion ]; then
    GUARD=safe
    return 0
  fi
  if [ "$3" != true ]; then
    classic="no branch protection"
  elif api "${work}/protection.json" "repos/$1/branches/${enc}/protection"; then
    state=$(jq -r '
      if (.lock_branch.enabled // false) == true then "locked"
      elif (.allow_deletions.enabled | type) == "boolean" then
        (if .allow_deletions.enabled then "allows" else "blocks" end)
      else "unparseable" end' "${work}/protection.json" 2>/dev/null || echo unparseable)
    case "${state}" in
      locked|blocks)
        GUARD=safe
        return 0
        ;;
      allows) classic="branch protection allows deletions" ;;
      *)
        GUARD="unknown:unparseable branch protection response"
        return 0
        ;;
    esac
  elif [ "${API_STATUS}" = 404 ] && grep -qi 'branch not protected' "${work}/stderr"; then
    # `protected` without a classic rule: rulesets only, and they had no
    # deletion rule above.
    classic="no classic branch protection"
  else
    GUARD="unknown:branch protection ${API_STATUS}: ${API_ERROR}"
    return 0
  fi
  # Classic protection does not stop deletion, so the rulesets decide.
  case "${RULES}" in
    none) GUARD="unsafe:${classic}" ;;
    *) GUARD="unknown:${classic}, and ${RULES#unknown:}" ;;
  esac
}

# long_lived_safety REPO DEFAULT_BRANCH BRANCHES_JSONL -> sets UNSAFE and
# UNVERIFIED to the long-lived branches GitHub's automatic deletion could, or
# might, remove: "name (why), ..." ("" when there are none).
long_lived_safety() {
  UNSAFE=""
  UNVERIFIED=""
  local name protected
  # A file, not a process substitution: if jq fails, set -e stops the run
  # instead of an empty list reading as "no long-lived branches". Git branch
  # names cannot contain a tab.
  jq -r --arg default "$2" --arg keep "${KEEP_RE}" \
    'select(.name != $default and (.name | test($keep))) | "\(.protected == true)\t\(.name)"' \
    "$3" > "${work}/long-lived.tsv"
  while IFS=$'\t' read -r protected name <&5; do
    deletion_guard "$1" "${name}" "${protected}"
    case "${GUARD}" in
      safe) ;;
      unsafe:*) UNSAFE="${UNSAFE:+${UNSAFE}, }${name} (${GUARD#unsafe:})" ;;
      *) UNVERIFIED="${UNVERIFIED:+${UNVERIFIED}, }${name} (${GUARD#unknown:})" ;;
    esac
  done 5< "${work}/long-lived.tsv"
}

# ensure_auto_delete REPO UNSAFE UNVERIFIED -- the auto-delete rules in the
# header, with long_lived_safety's lists. Records exactly one settings line
# for REPO and never fails the sweep by itself.
ensure_auto_delete() {
  local repo="$1" unsafe="$2" unverified="$3" also=""
  [ -z "${unverified}" ] || also="; unverified: ${unverified}"
  auto_delete_state "${repo}"
  case "${AUTO_DELETE}" in
    true)
      if [ -n "${unsafe}" ]; then
        echo "::warning title=prune-merged-branches::${repo}: auto-delete head branches is on but these long-lived branches are not protected from deletion, so merging a pull request from one deletes it: ${unsafe}"
        settings_record "${repo}" at_risk "on; unprotected long-lived branches: ${unsafe}${also}"
      elif [ -n "${unverified}" ]; then
        echo "::warning title=prune-merged-branches::${repo}: auto-delete head branches is on and the deletion protection of these long-lived branches could not be verified: ${unverified}"
        settings_record "${repo}" unknown "on; could not verify deletion protection of: ${unverified}"
      else
        settings_record "${repo}" already_on "on"
      fi
      return 0
      ;;
    false)
      if [ -n "${unsafe}" ]; then
        echo "left off  ${repo}: unprotected long-lived branches: ${unsafe}${also}"
        settings_record "${repo}" unsafe "skipped: unprotected long-lived branches: ${unsafe}${also}"
        return 0
      fi
      if [ -n "${unverified}" ]; then
        echo "::warning title=prune-merged-branches::${repo}: auto-delete head branches left off: the deletion protection of these long-lived branches could not be verified: ${unverified}"
        settings_record "${repo}" unknown "off; not turned on, could not verify deletion protection of: ${unverified}"
        return 0
      fi
      ;;
    *)
      echo "::warning title=prune-merged-branches::${repo}: auto-delete head branches is unknown: ${AUTO_DELETE#unknown:}"
      settings_record "${repo}" unknown "${AUTO_DELETE#unknown:}"
      return 0
      ;;
  esac

  if [ "${mode}" != apply ]; then
    echo "would set ${repo}: delete_branch_on_merge=true"
    settings_record "${repo}" would_enable "off; dry run, not changed"
    return 0
  fi

  # -F sends a JSON boolean, not the string "true".
  if ! api "${work}/patch.json" -X PATCH "repos/${repo}" -F delete_branch_on_merge=true; then
    if [ "${API_STATUS}" = 403 ]; then
      echo "::warning title=prune-merged-branches::${repo}: auto-delete head branches is off and the token may not turn it on (PATCH 403); PRUNE_TOKEN needs Administration: Read and write"
      settings_record "${repo}" unknown "off; PATCH 403, token needs Administration: Read and write: ${API_ERROR}"
    else
      echo "::warning title=prune-merged-branches::${repo}: could not turn on auto-delete head branches: PATCH ${API_STATUS}: ${API_ERROR}"
      settings_record "${repo}" failed "PATCH ${API_STATUS}: ${API_ERROR}"
    fi
    return 0
  fi

  # Read back. GitHub can answer a settings PATCH with 2xx and keep the old
  # value; only the setting itself says it changed.
  auto_delete_state "${repo}"
  if [ "${AUTO_DELETE}" = true ]; then
    echo "enabled   ${repo}: delete_branch_on_merge"
    settings_record "${repo}" enabled "turned on, read back true"
  else
    echo "::warning title=prune-merged-branches::${repo}: PATCH delete_branch_on_merge=true succeeded but the read-back is ${AUTO_DELETE}"
    settings_record "${repo}" failed "PATCH succeeded but read-back is ${AUTO_DELETE}"
  fi
}

echo "prune-merged-branches: ${scope} ${owner}, mode ${mode}"
echo

# ---- repositories ---------------------------------------------------------
if [ "${scope}" = org ]; then
  repos_path="orgs/${owner}/repos?type=all&per_page=100"
else
  repos_path="user/repos?affiliation=owner&per_page=100"
fi
if ! api "${work}/repos.jsonl" --paginate "${repos_path}" \
  --jq '.[] | {full_name, owner: .owner.login, archived, fork, default_branch}'; then
  echo "::error title=prune-merged-branches::could not list repositories (${API_STATUS}): ${API_ERROR}"
  exit 1
fi
jq -c --arg owner "${owner}" 'select((.owner | ascii_downcase) == ($owner | ascii_downcase))' \
  "${work}/repos.jsonl" > "${work}/mine.jsonl"
if [ ! -s "${work}/mine.jsonl" ]; then
  # "The token sees nothing" and "there is nothing" look identical. Refuse to
  # report a clean sweep over an empty list.
  echo "::error title=prune-merged-branches::no repositories returned for ${owner}; the token probably cannot see them"
  exit 1
fi

repos_scanned=0
# Loops read from fd 3 so nothing inside them can swallow the list on stdin.
while IFS= read -r line <&3; do
  repo=$(jq -r '.full_name' <<< "${line}")
  if [ "$(jq -r '.archived' <<< "${line}")" = true ]; then
    jq -cn --arg repo "${repo}" '{repo: $repo, reason: "archived"}' >> "${work}/skipped.jsonl"
    continue
  fi
  if [ "$(jq -r '.fork' <<< "${line}")" = true ]; then
    jq -cn --arg repo "${repo}" '{repo: $repo, reason: "fork"}' >> "${work}/skipped.jsonl"
    continue
  fi
  default_branch=$(jq -r '.default_branch // ""' <<< "${line}")
  repos_scanned=$((repos_scanned + 1))

  # ---- branches and pull requests, fully paginated ------------------------
  if ! api "${work}/branches.jsonl" --paginate "repos/${repo}/branches?per_page=100" \
    --jq '.[] | {name, sha: .commit.sha, protected}'; then
    echo "::warning title=prune-merged-branches::${repo}: could not list branches (${API_STATUS}); nothing in it was considered"
    jq -cn --arg repo "${repo}" --arg why "branches ${API_STATUS}: ${API_ERROR}" '{repo: $repo, reason: $why}' >> "${work}/unreadable.jsonl"
    # Without the branches the long-lived ones cannot be checked, so the
    # setting is neither judged nor changed.
    settings_record "${repo}" unknown "branches could not be listed, so long-lived branches could not be checked"
    continue
  fi

  # ---- "Automatically delete head branches" -------------------------------
  # Before the pull requests, so a repository whose pull requests cannot be
  # listed (or that has no branches) still gets the setting checked.
  long_lived_safety "${repo}" "${default_branch}" "${work}/branches.jsonl"
  ensure_auto_delete "${repo}" "${UNSAFE}" "${UNVERIFIED}"

  [ -s "${work}/branches.jsonl" ] || { echo "empty     ${repo}"; continue; }

  if ! api "${work}/prs.jsonl" --paginate "repos/${repo}/pulls?state=all&per_page=100" \
    --jq '.[] | {number, state, merged_at, head_ref: .head.ref, head_sha: .head.sha, head_repo: (.head.repo.full_name // null), base_ref: .base.ref}'; then
    echo "::warning title=prune-merged-branches::${repo}: could not list pull requests (${API_STATUS}); nothing in it was considered"
    jq -cn --arg repo "${repo}" --arg why "pulls ${API_STATUS}: ${API_ERROR}" '{repo: $repo, reason: $why}' >> "${work}/unreadable.jsonl"
    continue
  fi

  # Last commit dates, one GraphQL page per hundred branches. Informational
  # only: a failure here leaves dates "unknown" and decides nothing.
  # shellcheck disable=SC2016 # GraphQL variables, not shell
  if ! api "${work}/dates.jsonl" graphql --paginate -f owner="${repo%%/*}" -f name="${repo#*/}" -f query='
    query($owner: String!, $name: String!, $endCursor: String) {
      repository(owner: $owner, name: $name) {
        refs(refPrefix: "refs/heads/", first: 100, after: $endCursor) {
          pageInfo { hasNextPage endCursor }
          nodes { name target { ... on Commit { committedDate } } }
        }
      }
    }' --jq '.data.repository.refs.nodes[] | {name, date: (.target.committedDate // null)}'; then
    echo "::notice title=prune-merged-branches::${repo}: last-commit dates unavailable (${API_STATUS})"
    : > "${work}/dates.jsonl"
  fi

  # ---- static checks, rules 2-7 ------------------------------------------
  jq -c -n --arg repo "${repo}" --arg default "${default_branch}" --arg keep "${KEEP_RE}" \
    --slurpfile branches "${work}/branches.jsonl" --slurpfile prs "${work}/prs.jsonl" \
    --slurpfile dates "${work}/dates.jsonl" '
    ($dates | map({key: .name, value: .date}) | from_entries) as $when
    | $prs as $p
    | $branches[] as $b
    | ($p | map(select(.head_ref == $b.name and .head_repo == $repo))) as $own
    | ($p | map(select(.state == "open" and (.head_ref == $b.name or .base_ref == $b.name)))) as $open
    | ($own | map(select(.merged_at != null))) as $merged
    | ($merged | map(select(.head_sha == $b.sha)) | sort_by(.merged_at) | last) as $match
    | {repo: $repo, branch: $b.name, sha: $b.sha, last_commit: ($when[$b.name] // "unknown")}
      + if $b.name == $default then {category: "keep/protected", reason: "default branch"}
        elif ($b.name | test($keep)) then {category: "keep/protected", reason: "matches keep pattern"}
        elif $b.protected then {category: "keep/protected", reason: "protected branch"}
        elif ($open | length) > 0 then {category: "open", reason: ("open PR " + ($open | map("#\(.number) (\(if .head_ref == $b.name then "head" else "base" end))") | join(", ")))}
        elif ($own | length) == 0 then {category: "no-pr", reason: "no pull request from this branch"}
        elif ($merged | length) == 0 then {category: "closed-unmerged", reason: ("closed without merging: " + ($own | map("#\(.number)") | join(", ")))}
        elif $match == null then {category: "merged-but-moved", reason: ("merged as " + ($merged | map("#\(.number) at \(.head_sha[0:7])") | join(", ")) + ", tip is now " + $b.sha[0:7])}
        else {category: "candidate", pr: $match.number, merged_at: $match.merged_at, reason: "merged in #\($match.number) at its current tip"}
        end' > "${work}/classified.jsonl"

  # ---- live checks, rules 8-9, and the deletion itself --------------------
  while IFS= read -r rec <&4; do
    category=$(jq -r '.category' <<< "${rec}")
    branch=$(jq -r '.branch' <<< "${rec}")
    if [ "${category}" != candidate ]; then
      record "${rec}"
      continue
    fi
    sha=$(jq -r '.sha' <<< "${rec}")
    enc=$(urlencode "${branch}")

    rules_state "${repo}" "${enc}"
    case "${RULES}" in
      none) ;;
      deletion)
        record "$(jq -c '.category = "keep/protected" | .reason = "ruleset deletion rule" | del(.pr, .merged_at)' <<< "${rec}")"
        continue
        ;;
      *)
        echo "::warning title=prune-merged-branches::${repo}:${branch}: ${RULES#unknown:} -- kept"
        record "$(jq -c --arg why "rules unknown (${RULES#unknown:})" '.category = "keep/protected" | .reason = $why | del(.pr, .merged_at)' <<< "${rec}")"
        continue
        ;;
    esac

    live_tip "${repo}" "${enc}"
    if [ "${TIP}" != "${sha}" ]; then
      case "${TIP}" in
        gone) why="ref not found on re-read (deleted meanwhile, or the ref path did not resolve)"; cat_=keep/protected ;;
        error:*) why="could not re-read tip: ${TIP#error:}"; cat_=keep/protected ;;
        *) why="tip moved during the run (${sha:0:7} -> ${TIP:0:7})"; cat_=merged-but-moved ;;
      esac
      record "$(jq -c --arg c "${cat_}" --arg why "${why}" '.category = $c | .reason = $why | del(.pr, .merged_at)' <<< "${rec}")"
      continue
    fi

    if [ "${mode}" != apply ]; then
      echo "would rm  ${repo}:${branch} (${sha:0:7}, #$(jq -r '.pr' <<< "${rec}"))"
      record "$(jq -c '.category = "deletable" | .result = "would-delete"' <<< "${rec}")"
      continue
    fi

    if api "${work}/del.json" -X DELETE "repos/${repo}/git/refs/heads/${enc}"; then
      outcome=deleted
    elif [ "${API_STATUS}" = 422 ] || [ "${API_STATUS}" = 404 ]; then
      outcome=already-gone
    else
      outcome="failed: DELETE ${API_STATUS}: ${API_ERROR}"
    fi
    # Read back. A 2xx (or a 404/422) is a claim; the ref being absent is the
    # evidence.
    live_tip "${repo}" "${enc}"
    if [ "${TIP}" != gone ] && [ "${outcome#failed}" = "${outcome}" ]; then
      outcome="failed: ref still present after ${outcome} (${TIP})"
    fi
    case "${outcome}" in
      failed*) echo "::warning title=prune-merged-branches::${repo}:${branch}: ${outcome}"; result=failed ;;
      *) echo "${outcome}  ${repo}:${branch}"; result="${outcome}" ;;
    esac
    record "$(jq -c --arg r "${result}" --arg d "${outcome}" '.category = "deletable" | .result = $r | .detail = $d' <<< "${rec}")"
  done 4< "${work}/classified.jsonl"
done 3< "${work}/mine.jsonl"

# ---- report ----------------------------------------------------------------
jq -n --arg mode "${mode}" --arg scope "${scope}" --arg owner "${owner}" --arg keep "${KEEP_RE}" \
  --argjson scanned "${repos_scanned}" \
  --slurpfile results "${work}/results.jsonl" \
  --slurpfile skipped "${work}/skipped.jsonl" \
  --slurpfile unreadable "${work}/unreadable.jsonl" \
  --slurpfile settings "${work}/settings.jsonl" '
  ($results | map(select(.category == "deletable")) | sort_by(.repo, .branch)) as $del
  | ($results | map(select(.category != "deletable")) | sort_by(.category, .repo, .branch)) as $keep
  | ($settings | sort_by(.repo)) as $set
  | def n($s): $set | map(select(.state == $s)) | length;
  {
      generated_at: (now | todate),
      mode: $mode, scope: $scope, owner: $owner, keep_pattern: $keep,
      counts: {
        repos_scanned: $scanned,
        repos_skipped: ($skipped | length),
        repos_unreadable: ($unreadable | length),
        deletable: ($del | length),
        deleted: ($del | map(select(.result == "deleted")) | length),
        already_gone: ($del | map(select(.result == "already-gone")) | length),
        failed: ($del | map(select(.result == "failed")) | length),
        report_only: ($keep | group_by(.category) | map({key: .[0].category, value: length}) | from_entries),
        settings: {
          already_on: n("already_on"),
          enabled: n("enabled"),
          would_enable: n("would_enable"),
          unsafe: n("unsafe"),
          at_risk: n("at_risk"),
          unknown: n("unknown"),
          failed: n("failed")
        }
      },
      deletable: $del,
      report_only: $keep,
      settings: $set,
      repos_skipped: $skipped,
      repos_unreadable: $unreadable
    }' > "${report}"

summary="${GITHUB_STEP_SUMMARY:-/dev/stdout}"
jq -r '
  def cell: tostring | gsub("\\|"; "\\|") | gsub("\n"; " ");
  "### Merged-branch prune (\(.mode))",
  "",
  "`\(.scope)` **\(.owner)** -- \(.counts.repos_scanned) repositories scanned, \(.counts.repos_skipped) skipped (archived/fork), \(.counts.repos_unreadable) unreadable.",
  (if .mode == "apply" then "" else "Dry run: nothing was deleted or changed." end),
  "",
  "| Category | Branches |",
  "|---|---:|",
  "| deletable | \(.counts.deletable) |",
  (.counts.report_only | to_entries[] | "| \(.key) | \(.value) |"),
  "",
  (if .counts.deletable > 0 then
     "#### Deletable",
     "",
     "| Repository | Branch | PR | Last commit | Result |",
     "|---|---|---|---|---|",
     (.deletable[] | "| \(.repo | cell) | \(.branch | cell) | #\(.pr) | \(.last_commit | cell) | \(.result | cell) |"),
     ""
   else "No branch meets every rule.", "" end),
  (if (.repos_unreadable | length) > 0 then
     "#### Unreadable repositories (not swept)",
     "",
     (.repos_unreadable[] | "- \(.repo | cell): \(.reason | cell)"),
     ""
   else empty end),
  "#### Auto-delete head branches",
  "",
  "GitHub deletes a pull request'"'"'s head branch when it is merged once `delete_branch_on_merge` is on, so this sweep only has the backlog to clear. GitHub does not apply the keep pattern: only a branch protection rule that forbids deletion, or a ruleset deletion rule, stops it. So the setting is only turned on where every long-lived branch (keep pattern, not the default branch) is verifiably protected from deletion. **unsafe**: left off until those branches are protected. **at_risk**: already on, and merging a pull request from one of the named branches deletes it. **unknown** also covers branches whose protection could not be read; the setting is never turned on over them.",
  "",
  "| Setting | Repositories |",
  "|---|---:|",
  (.counts.settings | to_entries[] | "| \(.key) | \(.value) |"),
  "",
  (if (.settings | map(select(.state != "already_on")) | length) > 0 then
     "| Repository | State | Detail |",
     "|---|---|---|",
     (.settings[] | select(.state != "already_on") | "| \(.repo | cell) | \(.state) | \(.detail | cell) |"),
     ""
   else "On in every scanned repository.", "" end),
  (if .counts.settings.unknown > 0 then
     "Unknown means the setting, or a long-lived branch'"'"'s protection, could not be read, or the setting could not be changed for lack of permission. `PRUNE_TOKEN` needs **Administration: Read and write** to read branch protection and turn the setting on, and **Contents: Read and write** to read the setting.",
     ""
   else empty end),
  "<details><summary>Report only (\(.report_only | length))</summary>",
  "",
  "| Repository | Branch | Category | Reason | Last commit |",
  "|---|---|---|---|---|",
  (.report_only[] | "| \(.repo | cell) | \(.branch | cell) | \(.category) | \(.reason | cell) | \(.last_commit | cell) |"),
  "",
  "</details>",
  ""' "${report}" >> "${summary}"

counts=$(jq -c '.counts' "${report}")
echo
echo "counts: ${counts}"
echo "report: ${report}"

# Unknown settings warn, once here and per repository above, but never fail
# the run: the branch sweep is still complete, and nothing was turned on.
if [ "$(jq '.counts.settings.unknown' "${report}")" -gt 0 ]; then
  echo "::warning title=prune-merged-branches::auto-delete head branches unknown on $(jq -r '.counts.settings.unknown' "${report}") repositories (the setting or a long-lived branch's protection could not be read, or the setting could not be changed); PRUNE_TOKEN needs Administration: Read and write to read branch protection and turn it on, and Contents: Read and write to read it"
fi
if [ "$(jq '.counts.repos_unreadable + .counts.failed + .counts.settings.failed' "${report}")" -gt 0 ]; then
  echo "::error title=prune-merged-branches::incomplete: $(jq -r '.counts.repos_unreadable' "${report}") repositories unreadable, $(jq -r '.counts.failed' "${report}") deletions failed, $(jq -r '.counts.settings.failed' "${report}") auto-delete settings failed to turn on"
  exit 1
fi
