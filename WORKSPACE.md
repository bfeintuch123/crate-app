# Crate Workspace Map

This workspace contains the Crate app repo and adjacent local repos. Use this map to avoid crossing repo boundaries.

## Repos

| Path | Repo | Branch | Package manager | Purpose |
| --- | --- | --- | --- | --- |
| `/Users/bryantfeintuchclaw/Projects` | `bfeintuch123/crate-app` | `v2.4.x` | npm | Electron app, QA prereleases, app source of truth |
| `/Users/bryantfeintuchclaw/Projects/crate-web` | `bfeintuch123/crate-web` | `main` | pnpm | public website and web app |
| `/Users/bryantfeintuchclaw/Projects/mission-control` | `bfeintuch123/mission-control` | `main` | npm | local productivity dashboard |

## Important Boundary

`crate-web` and `mission-control` are nested git repositories and appear as gitlinks in crate-app. There is no `.gitmodules` mapping. Treat them as separate repos unless Bryant explicitly scopes cross-repo work.

For crate-app release, QA, smoke-failure, and fix loops:

- do not touch crate-web
- do not deploy get-crate.com
- do not mutate mission-control
- do not inspect `.env`, `.env.local`, credentials, tokens, or secrets
- verify repo identity before editing

## Crate App Defaults

- Source of truth branch: `v2.4.x`
- PR base: `v2.4.x`
- Internal QA release tags: `v2.8.0-qa.<n>`
- App source changes require focused scope and tests.
- Internal QA prerelease version bumps should change only `package.json` and `package-lock.json`.
- Final public `v2.8.0`, get-crate.com, site deploys, tags, notarization, and GitHub releases require explicit Bryant approval.

## Common Status Check

```sh
for repo in /Users/bryantfeintuchclaw/Projects /Users/bryantfeintuchclaw/Projects/crate-web /Users/bryantfeintuchclaw/Projects/mission-control; do
  echo "$repo"
  git -C "$repo" remote -v | head -2
  git -C "$repo" status --short --branch
done
```

## Artifact Convention

- `dist/` contains generated app artifacts and may be large.
- Release artifacts are validated by the release gate, not by ordinary docs or fix loops.
- QA reports should be summarized in repo docs only after privacy review.
- Raw ChatGPT exports, Jenna-machine files, screenshots, recordings, and broad diagnostics should stay private unless Bryant explicitly approves committing a sanitized form.
