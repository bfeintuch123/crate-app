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

Use `.codex/ROUTER.md` and the `crate-router` skill when Bryant gives a short Crate request and expects Codex to choose the correct playbooks, loop mode, checks, and stop gates.

Supporting workflow references:
- `WORKSPACE.md` maps crate-app, crate-web, and mission-control boundaries.
- `.codex/state/current-workstream.md` records the compact active Crate state and next prompt.
- `.codex/playbooks/_shared-gates.md` contains common repo, mutation, release, dependency, privacy, review, and final-report gates.
- `.codex/checks/crate-check-suites.md` defines named docs, focused QA, provenance, Figma, package-parser, and release-gate check suites.
- `.codex/ops/crate-ops-improvement-plan.md` maps the Crate ops layer: standing orders, taskflows, memory, proof bundles, skill registry, doctor, Cloudflare deploy, and tester archive.
- `.codex/ops/standing-orders.md` defines durable authority for recurring Crate programs.
- `.codex/taskflows/README.md` defines durable taskflow state and resume-token format for multi-step loops.
- `.codex/ops/crate-memory-model.md` defines memory tiers and action-sensitive approval memory.
- `.codex/ops/proof-bundle-template.md` defines proof-bundle closeout evidence.
- `docs/crate/qa-smokes/` stores reusable Jenna-machine smoke prompt templates.

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
- `crate-codex-loops.md` also defines the Autonomous Crate Failure Loop. Use it for QA smoke failures, tester reports, GitHub issues, release-gate failures, dependency audits, PR review findings, package/provenance anomalies, installed-app regressions, and public/beta bug reports. For any code-fix loop, automatically use the Crate Fix Review Stack: `crate-bug-triage.md`, `clawpatch-fix.md`, `crate-autoreview.md`, `crate-regression-detector.md`, `crate-security-scan.md`, `crate-provenance-review.md`, `crate-runner-loop.md`, `review-crate-pr.md`, and `crate-handoff.md`.
- `crate-runner-loop.md` for Crabbox-style self-verifying Codex App loops with execution tiers, safe runner command suites, evidence format, and Mac-only release/signing boundaries.
- `crate-codex-qa-assistant.md` for durable Codex QA assistant workflows that split crate-web browser QA from crate-app desktop Computer Use QA, produce proof artifacts, and route fixes through Bryant-approved draft PRs or follow-up prompts.
- `crate-external-control-layer.md` for Crate thread/sub-agent orchestration, including Crate Ops persistent task tools, the plugin-owned app-server transport, and sub-agent sidecars when persistent thread control is unnecessary.
- `crate-cmux-workbench.md` for optional cmux-style organization of multiple Codex CLI sessions while preserving Codex CLI, Computer Use, scoped app-lane QA, and Bryant approval boundaries.
- `crate-handoff.md` for restartable Codex App session handoffs and fresh-agent Crate prompts with portable anchors, privacy filters, exact next prompts, and explicit stop conditions.
- `crate-cloudflare-deploy.md` for safe get-crate.com Cloudflare Pages deploys using the Keychain token path, Wrangler verification, and no token exposure.
- `_shared-gates.md` for common gates that other Crate playbooks and router-selected workflows should apply.

When using a playbook, state which playbook is active, confirm the current branch, and follow the approval gates in that playbook.

## Ops Layer

For non-trivial Crate work, route through the ops layer:

1. Select a standing order from `.codex/ops/standing-orders.md`.
2. Create or update a taskflow under `.codex/taskflows/` if the work spans turns, threads, agents, machines, or approval gates.
3. Load memory according to `.codex/ops/crate-memory-model.md`.
4. Use `.codex/ops/skill-registry.md` when selecting routeable skills/tools.
5. Run `python3 .codex/tools/crate_doctor.py` before release, deploy, long-running QA, or external-control work.
6. Close major work with a proof bundle or proof section based on `.codex/ops/proof-bundle-template.md`.
7. Update `.codex/state/daily-crate-ledger.md` and `.codex/state/current-workstream.md` when state changes.

## PR Review Rules
Before merge:
1. Confirm PR base is `v2.4.x`.
2. Confirm PR branch is mergeable.
3. Inspect changed files.
4. Run relevant tests.
5. Check for unrelated watcher/package/parser changes.
6. Summarize risks.
7. Do not merge unless Bryant explicitly approves.

## Code Review Rules

### Preserve protected Crate behavior
- Flag a change when it alters generic watcher capture, package filtering, parser behavior, provenance or manifest generation, or Figma scope enforcement without the PR explicitly scoping that behavior and providing focused regression evidence.
- Do not flag an explicitly scoped behavior change with relevant tests, or an unrelated UI, copy, documentation, or test-only change that leaves those paths and their existing regression coverage untouched.

### Prevent sensitive-data exposure
- Flag a change when new user-visible, logged, diagnostic, package, manifest, fixture, or persisted output can expose a Figma token, complete Figma URL, Figma file key, signed URL, Keychain value, or unrelated private filesystem path.
- Do not flag redacted values, clearly synthetic placeholders, paths displayed only to the same local user who selected them, or internal path handling that does not create a new disclosure boundary. The path exception does not apply to logs, diagnostics, packages, manifests, or other shared output.

### Enforce the approved mutation lane
- Flag a change when it mutates dependencies or lockfiles, release/signing/notarization configuration, GitHub release state, or `crate-site`/deployment behavior outside a PR whose stated scope explicitly authorizes that lane.
- Do not flag an explicitly scoped dependency, release, or site PR that follows its required approval gates, or a change with no mutations in those areas.

## Release Workflow
Follow `.codex/playbooks/release-crate.md` and `.codex/playbooks/crate-release-gate.md` as the executable release authority:
1. Select the release profile before mutation. A **tester beta** is an explicitly Bryant-approved prerelease distributed through the existing GitHub release and `get-crate.com` download flow. Both profiles require source-CI provenance, blocked force-push/deletion, append-only `v*` tag protection, immutable-release enforcement with immutable published release assets, and exact remote asset verification. A **public stable release** additionally requires the independent controlling-principal approval, layered branch/public tag-creation rulesets, attestation verification, and future account-gated download backend defined by the release playbooks.
2. For either profile, use one exclusive release session, authenticate fixed Git, GitHub CLI, Node, and npm paths, hashes, and versions, and define the minimal sanitized environment required for every Node invocation. For public stable only, complete the manual controlling-principal attestation and additional bounded GitHub governance evidence before version mutation.
3. Create, review, and merge a version-only release-prep PR into `v2.4.x`; require the source-security check on the PR and protected-branch push, bind it to that exact release SHA, GitHub Actions app, check suite, and `.github/workflows/security-gate.yml`, then pull that exact clean release commit.
4. Reconstruct dependencies from the committed lockfile with lifecycle scripts disabled, verify the approved lifecycle allowlist, and install only the exact pinned official Canvas arm64 prebuild through the reviewed installer without running dependency lifecycle scripts.
5. Start Electron Builder only after one combined build, signing, app-notarization, app-stapling, and app-staple-validation approval; the configured `afterSign` hook must use only the fixed `crate-release-notarytool` Keychain profile and complete those app steps before DMG/ZIP creation.
6. Notarize, staple, and validate release envelopes under their separate approval gate.
7. Create separate clean proof and verifier worktrees at the release commit, assert their canonical paths differ, reconstruct dependencies independently with lifecycle scripts disabled in both, and install the same authenticated Canvas prebuild only in the proof worktree.
8. From the explicit verifier worktree at the approved release commit, verify the standalone signed app and the app extracted from every final DMG/ZIP against the isolated proof root and exact Canvas archive at that same commit, including Apple-anchored Developer ID trust, exact launch/security metadata, internally consistent main/helper build metadata, and complete allowlisted outer container inventories; then validate artifact hashes, update metadata, and blockmaps before tagging, push the tag, and verify its remote SHA matches the approved release commit.
9. Freeze an exact asset manifest, create the GitHub release as a draft with the verified remote tag, and compare every downloaded draft asset to every and only approved filename, byte size, and SHA-256. Immediately before publication, both profiles require a second complete draft download into a second new empty directory with the same full comparison; publishing must be the next bounded operation. Both profiles require immutable published release assets and a complete post-publication download comparison. Tester betas must publish with GitHub's prerelease flag after this comparison. Public stable releases additionally require a separately controlled release authority and require the attested subjects to equal the same exact set.
10. Commit, review, and merge the `crate-site` update so its download button points to the verified tester-beta or public-stable DMG. Reconstruct Wrangler immediately from its authenticated lockfile, bind `whoami` to Cloudflare account `ba2eae4575a070ed70ae9be217fa21dc`, then deploy only from an isolated private working directory and a private inventory-verified snapshot of that exact remote commit; never deploy the live worktree.
11. Confirm `get-crate.com` points to the exact hash-verified GitHub DMG for the selected profile. Account-gated downloads are a separate prerequisite for public stable launch, not for the established tester-beta flow.
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
