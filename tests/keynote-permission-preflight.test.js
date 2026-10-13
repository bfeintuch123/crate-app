'use strict';

// Execute only the production measurement block in a closed fake environment.
// No Electron, child_process, JXA, AppKit, application, or native probe is loaded.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const begin = source.indexOf('const KEYNOTE_PERMISSION_MEASUREMENT_MODE =');
const end = source.indexOf("const LAST_USED_XATTR_NAME =", begin);
assert.ok(begin > 0 && end > begin);
const block = source.slice(begin, end);
const coordinatorBegin = source.indexOf('function createWatcherCoordinator(');
const coordinatorEnd = source.indexOf('function clearDeferredWatcherOperations(', coordinatorBegin);
assert.ok(coordinatorBegin > 0 && coordinatorEnd > coordinatorBegin);

function fixture(options = {}) {
  const calls = [], writes = [];
  let generation = 1;
  const context = {
    process: { platform: 'darwin', argv: options.enabled === false ? [] : ['--crate-keynote-permission-measurement'], pid: 111, execPath: '/synthetic/Crate', },
    app: { isPackaged: options.packaged !== false }, Buffer, crypto, path,
    store: { get: () => options.projects ?? [] },
    watchers: new Map(), watcherCoordinators: new Map(), watcherStartupTimers: new Map(), watcherDeferredOperations: new Map(),
    activeAddFilesOperations: new Map(), pendingNativeAddFilesPickers: new Map(), packageInFlight: false,
    workingSourceScanLeases: options.scanState?.leases || new Map(),
    workingSourceScanOperations: options.scanState?.operations || new Set(),
    localStoreStartupError: null, localStorePaths: { userDataRealPath: '/synthetic/profile' },
    accountSession: { canUseWorkspace: () => true },
    MAX_DEFERRED_WATCHER_OPERATIONS_PER_PROJECT: 64,
    clearDeferredWatcherOperations: () => {}, clearCurrentSessionFilesystemEvidence: () => {}, clearTimeout: () => {},
    captureAccountAuthorization: () => { const old = generation; return () => { if (old !== generation) throw Error('stale'); }; },
    fs: { promises: {
      mkdtemp: async prefix => { calls.push(['mkdtemp', prefix]); return `${prefix}private`; },
      chmod: async (file, mode) => calls.push(['chmod', file, mode]),
      writeFile: async (file, contents, flags) => writes.push({ file, value: JSON.parse(contents), flags })
    } },
    runOsascriptInPrivateTemp: async (build, name, config) => {
      const script = build()[name]; calls.push(['runner', name, config]);
      if (options.runner) return options.runner(script);
      return { stdout: fakeBridge(script).stdout };
    }
  };
  vm.createContext(context, { codeGeneration: { strings: false, wasm: false } });
  vm.runInContext(`${source.slice(coordinatorBegin, coordinatorEnd)}\n${block}\nglobalThis.api = { buildKeynotePermissionPreflightScript, parseKeynotePermissionPreflightOutput, runKeynotePermissionPreflightOnce, keynotePermissionMeasurementMenuItems, getWatcherCoordinator, activateWatcherCoordinator, cancelWatcherCoordinator };`, context);
  return { context, api: context.api, calls, writes, changeAccount: () => { generation++; } };
}

function fakeBridge(script, options = {}) {
  const calls = [], imports = [], bindings = [];
  const pointer = {};
  const owner = { aeDesc: options.nullPointer ? null : pointer, isNil: () => false };
  let snapshots = 0;
  const target = {
    isNil: () => false, terminated: !!options.terminated,
    bundleIdentifier: options.bundleId || 'com.apple.Keynote',
    bundleURL: { isNil: () => false, path: options.bundlePath || '/Applications/Keynote Creator Studio.app' },
    launchDate: options.noDate ? null : { isNil: () => false, timeIntervalSince1970: 1700000000 },
    processIdentifier: 222, isEqual: other => other === target
  };
  const native = {
    NSProcessInfo: { processInfo: { processIdentifier: 333 } },
    NSRunningApplication: { runningApplicationsWithBundleIdentifier: id => {
      assert.equal(id, 'com.apple.Keynote'); snapshots++;
      return { count: options.count ?? 1, objectAtIndex: index => {
        assert.equal(index, 0);
        if (options.replaceAfter && snapshots > options.replaceAfter) return { ...target, isEqual: () => false };
        return target;
      } };
    } },
    NSAppleEventDescriptor: { descriptorWithProcessIdentifier: pid => { assert.equal(pid, 222); return owner; } },
    AEDeterminePermissionToAutomateTarget: (actualPointer, eventClass, eventId, ask) => {
      assert.equal(actualPointer, owner.aeDesc); assert.equal(owner.isNil(), false);
      calls.push([eventClass, eventId, ask]);
      if (options.throwCall) throw Error('synthetic bridge error');
      return (options.statuses || [0, 0])[calls.length - 1];
    }
  };
  const context = vm.createContext({ $: native, ObjC: {
    import: name => { imports.push(name); if (options.importFailure) throw Error('framework'); },
    unwrap: value => value,
    bindFunction: (name, signature) => { bindings.push([name, JSON.parse(JSON.stringify(signature))]); if (options.bindFailure) throw Error('symbol'); }
  } }, { codeGeneration: { strings: false, wasm: false } });
  const stdout = vm.runInContext(script, context, { timeout: 1000 });
  return { stdout, value: JSON.parse(stdout), calls, imports, bindings };
}

test('production JXA script binds exact ABI and calls only fixed no-prompt event permissions', () => {
  const f = fixture(); const result = fakeBridge(f.api.buildKeynotePermissionPreflightScript());
  assert.deepEqual(result.imports, ['AppKit', 'CoreServices']);
  assert.deepEqual(result.bindings, [['AEDeterminePermissionToAutomateTarget', ['int', ['pointer', 'unsigned int', 'unsigned int', 'unsigned char']]]]);
  assert.deepEqual(result.calls, [[0x636f7265, 0x67657464, 0], [0x636f7265, 0x636e7465, 0]]);
  assert.equal(result.value.outcome, 'EVENTS_PERMITTED');
  assert.equal(f.api.parseKeynotePermissionPreflightOutput(result.stdout).outcome, 'EVENTS_PERMITTED');
});

for (const [status, outcome] of [[-1743, 'NOT_PERMITTED'], [-1744, 'CONSENT_REQUIRED'], [-600, 'TARGET_NOT_RUNNING'], [-42, 'UNKNOWN_OSSTATUS']]) {
  test(`status ${status} stops without a second call or fallback`, () => {
    const f = fixture(); const result = fakeBridge(f.api.buildKeynotePermissionPreflightScript(), { statuses: [status] });
    assert.equal(result.calls.length, 1); assert.equal(result.value.outcome, outcome);
    assert.equal(f.api.parseKeynotePermissionPreflightOutput(result.stdout).statuses[0], status);
  });
}

for (const option of [{ count: 0 }, { count: 2 }, { noDate: true }, { terminated: true }, { bundleId: 'wrong' },
  { bundlePath: '/wrong.app' }, { nullPointer: true }, { importFailure: true }, { bindFailure: true }, { replaceAfter: 1 }]) {
  test(`bridge/identity rejection precedes native call: ${JSON.stringify(option)}`, () => {
    const f = fixture(); const result = fakeBridge(f.api.buildKeynotePermissionPreflightScript(), option);
    assert.equal(result.calls.length, 0);
    assert.notEqual(result.value.outcome, 'EVENTS_PERMITTED');
    f.api.parseKeynotePermissionPreflightOutput(result.stdout);
  });
}

test('replacement immediately after first status invalidates success and prevents count', () => {
  const f = fixture(); const result = fakeBridge(f.api.buildKeynotePermissionPreflightScript(), { replaceAfter: 2 });
  assert.equal(result.calls.length, 1); assert.equal(result.value.outcome, 'UNKNOWN');
  assert.equal(result.value.stage, 'identity');
});

test('missing status, thrown bridge and second-event denial remain fail closed', () => {
  const f = fixture(); const script = f.api.buildKeynotePermissionPreflightScript();
  for (const options of [{ statuses: [] }, { throwCall: true }, { statuses: [0, -1744] }]) {
    const result = fakeBridge(script, options);
    assert.notEqual(result.value.outcome, 'EVENTS_PERMITTED');
    f.api.parseKeynotePermissionPreflightOutput(result.stdout);
  }
});

test('output parser rejects oversized, extra, malformed, forged and inconsistent records', () => {
  const f = fixture(); const good = fakeBridge(f.api.buildKeynotePermissionPreflightScript()).value;
  const bad = ['x'.repeat(32769), '{}', JSON.stringify(good) + '\n{}', JSON.stringify({ ...good, extra: true }),
    JSON.stringify({ ...good, statuses: [0] }), JSON.stringify({ ...good, statuses: [-1743, 0] }),
    JSON.stringify({ ...good, target: null }), JSON.stringify({ ...good, childPid: null }),
    JSON.stringify({ ...good, outcome: 'CONSENT_REQUIRED' }), JSON.stringify({ ...good, target: { ...good.target, document: 'private' } })];
  for (const input of bad) assert.throws(() => f.api.parseKeynotePermissionPreflightOutput(input));
});

test('normal and developer modes expose no command and never invoke runner', async () => {
  for (const options of [{ enabled: false }, { packaged: false }]) {
    const f = fixture(options);
    assert.equal(f.api.keynotePermissionMeasurementMenuItems().length, 0);
    assert.equal((await f.api.runKeynotePermissionPreflightOnce()).outcome, 'UNAVAILABLE');
    assert.equal(f.calls.length, 0);
  }
  assert.equal((source.match(/\.\.\.keynotePermissionMeasurementMenuItems\(\)/g) || []).length, 1);
});

test('idle check blocks watchers, operations, invalid store and account failure without consuming attempt', async () => {
  for (const name of ['watchers', 'watcherCoordinators', 'watcherStartupTimers', 'watcherDeferredOperations', 'activeAddFilesOperations', 'pendingNativeAddFilesPickers', 'workingSourceScanLeases']) {
    const f = fixture(); f.context[name].set('busy', true);
    assert.equal((await f.api.runKeynotePermissionPreflightOnce()).outcome, 'BUSY');
    assert.equal(f.calls.length, 0); f.context[name].clear();
    assert.equal((await f.api.runKeynotePermissionPreflightOnce()).outcome, 'CALLER_UNBOUND');
  }
  const f = fixture(); f.context.store.get = () => null;
  assert.equal((await f.api.runKeynotePermissionPreflightOnce()).outcome, 'BUSY');
  f.context.store.get = () => []; f.context.accountSession.canUseWorkspace = () => false;
  assert.equal((await f.api.runKeynotePermissionPreflightOnce()).outcome, 'BUSY');
});

test('retiring scan lifecycle blocks even after a replaced source lease leaves the map', async () => {
  const f = fixture(), retiring = {};
  f.context.workingSourceScanOperations.add(retiring);
  assert.equal((await f.api.runKeynotePermissionPreflightOnce()).outcome, 'BUSY');
  assert.equal(f.calls.length, 0);
  f.context.workingSourceScanOperations.delete(retiring);
  assert.equal((await f.api.runKeynotePermissionPreflightOnce()).outcome, 'CALLER_UNBOUND');
  assert.equal((await f.api.runKeynotePermissionPreflightOnce()).outcome, 'UNAVAILABLE');
  assert.equal(f.calls.filter(call => call[0] === 'runner').length, 1);
});

test('real stopped and drained coordinator remains cached and permits exactly one measurement', async () => {
  const f = fixture();
  f.api.activateWatcherCoordinator('project');
  const coordinator = f.api.getWatcherCoordinator('project');
  const ticket = coordinator.tryStart('project', 'lsof');
  assert.ok(ticket);
  coordinator.finish('project', ticket);
  f.api.cancelWatcherCoordinator('project');
  await coordinator.waitForIdle('project');
  assert.equal(f.context.watcherCoordinators.size, 1);
  assert.equal(coordinator.snapshot('project').cancelled, true);
  assert.equal((await f.api.runKeynotePermissionPreflightOnce()).outcome, 'CALLER_UNBOUND');
  assert.equal((await f.api.runKeynotePermissionPreflightOnce()).outcome, 'UNAVAILABLE');
  assert.equal(f.calls.filter(call => call[0] === 'runner').length, 1);
});

test('real live, queued and cancelled-but-draining coordinator blocks without consuming measurement', async () => {
  const f = fixture();
  f.api.activateWatcherCoordinator('project');
  const coordinator = f.api.getWatcherCoordinator('project');
  assert.equal((await f.api.runKeynotePermissionPreflightOnce()).outcome, 'BUSY');
  assert.equal(coordinator.defer('project', 'poll'), true);
  assert.equal((await f.api.runKeynotePermissionPreflightOnce()).outcome, 'BUSY');
  const ticket = coordinator.tryStart('project', 'lsof');
  assert.ok(ticket);
  f.api.cancelWatcherCoordinator('project');
  assert.equal(coordinator.snapshot('project').pendingOperations.length, 0);
  assert.equal(coordinator.snapshot('project').running, true);
  const draining = coordinator.waitForIdle('project');
  assert.equal((await f.api.runKeynotePermissionPreflightOnce()).outcome, 'BUSY');
  assert.equal(f.calls.length, 0);
  coordinator.finish('project', ticket);
  await draining;
  assert.equal(f.context.watcherCoordinators.size, 1);
  assert.equal((await f.api.runKeynotePermissionPreflightOnce()).outcome, 'CALLER_UNBOUND');
});

test('real package-drain state remains busy even on a previously cancelled coordinator', async () => {
  const f = fixture();
  f.api.activateWatcherCoordinator('project');
  f.api.cancelWatcherCoordinator('project');
  const coordinator = f.api.getWatcherCoordinator('project');
  coordinator.beginPackageScan('project');
  assert.equal((await f.api.runKeynotePermissionPreflightOnce()).outcome, 'BUSY');
  assert.equal(f.calls.length, 0);
  coordinator.endPackageScan('project');
  assert.equal((await f.api.runKeynotePermissionPreflightOnce()).outcome, 'CALLER_UNBOUND');
});

test('one explicit menu invocation writes private receipt with unknown sender and source, never usable eligibility', async () => {
  const f = fixture(); const item = f.api.keynotePermissionMeasurementMenuItems()[0];
  assert.equal(f.calls.length, 0); await item.click(item); assert.equal(item.enabled, false);
  const run = f.calls.find(call => call[0] === 'runner');
  assert.deepEqual(JSON.parse(JSON.stringify(run.slice(1))), ['keynote-permission-preflight.js', { language: 'JavaScript', timeout: 5000, maxBuffer: 32768, encoding: 'utf8' }]);
  assert.equal(f.writes.length, 1);
  const { value, flags, file } = f.writes[0];
  assert.equal(file, '/synthetic/profile/keynote-permission-measurement-private/receipt.json');
  assert.equal(flags.flag, 'wx'); assert.equal(flags.mode, 0o600);
  assert.ok(f.calls.some(call => call[0] === 'chmod' && call[2] === 0o700));
  assert.equal(value.outcome, 'CALLER_UNBOUND'); assert.equal(value.observation.outcome, 'EVENTS_PERMITTED');
  assert.equal(value.responsibleSenderBinding.status, 'UNKNOWN'); assert.equal(value.candidateSourceHead, null);
  assert.equal(value.actualSigningIdentity, null); assert.equal(value.child.parentVerified, false);
  for (const key of ['automaticSelectionAllowed', 'documentObservationPerformed', 'usableCrateEligibility', 'askUserIfNeeded']) assert.equal(value[key], false);
  assert.equal((await f.api.runKeynotePermissionPreflightOnce()).outcome, 'UNAVAILABLE');
});

test('concurrent calls and failure cannot retry a consumed attempt', async () => {
  let rejectRun;
  const pending = new Promise((_, reject) => { rejectRun = reject; });
  const f = fixture({ runner: () => pending });
  const first = f.api.runKeynotePermissionPreflightOnce();
  assert.equal((await f.api.runKeynotePermissionPreflightOnce()).outcome, 'UNAVAILABLE');
  rejectRun(Error('synthetic timeout'));
  const receipt = await first;
  assert.equal(receipt.outcome, 'UNKNOWN'); assert.equal(receipt.errorStage, 'execution');
  assert.equal(f.calls.filter(call => call[0] === 'runner').length, 1);
  assert.equal((await f.api.runKeynotePermissionPreflightOnce()).outcome, 'UNAVAILABLE');
});

test('account change invalidates raw successful statuses; no configuration becomes authority', async () => {
  const f = fixture({ runner: script => { f.changeAccount(); return { stdout: fakeBridge(script).stdout }; } });
  const receipt = await f.api.runKeynotePermissionPreflightOnce();
  assert.equal(receipt.outcome, 'UNKNOWN'); assert.equal(receipt.errorStage, 'context');
  assert.equal(receipt.usableCrateEligibility, false);
});

test('parse/storage errors remain bounded and one-use with no raw error disclosure', async () => {
  const f = fixture({ runner: () => ({ stdout: 'untrusted private text' }) });
  const receipt = await f.api.runKeynotePermissionPreflightOnce();
  assert.equal(receipt.errorStage, 'output'); assert.equal(JSON.stringify(receipt).includes('untrusted private text'), false);
  const g = fixture(); g.context.fs.promises.writeFile = async () => { throw Error('private path'); };
  const failed = await g.api.runKeynotePermissionPreflightOnce();
  assert.equal(failed.errorStage, 'receipt-write'); assert.equal(failed.outcome, 'UNKNOWN');
});

test('receipt setup failure prevents execution and stays consumed', async () => {
  const f = fixture(); f.context.fs.promises.mkdtemp = async () => { throw Error('synthetic storage failure'); };
  const result = await f.api.runKeynotePermissionPreflightOnce();
  assert.equal(result.outcome, 'UNKNOWN'); assert.equal(result.errorStage, 'receipt-setup');
  assert.equal(f.calls.filter(call => call[0] === 'runner').length, 0);
  assert.equal((await f.api.runKeynotePermissionPreflightOnce()).outcome, 'UNAVAILABLE');
});

for (const failure of [null, 'write', 'exec']) {
  test(`existing private execution primitive preserves fixed arguments and cleanup: ${failure || 'success'}`, async () => {
    const runnerStart = source.indexOf('function safeTempScriptName(');
    const runnerEnd = source.indexOf('// Measurement only:', runnerStart);
    const events = [];
    const context = vm.createContext({
      path, os: { tmpdir: () => '/synthetic' }, TEMP_SCRIPT_DIR_PREFIX: 'test-', TEMP_SCRIPT_DIR_MODE: 0o700, TEMP_SCRIPT_FILE_MODE: 0o600,
      fs: { mkdtempSync: () => '/synthetic/private', chmodSync: () => {}, promises: {
        writeFile: async (file, contents, flags) => { events.push(['write', file, flags]); if (failure === 'write') throw Error('write'); },
        rm: async file => events.push(['remove', file])
      } },
      execFileAsync: async (file, args, options) => { events.push(['exec', file, args, options]); if (failure === 'exec') throw Error('deadline'); return { stdout: '{}' }; }
    }, { codeGeneration: { strings: false, wasm: false } });
    vm.runInContext(`${source.slice(runnerStart, runnerEnd)}\nglobalThis.runner = runOsascriptInPrivateTemp;`, context);
    const result = context.runner(() => ({ 'keynote-permission-preflight.js': 'fake only' }), 'keynote-permission-preflight.js',
      { language: 'JavaScript', timeout: 5000, maxBuffer: 32768, encoding: 'utf8' });
    if (failure) await assert.rejects(result); else await result;
    assert.deepEqual(events.at(-1), ['remove', '/synthetic/private']);
    if (failure !== 'write') {
      const event = JSON.parse(JSON.stringify(events.find(entry => entry[0] === 'exec')));
      assert.deepEqual(event, ['exec', '/usr/bin/osascript', ['-l', 'JavaScript', '/synthetic/private/keynote-permission-preflight.js'],
        { timeout: 5000, maxBuffer: 32768, encoding: 'utf8' }]);
    } else assert.equal(events.some(entry => entry[0] === 'exec'), false);
  });
}
