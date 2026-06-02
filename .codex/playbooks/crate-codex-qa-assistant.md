# Crate Codex QA Assistant Playbook

## Purpose
Make Codex a durable QA assistant for Crate rather than a one-off reviewer.

This playbook adapts the useful Peter Steinberger / OpenClaw pattern for Crate:

```text
Codex Action or Codex Computer Use
-> generate or perform a QA scenario
-> produce proof and artifacts
-> optionally recommend or open a draft PR with fixes
-> Bryant reviews and approves
```

The QA assistant is allowed to find bugs and propose specific fixes. Code
changes must be isolated in a branch or draft PR and require Bryant approval
before commit, merge, release, or deploy.

## When To Use
- When Bryant wants recurring QA evidence instead of a one-off review.
- Before or after tester rollout when a workflow needs screenshots, package
  output proof, or browser proof.
- After a GUI-only or web-only report needs repeatable verification.
- When a PR needs QA artifacts before autoreview, bug triage, or release
  readiness.
- When Bryant wants Codex to recommend a fix while preserving human approval
  gates.

## Start Prompt
Use a prompt like:

```text
Use .codex/playbooks/crate-codex-qa-assistant.md for the assigned Crate QA lane.
Confirm whether this is crate-web browser QA or crate-app desktop QA, scope apps
and routes narrowly, produce artifacts and a report, recommend fixes if needed,
and do not commit, merge, release, deploy, tag, notarize, or mutate dependencies.
```

## Core Rules
- Codex QA assistant may find bugs and propose fixes.
- Code changes must be isolated on a branch or draft PR.
- Bryant must approve before commit, merge, release, deploy, tag, or
  notarization.
- No direct production deploys.
- No direct push to protected branches.
- No release, tag, signing, or notarization unless explicitly using an approved
  release-gate or release playbook.
- No dependency mutation.
- No secrets, cookies, signed URLs, tokens, API keys, session IDs, private
  account pages, or private client files in logs, screenshots, reports, PR
  bodies, or artifacts.
- Use only synthetic, minimal, or Bryant-approved test-safe fixtures.
- Scope every Computer Use run to the apps needed for the current lane.
- Stop for Bryant when an account, security, permission, credential, privacy,
  signing, release, or deployment prompt appears.

## Lane A: crate-web Browser QA Assistant

Use this lane for the `crate-web` browser workflow only.

### Tooling
- GitHub Actions.
- Codex Action.
- Playwright or browser smoke scripts.
- GitHub Actions artifacts for screenshots and reports.

### Scope
- Public crate-web browser pages and public user flows.
- Browser-visible copy, layout, navigation, CTAs, and public route behavior.
- No private signed-in account, admin, billing, security, dashboard, portal, or
  signed URL pages.

### Required Behavior
- Produce screenshots, reports, and artifacts.
- Use least-privilege GitHub Actions permissions.
- Prefer `GITHUB_TOKEN`; do not require broad PAT, admin, deploy, or release
  permissions.
- If Codex makes a browser fix, the workflow may open a draft PR.
- The workflow must never push directly to `main`.
- The workflow must never merge its own PR.
- The workflow must never deploy, tag, release, notarize, or touch production.
- The workflow must not expose secrets, cookies, signed URLs, tokens, private
  routes, or account pages in logs or screenshots.

### Non-Replacement Rule
crate-web browser QA assistant does not replace crate-app desktop QA. It tests
the web surface only and feeds browser findings into `crate-autoreview.md` and
`crate-bug-triage.md`.

## Lane B: crate-app Desktop QA Assistant

Use this lane for installed Crate desktop app GUI QA on macOS.

### Tooling
- Codex Computer Use on macOS.
- Installed DMG app under test.
- Finder inspection.
- Approved creative apps only.
- Screenshots, recordings, package inventories, and redacted QA reports.

### Approved Apps
Use only the apps needed for the approved QA lane:

- Crate.
- Finder.
- Figma.
- PowerPoint.
- Keynote.
- Later approved creative apps.

Do not open broad unrelated apps. Do not use password managers, Keychain Access,
Apple Developer portals, deploy dashboards, GitHub release pages, banking,
payment, security, identity, Mail, Messages, Photos, Notes, Calendar, or
unrelated browser tabs.

### Workflows To Exercise
- Package Details.
- Diagnostics on and off.
- Figma Current Page Only.
- PowerPoint.
- Keynote.
- Quick Package.
- Finder output review.

### Required Behavior
- Test the installed DMG app, not the web app.
- Use synthetic or Bryant-approved test-safe fixtures.
- Do not enter credentials, tokens, API keys, payment data, or one-time links.
- Stop for Bryant on account, security, privacy, permission, credential,
  automation, file-access, signing, release, or deploy prompts.
- May recommend fixes, but must not edit code unless Bryant approves a
  follow-up fix prompt.

### Non-Replacement Rule
crate-app Computer Use QA does not replace release gate, signing,
notarization, DMG validation, update metadata validation, or live download
validation. Release validation remains under `crate-release-gate.md` and
`release-crate.md`.

## Required QA Assistant Report
Every QA assistant run should produce a clear report. Include:

- scenario tested
- lane: `crate-web browser` or `crate-app desktop`
- apps used
- routes or workflows exercised
- artifacts and screenshots generated
- package output path, when applicable
- files included and missing, when applicable
- Package Details observations, when applicable
- optional `Crate Diagnostics/crate-provenance.json` summary, when diagnostics
  were enabled and the manifest exists
- privacy checks performed
- pass/fail result
- bug found, if any
- recommended fix or draft PR, if needed
- tests or checks actually run
- risks and gaps

Do not claim a test, smoke, build, release validation, signing check, or
notarization check passed unless it actually ran in the current run.

## Artifact Rules
- Store QA assistant artifacts under a clearly named run folder.
- Use `/private/tmp/crate-*` or another Bryant-approved local path for desktop
  QA outputs.
- Use GitHub Actions artifacts for crate-web browser QA.
- Redact logs and reports before sharing.
- Do not commit screenshots, recordings, logs, generated reports, package
  output, or private fixture files.
- Do not include private/client files unless Bryant explicitly provides
  test-safe fixtures or approves the exact artifact.
- Scan reports, manifests, and package outputs for token-like strings when
  privacy risk is present.

## Related Playbooks
- Use `crate-autoreview.md` after QA artifacts exist and Bryant wants an
  adversarial review or concrete fix recommendations.
- Use `crate-computer-use-qa.md` for detailed crate-app desktop GUI QA
  execution.
- Use `crate-gui-repro-flow.md` when the QA assistant finds or needs to
  reproduce a GUI-only bug.
- Use `crate-manual-qa-matrix.md` when a QA assistant scenario should become a
  repeatable manual workflow.
- Use `crate-bug-triage.md` to classify QA findings, draft issues, and choose
  next playbooks.
- Use `crate-regression-detector.md` after a proposed fix exists and Bryant
  wants a fail-fast branch or PR regression sweep.
- Use `crate-release-gate.md` only after Bryant is considering release
  readiness. QA assistant evidence can feed the gate, but does not replace it.

Both lanes feed into autoreview and bug triage. Neither lane is allowed to
silently cross into release mutation or production deployment.

## Files Codex May Read
- `AGENTS.md`.
- `.codex/playbooks/*.md`.
- `docs/*.md`.
- Approved QA reports, screenshots, recordings, browser reports, package
  inventories, package outputs, and diagnostic manifests.
- `package.json` read-only for version and script context.
- Changed files read-only when needed to recommend a fix.

## Files Codex May Modify
- For docs/process/playbook work explicitly scoped by Bryant:
  - `.codex/playbooks/*.md`
  - `docs/*.md`
  - `AGENTS.md`
- For crate-web browser QA, a workflow may isolate a Codex-generated fix in a
  draft PR branch after the browser QA job succeeds.
- For crate-app desktop QA, none by default. Code edits require Bryant to
  approve a separate follow-up fix prompt.

## Files Codex Must Not Modify By Default
- `main.js`.
- `preload.js`.
- `renderer/`.
- `parsers/`.
- `scripts/`.
- `tests/`.
- `package.json`.
- `package-lock.json`.
- release artifacts.
- `crate-site/`.
- crate-web from a crate-app desktop QA task.
- private tester, client, or source assets.

## Commands And Checks

Start with repo context:

```sh
git status --short --branch
git branch --show-current
git rev-parse --short HEAD
git diff --name-only
```

Docs-only checks after editing playbooks or AGENTS:

```sh
git diff --check
rg -n "[[:blank:]]$" AGENTS.md .codex/playbooks docs
LC_ALL=C rg -n "[^[:ascii:]]" AGENTS.md .codex/playbooks docs
```

crate-web browser QA workflows may run browser checks inside the crate-web
workflow environment. Do not run crate-web checks from a crate-app docs task.

crate-app desktop QA may inspect approved package output after Bryant provides
or approves the output path:

```sh
find <approved-package-output> -maxdepth 4 -type f | sort
rg -n "token|secret|credential|Authorization|Bearer|cookie|password|passkey|signed" <approved-report-or-manifest>
```

## Definition Of Done
- Confirmed lane: crate-web browser or crate-app desktop.
- Scope stayed within the approved lane.
- Artifacts and a report were produced or a blocker was explained.
- Privacy checks were performed and sensitive surfaces were avoided.
- Fixes, if any, were recommended or isolated in a draft PR branch.
- No protected branch push, merge, release, deploy, tag, signing, notarization,
  or dependency mutation occurred.
- Bryant receives files changed, checks run, artifacts generated, risks, and
  whether he can approve the next step.
