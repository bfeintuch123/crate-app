# Crate Computer Use QA Playbook

## Purpose
Use Codex Computer Use to run scoped GUI QA flows for Crate across Crate-supported creative apps and workflows.

This playbook is for observing and recording Crate behavior in real GUI workflows. It does not replace Codex CLI tests, release gates, or code review. It gives Bryant evidence from the parts of Crate that automated tests cannot fully exercise: app launch, macOS dialogs, source-app state, package completion UI, package review, and Finder output.

Start narrow, then expand by scoped app lane. Figma, PowerPoint, and Keynote are initial priority workflows, not the full long-term GUI QA scope.

Jenna-machine real-file installed-app QA is an internal-validation lane within this playbook. Use it only when Bryant explicitly scopes QA to Jenna's machine, Jenna-approved real files, the installed Crate app, and installed creative apps. Treat it as privacy-sensitive evidence collection, not broad tester rollout and not release approval. Findings from this lane must be routed into `.codex/playbooks/crate-bug-triage.md` and `.codex/playbooks/crate-autoreview.md`; they may produce fix PRs after Bryant approves implementation, but they do not replace `.codex/playbooks/crate-release-gate.md`.

## When To Use
- Before tester rollout when Bryant wants GUI evidence for Crate workflows.
- Before release readiness when recent changes affect packaging, Package Complete, Package Details, Settings, Figma scope, PowerPoint, Keynote, Finder output, or provenance display.
- After a GUI-only bug report where tests do not show the user-facing failure.
- When Bryant wants screenshots, recordings, and a repeatable QA transcript instead of a code change.
- When Bryant approves Jenna-machine internal QA using real files and already-installed apps.
- With `.codex/playbooks/crate-manual-qa-matrix.md` for a broader manual QA run.

## Start Prompt
Use a prompt like:

```text
Use .codex/playbooks/crate-computer-use-qa.md to run scoped GUI QA for Crate. Use Codex Computer Use only for the approved apps and workflows, collect screenshots and results, do not modify code, and stop before any security, release, signing, deploy, or private-data boundary.
```

## Role Boundaries
- Codex Computer Use is for GUI QA and visual evidence collection.
- Codex CLI remains the source of truth for code, tests, git, release gates, and docs edits.
- Codex App remains useful for planning, triage, supervision, and QA synthesis.
- Bryant remains the human gate for sensitive actions, private assets, permissions, releases, signing, deploys, and broad scope changes.

## App Scope Tiers
Use the narrowest tier needed for the current QA task. Do not open apps outside the approved lane.

Tier 1 - Core smoke tests:
- Crate.
- Finder.

Tier 2 - Primary tester workflows:
- Figma.
- PowerPoint.
- Keynote.

Tier 3 - Adobe and design workflows:
- Photoshop.
- Illustrator.
- InDesign.
- After Effects, only if in supported workflow scope.
- Acrobat.

Tier 4 - Other supported creative workflows:
- Sketch.
- Affinity Designer.
- Affinity Photo.
- Affinity Publisher.
- Pixelmator Pro.
- browser-based Figma or download workflows.
- local files.
- Downloads/Desktop workflows.
- external drive/custom folder workflows.

## Apps Codex Computer Use May Use
- Crate.
- Finder.
- Only the Crate-supported creative app or workflow lane Bryant approved for the current QA task.
- Browser only when needed for Figma authentication, Figma file access, fixture downloads, approved download verification, or an approved browser-based creative workflow.

## Apps Codex Computer Use Must Never Use
- Keychain Access.
- Apple Developer account or signing portals.
- Cloudflare dashboard or deploy surfaces.
- GitHub release creation or release upload pages.
- Password managers.
- Banking, payment, security, or identity apps.
- Mail, Messages, Notes, Photos, Calendar, or other unrelated private apps.
- Private browser windows, unrelated browser tabs, or authenticated accounts outside the approved QA flow.
- Terminal for release, signing, notarization, deploy, tag, or mutation work.
- Broad unrelated app access. App access must stay scoped to the current QA flow.

## Files Codex May Read
- `AGENTS.md`.
- `.codex/playbooks/*.md`.
- `docs/*.md`.
- approved fixture instructions and synthetic assets.
- approved package outputs under `/private/tmp` or another Bryant-approved QA path.
- approved Jenna-machine real-file QA source paths, package outputs, screenshots, recordings, notes, and redacted inventories, only when Bryant explicitly approved that exact artifact for inspection and Jenna approved access when relevant.
- optional `Crate Diagnostics/crate-provenance.json` diagnostic manifests from approved QA package outputs when diagnostic reports were enabled.
- `package.json` read-only for version and script context.

## Files Codex May Modify
- None by default.
- With Bryant's explicit approval, Codex may write screenshots, screen recordings, notes, and redacted QA reports under `/private/tmp/crate-computer-use-qa-*`.
- With Bryant's explicit approval for Jenna-machine real-file installed-app QA, Codex may duplicate approved local originals into an approved `source-copies/` folder and operate only on those copies.
- With Bryant's explicit approval for process-doc updates, Codex may modify `.codex/playbooks/*.md`, `docs/*.md`, or `AGENTS.md` playbook references.

## Files Codex Must Not Modify
- `main.js`.
- `preload.js`.
- `renderer/`.
- `parsers/`.
- `scripts/`.
- `tests/`.
- `package.json`.
- `package-lock.json`.
- release artifacts.
- `crate-site/`.
- app preferences or system settings unless Bryant explicitly approves the exact setting.
- private tester, client, or source assets.

## Commands And Checks Codex May Run
Capture branch and docs state before GUI QA:

```sh
git status --short --branch
git branch --show-current
git rev-parse --short HEAD
git diff --name-only
```

Inspect approved package output after a GUI run:

```sh
find <approved-package-output> -maxdepth 4 -type f | sort
diagnostic_manifest="<approved-package-output>/Crate Diagnostics/crate-provenance.json"
test -f "$diagnostic_manifest"
node -e "const fs=require('fs'); const p=process.argv[1]; const m=JSON.parse(fs.readFileSync(p,'utf8')); console.log(JSON.stringify({copiedCount:m.copiedCount,embeddedCount:m.embeddedCount,totalFiles:m.totalFiles,errors:m.errors||[],warnings:m.warnings||[],nodes:(m.nodes||[]).length,edges:(m.edges||[]).length}, null, 2));" "$diagnostic_manifest"
rg -n "token|secret|credential|Authorization|Bearer|cookie|password|passkey|cdn\\.figma|rawTrackedFiles|/usr/sbin/lsof" "$diagnostic_manifest"
```

Diagnostic reports are optional and off by default. Enable `Include diagnostic report in packages` before expecting `Crate Diagnostics/crate-provenance.json`; do not expect a package-root manifest in default package output.

Run docs-only checks only if process docs are edited:

```sh
git diff --check
rg -n "[[:blank:]]$" AGENTS.md .codex/playbooks docs
rg -n "[^[:ascii:]]" AGENTS.md .codex/playbooks docs
```

## GUI QA Setup
- Confirm the branch, build, or installed app version under test.
- Confirm whether the app under test is a local dev run, installed QA build, or released build.
- For Jenna-machine real-file installed-app QA, confirm the installed Crate app path, installed Crate version, approved Jenna-machine source files, approved output folder, approved app lane, and whether diagnostic reports should be enabled before opening files.
- Confirm macOS version and source-app versions when relevant.
- Confirm the approved app tier and exact app lane before opening source apps.
- Confirm the package output folder before starting.
- Use synthetic, minimal, or explicitly approved files.
- Start a screen recording when Bryant approves recording.
- Take screenshots of setup state, Crate actions, package completion, package output, and Package Details.
- Keep unrelated apps and private windows closed.
- Stop if macOS asks for a privacy, security, automation, file-access, keychain, signing, or account approval that Bryant has not explicitly approved.

## Required GUI Flows

### Open Crate And Verify Launch
Steps:
- Open Crate through the approved build or app path.
- Confirm the main window appears.
- Confirm no crash, blank window, unhandled dialog, or stuck loading state appears.
- Capture the visible version/build indicator if present.

Pass:
- Crate launches to the expected starting UI and remains responsive.

Stop and ask Bryant:
- Crate asks for new privacy permissions.
- Crate opens a signing, update, login, or credential prompt.
- Crate appears to be a different build than the one Bryant intended.

### Package Complete UI
Steps:
- Run an approved package workflow.
- Wait for Package Complete.
- Screenshot the completed state.
- Confirm success/failure messaging, package path, and primary actions are visible.
- Confirm no unrelated private paths or raw diagnostics are displayed.

Pass:
- Package Complete appears after the package run and points to the expected output.

Fail:
- Completion never appears, shows the wrong folder, hides errors, or exposes private/internal data.

### Package Details Dropdown
Steps:
- Open the Package Details dropdown from Package Complete.
- Confirm included files, file sources, extracted or linked information, warnings, and needs-review items match the approved fixture.
- Compare visible Package Details to `Crate Diagnostics/crate-provenance.json` only when the diagnostic report setting was enabled and a manifest is present.
- Screenshot collapsed and expanded states.

Pass:
- Package Details is readable, collapsed by default when expected, and consistent with package output and manifest evidence.

Fail:
- Details overclaim provenance, omit important warnings, contradict package output, or expose raw internal paths beyond the approved UX.

### Settings Toggles
Steps:
- Open Settings.
- Verify expected toggles and defaults for the workflow under test.
- Confirm Figma Current Page Only remains default when relevant.
- Toggle only settings Bryant approved for the QA run.
- Return settings to the starting state unless Bryant approves keeping a changed state.

Pass:
- Toggles render, persist or reset according to expected behavior, and do not silently widen package scope.

Stop and ask Bryant:
- A toggle would alter privacy, startup behavior, filesystem permissions, telemetry, account state, or release behavior.

### Finder Package Output
Steps:
- Use Crate's open-in-Finder action or manually open the approved output path.
- Screenshot the top-level package folder.
- Inspect expected subfolders and files.
- Confirm unrelated files are absent.
- Confirm `Crate Diagnostics/crate-provenance.json` exists only when diagnostic reports were enabled.

Pass:
- Finder output matches the expected file inventory and remains inside the intended package folder.

Fail:
- Package output is missing, out of scope, outside the chosen folder, unexpectedly duplicated, or includes unrelated private files.

### PowerPoint Workflow QA
Steps:
- Open an approved synthetic PowerPoint deck.
- Confirm whether the deck has linked media, embedded media, or unsaved changes.
- Save before packaging when the test expects saved-state behavior.
- Package the PowerPoint workflow in Crate.
- Capture Package Complete, Package Details, Finder output, and manifest summary.

Pass:
- The PowerPoint deck and eligible media are packaged as expected, with no unrelated files.

Fail:
- Crate misses expected embedded or linked media, packages unrelated app files, or misstates file source evidence.

### Keynote Workflow QA
Steps:
- Open an approved synthetic Keynote file.
- Confirm whether the file has linked media, embedded media, or unsaved changes.
- Save before packaging when the test expects saved-state behavior.
- Package the Keynote workflow in Crate.
- Capture Package Complete, Package Details, Finder output, and manifest summary.

Pass:
- The Keynote document and eligible media are packaged as expected, with no unrelated files.

Fail:
- Crate treats Keynote like PowerPoint without evidence, misses expected media, or includes unrelated files.

### Figma Current Page Only QA
Steps:
- Open an approved Figma file with at least two pages and distinct assets.
- Select the intended current page.
- Confirm Crate is set to Current Page Only.
- Package the Figma workflow.
- Capture Figma page state, Crate scope setting, Package Complete, Package Details, Finder output, and manifest summary.

Pass:
- Current-page assets are included and other-page-only assets are excluded.

Fail:
- Other-page assets are included, current-page assets are missed, page lock failure is hidden, or scope is silently widened.

### Figma Entire File QA
Steps:
- Open an approved Figma file with distinct assets on multiple pages.
- Explicitly set Crate to Entire File.
- Package the Figma workflow.
- Capture Figma file/page state, Crate scope setting, Package Complete, Package Details, Finder output, and manifest summary.

Pass:
- Eligible assets across the file are included and unrelated files are excluded.

Fail:
- Only the current page is packaged, unrelated files appear, or Package Details overclaims page-level certainty.

### Supported Creative App Lane QA
Use this flow for approved Tier 3 or Tier 4 apps and workflows after the core Tier 1 smoke tests and any relevant Tier 2 priority workflows.

Steps:
- Open only the approved source app, document, folder, or browser workflow for the lane.
- Record the app name, version when visible, document state, save state, linked/embedded media state, and relevant Crate settings.
- Package the approved workflow in Crate.
- Capture Package Complete, Package Details, Finder output, and manifest summary when present.
- Compare included and missing files against the expected lane behavior.

Pass:
- The approved creative workflow packages expected eligible files, excludes unrelated files, and reports provenance or limitations accurately.

Fail:
- Crate packages unrelated app files, misses expected eligible files without warning, silently widens scope, or overclaims source evidence.

### Jenna-Machine Real-File Installed-App QA
Use this flow only when Bryant explicitly approves internal QA on Jenna's machine using Jenna-approved real files, the installed Crate app, and already-installed source apps. Do not use this flow as approval to install apps, update apps, grant permissions, inspect unrelated files, or make a release decision. Jenna-machine QA findings feed bug triage and autoreview; they do not build, sign, notarize, tag, release, deploy, update `get-crate.com`, or replace release gates.

Preflight:
- Confirm this is Jenna-machine internal validation, not external tester rollout.
- Confirm the installed DMG-derived Crate app path on Jenna's Mac and visible version/build under test.
- Confirm each installed source app and version when visible.
- Confirm the exact approved real file, folder, or cloud document for the lane.
- Confirm whether the approved real file can be opened, screenshotted, recorded, inventoried, or summarized.
- Confirm the approved package output folder and whether it may be inspected after packaging.
- Confirm whether `Include diagnostic report in packages` should be enabled for this run.
- Confirm any expected package contents and expected exclusions Bryant or Jenna already know.

Real-file handling rules:
- Use only Bryant-approved real files, folders, cloud documents, package outputs, screenshots, recordings, and manifests.
- Duplicate approved local originals into an approved `source-copies/` folder before opening them in source apps; run QA from those copies and leave originals untouched.
- If a source app forces a save, save only the approved file inside `source-copies/`.
- Use approved `test-photos/` assets only for add-photo or place-photo tests; do not pull photos from Photos, Downloads, Desktop, recents, browser tabs, or unrelated folders.
- Stop if the flow would inspect, mutate, rename, move, delete, upload, or package an original real file instead of the approved copy.

Steps:
- Open only the installed Crate app and the approved installed source app for the current lane.
- Open only the approved real-file copy, folder, or cloud document; keep unrelated files, windows, tabs, and recent-document lists out of scope.
- Record source-app state that affects package behavior, including save state, active document, linked or embedded media indicators, cloud/local state, and visible file identity.
- Run a clean baseline package before add-photo tests or live-watch tests.
- Run the assigned Crate workflow from the installed app: explicit-add, live-watch, or both.
- Capture Package Complete, Package Details collapsed and expanded, Finder output, and manifest summary when diagnostics were enabled and the manifest is approved for inspection.
- Compare package output to expected real-file contents and expected exclusions, using redacted names when the file names or paths are private.
- Record any blocked permissions, missing assets, wrong assets, extra assets, provenance confusion, install warnings, update prompts, crashes, or privacy concerns.

Clean baseline package:
- Run before add-photo tests or live-watch tests.
- Use only approved files from `source-copies/`.
- Do not use `test-photos/` assets.
- Enable `Include diagnostic report in packages` for the baseline run.
- Confirm Package Details remains designer-facing and does not expose raw internal diagnostics.
- Confirm `Crate Diagnostics/crate-provenance.json` exists when diagnostics are on.
- Confirm no package-root `crate-provenance.json` exists.
- Confirm expected source files, linked assets, and embedded assets are present.
- Confirm no unexpected Desktop, Downloads, private, original-source, credential, token, or out-of-lane files appear unless explicitly linked by approved source files.
- Compare package counts across the project card, Package Complete modal, Package Details, Finder inventory, and diagnostics when available.
- Stop and route to `.codex/playbooks/crate-bug-triage.md` if unexpected files appear.

Explicit-add workflow:
- Add only the approved copied source file, approved copied source folder, approved cloud document, or approved `test-photos/` asset through Crate's explicit add action.
- Record the exact visible control or menu used for the add.
- Package to the approved output folder.
- Pass only if the explicitly added item and expected eligible dependencies are included and unrelated watched files are absent.

Live-watch workflow:
- Start the approved project in Crate before opening or modifying the copied source file.
- Open and save only the approved source copy in the installed source app.
- For add-photo tests, place only approved `test-photos/` assets into the source copy.
- Package to the approved output folder after Crate has had a fair chance to observe the workflow.
- Pass only if expected live-watch files are captured and unrelated files opened outside the lane are absent.

Lane coverage:
- Adobe: run only the approved Photoshop, Illustrator, InDesign, Acrobat, or other approved Adobe lane; record linked, embedded, placed, exported, and save-state evidence visible in the app.
- Figma: record Current Page Only or Entire File mode, file/page identity when approved, and whether the lane used the installed app or browser-based Figma.
- PowerPoint: record saved state, linked media, embedded media, and any add-photo step using only approved `test-photos/` assets.
- Keynote: record saved state, linked media, embedded media, and any add-photo step using only approved `test-photos/` assets; do not assume PowerPoint results cover Keynote.

Combined Adobe + Figma workflow:
- Use only approved Adobe source copies from `source-copies/`.
- Use only the approved Figma file and approved current page.
- Include an optional approved PowerPoint or Keynote file only when Bryant scopes it into the run.
- Package into Crate from the installed DMG-derived app.
- Confirm expected Adobe files and assets are included.
- Confirm expected Figma Current Page Only assets are included and other-page-only assets are excluded.
- Confirm unrelated open files are excluded.
- Confirm Package Details and diagnostics preserve privacy and do not expose credentials, tokens, raw Figma API payloads, private source paths, or unrelated files.
- Stop and route to `.codex/playbooks/crate-bug-triage.md` if unexpected files appear.

Audit:
- Unexpected-file audit: compare Finder output and any approved manifest summary against the expected inclusion and exclusion list; fail if unrelated, private, original-source, Downloads, Desktop, recents, credential, token, or out-of-lane files appear.
- Duplicate-file audit: record duplicate basenames, duplicate package entries, and repeated assets; pass only when duplicates are expected by the workflow or clearly explained by copied source plus package output, and fail when duplicates imply overcapture or confusing package output.

Pass:
- The installed Crate app packages the approved real-file workflow through the installed source app, includes expected eligible files, excludes unrelated/private files, and presents Package Complete and Package Details without misleading or sensitive output.

Fail:
- Crate misses expected real-file assets, includes unrelated/private files, packages from the wrong app or folder, silently widens scope, exposes sensitive paths or diagnostics, misstates provenance, crashes, hangs, or cannot complete the installed-app workflow.

Stop and ask Bryant/Jenna:
- Jenna's real file, package output, screenshot, recording, or manifest was not explicitly approved for inspection.
- The flow requires installing, updating, downloading, signing in, granting macOS permissions, changing cloud/account state, changing system/app preferences, opening billing, account security, admin/team settings, credential settings, Keychain, Apple Developer, Cloudflare, or GitHub release/admin pages.
- The source app shows unrelated private files, recent documents, account information, client names, credentials, or private browser state.
- The package output contains any private, unrelated, credential, token, or surprising file.
- The installed Crate app or source app version differs from the version Bryant intended to validate.
- The flow would require code edits, tests edits, package edits, app builds, release builds, signing, notarization, stapling, tags, deploys, or release-site changes.

## Screenshot And Result Collection
Collect only approved and privacy-safe artifacts:

- setup screenshot
- app version/build screenshot when visible
- Crate Settings screenshot
- source-app state screenshot
- Package Complete screenshot
- Package Details collapsed and expanded screenshots
- Finder output screenshot
- redacted package inventory
- redacted `Crate Diagnostics/crate-provenance.json` summary when diagnostics were enabled
- screen recording path when one was approved

For Jenna-machine real-file installed-app QA, redact private file names, client names, local usernames, cloud URLs, and source paths unless Bryant explicitly approves preserving them. Store temporary reports under `/private/tmp/crate-computer-use-qa-<id>` only after Bryant approves artifact writing. Do not store private client, tester, or Jenna-machine source assets in the report.

## When To Stop And Ask Bryant
- A privacy, security, automation, file-access, keychain, signing, account, or update prompt appears.
- The flow requires a private tester or client file that Bryant has not approved.
- The flow would access unrelated apps, windows, accounts, tabs, or folders.
- The source app, browser, or Crate requests credentials or cloud-account changes.
- The flow would require approving macOS security or privacy prompts through Computer Use.
- A package appears to contain private, credential, or unrelated files.
- Crate crashes, hangs, or appears to be using the wrong build.
- A test requires changing app settings beyond the approved scope.
- A Jenna-machine real-file QA flow would inspect, upload, rename, delete, or otherwise mutate original source files, or copy them anywhere except the approved `source-copies/` folder.
- Any step would build, release, deploy, notarize, tag, merge, commit, push, or create a GitHub release.

## Approval Gates
Codex may run read-only repository checks and operate only the approved GUI apps in the approved workflow. Bryant must explicitly approve:

- opening private, tester, or client assets
- recording the screen
- writing screenshots, recordings, reports, or package summaries
- changing Settings values beyond observation
- granting macOS permissions
- expanding app access beyond the current QA lane
- using browser authentication
- creating new package outputs from private files
- opening Jenna-machine real files, source folders, package outputs, screenshots, recordings, or manifests
- duplicating approved originals into `source-copies/`
- installing, updating, or downloading apps
- switching branches
- running `npm start`
- committing, pushing, merging, tagging, releasing, building, notarizing, stapling, or deploying

## Must Never Do
- Do not modify app code, tests, package files, release artifacts, or site files.
- Do not edit `main.js`.
- Do not approve privacy, security, automation, keychain, account, signing, or developer prompts.
- Do not open Keychain, Apple Developer, Cloudflare, GitHub release pages, password managers, banking/payment/security apps, unrelated apps, private windows, or unrelated browser tabs.
- Do not use private tester or client assets without approval.
- Do not build, release, deploy, notarize, staple, tag, merge, commit, push, or mutate dependencies.
- Do not claim a GUI flow passed without screenshots or an explicit observation record.
- Do not generalize PowerPoint results to Keynote, or Keynote results to PowerPoint, without testing both.
- Do not treat one creative app lane as coverage for another lane without evidence.

## Quality Impact
- Catches launch, UI, Settings, Finder, source-app, and Crate-supported creative workflow failures that unit tests cannot see.
- Reduces release risk by verifying Package Complete and Package Details from the designer's point of view.
- Speeds debugging by pairing screenshots with package inventories and manifest summaries.
- Protects privacy by making stop conditions explicit before sensitive prompts or files appear.
- Keeps Codex App, Codex CLI, and Codex Computer Use roles separate.

## Definition Of Done
- Branch, SHA, build/app version, and dirty state are recorded.
- Approved apps and source files are named.
- Each assigned GUI flow is marked pass, fail, blocked, or not run.
- Screenshots, recordings, package paths, and manifest summaries are listed if collected.
- Any discrepancy is tied to exact visible evidence.
- No app code, tests, package files, release artifacts, site files, tags, releases, notarization, or deploy state are changed.

## Report Format
- Scope:
  - Branch:
  - SHA:
  - Build or app version:
  - Dirty state:
  - Approved apps:
  - Approved files:
- Results:
  - Crate launch:
  - Package Complete:
  - Package Details:
  - Settings toggles:
  - Finder output:
  - PowerPoint:
  - Keynote:
  - Figma Current Page Only:
  - Figma Entire File:
  - Creative app lane:
  - Jenna-machine real-file installed-app QA:
    - Installed DMG app path/version:
    - Source-copies folder:
    - Test-photos used:
    - Workflows run:
    - Lanes run:
    - Clean baseline package:
    - Combined Adobe + Figma:
    - Unexpected-file audit:
    - Duplicate-file audit:
    - Triage/autoreview routing:
    - Pass/fail decision:
- Artifacts:
  - Screenshots:
  - Recordings:
  - Package folders:
  - Manifest summaries:
- Findings:
  - Bugs:
  - Expected limitations:
  - Blockers:
  - Privacy concerns:
- Commands run:
- Files changed:
- Risks:
- Whether Bryant can proceed:
