# Mobile Codex Workflow Playbook

## Purpose
Define how Bryant can supervise Crate work from iPhone Codex while the Mac mini runs Codex CLI and holds the working tree, credentials, builds, and release tools.

## When To Use
- When Bryant is away from the Mac but wants to steer active Crate work.
- When Codex CLI is running on the Mac mini and Bryant is approving, redirecting, or reviewing from iPhone.
- When deciding whether a task is safe to run remotely or must wait for direct Mac operation.

## Start Prompt
Use a prompt like:

```text
Use .codex/playbooks/mobile-codex-workflow.md. Give me a mobile-friendly Crate status with branch, changed files, commands run, risks, blocked approval-gated actions, and the next safe choice.
```

## Inspect
- Active branch and PR context.
- Current Codex CLI session status.
- Working tree status and changed files.
- Whether the next action mutates code, dependencies, release artifacts, credentials, or deployment state.
- Whether Bryant has explicitly approved any approval-gated command.

## Mobile-Safe Work
- Ask Codex CLI for status, summaries, risks, changed files, and next-step options.
- Review PR findings, regression audit results, and test output summaries.
- Approve or reject plans, test runs, documentation edits, and focused code fixes.
- Direct Codex to inspect files, run read-only commands, or run relevant tests.
- Decide whether to proceed with a merge, release step, or deploy after Codex reports readiness.

## Must Happen On Mac Or With Explicit Approval
- Manual Terminal commands Bryant wants to run directly.
- Accessing local GUI prompts, Keychain prompts, signing prompts, or Apple notarization flows.
- Dependency installs or lockfile updates.
- Release builds, notarization, stapling, validation, tagging, GitHub release creation, and Cloudflare deploys.
- Any command that uses credentials or could expose local secrets.
- Any destructive git command.

## Commands Codex May Run
```sh
git status --short --branch
git branch --show-current
git diff --name-only
git diff
gh pr view <pr> --json baseRefName,headRefName,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup
gh pr diff <pr> --name-only
npm test
npm run test
```

Codex should summarize command output clearly for Bryant on mobile, including failures and next choices.

## Commands Requiring Explicit Bryant Approval
```sh
npm install
npm audit fix
git commit
git push
git reset
git checkout -- <file>
gh pr merge <pr>
npx electron-builder --mac --arm64
xcrun notarytool submit <dmg> --wait
xcrun stapler staple <app-or-dmg>
xcrun stapler validate <app-or-dmg>
npx wrangler pages deploy <directory>
```

Approval should be specific to the action, target branch or PR, and expected result.

## Definition Of Done
- Bryant can see branch, changed files, tests run, risks, and proceed status from mobile.
- Codex CLI has not run approval-gated commands without explicit approval.
- Any Mac-only action is clearly identified.
- The working tree remains understandable from `git status --short --branch`.
- Next action is stated plainly.

## Report Format
- Current branch, PR if any, and working tree status.
- What Codex has done so far.
- Commands run and important outputs summarized.
- Approval-gated actions that are waiting on Bryant.
- Risks, blockers, and the next safe action.

## Risk Checklist
- Mobile approval is vague and Codex infers a broader action.
- Codex runs release or deploy commands from a status-check request.
- Local GUI prompts block while Bryant is remote.
- Secrets or credential outputs are pasted into chat.
- Multiple builder agents edit concurrently.
- Mac Terminal manual operations and Codex CLI operations diverge.
