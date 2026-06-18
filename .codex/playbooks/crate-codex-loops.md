# Crate Codex Loops Playbook

## Purpose
Define true autonomous Codex loops for Crate work.

A Crate Loop means Codex continues iterating after one initial prompt until the defined goal is reached or a stop condition is hit. A loop is not a prompt chain. Bryant should not need to provide the next prompt after every step when the loop is inside an approved action set and has a clear definition of done.

This playbook orchestrates existing Crate playbooks. It does not replace focused fix, review, QA, release gate, security, provenance, handoff, or package-diff playbooks.

## When To Use
- Bryant explicitly asks for an autonomous loop.
- The task has a clear goal, allowed action set, definition of done, and stop gates.
- Long-running review, QA, fix, release-gate, readiness, crate-failure, or smoke-failure work needs durable state and explicit autonomy boundaries.
- Codex should choose the next safe step without Bryant providing every next prompt.
- Codex should produce a handoff or exact approval request after reaching a stop gate.

## Start Prompt
Use a prompt like:

```text
Use .codex/playbooks/crate-codex-loops.md for <loop name>.
Preauthorization mode: <no-autonomy|fix-only|fix-and-PR|fix-PR-and-merge-if-clean|release-gate-only-when-explicitly-approved>.
Goal: <goal>.
Allowed actions: <allowed action set>.
Definition of done: <done criteria>.
Stop at approval gates and do not commit, push, merge, release, build, deploy, tag, notarize, mutate dependencies, or touch out-of-scope files unless explicitly approved by the selected preauthorization mode.
```

If the loop is a focused code fix, also use the Crate Fix Review Stack below. If it is review-only, also use `crate-autoreview.md` or the relevant review playbook. If it is PR or merge work, also use `review-crate-pr.md`. If it is GUI QA, also use `crate-computer-use-qa.md` or `crate-gui-repro-flow.md`. If it is prerelease readiness, also use `crate-release-gate.md`. If it needs a restartable handoff, also use `crate-handoff.md`.

## Required Start Gate
Before acting, Codex must confirm:
- repo path
- remote repository
- repo identity is `crate-app`, not `crate-web`
- current branch
- whether the branch is based on the required base branch, usually latest `origin/v2.4.x`
- working tree state
- loop name
- preauthorization mode
- goal
- allowed action set
- definition of done
- stop gates

If the path, repo, branch, base, or working tree does not match the prompt or relevant playbook, stop and report.

## Core Definitions

### Assisted Workflow
An assisted workflow is not an autonomous loop.

In an assisted workflow:
- Codex performs one requested step.
- Codex reports the result.
- Codex waits for Bryant to provide the next prompt or approval.
- The next action is not selected or executed unless Bryant asks for it.

Use assisted workflow mode when the task lacks a clear action set, has unresolved product ambiguity, needs credentials or account decisions, or requires a high-risk mutation that Bryant did not preauthorize.

### Autonomous Loop
An autonomous loop is an approved bounded workflow.

In an autonomous loop:
- Codex observes state.
- Codex plans the next safe action.
- Codex acts inside the allowed scope.
- Codex runs checks.
- Codex evaluates the result.
- Codex updates loop state.
- Codex continues until done or stopped.

Autonomy is scoped. Codex may continue without additional Bryant prompts only inside the loop's allowed action set and selected preauthorization mode.

## Loop Cycle
Every autonomous Crate Loop follows this cycle:

```text
Observe -> Plan -> Act -> Check -> Evaluate -> Handoff/Continue
```

Iteration rules:
- Observe current repo, PR, QA, artifact, or app state from authoritative sources.
- Plan the next smallest safe action inside the allowed scope.
- Act only inside the selected preauthorization mode.
- Check with the narrowest meaningful tests, commands, or UI verification.
- Evaluate whether the goal is complete, blocked, or still needs another allowed iteration.
- Handoff if a stop gate or approval gate is hit; otherwise continue.

Codex must keep each iteration small enough that the next state can be inspected, explained, and reversed without broad unrelated churn. If the next smallest safe action is outside the approved action set, Codex stops and asks Bryant for approval.

## Preauthorization Modes

### no-autonomy
Codex may inspect, plan, and report one step at a time. It must wait after each substantive action.

Allowed:
- read files
- inspect git/GitHub state
- run read-only checks
- propose exact next prompt

Forbidden unless separately approved:
- edit
- commit
- push
- open PR
- merge
- build
- release
- deploy
- tag
- notarize
- mutate dependencies

### fix-only
Codex may create or use a branch, implement a scoped fix, run checks, self-review, and stop before commit.

Allowed:
- create branch from approved base
- edit scoped files
- add/update tests
- run focused checks
- update local loop state

Forbidden unless separately approved:
- commit
- push
- open PR
- merge
- build
- release
- deploy
- tag
- notarize
- mutate dependencies

### fix-and-PR
Codex may complete the fix, commit, push the branch, and open a draft PR after checks pass.

Allowed:
- everything in `fix-only`
- commit scoped changes
- push branch
- open draft PR
- return review and merge-readiness prompt

Forbidden unless separately approved:
- mark PR ready
- merge
- release
- deploy
- tag
- notarize
- mutate dependencies

### fix-PR-and-merge-if-clean
Codex may complete the fix, open a PR, run merge-readiness checks, and merge only if every required gate is clean and Bryant explicitly preauthorized merge for that exact loop.

Allowed:
- everything in `fix-and-PR`
- run `review-crate-pr.md`
- inspect requested changes and unresolved comments
- merge only if no blockers, no requested changes, clean checks, correct base, and the prompt explicitly permits merge

Must stop before merge if:
- merge-readiness requests changes
- status checks fail or are missing
- branch is not mergeable
- review comments are unresolved
- PR base is not `v2.4.x`
- changed files exceed the loop scope
- Bryant's prompt did not explicitly preauthorize merge

### release-gate-only-when-explicitly-approved
Codex may run the release gate only to the exact mutation boundary Bryant approved.

Allowed only when the prompt explicitly says so:
- version bump
- build
- signing validation
- notarization validation
- commit package metadata
- tag
- push
- GitHub prerelease

Forbidden unless separately approved:
- final public `v2.8.0`
- `get-crate.com` updates
- site deploy
- stable release publication
- dependency mutation

## Loop State File
Codex should maintain a lightweight loop state file when useful, especially for long-running loops, interrupted work, multi-pass QA, prerelease gates, smoke-failure fixes, or review loops that produce staged findings.

Suggested path:

```text
.codex/loop-state/<loop-name>.md
```

Loop-state files are local working artifacts by default. Do not commit loop-state files unless Bryant explicitly approves.

Loop-state files must not contain:
- secrets
- tokens
- passwords
- API keys
- private client data
- raw command dumps
- broad private file lists
- sensitive filesystem inventories
- unredacted account, security, billing, or admin details

Suggested loop-state fields:
- loop name
- preauthorization mode
- goal
- definition of done
- current branch
- current commit
- current PR
- current artifact/version
- keepalive status
- current blocker
- last action
- last observation
- changed files
- tests/checks run
- next action
- stop condition
- approval needed
- risks/open questions

## Mac Keepalive / Loop Heartbeat
Use this only when Bryant approves a long-running local Codex App loop and the Mac should stay awake. The heartbeat keeps the Mac awake; it does not grant permission to bypass stop gates.

Start:

```sh
caffeinate -dimsu -t 43200 &
echo $! > /tmp/crate-caffeinate.pid

while true; do
  date "+%Y-%m-%d %H:%M:%S Crate Codex loop heartbeat"
  caffeinate -u -t 30
  sleep 300
done &
echo $! > /tmp/crate-heartbeat.pid
```

Stop:

```sh
kill "$(cat /tmp/crate-heartbeat.pid)" 2>/dev/null || true
kill "$(cat /tmp/crate-caffeinate.pid)" 2>/dev/null || true
rm -f /tmp/crate-heartbeat.pid /tmp/crate-caffeinate.pid
```

Check:

```sh
ps -p "$(cat /tmp/crate-caffeinate.pid)" -o pid,command
ps -p "$(cat /tmp/crate-heartbeat.pid)" -o pid,command
```

Rules:
- Heartbeat does not override stop gates.
- Do not commit PID files.
- Include keepalive status in `/handoff state`.
- Stop the heartbeat when the loop is done, blocked, or handed back to Bryant unless Bryant asks to keep it running.
- If the heartbeat fails to start, report it as an operational limitation, not a product blocker.

## Hard Stop Gates
Codex must stop immediately and report if any of these appear:
- credentials/tokens/passwords
- Keychain/signing prompts
- Apple Developer secrets
- private-file ambiguity
- product decision ambiguity
- dependency mutation outside explicit scope
- `crate-web` changes
- build/release/tag/notarize unless explicitly approved
- final public `v2.8.0`
- `get-crate.com` or site deploy
- merge-readiness requests changes
- tests fail and cannot be safely resolved inside the loop scope
- scope expands beyond loop goal
- wrong repo, path, branch, base, or unexpected dirty tree
- account/security/billing/admin prompts
- unapproved private/client files or artifacts

Codex must not treat silence as approval for any stop gate. If a loop reaches a stop gate, Codex reports current state, risk, exact approval needed, and the safest next prompt Bryant can use.

## Loop Types

### Crate Fix Review Stack
Every autonomous Crate code-fix loop must use this stack unless Bryant explicitly scopes the work as docs-only, review-only, or no-review.

Mandatory playbooks:
- `crate-bug-triage.md` before editing to classify the failure, evidence quality, severity, and whether a fix is actually warranted.
- `clawpatch-fix.md` for the implementation path so the change stays small, branch-gated, and test-backed.
- `crate-autoreview.md` before and after the fix to challenge assumptions, stale evidence, over-scope, and release-blocking risk.
- `crate-regression-detector.md` to identify blast radius and required focused checks.
- `crate-security-scan.md` to check token, path, package, parser, shell, filesystem-boundary, and privacy risks.
- `crate-provenance-review.md` when the change touches package output, Figma, diagnostics, live evidence, provenance, pending files, asset classification, or session decisions.
- `crate-runner-loop.md` to record repeatable command evidence, environment, branch/commit, pass/fail, duration, failures, and next action.
- `review-crate-pr.md` before merge when a PR exists or merge is preauthorized.
- `crate-handoff.md` whenever the loop stops, blocks, or needs a restartable next prompt.

Stack rules:
- Do not skip triage and autoreview just because the likely fix seems obvious.
- Do not edit code before classifying whether the issue is a real app bug, QA setup problem, automation blocker, product follow-up, stale report, dependency/security issue, or release blocker.
- Use the strictest stop gate from all selected playbooks.
- If a playbook says to stop, the loop stops even if the preauthorization mode would otherwise allow more work.
- Preserve privacy filters across all evidence, logs, QA reports, runner output, and handoffs.
- For dependency remediation, use the Security / Dependency Loop rules in addition to this stack.
- For release-gate failures, use this stack only for the remediation branch; run `crate-release-gate.md` again only after the fix merges and Bryant approves the next QA prerelease.

### 1. Autonomous Crate Failure Loop
Purpose:
- Triage and resolve Crate failures from any approved source, not only QA smoke reports.

Failure sources include:
- Jenna QA smoke report
- external tester report
- GitHub issue
- release-gate failure
- dependency audit failure
- PR review finding
- package/provenance diff
- GUI reproduction finding
- installed-app regression
- public or private beta user bug report

Recommended orchestrated playbooks:
- Crate Fix Review Stack when the loop may edit code
- `crate-qa-results-synthesizer.md` for Jenna/tester QA artifacts
- `crate-tester-intake.md` for external designer or beta-user feedback
- `crate-gui-repro-flow.md` or `crate-computer-use-qa.md` when GUI reproduction is needed
- `crate-package-diff.md` and `crate-provenance-snapshot.md` when package output or provenance artifacts are central evidence
- `crate-release-gate.md` only after a merged fix and explicit QA prerelease approval

Failure classification:
- `pass`
- `fail-likely-app-bug`
- `fail-qa-setup`
- `blocked-automation`
- `product-follow-up`
- `release-blocker`
- `dependency-security`
- `needs-more-evidence`
- `non-blocking-public-release-follow-up`
- `stale-or-already-fixed`

Loop phases:
1. Intake failure report and source.
2. Classify failure type, severity, evidence quality, and scope.
3. Decide whether evidence is sufficient to fix or whether QA/repro/product input is needed.
4. Select the required playbooks from the Crate Fix Review Stack and any source-specific playbooks.
5. Create a focused branch only after classification supports implementation and the selected mode allows edits.
6. Implement the smallest safe fix if warranted.
7. Run runner-compatible checks and focused tests.
8. Run autoreview, regression, security, provenance, and PR review gates as applicable.
9. Commit, push, open PR, and merge only when the selected mode allows it and all gates pass.
10. Return handoff state and the next QA, release-gate, tester, or follow-up prompt.

Allowed according to preauthorization:
- inspect reports, code, GitHub state, and safe artifacts
- run read-only checks
- create a focused branch after start gate passes
- edit scoped app or test files only when classification supports a real fix
- add/update tests
- commit/push/PR/merge only in modes that explicitly allow those actions

Must stop if:
- classification is product decision, QA setup, automation blocker, or needs-more-evidence and no safe next action is approved
- fix would broaden beyond the failure source
- fix requires credentials, private file inspection, dependency mutation, release/build/deploy/tag/notarization, crate-web changes, or final public release action outside explicit scope
- any selected playbook requests changes or hits a stop gate

Definition of done:
- failure source and classification are reported
- root cause is identified or narrowed
- fix is implemented only if warranted
- required checks pass
- review stack is clean
- PR/merge state is reported when applicable
- exact next prompt is returned

### 2. Autonomous Fix Loop
Purpose:
- Implement a focused bug fix or product behavior fix.

Recommended orchestrated playbooks:
- Crate Fix Review Stack

Allowed according to preauthorization:
- create branch
- inspect code
- edit relevant files
- add/update tests
- run tests
- rerun failed tests
- revise implementation
- update loop state
- commit/push/PR only in `fix-and-PR` or stronger mode

Definition of done:
- fix implemented
- focused tests added/updated
- required tests pass
- `git diff --check` passes
- no unrelated files changed
- self-review ready
- final review prompt or PR returned

### 3. Autonomous Review Loop
Purpose:
- Read-only investigation, PR review, release-blocker review, or fix recommendation.

Recommended orchestrated playbooks:
- `crate-autoreview.md`
- `review-crate-pr.md`
- `crate-regression-detector.md`
- `crate-pr-documenter.md`
- `crate-release-gate.md` for release-readiness gate review

Allowed:
- inspect repo
- inspect PR/diff
- run read-only checks
- run tests if safe
- produce findings
- produce exact fix prompts

Forbidden:
- edit files
- branch
- commit
- push
- merge
- build
- release
- deploy
- tag
- notarize

Definition of done:
- findings classified
- risks stated
- tests/checks reported
- exact next prompt produced

### 4. Autonomous PR/Merge Loop
Purpose:
- Carry a clean scoped branch through PR creation, review-readiness, and optionally merge if explicitly preauthorized.

Recommended orchestrated playbooks:
- `review-crate-pr.md`
- `crate-autoreview.md` when release-blocker review is needed
- `crate-regression-detector.md`
- `crate-pr-documenter.md`

Allowed according to preauthorization:
- inspect branch and base
- push branch and open draft PR in `fix-and-PR` mode
- run merge-readiness checks
- update PR description through approved tooling
- merge only in `fix-PR-and-merge-if-clean` mode and only if all merge gates pass

Must stop if:
- PR base is not `v2.4.x`
- mergeability is not clean
- checks fail or are missing
- review requests changes
- unresolved review threads remain
- changed files exceed scope
- Bryant did not explicitly preauthorize merge

Definition of done:
- PR is open and documented, or merged if explicitly preauthorized and clean
- merge-readiness state is reported
- next release/QA prompt is returned if relevant

### 5. Autonomous QA Loop
Purpose:
- Installed-app QA with Computer Use, Finder, and scoped creative-app workflows.

Recommended orchestrated playbooks:
- `crate-computer-use-qa.md`
- `crate-gui-repro-flow.md`
- `crate-manual-qa-matrix.md`
- `crate-package-diff.md` when output comparison is in scope
- `crate-handoff.md` for restartable QA state

Allowed:
- launch installed app
- inspect visible UI
- run approved QA workflows
- use Finder and approved creative apps
- use Terminal only for safe QA setup, read-only checks, or System Events automation when approved
- record pass/fail
- update local loop state

Forbidden:
- source code edits
- Git operations unless scoped by the prompt
- build/release/deploy/tag/notarize
- account/security/billing/admin settings
- credentials/tokens
- unapproved private/client files
- packaging contaminated projects

Definition of done:
- QA matrix step passes
- or first blocker is captured with reproducible details
- artifacts/paths are recorded only when privacy-safe and approved
- next action recommended

### 6. Autonomous Release Gate Loop
Purpose:
- Internal QA prerelease gate or release-readiness gate.

Recommended orchestrated playbooks:
- `crate-release-gate.md`
- `release-crate.md` only after Bryant explicitly approves release execution
- `crate-pr-documenter.md` for release notes or tester notes
- `crate-handoff.md` for restartable release state

Allowed only when explicitly approved:
- version bump
- build
- signing validation
- notarization validation
- commit package metadata
- tag
- push
- GitHub prerelease

Must stop for:
- Keychain/signing/manual credential prompt
- failed tests
- artifact validation failure
- `latest-mac.yml` mismatch
- tag/release conflict
- dirty tree
- final public release action
- site deploy action

Definition of done:
- approved gate completes or stops at first blocker
- artifacts and hashes reported if built
- no final public release/site deploy occurred unless explicitly approved
- QA checklist or exact next prompt returned

### 7. Public v2.8 Readiness Loop
Purpose:
- Maintain public `v2.8` go/no-go state.

Recommended orchestrated playbooks:
- `crate-workstream-status.md`
- `crate-release-gate.md`
- `crate-qa-results-synthesizer.md`
- `crate-pr-documenter.md`
- `crate-manual-qa-matrix.md`

Allowed:
- inspect branch/PR/release state
- summarize blockers/non-blockers
- run read-only review/checks
- recommend next action

Forbidden unless separately approved:
- code edits
- branch creation
- release
- deploy
- final public tag
- final public `v2.8.0`

Definition of done:
- current readiness matrix complete
- blockers and non-blockers separated
- next highest-leverage action identified
- exact next prompt returned

### 8. Provenance / AI-Readiness Loop
Purpose:
- Evolve Crate Provenance into deterministic capture intelligence and future AI-ready evidence.

Principles:
- apps provide evidence
- provenance/session layer normalizes and reconciles evidence
- deterministic policy remains the safety gate
- AI/LLM may later review ambiguous evidence, but no AI calls unless separately approved
- privacy and user trust come first

Recommended orchestrated playbooks:
- `crate-provenance-review.md`
- `crate-provenance-snapshot.md`
- `crate-package-diff.md`
- `crate-security-scan.md`
- `clawpatch-fix.md` only after Bryant approves a deterministic fix loop

Allowed:
- planning/review
- evidence schema inspection
- deterministic decision-layer fixes if approved through Fix Loop
- package/provenance snapshot analysis with approved artifacts

Forbidden unless explicitly approved:
- AI/LLM calls
- cloud AI data transfer
- raw private evidence collection
- silent inclusion of private files

Definition of done:
- evidence model assessed
- risks stated
- next safe PR or research prompt identified

### 9. Security / Dependency Loop
Purpose:
- Security review, npm audit triage, dependency remediation planning, or approved dependency remediation.

Recommended orchestrated playbooks:
- `crate-security-scan.md`
- `security-audit.md`
- `crate-regression-detector.md`

Rules:
- non-force lockfile remediation can be separate
- major Electron/electron-builder upgrades require explicit approval
- no `npm audit fix --force` without Bryant approval
- no dependency mutation unless loop explicitly allows it

Allowed only when the loop explicitly scopes dependency work:
- inspect advisories
- classify runtime/build/dev impact
- propose remediation
- run approved non-force remediation
- run relevant tests
- update loop state

Forbidden unless explicitly approved:
- `npm audit fix --force`
- major Electron upgrades
- major `electron-builder` upgrades
- unrelated dependency churn
- commit
- push
- release

Definition of done:
- advisories classified
- remediation path proposed or implemented
- tests run

## Autonomous Crate Failure Loop Template
Use this template when Bryant wants Codex to triage and resolve a Crate failure end-to-end without waiting for each next prompt.

```text
Use .codex/playbooks/crate-codex-loops.md for Crate failure <short-name>.
Preauthorization mode: <fix-only|fix-and-PR|fix-PR-and-merge-if-clean>.
Failure source: <qa-smoke|tester-report|github-issue|release-gate-failure|dependency-audit|pr-review-finding|package-diff|provenance-anomaly|production-bug>.
Goal: triage and fix <exact failure> from <version/artifact/PR/report>.
Allowed actions:
- verify repo path, remote, branch, base, and clean tree
- classify the failure with `crate-bug-triage.md`
- use the Crate Fix Review Stack
- create a focused branch from latest origin/v2.4.x only if classification supports a real fix
- inspect the exact failing command, error text, report, or privacy-safe artifact
- identify the smallest plausible code or docs surface
- implement the smallest safe fix
- add or update focused tests when appropriate
- run focused tests, runner-compatible checks, and git diff --check
- run autoreview, regression, security, provenance, and merge-readiness gates as applicable
- commit, push, and open a draft PR only if preauthorization mode allows it
- run merge-readiness only if preauthorization mode allows it
- merge only if preauthorized and no blockers exist
- return the next QA, tester, release-gate, or follow-up prompt

Stop conditions:
- credentials/tokens/passwords
- Keychain/signing prompts
- Apple Developer secrets
- private-file ambiguity
- product decision ambiguity
- dependency mutation
- crate-web changes
- build/release/tag/notarize unless explicitly approved
- final public v2.8.0
- get-crate.com/site deploy
- merge-readiness requests changes
- tests fail and cannot be safely resolved
- scope expands beyond loop goal
```

Crate failure loop phases:
1. Triage failure.
2. Create branch.
3. Implement fix.
4. Run tests.
5. Self-review.
6. Commit if preauthorized.
7. Push if preauthorized.
8. Open PR if preauthorized.
9. Run merge-readiness if preauthorized.
10. Merge if preauthorized and no blockers.
11. Return next QA release prompt.

## Autonomous Smoke Failure Fix Loop Variant
The old smoke-failure loop is retained as a named variant:

```text
Autonomous Smoke Failure Fix Loop = Autonomous Crate Failure Loop with Failure source: qa-smoke
```

Use this variant when the input is a Jenna installed-app smoke report or another structured QA smoke result. It must still use the Crate Fix Review Stack before implementation and before merge.

Required final output:
- failure source and classification
- root cause or best-supported failure path
- files changed
- tests/checks run
- PR URL if opened
- merge status if preauthorized
- remaining risk
- exact next QA release prompt

## Crate-Specific Loop Examples

### v2.8 QA Prerelease Loop
Goal:
- Run release gates until the approved prerelease is published or a stop condition is hit.

Allowed:
- use `crate-release-gate.md`
- run approved tests/checks
- perform each release mutation only after explicit approval or exact release-gate preauthorization
- record artifact/version/hash state

Stop:
- failed tests
- signing/Keychain prompt
- artifact mismatch
- tag/release conflict
- dirty tree
- any final public release or site deploy action

Done:
- approved prerelease exists
- artifacts and hashes are reported
- QA checklist is returned
- no final public release/site deploy occurred

### Jenna Real-File QA Loop
Goal:
- Run installed-app QA on Jenna's approved real-file workflows without contaminating packages or exposing private files.

Allowed:
- launch installed Crate
- use explicit-add and live-watch workflows
- use Finder and approved creative apps
- record pass/fail and approved package output paths

Stop:
- unexpected files
- private file ambiguity
- package contamination
- credential/account prompt
- unapproved client data exposure

Done:
- approved workflow passes, or first blocker has reproducible details and safe artifact references.

### Active-Session Provenance Fix Loop
Goal:
- Fix active-session provenance behavior using the central evidence collection and decision layer.

Allowed:
- inspect relevant evidence collection and central decision-layer code
- apply the smallest approved fix
- add/update focused tests
- run targeted provenance tests
- run `git diff --check`

Stop:
- scope drift into unrelated parser/watcher behavior
- product ambiguity
- failing tests that require broader design decisions
- commit approval when not preauthorized

Done:
- fix and tests are ready
- checks pass
- no unrelated files changed
- Codex stops before commit unless preauthorization allows it.

### Figma Scope QA Loop
Goal:
- Verify Figma Current Page Only and Entire File behavior with diagnostics privacy and no token leakage.

Allowed:
- inspect Figma scope behavior
- run approved Figma QA/tests
- inspect diagnostics output for privacy-safe summaries
- use relevant Figma regression playbooks

Stop:
- page lock cannot resolve
- token or credential exposure risk
- private file ambiguity
- multi-app capture regression
- product decision ambiguity

Done:
- Current Page Only and Entire File behaviors are classified
- diagnostics privacy is checked
- token leakage risk is reported
- exact next prompt is returned if a fix is needed.

### Final Public v2.8 Readiness Loop
Goal:
- Aggregate blockers, non-blockers, QA state, release state, and next action for public `v2.8`.

Allowed:
- inspect branch/PR/release state
- run read-only checks
- synthesize QA results
- recommend next highest-leverage action

Forbidden:
- publish final release
- deploy site
- create public stable tag
- edit code unless separately approved

Done:
- readiness matrix is current
- blockers and non-blockers are separated
- exact next prompt is returned
- no public final release action occurred.

## Relationship To Existing Playbooks
This playbook orchestrates existing playbooks. It does not replace:
- `crate-release-gate.md`
- `crate-autoreview.md`
- `clawpatch-fix.md`
- `review-crate-pr.md`
- `crate-bug-triage.md`
- `crate-runner-loop.md`
- `crate-qa-results-synthesizer.md`
- `crate-tester-intake.md`
- `crate-regression-detector.md`
- `crate-security-scan.md`
- `crate-provenance-review.md`
- `crate-computer-use-qa.md`
- `crate-gui-repro-flow.md`
- `crate-package-diff.md`
- `crate-handoff.md`

When another playbook has stricter gates, the stricter gate wins.

## Definition Of Done
- Loop type is named.
- Preauthorization mode is named.
- Goal and definition of done are explicit.
- Allowed actions and forbidden actions are explicit.
- Start gate has been checked.
- Loop state is maintained when useful and kept local unless Bryant approves committing it.
- Keepalive status is captured in `/handoff state` when heartbeat is used.
- Each iteration observes, plans, acts, checks, evaluates, and either continues or hands off.
- Stop gates are honored.
- Final report includes commands run, files changed, tests/checks, risks, approval needed, and the exact next prompt if Bryant action is required.

## Report Format
- Active loop and orchestrated playbooks.
- Preauthorization mode.
- Branch, base, HEAD, PR, and working tree state.
- Goal and definition of done.
- Allowed action set used.
- Iterations completed.
- Keepalive status, if used.
- Files changed, if any.
- Tests/checks run, with exact commands.
- Current blocker or stop condition.
- Risks/open questions.
- Approval needed.
- Whether Bryant can proceed.
