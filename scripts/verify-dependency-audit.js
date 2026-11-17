'use strict';

// Dependency audit gate with one temporary, narrowly scoped exception.
//
// CI runs this script instead of `npm audit --audit-level=high`. It runs
// `npm audit --json` itself and fails on any high or critical finding, except
// the exact set of six dev-only findings caused by GHSA-fc5q-39xc-vjpf
// (picomatch ReDoS through crafted extglob patterns, no patched release). The
// exception expires at EXCEPTION_EXPIRES_AT and stops applying as soon as the
// pinned advisory fields, the affected report entries or lockfile entries, or
// their runtime reachability change. Report and lockfile structures it does
// not need to model (other report shapes, workspaces, links, bundles, other
// lockfile versions, non-canonical paths, non-registry sources) are rejected.
// With no high and no critical finding, entry or advisory, it passes without
// using the exception at all.
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

// npm audit JSON (report version 2, npm 10) entry and advisory shapes. Both are
// checked as total shapes: an unknown or missing field fails.
const ENTRY_KEYS = Object.freeze(['effects', 'fixAvailable', 'isDirect', 'name', 'nodes', 'range', 'severity', 'via']);
const ADVISORY_KEYS = Object.freeze(['cvss', 'cwe', 'dependency', 'name', 'range', 'severity', 'source', 'title', 'url']);
const METADATA_KEYS = Object.freeze(['dependencies', 'vulnerabilities']);
const DEPENDENCY_COUNT_KEYS = Object.freeze(['dev', 'optional', 'peer', 'peerOptional', 'prod', 'total']);

// Lockfile shape. Anything the verifier would otherwise have to model
// (workspaces, links, bundles, other lockfile versions, non-canonical paths)
// is rejected instead.
const LOCKFILE_KEYS = Object.freeze(['lockfileVersion', 'name', 'packages', 'requires', 'version']);
const DEPENDENCY_MAP_FIELDS = Object.freeze(['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']);
const RUNTIME_DECLARATION_FIELDS = Object.freeze(['dependencies', 'optionalDependencies', 'peerDependencies']);
const STRING_FIELDS = Object.freeze(['integrity', 'name', 'resolved', 'version']);
const BOOLEAN_FIELDS = Object.freeze(['dev', 'devOptional', 'optional', 'peer']);
const FORBIDDEN_FIELDS = Object.freeze(['bundleDependencies', 'bundledDependencies', 'inBundle', 'link', 'workspaces']);
const REGISTRY_HOST = 'registry.npmjs.org';
// The one lockfile entry not resolved from the registry: the reviewed,
// vendored http-cache-semantics backport.
const VENDORED_RESOLVED = Object.freeze({
  lockPath: 'node_modules/cacheable-request/node_modules/http-cache-semantics',
  resolved: 'file:vendor/crate-http-cache-semantics-backport-0.1.0.tgz',
});
const PACKAGE_NAME = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/u;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function hasExactKeys(object, keys) {
  return isDeepStrictEqual(Object.keys(object).sort(), [...keys]);
}

function isCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value !== '';
}

function severityRank(severity) {
  return SEVERITIES.indexOf(severity);
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

function advisoryShapeIsValid(item, entryName) {
  if (!isPlainObject(item) || !hasExactKeys(item, ADVISORY_KEYS)) return false;
  let url;
  try {
    url = new URL(item.url);
  } catch (error) {
    return false;
  }
  return Number.isSafeInteger(item.source) && item.source > 0 &&
    item.name === entryName && item.dependency === entryName &&
    isNonEmptyString(item.title) && url.protocol === 'https:' &&
    SEVERITIES.includes(item.severity) && isNonEmptyString(item.range) &&
    Array.isArray(item.cwe) && item.cwe.every(isNonEmptyString) &&
    isPlainObject(item.cvss) && typeof item.cvss.score === 'number' &&
    (item.cvss.vectorString === null || typeof item.cvss.vectorString === 'string');
}

// Rule a: total report shape. Every entry and every via member is checked,
// whatever its severity.
function reportStructureFailures(report) {
  if (!isPlainObject(report)) return [failure('report-shape', 'Audit report is not a JSON object.')];
  if (hasOwn(report, 'error')) {
    return [failure('report-error', 'npm audit reported an error instead of a report.')];
  }
  if (!hasExactKeys(report, REPORT_KEYS)) {
    return [failure('report-shape', `Audit report has unexpected top-level fields: ${Object.keys(report).sort().join(', ')}.`)];
  }
  if (report.auditReportVersion !== 2) {
    return [failure('report-version', 'Audit report version is not 2.')];
  }
  const { metadata } = report;
  if (!isPlainObject(metadata) || !hasExactKeys(metadata, METADATA_KEYS) ||
      !isPlainObject(metadata.vulnerabilities) || !hasExactKeys(metadata.vulnerabilities, [...SEVERITIES, 'total'].sort()) ||
      !isPlainObject(metadata.dependencies) || !hasExactKeys(metadata.dependencies, DEPENDENCY_COUNT_KEYS)) {
    return [failure('report-shape', 'Audit report metadata is missing or has unexpected fields.')];
  }
  const counts = metadata.vulnerabilities;
  if (![...SEVERITIES, 'total'].every(key => isCount(counts[key])) ||
      !DEPENDENCY_COUNT_KEYS.every(key => isCount(metadata.dependencies[key]))) {
    return [failure('report-shape', 'Audit report counts are not non-negative integers.')];
  }
  if (SEVERITIES.reduce((sum, key) => sum + counts[key], 0) !== counts.total) {
    return [failure('report-shape', 'Audit report severity counts do not add up to the total.')];
  }
  if (!isPlainObject(report.vulnerabilities)) {
    return [failure('report-shape', 'Audit report vulnerabilities is missing or not an object.')];
  }
  const failures = [];
  for (const [name, entry] of Object.entries(report.vulnerabilities)) {
    const label = JSON.stringify(name);
    if (!isPlainObject(entry) || !hasExactKeys(entry, ENTRY_KEYS) || entry.name !== name ||
        !SEVERITIES.includes(entry.severity) || typeof entry.isDirect !== 'boolean' ||
        typeof entry.range !== 'string' ||
        !(typeof entry.fixAvailable === 'boolean' || isPlainObject(entry.fixAvailable)) ||
        !Array.isArray(entry.effects) || !entry.effects.every(isNonEmptyString) ||
        !Array.isArray(entry.nodes) || entry.nodes.length === 0 || !entry.nodes.every(isNonEmptyString) ||
        !Array.isArray(entry.via) || entry.via.length === 0) {
      failures.push(failure('report-shape', `Audit report entry ${label} has an unexpected shape.`));
      continue;
    }
    for (const item of entry.via) {
      if (typeof item === 'string') {
        if (item === name || !hasOwn(report.vulnerabilities, item)) {
          failures.push(failure('report-via', `Audit report entry ${label} names a missing or self via ${JSON.stringify(item)}.`));
        }
      } else if (!advisoryShapeIsValid(item, name)) {
        failures.push(failure('report-advisory', `Audit report entry ${label} has a malformed advisory in via.`));
      }
    }
    for (const effect of entry.effects) {
      if (!hasOwn(report.vulnerabilities, effect)) {
        failures.push(failure('report-via', `Audit report entry ${label} names a missing effect ${JSON.stringify(effect)}.`));
      }
    }
  }
  return failures;
}

// Severity consistency, as npm derives it (@npmcli/arborist lib/vuln.js and
// @npmcli/metavuln-calculator lib/advisory.js): an entry's severity is the
// maximum over its advisories. An advisory object counts with its own
// severity; a string via is a metavuln that carries the severity of one
// advisory of the named entry, so it is at most that entry's severity (and may
// be lower: the real report has moderate dmg-builder via high
// app-builder-lib). Hence: own advisories <= entry severity <=
// max(own advisories, named entries). Every entry must also lead, through
// string vias, to an entry with an advisory object; cycles cannot justify
// themselves.
function severityConsistencyFailures(report) {
  const vulnerabilities = report.vulnerabilities;
  const failures = [];
  const rooted = new Set(Object.values(vulnerabilities)
    .filter(entry => entry.via.some(item => typeof item !== 'string'))
    .map(entry => entry.name));
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of Object.values(vulnerabilities)) {
      if (!rooted.has(entry.name) && entry.via.some(item => typeof item === 'string' && rooted.has(item))) {
        rooted.add(entry.name);
        changed = true;
      }
    }
  }
  for (const entry of Object.values(vulnerabilities)) {
    const own = Math.max(-1, ...entry.via.filter(item => typeof item !== 'string').map(item => severityRank(item.severity)));
    const named = Math.max(-1, ...entry.via.filter(item => typeof item === 'string')
      .map(item => severityRank(vulnerabilities[item].severity)));
    const rank = severityRank(entry.severity);
    if (rank < own || rank > Math.max(own, named)) {
      failures.push(failure('report-severity', `Audit report entry ${JSON.stringify(entry.name)} has severity ${entry.severity}, inconsistent with its via.`));
    }
    if (!rooted.has(entry.name)) {
      failures.push(failure('report-via', `Audit report entry ${JSON.stringify(entry.name)} does not lead to any advisory.`));
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

function advisoryObjects(report) {
  return Object.values(report.vulnerabilities).flatMap(entry => entry.via
    .filter(item => typeof item !== 'string')
    .map(item => ({ entryName: entry.name, item })));
}

function advisoryMatches(item) {
  return isPlainObject(item) &&
    item.source === EXCEPTION_ADVISORY.source &&
    item.name === EXCEPTION_ADVISORY.name &&
    item.dependency === EXCEPTION_ADVISORY.dependency &&
    item.url === EXCEPTION_ADVISORY.url &&
    item.severity === EXCEPTION_ADVISORY.severity &&
    item.range === EXCEPTION_ADVISORY.range;
}

// Rule d (report side): each excepted entry has exactly its expected via and
// nodes. For picomatch the pinned advisory fields are source, name,
// dependency, url, severity and range; title, cwe and cvss are not compared.
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

// A canonical nested install path: node_modules/<name>(/node_modules/<name>)*.
function isCanonicalLockPath(lockPath) {
  if (!lockPath.startsWith('node_modules/')) return false;
  return lockPath.slice('node_modules/'.length).split('/node_modules/')
    .every(name => PACKAGE_NAME.test(name) && name !== 'node_modules' && !name.endsWith('/node_modules'));
}

function installNameFromLockPath(lockPath) {
  return lockPath.slice(lockPath.lastIndexOf('node_modules/') + 'node_modules/'.length);
}

function parentLockPath(lockPath) {
  const index = lockPath.lastIndexOf('/node_modules/');
  return index === -1 ? '' : lockPath.slice(0, index);
}

// With only canonical nested install paths (checked first), Node's resolution
// is exact: <from>/node_modules/<name>, then the same at each ancestor
// install path, then node_modules/<name>.
function resolveLockPath(packages, fromPath, name) {
  let current = fromPath;
  while (true) {
    const candidate = current === '' ? `node_modules/${name}` : `${current}/node_modules/${name}`;
    if (hasOwn(packages, candidate)) return candidate;
    if (current === '') return null;
    current = parentLockPath(current);
  }
}

function dependencyMapIsValid(value) {
  return isPlainObject(value) && Object.entries(value).every(([name, spec]) => name !== '' && isNonEmptyString(spec));
}

function peerMetaIsValid(value) {
  return isPlainObject(value) && Object.values(value).every(meta => isPlainObject(meta) &&
    Object.entries(meta).every(([key, flag]) => key === 'optional' && typeof flag === 'boolean'));
}

function declarationFailures(label, object) {
  const failures = [];
  for (const field of FORBIDDEN_FIELDS) {
    if (hasOwn(object, field)) failures.push(failure('lockfile-shape', `${label}: ${field} is not supported.`));
  }
  for (const field of DEPENDENCY_MAP_FIELDS) {
    if (hasOwn(object, field) && !dependencyMapIsValid(object[field])) {
      failures.push(failure('lockfile-shape', `${label}: ${field} is not a map of names to non-empty specs.`));
    }
  }
  if (hasOwn(object, 'peerDependenciesMeta') && !peerMetaIsValid(object.peerDependenciesMeta)) {
    failures.push(failure('lockfile-shape', `${label}: peerDependenciesMeta is malformed.`));
  }
  return failures;
}

// Rule e (structure): everything the verifier does not model is rejected.
function lockfileStructureFailures(lockfile, manifest) {
  if (!isPlainObject(lockfile) || !isPlainObject(manifest)) {
    return [failure('lockfile-shape', 'package-lock.json or package.json could not be inspected.')];
  }
  if (lockfile.lockfileVersion !== 3) {
    return [failure('lockfile-shape', 'package-lock.json lockfileVersion is not 3.')];
  }
  const keys = Object.keys(lockfile);
  if (!keys.every(key => LOCKFILE_KEYS.includes(key)) || !isPlainObject(lockfile.packages) ||
      !isPlainObject(lockfile.packages[''])) {
    return [failure('lockfile-shape', 'package-lock.json has unexpected top-level fields or no packages.')];
  }
  const failures = [...declarationFailures('package.json', manifest)];
  for (const [lockPath, entry] of Object.entries(lockfile.packages)) {
    const label = lockPath === '' ? 'lockfile root' : lockPath;
    if (lockPath !== '' && !isCanonicalLockPath(lockPath)) {
      failures.push(failure('lockfile-path', `Lockfile key ${JSON.stringify(lockPath)} is not a canonical nested install path.`));
      continue;
    }
    if (!isPlainObject(entry)) {
      failures.push(failure('lockfile-shape', `${label}: entry is not an object.`));
      continue;
    }
    failures.push(...declarationFailures(label, entry));
    for (const field of STRING_FIELDS) {
      if (hasOwn(entry, field) && typeof entry[field] !== 'string') {
        failures.push(failure('lockfile-shape', `${label}: ${field} is not a string.`));
      }
    }
    for (const field of BOOLEAN_FIELDS) {
      if (hasOwn(entry, field) && typeof entry[field] !== 'boolean') {
        failures.push(failure('lockfile-shape', `${label}: ${field} is not a boolean.`));
      }
    }
  }
  return failures;
}

function parseRegistryTarballName(resolved) {
  let url;
  try {
    url = new URL(resolved);
  } catch (error) {
    return null;
  }
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname).toLowerCase();
  } catch (error) {
    pathname = url.pathname.toLowerCase();
  }
  for (const name of EXCEPTED_NAMES) {
    const tarball = name.includes('/') ? name.split('/')[1] : name;
    if (pathname.startsWith(`/${name}/-/${tarball}-`) && pathname.endsWith('.tgz')) return name;
  }
  return null;
}

// Which of the six packages an entry is, by any of: install path, name field,
// registry-style tarball path on any host and scheme, or an expected integrity
// value anywhere in its integrity string.
function identifiedNames(lockPath, entry) {
  const names = new Set();
  const installName = installNameFromLockPath(lockPath);
  if (EXCEPTED_NAMES.includes(installName)) names.add(installName);
  if (EXCEPTED_NAMES.includes(entry.name)) names.add(entry.name);
  if (typeof entry.resolved === 'string') {
    const fromUrl = parseRegistryTarballName(entry.resolved);
    if (fromUrl) names.add(fromUrl);
  }
  if (typeof entry.integrity === 'string') {
    for (const expected of EXCEPTED_FINDINGS) {
      if (entry.integrity.includes(expected.integrity)) names.add(expected.name);
    }
  }
  return names;
}

function resolvedSourceIsApproved(lockPath, resolved) {
  if (lockPath === VENDORED_RESOLVED.lockPath && resolved === VENDORED_RESOLVED.resolved) return true;
  let url;
  try {
    url = new URL(resolved);
  } catch (error) {
    return false;
  }
  return url.protocol === 'https:' && url.hostname === REGISTRY_HOST && url.host === REGISTRY_HOST &&
    url.username === '' && url.password === '' && url.search === '' && url.hash === '' &&
    resolved.startsWith(`https://${REGISTRY_HOST}/`);
}

function runtimeEdges(entry) {
  const edges = [];
  const optional = entry.optionalDependencies || {};
  const peerMeta = entry.peerDependenciesMeta || {};
  for (const name of Object.keys(entry.dependencies || {})) edges.push({ name, optional: false });
  for (const name of Object.keys(optional)) {
    edges.push({ name, optional: !hasOwn(entry.dependencies || {}, name) });
  }
  for (const name of Object.keys(entry.peerDependencies || {})) {
    edges.push({ name, optional: isPlainObject(peerMeta[name]) && peerMeta[name].optional === true });
  }
  return edges;
}

// Closure of lockfile paths reachable from the root manifest's runtime
// declarations (dependencies, optionalDependencies, peerDependencies). An
// unresolved required edge is reported; an unresolved edge is tolerated only
// when declared optional (optionalDependencies, or peerDependenciesMeta
// optional: true). Call only after lockfileStructureFailures passed.
function runtimeClosure(lockfile, manifest) {
  const packages = lockfile.packages;
  const visited = new Set();
  const unresolved = [];
  const pending = runtimeEdges(manifest).map(edge => ({ from: '', edge }));
  while (pending.length > 0) {
    const { from, edge } = pending.pop();
    const target = resolveLockPath(packages, from, edge.name);
    if (target === null) {
      if (!edge.optional) unresolved.push(`${from || '<root>'} -> ${edge.name}`);
      continue;
    }
    if (visited.has(target)) continue;
    visited.add(target);
    for (const next of runtimeEdges(packages[target])) pending.push({ from: target, edge: next });
  }
  return { paths: visited, unresolved: unresolved.sort() };
}

// Rules d and e: lockfile identity, single location, sources and runtime
// reachability.
function lockfileFailures(lockfile, manifest) {
  const structure = lockfileStructureFailures(lockfile, manifest);
  if (structure.length > 0) return structure;
  const packages = lockfile.packages;
  const failures = [];

  for (const field of RUNTIME_DECLARATION_FIELDS) {
    if (!isDeepStrictEqual(manifest[field] || {}, packages[''][field] || {})) {
      failures.push(failure('lockfile-root', `package.json and the lockfile root disagree on ${field}.`));
    }
  }

  for (const expected of EXCEPTED_FINDINGS) {
    const entry = packages[expected.lockPath];
    if (!entry) {
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
    if (hasOwn(entry, 'name')) {
      failures.push(failure('lockfile-entry', `${expected.name}: lockfile entry is aliased.`));
    }
  }

  const expectedPaths = new Map(EXCEPTED_FINDINGS.map(item => [item.name, item.lockPath]));
  for (const [lockPath, entry] of Object.entries(packages)) {
    if (lockPath === '') continue;
    if (hasOwn(entry, 'resolved') && !resolvedSourceIsApproved(lockPath, entry.resolved)) {
      failures.push(failure('lockfile-source', `${lockPath} is not resolved from https://${REGISTRY_HOST}/.`));
    }
    for (const name of identifiedNames(lockPath, entry)) {
      if (expectedPaths.get(name) !== lockPath) {
        failures.push(failure('duplicate-path', `${name} also appears in the lockfile at ${lockPath}.`));
      }
    }
  }

  const closure = runtimeClosure(lockfile, manifest);
  if (closure.unresolved.length > 0) {
    failures.push(failure('runtime-unresolved', `Required runtime dependencies do not resolve in the lockfile: ${closure.unresolved.join(', ')}.`));
  }
  for (const lockPath of [...closure.paths].sort()) {
    if (identifiedNames(lockPath, packages[lockPath]).size > 0) {
      failures.push(failure('runtime-reachability', `${lockPath} is reachable from runtime dependencies.`));
    }
  }
  return failures;
}

function evaluateDependencyAudit({ report, lockfile, manifest, now }) {
  const structure = reportStructureFailures(report);
  if (structure.length > 0) return { ok: false, usedException: false, failures: structure, counts: null };
  const counts = report.metadata.vulnerabilities;
  const entries = Object.values(report.vulnerabilities);
  const advisories = advisoryObjects(report);
  const failures = [...severityConsistencyFailures(report)];

  // Rule b: no critical finding, as an entry or as an advisory anywhere.
  const criticalEntries = entries.filter(entry => entry.severity === 'critical').map(entry => entry.name).sort();
  const criticalAdvisories = advisories.filter(({ item }) => item.severity === 'critical').map(({ entryName }) => entryName).sort();
  if (counts.critical !== 0 || criticalEntries.length !== 0 || criticalAdvisories.length !== 0) {
    failures.push(failure(
      'critical',
      `Critical findings are never excepted (metadata ${counts.critical}, entries: ${criticalEntries.join(', ') || 'none'}, advisories under: ${criticalAdvisories.join(', ') || 'none'}).`
    ));
  }
  failures.push(...countFailures(report).filter(item => item.rule !== 'critical'));

  // Any high or critical advisory other than the pinned picomatch advisory
  // fails, whatever the severity of the entry that lists it.
  for (const { entryName, item } of advisories) {
    if (severityRank(item.severity) >= severityRank('high') &&
        !(entryName === EXCEPTION_ADVISORY.name && advisoryMatches(item))) {
      failures.push(failure('advisory-severity', `A ${item.severity} advisory (${item.url}) under ${JSON.stringify(entryName)} is not excepted.`));
    }
  }

  const highNames = entries.filter(entry => entry.severity === 'high').map(entry => entry.name).sort();
  const highAdvisories = advisories.filter(({ item }) => severityRank(item.severity) >= severityRank('high'));
  if (failures.length === 0 && counts.high === 0 && highNames.length === 0 && highAdvisories.length === 0) {
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
    const reason = result.error.code === 'ENOBUFS'
      ? `its output exceeded ${AUDIT_MAX_OUTPUT_BYTES} bytes`
      : `it could not be run (${result.error.code || 'error'})`;
    return { stdout: null, failure: failure('report-json', `npm audit failed: ${reason}.`) };
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
