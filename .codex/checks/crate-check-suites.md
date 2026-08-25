# Crate Check Suites

Named check suites keep prompts short and make loop results easier to compare. A playbook or user prompt may add stricter checks.

## docs-only

Use for workflow docs, playbooks, skills, and Markdown-only changes.

```sh
git diff --check
git diff --name-only
python3 -m py_compile .codex/tools/crate_doctor.py
python3 -m unittest discover -s .codex/tools/tests -p 'test_*.py'
rg -n "[[:blank:]]$" AGENTS.md WORKSPACE.md docs .codex .agents
LC_ALL=C rg -n "[^[:ascii:]]" AGENTS.md WORKSPACE.md docs .codex .agents
```

## ops-layer

Use when changes affect Crate standing orders, taskflows, memory, proof bundles, doctor tooling, Cloudflare deploy workflow, or thread-control workflow.

```sh
python3 .codex/tools/crate_doctor.py
python3 -m py_compile .codex/tools/crate_doctor.py
python3 -m unittest discover -s .codex/tools/tests -p 'test_*.py'
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

## ops-product-learning

Use for design-review, workflow-recording, tester-insight, launch-readiness, product-metric, dependency-watch, or incident-rehearsal workflow changes.

```sh
python3 .codex/tools/crate_doctor.py
python3 -m json.tool .codex/ops/crate-loop-catalog.json >/dev/null
rg -n "crate-design-review|crate-workflow-recorder|crate-tester-insights|crate-launch-readiness|crate-product-metrics|crate-dependency-watch|crate-launch-incident-rehearsal" .codex/ROUTER.md .codex/ops .codex/taskflows
git diff --check
```

## ops-workflow-eval

Use for explicit-preference, workflow-evaluation, outcome-receipt, or evidence-based routing changes.

```sh
python3 .codex/tools/crate_doctor.py
python3 -m json.tool .codex/ops/crate-loop-catalog.json >/dev/null
python3 /Users/bryantfeintuchclaw/plugins/crate-ops/scripts/evaluate_workflow_suite.py /Users/bryantfeintuchclaw/plugins/crate-ops/examples/crate-workflow-eval-suite.example.json
python3 -m unittest discover -s /Users/bryantfeintuchclaw/plugins/crate-ops/tests -p 'test_chief_learning.py'
rg -n "crate-preference-ledger|crate-workflow-evals|Outcome Receipt|Evidence-Based Routing" .codex/ROUTER.md .codex/ops .codex/playbooks .codex/taskflows
git diff --check
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
node --check parsers/admission-budgets.js
node --check parsers/powerpoint.js
node --check parsers/package-safety.js
node --check tests/parser-admission-limits.test.js
node --check tests/quick-package-parser.test.js
node --test tests/parser-admission-limits.test.js
node --test tests/quick-package-parser.test.js
node --test tests/psd-embedded-safety.test.js
git diff --check
```

## ui-stability-responsive-geometry

Use when changes affect Crate window resizing, responsive layout, Review Assets containment, control wrapping, asset-card density, modal sizing, UI state preservation during resize, or the supported minimum-window contract.

Source and focused checks:

```sh
node --check tests/ui-stability-fixture.js
node --check tests/ui-stability-preload.js
node --check tests/ui-stability-electron-harness.js
node --check tests/ui-stability-responsive-geometry.test.js
node --test tests/ui-stability-fixture.test.js
node --test tests/ui-stability-harness-contract.test.js
node --test tests/ui-stability-responsive.test.js
node --test tests/ui-stability-responsive-geometry.test.js
node --test tests/renderer-figma-scope.test.js
node --test tests/main-window-lifecycle.test.js
git diff --check
```

The dependency-free browser geometry test may report an intentional environment skip when Chrome or Chromium is unavailable. That skip does not satisfy the Mac proof gate.

Exact-head macOS evidence gate, using a dependency-complete approved worktree and an owner-only private evidence directory:

```sh
CRATE_UI_SHOW=1 \
CRATE_UI_EVIDENCE_DIR=<approved-private-evidence-directory> \
./node_modules/.bin/electron tests/ui-stability-electron-harness.js \
  > <approved-private-evidence-directory>/geometry-report.json
```

The exact-head Mac gate must use synthetic data and confirm:

- root, app shell, Current Project, files view, and Review Assets have no horizontal overflow;
- sidebar/content, heading/search, summary/actions, cards, and footer do not intersect;
- the responsive card-density modes remain readable;
- search and active-filter state survive resizing;
- resize alone triggers no project, workspace, or preview requests;
- screenshots and the complete resize video are inspected and pass privacy review;
- the minimum BrowserWindow decision follows measured usability rather than concealing broken geometry.

Any UI-affecting commit after evidence capture makes that evidence stale.

## release-gate-readonly

Use before any internal QA release mutation.

Authenticate the fixed Git, Node, and npm paths first. Define `<sanitized-git-environment>`, `<sanitized-git-command>`, and `<sanitized-node-environment>` exactly as required by `.codex/playbooks/crate-release-gate.md`, including disabled global/system Git config, hooks and filesystem monitors plus the approved home and fresh mode-`0700` private temp/cache roots. Authenticate and hash the local Git config with includes disabled before using the repository. The audit registry is fixed explicitly so inherited npm, proxy, registry, script-shell, Node, and dynamic-loader settings cannot redirect the check.

```sh
/bin/pwd
<sanitized-git-command> remote -v
<sanitized-git-command> fetch origin
<sanitized-git-command> branch --show-current
<sanitized-git-command> status --short --branch
<sanitized-git-command> rev-parse HEAD origin/v2.4.x
<sanitized-node-environment> "<canonical-node-executable>" -p "require('./package.json').version"
<sanitized-git-command> log --oneline -12
<sanitized-node-environment> "<canonical-node-executable>" "<canonical-npm-cli>" audit --audit-level=high --registry=https://registry.npmjs.org/
<sanitized-git-command> diff --check
```

Release execution adds version bump, build, signing, notarization, artifact metadata, hash, tag, push, and GitHub prerelease checks only when Bryant explicitly approves those release steps.

## signed-macos-app-proof

Use only after Bryant has approved the applicable macOS build and signing checks and an app artifact already exists. Public-release mode additionally requires the approved Gatekeeper and notarization checks; contained QA mode must be explicitly approved and remains non-release proof.

```sh
(cd <isolated-verifier-source-root> && <sanitized-node-environment> "<canonical-node-executable>" scripts/run-macos-release-proof.js <path-to-app> --electron-archive <electron-arm64-archive> --canvas-prebuild <canvas-arm64-prebuild> --expected-revision <approved-release-commit> --source-root <isolated-proof-source-root> --json)
```

For public-release mode, first create two detached clean worktrees at the approved release commit: `<isolated-verifier-source-root>` and a different `<isolated-proof-source-root>`. Assert both canonical paths differ, both worktrees are clean, and both resolve `HEAD` to the approved SHA. Independently run canonical npm `ci --ignore-scripts` plus the committed install-policy verifier in each worktree under separate fresh cache/temp roots; install the exact pinned official Canvas arm64 prebuild only in the proof worktree. Run the signed-app verifier from the verifier worktree only after its own reviewed dependencies exist and after the app is notarized, stapled, and ready for Gatekeeper assessment. The proof worktree supplies all package evidence. The verifier requires the original app fingerprint to remain stable while it collects evidence from one private metadata-preserving snapshot whose complete fingerprint also remains stable. The Electron ZIP must be the exact arm64 distribution named in the proof worktree's installed locked Electron package's authenticated `checksums.json`; the verifier checks its SHA-256 and binds the packaged Electron executable and framework payload to that archive. The default mode requires Apple-anchored Developer ID Application signing for the app and nested code, the approved arm64 architecture policy with only the exact allowlisted universal native module, hardened runtime, the canonical Crate team and bundle identifier, exact launch/security metadata plus internally consistent main/helper build metadata, exact main/helper/nested-bundle entitlements, an approved canonical bundle layout, strict final privacy and transport metadata, the actual ASAR header hash against embedded integrity metadata, the exact approved Electron fuse wire, first-party source-to-ASAR binding, package and build-version binding, and the complete production dependency closure from that isolated proof root. Dependency proof requires declared-version satisfaction, exact lock paths and package/version topology, registry-tarball source bytes authenticated against lockfile integrity, the complete exact approved Canvas prebuild inventory and bytes, Electron Builder-filtered file inventories, transformed package manifests, ordinary file bytes, and signature-normalized native binaries. It also requires packaged-content verification, Gatekeeper acceptance, and a valid notarization staple. Its proof includes only the code-directory fingerprint and source revision needed to identify the reviewed artifact; it omits local paths, signer names, timestamps, ASAR hashes, and package-content hashes. `--allow-unnotarized` is for explicitly approved contained QA only, waives only Gatekeeper and staple proof, and produces `releaseReady: false`; it cannot satisfy a public release gate.
