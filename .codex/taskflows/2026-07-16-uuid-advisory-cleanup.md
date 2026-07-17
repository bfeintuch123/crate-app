# Taskflow: UUID Advisory Cleanup

## Metadata

- created: 2026-07-16
- updated: 2026-07-16
- owner: source-of-truth Codex task; single builder
- standing order: SO-002, with the dependency mutation explicitly authorized by Bryant for this bounded cleanup
- repo: crate-app worktree `/private/tmp/crate-uuid-cleanup.aNhf6r/repo`
- branch: `codex/security-uuid-cleanup`
- base: exact merged `origin/v2.4.x` commit `b44453c0854af64fa83cf5345054e34151d3b754`
- mode: implementation and validation; stop before git publication, build, install, release, deploy, updater, or tester work
- status: implementation, exact-base validation, post-finding correction, and final no-finding rereview complete; ready for Bryant's separate staging, commit, push, and PR approval

## Goal

Remove Crate's direct `uuid@9.0.1` production dependency and its moderate advisory by replacing the two `uuid.v4()` calls with the existing Node `crypto.randomUUID()` API, while preserving generated UUID semantics and all app, package, Figma, and provenance behavior.

## Scope

Allowed:

- inspect all source, test, manifest, and lockfile ownership of `uuid`
- add the narrowest useful failure-first source-policy regression coverage
- edit only the minimum required source, tests, `package.json`, and `package-lock.json`
- use npm only with lifecycle scripts disabled for the package/lock mutation
- update this taskflow, `.codex/state/current-workstream.md`, and `.codex/state/daily-crate-ledger.md` with privacy-safe evidence
- run focused, deterministic full-suite, audit, syntax, whitespace, protected-surface, privacy, provenance, exact-base, and review checks

Forbidden:

- `uuid` major upgrade, `npm audit fix`, `npm update`, or `npm dedupe`
- watcher, parser, package selection/output, Figma scope, provenance schema/behavior, quota, renderer, UI, or tester-data changes
- canonical `/Users/bryantfeintuchclaw/Projects` checkout mutation
- git add, commit, push, PR creation, merge, tag, build, signing, notarization, app install, release, deploy, updater work, or Olivia restart
- more than one read-only reviewer at a time

## State

- current phase: frozen candidate awaiting publication approval
- last completed checkpoint: final narrow Autoreview returned `NO_ACTIONABLE_FINDINGS` after the stale-proof P2 was corrected
- next action: Chief review and Bryant approval before git add, commit, push, or PR creation
- blocker: none
- approval state: Bryant explicitly authorized this bounded dependency cleanup and required a stop before staging
- preferences applied: minimum diff, ignore-scripts npm mutation, no unrelated changes, privacy-safe evidence
- routing decision: Clawpatch fix plus release-blocker Crate Fix Review Stack
- workflow eval suite/result: focused 17/17; impacted main-process 190/190; exact-base Node 22 complete suite 401 total, 400 passed, zero failed, one intentional CI-only skip
- outcome receipt: implementation complete; publication not authorized

## Checkpoints

- [x] repo, branch, exact base, remote, and clean starting state verified
- [x] required instructions, standing order, shared gates, and review playbooks loaded
- [x] direct `uuid` source usage and lockfile ownership inspected
- [x] failure-first source-policy regression captured
- [x] minimum runtime, test, manifest, and lockfile cleanup implemented
- [x] focused and complete deterministic source verification passed
- [x] audit, syntax, whitespace, protected-surface, privacy, and provenance checks passed
- [x] exact-base Reprobox verification passed
- [x] release-blocker Autoreview and affected reruns passed
- [x] proof summary and Crate state files updated
- [x] stop before staging and handoff to Bryant

## Evidence

| Time | Action | Evidence | Result |
| --- | --- | --- | --- |
| 2026-07-16 | Start gate | `git status --short --branch`; `git rev-parse HEAD`; `git merge-base HEAD origin/v2.4.x`; `git worktree list --porcelain` | Clean assigned worktree; branch and exact base both match `b44453c0854af64fa83cf5345054e34151d3b754`; canonical checkout not used |
| 2026-07-16 | Dependency ownership | bounded `rg`; package manifest/lock inspection; `npm ls uuid --all --package-lock-only --ignore-scripts --json` | Exactly two `uuid.v4()` calls in `main.js`; `uuid@9.0.1` is direct root-only production dependency with no transitive owner |
| 2026-07-16 | Failure-first policy | `node --test --test-name-pattern='runtime UUID policy' tests/app-content-policy.test.js` on the unmodified base | Expected failure: direct dependency/import still present and Node crypto calls absent |
| 2026-07-16 | Minimum cleanup | `crypto.randomUUID()` at the two existing call sites; root manifest and lock comparison | Direct dependency and exact root-only lock record removed; no other dependency version or lock record changed |
| 2026-07-16 | Focused behavior | `node --test --test-concurrency=1 tests/app-content-policy.test.js tests/main-window-lifecycle.test.js`; impacted main-process lanes | 17/17 and 190/190 passed; deterministic crypto stubs preserve existing test behavior |
| 2026-07-16 | Exact-base Reprobox | `/private/tmp/crate-uuid-reprobox.QD9xs4/repo`; `npm ci --ignore-scripts`; install-script policy; full and production-only audits | 433 packages reconstructed without lifecycle scripts; six approved lifecycle packages; zero vulnerabilities in both audits |
| 2026-07-16 | Node 22 complete suite | `npx --yes node@22.23.1 --test --test-concurrency=1 tests/*.test.js` in the dependency-complete exact-base Reprobox | 401 tests total; 400 passed; zero failed; one intentional CI-only skip |
| 2026-07-16 | Release-blocker Autoreview | complete diff, lock drift, runtime compatibility, test fidelity, package/Figma/provenance scope | One P2: taskflow proof was stale; no code or behavioral finding. Durable evidence corrected for final rereview |
| 2026-07-16 | Final rereview | corrected taskflow, current-workstream, daily ledger, frozen implementation and package diff | `NO_ACTIONABLE_FINDINGS`; reviewer closed |

## Risks

- Removing a production dependency changes the packaged dependency closure even though runtime behavior is unchanged; exact manifest/lock comparison and packaged-content policy therefore remain required evidence.
- The temporary Node 22 runner and exact-base Reprobox prove source/runtime compatibility only. No signed-app, installed-app, notarization, or public-release proof is claimed.

## Handoff

Next exact action:

```text
Review the frozen candidate evidence and, only with Bryant's explicit approval, stage the listed files, commit, push, open a PR against `v2.4.x`, and run fresh CI plus merge readiness. Stop before merge or any build/release activity without separate approval.
```
