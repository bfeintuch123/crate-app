import Darwin
import Foundation
import CryptoKit

// Seek-based PSD/PSB metadata & linked-asset parser.
// Reads ONLY header, resource 1075, and layer/global link & media descriptors
// (lnk2/lnk3/lnkD/lnkE, PlLd/SoLd, PxSc), seeking directly past all pixel
// channels and the merged composite image data. Handles multi-GB PSB files in
// milliseconds with < 3 MB RAM.

enum PsdParser {
    private static let maxBlocks = 8192
    private static let maxLayers = 8192
    private static let maxRecords = 8192
    private static let maxDescriptorBytes = 256 * 1024

    final class SeekReader {
        let fd: Int32
        let fileSize: Int64
        var offset: Int64 = 0
        private var buf = [UInt8](repeating: 0, count: 65536)
        private var bufStart: Int64 = -1
        private var bufLen: Int = 0

        init(fd: Int32, fileSize: Int64) {
            self.fd = fd
            self.fileSize = fileSize
        }

        func seek(to pos: Int64) throws {
            if pos < 0 || pos > fileSize { throw HelperError("psd_framing_bounds") }
            offset = pos
        }

        func skip(_ n: Int64, end: Int64) throws {
            if n < 0 || offset > end || n > end - offset { throw HelperError("psd_framing_bounds") }
            offset += n
        }

        private func ensureBuffered(_ count: Int) throws {
            if bufStart >= 0 && offset >= bufStart && (offset + Int64(count)) <= (bufStart + Int64(bufLen)) {
                return
            }
            let remaining = fileSize - offset
            if remaining < Int64(count) { throw HelperError("psd_framing_bounds") }
            let toRead = Int(min(Int64(buf.count), remaining))
            var totalRead = 0
            while totalRead < toRead {
                let r = buf.withUnsafeMutableBytes { raw -> Int in
                    let base = raw.baseAddress!.advanced(by: totalRead)
                    return Darwin.pread(fd, base, toRead - totalRead, off_t(offset + Int64(totalRead)))
                }
                if r <= 0 { throw HelperError("psd_read_error") }
                totalRead += r
            }
            bufStart = offset
            bufLen = totalRead
        }

        func readU8(end: Int64) throws -> UInt8 {
            if offset + 1 > end { throw HelperError("psd_framing_bounds") }
            try ensureBuffered(1)
            let v = buf[Int(offset - bufStart)]
            offset += 1
            return v
        }

        func readU16(end: Int64) throws -> UInt16 {
            if offset + 2 > end { throw HelperError("psd_framing_bounds") }
            try ensureBuffered(2)
            let i = Int(offset - bufStart)
            offset += 2
            return (UInt16(buf[i]) << 8) | UInt16(buf[i + 1])
        }

        func readI16(end: Int64) throws -> Int16 {
            return Int16(bitPattern: try readU16(end: end))
        }

        func readU32(end: Int64) throws -> UInt32 {
            if offset + 4 > end { throw HelperError("psd_framing_bounds") }
            try ensureBuffered(4)
            let i = Int(offset - bufStart)
            offset += 4
            return (UInt32(buf[i]) << 24)
                | (UInt32(buf[i + 1]) << 16)
                | (UInt32(buf[i + 2]) << 8)
                | UInt32(buf[i + 3])
        }

        func readU64(end: Int64) throws -> Int64 {
            let hi = try readU32(end: end)
            let lo = try readU32(end: end)
            let val = (UInt64(hi) << 32) | UInt64(lo)
            if val > UInt64(Int64.max) { throw HelperError("psd_framing_bounds") }
            return Int64(val)
        }

        func readAscii(_ count: Int, end: Int64) throws -> String {
            let bytes = try readBytes(count, end: end)
            return String(bytes: bytes, encoding: .isoLatin1) ?? ""
        }

        func readBytes(_ count: Int, end: Int64) throws -> [UInt8] {
            if count < 0 || Int64(count) > end - offset { throw HelperError("psd_framing_bounds") }
            if count == 0 { return [] }
            if count <= buf.count {
                try ensureBuffered(count)
                let i = Int(offset - bufStart)
                let out = Array(buf[i..<(i + count)])
                offset += Int64(count)
                return out
            }
            var out = [UInt8](repeating: 0, count: count)
            var total = 0
            while total < count {
                let r = out.withUnsafeMutableBytes { raw -> Int in
                    Darwin.pread(fd, raw.baseAddress!.advanced(by: total), count - total, off_t(offset + Int64(total)))
                }
                if r <= 0 { throw HelperError("psd_read_error") }
                total += r
            }
            offset += Int64(count)
            return out
        }

        func readUnicodeString(end: Int64) throws -> String {
            let units = Int(try readU32(end: end))
            if units > 32768 { throw HelperError("psd_coverage_limit") }
            if units == 0 { return "" }
            let raw = try readBytes(units * 2, end: end)
            var utf16 = [UInt16]()
            utf16.reserveCapacity(units)
            for idx in 0..<units {
                let ch = (UInt16(raw[idx * 2]) << 8) | UInt16(raw[idx * 2 + 1])
                if ch == 0 && idx == units - 1 { break }
                utf16.append(ch)
            }
            return String(utf16CodeUnits: utf16, count: utf16.count)
        }

        func readSection32(end: Int64) throws -> Int64 {
            let size = Int64(try readU32(end: end))
            if offset + size > end { throw HelperError("psd_framing_bounds") }
            return offset + size
        }

        func readSectionLen(isPsb: Bool, end: Int64) throws -> Int64 {
            let size = isPsb ? try readU64(end: end) : Int64(try readU32(end: end))
            if size < 0 || size > end - offset { throw HelperError("psd_framing_bounds") }
            return offset + size
        }
    }

    // Minimal bounded Adobe Action Descriptor reader for extracting string fields
    // (fullPath, originalPath, relPath, Nm  , etc.) from lnk2/lnk3/PxSc/1075 blocks.
    struct DescriptorReader {
        let bytes: [UInt8]
        var pos: Int = 0

        mutating func readU8() throws -> UInt8 {
            if pos + 1 > bytes.count { throw HelperError("psd_descriptor_bounds") }
            defer { pos += 1 }
            return bytes[pos]
        }

        mutating func readU32() throws -> UInt32 {
            if pos + 4 > bytes.count { throw HelperError("psd_descriptor_bounds") }
            let v = (UInt32(bytes[pos]) << 24)
                | (UInt32(bytes[pos + 1]) << 16)
                | (UInt32(bytes[pos + 2]) << 8)
                | UInt32(bytes[pos + 3])
            pos += 4
            return v
        }

        mutating func readI32() throws -> Int32 {
            return Int32(bitPattern: try readU32())
        }

        mutating func skip(_ n: Int) throws {
            if n < 0 || pos + n > bytes.count { throw HelperError("psd_descriptor_bounds") }
            pos += n
        }

        mutating func readAscii(_ n: Int) throws -> String {
            if n < 0 || pos + n > bytes.count { throw HelperError("psd_descriptor_bounds") }
            let s = String(bytes: bytes[pos..<(pos + n)], encoding: .isoLatin1) ?? ""
            pos += n
            return s
        }

        mutating func readId() throws -> String {
            let len = Int(try readU32())
            if len == 0 {
                return try readAscii(4)
            }
            if len > 4096 { throw HelperError("psd_descriptor_bounds") }
            return try readAscii(len)
        }

        mutating func readUnicodeString() throws -> String {
            let units = Int(try readU32())
            if units > 32768 || pos + units * 2 > bytes.count { throw HelperError("psd_descriptor_bounds") }
            if units == 0 { return "" }
            var utf16 = [UInt16]()
            utf16.reserveCapacity(units)
            for idx in 0..<units {
                let off = pos + idx * 2
                let ch = (UInt16(bytes[off]) << 8) | UInt16(bytes[off + 1])
                if ch == 0 && idx == units - 1 { break }
                utf16.append(ch)
            }
            pos += units * 2
            return String(utf16CodeUnits: utf16, count: utf16.count)
        }

        mutating func readVersionAndDescriptor() throws -> [String: Any] {
            let version = try readU32()
            if version != 16 { throw HelperError("psd_descriptor_version") }
            return try readDescriptor(depth: 0)
        }

        mutating func readDescriptor(depth: Int) throws -> [String: Any] {
            if depth > 16 { throw HelperError("psd_descriptor_depth") }
            _ = try readUnicodeString() // class name
            _ = try readId() // class id
            let count = Int(try readU32())
            if count > 2048 { throw HelperError("psd_descriptor_bounds") }
            var out: [String: Any] = [:]
            for _ in 0..<count {
                let key = try readId()
                let value = try readOSTypeValue(depth: depth + 1)
                if let v = value {
                    out[key] = v
                }
            }
            return out
        }

        mutating func readOSTypeValue(depth: Int) throws -> Any? {
            if depth > 16 { throw HelperError("psd_descriptor_depth") }
            let type = try readAscii(4)
            switch type {
            case "Objc", "GlbO":
                return try readDescriptor(depth: depth + 1)
            case "VlLs":
                let count = Int(try readU32())
                if count > 4096 { throw HelperError("psd_descriptor_bounds") }
                var arr: [Any] = []
                for _ in 0..<count {
                    if let item = try readOSTypeValue(depth: depth + 1) {
                        arr.append(item)
                    }
                }
                return arr
            case "TEXT":
                return try readUnicodeString()
            case "UntF":
                try skip(4 + 8)
                return nil
            case "doub":
                try skip(8)
                return nil
            case "bool":
                return (try readU8()) != 0
            case "long":
                return Int(try readI32())
            case "comp":
                try skip(8)
                return nil
            case "enum":
                _ = try readId()
                return try readId()
            case "type", "GlbC":
                _ = try readUnicodeString()
                return try readId()
            case "alis", "tdta", "Pth ":
                let len = Int(try readU32())
                if len < 0 || len > maxDescriptorBytes { throw HelperError("psd_descriptor_bounds") }
                try skip(len)
                return nil
            case "obj ":
                let count = Int(try readU32())
                if count > 256 { throw HelperError("psd_descriptor_bounds") }
                for _ in 0..<count {
                    let refType = try readAscii(4)
                    switch refType {
                    case "prop":
                        _ = try readUnicodeString(); _ = try readId(); _ = try readId()
                    case "Clss":
                        _ = try readUnicodeString(); _ = try readId()
                    case "Enmr":
                        _ = try readUnicodeString(); _ = try readId(); _ = try readId(); _ = try readId()
                    case "rele":
                        _ = try readUnicodeString(); _ = try readId(); try skip(4)
                    case "Idnt", "indx":
                        try skip(4)
                    case "name":
                        _ = try readUnicodeString()
                    default:
                        throw HelperError("psd_descriptor_ref_type")
                    }
                }
                return nil
            default:
                throw HelperError("psd_descriptor_type_\(type)")
            }
        }
    }

    static func parse(filePath: String, includeDigest: Bool) throws -> [String: Any] {
        let fd = Darwin.open(filePath, O_RDONLY | O_NOFOLLOW)
        if fd < 0 {
            if errno == ELOOP { throw HelperError("asset_baseline_source_symlink") }
            throw HelperError("asset_baseline_source_open_failed")
        }
        defer { Darwin.close(fd) }

        var st = stat()
        if fstat(fd, &st) != 0 { throw HelperError("asset_baseline_source_stat_failed") }
        if (st.st_mode & S_IFMT) != S_IFREG { throw HelperError("asset_baseline_source_not_file") }

        let fileSize = Int64(st.st_size)
        let reader = SeekReader(fd: fd, fileSize: fileSize)

        // Section 1: File Header (26 bytes)
        let sig = try reader.readAscii(4, end: fileSize)
        if sig != "8BPS" { throw HelperError("psd_invalid_signature") }
        let version = try reader.readU16(end: fileSize)
        if version != 1 && version != 2 { throw HelperError("psd_unsupported_version") }
        let isPsb = (version == 2)
        try reader.skip(6, end: fileSize) // reserved
        let channels = try reader.readU16(end: fileSize)
        let height = try reader.readU32(end: fileSize)
        let width = try reader.readU32(end: fileSize)
        let depth = try reader.readU16(end: fileSize)
        let colorMode = try reader.readU16(end: fileSize)

        // Section 2: Color Mode Data — seek right past it!
        let colorEnd = try reader.readSection32(end: fileSize)
        try reader.seek(to: colorEnd)

        var linkedPaths: [String] = []
        var linkedRecords: [[String: Any]] = []
        var embeddedRecords: [[String: Any]] = []
        var mediaPaths: [String] = []
        var issues: [String] = []
        var blockCount = 0
        var layerTotal = 0

        func normalizeLocalPath(_ raw: String?) -> String? {
            guard let raw = raw else { return nil }
            // Strip only trailing NUL padding from Photoshop UTF-16BE descriptors.
            // Never trim whitespace or invisible characters (trailing spaces, U+200B)
            // because they are valid literal macOS filename characters.
            var stripped = raw
            while stripped.unicodeScalars.last == UnicodeScalar(0) {
                stripped.unicodeScalars.removeLast()
            }
            if stripped.isEmpty { return nil }
            if stripped.unicodeScalars.contains(where: { $0.value < 0x20 }) { return nil }
            if stripped.lowercased().hasPrefix("file:") {
                var rest = String(stripped.dropFirst(5))
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
                return decoded
            }
            return stripped.hasPrefix("/") && !stripped.hasPrefix("//") && stripped.count > 1 ? stripped : nil
        }

        func extractPathsFromLinkDescriptor(_ desc: [String: Any]) -> (fullPath: String?, originalPath: String?, relPath: String?, name: String?) {
            let fp = desc["fullPath"] as? String
            let op = desc["originalPath"] as? String
            let rp = desc["relPath"] as? String
            let nm = desc["Nm  "] as? String
            return (fp, op, rp, nm)
        }

        func walkMediaDescriptor(desc: [String: Any], carrier: String) {
            if let frameReader = desc["frameReader"] as? [String: Any],
               let lnk = frameReader["Lnk "] as? [String: Any],
               let fp = normalizeLocalPath(lnk["fullPath"] as? String) {
                mediaPaths.append(fp)
            }
            if carrier == "1075",
               let groupWrap = desc["audioClipGroupList"] as? [String: Any],
               let groups = groupWrap["audioClipGroupList"] as? [[String: Any]] {
                for group in groups {
                    if let clips = group["audioClipList"] as? [[String: Any]] {
                        for clip in clips {
                            if let fr = clip["frameReader"] as? [String: Any],
                               let lnk = fr["Lnk "] as? [String: Any],
                               let fp = normalizeLocalPath(lnk["fullPath"] as? String) {
                                mediaPaths.append(fp)
                            }
                        }
                    }
                }
            }
        }

        func parseLinkBlock(end: Int64, carrier: String, layerIndex: Int?) throws {
            while reader.offset < end {
                if linkedRecords.count + embeddedRecords.count >= maxRecords {
                    throw HelperError("psd_coverage_limit")
                }
                let size = try reader.readU64(end: end)
                let recordEnd = reader.offset + size
                if recordEnd > end { throw HelperError("psd_framing_bounds") }
                let type = try reader.readAscii(4, end: recordEnd)
                let recVersion = try reader.readU32(end: recordEnd)
                let idLen = Int(try reader.readU8(end: recordEnd))
                let id = try reader.readAscii(idLen, end: recordEnd)

                if type == "liFD" || type == "liFE" || type == "liFA" {
                    let fileName = try reader.readUnicodeString(end: recordEnd)
                    try reader.skip(8, end: recordEnd) // fileType + creator
                    let dataSize = try reader.readU64(end: recordEnd)
                    let hasOpenDesc = try reader.readU8(end: recordEnd)

                    var fullPath: String? = nil
                    var originalPath: String? = nil
                    var relPath: String? = nil

                    func readDescriptorFromStream() throws {
                        let avail = Int(min(Int64(maxDescriptorBytes), recordEnd - reader.offset))
                        let snapOffset = reader.offset
                        let raw = try reader.readBytes(avail, end: recordEnd)
                        var dr = DescriptorReader(bytes: raw)
                        let desc = try dr.readVersionAndDescriptor()
                        try reader.seek(to: snapOffset + Int64(dr.pos))
                        let extracted = extractPathsFromLinkDescriptor(desc)
                        if let fp = extracted.fullPath, !fp.isEmpty { fullPath = fp }
                        if let op = extracted.originalPath, !op.isEmpty { originalPath = op }
                        if let rp = extracted.relPath, !rp.isEmpty { relPath = rp }
                    }

                    if hasOpenDesc == 1 {
                        do { try readDescriptorFromStream() } catch { issues.append("open-descriptor-error") }
                    }
                    if type == "liFE" {
                        do { try readDescriptorFromStream() } catch { issues.append("link-descriptor-error") }
                        if recVersion > 3 { try reader.skip(16, end: recordEnd) }
                        let extFileSize = try reader.readU64(end: recordEnd)
                        let normalizedFullPath = normalizeLocalPath(fullPath)
                        if let fp = normalizedFullPath {
                            linkedPaths.append(fp)
                        }
                        linkedRecords.append([
                            "carrier": carrier,
                            "layerIndex": layerIndex as Any,
                            "id": id,
                            "type": type,
                            "version": Int(recVersion),
                            "name": fileName,
                            "fullPath": normalizedFullPath ?? (fullPath ?? ""),
                            "originalPath": originalPath ?? "",
                            "relativePath": relPath ?? "",
                            "fileSize": extFileSize,
                        ])
                    } else if type == "liFD" {
                        let dataOffset = reader.offset
                        // Seek straight past embedded file payload without reading it into RAM!
                        try reader.seek(to: min(recordEnd, dataOffset + dataSize))
                        embeddedRecords.append([
                            "carrier": carrier,
                            "layerIndex": layerIndex as Any,
                            "id": id,
                            "type": type,
                            "version": Int(recVersion),
                            "name": fileName,
                            "dataOffset": dataOffset,
                            "byteLength": dataSize,
                        ])
                    } else {
                        linkedRecords.append([
                            "carrier": carrier,
                            "layerIndex": layerIndex as Any,
                            "id": id,
                            "type": type,
                            "version": Int(recVersion),
                            "name": fileName,
                            "fullPath": fullPath ?? "",
                        ])
                    }
                } else {
                    issues.append("unsupported-link-form")
                }

                try reader.seek(to: recordEnd)
                let pad = (4 - (size % 4)) % 4
                if pad > 0 && reader.offset + pad <= end {
                    try reader.skip(pad, end: end)
                }
            }
        }

        func parseAdditionalBlocks(end: Int64, layerIndex: Int?, depth: Int) throws {
            if depth > 4 { throw HelperError("psd_coverage_limit") }
            while reader.offset < end {
                if layerIndex == nil {
                    let peek = try reader.readU8(end: end)
                    if peek == 0 { continue }
                    try reader.seek(to: reader.offset - 1)
                }
                if end - reader.offset < 12 { break }
                blockCount += 1
                if blockCount > maxBlocks { throw HelperError("psd_coverage_limit") }
                let blockSig = try reader.readAscii(4, end: end)
                if blockSig != "8BIM" && blockSig != "8B64" {
                    issues.append("unsupported-additional-signature")
                    break
                }
                let key = try reader.readAscii(4, end: end)
                let uses64 = (blockSig == "8B64")
                let blockSize = uses64 ? try reader.readU64(end: end) : Int64(try reader.readU32(end: end))
                let blockEnd = reader.offset + blockSize
                if blockSize < 0 || blockEnd > end { throw HelperError("psd_framing_bounds") }

                if key == "lnk2" || key == "lnk3" || key == "lnkD" || key == "lnkE" {
                    try parseLinkBlock(end: blockEnd, carrier: key, layerIndex: layerIndex)
                } else if key == "PxSc" {
                    if blockSize > Int64(maxDescriptorBytes) {
                        issues.append("oversized-pxsc-descriptor")
                    } else {
                        let raw = try reader.readBytes(Int(blockSize), end: blockEnd)
                        var dr = DescriptorReader(bytes: raw)
                        if let desc = try? dr.readVersionAndDescriptor() {
                            walkMediaDescriptor(desc: desc, carrier: "PxSc")
                        } else {
                            issues.append("unreadable-pxsc-descriptor")
                        }
                    }
                } else if key == "Layr" || key == "Lr16" || key == "Lr32" {
                    try parseLayerInfo(layerEnd: blockEnd, depth: depth + 1)
                }

                // Seek straight past block payload (skipping any pixel/effect/unknown data)!
                try reader.seek(to: blockEnd)
                let pad = blockSize % 2
                if pad > 0 && reader.offset + pad <= end {
                    try reader.skip(pad, end: end)
                }
            }
        }

        func parseLayerInfo(layerEnd: Int64, depth: Int) throws {
            if reader.offset + 2 > layerEnd { return }
            let rawCount = try reader.readI16(end: layerEnd)
            let count = abs(Int(rawCount))
            layerTotal += count
            if layerTotal > maxLayers { throw HelperError("psd_coverage_limit") }

            let maxDim: Int64 = isPsb ? 300_000 : 30_000
            var totalChannelBytes: Int64 = 0
            for idx in 0..<count {
                let top = Int64(Int32(bitPattern: try reader.readU32(end: layerEnd)))
                let left = Int64(Int32(bitPattern: try reader.readU32(end: layerEnd)))
                let bottom = Int64(Int32(bitPattern: try reader.readU32(end: layerEnd)))
                let right = Int64(Int32(bitPattern: try reader.readU32(end: layerEnd)))
                let layerH = bottom - top
                let layerW = right - left
                if layerH < 0 || layerW < 0 || layerH > maxDim || layerW > maxDim {
                    throw HelperError("Invalid layer size")
                }
                let chCount = Int(try reader.readU16(end: layerEnd))
                if chCount > 56 { throw HelperError("psd_unsupported_channels") }
                for _ in 0..<chCount {
                    try reader.skip(2, end: layerEnd) // channel id
                    let chLen = isPsb ? try reader.readU64(end: layerEnd) : Int64(try reader.readU32(end: layerEnd))
                    if chLen < 0 { throw HelperError("psd_framing_bounds") }
                    totalChannelBytes += chLen
                }
                let blendSig = try reader.readAscii(4, end: layerEnd)
                if blendSig != "8BIM" { throw HelperError("psd_invalid_layer_signature") }
                try reader.skip(8, end: layerEnd) // blend mode + opacity + clipping + flags + filler
                let extraEnd = try reader.readSection32(end: layerEnd)
                let maskDataEnd = try reader.readSection32(end: extraEnd)
                if maskDataEnd - reader.offset >= 16 {
                    let mTop = Int64(Int32(bitPattern: try reader.readU32(end: maskDataEnd)))
                    let mLeft = Int64(Int32(bitPattern: try reader.readU32(end: maskDataEnd)))
                    let mBottom = Int64(Int32(bitPattern: try reader.readU32(end: maskDataEnd)))
                    let mRight = Int64(Int32(bitPattern: try reader.readU32(end: maskDataEnd)))
                    let maskH = mBottom - mTop
                    let maskW = mRight - mLeft
                    if maskH < 0 || maskW < 0 || maskH > maxDim || maskW > maxDim {
                        throw HelperError("Invalid mask size")
                    }
                }
                try reader.seek(to: maskDataEnd)
                let blendRangeEnd = try reader.readSection32(end: extraEnd)
                try reader.seek(to: blendRangeEnd)
                let nameLen = Int(try reader.readU8(end: extraEnd))
                let paddedName = nameLen + ((4 - ((nameLen + 1) % 4)) % 4)
                try reader.skip(Int64(paddedName), end: extraEnd)
                try parseAdditionalBlocks(end: extraEnd, layerIndex: idx, depth: depth)
                try reader.seek(to: extraEnd)
            }
            // Seek straight past ALL layer pixel channel bytes without reading a single pixel!
            try reader.skip(totalChannelBytes, end: layerEnd)
        }

        // Section 3: Image Resources — seek past all except 1075 (timeline audio)
        let resourcesEnd = try reader.readSection32(end: fileSize)
        while reader.offset < resourcesEnd {
            blockCount += 1
            if blockCount > maxBlocks { throw HelperError("psd_coverage_limit") }
            let rSig = try reader.readAscii(4, end: resourcesEnd)
            if rSig != "8BIM" { break }
            let resId = try reader.readU16(end: resourcesEnd)
            let nameLen = Int(try reader.readU8(end: resourcesEnd))
            let namePad = (nameLen + 1) % 2
            try reader.skip(Int64(nameLen + namePad), end: resourcesEnd)
            let resSize = Int64(try reader.readU32(end: resourcesEnd))
            let resEnd = reader.offset + resSize
            if resSize < 0 || resEnd > resourcesEnd { throw HelperError("psd_framing_bounds") }
            if resId == 1075 && resSize <= Int64(maxDescriptorBytes) {
                let raw = try reader.readBytes(Int(resSize), end: resEnd)
                var dr = DescriptorReader(bytes: raw)
                if let desc = try? dr.readVersionAndDescriptor() {
                    walkMediaDescriptor(desc: desc, carrier: "1075")
                }
            }
            try reader.seek(to: resEnd)
            if (resSize % 2) == 1 && reader.offset < resourcesEnd {
                try reader.skip(1, end: resourcesEnd)
            }
        }
        try reader.seek(to: resourcesEnd)

        // Section 4: Layer & Mask Information
        let maskSectionEnd = try reader.readSectionLen(isPsb: isPsb, end: fileSize)
        if reader.offset < maskSectionEnd {
            let layerInfoEnd = try reader.readSectionLen(isPsb: isPsb, end: maskSectionEnd)
            let layerStart = reader.offset
            if reader.offset < layerInfoEnd {
                try parseLayerInfo(layerEnd: layerInfoEnd, depth: 0)
            }
            try reader.seek(to: layerInfoEnd)
            let pad = (layerInfoEnd - layerStart) % 2
            if pad > 0 && reader.offset + pad <= maskSectionEnd {
                try reader.skip(pad, end: maskSectionEnd)
            }
            if reader.offset < maskSectionEnd {
                let globalMaskEnd = try reader.readSection32(end: maskSectionEnd)
                try reader.seek(to: globalMaskEnd)
                if reader.offset < maskSectionEnd {
                    try parseAdditionalBlocks(end: maskSectionEnd, layerIndex: nil, depth: 0)
                }
            }
        }
        // Section 5 (Merged Composite Image Data) is NEVER read!

        var result: [String: Any] = [
            "format": isPsb ? "psb" : "psd",
            "version": Int(version),
            "width": Int(width),
            "height": Int(height),
            "channels": Int(channels),
            "bitsPerChannel": Int(depth),
            "colorMode": Int(colorMode),
            "linkedPaths": linkedPaths,
            "mediaPaths": mediaPaths,
            "linkedRecords": linkedRecords,
            "embeddedRecords": embeddedRecords,
            "issues": issues,
            "incomplete": !issues.isEmpty,
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
}
