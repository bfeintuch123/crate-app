# Crate QA Results Synthesizer Playbook

## Purpose
Turn Jenna and tester QA results into structured next actions.

QA synthesis is not bug fixing. It organizes observed evidence, package output, optional `Crate Diagnostics/crate-provenance.json` diagnostic output, screen recordings, expected versus actual behavior, and privacy constraints so Bryant can decide whether to pass, triage, reproduce, hold release, or proceed toward final `v2.8.0`.

## When To Use
- After Jenna QA produces notes, recordings, package folders, screenshots, or manifest output.
- After external tester feedback has been collected with `.codex/playbooks/crate-tester-intake.md`.
- Before converting QA findings into `.codex/playbooks/crate-bug-triage.md`.
- Before deciding whether to use `.codex/playbooks/crate-reprobox.md`, `.codex/playbooks/crate-package-diff.md`, `.codex/playbooks/crate-provenance-snapshot.md`, `.codex/playbooks/crate-security-scan.md`, or `.codex/playbooks/crate-release-gate.md`.
- Before final `v2.8.0` release consideration when QA results need to be summarized without changing release state.

## Start Prompt
Use a prompt like:

```text
Use .codex/playbooks/crate-qa-results-synthesizer.md to synthesize these Jenna or tester QA results. Ingest notes, recordings, package folder inventory, optional Crate Diagnostics/crate-provenance.json if diagnostic reports were enabled, expected versus actual package contents, scope behavior, missing and wrong assets, provenance confusion, install warnings, classify each result, map to next playbook, and do not modify app code or approve release.
```

## Inputs To Collect
- QA source:
  - Jenna internal QA
  - external tester
  - Bryant manual QA
  - synthetic fixture run
- Crate version:
  - public production release
  - internal QA prerelease
  - local branch
- macOS version and install/update state
- source app versions when available
- assigned workflow
- expected package contents
- expected exclusions
- Figma scope setting:
- Current Page Only
- Entire File
- unknown
- package output folder path or redacted inventory
- optional `Crate Diagnostics/crate-provenance.json` path or redacted summary when diagnostic reports were enabled
- screen recording path or approved link
- screenshots
- missing asset reports
- wrong or extra asset reports
- provenance confusion reports
- install, Gatekeeper, permission, crash, update, or security warnings
- privacy restrictions
- follow-up questions

## Files Codex May Read
- `AGENTS.md`
- `.codex/playbooks/*.md`
- `docs/*.md`
- approved QA notes
- approved screen-recording metadata and screenshots
- approved package output folders
- approved optional `Crate Diagnostics/crate-provenance.json` diagnostic manifests
- redacted package inventories
- redacted manifest summaries
- GitHub issues and PR metadata through `gh`
- `package.json` read-only, for version context only

## Files Codex May Modify
- None by default.
- With Bryant's explicit approval, temporary QA synthesis reports under `/private/tmp/crate-qa-results-*`.
- With Bryant's explicit approval for process docs, `.codex/playbooks/*.md`, `docs/*.md`, or `AGENTS.md` playbook references.
- With Bryant's explicit approval, GitHub issue drafts or comments. Do not create or post them remotely without explicit approval.

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
- package outputs
- private client files
- tester source assets

## Read-Only Commands Codex May Run
Capture repo and branch context:

```sh
git status --short --branch
git branch --show-current
git rev-parse --short HEAD
git rev-parse --short origin/v2.4.x
git diff --name-only
git diff --stat
```

Inspect approved package output inventory:

```sh
find <approved-package-output> -maxdepth 5 -type f | sort
diagnostic_manifest="<approved-package-output>/Crate Diagnostics/crate-provenance.json"
test -f "$diagnostic_manifest"
du -sh <approved-package-output>
```

Diagnostic reports are optional and off by default. Enable `Include diagnostic report in packages` before expecting `Crate Diagnostics/crate-provenance.json`; do not expect a package-root manifest in default package output.

Summarize the diagnostic manifest when approved:

```sh
node -e "const fs=require('fs'); const p=process.argv[1]; const m=JSON.parse(fs.readFileSync(p,'utf8')); const pkg=m.package||m; const legacyErrors=Array.isArray(pkg.errors)?pkg.errors:[]; const count=(items,key)=>(items||[]).reduce((a,x)=>{const k=x&&x[key]||'unknown'; a[k]=(a[k]||0)+1; return a;},{}); console.log(JSON.stringify({file:p,schemaVersion:m.schemaVersion,scope:m.scope||'legacy',copiedCount:pkg.copiedCount,embeddedCount:pkg.embeddedCount,totalFiles:pkg.totalFiles,errorCount:Number.isSafeInteger(pkg.errorCount)?pkg.errorCount:legacyErrors.length,errorCategories:pkg.errorCategories||{},nodesByType:count(m.nodes,'type'),edgesByType:count(m.edges,'relationType'),warnings:m.warnings||[]}, null, 2));" "$diagnostic_manifest"
```

Check manifest privacy before sharing:

```sh
rg -n "token|secret|credential|Authorization|Bearer|cookie|password|passkey|cdn\\.figma|rawTrackedFiles|/usr/sbin/lsof|notary" "$diagnostic_manifest"
```

Compare expected and actual package inventories when Bryant provides an expected list:

```sh
sort <expected-files.txt> > /private/tmp/crate-qa-results-<id>-expected.txt
find <approved-package-output> -maxdepth 5 -type f | sort > /private/tmp/crate-qa-results-<id>-actual.txt
comm -23 /private/tmp/crate-qa-results-<id>-expected.txt /private/tmp/crate-qa-results-<id>-actual.txt
comm -13 /private/tmp/crate-qa-results-<id>-expected.txt /private/tmp/crate-qa-results-<id>-actual.txt
```

Inspect approved recording or screenshot metadata without uploading assets:

```sh
ls -lh <approved-recording-or-screenshot>
shasum -a 256 <approved-recording-or-screenshot>
```

Inspect existing GitHub issues before recommending a new issue:

```sh
gh issue list --state open --search "<short symptom keywords>" --json number,title,labels,updatedAt,url
gh pr list --state open --search "<short symptom keywords>" --json number,title,headRefName,baseRefName,isDraft,updatedAt,url
```

Run docs-only checks after editing this playbook or a QA synthesis report in the repo:

```sh
git diff --check
rg -n "[[:blank:]]$" AGENTS.md .codex/playbooks docs
rg -n "[^[:ascii:]]" AGENTS.md .codex/playbooks docs
```

## Result Classification
Classify every finding as one primary result:

- Pass:
  - Evidence matches the assigned workflow, expected package contents, expected exclusions, and known provenance limitations.
- Fail:
  - Evidence shows Crate violated expected behavior, included wrong or private assets, missed required assets, failed packaging, exposed sensitive data, or produced materially misleading output.
- Inconclusive:
  - Evidence is insufficient, private artifacts cannot be inspected, or the workflow cannot be reconstructed fairly.
- Expected limitation:
  - Behavior matches a known and accepted current limitation, and the report should not become a code bug unless messaging needs improvement.
- Product requirement gap:
  - Tester expectation is reasonable but not currently specified, implemented, or decided.
- Needs reprobox:
  - Isolated reproduction is needed before code work, especially when local state, private assets, cloud files, app versions, or dirty branches could affect the result.
- Needs bug triage:
  - Evidence is actionable enough to classify bug type, severity, reproduction needs, and next engineering scope.

Secondary tags may include:

- missing asset
- wrong asset
- extra asset
- duplicate asset
- Figma Current Page Only mismatch
- Figma Entire File mismatch
- package failure
- manifest parse failure
- provenance overclaim
- provenance underclaim
- confusing warning
- install/security warning
- privacy risk
- tester setup issue
- release blocker

## Severity Rubric
- P0:
  - private or unrelated asset exposure
  - destructive file behavior
  - credential, token, signed URL, cookie, or private raw command output exposure
  - install or security issue blocks all QA
- P1:
  - assigned workflow cannot package
  - expected key asset is missing
  - wrong asset is included
  - package scope widens silently for Figma Current Page Only
  - manifest materially overclaims certainty in a way that can mislead release or tester trust
- P2:
  - provenance graph, warning, count, or confidence issue with no privacy exposure
  - secondary expected asset missing
  - confusing UI or message causes likely misuse but has a workaround
  - repeatable package discrepancy in a bounded workflow
- P3:
  - expected current limitation needing clearer wording
  - low-risk docs, process, or tester-instruction gap
  - cosmetic package or report issue

## Package And Provenance Review Checklist
- Does the package folder exist?
- Does it contain `Crate Diagnostics/crate-provenance.json` when diagnostic reports were enabled?
- Does the manifest parse as JSON?
- Do `copiedCount`, `embeddedCount`, and `totalFiles` align with the package contents? For schema v2, do `errorCount` and fixed `errorCategories` align? For schema v1, compare only the derived legacy error count and do not print raw error strings.
- Are expected assets present?
- Are expected exclusions absent?
- Are wrong, unrelated, other-page, private, or out-of-scope assets absent?
- Does Current Page Only include only current-page eligible assets?
- Does Entire File include eligible multi-page assets without pulling unrelated files?
- Are missing asset reports supported by package inventory or recording evidence?
- Are wrong or extra asset reports supported by package inventory or recording evidence?
- Are provenance confidence bands conservative and explainable?
- Does the manifest avoid tokens, credentials, signed URLs, cookies, raw command output, and private unrelated paths?
- Are warnings understandable and tied to observed limitations?
- Are install or security warnings captured with screenshot, recording timestamp, macOS version, and Crate version?

## Map To Next Playbook
- Use `.codex/playbooks/crate-bug-triage.md` when the finding is actionable and needs bug type, severity, issue draft, or fix scope.
- Use `.codex/playbooks/crate-reprobox.md` when isolated reproduction is needed or private/local state makes the evidence ambiguous.
- Use `.codex/playbooks/crate-package-diff.md` when before/after package contents, counts, copied files, embedded extracts, or expected exclusions need comparison.
- Use `.codex/playbooks/crate-provenance-snapshot.md` when manifest graph shape, confidence bands, warnings, evidence, or privacy minimization need structured comparison.
- Use `.codex/playbooks/crate-security-scan.md` when private data, secrets, paths, shell behavior, package containment, install warnings, or filesystem boundaries are implicated.
- Use `.codex/playbooks/crate-release-gate.md` when QA results support considering a final release and Bryant wants strict release-readiness validation.

## When To Create A GitHub Issue
Create an issue draft when:

- the finding is fail, product requirement gap, needs reprobox, or needs bug triage
- the report can be described without exposing private tester or client assets
- the issue is not already covered by an open issue
- expected behavior and actual behavior are clear enough to preserve
- severity and next playbook can be named

Do not create the issue remotely without Bryant's explicit approval.

## When To Create A Fix PR
Recommend a fix PR only when:

- the finding is a real or likely bug
- the reproduction path is known or can be made synthetic
- expected behavior is already decided
- privacy constraints allow enough evidence for engineering
- no release mutation is required just to investigate

Use `.codex/playbooks/clawpatch-fix.md` for a narrow fix after Bryant approves implementation scope.

## When To Hold Release
Recommend holding final release when:

- any P0 is present
- any P1 affects a core promised workflow for the target release
- package output includes wrong, private, unrelated, or out-of-scope assets
- Current Page Only silently widens scope
- `Crate Diagnostics/crate-provenance.json` exposes secrets or materially overclaims certainty
- install or security warnings block internal QA
- Jenna QA is incomplete and Bryant has not waived it
- `.codex/playbooks/crate-release-gate.md` has not validated readiness

## When To Proceed Toward Final v2.8.0
Recommend proceeding toward final `v2.8.0` only when:

- Jenna QA has either passed or Bryant explicitly accepts remaining limitations
- no unresolved P0 or release-blocking P1 remains
- expected limitations are documented and not privacy or data-loss risks
- package output and optional `Crate Diagnostics/crate-provenance.json` evidence match the release's evidence-aware promise
- `get-crate.com` is still held until final release approval
- next step is `.codex/playbooks/crate-release-gate.md`, not direct build, tag, release, or deploy

## Approval Gates
Codex may inspect approved QA artifacts and draft a synthesis report. Bryant must explicitly approve access to private artifacts, creating package outputs, opening issues, starting implementation, committing, pushing, merging, building, tagging, releasing, notarizing, deploying, or changing site state.

Commands requiring explicit Bryant approval:

```sh
npm start
git switch <branch>
git checkout <branch>
git worktree add <path> <ref>
gh issue create
gh issue edit <issue>
gh pr edit <pr>
gh pr comment <pr>
git add <files>
git commit
git push
gh pr merge <pr>
npm install
npm ci
npm audit fix
npx electron-builder --mac --arm64
xcrun notarytool submit <artifact> --wait
xcrun stapler staple <artifact>
xcrun stapler validate <artifact>
git tag <tag>
gh release create <tag>
npx wrangler pages deploy <directory>
```

## Must Never Do
- Do not blame the tester without evidence.
- Do not expose private tester, client, credential, token, signed URL, local path, or unrelated asset data.
- Do not claim a bug is fixed without tests or explicit verification evidence.
- Do not approve final release without `.codex/playbooks/crate-release-gate.md` validation.
- Do not treat a product requirement gap as an implementation bug until Bryant decides the requirement.
- Do not treat expected limitations as release-safe when they expose private data, include wrong assets, or contradict the release promise.
- Do not modify app code, tests, package files, release artifacts, package outputs, or site files.
- Do not build, release, deploy, notarize, tag, merge, or mutate dependencies.

## Quality Impact
- Reduces bugs by turning raw QA observations into evidence-based classifications before engineering starts.
- Speeds Crate development by routing each finding to the right next playbook instead of mixing QA, triage, reproduction, and fixing.
- Protects tester and client privacy by making artifact access and redaction explicit.
- Prevents release mistakes by separating "QA looks acceptable" from release-gate validation.
- Keeps v2.8.0 framed as evidence-aware and conservative rather than perfect provenance.

## Definition Of Done
- QA source, version, workflow, expected behavior, actual behavior, and privacy constraints are captured.
- Package output and optional `Crate Diagnostics/crate-provenance.json` are reviewed when approved and available.
- Missing, wrong, extra, and expected-exclusion findings are classified.
- Current Page Only versus Entire File behavior is assessed when Figma is involved.
- Install/security warnings are classified and routed.
- Each finding has severity, next playbook, issue/PR/release recommendation, and evidence status.
- No app code, tests, package files, release artifacts, site files, builds, tags, deploys, dependencies, package outputs, or private assets are changed.

## Report Format
- QA synthesis:
  - Source:
  - Crate version:
  - Workflow:
  - Artifacts reviewed:
  - Privacy constraints:
- Current state:
  - Package output:
  - `Crate Diagnostics/crate-provenance.json`:
  - Figma scope:
  - Install/security state:
- Findings:
  - Finding:
  - Classification:
  - Severity:
  - Evidence:
  - Expected:
  - Actual:
  - Privacy notes:
  - Next playbook:
  - Issue recommendation:
  - Fix PR recommendation:
  - Release impact:
- Summary:
  - Passes:
  - Fails:
  - Inconclusive:
  - Expected limitations:
  - Product requirement gaps:
  - Needs reprobox:
  - Needs bug triage:
- Hold or proceed:
  - Release hold:
  - Proceed toward final `v2.8.0`:
  - Next required approval:
- Commands run:
- Files changed:
- Whether Bryant can proceed:
