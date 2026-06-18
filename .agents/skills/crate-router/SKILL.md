---
name: crate-router
description: Route Crate requests to the correct playbooks, loops, check suites, state files, and stop gates. Use when Bryant asks for Crate status, QA synthesis, smoke-failure triage, internal QA prerelease gates, PR review or merge readiness, Jenna prompt generation, workflow handoff, or short Crate commands that should select the right existing Crate process without restating every playbook.
---

# Crate Router

Use this skill to turn short Bryant prompts into the right Crate workflow.

## First Read

Read these files as needed:

- `.codex/ROUTER.md` for task routing.
- `.codex/state/current-workstream.md` for the latest Crate state.
- `.codex/playbooks/_shared-gates.md` for common stop gates.
- `.codex/checks/crate-check-suites.md` for named checks.
- `WORKSPACE.md` for repo boundaries.

Only read the detailed playbooks selected by the router. Avoid loading every playbook by default.

## Start Gate

Before mutating work, confirm repo path, remote, branch, working tree, requested mode, and allowed actions. For crate-app work, the default repo is `/Users/bryantfeintuchclaw/Projects`, remote `bfeintuch123/crate-app.git`, base `v2.4.x`.

If the request could touch crate-web, mission-control, credentials, private files, release signing, notarization, deploys, tags, or final public release state, require explicit Bryant approval for that scope.

## Routing

Use `.codex/ROUTER.md` to choose the workflow:

- status or next action: current workstream plus workstream-status playbook.
- Jenna QA report: QA results synthesizer, then bug triage if needed.
- Crate failure: Autonomous Crate Failure Loop plus the full Crate Fix Review Stack.
- smoke failure: Autonomous Smoke Failure Fix Loop variant, which is the Crate Failure Loop with `qa-smoke` as the failure source.
- internal QA prerelease: release gate plus release-blocker review playbooks.
- PR merge readiness: review-crate-pr plus relevant review playbooks.
- Jenna prompt generation: smoke prompt bank plus privacy gates.
- handoff: crate-handoff skill and playbook.

For Crate Failure Loop or Smoke Failure Fix Loop requests, automatically include:
- `crate-bug-triage.md`
- `clawpatch-fix.md`
- `crate-autoreview.md`
- `crate-regression-detector.md`
- `crate-security-scan.md`
- `crate-provenance-review.md`
- `crate-runner-loop.md`
- `review-crate-pr.md`
- `crate-handoff.md`

## Output

State:

- selected route
- repo/branch status
- autonomy mode
- files or artifacts in scope
- stop gates
- next action or exact prompt

When a task completes, include the standard final report from `_shared-gates.md`.
