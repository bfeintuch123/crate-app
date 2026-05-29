# Crate Bug Triage Playbook

## Purpose
Convert tester feedback into actionable engineering work.

Bug triage should turn evidence into a clear next step without inventing reproduction facts, exposing tester assets, or treating every tester report as a code defect.

## When To Use
- After `.codex/playbooks/crate-tester-intake.md` produces structured feedback.
- When Bryant receives a tester report about missing assets, wrong assets, package failures, manifest issues, install problems, or UI confusion.
- Before opening a GitHub issue for a tester-reported problem.
- Before deciding whether to run `.codex/playbooks/crate-reprobox.md`, `.codex/playbooks/crate-regression-detector.md`, `.codex/playbooks/crate-provenance-review.md`, `.codex/playbooks/crate-security-scan.md`, `.codex/playbooks/crate-package-diff.md`, or `.codex/playbooks/crate-provenance-snapshot.md`.
- Before deciding whether a fix needs a release.

## Start Prompt
Use a prompt like:

```text
Use .codex/playbooks/crate-bug-triage.md to triage this Crate tester report. Classify the bug type, inspect package output and optional Crate Diagnostics/crate-provenance.json if provided, separate facts from assumptions, recommend next playbook, draft a GitHub issue if appropriate, and do not modify code.
```

## Triage Inputs
Collect and separate:

- tester profile and creative stack
- assigned workflow
- expected Crate behavior
- actual Crate behavior
- screen recording or screenshots
- package output path, archive, or redacted inventory
- optional `Crate Diagnostics/crate-provenance.json` diagnostic manifest or redacted manifest summary
- Crate version
- macOS version
- source app versions, if known
- storage context, such as local folder, Downloads, cloud drive, or external drive
- privacy constraints and sharing approvals
- follow-up questions

Mark each input as observed, tester-reported, Bryant-provided, inferred, missing, or unknown.

## Bug Type Classification
Classify the primary type and any secondary types:

- Figma scope:
  - Current Page Only mismatch
  - Entire File mismatch
  - page lock failure
  - multi-page collaborative ambiguity
  - local image import missing
  - component dependency ambiguity
- cross-app handoff:
  - asset moved from one app to another but not connected
  - wrong app context wins
  - multiple apps open with unrelated files
  - handoff through exports, Downloads, clipboard, or cloud drive
- parser/provenance:
  - linked file not detected
  - embedded resource not extracted
  - relationship confidence wrong
  - manifest overclaims or underclaims provenance
  - warnings missing or misleading
- package output:
  - missed asset
  - wrong asset included
  - duplicate asset
  - package failure
  - output path or containment issue
  - file count mismatch
- manifest/privacy:
  - private data exposed
  - token-like data exposed
  - signed URL exposed
  - raw command output exposed
  - confidential path or client name exposed
- install/release:
  - download, Gatekeeper, permissions, update, crash, or launch issue
  - mismatch between live release and unreleased merged code
- UI/UX confusion:
  - tester chose wrong scope
  - success or failure state unclear
  - error message missing action
  - settings or permissions unclear

## Reproduction Requirements
Before engineering work starts, identify what is needed to reproduce:

- exact workflow category
- source app and destination app
- source file type and asset type
- storage location, such as local folder, Downloads, cloud drive, or external drive
- Crate version or branch
- relevant scope setting
- minimum synthetic or cleared fixture that can reproduce the behavior
- package output or redacted inventory
- optional `Crate Diagnostics/crate-provenance.json` diagnostic manifest or redacted summary
- screenshots or recording timestamps that show the critical moment
- expected package contents
- expected exclusions
- privacy constraints

If these are missing, classify the report as needs more evidence instead of inventing steps.

## Artifact Inspection
Inspect package output only when Bryant has approved access to the artifact or the artifact is synthetic/cleared.

Package output checks:

- Does the package folder exist?
- If diagnostic reports were enabled, does it contain `Crate Diagnostics/crate-provenance.json`?
- Are expected assets present?
- Are wrong, unrelated, private, or out-of-scope assets present?
- Are extracted embedded resources present?
- Are files duplicated or unexpectedly renamed?
- Are files contained inside the intended output folder?
- Do package counts match the visible inventory?

Manifest checks:

- Does `Crate Diagnostics/crate-provenance.json` parse as JSON when a diagnostic manifest is provided?
- Are `copiedCount`, `embeddedCount`, `totalFiles`, and `errors` present?
- Do node and edge counts roughly match the package contents?
- Are confidence bands appropriate, such as confirmed, likely, candidate, or weak?
- Are warnings present for partial or omitted provenance?
- Does the manifest avoid tokens, credentials, signed URLs, raw command output, cookies, and private unrelated paths?
- Does the manifest overclaim certainty for Figma, parser, package, or cross-app relationships?

## Triage Decision
Choose one decision and explain the evidence:

- Real bug:
  - Evidence shows Crate behavior violates expected product behavior or guardrails.
  - Reproduction path is known or can be made synthetic.
- Expected current limitation:
  - Behavior matches known current capability or partial-provenance limits.
  - Product messaging or docs may still need improvement.
- Tester setup issue:
  - Evidence points to permissions, unavailable cloud files, disconnected external drive, unsupported app state, or wrong Crate version.
  - Do not blame the tester without evidence.
- Product requirement gap:
  - The tester expectation is reasonable but not currently specified or implemented.
  - Product decision needed before engineering fix.
- Needs more evidence:
  - Artifacts or reproduction facts are missing.
  - Privacy limits prevent inspection.
  - Report cannot be fairly classified yet.

## Choose Next Playbook
Recommend the next playbook based on the classification:

- Use `.codex/playbooks/crate-reprobox.md` when the issue needs isolated reproduction or dirty working trees must be avoided.
- Use `.codex/playbooks/crate-regression-detector.md` when the issue could be a branch or PR regression.
- Use `.codex/playbooks/crate-provenance-review.md` when provenance confidence, privacy, manifest shape, or evidence claims are central.
- Use `.codex/playbooks/crate-security-scan.md` when private data, tokens, paths, shell behavior, or filesystem boundaries are implicated.
- Use `.codex/playbooks/crate-package-diff.md` when before/after package contents, counts, copied files, or extracted resources need comparison.
- Use `.codex/playbooks/crate-provenance-snapshot.md` when manifest graph changes need a structured before/after comparison.
- Use `.codex/playbooks/crate-manual-qa-matrix.md` when the report should become part of a repeatable manual QA workflow.
- Use `.codex/playbooks/crate-pr-documenter.md` after a fix exists and PR notes are needed.

## GitHub Issue Draft
Create an issue draft when the report is actionable, privacy-safe, and not already covered by an issue.

Do not create the issue remotely without Bryant's explicit approval.

Issue draft template:

```md
# <short behavior title>

## Summary
<one or two factual sentences>

## Classification
- Type:
- Decision:
- Priority:
- Severity:
- Release need:

## Environment
- Crate version:
- macOS version:
- Source app versions:
- Storage context:

## Reproduction
1. <observed or approved step>
2. <observed or approved step>
3. <observed or approved step>

## Expected
<what tester expected Crate to do>

## Actual
<what Crate did>

## Evidence
- Screen recording:
- Screenshots:
- Package output:
- Crate Diagnostics/crate-provenance.json:

## Privacy
- Artifacts cleared:
- Redactions:
- Private assets excluded:

## Next Playbook
<recommended playbook and why>

## Open Questions
- <question>
```

## Branch And Priority Recommendations
Recommend a PR branch name only after deciding the issue is real, likely real, or a product requirement gap.

Branch name patterns:

- `fix/<area>-<short-symptom>`
- `docs/<area>-<short-gap>`
- `test/<area>-<workflow-fixture>`
- `security/<area>-<privacy-risk>`

Priority hints:

- P0:
  - data exposure, destructive behavior, or install/security issue blocking all use
- P1:
  - core package failure, wrong private asset included, or key workflow asset missed
- P2:
  - manifest correctness issue, repeatable but bounded workflow failure, or confusing UI with workaround
- P3:
  - documentation, polish, low-risk expected limitation, or enhancement request

Release recommendation:

- Immediate release recommended when a shipped version exposes private data, corrupts output, blocks install for testers, or breaks a core promised workflow.
- Next planned release is enough when the fix affects unreleased code, docs, test infrastructure, or lower-risk behavior.
- No release needed for docs-only triage, issue drafting, or internal process changes.

## Files Codex May Read
- `AGENTS.md`
- `.codex/playbooks/*.md`
- `docs/*.md`
- tester intake notes
- approved package output directories under `/private/tmp` or another Bryant-approved local path
- approved optional `Crate Diagnostics/crate-provenance.json` diagnostic manifests or redacted summaries
- changed files and tests read-only when needed to assess likely ownership
- GitHub issue and PR metadata through `gh`
- `package.json` read-only for version/script context

## Files Codex May Modify
- None by default.
- With Bryant's explicit approval, Codex may write issue drafts under `/private/tmp/crate-bug-triage-*`.
- With Bryant's explicit approval for process docs, Codex may modify `.codex/playbooks/*.md`, `docs/*.md`, or `AGENTS.md` playbook references.

## Files Codex Must Not Modify
- `main.js`
- `preload.js`
- `renderer/`
- `parsers/`
- `scripts/`
- `tests/`
- `package.json`
- `package-lock.json`
- release artifacts
- `crate-site/`
- private tester assets or package outputs

## Commands Codex May Run
Capture branch and docs state:

```sh
git status --short --branch
git branch --show-current
git diff --name-only
git diff --stat
git diff --check
```

Inspect approved artifacts:

```sh
find <approved-package-output> -maxdepth 4 -type f | sort
diagnostic_manifest="<approved-package-output>/Crate Diagnostics/crate-provenance.json"
test -f "$diagnostic_manifest"
node -e "const fs=require('fs'); const p=process.argv[1]; const m=JSON.parse(fs.readFileSync(p,'utf8')); const count=(items,key)=>items.reduce((a,x)=>{const k=x&&x[key]||'unknown'; a[k]=(a[k]||0)+1; return a;},{}); console.log(JSON.stringify({copiedCount:m.copiedCount,embeddedCount:m.embeddedCount,totalFiles:m.totalFiles,errors:m.errors||[],nodesByType:count(m.nodes||[],'type'),edgesByType:count(m.edges||[],'relationType'),warnings:m.warnings||[]}, null, 2));" "$diagnostic_manifest"
rg -n "token|secret|credential|Authorization|Bearer|cookie|cdn\\.figma|password|passkey|rawTrackedFiles|/usr/sbin/lsof" "$diagnostic_manifest"
```

Diagnostic reports are optional and off by default. Enable `Include diagnostic report in packages` before expecting `Crate Diagnostics/crate-provenance.json`; do not expect a package-root manifest in default package output.

Inspect related repo context without editing:

```sh
rg -n "Current Page|Entire File|crate-provenance|package_includes_file|package_extracts_resource|container_references_file|container_embeds_resource|resource_materialized_as_file|pending_file_rejected" .codex docs tests main.js
rg -n "Photoshop|Illustrator|InDesign|PowerPoint|Keynote|Figma|Downloads|external drive|cloud drive|privacy|manifest" .codex docs tests main.js
```

Prepare an issue draft locally when approved:

```sh
mkdir -p /private/tmp/crate-bug-triage-<id>
```

## Required Checks
- Bug type classified.
- Reproduction requirements listed.
- Package output inspected or marked unavailable.
- Optional `Crate Diagnostics/crate-provenance.json` inspected or marked unavailable.
- Real bug, expected limitation, tester setup issue, product requirement gap, or needs more evidence decision made.
- Facts, assumptions, and unknowns are separated.
- Next playbook is recommended.
- Priority and severity are recommended.
- Release need is recommended.
- GitHub issue draft is prepared when appropriate and approved.

## Approval Gates
Codex may triage from provided evidence and draft text locally in chat without approval. Bryant must explicitly approve any command that reads private tester artifacts, writes issue drafts to disk, creates GitHub issues, commits, pushes, launches the app, or changes release state.

Commands requiring explicit Bryant approval:

```sh
git add <files>
git commit
git push
gh issue create
gh issue edit
gh pr create
gh pr merge <pr>
npm start
npm install
npm ci
npm audit fix
npx electron-builder --mac --arm64
xcrun notarytool submit <artifact> --wait
xcrun stapler staple <artifact>
xcrun stapler validate <artifact>
npx wrangler pages deploy <directory>
```

## Must Never Do
- Do not invent reproduction facts.
- Do not blame the tester without evidence.
- Do not expose private tester assets.
- Do not modify code directly.
- Do not modify tests directly.
- Do not edit package files, release artifacts, or active local cleanup tasks.
- Do not release, deploy, notarize, tag, merge, or mutate dependencies.
- Do not claim a fix is complete without tests.
- Do not create GitHub issues or PRs without Bryant's approval.
- Do not promote partial provenance to certainty.

## Quality Impact
- Converts ambiguous feedback into engineering-ready scope.
- Speeds Crate development by choosing the right next playbook instead of jumping straight to code.
- Reduces bug churn by separating real bugs from limitations, setup issues, product gaps, and missing evidence.
- Protects tester privacy while still preserving package and manifest diagnostics.
- Improves release judgment by naming severity, priority, and release need up front.

## Definition Of Done
- Bug type, decision, priority, severity, reproduction requirements, artifact status, and next playbook are documented.
- Evidence and assumptions are separated.
- A privacy-safe GitHub issue draft exists when appropriate.
- No app code, tests, package files, release files, builds, tags, deploys, or dependencies are changed.
- Bryant receives a clear recommendation for whether to investigate, fix, document, defer, or ask for more evidence.

## Report Format
- Branch and dirty state when repo work was involved.
- Tester report summary.
- Bug type classification.
- Evidence received.
- Package output findings.
- `Crate Diagnostics/crate-provenance.json` findings when diagnostics were enabled.
- Facts, assumptions, and unknowns.
- Triage decision.
- Priority, severity, and release recommendation.
- Recommended next playbook.
- GitHub issue draft, if appropriate.
- Commands run and results.
- Files changed, if any.
- Risks and follow-up questions.
- Whether Bryant can proceed.
