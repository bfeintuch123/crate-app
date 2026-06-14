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
- `crate-autoreview.md` for long-running, adversarial, multi-pass pre-merge autoreview with concrete fix recommendations and no automatic code edits.
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
- `crate-workstream-status.md` for read-only snapshots of branch, PR, release, QA, tester-feedback, and safe-next-action state.
- `crate-decision-log.md` for preserving Bryant-approved Crate product, architecture, release, QA, provenance, and rollout decisions.
- `crate-qa-results-synthesizer.md` for turning Jenna or tester QA artifacts into classifications, severity, next playbooks, and release recommendations.
- `crate-computer-use-qa.md` for scoped Codex Computer Use GUI QA of Crate-supported creative apps and workflows, starting with Crate, Finder, Figma, PowerPoint, and Keynote.
- `crate-gui-repro-flow.md` for reproducing GUI-only Crate bugs across scoped creative app lanes with exact steps, screenshots, package output, Package Details, and manifest comparison.
- `crate-codex-loops.md` for true autonomous Codex loops with preauthorization modes, allowed action sets, loop state, keepalive heartbeat guidance, stop gates, and orchestration across existing Crate playbooks.
- `crate-runner-loop.md` for Crabbox-style self-verifying Codex App loops with execution tiers, safe runner command suites, evidence format, and Mac-only release/signing boundaries.
- `crate-codex-qa-assistant.md` for durable Codex QA assistant workflows that split crate-web browser QA from crate-app desktop Computer Use QA, produce proof artifacts, and route fixes through Bryant-approved draft PRs or follow-up prompts.
- `crate-cmux-workbench.md` for optional cmux-style organization of multiple Codex CLI sessions while preserving Codex CLI, Computer Use, scoped app-lane QA, and Bryant approval boundaries.
- `crate-handoff.md` for restartable Codex App session handoffs and fresh-agent Crate prompts with portable anchors, privacy filters, exact next prompts, and explicit stop conditions.

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
