# Release Crate Playbook

## Purpose
Run the selected Crate release profile from `v2.4.x` through version bump, macOS build, notarization, staple, validation, GitHub release, site update, Cloudflare Pages deploy, and live download verification.

## When To Use
- Only after Bryant says a release should begin.
- After the intended PRs have merged into `v2.4.x`.
- When preparing a signed macOS release artifact and updating `get-crate.com`.

## Start Prompt
Use a prompt like:

```text
Use .codex/playbooks/release-crate.md for Crate release <version>. Start with read-only readiness checks only. Do not pull, bump, build, notarize, tag, create a release, or deploy until Bryant approves that specific step.
```

## Release Profiles

- **Tester beta:** Bryant explicitly approves a prerelease for named testers. It uses the existing direct-download flow: version-only PR, required source CI, exact merged-source build, signing/notarization/stapling, independent signed-artifact proof, immutable tag/release asset integrity, frozen asset manifest, GitHub prerelease, a reviewed `crate-site` link update, Cloudflare deploy, live-link verification, and installed-app smoke. It does not require an independent GitHub approver, public-stable tag-creation authority, or the future account backend.
- **Public stable:** requires every tester-beta artifact gate plus the independently controlled code-owner/release approval, public-stable branch and tag-creation rulesets, attestation checks, and the account-gated download backend approved for public launch.

Record the selected profile in the proof bundle before any mutation. A tester beta must never be described as public stable, and public-stable requirements must not be silently waived by labeling a build beta.

## Inspect
- Current branch is `v2.4.x`.
- Working tree is clean before release changes begin.
- Local `v2.4.x` includes latest `origin/v2.4.x`.
- Version bump target and changelog/release notes are confirmed.
- Apple signing and notarization credentials are available without exposing secrets.
- The reviewed `notarytool` Keychain profile `crate-release-notarytool` exists under the approved release account, and `notarytool history --keychain-profile "crate-release-notarytool"` succeeds before any build or envelope submission. The committed `afterSign` hook uses only that profile. Never place Apple credentials in a command argument, environment variable, log, proof bundle, or repository file.
- GitHub's default branch is `v2.4.x`, the required source-security check is active, no-bypass `v*` tag update/deletion protection is active, and immutable releases are enabled. Public stable additionally verifies its branch/tag-creation rulesets through the GitHub API and archives them in the release proof.
- `crate-site/index.html` points to the new release asset after the release artifact exists.
- GitHub release tag, uploaded DMG, Cloudflare Pages deployment, and `get-crate.com` live response all agree.

## Fixed Command Environments

Define `<sanitized-git-environment>` as exactly `/usr/bin/env -i HOME="<approved-home>" PATH=/usr/bin:/bin:/usr/sbin:/sbin GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_NO_REPLACE_OBJECTS=1 GIT_OPTIONAL_LOCKS=0`. Define `<sanitized-git-command>` as that environment followed by `/usr/bin/git --no-optional-locks --no-replace-objects -c core.hooksPath=/dev/null -c core.fsmonitor=false -c core.untrackedCache=false`. Define `<sanitized-gh-environment>` as exactly `/usr/bin/env -i HOME="<approved-home>" PATH=/usr/bin:/bin:/usr/sbin:/sbin`.

Before trusting a repository, resolve its real Git directory and local config without following a symlink. Authenticate and hash the local Git config with includes disabled. Reject aliases, `include` and `includeIf`, URL rewrites, executable remote helpers, `core.hooksPath`, `core.fsmonitor`, `core.sshCommand`, `protocol.*.allow`, credential helpers, and any unknown key capable of executing or redirecting a command. Recompute the config hash before and after every remote or mutating Git operation. Remote authentication may be added only through one separately authenticated canonical credential helper supplied explicitly to the fixed command; never trust a helper from repository, global, or system configuration.

Create distinct empty mode-`0600` regular files `<private-release-user-npmrc>` and `<private-release-global-npmrc>` inside `<private-release-temp-root>` with `/usr/bin/install -m 600 /dev/null`, after rejecting either path if it already exists or is a symlink. Verify both canonical paths stay inside the private root, differ from each other, and remain owner-only regular files before and after every npm use. Define `<sanitized-node-environment>` as exactly `/usr/bin/env -i HOME="<approved-home>" TMPDIR="<private-release-temp-root>" PATH=/usr/bin:/bin:/usr/sbin:/sbin npm_config_cache="<private-release-cache-root>" npm_config_userconfig="<private-release-user-npmrc>" npm_config_globalconfig="<private-release-global-npmrc>"`. All placeholders identify previously authenticated canonical paths; they are not shell snippets to expand from ambient configuration.

## Release Session Trust Boundary

- Run the release from one exclusive local session under the Bryant-approved release operator. Public stable additionally requires the separately controlled release authority. Stop if another agent, shell, automation, or unknown process may be mutating the same checkout, proof roots, artifact roots, draft release, tag, or Cloudflare project.
- Private mode-`0700` roots, authenticated snapshots, and repeated fingerprints protect against accidental drift, ordinary concurrent work, and unprivileged local users. They cannot make a release trustworthy after the active macOS login or another process with the same user identity is compromised. Treat suspected same-user compromise as a hard stop and restart from a known-clean release machine/session.
- Source and API fields cannot prove that two GitHub logins represent different controlling people. The public-stable proof must include a manual attestation naming the PR author, approving code owner, and separately controlled release authority, and must confirm they satisfy the independence rules below. A tester-beta proof records Bryant's explicit approval and does not claim independent review.

## Commands Codex May Run
```sh
<sanitized-git-command> status --short --branch
<sanitized-git-command> branch --show-current
<sanitized-git-command> fetch origin
<sanitized-git-command> log --oneline --decorate -n 20
<sanitized-git-command> diff --name-only
<sanitized-gh-environment> "<canonical-gh-executable>" release view <tag>
<sanitized-gh-environment> "<canonical-gh-executable>" api repos/bfeintuch123/crate-app --jq .default_branch
<sanitized-gh-environment> "<canonical-gh-executable>" api repos/bfeintuch123/crate-app/rulesets
<sanitized-gh-environment> "<canonical-gh-executable>" api repos/bfeintuch123/crate-app/immutable-releases
/usr/bin/env -i HOME="<private-live-check-home>" PATH=/usr/bin:/bin:/usr/sbin:/sbin /usr/bin/curl -q --noproxy '*' --proto '=https' --tlsv1.2 --fail --head https://get-crate.com/
```

Read-only release checks are allowed. Do not begin release mutation without Bryant approval.

## Commands Requiring Explicit Bryant Approval
```sh
<sanitized-git-command> pull origin v2.4.x
/usr/bin/env -i HOME="<approved-home>" TMPDIR="<private-release-temp-root>" PATH=/usr/bin:/bin:/usr/sbin:/sbin npm_config_cache="<private-release-cache-root>" npm_config_userconfig="<private-release-user-npmrc>" npm_config_globalconfig="<private-release-global-npmrc>" "<canonical-node-executable>" "<canonical-npm-cli>" version <version> --no-git-tag-version --ignore-scripts
/usr/bin/env -i HOME="<approved-home>" TMPDIR="<private-release-temp-root>" PATH=/usr/bin:/bin:/usr/sbin:/sbin npm_config_cache="<private-release-cache-root>" npm_config_userconfig="<private-release-user-npmrc>" npm_config_globalconfig="<private-release-global-npmrc>" "<canonical-node-executable>" "<canonical-npm-cli>" ci --ignore-scripts
/usr/bin/env -i HOME="<approved-home>" TMPDIR="<private-release-temp-root>" PATH=/usr/bin:/bin:/usr/sbin:/sbin npm_config_cache="<private-release-cache-root>" npm_config_userconfig="<private-release-user-npmrc>" npm_config_globalconfig="<private-release-global-npmrc>" "<canonical-node-executable>" scripts/verify-install-scripts.js
/usr/bin/env -i HOME="<approved-home>" TMPDIR="<private-release-temp-root>" PATH=/usr/bin:/bin:/usr/sbin:/sbin npm_config_cache="<private-release-cache-root>" npm_config_userconfig="<private-release-user-npmrc>" npm_config_globalconfig="<private-release-global-npmrc>" "<canonical-node-executable>" scripts/install-approved-canvas-prebuild.js <canvas-arm64-prebuild>
/usr/bin/env -i HOME="<approved-home>" TMPDIR="<private-release-temp-root>" PATH=/usr/bin:/bin:/usr/sbin:/sbin npm_config_cache="<private-release-cache-root>" npm_config_userconfig="<private-release-user-npmrc>" npm_config_globalconfig="<private-release-global-npmrc>" "<canonical-node-executable>" node_modules/electron-builder/out/cli/cli.js --mac --arm64 --config.npmRebuild=false
<sanitized-git-command> worktree add --detach <isolated-proof-source-root> <release-commit>
<sanitized-git-command> worktree add --detach <isolated-verifier-source-root> <release-commit>
/usr/bin/xcrun notarytool submit <dmg> --keychain-profile "crate-release-notarytool" --wait
/usr/bin/xcrun notarytool history --keychain-profile "crate-release-notarytool"
/usr/bin/xcrun stapler staple <app-or-dmg>
/usr/bin/xcrun stapler validate <app-or-dmg>
/usr/sbin/spctl --assess --type execute --verbose <app>
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

Approval is required for every release mutation, build, signing, notarization, tag, GitHub release, deploy, and live verification step that Bryant wants Codex to execute. Because `package.json` configures `afterSign` as `scripts/notarize.js`, the canonical-Node Electron Builder command requires one combined build, signing, app-notarization, app-stapling, and app-staple-validation approval. A build-only approval is insufficient and must not start that command.

## Common Artifact Integrity Protections

Both release profiles require live GitHub API evidence for all of the following:

- `v2.4.x` is the repository default branch; force pushes and branch deletion are blocked; and the exact `Source security and regression suite` succeeds for the version PR and its protected-branch merge SHA through `.github/workflows/security-gate.yml` and the `github-actions` app.
- A separate no-bypass immutability ruleset targets `refs/tags/v*` and blocks tag updates and deletion for every normal and administrator path after a tag is created. Tester beta does not require a separately controlled tag creator, but its tag must remain append-only once pushed.
- Repository release immutability is enabled. The live `immutable-releases` API response reports `enabled: true` before a release mutation, so a published release locks its tag and assets. Tester-beta proof verifies immutable published assets but does not claim independent release-authority approval or use release attestation as a governance substitute.
- The bounded API fields proving these common controls are stored in the privacy-safe release proof bundle.

## Public Stable Repository Protections

Public release work is blocked until live GitHub API evidence proves all of the following:

- `v2.4.x` is the repository default branch, so the canonical workflow and CODEOWNERS file come from the same protected source of truth. The source-security workflow must expose only `pull_request` and protected-branch `push` triggers, never a manual or reusable trigger.
- An active ruleset targets `refs/heads/v2.4.x`, requires the exact `Source security and regression suite` check with a non-null GitHub App `integration_id`, requires the branch to be up to date, blocks force pushes and deletion, dismisses stale approvals, requires approval after the latest reviewable push, and requires at least one code-owner approval from a controlling principal different from the PR author. For the exact release merge SHA, the successful check run must have that same name, `head_sha`, and integration ID; its app slug must be `github-actions`; and its check-suite ID must equal a successful Actions workflow run whose immutable path is `.github/workflows/security-gate.yml`, whose event is `push`, whose ref is `refs/heads/v2.4.x`, and whose `head_sha` is the release merge SHA. Reject any status from another source, app, workflow, event, ref, or commit. Archive only bounded provenance fields: check name, conclusion, head SHA, app ID/slug, check-suite ID, workflow run ID/path/event/ref/conclusion, and required-check integration ID.
- Repository administrators and ordinary repository roles cannot bypass that branch ruleset. An approval from another login controlled by the same person is not independent review.
- A separate creation-control ruleset targets `refs/tags/v*` and restricts tag creation to one separately controlled release authority as its only bypass actor. That authority must not bypass the common no-bypass tag immutability rule. The release proof records both ruleset IDs, targets, enforcement, rules, and bypass actors before the tag is created and again before the GitHub release is published.
- The public-stable proof additionally records the API responses proving required review controls and separate release-authority controls.

Source files cannot configure or prove these repository settings. For public stable, if any common or public-stable setting is absent, bypassable, or not independently controlled, stop before version bump, build, tag, or release mutation. Tester beta requires every common artifact-integrity control plus Bryant's explicit release approval, but not an independent code-owner/release approval or public-stable tag-creation authority.

### Bounded GitHub Governance Evidence

#### Common Evidence (Both Profiles)

Run these exact read-only API queries through the authenticated sanitized GitHub CLI. Keep only the bounded fields shown; stop if any query returns zero or multiple candidates where exactly one is required.

```sh
<sanitized-gh-environment> "<canonical-gh-executable>" api repos/bfeintuch123/crate-app --jq '{default_branch}'
<sanitized-gh-environment> "<canonical-gh-executable>" api 'repos/bfeintuch123/crate-app/rulesets?includes_parents=false' --jq '[.[] | {id,name,target,enforcement}]'
<sanitized-gh-environment> "<canonical-gh-executable>" api repos/bfeintuch123/crate-app/rulesets/<ruleset-id> --jq '{id,name,target,enforcement,conditions,rules,bypass_actors}'
<sanitized-gh-environment> "<canonical-gh-executable>" api repos/bfeintuch123/crate-app/immutable-releases --jq '{enabled}'
<sanitized-gh-environment> "<canonical-gh-executable>" api 'repos/bfeintuch123/crate-app/commits/<release-pr-head-sha>/check-runs?filter=latest&per_page=100' --jq '[.check_runs[] | select(.name == "Source security and regression suite") | {id,name,status,conclusion,head_sha,app:{id:.app.id,slug:.app.slug},check_suite_id:.check_suite.id}]'
<sanitized-gh-environment> "<canonical-gh-executable>" api 'repos/bfeintuch123/crate-app/actions/workflows/security-gate.yml/runs?branch=<release-prep-branch>&event=pull_request&per_page=100' --jq '[.workflow_runs[] | select(.head_sha == "<release-pr-head-sha>") | {id,path,event,head_branch,head_sha,status,conclusion,check_suite_id}]'
<sanitized-gh-environment> "<canonical-gh-executable>" api 'repos/bfeintuch123/crate-app/commits/<release-merge-sha>/check-runs?filter=latest&per_page=100' --jq '[.check_runs[] | select(.name == "Source security and regression suite") | {id,name,status,conclusion,head_sha,app:{id:.app.id,slug:.app.slug},check_suite_id:.check_suite.id}]'
<sanitized-gh-environment> "<canonical-gh-executable>" api 'repos/bfeintuch123/crate-app/actions/workflows/security-gate.yml/runs?branch=v2.4.x&event=push&per_page=100' --jq '[.workflow_runs[] | select(.head_sha == "<release-merge-sha>") | {id,path,event,head_branch,head_sha,status,conclusion,check_suite_id}]'
<sanitized-gh-environment> "<canonical-gh-executable>" api repos/bfeintuch123/crate-app/actions/runs/<workflow-run-id> --jq '{id,path,event,head_branch,head_sha,status,conclusion,check_suite_id}'
```

Require exactly one successful check-run object and exactly one successful workflow-run object at both the version-only PR head SHA and the protected-branch release merge SHA. For each SHA, their check-suite IDs must be equal, the workflow path must be `.github/workflows/security-gate.yml`, and the app slug must be `github-actions`. The PR-head workflow event must be `pull_request` and its head branch must be `<release-prep-branch>`; the merge workflow event must be `push` and its branch must be `v2.4.x`.

#### Public Stable Extensions Only

Public stable additionally runs the review query below. Review evidence must bind an approval to the latest reviewable commit and be paired with the manual controlling-principal attestation from the trust boundary. Tester beta does not collect or require this evidence.

```sh
<sanitized-gh-environment> "<canonical-gh-executable>" api 'repos/bfeintuch123/crate-app/pulls/<release-pr-number>/reviews?per_page=100' --jq '[.[] | {user:.user.login,state,commit_id,submitted_at}]'
```

## Tester Beta Flow

1. Record `tester-beta` as the selected profile, the target version, named testing purpose, and Bryant's explicit approval. Confirm no public-stable claim or account-gated launch is being made.
2. Authenticate the fixed Git, GitHub CLI, Node, npm, signing, notarization, and Cloudflare tools using the same sanitized environments and drift checks required by the Standard Flow.
3. Confirm every Common Artifact Integrity Protection that is available before the version-only release-prep PR: `v2.4.x` is the default branch, force pushes and deletion are blocked, no-bypass `v*` tag update/deletion protection is active, and `immutable-releases` reports enabled. Independent code-owner approval, manual controlling-principal attestation, review evidence, and public-stable tag-creation authority are not tester-beta gates.
4. Create, review, and merge the version-only tester-beta release-prep PR using the applicable clean-source, frozen-dependency, and canonical-tool steps of the Standard Flow. After it merges, bind the exact `Source security and regression suite` success for both that version-only PR and its protected-branch merge SHA to the required workflow path, GitHub App, and check-suite evidence before any build, tag, GitHub release, deploy, or installed verification.
5. From the exact verified tester-beta merge commit, complete the authenticated Canvas prebuild, signed/notarized/stapled app and containers, independent proof worktrees, `releaseReady: true`, container inventories, hashes, update metadata, and blockmaps required by the Standard Flow.
6. Tag only the verified tester-beta merge commit, push the tag, and verify the remote tag resolves to that exact commit.
7. Freeze the exact `{name,size,sha256}` asset manifest, create the GitHub release as a draft with `--prerelease`, download every draft asset into a new empty directory, and require the complete remote set and bytes to match the frozen manifest before publication.
8. Immediately before publication, confirm the draft still has `prerelease: true`, the expected tag, and exactly the frozen asset names and sizes. Download the complete draft asset set again into a second new empty directory and require every filename, byte size, and SHA-256 to match the frozen manifest. The next bounded operation must be `<sanitized-gh-environment> "<canonical-gh-executable>" release edit <tag> --draft=false`. Require the published release to report immutable, then re-download the published assets and require every filename, byte size, and SHA-256 to match. Do not claim independent release-authority approval or treat an attestation as a substitute for the common artifact-integrity controls.
9. Update `crate-site/index.html` on a separate reviewed site branch so the beta download button points to the exact verified GitHub prerelease DMG. Merge that PR, deploy the exact site merge commit through the authenticated Cloudflare workflow, and confirm `get-crate.com` resolves to the beta DMG.
10. Install the published DMG on the Mac mini, run the targeted tester smoke, archive privacy-safe evidence, and clean temporary worktrees, mounts, logs, and launched QA apps. Only then send the website download flow to the named tester.

## Standard Flow (Public Stable)
1. Confirm Bryant approved the release and target version.
2. Before any repository or release command, record an existing canonical `<approved-home>`. Require `/usr/bin/git` and one canonical realpath GitHub CLI executable to be regular executables outside the worktree and every `node_modules` directory; record their realpaths, SHA-256 hashes, and versions, then stop if they drift. Establish the exact fixed command environments above, authenticate and hash the local Git config, and reject every executable or redirecting config key. Confirm the fixed Git remote is exactly the approved repository and the GitHub CLI account authenticated through the sanitized home is the approved release account. Every Git and GitHub CLI invocation must use the fixed wrappers so inherited `GIT_*`, `GH_*`, proxy, shell, executable-path, hook, filesystem-monitor, credential-helper, alias, include, and URL-rewrite configuration cannot redirect the operation.
3. Complete every Required Repository Protection check below through those authenticated sanitized tools and archive its bounded API evidence before any version or release mutation.
4. Pull latest `v2.4.x` through the sanitized Git command and verify a clean working tree.
5. With explicit approval, authenticate the dependency and build tools before any version mutation. Resolve and record one canonical realpath Node executable and one canonical npm CLI file with the same outside-worktree requirements, hashes, and versions. Create new mode-`0700` `<private-release-temp-root>`, `<private-release-cache-root>`, and empty `<private-live-check-home>` directories, then create and verify the two distinct empty owner-only npm configuration files defined above. Every Node invocation must use exactly `/usr/bin/env -i HOME="<approved-home>" TMPDIR="<private-release-temp-root>" PATH=/usr/bin:/bin:/usr/sbin:/sbin npm_config_cache="<private-release-cache-root>" npm_config_userconfig="<private-release-user-npmrc>" npm_config_globalconfig="<private-release-global-npmrc>"` before the canonical Node path. This drops `NODE_OPTIONS`, `NODE_PATH`, inherited npm configuration, dynamic-loader variables, proxy variables, and script-shell injection. Invoke npm only through canonical Node and its canonical CLI file; never execute an env shebang or package-local shim directly. Recompute every tool path, hash, version, and npm-config file identity before each release or proof use.
6. Create a release-prep branch and bump only `package.json` and `package-lock.json` with the sanitized environment prefix followed by `"<canonical-node-executable>" "<canonical-npm-cli>" version <version> --no-git-tag-version --ignore-scripts`. The install-script verifier must already have established that root `preversion`, `version`, and `postversion` hooks are absent; `--ignore-scripts` remains mandatory.
7. Commit, push, review, and merge the release-prep PR into `v2.4.x` through the sanitized Git and GitHub CLI commands; wait for the required source-security check to pass. Bind that result to the exact merge SHA, workflow, GitHub App, and check-suite evidence required below.
8. Pull the merged release commit through the sanitized Git command, record its full SHA, confirm the source tree is clean, and revalidate every canonical tool path, hash, version, remote, and account from Steps 2 and 5. Using the exact sanitized Node environment prefix, run `"<canonical-node-executable>" "<canonical-npm-cli>" ci --ignore-scripts` from the committed lockfile, then `"<canonical-node-executable>" scripts/verify-install-scripts.js`; confirm neither command changes package files.
9. Install only the exact pinned official Canvas arm64 prebuild; do not run Canvas, npm, or dependency lifecycle scripts. Set `<canvas-arm64-prebuild>` to a new path inside `<private-release-temp-root>` and require that path not to exist. Download it with exactly `/usr/bin/env -i HOME="<private-live-check-home>" PATH=/usr/bin:/bin:/usr/sbin:/sbin /usr/bin/curl -q --noproxy '*' --proto '=https' --tlsv1.2 --fail --silent --show-error --location --output "<canvas-arm64-prebuild>" "https://github.com/Automattic/node-canvas/releases/download/v3.2.1/canvas-v3.2.1-napi-v7-darwin-arm64.tar.gz"`; do not inherit proxy variables or a curl configuration file. Require the resulting path to be a regular file, not a symlink, inside the private root before continuing. Under the exact sanitized Node environment, run `"<canonical-node-executable>" scripts/install-approved-canvas-prebuild.js <canvas-arm64-prebuild>`. The command pins both the download URL and private destination; the installer independently requires the pinned byte size, SHA-256 digest, exact regular-file/directory archive inventory, one private authenticated archive snapshot for inspection and extraction, traversal-safe extraction, a clean real destination, same-filesystem atomic installation, and byte-for-byte installed payload equality. Rerun the install-script verifier, confirm package files did not change, and stop on any archive, tree, symlink, lifecycle, or dependency drift.
10. After one combined build, signing, app-notarization, app-stapling, and app-staple-validation approval, build under the exact sanitized Node environment with `"<canonical-node-executable>" node_modules/electron-builder/out/cli/cli.js --mac --arm64 --config.npmRebuild=false` from that exact commit. This invokes the fresh lockfile-integrity-reconstructed Electron Builder CLI under canonical Node, prevents Node/npm/script-shell injection and package-local executable lookup, and permits only standard macOS system-tool lookup. The signed-app verifier remains the hard byte-authentication gate for the resulting application; this build-tool reconstruction is not a substitute for that proof. Electron Builder cannot execute an additional dependency-rebuild path. Its configured `afterSign` hook at `scripts/notarize.js` must suppress private `electron-notarize*` debug output, notarize, staple, and validate the app before Electron Builder creates the DMG and ZIP. A build-only approval is insufficient.
11. With separate approval, revalidate the reviewed Keychain profile with `/usr/bin/xcrun notarytool history --keychain-profile "crate-release-notarytool"`, then notarize each completed release envelope with `/usr/bin/xcrun notarytool submit <dmg> --keychain-profile "crate-release-notarytool" --wait`, staple it, and validate it. Do not submit the app a second time after the successful `afterSign` app notarization.
12. With explicit approval, create two detached worktrees at the release commit through the sanitized Git command: `<isolated-proof-source-root>` and `<isolated-verifier-source-root>`. Assert they are different canonical directories, each has an empty sanitized-Git `status --porcelain=v1 --untracked-files=all`, and each resolves `HEAD` to the exact release commit. Reconstruct each worktree independently with canonical npm `ci --ignore-scripts` under its own fresh mode-`0700` cache/temp roots, then run its committed install-script verifier and confirm package files did not change. Install the same pinned Canvas prebuild from Step 9 only in the proof worktree, rerun that worktree's install-script verifier, and recheck both worktrees against the release commit. The verifier worktree's independently reconstructed dependencies may execute only the reviewed verifier; the proof worktree supplies all dependency-byte evidence. Never use the build tree or verifier checkout as the public dependency proof root. Locate the exact arm64 Electron ZIP named by the proof worktree's locked Electron package and confirm the verifier can authenticate it against that installed package's sealed `checksums.json` snapshot.
13. From `<isolated-verifier-source-root>`, use the exact sanitized Node environment to run `"<canonical-node-executable>" scripts/run-macos-release-proof.js <path-to-app> --electron-archive <electron-arm64-archive> --canvas-prebuild <canvas-arm64-prebuild> --expected-revision <release-commit> --source-root <isolated-proof-source-root> --json` and require `releaseReady: true`. The bootstrap authenticates every local verifier source file against the approved commit before loading the verifier. It then resolves the exact `@electron/asar` and `@electron/fuses` execution closure from the committed lockfile, authenticates every installed package in that closure against its registry integrity before loading either module, injects only those authenticated tools into the verifier, and rechecks both package bytes and committed verifier sources after proof execution. The verifier fingerprints the original app before and after its one metadata-preserving copy, collects evidence only from the private snapshot, then requires both the original app and complete snapshot fingerprints to remain unchanged through final proof. The verifier checkout and isolated proof root must remain different clean directories at the same approved commit. This binds exact launch and security metadata plus internally consistent main/helper build metadata, the packaged Electron executable and framework payload, every authenticated production package's dependency declarations, and the exact Canvas native bytes to reviewed inputs.
14. Mount the final DMG read-only and extract the final ZIP into separate empty temporary roots. Before app verification, record and compare the complete container inventories against an explicit allowlist derived from the reviewed Electron Builder configuration: the ZIP may contain only the expected Crate app tree, and the DMG may contain only that app plus the exact reviewed Finder presentation files and `/Applications` link. Reject every additional script, installer, executable, application, symlink, or unrelated file. Then run the same signed-app verifier against the one Crate app embedded in each container, require `releaseReady: true`, and require their bundle identifier, version, code-directory hash, and source revision to match the approved standalone-app proof. Unmount and delete the temporary roots afterward. A verifier pass for only the standalone app cannot approve the distributed containers.
15. Validate final DMG/ZIP names, sizes, SHA-256 hashes, `latest-mac.yml` entries and checksums, and every required blockmap against those container-verified artifacts.
16. Tag the verified release commit only after app proof and update-metadata validation pass, push that tag through sanitized Git, verify the remote tag resolves to the approved release commit, and confirm the active `v*` tag ruleset prevents update or deletion by every normal and administrator path.
17. Freeze one exact approved asset manifest containing every intended filename, byte size, and SHA-256 hash before creating the draft. Create the GitHub release as a draft through `<sanitized-gh-environment> "<canonical-gh-executable>" release create --verify-tag --draft` and permit only one separately controlled release authority to mutate that draft. Download all draft assets through that same authenticated sanitized GitHub CLI or authenticated API access into a new empty directory; require the complete remote asset set to equal the manifest exactly, with no missing, duplicate, or additional asset, and require every downloaded byte count and hash to match. Do not publish if authenticated draft download is unavailable or any comparison differs.
18. Immediately before publication, confirm the release session remains exclusive, re-fetch bounded release and asset metadata, and require the release is still a draft with exactly the frozen asset names and sizes. Recheck live `immutable-releases` evidence. Download the complete draft asset set again into a second new empty directory and repeat every filename, byte-size, and SHA-256 comparison. The next bounded operation must be `<sanitized-gh-environment> "<canonical-gh-executable>" release edit <tag> --draft=false`; stop if any other actor or operation intervenes. After publication, require `release view <tag> --json isDraft,isImmutable,assets` to report `isDraft: false`, `isImmutable: true`, and the same exact asset set. Through the same sanitized GitHub CLI, run `release verify <tag>` and require its attested subjects to equal that manifest exactly, then run `release verify-asset <tag> <local-approved-artifact>` for every and only approved asset. Archive the bounded GitHub release attestation and verification results in the privacy-safe proof bundle.
19. Update `crate-site/index.html` on a separate post-release site branch only after the immutable, attested GitHub DMG matches the approved local DMG, then commit, push, review, and merge its code-owned PR into protected `v2.4.x`; wait for required checks and confirm the local deploy source matches the remote merge commit.
20. Deploy Cloudflare Pages only from a new mode-`0700` private site snapshot materialized from the exact verified site merge commit. Compare its complete path, Git mode, byte-size, and Git-blob inventory to `<site-merge-commit>:crate-site` immediately before and after the deploy. Use the fresh lockfile-integrity-authenticated Wrangler reconstruction defined by `crate-cloudflare-deploy.md`; never deploy the live worktree, use `--commit-dirty=true`, run `npx`, or permit an unauthenticated on-demand package download.
21. Confirm `get-crate.com` points to the exact immutable, hash-verified GitHub DMG.

## Definition Of Done
- Release was started only after Bryant approval.
- `v2.4.x` was current before release changes.
- Version, build artifact, notarization, staple, and validation were verified.
- The clean approved verifier checkout proves the signed app's exact launch and security metadata, internally consistent main/helper build metadata, executable identity, Apple-anchored Developer ID signature, Electron runtime, ASAR header, approved arm64 architecture policy, and complete production dependency payload match authenticated locked inputs plus the exact pinned official Canvas prebuild.
- `crate-site/index.html` links to the intended DMG.
- Release commit and tag exist on remote.
- GitHub release exists with the expected artifact.
- The complete draft and published GitHub asset sets equal the frozen approved filenames, sizes, and SHA-256 hashes exactly, with no additional asset. Public stable additionally proves the attested asset set matches.
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
- Electron Builder creates DMG/ZIP containers before the app ticket is stapled, or only the standalone app is verified.
- A DMG or ZIP contains any entry outside its explicit reviewed inventory.
- The draft, published, or attested GitHub asset set differs from the frozen approved manifest or contains an additional asset.
- A release is published before its draft assets are downloaded and compared, repository release immutability or no-bypass tag immutability is disabled, or public-stable release/asset attestation verification fails.
- Electron Builder starts under build-only approval even though its `afterSign` hook notarizes the app.
- `crate-site/index.html` points to an old artifact.
- Cloudflare deploy succeeds but production domain still serves cached HTML.
- Credentials or notarization output leak secrets into logs or commits.
- Package files include unrelated dependency changes.
