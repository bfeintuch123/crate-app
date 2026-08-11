const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const path = require('path');

function loadPreload({ getPathForFile }) {
  const originalLoad = Module._load;
  const exposed = new Map();
  const invocations = [];
  const preloadPath = path.resolve(__dirname, '..', 'preload.js');

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        contextBridge: {
          exposeInMainWorld(name, api) {
            exposed.set(name, api);
          },
        },
        ipcRenderer: {
          invoke(channel, ...args) {
            invocations.push({ channel, args });
            return Promise.resolve({ success: true });
          },
          on() {},
        },
        webUtils: { getPathForFile },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  delete require.cache[preloadPath];
  try {
    require(preloadPath);
  } finally {
    Module._load = originalLoad;
    delete require.cache[preloadPath];
  }

  return { bridge: exposed.get('crate'), invocations };
}

test('preload packages an operating-system-backed dropped file without a path-resolution bridge', async () => {
  const droppedFile = { name: 'Synthetic Deck.pptx' };
  const droppedPath = '/private/tmp/crate-synthetic/Synthetic Deck.pptx';
  const { bridge, invocations } = loadPreload({
    getPathForFile(file) {
      assert.equal(file, droppedFile);
      return droppedPath;
    },
  });

  assert.equal(typeof bridge.v2PackageDroppedFile, 'function');
  assert.deepEqual(await bridge.v2PackageDroppedFile(droppedFile), { success: true });
  assert.deepEqual(invocations, [{ channel: 'v2:package-file', args: [droppedPath] }]);
});

test('preload forwards Existing Assets decisions and authoritative Package Review bindings', async () => {
  const { bridge, invocations } = loadPreload({ getPathForFile: () => '' });
  const projectId = 'project-review';
  const outputPath = '/private/tmp/crate-synthetic-output';
  const reviewToken = '00000000-0000-4000-8000-000000000123';
  const fileIdentity = 'stable-file-identity';
  const fileRevision = 'stable-file-revision';

  await bridge.getFileVisual(projectId, fileIdentity, fileRevision);
  await bridge.setExistingAssetsDecision(projectId, 'skip');
  await bridge.preparePackageReview(projectId);
  await bridge.preparePackageReview(projectId, outputPath);
  await bridge.packageProject(projectId, outputPath, reviewToken);

  assert.deepEqual(invocations, [
    { channel: 'projects:get-file-visual', args: [projectId, fileIdentity, fileRevision] },
    { channel: 'projects:set-existing-assets-decision', args: [projectId, 'skip'] },
    { channel: 'projects:prepare-package-review', args: [projectId] },
    { channel: 'projects:prepare-package-review', args: [projectId, outputPath] },
    { channel: 'projects:package', args: [projectId, outputPath, reviewToken] },
  ]);
});

test('preload rejects a dropped file without an operating-system path', async () => {
  const { bridge, invocations } = loadPreload({
    getPathForFile() { return ''; },
  });

  assert.equal(typeof bridge.v2PackageDroppedFile, 'function');
  assert.deepEqual(await bridge.v2PackageDroppedFile({ name: 'Synthetic Deck.pptx' }), {
    error: 'file_unavailable',
  });
  assert.deepEqual(invocations, []);
});

test('preload fails safely when the dropped value is not a disk-backed File', async () => {
  const { bridge, invocations } = loadPreload({
    getPathForFile() { throw new TypeError('not a File'); },
  });

  assert.equal(typeof bridge.v2PackageDroppedFile, 'function');
  assert.deepEqual(await bridge.v2PackageDroppedFile({}), { error: 'file_unavailable' });
  assert.deepEqual(invocations, []);
});
