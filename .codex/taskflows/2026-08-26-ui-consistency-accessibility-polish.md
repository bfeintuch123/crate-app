# Taskflow: App-Wide UX Consistency and Accessibility Polish

## Metadata

- created: 2026-08-26
- updated: 2026-08-26
- owner: ChatGPT GitHub implementation lane
- standing order: SO-008 read-only design/product audit followed by SO-002 scoped fix-and-PR implementation
- repo: `bfeintuch123/crate-app`
- branch: `codex/ui-consistency-accessibility-polish`
- base: `v2.4.x@de935e307c61674af5a684ceab4895aa650a467b`
- draft PR: `#233 — Polish app-wide UX consistency and accessibility`
- Phase A authority: merged PR #231
- Phase B authority: merged PR #232
- mode: audit-first; one focused draft PR; no merge authority
- status: production implementation complete; exact-head validation and MacBook QA pending

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
- exact CSP hash binding for the source-bound Phase C script inside the existing packaged `renderer/index.html`;
- focused source-contract and runtime tests;
- a read-only exact-head MacBook QA procedure.

## Protected boundaries

The implementation does not change:

- deferred navigation order (`Projects → Project Workspace → Quick Package` remains separate);
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

No extra packaged renderer file was added. Runtime changes remain inside the existing source-bound `renderer/index.html`.

## State

- current phase: C3 exact-head validation and read-only QA handoff
- last completed checkpoint: C0 audit, C1 dialog/focus consistency, C2 keyboard/naming/status/focus-visible consistency, focused test contracts, and QA procedure committed and pushed
- next action: require successful exact-head source CI, run security/regression/Autoreview, and hand the frozen exact head to the current MacBook Chief for the committed QA procedure
- blocker: none in the implementation lane
- approval state: Bryant authorized Phase C implementation; merge is not authorized
- preferences applied: one builder, small atomic commits, immediate pushes, remote verification, no navigation reorder
- routing decision: SO-008 audit followed by SO-002 narrow fixes; Crate Fix Review Stack before merge readiness
- workflow eval suite/result: exact-head source gate pending on the final documentation checkpoint
- outcome receipt: pending exact-head validation and Bryant approval

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
- [ ] final focused tests and Phase A/B regressions pass on exact head
- [ ] complete source CI passes on exact head
- [ ] security review, regression review, and Autoreview pass
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

## Confirmed audit findings closed by source implementation

1. Secondary dialogs lacked complete dialog semantics and focus lifecycle.
2. Project selection and watching controls were not fully keyboard-operable.
3. Edit Figma Link entry was pointer-only.
4. Several form and toggle controls lacked explicit accessible names.
5. Dynamic Figma error and status surfaces lacked a uniform announcement contract.
6. Active navigation state was visual but did not expose `aria-current`.
7. Focus visibility and keyboard discovery of the remove action were inconsistent.

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

After exact-head CI passes, the current MacBook Chief should follow:

```text
docs/crate/qa-smokes/ui-consistency-accessibility.md
```

The Chief must remain read-only, use synthetic content, verify keyboard/focus/status behavior and Phase A/B regressions, and return `PASS`, `NEEDS_FIX`, or `BLOCKED` without merging or beginning the navigation-order PR.
