"""Helper for tests/run-tests-memory-guard.test.js, not a test. Runs the code of
scripts/run-tests-sampler.py with some of its reads answered from a script, or
against real processes it starts itself, and prints what it saw as JSON. The
test decides what that should have been.

  python3 -I -B sampler-harness.py <sampler file> <check> [<json>]

  scripted <json>   every read is answered from a script; see scripted()
  decoding          process records as sysctl could hand them back
  records           process records against libproc, for every live process
  ended             a real ordinary child and a real set-uid ps, alive, ended
                    and not collected, and collected
  scan              two scans with a real ps that is new, then already seen
  table-decoding    the longer process record, as sysctl could hand it back
  table             what the process table says of a real child and a real
                    set-uid ps, alive and then ended and not collected
  exit-window [n]   a probe, run by hand and by no test: n real set-uid ps (150
                    by default) in each of three ways of ending, read in a tight
                    loop. What it catches depends on timing, so it decides
                    nothing; it reports how often the dying state was seen, how
                    long it lasted, and whether each sighting kept the contract

Whatever it starts ends by itself within seconds and is collected here.
"""

import ctypes
import errno
import importlib.util
import io
import json
import os
import struct
import subprocess
import sys
import threading
import time

spec = importlib.util.spec_from_file_location("sampler", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

# Left in the sampler's structures by a read that fails, so that a row which
# used them anyway would show it.
STALE = 424242


def scripted(scenario):
    """Scans with every read answered from a script.

    scenario = {
      "uid": the user the sampler runs as, "guard": the guard's pid,
      "scans": [[pid, ...], ...]         the pids each scan lists
      "known": {pid: row}                what the scan before the first reported, if anything
      "script": {pid: [step, ...]}       the answers for that pid, in the order they are asked for
    }
    A step is ["info", errno, [ppid, pgid, uid, ruid, status]], ["usage", errno,
    [start, resident, footprint] or [start, resident, footprint, exit time]],
    ["path", text] or ["record", null, "absent" (the table answers and has no
    such record) or [ppid, pgid, uid, ruid, status] with, optionally,
    [seconds, microseconds] and flags]. A read the script did not expect next
    is an error, and so is a step that is never asked for.
    """
    sampler = module.Sampler()
    sampler.uid = scenario["uid"]
    sampler.guard = scenario["guard"]
    sampler.denied = {int(pid): row for pid, row in scenario.get("known", {}).items()}
    script = {int(pid): list(steps) for pid, steps in scenario["script"].items()}
    calls = []
    errors = []
    pauses = []

    def step(pid, kind):
        calls.append([pid, kind])
        steps = script.get(pid, [])
        if not steps or steps[0][0] != kind:
            errors.append("pid %d: %s was read, the script says %s" % (pid, kind, steps[0][0] if steps else "nothing more"))
            return None
        return steps.pop(0)

    def read_info(pid):
        answer = step(pid, "info")
        info = sampler.info
        if answer is None or answer[1]:
            info.pbsi_ppid = info.pbsi_pgid = info.pbsi_uid = info.pbsi_ruid = info.pbsi_status = STALE
            return answer[1] if answer else errno.EIO
        info.pbsi_ppid, info.pbsi_pgid, info.pbsi_uid, info.pbsi_ruid, info.pbsi_status = answer[2]
        return 0

    def read_usage(pid):
        answer = step(pid, "usage")
        usage = sampler.usage
        if answer is None or answer[1]:
            usage.ri_proc_start_abstime = usage.ri_resident_size = usage.ri_phys_footprint = usage.ri_proc_exit_abstime = STALE
            return answer[1] if answer else errno.EIO
        # A successful read fills the whole structure, the exit time included (0 unless the script gives one).
        usage.ri_proc_start_abstime, usage.ri_resident_size, usage.ri_phys_footprint, usage.ri_proc_exit_abstime = (list(answer[2]) + [0])[:4]
        return 0

    def read_path(pid):
        answer = step(pid, "path")
        return answer[1] if answer else "-"

    def read_table(pid):
        answer = step(pid, "record")
        if not answer or not answer[1]:
            return None
        if answer[1] == "absent":
            return module.NO_RECORD
        facts = list(answer[1]) + [[0, 0], 0][len(answer[1]) - 5:]
        return (*facts[:5], tuple(facts[5]), facts[6])

    # A sampler without read_table (the one this change started from) asks for the five facts.
    def read_record(pid):
        answer = step(pid, "record")
        return tuple(answer[1][:5]) if answer and answer[1] and answer[1] != "absent" else None

    sampler.read_info, sampler.read_usage, sampler.read_path, sampler.read_record = read_info, read_usage, read_path, read_record
    sampler.read_table = read_table
    sampler.pause = pauses.append
    scans = []
    for pids in scenario["scans"]:
        sampler.list_pids = lambda pids=pids: list(pids)
        before = len(pauses)
        rows = sampler.scan()
        scans.append({"rows": rows, "pauses": pauses[before:], "remembered": {str(pid): row for pid, row in sampler.denied.items()}})
    return {
        "scans": scans,
        "calls": calls,
        "errors": errors,
        "unused": {str(pid): [item[0] for item in steps] for pid, steps in script.items() if steps},
    }


class ScriptedSysctl:
    """Stands in for libc: each call hands back the next scripted outcome."""

    def __init__(self, outcomes):
        self.outcomes = list(outcomes)

    def sysctl(self, name, count, buffer, size, new, new_size):
        kind, data, reported = self.outcomes.pop(0)
        if kind == "fails":
            ctypes.set_errno(data)
            return -1
        ctypes.memmove(buffer, data, len(data))
        size._obj.value = reported
        return 0


def record_of(pid, ppid, pgid, uid, ruid, status):
    raw = bytearray(module.KINFO_PROC_SIZE)
    struct.pack_into("i", raw, module.KINFO_PID, pid)
    struct.pack_into("i", raw, module.KINFO_PPID, ppid)
    struct.pack_into("i", raw, module.KINFO_PGID, pgid)
    struct.pack_into("I", raw, module.KINFO_UID, uid)
    struct.pack_into("I", raw, module.KINFO_REAL_UID, ruid)
    raw[module.KINFO_STATUS] = status
    return bytes(raw)


def decoding():
    sampler = module.Sampler()
    size = module.KINFO_PROC_SIZE
    ended = record_of(4242, 100, 100, 0, 501, module.ENDED)

    def read(*outcomes):
        sampler.libc = ScriptedSysctl(outcomes)
        return [sampler.read_record(4242) for _ in outcomes]

    results = {
        "whole record of that pid": read(("ok", ended, size)),
        "record of another pid": read(("ok", record_of(4243, 100, 100, 0, 501, module.ENDED), size)),
        "no record": read(("ok", b"", 0)),
        "part of a record": read(("ok", ended[:100], 100)),
        "whole record, reported as shorter": read(("ok", ended, size - 8)),
        "reported as longer than a record": read(("ok", ended, size + 8)),
        "call fails: no such process": read(("fails", errno.ESRCH, 0)),
        "call fails: not permitted": read(("fails", errno.EPERM, 0)),
        "call fails: no memory": read(("fails", errno.ENOMEM, 0)),
        # A good record first; what follows must not be read from what it left behind.
        "after a good record: fails, none, short, nothing written": read(
            ("ok", ended, size), ("fails", errno.EIO, 0), ("ok", b"", 0), ("ok", b"", 16), ("ok", b"", size)),
    }

    # The check at start, on this process and on process 1: right, and with each fact wrong in turn.
    own = [os.getpid(), os.getppid(), os.getpgrp(), os.geteuid(), os.getuid(), module.RUNNING]
    first = [1, 0, 1, 0, 0, module.RUNNING]
    names = ["pid", "parent", "group", "owner", "real owner", "state"]
    wrong = lambda facts, index: facts[:index] + [facts[index] + 1] + facts[index + 1:]
    variants = {"as they are": (own, first)}
    for index, name in enumerate(names):
        variants["own %s wrong" % name] = (wrong(own, index), first)
        variants["first process: %s wrong" % name] = (own, wrong(first, index))
    checks = {}
    for name, (mine, other) in variants.items():
        sampler.libc = ScriptedSysctl([("ok", record_of(*mine), size), ("ok", record_of(*other), size)])
        checks[name] = sampler.check_records()
    good = ("ok", record_of(*own), size)
    for name, outcome in {"short": ("ok", record_of(*first)[:size - 8], size - 8), "none": ("ok", b"", 0), "fails": ("fails", errno.EPERM, 0)}.items():
        sampler.libc = ScriptedSysctl([outcome, good])
        checks["own record " + name] = sampler.check_records()
        sampler.libc = ScriptedSysctl([good, outcome])
        checks["first process: record " + name] = sampler.check_records()

    # A sampler that fails that check does not answer a single request.
    class NoRequests:
        def __iter__(self):
            raise AssertionError("a request was read")

    def start(requests):
        saved = sys.stdin, sys.stderr
        sys.stdin, sys.stderr = requests, io.StringIO()
        try:
            return [module.main(), sys.stderr.getvalue().strip()]
        finally:
            sys.stdin, sys.stderr = saved

    started = start(io.StringIO(""))
    module.KINFO_PROC_SIZE += 8  # not the size of the records this system hands out
    refused = start(NoRequests())
    module.KINFO_PROC_SIZE -= 8
    return {"records": results, "checks": checks, "started": started, "refused": refused}


def records():
    sampler = module.Sampler()
    agree = differ = 0

    def both(pid):
        if sampler.read_info(pid):
            return None
        info = sampler.info
        return (info.pbsi_ppid, info.pbsi_pgid, info.pbsi_uid, info.pbsi_ruid, info.pbsi_status), sampler.read_record(pid)

    for pid in sampler.list_pids():
        seen = both(pid)
        if seen and seen[1] is not None and seen[0] != seen[1]:
            seen = both(pid)  # it may have changed between the two reads
        if not seen or seen[1] is None:
            continue
        agree += seen[0] == seen[1]
        differ += seen[0] != seen[1]
    free = next(pid for pid in range(99998, 90000, -1) if sampler.read_info(pid) == errno.ESRCH and sampler.read_usage(pid) == errno.ESRCH)
    return {"agree": agree, "differ": differ, "checked": sampler.check_records(), "free": sampler.read_record(free)}


def observe(sampler, pid):
    info_errno = sampler.read_info(pid)
    usage_errno = sampler.read_usage(pid)
    megabytes = None if usage_errno else [round(sampler.usage.ri_resident_size / 1048576), round(sampler.usage.ri_phys_footprint / 1048576)]
    row, transition, *_ = sampler.read_row(pid)
    return {"info": info_errno, "usage": usage_errno, "megabytes": megabytes, "record": sampler.read_record(pid), "row": row, "transition": transition}


def ended():
    sampler = module.Sampler()
    # Holds 48 MB until its input closes. Nothing collects either child until wait() below.
    holds = "import sys\nheld = bytearray(48 * 1024 * 1024)\nfor at in range(0, len(held), 4096): held[at] = 1\nsys.stdout.write('held\\n')\nsys.stdout.flush()\nsys.stdin.read()\n"
    ordinary = subprocess.Popen([sys.executable, "-I", "-B", "-c", holds], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    ordinary.stdout.readline()
    result = {"self": {"pid": os.getpid(), "group": os.getpgrp(), "uid": os.getuid()}, "ordinary": {"pid": ordinary.pid}, "ps": {}}
    result["ordinary"]["alive"] = observe(sampler, ordinary.pid)
    ordinary.stdin.close()
    ps = subprocess.Popen(["/bin/ps", "-axo", "pid="], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    result["ps"]["pid"] = ps.pid
    time.sleep(0.6)
    for name, child in (("ordinary", ordinary), ("ps", ps)):
        result[name]["ended"] = observe(sampler, child.pid)
    for name, child in (("ordinary", ordinary), ("ps", ps)):
        child.wait()
        result[name]["collected"] = observe(sampler, child.pid)
    return result


def scan():
    sampler = module.Sampler()
    # A ps that cannot finish: nobody reads what it writes.
    child = subprocess.Popen(["/bin/ps", "-axwwo", ",".join(["command="] * 16)], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    time.sleep(0.3)
    reads = []
    read_row = sampler.read_row

    def counted(pid):
        if pid == child.pid:
            reads.append(pid)
        return read_row(pid)

    sampler.read_row = counted
    mine = lambda rows: [row for row in rows if row.startswith("%d " % child.pid)]
    first = mine(sampler.scan())
    after_first = len(reads)
    second = mine(sampler.scan())
    running = child.poll() is None
    child.kill()
    child.wait()
    return {"first": first, "second": second, "reads": [after_first, len(reads) - after_first], "running": running, "remembered": sampler.denied.get(child.pid)}


def table_decoding():
    sampler = module.Sampler()
    size = module.KINFO_PROC_SIZE
    raw = bytearray(record_of(4242, 100, 101, 0, 501, 2))
    struct.pack_into("q", raw, module.KINFO_START_SECONDS, 1763440000)
    struct.pack_into("i", raw, module.KINFO_START_MICROSECONDS, 123456)
    struct.pack_into("i", raw, module.KINFO_FLAGS, module.P_WEXIT)
    whole = bytes(raw)

    def read(outcome):
        sampler.libc = ScriptedSysctl([outcome])
        answer = sampler.read_table(4242)
        return "no record" if answer == module.NO_RECORD else answer

    return {
        "whole": read(("ok", whole, size)),
        "none": read(("ok", b"", 0)),
        "short": read(("ok", whole[:100], 100)),
        "longer": read(("ok", whole, size + 8)),
        "another pid": read(("ok", record_of(4243, 100, 101, 0, 501, 2), size)),
        "fails": read(("fails", errno.ESRCH, 0)),
        "wexit": module.P_WEXIT,
    }


def wait_until(condition):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        value = condition()
        if value:
            return value
        time.sleep(0.002)
    raise SystemExit("timed out")


def table():
    """Nothing here depends on catching a moment: an ended process stays as it is until collected."""
    sampler = module.Sampler()
    before = int(time.time())
    children = {
        "ordinary": subprocess.Popen(["/bin/sleep", "30"]),
        "ps": subprocess.Popen(["/bin/ps", "-axwwo", ",".join(["command="] * 16)], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL),
    }
    result = {"before": before, "after": None, "self": os.getuid(), "wexit": module.P_WEXIT}
    try:
        wait_until(lambda: sampler.read_path(children["ordinary"].pid).endswith("/sleep"))
        wait_until(lambda: sampler.read_path(children["ps"].pid) == "/bin/ps")
        result["after"] = int(time.time())
        for name, child in children.items():
            alive = sampler.read_table(child.pid)
            child.kill()
            ended = wait_until(lambda: (lambda record: record if record not in (None, module.NO_RECORD) and record[4] == module.ENDED else None)(sampler.read_table(child.pid)))
            row, transition, leaving = sampler.read_row(child.pid)
            result[name] = {"pid": child.pid, "alive": alive, "ended": ended, "row": row, "transition": transition, "leaving": leaving}
    finally:
        for child in children.values():
            child.kill()
            child.wait()
    return result


def exit_window():
    count = int(sys.argv[3]) if len(sys.argv) > 3 else 150
    sampler = module.Sampler()
    wide = ["/bin/ps", "-axwwo", ",".join(["command="] * 16)]
    report = {}
    for way in ("killed", "killed and collected at once", "ended by itself"):
        spans, kept, broken = [], 0, 0
        for _ in range(count):
            itself = way == "ended by itself"
            child = subprocess.Popen(["/bin/ps", "-axo", "pid="] if itself else wide, stdout=subprocess.DEVNULL if itself else subprocess.PIPE, stderr=subprocess.DEVNULL)
            alive = None
            until = time.monotonic() + 0.03
            while not itself and time.monotonic() < until:
                record = sampler.read_table(child.pid)
                if record not in (None, module.NO_RECORD):
                    alive = record
            collector = None
            if way == "killed and collected at once":
                collector = threading.Thread(target=child.wait)
                collector.start()
            if not itself:
                child.kill()
            first = last = None
            until = time.monotonic() + 3
            while time.monotonic() < until:
                _, _, leaving = sampler.read_row(child.pid)
                now = time.monotonic()
                if leaving and leaving[0] == "dying":
                    first, last = first or now, now
                    if alive:
                        if leaving[1] == alive[5]:
                            kept += 1
                        else:
                            broken += 1
                elif leaving or (first and sampler.read_info(child.pid) == errno.ESRCH and sampler.read_usage(child.pid) == errno.ESRCH):
                    break
            if first:
                spans.append((last - first) * 1000000)
            if collector:
                collector.join()
            else:
                child.kill()
                child.wait()
            if child.stdout:
                child.stdout.close()
        spans.sort()
        report[way] = {
            "runs": count, "runs in which it was seen dying": len(spans), "readings with the start time it had alive": kept, "readings with another": broken,
            "microseconds": None if not spans else {"median": round(spans[len(spans) // 2]), "p99": round(spans[min(len(spans) - 1, len(spans) * 99 // 100)]), "longest": round(spans[-1])},
        }
    report["note"] = "zero sightings would prove nothing: this probe decides no test"
    return report


checks = {"decoding": decoding, "records": records, "ended": ended, "scan": scan, "table-decoding": table_decoding, "table": table, "exit-window": exit_window}
if sys.argv[2] == "scripted":
    print(json.dumps(scripted(json.loads(sys.argv[3]))))
else:
    print(json.dumps(checks[sys.argv[2]]()))
