# Crate Autoreview Playbook

## Purpose
Run a deep, adversarial, multi-pass pre-merge review for important Crate PRs without changing app behavior.

This playbook is inspired by Peter Steinberger/OpenClaw-style autoreview loops: inspect broadly, challenge assumptions, review from multiple risk angles, and return concrete fix recommendations. It is review-only by default. Codex must not edit code, tests, package files, dependencies, release files, tags, deploys, or PR merge state unless Bryant explicitly approves a separate follow-up fix or release step.

## When To Use
- Before landing important Crate PRs.
- When a PR touches watcher, parser, package, Figma, provenance, diagnostics, privacy, security, or UX language behavior.
- Before release candidates or high-risk PRs where a normal merge-readiness review is not enough.
- When Bryant wants an adversarial "what could go wrong?" pass.
- When previous reviews found issues and Bryant needs specific fix recommendations before deciding whether to approve implementation.

## Start Prompt
Use a prompt like:

```text
Use .codex/playbooks/crate-autoreview.md in <standard|deep|release-blocker|fix-recommendation> mode for PR <number>. Confirm base v2.4.x, stay review-only, orchestrate relevant Crate playbooks, produce concrete fix recommendations, and do not edit code unless Bryant explicitly approves a follow-up fix.
```

## Core Principle
Autoreview is review-only by default.

If autoreview finds a problem, it must not stop at "request changes." It must explain:
- what is wrong
- why it matters
- exact file, function, or area likely involved
- proposed fix approach
- tests to add or update
- risk level
- whether Bryant should approve applying the fix
- exact next prompt Bryant can use to approve implementation

Do not apply fixes automatically. Use fix-recommendation mode to prepare specific implementation guidance, then wait for Bryant's approval.

## Modes

### Standard Mode
Use for normal PRs that need a strong pre-merge review.

Review:
- PR base, branch, mergeability, review state, and CI state
- changed files and scope
- whether changes match the PR intent
- test coverage and focused tests
- obvious regressions
- package/result shape drift
- forbidden or out-of-scope files
- watcher, parser, package, Figma, and provenance guardrails when touched
- merge readiness

Recommended orchestrated playbooks:
- `review-crate-pr.md`
- `crate-regression-detector.md`
- `crate-pr-documenter.md` when Bryant needs reviewer notes or a factual PR summary

### Deep Mode
Use for important PRs, stacked changes, or changes in high-risk Crate surfaces.

Include Standard mode, plus:
- adversarial edge-case review
- "what could go wrong?" pass
- stale assumption check
- hidden coupling check across capture, parser, package, provenance, diagnostics, and UI
- package output review
- provenance and diagnostics review
- privacy and security review
- UX and product-language review
- test adequacy review
- manual QA impact
- whether Computer Use QA is needed

Recommended orchestrated playbooks:
- `review-crate-pr.md`
- `crate-regression-detector.md`
- `crate-provenance-review.md` when provenance evidence or manifest output is touched
- `crate-security-scan.md` when file IO, parser, package, token, shell, privacy, or manifest risk is present
- `crate-package-diff.md` when package output may change
- `crate-provenance-snapshot.md` when graph shape or confidence output may change
- `crate-manual-qa-matrix.md` when workflows need human QA coverage
- `crate-computer-use-qa.md` when GUI verification is needed
- `crate-gui-repro-flow.md` when GUI-only bugs are involved

### Release-Blocker Mode
Use before release candidates, for high-risk PRs, or when deciding whether a branch can enter final release readiness.

Include Deep mode, plus:
- release-readiness impact
- manual QA impact
- package/provenance snapshot impact
- security/privacy gate
- whether to block final release
- whether a `v2.8.0-qa.x` rebuild is required
- whether release notes, tester notes, or QA artifacts need updates

Recommended orchestrated playbooks:
- `crate-release-gate.md` for strict release-readiness gates
- `crate-regression-detector.md`
- `crate-security-scan.md`
- `crate-package-diff.md`
- `crate-provenance-snapshot.md`
- `crate-manual-qa-matrix.md`
- `crate-pr-documenter.md`
- `crate-computer-use-qa.md` when GUI verification is needed

Do not run release, build, deploy, tag, notarization, or dependency mutation commands. A release-blocker autoreview may recommend blocking release, but it must not start release work.

### Fix-Recommendation Mode
Use when autoreview finds issues and Bryant needs exact fix guidance before approving implementation.

This mode produces specific code-fix recommendations without applying them automatically. Each finding must include:
- finding title
- severity: `blocker`, `high`, `medium`, `low`, or `polish`
- affected files/functions
- root-cause hypothesis
- proposed code change
- proposed tests
- risk of fixing
- risk of not fixing
- smallest safe branch name
- exact implementation prompt for Bryant to approve
- whether Codex should apply the fix now or wait

Fix-recommendation mode may be used after Standard, Deep, or Release-blocker mode. It may read code and tests to make recommendations, but it must not edit them unless Bryant explicitly approves a follow-up implementation step.

## Inspect
- Current branch, PR number, base branch, head branch, dirty state, and whether the PR targets `v2.4.x`.
- PR title, description, commits, changed files, status checks, review decision, and mergeability.
- Full diff and changed-file list.
- Whether changed files touch:
  - `main.js`
  - `preload.js`
  - `renderer/`
  - `parsers/`
  - `scripts/`
  - `tests/`
  - `docs/`
  - `.codex/playbooks/`
  - `package.json`
  - `package-lock.json`
  - `crate-site/`
  - release artifacts
- Scope drift, forbidden files, unrelated behavior changes, and dependency changes.
- Watcher behavior, package filtering, parser behavior, Figma scope enforcement, provenance output, diagnostics output, privacy boundaries, and user-facing copy.
- Existing test coverage and missing regression tests.
- Manual QA and Computer Use QA needs.

## Files Codex May Read
- `AGENTS.md`
- `.codex/playbooks/*.md`
- `docs/*.md`
- `README.md`
- changed files in the PR or working tree
- `main.js`, `preload.js`, `renderer/`, `parsers/`, `scripts/`, and `tests/` read-only when needed to understand review scope
- `package.json` and `package-lock.json` read-only, for scripts and dependency risk
- `crate-site/` read-only when site or release-link behavior is in scope
- existing package outputs or provenance artifacts only when Bryant has identified them as review inputs
- PR metadata and diffs through `gh`

## Files Codex May Modify
- None by default.
- For docs/process/playbook work explicitly scoped by Bryant, Codex may modify only:
  - `.codex/playbooks/*.md`
  - `docs/*.md`
  - `AGENTS.md` playbook references
- In fix-recommendation mode, Codex may modify app code or tests only after Bryant explicitly approves a separate follow-up implementation prompt.

## Files Codex Must Not Modify By Default
- `main.js`
- `preload.js`
- `renderer/`
- `parsers/`
- `scripts/`
- `tests/`
- `package.json`
- `package-lock.json`
- release artifacts
- generated build outputs
- `crate-site/` unless Bryant explicitly scopes site documentation work

## Command Categories
Start with branch and working-tree context:

```sh
git status --short --branch
git branch --show-current
git fetch origin
git diff --name-only
git diff --stat
git diff --check
```

Inspect PR metadata and diffs:

```sh
gh pr view <pr> --json baseRefName,headRefName,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,title,body
gh pr diff <pr> --name-only
gh pr diff <pr>
```

Map risk surfaces with targeted searches:

```sh
rg -n "Figma|figma|Current Page|Entire File|pageLock|scopeMode|provenance|diagnostic|manifest|crate-provenance" main.js preload.js renderer parsers scripts tests docs .codex
rg -n "Photoshop|Illustrator|InDesign|watcher|chokidar|lsof|Spotlight|package|parser|pending|accept|reject" main.js preload.js renderer parsers scripts tests docs .codex
rg -n "path\\.join|path\\.resolve|realpath|normalize|relative|symlink|copyFile|writeFile|mkdir|extract|exec\\(|spawn\\(|token|secret|credential|Authorization|Bearer" main.js preload.js renderer parsers scripts tests docs .codex
```

Run focused checks based on touched areas. Do not claim these ran unless they actually ran:

```sh
node --check main.js
node tests/provenance.test.js
node tests/provenance-dual-write.test.js
node tests/psd-embedded-safety.test.js
node tests/figma-scope.test.js
node tests/figma-link-per-project.test.js
```

Use docs checks for playbook-only changes:

```sh
git diff --check
rg -n "[[:blank:]]$" .codex/playbooks docs AGENTS.md
LC_ALL=C rg -n "[^[:ascii:]]" .codex/playbooks docs AGENTS.md
```

Use package and provenance artifact checks only when artifacts are available or Bryant approves generating them through a separate workflow:

```sh
find <package-output> -type f | sort
rg -n "token|secret|credential|cdn\\.figma|Authorization|Bearer|rawTrackedFiles" <package-output>
diagnostic_manifest="<package-output>/Crate Diagnostics/crate-provenance.json"
node -e "const fs=require('fs'); const m=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); console.log(JSON.stringify({copiedCount:m.copiedCount,embeddedCount:m.embeddedCount,totalFiles:m.totalFiles,errors:m.errors||[],nodes:(m.nodes||[]).length,edges:(m.edges||[]).length,warnings:m.warnings||[]}, null, 2));" "$diagnostic_manifest"
```

Diagnostic manifests are optional and off by default. Enable `Include diagnostic report in packages` before expecting `Crate Diagnostics/crate-provenance.json`; do not expect a package-root manifest in default package output.

## Check Selection
- Docs-only or playbook-only: run docs checks, inspect the docs diff, and do not run app tests unless the docs make behavior claims that need verification.
- Normal PR: run Standard mode and the narrowest focused tests that cover changed behavior.
- High-risk app behavior: run Deep mode and include security, provenance, package, and manual QA assessment where relevant.
- Package output changes: include `crate-package-diff.md`.
- Provenance graph or confidence changes: include `crate-provenance-review.md` and `crate-provenance-snapshot.md`.
- File IO, parser filenames, shell, tokens, or privacy changes: include `crate-security-scan.md`.
- GUI workflow changes or hard-to-observe UI bugs: include `crate-computer-use-qa.md` or `crate-gui-repro-flow.md`.
- Release candidate or release-risk PR: run Release-blocker mode and consider `crate-release-gate.md` without starting release work.

## Approval Gates
Codex may inspect, run read-only checks, and report without Bryant approval.

Bryant must explicitly approve:
- code edits
- test edits
- dependency mutation
- app launches that create package outputs from private projects
- generating package/provenance artifacts from private work
- commits
- pushes
- merges
- release builds
- notarization
- tags
- deploys
- destructive cleanup

Commands requiring explicit Bryant approval:

```sh
npm install
npm ci
npm audit fix
git add <files>
git commit
git push
git reset
git checkout -- <file>
gh pr merge <pr>
npm start
npx electron-builder --mac --arm64
xcrun notarytool submit <artifact> --wait
xcrun stapler staple <artifact>
xcrun stapler validate <artifact>
git tag <tag>
npx wrangler pages deploy <directory>
rm -rf <path>
```

## Must Never Do
- Do not edit code automatically during autoreview.
- Do not edit tests automatically during autoreview.
- Do not edit `main.js`, renderer files, tests, package files, release files, build outputs, or dependencies unless Bryant explicitly approves a follow-up implementation step.
- Do not commit, push, merge, build, release, deploy, tag, notarize, or mutate dependencies.
- Do not run destructive commands.
- Do not expose secrets, tokens, credentials, raw API responses, private project contents, signed URLs, raw command output, or sensitive local paths.
- Do not claim tests, checks, package diffs, Computer Use QA, or manual QA ran unless they actually ran.
- Do not overclaim certainty. State confidence and remaining unknowns.
- Do not give vague "fix it" recommendations. Every finding must include concrete next actions.
- Do not treat every diff as a bug. Separate expected changes from unexpected changes.

## Report Format
Use this structure:

```text
Verdict: approve | request changes | needs artifacts | block release

Branch/PR:
- Branch:
- PR:
- Base:
- Mergeability:
- Dirty state:

Changed Files Reviewed:
- <file or group>: <reviewed concern>

Tests/Checks Run:
- <exact command>: <result>

Edge Cases Found:
- <case or none>

Privacy/Security Concerns:
- <concern or none>

Package/Provenance Concerns:
- <concern or none>

UI/Product-Language Concerns:
- <concern or none>

Manual QA / Computer Use Needed?
- <yes/no and why>

Release Impact:
- <none/low/medium/high/blocking>

Fix Recommendations:
- <finding summary or none>

Exact Recommended Next Action:
- <approve merge, request artifacts, approve a specific fix prompt, or block release>
```

## Fix Recommendation Format
For each finding:

```text
1. Finding
   <short title and what is wrong>

2. Severity
   blocker | high | medium | low | polish

3. Evidence
   <file lines, diff evidence, test failure, missing artifact, or reasoned path>

4. Affected files/functions
   <exact file/function/area likely involved>

5. Proposed fix
   <specific code or process approach, without applying it>

6. Tests to add/update
   <specific test file or manual QA check>

7. Risk
   Risk of fixing: <low/medium/high and why>
   Risk of not fixing: <low/medium/high and why>

8. Approval question
   Bryant, approve Codex to implement this fix?

9. Suggested implementation prompt
   Use .codex/playbooks/clawpatch-fix.md to implement <specific fix> on branch <smallest-safe-branch>. Keep the patch narrow, add/update <specific tests>, preserve Crate guardrails, run <specific checks>, and do not commit.
```

## Quality Impact
- Reduces bugs by forcing multiple passes over scope, hidden coupling, edge cases, package output, provenance, security, privacy, UX, and tests.
- Speeds Crate development by turning review findings into concrete fix prompts Bryant can approve immediately.
- Keeps important PRs from landing with vague unresolved risk.
- Preserves velocity by keeping Standard mode lightweight while reserving Deep and Release-blocker modes for higher-risk changes.
- Prevents review work from mutating code, dependencies, release state, or private artifacts without explicit approval.

## Definition Of Done
- Active mode is stated.
- Branch, base, PR, dirty state, and mergeability are reported.
- Changed files and high-risk surfaces are reviewed.
- Relevant orchestrated playbooks are named and their checks are summarized.
- Focused tests/checks are run or clearly marked as not run with a reason.
- Edge cases, hidden coupling, privacy/security, package/provenance, UI/product language, manual QA, and release impact are covered according to mode.
- Findings are ordered by severity and include concrete fix recommendations.
- No app code, tests, package files, release files, builds, tags, deploys, dependencies, or merge state are changed unless Bryant separately approves.
- Bryant receives an exact recommended next action and whether he can proceed.
