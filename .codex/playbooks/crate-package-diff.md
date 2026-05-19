# Crate Package Diff Playbook

## Purpose
Compare Crate package outputs before and after a PR so file, extraction, count, manifest, privacy, and containment changes are explicit.

Package diffs are evaluation tools. A difference is not automatically a bug; the report must separate expected changes from unexpected changes.

## When To Use
- Before merging PRs that touch package generation, parser output, embedded extraction, Figma scope, provenance manifests, watcher filters, or file selection.
- After a regression report about missing, extra, duplicated, or out-of-scope package files.
- When Bryant wants before/after evidence for a PR.
- Before release readiness if recent PRs changed package output or manifest output.
- With `.codex/playbooks/crate-reprobox.md` when the active checkout should remain untouched.

## Start Prompt
Use a prompt like:

```text
Use .codex/playbooks/crate-package-diff.md to compare package outputs before and after this Crate PR. Report file counts, copied files, embedded extracts, manifest graph differences, privacy checks, containment checks, expected changes, unexpected changes, and do not delete package outputs.
```

## Inspect
- Current branch, PR base, dirty state, and changed files.
- Whether package output changes are expected by the PR.
- Fixture or project used for the package comparison.
- Before and after source revisions.
- Package output directories.
- `copiedCount`, `embeddedCount`, `totalFiles`, and `errors`.
- Copied file list.
- Embedded extracted asset list.
- Missing and extra files.
- Path normalization and case differences.
- File hashes when safe and practical.
- `crate-provenance.json` contents, warnings, graph shape, and privacy redaction.
- Package output containment: all package files remain inside the intended output folder.

## Files Codex May Read
- `AGENTS.md`
- `.codex/playbooks/*.md`
- `docs/*.md`
- approved fixture docs and synthetic fixture assets
- package output directories under `/private/tmp/crate-package-diff-*`
- `crate-provenance.json` files from before and after package outputs
- `package.json` read-only, for version/script context
- changed files and tests read-only when needed for package risk context

## Files Codex May Modify
- Temporary comparison files under `/private/tmp/crate-package-diff-*`.
- Optional markdown or JSON package-diff reports under `/private/tmp/crate-package-diff-*`.
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
Capture source and diff context:

```sh
git status --short --branch
git branch --show-current
git rev-parse HEAD
git rev-parse origin/v2.4.x
git diff --name-only
git diff --stat
git diff --check
```

Prepare comparison folders:

```sh
mkdir -p /private/tmp/crate-package-diff-<id>/before
mkdir -p /private/tmp/crate-package-diff-<id>/after
mkdir -p /private/tmp/crate-package-diff-<id>/reports
```

Generate stable file inventories after package outputs exist:

```sh
find /private/tmp/crate-package-diff-<id>/before -type f | sort > /private/tmp/crate-package-diff-<id>/reports/before-files.txt
find /private/tmp/crate-package-diff-<id>/after -type f | sort > /private/tmp/crate-package-diff-<id>/reports/after-files.txt
diff -u /private/tmp/crate-package-diff-<id>/reports/before-files.txt /private/tmp/crate-package-diff-<id>/reports/after-files.txt
```

Compare hashes when files are synthetic, non-private, and reasonably small:

```sh
shasum -a 256 /private/tmp/crate-package-diff-<id>/before/**/* > /private/tmp/crate-package-diff-<id>/reports/before-sha256.txt
shasum -a 256 /private/tmp/crate-package-diff-<id>/after/**/* > /private/tmp/crate-package-diff-<id>/reports/after-sha256.txt
diff -u /private/tmp/crate-package-diff-<id>/reports/before-sha256.txt /private/tmp/crate-package-diff-<id>/reports/after-sha256.txt
```

Summarize package manifests:

```sh
node -e "const fs=require('fs'); for (const p of process.argv.slice(1)) { const m=JSON.parse(fs.readFileSync(p,'utf8')); console.log(JSON.stringify({file:p,copiedCount:m.copiedCount,embeddedCount:m.embeddedCount,totalFiles:m.totalFiles,errors:m.errors||[],nodes:(m.nodes||[]).length,edges:(m.edges||[]).length,warnings:m.warnings||[]}, null, 2)); }" <before-manifest> <after-manifest>
```

Check manifest privacy and containment:

```sh
rg -n "token|secret|credential|cdn\\.figma|SHOULD_NOT_APPEAR|/usr/sbin/lsof|rawTrackedFiles|Authorization|Bearer" /private/tmp/crate-package-diff-<id>/before /private/tmp/crate-package-diff-<id>/after
node -e "const path=require('path'); const root=path.resolve(process.argv[1]); for (const p of process.argv.slice(2)) { const resolved=path.resolve(p); if (!resolved.startsWith(root + path.sep)) { console.error('outside root', p); process.exitCode=1; } }" /private/tmp/crate-package-diff-<id>/after $(find /private/tmp/crate-package-diff-<id>/after -type f)
```

## Required Checks
- File count comparison.
- Copied file list comparison.
- Embedded extracted asset comparison.
- Missing and extra file detection.
- `crate-provenance.json` comparison.
- Package count comparison:
  - `copiedCount`
  - `embeddedCount`
  - `totalFiles`
  - `errors`
- Path normalization review.
- Hash comparison when safe/practical.
- Manifest privacy redaction check.
- Package output containment check.
- Expected versus unexpected diff classification.

## Approval Gates
Codex may inspect existing package outputs and write temporary reports under `/private/tmp`. Bryant must explicitly approve any command that creates new package outputs from the app, uses private project files, deletes package outputs, mutates repo files, or changes remote/release state.

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
rm -rf /private/tmp/crate-package-diff-<id>
```

## Must Never Do
- Do not treat every diff as a bug automatically.
- Do not delete package outputs unless Bryant explicitly approves cleanup.
- Do not modify package contents unless Bryant explicitly approves.
- Do not ignore privacy-sensitive paths, secrets, signed URLs, tokens, credentials, or raw command output.
- Do not claim a package diff is safe without explaining expected versus unexpected changes.
- Do not edit app code, tests, package files, release files, or active local cleanup tasks.
- Do not build, release, deploy, notarize, tag, merge, or mutate dependencies.

## Quality Impact
- Catches missing, extra, duplicated, and out-of-scope package files before merge.
- Makes package count changes visible instead of relying on visual folder inspection.
- Validates `crate-provenance.json` graph and privacy behavior alongside package content.
- Speeds review by producing a before/after artifact Bryant can rerun or inspect.
- Reduces false alarms by classifying expected and unexpected diffs explicitly.

## Definition Of Done
- Before and after source revisions are identified.
- Fixture or project input is documented.
- Package output roots are recorded.
- File lists, counts, manifest summaries, privacy checks, and containment checks are reported.
- Expected and unexpected differences are separated.
- No repo app code, tests, package files, release files, builds, tags, deploys, or dependencies are changed.
- Bryant receives residual risks and whether the diff supports merge readiness.

## Report Format
- Branch, PR, base branch, and dirty state.
- Before ref and after ref.
- Fixture or project used.
- Package output paths.
- File count and copied-file diff.
- Embedded extracted asset diff.
- Package count diff: `copiedCount`, `embeddedCount`, `totalFiles`, `errors`.
- Manifest graph diff.
- Privacy and containment results.
- Expected changes.
- Unexpected changes and risks.
- Commands run and report files written.
- Whether Bryant can proceed.
