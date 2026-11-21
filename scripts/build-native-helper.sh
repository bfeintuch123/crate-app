#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="$ROOT_DIR/native/crate-helper"
OUT_DIR="$ROOT_DIR/native/bin"
OUT_BIN="$OUT_DIR/crate-helper"

mkdir -p "$OUT_DIR"

/usr/bin/swiftc \
  -O \
  -whole-module-optimization \
  -parse-as-library \
  -target arm64-apple-macosx14.0 \
  -lz \
  -framework AppKit \
  -framework Foundation \
  -framework CryptoKit \
  "$SRC_DIR/main.swift" \
  "$SRC_DIR/PsdParser.swift" \
  "$SRC_DIR/PdfAiParser.swift" \
  "$SRC_DIR/PackageOps.swift" \
  "$SRC_DIR/WatchOps.swift" \
  -o "$OUT_BIN"

chmod 755 "$OUT_BIN"
echo "Built $OUT_BIN ($(wc -c < "$OUT_BIN" | tr -d ' ') bytes)"
