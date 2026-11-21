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
            do {
                let result = try PsdParser.parse(filePath: filePath, includeDigest: includeDigest)
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
            do {
                let result = try PdfAiParser.parse(
                    filePath: filePath,
                    includeDigest: includeDigest,
                    decompressStreams: decompressStreams
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

        case "package_batch":
            guard let destDir = req["destDir"] as? String,
                  let items = req["items"] as? [[String: Any]] else {
                return ["id": reqId, "ok": false, "error": "invalid_package_batch"]
            }
            let mode = (req["mode"] as? String) ?? "clone_or_copy"
            let computeHash = (req["computeHash"] as? Bool) ?? true
            do {
                let result = try PackageOps.packageBatch(
                    destDir: destDir,
                    items: items,
                    mode: mode,
                    computeHash: computeHash
                )
                return ["id": reqId, "ok": true, "result": result]
            } catch let err as HelperError {
                return ["id": reqId, "ok": false, "error": err.code]
            } catch {
                return ["id": reqId, "ok": false, "error": "package_batch_failed"]
            }

        case "running_apps":
            let keywords = (req["keywords"] as? [String]) ?? []
            let apps = WatchOps.runningApps(keywords: keywords)
            return ["id": reqId, "ok": true, "result": ["apps": apps]]

        case "open_files":
            let rawPids = (req["pids"] as? [NSNumber]) ?? []
            let pids = rawPids.map { Int32($0.int32Value) }.filter { $0 > 0 }
            let extensions = Set(((req["extensions"] as? [String]) ?? []).map { $0.lowercased() })
            let files = WatchOps.openFiles(pids: pids, extensions: extensions)
            return ["id": reqId, "ok": true, "result": ["files": files]]

        case "read_last_used_xattr":
            let paths = (req["paths"] as? [String]) ?? []
            let timestamps = WatchOps.readLastUsedXattrs(paths: paths)
            return ["id": reqId, "ok": true, "result": ["timestamps": timestamps]]

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
