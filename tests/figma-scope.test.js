const test = require('node:test');
const assert = require('node:assert/strict');

const { FigmaParser } = require('../parsers/figma');

const FILE_KEY = 'FILE123';
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
  assert.match(result.scopeEntries[0].warning || '', /could not resolve the starting page/i);
});
