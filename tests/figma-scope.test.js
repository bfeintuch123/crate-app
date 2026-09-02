const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const { FigmaParser, parseFigmaRetryAfterMs } = require('../parsers/figma');
const { FIGMA_NETWORK_LIMITS, createByteBudget } = require('../parsers/figma-network');

const FILE_KEY = 'FILE123';

test('Figma asset dedup requires composite stable identity and fails closed for keyless records', () => {
  const parser = new FigmaParser();
  const keyless = [
    { name: 'Same', nodeId: '1:1', url: 'https://cdn.example/a.png' },
    { name: 'Same', nodeId: '1:1', url: 'https://cdn.example/a.png' },
  ];
  assert.equal(parser.deduplicateFigmaAssets(keyless).length, 2);

  const stable = [
    { name: 'Same', fileKey: 'FILE_A', nodeId: '1:1', url: 'https://cdn.example/a.png' },
    { name: 'Same', fileKey: 'FILE_A', nodeId: '1:1', url: 'https://cdn.example/a.png' },
    { name: 'Same', fileKey: 'FILE_B', nodeId: '1:1', url: 'https://cdn.example/a.png' },
  ];
  assert.equal(parser.deduplicateFigmaAssets(stable).length, 2);
});

test('Figma local names retain collision-safe identity entropy', () => {
  const parser = new FigmaParser();
  const first = parser.buildFigmaAssetName('Same Display Name', 'FILE_A\u00001:23');
  const second = parser.buildFigmaAssetName('Same Display Name', 'FILE_A\u000012:3');

  assert.notEqual(first, second);
  assert.match(first, /^[a-f0-9]{16}__/u);
  assert.match(second, /^[a-f0-9]{16}__/u);
});

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

function figmaApiResponse(status, payload = {}, headers = {}) {
  const normalizedHeaders = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [String(key).toLowerCase(), String(value)])
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return normalizedHeaders[String(name).toLowerCase()] || null;
      },
    },
    buffer: async () => Buffer.from(JSON.stringify(payload)),
  };
}

function createRequestRecordingParser(responseForRequest) {
  const parserPath = require.resolve('../parsers/figma');
  const cachedParserModule = require.cache[parserPath];
  const originalLoad = Module._load;
  const requests = [];
  const fetchRecorder = async (rawUrl, options = {}) => {
    const url = new URL(rawUrl);
    const endpoint = `${url.pathname}${url.search}`;
    requests.push(endpoint);
    return responseForRequest(endpoint, options);
  };

  delete require.cache[parserPath];
  Module._load = function(request, parent, isMain) {
    if (request === 'node-fetch') return fetchRecorder;
    return originalLoad.call(this, request, parent, isMain);
  };

  let RecordedFigmaParser;
  try {
    RecordedFigmaParser = require('../parsers/figma').FigmaParser;
  } finally {
    Module._load = originalLoad;
    delete require.cache[parserPath];
    if (cachedParserModule) require.cache[parserPath] = cachedParserModule;
  }

  return {
    parser: new class extends RecordedFigmaParser {
      async getStoredToken() {
        return 'token';
      }
    }(),
    requests,
  };
}

const DOCUMENT_FIXTURE = {
  id: '0:0',
  type: 'DOCUMENT',
  name: 'Fixture',
  children: [
    {
      id: '1:1',
      type: 'CANVAS',
      name: 'Page One',
      children: [
        {
          id: '2:1',
          type: 'RECTANGLE',
          name: 'Hero',
          fills: [{ type: 'IMAGE', imageRef: 'img-ref-page-one' }]
        }
      ]
    },
    {
      id: '1:2',
      type: 'CANVAS',
      name: 'Page Two',
      children: [
        {
          id: '2:2',
          type: 'RECTANGLE',
          name: 'Alt',
          fills: [{ type: 'IMAGE', imageRef: 'img-ref-page-two' }]
        }
      ]
    }
  ]
};

class StubFigmaParser extends FigmaParser {
  async getStoredToken() {
    return 'token';
  }

  async verifyToken() {
    return { valid: true, user: { id: '1', handle: 'tester', email: 'tester@example.com' } };
  }

  async discoverRecentFiles() {
    return {
      recentFiles: [
        {
          key: FILE_KEY,
          name: 'Fixture File',
          isTracked: true,
          trackedIndex: 0,
          lastModifiedMs: Date.now()
        }
      ],
      errors: []
    };
  }

  async _fetchAPI(endpoint) {
    this.requestedEndpoints = [...(this.requestedEndpoints || []), endpoint];
    if (endpoint === `/files/${FILE_KEY}` || endpoint.startsWith(`/files/${FILE_KEY}?`)) {
      return { document: DOCUMENT_FIXTURE };
    }
    if (endpoint === `/files/${FILE_KEY}/images`) {
      return {
        images: {
          'img-ref-page-one': 'https://cdn.example.com/page-one.png',
          'img-ref-page-two': 'https://cdn.example.com/page-two.png'
        }
      };
    }

    throw new Error(`Unexpected endpoint: ${endpoint}`);
  }
}

class SensitiveUrlFigmaParser extends StubFigmaParser {
  async _fetchAPI(endpoint) {
    if (endpoint === `/files/${FILE_KEY}/images`) {
      return {
        images: {
          'img-ref-page-one': 'https://cdn.figma.example/page-one.png?token=SIGNED_QUERY_TOKEN&Authorization=Bearer%20SECRET&cookie=session%3DSECRET'
        }
      };
    }

    return super._fetchAPI(endpoint);
  }
}

class AssetDiscoveryFailureFigmaParser extends StubFigmaParser {
  async _fetchAPI(endpoint) {
    if (endpoint === `/files/${FILE_KEY}/images` || endpoint.startsWith(`/images/${FILE_KEY}?`)) {
      throw new Error('Figma asset request failed.');
    }
    return super._fetchAPI(endpoint);
  }
}

const MODERN_FILE_KEY = 'Petra_logo-File_123';

class MetadataFailureFigmaParser extends FigmaParser {
  async getStoredToken() {
    return 'token';
  }

  async verifyToken() {
    return { valid: true, user: { id: '1', handle: 'tester', email: 'tester@example.com' } };
  }

  async _fetchAPI(endpoint) {
    if (
      endpoint === `/files/${MODERN_FILE_KEY}/metadata` ||
      endpoint === `/files/${MODERN_FILE_KEY}?depth=1`
    ) {
      throw new Error('metadata unavailable for https://figma.example/SHOULD_NOT_APPEAR');
    }

    if (endpoint === `/files/${MODERN_FILE_KEY}`) {
      return { document: DOCUMENT_FIXTURE };
    }

    if (endpoint === `/files/${MODERN_FILE_KEY}/images`) {
      return {
        images: {
          'img-ref-page-one': 'https://cdn.example.com/page-one.png',
          'img-ref-page-two': 'https://cdn.example.com/page-two.png'
        }
      };
    }

    throw new Error(`Unexpected endpoint: ${endpoint}`);
  }
}

class FileFetchFailureFigmaParser extends FigmaParser {
  async getStoredToken() {
    return 'token';
  }

  async _fetchAPI(endpoint) {
    if (endpoint === `/files/${FILE_KEY}`) {
      throw new Error('Figma file not found at https://figma.example/SHOULD_NOT_APPEAR');
    }
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  }
}

class RateLimitedFileFetchFigmaParser extends FigmaParser {
  async getStoredToken() {
    return 'token';
  }

  async _fetchAPI(endpoint) {
    if (endpoint === `/files/${FILE_KEY}`) {
      const error = new Error('Figma API rate limit exceeded at https://figma.example/SHOULD_NOT_APPEAR?token=SHOULD_NOT_APPEAR');
      error._crateFigmaApiFailureReason = 'rate-limited';
      error._crateFigmaApiRetryAfterMs = 90_000;
      throw error;
    }
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  }

  async verifyToken() {
    return { valid: true };
  }

  async getFileMetadata(fileKey, diagnostic) {
    diagnostic.metadataStatus = 'success';
    return {
      key: fileKey,
      name: 'Rate Limited Fixture',
      lastModified: new Date().toISOString(),
      lastModifiedMs: Date.now()
    };
  }
}

test('Retry-After parsing accepts bounded integer seconds only', () => {
  assert.equal(parseFigmaRetryAfterMs('90'), 90_000);
  assert.equal(parseFigmaRetryAfterMs(' 120 '), 120_000);
  assert.equal(parseFigmaRetryAfterMs('0'), null);
  assert.equal(parseFigmaRetryAfterMs('-1'), null);
  assert.equal(parseFigmaRetryAfterMs('1.5'), null);
  assert.equal(parseFigmaRetryAfterMs('Wed, 21 Oct 2030 07:28:00 GMT'), null);
  assert.equal(parseFigmaRetryAfterMs('999999999999999999999999'), null);
  assert.equal(parseFigmaRetryAfterMs(String(60 * 60 * 24 * 365)), 31 * 24 * 60 * 60 * 1000);
});

test('tracked-link preflight verifies file access and locks Current Page without asset discovery', async () => {
  const parser = new StubFigmaParser();
  const result = await parser.validateTrackedFileScope(FILE_KEY, {
    scopeMode: 'current-page',
    requestedPageId: '1:1',
    requestedNodeId: null,
  });

  assert.equal(result.valid, true);
  assert.deepEqual(result.scope, {
    scopeMode: 'current-page',
    lockStatus: 'locked',
    lockedPageId: '1:1',
    lockedPageName: 'Page One',
    statusReason: null,
  });
  assert.deepEqual(parser.requestedEndpoints, [`/files/${FILE_KEY}?ids=1%3A1&depth=1`]);
});

test('tracked-link preflight resolves a selected node to its enclosing page', async () => {
  const parser = new StubFigmaParser();
  const result = await parser.validateTrackedFileScope(FILE_KEY, {
    scopeMode: 'current-page',
    requestedPageId: null,
    requestedNodeId: '2:1',
  });

  assert.equal(result.valid, true);
  assert.equal(result.scope.lockedPageId, '1:1');
  assert.equal(result.scope.lockedPageName, 'Page One');
  assert.deepEqual(parser.requestedEndpoints, [`/files/${FILE_KEY}?ids=2%3A1&depth=1`]);
});

test('tracked-link preflight reports an unresolved requested page without fetching assets', async () => {
  const parser = new StubFigmaParser();
  const result = await parser.validateTrackedFileScope(FILE_KEY, {
    scopeMode: 'current-page',
    requestedPageId: '9:9',
    requestedNodeId: null,
  });

  assert.equal(result.valid, false);
  assert.equal(result.reason, 'figma-current-page-requested-page-not-found');
  assert.equal(result.scope.lockStatus, 'unresolved');
});

test('tracked-link preflight distinguishes a missing connection from a rejected credential', async () => {
  const disconnected = new class extends StubFigmaParser {
    async getStoredToken() { return null; }
  }();
  assert.deepEqual(
    await disconnected.validateTrackedFileScope(FILE_KEY, { scopeMode: 'entire-file' }),
    { valid: false, reason: 'not-connected' }
  );

  const rejected = new class extends StubFigmaParser {
    async _fetchAPI() {
      const error = new Error('safe rejection');
      error._crateFigmaApiStatus = 401;
      throw error;
    }
  }();
  assert.deepEqual(
    await rejected.validateTrackedFileScope(FILE_KEY, { scopeMode: 'entire-file' }),
    { valid: false, reason: 'invalid-token', retryAfterMs: null }
  );

  const unavailableCredentialStore = new class extends StubFigmaParser {
    async getStoredToken() {
      throw new Error('SHOULD_NOT_APPEAR_PRIVATE_CREDENTIAL_DETAIL');
    }
  }();
  assert.deepEqual(
    await unavailableCredentialStore.validateTrackedFileScope(FILE_KEY, { scopeMode: 'entire-file' }),
    { valid: false, reason: 'request-failed', retryAfterMs: null }
  );
});

test('metadata rate limiting skips the depth fallback request', async () => {
  const { parser, requests } = createRequestRecordingParser((endpoint) => {
    if (endpoint === `/v1/files/${FILE_KEY}/metadata`) {
      return figmaApiResponse(429, {}, { 'retry-after': '120' });
    }
    if (endpoint === `/v1/files/${FILE_KEY}?depth=1`) {
      return figmaApiResponse(200, { name: 'must-not-run' });
    }
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  });
  const diagnostic = { metadataStatus: 'not-attempted' };
  const apiBudget = createByteBudget(
    FIGMA_NETWORK_LIMITS.apiOperationBytes,
    FIGMA_NETWORK_LIMITS.apiOperationTimeoutMs
  );

  const result = await parser.getFileMetadata(FILE_KEY, diagnostic, apiBudget);

  assert.equal(result, null);
  assert.deepEqual(requests, [`/v1/files/${FILE_KEY}/metadata`]);
  assert.equal(diagnostic.metadataFailureReason, 'rate-limited');
  assert.equal(diagnostic.retryAfterMs, 120_000);
});

test('image-map rate limiting skips rendered-image fallback requests', async () => {
  const { parser, requests } = createRequestRecordingParser((endpoint) => {
    if (endpoint === `/v1/files/${FILE_KEY}`) {
      return figmaApiResponse(200, { document: DOCUMENT_FIXTURE });
    }
    if (endpoint === `/v1/files/${FILE_KEY}/images`) {
      return figmaApiResponse(429, {}, { 'retry-after': '180' });
    }
    if (endpoint.startsWith(`/v1/images/${FILE_KEY}?`)) {
      return figmaApiResponse(200, { images: {} });
    }
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  });
  const apiBudget = createByteBudget(
    FIGMA_NETWORK_LIMITS.apiOperationBytes,
    FIGMA_NETWORK_LIMITS.apiOperationTimeoutMs
  );
  const result = await parser.extractAssetsFromFileKey(FILE_KEY, {
    key: FILE_KEY,
    scopeMode: 'current-page',
    requestedNodeId: '2:1'
  }, apiBudget);

  assert.deepEqual(requests, [`/v1/files/${FILE_KEY}`, `/v1/files/${FILE_KEY}/images`]);
  assert.equal(result.assets.length, 0);
  assert.equal(result.scope.assetFetchStatus, 'failed');
  assert.equal(result.scope.retryAfterMs, 180_000);
});

test('rendered-export rate limiting stops later batches and discards partial assets', async () => {
  const fileKey = 'BATCH_FILE';
  const exportableNodes = Array.from({ length: 1001 }, (_, index) => ({
    id: `2:${index + 1}`,
    type: 'RECTANGLE',
    name: `Export ${index + 1}`,
    exportSettings: [{ format: 'PNG' }],
  }));
  const document = {
    id: '0:0',
    type: 'DOCUMENT',
    name: 'Batch Fixture',
    children: [{
      id: '1:1',
      type: 'CANVAS',
      name: 'Batch Page',
      children: exportableNodes,
    }],
  };
  let renderedBatchCount = 0;
  const { parser, requests } = createRequestRecordingParser((endpoint) => {
    if (endpoint === '/v1/me') {
      return figmaApiResponse(200, { id: 'tester', handle: 'tester', email: 'tester@example.com' });
    }
    if (endpoint === `/v1/files/${fileKey}/metadata`) {
      return figmaApiResponse(200, {
        name: 'Batch Fixture',
        lastModified: new Date().toISOString(),
      });
    }
    if (endpoint === `/v1/files/${fileKey}`) {
      return figmaApiResponse(200, { document });
    }
    if (endpoint.startsWith(`/v1/images/${fileKey}?`)) {
      renderedBatchCount += 1;
      if (renderedBatchCount === 2) {
        return figmaApiResponse(429, {}, { 'retry-after': '360' });
      }
      if (renderedBatchCount > 2) {
        throw new Error('Rendered export request continued after rate limiting.');
      }
      const ids = new URLSearchParams(endpoint.split('?')[1]).get('ids').split(',');
      return figmaApiResponse(200, {
        images: Object.fromEntries(
          ids.map((id) => [id, `https://cdn.example.com/${encodeURIComponent(id)}.png`])
        ),
      });
    }
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  });

  const result = await parser.autoTrackScan({
    fileKeys: [fileKey],
    scopeEntries: [{
      key: fileKey,
      primaryKey: fileKey,
      scopeMode: 'entire-file',
    }],
  });

  const renderedRequests = requests.filter((endpoint) => endpoint.startsWith(`/v1/images/${fileKey}?`));
  assert.equal(renderedRequests.length, 2);
  assert.equal(renderedBatchCount, 2);
  assert.deepEqual(requests.slice(requests.indexOf(renderedRequests[1]) + 1), []);
  assert.equal(result.rateLimited, true);
  assert.equal(result.retryAfterMs, 360_000);
  assert.equal(result.assets.length, 0);
});

test('multi-candidate scan stops after the first rate limit and discards partial assets', async () => {
  const fileKeys = ['SUCCESS_FIRST', 'RATE_SECOND', 'MUST_NOT_RUN'];
  const { parser, requests } = createRequestRecordingParser((endpoint) => {
    if (endpoint === '/v1/me') {
      return figmaApiResponse(200, { id: 'tester', handle: 'tester', email: 'tester@example.com' });
    }
    const metadataMatch = endpoint.match(/^\/v1\/files\/([^/?]+)\/metadata$/);
    if (metadataMatch) {
      return figmaApiResponse(200, {
        name: `Tracked ${metadataMatch[1]}`,
        lastModified: new Date().toISOString(),
      });
    }
    if (endpoint === '/v1/files/SUCCESS_FIRST') {
      return figmaApiResponse(200, { document: DOCUMENT_FIXTURE });
    }
    if (endpoint === '/v1/files/SUCCESS_FIRST/images') {
      return figmaApiResponse(200, {
        images: {
          'img-ref-page-one': 'https://cdn.example.com/partial.png',
        },
      });
    }
    if (endpoint === '/v1/files/RATE_SECOND') {
      return figmaApiResponse(429, {}, { 'retry-after': '240' });
    }
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  });
  const result = await parser.autoTrackScan({
    fileKeys,
    scopeEntries: fileKeys.map((key) => ({
      key,
      primaryKey: key,
      scopeMode: 'current-page',
      requestedPageId: '1:1',
      requestedNodeId: '1:1',
    }))
  });

  const rateLimitRequestIndex = requests.indexOf('/v1/files/RATE_SECOND');
  assert.ok(rateLimitRequestIndex >= 0);
  assert.deepEqual(requests.slice(rateLimitRequestIndex + 1), []);
  assert.equal(requests.includes('/v1/files/MUST_NOT_RUN'), false);
  assert.equal(result.rateLimited, true);
  assert.equal(result.retryAfterMs, 240_000);
  assert.equal(result.assets.length, 0);
  assert.equal(result.scopeEntries.length, 2);
});

class AllCandidateFailureFigmaParser extends FigmaParser {
  async getStoredToken() {
    return 'token';
  }

  async verifyToken() {
    return { valid: true, user: { id: '1', handle: 'tester', email: 'tester@example.com' } };
  }

  async _fetchAPI(endpoint) {
    if (endpoint.includes('/metadata') || endpoint.includes('depth=1')) {
      throw new Error('metadata denied for https://figma.example/SHOULD_NOT_APPEAR?token=SHOULD_NOT_APPEAR');
    }
    if (/^\/files\/[^/?]+$/.test(endpoint)) {
      throw new Error('file fetch denied for https://figma.example/SHOULD_NOT_APPEAR Authorization=Bearer SHOULD_NOT_APPEAR');
    }
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  }
}

class EmptyPageFigmaParser extends StubFigmaParser {
  async _fetchAPI(endpoint) {
    if (endpoint === `/files/${FILE_KEY}`) {
      return {
        document: {
          id: '0:0',
          type: 'DOCUMENT',
          name: 'Empty Fixture',
          children: [
            {
              id: '1:1',
              type: 'CANVAS',
              name: 'Page One',
              children: [
                {
                  id: '2:1',
                  type: 'RECTANGLE',
                  name: 'Plain Shape',
                  fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }]
                }
              ]
            }
          ]
        }
      };
    }
    return super._fetchAPI(endpoint);
  }
}

test('Figma URL parsing preserves modern keys and page or node scope params', () => {
  const designUrl = 'https://www.figma.com/design/Petra_logo-File_123/Petra-Logo?node-id=2-1&t=abc';
  const hashUrl = 'https://www.figma.com/file/HashKey_456/Petra#node-id=2-1';
  const desktopUrl = 'figma://design/Desktop-Key_789/Petra?pageId=1-1';
  const desktopHostUrl = 'figma://www.figma.com/design/DesktopHost-Key_123/Petra?page-id=1-1&node-id=2-1';
  const nestedUrl = 'figma://open?url=https%3A%2F%2Fwww.figma.com%2Fdesign%2FNested-Key_123%2FPetra%3Fnode-id%3D2-1%26t%3Dabc';
  const designWithConflictingParamUrl = 'https://www.figma.com/design/Petra_logo-File_123/Petra-Logo?node-id=2-1&file-key=Wrong-File_456';
  const prototypeWithNestedDesignUrl = 'figma://open?url=https%3A%2F%2Fwww.figma.com%2Fproto%2FPrototype-Route_123%2FPetra%3Fnode-id%3D2-1%26redirect%3Dhttps%253A%252F%252Fwww.figma.com%252Fdesign%252FPetra_logo-File_123%252FPetra%253Fnode-id%253D2-1';
  const prototypeWithFileKeyParamUrl = 'figma://open?url=https%3A%2F%2Fwww.figma.com%2Fproto%2FPrototype-Route_456%2FPetra%3Fnode-id%3D2-1%26file-key%3DPetra_logo-File_123';
  const openUrlWithFileIdParam = 'figma://open?file-id=Petra_logo-File_123&node-id=2-1';
  const prototypeWithAmbiguousFileIdUrl = 'https://www.figma.com/proto/Prototype-Route_789/Petra?node_id=2-1&file-id=Desktop-File_Id';
  const embedUrl = 'https://embed.figma.com/design/Embedded-Key_123/Petra?node-id=2-1&embed-host=share';

  assert.equal(FigmaParser.extractFileKey(designUrl), 'Petra_logo-File_123');
  assert.deepEqual(FigmaParser.parseScopeFromTrackedUrl(designUrl), {
    fileKey: 'Petra_logo-File_123',
    requestedPageId: null,
    requestedNodeId: '2:1',
  });
  assert.deepEqual(FigmaParser.parseScopeFromTrackedUrl(hashUrl), {
    fileKey: 'HashKey_456',
    requestedPageId: null,
    requestedNodeId: '2:1',
  });
  assert.deepEqual(FigmaParser.parseScopeFromTrackedUrl(desktopUrl), {
    fileKey: 'Desktop-Key_789',
    requestedPageId: '1:1',
    requestedNodeId: null,
  });
  assert.deepEqual(FigmaParser.parseScopeFromTrackedUrl(desktopHostUrl), {
    fileKey: 'DesktopHost-Key_123',
    requestedPageId: '1:1',
    requestedNodeId: '2:1',
  });
  assert.deepEqual(FigmaParser.parseScopeFromTrackedUrl(nestedUrl), {
    fileKey: 'Nested-Key_123',
    requestedPageId: null,
    requestedNodeId: '2:1',
  });
  assert.deepEqual(FigmaParser.parseScopeFromTrackedUrl(designWithConflictingParamUrl), {
    fileKey: 'Petra_logo-File_123',
    requestedPageId: null,
    requestedNodeId: '2:1',
  });
  assert.deepEqual(FigmaParser.parseScopeFromTrackedUrl(prototypeWithNestedDesignUrl), {
    fileKey: 'Petra_logo-File_123',
    requestedPageId: null,
    requestedNodeId: '2:1',
  });
  assert.deepEqual(FigmaParser.parseScopeFromTrackedUrl(prototypeWithFileKeyParamUrl), {
    fileKey: 'Petra_logo-File_123',
    requestedPageId: null,
    requestedNodeId: '2:1',
  });
  assert.deepEqual(FigmaParser.parseScopeFromTrackedUrl(openUrlWithFileIdParam), {
    fileKey: 'Petra_logo-File_123',
    requestedPageId: null,
    requestedNodeId: '2:1',
  });
  assert.deepEqual(FigmaParser._figmaFileKeyCandidates(prototypeWithAmbiguousFileIdUrl), [
    'Prototype-Route_789',
    'Desktop-File_Id',
  ]);
  assert.deepEqual(
    FigmaParser._figmaFileKeyCandidateDetails(prototypeWithAmbiguousFileIdUrl).map(candidate => ({
      key: candidate.key,
      source: candidate.source
    })),
    [
      { key: 'Prototype-Route_789', source: 'prototype-route' },
      { key: 'Desktop-File_Id', source: 'ambiguous-file-id-param' },
    ]
  );
  assert.deepEqual(FigmaParser.parseScopeFromTrackedUrl(prototypeWithAmbiguousFileIdUrl), {
    fileKey: 'Prototype-Route_789',
    requestedPageId: null,
    requestedNodeId: '2:1',
  });
  assert.deepEqual(FigmaParser.parseScopeFromTrackedUrl(embedUrl), {
    fileKey: 'Embedded-Key_123',
    requestedPageId: null,
    requestedNodeId: '2:1',
  });
});

test('metadata failure does not block direct tracked current-page extraction', async () => {
  const parser = new MetadataFailureFigmaParser();

  const { result, output } = await captureConsole(() => parser.autoTrackScan({
    fileKeys: [MODERN_FILE_KEY],
    scopeEntries: [{
      key: MODERN_FILE_KEY,
      scopeMode: 'current-page',
      requestedNodeId: '2:1'
    }]
  }));

  assert.equal(result.files.length, 1);
  assert.equal(result.assets.length, 1);
  assert.equal(result.assets[0].figmaPageId, '1:1');
  assert.equal(result.scopeEntries.length, 1);
  assert.equal(result.scopeEntries[0].lockStatus, 'locked');
  assert.equal(result.scopeEntries[0].lockedPageName, 'Page One');
  assert.ok(result.errors.some(error => String(error).includes(
    'Metadata fetch failed for a tracked Figma file; proceeding to extraction anyway.'
  )));

  const serialized = `${JSON.stringify(result)}\n${output}`;
  const diagnosticText = `${JSON.stringify(result.errors)}\n${output}`;
  assert.equal(diagnosticText.includes(MODERN_FILE_KEY), false);
  assert.equal(serialized.includes('SHOULD_NOT_APPEAR'), false);
  assert.equal(serialized.includes('https://figma.example'), false);
});

test('metadata failure does not block nested desktop URL current-page extraction', async () => {
  const parser = new MetadataFailureFigmaParser();
  const trackedUrl = 'figma://open?url=https%3A%2F%2Fwww.figma.com%2Fdesign%2FPetra_logo-File_123%2FPetra-Logo%3Fnode-id%3D2-1%26t%3Dabc';
  const parsedScope = FigmaParser.parseScopeFromTrackedUrl(trackedUrl);

  const result = await parser.autoTrackScan({
    fileKeys: [parsedScope.fileKey],
    scopeEntries: [{
      key: parsedScope.fileKey,
      scopeMode: 'current-page',
      requestedNodeId: parsedScope.requestedNodeId
    }]
  });

  assert.equal(parsedScope.fileKey, MODERN_FILE_KEY);
  assert.equal(parsedScope.requestedNodeId, '2:1');
  assert.equal(result.assets.length, 1);
  assert.equal(result.scopeEntries[0].lockStatus, 'locked');
  assert.equal(result.scopeEntries[0].lockedPageName, 'Page One');
});

test('metadata failure does not block prototype desktop URL with canonical file key extraction', async () => {
  const parser = new MetadataFailureFigmaParser();
  const trackedUrl = 'figma://open?url=https%3A%2F%2Fwww.figma.com%2Fproto%2FPrototype-Route_123%2FPetra%3Fnode-id%3D2-1%26file-key%3DPetra_logo-File_123%26t%3Dabc';
  const parsedScope = FigmaParser.parseScopeFromTrackedUrl(trackedUrl);

  const { result, output } = await captureConsole(() => parser.autoTrackScan({
    fileKeys: [parsedScope.fileKey],
    scopeEntries: [{
      key: parsedScope.fileKey,
      scopeMode: 'current-page',
      requestedNodeId: parsedScope.requestedNodeId
    }]
  }));

  assert.equal(parsedScope.fileKey, MODERN_FILE_KEY);
  assert.equal(parsedScope.requestedNodeId, '2:1');
  assert.equal(result.assets.length, 1);
  assert.equal(result.scopeEntries[0].lockStatus, 'locked');
  assert.equal(result.scopeEntries[0].lockedPageName, 'Page One');
  assert.equal(result.candidateDiagnostics.candidateCount, 1);
  assert.equal(result.candidateDiagnostics.metadataStatusCounts.failed, 1);
  assert.equal(result.candidateDiagnostics.metadataFailureReasonCounts['request-failed'], 1);
  assert.equal(result.candidateDiagnostics.fileFetchStatusCounts.success, 1);
  assert.equal(result.candidateDiagnostics.lockStatusCounts.locked, 1);
  assert.equal(result.candidateDiagnostics.assetResultCounts.withAssets, 1);

  const serialized = `${JSON.stringify(result)}\n${output}`;
  assert.equal(serialized.includes('figma://open'), false);
  assert.equal(serialized.includes('Prototype-Route_123'), false);
});

test('all current-page candidate failures surface privacy-safe diagnostics', async () => {
  const parser = new AllCandidateFailureFigmaParser();

  const { result, output } = await captureConsole(() => parser.autoTrackScan({
    fileKeys: ['Prototype-Route_123', MODERN_FILE_KEY],
    scopeEntries: [
      {
        key: 'Prototype-Route_123',
        scopeMode: 'current-page',
        requestedNodeId: '2:1',
        candidateSource: 'prototype-route',
        isCandidateFallback: false
      },
      {
        key: MODERN_FILE_KEY,
        scopeMode: 'current-page',
        requestedNodeId: '2:1',
        candidateSource: 'canonical-param',
        isCandidateFallback: true
      }
    ]
  }));

  assert.equal(result.files.length, 2);
  assert.equal(result.assets.length, 0);
  assert.equal(result.candidateDiagnostics.candidateCount, 2);
  assert.equal(result.candidateDiagnostics.candidateStrategyCounts.primary, 1);
  assert.equal(result.candidateDiagnostics.candidateStrategyCounts.fallback, 1);
  assert.equal(result.candidateDiagnostics.candidateSourceCounts['prototype-route'], 1);
  assert.equal(result.candidateDiagnostics.candidateSourceCounts['canonical-param'], 1);
  assert.equal(result.candidateDiagnostics.parsedScopeCounts.withPageOrNode, 2);
  assert.equal(result.candidateDiagnostics.metadataStatusCounts.failed, 2);
  assert.equal(result.candidateDiagnostics.metadataFailureReasonCounts['access-denied'], 2);
  assert.equal(result.candidateDiagnostics.fileFetchStatusCounts.failed, 2);
  assert.equal(result.candidateDiagnostics.fileFetchFailureReasonCounts['access-denied'], 2);
  assert.equal(result.candidateDiagnostics.lockStatusCounts.unresolved, 2);
  assert.equal(
    result.candidateDiagnostics.statusReasonCounts['figma-current-page-prototype-link-file-fetch-failed'],
    1
  );
  assert.equal(
    result.candidateDiagnostics.statusReasonCounts['figma-current-page-file-fetch-failed'],
    1
  );
  assert.equal(result.candidateDiagnostics.assetResultCounts.withoutAssets, 2);

  const serialized = `${JSON.stringify(result)}\n${output}`;
  assert.equal(serialized.includes('https://figma.example'), false);
  assert.equal(serialized.includes('SHOULD_NOT_APPEAR'), false);
  assert.equal(serialized.includes('Authorization'), false);
  assert.equal(serialized.includes('Bearer'), false);
  assert.equal(serialized.includes('figma://open'), false);
});

test('current-page node lock extracts only the locked page assets', async () => {
  const parser = new StubFigmaParser();

  const result = await parser.extractAssetsFromFileKey(FILE_KEY, {
    key: FILE_KEY,
    scopeMode: 'current-page',
    requestedNodeId: '2:1'
  });

  assert.equal(result.assets.length, 1);
  assert.equal(result.assets[0].figmaPageId, '1:1');
  assert.equal(result.assets[0].figmaPageName, 'Page One');
  assert.equal(result.scope.lockStatus, 'locked');
  assert.equal(result.scope.lockedPageId, '1:1');
});

test('entire-file scope still includes assets from multiple pages', async () => {
  const parser = new StubFigmaParser();

  const result = await parser.extractAssetsFromFileKey(FILE_KEY, {
    key: FILE_KEY,
    scopeMode: 'entire-file'
  });

  assert.equal(result.assets.length, 2);
  assert.deepEqual(
    result.assets.map(asset => asset.imageRef).sort(),
    ['img-ref-page-one', 'img-ref-page-two']
  );
});

test('figma image resolution logs omit raw CDN URLs and signed query material', async () => {
  const parser = new SensitiveUrlFigmaParser();

  const { result, output } = await captureConsole(() => parser.extractAssetsFromFileKey(FILE_KEY, {
    key: FILE_KEY,
    scopeMode: 'current-page',
    requestedNodeId: '2:1'
  }));

  assert.equal(result.assets.length, 1);
  assert.match(result.assets[0].url, /^https:\/\/cdn\.figma\.example\//);
  assert.match(output, /imageRefs found \(1\)/);
  assert.match(output, /image URLs resolved \(1\)/);
  assert.equal(output.includes('img-ref-page-one'), false);
  assert.equal(output.includes(result.assets[0].url), false);
  assert.equal(output.includes('https://'), false);
  assert.equal(/cdn\.figma\.example/i.test(output), false);
  assert.equal(/SIGNED_QUERY_TOKEN|Authorization|Bearer|cookie=/i.test(output), false);
});

test('asset-discovery API failures remain distinct from a successful file read', async () => {
  const parser = new AssetDiscoveryFailureFigmaParser();
  const result = await parser.extractAssetsFromFileKey(FILE_KEY, {
    key: FILE_KEY,
    scopeMode: 'current-page',
    requestedNodeId: '2:1'
  });

  assert.equal(result.assets.length, 0);
  assert.equal(result.scope.fileFetchStatus, 'success');
  assert.equal(result.scope.assetFetchStatus, 'failed');
  assert.match(result.errors.join(' '), /asset request failed/i);
});

const DEPS_FILE_KEY = 'FILE_DEPS';
const DEPS_DOCUMENT_FIXTURE = {
  id: '0:0',
  type: 'DOCUMENT',
  name: 'Deps Fixture',
  children: [
    {
      id: '10:1',
      type: 'CANVAS',
      name: 'Locked Page',
      children: [
        {
          id: '11:1',
          type: 'RECTANGLE',
          name: 'Local Image',
          fills: [{ type: 'IMAGE', imageRef: 'img-locked-local' }]
        },
        {
          id: '11:2',
          type: 'INSTANCE',
          name: 'Hero Instance',
          componentId: '20:1'
        },
        {
          id: '11:3',
          type: 'INSTANCE',
          name: 'Card Instance',
          componentId: '20:2'
        },
        {
          id: '11:4',
          type: 'INSTANCE',
          name: 'Swap Instance',
          componentId: '20:3',
          componentProperties: {
            'icon#1': { type: 'INSTANCE_SWAP', value: '20:5' }
          }
        }
      ]
    },
    {
      id: '10:2',
      type: 'CANVAS',
      name: 'Components',
      children: [
        {
          id: '20:1',
          type: 'COMPONENT',
          name: 'Hero Component',
          fills: [{ type: 'IMAGE', imageRef: 'img-shared-hero' }]
        },
        {
          id: '20:2',
          type: 'COMPONENT',
          name: 'Card Component',
          children: [
            {
              id: '21:1',
              type: 'INSTANCE',
              name: 'Nested Inner',
              componentId: '20:4'
            }
          ]
        },
        {
          id: '20:3',
          type: 'COMPONENT',
          name: 'Swap Host Component'
        },
        {
          id: '20:4',
          type: 'COMPONENT',
          name: 'Nested Component',
          fills: [{ type: 'IMAGE', imageRef: 'img-nested-component' }]
        },
        {
          id: '20:5',
          type: 'COMPONENT',
          name: 'Swapped Component',
          fills: [{ type: 'IMAGE', imageRef: 'img-swapped-component' }]
        },
        {
          id: '20:99',
          type: 'COMPONENT',
          name: 'Unused Component',
          fills: [{ type: 'IMAGE', imageRef: 'img-unused-component' }]
        }
      ]
    },
    {
      id: '10:3',
      type: 'CANVAS',
      name: 'Unrelated Page',
      children: [
        {
          id: '30:1',
          type: 'RECTANGLE',
          name: 'Unrelated',
          fills: [{ type: 'IMAGE', imageRef: 'img-unrelated-page' }]
        }
      ]
    }
  ]
};

class DepsStubFigmaParser extends FigmaParser {
  async getStoredToken() {
    return 'token';
  }

  async verifyToken() {
    return { valid: true, user: { id: '1', handle: 'tester', email: 'tester@example.com' } };
  }

  async discoverRecentFiles() {
    return {
      recentFiles: [
        {
          key: DEPS_FILE_KEY,
          name: 'Deps Fixture File',
          isTracked: true,
          trackedIndex: 0,
          lastModifiedMs: Date.now()
        }
      ],
      errors: []
    };
  }

  async _fetchAPI(endpoint) {
    if (endpoint === `/files/${DEPS_FILE_KEY}`) {
      return { document: DEPS_DOCUMENT_FIXTURE };
    }
    if (endpoint === `/files/${DEPS_FILE_KEY}/images`) {
      return {
        images: {
          'img-locked-local': 'https://cdn.example.com/locked-local.png',
          'img-shared-hero': 'https://cdn.example.com/shared-hero.png',
          'img-nested-component': 'https://cdn.example.com/nested.png',
          'img-swapped-component': 'https://cdn.example.com/swapped.png',
          'img-unused-component': 'https://cdn.example.com/unused.png',
          'img-unrelated-page': 'https://cdn.example.com/unrelated.png'
        }
      };
    }

    throw new Error(`Unexpected endpoint: ${endpoint}`);
  }
}

test('current-page scope follows component dependencies reachable from the locked page', async () => {
  const parser = new DepsStubFigmaParser();

  const result = await parser.extractAssetsFromFileKey(DEPS_FILE_KEY, {
    key: DEPS_FILE_KEY,
    scopeMode: 'current-page',
    requestedPageId: '10:1'
  });

  const refs = result.assets.map(asset => asset.imageRef).sort();
  assert.deepEqual(refs, [
    'img-locked-local',
    'img-nested-component',
    'img-shared-hero',
    'img-swapped-component'
  ]);

  for (const asset of result.assets) {
    assert.equal(asset.figmaPageId, '10:1');
    assert.equal(asset.figmaPageName, 'Locked Page');
  }

  assert.equal(refs.includes('img-unrelated-page'), false);
  assert.equal(refs.includes('img-unused-component'), false);
});

test('unresolved current-page lock never widens to entire-file', async () => {
  const parser = new StubFigmaParser();

  const result = await parser.autoTrackScan({
    fileKeys: [FILE_KEY],
    scopeEntries: [
      {
        key: FILE_KEY,
        scopeMode: 'current-page',
        requestedPageId: '9:9'
      }
    ]
  });

  assert.equal(result.assets.length, 0);
  assert.equal(result.scopeEntries.length, 1);
  assert.equal(result.scopeEntries[0].lockStatus, 'unresolved');
  assert.equal(result.scopeEntries[0].statusReason, 'figma-current-page-requested-page-not-found');
  assert.match(result.scopeEntries[0].warning || '', /could not find the requested page/i);
  assert.equal((result.scopeEntries[0].warning || '').includes('9:9'), false);
});

test('current-page missing node id fails closed with a safe diagnostic', async () => {
  const parser = new StubFigmaParser();

  const result = await parser.autoTrackScan({
    fileKeys: [FILE_KEY],
    scopeEntries: [
      {
        key: FILE_KEY,
        scopeMode: 'current-page',
        requestedNodeId: '9:9'
      }
    ]
  });

  assert.equal(result.assets.length, 0);
  assert.equal(result.scopeEntries[0].lockStatus, 'unresolved');
  assert.equal(result.scopeEntries[0].statusReason, 'figma-current-page-requested-node-not-found');
  assert.match(result.scopeEntries[0].warning || '', /could not find the requested node/i);
  assert.equal((result.scopeEntries[0].warning || '').includes('9:9'), false);
});

test('current-page without page or node id fails closed with a safe diagnostic', async () => {
  const parser = new StubFigmaParser();

  const result = await parser.autoTrackScan({
    fileKeys: [FILE_KEY],
    scopeEntries: [
      {
        key: FILE_KEY,
        scopeMode: 'current-page'
      }
    ]
  });

  assert.equal(result.assets.length, 0);
  assert.equal(result.scopeEntries[0].lockStatus, 'unresolved');
  assert.equal(result.scopeEntries[0].statusReason, 'figma-current-page-no-page-or-node-param');
  assert.match(result.scopeEntries[0].warning || '', /could not find a page or node/i);
});

test('current-page file fetch failure surfaces a safe diagnostic before metadata errors', async () => {
  const parser = new FileFetchFailureFigmaParser();

  const { result, output } = await captureConsole(() => parser.extractAssetsFromFileKey(FILE_KEY, {
    key: FILE_KEY,
    scopeMode: 'current-page',
    requestedNodeId: '2:1'
  }));

  assert.equal(result.assets.length, 0);
  assert.equal(result.scope.lockStatus, 'unresolved');
  assert.equal(result.scope.statusReason, 'figma-current-page-file-fetch-failed');
  assert.equal(result.scope.fileFetchFailureReason, 'file-not-found');
  assert.match(result.scope.warning || '', /could not read the tracked Figma file/i);

  const serialized = `${JSON.stringify(result)}\n${output}`;
  assert.equal(serialized.includes('https://figma.example'), false);
  assert.equal(serialized.includes('SHOULD_NOT_APPEAR'), false);
});

test('current-page prototype candidate file fetch failure asks for a design file link safely', async () => {
  const parser = new FileFetchFailureFigmaParser();

  const { result, output } = await captureConsole(() => parser.extractAssetsFromFileKey(FILE_KEY, {
    key: FILE_KEY,
    scopeMode: 'current-page',
    requestedNodeId: '2:1',
    candidateSource: 'prototype-route'
  }));

  assert.equal(result.assets.length, 0);
  assert.equal(result.scope.lockStatus, 'unresolved');
  assert.equal(result.scope.statusReason, 'figma-current-page-prototype-link-file-fetch-failed');
  assert.equal(result.scope.fileFetchFailureReason, 'file-not-found');
  assert.match(result.scope.warning || '', /prototype link/i);
  assert.match(result.scope.warning || '', /design\/file link/i);

  const serialized = `${JSON.stringify(result)}\n${output}`;
  assert.equal(serialized.includes('https://figma.example'), false);
  assert.equal(serialized.includes('SHOULD_NOT_APPEAR'), false);
});

test('current-page rate-limited file fetch surfaces a safe retry warning', async () => {
  const parser = new RateLimitedFileFetchFigmaParser();

  const { result, output } = await captureConsole(() => parser.extractAssetsFromFileKey(FILE_KEY, {
    key: FILE_KEY,
    scopeMode: 'current-page',
    requestedNodeId: '2:1'
  }));

  assert.equal(result.assets.length, 0);
  assert.equal(result.scope.lockStatus, 'unresolved');
  assert.equal(result.scope.statusReason, 'figma-current-page-file-fetch-failed');
  assert.equal(result.scope.fileFetchFailureReason, 'rate-limited');
  assert.equal(result.scope.retryAfterMs, 90_000);
  assert.match(result.scope.warning || '', /rate limiting/i);
  assert.match(result.scope.warning || '', /retry after a cooldown/i);

  const serialized = `${JSON.stringify(result)}\n${output}`;
  assert.equal(serialized.includes('https://figma.example'), false);
  assert.equal(serialized.includes('SHOULD_NOT_APPEAR'), false);
  assert.equal(serialized.includes('Bearer'), false);
});

test('rate-limit retry timing survives the aggregate scan without raw response data', async () => {
  const parser = new RateLimitedFileFetchFigmaParser();
  const { result, output } = await captureConsole(() => parser.autoTrackScan({
    fileKeys: [FILE_KEY],
    scopeEntries: [{ key: FILE_KEY, scopeMode: 'current-page', requestedNodeId: '2:1' }]
  }));

  assert.equal(result.rateLimited, true);
  assert.equal(result.retryAfterMs, 90_000);
  assert.equal(result.candidateDiagnostics.retryAfterMs, 90_000);
  assert.equal(result.scopeEntries[0].retryAfterMs, 90_000);
  const serialized = `${JSON.stringify(result)}\n${output}`;
  assert.equal(serialized.includes('https://figma.example'), false);
  assert.equal(serialized.includes('SHOULD_NOT_APPEAR'), false);
});

test('current-page locked page with no exportable image refs reports zero image refs safely', async () => {
  const parser = new EmptyPageFigmaParser();

  const result = await parser.autoTrackScan({
    fileKeys: [FILE_KEY],
    scopeEntries: [
      {
        key: FILE_KEY,
        scopeMode: 'current-page',
        requestedNodeId: '2:1'
      }
    ]
  });

  assert.equal(result.assets.length, 0);
  assert.equal(result.scopeEntries[0].lockStatus, 'locked');
  assert.equal(result.scopeEntries[0].lockedPageName, 'Page One');
  assert.equal(result.scopeEntries[0].statusReason, 'figma-current-page-zero-image-refs');
  assert.match(result.scopeEntries[0].warning || '', /found no exportable image assets/i);
});
