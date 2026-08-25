# Taskflow: UI Stability Responsive Geometry

## Metadata

- created: 2026-08-25
- updated: 2026-08-25
- owner: ChatGPT GitHub implementation lane
- standing order: SO-002 Autonomous Crate Failure Loop
- repo: `bfeintuch123/crate-app`
- branch: `codex/ui-stability-responsive-geometry`
- base: `fa4d3d22378f11e4bcd80c55402194bda77da398`
- mode: scoped implementation, draft PR only
- status: active

## Goal

Make the existing Crate macOS UI adapt cleanly from its normal desktop size down to a tested minimum window size, beginning with Project Workspace and Review Assets. Eliminate application-level horizontal overflow, clipped or overlapping controls, and translucent surface bleed without redesigning the product or changing package, watcher, Figma, provenance, quota, privacy, release, or dependency behavior.

## Scope

Allowed:

- inspect the exact canonical UI and window behavior inherited from PRs #226 and #227
- update responsive layout and containment in `renderer/styles.css`
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

- current phase: responsive geometry diagnosis and implementation
- last completed checkpoint: Chief handoff after PRs #226 and #227; implementation branch created at the canonical handoff SHA
- next action: confirm the exact overflow chain in current CSS and tests, then commit the smallest responsive containment fix
- blocker: none
- approval state: Bryant authorized the separate UI implementation lane; merge remains unapproved
- preferences applied: fresh canonical branch, small atomic commits, immediate push after every commit, one builder
- routing decision: Phase A responsive geometry first; large-asset renderer smoothness remains a separate follow-up branch unless evidence proves a narrow combined scope is safer
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
| 2026-08-25 | Verified canonical and feature branch | `origin/v2.4.x` and `codex/ui-stability-responsive-geometry` both at `fa4d3d22378f11e4bcd80c55402194bda77da398` | PASS |
| 2026-08-25 | Confirmed Chief handoff | PR #227 merge `436c718e8d7c625673ed6bc255a9f718c58dd9b1`; PR #226 merge `fa4d3d22378f11e4bcd80c55402194bda77da398`; no active source writer reported | PASS |

## Risks

- Static CSS assertions currently protect fixed minimum-width behavior and must be rewritten rather than preserved.
- The existing Electron minimum width may be smaller than the usable content contract; the final minimum must follow measured layout behavior rather than conceal a broken layout.
- Authentic macOS resizing and video evidence require a separate exact-head Mac QA gate after GitHub implementation.
- Large-list DOM reconciliation and preview scheduling are intentionally deferred to the separate smoothness phase unless responsive work exposes an inseparable blocker.

## Handoff

Next exact action:

```text
Inspect the exact current responsive selectors, Review Assets markup, and focused tests on codex/ui-stability-responsive-geometry. Implement the first narrow responsive-containment commit, run focused source validation, push immediately, and record the resulting SHA here.
```
