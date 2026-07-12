# Taskflow: Crate Ops Safety And Feedback Loops

## Metadata

- created: 2026-07-11
- updated: 2026-07-11
- owner: Bryant / Codex chief thread
- standing order: SO-007 Crate Ops Improvement Proposal
- repos: crate-app and crate-ops-plugin
- branches: `codex/ops-repo-safety-inventory`, `codex/ops-safety-feedback-loops`
- bases: `origin/v2.4.x`, Crate Ops `origin/main`
- mode: fix-and-PR
- status: ready-for-review

## Goal

Add the approved first batch from Bryant's X-bookmark research: a destructive-command guard, safe worktree policy, reviewable skill workshop, outer-loop retrospective, canonical feature inventory, architecture-health audit, operational hygiene checks, and the merged private X research inbox.

## Scope

Allowed:

- Crate Ops hooks, skills, scripts, references, tests, routing, manifest, and README
- `.worktreeinclude`
- `.codex/ops/crate-feature-inventory.json` and generated Markdown
- `.codex/tools/crate_doctor.py`
- taskflow and proof/state documentation

Forbidden:

- app runtime, renderer, package engine, parsers, provenance behavior, dependencies
- build, signing, notarization, release, deploy, or site changes
- secrets, private tester assets, diagnostics, and raw bookmark content in commits

## State

- current phase: merge-ready review
- last completed checkpoint: separate plugin/app PRs opened and passed merge-readiness review
- next action: wait for Bryant's separate approval before merging PR #5 or PR #122
- blocker: none
- approval state: Bryant approved implementation; only PR #4 merge was preapproved

## Checkpoints

- [x] preflight / doctor context reviewed
- [x] context loaded
- [x] implementation or execution
- [x] verification
- [x] proof bundle
- [x] ledger/state update
- [x] handoff or next prompt

## Evidence

| Time | Action | Evidence | Result |
| --- | --- | --- | --- |
| 2026-07-11 | Merge-readiness for Crate Ops PR #4 | CI, local validator, syntax, privacy test | merged as `89aa76b` |
| 2026-07-11 | Plugin validation | plugin validator, syntax compilation, hook adversarial tests, diff and whitespace checks | pass |
| 2026-07-11 | App ops validation | 12-feature evidence inventory, Crate Doctor, JSON, ignore and diff checks | pass with expected branch/auth warnings |
| 2026-07-11 | Focused app regression suites | renderer/Figma, parser, privacy, lifecycle, provenance dual-write | 214 tests passed |
| 2026-07-11 | Independent safety review | destructive-command hook and wrapper/environment bypass rereview | clean |
| 2026-07-11 | Crate Ops PR | `https://github.com/bfeintuch123/crate-ops-plugin/pull/5` | mergeable; CI pass |
| 2026-07-11 | Crate app ops PR | `https://github.com/bfeintuch123/crate-app/pull/122` | mergeable; no configured branch checks |

## Risks

- Hooks have partial tool coverage and must remain defense in depth.
- Feature inventory links prove evidence locations, not runtime correctness.
- Hygiene reporting must not reveal private filenames or delete automatically.

## Handoff

Next exact action:

```text
PR #5 and PR #122 are merge-ready. Stop before merging either PR unless Bryant separately approves.
```
