# Crate App CI audit, November 2026

Baseline measurements for the CI speed work that follows. Taken read-only on
2026-11-15 against `origin/v2.4.x` at `102844bade16b888bc26660328875abfdb33918c`.
Later PRs compare their real runs against these numbers.

## Scope and method

- Workflow: `.github/workflows/security-gate.yml`, one job, "Source security
  and regression suite", on `macos-15` (GitHub standard runner, 3 vCPU, 7 GB).
- Sample: the 150 most recent workflow runs, 2026-10-19 to 2026-11-14, which
  hold 158 job attempts (8 runs were re-run once).
- Source: `GET /repos/{owner}/{repo}/actions/runs` and
  `GET /repos/{owner}/{repo}/actions/runs/{id}/jobs?filter=all`.
  - Waiting = job `started_at` minus job `created_at`.
  - Setup = the sum of these steps: Set up job, Check out source, Scrub
    checkout credentials, Reject repository package-manager configuration,
    Prepare isolated npm configuration, Set up Node.js, Install frozen
    dependencies, Install authenticated fixed Chrome for Testing.
  - Suite = the step "Run complete serial source suite".
- Percentiles use linear interpolation. Step and suite figures use successful
  job attempts only (n = 115).
- Per-test durations come from the TAP `duration_ms` values in the job logs of
  five runs: 39310192806 (Oct 19), 41580875970 (Nov 3), 42710153132 (Nov 9),
  43308223187 (Nov 12), and 43645371153 (Nov 14, push to `v2.4.x`).

## Outcomes

| Event | Success | Failure | Cancelled |
| --- | --- | --- | --- |
| pull_request (121 attempts) | 83 | 16 | 22 |
| push to v2.4.x (37 attempts) | 32 | 1 | 4 |

Runner time over the sample: 4,128 minutes, of which 618 were cancelled
attempts and 340 were failed attempts.

## Time split

| Bucket | n | p50 | p95 | max |
| --- | --- | --- | --- | --- |
| Waiting | 158 | 3 s | 9 s | 22 s |
| Setup | 115 | 23 s | 29 s | 76 s |
| Suite step | 115 | 1,500 s | 2,221 s | 2,397 s |
| Whole job, successful | 115 | 1,531 s | 2,258 s | 2,448 s |
| Whole job, failed | 17 | 1,365 s | 2,274 s | 2,313 s |

The suite step is about 98% of a successful job.

## Suite growth

| Run date | Tests | Suite duration |
| --- | --- | --- |
| 2026-10-19 | 3,203 | 1,473 s |
| 2026-11-03 | 3,361 | 1,127 s |
| 2026-11-09 | 3,667 | 1,441 s |
| 2026-11-12 | 4,149 | 2,178 s |
| 2026-11-14 | 4,340 | 2,060 s |

The CI guard deadline is 3,400 s and the job limit is 60 minutes.

## Where the suite time goes (run 43645371153)

Sum of per-test durations: 2,027 s over 4,333 parsed tests.

The 4,340 tests in "Suite growth" for this run come from the runner's own
`# tests` summary line. The 4,333 parsed tests are the top-level `ok` and
`not ok` result lines that carry a `duration_ms`, and the TAP plan line is
`1..4333`. The suite step log also holds 7 nested subtest results, which
`# tests` counts and this audit did not parse: 4 under "invalid encrypted
credential entries do not ask Keychain about encryption" and 3 under "archive
stream completion follows terminal stream events".

| Test | File | Duration |
| --- | --- | --- |
| large Add Files source scans use bounded concurrency and report per-file failures | tests/provenance-dual-write.test.js | 354 s |
| capacity: 128 cards drain 129 durable obligations with 130 predecessors across restart | tests/working-file-choice-ipc.test.js | 337 s |
| membership cost: recorded-owner work adds linear, not assets-times-references, operations | tests/olivia-baseline-discovery.test.js | 141 s |
| Review Assets preview requests stay bounded for large projects and preserve project-owned safety | not attributed | 76 s |
| membership cost: an excluded document that owns 400 rows adds linear work | not attributed | 64 s |

- The 10 slowest tests take 1,153 s (57%); the 100 slowest take 1,521 s (75%).
- 14 tests take longer than 10 s; 3,255 take less than 0.1 s.
- The first test took 311 s to 509 s across the five sampled runs, and the
  second 299 s to 390 s.
- Approximate per-file totals: provenance-dual-write 648 s,
  olivia-baseline-discovery 609 s, working-file-choice-ipc 361 s, and about
  410 s for the other 96 files together. These are approximate: the TAP output
  carries no file names, 2,245 of 4,333 titles are generated at run time, and
  those were attributed by their position between titles that match a file.
- Memory guard report for a full CI run (run 43629676116): peak 491 MB in one
  process and 1.1 GB in total, against limits of 2.0 GB and 4.0 GB.

## Failures

17 failed attempts:

- 12 in the suite step.
- 3 in "Reject high-severity dependency findings", in jobs that took 17 s to
  20 s in total. The step failed 13 s to 17 s after the job started.
- 1 in "Reject pull-request whitespace errors" (run 43300041932), because
  that step ran after the suite. The step failed about 1,932 s after the job
  started (20:24:51Z to 20:57:03.8Z). The whole job took 1,944 s.
- 1 guard exit 125 in the suite step (run 43629082221). The guard's message
  was logged about 181 s after the job started (18:53:50Z to 18:56:51Z). The
  whole job took 186 s. Cause not diagnosed. The same guard message recurred
  in run 43879768695 on 2026-11-16 (after 130.1 s, a Chrome process, errno 3,
  four samples in a row). Diagnosis is in progress.

Three attempts failed in the suite and passed when the same commit was re-run:

| Run | Failed test |
| --- | --- |
| 39321487018 | a scan that completes during replacement preflight is fenced from the old link |
| 41911337978 | v23 Watch coverage manual-at-cap reconciled seeded scope admission |
| 43629676116 | remembered-record [+]: disabled across a refresh while held, refused accept re-enables it with the exact message |

## Cancellations

26 cancelled attempts. Four ended between 1,822 s and 1,825 s on Nov 9 to
Nov 11, which matches the 30-minute job limit in force before PR #329. One
ran 8,409 s on Nov 2. The rest ended earlier, consistent with a newer commit
on the same ref cancelling the run.

## Branch protection at the time of the audit

`v2.4.x` requires the check "Source security and regression suite" from the
GitHub Actions app, requires branches to be up to date before merging, and
applies to administrators. The repository is public and owned by a personal
account, so GitHub's merge queue is not available to it.

## Limits of this audit

- Per-test figures come from five runs, not all 150.
- Per-file totals are approximate, as described above.
- No test was run locally for this audit.
- Runner-to-runner variance for the same test was large and is unexplained.
