const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

function loadFigmaParser(options = {}) {
  const parserPath = require.resolve('../parsers/figma');
  const originalLoad = Module._load;
  delete require.cache[parserPath];

  Module._load = function loadWithStubs(request, parent, isMain) {
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

const COMPOUND_COOKIE_VALUE = 'opaqueRefreshValue123';
const JSON_COOKIE_VALUE = 'opaqueJsonValue456';
const JSON_AUTH_VALUE = 'opaqueAuthValue789';
const JSON_ACCESS_TOKEN_VALUE = 'opaqueAccessValue123';
const JSON_REFRESH_TOKEN_VALUE = 'opaqueRefreshToken456';
const JSON_CLIENT_SECRET_VALUE = 'opaqueClientSecret789';
const JSON_API_KEY_VALUE = 'opaqueApiKey246';
const JSON_AUTH_HEADER_VALUE = 'opaqueAuthHeader135';
const JSON_AUTHORIZATION_HEADER_VALUE = 'neutralOpaqueValue864';
const SPACED_PRIVATE_PATH = '/private/tmp/neutral client/file.fig';

const FIGMA_SENSITIVE_ERROR = [
  'request failed',
  'https://api.figma.com/v1/files/FILEKEY?token=SHOULD_NOT_LEAK',
  'https://cdn.figma.com/signed/path?token=SHOULD_NOT_LEAK',
  'Authorization: Bearer SHOULD_NOT_LEAK',
  'cookie=SHOULD_NOT_LEAK',
  'X-Figma-Token SHOULD_NOT_LEAK',
  `Cookie: sid=one; refresh=${COMPOUND_COOKIE_VALUE}; region=us-east`,
  `{"cookie":"${JSON_COOKIE_VALUE}","Authorization":"Bearer ${JSON_AUTH_VALUE}"}`,
  `{"accessToken":"${JSON_ACCESS_TOKEN_VALUE}","refresh_token":"${JSON_REFRESH_TOKEN_VALUE}","clientSecret":"${JSON_CLIENT_SECRET_VALUE}","apiKey":"${JSON_API_KEY_VALUE}","authHeader":"${JSON_AUTH_HEADER_VALUE}","authorizationHeader":"${JSON_AUTHORIZATION_HEADER_VALUE}"}`,
  '/Users/designer/private/client/file.fig',
  `"${SPACED_PRIVATE_PATH}"`,
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
  assert.equal(text.includes(COMPOUND_COOKIE_VALUE), false);
  assert.equal(text.includes(JSON_COOKIE_VALUE), false);
  assert.equal(text.includes(JSON_AUTH_VALUE), false);
  assert.equal(text.includes(JSON_ACCESS_TOKEN_VALUE), false);
  assert.equal(text.includes(JSON_REFRESH_TOKEN_VALUE), false);
  assert.equal(text.includes(JSON_CLIENT_SECRET_VALUE), false);
  assert.equal(text.includes(JSON_API_KEY_VALUE), false);
  assert.equal(text.includes(JSON_AUTH_HEADER_VALUE), false);
  assert.equal(text.includes(JSON_AUTHORIZATION_HEADER_VALUE), false);
  assert.equal(text.includes('/Users/designer/private/client/file.fig'), false);
  assert.equal(text.includes(SPACED_PRIVATE_PATH), false);
  assert.equal(text.includes('neutral client/file.fig'), false);
  assert.equal(text.includes('client/file.fig'), false);
}

test('shared Figma redactor removes compound JSON credential values', () => {
  const { redactUrlAndCredentialText } = require('../parsers/figma-redaction');
  const input = JSON.stringify({
    accessToken: JSON_ACCESS_TOKEN_VALUE,
    refresh_token: JSON_REFRESH_TOKEN_VALUE,
    clientSecret: JSON_CLIENT_SECRET_VALUE,
    apiKey: JSON_API_KEY_VALUE,
    authHeader: JSON_AUTH_HEADER_VALUE,
    authorizationHeader: JSON_AUTHORIZATION_HEADER_VALUE,
  });
  const output = redactUrlAndCredentialText(input);

  for (const forbidden of [
    JSON_ACCESS_TOKEN_VALUE,
    JSON_REFRESH_TOKEN_VALUE,
    JSON_CLIENT_SECRET_VALUE,
    JSON_API_KEY_VALUE,
    JSON_AUTH_HEADER_VALUE,
    JSON_AUTHORIZATION_HEADER_VALUE,
  ]) {
    assert.equal(output.includes(forbidden), false);
  }
  assert.match(output, /redacted-credential/);
});

test('shared Figma redactor removes complete private paths containing spaces or delimiters', () => {
  const { redactPrivatePathText } = require('../parsers/figma-redaction');
  const cases = [
    {
      input: 'Could not read /Users/synthetic/Private Project/file.fig while scanning project.',
      expected: 'Could not read [redacted-path]',
    },
    {
      input: 'Could not read /Volumes/Client Drive/Assets/hero image.psd; retry later.',
      expected: 'Could not read [redacted-path]',
    },
    {
      input: 'Could not read /private/tmp/QA Folder/file.ai (permission denied).',
      expected: 'Could not read [redacted-path]',
    },
    {
      input: 'Could not read /var/folders/qa/Client.v2 Assets/slide 1.pptx after extraction.',
      expected: 'Could not read [redacted-path]',
    },
    {
      input: "Could not read /Users/synthetic/Designer's Work/Client (Final)/hero.v2 final.fig after scanning.",
      expected: 'Could not read [redacted-path]',
    },
    {
      input: 'Could not read `/tmp/QA Folder/file name.fig` during scan.',
      expected: 'Could not read [redacted-path]',
    },
    {
      input: 'Could not read /private/var/QA Folder/file name.indd before packaging.',
      expected: 'Could not read [redacted-path]',
    },
    {
      input: 'Could not read /Users/synthetic/Private Project/Extensionless File while scanning.',
      expected: 'Could not read [redacted-path]',
    },
    {
      input: 'Paths /Users/synthetic/First Project/file.fig and /Volumes/Client Drive/second file.psd failed.',
      expected: 'Paths [redacted-path]',
    },
    {
      input: "ENOENT: open '/tmp/synthetic/Designer's Work/file.fig'",
      expected: 'ENOENT: open [redacted-path]',
    },
    {
      input: 'Could not read "/tmp/synthetic/Client "Final"/file.fig" while scanning.',
      expected: 'Could not read [redacted-path]',
    },
    {
      input: 'Could not read `/tmp/synthetic/Client `Final/file.fig` while scanning.',
      expected: 'Could not read [redacted-path]',
    },
    {
      input: 'Could not read /tmp/synthetic/Private\nProject/file.fig while scanning.',
      expected: 'Could not read [redacted-path]',
    },
    {
      input: 'Could not read /tmp/synthetic/Private\r\nProject/file.fig while scanning.',
      expected: 'Could not read [redacted-path]',
    },
    {
      input: 'Could not read /users/synthetic/Private Project/file.fig while scanning.',
      expected: 'Could not read [redacted-path]',
    },
    {
      input: 'Could not read /VOLUMES/Client Drive/file.fig while scanning.',
      expected: 'Could not read [redacted-path]',
    },
    {
      input: 'Could not read /PRIVATE/TMP/QA Folder/file.fig while scanning.',
      expected: 'Could not read [redacted-path]',
    },
    {
      input: 'Could not read /VAR/folders/qa/file.fig while scanning.',
      expected: 'Could not read [redacted-path]',
    },
  ];

  for (const { input, expected } of cases) {
    const output = redactPrivatePathText(input);
    assert.equal(output, expected);
    assert.equal(output.includes('Project/file.fig'), false);
    assert.equal(output.includes('Drive/Assets'), false);
    assert.equal(output.includes('QA Folder'), false);
    assert.equal(output.includes('Client.v2 Assets'), false);
    assert.equal(output.includes("Designer's Work"), false);
    assert.equal(output.includes('file name'), false);
    assert.equal(output.includes('Extensionless File'), false);
    assert.equal(output.includes('second file.psd'), false);
    assert.equal(output.includes("s Work/file.fig"), false);
    assert.equal(output.includes('Final/file.fig'), false);
  }
});

test('shared Figma redactor handles long ambiguous input without exposing a private suffix', () => {
  const { redactPrivatePathText } = require('../parsers/figma-redaction');
  const input = `${'prefix /UsersSynthetic segment '.repeat(5000)}`
    + 'Could not read /Users/synthetic/Private Project/hero.v2 final.fig after scanning.';
  const output = redactPrivatePathText(input);

  assert.equal(output.endsWith('Could not read [redacted-path]'), true);
  assert.equal(output.includes('Private Project'), false);
  assert.equal(output.includes('final.fig'), false);
});

test('renderer Figma token privacy hint accurately describes local storage and API usage', () => {
  const rendererHtml = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  const parserSource = fs.readFileSync(path.join(__dirname, '..', 'parsers', 'figma.js'), 'utf8');
  const normalizedHtml = rendererHtml.replace(/\s+/g, ' ');
  const expectedHint = 'Saved Figma connections are protected by macOS Keychain and stay on this Mac. Crate uses them only to request the Figma files and assets you link.';
  const staleClaim = /never leaves\s+your computer/i;

  assert.equal(normalizedHtml.includes(expectedHint), true);
  assert.equal(staleClaim.test(rendererHtml), false);
  assert.equal(normalizedHtml.includes('~/.crate/figma-token'), false);
  assert.equal(parserSource.includes('~/.crate/figma-token'), false);
  assert.equal(parserSource.includes('Or save to:'), false);
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
    const FigmaParser = loadFigmaParser({ fetchImpl });
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

test('verifyTokenCandidate validates before storage and returns only privacy-safe status', async () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-figma-candidate-token-'));
  const candidateToken = 'CANDIDATE_TOKEN_SHOULD_NOT_LEAK';

  try {
    let status = 200;
    const fetchImpl = async () => ({
      ok: status === 200,
      status,
      json: async () => ({ id: 'user-id', email: 'private@example.test' }),
    });
    const FigmaParser = loadFigmaParser({ fetchImpl });
    const parser = new FigmaParser();

    assert.deepEqual(await parser.verifyTokenCandidate(candidateToken), { valid: true });

    status = 401;
    const { result, output } = await captureConsole(() => parser.verifyTokenCandidate(candidateToken));
    assert.deepEqual(result, { valid: false, reason: 'invalid-token' });
    assert.equal(output.includes(candidateToken), false);
    assert.equal(JSON.stringify(result).includes(candidateToken), false);
    assert.equal(JSON.stringify(result).includes('private@example.test'), false);
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('verifyTokenCandidate rejects oversized input before a network request', async () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-figma-candidate-limit-'));
  let requestCount = 0;

  try {
    const FigmaParser = loadFigmaParser({
      fetchImpl: async () => {
        requestCount += 1;
        return { ok: true, status: 200, json: async () => ({}) };
      },
    });
    const parser = new FigmaParser();

    assert.deepEqual(
      await parser.verifyTokenCandidate('x'.repeat(8193)),
      { valid: false, reason: 'invalid-token' }
    );
    assert.equal(requestCount, 0);
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
  assert.match(discovery.output, /Cannot access the configured Figma team/);
  assert.equal(discovery.output.includes('TEAM123'), false);
  assertNoFigmaSecrets(discovery.output);
  assertNoFigmaSecrets(JSON.stringify(discovery.result.errors));
  assert.equal(JSON.stringify(discovery.result.errors).includes('TEAM123'), false);
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
        errors: [
          `Discovery warning ${FIGMA_SENSITIVE_ERROR}`,
          `Private path warning "${SPACED_PRIVATE_PATH}"`,
        ]
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
