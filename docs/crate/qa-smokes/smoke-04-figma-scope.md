# Smoke 4 - Figma Scope

## Purpose

Verify Figma Current Page Only default, Entire File opt-in, token privacy, and package-time scope enforcement.

## Jenna Prompt Template

```text
Use installed Crate <QA_VERSION> and Jenna-approved Figma fixtures.

Goal:
Run Figma scope smoke.

Scope:
- Use approved Figma test file/link only.
- Do not expose Figma tokens.
- Do not inspect unrelated Figma files.
- Do not package unrelated Desktop/iCloud/Downloads files.

Steps:
1. Confirm Figma token UI/copy remains privacy-safe.
2. Create or use an approved Crate QA project.
3. Add the approved Figma link.
4. Verify Current Page Only is the default.
5. Package or inspect expected Current Page Only behavior.
6. Opt into Entire File and verify expanded behavior only when selected.
7. Inspect output and UI warnings.

Expected:
- Current Page Only is default.
- Entire File is opt-in.
- Scope is enforced at package time.
- Token is not exposed in UI, logs, diagnostics, or reports.
- Fail-closed behavior remains if page lock cannot resolve.

Return a structured Crate QA Smoke Report.
```
