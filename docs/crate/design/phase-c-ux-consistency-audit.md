# Phase C — App-Wide UX Consistency and Accessibility Audit

Date: 2026-08-26

## Authority

- repository: `bfeintuch123/crate-app`
- canonical base: `v2.4.x@de935e307c61674af5a684ceab4895aa650a467b`
- branch: `codex/ui-consistency-accessibility-polish`
- draft PR: `#233`
- Phase A authority: merged PR #231
- Phase B authority: merged PR #232

This audit is read-only evidence for a narrow Phase C implementation. It does not authorize the deferred navigation reorder, a redesign, a build, Beta 2.15, or changes to package, watcher, parser, provenance, Figma, quota, privacy, dependency, release, or deployment semantics.

## Executive finding

Phase A and Phase B established strong geometry, state preservation, keyed reconciliation, bounded preview scheduling, immediate busy states, and several specialized modal focus contracts. The remaining material inconsistencies are concentrated in four areas:

1. four secondary dialogs do not participate in the established modal focus and background-inert contract;
2. important Projects and Project Workspace controls are pointer-oriented rather than fully keyboard-operable;
3. several form controls and dynamic status surfaces lack explicit accessible names or announcement semantics;
4. visible keyboard focus is not consistently expressed across interactive controls.

These findings support one focused Phase C PR with two production checkpoints. They do not support a redesign.

## Confirmed strengths to preserve

The current renderer already provides:

- native desktop containment at the Phase A `1100 × 760` minimum;
- reduced-motion suppression for nonessential animation;
- keyed list reconciliation and state restoration from Phase B;
- immediate busy labels, disabled states, `aria-busy`, and duplicate-action suppression for core Phase B actions;
- focus containment and opener restoration for Existing Assets, Package Review, Package Complete, and package-limit dialogs;
- background `inert` and `aria-hidden` handling for the established package and decision flows;
- `role="status"`, polite live announcements, and atomic toast updates;
- stable Package Review status-space behavior.

Phase C must reuse these patterns rather than create a competing interaction system.

## Confirmed findings

### C-A1 — Secondary dialogs lack complete dialog semantics and focus lifecycle

Affected surfaces:

- Remove Project confirmation (`#modal-delete-confirm`);
- Clear All Projects confirmation (`#modal-clear-all`);
- Edit Figma Link (`#modal-edit-figma-link`);
- Quick Package results (`#modal-v2-results`).

Current evidence:

- the overlays are shown and hidden directly;
- they do not consistently declare `role="dialog"`, `aria-modal`, an accessible name, a description, and `tabindex="-1"`;
- they do not consistently move focus inside on open;
- they do not trap Tab or support Escape consistently;
- they do not consistently make the underlying app inert;
- they do not consistently restore focus to the opener on close.

Required correction:

- use one generic, narrowly scoped modal controller for only these four surfaces;
- preserve the existing specialized Existing Assets, Package Review, Package Complete, package-progress, and package-limit behavior;
- preserve existing click actions and product outcomes;
- restore focus to the original opener when it remains connected, with a safe destination-specific fallback when the opener was removed.

### C-A2 — Project selection and watching controls are not fully keyboard-operable

Current evidence:

- each project row is a clickable `div` without button semantics or keyboard activation;
- the Start/Pause Watching pill is an interactive `span` rather than a native button;
- the remove control is visually hidden until pointer hover and has no equivalent `:focus-within` reveal contract.

Required correction:

- make each project row keyboard-focusable and expose button semantics;
- activate project selection with Enter or Space without interfering with nested actions;
- expose the watching pill as a keyboard-operable control with `role="button"`, `tabindex="0"`, `aria-busy`, and `aria-disabled` consistency;
- reveal the remove button when focus enters the row;
- preserve row click routing, watching behavior, delete behavior, keyed identity, and the later deferred navigation-order decision.

### C-A3 — Edit Figma Link entry point is pointer-only

Current evidence:

- the Project Workspace Figma-link row receives an `onclick` handler;
- it is rendered as a non-focusable `div` without button semantics or keyboard activation.

Required correction:

- expose button semantics, a stable accessible name, and keyboard activation with Enter or Space;
- preserve the existing edit-link routing and all Figma semantics.

### C-A4 — Several controls lack explicit accessible names

Confirmed controls:

- new-project name input;
- optional Figma URL and scope in the new-project form;
- Settings naming-template input;
- Package alerts toggle;
- Include diagnostic report toggle;
- Show Package Details toggle;
- disconnected Figma token input;
- Edit Figma Link URL and scope inputs.

Required correction:

- associate existing visible labels through native `<label for>` or `aria-labelledby`/`aria-describedby` references;
- retain current visible copy and layout;
- do not expose credentials, paths, or Figma identifiers in labels or diagnostics.

### C-A5 — Dynamic Figma status and error surfaces are visually updated without a uniform announcement contract

Confirmed surfaces:

- new-project Figma URL error;
- Edit Figma Link error;
- Project Workspace Figma warning;
- Figma Scan status.

Required correction:

- use `role="alert"` for actionable validation errors;
- use polite atomic status semantics for scan progress and noncritical warnings;
- avoid duplicate toast and live-region announcements for the same state;
- preserve current error categories, messages, retry guidance, and Figma scope behavior.

### C-A6 — Active navigation state is visual but not explicitly conveyed to assistive technology

Current evidence:

- the active `.app-tab` receives a visual class;
- the renderer does not update `aria-current` or an equivalent current-destination attribute.

Required correction:

- set `aria-current="page"` only on the active destination and remove it from inactive destinations;
- preserve the current route names and the current sidebar order in this PR.

### C-A7 — Focus visibility is incomplete and the remove action is pointer-biased

Current evidence:

- individual controls have inconsistent focus styling;
- the project remove button is revealed only by hover;
- some custom controls suppress native outlines without a consistent replacement.

Required correction:

- add a scoped `:focus-visible` contract for native buttons, links, inputs, selects, summaries, and custom button-role elements;
- reveal project delete on `:focus-within`;
- avoid changing component sizes, spacing, colors, or the Phase A geometry contract.

## Deferred or rejected scope

The audit does **not** authorize:

- changing sidebar order;
- converting the entire navigation to a formal ARIA tab widget;
- replacing native confirmation behavior for repackaging;
- rewriting the Package Review, Existing Assets, package-limit, or package-completion modal systems that already have focused contracts;
- changing package-progress sequencing;
- changing Figma messages, recovery rules, scope, or network behavior;
- adding animation;
- introducing a design system or framework;
- adding a dependency or runtime file.

The separate later navigation PR remains:

```text
Projects
Project Workspace
Quick Package
```

## Implementation plan

### C1 — Dialog and focus consistency

Likely production files:

- `renderer/index.html`;
- `renderer/app.js` only if the existing source-bound renderer must own generic focus lifecycle behavior;
- `renderer/styles.css` only for focus visibility and focus-within presentation.

Acceptance:

- all four affected dialogs are correctly named and modal;
- focus enters on open, stays inside, Escape closes through the existing safe action, and focus restores on close;
- background surfaces are inert only while the dialog is open;
- established package and Existing Assets modal tests remain green.

### C2 — Keyboard, naming, live-status, and focus-visible consistency

Likely production files:

- `renderer/index.html`;
- `renderer/app.js` only for dynamic project-row, Figma-link, and active-navigation semantics;
- `renderer/styles.css` for scoped focus presentation.

Acceptance:

- project rows, watch controls, and Figma-link editing are keyboard-operable;
- current navigation is announced without changing its order;
- named controls expose the correct visible labels;
- validation errors and status updates use nonduplicative live semantics;
- every interactive control retains a visible focus indicator;
- Phase A geometry and Phase B state/smoothness regressions remain green.

## Verification plan

Run at minimum:

- focused Phase C source and behavior tests;
- impacted renderer/Figma scope tests;
- Phase A responsive geometry contracts;
- Phase B deterministic smoothness and preview tests;
- main-window lifecycle tests;
- packaged-content/source-binding tests for changed renderer files;
- complete serial source suite;
- `git diff --check`;
- high-severity dependency audit without dependency mutation;
- security review, regression review, and Autoreview;
- exact-head privacy-safe visual/keyboard evidence for visible Phase C changes through the approved normal local candidate path.

The consolidated packaged-app QA remains after Phase C and the separate navigation-order PR.

## Audit disposition

```ini
PHASE_C_C0_AUDIT=COMPLETE
confirmed_material_findings=7
recommended_production_checkpoints=2
redesign_warranted=no
navigation_reorder_in_scope=no
dependencies_required=no
native_lifecycle_change_required=no
phase_a_contract_preserved=yes
phase_b_contract_preserved=yes
next_gate=C1_DIALOG_AND_FOCUS_CONSISTENCY
```
