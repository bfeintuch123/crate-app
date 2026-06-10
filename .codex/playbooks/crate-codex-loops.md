# Crate Codex Loops Playbook

## Purpose
Define true autonomous Codex loops for Crate work.

A Crate Loop means Codex continues iterating after one initial prompt until the defined goal is reached or a stop condition is hit. A loop is not a prompt chain. Bryant should not need to provide the next prompt after every step when the loop is inside an approved action set and has a clear definition of done.

This playbook orchestrates existing Crate playbooks. It does not replace focused fix, review, QA, release gate, security, provenance, or package-diff playbooks.

## When To Use
- When Bryant wants Codex to continue working without being prompted for each next step.
- When the task has a clear goal, allowed action set, definition of done, and stop gates.
- When long-running review, QA, fix, release-gate, or readiness work needs durable state and explicit autonomy boundaries.
- When Codex should produce the next safe prompt or approval request after reaching a stop gate.

## Start Prompt
Use a prompt like:

```text
Use .codex/playbooks/crate-codex-loops.md for <loop name>. Goal: <goal>. Allowed actions: <allowed action set>. Definition of done: <done criteria>. Stop at approval gates and do not commit, push, release, build, deploy, tag, notarize, mutate dependencies, or touch out-of-scope files unless explicitly approved.
```

If the loop is a focused code fix, also use `clawpatch-fix.md`. If it is review-only, also use `crate-autoreview.md` or the relevant review playbook. If it is GUI QA, also use `crate-computer-use-qa.md` or `crate-gui-repro-flow.md`. If it is prerelease readiness, also use `crate-release-gate.md`.

## Required Start Gate
Before acting, Codex must confirm:
- repo path
- remote repository
- repo identity is `crate-app`, not `crate-web`
- current branch
- whether the branch is based on the required base branch, usually latest `origin/v2.4.x`
- working tree state
- loop name
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

Use assisted workflow mode when the task lacks a clear action set, has unresolved product ambiguity, needs credentials or account decisions, or requires a high-risk mutation such as commit, push, merge, release, deploy, tag, notarization, dependency mutation, or public site changes.

### Autonomous Loop
An autonomous loop is an approved bounded workflow.

In an autonomous loop:
- Codex observes current state.
- Codex chooses the next allowed action.
- Codex executes it.
- Codex runs checks.
- Codex evaluates the result.
- Codex updates loop state when useful.
- Codex continues without Bryant providing the next prompt.
- Codex stops only at explicit stop gates, definition of done, or a blocker that cannot be safely resolved inside the allowed action set.

Autonomy is scoped. Codex may continue without additional Bryant prompts only inside the loop's allowed action set.

## Autonomous Loop Contract
Every autonomous Crate Loop follows this cycle:

1. Observe current state.
2. Compare against goal and definition of done.
3. Plan the next smallest safe action.
4. Act only inside the allowed action set.
5. Run checks/tests.
6. Evaluate result.
7. Update loop state.
8. Continue or stop.

Codex must keep each iteration small enough that the next state can be inspected, explained, and reversed without broad unrelated churn. If the next smallest safe action is outside the approved action set, Codex stops and asks Bryant for approval.

## Loop State File
Codex should maintain a lightweight loop state file when useful, especially for long-running loops, interrupted work, multi-pass QA, prerelease gates, or review loops that produce staged findings.

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
- goal
- definition of done
- current branch
- current commit
- current PR
- current artifact/version
- current blocker
- last action
- last observation
- changed files
- tests/checks run
- next action
- stop condition
- approval needed
- risks/open questions

## Global Autonomy Rules
Codex may continue without additional Bryant prompts only inside the loop's allowed action set.

Codex must stop for:
- wrong repo/path/branch
- unexpected dirty working tree
- scope creep into another lane
- failed tests that cannot be safely resolved
- product decision ambiguity
- private file ambiguity
- credentials/tokens/passwords
- Keychain/signing prompts
- account/security/billing/admin prompts
- dependency mutation unless explicitly approved
- commit approval unless preapproved
- push approval unless preapproved
- PR creation approval unless preapproved
- merge approval
- build/release/tag/notarization approval
- `get-crate.com` or site deploy approval
- final public `v2.8.0` approval

Codex must not treat silence as approval for any stop gate. If a loop reaches a stop gate, Codex reports the current state, risk, exact approval needed, and the safest next prompt Bryant can use.

## Loop Types

### A. Autonomous Fix Loop
Purpose:
- Implement a focused bug fix or product behavior fix.

Recommended orchestrated playbooks:
- `clawpatch-fix.md`
- `crate-regression-detector.md` when regression coverage is needed
- `crate-provenance-review.md` when provenance behavior is touched
- `crate-security-scan.md` when path, parser, token, shell, package, or privacy risk is present

Allowed:
- create branch
- inspect code
- edit relevant files
- add/update tests
- run tests
- rerun failed tests
- revise implementation
- update loop state

Forbidden unless explicitly approved:
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

Definition of done:
- fix implemented
- focused tests added/updated
- required tests pass
- `git diff --check` passes
- no unrelated files changed
- self-review ready
- final review prompt returned

### B. Autonomous Review Loop
Purpose:
- Read-only investigation or release-blocker review.

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

### C. Autonomous QA Loop
Purpose:
- Installed-app QA with Computer Use/System Events.

Recommended orchestrated playbooks:
- `crate-computer-use-qa.md`
- `crate-gui-repro-flow.md`
- `crate-manual-qa-matrix.md`
- `crate-package-diff.md` when output comparison is in scope

Allowed:
- launch installed app
- inspect visible UI
- run approved QA workflows
- use Finder and approved creative apps
- use Terminal only for safe QA setup/read-only checks/System Events automation when approved
- record pass/fail

Forbidden:
- source code edits
- Git operations
- build/release/deploy/tag/notarize
- account/security/billing/admin settings
- credentials/tokens
- unapproved private/client files
- packaging contaminated projects

Definition of done:
- QA matrix step passes
- or first blocker is captured with reproducible details
- artifacts/paths recorded
- next action recommended

### D. Autonomous Release Gate Loop
Purpose:
- Internal QA prerelease gate such as `qa.10`, `qa.11`, or final release candidate.

Recommended orchestrated playbooks:
- `crate-release-gate.md`
- `release-crate.md` only after Bryant explicitly approves release execution
- `crate-pr-documenter.md` for release notes or tester notes

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
- public stable release action

Definition of done:
- release created as approved prerelease
- all artifacts uploaded
- hashes reported
- no final public release/site deploy occurred
- QA checklist returned

### E. Autonomous Public v2.8 Readiness Loop
Purpose:
- Maintain public `v2.8` go/no-go state.

Recommended orchestrated playbooks:
- `crate-workstream-status.md`
- `crate-release-gate.md`
- `crate-qa-results-synthesizer.md`
- `crate-pr-documenter.md`

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

Definition of done:
- current readiness matrix complete
- next highest-leverage action identified
- exact next prompt returned

### F. Autonomous Provenance / AI-Readiness Loop
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

Forbidden unless explicitly approved:
- AI/LLM calls
- cloud AI data transfer
- raw private evidence collection
- silent inclusion of private files

Definition of done:
- evidence model assessed
- risks stated
- next safe PR identified

### G. Autonomous Security / Dependency Loop
Purpose:
- npm audit/security remediation.

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

## Crate-Specific Loop Examples

### 1. v2.8 QA Prerelease Loop
Goal:
- Run release gates until the approved prerelease is published or a stop condition is hit.

Allowed:
- use `crate-release-gate.md`
- run approved tests/checks
- perform each release mutation only after explicit approval
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

### 2. Jenna Real-File QA Loop
Goal:
- Run installed-app QA on Jenna's approved real-file workflows without contaminating packages or exposing private files.

Allowed:
- launch installed Crate
- use explicit-add and live-watch workflows
- use Finder and approved creative apps
- record pass/fail and package output paths

Stop:
- unexpected files
- private file ambiguity
- package contamination
- credential/account prompt
- unapproved client data exposure

Done:
- approved workflow passes, or first blocker has reproducible details and artifact paths.

### 3. Active-Session Provenance Fix Loop
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
- commit approval

Done:
- fix and tests are ready
- checks pass
- no unrelated files changed
- Codex stops before commit and returns final review prompt.

### 4. Figma Scope QA Loop
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

### 5. Final Public v2.8 Readiness Loop
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
- `crate-regression-detector.md`
- `crate-security-scan.md`
- `crate-provenance-review.md`
- `crate-computer-use-qa.md`
- `crate-gui-repro-flow.md`
- `crate-package-diff.md`

When another playbook has stricter gates, the stricter gate wins.

## Definition Of Done
- Loop type is named.
- Goal and definition of done are explicit.
- Allowed actions and forbidden actions are explicit.
- Start gate has been checked.
- Loop state is maintained when useful and kept local unless Bryant approves committing it.
- Each iteration observes, acts, checks, evaluates, and continues or stops.
- Stop gates are honored.
- Final report includes commands run, files changed, tests/checks, risks, approval needed, and the exact next prompt if Bryant action is required.

## Report Format
- Active loop and orchestrated playbooks.
- Branch, base, HEAD, PR, and working tree state.
- Goal and definition of done.
- Allowed action set used.
- Iterations completed.
- Files changed, if any.
- Tests/checks run, with exact commands.
- Current blocker or stop condition.
- Risks/open questions.
- Approval needed.
- Whether Bryant can proceed.
