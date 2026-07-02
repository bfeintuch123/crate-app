# Taskflow: Crate Ops Loop Hardening

## Metadata

- created: 2026-07-02
- updated: 2026-07-02
- owner: Bryant / Codex source-of-truth thread
- standing order: SO-006 External Control / Thread Coordination, plus docs-only ops hardening
- repo: `/Users/bryantfeintuchclaw/Projects`
- branch: `codex/crate-ops-loop-hardening`
- base: `v2.4.x`
- mode: docs/ops-only
- status: ready-for-review

## Goal

Implement the 12 approved Crate ops/workflow improvements and wire them into the existing Crate loops, router, gates, checks, and state files.

## Scope

Allowed:

- `.codex/ops/`
- `.codex/taskflows/`
- `.codex/playbooks/`
- `.codex/checks/`
- `.codex/state/`
- `.codex/decisions/`
- `.codex/tools/`
- `.agents/skills/`
- `AGENTS.md`

Forbidden:

- Crate app source behavior
- package engine, parser, or provenance behavior
- dependency mutation
- release build/sign/notary/tag/GitHub release
- get-crate.com deploy
- crate-web or mission-control work
- credential inspection or token output

## State

- current phase: PR review
- last completed checkpoint: ops docs, skills, doctor tool, router/loop updates, decision, ledger, workstream state, docs/ops checks, commit, push, and PR
- next action: review PR #121, then merge only after Bryant approval and merge-readiness if requested
- blocker: none
- approval state: Bryant approved implementing and formalizing the ops/workflow improvements; merge not yet approved

## Checkpoints

- [x] preflight / repo state observed
- [x] context loaded
- [x] implementation
- [x] verification
- [x] proof bundle
- [x] ledger/state update
- [x] handoff or next prompt

## Evidence

| Time | Action | Evidence | Result |
| --- | --- | --- | --- |
| 2026-07-02 | Created branch | `codex/crate-ops-loop-hardening` | pass |
| 2026-07-02 | Added ops docs/tools | `.codex/ops/`, `.codex/taskflows/`, `.agents/skills/`, `.codex/tools/crate_doctor.py` | pass |
| 2026-07-02 | Updated loops/router | `AGENTS.md`, `.codex/ROUTER.md`, loop/gate/check docs | pass |
| 2026-07-02 | Ran doctor | `python3 .codex/tools/crate_doctor.py` | pass with expected warnings for feature branch and dirty docs worktree |
| 2026-07-02 | Ran syntax/diff checks | `python3 -m py_compile .codex/tools/crate_doctor.py .codex/tools/codex_thread_control.py`; `git diff --check` | pass |
| 2026-07-02 | Ran docs hygiene checks | trailing whitespace clean; ASCII check found pre-existing non-ASCII in historical QA state text | pass with known pre-existing note |
| 2026-07-02 | Committed/pushed/opened PR | commit `b839b74`; PR #121 | pass |

## Risks

- Existing worktree already had unrelated Crate ops/thread-control edits; do not stage or revert unrelated changes without review.
- `crate_doctor.py` is read-only but may report warnings for dirty worktree or branch mismatch when run from a feature branch.

## Handoff

Next exact action:

```text
Review PR #121. If Bryant wants it merged, run merge-readiness first and merge only if clean.
```
