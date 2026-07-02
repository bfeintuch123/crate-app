# Crate Cloudflare Deploy Playbook

## Purpose

Deploy `crate-site` to the Cloudflare Pages project `get-crate` through one safe, repeatable path.

Use this only when Bryant explicitly approves a get-crate.com or Cloudflare Pages deploy.

## Source

This playbook implements Standing Order `SO-004` from `.codex/ops/standing-orders.md`.

## Start Gate

Before any deploy command, confirm:

- repo path is `/Users/bryantfeintuchclaw/Projects`
- repo is `bfeintuch123/crate-app`
- current branch and commit match Bryant's approved deploy target
- deployment directory is `crate-site`
- Cloudflare Pages project is `get-crate`
- Cloudflare token is available from Keychain service `crate-cloudflare-api-token`
- token value will not be printed, logged, or pasted
- deploy is explicitly approved in the current prompt or active release taskflow

Stop if any item does not match.

## Keychain Token Pattern

Use:

```sh
export CLOUDFLARE_API_TOKEN="$(security find-generic-password -a "$USER" -s crate-cloudflare-api-token -w)"
```

Never echo the token. Never include it in final reports, logs, screenshots, or taskflows.

Unset it after deploy:

```sh
unset CLOUDFLARE_API_TOKEN
```

## Deploy Command

Use the approved branch and commit:

```sh
npx wrangler pages deploy crate-site \
  --project-name get-crate \
  --branch <approved-branch> \
  --commit-hash <approved-commit> \
  --commit-message "<approved-message>" \
  --commit-dirty=true
```

Notes:

- `--commit-dirty=true` is allowed when the site directory has the already-approved local release change and Bryant approved deploy from the current working tree.
- Do not deploy `crate-web`.
- Do not deploy from `main` unless Bryant explicitly approves `main`.

## Verification

After deploy:

```sh
npx wrangler pages deployment list --project-name get-crate
curl -fsSL "https://get-crate.com/?crate-cache-bust=$(date +%s)" | tee /tmp/crate-site-live.html >/dev/null
```

Then verify expected version/download markers with `rg`.

Example:

```sh
rg "v3.0.0-beta.1|Crate-3.0.0-beta.1-arm64.dmg" /tmp/crate-site-live.html
```

## Proof Required

Report:

- branch
- commit
- Wrangler project
- deployment URL
- live-site verification markers
- confirmation no token value was printed
- confirmation no crate-web deploy happened

## Stop Gates

Stop for:

- missing Keychain token
- wrong Cloudflare account/project
- wrong branch/commit/version
- failed deploy
- live site missing expected markers
- any prompt to reveal or paste token
- any accidental crate-web or dependency mutation
