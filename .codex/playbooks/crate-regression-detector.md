# Crate Regression Detector Playbook

## Purpose
Run a fail-fast, Crate-specific regression sweep for a branch, PR, or working tree without changing product behavior.

This playbook borrows the useful process ideas from OpenClaw-style engineering loops: scope first, cheap checks first, focused lanes before broad lanes, and reproducible command output. It does not import OpenClaw product behavior, broad agent concurrency, or unrelated infrastructure.

## When To Use
- Before Bryant reviews or merges a Crate PR.
- After a focused bug fix, especially near watcher, parser, package, Figma, or provenance code.
- After multiple provenance PRs have stacked and Bryant wants a regression pass.
- When a bug report could be caused by a recent workflow or provenance change.
- Before starting release readiness checks, but not as a release playbook.

## Start Prompt
Use a prompt like:

```text
Use .codex/playbooks/crate-regression-detector.md to run a docs-safe regression pass on this Crate branch. Confirm branch and dirty state, map the diff to focused checks, preserve Crate guardrails, and do not modify app code.
```

## Inspect
- Current branch, base branch, and whether the branch should target `v2.4.x`.
- Working tree state and pre-existing user edits.
- Changed files in the branch and uncommitted diff.
- Whether changes touch high-risk Crate surfaces:
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
- Whether the change affects Figma scope, watcher scope, package filtering, parser output, pending accept/reject behavior, or provenance manifest output.
- Whether the change is docs-only and can stay out of app test lanes.

## Files Codex May Read
- `AGENTS.md`
- `.codex/playbooks/*.md`
- `docs/*.md`
- `README.md`
- `package.json` and `package-lock.json` read-only, for script and dependency context.
- Changed app and test files needed to understand the regression surface.
- Existing PR metadata and diffs through `gh pr view` or `gh pr diff`.

## Files Codex May Modify
- None by default.
- If Bryant explicitly asks for process-doc updates, Codex may modify only `.codex/playbooks/*.md` or `docs/*.md`.

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
- `crate-site/` unless Bryant explicitly scopes site documentation work

## Commands Codex May Run
Start with read-only scope checks:

```sh
git status --short --branch
git branch --show-current
git diff --name-only
git diff --stat
git diff --check
git diff -- .codex docs README.md AGENTS.md
git diff -- main.js preload.js renderer parsers scripts tests package.json package-lock.json
```

Use PR checks when a PR exists:

```sh
gh pr view <pr> --json baseRefName,headRefName,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup
gh pr diff <pr> --name-only
gh pr diff <pr>
```

Use targeted searches to map risk:

```sh
rg -n "Figma|figma|Current Page|Entire File|pageLock|scopeMode|provenance|crate-provenance|session_observed_file|package_includes_file|package_extracts_resource|container_references_file|container_embeds_resource|resource_materialized_as_file" main.js tests docs .codex
rg -n "Photoshop|Illustrator|InDesign|watcher|chokidar|lsof|Spotlight|package|manifest|parser|pending" main.js tests docs .codex
```

Run focused checks based on touched areas. This repo currently uses direct Node test files rather than an `npm test` script:

```sh
node --check main.js
node tests/provenance.test.js
node tests/provenance-dual-write.test.js
node tests/psd-embedded-safety.test.js
node tests/figma-scope.test.js
node tests/figma-link-per-project.test.js
```

## Check Selection
- Docs-only or playbook-only: run `git diff --check` and read the changed docs. Do not run app tests unless the docs claim behavior that needs verification.
- Provenance helpers or model layer: run `node tests/provenance.test.js` and `node tests/provenance-dual-write.test.js`.
- Package provenance or manifest output: run `node tests/provenance.test.js`, `node tests/provenance-dual-write.test.js`, and any focused package/provenance test added later.
- PSD parser provenance: run `node tests/psd-embedded-safety.test.js` plus provenance tests.
- Figma scope or Figma provenance: run `node tests/figma-scope.test.js`, `node tests/figma-link-per-project.test.js`, and provenance tests.
- Package, watcher, or parser changes outside Figma: inspect the diff for unrelated app behavior and run the narrowest matching focused test.
- `package.json` or `package-lock.json`: stop and call out dependency risk unless Bryant explicitly scoped dependency work.

## Commands Requiring Explicit Bryant Approval
```sh
npm install
npm ci
npm audit fix
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
npx wrangler pages deploy <directory>
```

## Must Never Do
- Do not change app behavior during a regression detection pass.
- Do not edit `main.js`, tests, package files, release assets, or active provenance PR code.
- Do not broaden Photoshop, Illustrator, InDesign, generic watcher, package filtering, or Figma parser behavior unless Bryant explicitly scopes that work.
- Do not turn a detector run into a release, build, deploy, notarization, tag, merge, or dependency-update task.
- Do not run broad tests as a substitute for inspecting the changed files.
- Do not ignore pre-existing dirty files.

## Quality Impact
- Catches regressions by mapping changed files to the smallest high-signal checks.
- Keeps cheap syntax, diff, and guardrail checks ahead of slower workflows.
- Makes docs-only changes cheap and safe instead of accidentally entering app-code lanes.
- Preserves Crate's product guardrails while making review output more reproducible.
- Produces a command log Bryant can compare across repeated reviews.

## Definition Of Done
- Branch, base, and dirty state are reported.
- Changed files are grouped by risk surface.
- Focused commands were run or a test gap was explained.
- Figma, watcher, parser, package, and provenance guardrails were explicitly considered when relevant.
- No app code, tests, package files, release files, build artifacts, tags, deploys, or merges were changed.
- Bryant receives exact commands run, important outputs, residual risks, and whether he can proceed.

## Report Format
- Branch and starting working tree state.
- Changed files grouped by risk surface.
- Commands run, with pass/fail summaries.
- Guardrails checked and any gaps.
- Residual risks and recommended next action.
- Whether Bryant can proceed.
