# Crate External Control Tool Exposure Request

Date: 2026-06-29

Status: Resolved 2026-07-16. Crate Ops plugin
`0.11.1+codex.20260716214926` now owns the persistent task transport and
exposes create, send, read, list, and title tools. Commands below describe the
historical app-repo bridge and are retained only as original request evidence.

## Goal

Expose persistent user-owned Codex thread tools to the Crate source-of-truth thread so Codex can create, message, read, list, title, pin, archive, and hand off visible sidebar threads directly for Crate workflows.

## Current Verified Tool State

Available in this session:

- Local app-server thread bridge:
  - `.codex/tools/codex_thread_control.py list`
  - `.codex/tools/codex_thread_control.py start`
  - `.codex/tools/codex_thread_control.py read`
  - `.codex/tools/codex_thread_control.py send`
  - `.codex/tools/codex_thread_control.py name`
- `multi_agent_v1.spawn_agent`
- `multi_agent_v1.send_input`
- `multi_agent_v1.wait_agent`
- `multi_agent_v1.resume_agent`
- `multi_agent_v1.close_agent`

Not exposed as native model-visible tools in this session after direct `tool_search` probes:

- `create_thread`
- `send_message_to_thread`
- `read_thread`
- `list_threads`
- `fork_thread`
- `handoff_thread`
- `set_thread_title`
- `set_thread_pinned`
- `set_thread_archived`

## Requested Tool Family

Enable the Codex thread-management / thread-coordination tool family for this Crate thread.

Search terms to use in Codex tool/connector settings:

- `Thread Coordination`
- `Thread Management`
- `Codex Threads`
- `Codex App thread tools`
- `create_thread`
- `send_message_to_thread`
- `read_thread`
- `list_threads`
- `fork_thread`
- `handoff_thread`
- `set_thread_title`
- `set_thread_pinned`
- `set_thread_archived`

## Why This Matters

Bryant wants this Crate thread to remain the source of truth while Codex directly opens and coordinates additional visible Crate threads for:

- Figma implementation
- Jenna QA
- tester feedback triage
- release-gate side work
- PR/review side work
- handoffs and resumable workstreams

Without native persistent thread tools, Codex can now use the local app-server bridge for persistent Crate side threads and sub-agents for bounded sidecar work. Native tools would still be cleaner because they avoid shelling through the app-server bridge.

## Verified Bridge Probe

Date: 2026-06-29

Created and verified persistent app-server thread:

- title: `Crate Control Probe`
- thread id: `019f1601-f049-72a0-a5cb-841a4b306598`
- workspace: `/Users/bryantfeintuchclaw/Projects`
- bridge operations verified:
  - list threads
  - start thread
  - set thread name
  - read thread
  - resume existing thread
  - send message / start turn
  - read persisted response
- probe response: `PONG`

## Verification Phrase

After enabling the tools in Codex, return to the Crate source-of-truth thread and say:

```text
Thread tools exposed. Verify.
```

Codex should then run `tool_search` for:

```text
create_thread send_message_to_thread read_thread list_threads fork_thread handoff_thread set_thread_title set_thread_pinned set_thread_archived
```

Native tool exposure is proven only if at least the core tools are callable:

- `create_thread`
- `send_message_to_thread`
- `read_thread`
- `list_threads`

## Fallback Until Exposed

Use `.codex/playbooks/crate-external-control-layer.md`.

Current operating model:

- source-of-truth thread coordinates all decisions
- local app-server bridge handles persistent Crate side threads
- sub-agents handle bounded read-only sidecar work
- paste-ready prompts are used only when the bridge/native tools are unavailable or when Bryant explicitly wants manual control
