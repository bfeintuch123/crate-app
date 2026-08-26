# Taskflow: App-Wide UX Consistency and Accessibility Polish

## Metadata

- created: 2026-08-26
- updated: 2026-08-26
- owner: ChatGPT GitHub implementation lane
- standing order: SO-008 read-only design/product audit, followed by SO-002 scoped fix-and-PR work only for confirmed findings
- repo: `bfeintuch123/crate-app`
- branch: `codex/ui-consistency-accessibility-polish`
- base: `v2.4.x@de935e307c61674af5a684ceab4895aa650a467b`
- Phase A authority: merged PR #231
- Phase B authority: merged PR #232
- mode: audit-first; draft PR; no merge authority
- status: active

## Goal

Apply one coherent, accessible interaction language across Crate now that Phase A stabilized desktop geometry and Phase B stabilized renderer updates, previews, and core action feedback. Phase C is a focused consistency and accessibility pass, not a redesign.

## Scope

Allowed:

- inspect Projects, Project Workspace, Quick Package, Settings, Help, Existing Assets, Package Review, package progress/completion, Figma states, and quota/upgrade states;
- audit focus placement and restoration, keyboard order, visible focus, dialog semantics, live-status semantics, busy/disabled states, empty/loading/error/success presentation, stable dimensions, reduced motion, and residual layout shifts;
- add focused synthetic tests and documentation;
- change `renderer/app.js`, `renderer/index.html`, and `renderer/styles.css` only for confirmed residual Phase C findings;
- use small atomic commits and push each completed commit immediately;
- open and maintain one draft PR against `v2.4.x`.

Forbidden:

- deferred navigation order change (`Projects → Project Workspace → Quick Package`);
- route or selected-project behavior changes;
- design-system or layout redesign;
- weakening Phase A's `1100 × 760` desktop minimum or responsive containment;
- weakening Phase B's keyed reconciliation, preview scheduling, event coalescing, or action feedback;
- package, quota, watcher, parser, provenance, Figma semantic, persistence, privacy, credential, dependency, lockfile, version, build, signing, notarization, release, website, or deployment changes;
- Beta 2.15 work;
- merge without Bryant's explicit approval.

## State

- current phase: C0 read-only app-wide audit
- last completed checkpoint: canonical Phase B merge verified at `de935e307c61674af5a684ceab4895aa650a467b`; fresh Phase C branch created
- next action: inspect current renderer and focused tests, record confirmed residual consistency/accessibility findings, and define the smallest implementation sequence
- blocker: none
- approval state: Bryant authorized branch, draft PR, audit, and later scoped Phase C implementation; merge not authorized
- preferences applied: small atomic commits, immediate pushes, remote verification after every commit, one builder, no navigation reorder
- routing decision: `crate-router` principles with SO-008 audit and SO-002 narrow implementation; Crate Fix Review Stack before merge readiness
- workflow eval suite/result: pending
- outcome receipt: pending

## Checkpoints

- [x] canonical branch and Phase B merge verified
- [x] no overlapping open UI implementation PR found
- [x] fresh Phase C branch created
- [x] taskflow created and pushed
- [ ] draft PR opened
- [ ] C0 read-only app-wide audit complete
- [ ] confirmed findings and non-goals documented
- [ ] C1 focus, keyboard, and dialog consistency implemented
- [ ] C2 status, feedback, state-presentation, and motion consistency implemented
- [ ] focused tests and Phase A/B regressions pass
- [ ] complete source CI, security review, and Autoreview pass
- [ ] exact-head visual proof for visible changes complete or documented exception approved
- [ ] Bryant approval
- [ ] merge and Vault handoff
- [ ] separate navigation-order PR begins only after Phase C closes

## Evidence

| Time | Action | Evidence | Result |
| --- | --- | --- | --- |
| 2026-08-26 | Resolve canonical Phase B merge | `v2.4.x@de935e307c61674af5a684ceab4895aa650a467b` | PASS |
| 2026-08-26 | Inspect open PR ownership | Only historical documentation PR #156 open; no overlapping UI builder | PASS |
| 2026-08-26 | Create Phase C branch | `codex/ui-consistency-accessibility-polish` from exact canonical SHA | PASS |

## Audit Questions

1. Does every modal establish an accessible dialog name, move focus inside on open, trap focus while open, and restore focus to the correct opener on close?
2. Do meaningful async actions expose consistent immediate acknowledgement, `aria-busy`, disabled state, stable dimensions, error recovery, and duplicate-action suppression?
3. Are status, error, success, empty, progress, and blocked states announced through appropriate `role`, `aria-live`, or `aria-atomic` semantics without duplicate announcements?
4. Are keyboard navigation order, focus indicators, and reachable controls consistent across every supported desktop surface?
5. Do empty/loading/error messages reserve stable space only where useful, without trapping focus on empty content or causing avoidable layout shifts?
6. Does reduced-motion behavior cover remaining nonessential animations and transitions without suppressing essential feedback?
7. Are there any remaining Phase B state-preservation or focus-restoration edges when keyed rows legitimately change or disappear?

## Risks

- subjective scope expansion into redesign;
- duplicate or noisy announcements;
- focus traps or opener restoration regressions;
- changing established error or package semantics;
- unnecessary animation added in the name of polish;
- invalidating Phase A geometry or Phase B deterministic behavior;
- accidentally implementing the deferred navigation order in this PR.

## Handoff

Next exact action:

```text
Complete the read-only source and test audit on the exact Phase C branch head. Record only confirmed residual consistency/accessibility findings, open the draft PR early, and do not change production renderer files until the audit defines a narrow implementation sequence.
```
