# Crate Model And Cost Routing

## Purpose

Choose an appropriate capability tier for Crate work without hardcoding model names, prices, or provider claims that can become stale.

## Advisory Tiers

| Tier | Use when | Required review |
| --- | --- | --- |
| Deterministic | Mechanical parsing, validation, hashing, or catalog checks with a passing relevant eval and at least three current receipts | Verify output shape, source links, and fail-closed behavior. |
| Fast | Bounded extraction, summarization, or low-risk read-only checks without sufficient repeated evidence for deterministic routing | Verify output shape and source links. |
| Standard | Routine implementation, focused tests, docs, QA synthesis, or scoped browser work | Run the selected Crate checks and inspect the diff. |
| Frontier | Architecture decisions, security/privacy review, ambiguous failures, release blockers, or broad multi-system synthesis | Independent review plus explicit stop gates. |

## Escalation Signals

Escalate one tier when any of these apply:

- package, parser, provenance, watcher, Figma scope, credentials, billing, release, or deploy behavior is in scope
- the task crosses repositories, machines, connectors, or external accounts
- evidence conflicts or the requested behavior is ambiguous
- a failed review or test requires root-cause reasoning
- visual judgment materially affects a user-facing result

## Budget Controls

- Load the smallest context set defined by the Crate memory model.
- Use deterministic scripts for parsing, validation, hashing, and catalog checks.
- Use subagents only for bounded, non-overlapping work that advances the task.
- Do not run recurring loops, paid APIs, or external services without an explicit cap or standing authority.
- Report actual tool/API usage when the platform exposes it; never invent token or dollar estimates.

## Evidence-Based Routing

Record an advisory routing decision for meaningful work:

- exact operation, workflow, route, task class, risk, ambiguity, and cross-system scope
- selected capability tier and agent strategy
- current synthetic eval result
- reviewed aggregate outcome-receipt count
- expected verification and escalation trigger

A deterministic or lower-tier recommendation requires a passing pinned-contract eval and at least three current, locally signed receipts for the exact operation, workflow, route, task class, and risk class. Each receipt must reference hashes derived from real bounded evidence files in the canonical Crate repo; caller-supplied evidence IDs are not accepted. Failed evals, stale or invalid signatures, mismatched evidence, ambiguity, architecture, security/privacy, or release blockers require frontier review. Do not use private content, personal traits, hidden reasoning, or unsupported savings claims as evidence.

## Authority

This policy is advisory. It does not switch models, create agents, change providers, change service tiers, or start paid tools automatically. Availability, pricing, retention, and data-handling claims must be verified from current primary documentation before a cost-sensitive decision.
