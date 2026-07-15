# Taskflow: User-Data Security Hardening Program

## Metadata

- created: 2026-07-14
- updated: 2026-07-14
- owner: source-of-truth Codex task
- standing order: SO-002
- repo: crate-app
- branch: `codex/security-electron-boundary`
- base: `v2.4.x`
- mode: implementation and validation; no release, deploy, dependency mutation, push, PR, or merge without the applicable approval gate
- status: phases 1, 2A, and 2B merged; Phase 2B post-merge Mac mini QA passed; Phase 3 Electron-boundary implementation and validation complete; Bryant approved commit, push, PR creation, and merge if final merge readiness remains clean

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

- phase: 3, Electron boundary
- IPC target: every privileged main-process handler accepts calls only from Crate's local renderer entry document in its top frame
- window target: keep Node integration disabled, preserve context isolation, explicitly enable Chromium renderer sandboxing and web security, and disallow insecure mixed content
- navigation target: allow Crate's own local entry document, including its existing fragment navigation, while denying other navigation, redirects, and child-window creation
- lifecycle target: preserve the recovered visible-window behavior, activation, hidden-window recreation, and single-window app model
- package-engine impact: none
- Figma scope impact: none; Current Page Only remains default and Entire File remains opt-in
- normal user-workflow impact: none expected; existing renderer APIs and visible controls are unchanged
- deferred observation: Quick Package drag-and-drop still reads Electron's removed `File.path` property; route that pre-existing issue through a separate bug-fix slice rather than broadening this security PR

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
- [x] Bryant approval and merge of phase 2B PR #131
- [x] phase 2B post-merge deterministic and Mac mini installed-app validation
- [x] phase 3 read-only Electron boundary inventory and failure-first tests
- [x] phase 3 implementation and focused workflow validation
- [x] phase 3 autoreview, regression, security, provenance, runner, and isolated Reprobox validation
- [x] Bryant approval for phase 3 commit, push, and PR creation

## Stop Gates

- Stop if a patch requires package-engine, watcher, parser-result, provenance, Figma-scope, quota, or UI behavior changes.
- Stop before dependency changes, builds, signing, notarization, release mutation, site deployment, or updater implementation without separate approval.
- Stop if an existing connected Figma user would need to repeat normal setup after the credential-storage phase.
- Do not update an external tester's installed build until the replacement passes installed-app QA.

## Next Action

Commit and push Phase 3, open its PR against `v2.4.x`, run final merge readiness, and merge only if every gate remains clean under Bryant's explicit authorization. Then stop before any signed build, notarization, release mutation, site deployment, or Phase 4 implementation and discuss Phase 4 plus the deferred Electron 39 Quick Package drag-and-drop issue.

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
- PR #131 merged into `v2.4.x` as `29aa8646a51e5e241326cef420ed450465bd33b4`
- fresh post-merge deterministic suite passed 255 tests with zero failures
- contained non-release app content matched the merged source tree and passed packaged-content verification
- Mac mini validation passed automatic encrypted credential migration, legacy URL minimization, link editing and explicit scope controls, privacy-safe error rendering, restart recovery, and zero raw marker leakage under a synthetic isolated profile

## Phase 3 Evidence

- all 30 privileged main-process IPC channels use one trusted registration boundary that requires Crate's current live main window, exact owning web contents, top frame, and canonical local renderer document
- stale, destroyed, detached, replaced, and secondary-window senders fail closed; window recreation can adopt only a window identity previously created and marked by Crate
- canonical renderer fragments remain supported, while populated or bare queries, sibling files, remote origins, protocol changes, redirects, navigation away, and child-window creation are rejected
- BrowserWindow preferences explicitly keep Node integration off, context isolation on, Chromium renderer sandboxing on, web security on, and insecure mixed content off
- deterministic full suite passed 255 tests with zero failures; syntax and whitespace checks passed
- isolated Reprobox applied the complete patch to exact base `29aa8646a51e5e241326cef420ed450465bd33b4` and passed 165 focused tests with zero failures, plus syntax and whitespace checks
- a contained unsigned QA app passed packaged-content verification; its packed `main.js` SHA-256 matched the reviewed worktree and its renderer helper ran with Chromium sandboxing enabled
- Mac mini Computer Use validation passed visible Projects launch, sidebar and workspace navigation, Settings and Help rendering, Start Project dialog IPC, close-to-zero-window activation recovery, force-quit relaunch recovery, and privacy-safe synthetic Figma connection rendering
- the contained app used a synthetic Figma token, isolated Chromium profile, and mock Keychain because temporary-HOME unsigned QA initially triggered a macOS test-harness Keychain prompt; no real credential, Keychain item, Crate config, or installed app was read or changed
- independent functional and adversarial reviews found no P0, P1, P2, or actionable P3 issue after the sender-window, existing-window-adoption, and bare-query bypasses were closed
- `npm audit --audit-level=high` exited successfully with only the pre-existing moderate `uuid` advisory; dependencies and lockfiles were not changed
- package selection, watcher behavior, parser results, provenance relationships, Figma scope, quota, renderer UI, preload API shape, and release state were not changed
- no signed build, signing, notarization, release mutation, tag, GitHub release, site deployment, or external tester update occurred
