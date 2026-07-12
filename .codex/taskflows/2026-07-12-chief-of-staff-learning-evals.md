# Taskflow: Chief-Of-Staff Learning And Workflow Evaluations

## Metadata

- created: 2026-07-12
- updated: 2026-07-12
- owner: source-of-truth Codex task
- standing order: SO-007
- repos: crate-ops-plugin and crate-app ops docs
- branches: `codex/chief-of-staff-learning-evals`, `codex/chief-of-staff-learning-evals-catalog`
- bases: `main`, `v2.4.x`
- mode: implementation, validation, PR; no merge without separate approval
- status: ready for coordinated PR review

## Goal

Add explicit preference learning, repeatable synthetic workflow evaluations, privacy-safe aggregate outcome receipts, and evidence-based advisory model/agent routing without creating another memory system, standing order, or top-level loop.

## Scope

Allowed:

- Crate Ops skills, schemas, deterministic scripts, synthetic examples, and tests
- Crate app operations policies, playbooks, catalogs, check suites, taskflow, and state docs

Forbidden:

- app runtime, website, Figma, package engine, parsers, provenance, dependencies
- live inbox, calendar, tester, client, credential, or private file data
- model/provider switching, agent creation policy mutation, paid usage, release, build, deploy, or merge without approval

## State

- current phase: final independent review and coordinated PR preparation
- last completed checkpoint: implementation, 103-test validation, strict schema validation, loop-catalog audit, and Crate Doctor
- next action: resolve final rereview findings, open plugin-first coordinated PRs, and stop before merge
- blocker: none
- approval state: Bryant approved implementation; new PR merge requires separate approval
- preferences applied: current Codex task remains chief of staff; explicit preferences only
- routing decision: frontier review with one builder and independent product/security reviewers because authority and privacy contracts cross repositories
- workflow eval suite/result: 2/2 synthetic pinned-contract cases pass; mismatch and stale-contract probes fail closed
- outcome receipt: generator, local signature, evidence-file hashing, tamper rejection, and exact-route matching validated; durable closeout receipt follows merged canonical evidence

## Checkpoints

- [x] preflight / canonical branches confirmed
- [x] context loaded and duplication audit completed
- [x] implementation
- [x] verification
- [x] proof bundle / outcome-receipt mechanism validated
- [x] ledger/state update
- [ ] coordinated PRs and handoff

## Risks

- preference records becoming accidental action authority
- eval fixtures leaking private data or testing themselves rather than real routing contracts
- receipts becoming surveillance or unsupported cost claims
- evidence-based routing silently changing models or delegation

## Handoff

Next exact action: complete independent rereview, open plugin-first coordinated PRs, run merge-readiness, and stop before merge pending Bryant approval.
