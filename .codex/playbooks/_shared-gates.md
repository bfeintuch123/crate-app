# Crate Shared Gates

Shared gates are reusable constraints for Crate playbooks, loops, release gates, reviews, and handoffs. A specific user prompt or playbook may be stricter; the stricter instruction wins.

## Ops Gate

For non-trivial Crate work, confirm the ops layer before acting:

- applicable standing order from `.codex/ops/standing-orders.md`
- active taskflow path, or reason no taskflow is needed
- memory/context files selected from `.codex/ops/crate-memory-model.md`
- proof bundle expectation from `.codex/ops/proof-bundle-template.md`
- relevant skill/tool metadata from `.codex/ops/skill-registry.md`

Run `python3 .codex/tools/crate_doctor.py` before release, deploy, long-running QA, or external-control coordination. Warnings must be classified. Failures stop the work unless clearly outside scope.

## Repo Gate

Confirm before mutating work:

- path is `/Users/bryantfeintuchclaw/Projects`
- remote is `bfeintuch123/crate-app.git`
- work is in crate-app, not crate-web or mission-control
- base branch is `v2.4.x` unless Bryant explicitly says otherwise
- working tree state is known and acceptable for the requested mode
- crate-web and mission-control status are considered when the task could affect them

Stop if the repo identity, branch, base, or dirty-tree state conflicts with the prompt.

## Mutation Gate

Do not edit, commit, push, merge, build, release, deploy, tag, notarize, mutate dependencies, or touch credentials unless the selected playbook and Bryant's prompt both authorize that action.

Use the smallest mutation that satisfies the goal. Keep app code, tests, docs, release metadata, and dependency changes in separate scopes unless Bryant explicitly combines them.

## Release Gate

Internal QA prerelease work is not final public release work.

Do not:

- create final public `v2.8.0`
- mark any QA prerelease as public stable
- update get-crate.com
- deploy crate-web or Cloudflare Pages
- change crate-site for an internal QA prerelease
- build, sign, notarize, staple, tag, or create a GitHub release unless Bryant explicitly approves that exact release step

Stop for signing identity, Keychain, Apple Developer, notary profile, notarization, stapling, artifact hash, blockmap, `latest-mac.yml`, tag, or GitHub release conflicts.

## Dependency Gate

Do not mutate dependencies unless Bryant explicitly scopes dependency remediation.

Dependency remediation must:

- avoid `npm audit fix --force`
- avoid SemVer-major upgrades unless Bryant explicitly approves
- avoid Electron or electron-builder upgrades unless Bryant explicitly approves
- explain package.json changes if npm makes them
- run `npm audit --audit-level=high` after remediation

Known moderate advisories can remain non-blocking for internal QA only when the active release prompt says so.

## Privacy Gate

Never include or commit:

- passwords, tokens, credentials, signing secrets, Apple Developer secrets, or Keychain passwords
- raw `lsof`, `ps`, `mdls`, AppleScript, JXA, System Events, or broad diagnostics output
- raw private file lists
- Figma tokens
- signed URLs
- unrelated private/client file paths
- unapproved screenshots, recordings, package outputs, or Jenna-machine source files

Allowed when relevant:

- public PR and release URLs
- branch names
- package versions
- artifact filenames
- test names
- function names
- exact error text
- approved QA fixture names
- approved QA root paths only when operationally needed

## Review Gate

Before merge, confirm:

- PR base is `v2.4.x`
- branch is mergeable
- changed files are inside scope
- required checks passed
- no requested changes or unresolved blocking review threads remain
- regression, security, and provenance risks are reviewed when relevant
- Bryant explicitly approved merge, unless the loop prompt preauthorized merge and all merge-readiness gates approve

For a major PR, also require the exact-head correction loop in `crate-autoreview.md`: protected CI passed on the exact current head and a fresh independent read-only Luna/high review passed; add a second distinct independent reviewer for the highest-risk security, performance, or state-integrity changes. Keep one repository writer, route findings back as normal follow-up commits without history rewriting, and repeat both gates after every head change. The loop is bounded at three writer follow-up cycles; then stop and escalate rather than waive or lower a standard. Docs/copy and exact version-only PRs retain the lighter path unless safety or release integrity is affected. Stop before ready-for-review or merge; those remain separate Bryant-authorized gates.

Stop if merge-readiness requests changes.

## Standard Final Report

Return the fields relevant to the work:

- result
- standing order
- taskflow
- branch
- PR URL
- commit hash
- files changed
- tests/checks run and results
- proof bundle or proof summary
- release/artifact URLs when applicable
- risks and known follow-ups
- merge/release/deploy status
- confirmation of forbidden actions not taken
- exact next prompt for Bryant, Jenna, or the next Codex session
