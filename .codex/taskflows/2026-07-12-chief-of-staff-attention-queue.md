# Taskflow: Chief-Of-Staff Attention Queue

## Metadata

- created: 2026-07-12
- updated: 2026-07-12
- owner: source-of-truth Codex task
- standing order: SO-011 Chief-Of-Staff Attention Management
- repos: crate-app and crate-ops-plugin
- branches: `codex/chief-of-staff-attention-queue-catalog` and `codex/chief-of-staff-attention-queue`
- bases: `origin/v2.4.x` and Crate Ops `origin/main`
- mode: fix-and-PR
- status: ready-for-pr

## Goal

Create a privacy-safe, freshness-aware control index that lets the current Codex task act as Bryant and Jenna's chief of staff, prioritize active work, route it through existing Crate loops, supervise bounded agents or tasks, and integrate evidence without creating another source of truth.

## Scope

Allowed:

- plugin schema, synthetic example, ID generator, validator/renderer, tests, skill, and references
- app standing order, loop catalog, router, registry, docs index, taskflow, ledger, and current-workstream updates
- temporary synthetic validation outputs

Forbidden:

- app runtime, site, Figma, package engine, parsers, provenance, dependencies, release, deploy, credentials, live tester data, raw inbox/calendar content, or live queue snapshots in Git
- merging either PR without Bryant's separate approval

## State

- current phase: coordinated PR publication and merge-readiness
- last completed checkpoint: implementation, 83-test regression suite, strict schema probes, route-catalog audit, and independent product/security reviews completed with no P0/P1/P2 findings
- next action: open the plugin PR first, then the dependent app catalog/docs PR, and run merge-readiness
- blocker: none
- approval state: Bryant approved item 1 implementation; merge requires separate approval

## Checkpoints

- [x] preflight and isolated branches
- [x] context and duplication review
- [x] implementation
- [x] synthetic and adversarial verification
- [x] independent review
- [x] proof and state update
- [ ] separate PRs and merge-readiness

## Evidence

- 83 plugin tests passed, including source approval actors, anonymous-authority rejection, joint approval, route ownership, privacy, freshness, dedupe, reconciliation, output safety, and shared-helper regressions.
- Crate Ops validator and official plugin validator passed.
- Ajv Draft 2020-12 strict compilation and adversarial probes passed.
- Plugin route/standing-order map matches the app loop catalog.
- App loop catalog JSON, playbook existence, and diff checks passed.
- Crate Doctor reported zero failures; environment warnings were pre-existing and outside this docs/plugin scope.
- Independent product and security reviews reported no P0/P1/P2 blockers and recommended plugin-first coordinated PRs.

## Risks

- stale queue state could mislead decisions unless every source refresh remains explicit
- copied private source content would turn a control index into an unsafe archive
- queue placement could be mistaken for authority unless validation and standing orders remain strict
- duplicated signals could inflate priority unless dedupe keys are enforced

## Handoff

Next exact action:

```text
Finish the chief-of-staff attention queue validation, open the plugin PR first and dependent app catalog PR second, run merge-readiness, and stop before merge.
```
