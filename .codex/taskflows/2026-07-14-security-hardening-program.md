# Taskflow: User-Data Security Hardening Program

## Metadata

- created: 2026-07-14
- updated: 2026-07-14
- owner: source-of-truth Codex task
- standing order: SO-002
- repo: crate-app
- branch: `codex/security-figma-credentials`
- base: `v2.4.x`
- mode: implementation and validation; no release, deploy, dependency mutation, push, PR, or merge without the applicable approval gate
- status: phase 1 merged; phase 2A implementation and merge-readiness review complete; commit, push, and PR creation approved

## Goal

Strengthen protection of users' project files, Figma credentials, local metadata, and Macs without changing Crate's feature model, package behavior, Figma scope, or user workflow.

## Security Sequence

1. Build containment: explicit runtime allowlist and packaged-content verification.
2. Figma credential storage: automatic Keychain-backed migration with no normal user steps.
3. Electron boundary: trusted IPC registration, sender validation, navigation restrictions, and renderer sandboxing.
4. Parser and download limits: shared admission budgets around existing parsers and Figma downloads.
5. Local-data lifecycle: permissions, atomic config writes, cache cleanup, and diagnostics minimization.
6. Release hardening: least-privilege entitlements, Electron fuses, CI security checks, and signed-artifact proof.

Each phase must remain independently reviewable and revertible. Existing functional behavior is frozen unless the input is specifically unsafe or malicious.

## Current Phase

- phase: 2A, Figma credential storage
- credential target: Electron `safeStorage`, backed by macOS Keychain protection
- legacy source: `~/.crate/figma-token`, migrated silently only after the main window is visible
- failure behavior: fail closed without deleting the legacy credential when encryption, verification, or migration cannot complete safely
- package-engine impact: none
- Figma scope impact: none; Current Page Only remains default and Entire File remains opt-in
- normal user-workflow impact: none; valid existing connections migrate automatically and replacement credentials are verified before storage

## Deferred Pre-Public-Release Requirement

Before Crate's public release, specify and implement an in-app update or installation process so users do not need to repeatedly download and reinstall from the website.

This is deliberately outside the security patches. The later updater work must require signed update metadata and artifacts, preserve user projects and settings, support staged internal QA and rollback, fail safely if verification fails, and receive its own threat model and release-gate review.

## Checkpoints

- [x] read-only security audit and recommendation ordering
- [x] clean isolated branch from latest `origin/v2.4.x`
- [x] baseline runtime and packaged-content inventory
- [x] phase 1 implementation
- [x] focused tests and configuration validation
- [x] non-release packaged-app verification after separate build approval
- [x] autoreview, regression, security, provenance, and merge-readiness review
- [x] Bryant approval for commit, push, and PR creation
- [x] Bryant approval and merge of phase 1 PR #128
- [x] phase 2A failure-first tests and narrow implementation
- [x] phase 2A autoreview, regression, security, provenance, runner, and isolated Reprobox validation
- [x] Bryant approval for phase 2A commit, push, and PR creation

## Stop Gates

- Stop if a patch requires package-engine, watcher, parser-result, provenance, Figma-scope, quota, or UI behavior changes.
- Stop before dependency changes, builds, signing, notarization, release mutation, site deployment, or updater implementation without separate approval.
- Stop if an existing connected Figma user would need to repeat normal setup after the credential-storage phase.
- Do not update an external tester's installed build until the replacement passes installed-app QA.

## Next Action

Commit and push the reviewed phase 2A branch, then open a PR targeting `v2.4.x`. Stop before merge, build, signing, notarization, release mutation, site deployment, or the next security phase.

## Phase 1 Evidence

- explicit Electron Builder runtime allowlist added without dependency or application-code changes
- packaged-content verifier requires every Crate runtime entry and rejects all non-runtime roots
- sensitive-file deny policy applies inside both ASAR and unpacked production dependencies
- current artifact correctly fails the new policy with 556 disallowed entries
- `node --test tests/*.test.js`: 222 passed, 0 failed on the final hook-integrated patch
- an existing Illustrator process-detection test had a timing race; its test-only wait predicate now waits for the completed privacy-safe status, passed 10 focused repetitions, and passed in the final full suite
- `npm audit --audit-level=high`: exit 0 with the pre-existing moderate `uuid` advisory only
- approved non-release `dir` build completed with macOS signing and the `afterSign` notarization hook disabled
- Electron Builder explicitly skipped macOS signing; the app has no Developer ID team identifier and no notarization was attempted
- fresh artifact: 300 MiB app, 5.5 MiB ASAR, 2,857 ASAR entries, and 1,767 unpacked dependency entries
- packaged-content verification passed with only the eight expected runtime roots and zero forbidden or secret-shaped files
- isolated-profile launch created one visible Crate window and exited cleanly; no load, renderer, or crash errors were emitted
- the only launch log was Electron's existing `punycode` deprecation warning
- temporary proof artifact: `/private/tmp/crate-security-build-output-20260714/mac-arm64/Crate.app`

## Phase 2A Evidence

- new credential store encrypts the Figma credential with Electron `safeStorage` and keeps only the encrypted blob under the app's user-data directory
- the legacy plaintext credential migrates silently after visible-window startup; it is deleted only after encrypted round-trip verification and unchanged-file checks
- unavailable encryption, corrupt encrypted data, symlinked paths, changed legacy content, failed storage, and failed token verification all fail closed without exposing or overwriting the working credential
- a replacement credential is validated against Figma `/v1/me` before it replaces the stored connection
- renderer copy and errors remain nontechnical and privacy-safe; no extra normal connection step was added
- full deterministic suite: 239 passed, 0 failed with `--test-concurrency=1`
- focused credential, Figma-link, and privacy suite: 51 passed, 0 failed
- isolated Reprobox credential, Figma-link, lifecycle, and packaged-content suite: 61 passed, 0 failed
- package, provenance, watcher, parser-result, quota, dependencies, and lockfiles were not changed
- `npm audit --audit-level=high`: exit 0 with the pre-existing moderate `uuid` advisory only
- no build, signing, notarization, release, or deployment was run
