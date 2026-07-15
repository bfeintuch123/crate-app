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

## 2026-07-02

### Crate Ops Loop Hardening

- Bryant approved implementing all 12 Crate ops/workflow improvements derived from the Peter Steinberger/OpenClaw research pass.
- Created branch `codex/crate-ops-loop-hardening` from `v2.4.x`.
- Added the Crate ops layer:
  - `.codex/ops/crate-ops-improvement-plan.md`
  - `.codex/ops/standing-orders.md`
  - `.codex/taskflows/README.md`
  - `.codex/ops/crate-memory-model.md`
  - `.codex/ops/proof-bundle-template.md`
  - `.codex/ops/tester-feedback-archive.md`
  - `.codex/ops/skill-registry.md`
  - `.codex/ops/docs-index.md`
  - `.codex/playbooks/crate-cloudflare-deploy.md`
  - `.agents/skills/crate-cloudflare-deploy/SKILL.md`
  - `.agents/skills/crate-doctor/SKILL.md`
  - `.codex/tools/crate_doctor.py`
- Updated existing loop/router docs so Crate loops use standing orders, taskflows, memory load, proof bundles, and Crate Doctor preflights where appropriate.
- Updated `AGENTS.md`, `.codex/ROUTER.md`, `_shared-gates.md`, `crate-codex-loops.md`, `crate-runner-loop.md`, `crate-external-control-layer.md`, and `crate-check-suites.md`.
- Recorded the decision in `.codex/decisions/v3-crate-ops-loop-hardening.md`.
- Scope stayed docs/ops/tooling only; no Crate app source, package engine, parser, provenance, dependency, build, release, tag, notarization, crate-web, or deploy state was intentionally changed.
- Verification:
  - `python3 .codex/tools/crate_doctor.py` passed with expected warnings for feature branch and dirty docs worktree.
  - `python3 -m py_compile .codex/tools/crate_doctor.py .codex/tools/codex_thread_control.py` passed.
  - `git diff --check` passed.
  - trailing-whitespace scan was clean.
  - repo-wide ASCII scan found pre-existing non-ASCII in historical QA state text; no new ops docs intentionally use non-ASCII.
- Formalization:
  - committed as `b839b74` (`Formalize Crate ops loop layer`)
  - pushed branch `codex/crate-ops-loop-hardening`
  - opened PR #121: `https://github.com/bfeintuch123/crate-app/pull/121`

### Next Action

- Review PR #121 and run merge-readiness if Bryant wants it merged.

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

### qa.42 Post-Redesign Smoke Result

- Internal QA prerelease `v2.8.0-qa.42` passed the post-redesign renderer smoke on Jenna's Mac.
- Installed app metadata was correct:
  - `/Applications/Crate.app`
  - version `2.8.0-qa.42`
  - bundle ID `com.crate.app`
  - Apple Events usage string present
  - Apple Events entitlement present
  - previous qa41 app moved to Trash before install
- Redesign validation passed:
  - default launch lands on `Projects`
  - no `Home`
  - no top-level `Files`
  - nav labels are `Projects`, `Current Project`, `Settings`, `Help`
  - Quick Package is prominent but not a nav tab
  - Current Project workspace is reachable
  - Settings and Help are reachable
  - Crate wordmark is intact
- Functional spot checks passed:
  - Projects create/start/watch
  - Current Project no-project, no-files, watching, ready, and Needs save states
  - Illustrator Smoke 2 no-save linked JPG
  - Package Review, Package Complete, and Package Details
  - Diagnostics OFF and ON placement
  - Quick Package scoped output and quota increment
- Figma Pro Current Page Only was not run in this qa42 pass because no fresh approved page-node link was used.
- Privacy and package-scope checks were clean:
  - no token, full Figma URL, file key, signed URL, or unrelated private path leakage
  - package-output folders excluded
  - old QA roots excluded
  - diagnostics isolated only when enabled

### qa.42 Follow-Ups

- Bryant noted from the screenshot that the redesigned app feels visually cluttered: too many boxes/items spread across the workspace. This is a UI/design polish issue to review with Jenna, not a qa42 functional blocker.
- Empty Projects copy currently says `No active projects`; Jenna/Bryant may prefer `No projects yet`.
- Package Review shows `FIGMA SCOPE Current Page Only` even for non-Figma projects such as PowerPoint. This should be treated as a renderer copy/conditional-visibility follow-up before tester rollout.
- qa42 briefly staged an already-open stale Illustrator qa40 document when a new project started before Illustrator was closed. Cleanup fixed the lane and no package contamination occurred. Keep as a product/session-scope decision: Crate may capture already-open creative documents at watch start, so tester prompts should close unrelated creative apps before each lane unless Bryant decides to make the app stricter.

### Recommended Next Action

- Do not run a failure loop for qa42 core functionality.
- First, Bryant and Jenna should review the screenshot and decide the simpler visual layout direction.
- Then run a small renderer-only polish pass for:
  - conditional Figma scope row visibility
  - empty-state copy
  - reduced visual clutter/density in Projects and Current Project
- After that, prepare qa43 if code changes land.

### qa.42 Renderer Polish PR

- Opened draft PR #112: `codex/qa42-renderer-polish` into `v2.4.x`.
- Scope:
  - hide Package Review Figma scope/warning rows unless the project has actual Figma context
  - change Projects empty state copy to `No projects yet`
  - add renderer regression coverage for Figma vs non-Figma package-review scope visibility
- Changed app/test files:
  - `renderer/app.js`
  - `renderer/index.html`
  - `tests/renderer-figma-scope.test.js`
- Merge-readiness review was clean:
  - base `v2.4.x`
  - branch mergeable
  - no package engine/parser/provenance/dependency/crate-web changes
  - focused checks passed

### qa.43 Internal QA Prerelease

- PR #112 was merged into `v2.4.x`.
- Merge commit: `22aee850cdb527bf8a6ecff3ea4d60df161cfcb5`.
- Prepared internal QA prerelease `v2.8.0-qa.43`.
- Release commit: `87c47f4271e2a695ba9c48ad8d45880e93ddfa04`.
- GitHub prerelease: `https://github.com/bfeintuch123/crate-app/releases/tag/v2.8.0-qa.43`.
- Direct DMG: `https://github.com/bfeintuch123/crate-app/releases/download/v2.8.0-qa.43/Crate-2.8.0-qa.43-arm64.dmg`.
- Release commit changed only:
  - `package.json`
  - `package-lock.json`
- Internal QA release guardrails held:
  - no public final `v2.8.0`
  - no get-crate.com update
  - no crate-web/site deploy
  - no dependency mutation
  - no package engine/parser/provenance changes
- Build validation:
  - signed/notarized/stapled app passed validation
  - DMG envelope was signed, notarized, stapled, and accepted by Gatekeeper
  - mounted DMG app reports version `2.8.0-qa.43`
  - Apple Events usage string and entitlement are present
  - packaged ASAR contains the PR #112 renderer fix:
    - `No projects yet`
    - Figma scope row hidden by default
    - Figma context predicate present
    - no Home tab
    - no top-level Files tab
    - Current Project nav present
- qa43 smoke target:
  - non-Figma Package Review must not show Figma Scope
  - Figma Package Review must still show Current Page Only / Entire File scope
  - empty Projects copy should say `No projects yet`
  - rerun the core qa42 redesign smoke spot checks at lightweight level

### qa.43 Jenna Smoke Result

- Jenna's Mac completed the targeted post-redesign renderer smoke for `v2.8.0-qa.43`.
- Result: PASS.
- Installed app metadata was correct:
  - `/Applications/Crate.app`
  - version `2.8.0-qa.43`
  - bundle ID `com.crate.app`
  - Apple Events usage string present
  - Apple Events entitlement present
  - prior app moved to Trash before install
- Redesign checks passed:
  - default launch lands on Projects
  - no Home view
  - no top-level Files tab
  - nav labels are `Projects`, `Current Project`, `Settings`, `Help`
  - Quick Package is prominent but not a primary nav tab
  - empty copy is `No projects yet`
  - Help reachable
- PR #112 regression passed:
  - non-Figma PowerPoint Package Review did not show `Figma Scope` or `Current Page Only`
- Functional spot checks passed:
  - Diagnostics OFF normal project
  - Diagnostics ON normal project with diagnostics isolated under `Crate Diagnostics/crate-provenance.json`
  - Quick Package scoped output and quota increment
  - Illustrator Smoke 2 no-save linked JPG
- Figma Package Review regression was skipped because no fresh safe approved Pro workspace page-node link was available.
- Privacy and package-scope checks were clean:
  - no package-output folder inclusion
  - no old QA root inclusion
  - no unused control inclusion
  - no root `crate-provenance.json`
  - no token, Figma URL, file key, signed URL, auth, or Bearer markers
- Non-blocking follow-ups:
  - Quick Package still defaults output to Desktop, which Bryant has accepted.
  - Package Review still shows the general PowerPoint/Keynote save-before-packaging reminder even when the fixture was already saved; output/package behavior was correct.

### Updated Next Action

- qa43 is a clean targeted pass.
- Next engineering/design work should wait for Bryant and Jenna's broader UI review, unless Bryant wants to address the presentation save-reminder copy before that review.

### External Control Layer Progress

- Bryant started the Crate external-control workstream with the goal of making this source-of-truth thread able to create/message/read/list persistent user-owned Crate threads when those tools are exposed.
- Tool discovery confirmed persistent user-owned thread tools are not currently exposed in this session:
  - `create_thread`
  - `send_message_to_thread`
  - `read_thread`
  - `list_threads`
  - related persistent thread-management tools
- Tool discovery confirmed sub-agent controls are exposed:
  - `spawn_agent`
  - `send_input`
  - `wait_agent`
  - `resume_agent`
  - `close_agent`
- A read-only probe sub-agent successfully accessed the Crate repo, read the repo/router/workstream guardrails, confirmed `v2.4.x`, and reported that sidecar Crate agents should operate read-only by default under this source-of-truth thread.
- Added `.codex/playbooks/crate-external-control-layer.md`.
- Updated `AGENTS.md`, `.codex/ROUTER.md`, and `.codex/decisions/v2.8-crate-thread-orchestration-source-of-truth.md` to route Crate external-control requests through the new playbook.
- Current operating model:
  - this thread remains Crate source of truth
  - persistent user-owned thread tools should be used directly when exposed
  - until they are exposed, sub-agents are available for bounded read-only sidecar work
  - paste-ready prompts remain the fallback only when a visible user-owned sidebar thread is needed and thread tools are unavailable

### External Control Layer Remaining Gap

- Native model-visible thread tools are still not exposed in this session.
- However, a local Codex app-server bridge is now implemented and verified:
  - `.codex/tools/codex_thread_control.py`
  - uses local app-server protocol methods:
    - `thread/start`
    - `thread/list`
    - `thread/read`
    - `thread/name/set`
    - `thread/resume`
    - `turn/start`
- Verified bridge probe:
  - created persistent thread `Crate Control Probe`
  - thread id `019f1601-f049-72a0-a5cb-841a4b306598`
  - workspace `/Users/bryantfeintuchclaw/Projects`
  - sent prompt: `External control probe: reply PONG only. Do not edit files.`
  - read persisted response: `PONG`
- Current operating model:
  - this source-of-truth thread should use the bridge for persistent Crate side threads when native thread tools are unavailable
  - use sub-agents for bounded sidecar work
  - use paste-ready prompts only if both bridge/native thread control are unavailable or Bryant explicitly wants manual control
- Remaining nice-to-have:
  - native model-visible tools would still be cleaner than shelling through the app-server bridge:
    - `create_thread`
    - `send_message_to_thread`
    - `read_thread`
    - `list_threads`
    - title/pin/archive tools

### qa43 Redesign Layout Feedback And Local CSS Polish

- Bryant reviewed the qa43 redesigned app on the Mac mini and flagged layout polish before reviewing with Jenna:
  - Projects and other workspace surfaces should extend closer to the app edges.
  - Workspace panels should grow when the window grows, not visually shrink or stay capped.
  - The same responsive behavior should apply across Projects, Current Project, Quick Package, Settings, and Help.
  - Settings specifically looked messy: sections were visually stacked too tightly and appeared to sit on top of each other.
- Local renderer-only CSS polish was applied in `renderer/styles.css`:
  - reduced outer app/content padding
  - removed the late redesign layer's `920px` content cap
  - made main tab surfaces full-width/responsive
  - changed Settings into one full-width settings surface with a responsive internal grid, consistent gaps, and full-width large sections
  - added Quick Package to the same full-width surface sizing behavior as Projects and Current Project
- No backend/package-engine/parser/provenance/dependency/release files were touched.
- Checks run:
  - `node --check renderer/app.js`
  - `git diff --check -- renderer/styles.css`
- Local `npm start` preview eventually produced a visible Electron window and confirmed:
  - Projects rows now stretch wider with the app window.
  - Settings no longer appears as a stack of overlapping cards; Naming/Preferences sit across the top and Figma/Quota use wider sections.
- Preview screenshot captured at `/tmp/crate-qa44-settings-layout-preview.png`.
- Follow-up renderer-only polish moved Quick Package out of Projects:
  - Quick Package is now its own primary sidebar tab between Projects and Current Project.
  - The old Quick Package sidebar shortcut and scroll-to-Projects behavior were removed.
  - Quick Package keeps the existing drag/drop/browse behavior and remains wired to the same renderer handlers.
- Sidebar tab styling was adjusted toward the Figma mockup:
  - dark-sidebar active tab treatment
  - small square indicators
  - muted inactive labels instead of large pale active pills
- The soft pink/green/cream background treatment was strengthened on both the app shell and content surface so the mockup color direction is visible in-app.
- The Projects list `+ Add Project` action was restored to a black primary button to match the older Crate builds instead of the pale outline treatment.
- This polish was finalized as PR #113:
  - branch `codex/qa44-redesign-layout-polish`
  - PR `https://github.com/bfeintuch123/crate-app/pull/113`
  - merge commit `0c2d42659a0c9817d9c4c300debc9c5708b28184`
- Internal QA prerelease `v2.8.0-qa.44` was prepared from latest `origin/v2.4.x`:
  - release commit `42ac2a5` (`Prepare v2.8.0-qa.44 QA prerelease`)
  - tag `v2.8.0-qa.44`
  - GitHub prerelease `https://github.com/bfeintuch123/crate-app/releases/tag/v2.8.0-qa.44`
  - direct DMG `https://github.com/bfeintuch123/crate-app/releases/download/v2.8.0-qa.44/Crate-2.8.0-qa.44-arm64.dmg`
- qa.44 build validation:
  - app version `2.8.0-qa.44`
  - bundle id `com.crate.app`
  - signed app verifies with `codesign --verify --deep --strict`
  - mounted DMG app is accepted by Gatekeeper as `Notarized Developer ID`
  - stapler validation passed for the app inside the DMG
  - DMG container itself is not signed/stapled under the current electron-builder config, matching the existing app-notarization path
- qa.44 scope remains internal QA only:
  - no get-crate.com update
  - no crate-web deploy
  - no final public v2.8.0 release
  - no package-engine/parser/provenance/dependency mutation

### qa44 Visual And Alert QA

- Jenna-machine qa.44 visual confirmation passed:
  - app opened to Projects
  - no Home and no top-level Files tab
  - sidebar order is `Projects`, `Quick Package`, `Current Project`, `Settings`, `Help`
  - Quick Package is a primary sidebar tab
  - Projects surface expands wider with app width
  - Add Project button is black/dark primary
  - Settings spacing/layout is no longer cramped or overlapping
  - Help is reachable
  - background/gradient treatment is visible
- One visual state was not confirmed in that pass:
  - `Current Project / No Project Selected`, because prior qa43 project records persisted
- Alert confirmation:
  - Settings `Package alerts` was ON
  - visible inactivity alert passed after the 10-minute threshold
  - package-complete screen and Package Details passed
  - foreground native `Project Packaged!` notification was not observed; classify as inconclusive because macOS may suppress visible banners while Crate is foregrounded
- Background package-alert confirmation was blocked before package:
  - after relaunch, Crate process was running but exposed zero windows
  - `System Events` reported `windows=0`
  - `open`, `open -n`, `Show All`, and `Bring All to Front` did not restore a visible window
  - background notification lane could not confirm macOS notification permission or native package-complete notification
- Current interpretation:
  - do not classify package-complete notification as app bug yet
  - first run a focused visible-window recovery / clean relaunch check
  - if window recovery is stable, rerun background package-alert lane
  - if Crate again runs with zero windows after relaunch, route to Autonomous Crate Failure Loop for installed-app lifecycle/window restore

### qa44 Zero-Window Failure And qa45 Recovery Build

- qa44 zero-window isolation failed:
  - force quit and fresh open started the Crate process, but visible windows stayed at `0`
  - Dock icon was present, but Dock click, `Show All`, `Bring All to Front`, and normal app open did not restore a window
  - moving the active Crate config aside for a temporary fresh-config launch still produced `windows=0`
  - restored config also reproduced `windows=0`
  - fresh-config launch log category checks did not show renderer load failure, renderer process exit, startup initialization failure, uncaught exception, crash, permission error, or other logged error category
- Ran the Autonomous Crate Failure Loop full stack for the installed-app lifecycle/window restore blocker.
- PR #114 fixed lifecycle/window restoration hardening:
  - branch `codex/qa44-window-lifecycle-restore`
  - PR `https://github.com/bfeintuch123/crate-app/pull/114`
  - merge commit `cac6888a035e607cf655be25e92bcca28f23dff8`
  - changed `main.js` and `tests/main-window-lifecycle.test.js`
  - fix reconnects to existing BrowserWindow instances, calls `app.show()` before foreground restore, adds startup show retries, handles `did-become-active`, and preserves the existing no-quit-on-window-close behavior without forcing red-close auto-reopen
- qa45 internal QA prerelease was prepared from latest `origin/v2.4.x`:
  - release commit `24d239b` (`Prepare v2.8.0-qa.45 QA prerelease`)
  - tag `v2.8.0-qa.45`
  - GitHub prerelease `https://github.com/bfeintuch123/crate-app/releases/tag/v2.8.0-qa.45`
  - direct DMG `https://github.com/bfeintuch123/crate-app/releases/download/v2.8.0-qa.45/Crate-2.8.0-qa.45-arm64.dmg`
- qa45 build validation:
  - app version `2.8.0-qa.45`
  - bundle id `com.crate.app`
  - built app and mounted-DMG app pass `codesign --verify --deep --strict`
  - built app and mounted-DMG app pass `xcrun stapler validate`
  - built app and mounted-DMG app are accepted by Gatekeeper as `Notarized Developer ID`
  - release assets include DMG, DMG blockmap, ZIP, ZIP blockmap, and `latest-mac.yml`
- qa45 scope remains internal QA only:
  - no get-crate.com update
  - no crate-web deploy
  - no final public v2.8.0 release
  - no dependency mutation
  - no package-engine/parser/provenance changes
- Next qa45 validation target on Jenna's Mac:
  - delete old `/Applications/Crate.app`, install qa45, and confirm visible Projects window after clean launch
  - repeat clean launch after force quit
  - confirm Dock/app activation restores a visible window when the process is running
  - if visible-window recovery passes, rerun background package-alert lane
  - confirm qa44 visual layout remains present at spot-check level

### qa45 Zero-Window Failure And PR #115

- Jenna-machine qa45 install passed, but zero-window recovery still failed:
  - old `/Applications/Crate.app` moved to Trash
  - installed app reported `2.8.0-qa.45`, bundle id `com.crate.app`, correct process path, Apple Events usage string, and Apple Events entitlement
  - force quit left no Crate process
  - fresh launch started the Crate process but still showed `windows=0`
  - Dock click, `Show All`, `Bring All to Front`, and `Window > Crate` did not restore a visible window
  - temporary fresh config also produced `windows=0`
  - original config was restored and still produced `windows=0`
- Ran the Autonomous Crate Failure Loop full stack again for the continuing installed-app lifecycle/window creation failure.
- PR #115 merged into `v2.4.x`:
  - branch `codex/qa45-zero-window-lifecycle`
  - PR `https://github.com/bfeintuch123/crate-app/pull/115`
  - merge commit `dace1b736ba860a68d270ec172482cf0ad71d1a1`
  - changed `main.js` and `tests/main-window-lifecycle.test.js`
- PR #115 lifecycle hardening:
  - schedules startup retries before first BrowserWindow creation, so transient creation errors still get recovery attempts
  - treats existing-but-hidden main windows as failed show attempts and recreates after repeated hidden checks
  - discards cached `BrowserWindow` references missing from Electron's live window list
  - prevents an old hidden window's late `closed` event from clearing the replacement main-window reference
- Checks passed:
  - high-severity audit gate passed; known moderate `uuid` advisory remains and was not remediated because it requires a forced breaking upgrade
  - syntax checks for main, provenance, renderer, parsers, and dual-write test file passed
  - lifecycle, provenance, provenance dual-write, PSD, Figma scope/link/token privacy, renderer Figma, and Quick Package parser tests passed
  - local `npm start` smoke showed `windows=1` and `frontmost=true`
  - `git diff --check` passed
- One temporary dual-write test failure occurred only when global-stub-heavy main-process suites were run in parallel. The isolated test and the full dual-write suite run alone both passed.
- Next needed release-gate:
  - prepare internal QA prerelease `v2.8.0-qa.46` from latest `origin/v2.4.x`
  - validate PR #115 / merge commit `dace1b736ba860a68d270ec172482cf0ad71d1a1` in the signed app
  - do not update get-crate.com, crate-web, final public release, dependencies, package engine, parser, or provenance behavior

### qa46 Release Gate For PR #115

- Prepared internal QA prerelease `v2.8.0-qa.46` from latest `origin/v2.4.x`.
- Validated PR #115 / merge commit `dace1b736ba860a68d270ec172482cf0ad71d1a1` in the signed app.
- Release commit: `ba74ab5ba773b24504334fea8815abaec299b5dc` (`Prepare v2.8.0-qa.46 QA prerelease`)
- Tag: `v2.8.0-qa.46`
- GitHub prerelease: `https://github.com/bfeintuch123/crate-app/releases/tag/v2.8.0-qa.46`
- Direct DMG: `https://github.com/bfeintuch123/crate-app/releases/download/v2.8.0-qa.46/Crate-2.8.0-qa.46-arm64.dmg`
- Release assets:
  - `Crate-2.8.0-qa.46-arm64.dmg`
  - `Crate-2.8.0-qa.46-arm64.dmg.blockmap`
  - `Crate-2.8.0-qa.46-arm64-mac.zip`
  - `Crate-2.8.0-qa.46-arm64-mac.zip.blockmap`
  - `latest-mac.yml`
- Build validation:
  - built app and mounted-DMG app report version `2.8.0-qa.46`
  - bundle id `com.crate.app`
  - built app and mounted-DMG app pass `codesign --verify --deep --strict`
  - built app and mounted-DMG app pass `xcrun stapler validate`
  - built app and mounted-DMG app are accepted by Gatekeeper as `Notarized Developer ID`
  - app ASARs contain PR #115 lifecycle markers: `MAIN_WINDOW_HIDDEN_RECREATE_AFTER`, cached-window live-list recreation, and `recreate-hidden-window`
  - `latest-mac.yml` points to qa46 ZIP and DMG artifacts
- Checks passed before build:
  - `npm audit --audit-level=high`
  - `node --check main.js`
  - `node --check provenance.js`
  - `node --check renderer/app.js`
  - parser syntax checks
  - `node --test tests/main-window-lifecycle.test.js`
  - provenance, PSD, Figma scope/link/token privacy, renderer Figma, Quick Package parser, and provenance dual-write suites
- Known non-blocking release-gate note:
  - high-severity audit gate passed; known moderate `uuid` advisory remains and requires a forced breaking upgrade, so dependencies were not changed.
  - DMG envelope itself remains unsigned/unstapled under current builder config; the app inside validates, matching the existing internal QA notarization path.
- Scope kept:
  - no get-crate.com update
  - no crate-web deploy
  - no final public v2.8.0 release
  - no dependency mutation
  - no package-engine/parser/provenance changes
  - package metadata bump only in `package.json` and `package-lock.json`
- Next Jenna-machine validation:
  - delete old `/Applications/Crate.app` before installing qa46
  - confirm clean launch opens a visible Projects window
  - confirm force quit/reopen restores a visible window
  - confirm Dock/app activation restores a visible window when process is running
  - if needed, confirm temporary fresh config launch also opens a visible window
  - if visible-window recovery passes, rerun background package-alert lane
  - spot-check qa44 visual layout and privacy behavior

### qa46 Jenna-Machine Result

- qa46 installed successfully on Jenna's Mac:
  - app path `/Applications/Crate.app`
  - version `2.8.0-qa.46`
  - bundle id `com.crate.app`
  - process path `/Applications/Crate.app/Contents/MacOS/Crate`
  - Apple Events usage string present
  - Apple Events entitlement present
  - old app moved to Trash during install
- Zero-window recovery: PASS.
  - force quit/reopen worked
  - `System Events`: `process_count=1`, `windows=1`
  - Dock icon present
  - Dock click restored/brought Crate forward
  - fresh config fallback not needed
- Visual layout: PASS.
  - default launch Projects
  - no Home
  - no top-level Files
  - sidebar `Projects`, `Quick Package`, `Current Project`, `Settings`, `Help`
  - Quick Package primary tab
  - Add Project / Start Project dark primary
  - wide responsive surfaces
  - Settings spacing clean, no overlap
  - Package alerts ON, Diagnostics OFF, Package Details ON
- Background package-alert lane: PARTIAL PASS.
  - clean project `Jenna qa46 Background Package Alert QA`
  - safe fixture `Crate qa46 Background Alert Fixture.pptx`
  - Package Complete appeared after returning to Crate
  - Package Details opened
  - package counter incremented `4/10` to `5/10`
  - output contained fixture PPTX plus one extracted image
  - Diagnostics OFF emitted no diagnostics folder or root provenance
  - package-output recapture absent
  - targeted privacy grep clean
  - native macOS package-complete notification while backgrounded was not observed
  - macOS notification permission was not confirmed; private Notification Center content was not inspected
- Classification:
  - qa46 fixes the release-blocking zero-window lifecycle issue.
  - qa46 passes visual layout, package correctness, Package Complete, Package Details, quota increment, and privacy/scope checks for this lane.
  - native package-complete notification delivery remains a focused follow-up, likely notification permission/delivery/order related until proven otherwise.
- Next recommended action:
  - decide whether native package-complete notification delivery is required before tester rollout.
  - if required, run a focused notification triage loop before another broad QA build.

### qa47 Notification Fix + Release Gate

- Focused notification triage loop completed for qa46 remaining alert issue.
- Root cause addressed:
  - successful project packaging always called `showTrayWindow()` after scheduling the native notification.
  - when Crate was intentionally backgrounded during packaging, immediately foregrounding Crate could suppress or hide the native macOS package-complete banner.
- PR #116:
  - URL: `https://github.com/bfeintuch123/crate-app/pull/116`
  - branch: `codex/qa46-package-notification-delivery`
  - merge commit: `bbbbe0c`
  - changed files: `main.js`, `tests/provenance-dual-write.test.js`
- Fix summary:
  - added focused `showPackageCompleteNotification()`.
  - retained native notification objects in `activeNativeNotifications` until close/failure.
  - if native notification delivery succeeds while Crate is backgrounded, Crate leaves focus alone so macOS can show the banner.
  - clicking the native notification brings Crate forward.
  - if native notification delivery fails, Crate logs a privacy-safe failure category and falls back to showing the app window.
  - if native notifications are unavailable, Crate still shows the app window after package success.
- Checks passed:
  - `node --check main.js`
  - `node --check tests/provenance-dual-write.test.js`
  - `node --test tests/provenance-dual-write.test.js` (103/103)
  - `git diff --check`
  - `npm audit --audit-level=high`
- Audit note:
  - high-severity gate passed.
  - known moderate `uuid` advisory remains and would require a breaking `npm audit fix --force`; dependencies were not mutated.
- qa47 release-gate result:
  - Release commit: `81f6615` (`Prepare v2.8.0-qa.47 QA prerelease`)
  - Tag: `v2.8.0-qa.47`
  - GitHub prerelease: `https://github.com/bfeintuch123/crate-app/releases/tag/v2.8.0-qa.47`
  - Direct DMG: `https://github.com/bfeintuch123/crate-app/releases/download/v2.8.0-qa.47/Crate-2.8.0-qa.47-arm64.dmg`
  - built app and mounted-DMG app report version `2.8.0-qa.47`
  - bundle id `com.crate.app`
  - built app and mounted-DMG app pass `codesign --verify --deep --strict`
  - built app and mounted-DMG app are accepted by Gatekeeper as `Notarized Developer ID`
  - built app passes `xcrun stapler validate`
  - app ASAR contains PR #116 markers: `showPackageCompleteNotification`, `activeNativeNotifications`, `packageWindowWasForeground`, and `package-notification-failed`
  - release assets include DMG, DMG blockmap, ZIP, ZIP blockmap, and `latest-mac.yml`
- Scope kept:
  - no get-crate.com update
  - no crate-web deploy
  - no final public v2.8.0 release
  - no dependency mutation
  - no package-engine/parser/provenance behavior change
  - package metadata bump only in `package.json` and `package-lock.json`
- Next Jenna-machine validation:
  - install qa47 after moving old `/Applications/Crate.app` to Trash
  - confirm visible Projects launch and Dock/activation recovery remain passing
  - confirm Package alerts is ON
  - safely confirm macOS Notifications permission for Crate if visible in System Settings
  - package a safe fixture while Crate is backgrounded
  - expect native `Project Packaged!` notification while Crate remains backgrounded, if macOS permission allows
  - click the notification and confirm it brings Crate forward
  - confirm Package Complete, Package Details, quota increment, scoped output, and privacy checks remain passing

### qa48 Projects Button + Notification Focus Follow-Up

- Jenna-machine qa47 result:
  - install/window recovery passed
  - package/output behavior passed
  - Package alerts was ON and macOS Crate notification permission was allowed
  - background package notification failed because Crate became frontmost at about `t+1s` after destination confirmation
  - no native package-complete notification appeared
- Root cause found:
  - qa47 fixed the package-success foreground path, but `projects:select-output` still called `showTrayWindow()` immediately after the package destination picker closed.
  - this meant Crate could steal focus before package completion, preventing the native package-complete banner from surfacing.
- PR #117:
  - URL: `https://github.com/bfeintuch123/crate-app/pull/117`
  - branch: `codex/qa47-project-add-button-align`
  - merge commit: `244a18c0632cad80d1a367c71c8cd07c0df41baa`
  - changed files: `main.js`, `renderer/index.html`, `renderer/styles.css`, `tests/provenance-dual-write.test.js`
- Fix summary:
  - `+ Add Project` in the populated Projects list is now right-aligned and narrower to visually match project status/action pills.
  - successful package destination selection no longer foregrounds Crate.
  - canceling the destination picker still restores Crate so the user can keep working.
  - added a regression test proving confirmed output selection does not foreground Crate.
- Full-stack review notes:
  - PR base was `v2.4.x`, mergeable, and clean.
  - changed files stayed in scoped UI/package-focus/test surfaces.
  - no dependency, crate-web, parser, provenance, Figma, release-site, or broad watcher changes.
  - security/provenance review found no new token, path, manifest, package escape, or Figma privacy surface.
  - full `tests/provenance-dual-write.test.js` run passed the new tests but had one unrelated Illustrator process-detection flicker; the exact failing test passed on isolated rerun.
- Checks passed:
  - `node --check main.js`
  - `node --check renderer/app.js`
  - `node --check tests/provenance-dual-write.test.js`
  - `git diff --check`
  - `git diff --check origin/v2.4.x...HEAD`
  - `node --test --test-name-pattern "background project package|package destination selection" tests/provenance-dual-write.test.js`
  - `node --test --test-name-pattern "Illustrator running detection recognizes realistic command paths" tests/provenance-dual-write.test.js`
  - `node --test tests/main-window-lifecycle.test.js`
  - `node --test tests/quick-package-parser.test.js`
  - `node --test tests/provenance.test.js`
  - `npm audit --audit-level=high`
- Audit note:
  - high-severity gate passed.
  - known moderate `uuid` advisory remains and would require a breaking `npm audit fix --force`; dependencies were not mutated.
- qa48 release-gate result:
  - Release commit: `92e6bdb` (`Prepare v2.8.0-qa.48 QA prerelease`)
  - Tag: `v2.8.0-qa.48`
  - GitHub prerelease: `https://github.com/bfeintuch123/crate-app/releases/tag/v2.8.0-qa.48`
  - Direct DMG: `https://github.com/bfeintuch123/crate-app/releases/download/v2.8.0-qa.48/Crate-2.8.0-qa.48-arm64.dmg`
  - built app and mounted-DMG app report version `2.8.0-qa.48`
  - bundle id `com.crate.app`
  - built app and mounted-DMG app pass `codesign --verify --deep --strict`
  - built app and mounted-DMG app are accepted by Gatekeeper as `Notarized Developer ID`
  - built app passes `xcrun stapler validate`
  - app ASAR contains PR #117 markers: `project-list-actions`, `btn-add-project`, and background-safe destination selection copy
  - release assets include DMG, DMG blockmap, ZIP, ZIP blockmap, and `latest-mac.yml`
- Scope kept:
  - no get-crate.com update
  - no crate-web deploy
  - no final public v2.8.0 release
  - no dependency mutation
  - no parser/provenance behavior change
  - package metadata bump only in `package.json` and `package-lock.json`
- Next Jenna-machine validation:
  - install qa48 after moving old `/Applications/Crate.app` to Trash
  - confirm visible Projects launch and Dock/activation recovery remain passing
  - confirm populated Projects `+ Add Project` button is right-aligned and visually narrower
  - confirm Package alerts is ON and macOS notification permission is allowed
  - package a safe fixture while Crate is backgrounded immediately after destination confirmation
  - expect Crate to stay backgrounded until notification click or manual return
  - expect native `Project Packaged!` banner if macOS permission allows
  - confirm Package Complete, Package Details, quota increment, scoped output, and privacy checks remain passing

### qa49 Notification Focus + Rollover Quota Release Gate

- Bryant approved merging PR #118 if merge-readiness remained clean, then preparing qa49 for Jenna-machine validation.
- PR #118:
  - URL: `https://github.com/bfeintuch123/crate-app/pull/118`
  - branch: `codex/qa48-notification-quota-fix`
  - base: `v2.4.x`
  - merge state before merge: clean / mergeable
  - merge commit: `17eb7c665b6ed97a37c4d14057277f24d94601a5`
  - changed files: `main.js`, `tests/provenance-dual-write.test.js`
- Fix summary:
  - successful package destination selection now starts a focused package-background handoff window instead of bringing Crate foreground.
  - package-complete notification delivery respects that handoff window even if Electron reports stale foreground state.
  - native notification failure no longer forces foreground during the handoff window.
  - notification click still brings Crate forward.
  - Dock/app activation remains able to restore a visible Crate window.
  - quota reset now uses local-month reset-date formatting so successful packages still increment correctly on UTC/local rollover days.
- Review/checks:
  - PR base confirmed `v2.4.x`.
  - changed files stayed scoped to package focus/quota logic and tests.
  - high-severity audit gate passed; known moderate `uuid` advisory remains and was not mutated.
  - syntax checks passed for `main.js`, `provenance.js`, `renderer/app.js`, selected parsers, and touched tests.
  - focused notification/quota tests passed.
  - main window lifecycle, Quick Package parser, provenance, PSD, Figma scope/link/token/privacy, and renderer Figma scope tests passed at appropriate scope.
  - one full dual-write run had an unrelated process-detection timing flicker; the exact test passed on isolated rerun.
  - `git diff --check` passed.
- qa49 release-gate result:
  - Release commit: `7e947023bbcc5ab613dd81a976322727304dffd4` (`Prepare v2.8.0-qa.49 QA prerelease`)
  - Tag: `v2.8.0-qa.49`
  - GitHub prerelease: `https://github.com/bfeintuch123/crate-app/releases/tag/v2.8.0-qa.49`
  - Direct DMG: `https://github.com/bfeintuch123/crate-app/releases/download/v2.8.0-qa.49/Crate-2.8.0-qa.49-arm64.dmg`
  - app version in built app and mounted DMG: `2.8.0-qa.49`
  - bundle id `com.crate.app`
  - built app and mounted-DMG app pass `codesign --verify --deep --strict`
  - built app and mounted-DMG app are accepted by Gatekeeper as `Notarized Developer ID`
  - built app passes `xcrun stapler validate`
  - DMG container was signed, notarized, stapled, and accepted by Gatekeeper
  - release assets include DMG, DMG blockmap, ZIP, ZIP blockmap, and `latest-mac.yml`
- Scope kept:
  - no get-crate.com update
  - no crate-web deploy
  - no final public v2.8.0 release
  - no dependency mutation
  - no parser/provenance behavior change
  - package metadata bump only in `package.json` and `package-lock.json`
- Next Jenna-machine validation:
  - install qa49 after moving old `/Applications/Crate.app` to Trash
  - confirm visible Projects launch, force-quit/reopen, and Dock/app activation remain passing
  - confirm qa48 visual polish remains: no Home, no top-level Files, sidebar `Projects / Quick Package / Current Project / Settings / Help`, Quick Package primary tab, right-aligned dark `+ Add Project`, wide surfaces, and clean Settings spacing
  - confirm Package alerts is ON and macOS Notifications permission for Crate is allowed if visible safely
  - package a safe fixture while Crate is backgrounded immediately after destination confirmation
  - expect Crate to stay backgrounded until notification click or manual return
  - expect native `Project Packaged!` notification if macOS permission allows
  - confirm Package Complete, Package Details, quota increment on month-boundary/reset-day state, quota-block no-output behavior, scoped output, and privacy checks remain passing

### qa49 Jenna-Machine Validation Result

- Installed app:
  - version `2.8.0-qa.49`
  - bundle id `com.crate.app`
  - process path `/Applications/Crate.app/Contents/MacOS/Crate`
  - Apple Events usage string present
  - Apple Events entitlement present
  - old app moved to Trash before install
- Visual/window checks: PASS.
  - clean launch opened visible Projects window
  - force quit/reopen restored visible window
  - Dock/app activation brought Crate forward
  - no Home
  - no top-level Files
  - sidebar: `Projects`, `Quick Package`, `Current Project`, `Settings`, `Help`
  - Quick Package is a primary tab
  - `+ Add Project` is dark, narrower, and right-aligned under project rows
  - wide surfaces and Settings spacing remain intact
- Notification/package lane: PARTIAL.
  - Package alerts ON
  - macOS notification permission allowed with Temporary banner style
  - Diagnostics OFF
  - Package Details ON
  - project: `Jenna qa49 Background Package Alert QA`
  - fixture: `Crate qa49 Background Alert Fixture.pptx`
  - output path stayed within approved qa49 package-output root
  - Crate stayed backgrounded after `Package Now`; Finder remained frontmost from `t+1` through `t+5`
  - native `Project Packaged!` notification was not observed
  - Package Complete: PASS
  - Package Details: PASS
- Quota/output lane: PASS.
  - counter/config moved from `0/10` to `1/10`
  - temporary `10/10` quota block showed existing limit flow
  - quota-block output was not written
  - counter restored to `1/10`
  - output files were only the fixture PPTX and expected extracted image
  - no diagnostics folder with Diagnostics OFF
  - no root `crate-provenance.json`
  - no package-output recapture
  - no stale QA roots
  - targeted privacy grep clean for token/Figma URL/file key/signed URL/private-path markers
- Classification:
  - qa49 fixed the qa48/qa47 focus and quota failures.
  - qa49 is not fully release-clear if native package-complete banner delivery is required before testers.
  - remaining issue is limited to native notification delivery while backgrounded; package correctness, quota, focus, and privacy are clean.
- Next recommendation:
  - run one focused notification failure loop if Bryant wants native package-complete banner as a tester-readiness requirement.
  - likely code area: `showPackageCompleteNotification()` and package-completion notification timing/options, compared with the inactivity notification path that has shown visible alerts.
  - keep scope narrow and preserve background focus, quota increment, Package Complete/Details, package output scope, and privacy behavior.

### qa50 Native Package Notification Release Gate

- Bryant approved committing, pushing, opening PR, running merge-readiness, merging if clean, then preparing qa50 for native package-complete notification validation.
- PR #119:
  - URL: `https://github.com/bfeintuch123/crate-app/pull/119`
  - branch: `codex/qa49-native-notification-delivery`
  - base: `v2.4.x`
  - merge commit: `d70e927308f6e7a5d2b0154393ebf9c0a3f50f25`
  - changed files: `main.js`, `tests/provenance-dual-write.test.js`
- Fix summary:
  - package-complete native notification now uses an explicit show delay for background package handoff cases.
  - package-complete notification includes a non-silent native notification configuration and app icon when available.
  - click-to-open behavior remains intact.
  - background package tests assert the notification is created before delayed show and shown later while Crate stays hidden.
- Merge-readiness:
  - PR base confirmed `v2.4.x`.
  - changed files stayed scoped to notification delivery and tests.
  - merge state was clean / mergeable.
  - focused notification/quota tests passed before merge.
  - no dependency, crate-web, parser, provenance, Figma, package-scope, or release-site changes.
- Release-gate checks passed:
  - `npm audit --audit-level=high` passed; known moderate `uuid` advisory remains and was not force-fixed.
  - syntax checks passed for `main.js`, `provenance.js`, `renderer/app.js`, selected parsers, and touched tests.
  - focused notification/quota tests passed.
  - `tests/main-window-lifecycle.test.js`, `tests/quick-package-parser.test.js`, `tests/provenance.test.js`, `tests/psd-embedded-safety.test.js`, Figma scope/link/token/privacy, renderer Figma scope, and full `tests/provenance-dual-write.test.js` all passed.
  - full dual-write result: 106 tests passing.
- qa50 release-gate result:
  - Release commit: `362d2d0faad785bb935e2517d498b296e0ad935c` (`Prepare v2.8.0-qa.50 QA prerelease`)
  - Tag: `v2.8.0-qa.50`
  - GitHub prerelease: `https://github.com/bfeintuch123/crate-app/releases/tag/v2.8.0-qa.50`
  - Direct DMG: `https://github.com/bfeintuch123/crate-app/releases/download/v2.8.0-qa.50/Crate-2.8.0-qa.50-arm64.dmg`
  - built app and mounted-DMG app report version `2.8.0-qa.50`
  - bundle id `com.crate.app`
  - built app and mounted-DMG app pass `codesign --verify --deep --strict`
  - built app and mounted-DMG app are accepted by Gatekeeper as `Notarized Developer ID`
  - built app passes `xcrun stapler validate`
  - DMG container was signed, notarized, stapled, and accepted by Gatekeeper
  - release assets include DMG, DMG blockmap, ZIP, ZIP blockmap, and `latest-mac.yml`
- Scope kept:
  - no get-crate.com update
  - no crate-web deploy
  - no final public v2.8.0 release
  - no dependency mutation
  - no parser/provenance behavior change
  - package metadata bump only in `package.json` and `package-lock.json`
- Next Jenna-machine validation:
  - install qa50 after moving old `/Applications/Crate.app` to Trash
  - confirm visible Projects launch, force-quit/reopen, and Dock/app activation remain passing
  - confirm qa49 visual polish remains: no Home, no top-level Files, sidebar `Projects / Quick Package / Current Project / Settings / Help`, Quick Package primary tab, right-aligned dark `+ Add Project`, wide surfaces, and clean Settings spacing
  - confirm Package alerts is ON and macOS Notifications permission for Crate is allowed if visible safely
  - package a safe fixture while Crate is backgrounded immediately after destination confirmation
  - expect Crate to stay backgrounded until notification click or manual return
  - expect native `Project Packaged!` notification if macOS permission allows
  - confirm Package Complete, Package Details, quota increment, quota-block no-output behavior, scoped output, and privacy checks remain passing

### qa50 Jenna Result + qa51 Zero-Window Recovery Release Gate

- qa50 Jenna-machine result:
  - installed app version `2.8.0-qa.50`
  - qa50 package scoping, Package Complete, Package Details, quota increment, quota block, diagnostics-off behavior, and privacy checks passed
  - qa50 failed initial clean launch / force quit-reopen because Crate could start as a process with `windows=0`
  - fresh config also reproduced `windows=0`, so the issue was classified as likely app lifecycle/window-creation bug, not persisted user config
  - native package-complete banner was still not observed, but Bryant clarified that this banner is not required for tester rollout because Crate already shows the in-app Package Complete screen and Package Details
- PR #120:
  - URL: `https://github.com/bfeintuch123/crate-app/pull/120`
  - branch: `codex/qa50-zero-window-launch-recovery`
  - base: `v2.4.x`
  - merge commit: `ccbaffcb699fd909337f17d60749c7d40760833b`
  - changed files: `main.js`, `renderer/index.html`, `tests/main-window-lifecycle.test.js`
- Fix summary:
  - startup retry timers now stay alive until Crate confirms a visible main window
  - if the first launch window closes before visibility is established, retry recovery creates a replacement visible window instead of leaving a headless process
  - once a window is confirmed visible, startup retries clear normally
  - Package Alerts settings copy now describes the proven idle-project reminder behavior instead of promising package-complete native banners
- Merge-readiness:
  - PR base confirmed `v2.4.x`
  - changed files stayed scoped to app lifecycle, renderer copy, and lifecycle tests
  - merge state was clean / mergeable
  - no dependency, crate-web, parser, provenance, Figma, package-scope, or release-site changes
- Checks passed:
  - `npm audit --audit-level=high` passed; known moderate `uuid` advisory remains and was not force-fixed
  - `node --check main.js`
  - `node --check provenance.js`
  - `node --check renderer/app.js`
  - `node --check parsers/index.js`
  - `node --check parsers/powerpoint.js`
  - `node --check parsers/figma.js`
  - `node --check parsers/package-safety.js`
  - `node --check tests/main-window-lifecycle.test.js`
  - `node --test tests/main-window-lifecycle.test.js`
  - `node --test tests/renderer-figma-scope.test.js`
  - focused package/notification/quota subset from `tests/provenance-dual-write.test.js`
  - `node --test tests/quick-package-parser.test.js`
  - `node --test tests/provenance.test.js`
  - `git diff --check`
- qa51 release-gate result:
  - Release commit: `e17c98e` (`Prepare v2.8.0-qa.51 QA prerelease`)
  - Tag: `v2.8.0-qa.51`
  - GitHub prerelease: `https://github.com/bfeintuch123/crate-app/releases/tag/v2.8.0-qa.51`
  - Direct DMG: `https://github.com/bfeintuch123/crate-app/releases/download/v2.8.0-qa.51/Crate-2.8.0-qa.51-arm64.dmg`
  - built app and mounted-DMG app report version `2.8.0-qa.51`
  - bundle id `com.crate.app`
  - built app and mounted-DMG app pass `codesign --verify --deep --strict`
  - built app and mounted-DMG app are accepted by Gatekeeper as `Notarized Developer ID`
  - built app passes `xcrun stapler validate`
  - DMG container was signed, notarized, stapled, and accepted by Gatekeeper
  - release assets include DMG, DMG blockmap, ZIP, ZIP blockmap, and `latest-mac.yml`
- Scope kept:
  - no get-crate.com update
  - no crate-web deploy
  - no final public v2.8.0 release
  - no dependency mutation
  - no parser/provenance behavior change
  - package metadata bump only in `package.json` and `package-lock.json`
- Next Jenna-machine validation:
  - install qa51 after moving old `/Applications/Crate.app` to Trash
  - confirm clean launch opens visible Projects window
  - confirm force quit/reopen restores visible window
  - confirm Dock/app activation brings Crate forward
  - confirm no Home, no top-level Files, sidebar `Projects / Quick Package / Current Project / Settings / Help`, Quick Package primary tab, right-aligned dark `+ Add Project`, wide surfaces, and clean Settings spacing
  - confirm Package Alerts copy says Crate alerts when a watched project is idle
  - confirm Package Complete screen and Package Details still work after a normal package
  - confirm quota increments by exactly one
  - confirm quota-block writes no output
  - confirm scoped output, diagnostics behavior, and privacy checks remain passing

### qa51 Jenna-Machine Validation Result

- QA version: `v2.8.0-qa.51`.
- Installed app:
  - `/Applications/Crate.app`
  - version/build `2.8.0-qa.51`
  - bundle id `com.crate.app`
  - process path `/Applications/Crate.app/Contents/MacOS/Crate`
  - `NSAppleEventsUsageDescription` present
  - Apple Events entitlement present
  - old qa50 app moved to Trash before install
- Window / visual validation: PASS.
  - clean launch opened visible Projects window
  - force quit/reopen restored visible window with `process_count=1, windows=1`
  - app activation brought Crate forward
  - no Home
  - no top-level Files
  - sidebar shows `Projects`, `Quick Package`, `Current Project`, `Settings`, `Help`
  - Quick Package is a primary tab
  - `+ Add Project` is dark, narrower, and right-aligned
  - wide surfaces and Settings spacing remain intact
- Package Alerts copy: PASS.
  - Settings copy now says `Get alerts when Crate notices a watched project has been idle.`
  - Native package-complete banner is not a tester-readiness requirement; in-app Package Complete and Package Details are the accepted completion confirmation.
- Package smoke: PASS.
  - project `Jenna qa51 Package Smoke QA`
  - fixture `Crate qa51 Package Smoke Fixture.pptx`
  - output path under approved `v2.8.0-qa.51-jenna/package-outputs`
  - Package Complete: `2 files packaged`
  - Package Details: `2 files included`, `1 file gathered`, `1 extracted media file`, `No issues found`, `Diagnostics off`
  - quota incremented exactly +1 (`1/10` to `2/10`)
  - output contained only the fixture PPTX and expected extracted image
- Quota block: PASS, with setup caveat.
  - temporarily set counter to `10/10` with backup
  - at `10/10`, Projects disabled `+ Add Project`
  - Quick Package quota-block flow showed existing `You've used all 10 packages` / upgrade / reset copy
  - no quota-block output was written
  - counter restored to real tested value `2/10`, reset date `2026-08-01`
- Privacy / scope: PASS.
  - no `Crate Diagnostics` folder with Diagnostics OFF
  - no root `crate-provenance.json`
  - no package-output recapture
  - no stale QA roots or unrelated files in package
  - no token, Figma URL, file key, signed URL, or private-path leakage in targeted checks
- Classification:
  - qa51 passes PR #120's core installed-app targets and closes the release-blocking zero-window regression for this lane.
  - package output, Package Details, quota increment, quota block, and privacy checks are clean.
  - package-complete native banner is intentionally out of scope after the copy/requirement clarification.
- Separate follow-up:
  - a stale qa50 idle alert appeared once after install; clicking `Pause` caused Crate to quit, but relaunch recovered normally.
  - classify as idle-alert button interaction follow-up, not a qa51 package/window/quota blocker.
  - if Bryant wants extra confidence before testers, run a focused qa51 idle-alert button smoke covering `Keep Watching`, `Pause`, and `Package Now` on a current qa51 project.

### qa51 Idle Alert Button Smoke

- QA version: `v2.8.0-qa.51`.
- Installed app:
  - `/Applications/Crate.app`
  - version `2.8.0-qa.51`
  - bundle id `com.crate.app`
  - process path `/Applications/Crate.app/Contents/MacOS/Crate`
  - `NSAppleEventsUsageDescription` present
  - Apple Events entitlement present
- Settings:
  - Package alerts ON
  - Diagnostics OFF
  - Package Details ON
  - package counter before focused smoke: `2 of 10`
  - package counter after focused smoke: `3 of 10`
- Part A, `Keep Watching`: PASS.
  - alert appeared after 12 minutes
  - alert referenced fresh project `Jenna qa51 Idle Alert Keep Watching QA`
  - Crate did not quit
  - window remained visible
  - project remained Watching
  - no output written
  - counter stayed `2/10`
- Part B, `Pause`: PASS.
  - alert appeared after 12 minutes
  - alert referenced fresh project `Jenna qa51 Idle Alert Pause QA`
  - Crate did not quit
  - window remained visible / recoverable
  - UI showed `Paused · 1 file`
  - no output written
  - counter stayed `2/10`
  - no zero-window regression
- Part C, `Package Now`: PASS.
  - alert appeared after 12 minutes
  - alert referenced fresh project `Jenna qa51 Idle Alert Package Now QA`
  - package flow opened normally through destination chooser
  - Package Complete showed `2 files packaged`
  - Package Details showed `2 files included`, `1 file gathered`, `1 extracted media file`, `No issues found`, `Diagnostics off`
  - counter changed `2/10` to `3/10`
  - output path under approved `v2.8.0-qa.51-jenna/package-outputs`
  - output files were only `Crate qa51 Idle Package Now Fixture.pptx` and `Crate qa51 Idle Package Now Fixture — image1.jpg`
  - no unexpected files
- Privacy / scope:
  - Diagnostics with Diagnostics OFF absent
  - root `crate-provenance.json` absent
  - package-output recapture absent
  - stale QA roots absent
  - unrelated files absent from output
  - no token, Figma URL, file key, signed URL, or private-path leakage in output text-file scan
- Classification:
  - likely app bug: no
  - likely QA setup issue: no
  - likely permissions/TCC issue: no
  - likely package/scope issue: no
  - release/tester blocker: no
- Result:
  - qa51 idle-alert buttons are tester-ready.
  - `Keep Watching`, `Pause`, and `Package Now` all worked from fresh qa51 projects.
  - The earlier stale qa50 idle-alert `Pause` behavior does not reproduce on fresh qa51 projects and is not an active tester blocker.

### v3.0.0-beta.1 Tester Release

- Bryant decided the redesigned Crate app should move to v3.0 rather than final public `v2.8.0`.
- Release target selected: `v3.0.0-beta.1`.
- Release branch: `v2.4.x`.
- Docs/control-layer dirty state was stashed before release mutation and restored afterward.
- Release-gate checks before version bump:
  - branch was `v2.4.x`
  - local branch matched `origin/v2.4.x`
  - working tree was clean after stashing docs/control-layer files
  - package metadata before bump was `2.8.0-qa.51`
  - `npm audit --audit-level=high` passed; known moderate `uuid` advisory remains and was not force-fixed
  - syntax checks passed for `main.js`, `provenance.js`, `renderer/app.js`, `parsers/index.js`, `parsers/powerpoint.js`, `parsers/figma.js`, and `parsers/package-safety.js`
  - focused lifecycle, Quick Package, provenance, PSD, Figma, renderer, and token privacy tests passed
  - full `tests/provenance-dual-write.test.js` passed: 106 tests passing
- Version bump:
  - `package.json`: `3.0.0-beta.1`
  - `package-lock.json`: `3.0.0-beta.1`
- Build / artifact result:
  - `npx electron-builder --mac --arm64` succeeded
  - built app version: `3.0.0-beta.1`
  - bundle id: `com.crate.app`
  - artifacts:
    - `dist/Crate-3.0.0-beta.1-arm64.dmg`
    - `dist/Crate-3.0.0-beta.1-arm64.dmg.blockmap`
    - `dist/Crate-3.0.0-beta.1-arm64-mac.zip`
    - `dist/Crate-3.0.0-beta.1-arm64-mac.zip.blockmap`
    - `dist/latest-mac.yml`
- Signing / notarization:
  - built app passed `codesign --verify --deep --strict`
  - built app was accepted by Gatekeeper as `Notarized Developer ID`
  - built app passed `xcrun stapler validate`
  - DMG container was signed, notarized, stapled, validated, and accepted by Gatekeeper as `Notarized Developer ID`
  - mounted-DMG app reported version `3.0.0-beta.1`, bundle id `com.crate.app`, passed codesign, and was accepted by Gatekeeper
- Git / GitHub release:
  - release commit: `fcef32f` (`Prepare v3.0.0-beta.1 release`)
  - tag: `v3.0.0-beta.1`
  - branch and tag pushed to origin
  - GitHub prerelease created: `https://github.com/bfeintuch123/crate-app/releases/tag/v3.0.0-beta.1`
  - direct DMG: `https://github.com/bfeintuch123/crate-app/releases/download/v3.0.0-beta.1/Crate-3.0.0-beta.1-arm64.dmg`
  - GitHub release assets include DMG, DMG blockmap, ZIP, ZIP blockmap, and `latest-mac.yml`
  - direct GitHub DMG URL resolves successfully
- Site update:
  - `crate-site/index.html` was updated and committed so regular download CTAs point to the v3 beta DMG.
  - updated CTA copy includes `Download v3 Beta` and `For Mac · v3 beta · Free to start`.
  - this change was included in release commit `fcef32f` and pushed to `origin/v2.4.x`.
- Site deploy status:
  - Cloudflare Pages project: `get-crate`.
  - first deploy to branch `main` updated preview URLs but not custom domain production.
  - production deployment list showed the custom domain production branch is `v2.4.x`.
  - production deploy was then run for branch `v2.4.x`.
  - production deployment URL: `https://51c5bf53.get-crate.pages.dev`.
  - live `https://get-crate.com/` verified with cache-busting and now serves v3 beta download links.
  - verified live HTML contains `v3.0.0-beta.1` and `Crate-3.0.0-beta.1-arm64.dmg`.
  - verified live HTML no longer contains old `v2.7.1` / `Crate-2.7.1` download links.
- Security follow-up:
  - Cloudflare API token was exposed in a Terminal screenshot/transcript while enabling deploy access.
  - Rotate the exposed token in Cloudflare.
  - Going forward, use a secure Codex-accessible deployment path rather than relying on manual Terminal exports.

### 2026-07-11 Crate Ops Safety And Feedback Loops

- Crate Ops PR #4 merged after privacy hardening as `89aa76b`.
- Batch 1-8 was implemented on isolated app and plugin branches without changing app runtime, dependencies, package behavior, parsers, provenance, release, or site state.
- Added defense-in-depth destructive-command and repo-boundary checks, safe worktree policy, reviewable skill proposals, loop retrospectives, feature inventory, architecture-health audit, and aggregate-only operational hygiene checks.
- Validation passed: plugin validator, adversarial hook tests, Crate Doctor, 12-feature evidence inventory, diff/whitespace checks, independent safety rereview, and 214 focused app tests.
- Next gate: open separate PRs and stop before merging either new PR without Bryant's separate approval.

### 2026-07-11 Crate Ops Quality Intelligence

- Crate Ops PR #5 merged as `3537c3b`; Crate app PR #122 merged as `3afc7e0`.
- Bryant approved moving to X-research batch 9-16.
- Duplication review selected extensions for feature coverage, loop discovery, handoff/context, QA visual evidence, architecture health, and ops hygiene; only instruction audit, automation hygiene, and model/cost routing are new skills.
- Work remains ops-only and review-first. No app runtime, dependency, release, deploy, model switch, automation mutation, or paid API usage is authorized by this batch.
- Validation passed after three adversarial hardening rounds: contained atomic report outputs, fail-closed credential/Figma/signed-URL filtering, repo-contained catalog evidence, no-write-on-invalid behavior, automation live-state distrust, and Git-history fail-closed reporting.
- Proof: 13 plugin tests, plugin validators, Crate Doctor with zero failures, 12-feature/7-loop catalogs, 214 focused app tests, and two clean independent rereviews.
- PRs: Crate Ops #6 and Crate app #123 are clean and mergeable; plugin CI passed after replacing a platform-dependent test assumption with portable collision coverage.

### 2026-07-12 Crate Ops Design And Launch Readiness

- Bryant merged Crate Ops PR #6 and Crate app PR #123, then approved moving to the next X-research batch.
- Overlap review selected seven non-duplicative, review-first capabilities: design quality, safe workflow recording, cross-tester learning, customer-journey/public-asset launch readiness, privacy-first product metrics, read-only dependency posture, and public-launch incident rehearsal.
- Scope remains ops-only. No app runtime, site, Figma, analytics, dependency, release, deploy, automation, or credential mutation is authorized.
- Active branches: `codex/ops-design-launch-readiness` and `codex/ops-design-launch-catalogs`.
- Next gate: validate, open separate PRs, run merge-readiness, and stop before merge without Bryant's separate approval.
- Validation completed after adversarial hardening: target-specific launch assets, plain-text tester/launch evidence, symlink-safe report roots, canonical tester source IDs, real full-vs-production npm audit comparison, strict npm schema/count consistency, and escaped dependency output.
- Proof: 31 plugin tests, both plugin validators, loop catalog validation, Crate Doctor with zero failures, 214 existing app tests, and clean independent security/ownership rereviews.
- PRs: Crate Ops #7 and Crate app #124 are clean and mergeable; plugin CI passed. Merge order is plugin first, then app catalog. Stop before either merge without Bryant's separate approval.

### 2026-07-12 Canonical Tester Feedback JSON

- Bryant approved creating the canonical tester-feedback format before Olivia's first session.
- Selected one finding per record, with shared pseudonymous `source_id` and `session_id` values across findings from one tester session.
- Schema version `1.0` excludes identities, demographics, profile/portfolio links, URLs, raw paths, screenshots, recordings, and private assets.
- Real tester use will validate the field set; missing optional concepts should become a reviewed backward-compatible `1.1` proposal.
- Active branches: `codex/canonical-tester-feedback-schema` and `codex/tester-feedback-schema-catalog`.
- Implemented a closed Draft 2020-12 record schema and versioned collection envelope with one finding per record, semantic build versions, generated opaque IDs, stable source-ID reuse for returning testers, session integrity, and accountable privacy/product decisions.
- Added strict validation for duplicate JSON keys, unsafe paths/URLs/emails/filenames/IPs/active content, exact canonical schema parity, chronology, and sanitized error output.
- Split loop ownership: private intake/evidence custody, canonicalization/privacy validation, downstream bug triage, and cross-tester synthesis. Cross-tester synthesis now requires at least two independent sources.
- Validation proof: 47 plugin tests, both plugin validators, independent Ajv Draft 2020-12 compilation and privacy probes, Crate Doctor with zero failures, loop-catalog JSON validation, clean diffs, and independent security/product rereviews.
- Merge dependency: plugin PR first, then app catalog PR. Stop before merge without Bryant's approval.
- PRs opened and merge-readiness passed: Crate Ops PR #8 is mergeable with CI passing; Crate app PR #125 is mergeable with local docs/doctor validation passing and no configured PR checks.
- Bryant approved merge; Crate Ops PR #8 merged first as `823b860`, then dependent Crate app PR #125 merged to `v2.4.x` as `ad3716b`.

### 2026-07-12 Chief-Of-Staff Attention Queue

- Every newsletter review identified a useful `Tend` pattern: one source-of-truth chief task gathers signals, proposes decisions, routes execution, and learns from outcomes.
- Duplication review confirmed Crate already has routers, loops, taskflows, context packs, model tiers, retrospectives, and thread/subagent control. The missing layer is one freshness-aware active attention index.
- Bryant approved implementing item 1 before preference learning, workflow evaluations, efficiency receipts, and evidence-based model routing.
- Selected architecture: the current Codex task remains chief of staff; the queue is a private local control index; existing authoritative sources and loop owners remain unchanged.
- Two read-only agents reviewed privacy, freshness, authority, deduplication, phase ownership, and anti-duplication requirements. Their findings are being treated as implementation acceptance criteria.
- Active branches: Crate Ops `codex/chief-of-staff-attention-queue`; app catalog `codex/chief-of-staff-attention-queue-catalog`.
- No app runtime, site, Figma, live inbox/calendar/tester data, dependencies, release, deploy, credentials, or live queue snapshots are in scope.
- Implemented a closed privacy-safe queue schema, synthetic example, stable matter/dedupe identities, current-date freshness, expected source inventory, per-source refresh accounting, prior-snapshot reconciliation, accountable privacy review, and owner-only atomic output.
- Added exact route/action/standing-order authority, source-bound approval revisions and expiry, dual-source Bryant-and-Jenna approval, and Bryant-only gates for code, support sends, and business mutations.
- Added dedicated attention, support/email, calendar, and business-operation routes under SO-011 through SO-014; existing engineering, QA, release, design, tester, and deploy loops remain owners of their current scopes.
- Full verification: 83 plugin tests, both plugin validators, strict Ajv probes, plugin/app route-catalog consistency, standing-order contract audit, app JSON/diff checks, and Crate Doctor with zero failures.
- Independent product and security rereviews found no P0/P1/P2 blockers and recommended coordinated PRs in plugin-first order.
- Opened Crate Ops PR #9 and dependent Crate app PR #126. A Linux-only test-path failure on PR #9 was fixed by selecting the platform's real system temp directory; the full 83-test suite remained green locally and GitHub `validate` now passes.
- Final merge-readiness: both PRs are clean and mergeable. Merge order is #9 then #126; stop before merge pending Bryant approval.

### 2026-07-12 Chief-Of-Staff Learning And Workflow Evaluations

- Bryant approved and merged Crate Ops PR #9 as `9f8ceb3a16125e741cb81be158cf0095feb27cbc`, then dependent Crate app PR #126 as `a47b27643b80b8b4a7022b54c5b8793511afbd21`.
- The next ops batch reuses SO-007 and the existing ops-improvement loop; it does not create another memory system, standing order, or top-level loop.
- Implemented decision-backed explicit preference records with exact owner, subject, statement, content hash, review date, expiry, conflict, and supersession checks. Preferences remain advisory defaults and never grant action authority.
- Implemented privacy-reviewed synthetic workflow evaluations pinned to deterministic routing contracts, plus stale-contract and mismatch failure probes.
- Implemented private locally signed aggregate outcome receipts that require real bounded evidence files and retain only content-derived opaque hashes. Receipt identity, work identity, signatures, route fields, and evidence matching are fail closed.
- Implemented advisory model/agent routing based on exact current eval and receipt evidence. It cannot switch models, create agents, begin paid usage, or bypass existing approval gates.
- Validation: 103 plugin tests, both plugin validators, strict Draft 2020-12 schema validation with date formats, Python compilation, loop-catalog audit, JSON/diff checks, and Crate Doctor with zero failures.
- Active branches: Crate Ops `codex/chief-of-staff-learning-evals`; Crate app `codex/chief-of-staff-learning-evals-catalog`.
- Independent product and security rereviews found no P0/P1/P2 blockers. The only residual P3 limits are that evidence hashes do not prove every semantic claim and repo decision provenance is not cryptographic identity; both remain non-authoritative and advisory.
- Coordinated PRs: Crate Ops #10 and dependent Crate app #127 are clean and mergeable; plugin CI passes. Merge #10 before #127 only after Bryant approval.

### 2026-07-14 Figma Link And Identifier Privacy

- Phase 2A PR #129 is merged and its Mac mini credential migration and connection smoke passed.
- Implemented Phase 2B on `codex/security-figma-link-privacy`: full Figma URLs are parsed transiently and replaced in persisted state by the minimal file, candidate, and page or node locator needed for existing behavior.
- Legacy project and session URLs migrate automatically without reconnecting; blank edits preserve the current link, replacement requires a new URL, and removal is explicit.
- Main-process, parser, and optional diagnostic output now minimize complete URLs, credentials, signed-link material, and Figma identifiers.
- Current Page Only remains default and fail closed; Entire File remains opt-in. Package, watcher, parser-result, provenance, quota, dependency, preload, build, release, and deploy behavior were not changed.
- Final validation: 251 dependency-complete full-suite tests passed; 107 focused Figma/privacy/package tests passed; the complete patch applied to exact base `4be0d5fba8d1d22696f067da90950de1b35a85de` in a fresh Reprobox and passed the same 107 tests plus syntax and whitespace checks.
- Failure-first coverage now proves atomic page/node locator migration, rejection of stale mismatched session locks, renderer IPC error sanitization, compound credential-field redaction including renderer-originated logs, and complete redaction of quoted private paths containing spaces.
- Independent functional review and final adversarial security re-review returned no findings; the security reviewer directly probed neutral compound credentials and quoted private paths containing spaces across shared, main-process IPC, parser, and renderer boundaries.
- Reprobox proof: `/private/tmp/crate-reprobox-figma-link-privacy-finalv8.kocFfh`; no dependency installation, app launch, build, signing, release, or deployment occurred.
- Phase 2B commit `64b4263` was pushed and opened as PR #130 against `v2.4.x`. GitHub reports the PR mergeable and clean; the committed-tree focused suite passed 107/107, while GitHub reports no configured branch checks.
- Next gate: Bryant approval to merge PR #130. Stop before merge, build, signing, notarization, release, deploy, or the next security phase without the applicable approval.

### 2026-07-14 Electron Boundary Hardening

- Phase 2B ultimately merged as PR #131 at `29aa8646a51e5e241326cef420ed450465bd33b4`; its post-merge deterministic suite and contained Mac mini Figma migration, link-minimization, scope, editing, restart, and privacy validation passed.
- Implemented Phase 3 on `codex/security-electron-boundary`: all 30 privileged IPC handlers now share a fail-closed sender boundary tied to Crate's current live main window, exact top frame, and canonical local renderer document.
- Explicit BrowserWindow settings preserve context isolation, keep Node integration off, enable Chromium renderer sandboxing and web security, and deny insecure mixed content. Navigation, redirects, and child-window creation are restricted to the canonical local renderer entry.
- Closed adversarial bypasses for stale or secondary senders, destroyed or detached windows, arbitrary existing-window adoption, and renderer URLs with populated or bare queries.
- Validation passed: 255 deterministic tests, 165 focused exact-base Reprobox tests, syntax and whitespace checks, packaged-content verification, source-to-ASAR hash comparison, and Mac mini Computer Use startup/navigation/IPC/window-recovery checks.
- The contained unsigned QA app used a synthetic Figma token, isolated profile, and mock Keychain. No real credential, Keychain item, Crate config, installed app, dependency, signing, release, or deploy state was changed.
- Independent functional and adversarial reviews found no P0, P1, P2, or actionable P3 issue. The pre-existing moderate `uuid` advisory remains; no dependency mutation was authorized.
- Bryant approved Phase 3 commit, push, PR creation, and merge if final merge readiness remains clean.
- Next gate: commit and open the Phase 3 PR against `v2.4.x`, run final merge readiness, merge only if clean, then stop before signed build, notarization, release mutation, site deployment, or Phase 4 implementation and discuss Phase 4 plus the deferred Electron 39 Quick Package drag-and-drop issue.

### 2026-07-14 Electron 39 Quick Package Drag And Drop

- Phase 3 PR #132 merged into `v2.4.x` as `c6c9354b37e89ba8daea84e545530296d3f0ab9b` after GitHub mergeability, full 255-test, audit, scope, independent review, Reprobox, and contained Mac gates passed.
- Bryant approved the recommended Phase 3.5 compatibility slice before Phase 4.
- Root cause is confirmed in the renderer: Quick Package drag-and-drop reads Electron's removed nonstandard `File.path` property, while Browse continues to receive a path from the main-process file dialog.
- Target fix: resolve the operating-system-backed dropped `File` through `webUtils.getPathForFile` inside sandboxed preload and invoke the existing trusted Quick Package IPC channel without adding a new bridge API that returns the resolved path before packaging.
- Active branch: `codex/fix-electron39-quick-package-drop`, based exactly on merged `origin/v2.4.x` at `c6c9354b37e89ba8daea84e545530296d3f0ab9b`.
- Implemented the narrow preload/renderer compatibility fix without changing the existing main-process Quick Package handler: disk-backed drops resolve through Electron `webUtils.getPathForFile`, while Browse retains its existing path flow.
- Added failure-first and production-handler coverage for the removed `File.path` behavior, fail-safe unavailable files, first-file-only packaging, separate drop and Browse flows, quota refresh, progress cleanup, and retry after rejected requests.
- Validation passed: 43 focused tests, 260 full-suite tests, 43 exact-base Reprobox tests, syntax and whitespace checks, packaged-content verification, source-to-ASAR hash comparison, and two independent no-blocker rereviews.
- Contained Electron 39.8.10 validation packaged a genuine disk-backed PowerPoint drop, showed Package Complete, copied identical source bytes, and incremented isolated quota from `0 of 10` to `1 of 10`.
- One Keynote assertion failed only when the suite was deliberately forced under `/private/tmp`; the same test failed on exact base and passed when rerun under a normal macOS temporary root. This is test-environment sensitivity, not a Phase 3.5 regression.
- No dependency, lockfile, main-process handler, package-engine, parser, provenance, Figma, watcher, signed-build, release, deploy, installed-app, or personal-config mutation occurred.
- Phase 3.5 PR #133 merged into `v2.4.x` as `5cbe421086095ef4201ff5e740ac7bf413aca65a` after merge readiness remained clean.
- No signed build, notarization, release mutation, site deployment, dependency mutation, or external tester update occurred.

### 2026-07-14 Parser And Archive Admission Limits

- Began independently reviewable security Phase 4A on `codex/security-parser-admission-limits`, based exactly on merged `origin/v2.4.x` at `5cbe421086095ef4201ff5e740ac7bf413aca65a`.
- Added one shared parser admission-budget module for raw file reads, Premiere decompression, archive listings and declared expansion, PowerPoint or Keynote embedded media, and IDML XML inspection.
- Oversized files, decompression bombs, excessive archive entries, oversized declared or extracted content, and child-process output overflow now fail with fixed privacy-safe errors before unsafe parser work continues.
- Preserved normal parser result shapes, Quick Package behavior, package selection, naming, output, quota, watcher, provenance, Figma scope, Current Page Only default, and Entire File opt-in.
- Failure-first and compatibility proof passed: 57 focused parser, Quick Package, package-safety, PSD, and Electron 39 disk-drop tests; 20 Electron embedded-Node tests; one real PowerPoint archive list/extract smoke; and 280 dependency-complete full-suite tests.
- Fresh exact-base Reprobox at `/private/tmp/crate-reprobox-phase4a-final2.BdZL7d/repo` passed the same 57 focused tests, syntax checks, and `git diff --check`.
- Two independent adversarial rereviews approved the final patch after verifying timeout handling, same-descriptor bounded reads, reference limits, late-failure output cleanup, and separate plain or gzip Premiere input budgets.
- `npm audit --audit-level=high` passed with only the pre-existing moderate `uuid` advisory. No dependency or lockfile mutation occurred.
- Bryant approved committing and pushing Phase 4A, opening its PR against `v2.4.x`, running merge readiness, and merging if clean. Phase 4B network and Figma download limits remain separate and start only after that merge.

### 2026-07-15 Figma Network Admission Limits

- Phase 4A PR #134 merged into `v2.4.x` as `84a7fd3affdf15d855313d339392de6fe9b7a807`.
- Began independently reviewable Phase 4B on `codex/security-network-download-limits`, based exactly on that merged commit.
- Added one shared privacy-safe guard for Figma API and asset transfers with HTTPS-only URLs, no authenticated redirects, bounded unauthenticated asset redirects, 30-second request timeouts, 120-second operation deadlines, per-response limits, and shared operation byte budgets.
- Response bytes are counted before buffering; exhausted byte or time budgets reject before another request; rejected, redirected, oversized, timed-out, and non-success bodies are destroyed.
- A known pre-package Figma asset-transfer failure now blocks output with fixed nontechnical copy until a clean retry succeeds. Unreadable, rate-limited, partial, or failed asset-discovery retries remain blocked; the blocked attempts create no package folder and do not increment quota.
- Oversized assets create no cache file, file-ledger record, provenance node, or provenance edge. Current Page Only remains default and fail closed; Entire File remains opt-in.
- Validation passed: 80 focused Figma network, link, scope, privacy, package, and provenance tests; 297 dependency-complete full-suite tests; and 80 tests plus syntax and whitespace checks in exact-base Reprobox `/private/tmp/crate-reprobox-phase4b-final5.d5YbfM/repo`.
- One unchanged timing-sensitive provenance poll test failed in the first final full run, then passed in isolation and in the clean 297-test rerun.
- `npm audit --audit-level=high` passed with only the pre-existing moderate `uuid` advisory. No dependency, build, installed-app, signing, release, deploy, external-tester, Phase 5, or updater mutation occurred.
- Bryant authorized the Phase 4B commit, push, PR against `v2.4.x`, merge-readiness review, and merge if clean.
