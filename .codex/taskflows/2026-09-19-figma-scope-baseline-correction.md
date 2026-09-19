# Taskflow: Figma Scope and Initial Asset Baseline Correction

## Metadata

- created: 2026-09-19
- updated: 2026-09-19
- owner: dedicated Crate implementation writer
- native Codex task: `01a0ba98-fede-7c91-85ab-caf5da7d880a`
- host: `local`
- standing order: SO-002 Autonomous Crate Failure Loop
- repo: bfeintuch123/crate-app
- branch: codex/figma-scope-baseline-correction-20260919
- base: e390d3bce48d83abf8955fc131a74038a27fa06a
- draft PR: https://github.com/bfeintuch123/crate-app/pull/264
- mode: focused source correction, targeted regression checks, protected exact-head CI, independent Luna/high review
- status: active

## Goal

Correct the Beta 2.22 Figma Current Page Only preflight for page and nested-layer links using the documented filtered file response, and classify assets from the initial successful Figma snapshot as Existing while preserving later additions as Added while working.

## Scope

Allowed:

- Narrow Figma preflight and asset-origin changes in `parsers/figma.js` and `main.js`.
- Focused synthetic regressions for filtered Figma responses, failed-node rejection, initial snapshots, retries, deduplication, and project isolation.
- Repository-required playbooks, exact-head review/correction, focused checks, commit, branch push, draft PR, and sanitized taskflow/proof notes.

Forbidden:

- Owner Figma token, app secrets, cookies, private config, live API responses, original project/data, installed app, prepared release checkout, or Vault mutation.
- Full manual regression suite, unrelated cleanup/redesign, dependency or version changes, merge/ready transition, build/sign/notarize/tag/release/deploy/site publication, or Olivia delivery.
- Any scope fallback that silently expands Current Page Only to Entire File.

## State

- current phase: draft PR exact-head CI and review
- last completed checkpoint: source commit `b9317ae` pushed as draft PR #264 after focused Figma and full provenance validation
- next action: publish the sanitized daily proof entry, then bind the resulting final PR head for protected CI and two independent read-only reviews
- blocker: none
- approval state: Bryant authorized the two focused corrections, repository-required checks, exact-head corrections, commit, push, and draft PR; later release and merge gates remain unauthorized
- preferences applied: one repository writer; reviewers read-only; no private link or token in fixtures
- routing decision: SO-002 failure loop with Clawpatch, Deep Autoreview, regression, security, provenance, runner, PR, and handoff review
- outcome receipt: pending

## Checkpoints

- [x] preflight and exact canonical base
- [x] source and official Figma API contract review
- [x] implementation and realistic synthetic tests
- [x] targeted checks
- [ ] protected exact-head CI
- [ ] exact-head independent review/correction loop
- [ ] proof section and ledger/workstream update
- [x] source commit, push, and draft PR
- [ ] handoff at the authorized stop gate

## Evidence

| Time | Action | Evidence | Result |
| --- | --- | --- | --- |
| 2026-09-19 | Canonical source binding | `v2.4.x` remote head `e390d3bce48d83abf8955fc131a74038a27fa06a` | PASS |
| 2026-09-19 | Figma API contract | Official GET file docs describe `ids` as returning requested nodes, descendants, and ancestor chains; `depth=1` returns only pages | Root-cause direction confirmed |
| 2026-09-19 | Isolated writer checkout | Fresh clone at the exact base on `codex/figma-scope-baseline-correction-20260919` | Clean |
| 2026-09-19 | Focused Figma regressions | `figma-scope` 32 cases, `figma-link-per-project`, `figma-token-privacy` 9 cases, and `renderer-figma-scope` 251 cases | PASS |
| 2026-09-19 | Provenance checks | `provenance.test.js` 7 cases and `provenance-dual-write.test.js` 578 cases | PASS |
| 2026-09-19 | Syntax and hygiene | Pinned Node 22 syntax checks for changed JavaScript; `git diff --check`; private-link/token fixture search | PASS; search found no private URL or credential pattern |
| 2026-09-19 | Draft PR | PR #264 targets `v2.4.x`; source commit `b9317ae` | Draft; source security and regression workflow was running before final proof-state commit |

## Proof Notes

- The Current Page Only preflight now uses the documented `ids` response without truncating depth; missing selected nodes remain rejected.
- A project-scoped marker holds the Figma asset origin baseline open until the complete first scan and all asset ingestions succeed. Retries retain Existing origins, empty successful snapshots close the baseline, and later unseen assets are Added.
- Legacy Figma rows are not reclassified by migration; existing origin and exclusion decisions are preserved.
- `crate_doctor.py` was attempted in the isolated clone and could not run because its configured Projects root is absent in this environment. This is an environment limitation, not a product finding.

## Risks

- A scope-resolution failure must remain fail-closed for missing or inaccessible nodes.
- The Figma baseline must survive retries and resume without changing existing origin or exclusion decisions.
- Any new source head invalidates prior CI and review evidence.
- Exact-head visual evidence may remain unavailable because a build is outside this task's authorization.

## Handoff

Next exact action:

```text
Update the sanitized daily proof entry, then rerun exact-head protected CI and complete two distinct Luna/high read-only reviews against PR #264's final head. Apply no merge or ready transition.
```
