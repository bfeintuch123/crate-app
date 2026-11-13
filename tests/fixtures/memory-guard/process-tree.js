'use strict';
// Helper for tests/run-tests-memory-guard.test.js, not a test. Becomes one idle
// process of a small process tree:
//
//   node process-tree.js <pid file> '<json>'
//
// where <json> is { role, life, detached, ignoreTerm, children: [<json>, ...] }.
// It appends "<role> <pid>" to the pid file, starts its children (a detached
// child gets its own session and process group), and exits by itself after
// `life` milliseconds whether or not anyone stops it.
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const pidFile = process.argv[2];
const spec = JSON.parse(process.argv[3]);

if (spec.ignoreTerm) process.on('SIGTERM', () => {});
fs.appendFileSync(pidFile, `${spec.role} ${process.pid}\n`);
for (const child of spec.children || []) {
  spawn(process.execPath, [__filename, pidFile, JSON.stringify(child)], { stdio: 'ignore', detached: child.detached === true }).unref();
}
setTimeout(() => process.exit(0), spec.life);
