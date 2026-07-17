# Crate External Control Layer

## Purpose

Make this Codex thread the Crate command center while letting Codex coordinate additional execution surfaces when tools are exposed.

This playbook exists so Bryant does not have to manually copy prompts between Crate threads whenever Codex can safely create, message, or supervise another Crate worker.

## Ops Integration

External-control work uses Standing Order `SO-006` from `.codex/ops/standing-orders.md`.

Before creating or messaging another thread/agent:

- run or review `python3 .codex/tools/crate_doctor.py`
- identify the active taskflow if the work spans threads
- record the target thread/agent in `.codex/state/daily-crate-ledger.md`
- close with proof based on `.codex/ops/proof-bundle-template.md`

## Tool Layers

### Layer 1: Source-Of-Truth Thread

The current Crate thread remains the source of truth.

Responsibilities:

- choose the playbook and scope
- maintain Crate state files and daily ledger
- own final decisions and final reports
- commit, push, PR, merge, build, tag, or release only when the active prompt authorizes that scope
- keep Bryant informed of tool gaps and fallbacks

### Layer 2: Persistent User-Owned Threads

Preferred when available.

Preferred native model tools when exposed:

- `create_thread`
- `send_message_to_thread`
- `read_thread`
- `list_threads`
- `handoff_thread`
- `set_thread_title`
- `set_thread_pinned`
- `set_thread_archived`

Crate Ops plugin tools currently expose:

- `create_thread`
- `send_message_to_thread`
- `read_thread`
- `list_threads`
- `set_thread_title`

The Crate Ops plugin owns the local Codex app-server transport for
`thread/start`, `thread/list`, `thread/read`, `thread/name/set`,
`thread/resume`, and `turn/start`. The Crate app repository does not own or
execute that transport.

Use persistent user-owned threads for work Bryant may want to see, resume, or steer directly from the Codex sidebar:

- Figma-design implementation threads
- Jenna QA prompt/result threads
- long-running release-gate side threads
- tester-feedback triage threads
- public-release prep threads

Use model-visible tools directly when exposed. If this already-open task has a
stale plugin binding, use the reviewed plugin-owned fallback CLI or start a
fresh task before asking Bryant to paste prompts manually.

### Layer 3: Sub-Agents

Use when persistent thread tools are unavailable or when the task is a bounded sidecar investigation inside this source-of-truth thread.

Current exposed sub-agent tools:

- `spawn_agent`
- `send_input`
- `wait_agent`
- `resume_agent`
- `close_agent`

Use sub-agents for:

- read-only PR review
- regression sweeps
- security/provenance review
- QA report synthesis
- codebase exploration
- drafting a smoke prompt or checklist while the main thread continues critical-path work

Do not use sub-agents as hidden long-term state. Close them after their result is integrated.

## Start Gate

Before coordinating another thread or agent, confirm:

- repo path is `/Users/bryantfeintuchclaw/Projects`
- branch/base is `v2.4.x` unless Bryant explicitly scopes otherwise
- working tree state is understood
- exact requested mode is clear
- whether the work is read-only, code-editing, QA, release-gate, Figma, or public-release prep
- whether persistent task tools are currently exposed
- whether the installed Crate Ops plugin transport is current

## Delegation Rules

- One builder edits app code at a time.
- Side agents are read-only unless Bryant explicitly authorizes a worker/code-edit lane.
- Do not create overlapping edit ownership.
- Do not delegate urgent blocking work when the main thread needs it immediately.
- Prefer parallel read-only sidecars for independent risk questions.
- Main thread integrates side-agent findings and owns the final recommendation.

## Persistent Thread Workflow

When persistent user-owned task tools are available, either natively or through Crate Ops:

1. Create or select the target thread.
2. Give it a scoped Crate prompt with:
   - repo path
   - branch/base
   - allowed files
   - forbidden files/actions
   - exact checks
   - stop conditions
   - required return format
3. Record the thread title/id in `.codex/state/daily-crate-ledger.md`.
4. Read or wait for the thread result.
5. Integrate the result in this source-of-truth thread.
6. Update state/ledger with the outcome.

Plugin-owned fallback commands:

```bash
python3 /Users/bryantfeintuchclaw/plugins/crate-ops/mcp/codex_thread_control.py list --limit 10
python3 /Users/bryantfeintuchclaw/plugins/crate-ops/mcp/codex_thread_control.py start --title "Crate Side Task" --message "<prompt>" --wait 180
python3 /Users/bryantfeintuchclaw/plugins/crate-ops/mcp/codex_thread_control.py send <thread-id> "<prompt>" --wait 180
python3 /Users/bryantfeintuchclaw/plugins/crate-ops/mcp/codex_thread_control.py read <thread-id> --include-turns
```

Use `send` only for scoped prompts that can safely run as a separate thread. Do not send secrets, full Figma URLs, signed URLs, raw diagnostics, or unrelated private paths.

## Sub-Agent Workflow

When only sub-agent tools are available:

1. Spawn one or more bounded read-only agents.
2. Give each agent a non-overlapping task.
3. Keep critical-path implementation in the source-of-truth thread.
4. Wait only when a result is needed.
5. Close agents after results are captured.
6. Record important findings in the daily ledger.

## Fallback Workflow

If neither persistent task tools nor sub-agent tools are available:

- say which tool family is missing
- provide Bryant a paste-ready prompt
- keep the prompt privacy-safe and scoped
- update the daily ledger once Bryant returns the result

## Stop Gates

Do not create or message another thread/agent for:

- final public release
- get-crate.com or crate-web deploy
- dependency mutation
- signing credential or Keychain work
- private/client file inspection
- Figma token or full URL inspection
- public tester communications

unless Bryant explicitly approves that exact scope.

## Current Tool State

Last verified: 2026-07-16.

Available:

- Crate Ops plugin `0.11.1+codex.20260716214926` persistent task tools
- plugin-owned fallback CLI under `/Users/bryantfeintuchclaw/plugins/crate-ops/mcp/`
- sub-agent spawn/send/wait/resume/close
- Computer Use
- GitHub PR review-thread tools
- partial Figma MCP tools depending on active tool exposure

Long-running tasks may retain the plugin cache version loaded when they were
opened. A fresh task uses the installed version; do not overwrite immutable
plugin caches to force a hot reload.

## Definition Of Done

For an external-control task, report:

- which tool layer was used
- spawned thread/agent ids when applicable
- what each thread/agent was asked to do
- what each returned
- files changed, if any
- whether the result was integrated into the source-of-truth thread
- any missing tool capability still blocking the preferred workflow
