# Crate Current Workstream

Last updated: 2026-06-29

## Current Status

- Active repo: crate-app
- Canonical branch: `v2.4.x`
- Remote: `bfeintuch123/crate-app`
- Latest internal QA prerelease in this thread: `v2.8.0-qa.41`
- Latest public-stable release: not updated in this workstream
- Current phase: post-redesign build review and internal QA preparation; final public release is intentionally deferred
- Command center: current Codex thread
- Durable memory target: repo docs, daily ledger, and compiled vault

## Latest QA Result

`v2.8.0-qa.41` validated PR #110 / merge commit `14d340a82f1d0f666e79b4aab876afffe986ef9c` in the signed app.

qa41 release-gate result:

- Release commit: `7fbbae77afa28505a292bfc57da4a2cac6374692`
- GitHub prerelease: `https://github.com/bfeintuch123/crate-app/releases/tag/v2.8.0-qa.41`
- Direct DMG: `https://github.com/bfeintuch123/crate-app/releases/download/v2.8.0-qa.41/Crate-2.8.0-qa.41-arm64.dmg`
- Signed/stapled DMG validates as Notarized Developer ID.
- App inside the DMG reports version `2.8.0-qa.41`.
- Apple Events usage description and Apple Events entitlement are present.
- Built app ASAR contains PR #110 quota code paths: `getPackageLimitResult`, `incrementPackageUsage`, and `limit_reached`.
- No crate-web, site deploy, final public release, dependency mutation, or app source changes occurred.

Primary qa41 validation target:

qa41 targeted QA result: PASS.

- Successful Quick Package increments `usage.packagesThisMonth` by one: PASS.
- Quick Package at the 10-package limit shows the existing quota/upgrade flow and does not write output: PASS.
- Scoped Quick Package output remains correct: PASS.
- Desktop default output remains accepted: PASS.
- Normal project package quota behavior remains intact: PASS.
- Diagnostics OFF emits no diagnostics/root provenance: PASS.
- Diagnostics ON normal project package emits `Crate Diagnostics/crate-provenance.json` only under `Crate Diagnostics`: PASS.
- Package-output folders, stale lane files, unused controls, tokens, Figma URLs, file keys, signed URLs, and unrelated private paths were excluded in targeted checks.

Previous qa40 result:

Primary qa40 result:

- Smoke 8D - Keynote mixed existing + new assets: PASS.
- Keynote captured and packaged one `.key` file plus five expected media files after normal `Cmd+S`.
- Newly inserted Keynote media no longer requires close/reopen to package.
- Unused controls were excluded.
- No duplicate media, stale lane files, package-output folders, Crate Diagnostics, root provenance, token, Figma URL, file key, signed URL, or private-path leakage was reported.

Regression spot check:

- Illustrator Smoke 2 no-save linked JPG: PASS.
- `IMG_5331.JPG` appeared in Files Waiting For Review as `Needs save`.
- It was not package-ready before save.

Targeted qa40 reset/spot-check result:

- Quota reset completed with backup; only `usage.packagesThisMonth` changed from `10` to `0`.
- PowerPoint extraction/exclusion spot check passed with setup caveat: deterministic PPTX fixture validated extraction/exclusion, not live PowerPoint editing.
- PSD spot check was partial: PSD-only safety passed, but linked PSD dependency capture was not validated because linked placement automation failed and fallback used embedded placed layers.
- Quick Package contents were scoped correctly, but Quick Package did not increment package quota. This conflicts with Bryant's product decision that Quick Package should count against quota.
- Diagnostics ON did not emit `Crate Diagnostics/crate-provenance.json` in the reported output and needs a clean normal-project packaging rerun before classification.
- InDesign was blocked/inconclusive because PowerPoint files contaminated the active watcher state before packaging. It needs a clean InDesign-only rerun.
- Figma Pro Current Page Only was not run because no fresh approved Pro-workspace editor/page-node link was available.

qa40 cleanup rerun:

- InDesign-only rerun: PASS. It packaged exactly one current `.indd`, two existing linked images, and three newly used images; unused controls, stale lane files, `_1.indd`, diagnostics, root provenance, package-output recapture, and privacy markers were absent.
- Diagnostics ON normal project package: PASS. `Crate Diagnostics/crate-provenance.json` was present in the diagnostics folder, absent at package root, not counted as a design asset, and privacy grep was clean.
- Quick Package quota verification: FAIL for quota, PASS for scope. Usage stayed `2/10` before and after Quick Package, which conflicts with Bryant's product decision.
- PSD linked-dependency rerun: BLOCKED/INCONCLUSIVE by fixture/setup. Available qa40 PSD fixture was embedded-layer based, so it would not validate linked dependency capture.

## Recent Fix Trail

- PR #89: fixed Illustrator placed-item file/path reads by running them inside the Illustrator app context while keeping guarded per-item fallback behavior.
- PR #91: fixed Figma package materialization wait/file-key retention.
- PR #95/#96/#99/#100/#101: iterated Figma URL parsing, privacy-safe diagnostics, and fetch/rate-limit diagnostics.
- PR #102/#103: fixed Figma rate-limit handling/backoff and dependency audit blocker.
- PR #104: deduped InDesign master files so package output keeps one current `.indd`.
- PR #105: prevented stale prior-lane evidence from leaking into fresh project review/package paths.
- PR #107: fixed duplicate PowerPoint extracted media behavior.
- PR #108: fixed InDesign save/watch timing after manual `Cmd+S`.
- PR #109: fixed Keynote pasted-image media dedupe so distinct newly inserted media is retained and packaged.
- PR #110: fixed Quick Package quota behavior so successful Quick Package counts against `usage.packagesThisMonth`.

## Passing QA Lanes

- Installed-app launch/interactions: passing through qa41.
- Illustrator no-save linked JPG: passing through qa40.
- Illustrator mixed existing + new saved-package Smoke 8E: passing through qa41; package correctness, unused exclusion, duplicate prevention, quota increment, and privacy/scope passed. Caveat: scripted Illustrator save alone did not trigger staging, but normal foreground `Cmd+S` did.
- InDesign downloaded-unused exclusion and mixed existing + new assets: passing through qa40 cleanup.
- Photoshop/PSD downloaded-unused, mixed existing + new assets, and linked smart-object dependency capture: passing through qa41. Caveat: pre-package UI shows PSD only while Package Complete/Details/output correctly gather linked dependencies.
- PowerPoint downloaded-unused and mixed existing + new assets: passing through qa40/qa41 package checks.
- Keynote downloaded-unused and mixed existing + new assets: passing through qa40.
- Figma Current Page Only: passing through qa41 when the file is in an accessible Pro/team workspace and not Figma API rate-limited. Final Pro Current Page confirmation packaged 46 approved current-page assets with privacy/scope checks clean.
- Quick Package: package correctness and quota behavior passing through qa41.
- Package Details and Diagnostics OFF/ON: passing through qa41.

## Current Next Action

All requested pre-public smoke confirmations are complete, and Bryant clarified that Crate should not move straight to final public `v2.8.0`.

The active code branch is now `codex/redesign-current-model-ui`, created from `v2.4.x`, to merge Jenna's simplified Figma current-model visual direction into the existing Electron renderer.

Current implementation scope:

- `renderer/index.html`
- `renderer/app.js`
- `renderer/styles.css`

Guardrails:

- Figma is the visual spec/markup only.
- Do not replace app architecture.
- Do not change package-engine behavior.
- Do not touch `main.js`, preload API behavior, parsers, provenance, dependencies, crate-web, crate-site, build/release/sign/notary/deploy/tag state unless Bryant explicitly scopes it.

Implemented UI model:

- No Home.
- No top-level Files tab.
- Navigation is `Projects`, `Current Project`, `Settings`, `Help`.
- Quick Package remains a prominent action, not a primary nav tab.
- Default launch lands on Projects.
- Current Project replaces Files as the active project workspace.

Figma verification:

- A sibling Codex app thread with Figma MCP access inspected the active Figma file using `get_metadata`, `use_figma`, `get_screenshot`, and `get_design_context`.
- That direct-Figma pass confirmed/updated the renderer implementation while staying inside the allowed renderer scope.
- Follow-up local checks in this source-of-truth thread passed for renderer syntax, diff whitespace, prohibited Home/top-level Files/Wispr terms, and required Crate state labels.

Engineering evidence:

- `docs/crate/release-prep/v2.8.0-public-prep-synthesis.md`

Active tester/redesign plan:

- `docs/crate/tester-readiness/v2.8.0-tester-ready-baseline-ux-brief.md`
- `docs/crate/design/jenna-macos-redesign-brief-v2.8.md`
- `docs/crate/design/jenna-macos-redesign-state-coverage-review-2026-06-27.md`

Recommendation:

- Treat `v2.8.0-qa.41` as the validated engineering baseline.
- Review the current-model renderer implementation, then proceed toward a post-redesign internal QA build if approved.
- Do not run final public release execution until after redesign, tester feedback, and a later explicit Bryant approval.

Next:

1. Review the local renderer diff on `codex/redesign-current-model-ui`.
2. Confirm no Home dashboard, top-level Files tab, or Wispr/productivity behavior returned.
3. Confirm Projects, Current Project, Settings, Help, Quick Package, Package Review/Complete/Details, Figma states, quota states, and diagnostics states remain exposed.
4. If Bryant approves, commit/push/open PR to `v2.4.x`.
5. After merge, prepare the next internal QA build, likely `v2.8.0-qa.42`.
6. Decide the implementation mechanism for the approved closed-beta quota: 25 packages per month for testers, not unlimited.
7. Do not update get-crate.com, deploy crate-web, create final `v2.8.0`, tag a public release, or mutate release/site state until Bryant explicitly approves the final public release step.

## Bryant Product Decisions

- Quick Package defaulting to Desktop is acceptable and not a blocker.
- Quick Package should count against the 10-package quota.
- Figma support can require appropriate Figma plan, seat, file access, and workspace/file location.
- The Crate vault update should be hands-off for Bryant: Codex should maintain a daily ledger during the day, and the 11 PM automation should read that ledger instead of asking Bryant to paste summaries.
- Full public `v2.8.0` should wait until after Jenna's UI/UX redesign and a small real-tester group.
- Closed beta testers should receive 25 packages per month, not unlimited packaging. Public/free baseline remains 10 packages per month unless Bryant changes it later.
- Detailed Figma guidance should live primarily on get-crate.com. The app should stay lightweight: token connection, per-project link, Current Page Only default, Entire File opt-in, privacy-safe failure copy, and possibly a simple learn-more path.
- External testers should follow a privacy-first artifact protocol: synthetic/cleared assets preferred, private package folders and diagnostics not shared by default, diagnostics allowed only for synthetic/cleared tests or when Bryant explicitly asks after a failure.
- External tester feedback should flow through the professional testing company's portal with a structured Crate intake form. Bryant reviews first for product/privacy, Codex synthesizes triage, bugs route to the Autonomous Crate Failure Loop, and UX/design feedback routes to Jenna's redesign backlog.
- This Codex thread is the Crate source of truth and command center. When Crate work needs a fresh thread, Figma-specific thread, QA thread, or scoped handoff thread, Codex should create or message that thread directly when thread tools are exposed, instead of defaulting to giving Bryant a prompt to paste manually. If thread tools are unavailable, Codex should say so and provide the fallback prompt.

## Known Non-Blocking Public-Release Follow-Ups

- Improve pre-package review UI visibility for PSD linked dependencies; package output and Package Details are correct.
- Watch visible UI refresh lag in some lanes even when local state and package output are correct.
- Add get-crate.com Figma guidance about Pro/team workspace, seat/access, Starter plan API limits, and rate-limit behavior.
- Revisit Quick Package clarity only as product polish; Desktop default is accepted.
- Decide whether to remediate or document remaining moderate audit advisories if still present.
- Implement the redesigned macOS app without regressing the qa41 package engine.
- Preserve the completed Figma state coverage during any visual tweaks.

## Stop Conditions

Stop and ask Bryant before:

- final public `v2.8.0`
- get-crate.com update
- crate-web deploy
- dependency mutation
- credentials or Keychain handling
- unapproved private file inspection
- build, release, tag, notarization, or site mutation outside an explicit release-gate prompt
- broadening scope beyond the active QA lane

## Exact Next Prompt

```text
Use docs/crate/design/jenna-macos-redesign-brief-v2.8.md and docs/crate/tester-readiness/v2.8.0-tester-ready-baseline-ux-brief.md to prepare the implementation scope for Jenna's Crate macOS redesign mockup.

Do not create final public v2.8.0, update get-crate.com, deploy crate-web, tag a public release, notarize a new public artifact, mutate dependencies, or make app source changes.

Return:
- UI implementation scope
- screens and states to build
- acceptance criteria for qa.42
- files likely to change
- risks before implementation
- stop gates before app code edits

```
