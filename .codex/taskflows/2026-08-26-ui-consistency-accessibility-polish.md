# Taskflow: App-Wide UX Consistency and Accessibility Polish

## Metadata

- created: 2026-08-26
- updated: 2026-08-27
- owner: ChatGPT GitHub implementation lane
- standing order: SO-008 read-only design/product audit followed by SO-002 scoped fix-and-PR implementation
- repo: `bfeintuch123/crate-app`
- branch: `codex/ui-consistency-accessibility-polish`
- base: `v2.4.x@de935e307c61674af5a684ceab4895aa650a467b`
- draft PR: `#233 — Polish app-wide UX consistency and accessibility`
- Phase A authority: merged PR #231
- Phase B authority: merged PR #232
- mode: audit-first; one focused draft PR; no merge authority
- status: production implementation and two corrective commits complete; prior documentation-head protected CI is green at `05b4c42aba7e01332c07c4663dbdb62367022495`; both independent product/source/accessibility reviews passed; the resulting documentation-only head still requires exact-head CI and final readback

## Goal

Apply one coherent, accessible interaction language across Crate now that Phase A stabilized desktop geometry and Phase B stabilized renderer updates, previews, and core action feedback. Phase C is a focused consistency and accessibility pass, not a redesign.

## Implemented scope

Phase C now provides:

- complete accessible naming and modal semantics for Remove Project, Clear All Projects, Edit Figma Link, and Quick Package results;
- focus entry, Tab/Shift+Tab containment, Escape close through existing safe controls, background inertness, and opener restoration for those four secondary dialogs;
- `aria-current="page"` synchronization for the active Crate destination;
- keyboard operation for project selection, Start/Pause Watching, and the Project Workspace Figma-link entry;
- visible focus indicators for native and custom button-role controls;
- keyboard reveal of the project remove control through `:focus-within`;
- explicit accessible names and descriptions for project creation, Figma, Settings, and Edit Figma controls;
- consistent alert/status semantics for Figma validation, warnings, linking status, and scan descriptions;
- one authoritative polite Figma scan-status announcement for started, completed, warning, error, and manual zero-trigger outcomes, without duplicate scan toasts;
- exact CSP hash binding for the source-bound Phase C script inside the existing packaged `renderer/index.html`;
- focused source-contract and runtime tests;
- a read-only exact-head MacBook QA procedure.

## Protected boundaries

The implementation does not change:

- deferred navigation order (`Projects → Quick Package → Project Workspace` remains unchanged; any later reorder remains separate);
- route names, selected-project behavior, active-state behavior, or Quick Package behavior;
- Phase A's `1100 × 760` desktop minimum, responsive geometry, or containment;
- Phase B's keyed reconciliation, preview scheduling, event coalescing, action feedback, or state preservation;
- package selection, output, counts, quota, or transaction behavior;
- watcher admission, file classification, or coordination;
- parsers or provenance;
- Figma scope, network, package-time, retry, or error-message semantics;
- project persistence;
- privacy, credentials, or path redaction;
- dependencies or lockfile;
- version, build, signing, notarization, release, Beta 2.15, website, or deployment state.

No extra packaged renderer file was added. The actual production boundary is the existing source-bound `renderer/index.html` plus `renderer/app.js`.

## Complete PR changed-file list

- `.codex/taskflows/2026-08-26-ui-consistency-accessibility-polish.md`
- `docs/crate/design/phase-c-ux-consistency-audit.md`
- `docs/crate/qa-smokes/ui-consistency-accessibility.md`
- `renderer/app.js`
- `renderer/index.html`
- `tests/renderer-figma-scope.test.js`
- `tests/ui-consistency-accessibility.test.js`
- `tests/ui-consistency-keyboard-contract.test.js`
- `tests/ui-consistency-keyboard-runtime.test.js`

## State

- current phase: C4 documentation closeout after the protected code-head correction gate and prior documentation-head CI
- last completed checkpoint: original Phase C implementation, six-finding correction commit `8adbf33e737e91c7792c03fbd5053cbe1577399d`, zero-trigger follow-up `dd4b2988b9b86b83e0e91578d5a0cd8e32c52a6e`, documentation commit `05b4c42aba7e01332c07c4663dbdb62367022495`, its protected exact-head CI, and both independent product/source/accessibility reviews
- next action: resolve the live PR head after this documentation-only commit, require protected CI for that resulting exact head, perform final live readback, and keep the PR draft for the remaining approval gate
- blocker: none in the implementation lane
- approval state: Bryant authorized Phase C implementation; merge is not authorized
- preferences applied: one builder, small atomic commits, immediate pushes, remote verification, no navigation reorder
- routing decision: SO-008 audit followed by SO-002 narrow fixes; Crate Fix Review Stack before merge readiness
- workflow eval suite/result: protected code-head and prior documentation-head source gates green; the resulting documentation-only exact-head CI and final live readback are required downstream
- outcome receipt: prior documentation-head validation and both independent product/source/accessibility PASS reviews are recorded; only the resulting documentation-only head's protected CI/readback and Bryant approval remain pending

## Checkpoints

- [x] canonical branch and Phase B merge verified
- [x] no overlapping open UI implementation PR found
- [x] fresh Phase C branch created
- [x] taskflow created and pushed
- [x] draft PR opened
- [x] C0 read-only app-wide audit complete
- [x] confirmed findings and non-goals documented
- [x] C1 dialog and focus consistency implemented
- [x] C1 focused runtime and source contracts added
- [x] C2 keyboard, naming, status, and focus-visible consistency implemented
- [x] C2 focused runtime and source contracts added
- [x] MacBook exact-head QA procedure documented
- [x] six-finding correction commit closed the first six findings; later review identified only the manual zero-trigger announcement gap
- [x] follow-up correction closed both manual zero-trigger outcomes through the single Figma status path
- [x] protected code-head CI passed at `dd4b2988b9b86b83e0e91578d5a0cd8e32c52a6e` (`33029071750/98377113934`)
- [x] final focused tests and Phase A/B regressions pass on protected code head (`219/219` focused; complete source CI green)
- [x] prior documentation-head protected source CI passed at exact head `05b4c42aba7e01332c07c4663dbdb62367022495` (`33029512444/98378513554`)
- [x] both independent Luna/high product/source/accessibility reviews passed; each found only the stale taskflow P2, now corrected
- [ ] resulting documentation-only head protected source CI and final live readback pass (future exact SHA and CI must be resolved after this commit)
- [ ] exact-head visual and keyboard proof complete or documented exception approved
- [ ] Bryant approval
- [ ] merge and Vault handoff
- [ ] separate navigation-order PR begins only after Phase C closes

## Evidence

| Time | Action | Evidence | Result |
| --- | --- | --- | --- |
| 2026-08-26 | Resolve canonical Phase B merge | `v2.4.x@de935e307c61674af5a684ceab4895aa650a467b` | PASS |
| 2026-08-26 | Inspect open PR ownership | No overlapping open UI implementation PR | PASS |
| 2026-08-26 | Create Phase C branch | `codex/ui-consistency-accessibility-polish` from exact canonical SHA | PASS |
| 2026-08-26 | Open draft PR | PR #233 against `v2.4.x` | PASS |
| 2026-08-26 | Complete read-only audit | `docs/crate/design/phase-c-ux-consistency-audit.md` | 7 confirmed findings; no redesign |
| 2026-08-26 | Implement secondary dialog focus lifecycle | source-bound `renderer/index.html` contract | PUSHED |
| 2026-08-26 | Implement app-wide keyboard/naming/status consistency | source-bound `renderer/index.html` contract | PUSHED |
| 2026-08-26 | Add focused contracts | `tests/ui-consistency-*.test.js` | PUSHED |
| 2026-08-26 | Document exact-head QA | `docs/crate/qa-smokes/ui-consistency-accessibility.md` | PUSHED |
| 2026-08-26 | First six-finding correction | `8adbf33e737e91c7792c03fbd5053cbe1577399d`; closed the first six findings except the discovered manual zero-trigger announcement gap; production boundary `renderer/index.html` plus `renderer/app.js`; focused correction tests `143/143` | PUSHED |
| 2026-08-27 | Manual Scan Now zero-trigger correction | `dd4b2988b9b86b83e0e91578d5a0cd8e32c52a6e`; both outcomes use `figma-scan-status`; follow-up focused suite `219/219` | PUSHED |
| 2026-08-27 | Protected code-head CI | exact head `dd4b2988b9b86b83e0e91578d5a0cd8e32c52a6e`; run `33029071750`; job `98377113934`; complete source suite `1,013 total, 1,012 passed, 0 failed, 1 skipped`; dependency audit `0 vulnerabilities` | PASS |
| 2026-08-27 | Protected prior documentation-head CI | exact head `05b4c42aba7e01332c07c4663dbdb62367022495`; run `33029512444`; job `98378513554`; complete source suite `1,013 total, 1,012 passed, 0 failed, 1 skipped` | PASS |
| 2026-08-27 | Independent product/source/accessibility reviews | Two independent Luna/high read-only reviews; both passed the product/source corrections and all seven accessibility findings, with only the stale taskflow P2 remaining | PASS |

The prior documentation-head CI receipt above is PASS and is not pending. This documentation-only follow-up creates a new head whose exact SHA must be resolved after commit and push; protected CI for that resulting exact head and final live PR readback remain required. No future documentation commit SHA or CI result is pre-recorded here.

## Confirmed audit findings closed by source implementation

1. Secondary dialogs lacked complete dialog semantics and focus lifecycle — closed by the original implementation and `8adbf33` correction.
2. Project selection and watching controls were not fully keyboard-operable — closed by the original implementation and `8adbf33` correction.
3. Edit Figma Link entry was pointer-only — closed by the original implementation and `8adbf33` correction.
4. Several form and toggle controls lacked explicit accessible names — closed by the original implementation and `8adbf33` correction.
5. Dynamic Figma error and status surfaces lacked a uniform announcement contract — closed by the original implementation and `8adbf33`, with manual zero-trigger completion in `dd4b298`.
6. Active navigation state was visual but did not expose `aria-current` — closed by the original implementation and `8adbf33` correction.
7. Focus visibility and keyboard discovery of the remove action were inconsistent — closed by the original implementation and `8adbf33` correction.

## Risks and required review

Review must specifically guard against:

- focus traps or restoration regressions;
- duplicate or noisy status announcements;
- project row keyboard activation interfering with nested watching/removal controls;
- a Figma-link entry becoming focusable before its existing action is available;
- CSP hash drift after any inline-script change;
- focus outlines being clipped at the Phase A desktop minimum;
- any accidental navigation reorder;
- Phase A geometry or Phase B smoothness regressions;
- subjective expansion into redesign.

Any later runtime-affecting commit invalidates exact-head Phase C evidence.

## Handoff

After the resulting documentation-only head's exact CI and final live readback pass, the current MacBook Chief should follow:

```text
docs/crate/qa-smokes/ui-consistency-accessibility.md
```

The Chief must remain read-only, use synthetic content, verify keyboard/focus/status behavior and Phase A/B regressions, and return `PASS`, `NEEDS_FIX`, or `BLOCKED` without GUI/packaged-app approval, merging, or beginning the navigation-order PR.
