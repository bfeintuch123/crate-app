'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAX_CHUNK_BYTES = 1024 * 1024;
const OWNER_ONLY_FILE_MODE = 0o600;
const OWNERSHIP_ACK_TIMEOUT_MS = 30_000;

function parseIdentity(value) {
  if (!value || !/^\d+$/u.test(value.dev) || !/^\d+$/u.test(value.ino)) return null;
  return { dev: BigInt(value.dev), ino: BigInt(value.ino) };
}

function parseAncestries(value, identity) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) return null;
  const ancestries = value.map(candidate => {
    if (!Array.isArray(candidate) || candidate.length === 0 || candidate.length > 256) return null;
    const ancestry = candidate.map(parseIdentity);
    if (
      ancestry.some(item => item === null) ||
      ancestry[0].dev !== identity.dev ||
      ancestry[0].ino !== identity.ino
    ) return null;
    return ancestry;
  });
  return ancestries.some(item => item === null) ? null : ancestries;
}

function currentDirectoryMatchesAncestry(identity, ancestry) {
  let relativePath = '.';
  for (const expected of ancestry) {
    const stat = fs.statSync(relativePath, { bigint: true });
    if (!stat.isDirectory() || stat.dev !== expected.dev || stat.ino !== expected.ino) return false;
    relativePath = path.join(relativePath, '..');
  }
  const stat = fs.statSync('.', { bigint: true });
  return stat.dev === identity.dev && stat.ino === identity.ino;
}

function currentDirectoryMatches(identity, ancestries) {
  return Array.isArray(ancestries) && ancestries.some(ancestry => (
    currentDirectoryMatchesAncestry(identity, ancestry)
  ));
}

function exactDirectoryMatches(candidatePath, identity) {
  try {
    const stat = fs.lstatSync(candidatePath, { bigint: true });
    return !stat.isSymbolicLink() &&
      stat.isDirectory() &&
      stat.dev === identity.dev &&
      stat.ino === identity.ino;
  } catch (_) {
    return false;
  }
}

function pathIsMissing(candidatePath) {
  try {
    fs.lstatSync(candidatePath);
    return false;
  } catch (error) {
    return error?.code === 'ENOENT';
  }
}

function parseOwnedOutputs(value) {
  if (!Array.isArray(value)) return { valid: false, outputs: [] };
  const seen = new Set();
  const identityByLeaf = new Map();
  const outputs = [];
  let valid = true;
  for (const item of value) {
    const identity = parseIdentity(item?.identity);
    const key = identity && isSafeLeafName(item?.leafName)
      ? `${item.leafName}\0${identity.dev}\0${identity.ino}`
      : null;
    if (!key) {
      valid = false;
      continue;
    }
    const identityKey = `${identity.dev}\0${identity.ino}`;
    const existingIdentity = identityByLeaf.get(item.leafName);
    if (existingIdentity && existingIdentity !== identityKey) {
      valid = false;
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    identityByLeaf.set(item.leafName, identityKey);
    outputs.push({ leafName: item.leafName, identity });
  }
  return { valid, outputs };
}

function isSafeLeafName(value) {
  return typeof value === 'string' &&
    value.length > 0 &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('/') &&
    !value.includes('\0');
}

function normalizeChunk(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

function startPackageTransactionWorker(port = process.parentPort, options = {}) {
  if (!port || typeof port.on !== 'function' || typeof port.postMessage !== 'function') {
    throw new Error('package transaction worker requires a parent port');
  }

  const exit = typeof options.exit === 'function' ? options.exit : code => process.exit(code);
  const ownershipAckTimeoutMs = Number.isSafeInteger(options.ownershipAckTimeoutMs) &&
    options.ownershipAckTimeoutMs > 0
    ? options.ownershipAckTimeoutMs
    : OWNERSHIP_ACK_TIMEOUT_MS;
  let state = 'awaiting-init';
  let outputFd = null;
  let outputIdentity = null;
  let outputLeafName = null;
  let expectedLength = null;
  let bytesWritten = 0n;
  let expectedSequence = 0;
  let transactionIdentity = null;
  let ancestries = null;
  let ownedOutputs = [];
  const ownedOutputKeys = new Set();
  let ownershipTimer = null;

  const clearOwnershipTimer = () => {
    if (ownershipTimer) clearTimeout(ownershipTimer);
    ownershipTimer = null;
  };

  const closeOutput = () => {
    if (outputFd === null) return;
    try { fs.closeSync(outputFd); } catch (_) {}
    outputFd = null;
  };
  const sanitizeDescriptor = (fd, identity) => {
    if (fd === null || !identity) return false;
    try {
      const stat = fs.fstatSync(fd, { bigint: true });
      if (!stat.isFile() || stat.dev !== identity.dev || stat.ino !== identity.ino) return false;
      fs.ftruncateSync(fd, 0);
      fs.fsyncSync(fd);
      return true;
    } catch (_) {
      return false;
    }
  };
  const sanitizeAndUnlinkOwnedPath = (childName, identity) => {
    let stat;
    try { stat = fs.lstatSync(childName, { bigint: true }); } catch (_) { return false; }
    if (
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      stat.dev !== identity.dev ||
      stat.ino !== identity.ino
    ) return false;
    let quarantineDirectory = null;
    let quarantineIdentity = null;
    let quarantinePath = null;
    let fd = null;
    try {
      quarantineDirectory = fs.mkdtempSync('.crate-cleanup-');
      fs.chmodSync(quarantineDirectory, 0o700);
      const quarantineStat = fs.lstatSync(quarantineDirectory, { bigint: true });
      if (
        quarantineStat.isSymbolicLink() ||
        !quarantineStat.isDirectory() ||
        (quarantineStat.mode & 0o777n) !== 0o700n
      ) return false;
      quarantineIdentity = { dev: quarantineStat.dev, ino: quarantineStat.ino };
      quarantinePath = path.join(quarantineDirectory, 'owned-output');
      options.beforeOwnedQuarantineRename?.({
        childName,
        quarantineDirectory,
        quarantinePath,
        identity,
      });
      if (
        !exactDirectoryMatches(quarantineDirectory, quarantineIdentity) ||
        !pathIsMissing(quarantinePath)
      ) return false;
      fs.renameSync(childName, quarantinePath);
      if (!exactDirectoryMatches(quarantineDirectory, quarantineIdentity)) return false;
      const quarantinedStat = fs.lstatSync(quarantinePath, { bigint: true });
      if (
        quarantinedStat.isSymbolicLink() ||
        !quarantinedStat.isFile() ||
        quarantinedStat.dev !== identity.dev ||
        quarantinedStat.ino !== identity.ino
      ) return false;
      fd = fs.openSync(quarantinePath, fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW);
      const openedStat = fs.fstatSync(fd, { bigint: true });
      if (
        !openedStat.isFile() ||
        openedStat.dev !== identity.dev ||
        openedStat.ino !== identity.ino
      ) return false;
      fs.ftruncateSync(fd, 0);
      fs.fsyncSync(fd);
    } catch (_) {
      return false;
    } finally {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch (_) {}
      }
    }
    try {
      options.beforeOwnedQuarantineUnlink?.({
        childName,
        quarantineDirectory,
        quarantinePath,
        identity,
      });
      if (!exactDirectoryMatches(quarantineDirectory, quarantineIdentity)) return false;
      const finalStat = fs.lstatSync(quarantinePath, { bigint: true });
      if (
        !finalStat.isSymbolicLink() &&
        finalStat.isFile() &&
        finalStat.dev === identity.dev &&
        finalStat.ino === identity.ino
      ) {
        fs.unlinkSync(quarantinePath);
        options.beforeOwnedQuarantineDirectoryRemove?.({
          childName,
          quarantineDirectory,
          quarantinePath,
          identity,
        });
        if (
          !exactDirectoryMatches(quarantineDirectory, quarantineIdentity) ||
          fs.readdirSync(quarantineDirectory).length !== 0
        ) return false;
        fs.rmdirSync(quarantineDirectory);
        return pathIsMissing(quarantineDirectory);
      }
    } catch (_) {}
    return false;
  };
  const removeOwnedRecordsFromDirectory = records => {
    const recordsByLeaf = new Map();
    for (const record of records) {
      const entries = recordsByLeaf.get(record.leafName) || [];
      entries.push(record.identity);
      recordsByLeaf.set(record.leafName, entries);
    }
    const fallbackIdentities = new Map();
    for (const [leafName, identities] of recordsByLeaf) {
      let matchedOriginalLeaf = false;
      for (const identity of identities) {
        if (sanitizeAndUnlinkOwnedPath(leafName, identity)) {
          matchedOriginalLeaf = true;
          break;
        }
      }
      if (!matchedOriginalLeaf && identities.length === 1) {
        const [identity] = identities;
        fallbackIdentities.set(`${identity.dev}\0${identity.ino}`, identity);
      }
    }
    if (fallbackIdentities.size === 0) return;
    let childNames = [];
    try { childNames = fs.readdirSync('.'); } catch (_) {}
    for (const childName of childNames) {
      let stat;
      try { stat = fs.lstatSync(childName, { bigint: true }); } catch (_) { continue; }
      const identity = fallbackIdentities.get(`${stat.dev}\0${stat.ino}`);
      if (!identity) continue;
      if (sanitizeAndUnlinkOwnedPath(childName, identity)) {
        fallbackIdentities.delete(`${identity.dev}\0${identity.ino}`);
      }
    }
  };
  const removeOutput = () => {
    const identity = outputIdentity;
    sanitizeDescriptor(outputFd, identity);
    closeOutput();
    if (identity && outputLeafName) {
      removeOwnedRecordsFromDirectory([{ leafName: outputLeafName, identity }]);
    }
  };
  const removeOwnedOutputs = () => {
    if (!transactionIdentity) return;
    try {
      const cwdStat = fs.statSync('.', { bigint: true });
      if (cwdStat.dev !== transactionIdentity.dev || cwdStat.ino !== transactionIdentity.ino) return;
    } catch (_) {
      return;
    }
    removeOwnedRecordsFromDirectory(ownedOutputs);
  };
  const resetOutput = () => {
    clearOwnershipTimer();
    outputFd = null;
    outputIdentity = null;
    outputLeafName = null;
    expectedLength = null;
    bytesWritten = 0n;
    expectedSequence = 0;
  };
  const rememberOwnedOutput = (leafName, identity) => {
    const key = `${leafName}\0${identity.dev}\0${identity.ino}`;
    if (ownedOutputKeys.has(key)) return;
    ownedOutputKeys.add(key);
    ownedOutputs.push({ leafName, identity });
  };
  const finish = (code, message = null) => {
    if (state === 'finished') return;
    state = 'finished';
    clearOwnershipTimer();
    if (code === 0) closeOutput();
    else {
      removeOutput();
      removeOwnedOutputs();
    }
    if (message) {
      try { port.postMessage(message); } catch (_) {}
    }
    setImmediate(() => exit(code));
  };
  const fail = () => finish(72, { type: 'failed' });

  const initializeSession = message => {
    const identity = parseIdentity(message.identity);
    const parsedAncestries = identity ? parseAncestries(message.ancestries, identity) : null;
    const parsedOwnedOutputs = parseOwnedOutputs(message.ownedOutputs);
    transactionIdentity = identity;
    if (!identity || !parsedAncestries || !parsedOwnedOutputs.valid) {
      ownedOutputs = [];
      fail();
      return;
    }
    ownedOutputs = parsedOwnedOutputs.outputs;
    for (const owned of ownedOutputs) {
      ownedOutputKeys.add(`${owned.leafName}\0${owned.identity.dev}\0${owned.identity.ino}`);
    }
    ancestries = parsedAncestries;
    if (!currentDirectoryMatches(identity, ancestries) || !Number.isInteger(fs.constants.O_NOFOLLOW)) {
      fail();
      return;
    }
    process.umask(0o077);
    state = 'idle';
    port.postMessage({ type: 'session-ready' });
  };

  const initializeWrite = message => {
    if (!isSafeLeafName(message.leafName) || !/^\d+$/u.test(message.expectedLength)) {
      fail();
      return;
    }
    if (!currentDirectoryMatches(transactionIdentity, ancestries)) {
      fail();
      return;
    }
    expectedLength = BigInt(message.expectedLength);
    outputLeafName = message.leafName;
    outputFd = fs.openSync(
      outputLeafName,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW,
      OWNER_ONLY_FILE_MODE
    );
    const openedStat = fs.fstatSync(outputFd, { bigint: true });
    outputIdentity = { dev: openedStat.dev, ino: openedStat.ino };
    fs.fchmodSync(outputFd, OWNER_ONLY_FILE_MODE);
    const hardenedStat = fs.fstatSync(outputFd, { bigint: true });
    if (
      !openedStat.isFile() ||
      !hardenedStat.isFile() ||
      hardenedStat.dev !== outputIdentity.dev ||
      hardenedStat.ino !== outputIdentity.ino ||
      openedStat.nlink !== 1n ||
      hardenedStat.nlink !== 1n ||
      (hardenedStat.mode & 0o777n) !== BigInt(OWNER_ONLY_FILE_MODE)
    ) {
      fail();
      return;
    }
    state = 'awaiting-ownership-ack';
    ownershipTimer = setTimeout(fail, ownershipAckTimeoutMs);
    ownershipTimer.unref?.();
    port.postMessage({
      type: 'opened',
      outputIdentity: { dev: `${outputIdentity.dev}`, ino: `${outputIdentity.ino}` },
    });
  };

  const acknowledgeOwnership = message => {
    const acknowledgedIdentity = parseIdentity(message.outputIdentity);
    if (
      state !== 'awaiting-ownership-ack' ||
      !acknowledgedIdentity ||
      acknowledgedIdentity.dev !== outputIdentity?.dev ||
      acknowledgedIdentity.ino !== outputIdentity?.ino ||
      !currentDirectoryMatches(transactionIdentity, ancestries)
    ) {
      fail();
      return;
    }
    const descriptorStat = fs.fstatSync(outputFd, { bigint: true });
    const pathStat = fs.lstatSync(outputLeafName, { bigint: true });
    if (
      !descriptorStat.isFile() ||
      !pathStat.isFile() ||
      pathStat.isSymbolicLink() ||
      descriptorStat.dev !== outputIdentity.dev ||
      descriptorStat.ino !== outputIdentity.ino ||
      pathStat.dev !== outputIdentity.dev ||
      pathStat.ino !== outputIdentity.ino ||
      descriptorStat.nlink !== 1n ||
      pathStat.nlink !== 1n ||
      (descriptorStat.mode & 0o777n) !== BigInt(OWNER_ONLY_FILE_MODE) ||
      (pathStat.mode & 0o777n) !== BigInt(OWNER_ONLY_FILE_MODE)
    ) {
      fail();
      return;
    }
    clearOwnershipTimer();
    state = 'writing';
    port.postMessage({ type: 'ready' });
  };

  const initializeCleanup = () => {
    if (!currentDirectoryMatches(transactionIdentity, ancestries)) {
      fail();
      return;
    }
    removeOwnedOutputs();
    if (!currentDirectoryMatches(transactionIdentity, ancestries) || fs.readdirSync('.').length !== 0) {
      fail();
      return;
    }
    finish(0, { type: 'complete', bytesWritten: '0' });
  };

  const currentOutputMatches = () => {
    if (outputFd === null || !outputIdentity || !outputLeafName) return false;
    const descriptorStat = fs.fstatSync(outputFd, { bigint: true });
    const pathStat = fs.lstatSync(outputLeafName, { bigint: true });
    return descriptorStat.isFile() &&
      pathStat.isFile() &&
      !pathStat.isSymbolicLink() &&
      descriptorStat.dev === outputIdentity.dev &&
      descriptorStat.ino === outputIdentity.ino &&
      pathStat.dev === outputIdentity.dev &&
      pathStat.ino === outputIdentity.ino &&
      descriptorStat.nlink === 1n &&
      pathStat.nlink === 1n &&
      (descriptorStat.mode & 0o777n) === BigInt(OWNER_ONLY_FILE_MODE) &&
      (pathStat.mode & 0o777n) === BigInt(OWNER_ONLY_FILE_MODE);
  };

  const writeChunk = message => {
    if (
      state !== 'writing' ||
      !Number.isSafeInteger(message.sequence) ||
      message.sequence !== expectedSequence
    ) {
      fail();
      return;
    }
    if (!currentDirectoryMatches(transactionIdentity, ancestries) || !currentOutputMatches()) {
      fail();
      return;
    }
    const chunk = normalizeChunk(message.data);
    if (!chunk || chunk.length === 0 || chunk.length > MAX_CHUNK_BYTES) {
      fail();
      return;
    }
    const nextTotal = bytesWritten + BigInt(chunk.length);
    if (nextTotal > expectedLength) {
      fail();
      return;
    }
    let offset = 0;
    while (offset < chunk.length) {
      const written = fs.writeSync(outputFd, chunk, offset, chunk.length - offset, null);
      if (written <= 0) {
        fail();
        return;
      }
      offset += written;
    }
    if (!currentDirectoryMatches(transactionIdentity, ancestries) || !currentOutputMatches()) {
      fail();
      return;
    }
    bytesWritten = nextTotal;
    expectedSequence++;
    port.postMessage({ type: 'ack', sequence: message.sequence });
  };

  const finishWrite = message => {
    if (
      state !== 'writing' ||
      !Number.isSafeInteger(message.sequence) ||
      message.sequence !== expectedSequence ||
      bytesWritten !== expectedLength
    ) {
      fail();
      return;
    }
    if (!currentDirectoryMatches(transactionIdentity, ancestries)) {
      fail();
      return;
    }
    fs.fsyncSync(outputFd);
    const finalStat = fs.fstatSync(outputFd, { bigint: true });
    const pathStat = fs.lstatSync(outputLeafName, { bigint: true });
    if (
      !finalStat.isFile() ||
      !pathStat.isFile() ||
      pathStat.isSymbolicLink() ||
      finalStat.dev !== outputIdentity.dev ||
      finalStat.ino !== outputIdentity.ino ||
      pathStat.dev !== outputIdentity.dev ||
      pathStat.ino !== outputIdentity.ino ||
      finalStat.nlink !== 1n ||
      pathStat.nlink !== 1n ||
      (finalStat.mode & 0o777n) !== BigInt(OWNER_ONLY_FILE_MODE) ||
      (pathStat.mode & 0o777n) !== BigInt(OWNER_ONLY_FILE_MODE)
    ) {
      fail();
      return;
    }
    if (!currentDirectoryMatches(transactionIdentity, ancestries)) {
      fail();
      return;
    }
    const completedBytes = bytesWritten;
    const completedIdentity = outputIdentity;
    const completedLeafName = outputLeafName;
    closeOutput();
    rememberOwnedOutput(completedLeafName, completedIdentity);
    resetOutput();
    state = 'idle';
    port.postMessage({
      type: 'complete',
      bytesWritten: `${completedBytes}`,
      outputIdentity: { dev: `${completedIdentity.dev}`, ino: `${completedIdentity.ino}` },
    });
  };

  port.on('message', event => {
    try {
      const message = event && Object.prototype.hasOwnProperty.call(event, 'data')
        ? event.data
        : event;
      if (!message || typeof message !== 'object') {
        fail();
      } else if (state === 'awaiting-init' && message.type === 'init-session') {
        initializeSession(message);
      } else if (state === 'idle' && message.type === 'write-start') {
        initializeWrite(message);
      } else if (state === 'awaiting-ownership-ack' && message.type === 'ownership-ack') {
        acknowledgeOwnership(message);
      } else if (state === 'idle' && message.type === 'cleanup') {
        initializeCleanup();
      } else if (state === 'idle' && message.type === 'release') {
        finish(0, { type: 'released' });
      } else if (message.type === 'chunk') {
        writeChunk(message);
      } else if (message.type === 'end') {
        finishWrite(message);
      } else {
        fail();
      }
    } catch (_) {
      fail();
    }
  });

  return { fail };
}

if (process.parentPort) startPackageTransactionWorker();

module.exports = {
  MAX_CHUNK_BYTES,
  OWNERSHIP_ACK_TIMEOUT_MS,
  startPackageTransactionWorker,
};
