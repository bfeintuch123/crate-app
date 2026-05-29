# Crate Provenance Review Playbook

## Purpose
Review Crate provenance changes for evidence quality, confidence correctness, privacy safety, manifest shape, and no unintended product-behavior changes.

This playbook is for the layered provenance architecture now landing across Crate PRs. It keeps review focused on whether provenance explains existing behavior correctly, not whether Crate should capture new product surfaces.

## When To Use
- For any PR that adds or changes provenance helpers, nodes, edges, observations, evidence, or manifests.
- For parser, package, pending accept/reject, PSD, or Figma provenance PRs.
- Before merging a provenance PR into `v2.4.x`.
- When a regression report mentions optional `Crate Diagnostics/crate-provenance.json`, missing edges, overconfident edges, privacy leakage, or package output explanation.
- After stacked provenance PRs have merged and Bryant wants a consistency pass.

## Start Prompt
Use a prompt like:

```text
Use .codex/playbooks/crate-provenance-review.md to review this Crate provenance change. Check evidence, confidence, privacy, manifest shape, dual-write safety, and package/Figma guardrails. Do not change app behavior.
```

## Inspect
- Current branch and PR base. Provenance PRs should target `v2.4.x` unless Bryant says otherwise.
- The changed files and whether they overlap active Figma provenance work.
- The architecture spec in `docs/v2.8-provenance-architecture.md`.
- Whether `project.files` behavior remains preserved.
- Whether provenance records are dual-written beside existing state rather than replacing existing behavior.
- Whether new edges map to the documented edge types and confidence model.
- Whether package-time edges are confirmed only when Crate performed the copy or extraction. Treat `package_writes_manifest` as reserved/out-of-scope for v2.8.0 diagnostic exports unless a future implementation explicitly emits it.
- Whether heuristic evidence remains `candidate` or `weak` unless structured evidence supports more confidence.
- Whether evidence payloads are compact, privacy-filtered, and free of raw command output, raw Figma API responses, tokens, credentials, or unrelated open-file state.
- Whether manifest output tolerates missing provenance and partial data.
- Whether Figma guardrails remain intact:
  - per-project Figma links
  - Current Page Only default
  - Entire File opt-in
  - fail-closed page lock behavior
  - package-time scope enforcement
  - multi-app capture behavior

## Files Codex May Read
- `AGENTS.md`
- `.codex/playbooks/*.md`
- `docs/v2.8-provenance-architecture.md`
- changed files in the PR or working tree
- `tests/provenance.test.js`
- `tests/provenance-dual-write.test.js`
- `tests/psd-embedded-safety.test.js`
- `tests/figma-scope.test.js`
- `tests/figma-link-per-project.test.js`
- `package.json` read-only, for command context
- PR metadata and diffs through `gh`

## Files Codex May Modify
- None by default.
- If Bryant explicitly asks for provenance review documentation updates, Codex may modify only `.codex/playbooks/*.md` or `docs/*.md`.

## Files Codex Must Not Modify
- `main.js`
- `tests/`
- `package.json`
- `package-lock.json`
- release artifacts
- active Figma provenance PR work unless Bryant explicitly scopes it

## Commands Codex May Run
Start with scope and PR checks:

```sh
git status --short --branch
git branch --show-current
git diff --name-only
git diff --stat
git diff -- docs/v2.8-provenance-architecture.md .codex/playbooks
git diff -- main.js tests package.json package-lock.json
gh pr view <pr> --json baseRefName,headRefName,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup
gh pr diff <pr> --name-only
gh pr diff <pr>
```

Search for provenance semantics and privacy-sensitive payloads:

```sh
rg -n "provenance|crate-provenance|session_observed_file|app_opened_file|container_references_file|container_embeds_resource|resource_materialized_as_file|file_derived_from_resource|file_possible_source_for_resource|package_includes_file|package_extracts_resource|package_writes_manifest" main.js tests docs .codex
rg -n "confidence|confirmed|likely|candidate|weak|evidence|observer|dedupeKey|raw|token|secret|credential|figma|lsof|mdls|AppleScript" main.js tests docs .codex
```

Run focused tests based on touched surfaces:

```sh
node --check main.js
node tests/provenance.test.js
node tests/provenance-dual-write.test.js
node tests/psd-embedded-safety.test.js
node tests/figma-scope.test.js
node tests/figma-link-per-project.test.js
```

## Review Checks
- Edge validity: every edge uses a documented relationship or the PR updates the architecture spec first.
- Evidence traceability: every derived edge has evidence that explains why it exists.
- Confidence discipline: parser, package copy, package extraction, user accept, and Figma asset download can be confirmed when direct; lsof, Spotlight, basename, timing, and app-level evidence stay lower confidence.
- Dedupe stability: observations and edges should not multiply across repeated watches or package runs.
- Dual-write safety: provenance writes must not change `project.files`, package selection, pending-file decisions, or existing UI behavior unless Bryant explicitly scoped that change.
- Manifest safety: optional `Crate Diagnostics/crate-provenance.json` must tolerate missing data, use compact evidence, and avoid secrets or raw local system state.
- Figma safety: Figma provenance must not widen capture scope or weaken page lock fail-closed behavior.
- Package safety: package provenance must describe copied or extracted output without changing which files are packaged.

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
- Do not invent provenance relationships without evidence.
- Do not promote heuristic app, lsof, Spotlight, basename, or timing evidence to confirmed.
- Do not store raw Figma API responses, raw shell output, raw lsof/mdls/ps output, tokens, credentials, cookies, or unrelated local file state in provenance.
- Do not replace `project.files` as the current UI/package ledger during a review.
- Do not change package selection, Figma scope, watcher behavior, parser behavior, or product behavior as part of review.
- Do not edit active provenance PR code during a docs/process-only review.
- Do not build, release, notarize, tag, deploy, merge, or mutate dependencies.

## Quality Impact
- Prevents provenance from becoming an unreviewable append-only log.
- Keeps confidence bands honest and evidence-backed.
- Protects privacy while still making package output explainable.
- Catches cases where provenance accidentally changes capture or packaging behavior.
- Gives Bryant a repeatable checklist for each layer of the provenance architecture.

## Definition Of Done
- Branch and PR base are reported.
- Changed provenance surfaces are identified.
- Evidence, confidence, dedupe, privacy, manifest, Figma, and package checks are covered.
- Relevant tests were run or a test gap was explained.
- No product behavior, app code, tests, package files, release files, tags, deploys, or dependencies were changed.
- Bryant receives findings, residual risks, and whether the provenance change is ready for normal PR review.

## Report Format
- Branch, PR, base branch, and dirty state.
- Provenance surfaces reviewed.
- Findings ordered by severity with file references.
- Evidence/confidence/privacy/manifest/Figma/package checklist result.
- Commands run and results.
- Test gaps and residual risks.
- Whether Bryant can proceed.
