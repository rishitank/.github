# The review gate

Nothing reaches a default branch here without a reviewed pull request. Each
repository carries a `review-gate` ruleset that requires:

- **CodeRabbit's approval of the latest commit.** CodeRabbit approves once its
  comments are resolved (its Request Changes Workflow is on). A push after
  approval drops it, so the approval always covers the code that merges.
- **Every review conversation resolved.**
- **Green checks** on a branch that is up to date with its base: the
  `CodeRabbit` status, pinned to the CodeRabbit app so a workflow can't fake
  it, plus the repository's own CI.
- **No bypass for people**, admins included. An agent working with the
  owner's token is bound by it like everyone else.
- Squash merges only; no force-pushes to, or deletion of, the default branch.

## The loop for every pull request

1. Open the PR and wait for CodeRabbit's review. Don't merge while its status
   says "Review in progress".
2. For each comment, fix it or reply with the reason it doesn't apply.
3. Push. CodeRabbit re-reviews, and resolves threads it agrees are fixed.
4. Repeat until CodeRabbit approves and no thread is open. Only then merge.

## Commands that would defeat the gate

Anyone who can comment on a PR can run these, including an agent working
with the owner's token. They skip the loop, so agents never use them:

- `@coderabbitai approve` resolves every thread and approves in one step,
  whether or not anything was fixed.
- `@coderabbitai resolve` marks every CodeRabbit comment resolved.

If CodeRabbit is wrong about something, reply in the thread and say why. It
resolves the thread itself when it agrees.

## Limits worth knowing

- **A ruleset can't name CodeRabbit as the reviewer.** `required_reviewers`
  accepts teams only. On a PR the owner opened, the owner can't approve, so
  CodeRabbit's is the only approval that counts. On a PR someone else opened
  (Dependabot, say), the owner's approval also counts.
- **CodeRabbit won't review bot PRs** ("bot user not eligible"), so Dependabot
  PRs need the owner's approval.
- **The `CodeRabbit` status isn't proof of review.** It turns green when a
  review is skipped or rate limited too. The approval is the proof.
- **Private repositories need GitHub Pro** for rulesets. On Free, only public
  repositories can carry the gate.
- **An admin token can still edit or delete a ruleset.** The gate stops merges,
  not someone determined to remove it.

The policy and the reconciler that applies it live in the TanksterAI
organisation's `.github` repository (`settings.yml`).
