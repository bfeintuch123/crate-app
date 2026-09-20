# Taskflow: Existing Assets native notification

## Binding and authority

- Date: 2026-09-20; standing order SO-002; clawpatch-fix and mandatory exact-head autoreview.
- Native sole writer: `01a0ba98-fede-7c91-85ab-caf5da7d880a`, host `local`.
- Repository `bfeintuch123/crate-app`; canonical `v2.4.x` base `72a06a0191b883c2d98aa4b122408d5a881c32e1` (Beta 2.24 source).
- Branch `codex/existing-assets-native-notification-20260920`; fresh isolated checkout under `2026-09-20/crate-existing-assets-native-notification/repo`.
- Chief delegated Bryant's native-notice request and subsequent explicit default-on Settings toggle request. Authorized source implementation, synthetic tests, normal commits/push, draft PR, and exact-head correction loop. One writer, two distinct Luna/high read-only reviewers, maximum three writer follow-up cycles.
- No owner profile/data access, live Figma/account/provider/credential action, app launch/capture, permission changes, ready/merge, version/build/sign/install/deploy/release or Olivia delivery.

## Behavior and scope

A persisted transition into a newly actionable Existing Assets decision can emit one generic native notification while Crate is in the background. Notification support, global `notifications`, and independent `existingAssetsNotifications` govern delivery. The new preference defaults to true for fresh and absent-field existing settings; explicit false persists. Turning off this type closes its notices and does not modify the in-app decision, watching, other notification preferences, or exclusions. Enabling it later does not retroactively notify an already pending decision.

Arrival does not foreground Crate. Clicking validates current account/project/activation and baseline identity, then focuses Crate and routes to the current decision after trusted renderer readiness. Same-project and cross-project navigation share modal cleanup. Unrelated blocking dialogs, in-flight Include/Skip and Add Files work remain authoritative; the user can finish that interaction and open the decision normally. Resolved/deleted/paused/stale notices have no decision authority. Notice text contains no project names, paths, file names or Figma links.

Watching continues while the decision waits. The current Figma watcher retains its initial scan and 60-second recurring poll; explicit pause/stop, lost link or authentication failures can stop polling independently. The first completed baseline defines Existing assets; later Figma additions remain Added. Packaging remains gated until Include or Skip is recorded. This feature changes neither the watcher schedule nor classification/package policy.

## Source verification and receipts

Synthetic main-process and renderer coverage includes transition deduplication, click without mutation, queued readiness, stale resolution/deletion/pause/account/preference clicks, global/type/OS/foreground suppression, absence default, persisted explicit false, unchanged package-completion notices, same/cross-project focus and modal isolation, delayed account/selection reads, and in-flight work preservation. Existing Figma/renderer regression suites, syntax and whitespace checks are required before commit.

Final commit, draft PR, exact protected CI identity and fresh reviewer verdicts are recorded externally in the native task/PR receipt, avoiding a commit that describes its own checks. Correction-cycle count starts at zero. Earlier PR266/267 results do not validate this head.

## Separate synthetic visual and OS delivery gate

Under a separately authorized running-candidate gate, bind the exact PR head and use a clean synthetic profile and isolated candidate:

1. Capture Settings General with default-on Existing assets need review, then off, restart, and retained off. Verify global-off precedence and independent package alerts.
2. Background Crate with a synthetic project; complete an initial Existing baseline. Capture the native banner/Notification Center item and absence of focus theft. Repeat scans and show one notification only.
3. Click with the same project selected and then in a separate cross-project scenario; capture the correct single decision dialog and keyboard focus. Demonstrate no automatic Include/Skip and no exclusion changes.
4. Resolve, pause, delete, sign out, or disable the preference before clicking stale notices; confirm no stale navigation or mutation. Preserve unrelated active dialogs and in-flight operations.
5. Leave the dialog waiting, ingest a later synthetic Added asset, then explicitly decide and inspect the packaging gate.

Source mocks do not establish macOS permission, banner style, Notification Center retention, delivery, installed-app behavior, or exact-head visual acceptance. Capture and inspect only approved synthetic Crate/notification surfaces with unrelated notifications and desktop content excluded. No permission toggles or capture are authorized by this source task. Keep the PR draft pending that gate and separate owner authorization for ready/merge.


## Correction cycle 1: preserve newer tab navigation

Initial head `494f4875dbeb2fa3896257fea3bf6a7beebc65e3` passed protected CI `35533188084` (1,441 passed, zero failed, one skipped) and local suites (954 passed). UI review passed. The independent lifecycle reviewer found a P2 delayed-notification navigation race: a newer Settings/Projects tab choice did not invalidate the pending project read, which could later reopen Current Project and its decision dialog.

A deferred-read regression reproduced the wrong-project selection on the initial head. The normal writer follow-up captures tab navigation intent alongside project/account guards, so a later tab choice wins. Focused tests cover both delayed project reads and delayed asset-workspace reads, Settings and Projects, selected project, visible tab, hidden decision modal, final focus and absence of decision/package mutation. Both delay cases failed before their guard was applied. Every prior CI/review result is invalid for the new head; fresh CI and both reviews are recorded externally. Correction-cycle count: 1 of 3.

The reviewers also considered and rejected two candidates: a fresh explicit baseline decision on a paused project is actionable under the existing paused Add Files/accepted-source contract, and a newer notification click may supersede older queued navigation. Neither requires watcher or notification-policy changes. Notices created before a later pause still lose authority.


## Correction cycle 2: latest notification click wins

Before cycle 1's protected run completed, a parent read-only synthetic probe at `628a271be379e404d565c4c1ac2cb6af2a071655` reproduced a second ordering defect: after two valid notice clicks A then B, A's faster project response could select A and invalidate newer B. Cycle 1 reviews were held, not passed.

This normal follow-up records each admitted click as a new selection intent before its asynchronous read and carries that intent through the existing render-current guard. Regressions cover both project-read completion orders and a superseded older asset-workspace render while the newer project read waits. The new keyboard-focus assertion also exposed workspace focus restoration overriding a newly opened modal; restoration now leaves active modal focus intact while still restoring scroll. No asset decision, exclusion, watcher or native delivery policy changes. Fresh protected CI and both independent reviews are required at the new head, recorded externally. Correction-cycle count: 2 of 3.
