# Crate Benchmark Fixtures Playbook

## Purpose
Define repeatable Crate workflow benchmark fixtures so future changes can be evaluated against known creative workflows.

Benchmark fixtures are process infrastructure, not product UI. They exist to make Crate changes easier to evaluate against stable Figma, PSD, PowerPoint, package, and provenance expectations.

## When To Use
- Before or after PRs that touch Figma, PSD, PowerPoint, package generation, provenance, parsers, watcher filters, or manifest output.
- When Bryant wants a stable creative workflow fixture instead of one-off manual project files.
- When a regression report needs to become a reusable repro case.
- Before release readiness if recent PRs changed package output or provenance behavior.
- When deciding whether a future automated fixture harness is worth implementing.

## Start Prompt
Use a prompt like:

```text
Use .codex/playbooks/crate-benchmark-fixtures.md to define repeatable Crate benchmark fixtures for this workflow. Prefer synthetic/minimal files, document expected package contents and crate-provenance.json graph shape, and do not touch app code.
```

## Fixture Set
Define fixtures as small, documented workflows with expected inputs, package output, and provenance output.

Required fixture categories:

- Figma Current Page Only fixture:
  - one tracked Figma file URL with a locked page
  - at least one in-scope image asset
  - at least one out-of-scope image asset when possible
  - expected package includes only scoped assets
  - expected provenance includes only packaged Figma materialization graph
- Figma Entire File fixture:
  - one tracked Figma file URL in entire-file mode
  - assets from more than one page
  - expected package includes all captured Figma assets
  - expected provenance does not claim page-lock certainty
- Photoshop/PSD linked asset fixture:
  - minimal PSD or parser fixture with an external linked asset
  - expected `container_references_file` relationship
  - expected linked file copied when eligible
- PSD embedded smart object fixture:
  - minimal PSD embedded asset or parser fixture
  - expected `container_embeds_resource` and package extraction behavior
  - expected sanitized extracted asset names
- PowerPoint embedded media fixture:
  - minimal PPTX with embedded media
  - expected extracted media files
  - expected package counts and manifest behavior
- Package manifest fixture:
  - package output with `crate-provenance.json`
  - expected package node, package copy/extract edges, warnings, and redacted paths
- Cross-app workflow fixture candidates:
  - Figma asset plus Photoshop or PowerPoint usage
  - PSD linked asset plus package-time manifest
  - PowerPoint embedded media plus package diff
  - candidates should be documented before they become required benchmarks

## Expected Outputs
Each fixture definition should document:

- source fixture files or synthetic generation steps
- project type and scope settings
- manual steps, if any
- expected package folder name pattern
- expected copied file list
- expected embedded extracted asset list
- expected `copiedCount`
- expected `embeddedCount`
- expected `totalFiles`
- expected `errors`
- expected `crate-provenance.json` node types
- expected `crate-provenance.json` edge types
- expected warnings
- expected omitted data
- expected confirmed, likely, candidate, and weak evidence

## Evidence Expectations
- Confirmed evidence:
  - Crate copied a file into a package
  - Crate extracted an embedded resource
  - Crate wrote `crate-provenance.json`
  - Figma asset download succeeded and the file ledger was updated
  - parser returned structured linked or embedded metadata
- Likely evidence:
  - strong app-script or parser evidence that still has document ambiguity
  - repeated independent observations that do not prove identity
- Candidate evidence:
  - lsof, Spotlight, basename, timing, or weak source-app context
  - possible cross-app association without document-level proof
- Weak evidence:
  - stale session evidence
  - missing files
  - basename-only or out-of-scope hints

Do not overclaim fixture certainty. If the fixture cannot prove a relationship, write the expected confidence band lower.

## Files Codex May Read
- `AGENTS.md`
- `.codex/playbooks/*.md`
- `docs/*.md`
- existing fixture documentation, if present
- `tests/` read-only for current fixture-like coverage
- `parsers/` read-only for parser fixture requirements
- `package.json` and `package-lock.json` read-only, for tool context
- synthetic fixture files under approved fixture directories

## Files Codex May Modify
- None by default.
- With Bryant's explicit approval for fixture documentation, Codex may modify:
  - `.codex/playbooks/*.md`
  - `docs/*.md`
  - `.codex/fixtures/**/*.md`
  - `.codex/fixtures/**/README.md`
- With Bryant's explicit approval for synthetic fixture assets, Codex may add small synthetic files under `.codex/fixtures/`.

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
- private client files or real user project files

## Commands Codex May Run
Inspect fixture and docs state:

```sh
git status --short --branch
git branch --show-current
git diff --name-only
git diff --stat
git diff --check
rg --files .codex docs tests | rg "fixture|benchmark|provenance|figma|psd|ppt|package"
rg -n "Current Page|Entire File|crate-provenance|container_references_file|container_embeds_resource|resource_materialized_as_file|package_includes_file|package_extracts_resource" .codex docs tests
```

Inspect candidate fixture files without mutating them:

```sh
find .codex/fixtures -maxdepth 4 -type f | sort
shasum -a 256 .codex/fixtures/<fixture-id>/*
node -e "const fs=require('fs'); const p='<manifest>'; const m=JSON.parse(fs.readFileSync(p,'utf8')); console.log({nodes:m.nodes?.length,edges:m.edges?.length,warnings:m.warnings?.length});"
```

Run relevant existing tests only when Bryant asks for verification:

```sh
node --test tests/figma-scope.test.js
node --test tests/figma-link-per-project.test.js
node --test tests/psd-embedded-safety.test.js
node --test tests/provenance.test.js
node --test tests/provenance-dual-write.test.js
```

## Approval Gates
Codex may inspect and draft fixture documentation without approval. Bryant must explicitly approve any command or edit that creates fixture assets, writes package outputs, uses private files, starts the app, mutates git history, or updates remote state.

Commands requiring explicit Bryant approval:

```sh
git add <fixture-docs-or-assets>
git commit
git push
npm install
npm ci
npm audit fix
npm start
gh pr merge <pr>
npx electron-builder --mac --arm64
xcrun notarytool submit <artifact> --wait
xcrun stapler staple <artifact>
xcrun stapler validate <artifact>
npx wrangler pages deploy <directory>
```

## Must Never Do
- Do not touch app code, tests, package files, release files, or active local cleanup tasks.
- Do not turn benchmark fixtures into product UI.
- Do not include real secrets, raw credentials, private client assets, production Figma tokens, signed CDN URLs, or raw API responses.
- Do not copy private user project files into the repo unless Bryant explicitly provides and approves them.
- Do not build, release, deploy, notarize, tag, merge, or mutate dependencies.
- Do not mark a fixture as authoritative when its expected evidence is only likely, candidate, or weak.

## Quality Impact
- Converts one-off creative workflow regressions into repeatable evaluation cases.
- Makes package and provenance expectations explicit before future code changes.
- Speeds review by separating fixture definition from implementation.
- Reduces accidental behavior drift across Figma, PSD, PowerPoint, package, and manifest workflows.
- Keeps private client material out of the repo by preferring synthetic/minimal fixtures.

## Definition Of Done
- Fixture purpose, source inputs, workflow steps, expected package output, expected manifest output, and confidence expectations are documented.
- Any fixture asset use is synthetic/minimal or explicitly approved by Bryant.
- Private assets, secrets, raw credentials, raw API responses, and signed CDN URLs are excluded.
- No app code, tests, package files, release files, builds, tags, deploys, or dependencies are changed.
- Bryant receives a clear list of fixture gaps and next candidates.

## Report Format
- Branch and dirty state.
- Fixture definitions added or reviewed.
- Expected package contents.
- Expected `crate-provenance.json` contents.
- Evidence bands: confirmed, likely, candidate, weak.
- Commands run and results.
- Files changed.
- Fixture gaps and risks.
- Whether Bryant can proceed.
