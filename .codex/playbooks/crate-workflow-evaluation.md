# Crate Workflow Evaluation Playbook

## Purpose

Evaluate Codex operating workflows with repeatable synthetic cases before promoting a routing, approval, privacy, stop-gate, or model-tier change.

## Scope

Use `SO-007` and the existing `ops-improvement-loop` in `evaluate` mode. This playbook evaluates the agents operating Crate; app behavior belongs to the existing app benchmark and QA suites.

## Case Contract

Each case must define:

- opaque case ID and suite version
- opaque approved fixture ID and operation ID
- pinned routing-contract revision
- workflow, task class, and risk class
- expected route and capability tier
- expected approval owner
- expected privacy handling
- expected stop gate
- human privacy-review owner and date

Fixtures must be synthetic. Do not include real inbox content, calendar details, tester identity, client work, credentials, URLs, paths, screenshots, or transcripts.

## Gate

1. Validate the closed suite schema.
2. Derive observed values from the pinned deterministic routing contract; fixtures never provide observed values.
3. Treat any mismatch between the expected contract and derived observation as a failed case.
4. Block promotion when a critical approval, privacy, or stop-gate case fails.
5. Record aggregate results and opaque evidence references only.
6. Route proposed changes through the existing skill workshop, decision, taskflow, PR, and merge gates.

Evaluation never changes a live model, creates an agent, edits standing orders, mutates a connector, or starts paid usage automatically.
