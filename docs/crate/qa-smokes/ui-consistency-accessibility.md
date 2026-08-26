# Crate Phase C — UX Consistency and Accessibility QA

Use this procedure on a fresh exact-head MacBook checkout of draft PR #233 after the source gate is green.

This is a read-only QA and evidence gate. Do not edit source or tests, create commits, push, modify PR #233, merge, build a packaged app, sign, notarize, release, deploy, begin Beta 2.15, update the Vault, or implement the deferred navigation reorder.

## Authority

- repository: `bfeintuch123/crate-app`
- draft PR: `#233 — Polish app-wide UX consistency and accessibility`
- branch: `codex/ui-consistency-accessibility-polish`
- base: live `v2.4.x` containing Phase B merge `de935e307c61674af5a684ceab4895aa650a467b`
- Phase A authority: merged PR #231
- Phase B authority: merged PR #232
- navigation order remains unchanged in this PR: `Projects → Quick Package → Project Workspace`

Resolve the live PR and remote branch head immediately before execution. Require them to match and require successful exact-head source CI.

## Privacy-safe fixture

Use the existing committed synthetic renderer fixture or another repository-approved synthetic local-development fixture. Do not use a real customer project, Bryant or Jenna files, a real Figma URL, a private path, a credential, a token, package output, or unrelated desktop content.

Do not create a new QA-only production path or dependency.

## Focused source checks

Run the exact-head equivalents of:

```sh
node --test --test-concurrency=1 \
  tests/ui-consistency-accessibility.test.js \
  tests/ui-consistency-keyboard-contract.test.js \
  tests/ui-consistency-keyboard-runtime.test.js \
  tests/renderer-figma-scope.test.js \
  tests/ui-stability-responsive.test.js \
  tests/ui-stability-responsive-geometry.test.js \
  tests/main-window-lifecycle.test.js

git diff --check de935e307c61674af5a684ceab4895aa650a467b...HEAD
```

Run the complete serial source suite in the approved lockfile-identical environment:

```sh
node --test --test-concurrency=1 tests/*.test.js
```

Record exact commands, Node and Electron versions, exit codes, pass/fail/skip counts, and durations. Do not change `package.json` or `package-lock.json`.

## Normal local candidate

Use the existing approved normal local-development candidate path. Phase C does not require another custom disposable Electron runner because it does not change native lifecycle or packaging.

The candidate must be bound to the exact PR head and use the existing Phase A `1100 × 760` desktop minimum.

## Required keyboard and focus scenarios

### 1. Primary navigation

Using the keyboard only:

1. Tab through Projects, Quick Package, Project Workspace, Settings, and Help.
2. Confirm every destination has a visible focus indicator.
3. Activate each destination with the native button behavior.
4. Confirm exactly one active destination exposes `aria-current="page"` through the accessibility inspector or a trusted DOM probe.
5. Confirm the visible and keyboard order is still:
   - Projects;
   - Quick Package;
   - Project Workspace.

Do not implement or simulate the separately deferred reorder.

### 2. Projects list

With a synthetic project present:

1. Tab to the project-selection control.
2. Confirm the focus indicator is visible.
3. Activate with Enter and Space and verify the existing selected-project route.
4. Tab to Start/Pause Watching.
5. Confirm the control exposes button semantics, immediate busy state, and duplicate-action suppression inherited from Phase B.
6. Confirm the remove button becomes visible when focus is inside the project row and remains reachable by keyboard.
7. Open Remove Project.
8. Confirm focus enters on Cancel, Tab and Shift+Tab remain inside, Escape closes without deleting, and focus restores to the opener.
9. Open the dialog again and complete removal only in a disposable synthetic state when the approved fixture permits it. Confirm a removed opener falls back safely to Projects navigation.

### 3. Project Workspace Figma-link entry

With the synthetic project selected:

1. Confirm the Figma-link row is keyboard-focusable only after the existing renderer has attached its edit action.
2. Confirm it exposes button semantics and a meaningful accessible name.
3. Activate it with Enter and Space.
4. Confirm Edit Figma Link opens with focus in the URL field.
5. Confirm Tab and Shift+Tab remain inside the dialog.
6. Confirm Escape closes and restores focus to the Figma-link entry.
7. Submit an invalid synthetic value only if the fixture safely permits it; confirm the existing validation copy is announced as an alert and no Figma network request is made.
8. Do not save, replace, or remove a real link.

### 4. Settings names and focus

At `1100 × 760`:

1. Navigate to Settings by keyboard.
2. Confirm the naming-template field has the visible Template label.
3. Confirm Package alerts, diagnostic report, Package Details, and package-folder toggles expose their visible names and descriptions.
4. Confirm every input, toggle, button, and link has a visible focus indicator.
5. Confirm Figma token input is named without exposing its value.
6. Confirm the Figma Scan button references its status text without producing duplicate live announcements.
7. Open Clear All Projects.
8. Confirm focus enters on Cancel, remains trapped, Escape closes, and focus restores to Clear All Projects.
9. Do not complete Clear All outside a disposable synthetic fixture.

### 5. Quick Package results

Using only a repository-approved synthetic Quick Package result state:

1. Open the result dialog without writing a real package.
2. Confirm the dialog has an accessible name and description.
3. Confirm focus enters on Done, remains inside, Escape closes through the existing Done behavior, and focus restores to Browse Files or Quick Package navigation.
4. Confirm Open Folder remains unchanged and is not invoked against a real path.

### 6. Established dialogs regressions

Confirm Phase C did not regress the existing specialized behavior for:

- Existing Assets decision;
- Package Review;
- Package Complete;
- package-limit/upgrade;
- package progress.

For each reachable synthetic state, confirm accessible naming, focus placement, focus containment, close behavior, and opener restoration remain consistent with the pre-Phase-C contract.

## Status and announcement review

Inspect these synthetic states:

- new-project Figma URL validation error;
- Edit Figma Link validation error;
- Project Workspace Figma warning;
- Package Review Figma warning;
- Figma Scan status;
- project-linking alert;
- Phase B busy states and toasts.

Require:

- actionable validation errors use assertive alert semantics;
- noncritical warnings and progress use polite atomic status semantics where appropriate;
- one state change is not announced twice through both a live region and an equivalent toast;
- existing wording, error categories, retry guidance, and Figma scope behavior remain unchanged.

## Geometry and motion regression

At `1100 × 760`, normal, and wide sizes confirm:

- no application-level horizontal overflow;
- no focus ring is clipped;
- dialogs remain contained;
- keyboard-revealed project controls do not change row geometry;
- Phase B busy labels retain stable dimensions;
- reduced-motion preference suppresses nonessential motion;
- Phase A and Phase B deterministic tests remain green.

## Evidence

Capture only the minimum privacy-safe evidence required to show:

- keyboard focus on primary navigation;
- project selection, watching, and remove controls;
- one secondary dialog focus loop and Escape close;
- Figma-link keyboard activation and Edit Figma dialog focus;
- Settings toggle naming/focus;
- no navigation reorder;
- no geometry regression at the desktop minimum.

Use a tightly framed, silent, window-only recording when video is useful. Inspect the complete recording and every screenshot. Record filenames, media type, exact byte count, SHA-256, exact PR head, capture environment, complete-inspection result, and privacy result.

Do not commit or publish evidence before Bryant reviews it.

## Return

```ini
PHASE_C_PR233_QA=PASS|NEEDS_FIX|BLOCKED
authoritative_pr=233
exact_head=
remote_branch_head=
source_ci=
worktree_clean=
focused_tests=
full_source_suite=
git_diff_check=
primary_navigation_order=Projects,Quick_Package,Project_Workspace
aria_current=PASS|FAIL
project_keyboard=PASS|FAIL
watch_control_keyboard=PASS|FAIL
project_delete_focus_reveal=PASS|FAIL
delete_dialog_focus=PASS|FAIL
figma_link_keyboard=PASS|FAIL
edit_figma_dialog_focus=PASS|FAIL
settings_names_and_focus=PASS|FAIL
clear_all_dialog_focus=PASS|FAIL
quick_package_results_focus=PASS|FAIL
established_modal_regressions=PASS|FAIL
status_announcement_review=PASS|FAIL
phase_a_geometry_regression=PASS|FAIL
phase_b_smoothness_regression=PASS|FAIL
reduced_motion=PASS|FAIL
visual_findings=
evidence_inventory=
complete_media_review=
privacy_review=
repository_mutated=no
pr_mutated=no
navigation_reorder_started=no
build_started=no
beta_2_15_started=no
exact_blockers=
```

Stop after returning the report. Do not merge PR #233 and do not begin the navigation-order PR.
