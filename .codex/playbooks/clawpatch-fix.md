# Clawpatch Fix Playbook

## Purpose
Make the smallest safe patch for a specific Crate bug, with clear blast radius, targeted tests, and no broad refactors.

## When To Use
- When Bryant asks for a surgical fix.
- When a regression has a known symptom and likely area.
- When a PR needs a minimal correction before merge.
- When release-readiness depends on one narrowly scoped bug fix.

## Start Prompt
Use a prompt like:

```text
Use .codex/playbooks/clawpatch-fix.md to make the smallest safe fix for <bug>. Keep the patch narrow, preserve Crate guardrails, run focused tests, and do not commit.
```

## Inspect
- Current branch and working tree state.
- The bug report, reproduction path, and expected behavior.
- The smallest code path that can explain the symptom.
- Adjacent tests and fixtures.
- Guardrails for Figma, Photoshop, Illustrator, InDesign, generic watchers, and package filtering.
- Existing user changes in the same files before editing.

## Commands Codex May Run
```sh
git status --short --branch
git diff --name-only
rg -n "<bug keyword>" .
npm test
npm run test
node tests/<focused-test>.js
```

Run the narrowest useful test before and after the patch when practical.

## Commands Requiring Explicit Bryant Approval
```sh
npm install
npm audit fix
git commit
git push
git reset
git checkout -- <file>
npx electron-builder --mac --arm64
npx wrangler pages deploy <directory>
```

Destructive git operations, dependency mutation, commits, pushes, release builds, and deploys require explicit Bryant approval.

## Patch Rules
- Change only files required for the bug.
- Avoid broad refactors, renames, formatting churn, and opportunistic cleanup.
- Preserve public behavior outside the bug unless Bryant explicitly approves a broader change.
- Add or update targeted tests proportional to risk.
- Explain the blast radius in the final report.

## Definition Of Done
- Reproduced or reasoned through the bug path.
- Applied the smallest safe patch.
- Added or updated targeted tests when feasible.
- Ran focused tests and any broader tests justified by risk.
- Reported files changed, tests run, exact commands, risks, branch status, and whether Bryant can proceed.
- Did not commit unless Bryant approved.

## Report Format
- Branch and starting working tree state.
- Root cause or best-supported bug path.
- Files changed and why each file changed.
- Tests or checks run, including exact commands.
- Blast radius, residual risks, and whether Bryant can proceed.

## Risk Checklist
- Fix changes watcher, parser, or package behavior outside the bug.
- Test coverage checks only the happy path.
- A refactor hides the actual behavior change.
- Existing user edits are overwritten.
- Figma scope guardrails are weakened.
- Package output changes without explicit expected-output verification.
