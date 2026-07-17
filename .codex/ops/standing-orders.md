# Crate Standing Orders

## Purpose

Standing orders define durable authority for repeatable Crate programs. A loop may act without Bryant restating every step only when the requested work matches an active standing order and no stop gate is hit.

## Required Fields

Each standing order has:

- authority
- trigger
- allowed actions
- approval gates
- escalation conditions
- forbidden actions
- proof required
- state files to update

## SO-001: Daily Vault Update

Authority: documentation-only daily synthesis.

Trigger:
- scheduled automation
- Bryant asks for vault update
- major Crate milestone completes

Allowed actions:
- read `.codex/state/daily-crate-ledger.md`
- read `.codex/state/current-workstream.md`
- read recent `docs/crate/` daily notes, decisions, taskflows, and proof bundles
- update the compiled Crate vault docs
- report changed vault files, ambiguity, and next Crate action

Approval gates:
- stop before editing app source, release state, site files, dependencies, credentials, or raw private artifacts

Proof required:
- files read
- vault files changed
- summary of decisions and next action

State files:
- `.codex/state/daily-crate-ledger.md`
- `.codex/state/current-workstream.md`

## SO-002: Autonomous Crate Failure Loop

Authority: triage, fix, review, and PR work only within the preauthorization mode Bryant provides.

Trigger:
- QA smoke failure
- tester bug report
- installed-app regression
- release-gate failure
- PR review finding

Allowed actions:
- classify failure source and severity
- create/use a branch from `v2.4.x`
- edit scoped files only when the selected mode allows edits
- run relevant check suites
- open PR and merge only when the active prompt explicitly permits it

Approval gates:
- stop before merge unless explicitly preauthorized and merge-readiness is clean
- stop before release, build, deploy, signing, notarization, dependency mutation, or crate-web changes

Proof required:
- root cause
- files changed
- checks run
- privacy/security review
- PR/merge state
- next QA prompt

State files:
- taskflow under `.codex/taskflows/`
- `.codex/state/daily-crate-ledger.md`

## SO-003: Internal QA Prerelease Gate

Authority: prepare an internal QA prerelease only when Bryant explicitly approves the exact version.

Trigger:
- Bryant asks to prepare `vX.Y.Z-qa.N` or tester beta build

Allowed actions:
- pull latest `origin/v2.4.x`
- run release-gate checks
- bump approved package version
- build/sign/notarize/staple only when approved
- create GitHub prerelease only when approved

Approval gates:
- every release mutation requires explicit version and scope
- stop before final public release, site deploy, crate-web changes, or dependency mutation unless separately approved

Proof required:
- release commit
- tag
- artifacts
- codesign/Gatekeeper/stapler result
- GitHub release URL
- exact Jenna QA prompt

State files:
- `.codex/state/current-workstream.md`
- `.codex/state/daily-crate-ledger.md`
- release taskflow

## SO-004: Cloudflare Site Deploy

Authority: deploy `crate-site` to the Cloudflare Pages project `get-crate` only when Bryant explicitly approves a site deploy.

Trigger:
- Bryant asks to deploy get-crate.com
- release playbook reaches an approved site-deploy step

Allowed actions:
- retrieve Cloudflare token from Keychain without printing it
- run Wrangler deploy against the approved project and branch
- verify production deployment and live site content

Approval gates:
- stop if token is missing, expired, or would be exposed
- stop if the target project is not `get-crate`
- stop if branch/commit/version does not match the approved release

Proof required:
- Wrangler project name
- branch
- commit hash
- deployment URL
- live-site verification
- confirmation token was not printed

State files:
- Cloudflare proof bundle
- `.codex/state/current-workstream.md`

## SO-005: Tester Feedback Intake

Authority: intake tester feedback, keep private evidence under controlled custody, and convert distinct findings into canonical privacy-safe records before downstream triage.

Trigger:
- Bryant provides tester portal results
- support mailbox receives tester issue summary
- Jenna QA report resembles tester feedback

Allowed actions:
- summarize feedback
- redact sensitive artifacts
- generate or reuse pseudonymous source IDs from the private tester mapping
- normalize one finding per canonical JSON record
- perform and record the required human privacy review
- validate canonical tester-feedback JSON without printing record content
- classify as UX, onboarding, packaging, permissions, Figma, quota, support, or billing
- create issue/bug prompt or UX backlog entry

Approval gates:
- stop before contacting testers directly
- stop before inspecting raw private assets or diagnostics
- stop before app code changes unless Bryant routes to a failure loop

Proof required:
- canonical schema validation summary
- human privacy review owner and date
- severity
- evidence available
- recommended next route

State files:
- tester archive entry
- daily ledger

## SO-006: External Control / Thread Coordination

Authority: create, message, or supervise scoped Crate side threads when tool exposure permits it.

Trigger:
- Bryant asks Codex to start another Crate thread
- a loop needs a visible side thread or read-only sidecar review

Allowed actions:
- use native thread tools when available
- use the installed Crate Ops persistent task tools or its plugin-owned fallback CLI when native tools are unavailable
- use sub-agents for bounded read-only sidecar work

Approval gates:
- one builder edits app code at a time
- stop before delegating secrets, release mutations, or private file inspection

Proof required:
- thread/agent id
- prompt sent
- result integrated
- state updated

State files:
- `.codex/state/daily-crate-ledger.md`
- active taskflow

## SO-007: Crate Ops Improvement Proposal

Authority: inspect, prototype, and propose Crate operational workflow improvements within Bryant's approved scope.

Trigger:
- Bryant approves an ops/workflow improvement batch
- a loop retrospective identifies repeated friction
- X or external research identifies a potentially useful workflow

Allowed actions:
- compare proposals against the skill registry and existing playbooks
- create reviewable skill proposals, hooks, scripts, tests, inventory updates, synthetic workflow evaluations, aggregate outcome receipts, and doctor checks on scoped branches
- run read-only validation and open PRs when the active mode permits it

Approval gates:
- stop before enabling or trusting a changed hook unless Bryant approved that rollout
- stop before app runtime changes, dependency mutation, merge, release, deploy, credentials, or private artifacts unless separately approved
- external research is inspiration only until primary-source or reproducible validation passes

Proof required:
- duplication assessment
- files and ownership boundaries
- validation and adversarial review
- workflow eval summary and outcome receipt when the change affects routing, approvals, privacy, stop gates, or model tiers
- privacy/security impact
- PR and merge state

State files:
- active taskflow
- `.codex/state/daily-crate-ledger.md`
- `.codex/state/current-workstream.md` when the durable next action changes

## SO-008: Design And Product Learning Review

Authority: produce read-only design, cross-tester, workflow-capture proposal, and product-measurement evidence.

Trigger:
- Bryant asks for design-quality review or a design implementation brief
- Bryant asks what multiple normalized tester records collectively show
- Bryant explicitly asks to record a recurring workflow
- Bryant asks for a beta or launch measurement plan

Allowed actions:
- inspect approved/public UI evidence and normalized tester records
- create design findings, cross-tester synthesis, measurement plans, and skill proposals
- start Record & Replay only after Bryant explicitly requests recording and confirms capture

Approval gates:
- stop before app/site/Figma mutation, analytics implementation, live-skill promotion, or external communication
- stop processing a recording that contains credentials, private client work, payments, signing, or other sensitive content
- raw recordings, screenshots, tester identities, and private assets remain private by default

Proof required:
- evidence sources and privacy status
- findings, disagreement, and confidence
- proposed owner and next route

State files:
- relevant taskflow or feedback archive
- `.codex/state/daily-crate-ledger.md` when a durable decision changes

## SO-009: Launch Experience Review And Rehearsal

Authority: audit the customer journey and public asset truth, or run a non-mutating launch incident tabletop.

Trigger:
- Bryant asks whether Crate's customer journey or public assets are launch-ready
- Bryant asks to rehearse a launch, support, privacy, download, Gatekeeper, or rollback incident

Allowed actions:
- inspect approved launch evidence
- produce readiness and tabletop reports
- route complete readiness evidence to `crate-ship`

Approval gates:
- stop before build, release, tag, deploy, DNS, download, mailbox, legal, billing, credential, rollback, or customer-message mutation
- readiness does not authorize release; rehearsal does not authorize live recovery actions

Proof required:
- target build and required asset inventory
- customer journey results or incident scenario
- blockers, owners, stop authority, and evidence gaps

State files:
- launch taskflow or proof bundle
- `.codex/state/current-workstream.md` only when the durable launch state changes

## SO-010: Dependency Watch

Authority: collect and classify read-only dependency evidence.

Trigger:
- Bryant asks for dependency posture, audit triage, outdated-package review, or supply-chain follow-up
- a release/security review requests dependency evidence

Allowed actions:
- collect approved read-only audit/outdated reports
- compare full and production-only audit results
- recommend monitor, security review, or a separately scoped upgrade proposal

Approval gates:
- network collection requires approval when not already authorized
- stop before install, update, fix, dedupe, package or lockfile mutation, build, release, or deploy
- do not infer a clean supply chain from audit/outdated reports alone

Proof required:
- report sources and collection mode
- runtime, development, and unknown-scope findings
- limitations and recommended next route

State files:
- dependency review taskflow or proof bundle when the result is material

## SO-011: Chief-Of-Staff Attention Management

Authority: maintain a privacy-safe, freshness-aware control index while the current Codex task remains the chief of staff and source of truth.

Trigger:
- Bryant asks for status, priorities, or chief-of-staff coordination
- a material tester, QA, PR, release, design, support, vendor, meeting, or business event changes what deserves attention
- bounded agent or task work returns for integration

Allowed actions:
- inspect only approved and connected source scopes
- record source coverage, freshness, and partial failures
- sanitize, deduplicate, prioritize, and route active attention items
- reconcile every noninitial refresh against the previous validated snapshot
- require route-owner and standing-order agreement, exact action class, approval trail, and next checkpoint
- continue work already authorized by the current prompt, an existing standing order, an approved taskflow, or a decision record
- delegate bounded sanitized work through `crate-thread-chief`
- integrate returned evidence and update the authoritative source before closing an item
- write temporary owner-only queue snapshots under approved local report directories

Approval gates:
- queue placement never grants authority
- stop before unapproved app, site, or Figma mutation
- stop before purchases, pricing/legal commitments, tester payments, external messages, scheduling, merges, releases, deploys, dependencies, credentials, or private-artifact access unless exactly authorized
- stop before presenting remembered, stale, failed, skipped, or unauthorized source state as current

Forbidden actions:
- committing live queue snapshots
- copying raw mailbox, calendar, tester, Figma, diagnostic, client, credential, or personal content into the queue
- allowing a side agent, visible task, or queue snapshot to become the source of truth

Proof required:
- refresh scope and per-source result
- queue counts by bucket
- routes and execution owners
- agents or tasks used
- evidence integrated
- approvals and next refresh trigger

State files:
- active taskflow when work spans turns, tasks, agents, or approval gates
- `.codex/state/daily-crate-ledger.md`
- `.codex/state/current-workstream.md` only when durable high-level state changes

## SO-012: Support And Business Communications

Authority: inspect approved Crate mailbox scopes, sanitize and classify messages, and draft responses. Send only when Bryant's current prompt or approved taskflow authorizes the exact message and recipients.

Trigger:
- Bryant asks to inspect, draft, or send a Crate support or business message
- an approved attention-queue item routes to `crate-support-inbox`

Allowed actions:
- inspect only the approved mailbox or thread scope
- sanitize, classify, and route support or business messages
- draft a response without sending
- send only the exact approved message to the exact approved recipients
- update the authoritative support case, feedback record, or taskflow after action

Approval gates:
- stop before any unapproved send, recipient change, mailbox permission change, bulk outreach, identity disclosure, legal commitment, or credential access
- external communication requires an approved action record bound to a fresh authority source

Escalation conditions:
- recipient, sender identity, attachment, message intent, legal meaning, payment request, or privacy scope is ambiguous
- the requested action changes mailbox permissions, aliases, forwarding, or authentication

Forbidden actions:
- bulk or unsolicited outreach
- exposing raw private message content in queue or repo state
- legal, payment, credential, mailbox-admin, or identity changes under this standing order

Proof required:
- mailbox scope, message category, send or draft result, recipients confirmed, and privacy outcome

State files:
- authoritative support case, tester-feedback record, or active taskflow when applicable
- `.codex/state/daily-crate-ledger.md` for material completed actions

## SO-013: Calendar Coordination

Authority: inspect approved calendars, find availability, and draft events. Create, update, or delete only the exact event authorized by the current prompt or approved taskflow.

Trigger:
- Bryant asks to inspect availability or coordinate a specific event
- an approved attention-queue item routes to `crate-calendar-coordination`

Allowed actions:
- inspect only approved calendar scope and expose availability rather than unrelated event details
- draft an event with the proposed date, time, attendees, body, and conferencing
- create, update, or delete only the exact approved event
- reread the resulting event state when the connector allows it

Approval gates:
- stop before adding unapproved attendees, exposing private calendar content, changing unrelated events, creating recurring automation, or purchasing services
- scheduling or remote mutation requires an approved action record bound to a fresh authority source

Escalation conditions:
- event identity, time zone, attendees, recurrence, conferencing, body, calendar owner, or requested mutation is ambiguous
- the event conflicts with another commitment or requires payment

Forbidden actions:
- changing unrelated events or calendar permissions
- adding unapproved attendees or exposing private event content
- creating recurring automations or purchasing services

Proof required:
- calendar scope, event action, attendee confirmation, resulting event state, and privacy outcome

State files:
- active taskflow for multi-step scheduling
- `.codex/state/daily-crate-ledger.md` when the event materially changes a Crate workstream

## SO-014: Business Operations

Authority: perform read-only business research and exact Bryant-approved operational actions outside engineering, support, and calendar coordination.

Trigger:
- Bryant asks for bounded business research or explicitly approves an operational action
- an approved attention-queue item routes to `crate-business-operations`

Allowed actions:
- perform bounded read-only product, vendor, pricing, or operations research
- execute only an exact approved product decision, remote mutation, purchase, legal workflow step, or credential/private-data action
- reread the resulting external state when possible
- update the authoritative decision, taskflow, or proof record

Approval gates:
- Bryant must approve the exact product decision, remote target, amount, counterparty, legal document or step, credential/private-data scope, and intended outcome before mutation
- stop on ambiguity or any action better owned by engineering, release, deploy, tester, design, support, or calendar loops

Escalation conditions:
- amount, counterparty, document, legal effect, remote target, credential/private-data scope, renewal, cancellation, or intended outcome is ambiguous
- the action creates an ongoing obligation or belongs to another loop

Forbidden actions:
- app, site, Figma, dependency, merge, release, deploy, tester, support-message, or calendar mutation under this standing order
- inferred approval, open-ended authority, unbounded purchases, or credential sharing

Proof required:
- action class, exact approval source, bounded target, external state result, and remaining obligations

State files:
- approved taskflow or decision record
- `.codex/state/daily-crate-ledger.md`
- `.codex/state/current-workstream.md` only when durable high-level state changes
