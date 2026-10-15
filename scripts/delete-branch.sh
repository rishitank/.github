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
#      that commit. This narrows, but cannot close, the window in which a push
#      lands between the check and the DELETE: the REST delete has no
#      precondition on the old SHA;
#   3. the branch is not the repository's default branch and does not match
#      KEEP_RE, the long-lived pattern prune-merged-branches.sh also keeps;
#   4. GitHub does not report the branch as protected;
#   5. no open pull request uses it as its head or as its base. The head check
#      asks GraphQL for the open pull requests whose head is this ref, in any
#      repository of the fork network the token can read (the parent, the
#      source or a public sibling fork; someone else's private fork is
#      invisible to it), then also lists them over REST in this repository and
#      in its parent and source. Pull requests into a branch can only live in
#      the branch's own repository, so the base check asks only there. Any
#      query that fails refuses the deletion.
# A branch that is already gone is reported and is not an error. The default
# mode is dry-run: it makes every check and reports what it would delete.
#
# Token (GH_TOKEN, used by gh): read the repository, its branches and pull
# requests, and delete refs (Contents: Read and write, Pull requests:
# Read-only). The workflow passes PRUNE_TOKEN.
set -euo pipefail

KEEP_RE='^(main|master|develop|staging|test|gh-pages|v[0-9][0-9.]*|deploy-.*|release/.*)$'

# fail MESSAGE: report a refused check in the log and the job summary, exit 1.
fail() {
  echo "::error title=delete-branch::$1"
  summary "Refused" "$1"
  exit 1
}

# usage_error MESSAGE: report a malformed command line and exit 2, like the prune.
usage_error() {
  echo "::error title=delete-branch::$1"
  exit 2
}

# clean VALUE: print VALUE without CR, LF or backticks. Inputs are echoed into
# logs and the job summary before they are validated: a newline would let a
# value start its own workflow command line.
clean() { local v="${1//[$'\n\r']/ }"; printf '%s' "${v//\`/\'}"; }

# summary TITLE TEXT: append the inputs and TEXT to the job summary, if any.
summary() {
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    {
      echo "### delete-branch: $1"
      echo
      echo "- Repository: \`$(clean "${repo:-?}")\`"
      echo "- Branch: \`$(clean "${branch:-?}")\`"
      echo "- Expected tip: \`$(clean "${sha:-?}")\`"
      echo "- Mode: \`$(clean "${mode:-?}")\`"
      echo
      echo "$2"
    } >> "${GITHUB_STEP_SUMMARY}"
  fi
}

# urlencode VALUE: percent-encode VALUE for one URL path or query component.
urlencode() { jq -rn --arg v "$1" '$v | @uri'; }

owner="" repo="" branch="" sha="" mode="dry-run"
while [ $# -gt 0 ]; do
  case "$1" in
    --owner|--repo|--branch|--sha|--mode)
      [ $# -ge 2 ] || usage_error "$1 needs a value"
      case "$1" in
        --owner) owner="$2" ;;
        --repo) repo="$2" ;;
        --branch) branch="$2" ;;
        --sha) sha="$2" ;;
        --mode) mode="$2" ;;
      esac
      shift 2 ;;
    -h|--help) sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) usage_error "unknown argument: $(clean "$1")" ;;
  esac
done

case "${mode}" in
  dry-run|apply) ;;
  *) fail "mode must be dry-run or apply, not '$(clean "${mode}")'" ;;
esac
[[ "${owner}" =~ ^[A-Za-z0-9-]+$ ]] || fail "--owner is missing or not a GitHub account name"
[[ "${repo}" =~ ^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$ ]] || fail "repository must be owner/name, got '$(clean "${repo}")'"
# GitHub account names are case-insensitive.
repo_owner="${repo%%/*}"
[ "${repo_owner,,}" = "${owner,,}" ] || fail "repository ${repo} does not belong to ${owner}"
[[ "${sha}" =~ ^[0-9a-f]{40}$ ]] || fail "sha must be a full 40-character lowercase commit SHA"
if [[ ! "${branch}" =~ ^[A-Za-z0-9._/@+-]+$ ]] || [[ "${branch}" == -* ]] || [[ "${branch}" == /* ]] \
  || [[ "${branch}" == */ ]] || [[ "${branch}" == *..* ]] || [[ "${branch}" == *//* ]] \
  || [[ "${branch}" == *.lock ]] || [[ "${branch}" == *@\{* ]]; then
  fail "'$(clean "${branch}")' is not a branch name this workflow accepts"
fi
if [[ "${branch}" =~ ${KEEP_RE} ]]; then
  fail "${branch} matches the long-lived pattern and is never deleted here"
fi

meta="$(gh api "repos/${repo}")" || fail "cannot read repos/${repo}"
# gh follows redirects: a renamed or transferred repository must not pass as this one.
full_name="$(jq -r '.full_name // empty' <<<"${meta}")"
[ "${full_name,,}" = "${repo,,}" ] || fail "repos/${repo} resolved to '${full_name}' (renamed or transferred?)"
default_branch="$(jq -r '.default_branch // empty' <<<"${meta}")"
[ -n "${default_branch}" ] || fail "repos/${repo} returned no default branch"
# A fork branch's pull requests usually live in its parent (or source) repository.
upstreams="$(jq -r '[.parent.full_name, .source.full_name] | map(select(. != null)) | unique | .[]' <<<"${meta}")"
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
# gh follows the redirect for a renamed branch: the name must match exactly.
name="$(jq -r '.name // empty' <<<"${info}")"
[ "${name}" = "${branch}" ] || fail "branch ${branch} in ${repo} resolved to '${name}' (renamed?)"
tip="$(jq -r '.commit.sha // empty' <<<"${info}")"
# Not `.protected // empty`: jq's // treats false as missing.
protected="$(jq -r 'if .protected == null then "" else (.protected | tostring) end' <<<"${info}")"
[ -n "${tip}" ] || fail "branch ${branch} in ${repo} returned no tip commit"
[ "${tip}" = "${sha}" ] || fail "${branch} in ${repo} points at ${tip}, not ${sha}: it has moved since you looked"
[ "${protected}" = "false" ] || fail "${branch} in ${repo} is protected (protected=${protected:-unknown})"

# Every open pull request whose head is this ref, whichever repository of the
# fork network it was opened in, as far as the token can see (someone else's
# private fork is invisible). A sibling fork's /pulls is not listable here.
# shellcheck disable=SC2016 # $owner, $name and $ref are GraphQL variables.
gql='query($owner: String!, $name: String!, $ref: String!) {
  repository(owner: $owner, name: $name) {
    ref(qualifiedName: $ref) { associatedPullRequests(states: OPEN, first: 1) { totalCount } }
  }
}'
open_any="$(gh api graphql -f query="${gql}" -f owner="${repo%%/*}" -f name="${repo#*/}" \
  -f ref="refs/heads/${branch}" --jq '.data.repository.ref.associatedPullRequests.totalCount' 2>&1)" \
  || fail "cannot ask GraphQL for open pull requests from ${branch}: $(clean "${open_any}")"
[[ "${open_any}" =~ ^[0-9]+$ ]] || fail "GraphQL returned no pull request count for ${branch} (got '$(clean "${open_any}")')"
[ "${open_any}" = "0" ] || fail "${open_any} open pull request(s) in the fork network use ${repo}:${branch} as their head (GraphQL)"
open_head="$(gh api "repos/${repo}/pulls?state=open&per_page=1&head=$(urlencode "${owner}:${branch}")" --jq 'length')" \
  || fail "cannot list open pull requests from ${branch}"
[ "${open_head}" = "0" ] || fail "an open pull request in ${repo} uses ${branch} as its head"
open_base="$(gh api "repos/${repo}/pulls?state=open&per_page=1&base=${enc}" --jq 'length')" \
  || fail "cannot list open pull requests into ${branch}"
[ "${open_base}" = "0" ] || fail "an open pull request in ${repo} targets ${branch}"
for up in ${upstreams}; do
  open_up="$(gh api "repos/${up}/pulls?state=open&per_page=1&head=$(urlencode "${owner}:${branch}")" --jq 'length')" \
    || fail "cannot list open pull requests in ${up}"
  [ "${open_up}" = "0" ] || fail "an open pull request in ${up} uses ${owner}:${branch} as its head"
done

if [ "${mode}" = "dry-run" ]; then
  echo "dry-run: would delete ${repo} ${branch} at ${tip}."
  summary "Would delete (dry run)" "Every check passed. Run again with \`mode: apply\` to delete it."
  exit 0
fi

gh api -X DELETE "repos/${repo}/git/refs/heads/${enc}" >/dev/null \
  || fail "DELETE refs/heads/${branch} in ${repo} failed"
# Only a 404 proves it is gone; any other failure is unknown, not success. A
# short retry covers a read that briefly still sees the branch.
for attempt in 1 2 3; do
  if gone="$(gh api "repos/${repo}/branches/${enc}" 2>&1)"; then
    [ "${attempt}" -lt 3 ] || fail "${branch} still exists in ${repo} after the DELETE"
    sleep "${READBACK_SLEEP:-2}"
    continue
  fi
  grep -q 'HTTP 404' <<<"${gone}" && break
  fail "DELETE sent, but the read-back of ${branch} in ${repo} failed: ${gone}"
done
echo "Deleted ${repo} ${branch} (was ${tip})."
summary "Deleted" "Deleted. To restore it: \`gh api repos/${repo}/git/refs -f ref=refs/heads/${branch} -f sha=${tip}\`."
