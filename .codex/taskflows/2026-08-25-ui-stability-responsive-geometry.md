# Taskflow: UI Stability Responsive Geometry

## Metadata

- created: 2026-08-25
- updated: 2026-08-25
- owner: ChatGPT GitHub implementation lane
- standing order: SO-002 Autonomous Crate Failure Loop
- repo: `bfeintuch123/crate-app`
- branch: `codex/ui-stability-responsive-geometry`
- base: `fa4d3d22378f11e4bcd80c55402194bda77da398`
- draft PR: `#228`
- mode: scoped implementation, draft PR only
- status: active; source implementation verified, exact-head Mac visual gate pending

## Goal

Make the existing Crate macOS UI adapt cleanly from its normal desktop size down to a tested minimum window size, beginning with Project Workspace and Review Assets. Eliminate application-level horizontal overflow, clipped or overlapping controls, and translucent surface bleed without redesigning the product or changing package, watcher, Figma, provenance, quota, privacy, release, or dependency behavior.

## Scope

Allowed:

- inspect the exact canonical UI and window behavior inherited from PRs #226 and #227
- update responsive layout and containment in renderer CSS
- make the smallest semantic markup changes required in `renderer/index.html`
- update `main.js` only for an evidence-based minimum window size
- rewrite focused renderer and window-lifecycle tests that currently encode broken width constraints
- add dependency-free, synthetic UI geometry checks and documentation
- use small atomic commits and push every completed commit immediately
- maintain draft PR #228 against `v2.4.x`

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

- preserved the established renderer styling in an unchanged `styles-base.css` layer
- added a focused `ui-stability.css` layer loaded after the base visual system
- neutralized inherited `640px`, `680px`, and `800px` layout pressure through later flexible rules
- made Current Project and Review Assets respond to their actual content-pane width through container queries
- moved Review Assets search and actions onto separate rows before collision
- changed asset density from four columns to three, two, and a compact readable row
- replaced the negatively offset absolute Review Assets footer with a contained sticky footer
- made Settings and major dialog surfaces respect the available window
- removed the permanent project-list Watching pulse and added reduced-motion handling
- preserved all package, watcher, Figma, quota, provenance, privacy, version, and dependency behavior

## State

- current phase: exact-head macOS visual and geometry verification
- last completed checkpoint: responsive geometry source implementation and complete GitHub source-security/regression gate passed
- current verified source head: `757905dc1c016eccbf8bebaac5df771dd0067537`
- next action: run synthetic large-project Mac QA at the exact current PR head, measure real geometry, inspect resizing, and decide the evidence-based minimum window size
- blocker: authentic macOS Electron geometry and video evidence require the separate Mac QA lane
- approval state: Bryant authorized implementation; merge remains unapproved
- preferences applied: fresh canonical branch, small atomic commits, immediate push after every completed commit, one builder
- routing decision: Phase A responsive geometry only; large-asset renderer smoothness remains a separate follow-up branch after Bryant approves the visible direction
- workflow eval suite/result: GitHub Actions run `32893793347`, job `97951593801`, Source security and regression suite PASS
- outcome receipt: pending exact-head visual evidence and final review

## Checkpoints

- [x] preflight / canonical handoff confirmed
- [x] context loaded
- [x] responsive geometry implementation
- [x] focused verification and complete source regression gate
- [ ] live Mac visual proof at exact PR head
- [ ] evidence-based minimum-window decision
- [ ] proof bundle
- [ ] ledger/state update
- [ ] Bryant and independent final-head review

## Evidence

| Time | Action | Evidence | Result |
| --- | --- | --- | --- |
| 2026-08-25 | Verified canonical and feature branch | `origin/v2.4.x` and the feature branch began at `fa4d3d22378f11e4bcd80c55402194bda77da398` | PASS |
| 2026-08-25 | Confirmed Chief handoff | PR #227 merge `436c718e8d7c625673ed6bc255a9f718c58dd9b1`; PR #226 merge `fa4d3d22378f11e4bcd80c55402194bda77da398`; no active source writer reported | PASS |
| 2026-08-25 | Isolated responsive styling | unchanged base blob retained as `renderer/styles-base.css`; focused responsive behavior in `renderer/ui-stability.css` | PASS |
| 2026-08-25 | Replaced stale responsive test authority | layered renderer test harness substitutes a container-aware contract for the legacy fixed-width assertion; focused `tests/ui-stability-responsive.test.js` added | PASS |
| 2026-08-25 | Complete protected source gate | workflow run `32893793347`, job `97951593801`; dependency, security, full serial source suite, and PR whitespace steps passed | PASS |

## Exact-Head Mac QA Requirements

Use only synthetic fixtures. At the exact candidate head:

1. Open a project with approximately four working files, seven existing assets, and 256 added assets.
2. Open Review Assets and capture geometry at `1440x900`, `1200x800`, `960x760`, `900x700`, and the currently configured minimum.
3. Confirm root, app-content, Current Project, files-view, and Review Assets `scrollWidth <= clientWidth + 1`.
4. Confirm the sidebar does not overlap content; heading/search, summary/actions, cards, and footer do not intersect.
5. Slowly resize across the full supported range and inspect four-, three-, two-column, and compact-row states where reachable.
6. Confirm search text and active filters survive resizing.
7. Inspect pink preview surfaces, green/pink app gradients, white panels, rounded edges, and the sticky footer for visual bleed.
8. Confirm no preview requests, project refetches, console errors, or unhandled rejections are caused by resize alone.
9. Capture privacy-safe before/after screenshots and a complete resize video; inspect the media before treating it as evidence.
10. Recommend whether `main.js` should retain `720x560` or adopt a larger minimum based on measured usability rather than convenience.

## Risks

- Source-level checks prove the responsive contract is present but do not substitute for authentic Electron geometry or visual judgment.
- CSS imports add local file-layering indirection; the complete source suite passes, but packaged exact-head evidence remains part of the final gate.
- The existing Electron minimum may still permit an undesirable shell transition around the legacy `760px` breakpoint; the final minimum must follow real Mac evidence.
- Large-list DOM reconciliation and preview scheduling are intentionally deferred to the separate smoothness phase.

## Handoff

Next exact action:

```text
Check out draft PR #228 at exact head 757905dc1c016eccbf8bebaac5df771dd0067537 on the approved Mac QA worktree. Run the synthetic 263-asset Review Assets resize and geometry matrix, inspect screenshots and a complete privacy-safe video, and return measured results plus an evidence-based minimum-window recommendation. Do not edit the implementation branch during QA.
```
