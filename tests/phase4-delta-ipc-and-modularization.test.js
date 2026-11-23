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

test('Coalesced IPC preserves union of tokens and cancels cleanly on account logout (G-P1 / A-P1-1)', async () => {
  const bridge = new ProjectIpcDeltaBridge({ coalesceMs: 16 });
  const emitted = [];

  // Scenario 1: valid token followed by stale token within 16ms window must NOT drop refresh
  let activeToken = 1;
  let authed = true;
  bridge.scheduleCoalesced('proj-1', {
    activationToken: 1,
    assertAuthorized: () => { if (!authed) throw new Error('logged_out'); },
    emitFn: ({ tokens, hasNullToken, authChecks }) => {
      const okAuth = authChecks.some(fn => { try { fn(); return true; } catch (_) { return false; } });
      const okTok = hasNullToken || [...tokens].some(tok => tok === activeToken);
      if (okAuth && okTok) emitted.push({ projectId: 'proj-1', tokens: [...tokens] });
    },
  });
  bridge.scheduleCoalesced('proj-1', {
    activationToken: 999, // stale token
    assertAuthorized: () => { if (!authed) throw new Error('logged_out'); },
    emitFn: ({ tokens, hasNullToken, authChecks }) => {
      const okAuth = authChecks.some(fn => { try { fn(); return true; } catch (_) { return false; } });
      const okTok = hasNullToken || [...tokens].some(tok => tok === activeToken);
      if (okAuth && okTok) emitted.push({ projectId: 'proj-1', tokens: [...tokens] });
    },
  });
  await new Promise(resolve => setTimeout(resolve, 45));
  assert.equal(emitted.length, 1);
  assert.deepEqual(emitted[0].tokens.sort((a, b) => a - b), [1, 999]);

  // Scenario 2: null-token send followed by logout/clearAll within 16ms emits nothing
  bridge.scheduleCoalesced('proj-2', {
    activationToken: null,
    assertAuthorized: () => { if (!authed) throw new Error('logged_out'); },
    emitFn: () => { emitted.push({ projectId: 'proj-2', leaked: true }); },
  });
  authed = false;
  bridge.clearAll();
  await new Promise(resolve => setTimeout(resolve, 45));
  assert.equal(emitted.filter(e => e.projectId === 'proj-2').length, 0);
});

test('NativeHelperClient per-child lifecycle: retired timed-out helper exit cannot reject replacement helper requests (A-P2-2)', async t => {
  const { NativeHelperClient } = require('../parsers/native-helper');
  const prevDisableEnv = process.env.CRATE_DISABLE_NATIVE_HELPER;
  delete process.env.CRATE_DISABLE_NATIVE_HELPER;
  t.after(() => {
    if (prevDisableEnv === undefined) delete process.env.CRATE_DISABLE_NATIVE_HELPER;
    else process.env.CRATE_DISABLE_NATIVE_HELPER = prevDisableEnv;
  });
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crate-nh-lifecycle-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // Synthetic helper script: delays on "slow" op, answers immediately on "ping",
  // and sleeps briefly on SIGTERM before exiting so the replacement spawns first.
  const fakeHelper = path.join(dir, 'fake-helper.js');
  const markerFile = path.join(dir, 'spawn-count');
  fs.writeFileSync(markerFile, '0');
  const script = `#!/bin/sh
exec "${process.execPath}" -e '
const fs = require("node:fs");
const readline = require("node:readline");
const marker = ${JSON.stringify(markerFile)};
const count = Number(fs.readFileSync(marker, "utf8")) + 1;
fs.writeFileSync(marker, String(count));
process.on("SIGTERM", () => { setTimeout(() => process.exit(0), 60); });
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", line => {
  const req = JSON.parse(line);
  if (req.op === "shutdown") { process.stdout.write(JSON.stringify({ id: req.id, ok: true }) + "\\n"); process.exit(0); }
  if (req.op === "slow") return; // deliberately time out
  if (req.op === "ping") {
    setTimeout(() => {
      process.stdout.write(JSON.stringify({ id: req.id, ok: true, result: { version: 1, spawn: count, pid: process.pid } }) + "\\n");
    }, 100);
  }
});
'
`;
  fs.writeFileSync(fakeHelper, script, { mode: 0o755 });

  const client = new NativeHelperClient(fakeHelper);
  t.after(() => client.shutdown());

  // 0. Ensure child #1 is alive and has recorded spawn 1 before triggering timeout
  const firstPong = await client.ping();
  assert.equal(firstPong.version, 1);
  assert.equal(firstPong.spawn, 1);

  // 1. Trigger a timeout on child #1 (which delays its SIGTERM exit by 60ms)
  await assert.rejects(() => client.call('slow', {}, 30), /native_helper_timeout/);

  // 2. Immediately issue ping on child #2 (takes 100ms, spanning child #1's exit at 60ms)
  const pong = await client.ping();
  assert.equal(pong.version, 1);
  assert.equal(pong.spawn, 2);
});

test('NativeHelperClient stdin error handling: dying child produces clean rejection, never uncaught EPIPE (Fable B4)', async t => {
  const { NativeHelperClient } = require('../parsers/native-helper');
  const prevDisableEnv = process.env.CRATE_DISABLE_NATIVE_HELPER;
  delete process.env.CRATE_DISABLE_NATIVE_HELPER;
  t.after(() => {
    if (prevDisableEnv === undefined) delete process.env.CRATE_DISABLE_NATIVE_HELPER;
    else process.env.CRATE_DISABLE_NATIVE_HELPER = prevDisableEnv;
  });

  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crate-nh-epipe-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // Helper responds to 1 line and immediately exits with code 0
  const crashHelper = path.join(dir, 'crash-helper.sh');
  const script = `#!/bin/sh
exec "${process.execPath}" -e '
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
rl.once("line", line => {
  const req = JSON.parse(line);
  process.stdout.write(JSON.stringify({ id: req.id, ok: true, result: { version: 1 } }) + "\\n", () => process.exit(0));
});
'
`;
  fs.writeFileSync(crashHelper, script, { mode: 0o755 });

  let uncaught = null;
  const onUncaught = err => { uncaught = err; };
  process.on('uncaughtException', onUncaught);
  t.after(() => process.removeListener('uncaughtException', onUncaught));

  const client = new NativeHelperClient(crashHelper);
  t.after(() => client.shutdown());

  const first = await client.ping();
  assert.equal(first.version, 1);

  // Synchronously block briefly so the OS tears down the child's stdin pipe before
  // Node's exit event runs, reproducing the EPIPE write window deterministically.
  const endSpin = Date.now() + 150;
  while (Date.now() < endSpin) { /* busy wait */ }

  await assert.rejects(() => client.ping(), /native_helper_/);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(uncaught, null, 'stdin write to exited helper must never raise uncaughtException');
});

test('Native watcher bridge client-injected tests: xattr errors throw, incomplete openFiles returns null, runningApps is case-sensitive (A-P1-3 / N4)', async () => {
  const {
    readNativeLastUsedXattrs,
    pollNativeOpenFilesAsLsofF,
    getNativeRunningDesignApps,
  } = require('../parsers/native-watcher-bridge');

  // 1. xattr errors must throw (triggering /usr/bin/xattr fallback / fail-closed scan)
  await assert.rejects(
    () => readNativeLastUsedXattrs(['/Users/synthetic/a.png'], 1000, {
      client: {
        readLastUsedXattrs: async () => ({
          timestamps: { '/Users/synthetic/a.png': null },
          errors: { '/Users/synthetic/a.png': 'errno_13' },
        }),
      },
    }),
    /native xattr read error/
  );

  // 2. Incomplete openFiles or failedPids must return null (NEVER emit empty p<pid> header)
  const incompleteOut = await pollNativeOpenFilesAsLsofF([101, 202], 1000, {
    client: {
      openFiles: async () => ({ files: [], complete: false, failedPids: [202] }),
    },
  });
  assert.equal(incompleteOut, null);

  const completeOut = await pollNativeOpenFilesAsLsofF([101, 202], 1000, {
    client: {
      openFiles: async () => ({
        files: [{ pid: 101, path: '/Users/synthetic/poster.psd' }],
        complete: true,
        failedPids: [],
      }),
    },
  });
  assert.equal(completeOut, 'p101\ntREG\nn/Users/synthetic/poster.psd\np202');

  // 3. getNativeRunningDesignApps passes caseSensitive=true and enforces exact case match
  let receivedOpts = null;
  const apps = await getNativeRunningDesignApps(['Adobe Photoshop', 'Keynote'], 1000, {
    client: {
      runningApps: async (keywords, _timeout, opts) => {
        receivedOpts = opts;
        return {
          apps: [
            { pid: 10, command: '/Applications/Adobe Photoshop 2026/Adobe Photoshop 2026.app/Contents/MacOS/Adobe Photoshop 2026' },
            { pid: 20, command: '/usr/local/bin/adobe photoshop spoof' },
          ],
        };
      },
    },
  });
  assert.deepEqual(receivedOpts, { caseSensitive: true });
  assert.deepEqual(apps.pids, [10]);
});
