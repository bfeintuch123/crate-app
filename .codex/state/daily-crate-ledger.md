# Daily Crate Ledger

Purpose: durable, privacy-safe source of truth for daily Crate progress. This file exists so the 11 PM vault automation can update the Crate vault without asking Bryant to paste a daily summary.

## Operating Contract

- Codex updates this ledger during the day whenever meaningful Crate progress happens.
- The nightly vault automation reads this file first, then cross-checks repo state and recent Crate docs.
- This ledger is synthesized, not a raw transcript.
- Keep entries short, factual, and restartable.

## Privacy Rules

Do not store:

- tokens, passwords, credentials, Keychain details, or API keys
- full Figma URLs, Figma file keys, signed URLs, or raw response payloads
- raw private paths beyond approved QA/repo/vault anchors
- raw logs, broad filesystem listings, or unrelated client data
- full copied diagnostics when a classification summary is enough

## Automation Sources

Primary:

- `/Users/bryantfeintuchclaw/Projects/.codex/state/daily-crate-ledger.md`

Secondary:

- `/Users/bryantfeintuchclaw/Projects/.codex/state/current-workstream.md`
- `/Users/bryantfeintuchclaw/Projects/docs/crate/daily/`
- `/Users/bryantfeintuchclaw/Projects/docs/crate/qa-smokes/`
- recent `v2.4.x` git log and release tags

## 2026-06-24

### Current QA State

- Active internal QA version: `v2.8.0-qa.40`.
- qa40 was built to validate PR #109 / merge commit `b9c6daa8a15f0c5763d691f01bc636f83a6fdf28`.
- qa40 Keynote mixed existing + new assets passed.
- qa40 Illustrator no-save linked JPG spot check passed.
- qa40 skipped PowerPoint, InDesign, PSD, Quick Package, Figma, Package Details, and diagnostics spot checks because package quota reached `10 of 10`.

### Key QA Results

- Keynote Smoke 8D PASS: one `.key` plus five expected media files packaged after normal `Cmd+S`, without close/reopen.
- Keynote unused controls were excluded.
- Keynote output had no stale lane files, package-output folders, diagnostics, root provenance, token, Figma URL, file key, signed URL, or private-path leakage.
- Illustrator Smoke 2 PASS: `IMG_5331.JPG` appeared as `Needs save` and was not package-ready before save.
- qa40 targeted quota reset completed with backup. Only `usage.packagesThisMonth` changed from `10` to `0`.
- PowerPoint extraction/exclusion spot check PASS with setup caveat: deterministic PPTX fixture validated Crate extraction/exclusion, not live PowerPoint editing.
- PSD/Photoshop spot check PARTIAL: PSD-only safety passed, but linked PSD dependency capture was not validated because linked placement automation failed and the fallback used embedded placed layers.
- Quick Package spot check PASS for scoped contents, but FOLLOW-UP because Quick Package did not increment package quota even though Bryant decided Quick Package should count against quota.
- Diagnostics / Package Details mini-check needs rerun/triage: Diagnostics ON output did not include `Crate Diagnostics/crate-provenance.json` in the reported package output.
- InDesign spot check BLOCKED/INCONCLUSIVE: expected InDesign files eventually staged, but PowerPoint test files contaminated the active watcher state before package. Needs clean InDesign-only rerun.
- Figma Pro Current Page Only was not run because no fresh approved Pro-workspace editor/page-node link was available.
- qa40 cleanup rerun resolved the InDesign and Diagnostics questions:
  - InDesign-only rerun PASS: one current `.indd` plus two existing linked images plus three newly used images packaged; unused controls, stale lane files, `_1.indd`, diagnostics, root provenance, package-output recapture, and privacy markers were absent.
  - Diagnostics ON normal project package PASS: `Crate Diagnostics/crate-provenance.json` was present in the diagnostics folder, not at package root, not counted as design asset, and privacy grep was clean.
- Quick Package quota behavior is now the only confirmed product-rule mismatch from qa40 cleanup:
  - Quick Package contents scoped correctly.
  - Usage counter stayed `2/10` before and after Quick Package.
  - This conflicts with Bryant's decision that Quick Package should count against quota.
- PSD linked-dependency rerun remained BLOCKED/INCONCLUSIVE by fixture/setup. Photoshop manual linked placement worked for one unsaved test placement, but the available qa40 PSD fixture was embedded-layer based, so packaging would not validate linked dependency capture.
- PR #110 fixed Quick Package quota behavior and merged into `v2.4.x` at merge commit `14d340a82f1d0f666e79b4aab876afffe986ef9c`.
  - Successful Quick Package now increments `usage.packagesThisMonth`.
  - Quick Package returns the existing `limit_reached` response at quota limit.
  - Renderer shows the existing upgrade modal for Quick Package quota limit and refreshes footer usage after Quick Package success.
  - Tests cover Quick Package success increment, failure/no-output no-increment, limit no-increment/no-output, and normal project package quota behavior.
- Internal QA prerelease `v2.8.0-qa.41` was prepared from latest `origin/v2.4.x`.
  - Release commit: `7fbbae77afa28505a292bfc57da4a2cac6374692`.
  - GitHub prerelease: `https://github.com/bfeintuch123/crate-app/releases/tag/v2.8.0-qa.41`.
  - Direct DMG: `https://github.com/bfeintuch123/crate-app/releases/download/v2.8.0-qa.41/Crate-2.8.0-qa.41-arm64.dmg`.
  - The signed/stapled DMG validates as Notarized Developer ID.
  - The app inside the DMG reports `2.8.0-qa.41`, includes the Apple Events usage string, and has the Apple Events entitlement.
  - The built app ASAR contains PR #110 quota paths: `getPackageLimitResult`, `incrementPackageUsage`, and `limit_reached`.
  - Only `package.json` and `package-lock.json` changed in the release commit.
  - No final public release, get-crate.com update, site deploy, crate-web change, dependency mutation, or app source change occurred.
- qa41 targeted Quick Package quota validation passed on Jenna's Mac.
  - Installed app version, bundle ID, process path, Apple Events usage description, and Apple Events entitlement were correct.
  - Quick Package success incremented package usage from `0/10` to `1/10`.
  - Normal project package incremented usage from `1/10` to `2/10`.
  - Diagnostics ON normal project package incremented usage from `2/10` to `3/10`.
  - Quick Package at `10/10` showed the existing quota/upgrade flow and wrote no output.
  - Quick Package scoped output, Desktop default output, Diagnostics OFF, Diagnostics ON placement, package-output exclusions, stale-lane exclusions, unused-control exclusions, and privacy checks all passed.
- Illustrator Smoke 8E mixed existing + new saved-package workflow passed on qa41.
  - Packaged exactly one current AI, two existing linked images, and three newly used linked images.
  - Unused controls, duplicate `_1` AI/media, stale lane files, package-output folders, Crate Diagnostics, root provenance, and privacy markers were absent.
  - Usage counter incremented from `3/10` to `4/10`.
  - Caveat: scripted Illustrator save alone did not trigger staging, but normal foreground `Cmd+S` did; treat as automation-save timing caveat, not package correctness failure.
- PSD linked-dependency clean rerun passed on qa41.
  - Photoshop confirmed all five asset layers were linked smart objects, not embedded.
  - Package output contained exactly one PSD, two existing linked images, and three newly used linked images.
  - Unused controls, duplicate `_1` PSD/media, stale lane files, package-output folders, Crate Diagnostics, root provenance, and privacy markers were absent.
  - Usage counter incremented from `4/10` to `5/10`.
  - Caveat: pre-package UI showed only the PSD; Package Complete, Package Details, and disk output correctly gathered all six files.
- Figma Pro Current Page Only final confirmation passed on qa41.
  - Used `Petra Logo (Copy) - Crate QA Pro` in a Team/Pro workspace, design/editor route, page/node present.
  - Current Page Only was the default and locked to Page 1.
  - Crate staged 46 current-page assets and packaged 46 PNGs.
  - No rate-limit warning appeared.
  - Package Details showed 46 included/gathered and no Needs Review issues.
  - Token, full Figma URL, file key, signed URL, Crate Diagnostics, root provenance, package-output folders, stale QA roots/lane files, and unrelated private files were absent from targeted checks.

### Product Decisions

- Quick Package defaulting to Desktop is acceptable and not a blocker.
- Quick Package should count against the 10-package quota.
- Figma support can require appropriate plan, seat, file access, and workspace/file location.
- The vault automation should be hands-off: Codex should maintain this daily ledger, and the automation should read it rather than asking Bryant to paste a summary.
- Full public `v2.8.0` should wait until after Jenna's full macOS UI/UX redesign and a small real-tester group.
- Closed beta testers should receive 25 packages per month, not unlimited packaging. Public/free baseline remains 10 packages per month unless Bryant changes it later.
- Detailed Figma guidance should live primarily on get-crate.com, not as dense in-app copy. The app should keep lightweight operational copy and privacy-safe failure states.
- External testers should follow a privacy-first artifact protocol: synthetic/cleared assets preferred, private package folders and diagnostics not shared by default, diagnostics allowed only for synthetic/cleared tests or when Bryant explicitly asks after a failure.
- External tester feedback should flow through the professional testing company's portal with a structured Crate intake form. Bryant reviews first for product/privacy, Codex synthesizes triage, bugs route to the Autonomous Crate Failure Loop, and UX/design feedback routes to Jenna's redesign backlog.
- This Codex thread is the Crate source of truth and command center. For Crate work, Codex should create or message new/scoped Codex threads directly when thread tools are available, rather than asking Bryant to paste prompts. If thread tools are unavailable, Codex should clearly state the blocker and provide a fallback prompt.

### Tester-Ready Baseline And Redesign Brief

- Created `docs/crate/tester-readiness/v2.8.0-tester-ready-baseline-ux-brief.md`.
- The brief treats `v2.8.0-qa.41` as the validated engineering baseline, not as final public release approval.
- It summarizes validated lanes from qa24-qa41, remaining Jenna design issues, tester readiness checklist, tester workflow scripts, feedback intake template, risks before inviting testers, and recommended next build strategy.
- Recorded the decision in `.codex/decisions/v2.8-ui-redesign-tester-rollout-before-public.md`.
- Updated the release-prep synthesis to point to the tester-readiness brief as the active next-step plan.
- Recorded the closed-beta tester quota decision in `.codex/decisions/v2.8-closed-beta-tester-quota.md`.
- Updated the tester-readiness brief to use 25 packages per month for closed beta testers and to preserve 10 packages per month as the public/free baseline.
- Recorded the Figma guidance placement decision in `.codex/decisions/v2.8-figma-guidance-on-website.md`.
- Updated the tester-readiness and release-prep docs so detailed Figma plan/access/rate-limit guidance is assigned to get-crate.com, while the app stays lightweight.
- Recorded the tester privacy/artifact protocol in `.codex/decisions/v2.8-tester-privacy-artifact-protocol.md`.
- Updated the tester-readiness brief with allowed/default-denied artifacts and diagnostics sharing rules.
- Recorded the tester portal and triage flow decision in `.codex/decisions/v2.8-tester-feedback-portal-flow.md`.
- Added professional tester portal questions to the tester-readiness brief.

### Next Action

- Review the tester-ready baseline and UI/UX redesign brief.
- Prepare tester onboarding materials and tester workflow assignments.
- Decide how to implement the approved 25-package monthly tester quota.
- Draft get-crate.com Figma guidance before public launch, but do not update crate-web or deploy until Bryant explicitly scopes that work.
- Turn the privacy/artifact protocol into tester-facing onboarding copy before inviting testers.
- Convert the approved portal questions into the chosen testing vendor's form format.
- Start Jenna UI/UX redesign work before any public release readiness execution.
- Do not run final public release, get-crate.com update, crate-web deploy, tag, or release-state mutation until after redesign and tester feedback.

### Non-Blocking Follow-Ups

- Improve pre-package review UI visibility for PSD linked dependencies.
- Watch visible UI refresh lag in some lanes.
- Add get-crate.com Figma guidance for plan/seat/file-access requirements and rate-limit behavior.
- Revisit Quick Package clarity only as polish; Desktop default is accepted.

## 2026-06-27

### Current Phase

- Jenna is working on the new Crate macOS mockup.
- Active engineering baseline remains `v2.8.0-qa.41`.
- Public `v2.8.0` remains deferred until after redesign, tester group, and follow-up fixes.

### Redesign Brief

- Created `docs/crate/design/jenna-macos-redesign-brief-v2.8.md`.
- Created daily note `docs/crate/daily/2026-06-27.md`.
- Updated `.codex/state/current-workstream.md` so the active next step is Jenna's redesign mockup and implementation scope, not final release readiness.
- Captured the Figma state coverage review at `docs/crate/design/jenna-macos-redesign-state-coverage-review-2026-06-27.md`.

### Brief Contents

- qa41 validated engineering baseline.
- Product promise and product tone.
- Core workflows:
  - Quick Package
  - watched project
  - Package Review
  - Package Complete
  - Figma project link
  - Settings
- Required screens and states.
- Non-negotiable product rules:
  - Figma Current Page Only default
  - Entire File opt-in
  - Diagnostics off by default
  - Quick Package counts against quota
  - free/public 10 packages/month baseline
  - closed beta 25 packages/month cap
  - detailed Figma guidance on get-crate.com
  - privacy-safe app copy and artifact rules
- Copy direction, visual direction, package trust model, tester-build requirements, engineering handoff needs, and post-redesign QA acceptance criteria.

### Next Action

- Bryant/Jenna review the redesign brief.
- Jenna keeps the visual direction and reviews/tweaks the now state-covered mockup.
- After mockup handoff, prepare implementation scope and post-redesign `qa.42` smoke plan.
- Do not update crate-web, get-crate.com, release tags, dependencies, signing, notarization, or final public release state.

### Figma State Coverage Update

- Jenna's Figma/Codex session added the requested missing frames and variants.
- Added frames include Home Empty/Active, Projects List, Files Watching/Ready/Needs Save/No Files, Package Review, Package Complete, Package Details, Quick Package Select/Progress/Complete/Quota Blocked, Settings Figma State Variants, and Quota Variants.
- Added component variants include file rows, status pills, quota cards, Figma state cards, and diagnostics cards.
- Copy was cleaned up:
  - `manifest included` -> `Package details included`
  - `Package Health` -> `Package status`
  - QA/internal Illustrator wording -> `Save Illustrator file to make linked assets package-ready.`
  - broad tracking copy -> `Tracks project dependencies while you work.`
- Jenna's visual direction was preserved: Wispr-style shell, Crate branding, sidebar language, spacing, colors, typography direction, rounded panels, native macOS feel, and calm production-ready tone.
- No new visual system or backend behavior was intentionally introduced.
- Remaining design decision: whether `Files` stays nested inside project context or becomes a more explicit top-level implementation.

### Wispr Inspiration Cleanup

- Jenna's Figma/Codex session corrected the design after the Wispr Flow reference leaked into Crate product behavior.
- Removed command launcher / shortcut UI, top-right notification/account header icons, transcript/activity-feed feel, smart `Next action` language, broad `auto-tracking` copy, visible QA/smoke/internal labels, and `Crate/Wispr shell` component-board wording.
- Copy was corrected to Crate-specific language:
  - `Crate project packaging`
  - `Files`
  - `Free`
  - `Status`
  - `Figma project link scanned`

## 2026-06-29

### Redesign Implementation Branch

- Bryant confirmed Figma is a visual spec/markup only and the existing Crate Electron app architecture must remain intact.
- Active branch created from `v2.4.x`: `codex/redesign-current-model-ui`.
- Implementation scope was limited to renderer UI files:
  - `renderer/index.html`
  - `renderer/app.js`
  - `renderer/styles.css`
- No package engine, parser, provenance, dependency, crate-web, site, build, release, signing, notarization, tag, or deploy files were intentionally changed.

### Current Model UI Changes

- Removed the Home-first model from the renderer shell.
- Removed the top-level Files tab.
- Implemented the simplified navigation model:
  - `Projects`
  - `Current Project`
  - `Settings`
  - `Help`
- Kept Quick Package as a prominent sidebar action, not a primary nav tab.
- Default launch remains on Projects.
- Current Project now replaces Files as the active project workspace while preserving existing renderer state and APIs.
- Preserved current Crate functionality and state surfaces:
  - Projects list
  - create/start project
  - active/current project
  - watching/scanning/no-files/ready/package-blocked states
  - files waiting for review
  - Needs save
  - Figma project link
  - Current Page Only default
  - Entire File opt-in
  - Figma connected/disconnected/reconnect/rate-limited/cannot-read states
  - Package Review
  - Package Complete
  - Package Details
  - Quick Package
  - quota/upgrade/limit reached
  - Diagnostics OFF/ON

### Design Guardrails

- Used the active Figma file and visible frame inventory as the visual target.
- Direct Figma plugin tools were not callable in this Codex thread, so implementation used the active Figma appshot, Bryant's prompt, and existing design docs as the spec.
- Preserved the Crate wordmark treatment and simplified current-model layout.
- Did not add Wispr/productivity behavior:
  - no Home dashboard
  - no command launcher
  - no activity feed
  - no notifications/account header
  - no inbox/transcript/AI assistant
  - no smart recommendation engine
  - no new backend states

### Verification

- `node --check renderer/app.js` passed.
- `git diff --check` passed.
- Renderer stale-term scan found no Home tab, top-level Files tab, Wispr/productivity copy, command launcher, notifications, auto-tracking, AI-powered copy, transcript, inbox, or assistant terms.
- Local Electron smoke render confirmed the new shell exposes Projects, Current Project, Settings, Help, Quick Package, and the sidebar quota/plan card.
- A sibling Codex app thread with Figma MCP access successfully inspected the active Figma file using `get_metadata`, `use_figma`, `get_screenshot`, and `get_design_context`.
- That Figma-MCP pass updated only renderer UI files:
  - `renderer/index.html`
  - `renderer/styles.css`
  - `renderer/app.js`
- The Figma-MCP pass confirmed:
  - no Home UI
  - no top-level Files tab
  - nav is Projects, Current Project, Settings, Help
  - Quick Package is prominent but not a nav tab
  - Package Review, Package Complete, and Package Details remain present
  - Figma connected/disconnected/scan/warning states remain present
  - quota states and diagnostics copy/details are represented without touching diagnostics/provenance internals
- Follow-up local checks in the source-of-truth thread passed:
  - `node --check renderer/app.js`
  - `git diff --check -- renderer/index.html renderer/styles.css renderer/app.js`
  - renderer stale-term scan for Home/top-level Files/Wispr/productivity copy
  - required-state scan for Package Review/Complete/Details, Figma states, quota state, Diagnostics, and Quick Package

### Next Action

- Review the local renderer implementation on branch `codex/redesign-current-model-ui`.
- If Bryant approves, commit/push/open PR to `v2.4.x`.
- After merge, prepare the next internal QA prerelease, likely `v2.8.0-qa.42`, focused on post-redesign UI regression plus the existing qa41 package-engine smoke surface.

### Thread Orchestration Decision

- Recorded `.codex/decisions/v2.8-crate-thread-orchestration-source-of-truth.md`.
- Going forward, Crate thread orchestration should be handled by Codex when tools are available:
  - create or message fresh Crate/Figma/QA threads directly
  - keep this thread as the source of truth
  - update repo state and daily ledger for durable context
  - fall back to pasteable prompts only when thread tools are unavailable
  - `Needs save`
  - `Diagnostics`
  - `Project links enabled`
  - `Package blocked because quota is exhausted. No output written.`
  - `Figma connected` / `Figma disconnected`
- Crate logo and wordmark treatment were preserved.
- Required Crate state frames and component variants remain present.
- Forbidden Wispr/productivity term scan was clean.
- Remaining Wispr-inspired element is structural only: left sidebar, large central workspace, and right status rail. This is acceptable visual inspiration as long as product behavior remains Crate-specific and qa41-backed.

### Redesign Simplification Decision

- Bryant and Jenna decided the redesign should stay close to the simple Crate app that exists today.
- The new layout should be treated as a visual refresh and state-coverage pass, not a new product model.
- Bryant and Jenna decided to remove `Home` rather than maintain a homepage/dashboard.
- The sidebar destination for the selected/active project should be named `Current Project`.
- Do not use `Files` as a top-level sidebar item because it implies a global file browser.
- Do not reuse `Projects` for this destination because the app already has a `Projects` section.
- Preferred simple navigation: Projects, Current Project, Quick Package, Settings, Help.
- Default launch should land on `Projects`.
- Avoid extra terminology from today's design exploration unless it maps directly to existing qa41 behavior.

### Figma Current-Model Cleanup Result

- Jenna's Figma/Codex session completed the simplified current-model redesign pass.
- Renamed `Crate macOS App - Branded` to `Crate macOS App - Current Model`.
- Removed Home frames, top-level Files frames, old imported website/reference frames, and older Wispr-style pass frames.
- Created frames for Projects, Current Project, Package Review, Package Complete, Package Details, Quick Package, Settings, quota, diagnostics, Figma states, and Help.
- Confirmed Home is gone.
- Confirmed top-level Files is gone.
- Confirmed `Current Project` replaces Files.
- Confirmed Quick Package remains prominent but not a primary nav tab.
- Confirmed no Wispr/productivity features remain.
- Confirmed Crate logo/wordmark typography remains intact.
- `Help - Support` should stay as a lightweight in-app help/support destination for now; external support/docs links can be decided later.

## 2026-06-29

### Redesign Buildout Status

- Bryant reported that Jenna finished the new Crate macOS app buildout in Figma.
- Bryant downloaded Figma and logged into Jenna's account.
- The Figma plugin was used to create the next Crate build for QA.
- Bryant plans to smoke test this build before preparing it for real testers.

### Current Guardrail

- Treat this as post-redesign internal QA preparation, not public release prep.
- The next build should preserve qa41 package-engine behavior.
- The build should preserve the simplified current-model navigation:
  - `Projects`
  - `Current Project`
  - `Settings`
  - `Help`
  - Quick Package as a prominent action
- Confirm no Home dashboard, top-level Files tab, or Wispr/productivity behavior returned.
- Next likely internal QA build is `v2.8.0-qa.42`, after generated code/design changes are reviewed.

### Next Action

- Wait for Bryant to provide the implementation branch, PR, build artifact, or Figma/plugin output details.
- Then inspect changed app files, verify no unintended package/backend changes, run focused renderer checks, and prepare a post-redesign QA smoke plan before any tester distribution.
