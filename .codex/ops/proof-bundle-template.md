# Crate Proof Bundle Template

## Purpose

A proof bundle is the closeout artifact for meaningful Crate work. It makes loop output auditable and gives the nightly vault automation clean evidence to ingest.

## When Required

Create a proof bundle or proof section for:

- autonomous failure loops
- PR merge-readiness reviews
- internal QA prereleases
- public/beta release prep
- Cloudflare deploys
- installed-app QA results
- tester feedback batches
- security/provenance reviews
- major design implementation passes

## Template

```markdown
# Proof Bundle: <name>

## Summary

- result:
- date:
- owner:
- standing order:
- taskflow:
- repo:
- branch:
- commit:
- PR:
- release/tag:
- artifact/version:

## Scope

Allowed:

- ...

Forbidden and not done:

- ...

## Evidence

| Check | Evidence | Result |
| --- | --- | --- |
| repo/branch | | |
| files changed | | |
| tests/checks | | |
| privacy | | |
| security | | |
| provenance/package scope | | |
| release/deploy/artifact | | |

## Commands Run

```sh
...
```

## Files Changed

- ...

## Risks

- ...

## Follow-Ups

- ...

## Next Action

```text
...
```
```

## Storage

For committed docs, use concise proof sections in:

- `.codex/state/daily-crate-ledger.md`
- `.codex/state/current-workstream.md`
- `docs/crate/daily/`
- release or QA docs under `docs/crate/`

For temporary local proof, use:

```text
.codex/proof-bundles/<date>-<short-name>.md
```

Do not commit temporary proof bundles unless Bryant explicitly approves.

## Privacy Rules

Allowed:

- public GitHub URLs
- public release URLs
- branch names
- commit hashes
- command names
- test names
- approved QA fixture names
- sanitized package output paths

Forbidden:

- secrets
- tokens
- raw Keychain output
- raw private file lists
- broad logs
- full Figma URLs or file keys
- signed URLs
- unrelated private/client paths
