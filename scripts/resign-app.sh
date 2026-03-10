#!/bin/bash
# resign-app.sh: Re-sign all binaries in the built .app with proper timestamps.
# Run when a build was signed while a timestamp server was down.

APP="$1"
IDENTITY="Developer ID Application: Bryant Feintuch (YY7WDMUFWJ)"
ENTITLEMENTS="/Users/bryantfeintuchclaw/Projects/entitlements.plist"

if [ -z "$APP" ]; then
  echo "Usage: $0 /path/to/App.app"
  exit 1
fi

echo "🔏 Re-signing: $APP"
echo "   Identity: $IDENTITY"
echo ""

ERRORS=0

# Sign all dylibs, .node files, and executables (bottom-up — frameworks last)
# Sort so deeper paths come first (sign leaves before containers)
find "$APP" -type f \( -name "*.dylib" -o -name "*.so" -o -name "*.node" \) | sort -r | while read -r f; do
  echo "  Signing: $(basename "$f")"
  codesign --sign "$IDENTITY" --force --timestamp --options runtime "$f" 2>&1
  if [ $? -ne 0 ]; then
    echo "  ❌ Failed: $f"
    ERRORS=$((ERRORS + 1))
  fi
done

# Sign nested Helper apps
find "$APP" -name "*.app" -not -path "$APP" | sort -r | while read -r helper; do
  echo "  Signing Helper: $(basename "$helper")"
  codesign --sign "$IDENTITY" --force --timestamp --options runtime --entitlements "$ENTITLEMENTS" "$helper" 2>&1
done

# Sign frameworks
find "$APP" -name "*.framework" | sort -r | while read -r fw; do
  echo "  Signing Framework: $(basename "$fw")"
  codesign --sign "$IDENTITY" --force --timestamp "$fw" 2>&1
done

# Sign the main app bundle last
echo ""
echo "  Signing main bundle: $(basename "$APP")"
codesign --sign "$IDENTITY" --force --timestamp --options runtime --entitlements "$ENTITLEMENTS" "$APP" 2>&1

echo ""
echo "✅ Done. Verifying..."
codesign -v --deep "$APP" 2>&1
spctl -a -v "$APP" 2>&1 || echo "(spctl check — may show 'rejected' until notarized)"
