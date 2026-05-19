# Crate Provenance Snapshot Playbook

## Purpose
Snapshot and compare Crate provenance graph output across PRs so provenance regressions are visible before merge or release.

Provenance snapshots are regression tools. They do not prove product truth by themselves, and partial manifests are expected while Crate's provenance architecture is still layered and incremental.

## When To Use
- Before merging PRs that touch provenance helpers, package manifests, parser relationships, pending decisions, Figma asset provenance, PSD provenance, or package provenance.
- When a package diff shows unexpected manifest changes.
- When Bryant wants a graph-level before/after summary instead of raw JSON.
- Before release readiness if recent PRs changed provenance or package output.
- With `.codex/playbooks/crate-benchmark-fixtures.md` when fixtures define expected graph shapes.

## Start Prompt
Use a prompt like:

```text
Use .codex/playbooks/crate-provenance-snapshot.md to snapshot and compare Crate provenance graph output for this PR. Summarize nodes, edges, evidence, confidence bands, warnings, privacy redaction, expected partial-manifest limitations, and do not overclaim provenance certainty.
```

## Inspect
- Current branch, PR base, dirty state, and changed files.
- Source fixture or package output used for the snapshot.
- Before and after `crate-provenance.json` files.
- Nodes by type.
- Edges by relation type.
- Evidence by kind and observer.
- Confidence bands:
  - `confirmed`
  - `likely`
  - `candidate`
  - `weak`
- Warnings and omitted graph explanations.
- Privacy redaction and whether raw sensitive data appears.
- Expected partial-manifest limitations.
- Whether absent edges are expected because their source files or resources are out of scope.

## Edge Types To Track
Snapshot reports should explicitly count and compare:

- `package_includes_file`
- `package_extracts_resource`
- `container_references_file`
- `container_embeds_resource`
- `resource_materialized_as_file`
- `pending_file_rejected`

If a graph includes additional edge types, report them separately and explain whether they are expected.

## Files Codex May Read
- `AGENTS.md`
- `.codex/playbooks/*.md`
- `docs/*.md`
- approved fixture docs and synthetic fixture assets
- package output directories under `/private/tmp`
- `crate-provenance.json` files from before and after package outputs
- changed files and tests read-only when needed for provenance risk context
- `package.json` read-only, for version/script context

## Files Codex May Modify
- Temporary snapshot files under `/private/tmp/crate-provenance-snapshot-*`.
- Optional markdown or JSON snapshot reports under `/private/tmp/crate-provenance-snapshot-*`.
- With Bryant's explicit approval for process docs, `.codex/playbooks/*.md`, `docs/*.md`, or `.codex/fixtures/**/*.md`.

## Files Codex Must Not Modify
- `main.js`
- `preload.js`
- `renderer/`
- `parsers/`
- `scripts/`
- `tests/`
- `package.json`
- `package-lock.json`
- committed package outputs
- release artifacts
- `crate-site/`

## Commands Codex May Run
Capture source context:

```sh
git status --short --branch
git branch --show-current
git rev-parse HEAD
git rev-parse origin/v2.4.x
git diff --name-only
git diff --stat
git diff --check
```

Prepare snapshot report directories:

```sh
mkdir -p /private/tmp/crate-provenance-snapshot-<id>/before
mkdir -p /private/tmp/crate-provenance-snapshot-<id>/after
mkdir -p /private/tmp/crate-provenance-snapshot-<id>/reports
```

Summarize manifests:

```sh
node -e "const fs=require('fs'); for (const p of process.argv.slice(1)) { const m=JSON.parse(fs.readFileSync(p,'utf8')); const nodes=m.nodes||[]; const edges=m.edges||[]; const evidence=m.evidence||[]; const count=(items,key)=>items.reduce((a,x)=>{const k=x&&x[key]||'unknown'; a[k]=(a[k]||0)+1; return a;},{}); console.log(JSON.stringify({file:p,nodesByType:count(nodes,'type'),edgesByType:count(edges,'relationType'),evidenceByKind:count(evidence,'kind'),confidenceBands:edges.reduce((a,e)=>{const k=e&&e.confidence&&e.confidence.band||'unknown'; a[k]=(a[k]||0)+1; return a;},{}),warnings:m.warnings||[]}, null, 2)); }" <before-manifest> <after-manifest>
```

Extract stable edge summaries:

```sh
node -e "const fs=require('fs'); const p=process.argv[1]; const m=JSON.parse(fs.readFileSync(p,'utf8')); for (const e of (m.edges||[])) console.log([e.relationType,e.subjectNodeId,e.objectNodeId,e.confidence&&e.confidence.band].join('\\t'));" <manifest> | sort
```

Check privacy redaction:

```sh
rg -n "token|secret|credential|cdn\\.figma|SHOULD_NOT_APPEAR|/usr/sbin/lsof|rawTrackedFiles|Authorization|Bearer|cookie|notary" <before-manifest> <after-manifest>
```

Compare normalized snapshot summaries:

```sh
diff -u /private/tmp/crate-provenance-snapshot-<id>/reports/before-summary.json /private/tmp/crate-provenance-snapshot-<id>/reports/after-summary.json
diff -u /private/tmp/crate-provenance-snapshot-<id>/reports/before-edges.txt /private/tmp/crate-provenance-snapshot-<id>/reports/after-edges.txt
```

## Required Checks
- Node counts and node types.
- Edge counts and relation types.
- Evidence count and observer kinds.
- Confidence band distribution.
- Warnings and omitted graph explanations.
- `package_includes_file` edges.
- `package_extracts_resource` edges.
- `container_references_file` edges.
- `container_embeds_resource` edges.
- `resource_materialized_as_file` edges.
- `pending_file_rejected` evidence or edge representation, as implemented.
- Privacy redaction.
- Partial-manifest limitations.
- Expected versus unexpected graph diffs.

## Snapshot Interpretation Rules
- Partial manifests are expected.
- Absence of an edge may be normal if the source file, embedded resource, Figma asset, pending file, or package output is out of scope.
- Do not overclaim provenance certainty.
- Confirmed, likely, candidate, and weak evidence must remain distinct.
- Package output edges are confirmed only when Crate performed the copy, extraction, or manifest write.
- Figma materialization is confirmed only when download and file ledger add succeeded.
- lsof, Spotlight, basename, timing, or app-level observations should not become confirmed relationships without stronger evidence.
- Snapshot differences should be classified as expected, suspicious, or blocking.

## Approval Gates
Codex may inspect existing manifests and write temporary reports under `/private/tmp`. Bryant must explicitly approve commands that create package outputs, use private project files, mutate repo files, change remote state, or clean up generated snapshots.

Commands requiring explicit Bryant approval:

```sh
npm start
git checkout <ref>
git worktree add <path> <ref>
git add <files>
git commit
git push
gh pr merge <pr>
npm install
npm ci
npm audit fix
npx electron-builder --mac --arm64
xcrun notarytool submit <artifact> --wait
xcrun stapler staple <artifact>
xcrun stapler validate <artifact>
npx wrangler pages deploy <directory>
rm -rf /private/tmp/crate-provenance-snapshot-<id>
```

## Must Never Do
- Do not edit app code, tests, package files, release files, or active local cleanup tasks.
- Do not treat a missing edge as a bug without checking fixture scope and partial-manifest expectations.
- Do not promote likely, candidate, or weak evidence to confirmed in the report.
- Do not expose secrets, tokens, signed CDN URLs, raw API responses, raw command output, cookies, credentials, or private project paths.
- Do not delete snapshot or package outputs unless Bryant explicitly approves cleanup.
- Do not build, release, deploy, notarize, tag, merge, or mutate dependencies.

## Quality Impact
- Makes provenance regressions visible as graph diffs rather than opaque JSON changes.
- Prevents confidence-band drift and accidental overclaiming.
- Validates privacy redaction alongside graph correctness.
- Speeds review by summarizing nodes, edges, evidence, warnings, and expected partial gaps.
- Pairs with benchmark fixtures and package diffs to make package/provenance behavior repeatable.

## Definition Of Done
- Before and after manifest sources are identified.
- Nodes, edges, evidence, confidence bands, warnings, privacy checks, and partial limitations are summarized.
- Expected and unexpected graph changes are separated.
- No repo app code, tests, package files, release files, builds, tags, deploys, or dependencies are changed.
- Bryant receives residual risks and whether the snapshot supports merge readiness.

## Report Format
- Branch, PR, base branch, and dirty state.
- Before ref and after ref.
- Fixture or package output used.
- Manifest paths.
- Node summary.
- Edge summary.
- Evidence summary.
- Confidence band summary.
- Warnings and omitted graph notes.
- Privacy redaction result.
- Expected graph changes.
- Unexpected graph changes and risks.
- Commands run and report files written.
- Whether Bryant can proceed.
