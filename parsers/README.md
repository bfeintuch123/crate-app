# Crate v2.0 — Parser Module

Modular parser system for extracting linked/embedded assets from design files.

## Architecture

```
parsers/
  index.js          # Registry + getParser() + packageMasterFile() orchestrator
  base.js           # BaseParser abstract class
  ai.js             # Adobe Illustrator
  psd.js            # Photoshop (stub)
  indesign.js       # InDesign / IDML
  powerpoint.js     # PowerPoint / Keynote
  premiere.js       # Premiere Pro
  aftereffects.js   # After Effects (stub)
  figma.js          # Figma (stub)
```

## Parser Interface

Every parser extends `BaseParser` and implements:

```javascript
class MyParser extends BaseParser {
  // Extract linked/embedded assets from a design file
  async extractAssets(filePath) {
    return [
      {
        path: '/absolute/path/to/asset.jpg',
        source: 'parser-method',  // e.g. 'ai-regex', 'idml-link'
        exists: true              // whether file exists on disk
      }
    ];
  }

  // File extensions this parser handles
  static get extensions() {
    return ['.ext'];
  }

  // Human-readable format name
  static get displayName() {
    return 'Format Name';
  }
}
```

## Usage

```javascript
const { getParser, packageMasterFile, SUPPORTED_EXTENSIONS } = require('./parsers');

// Check supported extensions
console.log(SUPPORTED_EXTENSIONS);
// ['.ai', '.ait', '.psd', '.psb', '.indd', '.idml', '.prproj', '.aep', '.aet', '.pptx', '.ppt', '.key', '.fig']

// Get parser for a specific file
const parser = getParser('/path/to/project.ai');
const assets = await parser.extractAssets('/path/to/project.ai');
// → [{ path: '/Users/.../image.jpg', source: 'ai-regex', exists: true }, ...]

// Package a master file with all its linked assets
const result = await packageMasterFile('/path/to/project.ai', '/output/folder', {
  flat: false,        // preserve folder structure
  skipMissing: true   // continue if linked files are missing
});
// → { masterFile, assetsFound, assetsCopied, assetsMissing, files }
```

## Parser Status

| Format | Parser | Status | Dependencies |
|--------|--------|--------|--------------|
| Adobe Illustrator (.ai, .ait) | `AIParser` | ✅ Implemented | — |
| Adobe Photoshop (.psd, .psb) | `PSDParser` | ⚠️ Stub | `npm install psd` |
| Adobe InDesign (.indd, .idml) | `InDesignParser` | ✅ Implemented | — |
| Premiere Pro (.prproj) | `PremiereParser` | ✅ Implemented | — |
| After Effects (.aep, .aet) | `AfterEffectsParser` | 🔬 Stub | Complex RIFX binary |
| PowerPoint (.pptx, .ppt) | `PowerPointParser` | ✅ Implemented | — |
| Keynote (.key) | `PowerPointParser` | ✅ Implemented | — |
| Figma | `FigmaParser` | ⚠️ Stub | `npm install keytar node-fetch@2` |

### Legend
- ✅ **Implemented** — Ready to use
- ⚠️ **Stub** — Needs npm dependency installed
- 🔬 **Stub** — Complex format, requires future development

## Implemented Parsers

### AIParser (Adobe Illustrator)

Scans .ai file binary for embedded path strings using regex.

**How it works:**
- .ai files are PDF-based
- Linked asset paths are stored as text strings in the binary
- Regex: `/\/Users\/[^\x00-\x1f\x22\x27]+\.(jpg|jpeg|png|...)/gi`

**Limitations:**
- PDF 1.6+ files may use FlateDecode compression, hiding some paths
- For complete coverage with Illustrator running, use AppleScript approach (v1.3 style)

### InDesignParser (InDesign / IDML)

Parses IDML ZIP archives and extracts `LinkResourceURI` values from XML.

**How it works:**
- IDML files are ZIP archives containing XML
- Links stored as `file:///path/to/asset.jpg` URIs
- Falls back to regex scanning for binary .indd files

**Dependencies:** None (uses `/usr/bin/unzip`)

### PremiereParser (Premiere Pro)

Decompresses gzip XML and extracts media paths.

**How it works:**
- .prproj files are gzip-compressed XML
- Media paths in `<ActualMediaFilePath>` and `<FilePath>` tags
- Uses Node's built-in `zlib` module

**Dependencies:** None

### PowerPointParser (PowerPoint / Keynote)

Extracts embedded media from ZIP archives.

**How it works:**
- .pptx: Media in `ppt/media/` folder
- .key: Media in `Data/` folder
- Keynote junk filtering (st-, mt-, bg-, tx- thumbnails)

**Note:** This parser extracts *embedded* files (copies), not *linked* files.
The `extractToDirectory()` method saves files to disk.

**Dependencies:** None (uses `/usr/bin/unzip`)

## Stub Parsers

### PSDParser (Photoshop)

**Dependencies needed:**
```bash
npm install psd
```

**Approach:**
- Parse PSD layer tree
- Find layers with `smartObject.linked` property
- Extract linked Smart Object paths

### AfterEffectsParser (After Effects)

**Status:** Complex binary format (RIFX)

**Possible approaches:**
1. Regex binary scan (similar to AI parser) — may miss some paths
2. Go bridge for proper RIFX parsing — more accurate
3. ExtendScript/osascript — requires AE running

### FigmaParser (Figma)

**Dependencies needed:**
```bash
npm install keytar node-fetch@2
```

**Approach:**
- Extract file key from Figma URL
- Call Figma REST API with Personal Access Token
- Download exported images

**Setup required:**
1. Generate PAT at figma.com/developers
2. Store PAT in macOS Keychain via Crate onboarding

## Adding a New Parser

1. Create `parsers/newformat.js`:

```javascript
'use strict';

const { BaseParser } = require('./base');

class NewFormatParser extends BaseParser {
  async extractAssets(filePath) {
    // Your parsing logic here
    return [{ path, source, exists }];
  }

  static get extensions() {
    return ['.newext'];
  }

  static get displayName() {
    return 'New Format';
  }
}

module.exports = { NewFormatParser };
```

2. Register in `parsers/index.js`:

```javascript
const { NewFormatParser } = require('./newformat');

const PARSER_REGISTRY = {
  // ... existing parsers
  '.newext': NewFormatParser
};

module.exports = {
  // ... existing exports
  NewFormatParser
};
```

3. Update this README with status

## Testing

Verify parsers load correctly:

```bash
# Test registry
node -e "const p = require('./parsers/index.js'); console.log('Registry loaded OK:', p.SUPPORTED_EXTENSIONS);"

# Test AI parser
node -e "const {AIParser} = require('./parsers/ai.js'); const p = new AIParser(); console.log('AI parser OK:', p.constructor.name, AIParser.extensions);"

# Test Premiere parser
node -e "const {PremiereParser} = require('./parsers/premiere.js'); const p = new PremiereParser(); console.log('Premiere parser OK:', PremiereParser.extensions);"
```

## Notes

- All parsers are CommonJS (no ESM)
- Parsers never throw uncaught exceptions — errors are handled gracefully
- Stubs throw helpful errors explaining what's needed
- v2.0 parsers are standalone and don't modify v1.x code
