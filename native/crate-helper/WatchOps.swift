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

    static func runningApps(keywords: [String]) -> [[String: Any]] {
        let lowerKeywords = keywords.map { $0.lowercased() }.filter { !$0.isEmpty }
        let estimated = proc_listallpids(nil, 0)
        guard estimated > 0 else { return [] }

        var pids = [pid_t](repeating: 0, count: Int(estimated) + 128)
        let bufferBytes = Int32(pids.count * MemoryLayout<pid_t>.stride)
        // proc_listallpids takes buffer size in bytes and returns the NUMBER of PIDs filled (not bytes).
        let actualCount = proc_listallpids(&pids, bufferBytes)
        guard actualCount > 0 else { return [] }
        let pidCount = min(Int(actualCount), pids.count)

        let pathBufSize = Int(MAXPATHLEN) * 4 // PROC_PIDPATHINFO_MAXSIZE
        var pathBuf = [CChar](repeating: 0, count: pathBufSize)
        var out: [[String: Any]] = []

        for idx in 0..<pidCount {
            let pid = pids[idx]
            guard pid > 0 else { continue }
            let pathLen = proc_pidpath(pid, &pathBuf, UInt32(pathBufSize))
            if pathLen <= 0 { continue }
            let command = String(cString: pathBuf)
            if command.isEmpty { continue }
            let name = (command as NSString).lastPathComponent
            if !lowerKeywords.isEmpty {
                let hay = command.lowercased()
                let matched = lowerKeywords.contains { hay.contains($0) }
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

    static func openFiles(pids: [Int32], extensions: Set<String>) -> [[String: Any]] {
        var results: [[String: Any]] = []
        let fdInfoSize = MemoryLayout<proc_fdinfo>.stride
        let vnodeInfoSize = Int32(MemoryLayout<vnode_fdinfowithpath>.size)
        let regionInfoSize = Int32(MemoryLayout<proc_regionwithpathinfo>.size)

        func recordIfMatching(pid: Int32, filePath: String, seenForPid: inout Set<String>) {
            if filePath.isEmpty || !filePath.hasPrefix("/") { return }
            if !extensions.isEmpty {
                let ext = (filePath as NSString).pathExtension.lowercased()
                if ext.isEmpty || !extensions.contains(".\(ext)") { return }
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

            // 1. Open file descriptors (PROC_PIDLISTFDS)
            let bufSize = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, nil, 0)
            if bufSize > 0 {
                let count = Int(bufSize) / fdInfoSize
                var fds = [proc_fdinfo](repeating: proc_fdinfo(), count: count)
                let actual = fds.withUnsafeMutableBytes { raw -> Int32 in
                    proc_pidinfo(pid, PROC_PIDLISTFDS, 0, raw.baseAddress, bufSize)
                }
                if actual > 0 {
                    let actualCount = Int(actual) / fdInfoSize
                    for idx in 0..<actualCount {
                        let fdInfo = fds[idx]
                        if fdInfo.proc_fdtype != PROX_FDTYPE_VNODE { continue }
                        var vnodeInfo = vnode_fdinfowithpath()
                        let ret = proc_pidfdinfo(pid, fdInfo.proc_fd, PROC_PIDFDVNODEPATHINFO, &vnodeInfo, vnodeInfoSize)
                        if ret <= 0 { continue }
                        // Regular files only (VREG == 1)
                        if vnodeInfo.pvip.vip_vi.vi_type != 1 { continue }

                        let filePath = withUnsafePointer(to: &vnodeInfo.pvip.vip_path) { ptr -> String in
                            ptr.withMemoryRebound(to: CChar.self, capacity: Int(MAXPATHLEN)) { cStr in
                                String(cString: cStr)
                            }
                        }
                        recordIfMatching(pid: pid, filePath: filePath, seenForPid: &seenForPid)
                    }
                }
            }

            // 2. Memory-mapped regular files (PROC_PIDREGIONPATHINFO) — matches lsof TXT/mapped vnodes
            var address: UInt64 = 0
            for _ in 0..<maxVmRegionsPerPid {
                var regionInfo = proc_regionwithpathinfo()
                let ret = proc_pidinfo(pid, PROC_PIDREGIONPATHINFO, address, &regionInfo, regionInfoSize)
                if ret <= 0 { break }
                if regionInfo.prp_vip.vip_vi.vi_type == 1 {
                    let filePath = withUnsafePointer(to: &regionInfo.prp_vip.vip_path) { ptr -> String in
                        ptr.withMemoryRebound(to: CChar.self, capacity: Int(MAXPATHLEN)) { cStr in
                            String(cString: cStr)
                        }
                    }
                    recordIfMatching(pid: pid, filePath: filePath, seenForPid: &seenForPid)
                }
                let nextAddress = regionInfo.prp_prinfo.pri_address &+ regionInfo.prp_prinfo.pri_size
                if nextAddress <= address { break }
                address = nextAddress
            }
        }
        return results
    }

    static func readLastUsedXattrs(paths: [String]) -> [String: Any] {
        var out: [String: Any] = [:]
        var raw = [UInt8](repeating: 0, count: 16)
        for filePath in paths {
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
            }
            out[filePath] = NSNull()
        }
        return out
    }
}
