# Crate Docs Index

## Purpose

This index gives Crate docs lightweight routing metadata so Codex can select the right context without rereading every file.

## Index

| Path | Summary | Read when |
| --- | --- | --- |
| `AGENTS.md` | Hard repo rules, branch/source-of-truth, playbook list, release workflow, guardrails. | Before any Crate mutation or repo decision. |
| `WORKSPACE.md` | Local repo boundary map for crate-app, crate-web, and mission-control. | Work could touch nested repos or deployment/site boundaries. |
| `.codex/ROUTER.md` | Route short Bryant prompts to playbooks, modes, and stop gates. | Bryant gives a short Crate command. |
| `.codex/state/current-workstream.md` | Current Crate status, latest QA/release state, next action. | Starting or resuming Crate work. |
| `.codex/state/daily-crate-ledger.md` | Daily privacy-safe progress ledger for vault automation. | Closing major work or preparing daily/vault synthesis. |
| `.codex/ops/standing-orders.md` | Durable authority for recurring Crate programs. | Starting a loop, deploy, release, tester intake, or thread coordination. |
| `.codex/taskflows/README.md` | Durable taskflow template and resume rules. | Work spans more than one turn, machine, thread, or approval gate. |
| `.codex/ops/crate-memory-model.md` | Memory tiers and action-sensitive memory rules. | Source-of-truth, handoff, vault, or long loop work. |
| `.codex/ops/proof-bundle-template.md` | Evidence closeout template for loops and releases. | Finishing a major loop, QA, release, deploy, or review. |
| `.codex/ops/tester-feedback-archive.md` | Tester feedback schema and routing. | Bryant provides tester/support/Jenna feedback. |
| `.codex/ops/chief-of-staff-attention-queue.md` | Source-of-truth hierarchy, four queue buckets, freshness, privacy, and delegation rules. | Bryant asks Codex to act as chief of staff or coordinate active work. |
| `.codex/playbooks/crate-attention-queue.md` | Operational workflow for refresh, reconciliation, routing, authority, delegation, and closeout. | Running or refreshing the chief-of-staff attention queue. |
| `.codex/playbooks/crate-chief-business-operations.md` | Bounded support/email, calendar, and approved business-operation execution routes. | Chief-of-staff work moves from approval into nonengineering execution. |
| `.codex/taskflows/2026-07-12-canonical-tester-feedback-schema.md` | Canonical tester-feedback JSON 1.0 implementation and validation state. | Creating, reviewing, or revising normalized tester records. |
| `.codex/ops/skill-registry.md` | Registry for Crate playbooks, skills, tools, pins, and security notes. | Adding or selecting skills/tools/playbooks. |
| `.codex/ops/crate-feature-inventory.json` | Canonical feature, risk, coverage-state, suite, manual-lane, and proof catalog. | Auditing product/test coverage. |
| `.codex/ops/crate-loop-catalog.json` | Review-first inventory of Crate loops, owners, modes, stop gates, and evidence. | Discovering or auditing recurring loops. |
| `.codex/ops/crate-automations.json` | Privacy-safe automation metadata; live automation tool remains authoritative. | Reviewing heartbeats, monitors, or scheduled work. |
| `.codex/ops/crate-model-routing.md` | Advisory capability tiers, escalation signals, and usage controls. | Selecting a model tier or cost/context budget. |
| `.codex/taskflows/2026-07-12-ops-design-launch-readiness.md` | Batch 17-23 design, workflow capture, tester learning, launch, metrics, dependency, and incident-rehearsal scope. | Reviewing or resuming the third X-research implementation batch. |
| `.codex/playbooks/crate-codex-loops.md` | Autonomous loop modes, stop gates, and loop lifecycle. | Bryant asks for an autonomous loop or failure loop. |
| `.codex/playbooks/crate-runner-loop.md` | Runner tiers, command suites, and evidence format. | Work needs command-backed proof. |
| `.codex/playbooks/crate-external-control-layer.md` | Native/thread bridge/subagent coordination. | Codex should spawn/message side threads or agents. |
| `.codex/playbooks/crate-cloudflare-deploy.md` | Safe Cloudflare Pages deployment procedure. | Bryant approves get-crate.com or Cloudflare deploy. |
| `.codex/checks/crate-check-suites.md` | Named check suites for docs, syntax, release, parser, Figma, provenance. | Selecting tests/checks. |

## Maintenance

When adding a new Crate playbook, skill, tool, or durable workflow doc:

1. Add it to this index.
2. Add it to `.codex/ops/skill-registry.md` if it is executable or routeable.
3. Add any required stop gates to `_shared-gates.md` or the specific playbook.
