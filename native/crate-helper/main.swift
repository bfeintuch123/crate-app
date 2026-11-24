import Darwin
import Foundation

// Persistent NDJSON-over-stdio native macOS helper for Crate.
// Zero third-party dependencies — built solely on Apple system frameworks.

@main
struct CrateHelperMain {
    static func main() {
        // Ensure unbuffered line-by-line JSON responses on stdout.
        setvbuf(stdout, nil, _IOLBF, 0)

        while let line = readLine(strippingNewline: true) {
            if line.isEmpty { continue }
            guard let data = line.data(using: .utf8),
                  let req = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  let op = req["op"] as? String else {
                writeResponse(["id": NSNull(), "ok": false, "error": "invalid_request"])
                continue
            }
            let reqId: Any = req["id"] ?? NSNull()
            if op == "shutdown" {
                writeResponse(["id": reqId, "ok": true])
                exit(0)
            }

            let response = dispatch(op: op, req: req, reqId: reqId)
            writeResponse(response)
        }
    }

    static func parsePositiveInt64(_ raw: Any) -> Int64? {
        guard let num = raw as? NSNumber else { return nil }
        if CFGetTypeID(num) == CFBooleanGetTypeID() { return nil }
        let dbl = num.doubleValue
        if !dbl.isFinite || dbl <= 0 || floor(dbl) != dbl || dbl > Double(Int64.max) {
            return nil
        }
        let val = num.int64Value
        return val > 0 ? val : nil
    }

    static func dispatch(op: String, req: [String: Any], reqId: Any) -> [String: Any] {
        switch op {
        case "ping":
            return [
                "id": reqId,
                "ok": true,
                "result": [
                    "version": 1,
                    "pid": Int(getpid()),
                    "arch": "arm64",
                ],
            ]

        case "parse_psd":
            guard let filePath = req["filePath"] as? String else {
                return ["id": reqId, "ok": false, "error": "missing_file_path"]
            }
            let includeDigest = (req["includeDigest"] as? Bool) ?? false
            var maxFileBytes: Int64? = nil
            if let rawMax = req["maxFileBytes"], !(rawMax is NSNull) {
                guard let parsedMax = parsePositiveInt64(rawMax) else {
                    return ["id": reqId, "ok": false, "error": "invalid_max_file_bytes"]
                }
                maxFileBytes = parsedMax
            }
            do {
                let result = try PsdParser.parse(
                    filePath: filePath,
                    includeDigest: includeDigest,
                    maxFileBytes: maxFileBytes
                )
                return ["id": reqId, "ok": true, "result": result]
            } catch let err as HelperError {
                return ["id": reqId, "ok": false, "error": err.code]
            } catch {
                return ["id": reqId, "ok": false, "error": "psd_parse_failed"]
            }

        case "parse_pdf_ai":
            guard let filePath = req["filePath"] as? String else {
                return ["id": reqId, "ok": false, "error": "missing_file_path"]
            }
            let includeDigest = (req["includeDigest"] as? Bool) ?? false
            let decompressStreams = (req["decompressStreams"] as? Bool) ?? true
            var maxFileBytes: Int64? = nil
            if let rawMax = req["maxFileBytes"], !(rawMax is NSNull) {
                guard let parsedMax = parsePositiveInt64(rawMax) else {
                    return ["id": reqId, "ok": false, "error": "invalid_max_file_bytes"]
                }
                maxFileBytes = parsedMax
            }
            do {
                let result = try PdfAiParser.parse(
                    filePath: filePath,
                    includeDigest: includeDigest,
                    decompressStreams: decompressStreams,
                    maxFileBytes: maxFileBytes
                )
                return ["id": reqId, "ok": true, "result": result]
            } catch let err as HelperError {
                return ["id": reqId, "ok": false, "error": err.code]
            } catch {
                return ["id": reqId, "ok": false, "error": "pdf_ai_parse_failed"]
            }

        case "sha256_file":
            guard let filePath = req["filePath"] as? String else {
                return ["id": reqId, "ok": false, "error": "missing_file_path"]
            }
            do {
                let result = try PackageOps.sha256File(filePath: filePath)
                return ["id": reqId, "ok": true, "result": result]
            } catch let err as HelperError {
                return ["id": reqId, "ok": false, "error": err.code]
            } catch {
                return ["id": reqId, "ok": false, "error": "sha256_failed"]
            }

        case "clone_verified_file":
            do {
                let result = try PackageOps.cloneVerifiedFile(req: req)
                return ["id": reqId, "ok": true, "result": result]
            } catch let err as HelperError {
                return ["id": reqId, "ok": false, "error": err.code]
            } catch {
                return ["id": reqId, "ok": false, "error": "clone_failed"]
            }

        case "running_apps":
            let keywords = (req["keywords"] as? [String]) ?? []
            let caseSensitive = (req["caseSensitive"] as? Bool) ?? false
            let apps = WatchOps.runningApps(keywords: keywords, caseSensitive: caseSensitive)
            return ["id": reqId, "ok": true, "result": ["apps": apps]]

        case "open_files":
            let rawPids = (req["pids"] as? [NSNumber]) ?? []
            let pids = rawPids.map { Int32($0.int32Value) }.filter { $0 > 0 }
            let extensions = Set(((req["extensions"] as? [String]) ?? []).map { $0.lowercased() })
            let openResult = WatchOps.openFiles(pids: pids, extensions: extensions)
            return ["id": reqId, "ok": true, "result": openResult]

        case "read_last_used_xattr":
            let paths = (req["paths"] as? [String]) ?? []
            let xattrResult = WatchOps.readLastUsedXattrs(paths: paths)
            return ["id": reqId, "ok": true, "result": xattrResult]

        default:
            return ["id": reqId, "ok": false, "error": "unknown_op"]
        }
    }

    static func writeResponse(_ obj: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: obj),
              var str = String(data: data, encoding: .utf8) else {
            fputs("{\"id\":null,\"ok\":false,\"error\":\"encode_failed\"}\n", stdout)
            fflush(stdout)
            return
        }
        str.append("\n")
        fputs(str, stdout)
        fflush(stdout)
    }
}

struct HelperError: Error {
    let code: String
    init(_ code: String) { self.code = code }
}
