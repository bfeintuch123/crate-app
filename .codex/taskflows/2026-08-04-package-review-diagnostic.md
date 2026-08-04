# Taskflow: Package Review Diagnostic Evidence

## Metadata

- created: 2026-08-04
- updated: 2026-08-04
- owner: Crate Chief of Staff
- standing order: SO-002 Autonomous Crate Failure Loop
- repo: bfeintuch123/crate-app
- branch: codex/diagnose-package-review-scan
- base: origin/v2.4.x at d111d805f6e55ed7fc5055f8eb07e41864dd2de7
- mode: diagnostic-only fix preparation
- status: ready-for-review

## Goal

Expose the exact typed Package Review preparation failure and bounded scan metrics needed to diagnose the Beta 2.7.2 Jenna-machine blocker without changing discovery, packaging, quota, watcher, parser, provenance, or fail-closed behavior.

## Scope

Allowed:

- Add privacy-safe diagnostic fields for typed Package Review preparation failures.
- Record elapsed phase time, candidate count, xattr resolution count, metadata fallback count, and timeout/failure phase.
- Add focused deterministic tests proving the evidence is surfaced without changing behavior.

Forbidden:

- Change the package discovery algorithm, timeout, review token rules, or package contents.
- Bypass `package_scan_incomplete` or weaken fail-closed behavior.
- Refactor oversized modules during this diagnostic step.
- Commit, push, open a PR, merge, build, sign, notarize, release, install, deploy, or contact testers without the applicable Bryant approval.

## State

- current phase: approved staging, commit, push, and draft PR
- last completed checkpoint: corrected candidate passed focused checks, full provenance coverage, and Deep Autoreview
- next action: obtain Bryant approval for the exact GitHub mutation scope
- blocker: none
- approval state: Bryant approved staging the five scoped files, committing, pushing, and opening a PR; merge and release mutations remain unapproved

## Checkpoints

- [x] preflight / doctor
- [x] context loaded
- [x] implementation or execution
- [x] verification
- [x] proof bundle
- [ ] ledger/state update
- [x] handoff or next prompt

## Evidence

| Time | Action | Evidence | Result |
| --- | --- | --- | --- |
| 2026-08-04 | Verified canonical remote | `origin/v2.4.x` = `d111d805f6e55ed7fc5055f8eb07e41864dd2de7` | PASS |
| 2026-08-04 | Ran Crate Doctor in preserved root | 0 failures; dirty-root and unavailable release credentials warned | PASS for isolated source work |
| 2026-08-04 | Created isolated worktree | `/private/tmp/crate-package-review-diagnostic.re1af9` | PASS |
| 2026-08-04 | Implemented diagnostic-only evidence | Aggregate timing/count metrics, typed phases, renderer allowlist | PASS |
| 2026-08-04 | Focused backend verification | 8 lifecycle/metadata tests | PASS |
| 2026-08-04 | Renderer verification | 32 tests | PASS |
| 2026-08-04 | Full provenance verification | 269 ordinary cases plus the `/Users/Shared` legacy PowerPoint case separately verified | PASS |
| 2026-08-04 | Deep Autoreview | Stale-metric finding corrected; re-review verdict `APPROVE_CANDIDATE` | PASS |
| 2026-08-04 | Bloat trim | Removed 10 duplicate test assertions; no production evidence removed | PASS |

## Risks

- Diagnostic output could expose private paths or file names; metrics must remain aggregate and privacy-safe.
- A renderer-only copy change could hide the backend typed error; tests must prove the backend error remains unchanged and is surfaced precisely.
- Instrumentation can accidentally alter timing; avoid new filesystem work and record counters already available in the existing scan.

## Handoff

Next exact action:

```text
If Bryant approves, stage the four code/test files and this taskflow, commit, push, and open a PR against v2.4.x. Stop before merge, build, release, or installed QA.
```
