# Taskflow: Release Verifier Codesign Integrity

## Metadata

- created: 2026-07-29
- updated: 2026-07-29
- owner: Codex
- standing order: SO-002 Autonomous Crate Failure Loop
- repo: bfeintuch123/crate-app
- branch: codex/fix-release-verifier-codesign
- base: v2.4.x
- mode: approved narrow fix and preauthorized clean merge
- status: review-fix-verified

## Goal

Keep ASAR verification fail-closed while accepting only codesign mutations to exact unpacked Mach-O dependency files that pass the existing authenticated signature-normalized native proof.

## Scope

Allowed:

- `scripts/verify-macos-release-app.js`
- focused release verifier and toolchain tests
- directly relevant Crate taskflow and proof documentation
- commit, push, PR, review resolution, CI rerun, and clean merge

Forbidden:

- runtime app behavior, UI, main/preload/renderer/parsers, watcher, package/provenance behavior
- Figma, quota, dependencies, version, website, Cloudflare, release artifacts, and user data
- build, signing, notarization, tagging, and publishing

## State

- current phase: valid P1 review finding fixed and locally verified
- last completed checkpoint: focused lane, authenticated toolchain integration, and complete serial suite passed after the P1 fix
- next action: push the review fix, reply with evidence, resolve the thread, and rerun CI
- blocker: none
- approval state: edits, tests, commit, push, PR, and clean merge explicitly approved

## Checkpoints

- [x] preflight / doctor
- [x] context loaded
- [x] implementation or execution
- [x] verification
- [x] proof bundle
- [x] ledger/state update
- [ ] handoff or next prompt

## Evidence

| Time | Action | Evidence | Result |
| --- | --- | --- | --- |
| 2026-07-29 | authenticated base | `origin/v2.4.x` and `git ls-remote` both resolved to `3295c8b88eafebd97bd362938fef997329dc3ca1` | pass |
| 2026-07-29 | Crate Doctor | 0 failures; warnings describe the intentionally dirty root and existing workspace hygiene | pass with classified warnings |
| 2026-07-29 | focused release checks | release policy, ASAR compatibility, metadata finalization, dependency compatibility, and authenticated toolchain | 69 passed, 0 failed |
| 2026-07-29 | complete serial suite | `node --test --test-concurrency=1 tests/*.test.js` under the authenticated tool environment and canonical macOS user temp root | 440 passed, 0 failed |
| 2026-07-29 | dependency gates | full audit, production audit, and install-script policy | 0 vulnerabilities; 6 approved lifecycle packages |
| 2026-07-29 | review stack | Autoreview, regression detector, security scan, provenance review, diff, syntax, ASCII, and whitespace checks | approve; no findings |
| 2026-07-29 | valid P1 review fix | authenticated pre-sign size, aggregate hash, block size, and every block hash now flow through the exact native proof | stale or corrupt ASAR pre-sign metadata fails closed |
| 2026-07-29 | P1 focused checks | release policy, ASAR compatibility, metadata finalization, npm bridge, and toolchain integration | 75 passed, 0 failed, 1 intentional CI-only skip; live integration 1 passed |
| 2026-07-29 | P1 complete serial suite | `node --test --test-concurrency=1 tests/*.test.js` under the canonical macOS user temp root | 440 passed, 0 failed, 1 intentional CI-only skip |
| 2026-07-29 | P1 dependency gates | full audit, production audit, and install-script policy | 0 vulnerabilities; 6 approved lifecycle packages |

Shared stale daily-ledger and current-workstream files were intentionally left untouched to preserve the separately scoped durable-state reconciliation lane. This taskflow is the scoped state record.

## Proof

- exact authenticated dependency paths and their pre-sign size/hash/block evidence are emitted only after the complete inventory, archive, recheck, source-binding, and clean-checkout gates pass
- raw ASAR size, hash, and block checks remain mandatory for packed and unpacked non-native files
- a raw mismatch is exempt only for an unpacked exact path whose ASAR metadata exactly matches authenticated pre-sign size/hash/block evidence and whose current bytes carry a Mach-O magic header
- malformed metadata, malformed integrity schema, stale pre-sign metadata, corrupt size/hash/block evidence, partial proof, wrong-path proof, missing proof, and extension-only non-Mach-O mutation fail closed
- app-builder-lib's resolved ASAR implementation verifies transformed `package.json` and zero-byte compatibility
- no runtime, UI, parser, watcher, package, provenance, Figma, quota, version, site, release artifact, or user-data surface changed

## Risks

- The exemption must remain bound to an exact unpacked path, authenticated pre-sign ASAR integrity evidence, and authenticated normalized native bytes.
- Packed files and unpacked non-native files must retain raw size, hash, and block verification.

## Handoff

Next exact action:

```text
Push the P1 review fix to PR #165, resolve the valid thread only with evidence, then require clean review and CI before the preauthorized merge.
```
