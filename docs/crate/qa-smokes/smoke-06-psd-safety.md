# Smoke 6 - PSD Safety

## Purpose

Verify PSD embedded safety behavior and package readiness boundaries.

## Jenna Prompt Template

```text
Use installed Crate <QA_VERSION> and approved PSD fixtures.

Goal:
Run PSD safety smoke.

Scope:
- Use approved PSD copies only.
- Do not inspect unrelated Photoshop files.
- Do not package private files, stale outputs, or diagnostics unless explicitly enabled.

Steps:
1. Create a fresh Crate QA project.
2. Add/open the approved PSD fixture.
3. Inspect Crate file list and any Needs Review rows.
4. Package only if the smoke scope explicitly asks for package verification.
5. Inspect Package Details or diagnostics if enabled.

Expected:
- Embedded PSD assets follow existing safety rules.
- Unsafe or ambiguous live assets are not silently package-ready.
- Package output contains expected approved files only.
- No private path leakage appears in UI, diagnostics, or reports.

Return a structured Crate QA Smoke Report.
```
