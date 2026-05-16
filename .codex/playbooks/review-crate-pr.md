# Review Crate PR Playbook

## Purpose
Review a Crate pull request for merge readiness into `v2.4.x`, with special attention to changed files, relevant tests, watcher/package/parser risk, and whether Bryant can safely approve merge.

## When To Use
- Before Bryant merges any Crate PR.
- When a PR has new commits after an earlier review.
- When CI fails or a reviewer asks for a targeted risk check.
- When verifying that a branch is ready but not yet approved for merge.

## Start Prompt
Use a prompt like:

```text
Use .codex/playbooks/review-crate-pr.md to review PR <number> for Crate. Confirm the base is v2.4.x, inspect changed files, run relevant tests, call out risks, and do not merge.
```

## Inspect
- PR base branch is `v2.4.x`.
- PR head branch, draft state, review state, mergeability, and failing or pending checks.
- Full changed file list and diff.
- Changes touching `main.js`, `preload.js`, `renderer/`, `parsers/`, `scripts/`, `tests/`, `package.json`, `package-lock.json`, `crate-site/`, or release assets.
- Watcher behavior, package filtering, parser behavior, and Figma scope enforcement.
- Unrelated changes to Photoshop, Illustrator, InDesign, generic watchers, package filtering, or Figma parser behavior.
- Test coverage for changed behavior and obvious missing regression tests.

## Commands Codex May Run
```sh
git status --short --branch
git branch --show-current
git fetch origin
gh pr view <pr> --json baseRefName,headRefName,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup
gh pr diff <pr> --name-only
gh pr diff <pr>
npm test
npm run test
```

Prefer the narrowest relevant test command if the repo has focused tests for the changed area.

## Commands Requiring Explicit Bryant Approval
```sh
gh pr merge <pr>
git push
git commit
git checkout -- <file>
git reset
npm install
npm audit fix
npx electron-builder --mac --arm64
npx wrangler pages deploy
```

Any destructive command, dependency mutation, release build, deploy, or merge requires explicit Bryant approval.

## Definition Of Done
- Confirmed PR base is `v2.4.x`.
- Confirmed PR branch mergeability and review/check status.
- Inspected changed files and summarized behavior changes.
- Ran relevant tests or clearly explained why tests were not run.
- Called out watcher/package/parser/Figma risks.
- Identified unrelated changes, if any.
- Gave a clear merge readiness recommendation.
- Did not merge unless Bryant explicitly approved.

## Report Format
- PR and branch status.
- Changed files inspected.
- Tests or checks run, including exact commands.
- Findings ordered by severity with file references.
- Watcher/package/parser/Figma risks.
- Merge recommendation and whether Bryant can proceed.

## Risk Checklist
- PR targets `main` instead of `v2.4.x`.
- Mergeability is unknown, blocked, or dirty.
- Package files changed without an explicit dependency reason.
- Watchers scan too broadly or trigger unintended apps.
- Parser changes alter package output unexpectedly.
- Figma behavior loses Current Page Only default or Entire File opt-in.
- Page lock failures become permissive instead of fail-closed.
- Tests are missing for changed capture, parser, or package behavior.
- Release files or site links changed inside a feature PR without scope.
