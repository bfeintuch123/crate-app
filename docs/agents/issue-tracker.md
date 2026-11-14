# Issue tracker: GitHub

Repository: `bfeintuch123/crate-app`.
Canonical base branch: `v2.4.x`.

Issues and specifications for Crate App belong in this repository's GitHub
Issues. Use `gh` with explicit `--repo bfeintuch123/crate-app`; for API calls,
use `repos/bfeintuch123/crate-app/...`. Never infer the destination from a fork
or the skills' upstream repository.

Read an issue with:
`gh issue view <number> --repo bfeintuch123/crate-app --json number,title,body,labels,comments`

List issues with:
`gh issue list --repo bfeintuch123/crate-app --state open --json number,title,body,labels`

Before an authorized write, verify the destination using:
`gh repo view bfeintuch123/crate-app --json nameWithOwner`

## Publication and mutation

When a skill says "publish", prepare the proposed issue or comment unless the
current task already authorizes publication. Use a body file for multiline
content. Creation, comments, labels, assignments, dependencies, edits, and
closure must remain within that authorization. Preserve unrelated content.

Publish only sanitized engineering requirements and approved evidence.
Private tester material, credentials, raw diagnostics, private paths, and
unapproved media do not belong in issue bodies or comments.

Use native sub-issues and blocking relationships when supported and authorized.
Otherwise use `Part of #<parent>` and `Blocked by: #<number>` references.
Do not create a second local tracker or wayfinder map.

Closed blockers and readiness labels do not authorize implementation.
Do not automatically close issues or change PR state after implementation.

## Pull requests as a triage surface

PRs as a request surface: no.

Resolve ambiguous issue/PR references before acting. Route PR review through
the existing Crate review workflow. Preserve all commit, publication,
ready-for-review, merge, release, signing, and deployment gates.
