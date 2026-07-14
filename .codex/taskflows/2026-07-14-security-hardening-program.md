# Taskflow: User-Data Security Hardening Program

## Metadata

- created: 2026-07-14
- updated: 2026-07-14
- owner: source-of-truth Codex task
- standing order: SO-002
- repo: crate-app
- branch: `codex/security-figma-link-privacy`
- base: `v2.4.x`
- mode: implementation and validation; no release, deploy, dependency mutation, push, PR, or merge without the applicable approval gate
- status: phase 1 and phase 2A merged; phase 2A Mac mini QA passed; phase 2B PR #130 is open and merge-readiness is clean; merge approval pending

## Goal

Strengthen protection of users' project files, Figma credentials, local metadata, and Macs without changing Crate's feature model, package behavior, Figma scope, or user workflow.

## Security Sequence

1. Build containment: explicit runtime allowlist and packaged-content verification.
2. Figma credential storage: automatic Keychain-backed migration with no normal user steps.
3. Figma link privacy: store only the minimal locator needed for API and scope behavior, migrate legacy URLs automatically, and redact identifiers from logs and diagnostics.
4. Electron boundary: trusted IPC registration, sender validation, navigation restrictions, and renderer sandboxing.
5. Parser and download limits: shared admission budgets around existing parsers and Figma downloads.
6. Local-data lifecycle: permissions, atomic config writes, cache cleanup, and diagnostics minimization.
7. Release hardening: least-privilege entitlements, Electron fuses, CI security checks, and signed-artifact proof.

Each phase must remain independently reviewable and revertible. Existing functional behavior is frozen unless the input is specifically unsafe or malicious.

## Current Phase

- phase: 2B, Figma link and identifier privacy
- storage target: parse a user-provided Figma URL once and persist only the file-key candidates and requested page or node locator required for existing Figma behavior
- legacy source: complete URLs in project or session records, migrated automatically when projects load without asking the user to reconnect
- edit behavior: blank input preserves the current link and can update scope; replacement and removal are explicit actions
- privacy behavior: logs and optional diagnostics redact complete URLs, credentials, signed-link material, file keys, page or node IDs, image refs, and related Figma identifiers
- package-engine impact: none
- Figma scope impact: none; Current Page Only remains default and Entire File remains opt-in
- normal user-workflow impact: no added setup steps; valid existing project links migrate automatically and remain connected

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
- [x] phase 2A committed, pushed, and opened as PR #129 against `v2.4.x`
- [x] Bryant approval and merge of phase 2A PR #129
- [x] phase 2A Mac mini credential migration and connection smoke
- [x] phase 2B failure-first tests and narrow implementation
- [x] phase 2B autoreview, regression, security, provenance, runner, and isolated Reprobox validation
- [x] Bryant approval for phase 2B commit, push, and PR creation

## Stop Gates

- Stop if a patch requires package-engine, watcher, parser-result, provenance, Figma-scope, quota, or UI behavior changes.
- Stop before dependency changes, builds, signing, notarization, release mutation, site deployment, or updater implementation without separate approval.
- Stop if an existing connected Figma user would need to repeat normal setup after the credential-storage phase.
- Do not update an external tester's installed build until the replacement passes installed-app QA.

## Next Action

Request Bryant approval to merge Phase 2B PR #130 into `v2.4.x`. Stop before merge, build, signing, notarization, release mutation, site deployment, or the next security phase without the applicable approval.

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

## Phase 2B Evidence

- new and replacement project links persist a minimal Figma locator rather than the complete user-provided URL
- legacy project and session URLs migrate automatically while preserving valid connections, candidate fallback, and requested page or node scope
- editing a Figma project never sends the saved URL back to the renderer; blank input preserves the link, replacement requires a new URL, and removal is explicit
- Current Page Only remains the default and fails closed when a page or node cannot be resolved; Entire File remains opt-in
- main-process, parser, and optional diagnostic output redact complete Figma and signed URLs, credentials, file keys, page and node IDs, image refs, team identifiers, and related free-text material
- dependency-complete full suite: 251 passed, 0 failed using the canonical checkout's existing dependencies through `NODE_PATH`; no dependency installation or mutation occurred
- focused Figma link, scope, privacy, renderer, app-content, PSD, package, and provenance suite: 107 passed, 0 failed
- isolated Reprobox applied the complete tracked and new-file patch to exact base `4be0d5fba8d1d22696f067da90950de1b35a85de`, then passed the same 107 tests, syntax checks, and `git diff --check`
- final failure-first coverage confirms atomic page/node locator migration, stale session-lock rejection, renderer IPC error sanitization, compound credential-field redaction including renderer-originated logs, and complete redaction of quoted private paths containing spaces
- independent functional review and final adversarial security re-review returned no findings; the security reviewer directly probed neutral compound credentials and quoted private paths containing spaces across the shared, main-process IPC, parser, and renderer boundaries
- syntax checks, `git diff --check`, frozen-file checks, patch application against the latest base, and focused privacy searches passed
- `npm audit --audit-level=high`: exit 0 with the pre-existing moderate `uuid` advisory only
- package selection, watcher scope, parser result shape, provenance relationships, quota, dependencies, lockfiles, preload behavior, and release state were not changed
- no app launch, build, signing, notarization, release, or deployment was run
- reproducibility proof remains at `/private/tmp/crate-reprobox-figma-link-privacy-finalv8.kocFfh`; earlier proof directories remain untouched
