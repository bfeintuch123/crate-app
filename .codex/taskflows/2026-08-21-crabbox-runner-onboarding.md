# Taskflow: Crabbox Runner Onboarding

## Metadata

- created: 2026-08-21T21:34:36-0400
- updated: 2026-08-22
- owner: Bryant and Codex
- standing order: SO-007 Crate Ops Improvement Proposal
- repo: `bfeintuch123/crate-app`
- branch: `ops/crabbox-runner-onboarding`
- base: `v2.4.x` at `f520d4579d9d3dfa47ecbbba12904750aa253afd`
- mode: isolated ops/workflow implementation and direct local Apple VM proof
- status: pre-commit-gate-ready

## Goal

Replace the documentation-only Crabbox-style placeholder with a pinned,
reviewed, local Apple VM Crabbox CLI and repository workflow for Crate Tier B
non-GUI validation without touching Beta 2.14 release artifacts or Jenna QA.

## Scope

Allowed:

- install and verify Crabbox v0.45.0 outside the repository;
- add reviewed repo config, hydration workflow, and agent skill;
- add named non-GUI jobs matching the existing Runner Loop suites;
- add a token-safe public GitHub attachment uploader and a strict visual
  evidence manifest/collection path;
- validate config, dry-run plans, docs, YAML, and workflow boundaries;
- prepare a reviewable branch and proof.

Forbidden:

- provider credentials, paid capacity, alternate providers, or GitHub
  self-hosted runner registration without separate approval;
- app, package, lockfile, release, build, signing, notarization, tag, deploy,
  installed-app, Jenna QA, or private-file changes;
- merge without separate approval.

## State

- current phase: visual artifact publication closeout and final review
- last completed checkpoint: end-to-end local Apple VM `quick-check` passed and
  the lease was released
- next action: run final pre-commit checks, stage the exact approved paths,
  commit once, push only this branch, open one draft PR, and complete the
  independent read-only Luna/high review
- blocker: none within the approved workflow lane; any unavailable or failed
  GitHub publication or Crabbox collection must retain the verified local
  bundle and fail closed without claiming durable publication
- approval state: Bryant explicitly approved proceeding with the Crabbox fix on
  2026-08-21 after Beta 2.14 build completion and, on 2026-08-22, approved the
  narrowed contract: GitHub PR user attachments are the sole durable
  publication destination; Crabbox provides isolated collection, integrity
  validation, and fail-closed local preservation; no independent Crabbox,
  release-asset, S3, R2, Cloudflare, broker, `uploads.sh`, or other backend is
  approved; commit, push, draft PR, and merge remain separate gates
- preferences applied: do not dirty or interrupt completed Beta 2.14 build or
  Jenna testing
- routing decision: direct local `apple-vm`, ARM64 Ubuntu, loopback SSH, no
  broker or cloud credentials; no speculative warmup; standard class;
  alternate cloud fallback disabled
- workflow eval suite/result: `quick-check` PASS and revised cross-platform
  `provenance-suite` PASS (8/8) in Apple VM; config, schema, dry-run, and
  repository boundary validation PASS
- outcome receipt: Crabbox v0.45.0 is installed outside the repo; the reviewed
  config uses direct local `apple-vm` with cloud fallback disabled; hydration
  and `quick-check` passed; lease cleanup passed; no Beta 2.14 or Jenna QA
  worktree was mutated

## Checkpoints

- [x] preflight / doctor attempted; pre-existing retired-Mac path crash classified
- [x] context loaded
- [x] implementation or execution
- [x] verification
- [x] proof receipt in this taskflow
- [x] ledger/state update
- [x] handoff or next prompt

## Evidence

| Time | Action | Evidence | Result |
| --- | --- | --- | --- |
| 2026-08-21T21:30-0400 | Verify release distribution | Archive, checksums, provenance, executable signatures | PASS |
| 2026-08-21T21:31-0400 | Install CLI | `crabbox --version`; login-shell discovery; `crabbox doctor` | PASS, provider intentionally unset |
| 2026-08-21T21:33-0400 | Isolate repo branch | Fresh worktree at exact `origin/v2.4.x` Beta 2.14 merge | PASS |
| 2026-08-21T21:33-0400 | Run Crate Doctor | Retired `/Users/bryantfeintuchclaw/Projects` lookup | FAIL, pre-existing environment blocker outside Crabbox scope |
| 2026-08-21T21:36-0400 | Raw `quick-check` attempt | Apple VM reached ready state; fresh-workspace fingerprint invalidation failed before hydration | ENVIRONMENT FAIL; lease automatically released |
| 2026-08-21T21:41-0400 | Wrapper hydration attempt | Sync passed; wrapper omitted explicit Actions hydration, so Node was unavailable | ENVIRONMENT FAIL; lease released; wrapper corrected |
| 2026-08-21T21:43-0400 | Actions hydration attempt | Frozen install passed; macOS policy expected Darwin-only `fsevents` on Linux | ENVIRONMENT FAIL; lease released; narrow Linux adapter added |
| 2026-08-21T21:45-0400 | End-to-end `quick-check` | lease `cbx_fc76b30f732b`; sync `run_fbad7eb29a03`; test `run_2e4c47d58ba3` | PASS; syntax and diff checks passed; lease released |
| 2026-08-21T21:51-0400 | Probe initial `provenance-suite` | core provenance 7/7; dual-write 371/387 with failures tied to macOS paths and timing | ENVIRONMENT CLASSIFICATION; lease released; dual-write retained in macOS lane |
| 2026-08-21T21:52-0400 | Revised `provenance-suite` | lease `cbx_f983ea2ff8bc`; sync `run_0a667d3ef999`; test `run_784474199e74` | PASS, 8/8; lease released |
| 2026-08-21T22:25-0400 | Inspect v0.45.0 artifact source/schema | `artifactGlobs`, `requiredArtifacts`, local archive and publisher backends inspected at tag source | PASS; local Apple VM collection supported; no durable URL without a separately approved backend |
| 2026-08-21T22:35-0400 | Implement visual evidence path | Strict public GitHub uploader, deterministic manifest, Crabbox bundle builder/validator, failure-first tests | PASS 22/22 in local Apple VM; no real upload or PR mutation |
| 2026-08-21T22:36-0400 | Initial changed-execution proof | lease `cbx_f2bb9c751ce2`; sync `run_cc5475f76104`; test `run_402ceb204bf7` | PASS; 22/22 visual tests, syntax, diff check; lease released |
| 2026-08-21T22:37-0400 | First independent security/privacy Autoreview | Complete tracked/untracked diff; token, path, TOCTOU, artifact, cleanup, durable-URL boundaries | Eight findings accepted and fixed; superseded by required explicit-model review |
| 2026-08-21T22:44-0400 | Required Luna/high Autoreview | Read-only complete tracked/untracked diff; effective model `gpt-5.6-luna`, reasoning `high` | Ten actionable findings, including two blockers; all accepted for correction |
| 2026-08-21T23:05-0400 | Final post-finding Apple VM proof | lease `cbx_beb7ebbdf909`; sync `run_f1931f848391`; test `run_bc129e2a28b0` | PASS; 29/29 tests including traversal rejection, descriptor-bound readback, and TERM status 143; syntax/diff checks passed; lease released |
| 2026-08-21T23:14-0400 | Final independent Autoreview | Complete 5 tracked + 11 untracked paths; read-only; effective model `gpt-5.6-luna`, reasoning `high`; session `01a0276f-cde3-7750-97a0-15e57c46201f` | `NO_ACTIONABLE_FINDINGS`; all ten dispositions and later traversal/readback/signal corrections verified; no lease or mutation |
| 2026-08-22T12:11-0400 | Final pre-commit Apple VM `quick-check` after approved contract wording | lease `cbx_b7319036e263`; run `run_c4bb318ca4ab` | PASS; 29/29 tests, syntax, and `git diff --check`; lease released |

## Luna/high Finding Disposition

| Severity | Affected contract | Accepted fix | Verification |
| --- | --- | --- | --- |
| Blocker | Public privacy review was caller-controlled | Replaced PASS argv with owner-only exact-key `crate.visual-review.v1` receipt bound to name/MIME/bytes/SHA-256; broadened absolute path rejection | Missing, permissive, FAIL, and hash-mismatch receipt tests; path tests; 28/28 PASS |
| High | Bundle request/manifest/output path TOCTOU and symlink confinement | Reads use held `O_NOFOLLOW` descriptors and `fstat`; output parent realpath is exact; staging stays on output filesystem | Request/manifest/output-parent symlink tests; 28/28 PASS |
| High | Media/readback size and hash described separate file instances | One held descriptor now supplies regular-file status, size, signature, and SHA-256 for source, staged media, and destination readback | Path-substitution-after-open descriptor test; 28/28 PASS |
| High | Archive integrity and run identity were independently supplied | Archive size/hash use one descriptor; basename must equal `<runId>-artifacts.tgz` | Archive hash and mismatched-run tests; 28/28 PASS |
| High | Cleanup could query the wrong Crabbox inventory | Cleanup preserves validated config homes, runs at repo root, proves config provider `apple-vm`, then requires lease absence | Child cwd/env/provider/live-lease failure tests; 28/28 PASS |
| High | Partial warmup or interruption could skip lease cleanup | Cleanup becomes required before warmup; signal traps preserve standard nonzero status and EXIT always attempts idempotent stop | Mocked failure/signal tests prove ordered `warmup`, `stop`, and TERM status 143; real failed/passing runs released |
| High | Workflow dispatch could select an arbitrary self-hosted label | `runs-on` now uses fixed reviewed Crabbox/default/standard labels; dynamic input is compatibility-only | Workflow contract test rejects dynamic `runs-on`; 28/28 PASS |
| Medium | Hydration `ref` input was ignored | Checkout uses requested ref or SHA and verifies hydrated HEAD exactly, with local-emulator SHA fallback | Workflow contract test plus successful local Actions hydration |
| Medium | Generated proof directories were not Git-excluded | Added root ignores for visual input/output, private evidence, and `.github/pr-assets` | Ignore contract test and clean status surface; 28/28 PASS |
| Blocker | Failure-first suite was not independently executable on host | Used reviewed Apple VM Node 22 hydration; no host dependency install | `run_bc129e2a28b0` 29/29 PASS; syntax/diff PASS; lease released |

## Risks

- Crabbox defaults are unsafe for blind adoption: generated config uses class
  `beast` and permits on-demand fallback. The reviewed config overrides both.
- Apple VM provides isolated local Linux proof but is not evidence from a
  separate remote host; alternate remote proof remains a future explicit gate.
- Mac-specific dual-write coverage is intentionally excluded from Crabbox and
  remains required in the existing macOS source-security lane.
- Crabbox v0.45.0 raw one-shot local hydration fails on a missing fresh
  workspace. The reviewed wrapper primes the workspace and owns cleanup; remove
  the workaround only after an upstream version is directly revalidated.
- The hydration workflow is executable automation and must receive ordinary PR
  review and CI before merge.
- The repository is public and every GitHub user attachment is public evidence;
  sanitization and complete media inspection are mandatory before upload.
- GitHub PR user attachments are the sole approved durable publication path.
  Crabbox collection is isolated, integrity-validated, and locally preserved;
  its archive is not a durable URL. If GitHub publication or Crabbox collection
  fails, preserve the verified bundle and fail closed. No release asset, S3,
  R2, Cloudflare, broker, `uploads.sh`, or other backend is an approved
  substitute.

## Handoff

Next exact action:

```text
Run the final bounded checks, stage only the exact reviewed paths, commit once,
push only `ops/crabbox-runner-onboarding`, and open one draft PR against
`v2.4.x`. Describe GitHub attachment publication as the sole durable path and
Crabbox as isolated collection plus fail-closed local preservation. Then run a
fresh read-only `gpt-5.6-luna` high-reasoning review of the exact PR state and
stop before ready-for-review or merge.
```
