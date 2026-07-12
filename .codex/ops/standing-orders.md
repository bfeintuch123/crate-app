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

Authority: convert tester feedback into structured, privacy-safe work items.

Trigger:
- Bryant provides tester portal results
- support mailbox receives tester issue summary
- Jenna QA report resembles tester feedback

Allowed actions:
- summarize feedback
- redact sensitive artifacts
- classify as UX, onboarding, packaging, permissions, Figma, quota, support, or billing
- create issue/bug prompt or UX backlog entry

Approval gates:
- stop before contacting testers directly
- stop before inspecting raw private assets or diagnostics
- stop before app code changes unless Bryant routes to a failure loop

Proof required:
- triage schema fields
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
- use `.codex/tools/codex_thread_control.py` when native tools are unavailable
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
- create reviewable skill proposals, hooks, scripts, tests, inventory updates, and doctor checks on scoped branches
- run read-only validation and open PRs when the active mode permits it

Approval gates:
- stop before enabling or trusting a changed hook unless Bryant approved that rollout
- stop before app runtime changes, dependency mutation, merge, release, deploy, credentials, or private artifacts unless separately approved
- external research is inspiration only until primary-source or reproducible validation passes

Proof required:
- duplication assessment
- files and ownership boundaries
- validation and adversarial review
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
