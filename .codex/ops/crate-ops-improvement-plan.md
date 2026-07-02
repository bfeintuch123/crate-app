# Crate Ops Improvement Plan

## Purpose

This file turns the Peter Steinberger / OpenClaw research synthesis into concrete Crate workflow upgrades.

These changes improve Crate operations, QA, release, support, tester intake, and Codex thread coordination. They do not change Crate app product behavior.

## Operating Principle

Crate loops should not be long prompts with memory glued on. They should be bounded agents operating against durable state.

Standard flow:

```text
User intent
  -> Crate router
  -> Standing order
  -> Taskflow state
  -> Memory/context load
  -> Playbooks/check suites
  -> Execution loop
  -> Proof bundle
  -> Decision log / daily ledger / vault update
```

## The 12 Improvements

| # | Improvement | Durable home | Loop integration |
| --- | --- | --- | --- |
| 1 | Split hard rules, skills/playbooks, and memory | `AGENTS.md`, `.agents/skills/`, `.codex/ops/crate-memory-model.md` | Router and loops read the smallest relevant layer first. |
| 2 | Formal standing orders | `.codex/ops/standing-orders.md` | Loops must name the active standing order before acting. |
| 3 | Durable taskflows and resume tokens | `.codex/taskflows/README.md` | Long loops update taskflow state before handoff or interruption. |
| 4 | Memory tiers and action-sensitive memory | `.codex/ops/crate-memory-model.md` | Loops load durable decisions, daily state, active taskflow, and scoped memory. |
| 5 | Evidence-based autoreview | `crate-autoreview.md`, `review-crate-pr.md`, this plan | Failure/fix loops must review changed surface, callers, siblings, tests, privacy, and user impact. |
| 6 | Skill/playbook registry, pinning, and security metadata | `.codex/ops/skill-registry.md` | Router uses registry metadata when selecting tools and playbooks. |
| 7 | Local-first tester and QA archive | `.codex/ops/tester-feedback-archive.md` | Tester reports are archived and normalized before routing to bug, UX, or decision loops. |
| 8 | Crate doctor command | `.codex/tools/crate_doctor.py`, `.agents/skills/crate-doctor/SKILL.md` | Release, deploy, and long QA loops run doctor preflight. |
| 9 | Cloudflare deploy skill | `.codex/playbooks/crate-cloudflare-deploy.md`, `.agents/skills/crate-cloudflare-deploy/SKILL.md` | Site deploys use one safe path with Keychain token retrieval and post-deploy verification. |
| 10 | `read_when` docs metadata | `.codex/ops/docs-index.md` | Router and handoffs can select docs without rereading everything. |
| 11 | Proof bundles | `.codex/ops/proof-bundle-template.md` | Every major loop closes with evidence and feeds the daily ledger/vault. |
| 12 | Tester feedback triage schema | `.codex/ops/tester-feedback-archive.md` | Paid tester reports become structured work items. |

## Adoption Order

1. Use `crate-doctor` before any release, Cloudflare deploy, long-running QA, or multi-agent thread coordination.
2. Add or update a taskflow file before starting a multi-step loop.
3. Close every major loop with a proof bundle.
4. Add proof summaries to `.codex/state/daily-crate-ledger.md`.
5. Let the nightly vault automation consume the ledger, taskflow state, decision log, and proof bundles.

## Boundaries

These ops upgrades do not authorize:

- app source changes
- dependency mutations
- release builds
- signing, notarization, tagging, or GitHub release publication
- get-crate.com deploys
- credential inspection
- private file inspection

Those actions still require the relevant Crate playbook and explicit Bryant approval.
