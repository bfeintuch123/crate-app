# Crate Phase B0 — App-Wide Smoothness Baseline

Use this procedure on a fresh exact-head MacBook checkout of draft PR #232 before Phase B production behavior changes begin.

This is a read-only diagnosis and evidence gate. Do not edit source, tests, the PR, dependencies, package files, release state, or the local Vault while collecting the baseline.

## Authority

- repository: `bfeintuch123/crate-app`
- draft PR: `#232 — Improve app-wide interaction and rendering smoothness`
- branch: `codex/ui-stability-app-smoothness`
- base: `v2.4.x@d2a7be01b89d3ff8bebfe3daf927aa34e6a16629`
- Phase A desktop minimum: `1100 × 760`

Resolve the live PR and remote branch head immediately before execution. Require them to match and require successful exact-head source CI.

## Synthetic coverage

The baseline exercises projects containing:

```text
0 assets
7 assets
30 assets
100 assets
263 assets
500 assets
```

The 30-asset fixture receives the full app-wide navigation, action-feedback, and modal audit. The larger fixtures are stress tests rather than the sole product target.

All fixture names and identities are synthetic. Do not substitute a real project, Figma link, path, credential, customer file, or personal file.

## Fresh checkout

1. Fetch origin.
2. Resolve the live PR #232 head and remote branch head.
3. Confirm they match.
4. Confirm PR #232 remains open, draft, and unmerged.
5. Confirm exact-head source CI is successful.
6. Create a fresh detached disposable worktree at that exact SHA.
7. Confirm `git status --short` is empty.
8. Use an approved lockfile-identical dependency-complete environment without changing `package.json` or `package-lock.json`.

## Focused source checks

Run:

```sh
node --check tests/ui-smoothness-fixture.js
node --check tests/ui-smoothness-preload.js
node --check tests/ui-smoothness-electron-baseline.js
node --test --test-concurrency=1 \
  tests/ui-smoothness-fixture.test.js \
  tests/ui-smoothness-preload-contract.test.js \
  tests/ui-smoothness-harness-contract.test.js
git diff --check d2a7be01b89d3ff8bebfe3daf927aa34e6a16629...HEAD
```

Run the complete serial source suite when supported by the approved environment:

```sh
node --test --test-concurrency=1 tests/*.test.js
```

Record exact commands, versions, exit codes, pass/fail/skip counts, and durations.

## Authentic Electron baseline

Create an owner-only evidence directory outside the repository:

```sh
EVIDENCE_DIR="$(mktemp -d /private/tmp/crate-pr232-smoothness.XXXXXX)"
chmod 700 "$EVIDENCE_DIR"
```

Run:

```sh
set +e
CRATE_SMOOTHNESS_SHOW=1 \
CRATE_SMOOTHNESS_EVIDENCE_DIR="$EVIDENCE_DIR" \
./node_modules/.bin/electron tests/ui-smoothness-electron-baseline.js \
  > "$EVIDENCE_DIR/baseline.json" \
  2> "$EVIDENCE_DIR/baseline.stderr"
BASELINE_STATUS=$?
set -e
```

Require:

- a complete parseable JSON report;
- renderer/harness exit status `0` unless a real harness, renderer, console, or process error occurred;
- the `findings` array may be non-empty because this is a diagnostic baseline;
- no private information in JSON, stderr, or screenshots.

Stop if the report is truncated or the fixture cannot launch. Do not improvise a source fix in the QA lane.

## Required measurements

For every asset size, report:

- Project Workspace visible and settled timing;
- Review Assets open timing;
- initial preview requests reaching the test bridge;
- one-event `getProjects`, workspace, preview, and event counts;
- whether an unchanged primary row, visual container, and loaded image retained DOM identity;
- rows/nodes added and removed from each observed list;
- search, filter, focus, scroll, and Review Assets state before and after one event;
- ten-event burst read/request counts and mutation counts;
- hidden Projects-list mutations while Settings is active;
- renderer long tasks and layout shifts when supported;
- errors and screenshots.

For the 30-asset fixture, also report:

- acknowledgement and settled timing for Projects, Quick Package, Project Workspace, Settings, and Help;
- API-call deltas for each navigation;
- immediate feedback for pause/start watching, Add Files, Figma Scan Now, and Package Review;
- Package Review opening time, dimensions, focus, and confirmation state.

## Human inspection

Inspect all screenshots at full size. Check normal—not only stress—projects for:

- flashes of empty content;
- loaded thumbnails returning to placeholders;
- scroll jumps;
- focus loss;
- search/filter resets;
- old project data appearing after navigation;
- hidden destinations visibly or structurally rebuilding;
- buttons that give no immediate acknowledgement;
- changing button dimensions;
- unstable modal dimensions;
- unnecessary motion or layout shifts;
- clipped or inaccessible feedback.

This baseline does not authorize UI changes. Record the observations precisely.

## Privacy and integrity

Inspect the complete JSON, stderr, and every screenshot. Record byte counts and SHA-256 hashes. Reject and delete any artifact containing unrelated desktop content, notifications, private paths, credentials, real Figma identifiers, customer work, personal files, or audio.

Do not commit evidence to the product branch or publish it before Bryant reviews it.

## Return report

Return:

```ini
PHASE_B0_APP_WIDE_SMOOTHNESS_BASELINE=PASS|BLOCKED
pr=232
exact_head=
remote_branch_head=
source_ci=
worktree_clean=
focused_tests=
full_source_suite=
git_diff_check=
baseline_exit_status=
baseline_report_complete=
asset_sizes=0,7,30,100,263,500
single_event_results=
burst_event_results=
hidden_destination_results=
node_identity_results=
preview_results=
scroll_focus_search_filter_results=
navigation_results=
action_feedback_results=
modal_results=
long_task_results=
human_findings=
evidence_inventory=
privacy_review=
repository_mutated=no
pr_mutated=no
phase_b_runtime_changes_started=no
recommended_B1_scope=
recommended_B2_scope=
exact_blockers=
```

Stop after returning the baseline. The implementation owner will use the evidence to choose narrow B1 and B2 changes.
