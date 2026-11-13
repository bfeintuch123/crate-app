#!/usr/bin/python3
"""Process sampler and signaller for scripts/run-tests.js. macOS only, standard
library only.

The memory guard needs three facts about every process, read from outside the
test processes and often: which process started it, when it started, and how
much memory it holds. libproc gives them directly:

  proc_listallpids                        every pid
  proc_pidinfo(PROC_PIDT_SHORTBSDINFO)    parent, process group, owner, state
  proc_pid_rusage(RUSAGE_INFO_V2)         ri_proc_start_abstime, ri_resident_size
                                          and ri_phys_footprint, which counts
                                          compressed memory

It also sends the guard's signals, because a pid alone does not say which
process will receive one: the system reuses pids. Each signal names the pid and
the start time of the process it is meant for; the start time is read again
here and compared, and the signal is sent in the very next system call. That
leaves a gap of microseconds between the check and the signal. No program
without special privileges can close it on macOS, so this narrows the chance of
signalling the wrong process as far as it goes; it does not remove it.

Protocol, one request per line on stdin, one answer on stdout.

  scan <id>
      begin <id> <rows>
      <pid> <ppid> <pgid> <uid> <status> <start> <resident> <footprint> <info-errno> <usage-errno>
      end <id>
    Every listed pid gets a row. <start> is in Mach absolute time units,
    <resident> and <footprint> are bytes. A non-zero <info-errno> means parent,
    group, owner and state could not be read (they are 0); a non-zero
    <usage-errno> means start time and memory could not be read (they are 0).
    Nothing is left out or guessed.

  signal <id> <NAME> <pid>:<start> [<pid>:<start> ...]
      signalled <id> <result> [<result> ...]

  group <id> <NAME> <pgid> <pid>:<start>
      signalled <id> <result>
    Signals process group <pgid> if <pid>, with that start time, is in it now.

  <NAME> is STOP, CONT, KILL, TERM, INT or HUP. A <result> is
    sent        the start time matched and the signal was sent
    mismatch    the pid belongs to another process now (or left the group)
    gone        no such process
    unreadable  the start time could not be read, so nothing was sent
    denied      the system refused the signal

The sampler exits when stdin closes, so it cannot outlive the guard, and it
ignores the signals a terminal sends to the guard's process group so that it is
still there for the guard's cleanup.
"""

import ctypes
import errno
import os
import signal
import sys

PROC_PIDT_SHORTBSDINFO = 13
RUSAGE_INFO_V2 = 2
MAXCOMLEN = 16
SIGNALS = {
    "STOP": signal.SIGSTOP,
    "CONT": signal.SIGCONT,
    "KILL": signal.SIGKILL,
    "TERM": signal.SIGTERM,
    "INT": signal.SIGINT,
    "HUP": signal.SIGHUP,
}


class ShortBsdInfo(ctypes.Structure):
    # struct proc_bsdshortinfo, <sys/proc_info.h>
    _fields_ = [
        ("pbsi_pid", ctypes.c_uint32),
        ("pbsi_ppid", ctypes.c_uint32),
        ("pbsi_pgid", ctypes.c_uint32),
        ("pbsi_status", ctypes.c_uint32),
        ("pbsi_comm", ctypes.c_char * MAXCOMLEN),
        ("pbsi_flags", ctypes.c_uint32),
        ("pbsi_uid", ctypes.c_uint32),
        ("pbsi_gid", ctypes.c_uint32),
        ("pbsi_ruid", ctypes.c_uint32),
        ("pbsi_rgid", ctypes.c_uint32),
        ("pbsi_svuid", ctypes.c_uint32),
        ("pbsi_svgid", ctypes.c_uint32),
        ("pbsi_rfu", ctypes.c_uint32),
    ]


class RusageInfoV2(ctypes.Structure):
    # struct rusage_info_v2, <sys/resource.h>
    _fields_ = [
        ("ri_uuid", ctypes.c_uint8 * 16),
        ("ri_user_time", ctypes.c_uint64),
        ("ri_system_time", ctypes.c_uint64),
        ("ri_pkg_idle_wkups", ctypes.c_uint64),
        ("ri_interrupt_wkups", ctypes.c_uint64),
        ("ri_pageins", ctypes.c_uint64),
        ("ri_wired_size", ctypes.c_uint64),
        ("ri_resident_size", ctypes.c_uint64),
        ("ri_phys_footprint", ctypes.c_uint64),
        ("ri_proc_start_abstime", ctypes.c_uint64),
        ("ri_proc_exit_abstime", ctypes.c_uint64),
        ("ri_child_user_time", ctypes.c_uint64),
        ("ri_child_system_time", ctypes.c_uint64),
        ("ri_child_pkg_idle_wkups", ctypes.c_uint64),
        ("ri_child_interrupt_wkups", ctypes.c_uint64),
        ("ri_child_pageins", ctypes.c_uint64),
        ("ri_child_elapsed_abstime", ctypes.c_uint64),
        ("ri_diskio_bytesread", ctypes.c_uint64),
        ("ri_diskio_byteswritten", ctypes.c_uint64),
    ]


class Sampler:
    def __init__(self):
        self.libproc = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
        self.libproc.proc_listallpids.argtypes = [ctypes.c_void_p, ctypes.c_int]
        self.libproc.proc_listallpids.restype = ctypes.c_int
        self.libproc.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
        self.libproc.proc_pidinfo.restype = ctypes.c_int
        self.libproc.proc_pid_rusage.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p]
        self.libproc.proc_pid_rusage.restype = ctypes.c_int
        self.pids = (ctypes.c_int * 4096)()
        self.info = ShortBsdInfo()
        self.usage = RusageInfoV2()

    def read_info(self, pid):
        """0, or the errno that kept parent, group, owner and state from being read."""
        size = ctypes.sizeof(self.info)
        ctypes.set_errno(0)
        if self.libproc.proc_pidinfo(pid, PROC_PIDT_SHORTBSDINFO, 0, ctypes.byref(self.info), size) == size:
            return 0
        return ctypes.get_errno() or errno.EIO

    def read_usage(self, pid):
        """0, or the errno that kept start time and memory from being read."""
        ctypes.set_errno(0)
        if self.libproc.proc_pid_rusage(pid, RUSAGE_INFO_V2, ctypes.byref(self.usage)) == 0:
            return 0
        return ctypes.get_errno() or errno.EIO

    def scan(self):
        # The pid list can grow between sizing and reading it, so leave headroom.
        while True:
            count = self.libproc.proc_listallpids(self.pids, ctypes.sizeof(self.pids))
            if count <= 0:
                raise OSError(ctypes.get_errno(), "proc_listallpids failed")
            if count < len(self.pids):
                break
            self.pids = (ctypes.c_int * (len(self.pids) * 2))()
        info = self.info
        usage = self.usage
        rows = []
        for index in range(count):
            pid = self.pids[index]
            if pid <= 0:
                continue
            info_errno = self.read_info(pid)
            usage_errno = self.read_usage(pid)
            rows.append("%d %d %d %d %d %d %d %d %d %d" % (
                pid,
                0 if info_errno else info.pbsi_ppid,
                0 if info_errno else info.pbsi_pgid,
                0 if info_errno else info.pbsi_uid,
                0 if info_errno else info.pbsi_status,
                0 if usage_errno else usage.ri_proc_start_abstime,
                0 if usage_errno else usage.ri_resident_size,
                0 if usage_errno else usage.ri_phys_footprint,
                info_errno,
                usage_errno,
            ))
        return rows

    def check(self, pid, start):
        """None when <pid> is the process that started at <start>, else why not."""
        usage_errno = self.read_usage(pid)
        if usage_errno == errno.ESRCH:
            return "gone"
        if usage_errno:
            return "unreadable"
        if str(self.usage.ri_proc_start_abstime) != start:
            return "mismatch"
        return None

    def signal_process(self, pid, start, signum):
        problem = self.check(pid, start)
        if problem:
            return problem
        # Nothing between the check above and this call.
        try:
            os.kill(pid, signum)
        except ProcessLookupError:
            return "gone"
        except PermissionError:
            return "denied"
        return "sent"

    def signal_group(self, pgid, pid, start, signum):
        info_errno = self.read_info(pid)
        if info_errno == errno.ESRCH:
            return "gone"
        if info_errno:
            return "unreadable"
        if self.info.pbsi_pgid != pgid:
            return "mismatch"
        problem = self.check(pid, start)
        if problem:
            return problem
        # Nothing between the check above and this call.
        try:
            os.killpg(pgid, signum)
        except ProcessLookupError:
            return "gone"
        except PermissionError:
            return "denied"
        return "sent"


def parse_target(text):
    pid, separator, start = text.partition(":")
    if not separator or not pid.isdigit() or not start.isdigit() or int(pid) <= 1:
        raise ValueError(text)
    return int(pid), start


def answer(sampler, words):
    if len(words) == 2 and words[0] == "scan" and words[1].isdigit():
        rows = sampler.scan()
        return "begin %s %d\n%s%send %s\n" % (words[1], len(rows), "\n".join(rows), "\n" if rows else "", words[1])
    if len(words) >= 4 and words[0] == "signal" and words[1].isdigit() and words[2] in SIGNALS:
        targets = [parse_target(word) for word in words[3:]]
        results = [sampler.signal_process(pid, start, SIGNALS[words[2]]) for pid, start in targets]
        return "signalled %s %s\n" % (words[1], " ".join(results))
    if len(words) == 5 and words[0] == "group" and words[1].isdigit() and words[2] in SIGNALS and words[3].isdigit():
        pid, start = parse_target(words[4])
        if int(words[3]) <= 1:
            raise ValueError(words[3])
        return "signalled %s %s\n" % (words[1], sampler.signal_group(int(words[3]), pid, start, SIGNALS[words[2]]))
    raise ValueError(" ".join(words))


def main():
    if sys.platform != "darwin":
        sys.stderr.write("run-tests-sampler: macOS only\n")
        return 2
    for name in ("SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"):
        signal.signal(getattr(signal, name), signal.SIG_IGN)
    sampler = Sampler()
    for line in sys.stdin:
        try:
            reply = answer(sampler, line.split())
        except ValueError:
            # A request that cannot be understood is never acted on.
            sys.stderr.write("run-tests-sampler: unknown request\n")
            return 2
        sys.stdout.write(reply)
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
