import AppKit
import Darwin
import Foundation

// Native macOS watching primitives replacing repeated /bin/ps, /usr/sbin/lsof,
// and /usr/bin/xattr subprocess spawns:
//   - NSWorkspace.shared.runningApplications -> running design apps in < 0.2 ms
//   - libproc proc_pidinfo / proc_pidfdinfo  -> open regular files in < 1 ms
//   - Darwin getxattr(XATTR_NOFOLLOW)        -> batch com.apple.lastuseddate#PS in < 0.2 ms

enum WatchOps {
    private static let lastUsedXattrName = "com.apple.lastuseddate#PS"
    private static let maxJavascriptDateSeconds: Int64 = 8_640_000_000_000

    static func runningApps(keywords: [String]) -> [[String: Any]] {
        let lowerKeywords = keywords.map { $0.lowercased() }.filter { !$0.isEmpty }
        var out: [[String: Any]] = []
        for app in NSWorkspace.shared.runningApplications {
            let pid = Int(app.processIdentifier)
            guard pid > 0 else { continue }
            let name = app.localizedName ?? ""
            let bundleId = app.bundleIdentifier ?? ""
            let execPath = app.executableURL?.path ?? ""
            let command = execPath.isEmpty ? name : execPath
            if !lowerKeywords.isEmpty {
                let hay = "\(command) \(name) \(bundleId)".lowercased()
                let matched = lowerKeywords.contains { hay.contains($0) }
                if !matched { continue }
            }
            out.append([
                "pid": pid,
                "name": name,
                "bundleId": bundleId,
                "command": command,
            ])
        }
        return out
    }

    static func openFiles(pids: [Int32], extensions: Set<String>) -> [[String: Any]] {
        var results: [[String: Any]] = []
        let fdInfoSize = MemoryLayout<proc_fdinfo>.stride
        let vnodeInfoSize = Int32(MemoryLayout<vnode_fdinfowithpath>.size)

        for pid in pids {
            let bufSize = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, nil, 0)
            if bufSize <= 0 { continue }
            let count = Int(bufSize) / fdInfoSize
            var fds = [proc_fdinfo](repeating: proc_fdinfo(), count: count)
            let actual = fds.withUnsafeMutableBytes { raw -> Int32 in
                proc_pidinfo(pid, PROC_PIDLISTFDS, 0, raw.baseAddress, bufSize)
            }
            if actual <= 0 { continue }
            let actualCount = Int(actual) / fdInfoSize
            var seenForPid = Set<String>()

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
                if filePath.isEmpty || !filePath.hasPrefix("/") { continue }
                if !extensions.isEmpty {
                    let ext = (filePath as NSString).pathExtension.lowercased()
                    if ext.isEmpty || !extensions.contains(".\(ext)") { continue }
                }
                if seenForPid.insert(filePath).inserted {
                    results.append([
                        "pid": Int(pid),
                        "path": filePath,
                    ])
                }
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
