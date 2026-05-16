# Security Audit Playbook

## Purpose
Review Crate changes for security risks involving shell execution, path traversal, token exposure, overbroad scanning, unsafe watcher/parser input handling, and release credential leakage.

## When To Use
- Before merging code that touches watchers, parsers, package generation, file IO, shell commands, release scripts, or credential handling.
- Before a release when security-sensitive areas changed.
- When Bryant asks for an audit of a PR, branch, or suspect behavior.

## Start Prompt
Use a prompt like:

```text
Use .codex/playbooks/security-audit.md to audit this Crate change for shell, path, credential, watcher, parser, package, dependency, and release-script risks. Report findings by severity and do not mutate dependencies.
```

## Inspect
- Shell execution paths and whether arguments are structured, quoted, and constrained.
- User-controlled paths, archive extraction paths, and output paths for traversal or overwrite risk.
- Token, key, cookie, credential, and notarization handling.
- File scanning scope and whether watchers can traverse outside intended project roots.
- Untrusted input in watchers, parsers, package metadata, dragged assets, and generated files.
- Logs for accidental secret output.
- Release scripts and site updates for credential leakage or artifact mixups.
- Dependency changes that introduce new scripts, postinstall behavior, or broad filesystem access.

## Commands Codex May Run
```sh
git status --short --branch
git diff --name-only
git diff
rg -n "exec|spawn|execFile|shell|child_process|token|secret|password|notary|credential|process.env|fs\.|path\." .
npm test
npm run test
npm audit --audit-level=high
```

Prefer targeted searches and tests. Do not print secret values; confirm only whether secret references exist and how they are handled.

## Commands Requiring Explicit Bryant Approval
```sh
npm install
npm audit fix
git commit
git push
npx electron-builder --mac --arm64
xcrun notarytool submit <dmg> --wait
npx wrangler pages deploy <directory>
```

Any dependency mutation, release build, signing/notarization, deploy, commit, or push requires explicit Bryant approval.

## Definition Of Done
- Reviewed all security-sensitive changed files.
- Checked unsafe shell execution and command argument handling.
- Checked path traversal and overwrite boundaries.
- Checked token and credential handling without exposing secrets.
- Checked watcher/parser scope and untrusted input handling.
- Ran relevant tests or reported why they were not run.
- Reported findings by severity with file references.
- Summarized residual risk and whether Bryant can proceed.

## Report Format
- Scope audited and changed files reviewed.
- Findings ordered by severity with file references.
- Security-sensitive commands, paths, inputs, credentials, and dependencies checked.
- Tests or checks run, including exact commands.
- Residual risks, false-positive assumptions, and whether Bryant can proceed.

## Risk Checklist
- `child_process.exec` uses interpolated untrusted input.
- File paths are joined without root containment checks.
- Watchers scan home directories, system directories, or unrelated project roots.
- Parser input can write outside package output.
- Package generation follows symlinks unexpectedly.
- Tokens, API keys, Apple credentials, or release credentials are logged or committed.
- Dependency scripts run unexpectedly during install or build.
- Security fixes broaden behavior without tests.
