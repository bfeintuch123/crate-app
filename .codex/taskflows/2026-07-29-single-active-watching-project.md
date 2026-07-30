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
- status: review-corrections-validated

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

- current phase: PR correction publication
- last completed checkpoint: delayed Figma, PSD, and presentation work is activation-bound and the full serial suite passed
- next action: commit and push the corrections, wait for CI, then resolve only the fixed PR review thread
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
- [x] review corrections
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
| 2026-07-29 | PR #166 review correction scope | unresolved GitHub P1 plus independent P2 review | delayed live Figma download/cache and PSD/presentation scan-on-save work must remain bound to the originating activation |
| 2026-07-29 | Implemented delayed-work guards | `main.js` activation token propagation through live Figma, PSD, and presentation paths | stale A work is rejected before cache, project, provenance, activity, and renderer mutation after A -> B -> A |
| 2026-07-29 | Added deterministic regressions | focused Figma and provenance suites | delayed Figma download, PSD read, and presentation extraction cases assert no stale cache or state mutation |
| 2026-07-29 | Focused correction regressions | `node --test --test-concurrency=1 --test-name-pattern='delayed (Figma|presentation|PSD)' tests/figma-link-per-project.test.js tests/provenance-dual-write.test.js` | 3 passed, 0 failed |
| 2026-07-29 | Complete corrected Figma and provenance suites | `node --test --test-concurrency=1 tests/figma-link-per-project.test.js tests/provenance-dual-write.test.js` | 183 passed, 0 failed |
| 2026-07-29 | Remaining focused behavior suites | serial main-window, provenance, PSD, Figma scope/privacy, renderer, admission, and Quick Package tests | 113 passed, 0 failed |
| 2026-07-29 | Full serial suite after review corrections | `node --test --test-concurrency=1 tests/*.test.js` | 447 passed, 0 failed, 1 expected CI-only skip |
| 2026-07-29 | Dependency audit | production and full dependency audits at high severity | 0 vulnerabilities |
| 2026-07-29 | Final Autoreview and risk lanes | full diff, async ownership, regression, security, provenance, runner, and diff-hygiene review | no unresolved source finding; no package, dependency, parser, renderer, release, site, credential, schema, or write-root drift |

## Risks

- Installed-app Test 1 still must be rerun after a future approved tester build; source tests do not claim physical package reproduction.
- `Control_Current.ai` through `lastused-poll` remains intentionally out of scope and pending review, matching the approved boundary.
- The single active project still observes all supported creative apps in that project; this PR changes project routing, not parser attribution within one active project.

## Handoff

Next exact action:

```text
Review the opened PR for base, mergeability, changed-file scope, and CI. Do not merge or begin release work without separate Bryant approval.
```
