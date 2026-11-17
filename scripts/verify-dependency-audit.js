'use strict';

// Dependency audit gate with one temporary, narrowly scoped exception.
//
// CI runs this script instead of `npm audit --audit-level=high`. It runs
// `npm audit --json` itself and fails on any high or critical finding, except
// the exact set of six dev-only findings caused by GHSA-fc5q-39xc-vjpf
// (picomatch ReDoS through crafted extglob patterns, no patched release). The
// exception expires at EXCEPTION_EXPIRES_AT and stops applying as soon as the
// advisory, the affected lockfile entries, or their runtime reachability
// change. With no high and no critical findings it passes without using the
// exception at all.
//
// No argument, environment variable or file substitutes the report, moves the
// expiry or disables a check. The environment is passed to npm unchanged so
// the workflow's npm configuration applies to the audit exactly as before.

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');

const AUDIT_ARGS = Object.freeze(['audit', '--json', '--registry=https://registry.npmjs.org/']);
const AUDIT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const SEVERITIES = Object.freeze(['info', 'low', 'moderate', 'high', 'critical']);
const REPORT_KEYS = Object.freeze(['auditReportVersion', 'metadata', 'vulnerabilities']);

const EXCEPTION_ADVISORY = Object.freeze({
  id: 'GHSA-fc5q-39xc-vjpf',
  source: 1247710,
  name: 'picomatch',
  dependency: 'picomatch',
  url: 'https://github.com/advisories/GHSA-fc5q-39xc-vjpf',
  severity: 'high',
  range: '<=4.0.7',
});
const EXCEPTION_EXPIRES_AT = '2026-11-20T23:59:59Z';
const EXCEPTION_EXPIRES_AT_MS = Date.parse(EXCEPTION_EXPIRES_AT);

const EXCEPTED_FINDINGS = Object.freeze([
  Object.freeze({
    name: 'picomatch',
    lockPath: 'node_modules/tinyglobby/node_modules/picomatch',
    version: '4.0.5',
    resolved: 'https://registry.npmjs.org/picomatch/-/picomatch-4.0.5.tgz',
    integrity: 'sha512-RvwwcruNjI1ncT5xRakeyS9Lf8lcItv34KD+aif+VH9kduAyfYBipGh12274xtenIPZ119/R9BdTBa8gAwSh0A==',
    via: Object.freeze([EXCEPTION_ADVISORY]),
  }),
  Object.freeze({
    name: 'fdir',
    lockPath: 'node_modules/tinyglobby/node_modules/fdir',
    version: '6.5.0',
    resolved: 'https://registry.npmjs.org/fdir/-/fdir-6.5.0.tgz',
    integrity: 'sha512-tIbYtZbucOs0BRGqPJkshJUYdL+SDH7dVM8gjy+ERp3WAUjLEFJE+02kanyHtwjWOnwrKYBiwAmM0p4kLJAnXg==',
    via: Object.freeze(['picomatch']),
  }),
  Object.freeze({
    name: 'tinyglobby',
    lockPath: 'node_modules/tinyglobby',
    version: '0.2.17',
    resolved: 'https://registry.npmjs.org/tinyglobby/-/tinyglobby-0.2.17.tgz',
    integrity: 'sha512-wXR/dYpcqKmfWpEdZjiKJOwCNFndD0DMnrW/cYjVGttEkBfVgcLFHoNrlj47mjOVic9yyNu65alsgF4NQyTa2g==',
    via: Object.freeze(['fdir', 'picomatch']),
  }),
  Object.freeze({
    name: 'node-gyp',
    lockPath: 'node_modules/node-gyp',
    version: '12.4.0',
    resolved: 'https://registry.npmjs.org/node-gyp/-/node-gyp-12.4.0.tgz',
    integrity: 'sha512-OMcPNvqTCFUnNaBlmdgq+lfNqY7gTiSmNRDjY3uAXRyudeKZEZxu3CLtjMQrx4zZxCX2b/mpNqTtwuCJgXhHkw==',
    via: Object.freeze(['tinyglobby']),
  }),
  Object.freeze({
    name: '@electron/rebuild',
    lockPath: 'node_modules/@electron/rebuild',
    version: '4.2.0',
    resolved: 'https://registry.npmjs.org/@electron/rebuild/-/rebuild-4.2.0.tgz',
    integrity: 'sha512-RKL/O+jGoXJMxrx/5771y1n0xTKmFuOYGO3gMmwypBM6rsH0kou0mswwdXA2JrhIkE4xyC7v9vGk0n6NPzgOxQ==',
    via: Object.freeze(['node-gyp']),
  }),
  Object.freeze({
    name: 'app-builder-lib',
    lockPath: 'node_modules/app-builder-lib',
    version: '26.15.7',
    resolved: 'https://registry.npmjs.org/app-builder-lib/-/app-builder-lib-26.15.7.tgz',
    integrity: 'sha512-C7APoYISPExUmrEntNhDpz9Tccb4uWuEDfLaC0WPPc7/pwzz0WZGznCz/ycPfkkzw6tKOalceD8g6TgHmVz1QA==',
    via: Object.freeze(['@electron/rebuild', 'dmg-builder', 'electron-builder-squirrel-windows', 'minimatch']),
  }),
]);
const EXCEPTED_NAMES = Object.freeze(EXCEPTED_FINDINGS.map(item => item.name));
const RUNTIME_EDGE_FIELDS = Object.freeze(['dependencies', 'optionalDependencies', 'peerDependencies']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function isCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function failure(rule, message) {
  return Object.freeze({ rule, message });
}

// Rule a (part): the audit output must be one JSON document.
function parseAuditOutput(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    return { report: null, failure: failure('report-json', 'npm audit printed no report.') };
  }
  try {
    return { report: JSON.parse(text), failure: null };
  } catch (error) {
    return { report: null, failure: failure('report-json', 'npm audit output is not valid JSON.') };
  }
}

// Rule a: report shape.
function reportShapeFailures(report) {
  if (!isPlainObject(report)) return [failure('report-shape', 'Audit report is not a JSON object.')];
  if (Object.prototype.hasOwnProperty.call(report, 'error')) {
    return [failure('report-error', 'npm audit reported an error instead of a report.')];
  }
  const keys = Object.keys(report).sort();
  if (!isDeepStrictEqual(keys, [...REPORT_KEYS])) {
    return [failure('report-shape', `Audit report has unexpected top-level fields: ${keys.join(', ')}.`)];
  }
  if (report.auditReportVersion !== 2) {
    return [failure('report-version', 'Audit report version is not 2.')];
  }
  if (!isPlainObject(report.metadata) || !isPlainObject(report.metadata.vulnerabilities)) {
    return [failure('report-shape', 'Audit report metadata.vulnerabilities is missing or not an object.')];
  }
  const counts = report.metadata.vulnerabilities;
  if (![...SEVERITIES, 'total'].every(key => isCount(counts[key]))) {
    return [failure('report-shape', 'Audit report severity counts are missing or not non-negative integers.')];
  }
  if (SEVERITIES.reduce((sum, key) => sum + counts[key], 0) !== counts.total) {
    return [failure('report-shape', 'Audit report severity counts do not add up to the total.')];
  }
  if (!isPlainObject(report.vulnerabilities)) {
    return [failure('report-shape', 'Audit report vulnerabilities is missing or not an object.')];
  }
  const failures = [];
  for (const [name, entry] of Object.entries(report.vulnerabilities)) {
    if (!isPlainObject(entry) || entry.name !== name || !SEVERITIES.includes(entry.severity) ||
        !Array.isArray(entry.via) || entry.via.length === 0 ||
        !entry.via.every(item => typeof item === 'string' || isPlainObject(item)) ||
        !Array.isArray(entry.nodes) || !entry.nodes.every(item => typeof item === 'string')) {
      failures.push(failure('report-shape', `Audit report entry ${JSON.stringify(name)} has an unexpected shape.`));
    }
  }
  return failures;
}

// Rules b and c (counts): metadata counts agree with the listed entries.
function countFailures(report) {
  const counts = report.metadata.vulnerabilities;
  const failures = [];
  for (const severity of SEVERITIES) {
    const listed = Object.values(report.vulnerabilities).filter(entry => entry.severity === severity).length;
    if (listed !== counts[severity]) {
      failures.push(failure(
        severity === 'critical' ? 'critical' : severity === 'high' ? 'high-count' : 'report-counts',
        `Audit report counts ${counts[severity]} ${severity} findings in metadata but lists ${listed}.`
      ));
    }
  }
  return failures;
}

function installNameFromLockPath(lockPath) {
  const index = lockPath.lastIndexOf('node_modules/');
  return index === -1 ? null : lockPath.slice(index + 'node_modules/'.length);
}

function parentLockPath(lockPath) {
  const index = lockPath.lastIndexOf('/node_modules/');
  return index === -1 ? '' : lockPath.slice(0, index);
}

// Node's nested resolution: <from>/node_modules/<name>, then each ancestor.
function resolveLockPath(packages, fromPath, name) {
  let current = fromPath;
  while (true) {
    const candidate = current === '' ? `node_modules/${name}` : `${current}/node_modules/${name}`;
    if (Object.prototype.hasOwnProperty.call(packages, candidate)) return candidate;
    if (current === '') return null;
    current = parentLockPath(current);
  }
}

function edgeNames(entry) {
  const names = [];
  if (!isPlainObject(entry)) return names;
  for (const field of RUNTIME_EDGE_FIELDS) {
    if (entry[field] === undefined) continue;
    if (!isPlainObject(entry[field])) return null;
    names.push(...Object.keys(entry[field]).map(name => ({ name, field })));
  }
  return names;
}

// Closure of lockfile paths reachable from the root manifest's runtime
// dependencies (dependencies, optionalDependencies, peerDependencies), with
// Node's nested resolution. Links are followed to their targets.
function runtimeClosure(lockfile, manifest) {
  const packages = lockfile.packages;
  const rootEdges = [...(edgeNames(manifest) || []), ...(edgeNames(packages['']) || [])];
  if (edgeNames(manifest) === null || edgeNames(packages['']) === null) {
    return { paths: null, unresolved: [] };
  }
  const visited = new Set();
  const unresolved = [];
  const pending = rootEdges.map(edge => ({ from: '', edge }));
  while (pending.length > 0) {
    const { from, edge } = pending.pop();
    let target = resolveLockPath(packages, from, edge.name);
    if (target === null) {
      // Uninstalled optional or peer edges are not part of the runtime tree.
      if (edge.field === 'dependencies') unresolved.push(`${from || '<root>'} -> ${edge.name}`);
      continue;
    }
    const seenLinks = new Set();
    while (isPlainObject(packages[target]) && packages[target].link === true) {
      if (seenLinks.has(target)) return { paths: null, unresolved };
      seenLinks.add(target);
      visited.add(target);
      target = packages[target].resolved;
      if (typeof target !== 'string' || !Object.prototype.hasOwnProperty.call(packages, target)) {
        return { paths: null, unresolved };
      }
    }
    if (visited.has(target)) continue;
    visited.add(target);
    const edges = edgeNames(packages[target]);
    if (edges === null) return { paths: null, unresolved };
    for (const next of edges) pending.push({ from: target, edge: next });
  }
  return { paths: visited, unresolved };
}

// Rules d and e: lockfile identity, single location and runtime reachability.
function lockfileFailures(lockfile, manifest) {
  if (!isPlainObject(lockfile) || !isPlainObject(lockfile.packages) ||
      !isPlainObject(lockfile.packages['']) || !isPlainObject(manifest)) {
    return [failure('lockfile-shape', 'package-lock.json or package.json could not be inspected.')];
  }
  const packages = lockfile.packages;
  const failures = [];
  for (const expected of EXCEPTED_FINDINGS) {
    const entry = packages[expected.lockPath];
    if (!isPlainObject(entry)) {
      failures.push(failure('lockfile-entry', `${expected.name}: no lockfile entry at ${expected.lockPath}.`));
      continue;
    }
    if (entry.version !== expected.version) {
      failures.push(failure('lockfile-version', `${expected.name}: lockfile version is not exactly ${expected.version}.`));
    }
    if (entry.integrity !== expected.integrity) {
      failures.push(failure('lockfile-integrity', `${expected.name}: lockfile integrity is not exactly the approved value.`));
    }
    if (entry.resolved !== expected.resolved) {
      failures.push(failure('lockfile-resolved', `${expected.name}: lockfile resolved is not exactly ${expected.resolved}.`));
    }
    if (entry.dev !== true) {
      failures.push(failure('lockfile-dev', `${expected.name}: lockfile entry is not dev-only.`));
    }
    if (entry.link !== undefined || entry.inBundle !== undefined || entry.name !== undefined) {
      failures.push(failure('lockfile-entry', `${expected.name}: lockfile entry is linked, bundled or aliased.`));
    }
  }

  const expectedPaths = new Map(EXCEPTED_FINDINGS.map(item => [item.name, item.lockPath]));
  for (const [lockPath, entry] of Object.entries(packages)) {
    if (lockPath === '') continue;
    const names = new Set([installNameFromLockPath(lockPath)]);
    if (isPlainObject(entry) && typeof entry.name === 'string') names.add(entry.name);
    if (isPlainObject(entry) && typeof entry.resolved === 'string') {
      for (const name of EXCEPTED_NAMES) {
        const tarball = name.startsWith('@') ? name.split('/')[1] : name;
        if (entry.resolved.startsWith(`https://registry.npmjs.org/${name}/-/${tarball}-`)) names.add(name);
      }
    }
    for (const name of names) {
      if (expectedPaths.has(name) && expectedPaths.get(name) !== lockPath) {
        failures.push(failure('duplicate-path', `${name} also appears in the lockfile at ${lockPath}.`));
      }
    }
  }

  const closure = runtimeClosure(lockfile, manifest);
  if (closure.paths === null) {
    failures.push(failure('runtime-reachability', 'Runtime dependency closure could not be computed from the lockfile.'));
  } else {
    if (closure.unresolved.length > 0) {
      failures.push(failure(
        'runtime-reachability',
        `Runtime dependencies do not resolve in the lockfile: ${closure.unresolved.sort().join(', ')}.`
      ));
    }
    for (const lockPath of [...closure.paths].sort()) {
      const entry = packages[lockPath];
      const name = installNameFromLockPath(lockPath);
      if (EXCEPTED_NAMES.includes(name) ||
          (isPlainObject(entry) && EXCEPTED_NAMES.includes(entry.name)) ||
          EXCEPTED_FINDINGS.some(item => item.lockPath === lockPath)) {
        failures.push(failure('runtime-reachability', `${lockPath} is reachable from runtime dependencies.`));
      }
    }
  }
  return failures;
}

function advisoryMatches(item) {
  if (!isPlainObject(item)) return false;
  return item.source === EXCEPTION_ADVISORY.source &&
    item.name === EXCEPTION_ADVISORY.name &&
    item.dependency === EXCEPTION_ADVISORY.dependency &&
    item.url === EXCEPTION_ADVISORY.url &&
    item.severity === EXCEPTION_ADVISORY.severity &&
    item.range === EXCEPTION_ADVISORY.range;
}

// Rule d (report side): each excepted entry has exactly its expected via and nodes.
function exceptedEntryFailures(report) {
  const failures = [];
  for (const expected of EXCEPTED_FINDINGS) {
    const entry = report.vulnerabilities[expected.name];
    if (!entry || entry.severity !== 'high') continue; // reported by the high-set rule
    if (expected.name === 'picomatch') {
      if (entry.via.length !== 1 || !advisoryMatches(entry.via[0])) {
        failures.push(failure(
          'advisory',
          `picomatch: via must be exactly one advisory ${EXCEPTION_ADVISORY.id} (${EXCEPTION_ADVISORY.url}, severity high, range ${EXCEPTION_ADVISORY.range}).`
        ));
      }
    } else if (!entry.via.every(item => typeof item === 'string') ||
        !isDeepStrictEqual([...entry.via].sort(), [...expected.via].sort())) {
      failures.push(failure('via', `${expected.name}: via is not exactly [${expected.via.join(', ')}].`));
    }
    if (!isDeepStrictEqual(entry.nodes, [expected.lockPath])) {
      failures.push(failure('nodes', `${expected.name}: nodes is not exactly [${expected.lockPath}].`));
    }
  }
  return failures;
}

function evaluateDependencyAudit({ report, lockfile, manifest, now }) {
  const shape = reportShapeFailures(report);
  if (shape.length > 0) return { ok: false, usedException: false, failures: shape, counts: null };
  const counts = report.metadata.vulnerabilities;
  const entries = Object.values(report.vulnerabilities);
  const failures = [];

  // Rule b: no critical findings.
  const criticalEntries = entries.filter(entry => entry.severity === 'critical').map(entry => entry.name).sort();
  if (counts.critical !== 0 || criticalEntries.length !== 0) {
    failures.push(failure(
      'critical',
      `Critical findings are never excepted (metadata ${counts.critical}, listed: ${criticalEntries.join(', ') || 'none'}).`
    ));
  }
  failures.push(...countFailures(report).filter(item => item.rule !== 'critical'));

  const highNames = entries.filter(entry => entry.severity === 'high').map(entry => entry.name).sort();
  if (failures.length === 0 && counts.high === 0 && highNames.length === 0) {
    return { ok: true, usedException: false, failures: [], counts };
  }

  // Rule c: the high set is exactly the six excepted findings.
  const extra = highNames.filter(name => !EXCEPTED_NAMES.includes(name));
  const missing = EXCEPTED_NAMES.filter(name => !highNames.includes(name));
  if (extra.length > 0) {
    failures.push(failure('high-set', `High findings outside the ${EXCEPTION_ADVISORY.id} exception: ${extra.join(', ')}.`));
  }
  if (missing.length > 0) {
    failures.push(failure('high-set', `The dependency tree changed; expected high findings are missing: ${missing.join(', ')}. Re-evaluate the exception.`));
  }
  if (counts.high !== EXCEPTED_FINDINGS.length || highNames.length !== EXCEPTED_FINDINGS.length) {
    failures.push(failure('high-count', `Expected exactly ${EXCEPTED_FINDINGS.length} high findings; metadata counts ${counts.high} and the report lists ${highNames.length}.`));
  }

  // Rules d and e.
  failures.push(...exceptedEntryFailures(report));
  failures.push(...lockfileFailures(lockfile, manifest));

  // Rule f: expiry, inclusive of the exact expiry instant.
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    failures.push(failure('expiry', 'Current time is not a valid date.'));
  } else if (now.getTime() > EXCEPTION_EXPIRES_AT_MS) {
    failures.push(failure('expiry', `The ${EXCEPTION_ADVISORY.id} exception expired at ${EXCEPTION_EXPIRES_AT}.`));
  }

  return { ok: failures.length === 0, usedException: failures.length === 0, failures, counts };
}

function formatResult(result) {
  if (!result.ok) {
    return {
      output: [],
      errors: [
        `Dependency audit gate failed: [${result.failures[0].rule}] ${result.failures[0].message}`,
        'All violations:',
        ...result.failures.map(item => `- [${item.rule}] ${item.message}`),
      ],
    };
  }
  const { counts } = result;
  const lower = `Findings below high (not gating): moderate ${counts.moderate}, low ${counts.low}, info ${counts.info}.`;
  if (!result.usedException) {
    return { output: ['Dependency audit gate passed: no high or critical findings.', lower], errors: [] };
  }
  return {
    output: [
      `Dependency audit gate passed under a TEMPORARY exception for ${EXCEPTION_ADVISORY.id} (${EXCEPTION_ADVISORY.url}, range ${EXCEPTION_ADVISORY.range}).`,
      `Excepted dev-only high findings: ${EXCEPTED_FINDINGS.map(item => item.lockPath).join(', ')}.`,
      `The exception expires at ${EXCEPTION_EXPIRES_AT} and applies only to this exact set.`,
      lower,
    ],
    errors: [],
  };
}

function runNpmAudit(projectRoot) {
  const result = childProcess.spawnSync('npm', AUDIT_ARGS, {
    cwd: projectRoot,
    encoding: 'utf8',
    maxBuffer: AUDIT_MAX_OUTPUT_BYTES,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) {
    return { stdout: null, failure: failure('report-json', `npm audit could not be run (${result.error.code || 'error'}).`) };
  }
  if (result.signal !== null || (result.status !== 0 && result.status !== 1)) {
    return {
      stdout: null,
      failure: failure('report-json', `npm audit ended unexpectedly (${result.signal ? `signal ${result.signal}` : `status ${result.status}`}).`),
    };
  }
  return { stdout: result.stdout, failure: null };
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    return null;
  }
}

function run(argv = process.argv.slice(2), dependencies = {}) {
  const writeOutput = dependencies.writeOutput || console.log;
  const writeError = dependencies.writeError || console.error;
  const setExitCode = dependencies.setExitCode || (code => { process.exitCode = code; });
  if (argv.length !== 0) {
    writeError('Usage: node scripts/verify-dependency-audit.js');
    setExitCode(2);
    return { exitCode: 2, result: null };
  }
  const projectRoot = path.resolve(__dirname, '..');
  const audit = runNpmAudit(projectRoot);
  let result;
  if (audit.failure) {
    result = { ok: false, usedException: false, failures: [audit.failure], counts: null };
  } else {
    const parsed = parseAuditOutput(audit.stdout);
    result = parsed.failure
      ? { ok: false, usedException: false, failures: [parsed.failure], counts: null }
      : evaluateDependencyAudit({
        report: parsed.report,
        lockfile: readJsonFile(path.join(projectRoot, 'package-lock.json')),
        manifest: readJsonFile(path.join(projectRoot, 'package.json')),
        now: new Date(),
      });
  }
  const formatted = formatResult(result);
  if (formatted.output.length > 0) writeOutput(formatted.output.join('\n'));
  if (formatted.errors.length > 0) writeError(formatted.errors.join('\n'));
  const exitCode = result.ok ? 0 : 1;
  if (exitCode !== 0) setExitCode(exitCode);
  return { exitCode, result };
}

if (require.main === module) run();

module.exports = {
  AUDIT_ARGS,
  EXCEPTED_FINDINGS,
  EXCEPTION_ADVISORY,
  EXCEPTION_EXPIRES_AT,
  evaluateDependencyAudit,
  formatResult,
  parseAuditOutput,
  run,
  runtimeClosure,
};
