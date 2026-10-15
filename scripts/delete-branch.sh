#!/usr/bin/env bash
# Deletes ONE named branch in ONE repository owned by this account, on demand,
# after the same kind of checks the nightly prune makes. It exists for the
# branches the prune never touches: a fork's branch whose pull request was
# merged upstream, or a branch whose pull request was closed without merging.
#
#   delete-branch.sh --owner OWNER --repo OWNER/NAME --branch BRANCH \
#                    --sha FULL_SHA [--mode dry-run|apply]
#
# Nothing is deleted, and the run fails, unless every check holds:
#   1. the repository belongs to --owner;
#   2. --sha is a full 40-character commit SHA and the branch's tip is exactly
#      that commit, so work pushed after you looked is never deleted;
#   3. the branch is not the repository's default branch and does not match
#      KEEP_RE, the long-lived pattern prune-merged-branches.sh also keeps;
#   4. GitHub does not report the branch as protected;
#   5. no open pull request uses it as its head or as its base.
# A branch that is already gone is reported and is not an error. The default
# mode is dry-run: it makes every check and reports what it would delete.
#
# Token (GH_TOKEN, used by gh): read the repository, its branches and pull
# requests, and delete refs (Contents: Read and write, Pull requests:
# Read-only). The workflow passes PRUNE_TOKEN.
set -euo pipefail

KEEP_RE='^(main|master|develop|staging|test|gh-pages|v[0-9][0-9.]*|deploy-.*|release/.*)$'

fail() {
  echo "::error title=delete-branch::$1"
  summary "Refused" "$1"
  exit 1
}

summary() {
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    {
      echo "### delete-branch: $1"
      echo
      echo "- Repository: \`${repo:-?}\`"
      echo "- Branch: \`${branch:-?}\`"
      echo "- Expected tip: \`${sha:-?}\`"
      echo "- Mode: \`${mode:-?}\`"
      echo
      echo "$2"
    } >> "${GITHUB_STEP_SUMMARY}"
  fi
}

urlencode() { jq -rn --arg v "$1" '$v | @uri'; }

owner="" repo="" branch="" sha="" mode="dry-run"
while [ $# -gt 0 ]; do
  case "$1" in
    --owner) owner="${2-}"; shift 2 ;;
    --repo) repo="${2-}"; shift 2 ;;
    --branch) branch="${2-}"; shift 2 ;;
    --sha) sha="${2-}"; shift 2 ;;
    --mode) mode="${2-}"; shift 2 ;;
    -h|--help) sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "::error title=delete-branch::unknown argument: $1"; exit 2 ;;
  esac
done

case "${mode}" in
  dry-run|apply) ;;
  *) fail "mode must be dry-run or apply, not '${mode}'" ;;
esac
[[ "${owner}" =~ ^[A-Za-z0-9-]+$ ]] || fail "--owner is missing or not a GitHub account name"
[[ "${repo}" =~ ^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$ ]] || fail "repository must be owner/name, got '${repo}'"
[ "${repo%%/*}" = "${owner}" ] || fail "repository ${repo} does not belong to ${owner}"
[[ "${sha}" =~ ^[0-9a-f]{40}$ ]] || fail "sha must be a full 40-character lowercase commit SHA"
if [[ ! "${branch}" =~ ^[A-Za-z0-9._/@+-]+$ ]] || [[ "${branch}" == -* ]] || [[ "${branch}" == /* ]] \
  || [[ "${branch}" == */ ]] || [[ "${branch}" == *..* ]] || [[ "${branch}" == *//* ]] \
  || [[ "${branch}" == *.lock ]] || [[ "${branch}" == *@\{* ]]; then
  fail "'${branch}' is not a branch name this workflow accepts"
fi
if [[ "${branch}" =~ ${KEEP_RE} ]]; then
  fail "${branch} matches the long-lived pattern and is never deleted here"
fi

default_branch="$(gh api "repos/${repo}" --jq .default_branch)" || fail "cannot read repos/${repo}"
[ -n "${default_branch}" ] || fail "repos/${repo} returned no default branch"
[ "${branch}" != "${default_branch}" ] || fail "${branch} is the default branch of ${repo}"

enc="$(urlencode "${branch}")"
if ! info="$(gh api "repos/${repo}/branches/${enc}" 2>&1)"; then
  if grep -q 'HTTP 404' <<<"${info}"; then
    echo "${repo}: ${branch} does not exist (already deleted)."
    summary "Already gone" "The branch does not exist, so there was nothing to delete."
    exit 0
  fi
  fail "cannot read ${repo} branch ${branch}: ${info}"
fi
tip="$(jq -r '.commit.sha // empty' <<<"${info}")"
# Not `.protected // empty`: jq's // treats false as missing.
protected="$(jq -r 'if .protected == null then "" else (.protected | tostring) end' <<<"${info}")"
[ -n "${tip}" ] || fail "branch ${branch} in ${repo} returned no tip commit"
[ "${tip}" = "${sha}" ] || fail "${branch} in ${repo} points at ${tip}, not ${sha}: it has moved since you looked"
[ "${protected}" = "false" ] || fail "${branch} in ${repo} is protected (protected=${protected:-unknown})"

open_head="$(gh api "repos/${repo}/pulls?state=open&per_page=1&head=$(urlencode "${owner}:${branch}")" --jq 'length')" \
  || fail "cannot list open pull requests from ${branch}"
[ "${open_head}" = "0" ] || fail "an open pull request in ${repo} uses ${branch} as its head"
open_base="$(gh api "repos/${repo}/pulls?state=open&per_page=1&base=${enc}" --jq 'length')" \
  || fail "cannot list open pull requests into ${branch}"
[ "${open_base}" = "0" ] || fail "an open pull request in ${repo} targets ${branch}"

if [ "${mode}" = "dry-run" ]; then
  echo "dry-run: would delete ${repo} ${branch} at ${tip}."
  summary "Would delete (dry run)" "Every check passed. Run again with \`mode: apply\` to delete it."
  exit 0
fi

gh api -X DELETE "repos/${repo}/git/refs/heads/${enc}" >/dev/null \
  || fail "DELETE refs/heads/${branch} in ${repo} failed"
if gh api "repos/${repo}/branches/${enc}" >/dev/null 2>&1; then
  fail "${branch} still exists in ${repo} after the DELETE"
fi
echo "Deleted ${repo} ${branch} (was ${tip})."
summary "Deleted" "Deleted. To restore it: \`gh api repos/${repo}/git/refs -f ref=refs/heads/${branch} -f sha=${tip}\`."
