---
name: crate-handoff
description: Create privacy-safe, restartable Crate handoffs for Codex App sessions and fresh-agent prompts. Use when Bryant asks for /handoff, /handoff state, /handoff prompt, or a Crate implementation, review, merge, release, QA, smoke-failure, or loop handoff that must preserve repo state, artifacts, tests, blockers, risks, and exact next prompts without leaking private paths, credentials, raw diagnostics, or unrelated client data.
---

# Crate Handoff

## Core Rule

Use `.codex/playbooks/crate-handoff.md` for full workflow details. This skill is the quick operating guide for generating handoffs only. Do not modify code, commit, push, merge, build, release, deploy, tag, notarize, mutate dependencies, close issues or PRs, or comment publicly while generating a handoff unless Bryant explicitly authorizes that separate action.

## Mode Selection

- `/handoff` and `/handoff state`: use Handoff State Mode.
- `/handoff prompt`: use Handoff Prompt Mode.
- `/handoff implementation`, `/handoff review`, `/handoff merge`, `/handoff release`, `/handoff qa`, `/handoff smoke-failure`, and `/handoff loop`: use Handoff State Mode with that variant's required fields.

Default to showing the handoff to Bryant. On macOS, if Bryant asks to copy it and `pbcopy` is available, copy the generated handoff with `pbcopy`; otherwise print it.

## Handoff Prompt Mode

Use for `/handoff prompt`, independent review, or delegating discussion and implementation planning.

Prompt handoffs are path-free by default:
- Do not include absolute paths.
- Do not include home-directory paths.
- Use portable anchors: branch, PR URL, QA version, exact error text, function names, tests, package keys, release tag, artifact filename, and public URL.
- Tell the receiving agent to review first before implementing.
- Tell the receiving agent to decide whether the task is real, stale, over-scoped, already solved, or better handled differently.
- Tell the receiving agent not to push, merge, release, deploy, tag, close issues or PRs, or comment publicly unless explicitly authorized.

Minimal prompt shape:

```text
Use the Crate repo on branch <branch> and review <portable anchors>.

Task:
<problem or review request>

First, verify the task is real and current. Decide whether it is stale,
over-scoped, already solved, or better handled differently before planning
any implementation. Do not push, merge, release, deploy, tag, close issues
or PRs, or comment publicly unless Bryant explicitly authorizes it.
```

## Handoff State Mode

Use for `/handoff`, `/handoff state`, active-session restart, implementation, QA, release-gate, or loop continuation.

Required headings:

```markdown
# Crate Handoff

## Mode

## Current Status

## Repo State
- repo owner/name:
- local path (only if operationally needed):
- branch:
- base branch:
- HEAD commit:
- working tree status:
- changed files:
- untracked files:
- active PRs:
- tag/release status if relevant:

## Work Completed

## Files Changed

## Tests / Checks Run

## Artifacts

## QA State

## Blockers

## Risks

## Decisions Made

## Next Recommended Action

## Exact Next Prompt

## Stop Conditions for Next Session
```

`Repo State` must include repo owner/name, local path only if operationally needed, branch, base branch, HEAD commit, working tree status, changed files, untracked files, active PRs, and tag/release status if relevant.

## Privacy Filter

Never include passwords, tokens, signing credentials, keychain passwords, Apple Developer secrets, raw lsof output, raw ps output, raw mdls output, raw AppleScript/JXA output, raw broad private file lists, Figma tokens, signed URLs, unrelated private/client file paths, or raw diagnostics that leak private folder structures.

Allowed anchors include approved QA root paths, approved QA fixture names, public PR/release URLs, artifact filenames, exact error text, function names, branch names, test names, and package/config keys.

## Variant Notes

- Implementation: include bug, intended behavior, touched files, tests, current diff, and no-commit status. Example: "continue `fix/v2.8-live-app-automation-diagnostics`; rerun `node --test tests/provenance-dual-write.test.js`."
- Review: include PR URL, base, changed files, checks already run, findings, and requested review stance. Example: "review PR #79 for release blockers before merge."
- Merge: include PR URL, base, mergeability, required checks, unresolved comments, and explicit no-merge-without-Bryant rule. Example: "PR #79 targets `v2.4.x`; verify checks before asking Bryant for merge approval."
- Release: include target version, gate status, artifact status, tag/release state, signing/notary blockers, and public-site prohibitions. Example: "continue QA prerelease `v2.8.0-qa.18`; do not update `get-crate.com`."
- QA: include app version, artifact filename, workflow lane, expected result, evidence needed, and privacy constraints. Example: "Jenna Illustrator clean linked JPG should stage as needs-save or produce safe breadcrumbs."
- Smoke-failure: include exact error text, failing command, version, artifact, reproduction steps, last known good, and stop conditions. Example: "Gatekeeper rejected DMG with `source=Unnotarized Developer ID`."
- Loop: include loop goal, allowed action set, last action, next action, loop state file if any, stop gates, and approval gates. Example: "continue crate-codex-loop with docs-only allowed actions; stop before commit."
