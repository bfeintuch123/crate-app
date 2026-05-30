const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

function loadFigmaParserWithHome(homeDir, options = {}) {
  const parserPath = require.resolve('../parsers/figma');
  const originalLoad = Module._load;
  delete require.cache[parserPath];

  Module._load = function loadWithStubs(request, parent, isMain) {
    if (request === 'os') {
      return { homedir: () => homeDir };
    }
    if (request === 'keytar') {
      throw new Error('keytar unavailable in fallback token test');
    }
    if (request === 'node-fetch' && options.fetchImpl) {
      return options.fetchImpl;
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return require('../parsers/figma').FigmaParser;
  } finally {
    Module._load = originalLoad;
    delete require.cache[parserPath];
  }
}

async function captureConsole(fn) {
  const messages = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  console.log = (...args) => messages.push(args.map(String).join(' '));
  console.warn = (...args) => messages.push(args.map(String).join(' '));
  console.error = (...args) => messages.push(args.map(String).join(' '));
  try {
    return {
      result: await fn(),
      output: messages.join('\n')
    };
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }
}

const FIGMA_SENSITIVE_ERROR = [
  'request failed',
  'https://api.figma.com/v1/files/FILEKEY?token=SHOULD_NOT_LEAK',
  'https://cdn.figma.com/signed/path?token=SHOULD_NOT_LEAK',
  'Authorization: Bearer SHOULD_NOT_LEAK',
  'cookie=SHOULD_NOT_LEAK',
  'X-Figma-Token SHOULD_NOT_LEAK',
  '/Users/designer/private/client/file.fig'
].join(' ');

function assertNoFigmaSecrets(text) {
  assert.equal(/https:\/\/api\.figma\.com/i.test(text), false);
  assert.equal(/https:\/\/cdn\.figma\.com/i.test(text), false);
  assert.equal(/[?&]token=/i.test(text), false);
  assert.equal(text.includes('SHOULD_NOT_LEAK'), false);
  assert.equal(/\bAuthorization\b/i.test(text), false);
  assert.equal(/\bBearer\b/i.test(text), false);
  assert.equal(/\bcookie\b/i.test(text), false);
  assert.equal(/\bX-Figma-Token\b/i.test(text), false);
  assert.equal(text.includes('/Users/designer/private/client/file.fig'), false);
}

test('renderer Figma token privacy hint accurately describes local storage and API usage', () => {
  const rendererHtml = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  const normalizedHtml = rendererHtml.replace(/\s+/g, ' ');
  const expectedHint = 'Stored locally on this Mac, using Keychain when available or ~/.crate/figma-token with owner-only permissions. Crate uses it only to request your Figma files and assets from Figma.';
  const staleClaim = /never leaves\s+your computer/i;

  assert.equal(normalizedHtml.includes(expectedHint), true);
  assert.equal(staleClaim.test(rendererHtml), false);
});

test('storeToken hardens existing fallback token file permissions without logging token contents', async () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-figma-token-privacy-'));
  const crateDir = path.join(tempHome, '.crate');
  const tokenPath = path.join(crateDir, 'figma-token');
  const oldToken = 'OLD_PUBLIC_TEST_TOKEN';
  const newToken = 'NEW_PRIVATE_TEST_TOKEN';

  try {
    fs.mkdirSync(crateDir, { recursive: true, mode: 0o755 });
    fs.chmodSync(crateDir, 0o755);
    fs.writeFileSync(tokenPath, oldToken, { mode: 0o644 });
    fs.chmodSync(tokenPath, 0o644);

    const FigmaParser = loadFigmaParserWithHome(tempHome);
    const parser = new FigmaParser();
    const { result, output } = await captureConsole(() => parser.storeToken(newToken));

    assert.equal(result, true);
    assert.equal(fs.readFileSync(tokenPath, 'utf8'), newToken);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(crateDir).mode & 0o777, 0o700);
      assert.equal(fs.statSync(tokenPath).mode & 0o777, 0o600);
    }
    assert.equal(output.includes(oldToken), false);
    assert.equal(output.includes(newToken), false);
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('_fetchAPI redacts network and status failures before throwing', async () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-figma-fetch-privacy-'));

  try {
    let mode = 'network';
    const fetchImpl = async (url) => {
      if (mode === 'network') {
        throw new Error(`${FIGMA_SENSITIVE_ERROR} ${url}`);
      }
      return {
        ok: false,
        status: 500,
        statusText: FIGMA_SENSITIVE_ERROR
      };
    };
    const FigmaParser = loadFigmaParserWithHome(tempHome, { fetchImpl });
    const parser = new FigmaParser();

    await assert.rejects(
      parser._fetchAPI('/files/FILEKEY?token=SHOULD_NOT_LEAK', 'SHOULD_NOT_LEAK'),
      (error) => {
        assert.match(error.message, /Figma API request failed/);
        assert.match(error.message, /file/);
        assertNoFigmaSecrets(error.message);
        return true;
      }
    );

    mode = 'status';
    await assert.rejects(
      parser._fetchAPI('/files/FILEKEY/metadata?token=SHOULD_NOT_LEAK', 'SHOULD_NOT_LEAK'),
      (error) => {
        assert.match(error.message, /Figma API request failed/);
        assert.match(error.message, /file metadata/);
        assert.match(error.message, /status 500/);
        assertNoFigmaSecrets(error.message);
        return true;
      }
    );
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('parser-level Figma logs and returned errors redact request details', async () => {
  const { FigmaParser } = require('../parsers/figma');

  class SensitiveParser extends FigmaParser {
    async getStoredToken() {
      return 'SHOULD_NOT_LEAK';
    }

    async verifyToken() {
      return { valid: true };
    }

    async _fetchAPI(endpoint) {
      if (endpoint === '/files/FILEKEY') {
        return {
          document: {
            id: '0:0',
            type: 'DOCUMENT',
            children: [{
              id: '1:1',
              type: 'CANVAS',
              name: 'Page',
              children: [{
                id: '2:1',
                type: 'RECTANGLE',
                name: 'Hero',
                fills: [{ type: 'IMAGE', imageRef: 'safe-image-ref' }],
                exportSettings: [{ format: 'PNG' }]
              }]
            }]
          }
        };
      }
      throw new Error(FIGMA_SENSITIVE_ERROR);
    }
  }

  const parser = new SensitiveParser();

  const metadata = await captureConsole(() => parser.getFileMetadata('FILEKEY'));
  assert.equal(metadata.result, null);
  assert.match(metadata.output, /getFileMetadata error/);
  assertNoFigmaSecrets(metadata.output);

  const discovery = await captureConsole(() => parser.discoverRecentFiles({ teamIds: ['TEAM123'] }));
  assert.match(discovery.output, /Cannot access team TEAM123/);
  assertNoFigmaSecrets(discovery.output);
  assertNoFigmaSecrets(JSON.stringify(discovery.result.errors));
  assert.match(JSON.stringify(discovery.result.errors), /Figma API request failed|redacted/);

  const extraction = await captureConsole(() => parser.extractAssetsFromFileKey('FILEKEY'));
  assertNoFigmaSecrets(extraction.output);
  assertNoFigmaSecrets(JSON.stringify(extraction.result.errors));
  assert.match(JSON.stringify(extraction.result.errors), /Image-fill recovery failed|Batch image export failed/);
});

test('autoTrackScan redacts aggregated parser extraction errors and warnings', async () => {
  const { FigmaParser } = require('../parsers/figma');

  class AggregatingParser extends FigmaParser {
    async verifyToken() {
      return { valid: true };
    }

    async discoverRecentFiles() {
      return {
        recentFiles: [{ key: 'FILEKEY', name: 'Tracked File', isTracked: true }],
        errors: [`Discovery warning ${FIGMA_SENSITIVE_ERROR}`]
      };
    }

    async extractAssetsFromFileKey() {
      return {
        assets: [],
        errors: [`Extraction error ${FIGMA_SENSITIVE_ERROR}`],
        warnings: [`Extraction warning ${FIGMA_SENSITIVE_ERROR}`],
        scope: {
          scopeMode: 'entire-file',
          lockStatus: 'entire-file',
          lockedPageId: null,
          lockedPageName: null,
          warning: `Scope warning ${FIGMA_SENSITIVE_ERROR}`
        }
      };
    }
  }

  const parser = new AggregatingParser();
  const { result, output } = await captureConsole(() => parser.autoTrackScan({ fileKeys: ['FILEKEY'] }));
  const returnedText = JSON.stringify({
    errors: result.errors,
    warnings: result.warnings,
    scopeEntries: result.scopeEntries
  });

  assertNoFigmaSecrets(output);
  assertNoFigmaSecrets(returnedText);
  assert.match(returnedText, /Discovery warning/);
  assert.match(returnedText, /Extraction error/);
  assert.match(returnedText, /Extraction warning/);
  assert.match(returnedText, /Scope warning/);
});
