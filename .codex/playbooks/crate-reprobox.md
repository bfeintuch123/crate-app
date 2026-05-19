# Crate Reprobox Playbook

## Purpose
Create a small, reproducible investigation envelope for a Crate bug, regression, or PR using a known source revision, isolated temp workspace, focused fixtures, exact commands, and captured environment context.

This is the Crate-sized version of a reproducibility loop: preserve the local working tree, isolate the repro from personal state where possible, and make the result repeatable enough that Bryant or a later Codex session can rerun it.

## When To Use
- When a regression cannot be reproduced reliably in the active working tree.
- When a PR passes focused tests but Bryant wants a cleaner reproduction record.
- When package or provenance output needs to be compared across two revisions.
- Before release readiness when a recent bug needs a deterministic repro or non-repro record.
- When active app/test edits exist and Codex should avoid disturbing them.

## Start Prompt
Use a prompt like:

```text
Use .codex/playbooks/crate-reprobox.md to create a read-only reprobox for this Crate issue. Capture branch, SHA, dirty state, environment, focused commands, and temp-workspace results. Do not touch app code, tests, package files, release steps, or active provenance work.
```

## Inspect
- Current branch, SHA, and whether the branch is based on `v2.4.x`.
- Dirty working tree and whether uncommitted changes are part of the repro.
- Node and npm versions.
- Dependency state without mutating dependencies.
- The smallest fixture, project state, or command sequence needed to reproduce the issue.
- Whether the repro needs real user project files, credentials, Figma tokens, Apple signing credentials, or GUI interaction. If so, stop and ask Bryant before proceeding.

## Files Codex May Read
- `AGENTS.md`
- `.codex/playbooks/*.md`
- `docs/*.md`
- `README.md`
- `package.json` and `package-lock.json` read-only
- focused changed files needed to understand the repro
- focused tests and fixtures needed to run the repro
- PR metadata and diffs through `gh`

## Files Codex May Modify
- Temporary files under `/private/tmp/crate-reprobox-*`.
- A temporary local clone under `/private/tmp/crate-reprobox-*/repo`.
- A temporary isolated home under `/private/tmp/crate-reprobox-*/home`.
- A temporary patch file under `/private/tmp/crate-reprobox-*/worktree.patch` when uncommitted changes are intentionally included.

## Files Codex Must Not Modify
- Any tracked app source file.
- `main.js`
- `tests/`
- `package.json`
- `package-lock.json`
- release artifacts
- `crate-site/`
- active provenance PR work

## Commands Codex May Run
Capture the source and environment:

```sh
git status --short --branch
git branch --show-current
git rev-parse HEAD
git rev-parse --short HEAD
git diff --name-only
git diff --stat
node -v
npm -v
npm ls --depth=0
```

Create a temp reprobox when a clean committed revision is enough. Replace `<id>` with a short issue or SHA label:

```sh
mkdir -p /private/tmp/crate-reprobox-<id>
git clone --local /Users/bryantfeintuchclaw/Projects /private/tmp/crate-reprobox-<id>/repo
git -C /private/tmp/crate-reprobox-<id>/repo checkout --detach <sha>
mkdir -p /private/tmp/crate-reprobox-<id>/home
git -C /private/tmp/crate-reprobox-<id>/repo status --short --branch
```

Include uncommitted changes only when they are part of the repro:

```sh
mkdir -p /private/tmp/crate-reprobox-<id>
git diff --binary --output=/private/tmp/crate-reprobox-<id>/worktree.patch
git clone --local /Users/bryantfeintuchclaw/Projects /private/tmp/crate-reprobox-<id>/repo
git -C /private/tmp/crate-reprobox-<id>/repo checkout --detach <sha>
git -C /private/tmp/crate-reprobox-<id>/repo apply /private/tmp/crate-reprobox-<id>/worktree.patch
mkdir -p /private/tmp/crate-reprobox-<id>/home
git -C /private/tmp/crate-reprobox-<id>/repo status --short --branch
```

Run focused checks from the reprobox with isolated home state when practical:

```sh
HOME=/private/tmp/crate-reprobox-<id>/home node tests/provenance.test.js
HOME=/private/tmp/crate-reprobox-<id>/home node tests/provenance-dual-write.test.js
HOME=/private/tmp/crate-reprobox-<id>/home node tests/psd-embedded-safety.test.js
HOME=/private/tmp/crate-reprobox-<id>/home node tests/figma-scope.test.js
HOME=/private/tmp/crate-reprobox-<id>/home node tests/figma-link-per-project.test.js
```

For package or provenance-output comparisons, record commands and paths but avoid real user project data unless Bryant approves. Prefer synthetic fixtures and temp output paths under `/private/tmp/crate-reprobox-<id>/`.

## Reprobox Record
Every reprobox report should include:

- branch and SHA
- whether uncommitted changes were included
- dirty files at start
- Node and npm versions
- dependency state from `npm ls --depth=0`
- temp reprobox path
- exact commands run
- expected result
- actual result
- whether the issue reproduced
- files read from the real repo
- files written under `/private/tmp`
- cleanup status

## Commands Requiring Explicit Bryant Approval
```sh
npm install
npm ci
npm audit fix
npm start
git commit
git push
git reset
git checkout -- <file>
gh pr merge <pr>
npx electron-builder --mac --arm64
xcrun notarytool submit <artifact> --wait
xcrun stapler staple <artifact>
xcrun stapler validate <artifact>
npx wrangler pages deploy <directory>
rm -rf /private/tmp/crate-reprobox-<id>
```

## Must Never Do
- Do not mutate the real working tree to create a repro.
- Do not edit app code, tests, package files, release files, or active provenance PR work.
- Do not use Bryant's real `HOME`, Figma tokens, Apple credentials, or user project files unless Bryant explicitly approves that exact need.
- Do not copy secrets, raw API responses, raw local system scans, or private project assets into a reprobox report.
- Do not install dependencies, launch the Electron app, build, release, notarize, tag, deploy, merge, or push without explicit approval.
- Do not treat a non-repro as proof that the bug is gone if the reprobox omitted dirty changes, credentials, GUI state, or real project data needed for the issue.

## Quality Impact
- Separates source revision, environment, fixtures, and commands so failures can be replayed.
- Reduces hidden dependence on local home state, caches, credentials, and active dirty files.
- Gives package and provenance changes a stable place for before/after comparison.
- Preserves active work while making regressions easier to hand off or revisit.
- Turns ambiguous "works on my machine" results into a concrete repro or test-gap report.

## Definition Of Done
- Source revision and dirty state are captured.
- The repro either uses a clean temp clone or clearly states why it stayed in the active checkout.
- Commands are run from an isolated temp workspace when practical.
- Any uncommitted changes included in the repro are explicitly recorded.
- No real repo app code, tests, package files, release files, tags, deploys, or dependencies are changed.
- Bryant receives the repro path, command log, result, risks, and whether the issue reproduced.

## Report Format
- Branch, SHA, and dirty state.
- Reprobox path and whether it used clean SHA or dirty patch mode.
- Environment summary.
- Commands run and results.
- Reproduced, not reproduced, or inconclusive.
- Files written under `/private/tmp`.
- Cleanup status.
- Residual risks and whether Bryant can proceed.
