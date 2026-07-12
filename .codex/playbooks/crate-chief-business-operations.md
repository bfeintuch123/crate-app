# Crate Chief Business Operations Playbook

## Purpose

Provide three explicit, bounded execution routes for chief-of-staff work that is outside app engineering: support and business communication, calendar coordination, and approved business operations.

This playbook does not create authority. Every mutation requires the exact current approval recorded by the chief-of-staff attention queue.

## Routes

### Support And Business Communications

- owner: `crate-support-inbox`
- standing order: `SO-012`
- actions: read approved mail scope, sanitize and classify, draft, and send only when Bryant's current prompt or approved taskflow authorizes the exact message and recipients
- stop before unapproved sends, mailbox permission changes, identity disclosure, bulk outreach, legal commitments, or credentials

### Calendar Coordination

- owner: `crate-calendar-coordination`
- standing order: `SO-013`
- actions: read approved calendars, find availability, draft events, and create/update/delete only the exact event authorized in the current prompt or approved taskflow
- stop before unapproved attendees, private calendar disclosure, recurring automation, purchases, or unrelated events

### Business Operations

- owner: `crate-business-operations`
- standing order: `SO-014`
- actions: read-only research and exact Bryant-approved product decisions, remote mutations, purchases, legal workflow steps, or credential/private-data access
- stop before any action whose amount, counterparty, document, system, scope, or approval is not exact and current

## Shared Gates

- Use only approved connectors and bounded scopes.
- A queue bucket never authorizes execution.
- Current-prompt authority expires with the active queue date.
- Approved authority must bind to a fresh prompt, taskflow, or decision source revision.
- Keep raw mail, calendar, legal, payment, credential, tester, vendor, and personal content out of queue snapshots and repo state.
- Report actions taken, external state changed, evidence, and remaining approval needs.

## Verification

- confirm route owner and standing order
- confirm action class and approval scope match
- confirm Bryant approval for money, legal, credentials/private data, merge, release, and deploy
- confirm recipients, attendees, amount, document, or remote target before mutation
- reread changed remote state after execution when the connector allows it

## Stop Gates

Stop on ambiguous recipients, attendees, amounts, documents, credentials, external systems, authority, or privacy scope. Route engineering, release, deploy, tester, and design work back through their existing loops.
