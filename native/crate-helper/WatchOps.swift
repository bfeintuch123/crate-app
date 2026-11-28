import Darwin
import Foundation

// Native macOS watching primitives replacing repeated /bin/ps, /usr/sbin/lsof,
// and /usr/bin/xattr subprocess spawns:
//   - libproc proc_listallpids / proc_pidpath          -> live running apps in < 0.5 ms (no RunLoop cache!)
//   - libproc PROC_PIDLISTFDS + PROC_PIDREGIONPATHINFO -> open & memory-mapped regular files in < 1 ms
//   - Darwin getxattr(XATTR_NOFOLLOW)                  -> batch com.apple.lastuseddate#PS in < 0.2 ms

enum WatchOps {
    private static let lastUsedXattrName = "com.apple.lastuseddate#PS"
    private static let maxJavascriptDateSeconds: Int64 = 8_640_000_000_000
    private static let maxVmRegionsPerPid = 16_384

    // Only EBADF (descriptor closed between PROC_PIDLISTFDS and lookup) and ENOENT
    // (vnode unlinked/revoked) are benign per-fd absences; any other errno (e.g.
    // EPERM, ENOMEM, ESRCH, EINVAL) leaves the PID's open-file inventory uncertain.
    static func isBenignVnodeLookupErrno(_ err: Int32) -> Bool {
        return err == EBADF || err == ENOENT
    }

    // On macOS XNU, PROC_PIDREGIONPATHINFO returns 0 with errno == EINVAL when the
    // scan reaches the end of the process address space. Any other errno indicates
    // an incomplete/failed VM region scan rather than confirmed exhaustion.
    static func isNormalVmRegionEndErrno(_ err: Int32) -> Bool {
        return err == EINVAL
    }

    // Only ESRCH (process exited or zombie between proc_listallpids and proc_pidpath)
    // is a benign per-PID absence; any other errno leaves process discovery uncertain
    // so callers fall back to /bin/ps.
    static func isBenignPidPathErrno(_ err: Int32) -> Bool {
        return err == ESRCH
    }

    static func runningApps(keywords: [String], caseSensitive: Bool = false) throws -> [[String: Any]] {
        let exactKeywords = keywords.filter { !$0.isEmpty }
        let lowerKeywords = exactKeywords.map { $0.lowercased() }
        errno = 0
        let estimated = proc_listallpids(nil, 0)
        guard estimated > 0 else { throw HelperError("proc_listallpids_failed") }

        let pidStride = MemoryLayout<pid_t>.stride
        var allocCount = max(Int(estimated) + 128, 256)
        var pids: [pid_t] = []
        var pidCount = 0
        var listComplete = false
        for _ in 0..<4 {
            let (byteCount, byteOverflow) = allocCount.multipliedReportingOverflow(by: pidStride)
            guard !byteOverflow, byteCount > 0, byteCount <= Int(Int32.max) else {
                throw HelperError("proc_listallpids_failed")
            }
            pids = [pid_t](repeating: 0, count: allocCount)
            // proc_listallpids takes buffer size in bytes and returns the NUMBER of PIDs filled (not bytes).
            errno = 0
            let actualCount = proc_listallpids(&pids, Int32(byteCount))
            guard actualCount > 0 else { throw HelperError("proc_listallpids_failed") }
            if Int(actualCount) >= pids.count {
                let (nextCount, countOverflow) = allocCount.multipliedReportingOverflow(by: 2)
                if countOverflow { throw HelperError("proc_listallpids_failed") }
                allocCount = nextCount
                continue
            }
            pidCount = Int(actualCount)
            listComplete = true
            break
        }
        guard listComplete else { throw HelperError("proc_listallpids_failed") }

        let pathBufSize = Int(MAXPATHLEN) * 4 // PROC_PIDPATHINFO_MAXSIZE
        var pathBuf = [CChar](repeating: 0, count: pathBufSize)
        var out: [[String: Any]] = []

        for idx in 0..<pidCount {
            let pid = pids[idx]
            guard pid > 0 else { continue }
            errno = 0
            let pathLen = proc_pidpath(pid, &pathBuf, UInt32(pathBufSize))
            if pathLen <= 0 {
                let err = errno
                if isBenignPidPathErrno(err) { continue }
                throw HelperError("proc_pidpath_failed")
            }
            let command = String(cString: pathBuf)
            if command.isEmpty { continue }
            let name = (command as NSString).lastPathComponent
            if !exactKeywords.isEmpty {
                let matched: Bool
                if caseSensitive {
                    matched = exactKeywords.contains { command.contains($0) }
                } else {
                    let hay = command.lowercased()
                    matched = lowerKeywords.contains { hay.contains($0) }
                }
                if !matched { continue }
            }
            out.append([
                "pid": Int(pid),
                "name": name,
                "bundleId": "",
                "command": command,
            ])
        }
        return out
    }

    static func openFiles(pids: [Int32], extensions: Set<String>) -> [String: Any] {
        var results: [[String: Any]] = []
        var failedPids: [Int] = []
        let fdInfoSize = MemoryLayout<proc_fdinfo>.stride
        let vnodeInfoSize = Int32(MemoryLayout<vnode_fdinfowithpath>.size)
        let regionInfoSize = Int32(MemoryLayout<proc_regionwithpathinfo>.size)

        func recordIfMatching(pid: Int32, filePath: String, seenForPid: inout Set<String>) {
            guard !filePath.isEmpty, filePath.hasPrefix("/") else { return }
            if !extensions.isEmpty {
                let ext = "." + ((filePath as NSString).pathExtension).lowercased()
                if !extensions.contains(ext) { return }
            }
            if seenForPid.insert(filePath).inserted {
                results.append([
                    "pid": Int(pid),
                    "path": filePath,
                ])
            }
        }

        for pid in pids {
            var seenForPid = Set<String>()

            // 1. Open file descriptors (PROC_PIDLISTFDS) with explicit completeness & truncation retry.
            let initialBufSize = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, nil, 0)
            if initialBufSize <= 0 {
                failedPids.append(Int(pid))
                continue
            }

            var allocCount = max(1, (Int(initialBufSize) / fdInfoSize) + 32)
            var fdReadOk = false
            var fds: [proc_fdinfo] = []
            var actualCount = 0

            for _ in 0..<3 {
                let allocBytes = Int32(allocCount * fdInfoSize)
                fds = [proc_fdinfo](repeating: proc_fdinfo(), count: allocCount)
                let actual = fds.withUnsafeMutableBytes { raw -> Int32 in
                    proc_pidinfo(pid, PROC_PIDLISTFDS, 0, raw.baseAddress, allocBytes)
                }
                if actual <= 0 {
                    fdReadOk = false
                    break
                }
                if actual >= allocBytes {
                    allocCount *= 2
                    continue
                }
                actualCount = Int(actual) / fdInfoSize
                fdReadOk = true
                break
            }

            if !fdReadOk {
                failedPids.append(Int(pid))
                continue
            }

            var pidFailed = false
            for idx in 0..<actualCount {
                let fdInfo = fds[idx]
                if fdInfo.proc_fdtype != PROX_FDTYPE_VNODE { continue }
                var vnodeInfo = vnode_fdinfowithpath()
                errno = 0
                let ret = proc_pidfdinfo(pid, fdInfo.proc_fd, PROC_PIDFDVNODEPATHINFO, &vnodeInfo, vnodeInfoSize)
                if ret <= 0 {
                    let err = errno
                    if isBenignVnodeLookupErrno(err) { continue }
                    pidFailed = true
                    break
                }
                if ret < vnodeInfoSize {
                    pidFailed = true
                    break
                }
                // Regular files only (VREG == 1)
                if vnodeInfo.pvip.vip_vi.vi_type != 1 { continue }

                let filePath = withUnsafePointer(to: &vnodeInfo.pvip.vip_path) { ptr -> String in
                    ptr.withMemoryRebound(to: CChar.self, capacity: Int(MAXPATHLEN)) { cStr in
                        String(cString: cStr)
                    }
                }
                recordIfMatching(pid: pid, filePath: filePath, seenForPid: &seenForPid)
            }
            if pidFailed {
                failedPids.append(Int(pid))
                continue
            }

            // 2. Memory-mapped regular files (PROC_PIDREGIONPATHINFO) — matches lsof TXT/mapped vnodes
            var address: UInt64 = 0
            var vmScanExhausted = false
            for _ in 0..<maxVmRegionsPerPid {
                var regionInfo = proc_regionwithpathinfo()
                errno = 0
                let ret = proc_pidinfo(pid, PROC_PIDREGIONPATHINFO, address, &regionInfo, regionInfoSize)
                if ret <= 0 {
                    let err = errno
                    vmScanExhausted = isNormalVmRegionEndErrno(err)
                    break
                }
                if ret < regionInfoSize {
                    vmScanExhausted = false
                    break
                }
                if regionInfo.prp_vip.vip_vi.vi_type == 1 {
                    let filePath = withUnsafePointer(to: &regionInfo.prp_vip.vip_path) { ptr -> String in
                        ptr.withMemoryRebound(to: CChar.self, capacity: Int(MAXPATHLEN)) { cStr in
                            String(cString: cStr)
                        }
                    }
                    recordIfMatching(pid: pid, filePath: filePath, seenForPid: &seenForPid)
                }
                let regionStart = regionInfo.prp_prinfo.pri_address
                let regionSize = regionInfo.prp_prinfo.pri_size
                if regionSize == 0 {
                    vmScanExhausted = false
                    break
                }
                let (nextAddress, overflow) = regionStart.addingReportingOverflow(regionSize)
                if overflow {
                    vmScanExhausted = true
                    break
                }
                if nextAddress <= address {
                    vmScanExhausted = false
                    break
                }
                address = nextAddress
            }
            if !vmScanExhausted {
                failedPids.append(Int(pid))
            }
        }
        return [
            "files": results,
            "complete": failedPids.isEmpty,
            "failedPids": failedPids,
        ]
    }

    static func readLastUsedXattrs(paths: [String]) -> [String: Any] {
        var out: [String: Any] = [:]
        var errors: [String: String] = [:]
        var raw = [UInt8](repeating: 0, count: 16)
        for filePath in paths {
            errno = 0
            let len = filePath.withCString { cPath in
                lastUsedXattrName.withCString { cAttr in
                    Darwin.getxattr(cPath, cAttr, &raw, raw.count, 0, XATTR_NOFOLLOW)
                }
            }
            if len == 16 {
                // com.apple.lastuseddate#PS stores a native 16-byte little-endian timespec:
                // signed 64-bit Unix seconds followed by signed 64-bit nanoseconds.
                let secRaw: Int64 = raw.withUnsafeBytes { $0.loadUnaligned(fromByteOffset: 0, as: Int64.self) }
                let nsecRaw: Int64 = raw.withUnsafeBytes { $0.loadUnaligned(fromByteOffset: 8, as: Int64.self) }
                let seconds = Int64(littleEndian: secRaw)
                let nanoseconds = Int64(littleEndian: nsecRaw)
                if seconds > 0
                    && seconds <= maxJavascriptDateSeconds
                    && !(seconds == maxJavascriptDateSeconds && nanoseconds > 0)
                    && nanoseconds >= 0
                    && nanoseconds < 1_000_000_000 {
                    let unixMs = Double(seconds) * 1000.0 + Double(nanoseconds) / 1_000_000.0
                    if unixMs.isFinite && unixMs <= 8_640_000_000_000_000.0 {
                        out[filePath] = unixMs
                        continue
                    }
                }
                errors[filePath] = "invalid_timespec"
                out[filePath] = NSNull()
                continue
            }
            if len < 0 {
                let err = errno
                if err == ENOATTR {
                    out[filePath] = NSNull()
                } else {
                    errors[filePath] = "errno_\(err)"
                    out[filePath] = NSNull()
                }
                continue
            }
            errors[filePath] = "invalid_length_\(len)"
            out[filePath] = NSNull()
        }
        return [
            "timestamps": out,
            "errors": errors,
        ]
    }
}
