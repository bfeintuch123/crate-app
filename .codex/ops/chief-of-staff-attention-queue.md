# Chief-Of-Staff Attention Queue

## Purpose

The current user-visible Codex task is Bryant and Jenna's chief of staff and the source of truth for prioritization, delegation, integration, and final reporting. The attention queue is its privacy-safe control index.

The queue is not another chief of staff, app, backlog, authority layer, or durable evidence store.

## Control Hierarchy

1. Bryant and Jenna provide intent and consequential approvals.
2. The source-of-truth Codex task gathers approved signals and owns the active attention queue.
3. `crate-router` selects the standing order, playbook, and loop.
4. `crate-thread-chief` creates or supervises bounded agents and visible tasks.
5. Existing loop owners execute and verify work.
6. The source-of-truth task integrates results and updates the authoritative record.

Side agents and tasks never become sources of truth.

## Four Buckets

- **Needs Bryant/Jenna:** product, brand, pricing, legal, spending, tester selection/payment, public communication, merge, release, deploy, credential, or unresolved tradeoff decisions.
- **Ready For Chief:** work already authorized by the current prompt, a standing order, an approved taskflow, or a decision record.
- **In Progress:** work with one route owner, bounded scope, and a concrete checkpoint.
- **Waiting:** external response, scheduled event, tester session, QA result, dependency, approval, or source refresh.

Queue placement never grants authority.

Every item declares an action class, exact route owner, matching standing order, approval state, and privacy-safe next checkpoint. Every in-progress item has one opaque work reference. Consequential work requires its existing approval scope. Code mutation, external communication, merge, release, deploy, money, legal, and credential/private-data actions require Bryant or Bryant-and-Jenna approval. SO-014 product decisions and remote mutations also require Bryant; calendar mutation retains its separate Bryant-or-Jenna policy.

Approved authority must bind to a fresh expected prompt, taskflow, or decision source snapshot that records the approval actor. The authority revision equals that source digest, and current-prompt authority expires with the active queue date. Anonymous taskflow or decision records cannot authorize work.

Joint Bryant-and-Jenna approval requires two distinct authority sources and revisions. Current-prompt joint approval requires one fresh Bryant source and one fresh Jenna source.

## Authoritative Sources

The queue references but does not replace:

- taskflows for execution state
- canonical tester-feedback JSON for tester findings
- GitHub for issues, PRs, checks, and merge state
- decision records for approved product choices
- proof bundles for completed validation
- current mailbox, calendar, tester portal, Figma, QA, or vendor state when checked through an approved bounded connector/tool scope
- Bryant or Jenna's current instruction for manual direction

Every item has one authoritative source and an opaque deduplication key. Related signals attach to that item. Conflicting signals become `needs-reconciliation`; no source silently overwrites another.

## Refresh Rules

Refresh the queue when:

- Bryant asks for status or priorities
- a meaningful email, tester, QA, PR, release, design, vendor, or meeting event occurs
- delegated work returns
- a new consequential decision is requested
- the current queue depends on stale or unavailable sources

Every refresh declares its scope and per-source success, failure, skip, authorization, coverage, and freshness. A partial refresh must be labeled partial. Remembered state is never presented as current evidence.

Every refresh declares its expected source inventory. Omitted sources are invalid; unsuccessful sources remain visible with a bounded category and no raw error content. Fresh actionable sources must be observed and verified on the active queue date.

The first snapshot is explicitly initial. Every later refresh supplies the prior validated snapshot and its canonical revision. Continuing matters preserve item IDs and dedupe keys; additions, updates, resolutions, and unchanged counts reconcile exactly. Changed or resolved work requires a changed authoritative or related source revision.

## Privacy And Retention

Live queue snapshots are temporary local files under an approved private report directory with owner-only permissions. Do not commit them.

Never include raw email bodies/headers, names, personal addresses, tester identity mappings, portfolio/profile links, calendar descriptions, private client/project names, filenames, paths, screenshots, recordings, diagnostics, Figma URLs/keys, credentials, signed URLs, or private assets.

Every item records the privacy reviewer, review date, and method. Sensitive sources require Bryant, Jenna, or both to review sanitized pseudonymous wording and may not rely on an automated scan alone.

`personal-approved` items require Bryant's explicit assignment and remain local. The queue is not a personal-data archive.

## Completion

Before closing an item, update its authoritative taskflow, feedback record, PR, decision, proof bundle, or other approved source. Completed work leaves the active queue; full history belongs in the authoritative source and daily ledger.
