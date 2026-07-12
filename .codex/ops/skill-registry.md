# Crate Skill And Playbook Registry

## Purpose

This registry makes Crate workflows discoverable, pinned, and auditable. It is the Crate-local equivalent of a small skill catalog.

## Registry Fields

| Field | Meaning |
| --- | --- |
| name | Stable workflow name. |
| path | File or directory that owns the workflow. |
| type | playbook, skill, check-suite, tool, standing-order, taskflow-template. |
| read_when | Short trigger phrase for routing. |
| authority | read-only, docs-only, code-fix, release-gate, deploy, external-control. |
| risk | low, medium, high. |
| pin | local, repo, external. |
| security notes | Credential/private-file/deploy constraints. |

## Core Registry

| name | path | type | read_when | authority | risk | pin | security notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Crate Router | `.codex/ROUTER.md` | playbook | Bryant gives a short Crate command | routing | medium | repo | Must enforce repo and release gates. |
| Shared Gates | `.codex/playbooks/_shared-gates.md` | playbook | Any mutation, review, release, deploy, QA, or handoff | policy | high | repo | Contains credential/privacy stop gates. |
| Codex Loops | `.codex/playbooks/crate-codex-loops.md` | playbook | Autonomous loop, failure loop, smoke failure | loop | high | repo | Must use standing orders/taskflows/proof bundles. |
| Runner Loop | `.codex/playbooks/crate-runner-loop.md` | playbook | Self-verifying loop or runner-backed work | loop | medium | repo | Evidence must avoid secrets and raw private output. |
| External Control | `.codex/playbooks/crate-external-control-layer.md` | playbook | Create/message side threads or subagents | external-control | high | repo | Do not pass secrets or private files to side threads. |
| Cloudflare Deploy | `.codex/playbooks/crate-cloudflare-deploy.md` | playbook | Deploy get-crate.com or Cloudflare Pages | deploy | high | repo | Token from Keychain only; never print token. |
| Crate Doctor | `.codex/tools/crate_doctor.py` | tool | Preflight repo/tool/auth readiness | read-only | medium | repo | Must not print secret values. |
| Crate Doctor Skill | `.agents/skills/crate-doctor/SKILL.md` | skill | User asks for Crate doctor/preflight | read-only | medium | repo | Uses doctor tool. |
| Cloudflare Deploy Skill | `.agents/skills/crate-cloudflare-deploy/SKILL.md` | skill | User asks to deploy Cloudflare/get-crate.com | deploy | high | repo | Requires explicit deploy approval. |
| Standing Orders | `.codex/ops/standing-orders.md` | standing-order | Any recurring Crate program | policy | high | repo | Defines allowed authority. |
| Taskflow Template | `.codex/taskflows/README.md` | taskflow-template | Multi-step work that must resume | state | medium | repo | No raw secrets/private artifacts. |
| Memory Model | `.codex/ops/crate-memory-model.md` | playbook | Context load, handoff, vault, source-of-truth work | state | medium | repo | Action-sensitive memory must include scope and source. |
| Proof Bundle Template | `.codex/ops/proof-bundle-template.md` | playbook | Closeout for major Crate work | evidence | medium | repo | Privacy filters required. |
| Tester Feedback Archive | `.codex/ops/tester-feedback-archive.md` | playbook | Paid tester/support/Jenna feedback intake | triage | medium | repo | Raw tester artifacts are private by default. |
| Crate Safety Guard | `crate-ops-plugin/hooks/` and `crate-safety-guard` | hook/skill | Destructive command or repo-boundary edit | guardrail | high | external | Partial tool coverage; keep sandbox/approvals; trust hook changes explicitly. |
| Crate Skill Workshop | `crate-ops-plugin/skills/crate-skill-workshop/` | skill | Repeated work may deserve a skill | proposal-only | medium | external | Must check this registry and cannot install without approval. |
| Crate Loop Retrospective | `crate-ops-plugin/skills/crate-loop-retrospective/` | skill | Completed loop should improve its next run | evidence | low | external | Optional proof/taskflow attachment; no silent policy changes. |
| Crate Feature Inventory | `.codex/ops/crate-feature-inventory.json` and `crate-ops-plugin/skills/crate-feature-inventory/` | skill/tool | Audit product stories and evidence coverage | read-only | low | repo/external | Does not replace supported-app claims or manual QA matrix. |
| Crate Architecture Health | `crate-ops-plugin/skills/crate-architecture-health/` | skill/tool | Complexity or change-amplification review | read-only | low | external | Metrics are triage signals; no automatic refactors. |
| Crate Ops Hygiene | `.codex/tools/crate_doctor.py` and `crate-ops-plugin/skills/crate-ops-hygiene/` | skill/tool | Disk, cache, log, worktree, or temp growth | read-only | medium | Aggregate counts only; never delete or reveal private filenames. |
| Crate X Research | `crate-ops-plugin/skills/crate-x-research/` | skill/tool | Pull and evaluate X bookmarks | read-only network | high | Read cap, Keychain token, owner-only cache, primary-source verification. |

## Pinning Rules

- Repo-pinned workflows live in this repo and should be changed through PR/review when material.
- External patterns from OpenClaw, ClawHub, or Peter Steinberger repos are inspiration only unless copied into this repo and reviewed.
- Do not auto-update local Crate skills from external sources.
- If an external skill/tool is adopted, record source, version/commit, local changes, and security notes here.

## Security Review

Before adding a new Crate skill/tool:

- identify whether it can read credentials, private files, network data, or browser/app state
- document required runtime capabilities
- document forbidden outputs
- run docs/check validation
- add it to this registry
