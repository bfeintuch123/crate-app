# Smoke 1 - Installed App Launch And Interaction

## Purpose

Verify a QA prerelease installs cleanly and Crate is readable, visible, and interactable as a normal macOS app.

## Jenna Prompt Template

```text
Use Terminal and Computer Use on Jenna's Mac.

Goal:
Install and verify Crate <QA_VERSION> from <DMG_URL>.

Scope:
- Installed app only.
- Do not inspect unrelated private files.
- Do not package.
- Use System Events coordinate fallback if direct Computer Use clicks hit the known action-channel issue.

Steps:
1. Stop running Crate.
2. Move old /Applications/Crate.app to Trash with a versioned name.
3. Mount the DMG.
4. Verify DMG app metadata:
   - version is <QA_VERSION>
   - bundle ID is com.crate.app
   - NSAppleEventsUsageDescription exists
   - Apple Events entitlement exists
5. Copy Crate.app into /Applications.
6. Launch /Applications/Crate.app.
7. Verify visible normal app window.
8. Navigate Projects, Files, Settings, and Quick Package.
9. Open the project form, type "<QA_VERSION> smoke test", and cancel without creating a project.
10. Quit and relaunch Crate.

Expected:
- Crate launches visibly.
- UI is readable and interactable.
- Projects, Files, Settings, Quick Package, and project form are reachable.
- Text input works.
- Quit/relaunch works.
- No project is created.

Return a structured Crate QA Smoke Report.
```
