# Taskflow: Beta 2.16 Resume and Add Files Stability

- Created: 2026-08-29
- Owner: dedicated Crate implementation writer
- Standing order: SO-002 Autonomous Crate Failure Loop
- Repository: bfeintuch123/crate-app
- Canonical branch: v2.4.x
- Base: 18ee1e74d8f1bf7d1bfa9318319f3815ea91080e
- Working branch: codex/beta-2.16-resume-import-stability
- Mode: deep correction, focused regression, full serial validation, protected CI, independent read-only review
- Status: active follow-up; draft PR remains open and unmerged

## Objective

Correct the confirmed Beta 2.15 watcher resume visibility defect and the multi-file Add Files stall while preserving watcher admission, provenance, privacy, package safety, Phase A/B/C UI contracts, PR #237 filesystem bounds, and PR #238 review-cohort and stable-identity behavior.

## Allowed scope

- Persisted accepted asset visibility and reconciliation across Start Watching, Pause, and Resume.
- Bounded completion or explicit fail-closed behavior for multi-file Add Files, including 30-, 263-, and 500-file contracts.
- Focused regression tests and required validation receipts.

## Forbidden scope

- No version change or Beta 2.16 artifact encoding.
- No Figma correction, Quick Package, quota, parser, packaging-semantics, or release change unless a changed-surface regression proves it.
- No build, sign, notarize, install, publish, release, deploy, merge, Vault mutation, or distribution.

## Checkpoints

1. Exact live base and clean isolated checkout: complete.
2. Root cause evidence and narrow patch design: complete.
3. Focused regression coverage and focused tests: complete.
4. Complete serial source and regression validation: pending for the cap-removal follow-up.
5. Small atomic follow-up commits, push, draft PR update, protected exact-head CI: pending.
6. Fresh independent Luna/high read-only review: pending for the new exact head.

## Current handoff

- Last verified head: a514d67f6d0a0458b487c8891e0f29017e82aba0.
- Last verified checkout: /private/tmp/crate-beta-2.16-resume-import-stability, clean at the prior published head before this follow-up.
- Diagnosis: persisted watcher acceptance was not a durable Illustrator scope admission signal after reactivation; Add Files performed an unbounded first-scan fan-out after committing the selected batch, and the temporary 100-file cap hid that scalability defect.
- Correction: provenance-backed accepted chokidar Illustrator sources remain visible after reactivation; Add Files now admits the complete selection, drains first scans through a four-worker internal queue, reports per-source failures without dropping successful files, and clears the renderer busy state for every terminal outcome.
- Validation: cap-removal focused watcher/Add Files tests, renderer busy-state tests, complete serial source suite, adjacent regression suites, protected exact-head CI, and fresh independent review remain pending for this follow-up.
- Next action: finish focused and serial validation, update the draft PR description, push the atomic follow-up commits, then bind CI and independent review to the new exact head.
- Blockers: release-tooling local dependency setup remains outside the source change and is delegated to CI’s dependency-complete environment.
