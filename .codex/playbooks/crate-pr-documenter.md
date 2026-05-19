# Crate PR Documenter Playbook

## Purpose
Generate high-quality Crate PR summaries, reviewer notes, tester notes, and release-note drafts from actual changed files, commands, and observed behavior.

This playbook improves the review loop by making PR context easier to consume without overstating what changed or pretending tests ran when they did not.

## When To Use
- Before opening a Crate PR.
- After a PR changes significantly and its description needs a refresh.
- When Bryant wants reviewer notes, tester instructions, or release-note draft language.
- After running `.codex/playbooks/crate-regression-detector.md`, `.codex/playbooks/crate-provenance-review.md`, `.codex/playbooks/crate-security-scan.md`, or `.codex/playbooks/crate-reprobox.md`.
- Before release planning, when merged PRs need a factual summary but are not yet released.

## Start Prompt
Use a prompt like:

```text
Use .codex/playbooks/crate-pr-documenter.md to draft PR documentation for this Crate branch. Base it only on changed files and commands actually run. Include scope, user impact, technical impact, tests, risks, tester notes, what did not change, and release need.
```

## Inspect
- Current branch, PR base, dirty state, and whether the PR should target `v2.4.x`.
- Changed files and diff.
- Existing PR title, body, labels, draft state, review status, and checks when a PR exists.
- Commands actually run in this session or provided by Bryant.
- Test output and known test gaps.
- User-facing behavior that changed.
- Technical behavior that changed.
- Explicit non-goals and guardrails preserved.
- Whether the change requires a release, a docs-only PR, or no release note.

## Files Codex May Read
- `AGENTS.md`
- `.codex/playbooks/*.md`
- `docs/*.md`
- changed files in the branch or PR
- `README.md`
- `package.json` read-only, for version/script context
- `tests/` read-only, for test names and coverage context
- PR metadata and diffs through `gh`

## Files Codex May Modify
- None by default.
- If Bryant explicitly asks Codex to update PR text through GitHub, Codex may modify only the PR title/body/comments.
- If Bryant explicitly asks for local documentation updates, Codex may modify only `.codex/playbooks/*.md`, `docs/*.md`, or `AGENTS.md` playbook references.

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
- `crate-site/` unless Bryant explicitly scopes site documentation work

## Commands Codex May Run
Inspect branch and diff:

```sh
git status --short --branch
git branch --show-current
git diff --name-only
git diff --stat
git diff
git log --oneline --decorate -n 20
```

Inspect PR context when a PR exists:

```sh
gh pr view <pr> --json number,url,title,body,baseRefName,headRefName,isDraft,state,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup
gh pr diff <pr> --name-only
gh pr diff <pr>
```

Verify command claims if needed:

```sh
git diff --check
node --check main.js
node tests/provenance.test.js
node tests/provenance-dual-write.test.js
node tests/psd-embedded-safety.test.js
node tests/figma-scope.test.js
node tests/figma-link-per-project.test.js
```

Do not run tests solely to make the PR description look stronger. Run tests only when Bryant asks for verification or the active review playbook calls for them.

## Documentation Checks
- Changed files: list the real files changed and group them by purpose.
- Scope summary: state the smallest true scope of the PR.
- User-facing impact: describe what users will notice, or say "No intended user-facing behavior change" when true.
- Technical impact: describe internal code, docs, workflow, provenance, parser, package, watcher, or release-process changes.
- Tests run: list only commands actually run and their results.
- Risks: name likely review risks, regression risks, and untested surfaces.
- Manual tester instructions: give concrete steps a tester can run, or say none are needed for docs-only changes.
- What changed: concise factual bullets based on the diff.
- What did not change: explicitly call out protected surfaces such as app behavior, Figma scope, package selection, parser behavior, dependencies, release files, or site deploys when relevant.
- Release need: state whether a release is required now, later, or not at all.

## Approval Gates
Codex may draft documentation locally in chat without approval. Bryant must explicitly approve any operation that mutates GitHub PR text, commits files, pushes branches, merges PRs, or changes release state.

Commands requiring explicit Bryant approval:

```sh
gh pr edit <pr> --title <title>
gh pr edit <pr> --body-file <file>
gh pr comment <pr> --body-file <file>
git add <files>
git commit
git push
gh pr merge <pr>
npm install
npm ci
npm audit fix
npm start
npx electron-builder --mac --arm64
xcrun notarytool submit <artifact> --wait
xcrun stapler staple <artifact>
xcrun stapler validate <artifact>
npx wrangler pages deploy <directory>
```

## Must Never Do
- Do not overstate behavior or imply broader product changes than the diff supports.
- Do not claim tests, builds, audits, releases, deploys, or manual checks ran unless they actually ran.
- Do not present release notes for unmerged code as if the release already shipped.
- Do not hide risks, skipped tests, dirty working tree state, or unrelated changes.
- Do not edit app code, tests, package files, release artifacts, or active provenance PR code.
- Do not merge, tag, release, deploy, or mutate dependencies.

## Quality Impact
- Speeds review by giving reviewers a factual map of changed files, intent, risks, and test evidence.
- Reduces release mistakes by separating PR notes from shipped release notes.
- Keeps tester instructions concrete and reproducible.
- Prevents accidental claims that behavior changed, tests passed, or releases shipped.
- Makes docs-only, process-only, and app-code PRs easier to distinguish.

## Definition Of Done
- Branch, PR base, dirty state, and changed files are captured.
- PR summary, reviewer notes, tester notes, risks, tests run, non-goals, and release need are drafted.
- All claims are traceable to a diff, command output, Bryant-provided context, or explicit assumption.
- Tests not run are stated as not run.
- No app code, tests, package files, release files, builds, tags, deploys, or dependencies are changed.
- Bryant receives text that can be used for a PR body, reviewer note, or release-note draft.

## Report Format
- Suggested PR title.
- Summary.
- Changed files.
- User-facing impact.
- Technical impact.
- Tests run.
- Manual tester notes.
- Risks and test gaps.
- What changed.
- What did not change.
- Release need.
- Ready-to-paste PR body when requested.
