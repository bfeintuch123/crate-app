# Crate Workstream Status Playbook

## Purpose
Give Bryant a reliable snapshot of Crate's current engineering state before deciding what to do next.

This playbook is read-only process orchestration. It should separate confirmed repository, PR, release, QA, and tester-feedback state from assumptions so Bryant can choose the next safe branch, PR, or playbook.

## When To Use
- At the start of a Codex session when Bryant needs orientation.
- Before choosing whether to continue QA, triage tester feedback, prepare a release gate, review a PR, or start a fix branch.
- After a PR merges into `v2.4.x` and Bryant needs to know whether release, site deploy, manual QA, or tester follow-up is pending.
- When there are multiple active Crate workstreams and the next branch or PR is unclear.
- Before touching any provenance, release, QA, or tester-feedback branch.

## Start Prompt
Use a prompt like:

```text
Use .codex/playbooks/crate-workstream-status.md to summarize Crate's current workstream state. Check branch, working tree, local versus origin/v2.4.x, open PRs, latest merged PRs, releases, QA prereleases, site deploy state, manual QA, tester feedback, safe next action, blockers, and do not modify code or release state.
```

## Inspect
- current branch
- working tree cleanliness
- local HEAD versus `origin/v2.4.x`
- active open PRs targeting `v2.4.x`
- latest merged PRs targeting `v2.4.x`
- current public release, verified from GitHub release metadata and site state
- current QA prerelease, verified from GitHub release metadata
- whether release or site deploy is pending
- whether manual QA is pending
- whether tester feedback is pending
- what branch or PR should be touched next
- what branches, PRs, files, or release surfaces must not be touched

## Files Codex May Read
- `AGENTS.md`
- `.codex/playbooks/*.md`
- `docs/*.md`
- `README.md`
- `package.json` read-only, for local version context only
- `git` history and branch metadata
- GitHub PR, issue, and release metadata through `gh`
- public `get-crate.com` HTML and headers through read-only `curl`

## Files Codex May Modify
- None.

With Bryant's explicit approval for process reporting, Codex may write a temporary markdown status report under `/private/tmp/crate-workstream-status-*`.

## Files Codex Must Not Modify
- `main.js`
- `preload.js`
- `renderer/`
- `parsers/`
- `scripts/`
- `tests/`
- `package.json`
- `package-lock.json`
- release artifacts
- `crate-site/`
- any package output
- any tester or client asset

## Read-Only Commands Codex May Run
Confirm branch, cleanliness, and local versus remote state:

```sh
git status --short --branch
git branch --show-current
git rev-parse --short HEAD
git fetch origin v2.4.x
git rev-parse --short origin/v2.4.x
git log --oneline --decorate --left-right HEAD...origin/v2.4.x
git diff --name-only
git diff --stat
```

Inspect active open PRs and recently merged PRs:

```sh
gh pr list --base v2.4.x --state open --json number,title,headRefName,baseRefName,isDraft,mergeable,updatedAt,url
gh pr list --base v2.4.x --state merged --limit 12 --json number,title,headRefName,baseRefName,mergedAt,url
gh pr status
```

Inspect release and prerelease state without mutating it:

```sh
gh release list --limit 30
gh release view <public-release-tag> --json tagName,name,isDraft,isPrerelease,publishedAt,assets,url
gh release view <qa-prerelease-tag> --json tagName,name,isDraft,isPrerelease,publishedAt,assets,url
```

Inspect public site state read-only before deciding whether site deploy is pending:

```sh
curl -I https://get-crate.com/
curl -L -s -H "Cache-Control: no-cache" https://get-crate.com/ | rg -n "v[0-9]+\\.[0-9]+\\.[0-9]+|download|dmg|GitHub|releases"
```

Inspect QA and tester-feedback state from issues, PRs, and local docs:

```sh
gh issue list --state open --search "Jenna QA OR manual QA OR tester feedback OR v2.8.0" --json number,title,labels,updatedAt,url
gh pr list --state open --search "qa OR tester OR release OR provenance" --json number,title,headRefName,baseRefName,isDraft,updatedAt,url
rg -n "Jenna|manual QA|tester feedback|v2\\.8\\.0|qa\\.1|release pending|deploy pending|get-crate\\.com" AGENTS.md docs .codex/playbooks
```

Run docs-only consistency checks only if this playbook or related process docs are edited:

```sh
git diff --check
rg -n "[[:blank:]]$" AGENTS.md .codex/playbooks docs
rg -n "[^[:ascii:]]" AGENTS.md .codex/playbooks docs
```

## Required Checks
- Branch is named and compared to `origin/v2.4.x`.
- Dirty files, if any, are listed before any recommendation.
- Open PRs are listed with base branch, head branch, draft state, and mergeability when available.
- Latest merged PRs are listed by PR number, title, branch, and merge date.
- Public release is identified from GitHub release metadata, not memory.
- QA prerelease is identified from GitHub release metadata, not memory.
- `get-crate.com` state is checked before saying site deploy is pending or complete.
- Manual QA status is based on Bryant-provided context, issues, PRs, or docs; unknowns remain unknown.
- Tester feedback status is based on Bryant-provided context, issues, PRs, or docs; unknowns remain unknown.
- The recommended next branch or PR is tied to the verified state.
- A "do not do" list is included before any action recommendation.

## Approval Gates
Codex may run read-only inspection commands. Bryant must explicitly approve any operation that changes branch, working tree, GitHub state, release state, package output, site state, dependencies, or tester artifacts.

Commands requiring explicit Bryant approval:

```sh
git switch <branch>
git checkout <branch>
git pull origin v2.4.x
git add <files>
git commit
git push
gh pr edit <pr>
gh pr comment <pr>
gh pr merge <pr>
gh issue create
gh issue edit <issue>
npm install
npm ci
npm audit fix
npm start
npx electron-builder --mac --arm64
xcrun notarytool submit <artifact> --wait
xcrun stapler staple <artifact>
xcrun stapler validate <artifact>
git tag <tag>
gh release create <tag>
gh release upload <tag>
npx wrangler pages deploy <directory>
```

## Must Never Do
- Do not modify code, tests, package files, release artifacts, package outputs, or site files.
- Do not switch branches unless Bryant explicitly approves the branch change.
- Do not commit, push, merge, tag, release, notarize, build, deploy, or mutate dependencies.
- Do not infer release state, QA state, public-site state, or tester-feedback state without checking.
- Do not treat `main` as the base for Crate release or feature work unless Bryant explicitly says so.
- Do not touch active provenance, release, or QA branches unless Bryant names them as the target.
- Do not expose private tester, client, local path, token, or credential data in the report.

## Decision Rules
- If the branch is dirty, safe next action is usually to stop and identify the owner of those changes.
- If local HEAD differs from `origin/v2.4.x`, safe next action is usually to decide whether to update from `origin/v2.4.x` before starting work.
- If open PRs exist, safe next action should name the highest-priority PR and why it is safe to inspect or not inspect.
- If a QA prerelease exists but final release is absent, do not recommend public-site updates until QA and release-gate state are verified.
- If manual QA or tester feedback is pending, prefer `.codex/playbooks/crate-qa-results-synthesizer.md`, `.codex/playbooks/crate-bug-triage.md`, or `.codex/playbooks/crate-manual-qa-matrix.md` before release work.
- If release readiness is being considered, recommend `.codex/playbooks/crate-release-gate.md` before any release mutation.

## Quality Impact
- Reduces wrong-branch work by making branch, base, and dirty-state checks the first step.
- Prevents accidental releases or site deploys based on stale memory.
- Speeds Crate development by turning scattered PR, release, QA, and tester signals into one operational snapshot.
- Reduces duplicated work by identifying the branch or PR that should be touched next.
- Makes blocked actions explicit before Codex starts implementation, review, release, or QA work.

## Definition Of Done
- Branch, HEAD SHA, `origin/v2.4.x` SHA, and dirty state are reported.
- Open PRs and latest merged PRs are summarized.
- Public release, QA prerelease, and `get-crate.com` state are checked or marked blocked with the reason.
- Manual QA and tester-feedback state are checked or marked unknown with missing evidence.
- Safe next action, blocked actions, risks, and "do not do" list are reported.
- No app code, tests, package files, release artifacts, site files, branches, PRs, releases, tags, or deploys are mutated.

## Report Format
- Current state:
  - Branch:
  - HEAD:
  - `origin/v2.4.x`:
  - Working tree:
  - Local versus remote:
  - Open PRs:
  - Latest merged PRs:
  - Public release:
  - QA prerelease:
  - `get-crate.com`:
  - Manual QA:
  - Tester feedback:
- Safe next action:
  - Branch or PR to touch next:
  - Recommended playbook:
  - Evidence:
- Blocked actions:
  - Action:
  - Blocker:
  - Approval or evidence needed:
- Risks:
  - Release risk:
  - QA risk:
  - Branch risk:
  - Privacy risk:
- Do not do:
  - Branches or PRs not to touch:
  - Files not to edit:
  - Commands not to run:
- Commands run:
- Files changed:
- Whether Bryant can proceed:
