# Smoke 3 - Quick Package

## Purpose

Verify Quick Package remains scoped, privacy-safe, and clear about missing paths and output location.

## Jenna Prompt Template

```text
Use installed Crate <QA_VERSION> on Jenna's Mac.

Goal:
Run Quick Package smoke using approved QA fixtures.

Scope:
- Use only approved copied fixtures under <QA_ROOT>.
- Do not inspect unrelated folders.
- Do not include old package-output, Crate Diagnostics, or unrelated Desktop/iCloud/Downloads files.
- Package only to the approved output folder.

Steps:
1. Launch Crate.
2. Open Quick Package.
3. Add approved fixture files.
4. Run package to the approved output folder.
5. Inspect visible UI, output folder inventory, warnings, missing-path behavior, and diagnostics behavior if enabled.

Expected:
- Quick Package includes only selected/valid approved files and expected extracted dependencies.
- Missing paths do not expose private path details beyond approved context.
- Package output is clear and excluded from live auto-capture.
- Crate Diagnostics is excluded unless explicitly enabled and expected.

Return a structured Crate QA Smoke Report.
```
