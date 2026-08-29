# Taskflow: Beta 2.16 Resume and Add Files Stability

- Created: 2026-08-29
- Owner: dedicated Crate implementation writer
- Standing order: SO-002 Autonomous Crate Failure Loop
- Repository: bfeintuch123/crate-app
- Canonical branch: v2.4.x
- Base: 18ee1e74d8f1bf7d1bfa9318319f3815ea91080e
- Working branch: codex/beta-2.16-resume-import-stability
- Mode: deep correction, focused regression, full serial validation, protected CI, independent read-only review
- Status: complete for the source-correction lane; draft PR remains open and unmerged

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
4. Complete serial source and regression validation: complete with three isolated-checkout dependency failures; changed-surface and canonical-dependency reruns pass.
5. Small atomic commit, push, draft PR, protected exact-head CI: complete.
6. Fresh independent Luna/high read-only review: complete; no P0/P1 findings.

## Current handoff

- Last verified head: f4dbaa9a25e18a41c4a9f6d8f4b5041808a997af.
- Last verified checkout: /private/tmp/crate-beta-2.16-resume-import-stability, clean, exact-head bound.
- Diagnosis: persisted watcher acceptance was not a durable Illustrator scope admission signal after reactivation; Add Files performed an unbounded first-scan fan-out after committing the selected batch.
- Correction: provenance-backed accepted chokidar Illustrator sources remain visible after reactivation; selections above 100 return a controlled result before mutation and the renderer clears its busy state with bounded guidance.
- Validation: focused watcher/Add Files tests, renderer suite 144/144, provenance suite 422/422, serial source suite 1,033 passed / 1 skipped / 3 dependency-environment failures.
- Next action: stop this lane. A later owner may decide the separate Beta 2.16 version gate and downstream candidate QA; no artifact or release action is authorized here.
- Blockers: release-tooling local dependency setup remains outside the source change and is delegated to CI’s dependency-complete environment.
