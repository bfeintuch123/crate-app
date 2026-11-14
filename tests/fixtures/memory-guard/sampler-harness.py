"""Helper for tests/run-tests-memory-guard.test.js, not a test. Runs the code of
scripts/run-tests-sampler.py with some of its reads answered from a script, or
against real processes it starts itself, and prints what it saw as JSON. The
test decides what that should have been.

  python3 -I -B sampler-harness.py <sampler file> <check> [<json>]

  scripted <json>   every read is answered from a script; see scripted()
  decoding          process records as sysctl could hand them back
  records           process records against libproc, for every live process
  ended             a real set-uid ps, ended and not collected, and collected
  scan              two scans with a real ps that is new, then already seen

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
    [start, resident, footprint]], ["path", text] or ["record", null or
    [ppid, pgid, uid, ruid, status]]. A read the script did not expect next is
    an error, and so is a step that is never asked for.
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
            usage.ri_proc_start_abstime = usage.ri_resident_size = usage.ri_phys_footprint = STALE
            return answer[1] if answer else errno.EIO
        usage.ri_proc_start_abstime, usage.ri_resident_size, usage.ri_phys_footprint = answer[2]
        return 0

    def read_path(pid):
        answer = step(pid, "path")
        return answer[1] if answer else "-"

    def read_record(pid):
        answer = step(pid, "record")
        return tuple(answer[1]) if answer and answer[1] else None

    sampler.read_info, sampler.read_usage, sampler.read_path, sampler.read_record = read_info, read_usage, read_path, read_record
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
    row, transition = sampler.read_row(pid)
    return {"info": info_errno, "usage": usage_errno, "megabytes": megabytes, "record": sampler.read_record(pid), "row": row, "transition": transition}


def ended():
    sampler = module.Sampler()
    # Nothing collects it until wait() below.
    ps = subprocess.Popen(["/bin/ps", "-axo", "pid="], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    result = {"self": {"pid": os.getpid(), "group": os.getpgrp(), "uid": os.getuid()}, "ps": {"pid": ps.pid}}
    time.sleep(0.6)
    result["ps"]["ended"] = observe(sampler, ps.pid)
    ps.wait()
    result["ps"]["collected"] = observe(sampler, ps.pid)
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


checks = {"decoding": decoding, "records": records, "ended": ended, "scan": scan}
if sys.argv[2] == "scripted":
    print(json.dumps(scripted(json.loads(sys.argv[3]))))
else:
    print(json.dumps(checks[sys.argv[2]]()))
