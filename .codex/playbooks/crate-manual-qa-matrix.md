# Crate Manual QA Matrix Playbook

## Purpose
Define repeatable manual QA workflows for Crate before tester rollout and before releases.

Manual QA validates real designer behavior, cross-app workflows, scope choices, package output, and provenance output. It is not a substitute for automated tests. It complements automated tests by exercising GUI state, designer habits, cloud/local storage, and package review in ways automated tests do not yet cover.

Provenance may be partial and should not overclaim certainty. Reports must distinguish confirmed package actions from likely, candidate, weak, missing, or unknown relationships.

## Stable Lane IDs

These IDs are referenced by the canonical feature inventory. They identify procedures, not current pass results.

| Lane ID | Procedure owner |
| --- | --- |
| `install-launch` | `docs/crate/qa-smokes/smoke-01-install-launch.md` |
| `projects-current-project` | Projects / Current Project installed-app workflow |
| `multi-app-capture` | Workflow Matrix creative-app lanes below |
| `quick-package` | `docs/crate/qa-smokes/smoke-03-quick-package.md` |
| `package-review-complete-details` | Package Output Review below |
| `illustrator-no-save-linked-jpg` | `docs/crate/qa-smokes/smoke-02-illustrator-no-save-linked-jpg.md` |
| `figma-scope` | `docs/crate/qa-smokes/smoke-04-figma-scope.md` |
| `figma-errors-privacy` | Figma workflow lanes plus privacy checks below |
| `package-details-diagnostics` | `docs/crate/qa-smokes/smoke-07-package-details-diagnostics.md` |
| `quota-limit-no-output` | Quota block installed-app lane |
| `idle-alert-buttons` | Keep Watching / Pause / Package Now installed-app lane |

## When To Use
- Before external tester rollout.
- Before release readiness when recent PRs affect Figma, Adobe, PowerPoint, package output, provenance, parser behavior, privacy, or install flow.
- After tester feedback identifies a workflow that should become repeatable.
- Before or after using `.codex/playbooks/crate-package-diff.md` or `.codex/playbooks/crate-provenance-snapshot.md`.
- When Bryant wants a checklist for manual validation rather than a code change.

## Start Prompt
Use a prompt like:

```text
Use .codex/playbooks/crate-manual-qa-matrix.md to run or prepare Crate manual QA. Cover assigned workflows, expected package contents, expected provenance signals, expected exclusions, screenshots, recordings, pass/fail criteria, known limitations, and do not modify app code or release state.
```

## QA Principles
- Manual QA is not a substitute for automated tests.
- Manual QA is used to validate real designer behavior.
- Use synthetic, minimal, or explicitly cleared project files whenever artifacts will be shared.
- Use real designer workflows where possible, but do not upload private or confidential client work unless cleared.
- Preserve package outputs and optional `Crate Diagnostics/crate-provenance.json` diagnostic manifests for review when diagnostic reports were enabled.
- Record what Crate did, not what the tester hoped it did.
- Provenance may be partial and should not overclaim certainty.
- Expected exclusions matter as much as expected inclusions.
- Multiple apps open with unrelated files must be tested because wrong-context capture is a core risk.

## Setup Checklist
Before running workflows:

- Confirm Crate version or branch under test.
- Confirm macOS version.
- Confirm source app versions when relevant.
- Confirm whether files are synthetic, cleared, or private.
- Confirm package output root.
- Confirm Figma scope setting where relevant.
- Confirm cloud-drive files are available offline if needed.
- Confirm external drives are mounted if used.
- Start screen recording for each workflow.
- Prepare screenshots of source setup, Crate choices, package output, and manifest review.

## Files Codex May Read
- `AGENTS.md`
- `.codex/playbooks/*.md`
- `docs/*.md`
- approved fixture docs and synthetic fixture assets
- approved package outputs under `/private/tmp` or another Bryant-approved path
- optional `Crate Diagnostics/crate-provenance.json` diagnostic manifests from manual QA packages when diagnostic reports were enabled
- `package.json` read-only for version/script context
- changed files and tests read-only when needed to map QA risk

## Files Codex May Modify
- None by default.
- With Bryant's explicit approval, Codex may write manual QA reports under `/private/tmp/crate-manual-qa-*`.
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
- private client files or tester assets

## Commands Codex May Run
Capture branch and docs state:

```sh
git status --short --branch
git branch --show-current
git rev-parse --short HEAD
git diff --name-only
git diff --stat
git diff --check
```

Inspect approved package outputs:

```sh
find <approved-package-output> -maxdepth 4 -type f | sort
diagnostic_manifest="<approved-package-output>/Crate Diagnostics/crate-provenance.json"
test -f "$diagnostic_manifest"
node -e "const fs=require('fs'); const p=process.argv[1]; const m=JSON.parse(fs.readFileSync(p,'utf8')); const pkg=m.package||m; const legacyErrors=Array.isArray(pkg.errors)?pkg.errors:[]; const count=(items,key)=>(items||[]).reduce((a,x)=>{const k=x&&x[key]||'unknown'; a[k]=(a[k]||0)+1; return a;},{}); console.log(JSON.stringify({schemaVersion:m.schemaVersion,scope:m.scope||'legacy',copiedCount:pkg.copiedCount,embeddedCount:pkg.embeddedCount,totalFiles:pkg.totalFiles,errorCount:Number.isSafeInteger(pkg.errorCount)?pkg.errorCount:legacyErrors.length,errorCategories:pkg.errorCategories||{},nodesByType:count(m.nodes,'type'),edgesByType:count(m.edges,'relationType'),warnings:m.warnings||[]}, null, 2));" "$diagnostic_manifest"
rg -n "token|secret|credential|Authorization|Bearer|cookie|cdn\\.figma|password|passkey|rawTrackedFiles|/usr/sbin/lsof" "$diagnostic_manifest"
```

Diagnostic reports are optional and off by default. Enable `Include diagnostic report in packages` before expecting `Crate Diagnostics/crate-provenance.json`; do not expect a package-root manifest in default package output.

Review multiple package outputs when a manual run creates them:

```sh
find <manual-qa-output-root> -path "*/Crate Diagnostics/crate-provenance.json" -type f | sort
find <manual-qa-output-root> -type f | sort
```

Run docs-only checks after editing this playbook:

```sh
git diff --check
rg -n "[[:blank:]]$" AGENTS.md .codex/playbooks
rg -n "[^[:ascii:]]" AGENTS.md .codex/playbooks
```

## Workflow Matrix
For every workflow, collect:

- setup screenshot
- action recording
- package output screenshot
- optional `Crate Diagnostics/crate-provenance.json` screenshot or redacted summary when diagnostic reports were enabled
- pass/fail result
- notes about expected exclusions and known limitations

### Figma Current Page Only
Setup:
- Use a Figma file with at least two pages.
- Put one image asset on the current page and one clearly different image asset on another page.
- Set Crate to Current Page Only.

Action:
- Package the Figma project from the current page.

Expected package contents:
- Current-page materialized image assets.
- Package metadata and `Crate Diagnostics/crate-provenance.json` when diagnostic reports are enabled.

Expected provenance signals:
- Figma file or page context.
- Packaged Figma assets represented as package-included or materialized resources.
- Scope should reflect Current Page Only behavior where Crate can resolve it.

Expected exclusions:
- Assets that only appear on other Figma pages.
- Unrelated local files and other app files.

Screenshots/recordings:
- Figma page list with current page visible.
- Crate scope setting.
- Package output folder.
- Manifest summary.

Pass/fail:
- Pass if current-page assets are included and other-page assets are excluded.
- Fail if other-page assets are included, current-page assets are missed, or page lock failure is hidden.

Known limitations:
- Provenance may not prove every internal Figma relationship.
- If page lock cannot resolve, Crate should fail closed rather than silently widening scope.

### Figma Entire File
Setup:
- Use a Figma file with assets on multiple pages.
- Set Crate to Entire File.

Action:
- Package the Figma project.

Expected package contents:
- Eligible captured assets from multiple pages.
- Manifest file when enabled.

Expected provenance signals:
- Figma file-level scope.
- Package includes captured materialized Figma resources.
- No claim that assets came only from the current page.

Expected exclusions:
- Assets outside the tracked Figma file.
- Unrelated local or app files.

Screenshots/recordings:
- Figma pages with distinct assets.
- Entire File scope selection.
- Package output and manifest summary.

Pass/fail:
- Pass if multi-page assets are included and unrelated files are excluded.
- Fail if only the current page is packaged or unrelated files are pulled in.

Known limitations:
- Entire File may still depend on what Crate can capture from Figma.
- Manifest should not overclaim page-level certainty.

### Figma Multi-Page Collaborative File
Setup:
- Use a collaborative Figma file with multiple pages and at least one contributor or shared library context when practical.
- Include distinct assets on separate pages.

Action:
- Package in Current Page Only and then, in a separate run, Entire File when approved.

Expected package contents:
- Current Page Only run includes only current-page captured assets.
- Entire File run includes eligible captured assets across pages.

Expected provenance signals:
- Figma file identity and scope mode.
- Warnings or partial notes when collaborative or library context cannot be fully proven.

Expected exclusions:
- Assets from unrelated files, teams, drafts, or libraries unless explicitly materialized into the tested file.

Screenshots/recordings:
- Figma page list and collaboration context.
- Scope setting for each run.
- Side-by-side package output inventories.

Pass/fail:
- Pass if scope behavior remains consistent across collaborative context.
- Fail if page scope widens silently, wrong files appear, or manifest overclaims library certainty.

Known limitations:
- Shared library and collaborator provenance may be partial.
- Do not expose private team or client file contents in artifacts.

### Figma Imported Local Image
Setup:
- Place a local image from a known folder into a Figma file.
- Keep the source local image available.
- Include at least one unrelated image in the same folder.

Action:
- Package the Figma workflow with the relevant scope.

Expected package contents:
- Captured or materialized Figma image asset when Crate can obtain it.
- The package should not include unrelated images just because they share a folder.

Expected provenance signals:
- Figma materialization or package include signals.
- Local-source relationship only if Crate has evidence; otherwise mark as partial or unknown.

Expected exclusions:
- Unrelated images from the source folder.
- Other app files open at the same time.

Screenshots/recordings:
- Local folder before import.
- Figma canvas with imported image.
- Package output inventory.
- Manifest summary.

Pass/fail:
- Pass if the imported asset is packaged and unrelated local folder contents are excluded.
- Fail if Crate packages the whole source folder or misses the imported asset without a warning.

Known limitations:
- Figma may not preserve enough local source path evidence for a confirmed relationship.

### Figma Component Dependency
Setup:
- Use a Figma file with a component instance, preferably from a local component or shared library.
- Include visible asset differences between main file and component source when possible.

Action:
- Package the Figma file under the assigned scope.

Expected package contents:
- Assets materialized from the active Figma file and captured component output when eligible.

Expected provenance signals:
- Package includes materialized Figma resources.
- Component/library relationships should be partial unless Crate has direct evidence.

Expected exclusions:
- Unrelated library files, team files, or private assets not materialized into the tested file.

Screenshots/recordings:
- Component instance in context.
- Component source or library indicator if safe.
- Package output and manifest summary.

Pass/fail:
- Pass if visible materialized component assets needed by the package are present and unrelated library assets are absent.
- Fail if unrelated library assets are included or manifest claims confirmed library provenance without evidence.

Known limitations:
- Component dependency provenance may be partial.

### Photoshop To Figma
Setup:
- Create or use a PSD with at least one image asset.
- Export or place the result into Figma using the tester's normal workflow.
- Keep unrelated Photoshop files open if testing exclusion behavior.

Action:
- Package the final Figma workflow.

Expected package contents:
- Final Figma materialized assets.
- Eligible source or exported assets only when Crate has captured or scoped evidence.

Expected provenance signals:
- Figma package signals.
- Photoshop cross-app handoff should be likely, candidate, weak, or absent unless confirmed by structured evidence.

Expected exclusions:
- Unrelated PSDs or Photoshop assets not used in the workflow.

Screenshots/recordings:
- PSD source.
- Handoff step into Figma.
- Crate packaging step.
- Package output and manifest summary.

Pass/fail:
- Pass if final workflow assets are packaged and unrelated open Photoshop files are excluded.
- Fail if wrong Photoshop assets are included or a required handoff asset is missed without explanation.

Known limitations:
- Cross-app handoff evidence may be partial and should not overclaim certainty.

### Photoshop To PowerPoint
Setup:
- Use a PSD or exported image from Photoshop.
- Place the result into PowerPoint.
- Keep the PSD and export folder available.

Action:
- Package the PowerPoint workflow.

Expected package contents:
- PowerPoint file and eligible embedded or linked media.
- Exported Photoshop asset if it is part of the packaged workflow and Crate can identify it.

Expected provenance signals:
- PowerPoint package and embedded media signals.
- Photoshop source relationship only when supported by evidence.

Expected exclusions:
- Unrelated PSDs, exports, or open Photoshop documents.

Screenshots/recordings:
- Photoshop export.
- PowerPoint slide with placed asset.
- Package output and manifest summary.

Pass/fail:
- Pass if PowerPoint media needed by the deck is included and unrelated Photoshop material is excluded.
- Fail if package misses visible deck media or includes unrelated open Photoshop files.

Known limitations:
- Export provenance may be candidate-level if the same basename appears in multiple folders.

### Illustrator To InDesign
Setup:
- Place an Illustrator file or exported graphic into an InDesign document.
- Include at least one unrelated Illustrator file in the same folder or open in Illustrator.

Action:
- Package the InDesign workflow.

Expected package contents:
- InDesign document and eligible placed Illustrator/PDF/image assets.

Expected provenance signals:
- InDesign placed-link or parser evidence where available.
- Package include relationships for copied files.

Expected exclusions:
- Unrelated Illustrator files and unused links.

Screenshots/recordings:
- InDesign Links panel or equivalent source view.
- Illustrator source if safe.
- Package output and manifest summary.

Pass/fail:
- Pass if placed assets are included and unused Illustrator files are excluded.
- Fail if a placed file is missed or unrelated Illustrator files are included.

Known limitations:
- InDesign link evidence may depend on file availability and parser support.

### Illustrator To PowerPoint
Setup:
- Export an Illustrator asset or place/copy it into PowerPoint.
- Include an unrelated Illustrator file nearby.

Action:
- Package the PowerPoint workflow.

Expected package contents:
- PowerPoint deck and embedded or linked media created from the Illustrator workflow when eligible.

Expected provenance signals:
- PowerPoint embedded media or package include signals.
- Illustrator source relationship only when supported by evidence.

Expected exclusions:
- Unrelated Illustrator files, unused exports, and other open app files.

Screenshots/recordings:
- Illustrator source/export.
- PowerPoint slide.
- Package output and manifest summary.

Pass/fail:
- Pass if visible deck media is included and unrelated Illustrator files are excluded.
- Fail if deck media is missed or source relationship is overclaimed.

Known limitations:
- Clipboard or export handoffs may not provide confirmed source provenance.

### PSD Linked Smart Object
Setup:
- Use a PSD containing a linked smart object that points to a local file.
- Keep the linked file available.
- Add an unrelated file in the linked file's folder.

Action:
- Package the PSD workflow.

Expected package contents:
- PSD.
- Linked smart object source file when eligible.
- Manifest file when enabled.

Expected provenance signals:
- `container_references_file` for the linked asset when parser evidence supports it.
- `package_includes_file` for copied files.

Expected exclusions:
- Unrelated files in the linked asset folder.
- Embedded extraction files unless the PSD also contains embedded resources.

Screenshots/recordings:
- Photoshop linked smart object panel or layer state if safe.
- Source folder.
- Package output and manifest summary.

Pass/fail:
- Pass if linked source is included and unrelated folder contents are excluded.
- Fail if linked source is missed, unrelated files are included, or relationship confidence is wrong.

Known limitations:
- Missing linked files should be reported as warnings or partial evidence, not silently confirmed.

### PSD Embedded Smart Object
Setup:
- Use a PSD with an embedded smart object or embedded image resource.
- Include unrelated files in the same folder to verify exclusion.

Action:
- Package the PSD workflow.

Expected package contents:
- PSD.
- Sanitized extracted embedded resource files when supported.
- Manifest file when enabled.

Expected provenance signals:
- `container_embeds_resource`.
- `package_extracts_resource`.
- `resource_materialized_as_file` for extracted files.

Expected exclusions:
- Unrelated local files.
- Linked asset claims unless the asset is actually linked.

Screenshots/recordings:
- PSD layer state if safe.
- Package output with extracted files.
- Manifest summary.

Pass/fail:
- Pass if embedded resources extract safely with sanitized names and unrelated files stay out.
- Fail if extraction escapes package boundaries, misses expected embedded resource, or mislabels embedded as linked.

Known limitations:
- Parser support may not cover every PSD embedded format.

### PowerPoint Embedded Media
Setup:
- Use a PPTX with at least one embedded image and one embedded video or audio file when practical.
- Include unrelated media nearby.

Action:
- Package the PowerPoint workflow.

Expected package contents:
- PPTX.
- Extracted embedded media when supported.
- Manifest file when enabled.

Expected provenance signals:
- PowerPoint container evidence.
- `package_extracts_resource` or equivalent extraction signal.
- Package counts reflect embedded media.

Expected exclusions:
- Unrelated local media not embedded in the deck.

Screenshots/recordings:
- Slide with embedded media.
- Package output media folder.
- Manifest summary.

Pass/fail:
- Pass if embedded media is included and unrelated local media is excluded.
- Fail if visible embedded media is missed or external nearby media is included.

Known limitations:
- Keynote and PowerPoint may differ; do not generalize one result to the other without testing.

### Local Downloads Asset To Destination App
Setup:
- Put a test image or media file in Downloads.
- Use it in Figma, Photoshop, Illustrator, InDesign, PowerPoint, or Keynote.
- Add unrelated files in Downloads.

Action:
- Package the destination app workflow.

Expected package contents:
- Destination document and eligible used asset.

Expected provenance signals:
- Destination-app evidence or package include signals.
- Downloads source relationship only when Crate has evidence.

Expected exclusions:
- Other Downloads files.
- Private unrelated downloads.

Screenshots/recordings:
- Downloads folder before workflow.
- Destination app showing the asset.
- Package output and manifest summary.

Pass/fail:
- Pass if the used Downloads asset is included and unrelated Downloads files are excluded.
- Fail if Crate packages broad Downloads contents or misses the used asset without explanation.

Known limitations:
- Downloads often contains private unrelated files; use synthetic files for shareable QA.

### External Drive Or Custom Folder Asset To Destination App
Setup:
- Mount an external drive or use a custom local folder.
- Place a test asset in that location and use it in a destination app.
- Include unrelated files in the same location.

Action:
- Package the destination app workflow.

Expected package contents:
- Destination document and eligible used asset.

Expected provenance signals:
- Package includes used asset when available.
- Warning or partial evidence when the external drive is disconnected or file is unavailable.

Expected exclusions:
- Unrelated files on the external drive or custom folder.

Screenshots/recordings:
- Mounted drive or folder.
- Destination app context.
- Package output and manifest summary.

Pass/fail:
- Pass if used external/custom asset is included and unrelated files are excluded.
- Fail if Crate pulls broad drive contents, misses an available linked asset, or hides missing-drive errors.

Known limitations:
- Disconnected drives and cloud placeholders may prevent confirmed inclusion.

### Multiple Apps Open With Unrelated Files
Setup:
- Open multiple creative apps with unrelated files.
- Prepare one assigned workflow as the package target.
- Keep unrelated files visible but clearly not part of the target.

Action:
- Package only the assigned workflow.

Expected package contents:
- Target workflow files and eligible dependencies only.

Expected provenance signals:
- Target package signals.
- Non-target app observations should be absent, weak, or explicitly rejected if represented.

Expected exclusions:
- Files from unrelated open apps.
- Files from unrelated windows, tabs, pages, or decks.

Screenshots/recordings:
- All open apps before packaging.
- Target selection in Crate.
- Package output and manifest summary.

Pass/fail:
- Pass if unrelated open app files are excluded.
- Fail if wrong app context is packaged or manifest overclaims unrelated app relationships.

Known limitations:
- Ambient app observations can be weak context but must not become confirmed package relationships without evidence.

### Package Output Review
Setup:
- Use package output from any manual QA workflow.
- Preserve the output exactly as Crate produced it.

Action:
- Review file tree, counts, copied files, extracted files, errors, and containment.

Expected package contents:
- Expected files for the specific workflow.
- `Crate Diagnostics/crate-provenance.json` when diagnostic reports were enabled.

Expected provenance signals:
- Package copy and extraction edges for files Crate actually wrote.

Expected exclusions:
- Unrelated private files.
- Files outside the intended package root.
- Temp files that should not ship in package output.

Screenshots/recordings:
- Full package folder tree.
- File count summary.
- Any unexpected or missing files.

Pass/fail:
- Pass if included, excluded, counts, and containment match the workflow expectation.
- Fail if unexpected private files, wrong assets, missing required assets, or path escape issues appear.

Known limitations:
- File tree review does not prove source provenance by itself.

### Crate Diagnostics/crate-provenance.json Review
Setup:
- Use the diagnostic manifest from any manual QA package where `Include diagnostic report in packages` was enabled.
- Work from a redacted copy if privacy requires it.

Action:
- Parse the JSON and review counts, nodes, edges, evidence, warnings, confidence bands, and privacy-sensitive strings.

Expected package contents:
- Diagnostic manifest exists and parses when diagnostics were enabled.

Expected provenance signals:
- `package_includes_file` for copied files.
- `package_extracts_resource` for extracted resources.
- `container_references_file` for linked file evidence when supported.
- `container_embeds_resource` for embedded resource evidence when supported.
- `resource_materialized_as_file` for extracted or downloaded resources when supported.
- `pending_file_rejected` or equivalent evidence when Crate rejects out-of-scope candidates.

Expected exclusions:
- Tokens, credentials, cookies, signed URLs, raw API responses, raw command output, private unrelated paths, and unrelated personal files.

Screenshots/recordings:
- Manifest location in package output.
- Parsed summary.
- Privacy scan result.
- Any warning or suspicious edge.

Pass/fail:
- Pass if manifest parses, matches package behavior, preserves confidence distinctions, and avoids private data.
- Fail if manifest exposes secrets, overclaims certainty, omits material warnings, or contradicts package output.

Known limitations:
- Schema v2 manifests are intentionally minimized; omitted private fields are expected and should not be reported as failures.

## Required Checks
- Each selected workflow has setup, action, expected package contents, expected provenance signals, expected exclusions, screenshots/recordings, pass/fail criteria, and known limitations.
- Package output is preserved for each run.
- Optional `Crate Diagnostics/crate-provenance.json` is inspected or marked unavailable.
- Expected inclusions and exclusions are both reviewed.
- Privacy checks are run before any artifact is shared.
- Minimized or partial provenance is described accurately.
- Automated test gaps are stated; manual QA does not replace them.

## Approval Gates
Codex may prepare the matrix and inspect approved artifacts. Bryant must explicitly approve starting the app, using private project files, collecting or uploading package outputs, creating QA reports on disk, mutating git state, or changing release state.

Commands requiring explicit Bryant approval:

```sh
npm start
git add <files>
git commit
git push
gh issue create
gh pr create
gh pr merge <pr>
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
- Do not treat manual QA as a replacement for automated tests.
- Do not modify app code, tests, package files, release files, or active local cleanup tasks.
- Do not use private client work, private tester files, or personal documents unless Bryant explicitly approves that exact use.
- Do not upload package outputs, manifests, screenshots, or recordings containing private material without approval.
- Do not build, release, deploy, notarize, tag, merge, or mutate dependencies.
- Do not overclaim provenance certainty.
- Do not ignore expected exclusions.

## Quality Impact
- Makes tester rollout safer by validating real designer workflows before external sessions.
- Speeds Crate development by turning manual checks into repeatable workflow evidence.
- Catches wrong-asset, missed-asset, package-output, and manifest issues before they reach testers.
- Reduces privacy risk by requiring explicit exclusions and manifest privacy scans.
- Creates a bridge from manual observation to package diff, provenance snapshot, regression, and triage playbooks.

## Definition Of Done
- Selected workflows are run or marked not run with reasons.
- Package outputs, manifests, screenshots, recordings, pass/fail status, known limitations, and privacy results are recorded.
- Any failures are routed to bug triage or another appropriate playbook.
- Automated test gaps are stated.
- No app code, tests, package files, release files, builds, tags, deploys, or dependencies are changed.
- Bryant receives a clear pass/fail matrix and whether tester rollout or release readiness can proceed.

## Report Format
- Branch and dirty state when repo work was involved.
- Crate version or branch under test.
- QA environment.
- Workflow matrix with pass, fail, unclear, or not run.
- Package output paths.
- `Crate Diagnostics/crate-provenance.json` findings when diagnostics were enabled.
- Expected inclusions and exclusions.
- Privacy check results.
- Screenshots and recordings collected.
- Known limitations.
- Failures requiring triage.
- Commands run and results.
- Files changed, if any.
- Whether Bryant can proceed.
