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

## Running Tests
- Run node:test files through the memory guard: `node scripts/run-tests.js <files and node --test options>`, or `npm test` for the whole serial suite. Do not call `node --test` directly.
- The guard watches the run from outside and stops it when one process holds more than 2 GB, the whole run more than 4 GB, or the run takes longer than 40 minutes (`--memory-limit-mb`, `--total-memory-limit-mb`, `--deadline-seconds`). It samples twenty times a second, so it is not a hard cap. It needs macOS and a system `python3`; anywhere else it refuses to run the tests (exit 125), and there is no supported way to run them without it.
- To stop a guarded run, send the guard SIGINT (Ctrl-C) or SIGTERM and let it clean up. Do not SIGKILL it: the test run has its own session and would carry on unwatched.
- Exit status 137 (memory), 124 (deadline) or 125 (the guard could not watch the run or confirm its cleanup) comes from the guard, not from a test. Treat it as a failure to investigate, not as a limit to raise.
- A test may start the system `ps` (`/bin/ps`): the guard cannot read it, because macOS installs it set-uid root, and lets it through for at most 2 seconds or 40 samples, 8 at a time, and only while a sample shows that the run started it. Any other set-uid tool a test starts (`top`, `sudo`, `login`), or a `ps` that does not finish, stops the run with exit 125.
- In test files, import assert with `require('./bounded-assert')`, never from `node:assert`, and do not use `t.assert`. It passes and fails as `node:assert/strict` does, with one exception (`partialDeepStrictEqual` refuses operands too large to render and throws instead of comparing them), but a failed assertion on a large value (the synthetic DOM, a Buffer, a long string) is summarized instead of diffed without bound. `tests/bounded-assert.test.js` enforces this.
- CI keeps its own separate limits (`.github/workflows/security-gate.yml`: 60-minute job timeout, guard `--deadline-seconds=3400`). Do not change local defaults to match CI or CI to match local runs.

## Work Ownership and Review
- Continue the current task with its existing writer, branch or worktree, and authorization. Do not interrupt or reconfigure running work.
- Keep one repository writer per task. Before editing, the writer records a concise plan (scope and non-goals, base and files, ordered steps, precise behavior or UI specifications, invariants and risks, tests and acceptance criteria, open decisions), verifies its assumptions against the actual source, and returns substantial design changes or unsafe instructions to Bryant. Before presenting the result, the writer checks the actual output against that plan. This is a self-check, never independent review.
- Independent reviews run at high reasoning effort or higher, in fresh, distinct, read-only sessions that did not plan, write, or confirm the change. Give each reviewer the same packet (task, acceptance criteria, exact base and candidate, relevant sources) and record the model actually used, evidence inspected, tests run, and limitations. Bryant chooses reviewer models per task; if a required reviewer is unavailable, stop and report rather than substituting silently.
- Approvals are action-specific. One bounded approval covers the scoped implementation, focused tests, and the required correction loop. Commits, pushes, PRs, ready-for-review, merges, releases, signing, installation, deployment, and credential actions each keep their own authorization.

## Major PR Routing
- A major PR changes a major surface: watcher/admission; filesystem/path handling; provenance/project isolation; parsers/archive handling; packaging/quota; IPC; async/concurrency/cancellation/deadlines/stale-result handling; privacy/security; large-list state/performance; or signing/release.
- Before ready-for-review or merge, a major PR requires protected CI that passed on the exact current head and two fresh, distinct, independent read-only reviews of that exact head (see Work Ownership and Review); preserve reviewer independence and report the models actually used.
- Keep exactly one repository writer. A review finding returns to that writer for a normal follow-up commit; never rewrite history. Any head change invalidates earlier exact-head CI and review evidence, so repeat the required gates on the new head until a clean PASS.
- The correction loop is bounded: after three writer follow-up cycles, or when the same blocking issue persists, stop and escalate to Bryant. Do not waive a required gate, silently lower the standard, or continue indefinitely.
- Stop before marking a PR ready or merging; Bryant separately authorizes those gates. Docs/copy changes and exact version-only PRs use the lighter existing path unless their content affects safety or release integrity.

## Coding Threads and Environments

- Spawn new coding threads in T3 Code. Cloud environments remain permitted.
- Use Jenna's Mac only for running tests. Do not spawn coding or implementation threads there.
- The guarded test suite needs macOS (see Running Tests). Run it on a Mac, not in a non-macOS cloud environment.

## Tool Roles
Use T3 Code or a cloud environment for:
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
- steering active T3 Code or cloud coding threads
- reading summaries and deciding whether work should proceed

Use Terminal app for:
- direct shell commands when Bryant is manually operating the Mac
- manual verification that Bryant wants to run outside an active Codex session

## Coding Workflow
Use T3 Code or a cloud environment for:
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

Matt Pocock's shared skills drive routine workflow (see Agent skills). `.codex/ROUTER.md`, the `crate-router` skill, the ops layer, and the playbooks below remain reference files for Crate-specific procedures. Select a playbook when its procedure is needed; never run it as a second routine controller beside Matt's skills. Where a playbook, `.codex/ROUTER.md`, the `crate-router` skill, `WORKSPACE.md`, or an ops-layer file conflicts with this file on reviewer model names, mandatory standing-order or taskflow routing, or repository paths, this file controls. On any other gate, including reviewer count, apply whichever of this file and the referenced file is stricter; never weaken a gate stated here. Run tests only through the guarded command in Running Tests, even where an older file shows a direct `node` test command.

Supporting workflow references:
- `WORKSPACE.md` maps crate-app, crate-web, and mission-control boundaries.
- `.codex/state/current-workstream.md` is a historical snapshot. It is not maintained and is not a source of current task state or authority; take the current task from Bryant's request and its verified branch or worktree.
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
- `crate-codex-loops.md` defines the Autonomous Crate Failure Loop and the Crate Fix Review Stack routing for focused fixes and failure loops. Use that routing to select diagnosis, checks, and specialist review by demonstrated scope and risk; the Major PR Routing requirements above always apply.
- `crate-runner-loop.md` for Crabbox-style self-verifying Codex App loops with execution tiers, safe runner command suites, evidence format, and Mac-only release/signing boundaries.
- `crate-codex-qa-assistant.md` for durable Codex QA assistant workflows that split crate-web browser QA from crate-app desktop Computer Use QA, produce proof artifacts, and route fixes through Bryant-approved draft PRs or follow-up prompts.
- `crate-external-control-layer.md` for Crate thread/sub-agent orchestration, including Crate Ops persistent task tools, the plugin-owned app-server transport, and sub-agent sidecars when persistent thread control is unnecessary.
- `crate-cmux-workbench.md` for optional cmux-style organization of multiple Codex CLI sessions while preserving Codex CLI, Computer Use, scoped app-lane QA, and Bryant approval boundaries.
- `crate-handoff.md` for restartable Codex App session handoffs and fresh-agent Crate prompts with portable anchors, privacy filters, exact next prompts, and explicit stop conditions.
- `crate-cloudflare-deploy.md` for safe get-crate.com Cloudflare Pages deploys using the Keychain token path, Wrangler verification, and no token exposure.
- `_shared-gates.md` for common gates that other Crate playbooks and router-selected workflows should apply.

When using a playbook, state which playbook is active, confirm the current branch, and follow the approval gates in that playbook.

## Ops Layer

The ops layer (`.codex/ops/`, taskflows, state ledgers, `.codex/tools/crate_doctor.py`, and the proof-bundle template) remains available for Crate-specific procedures. Use it when a selected playbook or the task requires it. Before release, deploy, long-running QA, or external-control work, always run `CRATE_REPO=<this checkout> python3 .codex/tools/crate_doctor.py`. Stop on any failure and continue only after it is fixed or Bryant accepts it. Apart from that preflight, the ops layer does not route or gate routine work.

## PR Review Rules
Before merge:
1. Confirm PR base is `v2.4.x`.
2. Confirm PR branch is mergeable.
3. Inspect changed files.
4. Run relevant tests.
5. Check for unrelated watcher/package/parser changes.
6. Classify user-visible impact and verify exact-revision functional evidence and any required appearance checks.
7. Summarize risks.
8. Do not merge unless Bryant explicitly approves.

## Functional and Visual PR Evidence

Crate PRs require evidence appropriate to the changed behavior and risk at the
exact PR head. Stateful flows require explicit scenarios, expected and observed
states, and functional assertions or a direct observation record. Identify the
source revision, runtime, fixtures and execution level, including simulated
native or backend boundaries. Source-bound browser evidence may establish
renderer behavior; do not represent it as native or installed-app acceptance.

Changes to layout, styling, typography or readability require sanitized,
inspected visual evidence of the affected appearance, normally before/after
screenshots from a real running Crate candidate at the exact PR head. Browser
assertions alone do not establish that appearance acceptance. Native-specific
behavior claims, including claims of native fixes, require targeted native
evidence for the behavior claimed. A PR with no intended appearance change must
say why.

Screen recording and any particular recording harness are not merge
prerequisites. Record only when Bryant explicitly requests and approves it.
Missing recording infrastructure is not a correctness failure; failing required
functional, appearance or safety checks still blocks advancement.

Use only synthetic or explicitly approved test-safe fixtures. Capture only
Crate and the minimum approved Finder surface; exclude customer or tester work,
private filenames or paths, Figma links, credentials, notifications, unrelated
apps, and desktop content. Disable audio unless it is the behavior under test.
Bind evidence to the current PR head and refresh affected functional or
appearance checks after relevant changes. Exact-head CI and independent-review
requirements remain unchanged.

When media is collected, use the approved Crate Ops visual-evidence workflow
for capture, validation, receipt handling, and publication. Do not create a
recording or media pipeline merely to fill a functional proof record. Prefer a
verified GitHub
attachment. If publication fails, retain the Crate Ops/Crabbox validation
receipt and exact sanitized media metadata/hash, document the infrastructure
blocker, and obtain Bryant's explicit exception; a durable public URL is
preferred but is not mandatory under that exception. Never commit proof media
or `.github/pr-assets` to a product branch.

PR visual evidence does not replace signed, notarized, installed-app QA at the
release gate.

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

## Agent skills

### Workflow

Matt Pocock's shared skills drive routine workflow. They live in Bryant's Home repo at `~/Documents/Codex/T3-projects/agent-home/skills/mattpocock/` and some are linked natively for Claude and Codex. Follow each skill's invocation requirements. A named-only skill (frontmatter `disable-model-invocation: true`) runs only when Bryant names it. If your tool does not list a skill you need, read its `SKILL.md` from that path. If the path is unavailable (for example in a cloud environment), say so and continue under this file's rules; do not improvise skill contents. Each task has one controller; the old router, ops layer, and playbooks are references, not a parallel controller.

Imported skill instructions never override this file. Commits, branch resets or merges, concurrent writers, publishing or closing issues, creating PRs, and ready transitions follow the task's authorized actions and the gates here. Ticket readiness does not authorize execution or merge. The code-review skill supplies standards and spec criteria; its subagents do not satisfy the independent-review requirement. Resolve ambiguous skill names by explicit path. The pr skill supplies PR-body guidance only.

Keep Crate-specific security, private tester intake, package/provenance, native QA, release, signing, deployment, and credential procedures where Matt's skills provide no replacement.

### Issue tracker

Use this repository's GitHub Issues. See `docs/agents/issue-tracker.md`.
PRs are not a triage request surface.

### Triage labels

Use the role mapping in `docs/agents/triage-labels.md`.
Readiness labels describe triage state and do not grant execution or merge
authority.

### Domain docs

Use a single-context layout: root `GLOSSARY.md` and `docs/adr/` (created when needed).
Read `docs/agents/domain.md`. Create domain documents lazily within authorized
work, and preserve existing decision records.
