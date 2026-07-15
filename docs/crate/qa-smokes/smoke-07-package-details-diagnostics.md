# Smoke 7 - Package Details And Diagnostics

## Purpose

Verify Package Details and optional diagnostics explain package contents without exposing private data.

## Jenna Prompt Template

```text
Use installed Crate <QA_VERSION> and approved QA fixtures.

Goal:
Run Package Details and optional diagnostics smoke.

Scope:
- Use approved fixtures and output folder only.
- Do not inspect unrelated private files.
- Enable diagnostics only when the smoke explicitly asks for it.

Steps:
1. Launch Crate and open Settings.
2. Verify Package Details and diagnostics toggles are visible and understandable.
3. Create or use an approved QA project.
4. Package with diagnostics disabled and inspect default output.
5. Package with diagnostics enabled only if approved for this smoke.
6. Inspect Package Details and optional `Crate Diagnostics/crate-provenance.json` summary.

Expected:
- Provenance remains internal language.
- Designer-facing UI uses Package Details, Included Files, File Sources, Needs Review, Why included, Extracted from, Linked from, and Used in.
- Diagnostics are optional.
- The report declares schema version 2, minimized package-relevant scope, metadata-only content, and report-local identifiers.
- Aggregate package counts, fixed error categories, allowlisted graph types, and confidence bands remain available for support.
- No project identity, filenames, resource names, raw errors, timestamps, persistent graph IDs, paths, tokens, signed URLs, broad private file lists, payloads, or raw AppleScript/JXA output leak into reports.

Return a structured Crate QA Smoke Report.
```
