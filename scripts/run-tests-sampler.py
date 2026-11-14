#!/usr/bin/python3
"""Process sampler and signaller for scripts/run-tests.js. macOS only, standard
library only.

The memory guard needs three facts about every process, read from outside the
test processes and often: which process started it, when it started, and how
much memory it holds. libproc gives them directly:

  proc_listallpids                        every pid
  proc_pidinfo(PROC_PIDT_SHORTBSDINFO)    parent, process group, owners, state
  proc_pid_rusage(RUSAGE_INFO_V2)         ri_proc_start_abstime, ri_resident_size
                                          and ri_phys_footprint, which counts
                                          compressed memory
  proc_pidpath                            the path of the executable, read only
                                          for a process this user started that
                                          now runs as another user (a set-uid
                                          tool such as /bin/ps), which is the
                                          one kind of process whose usage this
                                          user may not read

libproc does not describe a process that has ended and waits for its parent to
collect it: proc_pidinfo says there is no such process, which is also what it
says of a pid that is free, or that passed to a new process a moment ago. The
usage read still answers for an ordinary ended process (with the resident size
it had at the end and a footprint of zero) and is denied for a set-uid one. In
those two cases the sampler asks the system's process table

  sysctl kern.proc.pid.<pid>              state, parent, group and owners

and reports the process as ended only when the table says so in so many words
(state 5, awaiting collection by its parent). A record that shows the pid as
anything else changes nothing in the row.

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
      <pid> <ppid> <pgid> <uid> <status> <start> <resident> <footprint> <info-errno> <usage-errno> <ruid> <path>
      end <id>
    Every listed pid gets a row. <uid> is the effective and <ruid> the real
    owner. <status> 5 means the process has ended and waits to be collected.
    <start> is in Mach absolute time units, <resident> and <footprint> are
    bytes. A non-zero <info-errno> means parent, group, owners and state could
    not be read (they are 0); a non-zero <usage-errno> means start time and
    memory could not be read (they are 0). <path> is the percent-encoded path
    of the executable where it was read and could be read, and "-" everywhere
    else. Nothing is left out or guessed, and what the sampler does with these
    facts is nothing: the guard decides.

    A row is one reading, made of separate reads in a fixed order: parent,
    group, owners and state; then usage; then, in the cases above, the process
    table, which is the last word on that pid in the row; then the path, never
    for a process that has ended. The reads are not atomic. Each is true of
    whatever held the pid at its own instant, so the start time and sizes in
    the row of an ended process are older than the word "ended".

    A process that is just becoming a set-uid tool, or just ending as one,
    changes between those reads for a fraction of a millisecond, and a reading
    taken then can describe a state the process was never in. So a process
    this user started and may not read is read again, unless the previous scan
    read it exactly the same way: after 1 ms, and again after 1 ms and 2 ms
    more for as long as two readings in a row differ and it is still such a
    process. All such processes of one scan share those waits. The row is
    always the last reading, complete and fresh, whether or not it agreed with
    the one before; nothing in it comes from an earlier reading or scan.

    This means the guard does not get to see a state that lasted less than
    those waits, even one it would have stopped the run for. The exception is
    a child of the guard itself, which is where the test runner is: it is
    never read again, so the guard sees its first reading. The waits are a
    request to the system, not a bound: under load a scan takes longer.

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
import struct
import sys
import time
import urllib.parse

PROC_PIDT_SHORTBSDINFO = 13
RUSAGE_INFO_V2 = 2
MAXCOMLEN = 16
PROC_PIDPATHINFO_MAXSIZE = 4096
RUNNING = 2  # SRUN
ENDED = 5  # SZOMB: awaiting collection by parent
# sysctl kern.proc.pid.<pid> fills one struct kinfo_proc, <sys/sysctl.h>. These
# are its size on 64-bit macOS and where the fields used here lie in it. The
# sampler checks them before it answers anything; see check_records.
SYSCTL_PROCESS = (1, 14, 1)  # CTL_KERN, KERN_PROC, KERN_PROC_PID
KINFO_PROC_SIZE = 648
KINFO_STATUS = 36  # kp_proc.p_stat, one byte
KINFO_PID = 40  # kp_proc.p_pid
KINFO_REAL_UID = 392  # kp_eproc.e_pcred.p_ruid
KINFO_UID = 420  # kp_eproc.e_ucred.cr_uid
KINFO_PPID = 560  # kp_eproc.e_ppid
KINFO_PGID = 564  # kp_eproc.e_pgid
# How long to wait before reading a process in transition again, in seconds.
SETTLE_PAUSES = (0.001, 0.001, 0.002)
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
        self.libproc.proc_pidpath.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
        self.libproc.proc_pidpath.restype = ctypes.c_int
        self.libc = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
        self.libc.sysctl.argtypes = [
            ctypes.POINTER(ctypes.c_int), ctypes.c_uint, ctypes.c_void_p, ctypes.POINTER(ctypes.c_size_t), ctypes.c_void_p, ctypes.c_size_t,
        ]
        self.libc.sysctl.restype = ctypes.c_int
        self.uid = os.getuid()
        # The guard, whose child this sampler is. Its other child is the test runner.
        self.guard = os.getppid()
        self.pids = (ctypes.c_int * 4096)()
        self.info = ShortBsdInfo()
        self.usage = RusageInfoV2()
        self.pause = time.sleep
        # pid -> row, for each process of the last scan that this user started
        # and may not read. Only ever compared with a new reading.
        self.denied = {}

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

    def read_path(self, pid):
        """The percent-encoded executable path of <pid>, or "-" when it cannot be read.

        The buffer is new for every call and only the bytes the call reports
        are used, so nothing of an earlier process can show up here.
        """
        buffer = ctypes.create_string_buffer(PROC_PIDPATHINFO_MAXSIZE)
        length = self.libproc.proc_pidpath(pid, buffer, PROC_PIDPATHINFO_MAXSIZE)
        if length <= 0 or length >= PROC_PIDPATHINFO_MAXSIZE:
            return "-"
        return urllib.parse.quote(buffer.raw[:length], safe="/") or "-"

    def read_record(self, pid):
        """(ppid, pgid, uid, ruid, status) of <pid> from the system's process table, or None.

        None unless the call succeeds, fills exactly one record, and the record
        is that of <pid>. The buffer is new for every call, so a call that
        fails or comes back short cannot leave an earlier record to be read.
        """
        name = (ctypes.c_int * 4)(*SYSCTL_PROCESS, pid)
        record = ctypes.create_string_buffer(KINFO_PROC_SIZE)
        size = ctypes.c_size_t(KINFO_PROC_SIZE)
        if self.libc.sysctl(name, 4, record, ctypes.byref(size), None, 0) != 0 or size.value != KINFO_PROC_SIZE:
            return None
        raw = record.raw
        if struct.unpack_from("i", raw, KINFO_PID)[0] != pid:
            return None
        return (
            struct.unpack_from("i", raw, KINFO_PPID)[0],
            struct.unpack_from("i", raw, KINFO_PGID)[0],
            struct.unpack_from("I", raw, KINFO_UID)[0],
            struct.unpack_from("I", raw, KINFO_REAL_UID)[0],
            raw[KINFO_STATUS],
        )

    def check_records(self):
        """True when read_record reads two processes whose facts are known.

        Nothing at run time says how struct kinfo_proc is laid out, so its size
        and the offsets above are checked on this process (pid, parent, group,
        both owners, state) and on the first process of the system, whose
        parent is 0, whose group is 1 and whose owners are root. That catches
        another size and a shifted layout. It cannot tell the two owners
        apart, which are the same in both; the tests do that on a set-uid ps.
        """
        own = (os.getppid(), os.getpgrp(), os.geteuid(), os.getuid(), RUNNING)
        return self.read_record(os.getpid()) == own and self.read_record(1) == (0, 1, 0, 0, RUNNING)

    def read_row(self, pid):
        """One reading of <pid>: its row, and whether it may be in transition.

        In transition can only be a process this user started and may not
        read, other than a child of the guard.
        """
        info_errno = self.read_info(pid)
        # Each value is taken from the structures only when this pid's own
        # read succeeded; otherwise it is 0, never what an earlier pid left.
        ppid = pgid = effective_uid = real_uid = status = 0
        if not info_errno:
            info = self.info
            ppid, pgid, effective_uid, real_uid, status = info.pbsi_ppid, info.pbsi_pgid, info.pbsi_uid, info.pbsi_ruid, info.pbsi_status
        usage_errno = self.read_usage(pid)
        start = resident = footprint = 0
        if not usage_errno:
            usage = self.usage
            start, resident, footprint = usage.ri_proc_start_abstime, usage.ri_resident_size, usage.ri_phys_footprint
        # Not there for libproc, while usage answers or is denied: ended, or
        # something else. The process table is asked last, so that "ended" is
        # the latest thing this row knows about the pid, and it is believed
        # only when it says ended.
        if info_errno == errno.ESRCH and usage_errno in (0, errno.EPERM):
            record = self.read_record(pid)
            if record and record[4] == ENDED:
                info_errno = 0
                ppid, pgid, effective_uid, real_uid, status = record
        denied = usage_errno == errno.EPERM and not info_errno and status != ENDED and real_uid == self.uid
        path = self.read_path(pid) if denied and effective_uid != self.uid else "-"
        row = "%d %d %d %d %d %d %d %d %d %d %d %s" % (
            pid, ppid, pgid, effective_uid, status, start, resident, footprint, info_errno, usage_errno, real_uid, path)
        return row, denied and ppid != self.guard

    def settle(self, readings):
        """Reads again what may have been read in the middle of a change.

        <readings> is a list of [pid, row, in transition]. Each one that may be
        in transition, and that the last scan did not report in exactly the
        same way, is read again after a pause, until two readings in a row
        agree, it can no longer be in transition, or the pauses run out. The
        list ends up holding the last reading of every pid.
        """
        pending = [reading for reading in readings if reading[2] and self.denied.get(reading[0]) != reading[1]]
        for seconds in SETTLE_PAUSES:
            if not pending:
                break
            self.pause(seconds)
            changed = []
            for reading in pending:
                row, transition = self.read_row(reading[0])
                if transition and row != reading[1]:
                    changed.append(reading)
                reading[1], reading[2] = row, transition
            pending = changed
        self.denied = {pid: row for pid, row, transition in readings if transition}

    def list_pids(self):
        # The pid list can grow between sizing and reading it, so leave headroom.
        while True:
            count = self.libproc.proc_listallpids(self.pids, ctypes.sizeof(self.pids))
            if count <= 0:
                raise OSError(ctypes.get_errno(), "proc_listallpids failed")
            if count < len(self.pids):
                break
            self.pids = (ctypes.c_int * (len(self.pids) * 2))()
        return [pid for pid in self.pids[:count] if pid > 0]

    def scan(self):
        readings = [[pid, *self.read_row(pid)] for pid in self.list_pids()]
        self.settle(readings)
        return [row for _, row, _ in readings]

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
    if not sampler.check_records():
        sys.stderr.write("run-tests-sampler: the system's process records are not laid out as this sampler expects\n")
        return 2
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
