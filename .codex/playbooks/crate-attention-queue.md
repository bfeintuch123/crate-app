# Crate Chief-Of-Staff Attention Queue Playbook

## Purpose

Maintain one privacy-safe, freshness-aware control index for work that deserves Bryant and Jenna's attention while the current user-visible Codex task remains chief of staff and source of truth.

The queue does not replace taskflows, canonical tester records, GitHub, decisions, proof bundles, mailboxes, calendars, or tester portals. It grants no authority.

## When To Use

- Bryant asks what needs attention or asks Codex to coordinate everything.
- A material tester, QA, PR, design, support, vendor, meeting, or business event changes priorities.
- Delegated work returns for integration.
- A queue source is stale, partial, unavailable, or conflicting.

## Standing Order

Use `SO-011 Chief-Of-Staff Attention Management`.

## Workflow

1. Confirm this user-visible task is the queue owner.
2. Declare the exact bounded source refresh scope, expected source inventory, and deterministic inventory revision.
3. Read only approved source scopes, retain failures with bounded categories, and sanitize every signal.
4. On the first snapshot, declare `initial`. On every later snapshot, supply the previous validated snapshot and reconcile identities, additions, updates, resolutions, and unchanged items.
5. Preserve one opaque item ID and dedupe key for each continuing matter.
6. Route every item to exactly one owner whose standing order matches the loop catalog.
7. Record an action class, authority source, approval state, next checkpoint, and any in-progress work reference.
8. Use `crate-thread-chief` only for bounded delegation.
9. Integrate returned evidence into the authoritative source before removing completed work.
10. Report partial refreshes, stale sources, approvals needed, and the next refresh trigger.

## Four Buckets

- `needs-bryant-jenna`: consequential work awaiting an accountable approval.
- `ready-for-chief`: fresh work already covered by an exact current authority.
- `in-progress`: fresh work with one owner, one opaque work reference, and one checkpoint.
- `waiting`: blocked, reconciliation, external event, QA, dependency, or source refresh.

## Privacy

Never store raw messages, identities, addresses, tester mappings, links, paths, filenames, screenshots, recordings, diagnostics, Figma identifiers, credentials, signed URLs, or private assets. Live snapshots stay in approved private report directories with owner-only permissions and never enter Git.

## Approval Gates

Queue placement never authorizes work. Stop before any unapproved product decision, code or remote mutation, external communication, scheduling, money, legal commitment, merge, release, deploy, dependency change, credential use, or private-data access.

Merge, release, deploy, money, legal, and credential/private-data actions require Bryant or Bryant-and-Jenna approval. A current prompt, approved taskflow, or decision record must have an opaque authority reference.

## Verification

- validate the closed queue schema and privacy-safe text
- reject duplicate JSON keys, unknown fields, symlinks, unsafe paths, and output collisions
- verify route owner, standing order, and action class pairing
- bind approved authority to a fresh expected prompt, taskflow, or decision source digest and approval actor
- require distinct Bryant and Jenna sources for joint approval
- verify expected source inventory, current-date freshness, and full revision digests
- require accountable privacy review and pseudonymous sensitive-source wording
- reconcile against the previous snapshot after initialization
- require changed source revisions for updated or resolved work
- show partial refreshes and stale sources
- preserve atomic owner-only outputs

## Closeout

Report source coverage, queue counts, reconciled changes, routes and owners, delegated work, evidence integrated, approvals still needed, and the next refresh trigger.
