# Taskflow: Beta 2 DMG Envelope Finalization

## Metadata

- created: 2026-07-17
- updated: 2026-07-17
- owner: Codex under Bryant approval
- standing order: SO-002 and SO-003
- repo: crate-app
- branch: `codex/correct-beta2-pre-notary-gate`
- base: `v2.4.x`
- mode: release-blocker failure loop
- status: source-merge ready

## Goal

Require a signed DMG and regenerate update metadata from the final notarized and stapled DMG bytes without changing Crate runtime behavior.

## Scope

Allowed:

- Electron Builder DMG signing configuration
- final DMG blockmap and macOS update metadata tooling
- release policy tests and playbook ordering

Forbidden:

- runtime, renderer, watcher, parser, package, provenance, diagnostics, Figma, quota, or dependency changes
- tag, GitHub release, website, Cloudflare, install, or tester mutation before every release gate passes

## State

- current phase: publish and review the pre-notarization gate correction
- last completed checkpoint: final Autoreview approved the four-file policy-only correction after exact order assertions were added
- next action: commit, push, open the PR against `v2.4.x`, and run merge readiness
- blocker: none inside the approved correction
- approval state: Bryant approved proceeding with the correction and tester-beta release flow

## Checkpoints

- [x] preflight / doctor
- [x] context loaded
- [x] implementation or execution
- [x] verification
- [ ] proof bundle
- [ ] ledger/state update
- [ ] handoff or next prompt

## Evidence

| Time | Action | Evidence | Result |
| --- | --- | --- | --- |
| 2026-07-17 | DMG envelope assessment | `spctl` primary-signature gate | rejected unsigned DMG; no release mutation followed |
| 2026-07-17 | Focused release tests | 61 passed, 1 intentional CI-only skip | passed after Autoreview fixes |
| 2026-07-17 | Real metadata finalization | Electron Builder blockmap engine with cloned artifacts | passed; ZIP and ZIP blockmap unchanged |
| 2026-07-17 | Focused finalization and release tests | 66 tests, exit 0 | passed after the second Autoreview fixes |
| 2026-07-17 | Full serialized source suite | `node --test --test-concurrency=1 --test-reporter=dot tests/*.test.js` | exit 0 |
| 2026-07-17 | Install-script and dependency gates | 6 approved lifecycle packages; `npm audit --audit-level=high` | passed; 0 vulnerabilities |
| 2026-07-17 | Scope and source checks | syntax, `git diff --check`, protected runtime surface diff | passed; no runtime or package-lock changes |
| 2026-07-17 | Final release-blocker Autoreview | independent read-only review of complete tracked and untracked diff | APPROVE; no actionable findings |
| 2026-07-17 | Signed DMG pre-submit validation | `codesign --verify` and `spctl` against fresh exact-merge-SHA build | signature valid; Gatekeeper correctly withheld acceptance pending notarization |
| 2026-07-17 | Apple workflow confirmation | Apple notarization documentation | sign first, notarize, staple, then require Gatekeeper acceptance |
| 2026-07-17 | Corrected gate verification | 44 focused policy tests, full serialized suite, install-script policy, audit | passed; 0 vulnerabilities |
| 2026-07-17 | Final correction Autoreview | independent read-only review after order assertions and command grouping | APPROVE; no actionable findings |

## Risks

- Stapling mutates DMG bytes, so pre-staple blockmaps and updater metadata must never be published.
- Release tooling must remain isolated from Crate product behavior.
- Pre-notarization signature validity and post-notarization Gatekeeper acceptance must remain separate gates.

## Handoff

Next exact action:

```text
Run the release-blocker review stack on the signed-DMG and final metadata correction. Merge only if clean, then rebuild beta.2 from the exact protected-branch merge SHA.
```
