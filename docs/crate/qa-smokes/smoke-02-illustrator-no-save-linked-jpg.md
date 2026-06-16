# Smoke 2 - Illustrator No-Save Linked JPG

## Purpose

Verify Crate detects a newly placed Illustrator linked image before save and stages it as pending or needs-save, not package-ready.

## Current Passing Baseline

`v2.8.0-qa.24` passed this smoke. `IMG_5331.JPG` appeared under Files Waiting For Review with `Needs save`.

## Jenna Prompt Template

```text
Use Computer Use/System Events and Illustrator on Jenna's Mac.

Goal:
Run Crate <QA_VERSION> Smoke 2 - clean Illustrator no-save linked JPG.

Scope:
- Use installed /Applications/Crate.app version <QA_VERSION>.
- Use only approved QA copies under <QA_ROOT>.
- Do not save the Illustrator document.
- Do not package.
- Do not inspect unrelated private files.

Setup:
1. Close any unrelated Illustrator documents without saving when they are prior QA docs.
2. Confirm Illustrator has zero open documents.
3. Confirm source AI copy is clean and does not contain IMG_5331.
4. Create a fresh Crate project named "Jenna Illustrator Watch No Save QA <QA_VERSION>".
5. Start Watching before opening Illustrator.

Steps:
1. Open the approved source AI copy.
2. Place linked IMG_5331.JPG from the approved test-photos folder.
3. Confirm Illustrator is dirty/modified and the linked placed image exists.
4. Return to Crate and wait at least one refresh interval.
5. Inspect visible files, pending/review rows, breadcrumbs, and local Crate state if needed.

Expected:
- The open AI document appears in the active session.
- IMG_5331.JPG appears as observed, pending, needs-save, or needs-review before save.
- IMG_5331.JPG is not package-ready before save/accept/parser confirmation.
- No stale QA roots, package-output files, Crate Diagnostics, or unrelated private files appear.

Return a structured Crate QA Smoke Report with breadcrumb fields:
- pollFired
- appRunning
- scriptAttempted
- scriptSuccess
- docsCount
- linksCount
- placedItemsCount when available
- normalizedCount
- stagedCount
- errorCategory
```
