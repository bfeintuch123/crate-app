# Taskflow: UI Stability Responsive Geometry

## Metadata

- created: 2026-08-25
- updated: 2026-08-25
- owner: ChatGPT GitHub implementation lane
- standing order: SO-002 Autonomous Crate Failure Loop
- repo: `bfeintuch123/crate-app`
- branch: `codex/ui-stability-responsive-geometry`
- canonical base: `fa4d3d22378f11e4bcd80c55402194bda77da398`
- authoritative draft PR: `#231`
- superseded drafts: `#228`, `#229`, `#230`
- mode: scoped implementation, draft PR only
- status: active; desktop-minimum correction pushed, exact-head CI and fresh MacBook visual QA pending

## Goal

Preserve Crate's recognizable desktop application presentation while eliminating overflow, clipping, control collisions, and visual bleed. Crate should adapt cleanly between its supported minimum, normal, and wide desktop sizes, but it should not operate in an ultra-compact or mobile-style mode.

## Product-direction correction

Bryant reviewed the earlier `720 × 560` presentation and rejected it as too cramped. The responsive transitions remain useful defensive behavior, but they are no longer part of the supported user-visible window range.

The selected desktop minimum is:

```text
1100 × 760 outer window pixels
```

Rationale:

- `1100 × 760` already passed the earlier geometry and human screenshot matrix;
- it preserves the persistent left sidebar and readable desktop navigation;
- it avoids the compact two-row navigation state;
- it leaves Review Assets, Settings, and dialogs at a comfortable desktop density;
- it is a product decision based on Crate's background-utility role, not a copy of another application's dimensions.

A smaller `1100 × 720` contract was not selected because it lacked equivalent exact-head evidence across Settings, dialogs, keyboard navigation, and the full Review Assets workflow.

## Scope

Allowed:

- enforce the real Electron `BrowserWindow` minimum natively;
- clamp the initial window and later resize requests to `1100 × 760`;
- keep the existing responsive and footer-containment fixes;
- preserve defensive below-minimum CSS for unexpected embedding or test conditions;
- update the real-Electron and real-Chromium geometry matrices;
- add focused minimum-window and clamp regression tests;
- update this taskflow, the UI-stability standard, and PR #231;
- use small atomic commits and push every completed unit immediately.

Forbidden:

- navigation redesign;
- Phase B list-performance or renderer-reconciliation work;
- package, watcher, parser, Figma, provenance, quota, privacy, dependency, release, signing, notarization, deploy, or version changes;
- force-push or history rewrite;
- merge without Bryant's explicit approval.

## Implemented desktop contract

- `startup-phase-journal.js`, which is loaded by `main.js` before the real `BrowserWindow` is constructed, installs a `browser-window-created` handler;
- the handler calls native `setMinimumSize(1100, 760)` on the real window;
- an initial or later size below the contract is raised to at least `1100 × 760` with native `setSize`;
- the existing `720 × 560` constructor baseline is no longer the authoritative supported contract;
- the Electron harness reads the exported desktop minimum rather than parsing obsolete constructor literals;
- a requested `720 × 560` size is tested only as a clamp request and is reported separately from supported layouts;
- the supported geometry matrix begins at `1100 × 760` and continues through `1200 × 800`, `1280 × 800`, and `1440 × 900`;
- compact navigation must remain inactive and the persistent sidebar visible throughout the supported matrix;
- the short-height footer correction and all other useful responsive containment rules remain present.

## Test architecture

- `tests/desktop-window-minimum.test.js` proves the contract loads before window construction, applies native minimum bounds, clamps smaller dimensions, and installs idempotently;
- the pre-existing comprehensive `tests/main-window-lifecycle.test.js` remains intact;
- `tests/ui-stability-electron-harness.js` records requested outer size, actual outer size, native minimum, renderer viewport, navigation mode, geometry, state preservation, and no-refetch metrics;
- the harness requests `720 × 560` and must observe a native clamp to `1100 × 760`;
- `tests/ui-stability-harness-contract.test.js` protects the supported matrix, clamp evidence, desktop navigation, footer-overlap checks, and no-refetch behavior;
- `tests/ui-stability-responsive-geometry.test.js` treats only `1100 × 760` and larger viewports as supported desktop layouts;
- the synthetic fixture remains privacy-safe with four represented working-file sources, seven existing assets, and 256 added assets.

## Checkpoints

- [x] canonical handoff and one-builder ownership confirmed
- [x] responsive geometry and visual containment implemented
- [x] synthetic fixture and real-renderer Electron harness implemented
- [x] footer-overlap regression detected and corrected
- [x] Bryant rejected the ultra-compact supported mode
- [x] selected `1100 × 760` desktop minimum documented
- [x] native desktop minimum implementation pushed
- [x] below-minimum clamp and desktop-navigation tests pushed
- [x] pre-existing lifecycle coverage preserved
- [x] UI-stability standard updated
- [ ] exact-head complete source regression gate
- [ ] fresh MacBook proof of native resize refusal and desktop containment
- [ ] Settings, Existing Assets, Package Review, dialogs, and keyboard checks at the minimum
- [ ] privacy-safe screenshots and continuous resize video
- [ ] Bryant visible Phase A approval
- [ ] proof bundle and vault-ready handoff
- [ ] separate authorization for Phase B

## Evidence log

| Date | Action | Result |
| --- | --- | --- |
| 2026-08-25 | Canonical base and merged PR #226/#227 handoff confirmed | PASS |
| 2026-08-25 | Responsive geometry, synthetic fixture, and containment tests added | IMPLEMENTED |
| 2026-08-25 | Source-contract correction at `1293ce7753df78b6a393b61be4d11000cc64afb9` | PASS |
| 2026-08-25 | MacBook inspection found footer overlap at `720 × 560` | NEEDS FIX |
| 2026-08-25 | Footer overlap correction reached `f326ea8a12fe3eed3932a9e77facc879b81d8ab8` | PASS, SUPERSEDED BY PRODUCT DIRECTION CHANGE |
| 2026-08-25 | Bryant selected a comfortable desktop minimum | `1100 × 760` |
| 2026-08-25 | Native minimum and focused contract tests pushed | IMPLEMENTED |
| 2026-08-25 | Supported geometry matrix updated; below-minimum request separated | IMPLEMENTED |
| 2026-08-25 | Exact-head CI for final desktop-minimum documentation head | PENDING |

## Fresh MacBook QA requirements

At the exact final candidate head:

1. Confirm the native minimum reports `1100 × 760`.
2. Attempt to resize below the minimum and demonstrate macOS refusing further reduction.
3. Record requested outer size, actual outer size, and actual renderer viewport.
4. Test `1100 × 760`, `1200 × 800`, `1280 × 800`, and `1440 × 900`.
5. Confirm the persistent left sidebar and readable labels remain present.
6. Confirm compact navigation is inactive throughout the supported matrix.
7. Inspect Review Assets, Project Workspace, Settings, Existing Assets, Package Review, and representative dialogs at the minimum.
8. Confirm no horizontal overflow, clipping, footer overlap, surface bleed, or inaccessible control.
9. Verify keyboard navigation and visible focus indicators.
10. Confirm search and filter state survive minimum-to-wide-to-minimum resizing.
11. Confirm resize causes no project, workspace, or preview refetches.
12. Capture privacy-safe screenshots and a continuous resize video from the exact head.

## Risks and deferred work

- Defensive below-minimum CSS remains intentionally present but is not a supported product mode.
- The native contract is installed through the startup bootstrap already imported before main-window construction; exact MacBook QA must confirm there is no visible launch flicker and that native resize refusal behaves as intended.
- Large-list DOM reconciliation, preview scheduling, scroll anchoring during live updates, focus preservation during updates, and renderer event coalescing remain Phase B.

## Handoff

After exact-head CI passes, the current Chief on the MacBook independently verifies PR #231, demonstrates the enforced minimum, captures fresh evidence, and returns a Phase A verdict to Bryant. The Chief must not edit the branch, merge the PR, or begin Phase B.
