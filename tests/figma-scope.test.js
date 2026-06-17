const test = require('node:test');
const assert = require('node:assert/strict');

const { FigmaParser } = require('../parsers/figma');

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
  assert.ok(result.errors.some(error => String(error).includes('Metadata fetch failed for tracked file Petra_logo-File_123')));

  const serialized = `${JSON.stringify(result)}\n${output}`;
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
  assert.match(output, /imageRefs found \(1\): img-ref-page-one/);
  assert.match(output, /image URLs resolved \(1\) for imageRefs: img-ref-page-one/);
  assert.equal(output.includes(result.assets[0].url), false);
  assert.equal(output.includes('https://'), false);
  assert.equal(/cdn\.figma\.example/i.test(output), false);
  assert.equal(/SIGNED_QUERY_TOKEN|Authorization|Bearer|cookie=/i.test(output), false);
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
  assert.match(result.scope.warning || '', /could not read the tracked Figma file/i);

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
