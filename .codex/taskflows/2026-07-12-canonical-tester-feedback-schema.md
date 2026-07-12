# Taskflow: Canonical Tester Feedback JSON

## Metadata

- created: 2026-07-12
- owner: Bryant / Codex chief thread
- standing order: SO-008 Design And Product Learning Review
- repos: crate-app and crate-ops-plugin
- branches: `codex/tester-feedback-schema-catalog`, `codex/canonical-tester-feedback-schema`
- bases: `origin/v2.4.x`, Crate Ops `origin/main`
- mode: fix-and-PR
- status: validated; PR preparation

## Goal

Create canonical, versioned, privacy-safe tester-feedback JSON before Olivia's first testing session, with one finding per record and stable pseudonymous source/session IDs.

## Boundaries

- No tester contact, raw artifact inspection, app runtime, website, analytics, dependency, release, deploy, or credential mutation.
- Identity, demographics, recruiting context, paths, URLs, screenshots, recordings, and private assets are excluded from canonical records.
- Real tester evidence may propose backward-compatible schema version 1.1; it cannot silently widen version 1.0.

## State

- current phase: final review and separate PR preparation
- last completed checkpoint: canonical schema, privacy controls, independent JSON Schema compile, adversarial validation, and loop ownership passed
- next action: open plugin PR first, then dependent app catalog PR; run merge-readiness and stop before merge
- blocker: none
- approval state: Bryant approved canonical schema work; new PR merges require separate approval

## Checkpoints

- [x] schema owner and record unit selected
- [x] implementation
- [x] synthetic and adversarial validation
- [x] independent review
- [ ] separate PRs and merge-readiness

## Merge Order

1. Crate Ops plugin schema, ID generator, validator, and synthesis guard.
2. Crate app docs, standing order, router, and loop catalog that reference those plugin capabilities.

The app catalog PR must not merge before the plugin PR is available.

## Validation Evidence

- full Crate Ops test suite: 47 passed
- Crate Ops validator: passed
- official plugin validator: passed
- canonical synthetic collection: passed custom validation
- Ajv Draft 2020-12 compile, example, and unsafe-text probes: passed
- Crate Doctor: zero failures; environment warnings only
- app loop catalog JSON and both diffs: passed
- two independent adversarial reviews were run; findings were addressed before PR preparation

## Stop Condition

Stop before merging PRs, ingesting real tester data, contacting Olivia, changing app behavior, or enabling analytics without separate approval.
