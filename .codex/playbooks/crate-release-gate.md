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
- The `crate-release-notarytool` Keychain profile is available to the exclusive approved release account without credentials in arguments, environment variables, repository files, or proof output.

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
- No repository file, release artifact, remote state, or live service during the read-only release gate.
- Initial branch, source, and remote-metadata inspection must remain mutation-free. Do not create npm configuration, cache, or temporary proof state for those inspection-only commands.
- Only after Bryant explicitly approves test execution may Codex create fresh mode-`0700` temporary/cache roots and empty mode-`0600` npm configuration files outside the repository. That disposable local test state is not release execution and must be removed at gate closeout.
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
For initial mutation-free Git, GitHub, and metadata inspection, establish only the fixed Git/GitHub tool paths and environments defined by `.codex/playbooks/release-crate.md`. Define `<sanitized-git-environment>` as exactly `/usr/bin/env -i HOME="<approved-home>" PATH=/usr/bin:/bin:/usr/sbin:/sbin GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_NO_REPLACE_OBJECTS=1 GIT_OPTIONAL_LOCKS=0`. Define `<sanitized-git-command>` as that environment followed by `/usr/bin/git --no-optional-locks --no-replace-objects -c core.hooksPath=/dev/null -c core.fsmonitor=false -c core.untrackedCache=false`. Define `<sanitized-gh-environment>` as exactly `/usr/bin/env -i HOME="<approved-home>" PATH=/usr/bin:/bin:/usr/sbin:/sbin`. Authenticate and hash the exact local Git config with includes disabled; reject aliases, includes, URL rewrites, executable remote helpers, hooks, filesystem monitors, SSH commands, protocol overrides, and configured credential helpers. Supply only a separately authenticated canonical credential helper explicitly when remote access is required. Stop if a tool path, hash, version, config hash, remote, account, or approved home is missing or drifts.

Only after Bryant approves test execution, create fresh mode-`0700` `<private-release-temp-root>` and `<private-release-cache-root>` directories outside the repository and verify distinct empty mode-`0600` regular `<private-release-user-npmrc>` and `<private-release-global-npmrc>` files inside the private temp root as defined by `release-crate.md`. Define `<sanitized-node-environment>` as exactly `/usr/bin/env -i HOME="<approved-home>" TMPDIR="<private-release-temp-root>" PATH=/usr/bin:/bin:/usr/sbin:/sbin npm_config_cache="<private-release-cache-root>" npm_config_userconfig="<private-release-user-npmrc>" npm_config_globalconfig="<private-release-global-npmrc>"`. Stop if a Node/npm tool path, hash, version, npm-config file identity, or private-root identity drifts. Remove this disposable local test state at gate closeout; its creation never authorizes a version change, build, signing, notarization, release, or deployment.

Run every query in `release-crate.md` under `Bounded GitHub Governance Evidence` and archive only those bounded fields. Source files and a green check label are insufficient without the exact API-bound app, workflow, suite, commit, ruleset, review, and immutable-release evidence. Also complete the manual controlling-principal attestation required by the release-session trust boundary. Stop if the local session is not exclusive or if another same-user process, agent, automation, or release authority may mutate the release inputs or remote draft.

Confirm branch, cleanliness, and intended history:

```sh
<sanitized-git-command> status --short --branch
<sanitized-git-command> branch --show-current
<sanitized-git-command> fetch origin
<sanitized-git-command> rev-parse HEAD
<sanitized-git-command> rev-parse origin/v2.4.x
<sanitized-git-command> log --oneline --decorate -n 30
<sanitized-git-command> diff --name-only
<sanitized-git-command> diff --check
```

Inspect release metadata without mutating it:

```sh
<sanitized-node-environment> "<canonical-node-executable>" -p "require('./package.json').version"
<sanitized-node-environment> "<canonical-node-executable>" -p "require('./package.json').productName"
<sanitized-node-environment> "<canonical-node-executable>" -p "require('./package.json').build.appId"
<sanitized-node-environment> "<canonical-node-executable>" -p "require('./package.json').build.mac.target"
<sanitized-git-command> diff -- package.json package-lock.json crate-site/index.html
```

Run release-readiness tests only after Bryant approves test execution:

```sh
<sanitized-node-environment> "<canonical-node-executable>" --check main.js
<sanitized-node-environment> "<canonical-node-executable>" tests/provenance.test.js
<sanitized-node-environment> "<canonical-node-executable>" tests/provenance-dual-write.test.js
<sanitized-node-environment> "<canonical-node-executable>" tests/psd-embedded-safety.test.js
<sanitized-node-environment> "<canonical-node-executable>" tests/figma-scope.test.js
<sanitized-node-environment> "<canonical-node-executable>" tests/figma-link-per-project.test.js
```

Inspect existing remote release and production state read-only:

```sh
<sanitized-gh-environment> "<canonical-gh-executable>" release view <tag>
<sanitized-gh-environment> "<canonical-gh-executable>" release view <tag> --json tagName,name,isDraft,isPrerelease,assets,publishedAt,url
/usr/bin/env -i HOME="<private-live-check-home>" PATH=/usr/bin:/bin:/usr/sbin:/sbin /usr/bin/curl -q --noproxy '*' --proto '=https' --tlsv1.2 --fail --head https://get-crate.com/
```

After an approved build exists, inspect local artifact metadata. Run signing, Gatekeeper, notarization, stapling, DMG, and live-site validation commands only after Bryant approves those checks:

```sh
/bin/ls -la dist
/usr/bin/shasum -a 256 dist/*.dmg dist/*.zip dist/*.yml dist/*.blockmap
/usr/bin/sed -n '1,220p' dist/latest-mac.yml
/usr/bin/codesign --verify --deep --strict --verbose=4 <path-to-app>
(cd <isolated-verifier-source-root> && <sanitized-node-environment> "<canonical-node-executable>" scripts/run-macos-release-proof.js <path-to-app> --electron-archive <electron-arm64-archive> --canvas-prebuild <canvas-arm64-prebuild> --expected-revision <approved-release-commit> --source-root <isolated-proof-source-root> --json)
/usr/sbin/spctl --assess --type execute --verbose <path-to-app>
/usr/sbin/spctl -a -t open --context context:primary-signature -v <path-to-dmg>
/usr/bin/xcrun stapler validate <path-to-app-or-dmg>
/usr/bin/env -i HOME="<private-live-check-home>" PATH=/usr/bin:/bin:/usr/sbin:/sbin /usr/bin/curl -q --noproxy '*' --proto '=https' --tlsv1.2 --fail --silent --show-error --location -H "Cache-Control: no-cache" https://get-crate.com/
```

## Required Gate Checks
- Branch gate: release must run from `v2.4.x`, not `main`, not a feature branch, and not an active worktree with dirty changes.
- Merge gate: intended PRs are merged into `v2.4.x`; unintended branches are not included.
- Clean gate: the version bump is committed and merged before build, and the release build runs from that exact clean `v2.4.x` commit with no tracked or untracked source drift.
- Test gate: relevant focused tests pass before build.
- Metadata gate: package version, app name, app ID, target architecture, and release target match the intended release.
- Dependency reconstruction gate: before any npm command or version mutation, resolve and record one canonical realpath Node executable and one canonical npm CLI file. Require the Node executable to be a regular executable outside the worktree and every `node_modules` directory, and the npm CLI to be a regular file outside the release worktree and its dependency tree. Record both real paths, both SHA-256 hashes, and both tool versions; recompute them before every release or proof use and stop on drift. Invoke npm only through canonical Node under the exact minimal `env -i` environment defined above, with a mode-`0700` private temp/cache root and no inherited Node, npm, proxy, dynamic-loader, shell, or executable-path variables. Use `--ignore-scripts` for both `npm version` and `npm ci`; the install-script verifier must also reject every root version/install lifecycle hook. After `npm ci --ignore-scripts`, download only the exact pinned official Canvas URL through `/usr/bin/env -i HOME="<private-live-check-home>" PATH=/usr/bin:/bin:/usr/sbin:/sbin /usr/bin/curl -q --noproxy '*' --proto '=https' --tlsv1.2 --fail --silent --show-error --location`, then install it with `scripts/install-approved-canvas-prebuild.js`; never run Canvas, npm, or dependency lifecycle scripts. URL provenance is an operator gate. The installer independently verifies byte size, SHA-256, exact regular-file/directory archive inventory, one private authenticated archive snapshot for inspection and extraction, traversal-safe extraction, clean real destination, atomic installation, and installed bytes. These commands may not change `package.json` or `package-lock.json` outside the approved version-only step.
- Independent proof-root gate: after build, independently reconstruct dependencies with lifecycle scripts disabled in both detached clean worktrees at the exact release commit. Run the committed install-policy verifier in each; install the same authenticated Canvas prebuild only in the proof root. The verifier checkout may execute only the reviewed verifier, while the proof root supplies dependency evidence. The public signed-app verifier must use that isolated proof root, not the build tree or its own dependency tree, and must receive that exact Canvas archive plus the exact arm64 Electron ZIP named by the proof root's locked Electron package. It authenticates registry package bytes and dependency declarations against the lockfile, Canvas bytes against the prebuild, the Electron ZIP against a sealed `checksums.json` snapshot, and the packaged Electron executable/framework payload against the distribution.
- Build gate: `<sanitized-node-environment> "<canonical-node-executable>" node_modules/electron-builder/out/cli/cli.js --mac --arm64 --config.npmRebuild=false` succeeds only after Bryant gives one combined build, signing, app-notarization, app-stapling, and app-staple-validation approval. The fresh lockfile-integrity-reconstructed CLI runs under unchanged canonical Node, never through `npx` or an env shebang, and child tool lookup is limited to standard macOS system paths. The signed-app verifier, not the build-tool reconstruction alone, remains the hard byte-authentication gate for the resulting application. A build-only approval is insufficient because Electron Builder invokes `scripts/notarize.js`; that hook suppresses private notarization debug output and must staple and validate the accepted app ticket before container creation. Electron Builder must not run a second dependency-rebuild path.
- App signing gate: built app bundle passes codesign and Gatekeeper assessment.
- Source CI and repository-governance gate: live GitHub API evidence must show `v2.4.x` is the default branch and an active ruleset targets `refs/heads/v2.4.x`. It must require the exact `Source security and regression suite` check with a non-null integration ID, an up-to-date branch, stale-approval dismissal, approval after the latest reviewable push, blocked force pushes/deletion, and at least one code-owner approval from a controlling principal different from the PR author. The workflow must expose only `pull_request` and protected-branch `push` triggers. For the exact release merge SHA, require a successful check run with the same name, `head_sha`, and integration ID, app slug `github-actions`, and a check-suite ID equal to a successful Actions workflow run at immutable path `.github/workflows/security-gate.yml`, event `push`, ref `refs/heads/v2.4.x`, and that same head SHA. Reject any other source, app, workflow, event, ref, or commit. Repository administrators and ordinary repository roles must not bypass the rule; a second login controlled by the author is not independent review. Two active rulesets must target `refs/tags/v*`: a creation-control ruleset whose only bypass actor is a separately controlled release authority, plus a separate no-bypass immutability ruleset that blocks tag updates/deletion for every human, administrator, token, repository role, and normal app path. Live `immutable-releases` API evidence must also report `enabled: true`. Archive only bounded repository and check-provenance fields. Source files cannot satisfy this gate by themselves. The workflow has read-only repository permission, runs no dependency lifecycle scripts, receives no signing or deployment credentials, and performs no build or release mutation.
- Signed-app proof gate: `run-macos-release-proof.js` authenticates every local verifier source file before loading `verify-macos-release-app.js` from a clean checkout at the explicitly supplied release commit. Before either third-party verifier module loads, it resolves the exact `@electron/asar` and `@electron/fuses` execution closure from the committed lockfile and authenticates every installed package in that closure against its registry integrity; after proof execution it rechecks those package bytes and the committed verifier sources. The verifier fingerprints the original app before and after one private metadata-preserving copy, collects evidence only from that snapshot, then requires both the original app and complete snapshot fingerprints to remain unchanged through final proof. It passes in default release mode against a different isolated proof root at that same commit, the authenticated locked Electron archive, and the exact approved Canvas prebuild. It must report `releaseReady: true`; this proves the canonical executable name, identifier, and team, Apple-anchored Developer ID Application trust for the app and every nested code bundle, approved arm64 architecture policy with only the exact allowlisted universal native module, clean source revision, hardened runtime, exact launch/security metadata plus internally consistent main/helper build metadata, exact main/helper/nested-bundle entitlements, approved canonical typed bundle layout, strict transport and privacy metadata, the actual ASAR header hash against embedded integrity metadata, exact Electron fuse wire, first-party source-to-ASAR and version binding, the packaged Electron runtime against the locked official distribution, and the complete production dependency closure reconstructed independently from the committed lockfile. Dependency proof requires strict versions, exact lock paths, authenticated registry source bytes, each authenticated package manifest's exact dependency/optional/peer topology, the complete official Canvas inventory and bytes, exact Electron Builder-filtered inventories, transformed manifests, ordinary bytes, and signature-normalized native binaries. It also proves packaged-content policy, Gatekeeper acceptance, and the notarization staple. The privacy-safe proof includes only the code-directory fingerprint and source revision needed for identification.
- App notarization/stapling gate: the app is notarized through the fixed `crate-release-notarytool` Keychain profile, stapled, and validated inside `afterSign` before Electron Builder creates any release envelope. Raw Apple credentials, API-key paths, IDs, issuers, passwords, and secrets are absent from source, command arguments, environment variables, logs, and proof output.
- DMG envelope gate: DMG signing, notarization, stapling, and primary-signature assessment are validated.
- Container-content gate: mount the final DMG read-only and extract the final ZIP into separate empty temporary roots. Compare the complete outer inventories to explicit reviewed allowlists derived from the Electron Builder configuration: the ZIP contains only the expected Crate app tree, while the DMG contains only that app, the exact reviewed Finder presentation files, and the `/Applications` link. Reject any additional script, installer, executable, application, symlink, or unrelated file. The one expected app in each container must independently pass the signed-app verifier with `releaseReady: true` and match the approved standalone proof's bundle identifier, version, code-directory hash, and source revision.
- Update metadata gate: `latest-mac.yml` and `.blockmap` files match the built artifact names, versions, sizes, and checksums.
- GitHub release gate: repository release immutability is enabled before mutation; an exact approved `{name,size,sha256}` asset manifest is frozen; only the separately controlled release authority may mutate the draft; and the complete downloaded draft set equals that manifest with no missing or extra asset. Immediately before publication, re-fetch bounded draft metadata, recheck immutability, download the complete draft set into a second new empty directory, and repeat every manifest comparison. Publishing must be the next bounded operation with no intervening actor or command. After publication, the live immutable asset set and `gh release verify` attested subjects must equal the same exact manifest, and `gh release verify-asset` must pass for every and only approved artifact before site links are updated or deployed.
- Site gate: the code-owned `crate-site/index.html` points to the exact hash-verified GitHub release asset only after the asset exists and passes the download comparison.
- Deploy gate: Cloudflare Pages deploy happens only after GitHub release assets and site links are correct, from a new private site snapshot whose complete paths, Git modes, byte sizes, and Git-blob IDs equal `<approved-site-commit>:crate-site` immediately before and after deploy. The live worktree is never the deploy input; `--commit-dirty=true` is forbidden.
- Live gate: `get-crate.com` is verified after deploy, with cache-busting, against the expected DMG URL and version.

## Approval Gates
No release mutation may run until Bryant approves that exact step. Approval must name the target version and expected result.

Commands requiring explicit Bryant approval:

```sh
<sanitized-git-command> pull origin v2.4.x
<sanitized-node-environment> "<canonical-node-executable>" "<canonical-npm-cli>" version <version> --no-git-tag-version --ignore-scripts
<sanitized-node-environment> "<canonical-node-executable>" "<canonical-npm-cli>" ci --ignore-scripts
<sanitized-node-environment> "<canonical-node-executable>" scripts/verify-install-scripts.js
<sanitized-node-environment> "<canonical-node-executable>" scripts/install-approved-canvas-prebuild.js <canvas-arm64-prebuild>
<sanitized-node-environment> "<canonical-node-executable>" node_modules/electron-builder/out/cli/cli.js --mac --arm64 --config.npmRebuild=false
<sanitized-git-command> worktree add --detach <isolated-proof-source-root> <release-commit>
<sanitized-git-command> worktree add --detach <isolated-verifier-source-root> <release-commit>
/usr/bin/codesign --force --sign <identity> <artifact>
/usr/bin/xcrun notarytool history --keychain-profile "crate-release-notarytool"
/usr/bin/xcrun notarytool submit <artifact> --keychain-profile "crate-release-notarytool" --wait
/usr/bin/xcrun stapler staple <artifact>
/usr/bin/xcrun stapler validate <artifact>
/usr/sbin/spctl --assess --type execute --verbose <path-to-app>
/usr/sbin/spctl -a -t open --context context:primary-signature -v <path-to-dmg>
<sanitized-git-command> add <release-files>
<sanitized-git-command> commit -m "Release <version>"
<sanitized-git-command> tag <tag>
<sanitized-git-command> push origin <release-prep-or-site-branch>
<sanitized-gh-environment> "<canonical-gh-executable>" pr create --base v2.4.x --head <release-prep-or-site-branch>
<sanitized-gh-environment> "<canonical-gh-executable>" pr checks <pr-number> --watch
<sanitized-gh-environment> "<canonical-gh-executable>" pr merge <pr-number>
<sanitized-git-command> push origin <tag>
<sanitized-git-command> fetch --force origin refs/tags/<tag>:refs/tags/<tag>
test "$(<sanitized-git-command> rev-parse '<tag>^{commit}')" = "<approved-release-commit>"
<sanitized-gh-environment> "<canonical-gh-executable>" release create --verify-tag --draft <tag> <artifacts>
<sanitized-gh-environment> "<canonical-gh-executable>" release download <tag> --dir <empty-verification-directory>
<sanitized-gh-environment> "<canonical-gh-executable>" release edit <tag> --draft=false
<sanitized-gh-environment> "<canonical-gh-executable>" release verify <tag>
<sanitized-gh-environment> "<canonical-gh-executable>" release verify-asset <tag> <local-approved-artifact>
/usr/bin/hdiutil attach -readonly -nobrowse <path-to-dmg>
/usr/bin/hdiutil detach <mounted-volume>
/usr/bin/ditto -x -k <path-to-zip> <empty-zip-verification-directory>
<sanitized-wrangler-environment> "<canonical-node-executable>" "<authenticated-wrangler-cli>" pages deploy <directory>
/usr/bin/env -i HOME="<private-live-check-home>" PATH=/usr/bin:/bin:/usr/sbin:/sbin /usr/bin/curl -q --noproxy '*' --proto '=https' --tlsv1.2 --fail --silent --show-error --location -H "Cache-Control: no-cache" https://get-crate.com/
```

Approval for the sanitized canonical-Node Electron Builder command above must explicitly cover the combined build, signing, app-notarization, app-stapling, and app-staple-validation operation performed by the configured `afterSign` hook. Approval to build alone does not authorize that command.

Hard ordering rules:

- No version bump until branch, merge, clean, test, and metadata gates pass.
- No release mutation while `v2.4.x` is not the default branch; while repository release immutability is disabled; while the source CI workflow or branch/layered-tag rulesets are optional, bypassable, or failing; or while required independent code-owner review is not enforceable.
- No version or release mutation until the required check's non-null integration ID, successful GitHub Actions check run, workflow path, check-suite ID, and exact release merge SHA are bound together by live API evidence.
- No public release while the required code-owner approval could come only from the PR author.
- No public build until the version-only release-prep PR has merged, required CI passes on its merge commit, the local checkout matches that exact commit, and the fresh lockfile install completes without package-file drift.
- No public signed-app proof may use the build tree as its dependency source; the isolated proof worktree must be reconstructed after build from the same release commit.
- No tag until build, signing, pre-container app notarization/stapling, standalone and embedded-app proof, envelope validation, and update metadata pass.
- `--allow-unnotarized` is restricted to explicitly approved contained QA artifacts. It waives only Gatekeeper and notarization-staple proof; ASAR, source, dependency, signature, entitlement, bundle, fuse, and privacy policy checks remain mandatory. A proof produced in that mode reports `releaseReady: false` and must never satisfy the public release gate.
- No public GitHub release until the pushed remote tag resolves to the approved release commit and the complete draft asset set equals the frozen approved manifest exactly.
- No site deploy until the published release is immutable, its live assets and attested subjects equal the frozen manifest exactly, every local asset verification passes, the code-owned `crate-site/index.html` update has passed the required PR checks and merged into protected `v2.4.x`, the local deploy source matches that remote merge commit, and the Wrangler CLI comes from the approved authenticated tool root.
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
