# Taskflow: Generic Watcher Session Boundary

## Metadata

- created: 2026-08-01
- updated: 2026-08-01
- owner: Codex Chief of Staff
- standing order: SO-002 Autonomous Crate Failure Loop
- repo: crate-app
- branch: `codex/fix-generic-watcher-session-boundary`
- base: `b2229c2c59de225996ae08edc5f31b2cd024c29f`
- mode: fix-and-PR
- status: source-and-independent-review-pass-pr-preparation

## Goal

Prevent stale or delayed generic filesystem events from an earlier project or
Watching session from being accepted into the currently Watching project.

## Evidence And Product Decision

- Beta 2.5 enforced exactly one Watching project.
- With Project A paused, Project B watching, and both Illustrator documents
  open, `A_Project.ai` was accepted into Project B through `chokidar/change`.
- The source file's modification time predated Project B's Watching session.
- The structured Illustrator poll excluded the inactive Project A document.
- Olivia's follow-up described a separate one-project Figma plus Illustrator
  incident. That exact sequence remains a later test and fix lane.
- This fix is entirely backend. It must not add prompts, ownership overrides,
  or per-file decisions. Existing Add Files behavior remains unchanged.

## Approved Order

1. Seal generic watcher work to a unique Watching-session boundary.
2. Run source tests and the full Crate Fix Review Stack.
3. Open a focused PR against `v2.4.x`; stop before merge.
4. After a separately approved merge/build, rerun the Project A to B QA lane.
5. Only after that lane passes, investigate Olivia's exact one-project Figma
   plus Illustrator sequence in a separate narrow PR if needed.
6. Use a third persisted-state/manifest PR only if the exact sequence proves
   that boundary is faulty.

## Scope

Allowed:

- generic watcher event ownership and session/activation fencing
- cancellation or rejection of stale queued generic watcher work
- focused regression tests for Project A to B transitions
- assertions that current-project Illustrator source and linked assets still
  capture normally
- assertions that existing linked assets and manual Add Files are unchanged
- taskflow and proof documentation for this fix
- commit, push, and PR against `v2.4.x`

Forbidden:

- UI changes or new user decisions
- changes to Add Files behavior
- Figma parser or combined Figma/Illustrator merge changes
- package filtering, Package Review, or pending-review redesign
- dependency changes
- merge, build, signing, notarization, release, install, deploy, website changes,
  or tester communication

## State

- current phase: approved commit, push, and draft PR preparation
- last completed checkpoint: strict-boundary and Add Files race corrections passed focused and complete serial suites plus independent Autoreview and regression review
- next action: commit the scoped files, push, and open the approved draft PR
- blocker: none
- approval state: Bryant approved the ordered implementation and PR sequence;
  merge and every build/release/QA mutation remain separate gates
- graph: canonical `code-fix.json`

## Checkpoints

- [x] live remote and base reconciled
- [x] dirty canonical root preserved
- [x] isolated worktree created
- [x] pre-fix triage and Autoreview
- [x] narrow implementation
- [x] focused verification
- [x] independent Autoreview
- [x] regression, security, and provenance review
- [ ] commit, push, and PR
- [ ] merge-readiness handoff

## Acceptance Criteria

- A generic watcher event created or queued during Project A's Watching session
  cannot mutate Project B after the active session changes.
- Starting or resuming Project B invalidates all superseded generic watcher
  session work before B can receive events.
- A file whose relevant event predates B's Watching session is not accepted into
  B through a broad generic signal.
- `B_Project.ai` and `B_Asset.png` still enter B under the supported Illustrator
  workflow.
- Existing Illustrator linked assets still enter the correct project.
- Manual Add Files retains its current explicit behavior.
- No Figma, package-filtering, Package Review, pending-review, dependency,
  release, or renderer behavior changes.

## Risks

- Filesystem modification time alone is not a sufficient ownership rule because
  users may intentionally add an older existing file. Session provenance must
  distinguish watcher events from explicit Add Files and structured parser
  evidence.
- The strict timestamp boundary can suppress a broad generic event when both
  file timestamps predate Watching. Focused regression coverage must prove an
  existing file saved during Watching and an atomic replacement remain valid;
  explicit Add Files and stronger structured evidence remain unchanged.
- Passing source tests does not replace installed QA on Jenna's Mac.

## Correction Verification Evidence

- `node --check tests/provenance-dual-write.test.js`: passed before the final
  fixture correction and will be rerun in the final stack.
- Corrected focused watcher test-name pattern: 7 passed, 0 failed.
- `tests/provenance-dual-write.test.js`: 222 passed, 0 failed.
- `tests/provenance.test.js`: 7 passed, 0 failed.
- Complete serial `tests/*.test.js`: 548 discovered, 547 passed, 0 failed,
  1 expected CI-only skip.
- `node --check main.js`: passed.
- `node --check tests/provenance-dual-write.test.js`: passed.
- `git diff --check`: passed.
- Full and production-only npm audits: 0 vulnerabilities.
- Fresh `origin/v2.4.x` remains the exact base
  `b2229c2c59de225996ae08edc5f31b2cd024c29f`.
- After the strict-boundary and Add Files race corrections, the focused watcher
  matrix passed 7/7 and the complete serial suite discovered 548 tests with 547
  passed, 0 failed, and the same 1 expected CI-only skip.
- The no-stats Chokidar fallback rejects a stale prior-session change before
  file, pending, provenance, renderer, or parser mutation.
- A fresh `B_Project.ai` first appears as needs-save structured Illustrator
  evidence, then enters through the generic change path and discovers one
  `B_Asset.png`; no A fixture enters B, and a later accepted-source rescan does
  not duplicate either file.
- Autoreview correctly rejected the original two-second tolerance because it
  could admit an A save immediately before B started. The implementation now
  uses the exact Watching boundary; final verification is pending.
- Repeated Autoreview then identified an asynchronous stat race with explicit
  Add Files. The handler now refetches the active project after the stat await,
  preserves a concurrent explicit acceptance, rescans it, and leaves one
  duplicate-free manual entry. Final independent review is pending.

## Next Approval Gate

Stop after the PR and merge-readiness report. Merge, signed QA build, and Jenna
installation/testing require separate explicit approval.
