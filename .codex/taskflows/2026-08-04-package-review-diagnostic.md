# Taskflow: Package Review Diagnostic Evidence

## Metadata

- created: 2026-08-04
- updated: 2026-08-04
- owner: Crate Chief of Staff
- standing order: SO-002 Autonomous Crate Failure Loop
- repo: bfeintuch123/crate-app
- branch: codex/diagnose-package-review-scan
- base: origin/v2.4.x at d111d805f6e55ed7fc5055f8eb07e41864dd2de7
- mode: diagnostic-only merge-readiness correction
- status: ready-for-approved-commit

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

- current phase: corrected candidate passed local verification and Deep Autoreview
- last completed checkpoint: Deep Autoreview returned `APPROVE_CANDIDATE` with no blocker, high, or medium findings
- next action: commit and push under Bryant's existing approval, wait for fresh CI, then rerun source merge-readiness
- blocker: none
- approval state: Bryant approved this narrow correction and a follow-up commit/push to PR #180; merge, build, and release mutations remain unapproved

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
| 2026-08-04 | Created isolated worktree | Fresh isolated worktree from the recorded canonical base | PASS |
| 2026-08-04 | Implemented diagnostic-only evidence | Aggregate timing/count metrics, typed phases, renderer allowlist | PASS |
| 2026-08-04 | Focused backend verification | 8 lifecycle/metadata tests | PASS |
| 2026-08-04 | Renderer verification | 32 tests | PASS |
| 2026-08-04 | Full provenance verification | 269 ordinary cases plus the `/Users/Shared` legacy PowerPoint case separately verified | PASS |
| 2026-08-04 | Deep Autoreview | Stale-metric finding corrected; re-review verdict `APPROVE_CANDIDATE` | PASS |
| 2026-08-04 | Bloat trim | Removed 10 duplicate test assertions; no production evidence removed | PASS |
| 2026-08-04 | Source merge-readiness review | Final `projects:package` path returned bare scan errors and dropped existing allowlisted evidence | BLOCKER FOUND |
| 2026-08-04 | Confirmation-path correction | Return the existing privacy-safe diagnostic shape for final scan-in-flight and scan-incomplete failures | PASS |
| 2026-08-04 | Focused backend verification | Final package confirmation plus adjacent metadata/diagnostic regressions, 8/8 | PASS |
| 2026-08-04 | Renderer confirmation verification | Exact Package Now diagnostic path plus full renderer suite, 33/33 | PASS |
| 2026-08-04 | Full backend/provenance verification | 271/272 in sandbox; sole `/Users/Shared` permission fixture passed separately, effective 272/272 | PASS |
| 2026-08-04 | Static verification | `node --check` for main and renderer plus `git diff --check` | PASS |
| 2026-08-04 | Deep Autoreview | No blocker, high, or medium findings; verdict `APPROVE_CANDIDATE` | PASS |

## Risks

- Diagnostic output could expose private paths or file names; metrics must remain aggregate and privacy-safe.
- A renderer-only copy change could hide the backend typed error; tests must prove the backend error remains unchanged and is surfaced precisely.
- Instrumentation can accidentally alter timing; avoid new filesystem work and record counters already available in the existing scan.

## Handoff

Next exact action:

```text
After focused verification and Autoreview pass, use Bryant's existing approval to commit and push the correction to PR #180. Then rerun source merge-readiness and stop before merge, build, release, or installed QA.
```
