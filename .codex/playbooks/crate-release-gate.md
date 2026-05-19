# Crate Release Gate Playbook

## Purpose
Run a strict pre-release and release-readiness gate for Crate before any release mutation begins.

This playbook is not the release runner. It is the gate that proves Crate is on the right branch, includes the intended merged PRs, has a clean working tree, has passing checks, and is ready for Bryant to approve each release mutation step.

## When To Use
- After Bryant says a release is being considered, but before version bump, build, signing, notarization, tagging, GitHub release creation, site deploy, or live verification.
- After intended PRs have merged into `v2.4.x`.
- Before using `.codex/playbooks/release-crate.md`.
- When Bryant wants a hard stop between "looks ready" and "start release mutation."
- When release assets, `latest-mac.yml`, blockmaps, site links, or GitHub release assets need consistency verification.

## Start Prompt
Use a prompt like:

```text
Use .codex/playbooks/crate-release-gate.md for Crate <version>. Run read-only gate checks first. Do not bump, build, sign, notarize, tag, create a release, deploy, or verify live production until Bryant approves each step.
```

## Inspect
- Current branch is `v2.4.x`.
- Local `v2.4.x` is up to date with `origin/v2.4.x`.
- Working tree is clean before release mutation.
- Intended merged PRs are present in the release history.
- No unmerged feature, docs-only process branch, or active Figma provenance work is accidentally included unless Bryant intended it.
- `package.json` version, product name, app ID, build config, and release target are correct.
- `package-lock.json` matches the intended dependency state.
- Relevant tests pass.
- Build artifact names, version numbers, checksums, `latest-mac.yml`, blockmaps, GitHub release assets, `crate-site/index.html`, Cloudflare deploy output, and live `get-crate.com` response agree.

## Files Codex May Read
- `AGENTS.md`
- `.codex/playbooks/*.md`
- `package.json`
- `package-lock.json`
- `main.js`, `preload.js`, `renderer/`, `parsers/`, `scripts/`, and `tests/` for release-readiness context
- `docs/*.md`
- `crate-site/index.html`
- `dist/` and release artifacts after an approved build exists
- PR metadata, release metadata, and deploy metadata through `gh`, `git`, `curl`, and approved deploy tooling

## Files Codex May Modify
- None during the read-only release gate.
- After Bryant explicitly moves from gate to release execution, use `.codex/playbooks/release-crate.md` for approved version bumps, release file edits, commits, tags, GitHub releases, and deploys.

## Files Codex Must Not Modify
- Any file during read-only gate checks.
- `main.js`
- tests
- `package.json`
- `package-lock.json`
- `crate-site/index.html`
- release artifacts
- tags, GitHub releases, Cloudflare deploys, or live site state

## Read-Only Commands Codex May Run
Confirm branch, cleanliness, and intended history:

```sh
git status --short --branch
git branch --show-current
git fetch origin
git rev-parse HEAD
git rev-parse origin/v2.4.x
git log --oneline --decorate -n 30
git diff --name-only
git diff --check
```

Inspect release metadata without mutating it:

```sh
node -p "require('./package.json').version"
node -p "require('./package.json').productName"
node -p "require('./package.json').build.appId"
node -p "require('./package.json').build.mac.target"
git diff -- package.json package-lock.json crate-site/index.html
```

Run release-readiness tests only after Bryant approves test execution:

```sh
node --check main.js
node tests/provenance.test.js
node tests/provenance-dual-write.test.js
node tests/psd-embedded-safety.test.js
node tests/figma-scope.test.js
node tests/figma-link-per-project.test.js
```

Inspect existing remote release and production state read-only:

```sh
gh release view <tag>
gh release view <tag> --json tagName,name,isDraft,isPrerelease,assets,publishedAt,url
curl -I https://get-crate.com/
```

After an approved build exists, inspect local artifact metadata. Run signing, Gatekeeper, notarization, stapling, DMG, and live-site validation commands only after Bryant approves those checks:

```sh
ls -la dist
shasum -a 256 dist/*.dmg dist/*.zip dist/*.yml dist/*.blockmap
sed -n '1,220p' dist/latest-mac.yml
codesign --verify --deep --strict --verbose=4 <path-to-app>
spctl --assess --type execute --verbose <path-to-app>
spctl -a -t open --context context:primary-signature -v <path-to-dmg>
xcrun stapler validate <path-to-app-or-dmg>
curl -L -s -H "Cache-Control: no-cache" https://get-crate.com/
```

## Required Gate Checks
- Branch gate: release must run from `v2.4.x`, not `main`, not a feature branch, and not an active worktree with dirty changes.
- Merge gate: intended PRs are merged into `v2.4.x`; unintended branches are not included.
- Clean gate: working tree is clean before version bump or build.
- Test gate: relevant focused tests pass before build.
- Metadata gate: package version, app name, app ID, target architecture, and release target match the intended release.
- Build gate: `npx electron-builder --mac --arm64` succeeds only after Bryant approves build.
- App signing gate: built app bundle passes codesign and Gatekeeper assessment.
- App notarization/stapling gate: app notarization and stapling status are validated when applicable.
- DMG envelope gate: DMG signing, notarization, stapling, and primary-signature assessment are validated.
- Update metadata gate: `latest-mac.yml` and `.blockmap` files match the built artifact names, versions, sizes, and checksums.
- GitHub release gate: GitHub release assets exist before site links are updated or deployed.
- Site gate: `crate-site/index.html` points to the intended GitHub release asset only after the asset exists.
- Deploy gate: Cloudflare Pages deploy happens only after GitHub release assets and site links are correct.
- Live gate: `get-crate.com` is verified after deploy, with cache-busting, against the expected DMG URL and version.

## Approval Gates
No release mutation may run until Bryant approves that exact step. Approval must name the target version and expected result.

Commands requiring explicit Bryant approval:

```sh
git pull origin v2.4.x
npm version <version>
npx electron-builder --mac --arm64
codesign --force --sign <identity> <artifact>
xcrun notarytool submit <artifact> --wait
xcrun stapler staple <artifact>
xcrun stapler validate <artifact>
spctl --assess --type execute --verbose <path-to-app>
spctl -a -t open --context context:primary-signature -v <path-to-dmg>
git add <release-files>
git commit -m "Release <version>"
git tag <tag>
git push origin v2.4.x
git push origin <tag>
gh release create <tag> <artifacts>
gh release upload <tag> <artifacts>
npx wrangler pages deploy <directory>
curl -L -s -H "Cache-Control: no-cache" https://get-crate.com/
```

Hard ordering rules:

- No version bump until branch, merge, clean, test, and metadata gates pass.
- No tag until build, signing, notarization, stapling, and artifact validation pass.
- No GitHub release until the tag and release assets are correct.
- No site deploy until GitHub release assets exist and `crate-site/index.html` points to them.
- No live production verification until deploy has completed.

## Must Never Do
- Do not start a release from any branch other than `v2.4.x`.
- Do not run build, signing, notarization, stapling, tagging, GitHub release, deploy, or live production verification without explicit Bryant approval for that step.
- Do not deploy site links before GitHub release assets exist.
- Do not tag before build, signing, notarization, and validation pass.
- Do not include unmerged feature work, dirty worktree files, or active Figma provenance changes unless Bryant explicitly scopes them into the release.
- Do not mutate dependencies or package files except as part of an approved release step.
- Do not expose Apple credentials, API tokens, notarization secrets, or deploy credentials in output.

## Quality Impact
- Prevents accidental releases from the wrong branch or dirty checkout.
- Forces release artifact, metadata, site, and live URL consistency before users see a download.
- Separates readiness proof from release mutation so Bryant can approve each step deliberately.
- Catches common macOS release failures around app signing, DMG envelope validation, notarization, stapling, `latest-mac.yml`, and blockmaps.
- Speeds release work by turning the release into ordered gates instead of a loose checklist.

## Definition Of Done
- Branch, HEAD SHA, `origin/v2.4.x` SHA, and working tree cleanliness are reported.
- Intended PRs are confirmed merged or listed as blockers.
- Tests run or approval/test gap is stated.
- Package metadata and release target are checked.
- Build/sign/notarization/stapling, GitHub release, site deploy, and live checks are either verified or explicitly blocked pending Bryant approval.
- No release mutation occurred unless separately approved.
- Bryant receives the next approved-safe action.

## Report Format
- Target release version and current branch.
- Gate status: branch, merge, clean, test, metadata, build, signing, notarization, DMG, update metadata, GitHub release, site, deploy, live.
- Commands run and important outputs.
- Files changed, if any approved release step occurred.
- Blockers and risks.
- Next approval needed.
- Whether Bryant can proceed to `.codex/playbooks/release-crate.md`.
