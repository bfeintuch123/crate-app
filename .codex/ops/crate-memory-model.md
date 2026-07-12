# Crate Memory Model

## Purpose

Crate memory is the durable context layer that lets Codex operate across threads, days, and machines without asking Bryant to restate everything.

## Memory Tiers

### Tier 1: Hard Rules

Home:

- `AGENTS.md`
- `.codex/ROUTER.md`
- `.codex/playbooks/_shared-gates.md`

Use for:

- repo boundaries
- approval gates
- release/deploy constraints
- privacy and credential rules
- canonical branch rules

### Tier 2: Active State

Home:

- `.codex/state/current-workstream.md`
- `.codex/state/daily-crate-ledger.md`
- active `.codex/taskflows/*.md`

Use for:

- latest QA/build/release state
- current phase
- next action
- active blockers
- recent proof summaries

### Tier 3: Decisions

Home:

- `.codex/decisions/`
- `docs/crate/daily/`

Use for:

- product decisions
- tester policy
- design scope
- release policy
- architecture commitments

Explicit reusable preferences follow `.codex/ops/crate-preferences.md`. They remain source-linked, expiring guidance and never replace decisions or action authority.

### Tier 4: Workflow Knowledge

Home:

- `.codex/playbooks/`
- `.agents/skills/`
- `.codex/ops/`
- `.codex/checks/`

Use for:

- how to run loops
- check suites
- support workflows
- tool-specific procedures

### Tier 5: External Archives

Home:

- compiled Crate vault
- tester archive
- proof bundles
- GitHub PR/release history

Use for:

- long-horizon synthesis
- tester trend analysis
- release audit trails
- support history

## Action-Sensitive Memory

Any memory that grants or limits authority must include:

- decision owner
- date
- scope
- expiry or review trigger
- source file or proof link
- allowed actions
- forbidden actions

Examples:

- Bryant preauthorizes merge if merge-readiness is clean.
- Bryant approves Cloudflare deploy for one release.
- Bryant decides native package-complete banners are not required.
- Bryant decides closed beta testers get 25 packages/month.

Do not treat a casual statement as permanent authority unless it is recorded in a decision file, taskflow, or current-workstream state.

## Loop Memory Load Order

Before a Crate loop acts, read only the smallest relevant set:

1. `AGENTS.md`
2. `.codex/ROUTER.md`
3. active standing order
4. active taskflow, if present
5. `.codex/state/current-workstream.md`
6. relevant decision files
7. relevant active explicit preferences, when applicable
8. selected playbook/check suite

Avoid loading every Crate doc by default. Use `.codex/ops/docs-index.md` to route.

## Compaction And Handoff

Before a long thread, loop, or side thread is compacted or handed off:

- update the active taskflow
- add a proof summary to the daily ledger
- update current-workstream if the next action changed
- produce a privacy-safe handoff

The nightly vault automation should read the ledger and taskflows first, not raw transcripts.

## Bounded Context Packs

Use a context pack when a task crosses threads, agents, or machines but does not need the full Crate memory surface.

A context pack must:

- name one active route and taskflow
- include source paths and hashes
- load only the hard rules, active state, standing order, decisions, and workflows required for that task
- stay within an explicit size budget
- redact credential-like values and normalize private home paths
- exclude raw transcripts, research caches, tester artifacts, diagnostics, package outputs, and unrelated generated outputs by default

The pack is a bounded snapshot, not a new source of truth. Reread linked sources before action-sensitive work.
