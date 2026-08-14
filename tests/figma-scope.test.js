const test = require('node:test');
const assert = require('node:assert/strict');

const { FigmaParser, parseFigmaRetryAfterMs } = require('../parsers/figma');

const FILE_KEY = 'FILE123';

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
    if (endpoint === `/files/${FILE_KEY}`) {
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

function createRateLimitedParserError(retryAfterMs) {
  const error = new Error('Figma API rate limit exceeded at https://figma.example/SHOULD_NOT_APPEAR?token=SHOULD_NOT_APPEAR');
  error._crateFigmaApiFailureReason = 'rate-limited';
  error._crateFigmaApiRetryAfterMs = retryAfterMs;
  return error;
}

class MetadataRateLimitRequestRecorderParser extends FigmaParser {
  constructor() {
    super();
    this.requests = [];
  }

  async getStoredToken() {
    return 'token';
  }

  async _fetchAPI(endpoint) {
    this.requests.push(endpoint);
    if (endpoint === `/files/${FILE_KEY}/metadata`) throw createRateLimitedParserError(120_000);
    if (endpoint === `/files/${FILE_KEY}?depth=1`) return { name: 'must-not-run' };
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  }
}

class AssetRateLimitRequestRecorderParser extends FigmaParser {
  constructor() {
    super();
    this.requests = [];
  }

  async getStoredToken() {
    return 'token';
  }

  async _fetchAPI(endpoint) {
    this.requests.push(endpoint);
    if (endpoint === `/files/${FILE_KEY}`) return { document: DOCUMENT_FIXTURE };
    if (endpoint === `/files/${FILE_KEY}/images`) throw createRateLimitedParserError(180_000);
    if (endpoint.startsWith(`/images/${FILE_KEY}?`)) return { images: {} };
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  }
}

class MultiCandidateRateLimitRequestRecorderParser extends FigmaParser {
  constructor() {
    super();
    this.extractions = [];
  }

  async getStoredToken() {
    return 'token';
  }

  async verifyToken() {
    return { valid: true };
  }

  async getFileMetadata(fileKey, diagnostic) {
    diagnostic.metadataStatus = 'success';
    return {
      key: fileKey,
      name: `Tracked ${fileKey}`,
      lastModified: new Date().toISOString(),
      lastModifiedMs: Date.now()
    };
  }

  async extractAssetsFromFileKey(fileKey, scopeEntry) {
    this.extractions.push(fileKey);
    if (fileKey === 'RATE_SECOND') {
      return {
        assets: [],
        errors: ['Figma is temporarily rate limiting this scan.'],
        warnings: [],
        scope: {
          scopeMode: 'current-page',
          lockStatus: 'unresolved',
          lockedPageId: null,
          lockedPageName: null,
          statusReason: 'figma-current-page-file-fetch-failed',
          warning: null,
          fileFetchStatus: 'failed',
          fileFetchFailureReason: 'rate-limited',
          assetFetchStatus: 'not-attempted',
          retryAfterMs: 240_000
        }
      };
    }
    if (fileKey === 'MUST_NOT_RUN') throw new Error('third candidate must not run');
    return {
      assets: [{ url: 'https://cdn.example.com/partial.png', nodeId: 'partial', name: 'Partial', format: 'png' }],
      errors: [],
      warnings: [],
      scope: {
        scopeMode: scopeEntry.scopeMode,
        lockStatus: 'locked',
        lockedPageId: scopeEntry.requestedPageId,
        lockedPageName: 'Page One',
        statusReason: null,
        warning: null,
        fileFetchStatus: 'success',
        fileFetchFailureReason: null,
        assetFetchStatus: 'success',
        retryAfterMs: null
      }
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

test('metadata rate limiting skips the depth fallback request', async () => {
  const parser = new MetadataRateLimitRequestRecorderParser();
  const diagnostic = { metadataStatus: 'not-attempted' };

  const result = await parser.getFileMetadata(FILE_KEY, diagnostic, {});

  assert.equal(result, null);
  assert.deepEqual(parser.requests, [`/files/${FILE_KEY}/metadata`]);
  assert.equal(diagnostic.metadataFailureReason, 'rate-limited');
  assert.equal(diagnostic.retryAfterMs, 120_000);
});

test('image-map rate limiting skips rendered-image fallback requests', async () => {
  const parser = new AssetRateLimitRequestRecorderParser();
  const result = await parser.extractAssetsFromFileKey(FILE_KEY, {
    key: FILE_KEY,
    scopeMode: 'current-page',
    requestedNodeId: '2:1'
  }, {});

  assert.deepEqual(parser.requests, [`/files/${FILE_KEY}`, `/files/${FILE_KEY}/images`]);
  assert.equal(result.assets.length, 0);
  assert.equal(result.scope.assetFetchStatus, 'failed');
  assert.equal(result.scope.retryAfterMs, 180_000);
});

test('multi-candidate scan stops after the first rate limit and discards partial assets', async () => {
  const parser = new MultiCandidateRateLimitRequestRecorderParser();
  const fileKeys = ['SUCCESS_FIRST', 'RATE_SECOND', 'MUST_NOT_RUN'];
  const result = await parser.autoTrackScan({
    fileKeys,
    scopeEntries: fileKeys.map((key, index) => ({
      key,
      primaryKey: key,
      scopeMode: 'current-page',
      requestedPageId: `${index + 1}:1`
    }))
  });

  assert.deepEqual(parser.extractions, ['SUCCESS_FIRST', 'RATE_SECOND']);
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
