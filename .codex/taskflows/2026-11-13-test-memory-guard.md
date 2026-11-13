# Taskflow: Test memory guard and bounded assertion failures

## Metadata

- created: 2026-11-13
- updated: 2026-11-13
- owner: Fable (writer for this branch), coordinated by Mack for Bryant
- standing order: none selected yet; select one from `.codex/ops/standing-orders.md` on resume
- repo: bfeintuch123/crate-app
- branch: t3/test-memory-guard
- base: v2.4.x at 885bb56 (after #327 and #328), brought in by a normal merge with no conflicts
- mode: separate draft PR, not opened yet; merge, ready-for-review and release are not authorized
- status: blocked

## Goal

Stop a failing test from exhausting the machine. A failed `assert.equal` or `assert.deepEqual` on a very large value (the synthetic renderer DOM, a large Buffer, a long string) makes Node 22 render both values and diff them with memory that grows without limit outside the V8 heap. The fix has two parts: test files import a bounded drop-in for `node:assert/strict`, and tests run through `scripts/run-tests.js`, which watches the memory of the whole run from outside and stops it when it passes a limit.

## Scope

Allowed:

- `tests/bounded-assert.js`, its tests and fixtures
- the one-line assert import in test files
- `scripts/run-tests.js`, `scripts/run-tests-sampler.py`, their tests and fixtures
- `package.json` `test` script, the two node:test steps in `.github/workflows/security-gate.yml` and their pins in `tests/release-artifact-policy.test.js`
- test commands in AGENTS.md, check suites, playbooks and QA smoke templates

Forbidden:

- app source (`main.js`, `renderer/`, `parsers/`, `preload.js`)
- removing, skipping or weakening any test or assertion
- merge, auto-merge, ready-for-review, release, or publishing private machine evidence
- any deliberate runaway or memory-exhaustion test
- a fourth correction cycle on the guard without Bryant

## State

- current phase: STOPPED on a blocking issue in the reviewed guard, found by the writer during focused checks on the merged base. Waiting for Bryant.
- last completed checkpoint: v2.4.x (885bb56) merged in; bounded assert finished and tested; guard wired into `npm test`, CI and documented commands; all committed locally, unpushed
- next action: Bryant decides how the guard should treat a process of the run that it cannot read because another user owns it (see Blocker). Then one more guard change, bounded tests, the heavy slot for a full suite, push, draft PR, exact-head CI, and the independent reviews.
- blocker: see Blocker below. All three correction cycles are used; this needs a fourth, which is Bryant's call.
- approval state: resumption authorized after #328 merged; no approval to merge, mark ready, or release
- preferences applied: one writer, read-only reviewers, no concurrent heavy Mac tests, every run through the guard, pinned Node, live process preflight before each run
- routing decision: major PR (shared test infrastructure and CI); needs exact-head protected CI and independent read-only reviews by Astra at high effort and Claude Fable 5.2 at high effort, each in a fresh session
- workflow eval suite/result: focused checks only, see Evidence. No full suite on this base.
- outcome receipt: none

## Blocker

The guard stops any run in which a test starts a tool that runs as another user while a sample lands on it. `/bin/ps` is such a tool (it is installed setuid root). The sampler reports a `ps` child as owned by uid 0 with its start time and memory unreadable (errno 1, EPERM), and the rule added after the first review, that a process of the run which cannot be read stops the run, then ends the whole run with exit 125. Seen on the merged base: a focused run was stopped after 22 s while `tests/run-tests-memory-guard.test.js` was running; in a direct check, 240 of 240 scans of the writer's own `ps` children came back unreadable in exactly this way.

Seven test files start `ps`: `cross-app-live-pipeline`, `olivia-baseline-discovery`, `provenance-dual-write`, `working-file-choice-ipc`, `working-source-recovery-core`, `working-source-recovery-ipc`, and the guard's own test file. A `ps` lives for about 15 ms and the guard samples every 50 ms, so the full suite, which makes dozens of such calls, would almost certainly be stopped. With the guard wired into CI as it is on this branch, CI would fail the same way. The branch is therefore not pushed and no PR is open.

Nothing else is affected: the same focused set without those files passes through the guard, 517 of 517.

Choices, for Bryant:

1. Tolerate briefly (recommended). A process of the run that another user owns may stay unreadable for a short, fixed time, for example ten samples (0.5 s), before the run is stopped as now. A `ps` is gone long before that. What it gives up: such a process is unmeasured for up to that time; the guard cannot signal it either way.
2. Recognize system tools by path and exempt only those. More exact, more code, and a list to maintain.
3. Change the seven test files not to start `ps`. Touches tests outside this work, including files from #328 and the provenance suite.
4. Leave the rule as it is. The guard then cannot run this suite.

Each of 1 to 3 is a change to reviewed guard behavior or to other tests, so it needs a new review at the new head.

## Checkpoints

- [x] preflight / doctor (read-only preflight of v2.4.x, #327, #328 and duplicate work; no duplicate found)
- [x] context loaded
- [x] implementation: memory guard hardening (three correction cycles, reviewed through 90fd869; one later wording commit not yet reviewed)
- [x] merge of v2.4.x at 885bb56 (#328), normal merge, no conflicts
- [x] implementation: bounded assert hardening, import switch on the merged base, CI and doc wiring
- [x] verification: focused checks through the guard on the merged base
- [ ] BLOCKED: the guard must cope with tests that start `ps` (Bryant's decision)
- [ ] verification: full serial suite on the final head (heavy slot, coordinated; not run)
- [ ] push and draft PR
- [ ] exact-head CI
- [ ] independent reviews: Astra high and Claude Fable 5.2 high, fresh read-only sessions
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
| 2026-11-13 | Merged base: `tests/bounded-assert.test.js` through the guard | private log | 19 of 19 pass. Ten deliberate regressions in the wrapper, one at a time, each caught. With the size bound removed on purpose, the whole file still finishes: 10 tests fail and it peaks at 547 MB, the guarded child stopped at its 512 MB limit as designed. |
| 2026-11-13 | Merged base: focused files through the guard, including the guard's own test file | private log | Stopped by the guard after 22 s with exit 125: a `ps` started by a test could not be read. This is the Blocker. Every test that had run had passed (541). |
| 2026-11-13 | Merged base: the same focused set without files that start `ps` (bounded assert, release, install and app-content policy, legacy conf, excluded-needs-review IPC, renderer Figma scope, four `.cjs` files) | private log | 517 of 517 pass through the guard in 21 s; peak 364 MB in one process. Includes the focus test from #328 and the updated CI pins. |
| 2026-11-13 | Merged base: `node --test tests/run-tests-memory-guard.test.js` directly | private log | 41 of 41 pass, 27 s, nothing left running. |
| 2026-11-13 | Finite allocator under `--memory-limit-mb=128`, three runs | terminal | Stopped at 132, 132 and 140 MB after 0.5 to 0.6 s, exit 137, run confirmed gone, 0.64 to 0.70 s wall. |
| 2026-11-13 | Sampler reading against the macOS `footprint` tool for one process holding 96 MB | terminal | Sampler footprint 109.0 MB, tool 109.2 MB; resident 137.1 MB against 137.4 MB from Node. |
| 2026-11-13 | Guard cost on a 10 s idle run | terminal | 165 samples; about 5 percent of one core in total (sampler about 2 ms of CPU per scan, guard process about 0.02 s per second). |

Real-process scenarios covered by the tests: pass and fail passed through; per-process and total limit; a memory stop that takes nested, detached and adopted processes with it; leftovers of a finished run, including one that ignores SIGTERM; SIGTERM, SIGINT and a second signal; deadline; both samplers killed and both frozen; a leftover that cannot be ended and one that cannot be identified, both turning a passing run into exit 125; a process of the run that cannot be read stopping the run; a runner that cannot be read stopped at the first scan before the fixture starts anything; the sampler in use failing with no new one available, where the standby stops the whole run; no sampler working at all, where only the runner's group is ended; bad options. In each scenario that starts one, a process outside the guarded run survives.

## Review record

At most three correction cycles.

- Review 1, on the in-progress guard: four blocking findings (read failures dropped or zeroed; exit 0 with unconfirmed cleanup; signals sent from a stale snapshot; test cleanup by bare pid). Answered in the guard hardening commit.
- Review 2, on that commit: the four findings substantially addressed; 34 of 34 rerun independently. One new blocking finding: a runner unreadable from the first scan was never adopted, so nothing was owned and the run could continue unmeasured until the deadline. One limit to evaluate: when the sampler and its replacement both fail, detached children are left. Answered in the cycle 2 commit: the runner is the root by its own pid; the second sampler stands by from the start. The total-failure case remains a limit and is stated below.
- Review 3, on the cycle 2 commit: source approved for narrow, supervised use with #328; 40 of 40 in one of three independent runs, 39 of 40 in the other two. The failing test expected the words "sampler exited" or "did not answer" and got "sampler closed its input". Cause confirmed: a sampler that ends is noticed as its exit or as its closed input, whichever the guard sees first, and the guard acts the same on both (it marks the sampler gone and stops the run; the captured run exited 125 with every process gone). Answered in the cycle 3 commit: both are reported as "sampler ended", with the way it was noticed in brackets; the test accepts exactly those two wordings for a killed sampler and only "did not answer" for a frozen one, with its exit status, cleanup and bystander checks unchanged; one test added at the sampler client. No change to what the guard does.
- After the merge of #328 (2026-11-13), by the writer, during focused checks on the merged base: the rule from review 1 that a process of the run which cannot be read stops the run also stops runs in which a test starts `ps`. Not fixed: no correction cycle is left. See Blocker.
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

## What the bounded assert covers

- equal, notEqual, deepEqual, notDeepEqual and their strict aliases: decided exactly as `node:assert/strict` decides them; Node's own message when both operands are small, a summary otherwise.
- throws and rejects with a validation object: the function or promise is settled once; Node judges it when its message would be small, otherwise the same rule is applied here with a summary in place of the diff.
- the deprecated `fail(actual, expected)` and `partialDeepStrictEqual` do not render large operands (the second refuses them).
- `assert.Assert` is not handed out, and a test forbids `t.assert`, direct imports of `node:assert`, and hand-built AssertionErrors in test files.
- Not bounded in time for a comparison Node itself cannot finish quickly: the comparison is Node's own.
- The search for the first difference is limited to 64 levels, 50,000 comparisons and one second.

Still open, apart from the Blocker:

- The default deadline of 2400 s and the default limits were chosen from one full-suite run of the prototype and need confirming on the final head. CI passes `--deadline-seconds=2580`, just under the job's 45 minutes; the suite step took 35 min 47 s in the post-merge run on 885bb56.
- The guard has not run this suite on CI yet. It needs `/usr/bin/python3` or `python3` on the runner.

## Sequence from here

1. Bryant decides the Blocker.
2. One guard change for it, with bounded synthetic tests, as a normal follow-up commit.
3. Report "ready for heavy checks" on that head and wait for the coordinator. Then a live process preflight and the full serial suite through the guard, from a non-hidden workspace with the pinned Node and Chrome. Wait if another session's test, sampler or Chrome is active. Never signal a process another session started.
4. Push, open a draft PR against v2.4.x, exact-head CI.
5. Independent read-only reviews at that head: Astra high and Claude Fable 5.2 high, each in a fresh session. This writer does not count as a reviewer. A finding that needs a fix goes to Bryant.
6. Bryant's own approval for ready-for-review and for merge. Neither is authorized today.
7. After a separately authorized merge: the post-merge acceptance below.

## Required post-merge acceptance (Bryant, 2026-11-13)

Status: REQUIRED. NOT RUN. A planned run does not count as completed. This is acceptance of the merged code, in addition to pre-merge evidence. The narrower guard work above does not replace it.

When: after this PR is on v2.4.x by a separately authorized merge. #328, which carries the focus test, merged on 2026-11-13 as 885bb56.

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
Wait for Bryant's decision on the Blocker. Do not change the guard, push, open a PR or run a full suite before it. Then read this taskflow, verify branch t3/test-memory-guard and its working tree, and continue from "Sequence from here" step 2. Do not run the post-merge acceptance before a separately authorized merge of this PR.
```
