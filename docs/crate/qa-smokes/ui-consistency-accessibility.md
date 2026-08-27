# Crate Consolidated Packaged-App QA — UX Consistency, Navigation, and Regression

Use this procedure for the one consolidated packaged Crate candidate after Phase A, Phase B, Phase C, and the separate navigation-order change have merged into the canonical `v2.4.x` branch.

This is a read-only QA and evidence gate for a candidate that has already been built through the repository-approved process. Do not edit source or tests, create commits, push, merge, rebuild, sign, notarize, release, deploy, begin Beta 2.15, or update the Vault during QA.

## Authority

- repository: `bfeintuch123/crate-app`
- candidate: one packaged Crate artifact built from the resolved canonical `v2.4.x` head
- canonical head: resolve and record the full SHA immediately before QA
- Phase A authority: merged desktop minimum and responsive-containment work
- Phase B authority: merged state/rendering stability, preview scheduling, and interaction feedback work
- Phase C authority: merged UX consistency, accessibility, focus, status, and reduced-motion work
- navigation authority: the separately merged navigation-order change
- required primary navigation order: `Projects → Project Workspace → Quick Package`

The candidate must include the canonical Crate fixes carried by Phases A, B, and C and the navigation-order change. It must not reintroduce any removed Crate Ops or Crabbox implementation, workflow, runner, artifact-publishing, or operations files into the Crate App repository. Crate Ops guidance and the instruction-based `AGENTS.md` policy remain operational documentation; they are not product runtime code or packaged-app behavior.

Resolve the canonical `v2.4.x` head and packaged-candidate provenance immediately before execution. Require the recorded source SHA, artifact provenance, and protected source CI to match.

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

git diff --check
```

Run the complete serial source suite in the approved lockfile-identical environment:

```sh
node --test --test-concurrency=1 tests/*.test.js
```

Record exact commands, Node and Electron versions, exit codes, pass/fail/skip counts, and durations. Do not change `package.json` or `package-lock.json`.

## Candidate identity and provenance

Record the canonical source SHA, packaged artifact name and hash, build provenance, and the exact source and test checks used to produce the candidate. Confirm the packaged artifact contains the merged Crate source and does not contain removed Crate Ops or Crabbox implementation. Preserve the existing Phase A `1100 × 760` desktop minimum and the Phase B/Phase C source contracts.

Use the repository-approved packaged-app launch path. Do not substitute a browser mock, static HTML, a stale PR checkout, or an unverified development shell for the packaged candidate.

## Required keyboard and focus scenarios

### 1. Primary navigation

Using the keyboard only:

1. Tab through Projects, Project Workspace, Quick Package, Settings, and Help.
2. Confirm every destination has a visible focus indicator.
3. Activate each destination with the native button behavior.
4. Confirm exactly one active destination exposes `aria-current="page"` through the accessibility inspector or a trusted DOM probe.
5. Confirm the visible and keyboard order is:
   - Projects;
   - Project Workspace;
   - Quick Package.

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

Confirm the consolidated candidate did not regress the existing specialized behavior for:

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

## Olivia/Jenna regression coverage

Exercise the canonical scenarios that previously exposed Crate failures:

- large watched projects remain responsive and do not cause sustained main-process runaway work;
- watcher polling remains bounded, single-flight, cancellable, and free of no-op project-store rewrites;
- pre-existing files are not admitted as newly captured work merely because a supported design application is open;
- genuinely new current-session files, parser-confirmed assets, provenance, package selection, output-folder exclusions, quota behavior, and persisted project state remain unchanged;
- Figma link scope, token failure handling, package-time blocking, and recovery guidance remain fail-closed and privacy-safe;
- Review Assets counts, filters, search, thumbnails, scroll, focus, card identity, and footer containment remain correct;
- Package Review does not create output, include an unrelated Illustrator asset, or bypass user review;
- start/pause/resume, relaunch, package recovery, and error states remain usable.

Record any difference from the accepted Olivia/Jenna behavior as a defect. Do not dismiss it as a UI-only change without tracing it to the candidate and its canonical source.

## Evidence

Capture only the minimum privacy-safe evidence required to show:

- keyboard focus on primary navigation;
- project selection, watching, and remove controls;
- one secondary dialog focus loop and Escape close;
- Figma-link keyboard activation and Edit Figma dialog focus;
- Settings toggle naming/focus;
- the requested navigation order;
- no geometry regression at the desktop minimum.

Use a tightly framed, silent, window-only recording when video is useful. Inspect the complete recording and every screenshot. Record filenames, media type, exact byte count, SHA-256, exact PR head, capture environment, complete-inspection result, and privacy result.

Do not commit or publish evidence before Bryant reviews it.

## Return

```ini
CONSOLIDATED_CRATE_PACKAGED_QA=PASS|NEEDS_FIX|BLOCKED
canonical_branch=v2.4.x
canonical_head=
packaged_candidate=
packaged_candidate_sha256=
source_ci=
phase_a_regressions=
phase_b_regressions=
phase_c_regressions=
olivia_jenna_regressions=
worktree_clean=
focused_tests=
full_source_suite=
git_diff_check=
primary_navigation_order=Projects,Project_Workspace,Quick_Package
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
navigation_reorder_verified=PASS|FAIL
build_started=no
beta_2_15_started=no
exact_blockers=
```

Stop after returning the report. Do not merge, rebuild, release, or begin Beta 2.15 from this QA procedure. Advance toward Beta 2.15 and Olivia testing only after this consolidated candidate passes.
