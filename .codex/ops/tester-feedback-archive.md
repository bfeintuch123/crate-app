# Crate Tester Feedback Archive

## Purpose

External tester feedback should become structured, privacy-safe Crate evidence. The tester portal, support mailbox, and Jenna QA reports are inputs. The local archive is the source of truth for triage.

## Archive Location

Default committed summaries:

```text
docs/crate/tester-feedback/
```

Temporary/private raw artifacts:

```text
.codex/private/tester-feedback/
```

Do not commit raw screenshots, recordings, diagnostics, private package outputs, or private tester assets unless Bryant explicitly approves a sanitized artifact.

## Triage Schema

```markdown
# Tester Feedback: <short title>

## Metadata

- id:
- date received:
- source: tester portal | support mailbox | Jenna QA | Bryant note
- app version:
- macOS version:
- tester persona:
- workflow:
- severity: blocker | high | medium | low | polish
- classification: UX | onboarding | packaging | permissions | Figma | quota | support | billing | docs | unknown

## Report

- expected:
- actual:
- steps:
- files/apps involved:
- package output present:
- screenshots/video present:
- diagnostics present:
- privacy review:

## Evidence

- approved artifacts:
- redacted artifacts:
- unavailable evidence:

## Decision

- likely app bug:
- likely setup issue:
- likely product/design issue:
- route:
- owner:
- next playbook:

## Follow-Up Prompt

```text
...
```
```

## Routing

- `blocker` or `high` likely app bug -> Autonomous Crate Failure Loop.
- UX/design issue -> Jenna design backlog and Crate decision log if a product decision is needed.
- Support/onboarding issue -> support response draft and docs/site backlog.
- Figma issue -> Figma guidance, Figma scope playbooks, and privacy gate.
- Quota/payment issue -> product decision log before implementation.

## Privacy Rules

Do not store:

- tester private project files
- raw package outputs
- unredacted screenshots containing client data
- Figma tokens, URLs, file keys, or signed URLs
- email headers with unrelated private data
- billing/payment details

Store:

- sanitized summaries
- app version
- workflow attempted
- approved fixture names
- observed UI copy
- package file counts
- pass/fail classifications
