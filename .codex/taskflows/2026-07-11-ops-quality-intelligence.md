# Taskflow: Crate Ops Quality Intelligence

## Metadata

- created: 2026-07-11
- owner: Bryant / Codex chief thread
- standing order: SO-007 Crate Ops Improvement Proposal
- repos: crate-app and crate-ops-plugin
- branches: `codex/ops-quality-catalogs`, `codex/ops-quality-intelligence`
- bases: `origin/v2.4.x`, Crate Ops `origin/main`
- mode: fix-and-PR
- status: ready-for-review

## Goal

Implement X-research batch 9-16 by extending existing Crate owners for feature coverage, loop discovery, context packs, visual evidence, architecture health, and ops hygiene, while adding review-only instruction and model/cost routing.

## Boundaries

- No app runtime, package engine, parser, provenance, dependency, release, deploy, or website mutation.
- No automatic refactor, instruction rewrite, automation deletion, model switch, or paid API call.
- Private bookmark content remains outside commits; only concise source themes may be recorded.

## State

- current phase: merge-ready review
- last completed checkpoint: PR #6 and PR #123 opened and passed merge-readiness review
- next action: wait for Bryant's separate approval before merging either PR
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

Stop before merging new PRs, changing app behavior, enabling automations, or incurring paid usage without Bryant's separate approval.

## Evidence

| Check | Result |
| --- | --- |
| duplication/source audit | existing owners extended; only three genuinely new skills |
| plugin contract and official validator | pass |
| plugin unit/adversarial tests | 13 pass |
| safety hook tests | pass |
| feature inventory | 12 features, 0 missing evidence procedures |
| loop/automation/context/architecture tools | pass |
| Crate Doctor | 0 failures; expected branch/auth/live-automation warnings |
| focused app regression suites | 214 pass, including 106 provenance dual-write tests |
| independent ownership/security rereviews | clean |
| scope | no app runtime, dependency, release, deploy, or paid API mutation |
| Crate Ops PR | `https://github.com/bfeintuch123/crate-ops-plugin/pull/6`; clean, mergeable, CI pass |
| Crate app ops PR | `https://github.com/bfeintuch123/crate-app/pull/123`; clean, mergeable, correct `v2.4.x` base |
