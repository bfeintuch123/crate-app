# Crate Security Scan Playbook

## Purpose
Detect security, privacy, and filesystem safety risks in Crate changes without changing app behavior.

This is the Crate-specific security lane for OpenClaw-style engineering loops: focused scope, explicit threat checks, read-only commands first, redacted reporting, and no dependency or release mutation.

## When To Use
- Before merging PRs that touch file IO, package generation, parsers, watchers, shell commands, Figma API handling, provenance, manifests, or release scripts.
- When optional `Crate Diagnostics/crate-provenance.json` diagnostic output changes.
- When a PR changes path normalization, symlink handling, copied package output, embedded asset extraction, or parser-controlled filenames.
- Before release readiness if recent PRs touched security-sensitive surfaces.
- When Bryant asks whether a change can leak tokens, private paths, raw API data, command output, or unrelated local files.

## Start Prompt
Use a prompt like:

```text
Use .codex/playbooks/crate-security-scan.md to scan this Crate PR for path traversal, package escape, symlink, token leakage, manifest privacy, unsafe shell, parser filename, and filesystem write-boundary risks. Do not modify app code.
```

## Inspect
- Current branch, PR base, dirty state, and changed files.
- File writes, copies, extraction, archive handling, package output paths, and manifest writes.
- Path joins, path normalization, realpath usage, symlink behavior, and root containment checks.
- Parser-controlled filenames and embedded resource names before they become filesystem paths.
- Any output path that could escape the package directory.
- Raw token, API response, CDN URL, command output, local path, or credential handling.
- Figma token, Figma API payload, Figma CDN URL, imageRef, file key, page ID, and downloaded asset handling.
- `Crate Diagnostics/crate-provenance.json` privacy: schema v2 includes minimized package counts, fixed error categories, allowlisted graph metadata, and randomized report-local identifiers; it omits project identity, filenames, paths, timestamps, payloads, persistent IDs, raw errors, and evidence payloads.
- Shell execution and whether arguments are structured and constrained.
- Filesystem write boundaries for temp directories, package output, extracted resources, generated manifests, and release/site files.

## Files Codex May Read
- `AGENTS.md`
- `.codex/playbooks/*.md`
- `docs/*.md`
- changed files in the PR or working tree
- `main.js`, `preload.js`, `renderer/`, `parsers/`, `scripts/`, and `crate-site/` when they are in scope
- `tests/` read-only when needed to understand security coverage
- `package.json` and `package-lock.json` read-only, for dependency and script context
- PR metadata and diffs through `gh`

## Files Codex May Modify
- None by default.
- If Bryant explicitly asks for process-doc updates, Codex may modify only `.codex/playbooks/*.md`, `docs/*.md`, or `AGENTS.md` playbook references.

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
Start with branch and diff scope:

```sh
git status --short --branch
git branch --show-current
git diff --name-only
git diff --stat
git diff --check
gh pr view <pr> --json baseRefName,headRefName,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup
gh pr diff <pr> --name-only
gh pr diff <pr>
```

Search for path, write, shell, parser, and provenance risks:

```sh
rg -n "path\\.join|path\\.resolve|realpath|normalize|relative|isAbsolute|symlink|lstat|stat|copyFile|writeFile|mkdir|rename|rm|unlink|createWriteStream|extract|archive|manifest|crate-provenance" main.js preload.js renderer parsers scripts tests docs .codex
rg -n "exec\\(|execFile|spawn\\(|shell:|child_process|osascript|lsof|mdls|ps |process\\.env|token|secret|password|credential|notary|FIGMA|figma|api|cdn|imageRef" main.js preload.js renderer parsers scripts tests docs .codex
rg -n "basename|filename|fileName|resourceKey|internalPath|entryName|relativePath|outputPath|packagePath|download|url|href" main.js preload.js renderer parsers scripts tests docs .codex
```

Use focused tests only when the scanned change needs behavioral confirmation:

```sh
node --check main.js
node tests/provenance.test.js
node tests/provenance-dual-write.test.js
node tests/psd-embedded-safety.test.js
node tests/figma-scope.test.js
node tests/figma-link-per-project.test.js
```

Use dependency audit only when dependency risk is in scope:

```sh
npm audit --audit-level=high
```

Do not print secret values. If a command shows a possible secret, redact the value in the report and describe only where and how it is handled.

## Required Checks
- Path traversal: user-controlled, parser-controlled, archive-controlled, and API-controlled path segments cannot escape intended roots.
- Package output escaping: copied files, extracted embedded resources, and optional diagnostic manifest writes remain under the package output directory.
- Symlink safety: package generation and extraction do not unexpectedly follow symlinks outside intended roots.
- Raw leakage: logs, manifests, reports, and package files do not include raw tokens, raw Figma API responses, raw command output, cookies, credentials, unrelated open files, or private system scans.
- Figma privacy: tokens are never written; API payloads and CDN URLs are minimized; file keys and page IDs are only included when needed and safe.
- Manifest minimization: `Crate Diagnostics/crate-provenance.json` omits project identity, filenames, paths, timestamps, payloads, persistent IDs, raw errors, and evidence payloads rather than attempting to preserve redacted versions.
- Shell safety: shell commands avoid interpolated untrusted input and prefer structured arguments.
- Parser filenames: filenames derived from PSD, archive, Figma, or parser metadata are sanitized before filesystem writes.
- Write boundaries: temp, package, manifest, site, and release writes are explicit and constrained.

## Approval Gates
Codex may inspect and report without approval. Bryant must explicitly approve any command that mutates dependencies, app code, release files, remote state, build artifacts, tags, or deploy state.

Commands requiring explicit Bryant approval:

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
- Do not modify app code unless Bryant separately approves a security fix.
- Do not edit tests, package files, release files, or active Figma provenance work during a scan.
- Do not run destructive commands.
- Do not build, release, deploy, notarize, tag, merge, or mutate dependencies.
- Do not expose secrets, tokens, credentials, raw API responses, private project assets, or sensitive local paths in output.
- Do not claim a risk is fixed unless a fix was actually implemented and verified in a separate approved task.

## Quality Impact
- Finds escape and leakage bugs before they become packaged output or release artifacts.
- Keeps provenance useful without turning manifests into privacy leaks.
- Protects Figma credentials, API payloads, and downloaded asset handling.
- Makes parser and package changes safer by checking filesystem boundaries explicitly.
- Speeds review by producing a repeatable, redacted security checklist instead of broad manual inspection.

## Definition Of Done
- Branch, PR base, dirty state, and changed files are reported.
- Path traversal, package escape, symlink, shell, parser filename, Figma privacy, manifest redaction, and write-boundary checks are covered.
- Relevant focused tests or audit commands were run, or the reason for not running them is stated.
- Findings are ordered by severity with file references.
- No app code, tests, package files, release files, builds, tags, deploys, or dependencies were changed.
- Bryant receives residual risks and whether the branch can proceed to normal review.

## Report Format
- Branch, PR, base branch, and dirty state.
- Changed files and security-sensitive surfaces reviewed.
- Findings by severity with file references and redacted evidence.
- Required-check checklist result.
- Commands run and important results.
- Tests or audits not run, with reason.
- Residual risks and whether Bryant can proceed.
