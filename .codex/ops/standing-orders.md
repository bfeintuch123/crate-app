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
