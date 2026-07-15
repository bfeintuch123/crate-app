# Crate Tester Intake Playbook

## Purpose
Turn external designer testing into structured, useful Crate product feedback.

Tester intake is process infrastructure. It should preserve real designer context, protect private work, collect diagnostic artifacts, and make feedback specific enough that Bryant or Codex can triage it without guessing.

## When To Use
- Before inviting a new external designer, agency partner, or trusted user to test Crate.
- When Bryant needs a repeatable test brief for a designer workflow.
- When feedback arrives as a screen recording, package folder, screenshot, or informal message and needs to become structured intake.
- Before converting tester feedback into `.codex/playbooks/crate-bug-triage.md`.
- Before a tester rollout where privacy boundaries and artifact collection need to be explicit.

## Start Prompt
Use a prompt like:

```text
Use .codex/playbooks/crate-tester-intake.md to turn this Crate tester session into structured feedback. Capture tester profile, creative stack, assigned workflow, expected versus actual behavior, package output, optional Crate Diagnostics/crate-provenance.json when diagnostics were enabled, privacy notes, severity hints, and do not expose private client assets.
```

## Tester Onboarding
Give each tester a short brief before they begin:

- Crate packages creative project dependencies. Optional diagnostic reports can write `Crate Diagnostics/crate-provenance.json` so package contents can be reviewed when the setting is enabled.
- Testers should use real designer workflows where possible because real workflows expose cross-app, cloud-drive, and local-file behavior that synthetic demos miss.
- Testers must not upload or share private, confidential, client-owned, credential-bearing, or personal documents unless Bryant explicitly clears that exact material.
- Feedback is most useful when it says what the tester expected Crate to do, what Crate actually did, and what artifacts prove the result.
- Crate package output and optional diagnostic manifests are key diagnostic artifacts. Diagnostics are off by default, so testers must enable `Include diagnostic report in packages` before expecting `Crate Diagnostics/crate-provenance.json`; default package output should not contain a package-root manifest.

## Tester Profile Capture
Capture enough context to interpret the report without collecting unnecessary personal data:

- tester name or alias
- role or persona, such as brand designer, art director, production designer, motion designer, presentation designer, freelancer, agency designer, in-house designer, or founder
- approximate design experience level
- operating system and device class
- Crate version tested, if visible
- whether the tester installed Crate for the first time or updated an existing install
- whether the tester was supervised live, self-guided, or reviewing a prepared scenario
- whether artifacts are synthetic, cleared client work, or private work that must not be shared further

Profile and recruiting context belongs in the approved private intake system. Do not copy names, emails, profile/portfolio links, demographics, or raw project details into canonical tester-feedback JSON. Canonical findings use only pseudonymous `source_id` and `session_id` values.

Generate those IDs with Crate Ops `create_tester_feedback_ids.py`, keep the source-to-tester mapping private, and reuse a tester's source ID in later sessions. Use a session-level collection date rather than an exact interview timestamp. Before canonical validation, Bryant, Jenna, or both must confirm the record contains no identity, filename, path, URL, private asset, or recruiting detail and populate the required privacy-review owner and date fields.

## Creative Stack Capture
Capture the tester's normal creative stack and which pieces were active during the session:

- Figma:
  - browser or desktop use
  - Current Page Only or Entire File expectation
  - collaborative file, personal draft, design system, or client file
  - local image imports, component dependencies, or library references
- Photoshop:
  - PSDs, linked assets, embedded smart objects, cloud documents, or local files
  - whether linked files live beside the PSD, in Downloads, in a shared drive, or on an external drive
- Illustrator:
  - AI files, linked images, placed PDFs, SVGs, or exports handed to another app
  - whether links are embedded or external
- InDesign:
  - INDD files, linked images, placed AI/PDF files, package-like workflows, or missing links
  - whether links live in a Links folder, cloud drive, or external drive
- PowerPoint/Keynote:
  - embedded images, videos, audio, pasted graphics, exported decks, or assets handed from Adobe/Figma
  - whether the deck was local, cloud-synced, or opened from a shared folder
- local files:
  - Downloads, Desktop, project folders, exports folders, asset libraries, temp folders
- cloud drives and external drives:
  - iCloud Drive, Google Drive, Dropbox, OneDrive, shared server, NAS, USB drive, external SSD
  - whether files were online-only, available offline, or disconnected during testing

Do not collect passwords, tokens, cloud-drive credentials, raw API responses, private client contracts, private personal documents, or confidential client assets unless Bryant explicitly approves collection.

## Workflow Assignment
Assign one clear workflow per tester session unless Bryant wants exploratory testing.

Recommended workflow categories:

- Figma Current Page Only package.
- Figma Entire File package.
- Figma file with imported local images.
- Figma collaborative multi-page file.
- Photoshop to Figma handoff.
- Photoshop to PowerPoint handoff.
- Illustrator to InDesign handoff.
- Illustrator to PowerPoint handoff.
- PSD linked smart object package.
- PSD embedded smart object package.
- PowerPoint embedded media package.
- Local Downloads asset used in a destination app.
- External drive or custom folder asset used in a destination app.
- Multiple apps open with unrelated files to test exclusion behavior.

Each assignment should state:

- source app or apps
- destination app, if any
- project scope setting
- assets expected to be included
- assets expected to be excluded
- package output folder to preserve
- screen recording and screenshot expectations
- what counts as a pass, fail, or unclear result

## Test Scenario Instructions
Use these steps as the default structure:

1. Start screen recording before opening or packaging the workflow.
2. Show the source file, relevant page/artboard/slide, and expected source assets.
3. Use the workflow naturally, including normal handoffs between Figma, Adobe apps, PowerPoint, Keynote, local folders, or cloud drives.
4. Run Crate packaging using the assigned scope.
5. Open the package output folder after Crate finishes.
6. Confirm whether expected files are present.
7. Confirm whether unexpected private, out-of-scope, wrong-page, or unrelated files are absent.
8. If `Include diagnostic report in packages` was enabled, locate `Crate Diagnostics/crate-provenance.json`.
9. Record any warning, error, install prompt, security prompt, or confusing UI state.
10. Fill out the tester feedback template.

The tester should not clean up, rename, or reorganize the package output before Bryant has had a chance to review it.

## Screen Recording Guidance
Ask testers to record:

- the start state before packaging
- source app windows and relevant files
- Crate scope choices and package action
- package completion or failure state
- package output folder contents
- any unexpected UI prompt, permission prompt, install warning, crash, or error

Ask testers to avoid recording:

- passwords, passkeys, token dialogs, browser password managers, private messages, emails, or personal documents
- confidential client content unless cleared
- cloud-drive admin panels or account settings

If the workflow contains private visuals, testers may blur or crop visuals as long as file names, package structure, and Crate behavior remain understandable.

## Package Artifact Collection
When safe and approved, collect:

- package output folder path
- a zipped package output if the assets are synthetic or cleared
- optional `Crate Diagnostics/crate-provenance.json` when diagnostic reports were enabled
- screenshots of package contents
- screenshots of missing or unexpected files
- Crate error messages or warnings
- source file names and folder layout, with private details redacted when needed
- Crate version and macOS version

If the package contains private or client-confidential material, do not upload the package. Instead collect a redacted inventory and keep the raw package local unless Bryant explicitly approves transfer.

## Crate Diagnostics/crate-provenance.json Collection
`Crate Diagnostics/crate-provenance.json` is one of the most useful artifacts when diagnostic reports are enabled. Ask for it whenever safe, but do not expect a package-root manifest by default.

Before sharing a manifest, check for:

- private client names in paths or file names
- private user names in home paths
- signed URLs, CDN URLs, tokens, credentials, cookies, or Authorization headers
- raw app output that should not leave the tester's machine
- references to confidential assets

If the manifest cannot be shared, collect a redacted summary:

- node count and node types
- edge count and relation types
- package counts
- warnings
- missing expected relationships
- surprising included or excluded assets
- whether private values had to be removed

## Privacy Guidance
Default to privacy-preserving collection:

- Prefer synthetic or cleared test files for any artifact that will be uploaded.
- Use real designer workflows where possible, but do not upload private or confidential client work unless cleared.
- Redact client names, personal home paths, usernames, emails, tokens, signed URLs, and unrelated project names.
- Keep raw package outputs local when permission is unclear.
- Do not ask testers for account passwords, Figma tokens, Adobe tokens, cloud-drive credentials, Apple credentials, private client contracts, or personal documents.
- Do not preserve raw screen recordings that accidentally capture secrets; ask for a trimmed or redacted recording instead.

## What Not To Collect
Do not collect:

- passwords
- passkeys
- tokens
- credentials
- cookies
- Authorization headers
- private browser sessions
- confidential client assets unless explicitly approved
- private personal documents
- unrelated emails, messages, calendars, or contacts
- full cloud-drive folders unrelated to the test
- raw command output that includes secrets or private local system scans

## Severity Hints
Use these hints to label feedback before triage. They are not final engineering severity.

- Critical:
  - install or security issue blocks use
  - package output exposes private or unrelated files
  - package operation corrupts, overwrites, or deletes user files
- High:
  - package failure blocks the assigned workflow
  - wrong asset included
  - confidential out-of-scope asset included
  - expected key asset missed
  - `Crate Diagnostics/crate-provenance.json` contains private token-like data or materially wrong manifest claims
- Medium:
  - provenance manifest issue that does not expose private data
  - missing secondary asset
  - incorrect confidence or relationship hint
  - UI confusion causes likely misuse but has a workaround
- Low:
  - unclear copy, rough edge, cosmetic UI confusion, or documentation gap
  - tester setup issue with an obvious correction
  - expected current limitation that needs clearer messaging

Required categories:

- missed asset
- wrong asset included
- package failure
- provenance manifest issue
- UI confusion
- install/security issue

## Tester Feedback Template
Use this template for each session:

```md
# Crate Tester Feedback

## Tester
- Name or alias:
- Role/persona:
- Experience level:
- macOS version:
- Crate version:
- New install or update:

## Creative Stack
- Figma:
- Photoshop:
- Illustrator:
- InDesign:
- PowerPoint/Keynote:
- Local files:
- Cloud drives/external drives:

## Assigned Workflow
- Workflow:
- Source app/files:
- Destination app/files:
- Scope setting:
- Expected included assets:
- Expected excluded assets:

## Result
- Expected Crate behavior:
- Actual Crate behavior:
- Pass/fail/unclear:
- Severity hint:
- Category:

## Artifacts
- Screen recording:
- Screenshots:
- Package output path or archive:
- Crate Diagnostics/crate-provenance.json:
- Redactions applied:

## Privacy
- Assets are synthetic, cleared, private, or unknown:
- Confidential material included:
- Sharing approved by:

## Notes
- Tester quote or observation:
- Follow-up questions:
- Suggested next playbook:
```

After reviewing this human-facing intake, convert each distinct finding into one schema-valid JSON record using Crate Ops `schemas/crate-tester-feedback-record.schema.json`. Do not treat the Markdown intake itself as canonical structured evidence. Intake and private evidence custody remain owned by `tester-feedback-loop`; sanitized conversion and validation are owned by `tester-canonicalization-loop`; confirmed bugs continue to QA synthesis and bug triage.

## Files Codex May Read
- `AGENTS.md`
- `.codex/playbooks/*.md`
- `docs/*.md`
- tester-provided markdown, screenshots, package inventories, and redacted manifests
- approved package output directories under `/private/tmp` or another Bryant-approved local path
- optional `Crate Diagnostics/crate-provenance.json` diagnostic manifests explicitly provided for intake

## Files Codex May Modify
- None by default.
- With Bryant's explicit approval for process docs, Codex may modify `.codex/playbooks/*.md`, `docs/*.md`, or `AGENTS.md` playbook references.
- With Bryant's explicit approval for intake drafting, Codex may write redacted intake notes under `/private/tmp/crate-tester-intake-*`.

## Files Codex Must Not Modify
- `main.js`
- `preload.js`
- `renderer/`
- `parsers/`
- `scripts/`
- `tests/`
- `package.json`
- `package-lock.json`
- release artifacts
- `crate-site/`
- private tester assets or package outputs

## Commands Codex May Run
Capture branch and docs state when doing repo work:

```sh
git status --short --branch
git branch --show-current
git diff --name-only
git diff --stat
git diff --check
```

Inspect approved tester artifacts:

```sh
find <approved-package-output> -maxdepth 4 -type f | sort
diagnostic_manifest="<approved-package-output>/Crate Diagnostics/crate-provenance.json"
test -f "$diagnostic_manifest"
node -e "const fs=require('fs'); const p=process.argv[1]; const m=JSON.parse(fs.readFileSync(p,'utf8')); const pkg=m.package||m; const legacyErrors=Array.isArray(pkg.errors)?pkg.errors:[]; console.log(JSON.stringify({schemaVersion:m.schemaVersion,scope:m.scope||'legacy',copiedCount:pkg.copiedCount,embeddedCount:pkg.embeddedCount,totalFiles:pkg.totalFiles,errorCount:Number.isSafeInteger(pkg.errorCount)?pkg.errorCount:legacyErrors.length,errorCategories:pkg.errorCategories||{},nodes:(m.nodes||[]).length,edges:(m.edges||[]).length,warnings:m.warnings||[]}, null, 2));" "$diagnostic_manifest"
rg -n "token|secret|credential|Authorization|Bearer|cookie|cdn\\.figma|password|passkey" "$diagnostic_manifest"
```

Diagnostic reports are optional and off by default. Enable `Include diagnostic report in packages` before expecting `Crate Diagnostics/crate-provenance.json`; do not expect a package-root manifest in default package output.

Inspect redacted intake notes:

```sh
rg -n "Expected Crate behavior|Actual Crate behavior|Severity hint|Category|crate-provenance|package output" <intake-notes>
rg -n "password|token|credential|Authorization|Bearer|cookie|confidential|private personal" <intake-notes>
```

## Required Checks
- Tester profile captured.
- Creative stack captured across relevant apps and storage locations.
- Workflow assignment is specific.
- Expected versus actual Crate behavior is written down.
- Package output status is captured.
- Optional `Crate Diagnostics/crate-provenance.json` status is captured or the reason it is unavailable is stated.
- Privacy and sharing approval are explicit.
- Severity hint and category are assigned.
- Follow-up questions are listed.
- Next playbook is recommended when the report is ready for triage.

## Approval Gates
Codex may draft intake text from information Bryant provides. Bryant must explicitly approve any collection or upload of package outputs, manifests, screen recordings, screenshots, private project files, or tester identity details.

Commands requiring explicit Bryant approval:

```sh
git add <docs-or-intake-files>
git commit
git push
gh issue create
gh pr create
npm start
npm install
npm ci
npx electron-builder --mac --arm64
xcrun notarytool submit <artifact> --wait
xcrun stapler staple <artifact>
xcrun stapler validate <artifact>
npx wrangler pages deploy <directory>
```

## Must Never Do
- Do not collect passwords, tokens, credentials, cookies, private browser sessions, or cloud-drive credentials.
- Do not expose private tester assets, private personal documents, or confidential client work.
- Do not upload package outputs unless they are synthetic, cleared, or explicitly approved.
- Do not edit app code, tests, package files, release files, or active local cleanup tasks.
- Do not build, release, deploy, notarize, tag, merge, or mutate dependencies.
- Do not invent tester expectations, reproduction steps, or artifact contents.
- Do not treat partial provenance as proof of a bug without triage.

## Quality Impact
- Converts subjective tester reactions into expected versus actual behavior with evidence.
- Speeds triage by collecting package output and optional `Crate Diagnostics/crate-provenance.json` up front when diagnostics were enabled.
- Reduces privacy risk by separating real workflow testing from artifact sharing.
- Makes severity and category clear before engineering time is spent.
- Helps Crate learn from real designer behavior without overcollecting sensitive material.

## Definition Of Done
- Tester profile, stack, workflow, result, artifacts, privacy status, severity hint, and follow-up questions are captured.
- Package output and optional `Crate Diagnostics/crate-provenance.json` are collected or explicitly unavailable.
- Private and confidential materials are excluded, redacted, or explicitly approved.
- The report says what the tester expected Crate to do and what actually happened.
- No app code, tests, package files, release files, builds, tags, deploys, or dependencies are changed.
- Bryant receives a structured intake record ready for bug triage or product review.

## Report Format
- Branch and dirty state when repo work was involved.
- Tester profile and creative stack.
- Assigned workflow.
- Expected versus actual behavior.
- Artifacts received and artifacts missing.
- Privacy status and redactions.
- Severity hint and category.
- Follow-up questions.
- Suggested next playbook.
- Commands run and results.
- Files changed, if any.
- Whether Bryant can proceed to triage.
