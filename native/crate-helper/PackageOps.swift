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

    static func packageBatch(
        destDir: String,
        items: [[String: Any]],
        mode: String,
        computeHash: Bool
    ) throws -> [String: Any] {
        let dirFd = Darwin.open(destDir, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
        if dirFd < 0 {
            if errno == ELOOP || errno == ENOTDIR { throw HelperError("dest_dir_unsafe") }
            throw HelperError("dest_dir_open_failed")
        }
        defer { Darwin.close(dirFd) }

        var dirStat = stat()
        if fstat(dirFd, &dirStat) != 0 || (dirStat.st_mode & S_IFMT) != S_IFDIR {
            throw HelperError("dest_dir_unsafe")
        }

        var results: [[String: Any]] = []
        var createdLeaves: [String] = []
        var buf = [UInt8](repeating: 0, count: chunkBytes)

        func rollbackCreated() {
            for leaf in createdLeaves {
                _ = leaf.withCString { Darwin.unlinkat(dirFd, $0, 0) }
            }
        }

        do {
            for item in items {
                guard let sourcePath = item["sourcePath"] as? String,
                      let leafName = item["leafName"] as? String,
                      isSafeLeafName(leafName) else {
                    throw HelperError("invalid_package_item")
                }

                let srcFd = Darwin.open(sourcePath, O_RDONLY | O_NOFOLLOW)
                if srcFd < 0 {
                    if errno == ELOOP { throw HelperError("source_symlink") }
                    throw HelperError("source_open_failed")
                }
                defer { Darwin.close(srcFd) }

                var srcBefore = stat()
                if fstat(srcFd, &srcBefore) != 0 || (srcBefore.st_mode & S_IFMT) != S_IFREG {
                    throw HelperError("source_not_file")
                }
                let srcSize = Int64(srcBefore.st_size)

                // Verify optional expected source identity
                if let expected = item["expectedStat"] as? [String: Any] {
                    if let expDev = expected["dev"] as? NSNumber, expDev.int64Value != Int64(srcBefore.st_dev) {
                        throw HelperError("source_changed")
                    }
                    if let expIno = expected["ino"] as? NSNumber, expIno.int64Value != Int64(srcBefore.st_ino) {
                        throw HelperError("source_changed")
                    }
                    if let expSize = expected["size"] as? NSNumber, expSize.int64Value != srcSize {
                        throw HelperError("source_changed")
                    }
                }

                let sameDevice = (srcBefore.st_dev == dirStat.st_dev)
                let tryClone = sameDevice && (mode == "clone" || mode == "clone_or_copy")
                var cloned = false
                var sha256Hex: String? = nil
                var outDev: Int64 = 0
                var outIno: Int64 = 0

                if tryClone {
                    let rc = leafName.withCString { cLeaf in
                        fclonefileat(srcFd, dirFd, cLeaf, UInt32(CLONE_NOFOLLOW))
                    }
                    if rc == 0 {
                        cloned = true
                        createdLeaves.append(leafName)
                        // Harden mode and verify cloned file identity via openat(O_NOFOLLOW)
                        let outFd = leafName.withCString { cLeaf in
                            Darwin.openat(dirFd, cLeaf, O_RDONLY | O_NOFOLLOW)
                        }
                        if outFd < 0 { throw HelperError("dest_verify_failed") }
                        defer { Darwin.close(outFd) }
                        _ = fchmod(outFd, ownerOnlyFileMode)
                        var outStat = stat()
                        if fstat(outFd, &outStat) != 0 || (outStat.st_mode & S_IFMT) != S_IFREG {
                            throw HelperError("dest_verify_failed")
                        }
                        outDev = Int64(outStat.st_dev)
                        outIno = Int64(outStat.st_ino)
                        if computeHash {
                            sha256Hex = try computeSha256FromFd(fd: outFd, fileSize: Int64(outStat.st_size))
                        }
                    } else if errno == EEXIST {
                        throw HelperError("dest_already_exists")
                    }
                    // For EXDEV / ENOTSUP / EINVAL, fall through to openat streaming copy!
                }

                if !cloned {
                    let outFd = leafName.withCString { cLeaf in
                        Darwin.openat(
                            dirFd,
                            cLeaf,
                            O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW,
                            ownerOnlyFileMode
                        )
                    }
                    if outFd < 0 {
                        if errno == EEXIST { throw HelperError("dest_already_exists") }
                        throw HelperError("dest_create_failed")
                    }
                    createdLeaves.append(leafName)
                    defer { Darwin.close(outFd) }
                    _ = fchmod(outFd, ownerOnlyFileMode)

                    var hasher = SHA256()
                    var offset: Int64 = 0
                    while offset < srcSize {
                        let toRead = Int(min(Int64(chunkBytes), srcSize - offset))
                        let r = buf.withUnsafeMutableBytes { raw -> Int in
                            Darwin.pread(srcFd, raw.baseAddress!, toRead, off_t(offset))
                        }
                        if r <= 0 { throw HelperError("source_read_failed") }
                        if computeHash {
                            hasher.update(data: buf[0..<r])
                        }
                        var written = 0
                        while written < r {
                            let w = buf.withUnsafeBytes { raw -> Int in
                                Darwin.write(outFd, raw.baseAddress!.advanced(by: written), r - written)
                            }
                            if w <= 0 { throw HelperError("dest_write_failed") }
                            written += w
                        }
                        offset += Int64(r)
                    }

                    var outStat = stat()
                    if fstat(outFd, &outStat) != 0 || Int64(outStat.st_size) != srcSize {
                        throw HelperError("dest_verify_failed")
                    }
                    outDev = Int64(outStat.st_dev)
                    outIno = Int64(outStat.st_ino)
                    if computeHash {
                        sha256Hex = hasher.finalize().map { String(format: "%02x", $0) }.joined()
                    }
                }

                // Re-check source did not mutate during copy/clone
                var srcAfter = stat()
                if fstat(srcFd, &srcAfter) != 0
                    || srcBefore.st_dev != srcAfter.st_dev
                    || srcBefore.st_ino != srcAfter.st_ino
                    || srcBefore.st_size != srcAfter.st_size
                    || srcBefore.st_mtimespec.tv_sec != srcAfter.st_mtimespec.tv_sec
                    || srcBefore.st_mtimespec.tv_nsec != srcAfter.st_mtimespec.tv_nsec {
                    throw HelperError("source_changed")
                }

                var entry: [String: Any] = [
                    "leafName": leafName,
                    "bytes": srcSize,
                    "cloned": cloned,
                    "dev": outDev,
                    "ino": outIno,
                ]
                if let sha = sha256Hex {
                    entry["sha256"] = sha
                }
                results.append(entry)
            }
        } catch {
            rollbackCreated()
            throw error
        }

        return [
            "destDev": Int64(dirStat.st_dev),
            "destIno": Int64(dirStat.st_ino),
            "files": results,
        ]
    }
}
