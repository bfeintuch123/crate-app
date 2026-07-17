# Taskflow: Persistent Task Bridge Discovery

## Metadata

- created: 2026-07-16
- owner: source-of-truth Codex task; one builder
- standing order: SO-005 external control
- repo: crate-app isolated worktree
- branch: `codex/ops-thread-bridge-discovery`
- base: exact merged `origin/v2.4.x` commit `29a651619fdd6c47396fc97dd7e150e5bdddfd95`
- mode: ops-tool repair and validation
- status: implementation and final no-finding Autoreview complete; ready for publication gates

## Goal

Restore the local persistent task bridge after the desktop executable moved
from the legacy Codex app bundle to the ChatGPT app bundle, without changing
Crate application or release behavior.

## Scope

Allowed:

- executable discovery in `.codex/tools/codex_thread_control.py`
- failure-first unit coverage for discovery order and safe failures
- external-control playbook, check-suite, taskflow, and durable state updates
- live read-only bridge validation and one bounded task-creation probe
- Autoreview and merge-readiness checks

Forbidden:

- Crate app runtime, renderer, parser, package, Figma, provenance, or dependency changes
- build, signing, notarization, installation, release, deploy, updater, or tester actions
- mutation of the dirty canonical checkout
- final integrated six-phase audit before this repair closes

## State

- current phase: publication gate
- last checkpoint: final independent rereview returned `NO_ACTIONABLE_FINDINGS`
- next action: commit, push, open a PR against `v2.4.x`, require fresh CI and merge readiness, and merge only if clean
- blocker: none

## Checkpoints

- [x] exact merged base and isolated worktree verified
- [x] hard-coded legacy executable root cause confirmed
- [x] current ChatGPT executable and legacy-path absence confirmed
- [x] failure-first discovery tests captured
- [x] focused tests and ops check suite pass
- [x] live bridge list and task-creation probe pass
- [x] Autoreview reports no actionable findings
- [ ] publication and merge gates close

## Evidence

| Date | Action | Result |
| --- | --- | --- |
| 2026-07-16 | Root-cause inspection | Bridge used only `/Applications/Codex.app/Contents/Resources/codex`; current executable is under the ChatGPT app bundle |
| 2026-07-16 | Failure-first tests | Five discovery cases fail because `resolve_codex_executable` does not exist on the base |
| 2026-07-16 | Focused discovery tests | Resolver order, validated override, bundle and `PATH` fallback, privacy-safe failure, and temporary-server use pass |
| 2026-07-16 | Live bridge probe | List passed; persistent task `019f6dab-2c6e-7383-a1fb-c4515f11c287` completed and returned `BRIDGE_PROBE=PASS`; archive is not exposed |
| 2026-07-16 | First Autoreview | Blocked publication on relative-path normalization, launch-error path redaction, and one stale native-tool statement; all three corrected for rereview |
| 2026-07-16 | Final Autoreview | Eight focused tests and complete corrected diff reviewed; `NO_ACTIONABLE_FINDINGS` |
