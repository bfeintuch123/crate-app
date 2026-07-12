# Crate Current Workstream

Last updated: 2026-07-11

## Current Status

- Active repo: crate-app
- Canonical branch: `v2.4.x`
- Remote: `bfeintuch123/crate-app`
- Latest tester beta release in this thread: `v3.0.0-beta.1`
- Latest internal QA prerelease in this thread: `v2.8.0-qa.51`
- Latest public-stable release: not updated in this workstream
- Current phase: `v3.0.0-beta.1` remains the tester beta. Crate Ops batch 1-8 is implemented and validated in isolated app/plugin branches, with no app runtime or release mutation.
- Active ops branches: `codex/ops-repo-safety-inventory` and Crate Ops `codex/ops-safety-feedback-loops`
- Current ops work: destructive-command guard, safe worktree policy, reviewable skill workshop, loop retrospectives, canonical feature inventory, architecture-health audit, operational hygiene, and the merged private X research inbox. Crate Ops PR #5 and Crate app PR #122 are merge-ready; stop before merging them without Bryant's separate approval.
- Command center: current Codex thread
- Durable memory target: repo docs, daily ledger, and compiled vault

## Current Ops Layer

The Crate ops loop-hardening branch adds the durable operating layer under existing loops:

- plan: `.codex/ops/crate-ops-improvement-plan.md`
- standing orders: `.codex/ops/standing-orders.md`
- taskflow template: `.codex/taskflows/README.md`
- memory model: `.codex/ops/crate-memory-model.md`
- proof bundle template: `.codex/ops/proof-bundle-template.md`
- tester feedback archive: `.codex/ops/tester-feedback-archive.md`
- skill/playbook registry: `.codex/ops/skill-registry.md`
- docs routing metadata: `.codex/ops/docs-index.md`
- Cloudflare deploy playbook: `.codex/playbooks/crate-cloudflare-deploy.md`
- doctor tool: `.codex/tools/crate_doctor.py`

Existing loops and gates now route through standing orders, taskflows, memory load, doctor preflight where appropriate, and proof bundle closeout.

Formalization state:

- Commit: `b839b74` (`Formalize Crate ops loop layer`)
- Branch: `codex/crate-ops-loop-hardening`
- PR: `https://github.com/bfeintuch123/crate-app/pull/121`
- Merge status: not merged; run merge-readiness before merge if Bryant approves.

## Latest Release / Tester Build Result

`v3.0.0-beta.1` is the latest tester beta release. It is the renamed v3 beta line built from the qa51 validated baseline after Bryant decided the redesigned app should move to v3.0 rather than final public v2.8.0.

v3 beta release result:

- Branch: `v2.4.x`
- Release commit: `fcef32f` (`Prepare v3.0.0-beta.1 release`)
- Tag: `v3.0.0-beta.1`
- GitHub prerelease: `https://github.com/bfeintuch123/crate-app/releases/tag/v3.0.0-beta.1`
- Direct DMG: `https://github.com/bfeintuch123/crate-app/releases/download/v3.0.0-beta.1/Crate-3.0.0-beta.1-arm64.dmg`
- Version in `package.json`, `package-lock.json`, built app, and mounted-DMG app: `3.0.0-beta.1`
- Bundle id: `com.crate.app`
- Release assets uploaded:
  - `Crate-3.0.0-beta.1-arm64.dmg`
  - `Crate-3.0.0-beta.1-arm64.dmg.blockmap`
  - `Crate-3.0.0-beta.1-arm64-mac.zip`
  - `Crate-3.0.0-beta.1-arm64-mac.zip.blockmap`
  - `latest-mac.yml`
- Built app and mounted-DMG app pass `codesign --verify --deep --strict`.
- Built app and mounted-DMG app are accepted by Gatekeeper as `Notarized Developer ID`.
- Built app passes `xcrun stapler validate`.
- DMG container was signed, notarized, stapled, validated, and accepted by Gatekeeper as `Notarized Developer ID`.
- GitHub release asset URL resolves successfully.
- `crate-site/index.html` was updated and pushed so regular download CTAs point to the v3 beta DMG.
- Cloudflare Pages project: `get-crate`.
- Production deploy completed through Cloudflare Pages on branch `v2.4.x`.
- Production deployment URL verified: `https://51c5bf53.get-crate.pages.dev`.
- Live `get-crate.com` verified with cache-busting:
  - site HTML now contains `v3.0.0-beta.1`.
  - site HTML now links to `Crate-3.0.0-beta.1-arm64.dmg`.
  - old `v2.7.1` download links are no longer present in the verified response.
- Follow-up:
  - Cloudflare API token was exposed in a Terminal screenshot/transcript during manual setup. Rotate that token in Cloudflare and use a secure Codex-accessible deploy path going forward.

## Latest QA Result

`v2.8.0-qa.51` is the latest internal QA prerelease. It validates PR #120, the focused startup zero-window recovery fix after qa50 intermittently launched as a running process with `windows=0`. Native macOS package-complete banners are no longer treated as required for tester rollout because Crate already shows the in-app Package Complete screen and Package Details after packaging.

qa51 Jenna-machine result:

- Installed app reports version `2.8.0-qa.51`, bundle id `com.crate.app`, correct process path, Apple Events usage string, and Apple Events entitlement.
- Old qa50 app was moved to Trash before install.
- Window/visual validation: PASS.
  - clean launch opened visible Projects window.
  - force quit/reopen restored a visible window with `process_count=1, windows=1`.
  - app activation brought Crate forward.
  - no Home.
  - no top-level Files.
  - sidebar shows `Projects`, `Quick Package`, `Current Project`, `Settings`, `Help`.
  - Quick Package is a primary tab.
  - `+ Add Project` is dark, visually narrower, and right-aligned.
  - wide surfaces and Settings spacing remain intact.
- Package Alerts copy: PASS.
  - Settings copy now says `Get alerts when Crate notices a watched project has been idle.`
  - This matches Bryant's decision that native package-complete banners are not required.
- Package smoke: PASS.
  - safe PowerPoint fixture packaged to approved qa51 package-output folder.
  - Package Complete reported `2 files packaged`.
  - Package Details showed `2 files included`, `1 file gathered`, `1 extracted media file`, `No issues found`, and `Diagnostics off`.
  - quota incremented exactly +1 (`1/10` to `2/10`).
  - output contained only the fixture PPTX and expected extracted image.
- Quota block: PASS.
  - at `10/10`, Projects disabled `+ Add Project`.
  - Quick Package quota-block flow showed the existing limit / upgrade / reset copy.
  - no quota-block output was written.
  - counter was restored to the real tested value (`2/10`, reset date `2026-08-01`).
- Privacy/scope: PASS.
  - no diagnostics folder with Diagnostics OFF.
  - no root `crate-provenance.json`.
  - no package-output recapture.
  - no stale QA roots or unrelated files.
  - no token, Figma URL, file key, signed URL, or private-path leakage in targeted checks.
- Follow-up:
  - a stale qa50 idle alert appeared once after install; clicking `Pause` caused Crate to quit, but relaunch recovered normally.
- Idle-alert button follow-up result: PASS.
  - focused qa51 fresh-project idle alert smoke validated `Keep Watching`, `Pause`, and `Package Now`.
  - `Keep Watching` dismissed the alert, left the fresh watched project active, wrote no output, and did not change quota.
  - `Pause` dismissed the alert, kept Crate visible/recoverable, changed the fresh project to `Paused · 1 file`, wrote no output, and did not change quota.
  - `Package Now` completed the package flow, showed Package Complete and Package Details, incremented quota exactly +1 (`2/10` to `3/10`), and output only the expected PPTX plus extracted image.
  - no zero-window behavior, app quit, diagnostics leakage, root provenance, package-output recapture, stale QA roots, unrelated files, token, Figma URL, file key, signed URL, or private-path leakage.
  - classify the earlier stale qa50 alert as upgrade-state residue, not an active qa51 tester blocker.

qa51 release-gate result:

- PR #120 was merged into `v2.4.x`.
- PR #120 merge commit: `ccbaffcb699fd909337f17d60749c7d40760833b`.
- Release commit: `e17c98e` (`Prepare v2.8.0-qa.51 QA prerelease`)
- Tag: `v2.8.0-qa.51`
- GitHub prerelease: `https://github.com/bfeintuch123/crate-app/releases/tag/v2.8.0-qa.51`
- Direct DMG: `https://github.com/bfeintuch123/crate-app/releases/download/v2.8.0-qa.51/Crate-2.8.0-qa.51-arm64.dmg`
- App version in built app and mounted DMG: `2.8.0-qa.51`
- Bundle id: `com.crate.app`
- Built app and mounted-DMG app pass `codesign --verify --deep --strict`.
- Built app and mounted-DMG app are accepted by Gatekeeper as `Notarized Developer ID`.
- Built app passes `xcrun stapler validate`.
- DMG container was signed, notarized, stapled, and accepted by Gatekeeper.
- Release assets include DMG, DMG blockmap, ZIP, ZIP blockmap, and `latest-mac.yml`.
- No get-crate.com update, crate-web deploy, final public v2.8.0 release, dependency mutation, parser/provenance behavior change, or unrelated app source change occurred.

Primary qa50 validation target:

- Install qa51 on Jenna's Mac after moving old `/Applications/Crate.app` to Trash.
- Confirm visible Projects launch, force-quit/reopen, and Dock/app activation recovery remain passing.
- If the first launch starts a process with `windows=0`, keep the test stopped and report it as a qa51 failure.
- Confirm qa48/qa49/qa44 visual polish remains intact:
  - no Home
  - no top-level Files
  - sidebar shows `Projects`, `Quick Package`, `Current Project`, `Settings`, `Help`
  - Quick Package is a primary tab
  - `+ Add Project` is dark, visually narrower, and right-aligned with project-row status/action pills
  - wide responsive surfaces and clean Settings spacing remain intact
- Confirm Package Alerts copy says Crate alerts when a watched project has been idle, not that a package-complete native macOS banner will appear.
- Package a safe fixture while Crate is backgrounded immediately after destination confirmation.
- Expected: Crate does not steal focus during the package handoff.
- Expected: returning manually shows in-app Package Complete and Package Details.
- Confirm quota increments by exactly one after a successful normal package.
- Confirm quota-block flow still writes no output at `10/10`.
- Confirm output scope, diagnostics behavior, and privacy checks remain clean.

Previous latest qa50 result:

`v2.8.0-qa.50` was the prior internal QA prerelease. It validated PR #119, but Jenna-machine testing found a release-blocking zero-window launch regression: the app could start as a process with `windows=0`, including with fresh config. qa50 package scoping, Package Complete, Package Details, quota increment, quota block, and privacy checks passed. Native macOS package-complete banner was not observed, but Bryant decided this banner is not required because the in-app Package Complete screen remains the accepted completion confirmation.

Previous latest qa49 result:

`v2.8.0-qa.49` was the prior internal QA prerelease. Jenna-machine validation passed install/window recovery, qa48 visual polish, background focus behavior, quota increment on reset/month-boundary state, quota-block no-output behavior, package output scope, Package Complete, Package Details, diagnostics-off behavior, and privacy checks. The remaining failure was native macOS package-complete banner delivery: Crate stayed backgrounded correctly, macOS notification permission was allowed with Temporary banner style, but no `Project Packaged!` banner was observed.

qa49 Jenna-machine result:

- Visual/window checks: PASS.
- No Home / no top-level Files / sidebar order / Quick Package primary tab: PASS.
- `+ Add Project` dark, narrower, right-aligned under rows: PASS.
- Wide surfaces and Settings spacing: PASS.
- Crate stayed backgrounded after `Package Now` while Finder stayed frontmost from `t+1` through `t+5`: PASS.
- Native `Project Packaged!` notification observed: FAIL / not observed.
- Package Complete: PASS.
- Package Details: PASS.
- Quota increment: PASS (`0/10` to `1/10`, config `packagesThisMonth: 1`).
- Quota block at `10/10`: PASS; existing limit flow shown and no output written.
- Output scope/privacy: PASS; no diagnostics with Diagnostics OFF, no root provenance, no package-output recapture, no stale QA roots, no token/Figma URL/file key/signed URL/private-path leakage.
- Current classification: likely app bug or Electron/macOS notification-delivery gap, limited to native package-complete banner delivery. Not a package correctness or quota blocker.
- Cleanup note: quota-block test project remained visible as Watching and should be removed before the next Jenna run.

qa49 release-gate result:

- PR #118 was merged into `v2.4.x`.
- PR #118 merge commit: `17eb7c665b6ed97a37c4d14057277f24d94601a5`.
- Release commit: `7e947023bbcc5ab613dd81a976322727304dffd4` (`Prepare v2.8.0-qa.49 QA prerelease`)
- Tag: `v2.8.0-qa.49`
- GitHub prerelease: `https://github.com/bfeintuch123/crate-app/releases/tag/v2.8.0-qa.49`
- Direct DMG: `https://github.com/bfeintuch123/crate-app/releases/download/v2.8.0-qa.49/Crate-2.8.0-qa.49-arm64.dmg`
- App version in built app and mounted DMG: `2.8.0-qa.49`
- Bundle id: `com.crate.app`
- Built app and mounted-DMG app pass `codesign --verify --deep --strict`.
- Built app and mounted-DMG app are accepted by Gatekeeper as `Notarized Developer ID`.
- Built app passes `xcrun stapler validate`.
- DMG container was signed, notarized, stapled, and accepted by Gatekeeper.
- Release assets include DMG, DMG blockmap, ZIP, ZIP blockmap, and `latest-mac.yml`.
- No get-crate.com update, crate-web deploy, final public v2.8.0 release, dependency mutation, parser/provenance behavior change, or unrelated app source change occurred.

Primary qa49 validation target:

- Install qa49 on Jenna's Mac after moving old `/Applications/Crate.app` to Trash.
- Confirm visible Projects launch, force-quit/reopen, and Dock/app activation recovery remain passing.
- Confirm qa48 visual polish remains intact:
  - no Home
  - no top-level Files
  - sidebar shows `Projects`, `Quick Package`, `Current Project`, `Settings`, `Help`
  - Quick Package is a primary tab
  - `+ Add Project` is dark, visually narrower, and right-aligned with project-row status/action pills
  - wide responsive surfaces and clean Settings spacing remain intact
- Confirm Package alerts is ON and macOS Notifications permission for Crate is allowed if System Settings exposes it safely.
- Package a safe fixture while Crate is backgrounded immediately after destination confirmation.
- Expected: Crate does not steal focus during the package handoff.
- Expected: native macOS `Project Packaged!` notification appears while Crate stays backgrounded, if macOS notification permission allows.
- Expected: clicking the notification brings Crate forward to Package Complete.
- Expected: returning manually still shows Package Complete and Package Details.
- Confirm quota increments by exactly one after a successful normal package, including month-boundary / reset-day state.
- Confirm quota-block flow still writes no output at `10/10`.
- Confirm output scope, diagnostics behavior, and privacy checks remain clean.

Previous latest qa48 result:

`v2.8.0-qa.48` was the prior internal QA prerelease for Jenna-machine package-complete notification plus Projects button validation.

qa48 release-gate result:

- Release commit: `92e6bdb` (`Prepare v2.8.0-qa.48 QA prerelease`)
- Tag: `v2.8.0-qa.48`
- GitHub prerelease: `https://github.com/bfeintuch123/crate-app/releases/tag/v2.8.0-qa.48`
- Direct DMG: `https://github.com/bfeintuch123/crate-app/releases/download/v2.8.0-qa.48/Crate-2.8.0-qa.48-arm64.dmg`
- Validates PR #117 / merge commit `244a18c0632cad80d1a367c71c8cd07c0df41baa` in the signed app.
- App version in built app and mounted DMG: `2.8.0-qa.48`
- Bundle id: `com.crate.app`
- Built app and mounted-DMG app pass `codesign --verify --deep --strict`.
- Built app and mounted-DMG app are accepted by Gatekeeper as `Notarized Developer ID`.
- Built app passes `xcrun stapler validate`; the DMG container itself remains unstapled under the existing internal QA builder path, while the app inside validates.
- Built app ASAR contains PR #117 UI/notification markers: `project-list-actions`, right-aligned `btn-add-project`, background-safe destination selection copy, and qa47 notification markers.
- Release assets include DMG, DMG blockmap, ZIP, ZIP blockmap, and `latest-mac.yml`.
- No get-crate.com update, crate-web deploy, final public v2.8.0 release, dependency mutation, parser/provenance behavior change, or unrelated app source change occurred.

Primary qa48 validation target:

- Install qa48 on Jenna's Mac after moving old `/Applications/Crate.app` to Trash.
- Confirm visible Projects launch and Dock/activation recovery remain passing.
- Confirm Projects list `+ Add Project` button is right-aligned with project status/action pills and visually narrower.
- Confirm Package alerts is ON and macOS Notifications permission for Crate is allowed if System Settings exposes it safely.
- Package a safe fixture while Crate is backgrounded after destination confirmation.
- Expected: Crate does not steal focus immediately after destination confirmation.
- Expected: native macOS `Project Packaged!` notification appears while Crate stays backgrounded, if macOS notification permission allows.
- Expected: clicking the notification brings Crate forward.
- Expected: returning manually still shows Package Complete and Package Details.
- Confirm quota increments, output scope is clean, and privacy checks remain clean.

Previous latest qa47 result:

`v2.8.0-qa.47` was prepared for Jenna-machine package-complete notification validation but failed the background package test: Crate returned frontmost immediately after package destination confirmation and no native package-complete notification appeared despite macOS notification permission being allowed. PR #117 addresses the destination-picker focus steal.

qa47 release-gate result:

qa47 release-gate result:

- Release commit: `81f6615` (`Prepare v2.8.0-qa.47 QA prerelease`)
- Tag: `v2.8.0-qa.47`
- GitHub prerelease: `https://github.com/bfeintuch123/crate-app/releases/tag/v2.8.0-qa.47`
- Direct DMG: `https://github.com/bfeintuch123/crate-app/releases/download/v2.8.0-qa.47/Crate-2.8.0-qa.47-arm64.dmg`
- Validates PR #116 / merge commit `bbbbe0c` in the signed app.
- App version in built app and mounted DMG: `2.8.0-qa.47`
- Bundle id: `com.crate.app`
- Built app and mounted-DMG app pass `codesign --verify --deep --strict`.
- Built app and mounted-DMG app are accepted by Gatekeeper as `Notarized Developer ID`.
- Built app passes `xcrun stapler validate`; the DMG container itself remains unstapled under the existing internal QA builder path, while the app inside validates.
- Built app ASAR contains PR #116 notification markers: `showPackageCompleteNotification`, `activeNativeNotifications`, `packageWindowWasForeground`, and `package-notification-failed`.
- Release assets include DMG, DMG blockmap, ZIP, ZIP blockmap, and `latest-mac.yml`.
- No get-crate.com update, crate-web deploy, final public v2.8.0 release, dependency mutation, package-engine/parser/provenance behavior change, or unrelated app source change occurred.

Primary qa47 validation target:

- Install qa47 on Jenna's Mac after moving old `/Applications/Crate.app` to Trash.
- Confirm visible Projects launch and Dock/activation recovery remain passing.
- Confirm Package alerts is ON.
- Confirm macOS Notifications permission for Crate is allowed if System Settings exposes it safely.
- Package a safe fixture while Crate is backgrounded.
- Expected: native macOS `Project Packaged!` notification appears while Crate stays backgrounded, if macOS notification permission allows.
- Expected: clicking the notification brings Crate forward.
- Expected: returning manually still shows Package Complete and Package Details.
- Confirm quota increments, output scope is clean, and privacy checks remain clean.

Previous latest qa46 result:

`v2.8.0-qa.46` passed Jenna-machine zero-window recovery validation.

qa46 Jenna-machine result:

- Installed app reports version `2.8.0-qa.46`, bundle id `com.crate.app`, correct process path, Apple Events usage string, and Apple Events entitlement.
- Old app was moved to Trash during install.
- Zero-window recovery: PASS.
  - Force quit/reopen worked.
  - `System Events` reported `process_count=1`, `windows=1`.
  - Dock icon was present.
  - Dock click restored/brought Crate forward.
  - Fresh config fallback was not needed.
- Visual layout: PASS.
  - default launch is Projects.
  - no Home.
  - no top-level Files.
  - sidebar shows `Projects`, `Quick Package`, `Current Project`, `Settings`, `Help`.
  - Quick Package is a primary tab.
  - Add Project / Start Project is dark primary.
  - wide responsive surfaces and clean Settings spacing were confirmed.
- Background package-alert lane: PARTIAL PASS.
  - Packaging, Package Complete, Package Details, quota increment, and scoped output all passed.
  - Native macOS package-complete notification was not observed while Crate was backgrounded.
  - macOS notification permission was not confirmed; private Notification Center contents were not inspected.
- Current classification:
  - qa46 fixes the installed-app zero-window blocker.
  - package correctness and privacy remain clean.
  - native package-complete notification delivery remains a focused follow-up, not a package correctness blocker.

qa46 release-gate result:

- Release commit: `ba74ab5ba773b24504334fea8815abaec299b5dc` (`Prepare v2.8.0-qa.46 QA prerelease`)
- Tag: `v2.8.0-qa.46`
- GitHub prerelease: `https://github.com/bfeintuch123/crate-app/releases/tag/v2.8.0-qa.46`
- Direct DMG: `https://github.com/bfeintuch123/crate-app/releases/download/v2.8.0-qa.46/Crate-2.8.0-qa.46-arm64.dmg`
- Validates PR #115 / merge commit `dace1b736ba860a68d270ec172482cf0ad71d1a1` in the signed app.
- App version in built app and mounted DMG: `2.8.0-qa.46`
- Bundle id: `com.crate.app`
- Built app and mounted-DMG app pass `codesign --verify --deep --strict`.
- Built app and mounted-DMG app pass `xcrun stapler validate`.
- Built app and mounted-DMG app are accepted by Gatekeeper as `Notarized Developer ID`.
- Built and mounted app ASARs contain PR #115 lifecycle hardening markers: `MAIN_WINDOW_HIDDEN_RECREATE_AFTER`, cached-window live-list recreation, and `recreate-hidden-window`.
- Release assets include DMG, DMG blockmap, ZIP, ZIP blockmap, and `latest-mac.yml`.
- DMG container itself remains unsigned/unstapled under the current builder config, matching the existing app-notarization path; the app inside validates.
- No get-crate.com update, crate-web deploy, final public v2.8.0 release, dependency mutation, package-engine/parser/provenance changes, or unrelated app source changes occurred.

PR #115 remains the latest merged lifecycle recovery fix and is validated in qa46 for the zero-window blocker.

Latest merged lifecycle fix:

- PR: `https://github.com/bfeintuch123/crate-app/pull/115`
- Branch: `codex/qa45-zero-window-lifecycle`
- Merge commit: `dace1b736ba860a68d270ec172482cf0ad71d1a1`
- Changed files: `main.js`, `tests/main-window-lifecycle.test.js`
- Summary: hardens zero-window recovery beyond qa45 by recreating existing-but-hidden windows after repeated failed show checks, discarding cached BrowserWindow references that are missing from Electron's live window list, scheduling startup retries before first window creation, and protecting replacement windows from old late `closed` events.
- Next required action: triage native package-complete notification delivery if Bryant wants it fixed before tester rollout.

qa45 result:

- qa45 installed successfully on Jenna's Mac but did not fix the zero-window failure.
- Fresh launch after force quit still started a Crate process with `windows=0`.
- Dock click, `Show All`, `Bring All to Front`, and `Window > Crate` did not restore a visible window.
- Temporary fresh config also reproduced `windows=0`.
- Visual and package-alert tests stayed blocked.

Previous qa45 release-gate:

`v2.8.0-qa.45` was prepared to validate PR #114 / merge commit `cac6888a035e607cf655be25e92bcca28f23dff8` in the signed app.

qa45 release-gate result:

- Release commit: `24d239b` (`Prepare v2.8.0-qa.45 QA prerelease`)
- GitHub prerelease: `https://github.com/bfeintuch123/crate-app/releases/tag/v2.8.0-qa.45`
- Direct DMG: `https://github.com/bfeintuch123/crate-app/releases/download/v2.8.0-qa.45/Crate-2.8.0-qa.45-arm64.dmg`
- App inside the build and mounted DMG reports version `2.8.0-qa.45`.
- App bundle id is `com.crate.app`.
- Built app and mounted-DMG app pass `codesign --verify --deep --strict`.
- Built app and mounted-DMG app pass `xcrun stapler validate`.
- Built app and mounted-DMG app are accepted by Gatekeeper as `Notarized Developer ID`.
- Release assets include DMG, DMG blockmap, ZIP, ZIP blockmap, and `latest-mac.yml`.
- No crate-web, get-crate.com update, final public release, dependency mutation, package-engine/parser/provenance changes, or public release-state mutation occurred.

Primary qa46 validation target:

- Validate PR #115 / merge commit `dace1b736ba860a68d270ec172482cf0ad71d1a1` in the signed app.
- Verify the zero-window failure is fixed:
  - after deleting old `/Applications/Crate.app` and installing qa46, a clean launch opens a visible Projects window
  - force quit and reopen recovers a visible window
  - Dock/app activation restores a visible window when the process is running
  - temporary fresh-config launch also shows a visible window if needed
- If visible-window recovery passes, rerun the background package-alert lane.
- Confirm qa44 visual layout remains intact at spot-check level.

Previous qa44 failure:

- qa44 visual redesign confirmation passed.
- qa44 visible inactivity alert passed.
- qa44 foreground Package Complete and Package Details passed, but native macOS package-complete banner was not observed while foregrounded and remains inconclusive.
- qa44 background package-alert rerun was blocked because Crate launched as a process with `windows=0`.
- qa44 zero-window isolation reproduced with original config and temporary fresh config, so it was classified as an installed-app lifecycle/window creation bug.

Recent qa44 lifecycle fix:

- PR #114: `https://github.com/bfeintuch123/crate-app/pull/114`
- Branch: `codex/qa44-window-lifecycle-restore`
- Merge commit: `cac6888a035e607cf655be25e92bcca28f23dff8`
- Changed files: `main.js`, `tests/main-window-lifecycle.test.js`
- Root-cause area: main-process lifecycle was not aggressive enough about adopting/restoring an existing BrowserWindow or retrying foreground show after startup/activation, leaving installed-app edge cases where the process stayed alive with no visible window.
- Fix summary: adopt existing BrowserWindow instances before creating new ones, call `app.show()` during foreground restore, schedule short startup show retries, handle `did-become-active`, preserve no-quit-on-window-close behavior, and avoid force-reopening after intentional red close.

Previous qa41 baseline:

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

qa46 notification follow-up is the active next action.

Next:

1. Decide whether native package-complete notification delivery is required before tester rollout, or whether in-app Package Complete / Package Details is sufficient for now.
2. If native package-complete notification is required, run a focused notification triage loop:
   - confirm macOS notification authorization for `com.crate.app` without inspecting private notification contents
   - verify whether `new Notification(...).show()` fires but is suppressed by foregrounding or permission
   - check whether immediate `showTrayWindow()` after notification is preventing a visible banner
   - add privacy-safe notification diagnostics or adjust ordering only if needed
3. Keep qa46 as the current passing baseline for installed-app lifecycle recovery.
4. Do not run final public release execution until Jenna review is complete, tester feedback is incorporated, and Bryant gives a later explicit public-release approval.

## Historical Snapshot — 2026-06-30 qa.44

- Source of truth remains `v2.4.x`.
- PR #113 merged into `v2.4.x`:
  - `codex/qa44-redesign-layout-polish`
  - merge commit `0c2d42659a0c9817d9c4c300debc9c5708b28184`
- PR #113 scope:
  - renderer-only layout polish
  - Quick Package promoted to primary sidebar tab
  - navigation now includes `Projects`, `Quick Package`, `Current Project`, `Settings`, `Help`
  - Projects/Add Project primary action restored to black
  - main surfaces made wider/responsive
  - Settings spacing/layout cleaned up
  - Figma-style background treatment strengthened
- Internal QA prerelease `v2.8.0-qa.44` is built and published:
  - release commit `42ac2a5`
  - tag `v2.8.0-qa.44`
  - prerelease `https://github.com/bfeintuch123/crate-app/releases/tag/v2.8.0-qa.44`
  - DMG `https://github.com/bfeintuch123/crate-app/releases/download/v2.8.0-qa.44/Crate-2.8.0-qa.44-arm64.dmg`
- qa.44 validation completed on build machine:
  - `npm audit --audit-level=high` passed; only known moderate `uuid` advisory remains and requires force/breaking remediation
  - `node --check main.js`
  - `node --check provenance.js`
  - `node --check renderer/app.js`
  - `node --test tests/renderer-figma-scope.test.js`
  - `node --test tests/quick-package-parser.test.js`
  - `npx electron-builder --mac --arm64`
  - app inside DMG is signed, stapled, and accepted as `Notarized Developer ID`
- qa.44 is internal QA only:
  - no get-crate.com update
  - no crate-web deploy
  - no final public v2.8.0 release
  - no dependency mutation
  - no package-engine/parser/provenance changes

Historical qa44 validation target:

1. Send Jenna the qa.44 DMG and smoke prompt.
2. Validate layout polish:
   - Projects surfaces extend wider and grow with app width.
   - Current Project, Quick Package, Settings, Help use the same responsive width behavior.
   - Settings sections no longer overlap or stack too tightly.
   - Quick Package is a primary tab, not nested in Projects.
   - Sidebar tab colors match the dark Figma treatment.
   - background color treatment is visible.
   - Add Project button is black.
3. Re-run targeted functional smoke:
   - Projects/create/start/watch
   - Current Project no-project/no-files/ready/needs-save states
   - Package Review/Complete/Details
   - Quick Package scoped output and quota increment
   - Diagnostics OFF/ON
   - Illustrator Smoke 2
4. Continue UI review with Jenna after qa.44 smoke results.

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
- External control layer update:
  - native model-visible persistent thread tools such as `create_thread`, `send_message_to_thread`, `read_thread`, and `list_threads` are still not exposed in this session
  - local Codex app-server bridge is verified at `.codex/tools/codex_thread_control.py`
  - verified bridge operations: persistent thread start/list/read/name/send via app-server `thread/start`, `thread/list`, `thread/read`, `thread/name/set`, `thread/resume`, and `turn/start`
  - probe thread: `Crate Control Probe` / `019f1601-f049-72a0-a5cb-841a4b306598`, persisted response `PONG`
  - sub-agent controls are exposed and verified: `spawn_agent`, `send_input`, `wait_agent`, `resume_agent`, `close_agent`
  - use `.codex/playbooks/crate-external-control-layer.md` to coordinate source-of-truth, persistent bridge threads, native persistent threads when exposed, sub-agents, and paste-ready fallback behavior
  - exact persistent-thread exposure request is documented at `.codex/state/external-control-tool-exposure-request.md`

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
