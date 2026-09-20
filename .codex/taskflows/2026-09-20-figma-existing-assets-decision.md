# Taskflow: Figma existing-assets decision and bulk actions

## Binding and authority

- Date: 2026-09-20; standing order SO-002; focused-fix and deep exact-head autoreview.
- Native sole-writer task: `01a0ba98-fede-7c91-85ab-caf5da7d880a`, host `local`.
- Canonical repository: `bfeintuch123/crate-app`; base `v2.4.x` at `fca609db4373f26ab31d981f63d69b5f2ee3a1f8`.
- Branch: `codex/figma-existing-assets-decision-20260920`; fresh persistent isolated checkout, not the retired temporary PR264 checkout.
- Bryant authorized this correction, focused checks, normal commits/push, draft PR, and the mandatory exact-head correction loop. Chief delegation on September 20 is the approval source.
- One repository writer; independent reviewers use Luna/high and remain read-only. Three writer follow-up cycles maximum; every head change invalidates earlier CI/review evidence.

## Scope

Connect complete Figma snapshot completion to the shared Existing Assets decision; provide explicit Include existing assets / Skip existing assets actions; explain the all-included button state; repair old Existing lifecycle gaps only after complete current scan evidence. Preserve explicit decisions and individual exclusions, Working Files, Added assets, account/project isolation, Current Page Only, retries, and scope/link fences.

No owner project data, live Figma/account/token access, live app or auth computer use, dependency/version mutation, ready/merge, build/sign/release/install/deploy, or tester delivery.

## Evidence and status

- Starting protected source CI: run `35474239370`, PASS at exact base `fca609d`.
- Failure-first regression on an untouched archive of that base reproduces `asset_baseline_decision_unavailable` after a complete synthetic twenty-asset Figma snapshot.
- Product patch bridges complete/current snapshots into the shared lifecycle, waits for required native source work, preserves prior decisions, and applies prior skip only to newly ingested Existing Figma rows.
- Renderer provides explicit include/skip choices, existing focus/busy/error guards, and visible already-included button wording.
- Synthetic regressions cover twenty-asset bulk operations, serialized store reload and later scan, individual exclusion, old-marker repair without reclassifying Added rows, prior decisions, mixed-source completion order/failure/retry, empty and incomplete scans, package decision gating, and accessible UI actions.
- Doctor preflight could not run because its fixed legacy repository path is absent on this Mac. Canonical identity, clean starting base, GitHub access, and protected CI were verified directly; doctor/tooling changes are outside this correction.
- UI changes require exact-head running-candidate visual evidence under AGENTS.md. That evidence remains unperformed under the explicit no-live-app scope and is not waived by source tests.

## Review correction cycle 1

At initial head `a08a0190784e56189659cb600104d40ca7210403`, protected CI `35514873578` passed (1,431 passed, zero failed, one skipped). The state reviewer passed; the independent UI reviewer found that individually excluded Existing rows were hidden from the initial-choice dialog even though its actions affect them. With all rows excluded, the required choice could fail to appear.

The normal writer follow-up includes every Existing row in the decision set, discloses the currently skipped count and all-assets effect, and adds partial/all-excluded regressions. The new regression fails against the unchanged initial head; updated Figma/renderer suites pass 352/352 locally. These are pre-commit results; the new exact head requires fresh protected CI and both independent Luna/high reviews, recorded externally below. Correction-cycle count: 1 of 3.

## Review correction cycle 2

At head `60f36ccbb4b93276c425c53b6b3cfed07d583c08`, protected CI `35515669256` passed (1,432 passed, zero failed, one skipped), and local serial checks passed 938/938. The excluded-assets finding was closed. Review found a remaining keyboard retry problem: failed Skip saved no decision but moved focus to Include.

The second normal writer follow-up restores the attempted choice only while its modal session is current. Copy explicitly discloses the existing project-wide action, including assets not shown, without treating the scoped preview count as the total affected set; backend scope behavior is unchanged. A failure-first regression demonstrates the old focus error and covers failed Include/Skip, unsuccessful results/thrown errors, and activation of the focused retry control. Current Figma/renderer checks pass 352/352 before commit. Fresh final-head CI and both independent Luna/high reviews are required and recorded externally. Correction-cycle count: 2 of 3. Current correction tests do not substitute for historical Olivia/Jenna acceptance; Chief coordinates a separate read-only historical audit.

## Final-head evidence contract

This file records scope and reproducible evidence without attempting to record its own commit SHA. Consult the draft PR and native task's persistent September 20 receipt for the latest exact head, focused-check results, protected CI, two distinct Luna/high reviews, and correction-cycle count before resuming. Results are recorded externally after each committed head; do not make a self-recording documentation commit merely to repeat those results.

## Next gate

Complete the authorized source verification/review loop and stop at the reviewable draft PR. Ready/merge and required running-candidate visual evidence remain separate gates, followed by separately authorized build and installed-app QA.
