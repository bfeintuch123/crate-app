# Taskflow: Single Active Watching Project

## Metadata

- created: 2026-07-29
- updated: 2026-07-29
- owner: Codex
- standing order: SO-002 Autonomous Crate Failure Loop
- repo: crate-app
- branch: `fix/single-active-watching-project`
- base: `982d8de2a7dee5ffff6411d13d4ce0dcc2f49a0a`
- mode: fix-and-PR
- status: ready-for-pr

## Goal

Prevent cross-project file attribution by enforcing exactly one Watching project, repairing legacy multi-Watching state at startup, and rejecting capture work from superseded watcher sessions.

## Scope

Allowed:

- project start, resume, pause, and startup-repair state transitions
- watcher and Illustrator live-evidence delivery guards
- focused regression tests
- required Crate Fix Review Stack evidence
- commit, push, and PR against `v2.4.x`

Forbidden:

- package, parser, Figma-scope, generic watcher, or pending-review behavior changes beyond active-project routing
- dependency changes
- build, signing, notarization, release, deploy, merge, or Jenna QA
- changes outside `/private/tmp/crate-single-active-watching`

## State

- current phase: PR publication
- last completed checkpoint: full serial test suite passed 444/444 runnable tests
- next action: commit, push, and open a PR against `v2.4.x`
- blocker: none
- approval state: Bryant approved implementation, commit, push, and PR; merge and release are forbidden
- preferences applied: one builder, narrow diff, no release activity
- routing decision: `crate-bug-triage` -> `clawpatch-fix` -> full Crate Fix Review Stack
- workflow eval suite/result: Crate Fix Review Stack passed; no code finding remained
- outcome receipt: pending PR URL and mergeability

## Checkpoints

- [x] preflight
- [x] context loaded
- [x] implementation
- [x] verification
- [x] proof bundle
- [x] ledger/state update
- [ ] handoff

## Evidence

| Time | Action | Evidence | Result |
| --- | --- | --- | --- |
| 2026-07-29 | Verified branch and exact base | `git status --short --branch`; `git rev-parse HEAD` | clean; exact approved base |
| 2026-07-29 | Traced capture fan-out | `main.js` project IPC, startup recovery, watcher and live-app pollers | multiple Watching projects each installed global app observation pipelines |
| 2026-07-29 | Baseline focused tests | `node --test tests/figma-link-per-project.test.js tests/provenance-dual-write.test.js` | 176 passed, 0 failed |
| 2026-07-29 | Implemented single active watcher | `main.js` activation transition, startup repair, runtime session tokens | prior watcher state paused in one store write; stale async capture rejected |
| 2026-07-29 | Added regressions | focused project lifecycle, stale watcher, and Illustrator attribution tests | startup repair, start/resume, generic watcher, and Illustrator isolation covered |
| 2026-07-29 | Focused behavior suites | `node --test --test-concurrency=1` over focused QA, provenance, Figma, and package/parser lanes | 293 passed, 0 failed |
| 2026-07-29 | Dependency audit | `npm audit --audit-level=high`; `npm audit --audit-level=high --omit=dev` | 0 vulnerabilities |
| 2026-07-29 | Exact dependency environment | `npm ci --ignore-scripts --no-audit --no-fund` | lockfile-only install; no source or manifest drift |
| 2026-07-29 | Full serial suite | `node --test --test-concurrency=1 tests/*.test.js` | 444 passed, 0 failed, 1 CI-only test skipped |
| 2026-07-29 | Autoreview and risk lanes | diff scope, regression, security, provenance, and runner-loop review | no unresolved finding; package/parser/Figma/pending behavior preserved |
| 2026-07-29 | Diff hygiene | syntax checks and `git diff --check` | passed; no dependency or release-file diff |

## Risks

- Installed-app Test 1 still must be rerun after a future approved tester build; source tests do not claim physical package reproduction.
- `Control_Current.ai` through `lastused-poll` remains intentionally out of scope and pending review, matching the approved boundary.
- The single active project still observes all supported creative apps in that project; this PR changes project routing, not parser attribution within one active project.

## Handoff

Next exact action:

```text
Review the opened PR for base, mergeability, changed-file scope, and CI. Do not merge or begin release work without separate Bryant approval.
```
