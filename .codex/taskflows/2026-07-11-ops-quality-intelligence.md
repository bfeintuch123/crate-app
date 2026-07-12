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

- current phase: PR preparation
- last completed checkpoint: implementation, adversarial hardening, and full validation passed
- next action: commit, open separate PRs, and run merge-readiness review
- blocker: none
- approval state: Bryant approved moving to the next batch; new PR merges require separate approval

## Checkpoints

- [x] merged baseline confirmed
- [x] duplication and source-evidence audit
- [x] implementation
- [x] validation and adversarial review
- [ ] separate PRs and merge-readiness
- [ ] proof/state closeout

## Stop Condition

Stop before merging new PRs, changing app behavior, enabling automations, or incurring paid usage without Bryant's separate approval.

## Evidence

| Check | Result |
| --- | --- |
| duplication/source audit | existing owners extended; only three genuinely new skills |
| plugin contract and official validator | pass |
| plugin unit/adversarial tests | 14 pass |
| safety hook tests | pass |
| feature inventory | 12 features, 0 missing evidence procedures |
| loop/automation/context/architecture tools | pass |
| Crate Doctor | 0 failures; expected branch/auth/live-automation warnings |
| focused app regression suites | 214 pass, including 106 provenance dual-write tests |
| independent ownership/security rereviews | clean |
| scope | no app runtime, dependency, release, deploy, or paid API mutation |
