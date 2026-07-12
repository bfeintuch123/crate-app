# Crate Taskflows

## Purpose

Taskflows are durable state files for multi-step Crate work. They sit above playbooks and below Bryant's current intent.

Use a taskflow when work can span multiple turns, threads, agents, machines, or days.

## When To Create Or Update

Create or update a taskflow for:

- autonomous failure loops
- internal QA prerelease gates
- public or beta release prep
- Cloudflare deploys
- tester feedback batches
- Figma/design implementation passes
- long-running QA or installed-app repros

## File Naming

Use:

```text
.codex/taskflows/<date>-<short-name>.md
```

Example:

```text
.codex/taskflows/2026-07-02-v3-beta-tester-rollout.md
```

## Template

```markdown
# Taskflow: <name>

## Metadata

- created:
- updated:
- owner:
- standing order:
- repo:
- branch:
- base:
- mode:
- status: planned | active | blocked | ready-for-review | complete

## Goal

<one paragraph>

## Scope

Allowed:

- ...

Forbidden:

- ...

## State

- current phase:
- last completed checkpoint:
- next action:
- blocker:
- approval state:
- preferences applied:
- routing decision:
- workflow eval suite/result:
- outcome receipt:

## Checkpoints

- [ ] preflight / doctor
- [ ] context loaded
- [ ] implementation or execution
- [ ] verification
- [ ] proof bundle
- [ ] ledger/state update
- [ ] handoff or next prompt

## Evidence

| Time | Action | Evidence | Result |
| --- | --- | --- | --- |
| | | | |

## Risks

- ...

## Handoff

Next exact action:

```text
...
```
```

## Resume Rules

Before resuming:

1. Read this taskflow.
2. Read the named standing order.
3. Run or review `crate-doctor` if the work involves repo, release, deploy, QA, or thread coordination.
4. Verify branch and working tree.
5. Continue from `next action`, not from memory alone.

## Privacy

Taskflows may include public URLs, branch names, PR numbers, test names, approved QA fixture names, and sanitized output paths.

Do not include secrets, tokens, raw private file lists, full Figma URLs, signed URLs, broad logs, or unrelated private paths.
