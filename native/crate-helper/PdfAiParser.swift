import Darwin
import Foundation
import zlib

// Fast native PDF / Adobe Illustrator (.ai) / InDesign (.indd) linked-asset extractor.
// Combines:
//   1. Streaming raw-byte path scan (matching Crate's exact linked-asset grammar)
//   2. XMP metadata packet extraction (<stRef:filePath>, LinkResourceURI="...")
//   3. Selective FlateDecode PDF stream decompression (skipping /Subtype /Image
//      pixel streams), recovering compressed Illustrator links even when
//      Illustrator is closed!

enum PdfAiParser {
    private static let maxFileBytes: Int64 = 256 * 1024 * 1024
    private static let maxSingleStreamOut = 8 * 1024 * 1024
    private static let maxTotalInflatedOut = 64 * 1024 * 1024
    private static let maxStreamsToInflate = 512
    private static let maxReferenceCount = 10_000
    private static let maxReferenceBytes = 16 * 1024 * 1024

    // Exact base Quick Package AI supported extensions (matches parsers/ai.js).
    // Excludes web-font (.woff2/.woff), installable-font, and video extensions.
    private static let allowedExtensions: Set<String> = [
        "jpg", "jpeg", "png", "gif", "webp", "svg", "pdf", "eps", "ai", "psd", "psb",
        "tiff", "tif", "afdesign", "afphoto", "afpub", "indd", "idml", "sketch", "fig",
    ]
    private static let maxPathLength = 4096

    static func parse(
        filePath: String,
        includeDigest: Bool,
        decompressStreams: Bool,
        maxFileBytes: Int64? = nil
    ) throws -> [String: Any] {
        let fd = Darwin.open(filePath, O_RDONLY | O_NOFOLLOW)
        if fd < 0 {
            if errno == ELOOP { throw HelperError("pdf_ai_symlink") }
            throw HelperError("pdf_ai_open_failed")
        }
        defer { Darwin.close(fd) }

        var st = stat()
        if fstat(fd, &st) != 0 { throw HelperError("pdf_ai_stat_failed") }
        if (st.st_mode & S_IFMT) != S_IFREG { throw HelperError("pdf_ai_not_file") }
        let fileSize = Int64(st.st_size)
        let effectiveMaxFileBytes = maxFileBytes.map { min($0, Self.maxFileBytes) } ?? Self.maxFileBytes
        if fileSize > effectiveMaxFileBytes { throw HelperError("pdf_ai_too_large") }

        var data = Data(count: Int(fileSize))
        if fileSize > 0 {
            var total = 0
            let target = Int(fileSize)
            try data.withUnsafeMutableBytes { raw in
                while total < target {
                    let r = Darwin.pread(fd, raw.baseAddress!.advanced(by: total), target - total, off_t(total))
                    if r <= 0 { throw HelperError("pdf_ai_read_failed") }
                    total += r
                }
            }
        }

        var foundOrder: [String] = []
        var foundSet = Set<String>()
        var chargedReferenceCount = 0
        var chargedReferenceBytes = 0
        var compressedStreamsScanned = 0
        var compressedHits = 0
        var issues: [String] = []

        func recordPath(_ raw: String, chargeRepeats: Bool, fromCompressed: Bool = false) throws {
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty, trimmed != filePath else { return }
            let byteCount = trimmed.utf8.count
            guard byteCount <= maxPathLength else { return }
            let isNew = !foundSet.contains(trimmed)
            if chargeRepeats || isNew {
                chargedReferenceCount += 1
                chargedReferenceBytes += byteCount
                if chargedReferenceCount > maxReferenceCount || chargedReferenceBytes > maxReferenceBytes {
                    throw HelperError("pdf_ai_reference_limit")
                }
            }
            if isNew {
                foundSet.insert(trimmed)
                foundOrder.append(trimmed)
                if fromCompressed { compressedHits += 1 }
            }
        }

        // 1. Direct raw byte scan for /Users/ and /Volumes/ asset paths + XMP tags
        try data.withUnsafeBytes { buf in
            let bytes = buf.bindMemory(to: UInt8.self)
            try scanRawPaths(bytes: bytes, onMatch: { try recordPath($0, chargeRepeats: true) })
            try scanXmpAndUris(bytes: bytes, onMatch: { try recordPath($0, chargeRepeats: false) })

            // 2. Selective FlateDecode PDF stream decompression (non-image streams)
            if decompressStreams {
                try scanFlateDecodeStreams(bytes: bytes, streamsScanned: &compressedStreamsScanned, issues: &issues) { inflated in
                    try inflated.withUnsafeBytes { ibuf in
                        let ib = ibuf.bindMemory(to: UInt8.self)
                        try scanRawPaths(bytes: ib, onMatch: { try recordPath($0, chargeRepeats: false, fromCompressed: true) })
                        try scanXmpAndUris(bytes: ib, onMatch: { try recordPath($0, chargeRepeats: false, fromCompressed: true) })
                    }
                }
            }
        }

        var result: [String: Any] = [
            "paths": foundOrder,
            "compressedStreamsScanned": compressedStreamsScanned,
            "compressedHits": compressedHits,
            "incomplete": !issues.isEmpty,
            "issues": issues,
            "sourceIdentity": [
                "dev": Int64(st.st_dev),
                "ino": Int64(st.st_ino),
                "size": fileSize,
                "mtimeNs": Int64(st.st_mtimespec.tv_sec) * 1_000_000_000 + Int64(st.st_mtimespec.tv_nsec),
                "ctimeNs": Int64(st.st_ctimespec.tv_sec) * 1_000_000_000 + Int64(st.st_ctimespec.tv_nsec),
            ],
        ]
        if includeDigest {
            result["sourceDigest"] = try PackageOps.computeSha256FromFd(fd: fd, fileSize: fileSize)
        }
        return result
    }

    @inline(__always)
    private static func isDelimiter(_ b: UInt8) -> Bool {
        // Exact base 00c5e92 delimiter set: \x00-\x1f, '"', '\'', \x7f, '<', '>', '|', '*', '?'
        return b < 0x20 || b == 0x22 || b == 0x27 || b == 0x7F
            || b == 0x3C || b == 0x3E || b == 0x7C || b == 0x2A || b == 0x3F
    }

    @inline(__always)
    private static func isAsciiAlnum(_ b: UInt8) -> Bool {
        return (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5A) || (b >= 0x61 && b <= 0x7A)
    }

    @inline(__always)
    private static func isSegmentBoundarySeparator(_ b: UInt8) -> Bool {
        // Exclude ')' and ']' so folder paths like `/Users/me/Archive (old)/Users/jo/a.png`
        // stay intact; adjacent PDF strings `(/Users/a.png)(/Users/b.png)` still split on '('.
        return b == 0x20 || b == 0x09 || b == 0x2C || b == 0x3B
            || b == 0x28 || b == 0x5B
    }

    @inline(__always)
    private static func matchUsersOrVolumesPrefix(_ bytes: UnsafeBufferPointer<UInt8>, _ idx: Int, _ limit: Int) -> Int {
        guard bytes[idx] == 0x2F else { return 0 }
        if idx + 7 <= limit
            && (bytes[idx + 1] == 0x55 || bytes[idx + 1] == 0x75)
            && (bytes[idx + 2] == 0x73 || bytes[idx + 2] == 0x53)
            && (bytes[idx + 3] == 0x65 || bytes[idx + 3] == 0x45)
            && (bytes[idx + 4] == 0x72 || bytes[idx + 4] == 0x52)
            && (bytes[idx + 5] == 0x73 || bytes[idx + 5] == 0x53)
            && bytes[idx + 6] == 0x2F {
            return 7
        }
        if idx + 9 <= limit
            && (bytes[idx + 1] == 0x56 || bytes[idx + 1] == 0x76)
            && (bytes[idx + 2] == 0x6F || bytes[idx + 2] == 0x4F)
            && (bytes[idx + 3] == 0x6C || bytes[idx + 3] == 0x4C)
            && (bytes[idx + 4] == 0x75 || bytes[idx + 4] == 0x55)
            && (bytes[idx + 5] == 0x6D || bytes[idx + 5] == 0x4D)
            && (bytes[idx + 6] == 0x65 || bytes[idx + 6] == 0x45)
            && (bytes[idx + 7] == 0x73 || bytes[idx + 7] == 0x53)
            && bytes[idx + 8] == 0x2F {
            return 9
        }
        return 0
    }

    // Strictly O(N) byte scanner matching parsers/ai.js's scanQuickAiRawPaths identically:
    // maximal delimiter-free runs -> streaming /Users/ & /Volumes/ segments (preserving nested
    // /Volumes/<disk>/Users/...) -> backwards scan for LAST whole supported extension.
    private static func scanRawPaths(bytes: UnsafeBufferPointer<UInt8>, onMatch: (String) throws -> Void) throws {
        let n = bytes.count
        guard n >= 10 else { return }

        func processSegment(segStart: Int, prefixLen: Int, segEnd: Int) throws {
            let cappedEnd = min(segEnd, segStart + maxPathLength)
            if cappedEnd <= segStart + prefixLen { return }

            var pos = cappedEnd - 1
            while pos >= segStart + prefixLen {
                if bytes[pos] == 0x2E { // '.'
                    let extStart = pos + 1
                    var extEnd = extStart
                    while extEnd < segEnd && extEnd - extStart <= 9 && isAsciiAlnum(bytes[extEnd]) {
                        extEnd += 1
                    }
                    if extEnd > extStart && extEnd <= cappedEnd && extEnd - extStart <= 8 {
                        if extEnd < segEnd && isAsciiAlnum(bytes[extEnd]) {
                            pos -= 1
                            continue
                        }
                        var extStr = ""
                        extStr.reserveCapacity(extEnd - extStart)
                        for k in extStart..<extEnd {
                            let c = bytes[k]
                            let lc = (c >= 0x41 && c <= 0x5A) ? (c + 32) : c
                            extStr.append(Character(UnicodeScalar(lc)))
                        }
                        if allowedExtensions.contains(extStr) {
                            let slice = UnsafeBufferPointer(rebasing: bytes[segStart..<extEnd])
                            // Decode lossily with U+FFFD to match Node Buffer.toString('utf8')
                            // so non-UTF-8 bytes (e.g. MacRoman) are never silently dropped.
                            try onMatch(String(decoding: slice, as: UTF8.self))
                            break
                        }
                    }
                }
                pos -= 1
            }
        }

        var i = 0
        while i < n {
            while i < n && isDelimiter(bytes[i]) { i += 1 }
            let runStart = i
            while i < n && !isDelimiter(bytes[i]) { i += 1 }
            let runEnd = i
            if runEnd - runStart < 10 { continue }

            var hasCurrent = false
            var curStart = 0
            var curPrefixLen = 0
            var p = runStart
            while p < runEnd - 7 {
                let prefixLen = matchUsersOrVolumesPrefix(bytes, p, runEnd)
                if prefixLen > 0 {
                    let precededBySep = p > runStart && isSegmentBoundarySeparator(bytes[p - 1])
                    if !hasCurrent {
                        hasCurrent = true
                        curStart = p
                        curPrefixLen = prefixLen
                        p += prefixLen
                        continue
                    } else if precededBySep {
                        try processSegment(segStart: curStart, prefixLen: curPrefixLen, segEnd: p)
                        curStart = p
                        curPrefixLen = prefixLen
                        p += prefixLen
                        continue
                    }
                }
                p += 1
            }

            if hasCurrent {
                try processSegment(segStart: curStart, prefixLen: curPrefixLen, segEnd: runEnd)
            }
        }
    }

    // Extract XMP <stRef:filePath>...</stRef:filePath> and LinkResourceURI="..." values.
    private static func scanXmpAndUris(bytes: UnsafeBufferPointer<UInt8>, onMatch: (String) throws -> Void) rethrows {
        let markers: [[UInt8]] = [
            Array("stRef:filePath>".utf8),
            Array("stRef:filePath=\"".utf8),
            Array("LinkResourceURI=\"".utf8),
        ]
        let n = bytes.count
        for (idx, marker) in markers.enumerated() {
            let mLen = marker.count
            guard n > mLen + 4 else { continue }
            var i = 0
            while i <= n - mLen {
                if bytes[i] == marker[0] {
                    var eq = true
                    for j in 1..<mLen {
                        if bytes[i + j] != marker[j] { eq = false; break }
                    }
                    if eq {
                        let start = i + mLen
                        let stopByte: UInt8 = (idx == 0) ? 0x3C : 0x22 // '<' or '"'
                        var end = start
                        let limit = min(n, start + maxPathLength + 1)
                        while end < limit && bytes[end] != stopByte { end += 1 }
                        if end > start && end < limit {
                            let slice = UnsafeBufferPointer(rebasing: bytes[start..<end])
                            var val = String(decoding: slice, as: UTF8.self)
                            val = decodeXmlEntities(val)
                            if let local = normalizeLocalPathOrFileUri(val) {
                                try onMatch(local)
                            }
                        }
                        i = end + 1
                        continue
                    }
                }
                i += 1
            }
        }
    }

    private static func decodeXmlEntities(_ s: String) -> String {
        if !s.contains("&") { return s }
        var out = ""
        out.reserveCapacity(s.count)
        let chars = Array(s)
        var i = 0
        while i < chars.count {
            if chars[i] == "&" {
                var semi = i + 1
                let limit = min(chars.count, i + 12)
                while semi < limit && chars[semi] != ";" { semi += 1 }
                if semi < limit && chars[semi] == ";" {
                    let entity = String(chars[(i + 1)..<semi])
                    var replacement: String? = nil
                    switch entity.lowercased() {
                    case "amp": replacement = "&"
                    case "quot": replacement = "\""
                    case "apos": replacement = "'"
                    case "lt": replacement = "<"
                    case "gt": replacement = ">"
                    default:
                        if entity.hasPrefix("#") {
                            let body = entity.dropFirst(1)
                            let scalarVal: UInt32?
                            if body.hasPrefix("x") || body.hasPrefix("X") {
                                scalarVal = UInt32(body.dropFirst(1), radix: 16)
                            } else {
                                scalarVal = UInt32(body, radix: 10)
                            }
                            if let v = scalarVal, v > 0, v <= 0x10FFFF, !(v >= 0xD800 && v <= 0xDFFF),
                               let scalar = UnicodeScalar(v) {
                                replacement = String(scalar)
                            }
                        }
                    }
                    if let r = replacement {
                        out.append(r)
                        i = semi + 1
                        continue
                    }
                }
            }
            out.append(chars[i])
            i += 1
        }
        return out
    }

    private static func isSupportedPathExtension(_ path: String) -> Bool {
        guard path.utf8.count <= maxPathLength else { return false }
        guard let dot = path.lastIndex(of: ".") else { return false }
        if let slash = path.lastIndex(of: "/"), dot <= slash { return false }
        let ext = String(path[path.index(after: dot)...]).lowercased()
        return allowedExtensions.contains(ext)
    }

    private static func normalizeLocalPathOrFileUri(_ raw: String) -> String? {
        var path = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        while path.hasSuffix("\0") { path.removeLast() }
        if path.isEmpty || path.unicodeScalars.contains(where: { $0.value < 0x20 }) { return nil }
        if path.lowercased().hasPrefix("file:") {
            var rest = String(path.dropFirst(5))
            var hasEmptyAuthority = false
            if rest.hasPrefix("//") {
                let afterAuthorityStart = rest.index(rest.startIndex, offsetBy: 2)
                guard let slashIdx = rest[afterAuthorityStart...].firstIndex(of: "/") else { return nil }
                let host = String(rest[afterAuthorityStart..<slashIdx])
                if !host.isEmpty && host.lowercased() != "localhost" { return nil }
                hasEmptyAuthority = host.isEmpty
                rest = String(rest[slashIdx...])
            }
            guard rest.hasPrefix("/") else { return nil }
            if hasEmptyAuthority && rest.hasPrefix("//") && !rest.hasPrefix("///") {
                rest = String(rest.dropFirst(1))
            }
            let decoded = rest.removingPercentEncoding ?? rest
            if decoded.count <= 1 || !decoded.hasPrefix("/") || decoded.hasPrefix("//") ||
                decoded.unicodeScalars.contains(where: { $0.value < 0x20 }) {
                return nil
            }
            path = decoded
        }
        guard (path.hasPrefix("/Users/") || path.hasPrefix("/Volumes/")),
              isSupportedPathExtension(path) else {
            return nil
        }
        return path
    }

    // Locate `FlateDecode` streams (skipping `/Subtype /Image`), inflate with strict
    // memory caps via native zlib, and invoke `onInflated`.
    private static func scanFlateDecodeStreams(
        bytes: UnsafeBufferPointer<UInt8>,
        streamsScanned: inout Int,
        issues: inout [String],
        onInflated: (Data) throws -> Void
    ) rethrows {
        let streamToken = Array("stream".utf8)
        let endstreamToken = Array("endstream".utf8)
        let flateToken = Array("FlateDecode".utf8)
        let imageToken = Array("/Image".utf8)
        let n = bytes.count
        var streamAttempts = 0
        var totalInflated = 0
        var noEndstreamBefore = 0
        var i = 0

        func recordIssue(_ code: String) {
            if !issues.contains(code) { issues.append(code) }
        }

        func containsSubsequence(_ range: Range<Int>, _ needle: [UInt8]) -> Bool {
            let nl = needle.count
            if range.count < nl { return false }
            var p = range.lowerBound
            let stop = range.upperBound - nl
            while p <= stop {
                if bytes[p] == needle[0] {
                    var ok = true
                    for k in 1..<nl {
                        if bytes[p + k] != needle[k] { ok = false; break }
                    }
                    if ok { return true }
                }
                p += 1
            }
            return false
        }

        while i < n - 16 {
            // Match "stream" followed by \n or \r\n (and NOT preceded by "end")
            if bytes[i] == streamToken[0] && i + 7 < n {
                var ok = true
                for k in 1..<streamToken.count {
                    if bytes[i + k] != streamToken[k] { ok = false; break }
                }
                if ok {
                    let isEndstream = i >= 3 && bytes[i - 3] == 0x65 && bytes[i - 2] == 0x6E && bytes[i - 1] == 0x64
                    var dataStart = i + 6
                    var validLineBreak = false
                    if !isEndstream {
                        if bytes[dataStart] == 0x0A {
                            dataStart += 1; validLineBreak = true
                        } else if bytes[dataStart] == 0x0D && dataStart + 1 < n && bytes[dataStart + 1] == 0x0A {
                            dataStart += 2; validLineBreak = true
                        }
                    }
                    if validLineBreak {
                        // Inspect preceding PDF dictionary window (up to 512 bytes back)
                        let dictStart = max(0, i - 512)
                        let isFlate = containsSubsequence(dictStart..<i, flateToken)
                        let isImage = containsSubsequence(dictStart..<i, imageToken)
                        // Locate matching endstream without rescanning ranges already proven to contain none.
                        var endPos = max(dataStart, noEndstreamBefore)
                        let searchLimit = min(n - endstreamToken.count, dataStart + 16 * 1024 * 1024)
                        var foundEnd = -1
                        while endPos <= searchLimit {
                            if bytes[endPos] == endstreamToken[0] {
                                var m = true
                                for k in 1..<endstreamToken.count {
                                    if bytes[endPos + k] != endstreamToken[k] { m = false; break }
                                }
                                if m { foundEnd = endPos; break }
                            }
                            endPos += 1
                        }
                        if foundEnd < 0 {
                            noEndstreamBefore = max(noEndstreamBefore, searchLimit + 1)
                        }
                        if foundEnd > dataStart {
                            if isFlate && !isImage {
                                if streamAttempts >= maxStreamsToInflate {
                                    recordIssue("flate-stream-count-limit")
                                    break
                                }
                                if totalInflated >= maxTotalInflatedOut {
                                    recordIssue("flate-total-output-limit")
                                    break
                                }
                                var compEnd = foundEnd
                                while compEnd > dataStart && (bytes[compEnd - 1] == 0x0A || bytes[compEnd - 1] == 0x0D) {
                                    compEnd -= 1
                                }
                                let compLen = compEnd - dataStart
                                if compLen > 2 {
                                    streamAttempts += 1
                                    let budget = min(maxSingleStreamOut, maxTotalInflatedOut - totalInflated)
                                    let inflateResult = inflateZlibBounded(
                                        base: bytes.baseAddress!.advanced(by: dataStart),
                                        length: compLen,
                                        maxOut: budget
                                    )
                                    totalInflated += inflateResult.produced
                                    if let inflated = inflateResult.data {
                                        streamsScanned += 1
                                        try onInflated(inflated)
                                    } else {
                                        recordIssue("flate-stream-budget-or-decode")
                                    }
                                    if totalInflated >= maxTotalInflatedOut {
                                        recordIssue("flate-total-output-limit")
                                        break
                                    }
                                }
                            }
                            i = foundEnd + endstreamToken.count
                            continue
                        } else if isFlate && !isImage {
                            recordIssue("flate-endstream-unbounded")
                        }
                    }
                }
            }
            i += 1
        }
    }

    private static func inflateZlibBounded(base: UnsafePointer<UInt8>, length: Int, maxOut: Int) -> (data: Data?, produced: Int) {
        var stream = z_stream()
        stream.next_in = UnsafeMutablePointer(mutating: base)
        stream.avail_in = uInt(length)

        let initStatus = inflateInit_(&stream, ZLIB_VERSION, Int32(MemoryLayout<z_stream>.size))
        if initStatus != Z_OK { return (nil, 0) }
        defer { inflateEnd(&stream) }

        var output = Data()
        var producedTotal = 0
        var chunk = [UInt8](repeating: 0, count: 65536)
        while true {
            let chunkLen = chunk.count
            let status: Int32 = chunk.withUnsafeMutableBytes { raw in
                stream.next_out = raw.bindMemory(to: UInt8.self).baseAddress
                stream.avail_out = uInt(chunkLen)
                return zlib.inflate(&stream, Z_NO_FLUSH)
            }
            let produced = chunkLen - Int(stream.avail_out)
            if produced > 0 {
                producedTotal += produced
                if producedTotal > maxOut { return (nil, producedTotal) }
                output.append(chunk, count: produced)
            }
            if status == Z_STREAM_END {
                return (output, producedTotal)
            }
            if status != Z_OK {
                return (nil, producedTotal)
            }
            if stream.avail_in == 0 && produced == 0 {
                return (nil, producedTotal)
            }
        }
    }
}
