# Crate Workflow Router

Use this router before choosing a Crate playbook, loop, or skill. The goal is to let Bryant use short prompts while Codex selects the correct operating path, approval mode, and stop gates.

## Start Gate

Before acting on Crate work, confirm:

- repo path is `/Users/bryantfeintuchclaw/Projects`
- remote is `bfeintuch123/crate-app.git`
- repo is crate-app, not crate-web or mission-control
- branch is the requested branch, usually latest `origin/v2.4.x`
- working tree state is understood
- requested autonomy mode is clear
- crate-web and mission-control are not in scope unless Bryant explicitly says so

If the task is ambiguous, choose the safest read-only path and ask Bryant for the missing approval before mutating files, opening PRs, merging, building, releasing, deploying, tagging, notarizing, or touching credentials.

## Ops Layer

For any non-trivial Crate request, select:

- standing order from `.codex/ops/standing-orders.md`
- taskflow file from `.codex/taskflows/`, or create one when work spans turns/threads/machines
- memory load set from `.codex/ops/crate-memory-model.md`
- proof bundle closeout from `.codex/ops/proof-bundle-template.md`
- routeable skills/tools from `.codex/ops/skill-registry.md`

Run `python3 .codex/tools/crate_doctor.py` before release, deploy, long-running QA, or external-control work.

## Route Table

| Bryant says | Use first | Also use | Default mode |
| --- | --- | --- | --- |
| "What is the current Crate status?" | `.codex/state/current-workstream.md` | `.codex/playbooks/crate-workstream-status.md` | read-only |
| "Synthesize this Jenna report" | `.codex/playbooks/crate-qa-results-synthesizer.md` | `.codex/playbooks/crate-bug-triage.md` when action is needed | read-only unless approved |
| "Crate failure, triage/fix it" | `.codex/playbooks/crate-codex-loops.md` Autonomous Crate Failure Loop | Crate Fix Review Stack: `crate-bug-triage.md`, `clawpatch-fix.md`, `crate-autoreview.md`, `crate-regression-detector.md`, `crate-security-scan.md`, `crate-provenance-review.md`, `crate-runner-loop.md`, `review-crate-pr.md`, `crate-handoff.md` | use Bryant's requested loop mode |
| "Smoke failed, fix it" | `.codex/playbooks/crate-codex-loops.md` Autonomous Smoke Failure Fix Loop variant | same Crate Fix Review Stack as Crate Failure Loop | use Bryant's requested loop mode |
| "Run the internal QA release gate" | `.codex/playbooks/crate-release-gate.md` | `crate-autoreview.md`, `crate-security-scan.md`, `crate-regression-detector.md`, `crate-provenance-review.md`, `crate-handoff.md` | release-gate only when explicitly approved |
| "Review this PR for merge" | `.codex/playbooks/review-crate-pr.md` | `crate-autoreview.md`, `crate-regression-detector.md`, `crate-security-scan.md`, `crate-provenance-review.md` as scope requires | read-only until merge approved |
| "Make a small bug fix" | `.codex/playbooks/clawpatch-fix.md` | relevant check suite from `.codex/checks/crate-check-suites.md` | no-autonomy unless Bryant grants loop mode |
| "Triage tester feedback" | `.codex/playbooks/crate-tester-intake.md` | `crate-qa-results-synthesizer.md`, `crate-bug-triage.md` | read-only |
| "Run Jenna GUI QA" | `.codex/playbooks/crate-computer-use-qa.md` | `crate-gui-repro-flow.md` for repros | explicit app/file approval required |
| "Create a handoff" | `.codex/playbooks/crate-handoff.md` | `.agents/skills/crate-handoff/SKILL.md` | read-only |
| "Use external controls / spawn Crate side threads / coordinate agents" | `.codex/playbooks/crate-external-control-layer.md` | `.codex/playbooks/crate-handoff.md` when a portable handoff prompt is needed | source-of-truth thread coordinates; sidecars read-only by default |
| "Import Crate ChatGPT export" | future import plan | `crate-decision-log.md`, `crate-qa-results-synthesizer.md`, `crate-handoff.md` | read-only first pass |
| "Deploy get-crate.com / Cloudflare" | `.codex/playbooks/crate-cloudflare-deploy.md` | `SO-004`, `crate-doctor`, proof bundle | deploy only when explicitly approved |
| "Run Crate doctor / preflight" | `.agents/skills/crate-doctor/SKILL.md` | `.codex/tools/crate_doctor.py` | read-only |
| "Tighten Crate ops / workflow / loops" | `.codex/ops/crate-ops-improvement-plan.md` | standing orders, taskflows, memory model, proof bundles, registry | docs/ops-only unless approved |
| "Discover useful loops / run patrol" | `.codex/ops/crate-loop-catalog.json` | Crate Ops `audit_loop_catalog.py`, loop retrospective, skill workshop | report-only |
| "Audit or optimize our instructions" | Crate Ops `crate-instruction-audit` | simplify guardrails, skill workshop | proposal-only |
| "Create a bounded context pack" | `.codex/ops/crate-memory-model.md` | Crate Ops `create_context_pack.py`, handoff | read-only |
| "Build screenshot/appshot proof" | `.codex/ops/proof-bundle-template.md` | QA evidence normalizer, visual-evidence pack | evidence-only |
| "Review automations / heartbeats" | `.codex/ops/crate-automations.json` | Crate Ops `crate-automation-hygiene` | report-only |
| "Choose model tier / control usage" | `.codex/ops/crate-model-routing.md` | Crate Ops `crate-model-cost-routing` | advisory-only |
| "Review the app/site design quality" | Crate Ops `crate-design-review` | visual evidence, accessibility, supported-app claims | report/brief only |
| "Record this recurring workflow" | Crate Ops `crate-workflow-recorder` | Record & Replay, then skill workshop | proposal-only |
| "What are testers collectively telling us?" | Crate Ops `crate-tester-insights` | normalized feedback archive | read-only synthesis |
| "Are we ready for public launch?" | Crate Ops `crate-launch-readiness` | customer journey and public assets, then `crate-ship` | evidence-only |
| "Define beta or launch metrics" | Crate Ops `crate-product-metrics` | memory/decision model | plan-only |
| "Review dependency risk" | Crate Ops `crate-dependency-watch` | security scan and release diff when relevant | read-only |
| "Rehearse a launch incident" | Crate Ops `crate-launch-incident-rehearsal` | release, post-deploy, and support playbooks | tabletop-only |

## Common Loop Modes

- `no-autonomy`: inspect, plan, report one step at a time.
- `fix-only`: create/use a branch, edit scoped files, run checks, stop before commit.
- `fix-and-PR`: commit, push, and open a draft PR after checks pass.
- `fix-PR-and-merge-if-clean`: merge only if Bryant explicitly preauthorized merge and merge-readiness has no blockers.
- `release-gate-only-when-explicitly-approved`: run only the approved release-gate mutations.

## Fast Prompts

Use short prompts like these after this router exists:

```text
Crate router: synthesize this Jenna qa.24 report and tell me the next action.
```

```text
Crate router: run Smoke Failure Fix Loop for qa.25 Smoke 3, mode fix-PR-and-merge-if-clean.
```

```text
Crate router: run Crate Failure Loop for this tester bug report, mode fix-PR-and-merge-if-clean if classification is likely app bug with enough evidence.
```

```text
Crate router: run internal QA prerelease gate for v2.8.0-qa.25 from latest origin/v2.4.x. Internal QA only.
```

```text
Crate router: generate Jenna Smoke 2 prompt for qa.25 using the smoke bank.
```

## Hard Boundaries

Never infer approval to:

- update get-crate.com
- deploy crate-web or the site
- create final public v2.8.0
- publish a stable release
- mutate dependencies
- inspect credentials, tokens, passwords, keychain items, or Apple Developer secrets
- handle Keychain prompts
- touch crate-web during crate-app work
- inspect unapproved private files
- broaden scope beyond the requested loop

Use `.codex/playbooks/_shared-gates.md` for common stop gates, privacy filters, and final report shape.

## Closeout

For meaningful work, close with:

- proof bundle or proof section
- daily ledger update
- current-workstream update if next action changed
- active taskflow update if one exists
