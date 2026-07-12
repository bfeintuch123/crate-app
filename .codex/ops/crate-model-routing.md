# Crate Model And Cost Routing

## Purpose

Choose an appropriate capability tier for Crate work without hardcoding model names, prices, or provider claims that can become stale.

## Advisory Tiers

| Tier | Use when | Required review |
| --- | --- | --- |
| Fast | Deterministic formatting, catalog validation, bounded extraction, or low-risk read-only checks | Verify output shape and source links. |
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

## Authority

This policy is advisory. It does not switch models, providers, service tiers, or paid tools automatically. Availability, pricing, retention, and data-handling claims must be verified from current primary documentation before a cost-sensitive decision.
