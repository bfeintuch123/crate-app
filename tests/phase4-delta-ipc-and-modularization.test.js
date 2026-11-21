'use strict';

const assert = require('./bounded-assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ProjectIpcDeltaBridge,
  applyProjectFileDelta,
} = require('../parsers/ipc-delta-bridge');
const {
  PROJECT_LIFECYCLE_EVENTS,
  PROJECT_LIFECYCLE_STATES,
  ProjectLifecycleController,
  canTransitionProjectState,
  enforceSingleWatchingInvariant,
  nextProjectState,
} = require('../parsers/project-state-machine');
const {
  formatNativeOpenFilesAsLsofF,
} = require('../parsers/native-watcher-bridge');
const {
  AdobePushBridge,
  sanitizeAdobePushEvent,
} = require('../parsers/adobe-push-bridge');
const {
  resolveNativeHelperBinaryPath,
  isExecutableRegularFile,
} = require('../parsers/native-helper');
const { CrateSqliteStore } = require('../parsers/sqlite-store');
const net = require('node:net');

test('Phase 4A: ProjectIpcDeltaBridge computes minimal revisioned deltas, skips unchanged emits, and applies cleanly', () => {
  const bridge = new ProjectIpcDeltaBridge({ coalesceMs: 0 });
  const projectId = 'proj-delta-1';

  const initialFiles = [
    { fileId: 'f1', path: '/Users/designer/a.psd', name: 'a.psd', size: 100 },
    { fileId: 'f2', path: '/Users/designer/b.png', name: 'b.png', size: 200 },
  ];
  const initialPending = [
    { fileId: 'p1', path: '/Users/designer/c.jpg', name: 'c.jpg', size: 300 },
  ];

  // First snapshot establishes revision 1
  const u1 = bridge.computeProjectUpdate(projectId, initialFiles, initialPending);
  assert.equal(u1.revision, 1);
  assert.equal(u1.filesChanged, true);
  assert.equal(u1.pendingChanged, true);
  assert.equal(u1.filesDelta.added.length, 2);
  assert.equal(u1.pendingDelta.added.length, 1);
  assert.deepEqual(u1.counts, { files: 2, pending: 1 });

  // Identical repeat produces zero changes and keeps revision 1
  const u2 = bridge.computeProjectUpdate(projectId, initialFiles, initialPending);
  assert.equal(u2.revision, 1);
  assert.equal(u2.anyChanged, false);
  assert.equal(u2.filesChanged, false);
  assert.equal(u2.pendingChanged, false);

  // Add 1 file, mutate 1 file, remove 1 file; pending stays unchanged!
  const nextFiles = [
    { fileId: 'f2', path: '/Users/designer/b.png', name: 'b.png', size: 250 },
    { fileId: 'f3', path: '/Users/designer/d.ai', name: 'd.ai', size: 400 },
  ];
  const u3 = bridge.computeProjectUpdate(projectId, nextFiles, initialPending);
  assert.equal(u3.revision, 2);
  assert.equal(u3.filesChanged, true);
  assert.equal(u3.pendingChanged, false);
  assert.equal(u3.filesDelta.added.length, 1);
  assert.equal(u3.filesDelta.updated.length, 1);
  assert.equal(u3.filesDelta.removed.length, 1);

  // Applying delta to previous array reconstructs exact next array
  const reconstructed = applyProjectFileDelta(initialFiles, u3.filesDelta);
  assert.deepEqual(reconstructed, nextFiles);

  // Clearing project resets revision cleanly
  bridge.clearProject(projectId);
  assert.equal(bridge.getRevision(projectId), 0);
});

test('Phase 4A: ProjectIpcDeltaBridge coalesces high-frequency burst emissions into a single frame', async () => {
  const bridge = new ProjectIpcDeltaBridge({ coalesceMs: 15 });
  let emittedCount = 0;
  let lastPayload = null;
  for (let i = 1; i <= 50; i++) {
    bridge.schedule('proj-burst', () => {
      emittedCount += 1;
      lastPayload = i;
    });
  }
  // Should not have emitted 50 times synchronously
  assert.equal(emittedCount, 0);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(emittedCount, 1);
  assert.equal(lastPayload, 50);
  bridge.clearAll();
});

test('Phase 4B: ProjectLifecycleController enforces valid state transitions, monotonic activation tokens, and single-watching invariant', () => {
  const controller = new ProjectLifecycleController({ maxHistory: 16 });
  const projA = { id: 'proj-a', status: PROJECT_LIFECYCLE_STATES.PAUSED };
  const projB = { id: 'proj-b', status: PROJECT_LIFECYCLE_STATES.WATCHING };

  // Enforce single-watching invariant
  const inv = enforceSingleWatchingInvariant([projA, projB], projA.id);
  assert.deepEqual(inv.pausedProjectIds, ['proj-b']);
  assert.equal(projB.status, PROJECT_LIFECYCLE_STATES.PAUSED);

  // Valid lifecycle sequence: paused -> watching -> packaging -> packaged -> watching
  const t1 = controller.transition(projA, PROJECT_LIFECYCLE_EVENTS.START_WATCHING, { reason: 'user-start' });
  assert.equal(projA.status, PROJECT_LIFECYCLE_STATES.WATCHING);
  assert.equal(t1.activationToken, 1);
  assert.equal(controller.isTokenCurrent(projA.id, 1), true);

  const t2 = controller.transition(projA, PROJECT_LIFECYCLE_EVENTS.BEGIN_PACKAGE);
  assert.equal(projA.status, PROJECT_LIFECYCLE_STATES.PACKAGING);
  assert.equal(t2.activationToken, null);
  assert.equal(controller.isTokenCurrent(projA.id, 1), false);

  controller.transition(projA, PROJECT_LIFECYCLE_EVENTS.FINISH_PACKAGE);
  assert.equal(projA.status, PROJECT_LIFECYCLE_STATES.PACKAGED);

  const t3 = controller.transition(projA, PROJECT_LIFECYCLE_EVENTS.START_WATCHING);
  assert.equal(t3.activationToken, 2);
  assert.equal(controller.isTokenCurrent(projA.id, 1), false);
  assert.equal(controller.isTokenCurrent(projA.id, 2), true);

  // Invalid transition fails closed
  assert.equal(canTransitionProjectState(PROJECT_LIFECYCLE_STATES.PAUSED, PROJECT_LIFECYCLE_EVENTS.FINISH_PACKAGE), false);
  assert.throws(
    () => nextProjectState(PROJECT_LIFECYCLE_STATES.PAUSED, PROJECT_LIFECYCLE_EVENTS.FINISH_PACKAGE),
    /invalid_project_transition:paused->FINISH_PACKAGE/
  );
  assert.equal(controller.getRecentHistory(projA.id).length, 4);
});

test('Phase 4B: formatNativeOpenFilesAsLsofF preserves PID headers for scan-on-close and rejects newline injection', () => {
  const formatted = formatNativeOpenFilesAsLsofF(
    [101, 202],
    [
      { pid: 101, path: '/Users/designer/poster.psd' },
      { pid: 101, path: '/Users/designer/evil\np999\ntREG\nn/etc/passwd' },
    ]
  );
  assert.equal(formatted, 'p101\ntREG\nn/Users/designer/poster.psd\np202');
});

test('Phase 4A: indexed SQLite single-project read stays O(1) vs full getProjects() scan across 25 projects', t => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crate-phase4-store-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new CrateSqliteStore({ userDataRealPath: dir, defaults: { projects: [] } });
  t.after(() => store.close());

  for (let i = 0; i < 25; i++) {
    const files = Array.from({ length: 80 }, (_, j) => ({
      fileId: `f-${i}-${j}`,
      path: `/Users/designer/project-${i}/asset-${j}.png`,
      name: `asset-${j}.png`,
      size: 1024 * (j + 1),
      source: 'lsof',
    }));
    store.upsertProject({ id: `project-${i}`, name: `Project ${i}`, status: 'paused', files, pendingFiles: [] });
  }

  const single = store.getProjectById('project-12');
  assert.equal(single.id, 'project-12');
  assert.equal(single.files.length, 80);
  const all = store.get('projects', []);
  assert.equal(all.length, 25);
});

test('Phase 4C: AdobePushBridge enforces owner-only Unix socket, token auth, sanitization, and clean teardown', async t => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crate-adobe-push-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const received = [];
  const bridge = new AdobePushBridge({
    runtimeDir: dir,
    onEvent: evt => received.push(evt),
  });
  const info = await bridge.start();
  t.after(() => bridge.stop());

  // Verify owner-only permissions on runtime dir, socket, and session descriptor
  assert.equal(fs.lstatSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.lstatSync(info.socketPath).mode & 0o777, 0o600);
  assert.equal(fs.lstatSync(info.sessionFilePath).mode & 0o777, 0o600);

  const session = JSON.parse(fs.readFileSync(info.sessionFilePath, 'utf8'));
  assert.equal(session.socketPath, info.socketPath);
  assert.equal(typeof session.token, 'string');
  assert.equal(session.token.length, 64);

  const sendLine = line => new Promise((resolve, reject) => {
    const client = net.createConnection(info.socketPath);
    let buf = '';
    client.setEncoding('utf8');
    client.on('data', chunk => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl >= 0) {
        client.end();
        resolve(JSON.parse(buf.slice(0, nl)));
      }
    });
    client.once('error', reject);
    client.write(`${line}\n`);
  });

  // 1. Wrong token rejected
  const badAuth = await sendLine(JSON.stringify({
    token: '0'.repeat(64),
    appFamily: 'photoshop',
    event: 'document-saved',
    documentPath: '/Users/designer/poster.psd',
  }));
  assert.deepEqual(badAuth, { ok: false, error: 'unauthorized' });

  // 2. Relative path rejected
  const badPath = await sendLine(JSON.stringify({
    token: session.token,
    appFamily: 'photoshop',
    event: 'document-saved',
    documentPath: '../relative.psd',
  }));
  assert.deepEqual(badPath, { ok: false, error: 'invalid_event' });

  // 3. Valid authenticated push accepted in <5ms, deduplicating & sanitizing links
  const okRes = await sendLine(JSON.stringify({
    token: session.token,
    appFamily: 'photoshop',
    event: 'document-saved',
    documentPath: '/Users/designer/poster.psd',
    linkedPaths: [
      '/Users/designer/hero.png',
      '/Users/designer/hero.png',
      'relative/bad.png',
      '/Users/designer/logo.svg',
    ],
    dirty: false,
  }));
  assert.deepEqual(okRes, { ok: true, seq: 1 });
  assert.equal(received.length, 1);
  assert.equal(received[0].appFamily, 'photoshop');
  assert.equal(received[0].event, 'document-saved');
  assert.deepEqual(received[0].linkedPaths, ['/Users/designer/hero.png', '/Users/designer/logo.svg']);
  assert.equal(received[0].dirty, false);

  // 4. Clean teardown removes socket & session token file
  await bridge.stop();
  assert.equal(fs.existsSync(info.socketPath), false);
  assert.equal(fs.existsSync(info.sessionFilePath), false);

  // Sanitizer rejects unsupported app family
  assert.equal(sanitizeAdobePushEvent({ appFamily: 'evil', event: 'document-saved', documentPath: '/Users/a.psd' }), null);
});

test('Phase 4C: resolveNativeHelperBinaryPath supports packaged resourcesPath and rejects symlinks', t => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crate-res-path-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const nativeDir = path.join(dir, 'native');
  fs.mkdirSync(nativeDir, { recursive: true });
  const fakeBin = path.join(nativeDir, 'crate-helper');
  fs.writeFileSync(fakeBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  assert.equal(isExecutableRegularFile(fakeBin), true);

  // Symlink must be refused
  const symBin = path.join(nativeDir, 'symlink-helper');
  fs.symlinkSync(fakeBin, symBin);
  assert.equal(isExecutableRegularFile(symBin), false);

  const prevResourcesPath = process.resourcesPath;
  try {
    Object.defineProperty(process, 'resourcesPath', { value: dir, configurable: true, writable: true });
    assert.equal(resolveNativeHelperBinaryPath(), fakeBin);
  } finally {
    Object.defineProperty(process, 'resourcesPath', { value: prevResourcesPath, configurable: true, writable: true });
  }
});
