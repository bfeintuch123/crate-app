# Crate Check Suites

Named check suites keep prompts short and make loop results easier to compare. A playbook or user prompt may add stricter checks.

## docs-only

Use for workflow docs, playbooks, skills, and Markdown-only changes.

```sh
git diff --check
git diff --name-only
python3 -m py_compile .codex/tools/crate_doctor.py .codex/tools/codex_thread_control.py
rg -n "[[:blank:]]$" AGENTS.md WORKSPACE.md docs .codex .agents
LC_ALL=C rg -n "[^[:ascii:]]" AGENTS.md WORKSPACE.md docs .codex .agents
```

## ops-layer

Use when changes affect Crate standing orders, taskflows, memory, proof bundles, doctor tooling, Cloudflare deploy workflow, or thread-control workflow.

```sh
python3 .codex/tools/crate_doctor.py
python3 -m py_compile .codex/tools/crate_doctor.py .codex/tools/codex_thread_control.py
python3 -m json.tool .codex/ops/crate-feature-inventory.json >/dev/null
python3 -m json.tool .codex/ops/crate-loop-catalog.json >/dev/null
python3 -m json.tool .codex/ops/crate-automations.json >/dev/null
git diff --check
rg -n "[[:blank:]]$" AGENTS.md WORKSPACE.md docs .codex .agents
LC_ALL=C rg -n "[^[:ascii:]]" AGENTS.md WORKSPACE.md docs .codex .agents
```

## syntax-core

Use before most app code PRs.

```sh
node --check main.js
node --check provenance.js
node --check renderer/app.js
node --check parsers/index.js
node --check parsers/powerpoint.js
node --check parsers/figma.js
node --check parsers/package-safety.js
```

## focused-qa-suite

Use for current v2.8 QA bug fixes unless the prompt narrows or expands scope.

```sh
npm audit --audit-level=high
node --check main.js
node --check provenance.js
node --check renderer/app.js
node --check parsers/index.js
node --check parsers/powerpoint.js
node --check parsers/figma.js
node --check parsers/package-safety.js
node --check tests/main-window-lifecycle.test.js
node --check tests/provenance-dual-write.test.js
node --check tests/quick-package-parser.test.js
node --check tests/renderer-figma-scope.test.js
node --test tests/main-window-lifecycle.test.js
node --test tests/provenance.test.js
node --test tests/provenance-dual-write.test.js
node --test tests/psd-embedded-safety.test.js
node --test tests/figma-scope.test.js
node --test tests/figma-link-per-project.test.js
node --test tests/figma-token-privacy.test.js
node --test tests/renderer-figma-scope.test.js
node --test tests/quick-package-parser.test.js
git diff --check
```

## provenance-suite

Use when changes affect provenance, live evidence, package details, diagnostics, parser evidence, source confidence, or session relevance.

```sh
node --check provenance.js
node --check main.js
node --check tests/provenance-dual-write.test.js
node --test tests/provenance.test.js
node --test tests/provenance-dual-write.test.js
git diff --check
```

## figma-suite

Use when changes affect Figma links, token handling, scope, page lock, package-time scope enforcement, or renderer Figma UI.

```sh
node --check parsers/figma.js
node --check renderer/app.js
node --check tests/renderer-figma-scope.test.js
node --test tests/figma-scope.test.js
node --test tests/figma-link-per-project.test.js
node --test tests/figma-token-privacy.test.js
node --test tests/renderer-figma-scope.test.js
git diff --check
```

## package-parser-suite

Use when changes affect Quick Package, Add Files, package filtering, parser extraction, PowerPoint, Keynote, PSD safety, diagnostics, or package output exclusions.

```sh
node --check parsers/index.js
node --check parsers/powerpoint.js
node --check parsers/package-safety.js
node --check tests/quick-package-parser.test.js
node --test tests/quick-package-parser.test.js
node --test tests/psd-embedded-safety.test.js
git diff --check
```

## release-gate-readonly

Use before any internal QA release mutation.

```sh
pwd
git remote -v
git fetch origin
git branch --show-current
git status --short --branch
git rev-parse HEAD origin/v2.4.x
node -p "require('./package.json').version"
git log --oneline -12
npm audit --audit-level=high
git diff --check
```

Release execution adds version bump, build, signing, notarization, artifact metadata, hash, tag, push, and GitHub prerelease checks only when Bryant explicitly approves those release steps.
