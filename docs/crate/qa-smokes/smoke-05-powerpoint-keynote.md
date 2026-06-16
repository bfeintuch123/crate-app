# Smoke 5 - PowerPoint And Keynote Saved Extraction

## Purpose

Verify saved PowerPoint and Keynote extraction behavior, including Keynote filename encoding regressions.

## Jenna Prompt Template

```text
Use installed Crate <QA_VERSION> and approved PowerPoint/Keynote fixtures.

Goal:
Run PowerPoint and Keynote saved extraction smoke.

Scope:
- Use approved copied fixtures only.
- Do not inspect unrelated presentations.
- Do not include stale package outputs or diagnostics unless explicitly enabled.

Steps:
1. Create a fresh Crate QA project.
2. Add/open the approved PowerPoint fixture and package or inspect extracted media behavior.
3. Add/open the approved Keynote fixture and package or inspect extracted media behavior.
4. Verify expected media extraction and file names.
5. Verify Keynote mojibake regression remains fixed.
6. Inspect output folder and Package Details if enabled.

Expected:
- Saved PowerPoint extraction includes expected embedded media.
- Saved Keynote extraction includes expected embedded media.
- Keynote filenames are readable and not mojibake-corrupted.
- Package output excludes stale package-output and Crate Diagnostics unless enabled.

Return a structured Crate QA Smoke Report.
```
