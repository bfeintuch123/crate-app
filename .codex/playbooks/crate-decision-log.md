# Crate Decision Log Playbook

## Purpose
Preserve important Crate product and architecture decisions so future Codex sessions do not re-litigate them or drift.

Decision logging is process infrastructure. It should capture Bryant-approved decisions, the context behind them, and their implications without pretending that a decision is implemented app behavior before the code actually does it.

## When To Use
- When Bryant makes or confirms a product, release, QA, provenance, privacy, architecture, or rollout decision.
- Before a PR when the implementation depends on an existing Crate decision.
- During review when Codex is about to revisit a settled product or architecture question.
- After QA or tester feedback creates a product requirement gap that Bryant resolves.
- Before release planning when current release, prerelease, site, or tester-rollout policy matters.

## Start Prompt
Use a prompt like:

```text
Use .codex/playbooks/crate-decision-log.md to record or reference this Bryant-approved Crate decision. Include date, decision, context, rationale, implications, supersession status, PR references, and do not change app code.
```

## Seed Decisions To Preserve
These are Bryant-provided Crate process and product decisions that future sessions should preserve unless Bryant explicitly supersedes them.

### Provenance Is Hidden Intelligence, Visible Trust
- Decision: Provenance should mostly work as hidden intelligence that improves packaging and confidence, while users see clear trust signals, warnings, and package evidence.
- Context: Crate is a desktop creative workflow and provenance app for designers.
- Rationale: Users need confidence and reviewability without being forced to understand every internal graph edge.
- Implications: UI, QA, and release notes should avoid over-explaining internals unless they help users trust package output.

### v2.8.0 Is The First Evidence-Aware Release
- Decision: v2.8.0 is the first evidence-aware release, not perfect provenance.
- Context: The provenance foundation is merged into `v2.4.x` and packaged in internal QA prerelease `v2.8.0-qa.1`, while final `v2.8.0` has not been released.
- Rationale: The release should introduce evidence-aware package review while keeping claims conservative.
- Implications: QA and PR notes should frame provenance as incremental and evidence-aware, not complete or exhaustive.

### Conservative And Explainable Beats Aggressive And Wrong
- Decision: Conservative, explainable behavior beats aggressive inference that may be wrong.
- Context: Crate observes creative app state, package output, parser output, and provenance hints that can be partial.
- Rationale: Wrong inclusion, wrong exclusion, or overclaimed provenance can damage trust more than an explicit limitation.
- Implications: Confidence bands, warnings, and known limitations should remain visible in reports and reviews.

### lsof And appProcess Are Supporting Evidence
- Decision: `lsof` and app-process observations are supporting evidence, not deterministic truth.
- Context: Open files and active app process state can help explain workflows, but they can be stale, noisy, or unrelated.
- Rationale: A process-level signal does not prove a creative asset relationship by itself.
- Implications: Reports should not promote these signals to confirmed relationships without stronger package, parser, or materialization evidence.

### crate-provenance.json Is Partial And Package-Relevant For Now
- Decision: `crate-provenance.json` is partial and package-relevant for now.
- Context: Crate writes provenance artifacts that summarize package-relevant evidence, warnings, counts, nodes, edges, and limitations.
- Rationale: The manifest is useful even when the full creative history cannot be proven.
- Implications: Snapshot, QA, and release reports should distinguish package-confirmed facts from omitted, unknown, likely, candidate, or weak relationships.

### get-crate.com Does Not Update For Internal QA Prereleases
- Decision: `get-crate.com` should not update for internal QA prereleases.
- Context: Public production release and internal QA prerelease states can differ.
- Rationale: Public users should not be moved to QA builds until Bryant approves a final release.
- Implications: Site deploys wait for final release approval and release-gate validation.

### External Tester Rollout Starts Small
- Decision: External tester rollout starts small.
- Context: Crate is validating designer workflows, package contents, provenance output, privacy behavior, install friction, and communication.
- Rationale: Small rollout catches high-signal issues before broad external exposure.
- Implications: Tester intake, QA synthesis, and bug triage should protect privacy and prioritize learning over volume.

### Jenna QA Is Internal Validation
- Decision: Jenna QA is internal validation, not broad external testing.
- Context: Jenna QA is pending for the current QA prerelease path.
- Rationale: Internal validation should de-risk the first external tester loop.
- Implications: Do not treat Jenna QA as broad market validation or as a substitute for release-gate checks.

## Decision Entry Template
Use this template for every new decision:

```md
## <YYYY-MM-DD> - <Short Decision Name>

- Status: proposed | approved | superseded
- Decision owner: Bryant
- Decision:
- Context:
- Rationale:
- Implications:
- Non-goals:
- Applies to:
- Does not apply to:
- Related PRs:
- Related issues:
- Related playbooks:
- Supersedes:
- Superseded by:
- Evidence:
- Open questions:
```

## How To Reference Decisions In Future PRs
- Link or quote the decision title in the PR body or reviewer notes.
- State whether the PR implements, preserves, tests, documents, or intentionally does not touch the decision.
- Keep the reference factual: "Preserves the decision that `crate-provenance.json` is partial and package-relevant for now."
- Do not claim the PR implements a decision unless the diff actually changes app behavior, tests, or documentation in that direction.
- If a decision affects release notes, state whether the release is public, prerelease, internal QA, or unreleased.
- If a decision affects QA, name the relevant QA playbook and the evidence needed to validate it.

## How To Add New Decisions
1. Confirm Bryant approved the decision or explicitly asked Codex to draft it as proposed.
2. Check whether an existing decision already covers the topic.
3. Add a new entry using the template.
4. If changing a prior decision, mark the prior entry as superseded instead of silently rewriting it.
5. Keep app behavior claims separate from product intent unless the implementation exists.
6. Run docs-only checks.
7. Ask Bryant before committing.

## Files Codex May Read
- `AGENTS.md`
- `.codex/playbooks/*.md`
- `.codex/decisions/*.md` if present
- `docs/*.md`
- `README.md`
- PR and issue metadata through `gh`
- `package.json` read-only, for version context only
- changed files read-only when a PR claims to implement or preserve a decision

## Files Codex May Modify
- None by default.
- With Bryant's explicit approval for process docs, `.codex/decisions/*.md`, `docs/*.md`, `.codex/playbooks/*.md`, or `AGENTS.md` playbook references.
- With Bryant's explicit approval for PR documentation, GitHub PR body or comments.

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
- `crate-site/`
- package outputs
- tester or client assets

## Read-Only Commands Codex May Run
Inspect branch and local docs state:

```sh
git status --short --branch
git branch --show-current
git diff --name-only
git diff --stat
git log --oneline --decorate -n 20 -- AGENTS.md .codex/playbooks docs .codex/decisions
```

Search for existing decisions and related language:

```sh
rg -n "hidden intelligence|visible trust|evidence-aware|perfect provenance|conservative|explainable|lsof|appProcess|crate-provenance\\.json|QA prerelease|Jenna QA|tester rollout|get-crate\\.com" AGENTS.md .codex/playbooks docs .codex/decisions
```

Inspect PR context when a PR references a decision:

```sh
gh pr view <pr> --json number,title,body,baseRefName,headRefName,state,isDraft,url
gh pr diff <pr> --name-only
gh pr diff <pr>
```

Run docs-only checks after editing decision docs:

```sh
git diff --check
rg -n "[[:blank:]]$" AGENTS.md .codex/playbooks docs .codex/decisions
rg -n "[^[:ascii:]]" AGENTS.md .codex/playbooks docs .codex/decisions
```

## Required Checks
- Decision is either Bryant-approved or clearly marked proposed.
- Date, decision, context, rationale, and implications are present.
- Related PRs, issues, playbooks, and releases are linked or marked none/unknown.
- Prior decisions are not rewritten without a supersession note.
- Implementation status is separated from product intent.
- Privacy, release, QA, and provenance implications are named when relevant.
- Docs-only checks pass before committing any decision-log change.

## Approval Gates
Codex may draft proposed decision text in chat. Bryant must explicitly approve recording a decision, superseding a decision, mutating GitHub PR text, committing files, pushing branches, merging PRs, or changing release state.

Commands requiring explicit Bryant approval:

```sh
mkdir -p .codex/decisions
git add <files>
git commit
git push
gh pr edit <pr> --body-file <file>
gh pr comment <pr> --body-file <file>
gh issue create
gh issue edit <issue>
gh pr merge <pr>
npm install
npm ci
npm audit fix
npm start
npx electron-builder --mac --arm64
xcrun notarytool submit <artifact> --wait
xcrun stapler staple <artifact>
xcrun stapler validate <artifact>
git tag <tag>
gh release create <tag>
npx wrangler pages deploy <directory>
```

## Must Never Do
- Do not invent decisions Bryant did not approve.
- Do not rewrite past decisions without noting supersession.
- Do not treat decisions as app behavior unless implemented.
- Do not use the decision log to bypass tests, QA, release gates, or PR review.
- Do not expose private tester, client, credential, token, or local-path data.
- Do not edit app code, tests, package files, release artifacts, site files, dependencies, or package outputs.
- Do not tag, release, deploy, notarize, merge, or mutate GitHub state without explicit Bryant approval.

## Quality Impact
- Reduces bugs caused by repeatedly reopening settled product or architecture choices.
- Speeds PR review by giving reviewers the rationale behind conservative provenance, QA, release, and rollout behavior.
- Prevents release and site mistakes by preserving prerelease versus public-release decisions.
- Keeps provenance claims aligned with current implementation and known limitations.
- Helps future Codex sessions distinguish Bryant-approved strategy from speculation.

## Definition Of Done
- Decision status is clear: proposed, approved, or superseded.
- Date, context, rationale, implications, and references are recorded.
- Prior decisions are preserved or explicitly superseded.
- App behavior claims are limited to implemented behavior.
- No app code, tests, package files, release artifacts, site files, builds, tags, deploys, dependencies, or package outputs are changed.
- Bryant receives the decision text and any open questions before commit.

## Report Format
- Branch and dirty state:
- Decision action:
  - New decision:
  - Referenced decision:
  - Superseded decision:
- Decision text:
- Context and rationale:
- Implications:
  - Product:
  - Architecture:
  - QA:
  - Release:
  - Privacy:
- Related PRs/issues/playbooks:
- Files changed:
- Commands run:
- Risks and open questions:
- Whether Bryant can proceed:
