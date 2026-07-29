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
- status: ready-for-review

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

- current phase: PR creation
- last completed checkpoint: final focused lane passed 69/69 and complete serial suite passed 440/440
- next action: commit, push, open the PR, inspect reviews and CI, then merge only if clean
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

Shared stale daily-ledger and current-workstream files were intentionally left untouched to preserve the separately scoped durable-state reconciliation lane. This taskflow is the scoped state record.

## Proof

- exact authenticated dependency paths are emitted only after the complete inventory, archive, recheck, source-binding, and clean-checkout gates pass
- raw ASAR size, hash, and block checks remain mandatory for packed and unpacked non-native files
- a raw mismatch is exempt only for an unpacked exact path in that proof set whose actual bytes carry a Mach-O magic header
- malformed metadata, malformed integrity schema, partial proof, wrong-path proof, missing proof, and extension-only non-Mach-O mutation fail closed
- app-builder-lib's resolved ASAR implementation verifies transformed `package.json` and zero-byte compatibility
- no runtime, UI, parser, watcher, package, provenance, Figma, quota, version, site, release artifact, or user-data surface changed

## Risks

- The exemption must remain bound to an exact unpacked path and authenticated normalized native bytes.
- Packed files and unpacked non-native files must retain raw size, hash, and block verification.

## Handoff

Next exact action:

```text
Commit and push the reviewed branch, open the PR against v2.4.x, then require clean review and CI before the preauthorized merge.
```
