import Darwin
import Foundation
import CryptoKit

// Native macOS directory-FD pinned packaging + APFS copy-on-write cloning +
// Apple Silicon hardware-accelerated CryptoKit SHA-256.
//
// Security properties:
//   - Pins destination directory via open(destDir, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
//     and verifies (dev, ino), eliminating TOCTOU path-swap races without chdir or
//     ancestor statSync loops.
//   - Opens every source with O_RDONLY | O_NOFOLLOW and rejects symlinks / non-files.
//   - Uses fclonefileat(srcFd, dirfd, leafName, CLONE_NOFOLLOW) on same APFS volume
//     (atomic EEXIST non-overwrite + zero-copy instant clone), falling back seamlessly
//     to openat(dirfd, leafName, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
//     streaming copy + single-pass SHA-256 for cross-volume destinations.

enum PackageOps {
    private static let chunkBytes = 1024 * 1024 // 1 MiB
    private static let ownerOnlyFileMode: mode_t = 0o600

    static func computeSha256FromFd(fd: Int32, fileSize: Int64) throws -> String {
        var hasher = SHA256()
        var buf = [UInt8](repeating: 0, count: chunkBytes)
        var offset: Int64 = 0
        while offset < fileSize {
            let toRead = Int(min(Int64(chunkBytes), fileSize - offset))
            let r = buf.withUnsafeMutableBytes { raw -> Int in
                Darwin.pread(fd, raw.baseAddress!, toRead, off_t(offset))
            }
            if r <= 0 { throw HelperError("sha256_read_failed") }
            hasher.update(data: buf[0..<r])
            offset += Int64(r)
        }
        let digest = hasher.finalize()
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    static func sha256File(filePath: String) throws -> [String: Any] {
        let fd = Darwin.open(filePath, O_RDONLY | O_NOFOLLOW)
        if fd < 0 {
            if errno == ELOOP { throw HelperError("source_symlink") }
            throw HelperError("source_open_failed")
        }
        defer { Darwin.close(fd) }

        var before = stat()
        if fstat(fd, &before) != 0 { throw HelperError("source_stat_failed") }
        if (before.st_mode & S_IFMT) != S_IFREG { throw HelperError("source_not_file") }

        let size = Int64(before.st_size)
        let sha256 = try computeSha256FromFd(fd: fd, fileSize: size)

        var after = stat()
        if fstat(fd, &after) != 0 { throw HelperError("source_stat_failed") }
        if before.st_dev != after.st_dev
            || before.st_ino != after.st_ino
            || before.st_size != after.st_size
            || before.st_mtimespec.tv_sec != after.st_mtimespec.tv_sec
            || before.st_mtimespec.tv_nsec != after.st_mtimespec.tv_nsec {
            throw HelperError("source_changed")
        }

        return [
            "sha256": sha256,
            "size": size,
            "dev": Int64(before.st_dev),
            "ino": Int64(before.st_ino),
        ]
    }

    private static func isSafeLeafName(_ leaf: String) -> Bool {
        if leaf.isEmpty || leaf == "." || leaf == ".." { return false }
        if leaf.contains("/") || leaf.contains("\0") { return false }
        return true
    }

    private static func parseDecimalInt64(_ val: Any?) -> Int64? {
        if let s = val as? String { return Int64(s) }
        if let n = val as? NSNumber { return n.int64Value }
        return nil
    }

    private static func parseDecimalUInt64(_ val: Any?) -> UInt64? {
        if let s = val as? String { return UInt64(s) }
        if let n = val as? NSNumber, n.int64Value >= 0 { return n.uint64Value }
        return nil
    }

    private static func verifyDirFdMatchesAncestry(dirFd: Int32, ancestry: [[String: Any]]) -> Bool {
        guard !ancestry.isEmpty, ancestry.count <= 256 else { return false }
        var curFd = Darwin.dup(dirFd)
        if curFd < 0 { return false }
        defer { if curFd >= 0 { Darwin.close(curFd) } }

        for (idx, expected) in ancestry.enumerated() {
            guard let expDev = parseDecimalInt64(expected["dev"]),
                  let expIno = parseDecimalUInt64(expected["ino"]) else {
                return false
            }
            var st = stat()
            if fstat(curFd, &st) != 0 || (st.st_mode & S_IFMT) != S_IFDIR {
                return false
            }
            if Int64(st.st_dev) != expDev || UInt64(st.st_ino) != expIno {
                return false
            }
            if idx + 1 < ancestry.count {
                let parentFd = Darwin.openat(curFd, "..", O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
                if parentFd < 0 { return false }
                Darwin.close(curFd)
                curFd = parentFd
            }
        }
        return true
    }

    private static func verifyDirFdMatchesAnyAncestry(dirFd: Int32, ancestries: [[[String: Any]]]) -> Bool {
        guard !ancestries.isEmpty, ancestries.count <= 8 else { return false }
        return ancestries.contains { verifyDirFdMatchesAncestry(dirFd: dirFd, ancestry: $0) }
    }

    /// Strips all user/privacy extended attributes (including kMDItemWhereFroms,
    /// quarantine, Finder tags, etc.) and rejects extended ACLs from a newly cloned
    /// file descriptor so APFS-cloned outputs match byte-only copy privacy parity.
    /// Note: macOS Sequoia/Sonoma kernel-enforces `com.apple.provenance` even on
    /// freshly created files and silently retains it after fremovexattr returns 0.
    private static func stripCloneMetadata(fd: Int32) -> Bool {
        let kernelManagedXattrs: Set<String> = ["com.apple.provenance"]

        func listXattrNames() -> [String]? {
            for _ in 0..<4 {
                let listSize = Darwin.flistxattr(fd, nil, 0, 0)
                if listSize == 0 { return [] }
                if listSize < 0 {
                    if errno == ENOTSUP || errno == EOPNOTSUPP { return [] }
                    return nil
                }
                var buf = [CChar](repeating: 0, count: listSize)
                let actual = Darwin.flistxattr(fd, &buf, listSize, 0)
                if actual == 0 { return [] }
                if actual < 0 {
                    if errno == ERANGE { continue }
                    if errno == ENOTSUP || errno == EOPNOTSUPP { return [] }
                    return nil
                }
                var names: [String] = []
                var pos = 0
                while pos < actual {
                    var end = pos
                    while end < actual && buf[end] != 0 { end += 1 }
                    if end > pos {
                        let name = buf.withUnsafeBufferPointer { ptr in
                            String(cString: ptr.baseAddress!.advanced(by: pos))
                        }
                        names.append(name)
                    }
                    pos = end + 1
                }
                return names
            }
            return nil
        }

        // 1. Remove every non-kernel-managed extended attribute via fremovexattr
        guard let initialNames = listXattrNames() else { return false }
        for name in initialNames {
            if kernelManagedXattrs.contains(name) { continue }
            let removed = name.withCString { Darwin.fremovexattr(fd, $0, 0) }
            if removed != 0 && errno != ENOATTR {
                return false
            }
        }
        guard let remainingNames = listXattrNames() else { return false }
        if remainingNames.contains(where: { !kernelManagedXattrs.contains($0) }) {
            return false
        }

        // 2. Reject/fallback if the cloned file carries any extended ACL entries so
        //    the caller falls back to a fresh byte-only copy with zero ACLs.
        if let existingAcl = acl_get_fd_np(fd, ACL_TYPE_EXTENDED) {
            defer { acl_free(UnsafeMutableRawPointer(existingAcl)) }
            var entry: acl_entry_t? = nil
            if acl_get_entry(existingAcl, Int32(ACL_FIRST_ENTRY.rawValue), &entry) == 0 {
                return false
            }
        }

        return true
    }

    /// Descriptor-bound, ancestry-verified APFS copy-on-write clone matching
    /// Crate's package-transaction-worker security invariants (O_NOFOLLOW,
    /// full directory ancestry check, owner-only mode 0o600, source stability
    /// check, xattr/ACL stripping, atomic rollback on post-clone mismatch).
    static func cloneVerifiedFile(req: [String: Any]) throws -> [String: Any] {
        guard let sourcePath = req["sourcePath"] as? String,
              let destDir = req["destDir"] as? String,
              let leafName = req["leafName"] as? String,
              isSafeLeafName(leafName),
              let expSrcDev = parseDecimalInt64(req["expectedSourceDev"]),
              let expSrcIno = parseDecimalUInt64(req["expectedSourceIno"]),
              let expSrcSize = parseDecimalInt64(req["expectedSourceSize"]),
              expSrcSize >= 0,
              let expDestDev = parseDecimalInt64(req["expectedDestDev"]),
              let expDestIno = parseDecimalUInt64(req["expectedDestIno"]),
              let ancestries = req["ancestries"] as? [[[String: Any]]] else {
            throw HelperError("invalid_clone_request")
        }

        let targetMode: mode_t
        if let rawMode = req["mode"] as? NSNumber {
            let masked = rawMode.uint16Value & 0o777
            targetMode = masked == 0 ? ownerOnlyFileMode : mode_t(masked)
        } else {
            targetMode = ownerOnlyFileMode
        }

        let dirFd = Darwin.open(destDir, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
        if dirFd < 0 {
            throw HelperError("dest_dir_changed")
        }
        defer { Darwin.close(dirFd) }

        var dirStat = stat()
        if fstat(dirFd, &dirStat) != 0
            || (dirStat.st_mode & S_IFMT) != S_IFDIR
            || Int64(dirStat.st_dev) != expDestDev
            || UInt64(dirStat.st_ino) != expDestIno
            || !verifyDirFdMatchesAnyAncestry(dirFd: dirFd, ancestries: ancestries) {
            throw HelperError("dest_dir_changed")
        }

        let srcFd = Darwin.open(sourcePath, O_RDONLY | O_NOFOLLOW)
        if srcFd < 0 {
            if errno == ELOOP { throw HelperError("source_changed") }
            throw HelperError("source_changed")
        }
        defer { Darwin.close(srcFd) }

        var srcBefore = stat()
        if fstat(srcFd, &srcBefore) != 0
            || (srcBefore.st_mode & S_IFMT) != S_IFREG
            || Int64(srcBefore.st_dev) != expSrcDev
            || UInt64(srcBefore.st_ino) != expSrcIno
            || Int64(srcBefore.st_size) != expSrcSize {
            throw HelperError("source_changed")
        }

        if srcBefore.st_dev != dirStat.st_dev {
            return ["cloned": false, "fallback": true, "reason": "cross_device"]
        }

        // Fall back to byte-copy if source has BSD file flags (e.g., Finder Locked UF_IMMUTABLE),
        // because fclonefileat clones the flag and makes fchmod/unlinkat fail with EPERM.
        if srcBefore.st_flags != 0 {
            return ["cloned": false, "fallback": true, "reason": "source_has_flags"]
        }

        let rc = leafName.withCString { cLeaf in
            fclonefileat(srcFd, dirFd, cLeaf, UInt32(CLONE_NOFOLLOW))
        }
        if rc != 0 {
            let err = errno
            if err == EEXIST { throw HelperError("dest_already_exists") }
            if err == EXDEV || err == ENOTSUP || err == EOPNOTSUPP || err == EINVAL {
                return ["cloned": false, "fallback": true, "reason": "clone_unsupported"]
            }
            throw HelperError("clone_failed")
        }

        var ownedOutDev: dev_t = 0
        var ownedOutIno: UInt64 = 0
        var hasOwnedIdentity = false

        func verifyLeafMatchesOwnedIdentity() -> Bool {
            guard hasOwnedIdentity else { return false }
            var leafStat = stat()
            let stRc = leafName.withCString { cLeaf in
                Darwin.fstatat(dirFd, cLeaf, &leafStat, AT_SYMLINK_NOFOLLOW)
            }
            return stRc == 0
                && (leafStat.st_mode & S_IFMT) == S_IFREG
                && leafStat.st_nlink == 1
                && leafStat.st_uid == geteuid()
                && leafStat.st_dev == ownedOutDev
                && UInt64(leafStat.st_ino) == ownedOutIno
        }

        func rollbackClone() {
            // Only unlink if the directory leaf still refers to our exact owned
            // regular file identity (single-link, same dev/ino, owned by euid).
            guard verifyLeafMatchesOwnedIdentity() else { return }
            _ = leafName.withCString { Darwin.unlinkat(dirFd, $0, 0) }
        }

        func rollbackUnverifiedCloneIfOwned() {
            // Only unlink if the leaf is still a single-link regular file owned by euid
            // on dirStat.st_dev and distinct from the source file (never unlinks symlinks
            // or attacker-swapped hardlinks/foreign files).
            var leafStat = stat()
            let stRc = leafName.withCString { cLeaf in
                Darwin.fstatat(dirFd, cLeaf, &leafStat, AT_SYMLINK_NOFOLLOW)
            }
            guard stRc == 0
                && (leafStat.st_mode & S_IFMT) == S_IFREG
                && leafStat.st_nlink == 1
                && leafStat.st_uid == geteuid()
                && leafStat.st_dev == dirStat.st_dev
                && !(leafStat.st_dev == srcBefore.st_dev && leafStat.st_ino == srcBefore.st_ino) else {
                return
            }
            _ = leafName.withCString { Darwin.unlinkat(dirFd, $0, 0) }
        }

        let outFd = leafName.withCString { cLeaf in
            Darwin.openat(dirFd, cLeaf, O_RDONLY | O_NOFOLLOW)
        }
        if outFd < 0 {
            rollbackUnverifiedCloneIfOwned()
            throw HelperError("dest_verify_failed")
        }
        defer { Darwin.close(outFd) }

        // Establish exclusive file ownership and single-link identity BEFORE any
        // mode change, xattr stripping, or potential rollback unlink.
        var preHardenStat = stat()
        if fstat(outFd, &preHardenStat) != 0
            || (preHardenStat.st_mode & S_IFMT) != S_IFREG
            || preHardenStat.st_nlink != 1
            || preHardenStat.st_uid != geteuid()
            || preHardenStat.st_dev != dirStat.st_dev
            || Int64(preHardenStat.st_size) != expSrcSize
            || (preHardenStat.st_dev == srcBefore.st_dev && preHardenStat.st_ino == srcBefore.st_ino) {
            rollbackUnverifiedCloneIfOwned()
            throw HelperError("dest_verify_failed")
        }
        ownedOutDev = preHardenStat.st_dev
        ownedOutIno = UInt64(preHardenStat.st_ino)
        hasOwnedIdentity = true
        if !verifyLeafMatchesOwnedIdentity() {
            throw HelperError("dest_verify_failed")
        }

        if fchmod(outFd, targetMode) != 0 {
            rollbackClone()
            throw HelperError("fchmod_failed")
        }

        if !stripCloneMetadata(fd: outFd) {
            rollbackClone()
            return ["cloned": false, "fallback": true, "reason": "metadata_strip_failed"]
        }

        if Darwin.fsync(outFd) != 0 {
            rollbackClone()
            throw HelperError("dest_verify_failed")
        }

        var outStat = stat()
        if fstat(outFd, &outStat) != 0
            || (outStat.st_mode & S_IFMT) != S_IFREG
            || outStat.st_nlink != 1
            || outStat.st_uid != geteuid()
            || outStat.st_dev != ownedOutDev
            || UInt64(outStat.st_ino) != ownedOutIno
            || (outStat.st_mode & 0o777) != targetMode
            || Int64(outStat.st_size) != expSrcSize
            || !verifyLeafMatchesOwnedIdentity() {
            rollbackClone()
            throw HelperError("dest_verify_failed")
        }

        var srcAfter = stat()
        if fstat(srcFd, &srcAfter) != 0
            || srcBefore.st_dev != srcAfter.st_dev
            || srcBefore.st_ino != srcAfter.st_ino
            || srcBefore.st_size != srcAfter.st_size
            || srcBefore.st_mtimespec.tv_sec != srcAfter.st_mtimespec.tv_sec
            || srcBefore.st_mtimespec.tv_nsec != srcAfter.st_mtimespec.tv_nsec {
            rollbackClone()
            throw HelperError("source_changed")
        }

        if !verifyDirFdMatchesAnyAncestry(dirFd: dirFd, ancestries: ancestries) {
            rollbackClone()
            throw HelperError("dest_dir_changed")
        }

        return [
            "cloned": true,
            "bytesWritten": String(expSrcSize),
            "outputIdentity": [
                "dev": String(outStat.st_dev),
                "ino": String(outStat.st_ino),
            ],
        ]
    }
}
