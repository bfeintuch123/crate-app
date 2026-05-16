# Figma Regression Audit Playbook

## Purpose
Audit Figma-related Crate behavior for regressions in page scope, per-project links, package-time enforcement, component dependencies, dragged assets, and package output.

## When To Use
- Before merging PRs that touch Figma capture, parser, package, session, or project-link code.
- After fixing a Figma bug.
- Before a release when recent work touched Figma-adjacent code.
- When Bryant reports page switching, package scope, or dragged asset regressions.

## Start Prompt
Use a prompt like:

```text
Use .codex/playbooks/figma-regression-audit.md to audit this branch for Figma regressions. Preserve Current Page Only default, Entire File opt-in, fail-closed page lock behavior, package-time scope enforcement, and multi-app capture behavior.
```

## Inspect
- Current Page Only remains the default.
- Entire File remains explicit opt-in.
- Per-project Figma links are preserved and do not bleed across projects.
- Page lock resolution is fail-closed when the page cannot be resolved.
- Package-time scope enforcement prevents unintended pages from entering output.
- Page switching preserves the selected scope and does not silently widen capture.
- Component dependencies are included only when required by the selected scope.
- Photoshop-to-Figma dragged assets still package correctly.
- Figma package output has expected files, paths, and metadata.
- Multi-app capture behavior remains intact when Figma and Adobe apps are involved.

## Commands Codex May Run
```sh
git status --short --branch
git diff --name-only
rg -n "Figma|figma|Current Page|Entire File|page lock|pageLock|package" .
npm test
npm run test
node tests/<focused-figma-test>.js
```

Use focused tests first when available. Do not broaden the audit into unrelated Adobe or generic watcher behavior unless the diff touches that path.

## Commands Requiring Explicit Bryant Approval
```sh
git commit
git push
npm install
npm audit fix
npx electron-builder --mac --arm64
npx wrangler pages deploy
```

Any command that mutates dependencies, publishes, deploys, builds a release, or changes remote state requires explicit Bryant approval.

## Definition Of Done
- Confirmed Current Page Only default is preserved.
- Confirmed Entire File is opt-in only.
- Confirmed per-project links and page lock behavior remain scoped.
- Confirmed package-time scope enforcement remains fail-closed.
- Checked page switching, component dependencies, dragged assets, and package output.
- Ran relevant Figma regression tests or reported the exact test gap.
- Summarized residual Figma risks and whether Bryant can proceed.

## Report Format
- Branch and diff scope.
- Figma files and code paths inspected.
- Guardrail-by-guardrail result.
- Tests or checks run, including exact commands.
- Regressions, test gaps, and residual risks.
- Whether Bryant can proceed.

## Risk Checklist
- Entire File capture becomes the default.
- Page lock failure falls back to broad capture.
- Per-project Figma links are overwritten, shared globally, or dropped.
- Page switching changes scope without user intent.
- Component dependencies pull in unrelated pages or frames.
- Dragged Photoshop assets disappear from Figma package output.
- Package output contains files outside the selected page scope.
- Multi-app capture breaks when Figma is used alongside Photoshop, Illustrator, or InDesign.
