# Crate GUI Repro Flow Playbook

## Purpose
Reproduce GUI-only Crate bugs across Crate-supported creative apps and workflows that cannot be fully diagnosed from tests alone.

This playbook turns a user-facing report into a controlled GUI reproduction record: exact steps, source-app state, screenshots, package output, Package Details, optional `Crate Diagnostics/crate-provenance.json` diagnostic output, and a classification that determines whether the next step is a code fix, product clarification, manual QA, package diff, or CLI artifact triage.

Start narrow, then expand by scoped app lane. Figma, PowerPoint, and Keynote are initial priority workflows, not the full long-term GUI repro scope.

## When To Use
- A bug appears only through Crate, Finder, a Crate-supported creative app, or browser-assisted GUI state.
- Automated tests pass but the user-facing workflow still looks wrong.
- Package Complete, Package Details, Finder output, or optional `Crate Diagnostics/crate-provenance.json` diagnostic output contradict each other.
- A report mentions unexpected assets, missing assets, Figma page-scope mismatch, or save-before-package behavior.
- Bryant needs evidence before deciding whether a CLI fix branch is warranted.

## Start Prompt
Use a prompt like:

```text
Use .codex/playbooks/crate-gui-repro-flow.md to reproduce this GUI-only Crate bug. Record exact user steps, collect screenshots and approved package artifacts, classify the issue, do not modify app code during repro, and stop before private data, release, signing, deploy, or credential boundaries.
```

## Role Boundaries
- Codex Computer Use is for GUI repro and visual evidence collection.
- Codex CLI remains the source of truth for code, tests, git, release gates, and docs edits.
- Codex App remains useful for planning, triage, supervision, and QA synthesis.
- Bryant remains the human gate for sensitive actions, private assets, permissions, releases, signing, deploys, and broad scope changes.

## App Scope Tiers
Use the narrowest tier needed for the current repro task. Do not open apps outside the approved lane.

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
- Only the Crate-supported creative app or workflow lane Bryant approved for the current repro task.
- Browser only when needed for Figma authentication, Figma file access, fixture downloads, approved download verification, or an approved browser-based creative workflow.

## Apps Codex Computer Use Must Never Use
- Keychain Access.
- Apple Developer account or signing portals.
- Cloudflare dashboard or deploy surfaces.
- GitHub release creation or release upload pages.
- Password managers.
- Banking, payment, security, or identity apps.
- Mail, Messages, Notes, Photos, Calendar, or unrelated private apps.
- Private browser windows, unrelated browser tabs, or authenticated accounts outside the approved repro.
- Terminal for release, signing, notarization, deploy, tag, merge, or mutation work.
- Broad unrelated app access. App access must stay scoped to the current repro flow.

## Files Codex May Read
- `AGENTS.md`.
- `.codex/playbooks/*.md`.
- `docs/*.md`.
- approved bug reports, tester notes, or QA summaries.
- approved fixture instructions and synthetic assets.
- approved package output folders under `/private/tmp` or another Bryant-approved path.
- approved optional `Crate Diagnostics/crate-provenance.json` diagnostic manifests from repro packages when diagnostic reports were enabled.
- `package.json` read-only for version and script context.
- changed files and tests read-only only after GUI artifacts show that CLI triage is needed.

## Files Codex May Modify
- None by default.
- With Bryant's explicit approval, Codex may write screenshots, screen recordings, redacted notes, copied package inventories, and repro reports under `/private/tmp/crate-gui-repro-*`.
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
- private tester, client, or source assets.
- package output contents, unless Bryant explicitly approves copying them into a redacted temp repro folder.

## Commands And Checks Codex May Run
Capture branch and local state:

```sh
git status --short --branch
git branch --show-current
git rev-parse --short HEAD
git diff --name-only
```

Inspect package output after Bryant approves the package path:

```sh
find <approved-package-output> -maxdepth 5 -type f | sort
diagnostic_manifest="<approved-package-output>/Crate Diagnostics/crate-provenance.json"
test -f "$diagnostic_manifest"
node -e "const fs=require('fs'); const p=process.argv[1]; const m=JSON.parse(fs.readFileSync(p,'utf8')); const pkg=m.package||m; const legacyErrors=Array.isArray(pkg.errors)?pkg.errors:[]; const by=(items,key)=>(items||[]).reduce((a,x)=>{const k=(x&&x[key])||'unknown'; a[k]=(a[k]||0)+1; return a;},{}); console.log(JSON.stringify({schemaVersion:m.schemaVersion,scope:m.scope||'legacy',copiedCount:pkg.copiedCount,embeddedCount:pkg.embeddedCount,totalFiles:pkg.totalFiles,errorCount:Number.isSafeInteger(pkg.errorCount)?pkg.errorCount:legacyErrors.length,errorCategories:pkg.errorCategories||{},warnings:m.warnings||[],nodesByType:by(m.nodes,'type'),edgesByType:by(m.edges,'relationType')}, null, 2));" "$diagnostic_manifest"
rg -n "token|secret|credential|Authorization|Bearer|cookie|password|passkey|cdn\\.figma|rawTrackedFiles|/usr/sbin/lsof" "$diagnostic_manifest"
```

Diagnostic reports are optional and off by default. Enable `Include diagnostic report in packages` before expecting `Crate Diagnostics/crate-provenance.json`; do not expect a package-root manifest in default package output.

Prepare CLI artifact triage only after GUI repro evidence exists:

```sh
git diff --name-only
rg -n "PowerPoint|Keynote|Figma|Photoshop|Illustrator|InDesign|After Effects|Acrobat|Sketch|Affinity|Pixelmator|Package Details|crate-provenance|copiedCount|embeddedCount" docs .codex/playbooks tests main.js
```

Run docs-only checks only if process docs are edited:

```sh
git diff --check
rg -n "[[:blank:]]$" AGENTS.md .codex/playbooks docs
rg -n "[^[:ascii:]]" AGENTS.md .codex/playbooks docs
```

## Repro Principles
- Record exact user-visible steps before inferring cause.
- Use synthetic, minimal, or explicitly approved assets.
- Confirm the approved app tier and exact app lane before opening source apps.
- Keep the first repro as close as possible to the user's report.
- Change one variable at a time after the first repro.
- Compare Package Details against Finder output and `Crate Diagnostics/crate-provenance.json` only when the diagnostic report setting was enabled and a manifest is present.
- Treat screenshots and package folders as evidence, not guesses.
- Do not modify app code during repro.
- Do not claim root cause without artifacts.

## Required Repro Record
For every attempted repro, record:

- branch and SHA
- app build or installed version
- macOS version when available
- source app and version when available
- exact user steps, numbered in order
- input file identity, redacted when needed
- Crate settings before the run
- expected result
- actual result
- Package Complete state
- Package Details state
- Finder package output path
- `Crate Diagnostics/crate-provenance.json` summary when diagnostics were enabled and a manifest is present
- screenshots or recording paths when approved
- whether the issue reproduced
- whether private assets were avoided or approved

## Target Repro Flows

### PowerPoint Save-Before-Package Behavior
Reproduce when a report says PowerPoint edits, linked media, embedded media, or file changes are missing unless the deck is saved.

Steps:
- Open the approved PowerPoint deck.
- Record whether the deck starts saved or dirty.
- Make only the approved edit needed for the repro.
- Package once before saving if Bryant approved that scenario.
- Save the deck.
- Package again after saving.
- Compare Package Complete, Package Details, Finder output, and `Crate Diagnostics/crate-provenance.json` between runs when diagnostics were enabled.

Classify:
- Real bug if Crate claims it packaged unsaved content but output does not match, or if saved content is missed without warning.
- Expected limitation if Crate can only see saved PowerPoint state and the UI makes that limitation clear.
- Product requirement gap if the desired unsaved-state handling is not defined.
- Needs CLI artifact triage if package output or manifest evidence is inconsistent and the GUI repro is reliable.

### Unexpected Or Extra Asset Reports
Reproduce when a package includes files the user did not expect.

Steps:
- Record all open source apps and visible documents.
- Close unrelated apps only if the original report did not include them; otherwise preserve the reported state.
- Package the approved workflow.
- Inspect Finder output for extra files.
- Compare extra files with Package Details and `Crate Diagnostics/crate-provenance.json` when diagnostics were enabled.
- Check whether extras came from the same folder, another open app, prior activity, embedded extraction, or Figma scope.

Classify:
- Real bug if unrelated files are included without evidence.
- Expected limitation if Crate includes a documented broad dependency and explains it clearly.
- Product requirement gap if expected inclusion rules are ambiguous.
- Needs CLI artifact triage if file origin is visible in the manifest but behavior needs parser or package-output analysis.

### Missing Asset Reports
Reproduce when a package omits an expected file, media item, or Figma asset.

Steps:
- Confirm the expected asset is present and visible in the source app.
- Confirm whether the source document was saved.
- Confirm whether the asset is embedded, linked, cloud-backed, or generated.
- Package the approved workflow.
- Inspect Package Details, Finder output, and `Crate Diagnostics/crate-provenance.json` when diagnostics were enabled.
- Record warnings, errors, needs-review entries, and missing-file messaging.

Classify:
- Real bug if an eligible saved or materialized asset is omitted without warning.
- Expected limitation if the app cannot expose the source relationship and Crate reports partial confidence.
- Product requirement gap if Bryant expects support for a case Crate does not yet define.
- Needs CLI artifact triage if the missing asset appears in manifest evidence but not package output.

### Figma Current Page Only Mismatch
Reproduce when Current Page Only includes other-page assets or misses current-page assets.

Steps:
- Use an approved Figma file with at least two pages and visually distinct assets.
- Record the current Figma page before packaging.
- Confirm Crate is set to Current Page Only.
- Package the workflow.
- Inspect Package Complete, Package Details, Finder output, and `Crate Diagnostics/crate-provenance.json` when diagnostics were enabled.
- Repeat only if Bryant approves changing page, scope, or file.

Classify:
- Real bug if other-page-only assets are included, current-page assets are missed, or page-lock failure silently widens scope.
- Expected limitation if Figma does not expose the page evidence and Crate fails closed or reports the limitation clearly.
- Product requirement gap if desired cross-page behavior is not defined.
- Needs CLI artifact triage if manifest scope and package output disagree.

### Finder Package Inspection
Use Finder inspection for every GUI repro.

Steps:
- Open the exact package output folder.
- Screenshot top-level contents.
- Expand expected subfolders only as needed.
- Record missing files, extra files, duplicates, and unexpected locations.
- Confirm output stays inside the selected package root.

Pass:
- Finder output matches the expected inventory for the repro.

Fail:
- Files are missing, extra, outside the root, duplicated unexpectedly, or named in a way that hides source identity.

### Package Details And Manifest Comparison
Use this comparison whenever diagnostic reports were enabled and `Crate Diagnostics/crate-provenance.json` exists.

Steps:
- Screenshot Package Details collapsed and expanded states.
- Summarize `Crate Diagnostics/crate-provenance.json` counts and warnings with the approved command.
- Compare Package Details labels to manifest evidence.
- Flag overclaims, missing warnings, unexplained included files, and manifest/package count mismatches.

Pass:
- Package Details accurately summarizes package output and does not overclaim provenance certainty.

Fail:
- Package Details contradicts Finder output, hides important warnings, or claims source relationships not supported by the manifest.

### Supported Creative App Lane Repro
Use this flow for approved Tier 3 or Tier 4 apps and workflows after the core Tier 1 smoke tests and any relevant Tier 2 priority repro work.

Steps:
- Open only the approved source app, document, folder, or browser workflow for the lane.
- Record the app name, version when visible, document state, save state, linked/embedded media state, and relevant Crate settings.
- Reproduce the reported workflow as closely as possible.
- Capture Package Complete, Package Details, Finder output, and manifest summary when present.
- Compare included and missing files against the reported behavior and expected lane behavior.

Classify:
- Real bug if Crate packages unrelated app files, misses expected eligible files without warning, silently widens scope, or overclaims source evidence.
- Expected limitation if the source app or OS cannot expose the relationship and Crate reports the limitation clearly.
- Product requirement gap if Bryant expects support for a case Crate does not yet define.
- Needs CLI artifact triage if package output or manifest evidence is inconsistent and the GUI repro is reliable.

## Classification Rules
Every repro result must end in one of these classifications:

- Real bug: observed behavior contradicts Crate's expected behavior or safety guardrails, with artifacts.
- Expected limitation: behavior is constrained by source-app or OS visibility and Crate communicates that limitation adequately.
- Product requirement gap: desired behavior is plausible but not yet specified as required Crate behavior.
- Needs CLI artifact triage: GUI evidence is sufficient, but diagnosis requires code, parser, manifest, test, or package-diff analysis.
- Inconclusive: repro lacked approved files, permissions, source-app state, screenshots, or package artifacts needed for a reliable conclusion.

## When To Stop And Ask Bryant
- The repro needs private tester, client, or source assets that are not explicitly approved.
- The repro requires a privacy, security, automation, keychain, signing, account, update, or browser credential approval.
- The repro would require approving macOS security or privacy prompts through Computer Use.
- The repro would access unrelated apps, windows, accounts, tabs, or folders.
- The package appears to contain secrets, credentials, private paths, unrelated files, or client content.
- Source-app state differs materially from the report and cannot be recreated safely.
- A step would modify app code, tests, package files, dependencies, release files, site files, tags, releases, or deploy state.
- The next useful step is CLI artifact triage or implementation work.

## Approval Gates
Codex may run read-only repository checks and observe approved GUI workflows. Bryant must explicitly approve:

- opening private, tester, client, cloud, or account-backed assets
- screen recording
- writing screenshots, recordings, reports, copied inventories, or redacted package summaries
- creating package outputs from private files
- granting macOS permissions
- changing Crate Settings values beyond the repro instructions
- expanding app access beyond the current repro lane
- switching branches
- launching a dev build with `npm start`
- moving from GUI repro into CLI artifact triage
- committing, pushing, merging, tagging, releasing, building, notarizing, stapling, or deploying

## Must Never Do
- Do not guess root cause without screenshots, package output, manifest evidence, or a clear reproduction transcript.
- Do not modify app code during repro.
- Do not edit `main.js`.
- Do not edit tests.
- Do not modify `package.json` or `package-lock.json`.
- Do not build, release, deploy, notarize, staple, tag, merge, commit, push, or mutate dependencies.
- Do not touch private tester or client assets without approval.
- Do not approve privacy, security, automation, keychain, signing, developer, account, or browser credential prompts.
- Do not open Keychain, Apple Developer, Cloudflare, GitHub release pages, password managers, banking/payment/security apps, unrelated apps, private windows, or unrelated browser tabs.
- Do not alter package output contents to make the repro cleaner.
- Do not treat a non-repro as closure if the test omitted required GUI state, permissions, app version, or source files.
- Do not treat one creative app lane as coverage for another lane without evidence.

## Quality Impact
- Reduces speculative fixes by requiring artifacts before root-cause claims.
- Speeds bug triage by separating real bugs from expected limitations and product requirement gaps.
- Gives Codex CLI enough evidence to target parser, package, provenance, or UI work without rereproducing everything.
- Protects private assets by making approvals and stop conditions explicit.
- Keeps GUI QA, CLI implementation, and Bryant's merge/release decisions separate.

## Definition Of Done
- Exact user steps are recorded.
- Source app, Crate settings, package output, Package Details, and manifest evidence are captured or marked unavailable.
- The issue is classified as real bug, expected limitation, product requirement gap, needs CLI artifact triage, or inconclusive.
- Any required next playbook is named.
- No app code, tests, package files, release artifacts, site files, tags, releases, notarization, or deploy state are changed.

## Report Format
- Scope:
  - Branch:
  - SHA:
  - Build or app version:
  - Dirty state:
  - Source app:
  - Approved files:
- Repro:
  - Original report:
  - Exact steps:
  - Expected result:
  - Actual result:
  - Reproduced:
- Evidence:
  - Screenshots:
  - Recording:
  - Creative app lane:
  - Package folder:
  - Finder findings:
  - Package Details findings:
  - Manifest summary:
- Classification:
  - Result:
  - Evidence:
  - Next playbook:
- Commands run:
- Files changed:
- Risks:
- Whether Bryant can proceed:
