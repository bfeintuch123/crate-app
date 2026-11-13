# Taskflow: Test memory guard and bounded assertion failures

## Metadata

- created: 2026-11-13
- updated: 2026-11-13
- owner: Fable (writer for this branch), coordinated by Mack for Bryant
- standing order: none selected yet; select one from `.codex/ops/standing-orders.md` on resume
- repo: bfeintuch123/crate-app
- branch: t3/test-memory-guard
- base: v2.4.x at f80d5bc (after #327). Must be re-based onto v2.4.x after #328 merges.
- mode: separate draft PR; no merge, ready-for-review, or release is authorized
- status: blocked

## Goal

Stop a failing test from exhausting the machine. A failed `assert.equal` or `assert.deepEqual` on a very large value (the synthetic renderer DOM, a large Buffer, a long string) makes Node 22 render both values and diff them with memory that grows without limit outside the V8 heap. The fix has two parts: test files import a bounded drop-in for `node:assert/strict`, and tests run through `scripts/run-tests.js`, which watches the memory of the whole run from outside and stops it when it passes a limit.

## Scope

Allowed:

- `tests/bounded-assert.js`, its tests and fixtures
- the one-line assert import in test files
- `scripts/run-tests.js`, its tests and fixtures
- `package.json` `test` script, the two node:test steps in `.github/workflows/security-gate.yml` and their pins in `tests/release-artifact-policy.test.js`
- test commands in AGENTS.md, check suites, playbooks and QA smoke templates

Forbidden:

- app source (`main.js`, `renderer/`, `parsers/`, `preload.js`)
- removing, skipping or weakening any test or assertion
- editing the #328 worktree or branch
- merge, ready-for-review, release, or publishing private machine evidence

## State

- current phase: paused at a checkpoint on Bryant's sequencing decision (#328 merges first)
- last completed checkpoint: prototype files and the import switch are on this branch as one local WIP commit, unpushed
- next action: wait for Mack's resumption message after #328's separately approved merge
- blocker: #328 must merge first; this branch must then be brought onto the new v2.4.x
- approval state: writer ownership was granted for this branch and then released at this checkpoint; no merge approval exists
- preferences applied: one writer, read-only reviewers, no concurrent heavy Mac tests, pinned Node and Chrome, non-hidden test workspace
- routing decision: major PR (shared test infrastructure and CI); needs exact-head protected CI, an independent Luna review at high effort and a distinct second reviewer, at most three correction cycles
- workflow eval suite/result: none run on this base
- outcome receipt: none

## Checkpoints

- [x] preflight / doctor (read-only preflight of v2.4.x, #327, #328 and duplicate work; no duplicate found)
- [x] context loaded
- [ ] implementation or execution (prototype only; the hardening listed under Risks is not applied)
- [ ] verification (nothing has been run on this base)
- [ ] proof bundle
- [ ] ledger/state update
- [ ] handoff or next prompt
- [ ] REQUIRED post-merge acceptance on the exact merged commit (see below; not run)

## Evidence

| Time | Action | Evidence | Result |
| --- | --- | --- | --- |
| 2026-11-12 | Prototype on #328 head 1ef9c46: full serial suite through the guard | private log, not published | 4091 tests, 4089 pass, 0 fail, 2 skip. Prototype evidence only; it does not cover this branch. |
| 2026-11-13 | This branch at the checkpoint | none | No test, suite, CI run or review has been run. |

## Risks

Known gaps in the prototype that must be closed before review. None of them is done yet.

- Bounded assert: treat a value whose size cannot be measured safely (measurement throws, iterators, promises, module namespaces) as too large; never call into a Proxy while summarizing; cap the work spent locating the first difference; cover every exposed path (`throws`/`rejects` with an object validator, legacy `fail(actual, expected)`, `partialDeepStrictEqual`, `assert.Assert`, `t.assert`); add a differential parity test against `node:assert/strict`.
- Memory guard: it samples, so it is not a hard cap. A run overshoots its limit by what it allocates in one interval (measured: stopped at 2.5 GB with a 2 GB limit at about 3 GB per second). Still to do: identify processes by pid and start time so a reused pid is never signalled; stop, verify, then kill; confirm the whole run is gone after a kill or a signal; report processes left running after a normal exit; time out and count sampler failures and stop the run when the guard is blind; say plainly in the summary when footprint readings are unavailable; shorten the delay before compressed memory is seen (footprint is read every 5 seconds today).
- Measured cost of the prototype guard: no change in wall time on a 25 second sample, about 5 to 8 percent of one core. No unguarded full-suite baseline was measured.
- Sequencing: #328 adds `tests/asset-controls-real-browser.test.js` and `tests/excluded-needs-review-ipc.test.js`, which import `node:assert/strict` directly. With #328 merged first, this branch switches their imports when it is brought onto the new base, and the import policy test needs no exception.

## Sequence after resumption

1. Wait for #328's separately approved merge. Do not start before Mack's resumption message.
2. Bring this branch onto the new v2.4.x and regenerate the one-line import switch so it covers every test file on that base, including #328's new files.
3. Close the gaps listed under Risks. Keep exact assertion coverage: no test or assertion removed, skipped or weakened.
4. Focused checks, then a live process preflight, then the full serial suite on the exact head from a non-hidden workspace with the pinned Node and Chrome. Wait if another session's Chrome or heavy run is active. Never kill a process another session started.
5. Push, open a draft PR, exact-head CI, independent Luna review at high effort plus a distinct second reviewer, at most three correction cycles.
6. Bryant's own approval for ready-for-review and for merge. Neither is authorized today.
7. After a separately authorized merge: the post-merge acceptance below.

## Required post-merge acceptance (Bryant, 2026-11-13)

Status: REQUIRED. NOT RUN. A planned run does not count as completed. This is acceptance of the merged code, in addition to pre-merge evidence.

When: after this PR and #328 are both on v2.4.x by separately authorized merges. The focus test lives in #328, so the acceptance needs both.

Rules: one check at a time, after a live process preflight. Every Node process runs under an external limit. Never reproduce unbounded growth. Never raise a limit to make a check pass. Never signal a process this procedure did not start.

Setup:

- `MERGED` is the exact merged commit on v2.4.x. Export it with `git archive "$MERGED"` into a new non-hidden folder `RUN/app`, install dependencies from the lockfile as CI does, and use the pinned Node 22.23.1.
- `RUN/counterfactual` is a copy of `RUN/app` in which the focus guard is removed from `renderer/app.js`: the `button: button || null,` property and the four lines that begin with the comment `Never take focus back from a control the person moved to`. The copy is never committed.
- `RUN/unfixed` is a copy of `RUN/counterfactual` in which only `tests/renderer-figma-scope.test.js` imports `node:assert/strict` again. It exists to measure the old behavior under a low limit, and is never committed.
- `FOCUS` is `--test-name-pattern="never takes focus back" tests/renderer-figma-scope.test.js`.
- Measure each run with `/usr/bin/time -l` and record exit code, wall time, `maximum resident set size` and `peak memory footprint`.
- Besides the guard under test, keep a second, independent limit: a small shell loop that reads the resident size of the run's processes with `ps` several times a second and sends SIGKILL to those processes above 1024 MB.

Checks, in order:

| # | Folder | Command | Expected |
| --- | --- | --- | --- |
| 1 | `RUN/app` | `node scripts/run-tests.js --memory-limit-mb=512 $FOCUS` | Test passes, exit 0, peak footprint under 100 MB, guard summary line present, nothing left running. |
| 2 | `RUN/counterfactual` | same as 1 | Test fails on the same assertion as before the fix (`focus stays on Search`), with the summary message instead of a diff. Exit 1, not 137. Peak footprint under 100 MB. Nothing left running. |
| 3 | `RUN/unfixed` | same as 1 | The old behavior, safely: the guard stops the run within about 2 seconds with exit 137 and names the process. Peak stays under about 1.5 GB. This is the "before" number for the comparison. |
| 4 | `RUN/app` | `node scripts/run-tests.js --memory-limit-mb=256 tests/fixtures/memory-guard/growing.fixture.js`, with two bystander processes started beforehand outside the run (`sleep 600` and an idle `node`) | Exit 137 and the limit message. Both bystanders are still alive with the same pid and start time. Stop the bystanders afterwards. |
| 5 | `RUN/app` | `node scripts/run-tests.js tests/bounded-assert.test.js tests/run-tests-memory-guard.test.js` | All pass, exit 0. |

Stop criteria: another session's test, Chrome or heavy process is active (wait, do not kill it); any run passes the independent 1024 MB limit; any exit code, pass or fail result, or leftover process differs from the table. On a stop, do not retry with a higher limit. Report what was observed.

Evidence: raw logs stay in a private folder outside the repository and are not published. Publish only a sanitized table per check: exit code, wall time, maximum resident size, peak footprint, and pass or fail against the expectation. No machine paths, user names, pids or process lists.

Comparison to report: checks 2 and 3 side by side (after and before) for the failing path, and check 1 against the passing path measured on the same commit with `node --test` under the independent limit.

## Handoff

Next exact action:

```text
Wait for Mack's resumption message. Then read this taskflow, verify branch t3/test-memory-guard and its working tree, confirm #328 has merged and record the new v2.4.x commit, and continue from "Sequence after resumption" step 2. Do not run the post-merge acceptance before a separately authorized merge of this PR.
```
