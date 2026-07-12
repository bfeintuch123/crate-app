# Taskflow: Crate Ops Design And Launch Readiness

## Metadata

- created: 2026-07-12
- owner: Bryant / Codex chief thread
- standing order: SO-007 Crate Ops Improvement Proposal
- repos: crate-app and crate-ops-plugin
- branches: `codex/ops-design-launch-catalogs`, `codex/ops-design-launch-readiness`
- bases: `origin/v2.4.x`, Crate Ops `origin/main`
- mode: fix-and-PR
- status: ready-for-review

## Goal

Implement X-research batch 17-23 as non-duplicative, review-first capabilities for design quality, safe workflow recording, cross-tester learning, customer-journey/public-asset launch readiness, privacy-first product metrics, dependency posture, and launch incident rehearsal.

## Boundaries

- No app runtime, package engine, parser, provenance, dependency, release, deploy, website, Figma, analytics, automation, or credential mutation.
- Recordings and raw tester/private assets stay outside commits.
- External research is inspiration; local workflows require validation and review.

## State

- current phase: merge-ready review complete
- last completed checkpoint: Crate Ops PR #7 and Crate app PR #124 are clean and mergeable; plugin CI passed
- next action: wait for Bryant's separate approval before merging either PR; merge plugin PR #7 first
- blocker: none
- approval state: Bryant approved moving to the next batch; new PR merges require separate approval

## Checkpoints

- [x] merged baseline confirmed
- [x] duplication and source-evidence audit
- [x] implementation
- [x] validation and adversarial review
- [x] separate PRs and merge-readiness
- [x] proof/state closeout

## Stop Condition

Stop before merging new PRs, changing app or site behavior, recording a live workflow, enabling analytics, mutating dependencies, rehearsing against live systems, or starting release/deploy work without Bryant's separate approval.

## Evidence

| Check | Result |
| --- | --- |
| overlap/ownership audit | seven capabilities retained; launch readiness narrowed to evidence for `crate-ship`; incident rehearsal kept separate |
| plugin behavioral/adversarial tests | 31 pass |
| plugin contract and system validator | pass |
| loop catalog and JSON validation | pass |
| Crate Doctor | 0 failures; expected branch/auth/live-automation warnings |
| app regression baseline | 214 tests pass; one timing-sensitive Keynote case passed on isolated rerun |
| independent security and ownership rereviews | clean |
| app/runtime/dependency scope | no app runtime, renderer, parser, provenance, package, site, or dependency files changed |
| Crate Ops PR | `https://github.com/bfeintuch123/crate-ops-plugin/pull/7`; clean, mergeable, CI pass |
| Crate app ops PR | `https://github.com/bfeintuch123/crate-app/pull/124`; clean, mergeable, correct `v2.4.x` base |
