# Taskflow: Test memory guard and bounded assertion failures

## Metadata

- created: 2026-11-13
- updated: 2026-11-13
- owner: Fable (writer for this branch), coordinated by Mack for Bryant
- standing order: none selected yet; select one from `.codex/ops/standing-orders.md` on resume
- repo: bfeintuch123/crate-app
- branch: t3/test-memory-guard
- base: v2.4.x at f80d5bc (after #327). Must be brought onto v2.4.x again after #328 merges.
- mode: separate draft PR, not opened yet; no push, merge, ready-for-review, or release is authorized
- status: blocked

## Goal

Stop a failing test from exhausting the machine. A failed `assert.equal` or `assert.deepEqual` on a very large value (the synthetic renderer DOM, a large Buffer, a long string) makes Node 22 render both values and diff them with memory that grows without limit outside the V8 heap. The fix has two parts: test files import a bounded drop-in for `node:assert/strict`, and tests run through `scripts/run-tests.js`, which watches the memory of the whole run from outside and stops it when it passes a limit.

## Scope

Two components with different states.

1. Memory guard: `scripts/run-tests.js`, `scripts/run-tests-sampler.py`, `tests/run-tests-memory-guard.test.js`, `tests/fixtures/memory-guard/`. Hardened on 2026-11-13 under a scoped resumption so that it could protect #328's next test run before the rest of this work merges. It is NOT approved for that or any use until an independent read-only safety review of the final head passes.
2. Everything else is paused at the prototype state of the checkpoint commit: `tests/bounded-assert.js` and its tests, the one-line assert import in test files, the `npm test` script, the CI workflow steps and their pins, and the documented test commands.

Forbidden:

- app source (`main.js`, `renderer/`, `parsers/`, `preload.js`)
- removing, skipping or weakening any test or assertion
- editing the #328 worktree or branch
- full suite, push, PR, CI, merge, ready-for-review, release, or publishing private machine evidence, until Mack says otherwise

## State

- current phase: guard correction cycle 3 of 3 committed locally; no correction cycle is left. Waiting for Mack, and for #328 to merge before the rest resumes
- last completed checkpoint: four local commits, unpushed: the WIP checkpoint, the guard hardening, and the cycle 2 and cycle 3 corrections
- next action: wait for Mack. A further blocking finding on the guard is escalated to Bryant, not answered with a fourth cycle.
- blocker: independent review of the guard has not passed; #328 must merge before the paused work resumes
- approval state: writer ownership of this branch for guard work only; no approval to use the guard, push, or merge
- preferences applied: one writer, read-only reviewers, no concurrent heavy Mac tests, pinned Node, bounded synthetic tests only
- routing decision: major PR (shared test infrastructure and CI); needs exact-head protected CI, an independent Luna review at high effort and a distinct second reviewer, at most three correction cycles
- workflow eval suite/result: guard tests only, see Evidence
- outcome receipt: none

## Checkpoints

- [x] preflight / doctor (read-only preflight of v2.4.x, #327, #328 and duplicate work; no duplicate found)
- [x] context loaded
- [x] implementation: memory guard hardening (pending review)
- [ ] implementation: bounded assert hardening, import switch on the final base, CI and doc wiring (paused)
- [x] verification: guard tests, bounded and synthetic only
- [ ] verification: full serial suite on the final head (not run on this base)
- [ ] independent safety review of the guard
- [ ] proof bundle
- [ ] ledger/state update
- [ ] REQUIRED post-merge acceptance on the exact merged commit (see below; not run)

## How the guard works

- A long-lived sampler reads every process through libproc: parent, process group, owner, state, start time, resident size and `ri_phys_footprint`, which includes compressed memory. One scan of about 930 processes takes about 2 ms. The guard scans every 50 ms. A second sampler is started and checked before any test runs and stands by for cleanup.
- The runner is the root of the run by its own pid from the first scan, readable or not: the guard started it and has not collected it, so that pid cannot belong to anyone else. Every other process is identified by pid and start time together. It belongs to the run when it is in the runner's process group in a scan that also shows the runner, was started by a process of the run (including detached children in their own session and group), or was identified as the run's before.
- Stopping a run: SIGSTOP to the group and to every identified process, repeated until a scan finds nothing new; then SIGKILL; then scans until everything is gone or five seconds pass. The sampler sends every signal: it reads the target's start time again and signals in the next system call.
- The same cleanup runs on a memory limit, the deadline, a signal to the guard (after a grace period, skipped on a second signal), and for whatever a finished run leaves running.
- It stops the run and exits 125 when the sampler does not answer for three seconds or ends, or when a process of the run cannot be read. That includes the runner itself from the first scan: unreadable, not listed for more than three scans, or listed as something the guard did not start. With an unreadable runner the group is signalled by the runner's pid alone, which is sound only while the guard has not collected the runner, and is done only then.
- It exits 125, replacing the tests' own status, whenever it cannot confirm that every process of the run is gone.
- Exit status: the runner's own; 137 memory limit; 124 deadline; 128+N after signal N; 125 guard failure; 2 bad option.

## Evidence

Bounded synthetic tests only. Allocators stop by themselves at 256 MB and let go; every helper process exits by itself within 20 seconds. No full suite, no Chrome, no reproduction of the original runaway.

| Time | Action | Evidence | Result |
| --- | --- | --- | --- |
| 2026-11-12 | Prototype on #328 head 1ef9c46: full serial suite through the prototype guard | private log | 4091 tests, 4089 pass, 0 fail, 2 skip. Does not cover this branch or the hardened guard. |
| 2026-11-13 | First hardening: `node --test tests/run-tests-memory-guard.test.js`, twice, pinned Node 22.23.1 | private logs | 34 of 34 pass both times, about 20 s each, nothing left running. |
| 2026-11-13 | Eight deliberate regressions in the guard, one at a time, against the simulated tests | terminal | Each was caught by at least one test: group adoption without the runner in the scan; pid remembered without start time; unreadable process dropped; unreadable tolerated forever; kill without freeze; group signal after the runner is gone; frozen stranger not resumed; no confirmation deadline. |
| 2026-11-13 | Cycle 2: the same test file, twice | private logs | 40 of 40 pass both times, about 24 s each, nothing left running. 22 tests on a simulated process table, 18 with real processes. |
| 2026-11-13 | Cycle 2: eight more deliberate regressions, against the simulated tests or the command-level tests | terminal | Each was caught: runner adopted only when readable (simulated and at the command line); missing runner tolerated; inconsistent runner accepted; group signalled by number after collection; group signalled by number with the runner in another group; no group signal by number; standby sampler unused. |
| 2026-11-13 | Cycle 3: 120 samplers ended with SIGKILL and asked for a scan right after | terminal | Reported as ended through its exit 113 times and through its closed input 7 times; marked gone for good every time. |
| 2026-11-13 | Cycle 3: the test file three times; the two sampler-loss tests alone 12 times | private logs | 41 of 41 pass all three times, about 24 s each; 12 of 12. Nothing left running. 22 tests on a simulated process table, 19 with real processes. |
| 2026-11-13 | Finite allocator under `--memory-limit-mb=128`, three runs | terminal | Stopped at 132, 132 and 140 MB after 0.5 to 0.6 s, exit 137, run confirmed gone, 0.64 to 0.70 s wall. |
| 2026-11-13 | Sampler reading against the macOS `footprint` tool for one process holding 96 MB | terminal | Sampler footprint 109.0 MB, tool 109.2 MB; resident 137.1 MB against 137.4 MB from Node. |
| 2026-11-13 | Guard cost on a 10 s idle run | terminal | 165 samples; about 5 percent of one core in total (sampler about 2 ms of CPU per scan, guard process about 0.02 s per second). |

Real-process scenarios covered by the tests: pass and fail passed through; per-process and total limit; a memory stop that takes nested, detached and adopted processes with it; leftovers of a finished run, including one that ignores SIGTERM; SIGTERM, SIGINT and a second signal; deadline; both samplers killed and both frozen; a leftover that cannot be ended and one that cannot be identified, both turning a passing run into exit 125; a process of the run that cannot be read stopping the run; a runner that cannot be read stopped at the first scan before the fixture starts anything; the sampler in use failing with no new one available, where the standby stops the whole run; no sampler working at all, where only the runner's group is ended; bad options. In each scenario that starts one, a process outside the guarded run survives.

## Review record

At most three correction cycles.

- Review 1, on the in-progress guard: four blocking findings (read failures dropped or zeroed; exit 0 with unconfirmed cleanup; signals sent from a stale snapshot; test cleanup by bare pid). Answered in the guard hardening commit.
- Review 2, on that commit: the four findings substantially addressed; 34 of 34 rerun independently. One new blocking finding: a runner unreadable from the first scan was never adopted, so nothing was owned and the run could continue unmeasured until the deadline. One limit to evaluate: when the sampler and its replacement both fail, detached children are left. Answered in the cycle 2 commit: the runner is the root by its own pid; the second sampler stands by from the start. The total-failure case remains a limit and is stated below.
- Review 3, on the cycle 2 commit: source approved for narrow, supervised use with #328; 40 of 40 in one of three independent runs, 39 of 40 in the other two. The failing test expected the words "sampler exited" or "did not answer" and got "sampler closed its input". Cause confirmed: a sampler that ends is noticed as its exit or as its closed input, whichever the guard sees first, and the guard acts the same on both (it marks the sampler gone and stops the run; the captured run exited 125 with every process gone). Answered in the cycle 3 commit: both are reported as "sampler ended", with the way it was noticed in brackets; the test accepts exactly those two wordings for a killed sampler and only "did not answer" for a frozen one, with its exit status, cleanup and bystander checks unchanged; one test added at the sampler client. No change to what the guard does.
- Fallback evaluated for the total-failure case and not built: identifying detached processes with `ps` start times. It needs a second identity kept for every process, has one-second resolution and a millisecond gap before each signal, and fails in the same condition as starting a new sampler (no new process can be started). Nothing in Node can read another process's start time.

## Limits of the guard, measured where possible

- Not a hard cap. It samples every 50 ms. A run passes its limit by what it allocates between two samples plus the time to freeze it. The finite allocator at about 200 MB per second passed a 128 MB limit by 4 to 12 MB. A run growing at 3 GB per second would pass by roughly 150 MB or more. Not tested at that rate.
- A detached child is missed when its parent exits before the next sample. Measured with a parent that starts a detached child and exits N ms later, 12 runs each: missed 12 of 12 for N of 0, 10, 20 and 40; found 12 of 12 for N of 60 and 100. A missed process is not tracked, limited or cleaned up, and the guard does not know it exists. The three detached launches in #328 (the browser in `tests/asset-controls-cdp-helper.js` and `tests/ui-stability-responsive-geometry.test.js`, an idle Node process in `tests/asset-controls-real-browser.test.js`) keep their parent test process alive, so they are found at the next sample. Ways to narrow this further, not implemented: fork notifications from kqueue (still a sub-millisecond race), or a marker variable in the run's environment (changes the environment the tests see).
- Pid reuse. Every signal is checked against the start time by the sampler immediately before it is sent. A gap of microseconds remains between that check and the signal. A process frozen in that gap by mistake is resumed and not killed; a kill in that gap cannot be undone. Nothing available to an ordinary program on macOS closes it.
- If the guard itself is killed with SIGKILL or frozen, the run continues unwatched. Measured: the sampler ends, the test processes keep running.
- The guard is not able to end the whole run when no sampler works any more: the one in use, the one standing by, and a newly started one all fail. It then kills only the runner's process group, by the runner's pid and only while the runner has not been collected, leaves whatever the run started outside that group running, lists those pids, and exits 125. In that case it fails closed for the group, not for the full tree. A test pins this behavior.
- A process of the run that the guard cannot read (another user's, for example) is never signalled by pid. The run is stopped and exits 125 with that process reported.
- Compressed memory is read through footprint at every sample. Not tested under real memory pressure.
- macOS only. Needs `/usr/bin/python3` or `python3` on the path; without a working sampler the guard refuses to run the tests.
- A runner that is unreadable only in the way an ending process is, or missing from scans, is tolerated for three samples (about 0.15 s) before the run is stopped.
- The guard's own waits are bounded: 5 s grace after a signal, 2 s for leftovers, 5 s to confirm a kill, 1 s per sampler request, at most 3 s without a sample.

## Open items for the paused work

None of these is done.

- Bounded assert: treat a value whose size cannot be measured safely (measurement throws, iterators, promises, module namespaces) as too large; never call into a Proxy while summarizing; cap the work spent locating the first difference; cover every exposed path (`throws`/`rejects` with an object validator, legacy `fail(actual, expected)`, `partialDeepStrictEqual`, `assert.Assert`, `t.assert`); add a differential parity test against `node:assert/strict`.
- `tests/run-tests-memory-guard.test.js` imports `./bounded-assert`, which is still the prototype.
- #328 adds `tests/asset-controls-real-browser.test.js` and `tests/excluded-needs-review-ipc.test.js`, which import `node:assert/strict` directly. With #328 merged first, this branch switches their imports when it is brought onto the new base.
- `npm test`, the CI workflow steps and their pins, and documented commands are not wired.
- The default deadline of 2400 s and the default limits were chosen from one full-suite run of the prototype and need confirming on the final head.

## Sequence after resumption

1. Independent read-only review of the guard at its final head. Findings return to this writer as follow-up commits. The guard is not used for #328 before that review passes.
2. Wait for #328's separately approved merge. Do not resume the paused work before Mack's message.
3. Bring this branch onto the new v2.4.x and regenerate the one-line import switch so it covers every test file on that base, including #328's new files.
4. Close the open items above. Keep exact assertion coverage: no test or assertion removed, skipped or weakened.
5. Focused checks, then a live process preflight, then the full serial suite on the exact head from a non-hidden workspace with the pinned Node and Chrome. Wait if another session's Chrome or heavy run is active. Never signal a process another session started.
6. Push, open a draft PR, exact-head CI, independent Luna review at high effort plus a distinct second reviewer, at most three correction cycles.
7. Bryant's own approval for ready-for-review and for merge. Neither is authorized today.
8. After a separately authorized merge: the post-merge acceptance below.

## Required post-merge acceptance (Bryant, 2026-11-13)

Status: REQUIRED. NOT RUN. A planned run does not count as completed. This is acceptance of the merged code, in addition to pre-merge evidence. The narrower guard work above does not replace it.

When: after this PR and #328 are both on v2.4.x by separately authorized merges. The focus test lives in #328, so the acceptance needs both.

Rules: one check at a time, after a live process preflight. Every Node process runs under an external limit. Never reproduce unbounded growth. Never raise a limit to make a check pass. Never signal a process this procedure did not start.

Setup:

- `MERGED` is the exact merged commit on v2.4.x. Export it with `git archive "$MERGED"` into a new non-hidden folder `RUN/app`, install dependencies from the lockfile as CI does, and use the pinned Node 22.23.1.
- `RUN/counterfactual` is a copy of `RUN/app` in which the focus guard is removed from `renderer/app.js`: the `button: button || null,` property and the four lines that begin with the comment `Never take focus back from a control the person moved to`. The copy is never committed.
- `RUN/unfixed` is a copy of `RUN/counterfactual` in which only `tests/renderer-figma-scope.test.js` imports `node:assert/strict` again. It exists to measure the old behavior under a low limit, and is never committed.
- `FOCUS` is `--test-name-pattern="never takes focus back" tests/renderer-figma-scope.test.js`.
- Measure each run with `/usr/bin/time -l` and record exit code, wall time, `maximum resident set size` and `peak memory footprint`.
- Besides the guard under test, keep a second, independent limit: a small loop that reads the resident size of the run's processes several times a second and ends those above 1024 MB, recognizing them by a marker in their command line and not by pid alone.

Checks, in order:

| # | Folder | Command | Expected |
| --- | --- | --- | --- |
| 1 | `RUN/app` | `node scripts/run-tests.js --memory-limit-mb=512 $FOCUS` | Test passes, exit 0, peak footprint under 100 MB, guard summary line present, nothing left running. |
| 2 | `RUN/counterfactual` | same as 1 | Test fails on the same assertion as before the fix (`focus stays on Search`), with the summary message instead of a diff. Exit 1, not 137 or 125. Peak footprint under 100 MB. Nothing left running. |
| 3 | `RUN/unfixed` | same as 1 | The old behavior, safely: the guard stops the run within about 2 seconds with exit 137 and names the process. Peak stays under about 1 GB. This is the "before" number for the comparison. |
| 4 | `RUN/app` | `node scripts/run-tests.js --memory-limit-mb=128 tests/fixtures/memory-guard/growing.fixture.js`, with two bystander processes started beforehand outside the run (`sleep 600` and an idle `node`) | Exit 137 and the limit message. Both bystanders are still alive with the same pid and start time. End the bystanders afterwards. |
| 5 | `RUN/app` | `node scripts/run-tests.js tests/bounded-assert.test.js tests/run-tests-memory-guard.test.js` | All pass, exit 0. |

Stop criteria: another session's test, Chrome or heavy process is active (wait, do not signal it); any run passes the independent 1024 MB limit; any exit code, pass or fail result, or leftover process differs from the table. On a stop, do not retry with a higher limit. Report what was observed.

Evidence: raw logs stay in a private folder outside the repository and are not published. Publish only a sanitized table per check: exit code, wall time, maximum resident size, peak footprint, and pass or fail against the expectation. No machine paths, user names, pids or process lists.

Comparison to report: checks 2 and 3 side by side (after and before) for the failing path, and check 1 against the passing path measured on the same commit with `node --test` under the independent limit.

## Handoff

Next exact action:

```text
Wait for Mack. If review findings on the guard arrive, read this taskflow, verify branch t3/test-memory-guard and its working tree, and answer them with normal follow-up commits and bounded synthetic tests only. Do not use the guard for #328, run a full suite, push, or open a PR before Mack says so. Do not run the post-merge acceptance before a separately authorized merge of this PR and of #328.
```
