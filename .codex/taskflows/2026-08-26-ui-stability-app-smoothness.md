# Taskflow: App-Wide UI Smoothness

## Metadata

- created: 2026-08-26
- owner: ChatGPT GitHub implementation lane
- standing order: SO-002 Autonomous Crate Failure Loop
- mode: fix-and-PR; draft only; no merge authority
- repository: `bfeintuch123/crate-app`
- canonical base branch: `v2.4.x`
- canonical base SHA: `d2a7be01b89d3ff8bebfe3daf927aa34e6a16629`
- branch: `codex/ui-stability-app-smoothness`
- Phase A authority: merged PR #231
- Phase B status: active diagnosis; no runtime changes yet

## Product objective

Make normal Crate use feel immediate, stable, predictable, and calm across the entire application. Large projects are stress fixtures, not the sole target.

Phase B covers app-wide interaction and rendering smoothness across:

- Projects;
- Quick Package;
- Project Workspace;
- Review Assets;
- Settings;
- Help;
- Existing Assets decision UI;
- Package Review;
- packaging progress and completion;
- Figma connection, scan, warning, and error states;
- quota and upgrade states.

## Phase A boundary

Preserve the merged Phase A contract:

- native `1100 × 760` desktop minimum;
- persistent desktop sidebar;
- no supported compact navigation;
- responsive containment and no incidental horizontal overflow;
- contained Review Assets footer, cards, Settings, and dialogs;
- defensive below-minimum CSS only;
- exact-head geometry and visual evidence harnesses.

Do not reopen or weaken Phase A unless a focused Phase B test proves a direct regression.

## Phase B workstreams

### B0 — Read-only app-wide baseline audit

Measure current behavior before production edits at synthetic sizes:

- 0 assets;
- 7 assets;
- 30 assets;
- 100 assets;
- 263 assets;
- 500 assets.

Record:

- navigation acknowledgement and destination-render timing;
- screen, list, card, thumbnail, and modal node creation/replacement counts;
- project/workspace/settings/usage/preview requests per user action;
- renderer refresh counts after one event and a burst of ten events;
- scroll, focus, search, filter, selection, and dialog-state preservation;
- first usable frame, first visible preview, and warm rerender time;
- search/filter response time;
- long tasks above 50ms;
- unexpected layout shifts, placeholder flashes, button-size changes, duplicate actions, stale data, and console errors.

Stop after the baseline report if another builder begins touching scoped files or if the observed architecture materially contradicts this taskflow.

### B1 — State and rendering stability

After diagnosis approval within this authorized workstream:

- reconcile changed UI nodes instead of rebuilding unchanged destinations;
- preserve loaded previews and stable DOM identity;
- preserve scroll, focus, search, filters, selected project, asset decisions, and relevant dialog state during real updates;
- reject stale async results after project or destination changes;
- avoid rebuilding hidden destinations;
- coalesce bursts of related renderer events into one authoritative refresh;
- prioritize visible and near-visible previews;
- keep caches bounded and privacy-safe.

### B2 — Interaction feedback and perceived smoothness

Implement only issues demonstrated by the app-wide audit:

- immediate acknowledgement for meaningful actions;
- stable loading, disabled, success, and error states;
- duplicate-action prevention;
- stable control dimensions;
- calm modal, progress, and completion-state transitions;
- removal of broad or unnecessary motion;
- visible keyboard focus and predictable focus restoration;
- no decorative redesign.

## Protected product boundaries

Do not change:

- Phase A desktop minimum or supported geometry without separate Bryant approval;
- package selection, output, counts, or quota behavior;
- watcher admission, source-file classification, or watcher coordination;
- parsers or provenance semantics;
- Figma Current Page Only default, Entire File opt-in, page-lock, package-time scope, network, or error semantics;
- project persistence;
- privacy, credential, path-redaction, or security boundaries;
- dependencies or lockfile;
- application version, build, signing, notarization, release, website, or deployment state.

## Builder and recovery rules

1. One builder edits scoped files.
2. Use small, explanatory atomic commits.
3. Run focused checks before every commit.
4. Push each completed commit immediately.
5. Verify the remote branch after every push.
6. Open a draft PR early.
7. Do not force-push or rewrite history.
8. Do not merge without Bryant’s explicit approval.
9. Bind all visual and performance evidence to the exact PR head.
10. Any later interaction-affecting commit invalidates earlier evidence.

## Likely scoped files

- `renderer/app.js`;
- `renderer/index.html` only for demonstrated state or accessibility needs;
- focused renderer tests;
- Phase A synthetic fixtures and Electron harness extensions;
- app-wide smoothness benchmark or interaction harness files;
- UI-stability documentation, check-suite, taskflow, and proof records.

Avoid `main.js`, watcher modules, package modules, parsers, Figma transport, dependencies, and release files unless a focused blocker is proven and Bryant separately approves the expansion.

## Checkpoints

- [x] Phase A PR #231 merged and protected CI passed
- [x] canonical Phase B base established at `d2a7be01b89d3ff8bebfe3daf927aa34e6a16629`
- [x] one-builder ownership confirmed from GitHub-visible app work
- [x] fresh Phase B branch created
- [x] taskflow created and pushed
- [ ] draft PR opened
- [ ] app-wide baseline audit complete
- [ ] baseline reviewed against small, normal, and stress fixtures
- [ ] B1 implementation complete
- [ ] B1 exact-head tests and MacBook QA complete
- [ ] B2 confirmed interaction issues implemented
- [ ] B2 exact-head app-wide QA complete
- [ ] Bryant approval
- [ ] merge and Vault handoff
- [ ] optional post-B interaction-polish audit / Phase C decision

## Required closeout evidence

Report:

- exact base and head SHAs;
- branch and PR;
- atomic commit list;
- baseline measurements at every fixture size;
- changed files and protected files untouched;
- focused and complete test results;
- 263- and 500-asset stress results;
- normal-project and empty-state results;
- scroll/focus/search/filter/selection preservation;
- preview request, cache, stale-result, and event-coalescing results;
- button, modal, progress, and error-feedback findings;
- exact-head screenshots/video and privacy review where user-visible behavior changes;
- remaining risks and deferred work;
- Vault-ready factual handoff.
