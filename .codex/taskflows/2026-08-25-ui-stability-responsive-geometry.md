# Taskflow: UI Stability Responsive Geometry

## Metadata

- created: 2026-08-25
- updated: 2026-08-25
- owner: ChatGPT GitHub implementation lane
- standing order: SO-002 Autonomous Crate Failure Loop
- repo: `bfeintuch123/crate-app`
- branch: `codex/ui-stability-responsive-geometry-clean`
- base: `fa4d3d22378f11e4bcd80c55402194bda77da398`
- mode: scoped implementation, draft PR only
- status: active

## Goal

Make the existing Crate macOS UI adapt cleanly from its normal desktop size down to a tested minimum window size, beginning with Project Workspace and Review Assets. Eliminate application-level horizontal overflow, clipped or overlapping controls, and translucent surface bleed without redesigning the product or changing package, watcher, Figma, provenance, quota, privacy, release, or dependency behavior.

## Scope

Allowed:

- inspect the exact canonical UI and window behavior inherited from PRs #226 and #227
- update responsive layout and containment in renderer styles
- make the smallest semantic markup changes required in `renderer/index.html`
- update `main.js` only for an evidence-based minimum window size
- rewrite focused renderer and window-lifecycle tests that currently encode broken width constraints
- add dependency-free, synthetic UI geometry checks and documentation
- use small atomic commits and push every completed commit immediately
- open a draft PR against `v2.4.x`

Forbidden:

- package selection or output changes
- watcher admission or observer changes
- parser or provenance changes
- Figma scope or network changes
- quota, billing, release, signing, notarization, deploy, or version changes
- dependency or lockfile mutation
- renderer framework migration
- global CSS scaling, `zoom`, or hiding inaccessible overflow as the primary fix
- merge without Bryant's explicit approval

## State

- current phase: responsive geometry implementation
- last completed checkpoint: Chief handoff after PRs #226 and #227; clean implementation branch created at the canonical handoff SHA
- next action: add one isolated responsive stylesheet layer and focused contract tests
- blocker: authentic macOS geometry and visual evidence remain a separate exact-head Mac gate
- approval state: Bryant authorized the separate UI implementation lane; merge remains unapproved
- preferences applied: fresh canonical branch, small atomic commits, immediate push after every commit, one builder
- routing decision: Phase A responsive geometry first; large-asset renderer smoothness remains a separate follow-up branch
- workflow eval suite/result: pending
- outcome receipt: pending

## Checkpoints

- [x] preflight / canonical handoff confirmed
- [x] context loaded
- [ ] responsive geometry implementation
- [ ] focused verification
- [ ] live Mac visual proof at exact PR head
- [ ] proof bundle
- [ ] ledger/state update
- [ ] handoff or next prompt

## Evidence

| Time | Action | Evidence | Result |
| --- | --- | --- | --- |
| 2026-08-25 | Verified canonical base | `origin/v2.4.x = fa4d3d22378f11e4bcd80c55402194bda77da398` | PASS |
| 2026-08-25 | Confirmed Chief handoff | PR #227 merge `436c718e8d7c625673ed6bc255a9f718c58dd9b1`; PR #226 merge `fa4d3d22378f11e4bcd80c55402194bda77da398`; no active source writer reported | PASS |
| 2026-08-25 | Replaced noisy initial branch | clean branch `codex/ui-stability-responsive-geometry-clean` created directly from the canonical handoff SHA | PASS |

## Risks

- Static CSS assertions currently protect fixed minimum-width behavior and must be replaced or supplemented with the correct responsive contract.
- The existing Electron minimum width may be smaller than the usable content contract; the final minimum must follow Mac geometry evidence rather than conceal a broken layout.
- Authentic macOS resizing and video evidence require a separate exact-head Mac QA gate after GitHub implementation.
- Large-list DOM reconciliation and preview scheduling are intentionally deferred to the separate smoothness phase.

## Handoff

Next exact action:

```text
Add the isolated responsive stylesheet layer on codex/ui-stability-responsive-geometry-clean, add one focused source contract test, push each atomic commit immediately, then open a replacement draft PR and mark #228 superseded.
```
