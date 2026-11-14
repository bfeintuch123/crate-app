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
- status: in progress

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
- any further correction cycle on the guard without Bryant (he authorized one targeted round for the `ps` blocker on 2026-11-13 and, the same day, the three changes recorded under "The `ps` blocker and what came of it")

## State

- current phase: the correction round Bryant authorized is implemented as three local commits plus tests and this record, checked with bounded runs, and reviewed independently in two Opus 5.5 sessions that together read the whole change (approve for heavy checks; their required items are done). Next gate: the coordinator's heavy slot for the full suite.
- last completed checkpoint: three guard commits on top of the merged base, unpushed (see "The `ps` blocker and what came of it")
- next action: report "ready for heavy checks" on the exact head and wait for the coordinator. Then the full serial suite through the guard, push, draft PR, exact-head CI, and the independent final reviews.
- blocker: none in the code. The heavy slot and every later gate belong to the coordinator and Bryant.
- approval state: Bryant approved all three changes on 2026-11-13 ("Proceed"); no approval to merge, mark ready, enable auto-merge, or release
- preferences applied: one writer, read-only reviewers, no concurrent heavy Mac tests, every run through the guard, pinned Node, live process preflight before each run
- routing decision: major PR (shared test infrastructure and CI); needs exact-head protected CI and two independent read-only final reviews, each in a fresh session: Claude Opus 5.5 at high effort, which replaces Astra for this work on Bryant's instruction, and Claude Fable 5.2 at high effort
- workflow eval suite/result: bounded checks only, see Evidence. No full suite on this base.
- outcome receipt: none

## The `ps` blocker and what came of it

Found on the merged base: the guard stopped any run in which a test starts the system's `ps` while a sample lands on it. `/bin/ps` is installed set-uid root, so the sampler may not read its start time or memory (errno 1, EPERM), and the rule added after the first review, that a process of the run which cannot be read stops the run, ended the whole run with exit 125.

Correction (2026-11-13, by the writer, after the three changes below were built). This record, the writer's reports and the message of the first commit said that seven test files start `ps`. That was a count from a text search and it was wrong. Six of those files (`cross-app-live-pipeline`, `olivia-baseline-discovery`, `provenance-dual-write`, `working-file-choice-ipc`, `working-source-recovery-core`, `working-source-recovery-ipc`) only name `/bin/ps` in stubbed child-process handlers and start nothing. One suite file starts a real `ps`: the guard's own test file, in the helper that reads a process's command line. That file is part of the suite, so the full suite and CI, which run through the guard, would still have been stopped; but Bryant decided on the wrong count. The option it hid: change that one helper not to use `ps`, and leave the guard unable to run a test that starts `ps`. The app itself calls `/bin/ps` in many places, so a test that does not stub it would meet the same stop. Reported to Bryant with the corrected facts. His answer (2026-11-14 00:56 UTC): keep the guard accommodation.

Bryant's first decision (2026-11-13): one targeted correction and review round; a narrowly scoped accommodation for the legitimate system process, not a blanket tolerance for unreadable processes; fail-closed handling of unknown or unauthorized identity, an unreadable runner, sustained blindness, descendants and cleanup stays; stop and escalate on a new blocking safety issue or on scope beyond the round.

Running the accommodation against real processes raised three questions that were Bryant's to answer. The writer paused, an independent design check set out the choices, and Bryant approved all three on 2026-11-13. They are three separate commits:

1. Let the guard through tests that start the system `ps`.
   - The exception. A process is let through as the system `ps` only when, in one and the same scan, all of this holds: it is not the runner; it is in the run on that scan's own evidence (started by a process of the run, or in the runner's group in a scan that shows the runner; "this pid was in the run a moment ago" is not enough); its parent, group and owners can be read; its usage fails with EPERM; the system reports its executable as exactly `/bin/ps`; its real owner is the guard's user and its effective owner is root. At most 40 samples in a row and 2 seconds since it first could not be read, at most 8 at once. It is counted at an assumed 32 MB, which the summary line labels as an assumption. Its row stays unidentified, so it is never signalled by pid; the runner's group signal reaches it like everything else in the group. One that is left running outside the group when the run is cleaned up is listed, and the run exits 125.
   - An ended `ps`. libproc does not describe a process that has ended and waits for its parent to collect it: it answers "no such process". For a pid libproc cannot find, the sampler asks the system's process table (`sysctl kern.proc.pid`) last and reports the process as ended only when the table says so. It checks its reading of that table on two known processes at start and does not start otherwise.
   - A `ps` in transition, and the price of handling it (Bryant's second decision). For under 0.3 ms while it starts and while it ends, a `ps` reads as neither the tool nor an ordinary process. The sampler reads a process this user started and may not read again after 1 ms, and up to twice more (1 ms, 2 ms) while two readings in a row differ, and reports the last reading. The guard judges that reading with no added tolerance. What this gives up: a state of such a process that is over within those waits (about 4 ms, more under load) no longer reaches the guard, even one it would have stopped the run for. Children of the guard, which is where the test runner is, are never read again.
2. Recognize every process that has ended, not only a set-uid one (Bryant's first decision of the three; it reaches beyond `ps`). The reviewed guard had a false stop of its own: an ordinary child that the guard had seen, and that then ended while its parent was busy for more than three samples (about 0.2 s), stopped the run with exit 125. The guard's own test file ran into it under the guard. The sampler now asks the process table for any pid libproc cannot find while usage answers or is denied, and the guard leaves an ended process out of what the run holds, because the system keeps reporting the resident size it had at the end. The design check named a `ps`-only alternative; Bryant chose the general one.
3. Do not let the end of a run hide that the guard could not read it (Bryant's third decision; a defect of the reviewed guard that the design check found by reading the source). When a scan showed a process the guard could not read and the run had ended, or a signal had arrived, while that scan's answer was on its way, the guard exited with the tests' own status or the signal's and did not mention the process. A read failure now outranks whatever else its scan shows, and the one scan the guard makes right after a run has ended is judged like every scan before it. Not changed: while the guard is ending a run, a process it cannot read counts only if it is still running at the end.

## Checkpoints

- [x] preflight / doctor (read-only preflight of v2.4.x, #327, #328 and duplicate work; no duplicate found)
- [x] context loaded
- [x] implementation: memory guard hardening (three correction cycles, reviewed through 90fd869; one later wording commit not yet reviewed)
- [x] merge of v2.4.x at 885bb56 (#328), normal merge, no conflicts
- [x] implementation: bounded assert hardening, import switch on the merged base, CI and doc wiring
- [x] verification: focused checks through the guard on the merged base
- [x] the guard copes with tests that start `ps`; ended processes are recognized; a read failure is not hidden by the end of a run (three commits, each approved by Bryant)
- [x] verification: bounded checks of that work, including the guard's own tests under the guard
- [x] independent read-only review of the implementation, before the full suite (Claude Opus 5.5 at f2d64e0: approve with required changes)
- [ ] verification: full serial suite on the final head (heavy slot, coordinated; not run)
- [ ] push and draft PR
- [ ] exact-head CI
- [ ] independent reviews: Astra high and Claude Fable 5.2 high, fresh read-only sessions
- [ ] REQUIRED post-merge acceptance on the exact merged commit (see below; not run)

## How the guard works

- A long-lived sampler reads every process through libproc: parent, process group, owners, state, start time, resident size and `ri_phys_footprint`, which includes compressed memory. One scan of about 1000 processes takes about 2.5 ms, and a few milliseconds more when a process has to be read again. The guard waits 50 ms between scans. A second sampler is started and checked before any test runs and stands by for cleanup.
- The runner is the root of the run by its own pid from the first scan, readable or not: the guard started it and has not collected it, so that pid cannot belong to anyone else. Every other process is identified by pid and start time together. It belongs to the run when it is in the runner's process group in a scan that also shows the runner, was started by a process of the run (including detached children in their own session and group), or was identified as the run's before.
- Stopping a run: SIGSTOP to the group and to every identified process, repeated until a scan finds nothing new; then SIGKILL; then scans until everything is gone or five seconds pass. The sampler sends every signal: it reads the target's start time again and signals in the next system call.
- The same cleanup runs on a memory limit, the deadline, a signal to the guard (after a grace period, skipped on a second signal), and for whatever a finished run leaves running.
- A process that has ended and waits to be collected is not counted, signalled or waited for. The system's `ps` is let through within the bounds described above, at an assumed size.
- It stops the run and exits 125 when the sampler does not answer for three seconds or ends, or when a process of the run cannot be read, also when the same scan shows that the run has just ended or that a signal has arrived. That includes the runner itself from the first scan: unreadable, not listed for more than three scans, or listed as something the guard did not start. With an unreadable runner the group is signalled by the runner's pid alone, which is sound only while the guard has not collected the runner, and is done only then.
- It exits 125, replacing the tests' own status, whenever it cannot confirm that every process of the run has ended.
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
| 2026-11-13 | Round for `ps`: every state a real `ps` child passes through, read as fast as possible with the sampler's own reads, 3 x 200 processes | terminal | Created and readable (0.26 ms); running as root with its parent's executable (0.2 ms); the tool (up to 37 ms); executable gone (0.02 ms); ended and not collected (0.4 ms, and 52 ms with a busy parent). libproc never reported an ended process as ended; the process table did, and agreed with libproc on parent, group, owners and state for all of about 1000 live processes. |
| 2026-11-13 | The same `ps`-heavy fixture under the guard, before the sampler handled transitions and ended processes, and after | terminal | Before: stopped falsely in 3 of 40 runs. After, on the version before the design check's required changes: 0 of 190. On the final commits: 0 of 110 (60 runs, then 50 with three CPU-busy processes alongside). |
| 2026-11-13 | The guard's own test file, directly, at each of the three commits | private logs | 60 of 60, 62 of 62, 66 of 66. |
| 2026-11-13 | The guard's own test file and the bounded-assert tests through the guard | private logs | At the first commit the run was stopped by the false stop the second commit removes (an ended helper, uncollected while the next test ran synchronously). At the second and third: 81 of 81 and 85 of 85, exit 0, peak 172 MB in one process. |
| 2026-11-13 | 58 deliberate regressions in the guard and the sampler, one at a time on a scratch copy, plus two controls | terminal | Each was caught by at least one test: every condition and bound of the `ps` exception; identity learned from an ended row; an ended parent dropped with its children; the process table believed for a live-looking record, asked in the wrong cases, or its record taken short, stale or for another pid; the start check weakened or skipped; every step of the re-read; an ended process still counted; and each half of the exit-status fix. |
| 2026-11-13 | Exit-status race, four injected forms, before and after the third commit | terminal | Before: exit 0, 0, 0 and 143, with no mention of the process the guard could not read. After: exit 125 each time, naming the process and the status it replaces. |
| 2026-11-13 | Real set-uid tools the guard must still reject, run by themselves and not under an outer guard: `top`; a `ps` that cannot finish; nine `ps` at once | private log | 3 of 3: each run was stopped with exit 125 and confirmed ended, nothing was left running, and a process outside the run was untouched. |
| 2026-11-13 | Focused files through the guard on the final commits: bounded assert, release policy, excluded-needs-review IPC, renderer Figma scope, working-file-choice IPC, working-source-recovery core and IPC, cross-app live pipeline, and the guard's own test file | private log | 791 of 791 pass, exit 0, 250 s; peak 329 MB in one process and 614 MB in total. A `ps` was let through 40 times, as many as for the guard's own test file alone. |
| 2026-11-14 | Intermittent failure reported by the implementation review: the guard's test file rerun with full output; then the one failing test alone, 60 runs before and 60 after the fix | private logs | 16 passes, then 1 failure in the per-process limit test ("stopped at 128 MB"); that test alone failed 1 of 60 before the fix, with the same message, and 0 of 60 after. |

Real-process scenarios covered by the tests: pass and fail passed through; per-process and total limit; a memory stop that takes nested, detached and adopted processes with it; leftovers of a finished run, including one that ignores SIGTERM; SIGTERM, SIGINT and a second signal; deadline; both samplers killed and both frozen; a leftover that cannot be ended and one that cannot be identified, both turning a passing run into exit 125; a process of the run that cannot be read stopping the run; a runner that cannot be read stopped at the first scan before the fixture starts anything; the sampler in use failing with no new one available, where the standby stops the whole run; no sampler working at all, where only the runner's group is ended; bad options; a run that calls `ps` over and over, several at once, and with a parent too busy to collect them; a process that reads as `ps` but does not end, and one that reads as another set-uid tool; an ordinary child and a `ps` that end and wait to be collected; a process that cannot be read just as the run ends, as a signal arrives, and in the scan after the run. In each scenario that starts one, a process outside the guarded run survives.

## Review record

At most three correction cycles.

- Review 1, on the in-progress guard: four blocking findings (read failures dropped or zeroed; exit 0 with unconfirmed cleanup; signals sent from a stale snapshot; test cleanup by bare pid). Answered in the guard hardening commit.
- Review 2, on that commit: the four findings substantially addressed; 34 of 34 rerun independently. One new blocking finding: a runner unreadable from the first scan was never adopted, so nothing was owned and the run could continue unmeasured until the deadline. One limit to evaluate: when the sampler and its replacement both fail, detached children are left. Answered in the cycle 2 commit: the runner is the root by its own pid; the second sampler stands by from the start. The total-failure case remains a limit and is stated below.
- Review 3, on the cycle 2 commit: source approved for narrow, supervised use with #328; 40 of 40 in one of three independent runs, 39 of 40 in the other two. The failing test expected the words "sampler exited" or "did not answer" and got "sampler closed its input". Cause confirmed: a sampler that ends is noticed as its exit or as its closed input, whichever the guard sees first, and the guard acts the same on both (it marks the sampler gone and stops the run; the captured run exited 125 with every process gone). Answered in the cycle 3 commit: both are reported as "sampler ended", with the way it was noticed in brackets; the test accepts exactly those two wordings for a killed sampler and only "did not answer" for a frozen one, with its exit status, cleanup and bystander checks unchanged; one test added at the sampler client. No change to what the guard does.
- After the merge of #328 (2026-11-13), by the writer, during focused checks on the merged base: the rule from review 1 that a process of the run which cannot be read stops the run also stops runs in which a test starts `ps`. Not fixed: no correction cycle is left. See Blocker.
- Round for `ps` (2026-11-13). Design check 1, a fresh read-only Astra session at high effort, before implementation: approve with required changes. All four were built: the exception needs the same scan's own evidence that the process is in the run; a time bound next to the sample bound; the real rejection cases run by themselves and not under an outer guard; wider coverage, and the assumed size labelled as such.
- Design check 2, another fresh read-only Astra session, on what real processes showed (transitions, ended processes): approve with required changes, six of them, and three points for the owner. Built: (1) a process record is taken only whole and only for the pid asked about, and believed only when it says "ended"; (2) the process table is asked last, and an ended row teaches the guard no identity; (3) what an unreadable process started stays in the run when that process has ended; (4) the re-read is described as what it is, a bounded change in what reaches the guard, with the test runner excluded from it; (5) the exit-status defect, fixed with Bryant's approval; (6) the coverage it listed. The three owner points are the three decisions above. The writer had told the coordinator that handling ended processes "necessarily" reaches beyond `ps`; the check showed a `ps`-only alternative, and the claim was withdrawn before Bryant decided.
- Implementation review at f2d64e0. Three Astra sessions did not finish: the first two restarted themselves after every context reset (the writer's instructions "check the head first" and "read your notes first" fired again each time), the third worked through 7 of 32 units in half an hour. All were stopped, the last on Bryant's instruction (2026-11-14: stop Astra, it uses too much; use Claude Opus 5.5 as the independent reviewer). Their partial notes found no defect and count for nothing.
- Claude Opus 5.5, high effort, one fresh read-only session at f2d64e0: APPROVE WITH REQUIRED CHANGES; nothing that should stop the full suite. It verified the six required changes of design check 2 as met, found no fail-closed boundary weaker than before apart from what Bryant accepted, and judged the one changed expectation in an existing test stronger, not weaker. It ran the guard's test file twice: 65 of 66 once, without capturing which test failed, and 66 of 66 once. Required: find that intermittent failure. Notes, answered in the commit after f2d64e0: a false stop of a few microseconds that the header did not list (now listed); the header and AGENTS.md wording on when a `ps` counts as part of the run (corrected); a retry during cleanup can print a report line twice (as before this round; left). The reviewer did not read four fixtures in full and did not re-check the writer's counts.
- The intermittent failure, found: the older test "a process that passes the per-process limit is stopped, named, and the run confirmed gone", and not a false stop. The guard had stopped the process correctly, just above its limit; its report rounded the size to the nearest megabyte and so could read "reached 128 MB (limit 128 MB per process)", and the test insists on a reported size above the limit. Seen again on the 17th of the writer's reruns of the whole file and once in 60 runs of that test alone, each time as "stopped at 128 MB". Fixed in the guard's report and not in the test: a size that passed a limit is shown in whole megabytes, rounded up, next to the limit in megabytes. A new test pins that. Afterwards 0 failures in 60 runs of the limit tests. Blind repetition was capped at that one batch, at the coordinator's instruction.
- The first Opus 5.5 review did not read four fixtures in full or the older tests. A second, narrow Opus 5.5 session at 4c0618e, read-only and without running anything, read exactly those (the four fixtures; test lines 645 to 1071 and 1571 to the end) and the commit made after f2d64e0: GAPS CLOSED, APPROVE FOR HEAVY CHECKS. It found every fixture finite by itself, nothing weakened in the older tests, the diagnosis of the intermittent failure sound and its fix confined to the two limit messages. Required before the final reviews: the standalone validation of real rejections takes "nothing is left running" from `pgrep -f`, which it reasoned might not see the arguments of a tool that runs as root, so the check might not be able to fail. Checked by hand: on this system `pgrep -f` does see a running set-uid `ps` and `top`. The validation now proves that itself first, with a real `ps` and a real `top`, before it relies on the check; 4 of 4. Notes left as they are: the summary line still rounds to the nearest megabyte and can read "peak 128 MB" next to "reached 129 MB"; the new formatting test pins the helper and not the two messages; a blocked `ps` in the fixtures relies on a process listing larger than a pipe.
- The message of the first of the three commits repeats the wrong count of test files that start `ps`; see the correction above.
- Fallback evaluated for the total-failure case and not built: identifying detached processes with `ps` start times. It needs a second identity kept for every process, has one-second resolution and a millisecond gap before each signal, and fails in the same condition as starting a new sampler (no new process can be started). Nothing in Node can read another process's start time.

## Limits of the guard, measured where possible

- Not a hard cap. It samples every 50 ms. A run passes its limit by what it allocates between two samples plus the time to freeze it. The finite allocator at about 200 MB per second passed a 128 MB limit by 4 to 12 MB. A run growing at 3 GB per second would pass by roughly 150 MB or more. Not tested at that rate.
- A detached child is missed when its parent exits before the next sample. Measured with a parent that starts a detached child and exits N ms later, 12 runs each: missed 12 of 12 for N of 0, 10, 20 and 40; found 12 of 12 for N of 60 and 100. A missed process is not tracked, limited or cleaned up, and the guard does not know it exists. The three detached launches in #328 (the browser in `tests/asset-controls-cdp-helper.js` and `tests/ui-stability-responsive-geometry.test.js`, an idle Node process in `tests/asset-controls-real-browser.test.js`) keep their parent test process alive, so they are found at the next sample. Ways to narrow this further, not implemented: fork notifications from kqueue (still a sub-millisecond race), or a marker variable in the run's environment (changes the environment the tests see).
- Pid reuse. Every signal is checked against the start time by the sampler immediately before it is sent. A gap of microseconds remains between that check and the signal. A process frozen in that gap by mistake is resumed and not killed; a kill in that gap cannot be undone. Nothing available to an ordinary program on macOS closes it.
- If the guard itself is killed with SIGKILL or frozen, the run continues unwatched. Measured: the sampler ends, the test processes keep running.
- The guard is not able to end the whole run when no sampler works any more: the one in use, the one standing by, and a newly started one all fail. It then kills only the runner's process group, by the runner's pid and only while the runner has not been collected, leaves whatever the run started outside that group running, lists those pids, and exits 125. In that case it fails closed for the group, not for the full tree. A test pins this behavior.
- A process of the run that the guard cannot read (another user's, for example) is never signalled by pid. The run is stopped and exits 125 with that process reported.
- The system `ps` is not measured. While one is let through the guard counts an assumed 32 MB and does not know what it holds; a run that starts one after another has that much unmeasured the whole time.
- The re-read hides short states. A process this user started and may not read is read up to three more times within about 4 ms (more under load) and only the last reading reaches the guard. A state that is over by then is not seen, even one that would have stopped the run. The test runner is excluded.
- False stops that remain, by design: a `ps` that runs for more than 2 seconds or 40 samples; more than 8 at once; one started by a process that has left the run's group and lost its parent; one that stays between two states for longer than the sampler waits, which can happen when the machine is too busy to let it finish starting; and an ended `ps` that its parent collects in the microseconds between the sampler's usage read and its question to the process table. 0 in 110 runs of a `ps`-heavy fixture is evidence, not a bound.
- An ended process is recognized by the process table saying so, read in a separate call from its usage. The reads of one row are not one instant. A pid that passes to a new process between them can give a row that mixes two processes for one sample; the order of the reads and the rule that an ended row teaches no identity keep that from making a live process look ended for longer, or from making a stranger a target.
- While the guard is ending a run, a process it cannot read counts only if it is still running at the end.
- Cleanup confirms that no process of the run is seen running or unverified any more. An ended process may still wait for its parent to collect it.
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

Still open:

- The default deadline of 2400 s and the default limits were chosen from one full-suite run of the prototype and need confirming on the final head. CI passes `--deadline-seconds=2580`, just under the job's 45 minutes; the suite step took 35 min 47 s in the post-merge run on 885bb56.
- The guard has not run this suite on CI yet. It needs `/usr/bin/python3` or `python3` on the runner.

## Sequence from here

1. Done: independent read-only review of the implementation (see Review record).
2. Report "ready for heavy checks" on the head and wait for the coordinator. Then a live process preflight and the full serial suite through the guard, from a non-hidden workspace with the pinned Node and Chrome. Wait if another session's test, sampler or Chrome is active. Never signal a process another session started.
3. Push, open a draft PR against v2.4.x, exact-head CI.
4. Independent read-only reviews at that head, each in a fresh session: Claude Opus 5.5 high (in place of Astra, which Bryant ruled out for this work) and Claude Fable 5.2 high. This writer does not count as a reviewer. A finding that needs a fix goes to Bryant.
5. Bryant's own approval for ready-for-review and for merge. Neither is authorized today.
6. After a separately authorized merge: the post-merge acceptance below.

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
Read this taskflow, verify branch t3/test-memory-guard, its head and its working tree, and continue from "Sequence from here" at the first step that is not done. Do not push, open a PR or run a full suite before the implementation review and the coordinator's go. Do not run the post-merge acceptance before a separately authorized merge of this PR.
```
