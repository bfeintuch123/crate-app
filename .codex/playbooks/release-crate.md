# Release Crate Playbook

## Purpose
Run the standard Crate release flow from `v2.4.x` through version bump, macOS build, notarization, staple, validation, GitHub release, site update, Cloudflare Pages deploy, and live download verification.

## When To Use
- Only after Bryant says a release should begin.
- After the intended PRs have merged into `v2.4.x`.
- When preparing a signed macOS release artifact and updating `get-crate.com`.

## Start Prompt
Use a prompt like:

```text
Use .codex/playbooks/release-crate.md for Crate release <version>. Start with read-only readiness checks only. Do not pull, bump, build, notarize, tag, create a release, or deploy until Bryant approves that specific step.
```

## Inspect
- Current branch is `v2.4.x`.
- Working tree is clean before release changes begin.
- Local `v2.4.x` includes latest `origin/v2.4.x`.
- Version bump target and changelog/release notes are confirmed.
- Apple signing and notarization credentials are available without exposing secrets.
- `crate-site/index.html` points to the new release asset after the release artifact exists.
- GitHub release tag, uploaded DMG, Cloudflare Pages deployment, and `get-crate.com` live response all agree.

## Commands Codex May Run
```sh
git status --short --branch
git branch --show-current
git fetch origin
git log --oneline --decorate -n 20
git diff --name-only
gh release view <tag>
curl -I https://get-crate.com/
```

Read-only release checks are allowed. Do not begin release mutation without Bryant approval.

## Commands Requiring Explicit Bryant Approval
```sh
git pull origin v2.4.x
npm version <version>
npx electron-builder --mac --arm64
xcrun notarytool submit <dmg> --wait
xcrun stapler staple <app-or-dmg>
xcrun stapler validate <app-or-dmg>
spctl --assess --type execute --verbose <app>
git add <release-files>
git commit -m "Release <version>"
git tag <tag>
git push origin v2.4.x
git push origin <tag>
gh release create <tag> <artifacts>
npx wrangler pages deploy <directory>
curl -L -s -H "Cache-Control: no-cache" https://get-crate.com/
```

Approval is required for every release mutation, build, signing, notarization, tag, GitHub release, deploy, and live verification step that Bryant wants Codex to execute.

## Standard Flow
1. Confirm Bryant approved the release and target version.
2. Pull latest `v2.4.x`.
3. Verify clean working tree.
4. Bump version.
5. Build with `npx electron-builder --mac --arm64`.
6. Notarize the DMG or app as required.
7. Staple and validate the release artifact.
8. Update `crate-site/index.html`.
9. Commit release files.
10. Tag release.
11. Create GitHub release and upload artifacts.
12. Deploy Cloudflare Pages.
13. Confirm `get-crate.com` points to the new DMG.

## Definition Of Done
- Release was started only after Bryant approval.
- `v2.4.x` was current before release changes.
- Version, build artifact, notarization, staple, and validation were verified.
- `crate-site/index.html` links to the intended DMG.
- Release commit and tag exist on remote.
- GitHub release exists with the expected artifact.
- Cloudflare Pages deployed successfully.
- `get-crate.com` resolves to the new DMG.
- Exact commands, files changed, tests/checks, risks, and proceed status were reported.

## Report Format
- Release version and current branch.
- Readiness checks and exact commands.
- Files changed at each approved mutation step.
- Artifact, notarization, staple, validation, tag, GitHub release, deploy, and live-site status.
- Risks, blockers, and whether Bryant can proceed to the next step.

## Risk Checklist
- Releasing from a branch other than `v2.4.x`.
- Dirty working tree before release mutation.
- Version mismatch between `package.json`, tag, DMG name, site link, and GitHub release.
- Notarization succeeds but staple or validation is skipped.
- `crate-site/index.html` points to an old artifact.
- Cloudflare deploy succeeds but production domain still serves cached HTML.
- Credentials or notarization output leak secrets into logs or commits.
- Package files include unrelated dependency changes.
