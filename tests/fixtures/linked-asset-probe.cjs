'use strict';

// External parent owns the timeout; a synchronous regex cannot run its own timer.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { mainExtractor } = require('./linked-asset-main.cjs');
const config = JSON.parse(fs.readFileSync(0, 'utf8'));
const root = path.resolve(config.root);
const buffer = Buffer.from('/Users/synthetic/asset.psb '.repeat(config.repeats));
const filePath = '/synthetic/metadata.psd';
const { runBoundedAddFilesScan } = require(path.join(root, 'parsers/add-files-operation.js'));
const main = mainExtractor(root);
const worker = require(path.join(root, 'parsers/add-files-regex-worker.js'));

(async () => {
  const start = process.hrtime.bigint();
  let paths;
  let leaseAtReturn;
  const run = async lease => {
    paths = config.route === 'worker'
      ? worker.extractLinkedAssetsFromBuffer(buffer, filePath)
      : await main(filePath, { strict: true, sourceBuffer: buffer });
    leaseAtReturn = lease?.state;
    return paths.length;
  };
  const outcome = config.leaseMs === undefined
    ? { value: await run() }
    : await runBoundedAddFilesScan(run, { timeoutMs: config.leaseMs });
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  console.log(JSON.stringify({
    route: config.route, bytes: buffer.length, elapsedMs, count: paths.length,
    outputDigest: crypto.createHash('sha256').update(JSON.stringify(paths)).digest('hex'),
    timedOut: outcome.timedOut === true, cancelled: outcome.cancelled === true,
    leaseAtReturn, leaseAtOutcome: outcome.lease?.state,
  }));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
