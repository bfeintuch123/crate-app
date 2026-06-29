# Crate macOS Redesign State Coverage Review

Date: 2026-06-27

## Source

Jenna's current Figma direction was reviewed against the Crate qa41 UI integration brief.

## Bottom Line

Keep the visual direction. Add missing app states.

The Wispr-style shell is a good brand and layout direction. The current Figma file is not engineering-ready yet because it mostly covers Home, Settings, and notes rather than the actual Crate packaging workflow.

The work now is not to invent new product areas. The work is to design the existing backend-supported state machine.

## Missing Required States

Missing or underdesigned:

- Empty state with no active projects.
- Projects view.
- Files view.
- Add Project / Start Project flow.
- Quick Package entry point and flow.
- Project not watching / watching / scanning.
- No files tracked yet.
- Files waiting for review.
- Needs save / save to make package-ready.
- Package blocked: no files captured.
- Package blocked: quota.
- Package Review.
- Package Complete.
- Package Details.
- Figma disconnected / token invalid / rate-limited / file cannot be read.
- Current Page Only / Entire File choice.
- Diagnostics ON/OFF package-output state.

## Needed Components And Variants

Add reusable variants for:

- File row:
  - source file
  - linked asset
  - extracted media
  - Figma asset
  - diagnostics file
- File status:
  - included
  - excluded
  - needs review
  - needs save
  - pending
  - package-ready
- Project status:
  - not watching
  - watching
  - scanning
  - ready
  - blocked
  - completed
- Package modal/state:
  - review
  - progress
  - success
  - quota blocked
  - no files blocked
- Quota card:
  - Free 10/month
  - Beta 25/month
  - Pro unlimited or future paid state
  - limit reached
- Figma link card:
  - connected
  - disconnected
  - reconnect
  - current page locked
  - unresolved
  - rate-limited

## Copy Changes

Change:

- `manifest included`

To:

- `Package details included`
- `Ready for handoff`

Change:

- `Package Health`

To:

- `Package status`
- `Ready to package`

Reason:

- `Package Health` may imply new scoring logic that Crate does not currently have.

Change:

- `Review Illustrator unsaved-file behavior`

To:

- `Save Illustrator file to make linked assets package-ready`

Change any broad tracking language such as:

- `tracks every file you touch across every app`

To:

- `Tracks project dependencies while you work`

Use more of:

- `Needs save`
- `Save to make package-ready`
- `Files included`
- `Gathered files`
- `Extracted media`
- `No issues found`
- `No unrelated files found`
- `Package-output folders excluded`

## Design That May Imply New Backend Behavior

Review carefully:

- `Next action` as a smart recommendation engine.
- `Package Health` as aggregate scoring.
- Chronological Home activity feed as a rich event log.
- Active project cards with clean/draft/watching states across all projects.

These can stay only if they are summaries of current backend state. They should not imply AI recommendations, analytics, or a new event-log system unless Bryant explicitly scopes that feature.

## Backend States With No UI Home

The largest gaps:

- Package Review.
- Package Complete.
- Package Details.
- Quick Package.
- Files view.
- Quota blocked.
- Needs save.
- Figma scope/error states.
- Diagnostics included/not included.

These need actual Figma frames before engineering starts.

## Privacy And Trust Issues

The design should more explicitly communicate that Crate is scoped and selective.

Add small trust copy in Files, Review, or Details states:

- `No unrelated files found`
- `Package-output folders excluded`
- `Unused downloads not included`
- `Diagnostics off`
- `Current Page Only`
- `Linked assets gathered`

Avoid copy that sounds like Crate grabs the whole Desktop, Downloads, or every file touched globally.

## Figma-Specific Gaps

Settings shows a connected state, but the app also needs:

- disconnected
- reconnect needed
- file cannot be read
- rate-limited / retry later
- add per-project Figma link
- Current Page Only default
- Entire File opt-in
- page lock resolved: `Current Page Only - Page 1`
- page lock unresolved

Detailed setup help should stay on get-crate.com, with a light `Learn more` link in-app if needed.

## Quota, Package, And Diagnostics Gaps

Need explicit UI for:

- 10/month public Free.
- 25/month closed beta tester.
- Pro/unlimited or future paid state.
- Limit reached state.
- No-output-written quota-blocked modal.
- Successful Quick Package counts against quota.
- Diagnostics OFF default.
- Diagnostics ON adds support/debug file, not a normal design asset.

## Recommended Figma Updates Before Engineering

Add these frames:

1. Home - Empty.
2. Home - Active Project.
3. Projects - List.
4. Files - Watching / Ready / Needs Save / No Files.
5. Package Review.
6. Package Complete.
7. Package Details.
8. Quick Package - Select / Progress / Complete / Quota Blocked.
9. Settings - Figma state variants.
10. Quota variants - Free, Beta, Pro, Limit Reached.

## Engineering Handoff State Model

Engineering should map current backend state into UI primitives like:

```text
projectState:
- notWatching
- watching
- scanning
- ready
- needsSave
- blocked
- completed

fileKind:
- source
- linkedAsset
- extractedMedia
- figmaAsset
- diagnostics

fileStatus:
- included
- excluded
- needsReview
- needsSave
- packageReady

packageState:
- idle
- review
- packaging
- complete
- blockedNoFiles
- blockedQuota

quotaState:
- free
- beta
- pro
- exhausted

figmaState:
- disconnected
- connected
- reconnectNeeded
- rateLimited
- unreadable
- pageLocked
- pageUnresolved

diagnosticsEnabled:
- true
- false
```

## Current Recommendation

Do not change the visual direction.

Update the Figma file to include the missing states and variants above. The current design is the skin; now it needs the state machine.

## Figma Update Result

Status: state coverage updated and ready for Jenna visual review.

Figma file:

- Crate macOS Wispr-style mockup, link shared in the current Codex thread.

Jenna's Figma/Codex session added the requested missing frames:

- Home - Empty
- Home - Active Project
- Projects - List
- Files - Watching
- Files - Ready
- Files - Needs Save
- Files - No Files
- Package Review
- Package Complete
- Package Details
- Quick Package - Select
- Quick Package - Progress
- Quick Package - Complete
- Quick Package - Quota Blocked
- Settings - Figma State Variants
- Quota Variants - Free / Beta / Pro / Limit Reached

Component variants added:

- `Crate / File Row`: source, linked asset, extracted media, Figma asset, diagnostics, excluded
- `Crate / Status Pill`: included, excluded, needs review, needs save, package-ready
- `Crate / Quota Card`: free, closed beta, pro, limit reached
- `Crate / Figma State Card`: connected, disconnected, reconnect needed, Current Page Only, Entire File, page lock resolved/unresolved, rate-limited, cannot read
- `Crate / Diagnostics Card`: off, on, included in package output

Copy changes completed:

- `manifest included` -> `Package details included`
- `Package Health` -> `Package status`
- QA/internal Illustrator wording -> `Save Illustrator file to make linked assets package-ready.`
- broad tracking copy -> `Tracks project dependencies while you work.`

Confirmed:

- Jenna's existing visual direction was preserved.
- The Wispr-style shell, Crate branding, sidebar language, spacing, colors, typography direction, rounded panels, native macOS feel, and calm production-ready tone were preserved.
- No new visual system was introduced.
- No new backend behavior was intentionally implied.
- The previous broad state coverage gaps are now addressed.

Remaining design decision:

- Decide during Jenna review or engineering implementation whether `Files` stays visually nested inside project context, as currently designed, or becomes a more explicit top-level view in the app. The current design supports the required Files states without adding new product sections.

Engineering note:

- `Next action` and status cards must map to existing renderer/backend states only. They should not imply recommendation logic, analytics, AI, or new backend behavior unless Bryant explicitly scopes that later.

## Wispr Inspiration Cleanup Result

Status: product-behavior cleanup completed; visual structure can remain.

Jenna's Figma/Codex session corrected the design after the Wispr Flow reference started being treated as product behavior rather than visual inspiration.

Removed or corrected:

- command launcher / shortcut UI, including `Cmd+P`
- top-right notification, bell, and account-style header icons
- transcript or generic activity-feed feel
- `Next action` smart-recommendation language
- broad `auto-tracking` language that sounded like generic capture behavior
- QA, smoke-test, or internal labels in visible app copy
- component-board wording that framed the mockup as a `Crate/Wispr shell`

Copy updates completed:

- `Crate project packaging` replaced the generic welcome headline.
- `Files` replaced `Packages` in navigation.
- `Free` replaced `Basic`.
- `Status` replaced `Activity`.
- `Figma project link scanned` replaced `Figma auto-tracking scan completed`.
- `Needs save` replaced `Next action`.
- `Diagnostics` replaced `Notifications`.
- `Project links enabled` replaced `Auto-tracking enabled`.
- Added quota-blocked copy: `Package blocked because quota is exhausted. No output written.`
- Added Figma state labels: `Figma connected` and `Figma disconnected`.

Confirmed by Jenna's Figma/Codex session:

- Crate logo and wordmark treatment are preserved.
- No new backend behavior is intentionally implied.
- All required Crate state frames remain present.
- File Row, Status Pill, Quota Card, Figma State Card, and Diagnostics Card variants remain present.
- Forbidden Wispr/productivity term scan was clean.

Remaining acceptable Wispr-inspired element:

- Left sidebar, large central workspace, and right status rail.

This is a structural layout pattern, not a product behavior. It is acceptable if all visible copy and state behavior remain Crate-specific and backed by the qa41 app state model.
