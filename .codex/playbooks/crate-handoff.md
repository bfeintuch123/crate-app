# Crate Handoff Playbook

## Purpose
Create restartable, privacy-safe Crate handoffs for Codex App sessions and fresh-agent prompts.

This playbook preserves enough state for another session to continue intelligently without leaking credentials, private project paths, raw diagnostics, or unrelated local context. It complements Crate's existing review, fix, QA, release-gate, and loop playbooks; it does not replace them.

## When To Use
- Bryant asks for `/handoff`, `/handoff state`, or a restartable state summary.
- Bryant asks for `/handoff prompt`, a fresh-agent prompt, or independent review prompt.
- An implementation, QA, release gate, smoke failure, merge review, or autonomous loop needs to be paused and resumed later.
- A handoff must clarify exact next action, stop conditions, and what the next agent must verify before acting.

## Relationship To Other Playbooks
This complements, not replaces:
- `crate-codex-loops.md`
- `clawpatch-fix.md`
- `crate-autoreview.md`
- `review-crate-pr.md`
- `crate-bug-triage.md`
- `crate-regression-detector.md`
- `crate-security-scan.md`
- `crate-provenance-review.md`
- `crate-release-gate.md`
- `crate-computer-use-qa.md`
- `crate-gui-repro-flow.md`
- `crate-package-diff.md`

If the next session needs to act, name the relevant playbook in `Exact Next Prompt`. A handoff alone is not permission to edit, commit, push, merge, release, deploy, tag, notarize, or mutate dependencies.

## Slash Behavior
- `/handoff` defaults to Handoff State Mode.
- `/handoff state` uses Handoff State Mode.
- `/handoff prompt` creates a fresh-agent prompt.
- `/handoff implementation`, `/handoff review`, `/handoff merge`, `/handoff release`, `/handoff qa`, `/handoff smoke-failure`, and `/handoff loop` use Handoff State Mode with variant-specific required fields.
- In all modes, Codex must not modify code, commit, push, merge, build, release, deploy, tag, notarize, or mutate dependencies.
- If clipboard is available on macOS and Bryant asks for clipboard output, Codex may copy the generated handoff with `pbcopy`; otherwise print it.
- Default output is to show the handoff to Bryant.

## Start Gate
Before generating a state handoff from local repo data, confirm:
- repo path
- repo owner/name
- repo identity is `crate-app`, not `crate-web`
- current branch and base branch
- HEAD commit
- working tree status
- changed files and untracked files

For prompt handoffs, do not add local repo data unless it is relevant and privacy-safe. Prompt handoffs should be path-free by default.

## Mode 1: Handoff Prompt Mode
Use for:
- `/handoff prompt`
- asking another agent for independent review
- delegating discussion or implementation planning

Rules:
- Path-free by default.
- Do not include absolute paths.
- Do not include home-directory paths.
- Use portable anchors: branch, PR URL, QA version, exact error text, function names, tests, package keys, release tag, artifact filename, and public URL.
- The receiving agent must review first before implementing.
- The receiving agent must decide whether the task is real, stale, over-scoped, already solved, or better handled differently.
- The receiving agent must not push, merge, release, deploy, tag, close issues or PRs, or comment publicly unless explicitly authorized.

Template:

```text
Use the Crate app repo. Portable anchors:
- Branch:
- Base:
- PR URL:
- QA version or release tag:
- Exact error text:
- Relevant functions:
- Relevant tests:
- Relevant package/config keys:

Task:
<state the review, discussion, or planning request>

Before implementing, review the current branch and decide whether the task is
real, stale, over-scoped, already solved, or better handled differently.

Do not push, merge, release, deploy, tag, close issues or PRs, or comment
publicly unless Bryant explicitly authorizes that action.
```

Example:

```text
Use the Crate app repo on branch `fix/v2.8-live-app-automation-diagnostics`.
Review PR #79 against `v2.4.x` for release blockers around live-app Automation
breadcrumbs. Relevant anchors: `recordLiveAppStatusBreadcrumb`,
`refreshLiveAppEvidenceForProject`, `tests/provenance-dual-write.test.js`,
and package keys `build.afterPack`, `build.mac.extendInfo`, and
`build.mac.entitlements`.

First decide whether the reported risk is real, stale, over-scoped, already
solved, or better handled differently. Do not push, merge, release, deploy,
tag, close issues or PRs, or comment publicly unless Bryant explicitly
authorizes it.
```

## Mode 2: Handoff State Mode
Use for:
- `/handoff`
- `/handoff state`
- handing off an active Crate session
- restarting an implementation, QA, release, or loop later

Required output:

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
- tag/release status:

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

`local path` should be omitted or set to "not needed" unless it is operationally needed for the next local Codex session. If included, keep it to an approved operational repo path, not unrelated private/client paths.

## Privacy And Security Rules
Never include:
- passwords
- tokens
- signing credentials
- keychain passwords
- Apple Developer secrets
- raw lsof output
- raw ps output
- raw mdls output
- raw AppleScript/JXA output
- raw broad private file lists
- Figma tokens
- signed URLs
- unrelated private/client file paths
- raw diagnostics that leak private folder structures

Allowed:
- approved QA root paths
- approved QA fixture names
- public PR/release URLs
- artifact filenames
- exact error text
- function names
- branch names
- test names
- package/config keys

If useful evidence contains private paths or raw diagnostics, summarize the category and safe consequence instead of copying it.

## Variants

### /handoff implementation
Required fields:
- branch and base branch
- bug or goal
- intended behavior
- current implementation status
- changed files
- tests already run
- failing checks, if any
- exact next implementation prompt
- no-commit status

Example:

```markdown
## Mode
implementation

## Current Status
Patch drafted for live-app Automation breadcrumbs; tests are passing locally.

## Exact Next Prompt
Use `.codex/playbooks/clawpatch-fix.md` on branch `fix/v2.8-live-app-automation-diagnostics`. Review the diff first, verify the task is still needed, then run `node --test tests/provenance-dual-write.test.js` and `git diff --check`. Do not commit until Bryant approves.
```

### /handoff review
Required fields:
- PR URL or branch
- base branch
- review mode
- changed files or risk surfaces
- checks already run
- findings or open questions
- exact next review prompt
- public-comment prohibition unless approved

Example:

```markdown
## Mode
review

## Exact Next Prompt
Use `.codex/playbooks/crate-autoreview.md` in release-blocker mode for PR #79 against `v2.4.x`. Review first, then run focused checks only if needed. Do not comment publicly, merge, or push unless Bryant explicitly approves.
```

### /handoff merge
Required fields:
- PR URL
- base branch
- mergeability
- required checks
- unresolved comments
- release impact
- exact next prompt for merge readiness
- explicit no-merge-without-Bryant rule

Example:

```markdown
## Mode
merge

## Exact Next Prompt
Use `review-crate-pr.md` for PR #79. Confirm base is `v2.4.x`, checks are green, unresolved review comments are addressed, and branch is mergeable. Do not merge unless Bryant explicitly approves.
```

### /handoff release
Required fields:
- target version
- release type: QA prerelease or public release
- branch and HEAD
- gate status
- artifact status
- tag/release status
- signing/notary status
- site/deploy status
- stop conditions
- exact next release-gate prompt

Example:

```markdown
## Mode
release

## Exact Next Prompt
Use `.codex/playbooks/crate-release-gate.md` for `v2.8.0-qa.18` as an internal QA prerelease. Verify branch `v2.4.x`, tag/release absence, focused tests, signing identity, generated app metadata, and artifact validation. Do not update `get-crate.com`, deploy the site, or create final public `v2.8.0`.
```

### /handoff qa
Required fields:
- app version or artifact filename
- QA lane
- workflow steps already completed
- expected result
- observed result
- evidence needed next
- privacy constraints
- exact next QA prompt

Example:

```markdown
## Mode
qa

## Exact Next Prompt
Use `crate-computer-use-qa.md` for Crate `v2.8.0-qa.18`. Run the Illustrator clean linked JPG workflow. Expected result: file stages as needs-save/pending or diagnostics expose a safe failure breadcrumb. Do not collect private client assets or raw broad file lists.
```

### /handoff smoke-failure
Required fields:
- exact failing command
- exact error text
- version/artifact
- reproduction steps
- last known good
- likely risk surface
- files not to touch
- exact next triage prompt

Example:

```markdown
## Mode
smoke-failure

## Exact Next Prompt
Use `crate-bug-triage.md` and `crate-regression-detector.md` for smoke failure `Gatekeeper rejected DMG with source=Unnotarized Developer ID` on `v2.8.0-qa.18`. Verify artifact signing and stapling state first. Do not rebuild, notarize, tag, release, or deploy unless Bryant explicitly approves.
```

### /handoff loop
Required fields:
- loop name
- goal
- allowed action set
- definition of done
- last action
- last observation
- next allowed action
- loop state file, if any
- stop gates
- approval needed

Example:

```markdown
## Mode
loop

## Exact Next Prompt
Use `crate-codex-loops.md` for loop `qa18-adobe-observability`. Goal: run scoped QA and produce safe findings. Allowed actions: inspect repo, run approved tests, use Computer Use for scoped QA, and update loop state. Stop before commit, push, release, deploy, tag, notarization, dependency mutation, or private artifact collection.
```

## Verification Commands
Use read-only commands unless Bryant separately approves mutation:

```sh
git status --short --branch
git branch --show-current
git rev-parse HEAD
git rev-parse origin/v2.4.x
git diff --name-only
git diff --stat
gh pr list --base v2.4.x --state open
gh release view <tag>
```

For docs-only changes to this playbook or the skill, run:

```sh
git diff --check
git diff --name-only
rg -n "[[:blank:]]$" AGENTS.md .codex/playbooks/crate-handoff.md .agents/skills/crate-handoff/SKILL.md
LC_ALL=C rg -n "[^[:ascii:]]" AGENTS.md .codex/playbooks/crate-handoff.md .agents/skills/crate-handoff/SKILL.md
```

Run the ASCII check when the edited files are intended to stay ASCII-only. Existing non-ASCII outside the edited lines should be reported rather than churned.

## Approval Gates
Generating a handoff is read-only by default. Bryant must explicitly approve:
- code edits
- test edits
- package file edits
- dependency mutation
- app launch that touches private projects
- package output creation from private files
- commits
- pushes
- PR creation
- public comments
- merges
- builds
- releases
- deploys
- tags
- notarization

## Must Never Do
- Do not turn a handoff request into implementation unless Bryant explicitly asks.
- Do not include private credentials, secrets, raw diagnostics, broad local file inventories, or unrelated private/client paths.
- Do not imply approval for the next session to mutate repo or GitHub state.
- Do not use `main` as a Crate feature or release base unless Bryant explicitly says so.
- Do not touch `crate-web` while creating a Crate app handoff.

## Definition Of Done
- Correct mode is selected.
- Required sections are present.
- Repo and PR/release state are verified when state mode depends on them.
- Privacy filter is applied.
- Next action is concrete and bounded.
- Exact next prompt is usable by a fresh Codex agent.
- Stop conditions are explicit.
- No code, package, dependency, release, deploy, tag, or public GitHub mutation occurs unless separately approved.
