# Crate App Codex Instructions

## Repo
Crate app source of truth is this repo on branch `v2.4.x`.
All release, review, and feature work should treat `v2.4.x` as the canonical branch unless Bryant explicitly says otherwise.

## Branching
Feature branches merge into `v2.4.x`.
Never use `main` as the PR base for Crate release work unless Bryant explicitly says so.

## Agent Concurrency
- One builder agent edits code at a time.
- Specialist agents may review, audit, investigate, or plan, but should not edit concurrently with the builder agent unless Bryant explicitly authorizes it.
- If multiple agents are involved, keep ownership boundaries explicit and avoid overlapping file edits.
- Documentation-only workflow setup may edit docs and Codex configuration files, but must not touch app code, `package.json`, or `package-lock.json` unless Bryant explicitly scopes that work.

## Tool Roles
Use Codex CLI for:
- implementation
- test execution
- PR review
- regression checks
- release-readiness checks
- release and repo work
- Figma/session/package architecture work

Use ChatGPT/Codex mobile for:
- remote supervision
- approvals
- steering active Codex CLI sessions
- reading summaries and deciding whether work should proceed

Use Terminal app for:
- direct shell commands when Bryant is manually operating the Mac
- manual verification that Bryant wants to run outside an active Codex session

## Codex CLI Workflow
Use Codex CLI for:
- implementation
- PR review
- regression checks
- release-readiness checks
- test execution
- Figma/session/package architecture work

Use ChatGPT app for:
- product strategy
- prompt drafting
- interpreting Codex output

## Playbooks
Reusable Crate workflow playbooks live in `.codex/playbooks/`.

Use:
- `review-crate-pr.md` for merge-readiness review of a Crate PR.
- `figma-regression-audit.md` for Figma scope, page lock, package, and multi-app regression checks.
- `release-crate.md` only after Bryant explicitly approves starting a release.
- `security-audit.md` for shell, path, credential, watcher, parser, package, and dependency risk review.
- `clawpatch-fix.md` for a small, targeted bug fix with narrow tests.
- `mobile-codex-workflow.md` when Bryant is supervising Codex CLI from mobile.
- `crate-regression-detector.md` for fail-fast branch or PR regression sweeps.
- `crate-provenance-review.md` for provenance evidence, confidence, privacy, manifest, package, and Figma review.
- `crate-reprobox.md` for isolated reproducibility work in temporary workspaces.
- `crate-security-scan.md` for Crate-specific path, package, parser, token, manifest, and filesystem-boundary security scans.
- `crate-release-gate.md` for strict release-readiness gates before any release mutation begins.
- `crate-pr-documenter.md` for factual PR summaries, reviewer notes, tester notes, and release-note drafts.
- `crate-benchmark-fixtures.md` for defining repeatable synthetic workflow fixtures and expected package/provenance outputs.
- `crate-package-diff.md` for before/after package output comparisons.
- `crate-provenance-snapshot.md` for provenance graph snapshot and confidence-diff reviews.
- `crate-tester-intake.md` for turning external designer testing into structured, privacy-safe product feedback.
- `crate-bug-triage.md` for converting tester feedback into actionable engineering scope, issue drafts, and next-playbook recommendations.
- `crate-manual-qa-matrix.md` for repeatable manual QA workflows before tester rollout and releases.

When using a playbook, state which playbook is active, confirm the current branch, and follow the approval gates in that playbook.

## PR Review Rules
Before merge:
1. Confirm PR base is `v2.4.x`.
2. Confirm PR branch is mergeable.
3. Inspect changed files.
4. Run relevant tests.
5. Check for unrelated watcher/package/parser changes.
6. Summarize risks.
7. Do not merge unless Bryant explicitly approves.

## Release Workflow
After a PR is merged:
1. Pull latest `v2.4.x`.
2. Bump version.
3. Build with `npx electron-builder --mac --arm64`.
4. Staple and verify app.
5. Update `crate-site/index.html`.
6. Commit release files.
7. Tag release.
8. Create GitHub release.
9. Deploy Cloudflare Pages.
10. Confirm `get-crate.com` points to the new DMG.
Do not run release, build, notarization, tagging, GitHub release, or deploy commands unless Bryant explicitly approves that release step.

## Crate Guardrails
Do not change Photoshop, Illustrator, InDesign, generic watcher behavior, package filtering, or Figma parser behavior unless the task explicitly requires it.

For Figma changes, preserve:
- per-project Figma links
- Current Page Only default
- Entire File opt-in
- fail-closed behavior when page lock cannot resolve
- package-time scope enforcement
- multi-app capture behavior

## Definition of Done
Always report:
- files changed
- tests run
- exact commands run
- risks
- branch/PR status
- whether Bryant can proceed
