# Crate Cloudflare Deploy Playbook

## Purpose

Deploy `crate-site` to the Cloudflare Pages project `get-crate` through one safe, repeatable path.

Use this only when Bryant explicitly approves a get-crate.com or Cloudflare Pages deploy.

## Source

This playbook implements Standing Order `SO-004` from `.codex/ops/standing-orders.md`.

## Start Gate

Before any deploy command, confirm:

- repo path is the canonical Crate source root
- repo is `bfeintuch123/crate-app`
- current branch and commit match Bryant's approved deploy target
- `git status --porcelain=v1 --untracked-files=all` is empty, `HEAD` equals the approved commit, and that commit equals `origin/<approved-branch>` after an explicit fetch
- deployment input is a new private snapshot of `<approved-commit>:crate-site`, never the live worktree directory
- Cloudflare account ID is exactly `ba2eae4575a070ed70ae9be217fa21dc`
- Cloudflare Pages project is `get-crate`
- a separately approved Wrangler manifest and lockfile identify one exact version and are available for immediate fresh reconstruction before token access
- Cloudflare token is available from Keychain service `crate-cloudflare-api-token`
- token value will not be printed, logged, or pasted
- deploy is explicitly approved in the current prompt or active release taskflow

Stop if any item does not match.

## Authenticated Tool Gate

Complete this gate before reading the Keychain token:

- Never use `npx`, `npm exec`, an env shebang, or an on-demand Wrangler download.
- Record an existing canonical `<approved-home>` only to resolve the exact approved local Keychain account name before the bounded deployment subshell. Before reading the token, create new canonical mode-`0700` `<private-deploy-temp-root>`, `<private-wrangler-home>`, `<private-wrangler-tool-root>`, `<private-wrangler-cache-root>`, and `<private-site-snapshot-root>` directories outside the Crate worktree. `<private-wrangler-home>` must start empty and must not contain credentials, Wrangler configuration, npm configuration, or links.
- Require the approved Wrangler `package.json` and lockfile to be regular committed files, reject `.npmrc` and `npm-shrinkwrap.json` including symlinks, and record both file hashes. After rejecting either path if it exists or is a symlink, create distinct empty mode-`0600` regular `<private-wrangler-user-npmrc>` and `<private-wrangler-global-npmrc>` files inside `<private-deploy-temp-root>` with `/usr/bin/install -m 600 /dev/null`; verify both canonical paths stay inside the private root, differ, and remain owner-only regular files before and after npm use. Reconstruct the tool tree immediately before token access with canonical Node and npm under `/usr/bin/env -i HOME="<private-wrangler-home>" TMPDIR="<private-deploy-temp-root>" PATH=/usr/bin:/bin:/usr/sbin:/sbin npm_config_cache="<private-wrangler-cache-root>" npm_config_userconfig="<private-wrangler-user-npmrc>" npm_config_globalconfig="<private-wrangler-global-npmrc>" npm_config_registry=https://registry.npmjs.org/ npm_config_strict_ssl=true`, using `npm ci --ignore-scripts --registry=https://registry.npmjs.org/`.
- Authenticate the complete reachable Wrangler dependency tree against the approved lockfile: exact package names, versions, dependency topology, registry URLs, lockfile integrity, installed regular-file inventory, and bytes from authenticated registry archives. Reject symlinks, lifecycle execution, extra packages, package-file drift, or an incomplete proof. Record the tool root directory identity and complete inventory digest; recheck both immediately before and after every Wrangler invocation. A stale previously installed tool tree is not acceptable.
- Resolve the Wrangler CLI to a regular file inside that authenticated tree. Record and recheck canonical Node realpath/SHA-256/version, npm CLI realpath/SHA-256/version, Wrangler CLI realpath/SHA-256/version, the tool lock hash, and the tree inventory digest. Stop on any drift.
- Materialize only the exact committed `crate-site` tree into `<private-site-snapshot-root>` using the sanitized Git command from `release-crate.md`. Reject symlinks, submodules, executable files, special files, duplicate paths, and any path outside the snapshot root. Compare the complete relative-path, Git-mode, byte-size, and Git-blob-ID inventory to `<approved-commit>:crate-site`; record one inventory digest and recheck it immediately before and after deploy.
- Run every authenticated Wrangler invocation from `<private-wrangler-home>` as its working directory, never from the repository or site snapshot. Invoke Wrangler only through `/usr/bin/env -i HOME="<private-wrangler-home>" TMPDIR="<private-deploy-temp-root>" PATH=/usr/bin:/bin:/usr/sbin:/sbin CLOUDFLARE_ACCOUNT_ID="ba2eae4575a070ed70ae9be217fa21dc" CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN" "<canonical-node-executable>" "<authenticated-wrangler-cli>"`; the CLI must remain inside the authenticated tool root. This minimal environment, fixed account, isolated working directory, and fresh empty home drop inherited Node, npm, Wrangler, proxy, dynamic-loader, tracing, shell, repository, and user-level Wrangler configuration.

## Keychain Token Pattern

Read the token only inside the bounded deployment subshell:

```sh
(
  umask 077
  set +x
  set +v
  account_proof=''
  CLOUDFLARE_API_TOKEN="$(/usr/bin/security find-generic-password -a "<approved-local-account>" -s crate-cloudflare-api-token -w)"
  trap 'unset CLOUDFLARE_API_TOKEN; test -z "$account_proof" || /bin/rm -f "$account_proof"' EXIT HUP INT TERM
  test -n "$CLOUDFLARE_API_TOKEN" || exit 1
  account_proof="$(/usr/bin/mktemp "<private-deploy-temp-root>/crate-cloudflare-account.XXXXXX")"
  if ! (
    cd "<private-wrangler-home>" || exit 1
    /usr/bin/env -i \
      HOME="<private-wrangler-home>" \
      TMPDIR="<private-deploy-temp-root>" \
      PATH=/usr/bin:/bin:/usr/sbin:/sbin \
      CLOUDFLARE_ACCOUNT_ID="ba2eae4575a070ed70ae9be217fa21dc" \
      CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN" \
      "<canonical-node-executable>" "<authenticated-wrangler-cli>" whoami
  ) >"$account_proof" 2>&1; then
    exit 1
  fi
  if ! "<authenticated-rg-executable>" -q 'ba2eae4575a070ed70ae9be217fa21dc' "$account_proof"; then
    exit 1
  fi
  /bin/rm -f "$account_proof"
  account_proof=''
  # Run the deploy and deployment-list commands from the next sections here.
)
```

Disable shell execution and verbose tracing before the Keychain read, and do not re-enable either while the token exists. The private `whoami` proof must contain the one fixed account ID before deploy; archive only the pass/fail result and approved account ID, then remove its raw output. Never export or echo the token. Never include it in final reports, logs, screenshots, taskflows, command arguments, or any process environment outside the bounded Wrangler subprocess. The trap must unset it on normal exit and interruption.

## Deploy Command

Use the approved branch and commit:

```sh
(
  cd "<private-wrangler-home>" || exit 1
  /usr/bin/env -i \
    HOME="<private-wrangler-home>" \
    TMPDIR="<private-deploy-temp-root>" \
    PATH=/usr/bin:/bin:/usr/sbin:/sbin \
    CLOUDFLARE_ACCOUNT_ID="ba2eae4575a070ed70ae9be217fa21dc" \
    CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN" \
    "<canonical-node-executable>" "<authenticated-wrangler-cli>" pages deploy "<private-site-snapshot-root>" \
    --project-name get-crate \
    --branch <approved-branch> \
    --commit-hash <approved-commit> \
    --commit-message "<approved-message>"
)
```

Notes:

- Never pass `--commit-dirty=true`; commit, review, and merge every deploy input first.
- Never deploy `crate-site` from the live checkout; the private committed snapshot is the only valid input.
- Do not deploy `crate-web`.
- Do not deploy from `main` unless Bryant explicitly approves `main`.

## Verification

After deploy:

```sh
(
  cd "<private-wrangler-home>" || exit 1
  /usr/bin/env -i \
    HOME="<private-wrangler-home>" \
    TMPDIR="<private-deploy-temp-root>" \
    PATH=/usr/bin:/bin:/usr/sbin:/sbin \
    CLOUDFLARE_ACCOUNT_ID="ba2eae4575a070ed70ae9be217fa21dc" \
    CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN" \
    "<canonical-node-executable>" "<authenticated-wrangler-cli>" pages deployment list --project-name get-crate
)
live_html="$(/usr/bin/mktemp "<private-deploy-temp-root>/crate-site-live.XXXXXX")"
/usr/bin/env -i HOME="<private-live-check-home>" PATH=/usr/bin:/bin:/usr/sbin:/sbin \
  /usr/bin/curl -q --noproxy '*' --proto '=https' --tlsv1.2 --fail --silent --show-error --location \
  "https://get-crate.com/?crate-cache-bust=$(/bin/date +%s)" >"$live_html"
```

`<private-live-check-home>` must be a new empty mode-`0700` directory. The `env -i`, `-q`, and `--noproxy '*'` controls prevent proxy variables, `~/.curlrc`, and inherited network configuration from redirecting the live check. Then verify expected version/download markers with the authenticated absolute `rg` executable against `"$live_html"`, and remove that file before deleting the private temporary root.

Example:

```sh
"<authenticated-rg-executable>" "v3.0.0-beta.1|Crate-3.0.0-beta.1-arm64.dmg" "$live_html"
```

## Proof Required

Report:

- branch
- commit
- Wrangler project
- fixed Cloudflare account ID
- deployment URL
- live-site verification markers
- confirmation no token value was printed
- canonical Node, fresh private Wrangler home, and authenticated Wrangler tree proof identifiers, without local private paths
- committed site snapshot commit and inventory digest
- confirmation no crate-web deploy happened

## Stop Gates

Stop for:

- missing Keychain token
- missing, changed, or unauthenticated canonical Node/Wrangler proof
- stale Wrangler installation, incomplete transitive dependency proof, or tool-tree drift
- committed site snapshot mismatch or any attempt to deploy the live worktree
- missing or unsafe approved home, local Keychain account, private Wrangler home, or private deployment temporary root
- wrong Cloudflare account/project or a failed/missing private `whoami` binding proof
- dirty worktree or local/remote commit mismatch
- wrong branch/commit/version
- failed deploy
- live site missing expected markers
- any prompt to reveal or paste token
- any accidental crate-web or dependency mutation
