---
name: crate-cloudflare-deploy
description: Deploy get-crate.com through Cloudflare Pages for Crate using the repo playbook, Keychain token retrieval, Wrangler verification, and privacy-safe proof. Use when Bryant explicitly approves a Cloudflare Pages or get-crate.com deploy.
---

# Crate Cloudflare Deploy

Use `.codex/playbooks/crate-cloudflare-deploy.md` completely before running deploy commands.

Required inputs:

- approved branch
- approved commit hash
- approved release/version markers
- confirmation that get-crate.com deploy is in scope

Required gates:

- run the Crate router start gate
- read Standing Order `SO-004`
- retrieve the Cloudflare token only from Keychain
- never print, paste, log, or report the token
- unset `CLOUDFLARE_API_TOKEN` after deploy

Required proof:

- Wrangler project name
- deployment URL
- live get-crate.com marker verification
- confirmation no token was exposed
- confirmation crate-web was not touched
