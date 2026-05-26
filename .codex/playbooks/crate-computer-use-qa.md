# Crate Computer Use QA Playbook

## Purpose
Use Codex Computer Use to run scoped GUI QA flows for Crate across Crate-supported creative apps and workflows.

This playbook is for observing and recording Crate behavior in real GUI workflows. It does not replace Codex CLI tests, release gates, or code review. It gives Bryant evidence from the parts of Crate that automated tests cannot fully exercise: app launch, macOS dialogs, source-app state, package completion UI, package review, and Finder output.

Start narrow, then expand by scoped app lane. Figma, PowerPoint, and Keynote are initial priority workflows, not the full long-term GUI QA scope.

## When To Use
- Before tester rollout when Bryant wants GUI evidence for Crate workflows.
- Before release readiness when recent changes affect packaging, Package Complete, Package Details, Settings, Figma scope, PowerPoint, Keynote, Finder output, or provenance display.
- After a GUI-only bug report where tests do not show the user-facing failure.
- When Bryant wants screenshots, recordings, and a repeatable QA transcript instead of a code change.
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
- `crate-provenance.json` from approved QA package outputs.
- `package.json` read-only for version and script context.

## Files Codex May Modify
- None by default.
- With Bryant's explicit approval, Codex may write screenshots, screen recordings, notes, and redacted QA reports under `/private/tmp/crate-computer-use-qa-*`.
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
test -f <approved-package-output>/crate-provenance.json
node -e "const fs=require('fs'); const p=process.argv[1]; const m=JSON.parse(fs.readFileSync(p,'utf8')); console.log(JSON.stringify({copiedCount:m.copiedCount,embeddedCount:m.embeddedCount,totalFiles:m.totalFiles,errors:m.errors||[],warnings:m.warnings||[],nodes:(m.nodes||[]).length,edges:(m.edges||[]).length}, null, 2));" <approved-package-output>/crate-provenance.json
rg -n "token|secret|credential|Authorization|Bearer|cookie|password|passkey|cdn\\.figma|rawTrackedFiles|/usr/sbin/lsof" <approved-package-output>/crate-provenance.json
```

Run docs-only checks only if process docs are edited:

```sh
git diff --check
rg -n "[[:blank:]]$" AGENTS.md .codex/playbooks docs
rg -n "[^[:ascii:]]" AGENTS.md .codex/playbooks docs
```

## GUI QA Setup
- Confirm the branch, build, or installed app version under test.
- Confirm whether the app under test is a local dev run, installed QA build, or released build.
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
- Compare visible Package Details to `crate-provenance.json` when a manifest is present.
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
- Confirm `crate-provenance.json` exists only when expected.

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
- redacted `crate-provenance.json` summary
- screen recording path when one was approved

Store temporary reports under `/private/tmp/crate-computer-use-qa-<id>` only after Bryant approves artifact writing. Do not store private client or tester assets in the report.

## When To Stop And Ask Bryant
- A privacy, security, automation, file-access, keychain, signing, account, or update prompt appears.
- The flow requires a private tester or client file that Bryant has not approved.
- The flow would access unrelated apps, windows, accounts, tabs, or folders.
- The source app, browser, or Crate requests credentials or cloud-account changes.
- The flow would require approving macOS security or privacy prompts through Computer Use.
- A package appears to contain private, credential, or unrelated files.
- Crate crashes, hangs, or appears to be using the wrong build.
- A test requires changing app settings beyond the approved scope.
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
