# Taskflow: UI Stability Responsive Geometry

## Metadata

- created: 2026-08-25
- updated: 2026-08-25
- owner: ChatGPT GitHub implementation lane
- standing order: SO-002 Autonomous Crate Failure Loop
- repo: `bfeintuch123/crate-app`
- branch: `codex/ui-stability-responsive-geometry`
- base: `fa4d3d22378f11e4bcd80c55402194bda77da398`
- authoritative draft PR: `#231`
- superseded drafts: `#228`, `#229`, `#230`
- mode: scoped implementation, draft PR only
- status: active; Phase A source implementation complete, exact-head CI and Mac visual gate pending

## Goal

Make the existing Crate macOS UI adapt cleanly from its normal desktop size down to the currently configured minimum window size, beginning with Project Workspace and Review Assets. Eliminate application-level horizontal overflow, clipped or overlapping controls, and translucent surface bleed without redesigning the product or changing package, watcher, Figma, provenance, quota, privacy, release, or dependency behavior.

## Scope

Allowed:

- inspect the exact canonical UI and window behavior inherited from PRs #226 and #227
- update responsive layout and containment in renderer CSS
- make the smallest semantic markup changes required in `renderer/index.html`
- update `main.js` only after an evidence-based minimum-window decision
- replace focused responsive test authority that encoded broken width constraints
- add dependency-free synthetic UI geometry checks and documentation
- use small atomic commits and push every completed commit immediately
- maintain draft PR #231 against `v2.4.x`

Forbidden:

- package selection or output changes
- watcher admission or observer changes
- parser or provenance changes
- Figma scope or network changes
- quota, billing, release, signing, notarization, deploy, or version changes
- dependency or lockfile mutation
- renderer framework migration
- global CSS scaling, `zoom`, or hiding inaccessible overflow as the primary fix
- merge without Bryant's explicit approval

## Implemented Responsive Contract

- retained the established `renderer/styles.css` unchanged
- loaded one focused `renderer/ui-stability.css` layer immediately after the established stylesheet
- neutralized inherited `640px`, `680px`, and `800px` layout pressure through later flexible rules
- made Current Project and Review Assets respond to their actual content-pane width through container queries
- moved Review Assets search and actions onto separate rows before collision
- changed asset density from four columns to three, two, and a compact readable row
- replaced the negatively offset absolute Review Assets footer with a contained sticky footer
- made the Project Workspace dashboard, Settings, and major dialog surfaces respect the available width
- kept the current 720px Electron minimum usable by allowing the legacy narrow navigation to wrap
- removed the permanent project-list Watching pulse and added reduced-motion handling
- preserved all package, watcher, Figma, quota, provenance, privacy, version, and dependency behavior

## Test Architecture

- `tests/ui-stability-fixture.js` creates a synthetic project with three physical working files, one renderer-derived Figma source, seven existing assets, and 256 added assets
- `tests/ui-stability-preload.js` exposes a test-only `window.crate` bridge without touching production preload code or real data
- `tests/ui-stability-electron-harness.js` loads the real renderer, opens the real Project Workspace and Review Assets flow, resizes through the supported matrix, records geometry, and optionally captures screenshots
- `tests/ui-stability-responsive-geometry.test.js` runs an independent real-Chromium geometry probe when Chrome or Chromium is available
- focused source and fixture tests remain dependency-free and run through the existing Node test system

## State

- current phase: exact-head source CI followed by macOS visual and geometry verification
- last completed checkpoint: responsive implementation and focused test corrections pushed to the remote branch
- last code/test head before this taskflow-only update: `aa99f11e69c857356ee3423e87ea27801ebf8fbb`
- authoritative PR: `#231`
- next action: obtain a passing exact-head GitHub source gate, then run synthetic large-project Mac QA without editing the implementation branch
- blocker: authentic macOS Electron geometry and video evidence require the separate Mac QA lane
- approval state: Bryant authorized implementation; merge remains unapproved
- preferences applied: fresh canonical branch, small atomic commits, immediate push after every completed commit, one builder
- routing decision: Phase A responsive geometry only; large-asset renderer smoothness remains a separate follow-up branch after Bryant approves the visible direction
- outcome receipt: pending exact-head CI, visual evidence, and final review

## Checkpoints

- [x] preflight / canonical handoff confirmed
- [x] context loaded
- [x] responsive geometry implementation
- [x] synthetic fixture and real-renderer Electron harness
- [x] independent Chromium geometry probe
- [x] focused source-contract tests
- [ ] exact-head complete source regression gate
- [ ] live Mac visual proof at exact PR head
- [ ] evidence-based minimum-window decision
- [ ] proof bundle
- [ ] ledger/state and vault-ready final report
- [ ] Bryant and independent final-head review

## Evidence

| Time | Action | Evidence | Result |
| --- | --- | --- | --- |
| 2026-08-25 | Verified canonical and feature branch | `origin/v2.4.x` and the feature branch began at `fa4d3d22378f11e4bcd80c55402194bda77da398` | PASS |
| 2026-08-25 | Confirmed Chief handoff | PR #227 merge `436c718e8d7c625673ed6bc255a9f718c58dd9b1`; PR #226 merge `fa4d3d22378f11e4bcd80c55402194bda77da398`; no active source writer reported | PASS |
| 2026-08-25 | Added responsive presentation layer | established stylesheet unchanged; focused layer loaded from `renderer/index.html` | IMPLEMENTED |
| 2026-08-25 | Added synthetic geometry coverage | 263-asset fixture, test-only preload, real-renderer Electron harness, optional real-Chromium probe | IMPLEMENTED |
| 2026-08-25 | Replaced stale responsive test authority | focused tests assert the shrink/reflow contract and no longer require the inherited defect | IMPLEMENTED |
| 2026-08-25 | Earlier source gate | workflow run `32893793347`, job `97951593801` passed at an earlier responsive source head | PASS, SUPERSEDED BY NEWER HEAD |
| 2026-08-25 | Current source gate | PR #231 exact-head rerun after focused test corrections | PENDING |

## Exact-Head Mac QA Requirements

Use only the committed synthetic fixture. At the exact final candidate head:

1. Run `tests/ui-stability-electron-harness.js` through the repository's Electron binary with an owner-only evidence directory.
2. Open the real synthetic Project Workspace and Review Assets flow containing four represented working files, seven existing assets, and 256 added assets.
3. Capture geometry at `1440x900`, `1280x800`, `1200x800`, `1100x760`, `1040x760`, `960x760`, `900x700`, and the configured minimum.
4. Confirm root, app-content, Current Project, files-view, and Review Assets `scrollWidth <= clientWidth + 1`.
5. Confirm the sidebar does not overlap content; heading/search, summary/actions, asset cards, and footer do not intersect.
6. Slowly resize across the full supported range and inspect four-, three-, two-column, and compact-row states where reachable.
7. Confirm search text and active filters survive resizing.
8. Inspect pink preview surfaces, green/pink app gradients, white panels, rounded edges, modal containment, and the sticky footer for visual bleed.
9. Confirm resize alone causes no preview requests, project refetches, console errors, or unhandled rejections.
10. Capture privacy-safe screenshots and a complete resize video; inspect the media before treating it as evidence.
11. Recommend whether `main.js` should retain `720x560` or adopt a larger minimum based on measured usability rather than convenience.

## Risks

- Source and optional Chromium checks do not substitute for authentic macOS Electron visual judgment.
- The separate presentation layer intentionally leaves the established visual system untouched; future visual refactors must continue loading it in the documented order.
- The existing Electron minimum may still permit an undesirable shell transition around the legacy `760px` breakpoint; the final minimum must follow real Mac evidence.
- Large-list DOM reconciliation, preview scheduling, scroll-anchor preservation during live updates, and renderer event coalescing are intentionally deferred to the separate smoothness phase.

## Handoff

Next exact action after the current CI passes:

```text
Check out draft PR #231 at its exact final head on the approved Mac QA worktree. Run the committed synthetic Electron harness and complete the Review Assets resize/visual matrix. Return the geometry JSON, inspected screenshots/video, privacy result, and an evidence-based minimum-window recommendation. Do not edit the implementation branch during QA.
```
