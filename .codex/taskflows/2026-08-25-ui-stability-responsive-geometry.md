# Taskflow: UI Stability Responsive Geometry

## Metadata

- created: 2026-08-25
- updated: 2026-08-25
- owner: ChatGPT GitHub implementation lane
- standing order: SO-002 Autonomous Crate Failure Loop
- repo: `bfeintuch123/crate-app`
- branch: `codex/ui-stability-responsive-geometry-v2`
- canonical base: `fa4d3d22378f11e4bcd80c55402194bda77da398`
- mode: scoped implementation, draft PR only
- status: active

## Goal

Make the existing Crate macOS UI adapt cleanly from its normal desktop size down to a tested minimum size. Begin with Project Workspace and Review Assets: eliminate application-level horizontal overflow, clipped or overlapping controls, and translucent surface bleed without redesigning the product or changing package, watcher, Figma, provenance, quota, privacy, release, or dependency behavior.

## Scope

Allowed:

- responsive layout and paint containment in the renderer
- the smallest load-hook change needed for an isolated responsive stylesheet
- focused source-level responsive contract tests
- an evidence-based minimum window size only after exact-head Mac geometry proof
- UI-stability documentation, proof, state, and handoff records
- small atomic commits pushed immediately

Forbidden:

- package selection or output changes
- watcher admission or observer changes
- parser or provenance changes
- Figma scope or network changes
- quota, billing, release, signing, notarization, deploy, or version changes
- dependency or lockfile mutation
- renderer framework migration
- global scaling, CSS `zoom`, or hiding inaccessible content as the primary fix
- merge without Bryant's explicit approval

## State

- current phase: responsive geometry implementation
- canonical handoff: PR #227 merge `436c718e8d7c625673ed6bc255a9f718c58dd9b1`; PR #226 and canonical merge `fa4d3d22378f11e4bcd80c55402194bda77da398`
- active implementation branch: `codex/ui-stability-responsive-geometry-v2`
- superseded exploratory branch: `codex/ui-stability-responsive-geometry`
- next action: add the isolated responsive stylesheet and load it after the established renderer stylesheet
- blocker: none
- merge approval: not granted

## Checkpoints

- [x] Chief handoff and canonical base confirmed
- [x] one-builder ownership confirmed
- [x] clean implementation branch created from the canonical SHA
- [ ] responsive stylesheet and load hook
- [ ] focused contract tests
- [ ] CI
- [ ] exact-head Mac geometry and visual proof
- [ ] independent review
- [ ] proof bundle and vault-ready report

## Required Recovery Discipline

For each completed unit:

```text
implement one contained change
→ run or prepare its focused checks
→ commit
→ push immediately
→ verify the remote branch head
→ continue
```

## Risks

- Current base CSS contains fixed `640px`, `680px`, and `800px` minimum-width behavior; the responsive layer must neutralize those rules without merely clipping inaccessible content.
- Static source checks cannot substitute for authentic Electron geometry and resize evidence.
- Large-asset DOM reconciliation and preview scheduling are intentionally deferred to the separate smoothness phase.

## Next Handoff

After focused CI passes, return the exact PR head and a Mac QA prompt for synthetic 263-asset resize evidence. Do not begin the large-asset smoothness phase until Bryant approves the visible responsive result.
