# All-app package regression coverage — 2026-10-17

This is code-level coverage of current implemented routes. Native application availability is not a prerequisite. It is not proof of complete proprietary-format parsing or portable binary document links.

## Coverage matrix

Every **live** row below participates in `tests/cross-app-live-pipeline.test.js`: actual current reader → trusted Add Files IPC → Include → individual exclusion → persisted JSON reload → authoritative review → explicit Restore → package → dependency/source bytes and count agreement. Electron, OS process collectors, store transport and worker transport are modeled; readers, ZIP/unzip, PSD parsing, file IO and package writers are real. The shared `working-file-choice-ipc.test.js` separately covers explicit Add Files Replace/Keep and persisted choice state across all 15 live extensions. Observer-driven Save As has additional shared admission/identity tests; this does not claim per-format native Save As automation.

| Adapter/format | Route | Actual fixture and boundary |
| --- | --- | --- |
| Illustrator `.ai` | Live + Quick | PDF-style saved bytes with raw path metadata; Quick duplicate/missing refs and byte/count assertions. Proprietary compressed/UTF-16 link completeness is not established. |
| Illustrator `.ait` | Quick | Same actual Quick reader, PDF-style fixture, missing/duplicate refs and copied bytes. No live adapter. |
| Photoshop `.psd` | Live + Quick | Real `ag-psd` writer/reader linked resources; live worker protocol/framing plus embedded resource materialization; persisted exclusion/Restore and package bytes. Quick exports linked sidecars; embedded resources remain within the copied PSD. |
| Photoshop `.psb` | Quick | Real large-document writer/reader linked resources, missing refs and package bytes/counts. No live PSB admission claim. |
| InDesign `.indd` | Live + Quick | Saved-byte path fallback; live closed-process inventory receipt. This is not a full native compound-document fixture or relink writer. |
| InDesign `.idml` | Live + Quick | Real compressed ZIP/XML and URI refs; XML entities/one-pass Unicode tests in Quick. Copied IDML references remain unchanged. |
| Sketch `.sketch` | Live | Real compressed ZIP with JSON path references. No proprietary-format completeness or Quick route. |
| Affinity Designer `.afdesign` | Live | Real ZIP/text reference fixture for current fallback. No complete proprietary native-file guarantee. |
| Affinity Photo `.afphoto` | Live | Separate extension dispatch through same real ZIP/text fallback; same limit. |
| Affinity Publisher `.afpub` | Live | Separate extension dispatch through same real ZIP/text fallback; same limit. |
| Pixelmator `.pxd` | Live | Real ZIP/text reference fixture for current fallback; no complete proprietary native-file guarantee. |
| XD `.xd` | Live | Real stored ZIP exposing a raw path, exercising current regex reader; compressed proprietary reference completeness remains a gap. |
| PDF `.pdf` | Live | PDF-style saved bytes with raw path metadata; dependencies/counts. Raw text paths do not prove a complete PDF dependency inventory. |
| Figma `.fig` | Live fallback | Current local raw-reference path, with current-page policy retaining dependencies and omitting unsupported local FIG parent. Quick local FIG explicitly refuses. |
| Figma cloud | Connected API | Existing scope/page-lock/package suites; distinct-asset decision fixture correction and explicit persisted same-content exclusion/Restore regression. HTTP/credentials are modeled; no real account/network needed. |
| PowerPoint `.pptx` | Live + Quick | Real compressed OPC ZIP, external relationships and embedded media; excluded/missing dependency refusal; exact source/output bytes, collisions and count agreement. Explicit portable-picture option covered separately below. |
| PowerPoint `.ppt` | Live + Quick boundary | Live raw binary-path fallback. Quick legacy PPT has no extractor, explicitly tested; PPTX coverage does not establish PPT parsing. |
| Keynote `.key` | Live + Quick | Real compressed ZIP/Data media extraction and bytes/counts, same-basename distinct media. Not a full IWA semantic fixture or external-link relinker. |
| Premiere `.prproj` | Quick | Real gzip/XML, decoded duplicate/missing refs, exact bytes/counts. No live adapter or project-reference rewrite. |
| After Effects `.aep` / `.aet` | Quick | RIFX/FaFX length/padding/UTF-8 reference chunks, duplicate/missing refs and bytes/counts. Not a complete native project or relink writer; no live adapter. |

The union is **20 file extensions**: 15 live routes plus 5 Quick-only extensions. Quick supports 13 extensions, including the explicit unsupported-local-FIG/legacy-PPT boundaries above. Dependency asset extensions and VS Code process observation are not additional creative-document parsers.

## Regressions and fixes

`cross-app-quick-fixtures.test.cjs` and `cross-app-quick-regressions.test.cjs` exercise real parsers and files. They cover structured Photoshop links missed by the old regex, one-pass XML entity decoding (including astral Unicode), archive paths sharing a basename, strict failure rollback and preservation of preexisting output files. Existing admission tests retain size/decompression limits and cleanup-after-earlier-media-write coverage.

`portable-picture-ipc.test.js`, `portable-pictures.test.cjs` and `portable-option-renderer.test.cjs` cover explicit true/default false, authoritative setting display, token invalidation, stale modal responses, source preservation, exact image payload, existing embeds, external links, internal media dedup, both output layouts, counts, missing/excluded assets, unsafe or non-Office relationships, stale embedded IDs/targets and signed-package refusal. Existing embeds are preserved; the feature does not refresh their cached content.

Only explicit **Portable PowerPoint pictures** adds embedded picture copies. Links are retained; moved external references may need relinking for future edits. New embedded copies support PNG/JPEG/GIF/TIFF/BMP signatures. SVG/EMF/WMF and unassociated/VML picture forms are refused by this mode. Audio/video/OLE/package relationships retain their existing link behavior. These signature checks do not replace full image decoding or guarantee every PowerPoint representation.

Shared raster-content exclusion tests cover alias suppression across parent identities, plus existing PSD virtual-resource coverage. This is complementary shared-pipeline evidence, not a claim that every parser can prove all embedded content or rewrite its references. Unsupported/unrecognized inputs must not be described as complete portable packages.

## Local verification and remaining gate

Run the pinned Node version with `--test` on the files named above, plus parser admission, package output/review, PSD worker/safety, Figma scope/link, working-source selection/continuation, and portable package regression suites. For `working-file-choice-ipc.test.js`, the separate capacity stress case may be explicitly omitted with `--test-skip-pattern='capacity:'`; do not report that stress case as passed.

Evidence, exact commands, seals, review receipts, isolated renderer screenshots and native output screenshots live in the private task evidence directory `cross-app-coverage` outside the product repository. The explicit-picture production-pipeline output reopened successfully in PowerPoint after relocation with the external PNG unavailable, in flat and organized layouts. It does not establish automatic external-link refresh after relocation.

The separate local candidate is ad-hoc signed and is not an installed/distribution build. Its native UI launch was not certified: process sampling observed a blocking macOS Keychain read before renderer completion. No Keychain permissions were granted; the QA process stopped and the original signed app and saved original presentation were restored. Exact-head protected CI, a fresh required independent Luna/high review on the eventual PR head, and signed/notarized distribution QA remain release/ready gates. No release, publication, installation or merge is authorized by this change.
