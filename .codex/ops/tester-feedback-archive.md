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

## Canonical Finding Schema

Canonical normalized findings use Crate Ops schema version `1.0`:

```text
crate-ops-plugin/schemas/crate-tester-feedback-record.schema.json
crate-ops-plugin/schemas/crate-tester-feedback-collection.schema.json
```

Use one JSON record per finding. Several findings from one session share a pseudonymous `source_id` and `session_id`, so one tester is counted as one independent source.

Generate IDs with Crate Ops `create_tester_feedback_ids.py`; never derive them from a tester name, email, portal ID, or portfolio. Store the source-to-tester mapping only in the approved private intake system, and reuse the same source ID for later sessions with that tester. Use the session-level `collected_on` date rather than the exact interview time. Every canonical record requires `privacy_review_owner` and `privacy_reviewed_on`, completed by Bryant, Jenna, or both before validation.

Canonical severity values are `critical`, `high`, `medium`, and `low`; map human intake `blocker` to `critical` and `polish` to `low`.

After human privacy review, validate records before archive or synthesis:

```sh
python3 /Users/bryantfeintuchclaw/plugins/crate-ops/scripts/validate_tester_feedback.py /path/to/tester-feedback.json
```

Names, emails, profiles, portfolios, demographics, recruiting notes, raw paths, URLs, screenshots, recordings, and private assets stay outside canonical JSON. A controlled product-use `tester_segment`, such as `graphic-design-power-user`, is allowed because it measures target workflow fit rather than personal identity. Operational tester context may remain in the approved private intake system when needed.

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

- schema-valid sanitized finding records
- pseudonymous source and session IDs
- Crate build version
- workflow and optional canonical feature ID
- theme, finding type, severity, reproducibility, status, and next route
- opaque evidence IDs for separately governed approved evidence
