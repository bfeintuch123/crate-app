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
    private static let maxFileBytes: Int64 = 512 * 1024 * 1024
    private static let maxSingleStreamOut = 8 * 1024 * 1024
    private static let maxTotalInflatedOut = 64 * 1024 * 1024
    private static let maxStreamsToInflate = 512

    private static let allowedExtensions: Set<String> = [
        "jpg", "jpeg", "png", "gif", "webp", "svg", "pdf", "eps", "ai", "psd", "psb",
        "tiff", "tif", "afdesign", "afphoto", "afpub", "indd", "idml", "sketch", "fig",
        "heic", "ttf", "otf", "woff2", "woff", "mp4", "mov", "avi", "webm",
    ]

    static func parse(filePath: String, includeDigest: Bool, decompressStreams: Bool) throws -> [String: Any] {
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
        if fileSize > maxFileBytes { throw HelperError("pdf_ai_too_large") }

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
        var compressedStreamsScanned = 0
        var compressedHits = 0

        func recordPath(_ raw: String, fromCompressed: Bool = false) {
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty, trimmed != filePath else { return }
            if foundSet.insert(trimmed).inserted {
                foundOrder.append(trimmed)
                if fromCompressed { compressedHits += 1 }
            }
        }

        // 1. Direct raw byte scan for /Users/ and /Volumes/ asset paths + XMP tags
        data.withUnsafeBytes { buf in
            let bytes = buf.bindMemory(to: UInt8.self)
            scanRawPaths(bytes: bytes, onMatch: { recordPath($0) })
            scanXmpAndUris(bytes: bytes, onMatch: { recordPath($0) })

            // 2. Selective FlateDecode PDF stream decompression (non-image streams)
            if decompressStreams {
                scanFlateDecodeStreams(bytes: bytes, streamsScanned: &compressedStreamsScanned) { inflated in
                    inflated.withUnsafeBytes { ibuf in
                        let ib = ibuf.bindMemory(to: UInt8.self)
                        scanRawPaths(bytes: ib, onMatch: { recordPath($0, fromCompressed: true) })
                        scanXmpAndUris(bytes: ib, onMatch: { recordPath($0, fromCompressed: true) })
                    }
                }
            }
        }

        var result: [String: Any] = [
            "paths": foundOrder,
            "compressedStreamsScanned": compressedStreamsScanned,
            "compressedHits": compressedHits,
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

    // Fast O(N) byte scanner for `/Users/...<ext>` and `/Volumes/...<ext>` without
    // allocating a giant UTF-8 string for the entire file.
    private static func scanRawPaths(bytes: UnsafeBufferPointer<UInt8>, onMatch: (String) -> Void) {
        let n = bytes.count
        guard n >= 12 else { return }
        var i = 0
        while i < n - 8 {
            if bytes[i] == 0x2F { // '/'
                let isUsers = (i + 7 < n)
                    && (bytes[i + 1] == 0x55 || bytes[i + 1] == 0x75) // U/u
                    && (bytes[i + 2] == 0x73 || bytes[i + 2] == 0x53) // s
                    && (bytes[i + 3] == 0x65 || bytes[i + 3] == 0x45) // e
                    && (bytes[i + 4] == 0x72 || bytes[i + 4] == 0x52) // r
                    && (bytes[i + 5] == 0x73 || bytes[i + 5] == 0x53) // s
                    && bytes[i + 6] == 0x2F
                let isVolumes = !isUsers && (i + 9 < n)
                    && (bytes[i + 1] == 0x56 || bytes[i + 1] == 0x76) // V/v
                    && (bytes[i + 2] == 0x6F || bytes[i + 2] == 0x4F) // o
                    && (bytes[i + 3] == 0x6C || bytes[i + 3] == 0x4C) // l
                    && (bytes[i + 4] == 0x75 || bytes[i + 4] == 0x55) // u
                    && (bytes[i + 5] == 0x6D || bytes[i + 5] == 0x4D) // m
                    && (bytes[i + 6] == 0x65 || bytes[i + 6] == 0x45) // e
                    && (bytes[i + 7] == 0x73 || bytes[i + 7] == 0x53) // s
                    && bytes[i + 8] == 0x2F

                if isUsers || isVolumes {
                    // Find end of valid path run (delimiters: control chars < 0x20, '"', '\'', DEL, '<', '>').
                    // Do NOT stop on '(' or ')' so macOS filenames like `Logo (1).png` are preserved intact;
                    // PDF literal strings like `(/Users/a.png)` still stop right after `.png`.
                    var end = i + (isUsers ? 7 : 9)
                    let limit = min(n, i + 4096)
                    var matchedEnd = -1
                    while end < limit {
                        let b = bytes[end]
                        if b < 0x20 || b == 0x22 || b == 0x27 || b == 0x7F || b == 0x3C || b == 0x3E {
                            break
                        }
                        if b == 0x2E { // '.'
                            // Check if a known extension follows immediately (prefer longer like woff2 over woff)
                            let extStart = end + 1
                            var extEnd = extStart
                            while extEnd < min(limit, extStart + 9) {
                                let eb = bytes[extEnd]
                                let isAlnum = (eb >= 0x30 && eb <= 0x39) || (eb >= 0x41 && eb <= 0x5A) || (eb >= 0x61 && eb <= 0x7A)
                                if !isAlnum { break }
                                extEnd += 1
                            }
                            if extEnd > extStart {
                                var extStr = ""
                                for k in extStart..<extEnd {
                                    let c = bytes[k]
                                    let lc = (c >= 0x41 && c <= 0x5A) ? (c + 32) : c
                                    extStr.append(Character(UnicodeScalar(lc)))
                                }
                                if allowedExtensions.contains(extStr) {
                                    matchedEnd = extEnd
                                    break
                                }
                            }
                        }
                        end += 1
                    }
                    if matchedEnd > i {
                        let slice = UnsafeBufferPointer(rebasing: bytes[i..<matchedEnd])
                        if let str = String(bytes: slice, encoding: .utf8) {
                            onMatch(str)
                        }
                        i = matchedEnd
                        continue
                    } else {
                        i = end + 1
                        continue
                    }
                }
            }
            i += 1
        }
    }

    // Extract XMP <stRef:filePath>...</stRef:filePath> and LinkResourceURI="..." values.
    private static func scanXmpAndUris(bytes: UnsafeBufferPointer<UInt8>, onMatch: (String) -> Void) {
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
                        let limit = min(n, start + 4096)
                        while end < limit && bytes[end] != stopByte { end += 1 }
                        if end > start && end < limit {
                            let slice = UnsafeBufferPointer(rebasing: bytes[start..<end])
                            if var val = String(bytes: slice, encoding: .utf8) {
                                val = decodeXmlEntities(val)
                                if let local = normalizeLocalPathOrFileUri(val) {
                                    onMatch(local)
                                }
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
        return s
            .replacingOccurrences(of: "&amp;", with: "&")
            .replacingOccurrences(of: "&quot;", with: "\"")
            .replacingOccurrences(of: "&apos;", with: "'")
            .replacingOccurrences(of: "&lt;", with: "<")
            .replacingOccurrences(of: "&gt;", with: ">")
    }

    private static func normalizeLocalPathOrFileUri(_ raw: String) -> String? {
        var path = raw.replacingOccurrences(of: "\0", with: "").trimmingCharacters(in: .whitespacesAndNewlines)
        if path.isEmpty || path.unicodeScalars.contains(where: { $0.value < 0x20 }) { return nil }
        if path.lowercased().hasPrefix("file:") {
            var rest = String(path.dropFirst(5))
            if rest.hasPrefix("//") {
                let afterAuthorityStart = rest.index(rest.startIndex, offsetBy: 2)
                guard let slashIdx = rest[afterAuthorityStart...].firstIndex(of: "/") else { return nil }
                let host = String(rest[afterAuthorityStart..<slashIdx])
                if !host.isEmpty && host.lowercased() != "localhost" { return nil }
                rest = String(rest[slashIdx...])
            }
            guard rest.hasPrefix("/") else { return nil }
            let decoded = rest.removingPercentEncoding ?? rest
            path = "/" + decoded.drop(while: { $0 == "/" })
        }
        return (path.hasPrefix("/Users/") || path.hasPrefix("/Volumes/")) ? path : nil
    }

    // Locate `FlateDecode` streams (skipping `/Subtype /Image`), inflate with strict
    // memory caps via native zlib, and invoke `onInflated`.
    private static func scanFlateDecodeStreams(
        bytes: UnsafeBufferPointer<UInt8>,
        streamsScanned: inout Int,
        onInflated: (Data) -> Void
    ) {
        let streamToken = Array("stream".utf8)
        let endstreamToken = Array("endstream".utf8)
        let flateToken = Array("FlateDecode".utf8)
        let imageToken = Array("/Image".utf8)
        let n = bytes.count
        var totalInflated = 0
        var i = 0

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

        while i < n - 16 && streamsScanned < maxStreamsToInflate && totalInflated < maxTotalInflatedOut {
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
                        // Locate matching endstream
                        var endPos = dataStart
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
                        if foundEnd > dataStart {
                            if isFlate && !isImage {
                                var compEnd = foundEnd
                                while compEnd > dataStart && (bytes[compEnd - 1] == 0x0A || bytes[compEnd - 1] == 0x0D) {
                                    compEnd -= 1
                                }
                                let compLen = compEnd - dataStart
                                if compLen > 2 {
                                    let budget = min(maxSingleStreamOut, maxTotalInflatedOut - totalInflated)
                                    if let inflated = inflateZlibBounded(
                                        base: bytes.baseAddress!.advanced(by: dataStart),
                                        length: compLen,
                                        maxOut: budget
                                    ) {
                                        streamsScanned += 1
                                        totalInflated += inflated.count
                                        onInflated(inflated)
                                    }
                                }
                            }
                            i = foundEnd + endstreamToken.count
                            continue
                        }
                    }
                }
            }
            i += 1
        }
    }

    private static func inflateZlibBounded(base: UnsafePointer<UInt8>, length: Int, maxOut: Int) -> Data? {
        var stream = z_stream()
        stream.next_in = UnsafeMutablePointer(mutating: base)
        stream.avail_in = uInt(length)

        let initStatus = inflateInit_(&stream, ZLIB_VERSION, Int32(MemoryLayout<z_stream>.size))
        if initStatus != Z_OK { return nil }
        defer { inflateEnd(&stream) }

        var output = Data()
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
                if output.count + produced > maxOut { return nil }
                output.append(chunk, count: produced)
            }
            if status == Z_STREAM_END {
                return output
            }
            if status != Z_OK {
                return nil
            }
            if stream.avail_in == 0 && produced == 0 {
                return nil
            }
        }
    }
}
