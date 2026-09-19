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
- mode: one Bryant-authorized additional source correction cycle, targeted regression checks, protected exact-head CI, two independent Astra/high reviews
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

- current phase: final writer correction prepared; bind and review the next PR head
- last completed checkpoint: fresh Astra/high reviewers on `faa036d4a00bfb589a6bd12f7491804fac710dc0` found that a scan could finish during replacement preflight before the commit-time revision fence. The current working-tree correction keeps per-project scans and pre-package recovery fenced for the full preflight, then resumes watching scans after all overlapping updates settle. Current-code `figma-link-per-project` passes 96/96 and combined `provenance.test.js` plus `provenance-dual-write.test.js` passes 585/585.
- next action: recheck syntax and whitespace after the final race-test edit, make one normal correction commit with sanitized proof-state updates, push the authorized update to PR #264, bind its exact head, then run protected CI and two fresh distinct read-only Astra/high reviews. Keep the PR draft. If this one additional correction cycle receives another actionable finding, stop and escalate to Bryant.
- blocker: none
- approval state: Bryant authorized exactly one additional writer correction cycle, repository-required checks, final-head CI and two reviews, commit, push, factual PR-description update, and draft status; later release, ready-for-review, and merge gates remain unauthorized
- preferences applied: one repository writer; reviewers read-only; no private link or token in fixtures
- routing decision: SO-002 failure loop with Clawpatch, Deep Autoreview, regression, security, provenance, runner, PR, and handoff review
- outcome receipt: pending

## Checkpoints

- [x] preflight and exact canonical base
- [x] source and official Figma API contract review
- [x] implementation and realistic synthetic tests
- [x] current-code `figma-link-per-project` (96/96) and provenance helper/dual-write checks (585/585 combined)
- [ ] protected exact-head CI for the final PR head
- [ ] exact-head independent review/correction loop for the final PR head
- [x] proof section and ledger/workstream update
- [ ] latest corrective source and proof-state commits pushed to the existing draft PR
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
| 2026-09-19 | Initial exact-head review loop | PR head `22294d39e3d61dbe5ad164b9e81c4997ebf83cda`; protected source workflow passed; two distinct Luna/high reviewers requested changes | Corrected a scope-change race, incomplete pre-package ingestion block handling, and package-path baseline coverage; new head still required |
| 2026-09-19 | Corrective local validation | `figma-link-per-project` 91 cases; Figma scope/privacy/renderer 292 cases; provenance helpers 7 cases; provenance dual-write 578 cases; syntax and whitespace checks | PASS; exact-head protected CI and fresh reviews remain pending after push |
| 2026-09-19 | Second exact-head review loop | PR head `af8982825be2ae126b1213198fdb1e0e13cd57b0`; two fresh Luna/high reviewers found a delayed preflight request-order race; its in-flight CI was canceled after correction | Added request-order fencing and replace/remove plus replace/replace regressions |
| 2026-09-19 | Corrective local validation | `figma-link-per-project` 93/93; syntax and whitespace checks | PASS; full exact-head protected CI and two fresh reviews remain pending after push |
| 2026-09-19 | Corrective source commits | `7ee2e71`, `7881740` | Local commits; proof-state update remains to be committed before pushing the new draft PR head |
| 2026-09-19 | Third exact-head review loop | PR head `faa036d4a00bfb589a6bd12f7491804fac710dc0`; two fresh Luna/high reviewers found a poll could begin during replacement preflight and survive the successful link commit; stale CI run `35460465743` was canceled | Added commit-time scope revision advance and a delayed-scan regression |
| 2026-09-19 | Latest corrective local validation | `figma-link-per-project` 94/94; pinned Node 22 syntax checks and `git diff --check` | PASS; source commit `a1f1f39` is local; final-head CI and two fresh reviews remain pending |
| 2026-09-19 | Additional correction cycle | A fresh review found scans could complete before replacement commit during preflight; added a project-scoped pending-update fence for watcher scans and pre-package recovery, plus post-preflight watcher resume and three retry/race regressions | Current-code `figma-link-per-project` 96/96 and combined provenance helpers/dual-write 585/585; commit, push, exact-head CI, and two Astra/high reviews pending |

## Proof Notes

- The Current Page Only preflight now uses the documented `ids` response without truncating depth; missing selected nodes remain rejected.
- A project-scoped marker holds the Figma asset origin baseline open until the complete first scan and all asset ingestions succeed. Retries retain Existing origins, empty successful snapshots close the baseline, and later unseen assets are Added.
- Legacy Figma rows are not reclassified by migration; existing origin and exclusion decisions are preserved.
- A link replacement advances the per-project scope revision both when the request begins and when its preflight successfully commits, fencing polls that started during preflight from ingesting the previous link's snapshot.
- Every pending link preflight now fences per-project watcher scans before parser invocation and again after token retrieval; pre-package recovery fails closed while the preflight is pending. A successful watching-project link update resumes its initial scan after all overlapping updates settle, while a failed preflight leaves the existing link available for a later retry.
- `crate_doctor.py` was attempted in the isolated clone and could not run because its configured Projects root is absent in this environment. This is an environment limitation, not a product finding.

## Risks

- A scope-resolution failure must remain fail-closed for missing or inaccessible nodes.
- The Figma baseline must survive retries and resume without changing existing origin or exclusion decisions.
- Any new source head invalidates prior CI and review evidence.
- Exact-head visual evidence may remain unavailable because a build is outside this task's authorization.

## Handoff

Next exact action:

```text
Complete current-code affected checks, commit this single authorized writer correction cycle with the sanitized proof-state update, push to PR #264, and bind its exact new head. Run protected CI and two fresh, distinct Astra/high read-only reviews against that exact head; update the PR description to match completed evidence, keep it draft, and stop before ready-for-review or merge. If the final review reports another actionable finding, stop and escalate rather than starting another correction cycle.
```
