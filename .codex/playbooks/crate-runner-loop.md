# Crate Runner Loop Playbook

## Purpose
Define Crabbox-style self-verifying Codex App loops for Crate.

A Runner Loop means Codex verifies work through repeatable commands and evidence, not just code edits. The loop is useful when Bryant wants Codex to keep iterating only after each step has a concrete command result, artifact, log, or QA observation that proves the current state.

This playbook complements `crate-codex-loops.md`. Use `crate-codex-loops.md` for autonomy boundaries and stop gates; use this playbook for runner tiers, repeatable command sets, and evidence format.

## Ops Integration

Runner loops must use the Crate ops layer:

- standing order: `.codex/ops/standing-orders.md`
- taskflow state: `.codex/taskflows/README.md`
- memory routing: `.codex/ops/crate-memory-model.md`
- proof closeout: `.codex/ops/proof-bundle-template.md`
- skill/tool registry: `.codex/ops/skill-registry.md`

For release, deploy, long-running QA, or external-control work, run Crate Doctor before selecting runner commands:

```sh
python3 .codex/tools/crate_doctor.py
```

If the doctor reports warnings, classify them before continuing. If it reports failures, stop unless the active playbook says the failed area is outside scope.

## When To Use
- Bryant asks for Crabbox-style, runner-backed, or self-verifying Crate loops.
- Codex needs a repeatable non-GUI command suite before making or approving changes.
- A fresh agent needs to know which checks can run locally, remotely, on the signing Mac, or only through installed-app QA.
- Operational runner configuration and collection are owned by the separately reviewed Crate Ops workflow; no runner configuration belongs in Crate App.

## Start Prompt
Use a prompt like:

```text
Use .codex/playbooks/crate-runner-loop.md and .codex/playbooks/crate-codex-loops.md for <goal>.
Execution tier: <A|B|C|D>.
Allowed runner commands: <command list or suite>.
Evidence required: command, environment, branch/commit, run id if available, logs/evidence location, pass/fail, duration, failures, next action.
Do not add runner configuration, mutate dependencies, build, release, deploy, tag, notarize, or touch crate-web unless explicitly approved.
```

## Definitions

### Runner Loop
A Runner Loop is a Crate loop where each meaningful action is followed by repeatable verification. The loop does not claim progress merely because files were edited. It must show command output, structured status, logs, artifacts, or GUI QA evidence that supports the next decision.

Runner Loop cycle:

```text
Observe -> Choose runner tier -> Run command/check -> Record evidence -> Evaluate -> Fix/Continue/Handoff
```

### Runner Evidence
Every runner-backed step should capture:
- command
- environment
- branch/commit
- standing order
- taskflow path
- run id if a remote runner is used
- logs/evidence location
- pass/fail
- duration
- failures
- next action

Evidence must avoid secrets, raw private file lists, raw lsof/ps/mdls output, raw AppleScript/JXA output, Figma tokens, signed URLs, and unrelated private/client file paths.

## Execution Tiers

### Tier A: Codex App On Mac Mini
Use for normal local Crate development, docs checks, focused Node tests, and Mac-aware repository work that does not require signing or installed-app GUI QA.

Good for:
- syntax checks
- Node test suites
- npm audit high-severity gate
- docs checks
- git diff inspection
- PR preparation

Must not do without explicit approval:
- release build
- signing
- notarization
- stapling
- deploy
- tag
- dependency mutation

### Tier B: Crabbox / Remote Non-GUI Runner
Use only for checks that do not depend on macOS GUI state, signing identities, local Keychain, installed creative apps, private local files, or Crate app installation state.

Good for future jobs:
- quick-check
- provenance-suite
- figma-suite
- package-parser-suite
- full-nongui-suite

Not allowed on Tier B:
- release/sign/notarize/deploy jobs
- installed-app GUI smoke
- Adobe/Figma/Keynote/PowerPoint GUI workflows
- private local QA folder access
- tests that require Mac mini Keychain, Apple Developer credentials, or signing identity

### Tier C: Mac Mini Signed Release Environment
Use for release-gate work that depends on the local signing and notarization environment.

Mac mini only:
- `electron-builder`
- `codesign`
- notarization
- stapling
- `latest-mac.yml` final verification
- GitHub prerelease

Tier C requires explicit Bryant approval for each release mutation or exact release-gate preauthorization. Stop for Keychain prompts, Apple credentials, missing signing identity, failed notarization, artifact mismatch, tag/release conflicts, or any public stable release action not explicitly approved.

### Tier D: Jenna Installed-App GUI QA
Use for installed DMG and real workflow validation with approved GUI lanes.

Jenna only:
- Adobe/Figma/Keynote/PowerPoint GUI tests
- installed DMG smoke
- approved real-file QA folders
- Computer Use/System Events workflows

Tier D evidence may include screenshots, package filenames, visible UI states, Package Details text, and approved QA fixture names. Do not collect private client material, raw broad file lists, tokens, signed URLs, or unapproved local paths.

## Safe Runner-Compatible Commands
These commands are safe for Tier A and may be safe for Tier B when dependencies and fixtures are available:

```sh
npm audit --audit-level=high
node --check main.js
node --check provenance.js
node --check renderer/app.js
node --check parsers/index.js
node --check parsers/powerpoint.js
node --check parsers/figma.js
node --check parsers/package-safety.js
node --test tests/main-window-lifecycle.test.js
node --test tests/provenance.test.js
node --test tests/provenance-dual-write.test.js
node --test tests/psd-embedded-safety.test.js
node --test tests/figma-link-per-project.test.js
node --test tests/figma-scope.test.js
node --test tests/figma-token-privacy.test.js
node --test tests/renderer-figma-scope.test.js
node --test tests/quick-package-parser.test.js
git diff --check
```

Notes:
- `npm audit --audit-level=high` may report known lower-severity advisories; do not mutate dependencies unless explicitly approved.
- Long tests such as `tests/provenance-dual-write.test.js` should be allowed to finish before deciding pass/fail.
- Use focused subsets first when the loop goal is narrow; use the full non-GUI suite when the risk surface is broad.

## Crate Ops Runner Ownership

Operational Crabbox collection and validation are owned by the separately
reviewed Crate Ops crate-crabbox workflow (PR #15). Crate App retains the
generic runner evidence format, safe command sets, product-specific validation
guidance, and the QA/release/signing/notarization/deploy boundaries above; no
runner implementation or operational configuration belongs in this repository.

Real Mac capture remains the authority for Crate UI evidence. The Crate Ops
workflow may validate already-captured, already-inspected sanitized media, but
it cannot capture or simulate the macOS app. A GitHub PR user attachment is the
sole durable publication destination and is public disclosure; never use a
release asset or alternate backend for visual proof. If collection or
publication is unavailable, retain the verified local bundle, report the exact
blocker, and fail closed.

## Runner Evidence Format
Use this format in reports, loop state, PR notes, or handoffs:

```markdown
## Runner Evidence

- command:
- environment:
- branch/commit:
- standing order:
- taskflow:
- run id if Crabbox:
- logs/evidence location:
- pass/fail:
- duration:
- failures:
- next action:
```

Example:

```markdown
## Runner Evidence

- command: `node --test tests/provenance-dual-write.test.js`
- environment: Tier A, Codex App on Mac mini
- branch/commit: `fix/example`, `abc1234`
- standing order: `SO-002 Autonomous Crate Failure Loop`
- taskflow: `.codex/taskflows/2026-07-02-example.md`
- run id if Crabbox: not applicable
- logs/evidence location: terminal output in current Codex session
- pass/fail: pass
- duration: 93s
- failures: none
- next action: run `git diff --check`, then self-review changed files
```

## Runner Suites

### quick-check
Use for cheap validation after docs or narrow code edits.

```sh
node --check main.js
node --check provenance.js
node --check renderer/app.js
git diff --check
```

For docs-only work, use the docs check commands from the relevant playbook instead of app syntax checks unless the docs make behavior claims that need code validation.

### provenance-suite
Use for provenance, live evidence, diagnostics, package manifest, and session decision-layer changes.

```sh
node --test tests/provenance.test.js
node --test tests/provenance-dual-write.test.js
git diff --check
```

### figma-suite
Use for Figma scope, token privacy, renderer scope, and per-project link changes.

```sh
node --test tests/figma-link-per-project.test.js
node --test tests/figma-scope.test.js
node --test tests/figma-token-privacy.test.js
node --test tests/renderer-figma-scope.test.js
git diff --check
```

### package-parser-suite
Use for package safety, PowerPoint/Keynote parser, PSD safety, and Quick Package parser changes.

```sh
node --check parsers/index.js
node --check parsers/admission-budgets.js
node --check parsers/powerpoint.js
node --check parsers/package-safety.js
node --test tests/parser-admission-limits.test.js
node --test tests/psd-embedded-safety.test.js
node --test tests/quick-package-parser.test.js
git diff --check
```

### full-nongui-suite
Use before high-risk non-GUI PRs or release-gate readiness. It is the full safe runner-compatible command list.

## Crate Ops Guidance
- Route operational collection and validation to the separately reviewed Crate
  Ops crate-crabbox workflow.
- Treat any remote runner as non-GUI unless its separately reviewed ownership
  and environment prove otherwise.
- Keep release/sign/notarize/deploy jobs on the Mac mini signed release
  environment and installed-app GUI QA in the Jenna lane.
- Do not assume a remote runner has private QA folders, Keychain entries, Apple
  Developer credentials, signing identities, installed creative apps, or GUI
  automation.
- If a remote runner fails because dependencies or fixtures are unavailable,
  classify it as an environment limitation before changing product code.

## Stop Gates
Stop immediately for:
- credentials/tokens/passwords
- Keychain/signing prompts
- Apple Developer secrets
- private-file ambiguity
- product decision ambiguity
- dependency mutation outside explicit scope
- `crate-web` changes
- build/release/tag/notarize unless explicitly approved
- final public `v2.8.0`
- `get-crate.com` or site deploy
- failed runner commands that cannot be safely resolved inside scope
- scope expands beyond loop goal
- missing or unreviewed Crabbox schema/config drift
- absent durable visual-proof publication or ambiguous remote-runner ownership

## Relationship To Existing Playbooks
Use this playbook with:
- `crate-codex-loops.md` for autonomy and preauthorization modes
- `crate-handoff.md` for restartable state and fresh-agent prompts
- `clawpatch-fix.md` for focused fixes
- `crate-regression-detector.md` for fail-fast branch or PR sweeps
- `crate-security-scan.md` for security/privacy-sensitive changes
- `crate-provenance-review.md` for provenance changes
- `crate-release-gate.md` for release-gate checks
- `crate-computer-use-qa.md` and `crate-gui-repro-flow.md` for Tier D GUI QA

When another playbook has stricter gates, the stricter gate wins.

## Definition Of Done
- Runner tier is selected.
- Commands are tied to the goal and risk surface.
- Evidence is captured in the runner evidence format.
- Failures are classified as product, test, environment, or scope issues.
- Stop gates are honored.
- Any operational collection path remains owned and reviewed outside Crate App.
- Final report includes files changed, commands run, evidence, risks, and whether Bryant can proceed.

## Report Format
- Runner loop goal.
- Execution tier.
- Branch, base, HEAD, and working tree state.
- Commands run with runner evidence.
- Files changed, if any.
- Failures and classification.
- Artifacts or logs/evidence location.
- Stop gates hit, if any.
- Risks/open questions.
- Exact next action or handoff prompt.
