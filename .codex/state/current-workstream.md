# Crate Current Workstream

Last updated: 2026-06-16

## Current Status

- Active repo: crate-app
- Canonical branch: `v2.4.x`
- Latest internal QA prerelease in this thread: `v2.8.0-qa.24`
- Latest known public-stable release: not updated in this workstream
- Current phase: continue internal QA toward public `v2.8.0` readiness
- Command center: current Codex thread
- Durable memory target: repo docs and playbooks

## Latest QA Result

`v2.8.0-qa.24` passed:

- Smoke 1 - installed-app launch and interaction
- Smoke 2 - clean Illustrator no-save live linked asset

Smoke 2 result:

- `IMG_5331.JPG` appeared under Files Waiting For Review.
- Visible status was `Needs save`.
- Visible copy said the linked asset was observed from `Bris Invitation-03 copy.ai` and should be saved to make package-ready.
- The linked image was not package-ready before save.
- No old package outputs, Crate Diagnostics, or unrelated stale files appeared.

## Recent Fix Trail

- PR #83: removed unsafe active-session Illustrator `file path of pItem` fallback.
- PR #84: replaced failing Illustrator document `full name` path reads with safer document file path reads.
- PR #88: remediated high-severity `form-data` audit blocker for qa.23.
- PR #89: fixed Illustrator placed-item file/path reads by running them inside the Illustrator app context while keeping guarded per-item fallback behavior.

## Current Next Action

Continue feature smoke testing from `v2.8.0-qa.24`.

Recommended next lanes:

1. Quick Package behavior and output exclusions.
2. Figma Current Page Only / Entire File scope.
3. PowerPoint and Keynote saved extraction.
4. PSD embedded safety.
5. Package Details and optional diagnostics behavior.

## Known Non-Blocking Public-Release Follow-Ups

- package copy error redaction
- Quick Package missing-path privacy
- Quick Package diagnostics / Package Details parity
- Quick Package output-location clarity
- normal project repackage affordance
- moderate `uuid` advisory decision/remediation
- deeper Photoshop/InDesign Automation diagnostics if app-specific issues appear
- future AI reviewer for ambiguous evidence, not included in current QA train

## Stop Conditions

Stop and ask Bryant before:

- final public `v2.8.0`
- get-crate.com update
- crate-web deploy
- dependency mutation
- credentials or Keychain handling
- unapproved private file inspection
- build, release, tag, notarization, or site mutation outside an explicit release-gate prompt
- broadening scope beyond the active QA lane

## Exact Next Prompt

```text
Use the Crate router and Jenna smoke prompt bank. Generate the next Jenna qa.24 smoke prompt for Quick Package behavior and output exclusions. Keep it privacy-safe, installed-app focused, and scoped to Jenna-approved QA fixtures only.
```
