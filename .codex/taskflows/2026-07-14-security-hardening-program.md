# Taskflow: User-Data Security Hardening Program

## Metadata

- created: 2026-07-14
- updated: 2026-07-15
- owner: source-of-truth Codex task
- standing order: SO-002
- repo: crate-app
- branch: `codex/security-diagnostics-minimization-phase5b`
- base: `v2.4.x`
- mode: implementation and validation; no release, deploy, or dependency mutation without the applicable approval gate
- status: phases 1 through 5A are merged and the Phase 5A installed-app gate is complete; Phase 5B optional diagnostics minimization is implemented, fully reviewed, and awaiting Bryant's commit/push/PR approval

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

## Required Review Cadence

- Before any security phase or subphase is committed, pushed, or opened as a PR, run the complete Crate Fix Review Stack: bug triage, narrow-fix review, autoreview, regression detection, security scan, provenance review, runner loop, merge-readiness review, and restartable handoff evidence.
- A failing review or required check blocks commit, push, PR creation, and merge until the finding is fixed and the affected review lanes rerun.
- After the final security phase, rerun an integrated review across the combined security program: full deterministic suite, exact-base Reprobox, packaged-content verification, signed installed-app launch and recovery, privacy checks, and representative package/Figma workflows.
- Olivia remains paused until that final integrated gate passes and Bryant explicitly resumes external testing.

## Current Phase

- phase: Phase 5B optional diagnostics minimization
- security target: keep optional support diagnostics useful without exporting project identity, filenames, resource names, paths, timestamps, raw errors, payloads, credentials, URLs, Figma identifiers, or persistent graph IDs
- implementation target: emit schema v2 fixed counts and error categories plus allowlisted package-relevant graph metadata with randomized report-local identifiers; preserve the complete internal provenance graph
- workflow target: diagnostics remain off by default and under `Crate Diagnostics/crate-provenance.json`; Package Details and normal package behavior remain unchanged
- package-engine impact: no package selection, copied or extracted file, naming, output, quota, or Package Details behavior change
- Figma scope impact: Current Page Only remains default and fail closed; Entire File remains opt-in
- normal user-workflow impact: no new step, prompt, permission, setting, or credential action

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
- [x] Bryant approval and merge of phase 3 PR #132
- [x] phase 3.5 read-only root-cause confirmation
- [x] phase 3.5 failure-first tests and narrow implementation
- [x] phase 3.5 focused, regression, security, provenance, runner, isolated Reprobox, and contained Electron 39 validation
- [x] Bryant approval for phase 3.5 commit, push, and PR creation
- [x] Bryant approval and merge of phase 3.5 PR #133
- [x] phase 4A read-only parser and archive boundary inventory
- [x] phase 4A failure-first tests and narrow shared-budget implementation
- [x] phase 4A focused, full-suite, Electron-runtime, real-archive, security, provenance, runner, and isolated Reprobox validation
- [x] Bryant approval for phase 4A commit, push, PR creation, and clean merge
- [x] phase 4A PR #134 merged into `v2.4.x`
- [x] phase 4B read-only Figma API and asset-transfer inventory
- [x] phase 4B failure-first tests and narrow shared network-limit implementation
- [x] phase 4B focused, full-suite, security, provenance, runner, and isolated Reprobox validation
- [x] phase 4B adversarial review findings fixed with fail-closed package and hard operation-budget regression coverage
- [x] Bryant approval for phase 4B commit, push, PR creation, merge-readiness review, and clean merge
- [x] phase 4B PR #135 merged into `v2.4.x` as `6d07022f4ae43287da79b0db95fce5bad6f34c87`
- [x] contained installed-app build exposed missing runtime allowlist entries for `admission-budgets.js` and `figma-network.js`
- [x] failure-first runtime inventory test and narrow allowlist repair
- [x] disconnected-startup regression test proved and fixed unnecessary Keychain access
- [x] pre-review signed QA app passes packaged-content verification, source-to-ASAR hashes, clean launch, relaunch, Settings, and prompt-free disconnected Figma state
- [x] live Figma Current Page Only package validation with a one-day read-only QA credential
- [x] complete Crate Fix Review Stack and exact-base Reprobox before any commit, push, or PR request
- [x] use Bryant's one-time approval to rebuild the separately identified QA app from the frozen final source, then repeat packaged-content, signing, source-to-ASAR, and disconnected-launch checks
- [x] merge Phase 4 installed-app follow-up PR #136 into `v2.4.x`
- [x] split Phase 5 into independently reviewable Phase 5A local storage/cache lifecycle and Phase 5B optional diagnostics minimization
- [x] create clean Phase 5A branch from merged `origin/v2.4.x`
- [x] add failure-first tests for owner-only config storage, orphan and deleted-project cache cleanup, active-project preservation, symlink-root rejection, corrupt-store fail-closed behavior, and late in-flight Figma cache writes
- [x] implement narrow Phase 5A config permission and cache lifecycle changes without dependency, package, watcher, parser-result, provenance, renderer, quota, or Figma-scope changes
- [x] complete Phase 5A autoreview, regression, security, provenance, and runner checks before any commit, push, or PR
- [x] obtain Bryant approval before Phase 5A commit, push, and PR creation
- [x] merge Phase 5A PR #137 into `v2.4.x` as `2b75f38c7cc95e34117ea40c6481370569eedd6d`
- [x] complete installed-app Phase 5A validation before Phase 5B implementation
- [x] create a clean Phase 5B branch from merged `origin/v2.4.x`
- [x] add failure-first and defensive tests for schema minimization, fixed error categories, unknown and malformed graph records, and unlinkable report-local identifiers
- [x] implement schema v2 diagnostics minimization without changing internal provenance or package behavior
- [x] pass the 191-test focused lane, 330-test full suite, syntax, whitespace, diagnostic-reader compatibility, and high-severity dependency gates
- [x] complete final exact-base Reprobox
- [x] complete independent no-finding Autoreview
- [ ] obtain Bryant approval before Phase 5B commit, push, and PR creation

## Stop Gates

- Stop if a patch requires package-engine, watcher, parser-result, provenance, Figma-scope, quota, or UI behavior changes.
- Stop before any build, signing, dependency change, notarization, release mutation, site deployment, or updater implementation without separate approval. Bryant's approval for the final-source isolated QA rebuild applies only to this validation run.
- Stop if an existing connected Figma user would need to repeat normal setup after the credential-storage phase.
- Do not update an external tester's installed build or resume Olivia until the replacement and final integrated security gate pass.

## Next Action

Obtain Bryant approval before the reviewed Phase 5B commit, push, and PR creation. Stop before those actions, merge, build, signing, installed-app mutation, Phase 6, release, site deployment, updater work, or dependency change without the applicable approval. Olivia remains paused.

## Phase 5A Evidence

- PR #137 merged into `v2.4.x` as `2b75f38c7cc95e34117ea40c6481370569eedd6d`; the required post-merge installed-app gate completed before Phase 5B began
- failure-first local-data checks failed 4/4 before implementation
- five adversarial fix rounds closed startup visibility, strict store-path, corrupt-store, transient cleanup, overbroad orphan discovery, stale active-project snapshot, late-writer test gaps, intermediate-directory symlink traversal, unsafe-entry batching, and cache-directory replacement during file I/O
- fixed native startup-error copy exposes no config path or project data and requests a clean quit when local storage cannot be secured
- only recognized Crate project IDs and Crate quarantine names are eligible for startup orphan cleanup; explicit deletion still supports stored legacy IDs
- cleanup runs in bounded event-loop batches, rechecks active projects immediately before quarantine, retries transient rename and removal failures, and leaves a safe next-launch retry path if the filesystem remains unavailable
- complete Figma and presentation/provenance lifecycle lanes pass 171/171
- startup and PSD safety lane passes 21/21
- full serial source suite and fresh exact-base isolated Reprobox pass 329/329 with matching source/applied patch hashes and empty isolated cache roots afterward
- previously questioned Keynote ambiguous-mojibake case passes 10/10 isolated serial repetitions
- final security, product/regression, and test-adequacy read-only Autoreview lanes report no remaining finding; frozen-surface, syntax, whitespace, static privacy, and high-severity dependency closeout checks pass without mutation

## Phase 5B Evidence

- exact base is merged Phase 5A commit `2b75f38c7cc95e34117ea40c6481370569eedd6d`; implementation remains uncommitted on `codex/security-diagnostics-minimization-phase5b`
- optional diagnostics remain off by default and retain the existing `Crate Diagnostics/crate-provenance.json` placement
- schema v2 exports only aggregate package counts, fixed error categories, allowlisted package-relevant node/edge/evidence types, confidence bands, and fixed warnings
- project identity, filenames, resource names, local and output paths, timestamps, raw errors, payloads, credentials, URLs, Figma identifiers, and persistent graph IDs are omitted
- every export uses a fresh randomized report prefix, while malformed graph records are omitted with a fixed warning and unknown values collapse to fixed `other` or `weak` categories
- internal provenance remains complete for local app behavior; package contents, counts, naming, quota, Package Details, Quick Package, watchers, parsers, and Figma scope are unchanged
- focused diagnostics, provenance, Figma, PowerPoint, Keynote, and PSD lane passes 191/191; full serial source suite passes 330/330
- 20 legacy/schema-v2 playbook-reader cases pass without exposing raw legacy error text; syntax and `git diff --check` pass
- `npm audit --audit-level=high` exits successfully with only the pre-existing moderate `uuid` advisory; no dependency mutation occurred
- final exact-base closeout Reprobox `/private/tmp/crate-reprobox-phase5b-closeout.Himav1` applies the complete frozen tracked and untracked patch to `2b75f38c7cc95e34117ea40c6481370569eedd6d`; the final proof reports the matching source/applied patch hash and isolated suite result without changing this frozen taskflow
- initial independent Autoreview findings about deterministic local IDs, schema-v2 reader compatibility, stale privacy guidance, malformed-record coverage, the `other` category, and an inaccurate architecture example were fixed and the affected checks rerun
- a final packaged-runtime review caught the new `diagnostic-summary.js` helper missing from the Electron Builder allowlist; the helper is now explicitly included, required, permitted, and covered by packaged-content tests without dependency or lockfile mutation
- final independent security and product/regression rereviews and the post-fix 330-test full source suite report no actionable P0-P3 finding

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
- PR #132 merged into `v2.4.x` as `c6c9354b37e89ba8daea84e545530296d3f0ab9b`

## Phase 3.5 Evidence

- exact base is merged Phase 3 commit `c6c9354b37e89ba8daea84e545530296d3f0ab9b`; implementation remains uncommitted on `codex/fix-electron39-quick-package-drop`
- failure-first coverage produced four expected failures before the production patch: the preload bridge was absent and the renderer still touched the removed `File.path` property
- sandboxed preload now resolves only an operating-system-backed dropped `File` with Electron `webUtils.getPathForFile` and invokes the existing trusted `v2:package-file` channel without returning the raw path to the renderer
- Browse retains its existing main-process file-dialog path; first-file-only behavior, result rendering, quota refresh, package output, supported formats, and retry behavior are preserved
- rejected drop or Browse packaging requests always hide the progress overlay, release the in-flight guard, show fixed privacy-safe copy, and permit a retry
- focused lifecycle, preload, renderer, and Quick Package parser suite passed 43 tests with zero failures
- full clean deterministic suite passed 260 tests with zero failures using a normal macOS temporary root; forcing the suite under `/private/tmp` reproduced one unchanged Keynote path-string assertion on both the patch and exact base
- fresh exact-base Reprobox at `/private/tmp/crate-reprobox-phase35-final/repo` passed the same 43 focused tests, syntax checks, and `git diff --check`
- contained Electron `39.8.10` arm64 app passed packaged-content verification with 2,859 ASAR and 1,767 unpacked entries; packed `preload.js` and `renderer/app.js` hashes matched the reviewed source
- a genuine disk-backed PowerPoint `File` supplied to the packaged app's drop event reached Package Complete, copied identical source bytes, and incremented isolated quota from `0 of 10` to `1 of 10`
- the contained app used unique bundle id `com.crate.app.phase35qa`, isolated HOME/profile, mock Keychain, synthetic non-secret Figma environment value, no signing identity, and no installed-app or personal-config access
- two independent final rereviews found no P0-P2 blocker and confirmed the prior progress-overlay and retry concerns are resolved
- `npm audit --audit-level=high` exited successfully with only the pre-existing moderate `uuid` advisory; no dependency or lockfile mutation occurred
- `main.js`, package engine, parsers, provenance, Figma runtime and scope, watcher behavior, release state, and website remain unchanged
- PR #133 merged into `v2.4.x` as `5cbe421086095ef4201ff5e740ac7bf413aca65a`
- no signed build, notarization, release mutation, site deployment, or external tester update occurred

## Phase 4A Evidence

- exact base is merged Phase 3.5 commit `5cbe421086095ef4201ff5e740ac7bf413aca65a`; implementation remains uncommitted on `codex/security-parser-admission-limits`
- one shared admission module bounds raw whole-file reads, Premiere decompression, archive file and listing size, archive entry count and declared expansion, presentation media count and bytes, and IDML XML count and bytes
- sparse oversized files, decompression expansion, oversized declared archive entries, child-process output overflow, and package-orchestrator propagation fail with fixed privacy-safe errors
- normal Premiere, IDML, PowerPoint, Keynote, Quick Package, package, and parser result shapes remain covered; a real `/usr/bin/zip` and `/usr/bin/unzip` PowerPoint fixture listed and extracted one 600-byte asset successfully
- focused parser, Quick Package, package-safety, PSD, and Electron 39 disk-drop lane passed 57 tests with zero failures
- Electron `39.8.10` embedded Node passed all 20 new failure-first and compatibility tests
- dependency-complete full suite passed 280 tests with zero failures, including Figma scope and privacy, provenance, watcher, package, renderer, and lifecycle coverage
- fresh exact-base Reprobox at `/private/tmp/crate-reprobox-phase4a-final2.BdZL7d/repo` passed the same 57 focused tests, syntax checks, and `git diff --check`
- two independent adversarial rereviews approved the final patch after timeout handling, same-descriptor bounded reads, reference limits, late-failure cleanup, and separate legacy Premiere input budgets were verified
- `npm audit --audit-level=high` exited successfully with only the pre-existing moderate `uuid` advisory; no dependency or lockfile mutation occurred
- no new credential, URL, token, private-path, Figma, network, watcher, provenance, quota, release, or deployment behavior was introduced
- Bryant approved Phase 4A commit, push, PR creation, and merge if merge readiness remains clean; no signed build, notarization, release mutation, site deployment, external tester update, or Phase 4B implementation occurred before that gate
- PR #134 merged into `v2.4.x` as `84a7fd3affdf15d855313d339392de6fe9b7a807`

## Phase 4B Evidence

- exact base is merged Phase 4A commit `84a7fd3affdf15d855313d339392de6fe9b7a807`; implementation remains uncommitted on `codex/security-network-download-limits`
- one shared Figma network guard enforces a 30-second request timeout, 120-second operation deadline, 128 MiB API response cap, 512 MiB API operation cap, 100 MiB asset response cap, 1 GiB asset operation cap, zero authenticated API redirects, and at most five unauthenticated asset redirects
- every URL must remain HTTPS without embedded credentials; authenticated API requests never redirect or forward the Figma token, while asset redirects carry no authentication header
- response bytes are counted before buffering, exhausted byte or time budgets reject before another request, rejected and invalid-redirect bodies are destroyed, and timeout, redirect, status, protocol, size, and unknown-network errors use fixed privacy-safe text
- a known pre-package Figma asset-transfer failure creates no package output and does not increment quota; unreadable, rate-limited, partial, or failed asset-discovery retries remain blocked, while a clean retry clears the transient block and packages the recovered asset normally
- oversized assets create no cache file, file-ledger record, provenance node, or provenance edge
- focused Figma network, link, scope, privacy, package, and provenance suite passed 80 tests with zero failures
- dependency-complete full suite passed 297 tests with zero failures using the canonical checkout's existing dependencies through `NODE_PATH`; no dependency installation or mutation occurred
- one unchanged timing-sensitive provenance poll test failed in the first final full run, passed when isolated, and passed in the clean 297-test rerun
- fresh exact-base Reprobox at `/private/tmp/crate-reprobox-phase4b-final5.d5YbfM/repo` passed the same 80 tests, syntax checks, and `git diff --check`
- `npm audit --audit-level=high` exited successfully with only the pre-existing moderate `uuid` advisory
- normal parser results, watcher behavior, Figma scope, package selection and naming, provenance relationships, quota behavior, renderer UI, release state, and website remain unchanged outside the explicit fail-closed incomplete-Figma-transfer boundary
- no app launch, build, signing, notarization, release mutation, deployment, external tester update, Phase 5 implementation, updater work, or dependency mutation occurred

## Phase 4 Post-Merge Installed-App Evidence

- Phase 4B PR #135 merged as `6d07022f4ae43287da79b0db95fce5bad6f34c87`
- the first contained build correctly failed the packaged-content policy because the Phase 4A and 4B runtime modules were absent from the explicit allowlist
- a failure-first inventory test now compares every first-party `parsers/*.js` module with the packaged runtime allowlist; the allowlist adds only `admission-budgets.js` and `figma-network.js`
- the first production-identity QA launch also exposed an unnecessary Keychain prompt for a disconnected profile; root cause was checking `safeStorage` before checking whether an encrypted credential file existed
- a failure-first credential-store test proved the empty disconnected store made one encryption-availability call; the narrow fix makes zero calls while preserving encrypted reads, migration, secure writes, corruption handling, symlink defenses, and disconnect cleanup
- the pre-review, separately identified `Crate Phase 4B QA` app passed packaged-content verification, strict code-sign verification, and source-to-ASAR hash checks before the final credential preflight hardening; the replacement final-source build is recorded below
- clean launch, force quit/relaunch, Projects, Settings, zero quota, Diagnostics OFF, Package Details ON, and disconnected Figma all pass without a Keychain prompt or Keychain/log error when launched without a mock Keychain
- a one-day read-only QA credential was created in an approved Figma QA account and entered only into the separately identified, isolated Crate QA profile; its value was never printed or persisted in repo evidence
- the connected QA lane used an isolated test-only Keychain mode; the separate disconnected installed-app lane used the production Keychain path and proved prompt-free startup
- Current Page Only remained the selected default; a simple four-asset Figma fixture packaged exactly four PNGs, showed clean Package Complete and Package Details, and incremented quota exactly from zero to one
- a complex 46-asset fixture failed closed when Figma did not return every requested render: no package directory was written, quota remained unchanged, and privacy-safe retry copy was shown
- relaunch preserved the isolated Figma connection and visible window; Entire File remains the explicit alternate scope and was not selected
- targeted logs, evidence, and output contained no raw token, authorization header, complete Figma URL, signed URL, live file key, or unrelated private path; the isolated encrypted credential blob and profile directories retained restrictive permissions
- the temporary QA credential was revoked after validation, and the pre-existing production credential remained untouched
- the frozen final source was rebuilt once as the separately identified `Crate Phase 4 Final QA` app under Bryant's one-time approval; notarization, installation, release, upload, and deployment were not attempted
- the final app passes the strict packaged-content policy with 2,861 ASAR entries and 1,767 unpacked entries, strict Developer ID signature verification, and byte-for-byte source comparison for `main.js`, `preload.js`, `figma.js`, `figma-credential-store.js`, `figma-network.js`, and `admission-budgets.js`
- a new owner-only isolated profile opened one visible Projects window at zero usage without a Keychain prompt; Settings showed Figma disconnected, and force quit plus relaunch restored the same visible Projects state without a prompt
- no live credential was recreated for the replacement build: the earlier connected lane remains the live Figma behavior proof, while final-source unit coverage verifies valid encrypted reads and fail-fast invalid-entry handling

### Ordered Privacy-Safe Proof Manifest

Only sanitized filenames and hashes are retained here. The temporary screenshots and logs were reviewed through Computer Use, contain approved QA UI only, and are not committed.

| Order | Build / workflow / state | Viewport | Expected / observed | Sanitized artifact and SHA-256 | Privacy review | Redaction |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `Crate Phase 4 Final QA`; cold launch; new disconnected profile | 960 x 760 | Visible Projects window, zero usage, no Keychain prompt / pass | `01-projects-production-keychain.png` `c51f0ad267c87e4adb67b0c7d08493f669c46c7d32bfae7ae3c91389e0349832` | pass; approved QA UI only | none required; image not retained |
| 2 | same build; Settings; disconnected Figma | 960 x 760 | Disconnected state and Keychain explanation, no Keychain access prompt / pass | `02-settings-production-keychain.png` `ea473beb591ac79af0179ebd8ca9e24aa1c16f3fea914bb4ce0ac29b2941f383` | pass; no credential value or link | none required; image not retained |
| 3 | same build; force quit and relaunch; same isolated profile; window zoomed after default Projects was confirmed to distinguish the proof event | 1490 x 769 | Visible Projects window restored, no Keychain prompt / pass | `03-relaunch-production-keychain.png` `dd9770e32dc8826656fc69870dbd631c1ab52cc5721d6f6671ee8895c53da247` | pass; approved QA UI only | none required; image not retained |
| 4 | same build; launch log; production Keychain path | not applicable | No Keychain, credential, renderer-load, process-exit, or uncaught-error marker / pass | `launch-production-keychain.log` `4298413fcb841c62b5737a2577438dfd47683221d6d3a6262892678cf7f7ea8d` | pass; targeted secret, URL, identifier, and private-path scan | log not retained |
| 5 | pre-final connected QA build; Current Page Only package and incomplete-render fail-closed lanes | 960 x 760 | Four approved assets packaged once; partial 46-asset render wrote no output or quota / pass | `live-figma.log` `eeb2b7bd92342c63bbe9a1ef948f276ca5789bdebaf01f92226b7ad0ac3527c9`; four-file output manifest `a61083d80ae514eb8ab7f2227e00afd2f8b92025606e4920f1f5dfeb36b628fa` | pass; no credential, authorization header, complete URL, signed URL, opaque Figma identifier, or unrelated private path | raw artifacts not retained |

Final packaged runtime hash: `app.asar` `24faf63ee751b7be8103bbc88e36f13dfb08d0ad7d5f1fd46bf4d36307d18b5f`.

### Final Review Stack Result

- standard full suite passed 305/305; a quiet serial full-suite run also passed 305/305
- focused packaged-content and credential coverage passed 30/30 in both the source worktree and an exact-base Reprobox
- an intentionally overlapping reviewer run reproduced pre-existing shared-test-home contamination; the affected unchanged cases passed alone and in the quiet serial full suite, so no unrelated provenance test or product code was changed
- Crate Doctor reported zero failures; existing main-workspace hygiene warnings are outside this isolated patch
- `npm audit --audit-level=high` exited successfully with only the pre-existing moderate `uuid` advisory; no dependency or lockfile changed
- final specialist rereviews found no remaining credential, runtime allowlist, privacy, scope, build-proof, or evidence-manifest finding
