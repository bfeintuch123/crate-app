# Crate cmux Workbench Playbook

## Purpose
Use cmux-style workflows to organize multiple Codex CLI sessions for Crate engineering without changing the source of truth for code, GUI QA, or release decisions.

cmux is optional. It can help Bryant supervise parallel Codex CLI sessions, but Crate does not depend on cmux to build, test, review, or QA the app. Codex CLI remains the source of truth for code, tests, git, and release gates. Codex Computer Use remains the source of truth for GUI QA across Crate-supported creative apps and workflows. Bryant remains the human gate for merge, release, deploy, signing, notarization, sensitive app access, and public rollout.

## When To Use
- Multiple independent Crate tasks need separate Codex CLI sessions.
- Bryant wants implementation, review, tests, QA artifact review, and docs work visible in one workbench.
- A PR needs a builder session plus read-only reviewer or test sessions.
- Release readiness needs read-only gate checks before Bryant approves any release mutation.
- Docs/playbook work needs to stay isolated from app-code work.

## When Not To Use
- A single small task is easier to complete in one Codex CLI session.
- The work requires only Codex App reading, planning, or QA synthesis.
- The task is GUI-only and should use Codex Computer Use directly.
- The repo has uncommitted app-code changes whose owner is unclear.
- Multiple sessions would edit the same files or adjacent behavior.
- Bryant is not available to approve merge, release, deploy, signing, notarization, or destructive git decisions.

## Start Prompt
Use a prompt like:

```text
Use .codex/playbooks/crate-cmux-workbench.md to organize Crate Codex CLI sessions. Keep one workspace per task and branch, prevent conflicting edits, use Codex App for planning, Codex CLI for code/tests/git, Codex Computer Use for GUI QA, and do not run release/signing/notarization/deploy steps without Bryant approval.
```

## Roles
- Codex App: knowledge work, reading, planning, triage, QA synthesis, prompt drafting, summaries, and remote supervision.
- Codex CLI: implementation, tests, git operations, PR review, regression checks, release-gate checks, and docs edits.
- Codex Computer Use: GUI QA of Crate, Finder, initial Figma/PowerPoint/Keynote priority workflows, and other approved Crate-supported creative app lanes.
- cmux: optional workbench for organizing multiple Codex CLI sessions and their notifications.
- Bryant: human decision gate for merge, release, deploy, signing, notarization, public rollout, private assets, sensitive actions, and risky scope changes.

## Recommended Workspaces
- Implementation: one builder agent edits code for one task or branch.
- Review: read-only PR or branch review; no edits unless Bryant explicitly converts it into the builder.
- Tests: runs focused and broad test commands; reports failures with exact command output summaries.
- Release gate: read-only release-readiness checks only until Bryant approves release mutation.
- QA artifacts: reads screenshots, package outputs, manifest summaries, and GUI repro reports.
- GUI QA coordination: tracks which scoped creative app lane is approved for Codex Computer Use, but does not replace Computer Use for operating the GUI.
- Docs/playbooks: edits only docs, process, and playbook files when scoped.

Use one workspace per task and one branch per implementation stream. Do not let two workspaces edit overlapping files unless Bryant explicitly approves the ownership split.

## Files Codex May Read
- `AGENTS.md`.
- `.codex/playbooks/*.md`.
- `docs/*.md`.
- `README.md`.
- `package.json` and `package-lock.json` read-only unless the active task explicitly permits dependency or package-script work.
- changed files and tests needed for the active task.
- PR, issue, and release metadata through approved GitHub tooling.
- approved QA artifacts and package outputs under `/private/tmp` or another Bryant-approved path.

## Files Codex May Modify
- Only files explicitly owned by the active workspace task.
- Documentation-only workspaces may modify `.codex/playbooks/*.md`, `docs/*.md`, `README.md`, and `AGENTS.md` playbook references.
- Implementation workspaces may modify app files only when Bryant's task explicitly authorizes app-code work.
- Temporary reports under `/private/tmp/crate-*` when the playbook in use allows them.

## Files Codex Must Not Modify Without Explicit Scope
- `main.js`.
- `preload.js`.
- `renderer/`.
- `parsers/`.
- `scripts/`.
- `tests/`.
- `package.json`.
- `package-lock.json`.
- release artifacts.
- `crate-site/`.
- package outputs.
- tester or client assets.

## Commands And Checks Codex May Run
Baseline every workspace:

```sh
git status --short --branch
git branch --show-current
git rev-parse --short HEAD
git diff --name-only
```

Check branch relation to Crate source of truth:

```sh
git fetch origin v2.4.x
git rev-parse --short origin/v2.4.x
git log --oneline --decorate --left-right HEAD...origin/v2.4.x
```

Track PR status read-only:

```sh
gh pr status
gh pr list --base v2.4.x --state open --json number,title,headRefName,baseRefName,isDraft,mergeable,updatedAt,url
gh pr view <pr> --json number,title,headRefName,baseRefName,isDraft,mergeable,reviewDecision,statusCheckRollup,url
```

Inspect changed files:

```sh
git diff --name-only origin/v2.4.x...HEAD
git diff --stat origin/v2.4.x...HEAD
```

Run docs-only checks when the workspace edits process docs:

```sh
git diff --check
rg -n "[[:blank:]]$" AGENTS.md .codex/playbooks docs
rg -n "[^[:ascii:]]" AGENTS.md .codex/playbooks docs
```

Run tests only in the workspace assigned to tests or implementation, using the playbook for that task:

```sh
npm test
npm run test
node tests/<focused-test>.js
```

## Notification Discipline
- Keep notifications tied to actionable state: blocked, tests failed, review finding, ready for Bryant decision, or needs approval.
- Do not notify for every command.
- Include workspace name, branch, current task, and requested Bryant decision.
- Avoid duplicate notifications from multiple panes about the same failure.
- When a workspace finishes, report whether it is done, blocked, or handing off to another workspace.

## Branch And PR Tracking
- Treat `v2.4.x` as the canonical base unless Bryant explicitly says otherwise.
- Name the current branch in every status report.
- Record which workspace owns each branch.
- Record PR number, base branch, head branch, draft state, mergeability, and check status when a PR exists.
- Do not use `main` as a base for Crate release or feature work unless Bryant explicitly says so.
- Do not merge unless Bryant explicitly approves.

## Avoiding Parallel Conflicting Edits
- One builder agent edits code at a time.
- Specialist agents may review, audit, investigate, or plan without editing.
- Docs/playbook edits must not overlap app-code implementation unless Bryant approves the split.
- If a session sees unexpected dirty files, it stops and reports file names and likely owner.
- If two sessions need the same file, Bryant chooses the owner before either edits.
- Test and review sessions should use read-only commands unless Bryant assigns them fix ownership.

## Release, Signing, And Notarization Boundaries
Never run release, signing, notarization, stapling, tag, GitHub release, or deploy commands in an unsupervised pane.

Release-related commands require explicit Bryant approval at the exact step:

```sh
npx electron-builder --mac --arm64
xcrun notarytool submit <artifact> --wait
xcrun stapler staple <artifact>
xcrun stapler validate <artifact>
git tag <tag>
gh release create <tag>
gh release upload <tag>
npx wrangler pages deploy <directory>
netlify deploy
```

Release gate workspaces may run read-only checks from `.codex/playbooks/crate-release-gate.md`, but must stop before version bumps, builds, signing, notarization, tags, releases, deploys, or `crate-site` edits.

## Approval Gates
Bryant must explicitly approve:

- creating or switching branches for active work
- assigning a workspace to edit files
- converting a read-only review, tests, release-gate, or QA-artifacts workspace into a builder workspace
- touching private tester or client assets
- launching GUI QA through Codex Computer Use
- expanding GUI QA from one app lane to another
- granting permissions or using authenticated browser sessions
- dependency mutation
- app-code changes when the current scope is docs/process only
- commits, pushes, PR creation, merges, tags, releases, builds, signing, notarization, stapling, deploys, and site updates

## Must Never Do
- Do not treat cmux as required to test Crate.
- Do not use cmux as a substitute for Codex CLI command logs, git status, tests, or release gates.
- Do not use cmux as a substitute for Codex Computer Use GUI QA.
- Do not use cmux organization as approval for broad app access; each GUI QA lane stays scoped to the current task.
- Do not run unsupervised release, signing, notarization, deploy, tag, merge, or GitHub release commands.
- Do not let multiple agents edit overlapping files without Bryant's explicit approval.
- Do not touch `main` as a Crate release base unless Bryant explicitly says so.
- Do not edit app code, tests, package files, release artifacts, site files, or package outputs from a docs/playbooks workspace.
- Do not hide failed checks in a pane; failed commands must be surfaced in the final workspace report.

## Quality Impact
- Speeds Crate development by keeping implementation, review, test, release-gate, QA-artifact, and docs work visible but separated.
- Reduces wrong-branch work by making branch ownership explicit.
- Reduces conflicting edits by assigning one builder workspace at a time.
- Keeps GUI QA evidence in Codex Computer Use instead of guessing from code.
- Keeps release actions behind Bryant's explicit human gate.
- Helps Bryant supervise multiple Codex CLI sessions without turning Crate into an OpenClaw-style product.

## Definition Of Done
- Workspace list, branch ownership, and task ownership are recorded.
- Each workspace is marked active, blocked, done, or stopped.
- Changed files and dirty state are reported by workspace.
- Commands and checks are summarized with failures surfaced.
- Any next approval Bryant must make is explicit.
- No unsupervised release, signing, notarization, deploy, tag, merge, or GitHub release action occurred.

## Report Format
- Workbench:
  - Is cmux required:
  - Workspaces:
  - Branches:
  - PRs:
- Workspace status:
  - Implementation:
  - Review:
  - Tests:
  - Release gate:
  - QA artifacts:
  - Docs/playbooks:
- Ownership:
  - Builder:
  - Read-only sessions:
  - Files owned:
  - Files off-limits:
- Commands run:
- Checks:
  - Passed:
  - Failed:
  - Blocked:
- Approvals needed:
- Risks:
- Whether Bryant can proceed:
