'use strict';

const assert = require('./bounded-assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  AUDIT_ARGS,
  EXCEPTED_FINDINGS,
  EXCEPTION_ADVISORY,
  EXCEPTION_EXPIRES_AT,
  evaluateDependencyAudit,
  formatResult,
  parseAuditOutput,
  runtimeClosure,
} = require('../scripts/verify-dependency-audit');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'verify-dependency-audit.js');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'security-gate.yml');
// How the fixture was produced, the way CI obtains the report: on 2026-11-17,
// at v2.4.x 21f386d, with Node 22.23.1 and npm 10.9.8, run
// `npm ci --ignore-scripts --registry=https://registry.npmjs.org/` and then
// `npm audit --json --registry=https://registry.npmjs.org/` in the checkout,
// saving stdout unchanged. On that machine, a lockfile-only run (package.json
// and package-lock.json alone in an empty directory) printed the same report.
const REAL_REPORT_TEXT = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'dependency-audit', 'audit-report-2026-11-17.json'),
  'utf8'
);
const REAL_REPORT = JSON.parse(REAL_REPORT_TEXT);
const LIVE_LOCKFILE = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
const LIVE_MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const BEFORE_EXPIRY = new Date('2026-11-17T12:00:00Z');
const EXPIRY_MS = Date.parse('2026-11-20T23:59:59Z');
const SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical'];
const EXCEPTED_NAMES = EXCEPTED_FINDINGS.map(item => item.name);
const PICOMATCH = EXCEPTED_FINDINGS[0];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function recount(report) {
  const counts = report.metadata.vulnerabilities;
  for (const severity of SEVERITIES) {
    counts[severity] = Object.values(report.vulnerabilities).filter(entry => entry.severity === severity).length;
  }
  counts.total = SEVERITIES.reduce((sum, severity) => sum + counts[severity], 0);
  return report;
}

// Removes entries the way a changed tree would: references to them disappear,
// and entries left with no via disappear too.
function removeEntries(report, names) {
  const removed = new Set(names);
  let changed = true;
  while (changed) {
    changed = false;
    for (const name of removed) delete report.vulnerabilities[name];
    for (const entry of Object.values(report.vulnerabilities)) {
      entry.via = entry.via.filter(item => typeof item !== 'string' || !removed.has(item));
      entry.effects = entry.effects.filter(name => !removed.has(name));
      if (entry.via.length === 0 && !removed.has(entry.name)) {
        removed.add(entry.name);
        changed = true;
      }
    }
  }
  return recount(report);
}

function zeroHighReport() {
  return removeEntries(clone(REAL_REPORT), EXCEPTED_NAMES);
}

function evaluate(overrides = {}) {
  return evaluateDependencyAudit({
    report: clone(REAL_REPORT),
    lockfile: clone(LIVE_LOCKFILE),
    manifest: clone(LIVE_MANIFEST),
    now: BEFORE_EXPIRY,
    ...overrides,
  });
}

function withReport(mutate) {
  const report = clone(REAL_REPORT);
  mutate(report);
  return evaluate({ report });
}

function withLockfile(mutate) {
  const lockfile = clone(LIVE_LOCKFILE);
  const manifest = clone(LIVE_MANIFEST);
  mutate(lockfile, manifest);
  return evaluate({ lockfile, manifest });
}

function assertRejected(result, rule, label = rule) {
  assert.equal(result.ok, false, label);
  assert.equal(result.usedException, false, label);
  const rules = result.failures.map(item => item.rule);
  assert.equal(rules.includes(rule), true, `${label}: expected rule ${rule}, got ${rules.join(', ')}`);
  const formatted = formatResult(result);
  assert.deepEqual(formatted.output, []);
  assert.match(formatted.errors[0], /^Dependency audit gate failed: \[[a-z-]+\] /u);
  assert.equal(formatted.errors[1], 'All violations:');
  assert.equal(formatted.errors.length, result.failures.length + 2);
}

function assertPassed(result, usedException, label = 'pass') {
  assert.deepEqual(result.failures, [], label);
  assert.equal(result.ok, true, label);
  assert.equal(result.usedException, usedException, label);
}

// A well-formed entry with its own advisory, in npm's exact shape.
function advisoryEntry(name, severity = 'high', source = 1) {
  return {
    name,
    severity,
    isDirect: false,
    via: [{
      source,
      name,
      dependency: name,
      title: 'Synthetic advisory',
      url: `https://github.com/advisories/GHSA-0000-0000-${String(source).padStart(4, '0')}`,
      severity,
      cwe: [],
      cvss: { score: 0, vectorString: null },
      range: '<2.0.0',
    }],
    effects: [],
    range: '<2.0.0',
    nodes: [`node_modules/${name}`],
    fixAvailable: true,
  };
}

function lockEntry(name, version, extra = {}) {
  return {
    version,
    resolved: `https://registry.npmjs.org/${name}/-/${name.split('/').pop()}-${version}.tgz`,
    integrity: `sha512-${'C'.repeat(86)}==`,
    dev: true,
    ...extra,
  };
}

// ---- Pass cases -----------------------------------------------------------

test('the committed real report and lockfile pass under the temporary exception before expiry', () => {
  const result = evaluate();
  assertPassed(result, true);
  const formatted = formatResult(result);
  assert.deepEqual(formatted.errors, []);
  const text = formatted.output.join('\n');
  assert.match(text, /TEMPORARY exception for GHSA-fc5q-39xc-vjpf/u);
  assert.match(text, /https:\/\/github\.com\/advisories\/GHSA-fc5q-39xc-vjpf/u);
  assert.match(text, /expires at 2026-11-20T23:59:59Z/u);
  for (const item of EXCEPTED_FINDINGS) assert.equal(text.includes(item.lockPath), true, item.lockPath);
  assert.match(text, /^Findings below high \(not gating\): moderate 6, low 0, info 0\.$/mu);
});

test('the exception constants are the exact approved set', () => {
  assert.equal(EXCEPTION_EXPIRES_AT, '2026-11-20T23:59:59Z');
  assert.deepEqual(clone(EXCEPTION_ADVISORY), {
    id: 'GHSA-fc5q-39xc-vjpf',
    source: 1247710,
    name: 'picomatch',
    dependency: 'picomatch',
    url: 'https://github.com/advisories/GHSA-fc5q-39xc-vjpf',
    severity: 'high',
    range: '<=4.0.7',
  });
  assert.deepEqual(EXCEPTED_FINDINGS.map(item => [item.name, item.lockPath, item.version]), [
    ['picomatch', 'node_modules/tinyglobby/node_modules/picomatch', '4.0.5'],
    ['fdir', 'node_modules/tinyglobby/node_modules/fdir', '6.5.0'],
    ['tinyglobby', 'node_modules/tinyglobby', '0.2.17'],
    ['node-gyp', 'node_modules/node-gyp', '12.4.0'],
    ['@electron/rebuild', 'node_modules/@electron/rebuild', '4.2.0'],
    ['app-builder-lib', 'node_modules/app-builder-lib', '26.15.7'],
  ]);
  for (const item of EXCEPTED_FINDINGS) {
    // Full SHA-512 SRI strings, written out in the script and equal to the lockfile.
    assert.match(item.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/u, item.name);
    assert.equal(item.integrity.length, 95, item.name);
    assert.equal(item.integrity, LIVE_LOCKFILE.packages[item.lockPath].integrity, item.name);
    assert.equal(item.resolved, LIVE_LOCKFILE.packages[item.lockPath].resolved, item.name);
  }
  const source = fs.readFileSync(SCRIPT, 'utf8');
  for (const item of EXCEPTED_FINDINGS) {
    assert.equal(source.includes(`integrity: '${item.integrity}',`), true, item.name);
  }
  assert.equal(Object.isFrozen(EXCEPTED_FINDINGS), true);
  assert.equal(EXCEPTED_FINDINGS.every(item => Object.isFrozen(item) && Object.isFrozen(item.via)), true);
});

test('a consistent report with no high and no critical findings passes without the exception', () => {
  const report = zeroHighReport();
  assert.equal(report.metadata.vulnerabilities.high, 0);
  assert.deepEqual(Object.keys(report.vulnerabilities).sort(), ['@electron/asar', 'glob', 'minimatch']);
  const result = evaluate({ report });
  assertPassed(result, false);
  const text = formatResult(result).output.join('\n');
  assert.match(text, /^Dependency audit gate passed: no high or critical findings\.$/mu);
  assert.doesNotMatch(text, /GHSA-fc5q-39xc-vjpf|TEMPORARY|expires/u);

  // The exception is not consulted at all: neither expiry nor the excepted
  // lockfile entries matter once the findings are gone.
  const bumped = clone(LIVE_LOCKFILE);
  bumped.packages['node_modules/tinyglobby/node_modules/picomatch'].version = '4.0.8';
  assertPassed(evaluate({ report, lockfile: bumped, now: new Date('2027-06-01T00:00:00Z') }), false, 'after expiry');

  assertPassed(evaluate({
    report: {
      auditReportVersion: 2,
      vulnerabilities: {},
      metadata: {
        vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 },
        dependencies: { prod: 1, dev: 0, optional: 0, peer: 0, peerOptional: 0, total: 1 },
      },
    },
  }), false, 'empty report');
});

test('moderate and lower findings with matching advisories do not fail the gate', () => {
  const report = zeroHighReport();
  report.vulnerabilities.extra = advisoryEntry('extra', 'low');
  const result = evaluate({ report: recount(report) });
  assertPassed(result, false);
  assert.match(formatResult(result).output.join('\n'), /moderate 3, low 1, info 0\./u);
});

test('the declared-optional peer that is not installed is tolerated, as node-fetch encoding is', () => {
  assert.deepEqual(LIVE_LOCKFILE.packages['node_modules/node-fetch'].peerDependenciesMeta, { encoding: { optional: true } });
  assert.equal(Object.prototype.hasOwnProperty.call(LIVE_LOCKFILE.packages, 'node_modules/encoding'), false);
  const closure = runtimeClosure(LIVE_LOCKFILE, LIVE_MANIFEST);
  assert.deepEqual(closure.unresolved, []);
  assertPassed(withLockfile(lockfile => {
    const chokidar = lockfile.packages['node_modules/chokidar'];
    chokidar.peerDependencies = { 'absent-optional-peer': '^1.0.0' };
    chokidar.peerDependenciesMeta = { 'absent-optional-peer': { optional: true } };
    chokidar.optionalDependencies = { 'absent-optional-dependency': '^1.0.0' };
  }), true, 'declared optional peer and optional dependency');
});

// ---- Rule a: report shape --------------------------------------------------

test('invalid, empty or truncated audit output is rejected', () => {
  for (const text of ['', '   \n', 'not json', '{"auditReportVersion":', REAL_REPORT_TEXT.slice(0, 2000), undefined, null]) {
    const parsed = parseAuditOutput(text);
    assert.equal(parsed.report, null);
    assert.equal(parsed.failure.rule, 'report-json');
  }
  assert.deepEqual(parseAuditOutput(REAL_REPORT_TEXT).report, REAL_REPORT);
});

test('a wrong audit report version is rejected', () => {
  for (const version of [1, 3, '2', null]) {
    assertRejected(withReport(report => { report.auditReportVersion = version; }), 'report-version', String(version));
  }
  assertRejected(withReport(report => { delete report.auditReportVersion; }), 'report-shape');
});

test('missing or malformed vulnerabilities, metadata and entries are rejected', () => {
  const cases = {
    'no vulnerabilities': report => { delete report.vulnerabilities; },
    'vulnerabilities array': report => { report.vulnerabilities = []; },
    'vulnerabilities null': report => { report.vulnerabilities = null; },
    'no metadata': report => { delete report.metadata; },
    'metadata without vulnerabilities': report => { delete report.metadata.vulnerabilities; },
    'metadata without dependencies': report => { delete report.metadata.dependencies; },
    'metadata extra field': report => { report.metadata.extra = {}; },
    'metadata vulnerabilities array': report => { report.metadata.vulnerabilities = []; },
    'string count': report => { report.metadata.vulnerabilities.high = '6'; },
    'negative count': report => { report.metadata.vulnerabilities.low = -1; report.metadata.vulnerabilities.total -= 1; },
    'fractional count': report => { report.metadata.vulnerabilities.info = 0.5; },
    'missing count': report => { delete report.metadata.vulnerabilities.critical; },
    'extra count': report => { report.metadata.vulnerabilities.severe = 0; },
    'dependency count string': report => { report.metadata.dependencies.prod = '72'; },
    'total mismatch': report => { report.metadata.vulnerabilities.total = 11; },
    'unexpected top-level field': report => { report.message = 'x'; },
    'entry name mismatch': report => { report.vulnerabilities.fdir.name = 'other'; },
    'entry unknown severity': report => { report.vulnerabilities.fdir.severity = 'severe'; },
    'entry null severity': report => { report.vulnerabilities.fdir.severity = null; },
    'entry extra field': report => { report.vulnerabilities.fdir.extra = true; },
    'entry missing field': report => { delete report.vulnerabilities.fdir.isDirect; },
    'entry via not array': report => { report.vulnerabilities.fdir.via = 'picomatch'; },
    'entry via empty': report => { report.vulnerabilities.fdir.via = []; },
    'entry nodes not array': report => { report.vulnerabilities.fdir.nodes = 'node_modules/x'; },
    'entry nodes number': report => { report.vulnerabilities.fdir.nodes = [1]; },
    'entry nodes empty string': report => { report.vulnerabilities.fdir.nodes = ['']; },
    'entry effects not strings': report => { report.vulnerabilities.fdir.effects = [{}]; },
    'entry isDirect string': report => { report.vulnerabilities.fdir.isDirect = 'false'; },
    'entry fixAvailable string': report => { report.vulnerabilities.fdir.fixAvailable = 'yes'; },
    'entry is array': report => { report.vulnerabilities.fdir = []; },
  };
  for (const [label, mutate] of Object.entries(cases)) {
    assertRejected(withReport(mutate), 'report-shape', label);
  }
  for (const report of [null, [], 7, 'text', true]) {
    assertRejected(evaluate({ report }), 'report-shape', JSON.stringify(report));
  }
  assertRejected(
    withReport(report => { report.metadata.vulnerabilities.moderate = 5; report.metadata.vulnerabilities.total = 11; }),
    'report-counts'
  );
});

test('every advisory object in the report must be well formed', () => {
  const minimatchAdvisory = report => report.vulnerabilities.minimatch.via[0];
  const cases = {
    'moderate advisory replaced by {}': report => { report.vulnerabilities.minimatch.via[0] = {}; },
    'moderate advisory severity "severe"': report => { minimatchAdvisory(report).severity = 'severe'; },
    'advisory severity missing': report => { delete minimatchAdvisory(report).severity; },
    'advisory extra field': report => { minimatchAdvisory(report).id = 'x'; },
    'advisory url missing': report => { delete minimatchAdvisory(report).url; },
    'advisory url not a URL': report => { minimatchAdvisory(report).url = 'GHSA-g3hv-75wg-m249'; },
    'advisory url http': report => { minimatchAdvisory(report).url = 'http://github.com/advisories/GHSA-g3hv-75wg-m249'; },
    'advisory source string': report => { minimatchAdvisory(report).source = '1244623'; },
    'advisory source zero': report => { minimatchAdvisory(report).source = 0; },
    'advisory name of another package': report => { minimatchAdvisory(report).name = 'glob'; },
    'advisory dependency of another package': report => { minimatchAdvisory(report).dependency = 'glob'; },
    'advisory empty range': report => { minimatchAdvisory(report).range = ''; },
    'advisory cwe not array': report => { minimatchAdvisory(report).cwe = 'CWE-405'; },
    'advisory cvss not object': report => { minimatchAdvisory(report).cvss = 7.5; },
    'advisory as number': report => { report.vulnerabilities.fdir.via = [7]; },
    'advisory as null': report => { report.vulnerabilities.fdir.via = [null]; },
    'picomatch advisory copied under fdir': report => {
      report.vulnerabilities.fdir.via.push(clone(report.vulnerabilities.picomatch.via[0]));
    },
  };
  for (const [label, mutate] of Object.entries(cases)) {
    assertRejected(withReport(mutate), 'report-advisory', label);
  }
});

test('string via members must name another entry present in the report', () => {
  assertRejected(withReport(report => { report.vulnerabilities.fdir.via = ['not-in-report']; }), 'report-via', 'missing entry');
  assertRejected(withReport(report => { report.vulnerabilities.fdir.via = ['fdir']; }), 'report-via', 'self');
  assertRejected(withReport(report => { report.vulnerabilities.fdir.via = ['']; }), 'report-via', 'empty string');
  assertRejected(withReport(report => { report.vulnerabilities.fdir.effects = ['not-in-report']; }), 'report-via', 'missing effect');
  // The same with an otherwise clean report: the exception is not needed, the shape still fails.
  const zero = zeroHighReport();
  zero.vulnerabilities.glob.via.push('not-in-report');
  assertRejected(evaluate({ report: zero }), 'report-via', 'missing entry, clean report');
});

test('a via cycle with no advisory neither hangs nor passes', () => {
  const report = zeroHighReport();
  const cycleEntry = (name, other) => ({ ...advisoryEntry(name, 'moderate'), via: [other] });
  report.vulnerabilities.alpha = cycleEntry('alpha', 'beta');
  report.vulnerabilities.beta = cycleEntry('beta', 'alpha');
  const result = evaluate({ report: recount(report) });
  assertRejected(result, 'report-via');
  assert.match(result.failures.map(item => item.message).join('\n'), /"alpha" does not lead to any advisory/u);

  const highCycle = clone(REAL_REPORT);
  highCycle.vulnerabilities.picomatch.via = ['fdir'];
  assertRejected(evaluate({ report: highCycle }), 'report-via', 'picomatch <-> fdir cycle');
});

// ---- Severity consistency and hidden advisories ------------------------------

test('a critical advisory under a moderate parent is rejected (review counterexample)', () => {
  const result = withReport(report => { report.vulnerabilities.minimatch.via[0].severity = 'critical'; });
  assertRejected(result, 'critical');
  assertRejected(result, 'advisory-severity');
  assertRejected(result, 'report-severity');
});

test('the six removed but a hidden critical advisory kept is rejected after expiry (review counterexample)', () => {
  const report = zeroHighReport();
  report.vulnerabilities.minimatch.via[0].severity = 'critical';
  const result = evaluate({ report: recount(report), now: new Date('2027-01-15T00:00:00Z') });
  assertRejected(result, 'critical');
  assertRejected(result, 'advisory-severity');
});

test('the six parents downgraded to moderate while the picomatch advisory stays high are rejected (review counterexample)', () => {
  const report = clone(REAL_REPORT);
  for (const name of EXCEPTED_NAMES) report.vulnerabilities[name].severity = 'moderate';
  const result = evaluate({ report: recount(report) });
  assertRejected(result, 'report-severity');
  assertRejected(result, 'high-set');
});

test('a low parent with a high advisory is rejected', () => {
  const report = zeroHighReport();
  report.vulnerabilities.extra = { ...advisoryEntry('extra', 'high'), severity: 'low' };
  const result = evaluate({ report: recount(report) });
  assertRejected(result, 'advisory-severity');
  assertRejected(result, 'report-severity');
});

test('a clean report that still contains a high advisory object is rejected', () => {
  const report = zeroHighReport();
  report.vulnerabilities.glob.via.push({ ...clone(report.vulnerabilities.glob.via[0]), source: 1300001, severity: 'high' });
  report.vulnerabilities.glob.severity = 'moderate';
  const result = evaluate({ report: recount(report) });
  assertRejected(result, 'advisory-severity');
  assertRejected(result, 'report-severity');
});

test('an entry whose severity is lower than its own advisory is rejected', () => {
  assertRejected(withReport(report => {
    report.vulnerabilities.glob.severity = 'low';
    recount(report);
  }), 'report-severity');
});

test('an entry whose severity exceeds everything in its via is rejected', () => {
  assertRejected(withReport(report => {
    report.vulnerabilities.glob.severity = 'high';
    recount(report);
  }), 'report-severity');
  // npm allows a string via to carry a lower severity than the named entry
  // (the real report has moderate dmg-builder via high app-builder-lib).
  assert.equal(REAL_REPORT.vulnerabilities['dmg-builder'].severity, 'moderate');
  assert.deepEqual(REAL_REPORT.vulnerabilities['dmg-builder'].via, ['app-builder-lib']);
});

// ---- Rules b and c -----------------------------------------------------------

test('an npm error object is rejected', () => {
  assertRejected(
    evaluate({ report: { error: { code: 'ENOAUDIT', summary: 'Your configured registry does not support audit requests.', detail: '' } } }),
    'report-error'
  );
  assertRejected(withReport(report => { report.error = { code: 'ECONNRESET' }; }), 'report-error');
  assertRejected(withReport(report => { report.error = null; }), 'report-error');
});

test('any critical finding is rejected', () => {
  assertRejected(withReport(report => {
    report.vulnerabilities.extra = advisoryEntry('extra', 'critical');
    recount(report);
  }), 'critical', 'listed critical');
  assertRejected(withReport(report => {
    report.vulnerabilities.fdir.severity = 'critical';
    recount(report);
  }), 'critical', 'excepted package became critical');
  assertRejected(withReport(report => {
    report.metadata.vulnerabilities.critical = 1;
    report.metadata.vulnerabilities.total += 1;
  }), 'critical', 'metadata-only critical');
  assertRejected(withReport(report => {
    report.vulnerabilities.extra = advisoryEntry('extra', 'critical');
  }), 'critical', 'listed-only critical');
  const zero = zeroHighReport();
  zero.vulnerabilities.extra = advisoryEntry('extra', 'critical');
  assertRejected(evaluate({ report: recount(zero) }), 'critical', 'critical without highs');
});

test('a seventh high finding is rejected', () => {
  const result = withReport(report => {
    report.vulnerabilities.lodash = advisoryEntry('lodash');
    recount(report);
  });
  assertRejected(result, 'high-set');
  assertRejected(result, 'advisory-severity');
  assert.match(result.failures.find(item => item.rule === 'high-set').message, /lodash/u);
  const zero = zeroHighReport();
  zero.vulnerabilities.lodash = advisoryEntry('lodash');
  assertRejected(evaluate({ report: recount(zero) }), 'high-set', 'one unrelated high alone');
});

test('a high count that disagrees with the listed entries is rejected', () => {
  assertRejected(withReport(report => {
    report.metadata.vulnerabilities.high = 7;
    report.metadata.vulnerabilities.total += 1;
  }), 'high-count', 'metadata 7, listed 6');
  assertRejected(withReport(report => {
    report.metadata.vulnerabilities.high = 5;
    report.metadata.vulnerabilities.total -= 1;
  }), 'high-count', 'metadata 5, listed 6');
  const zero = zeroHighReport();
  zero.metadata.vulnerabilities.high = 6;
  zero.metadata.vulnerabilities.total += 6;
  assertRejected(evaluate({ report: zero }), 'high-count', 'metadata 6, listed 0');
});

test('one to five of the six excepted findings is a changed tree and is rejected', () => {
  // Keep the lower part of the chain, picomatch first, as a changed tree would.
  for (let kept = 1; kept <= 5; kept += 1) {
    const report = removeEntries(clone(REAL_REPORT), EXCEPTED_NAMES.slice(kept));
    assert.deepEqual(
      EXCEPTED_NAMES.filter(name => report.vulnerabilities[name]),
      EXCEPTED_NAMES.slice(0, kept)
    );
    assertRejected(evaluate({ report }), 'high-set', `${kept} of six kept`);
  }
  for (const name of EXCEPTED_NAMES) {
    // An entry simply missing leaves dangling references or a short high set.
    const raw = withReport(report => {
      delete report.vulnerabilities[name];
      recount(report);
    });
    assert.equal(raw.ok, false, `${name} missing`);
    assert.equal(raw.failures.some(item => item.rule === 'high-set' || item.rule === 'report-via'), true, `${name} missing`);
    assertRejected(withReport(report => {
      report.vulnerabilities[name].severity = 'moderate';
      recount(report);
    }), 'high-set', `${name} downgraded`);
  }
});

// ---- Rule d: report side -------------------------------------------------------

test('each excepted entry rejects an extra, different, duplicated or missing via', () => {
  for (const expected of EXCEPTED_FINDINGS) {
    const rule = expected.name === 'picomatch' ? 'advisory' : 'via';
    assertRejected(withReport(report => {
      report.vulnerabilities[expected.name].via.push('glob');
    }), rule, `${expected.name} extra via`);
    assertRejected(withReport(report => {
      report.vulnerabilities[expected.name].via = ['minimatch'];
    }), rule, `${expected.name} different via`);
    assertRejected(withReport(report => {
      const via = report.vulnerabilities[expected.name].via;
      via.push(clone(via[0]));
    }), rule, `${expected.name} duplicated via`);
    if (expected.via.length > 1) {
      assertRejected(withReport(report => {
        report.vulnerabilities[expected.name].via = expected.via.slice(1);
      }), rule, `${expected.name} missing via member`);
    }
  }
  // Order alone does not matter.
  assertPassed(withReport(report => { report.vulnerabilities['app-builder-lib'].via.reverse(); }), true, 'reordered');
});

test('each excepted entry rejects an extra or different node path', () => {
  for (const expected of EXCEPTED_FINDINGS) {
    assertRejected(withReport(report => {
      report.vulnerabilities[expected.name].nodes.push(`node_modules/other/node_modules/${expected.name}`);
    }), 'nodes', `${expected.name} extra node`);
    assertRejected(withReport(report => {
      report.vulnerabilities[expected.name].nodes = [`node_modules/other/node_modules/${expected.name}`];
    }), 'nodes', `${expected.name} different node`);
    assertRejected(withReport(report => {
      report.vulnerabilities[expected.name].nodes = [];
    }), 'report-shape', `${expected.name} no nodes`);
  }
});

test('picomatch requires exactly the one GHSA-fc5q-39xc-vjpf advisory with range <=4.0.7', () => {
  const advisory = mutate => withReport(report => mutate(report.vulnerabilities.picomatch.via[0], report));
  const cases = {
    'different advisory url': item => { item.url = 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc'; },
    'url only ending with the id': item => { item.url = 'https://example.invalid/GHSA-fc5q-39xc-vjpf'; },
    'url with a suffix': item => { item.url = `${item.url}/x`; },
    'url case changed': item => { item.url = item.url.toUpperCase(); },
    'severity moderate': item => { item.severity = 'moderate'; },
    'severity critical in via': item => { item.severity = 'critical'; },
    'range widened': item => { item.range = '<=4.0.8'; },
    'range open': item => { item.range = '*'; },
    'range narrowed': item => { item.range = '<4.0.7'; },
    'range with spaces': item => { item.range = '<= 4.0.7'; },
    'range with trailing text': item => { item.range = '<=4.0.7 || >=5.0.0'; },
    'different source id': item => { item.source = 1247711; },
  };
  for (const [label, mutate] of Object.entries(cases)) {
    assertRejected(advisory(mutate), 'advisory', label);
  }
  // Fields that make the object malformed fail as malformed advisories.
  assertRejected(advisory(item => { delete item.range; }), 'report-advisory', 'range missing');
  assertRejected(advisory(item => { item.name = 'micromatch'; }), 'report-advisory', 'different package name');
  assertRejected(advisory(item => { item.dependency = 'micromatch'; }), 'report-advisory', 'different dependency');
  // title, cwe and cvss are deliberately not pinned.
  assertPassed(advisory(item => { item.title = 'Retitled'; item.cwe = []; item.cvss = { score: 8, vectorString: null }; }), true, 'unpinned fields');
  const second = withReport(report => {
    report.vulnerabilities.picomatch.via.push({
      ...clone(report.vulnerabilities.picomatch.via[0]),
      source: 1300000,
      url: 'https://github.com/advisories/GHSA-dddd-eeee-ffff',
    });
  });
  assertRejected(second, 'advisory', 'second advisory');
  assertRejected(second, 'advisory-severity', 'second advisory');
  assertRejected(withReport(report => {
    report.vulnerabilities.picomatch.via = ['fdir'];
  }), 'advisory', 'string via');
});

// ---- Rule d: lockfile side -----------------------------------------------------

test('each excepted lockfile entry must match version, integrity, resolved and dev exactly', () => {
  for (const expected of EXCEPTED_FINDINGS) {
    const at = lockfile => lockfile.packages[expected.lockPath];
    assertRejected(withLockfile(lockfile => { at(lockfile).version = `${expected.version}-1`; }), 'lockfile-version', `${expected.name} version`);
    assertRejected(withLockfile(lockfile => { at(lockfile).version = `${expected.version} `; }), 'lockfile-version', `${expected.name} version space`);
    assertRejected(withLockfile(lockfile => { at(lockfile).integrity = `sha512-${'A'.repeat(86)}==`; }), 'lockfile-integrity', `${expected.name} integrity`);
    assertRejected(withLockfile(lockfile => { delete at(lockfile).integrity; }), 'lockfile-integrity', `${expected.name} no integrity`);
    assertRejected(withLockfile(lockfile => { at(lockfile).resolved = expected.resolved.replace('registry.npmjs.org', 'registry.example.invalid'); }), 'lockfile-resolved', `${expected.name} resolved host`);
    assertRejected(withLockfile(lockfile => { at(lockfile).resolved = `${expected.resolved}?x=1`; }), 'lockfile-resolved', `${expected.name} resolved suffix`);
    assertRejected(withLockfile(lockfile => { delete at(lockfile).dev; }), 'lockfile-dev', `${expected.name} dev missing`);
    assertRejected(withLockfile(lockfile => { at(lockfile).dev = false; }), 'lockfile-dev', `${expected.name} dev false`);
    assertRejected(withLockfile(lockfile => { at(lockfile).dev = 'true'; }), 'lockfile-shape', `${expected.name} dev string`);
    assertRejected(withLockfile(lockfile => { delete at(lockfile).dev; at(lockfile).devOptional = true; }), 'lockfile-dev', `${expected.name} devOptional`);
    assertRejected(withLockfile(lockfile => { delete lockfile.packages[expected.lockPath]; }), 'lockfile-entry', `${expected.name} entry missing`);
    assertRejected(withLockfile(lockfile => { at(lockfile).name = expected.name; }), 'lockfile-entry', `${expected.name} aliased`);
  }
});

test('integrity is compared as the complete string, never by prefix, substring or case', () => {
  for (const name of EXCEPTED_NAMES) {
    const expected = EXCEPTED_FINDINGS.find(item => item.name === name);
    const full = expected.integrity;
    const lastChar = full[full.length - 3];
    const variants = {
      'first 40 characters shared, different afterwards': `${full.slice(0, 40)}${'Q'.repeat(full.length - 42)}==`,
      'expected hash followed by a space and a second hash': `${full} sha512-${'B'.repeat(86)}==`,
      'second hash followed by the expected hash': `sha512-${'B'.repeat(86)}== ${full}`,
      'only the final base64 character differs': `${full.slice(0, -3)}${lastChar === 'A' ? 'B' : 'A'}==`,
      'only the final character differs': `${full.slice(0, -1)}A`,
      'final padding dropped': full.slice(0, -1),
      truncated: full.slice(0, 60),
      'case changed': full.replace('sha512-', 'SHA512-'),
      'trailing space': `${full} `,
      'sha384 prefix with same body': full.replace('sha512-', 'sha384-'),
    };
    for (const [label, integrity] of Object.entries(variants)) {
      assert.notEqual(integrity, full, label);
      const result = withLockfile(lockfile => { lockfile.packages[expected.lockPath].integrity = integrity; });
      assertRejected(result, 'lockfile-integrity', `${name}: ${label}`);
    }
  }
});

// ---- Rule e: lockfile structure --------------------------------------------------

test('only lockfileVersion 3 is accepted', () => {
  for (const version of [1, 2, 4, 999, '3', null]) {
    assertRejected(withLockfile(lockfile => { lockfile.lockfileVersion = version; }), 'lockfile-shape', String(version));
  }
  assertRejected(withLockfile(lockfile => { delete lockfile.lockfileVersion; }), 'lockfile-shape', 'missing');
  assertRejected(withLockfile(lockfile => { lockfile.dependencies = {}; }), 'lockfile-shape', 'legacy dependencies section');
  assertRejected(evaluate({ lockfile: null }), 'lockfile-shape', 'null lockfile');
  assertRejected(evaluate({ manifest: null }), 'lockfile-shape', 'null manifest');
  assertRejected(evaluate({ lockfile: { lockfileVersion: 3, packages: [] } }), 'lockfile-shape', 'packages array');
  assertRejected(evaluate({ lockfile: { lockfileVersion: 3, packages: {} } }), 'lockfile-shape', 'no root entry');
});

test('links, bundles and workspaces are rejected rather than modelled', () => {
  const cases = {
    'link entry': lockfile => {
      lockfile.packages['node_modules/pako'] = { resolved: 'node_modules/tinyglobby', link: true };
    },
    'link false is still not supported': lockfile => { lockfile.packages['node_modules/pako'].link = false; },
    inBundle: lockfile => { lockfile.packages['node_modules/pako'].inBundle = true; },
    'bundleDependencies in an entry': lockfile => { lockfile.packages['node_modules/canvas'].bundleDependencies = ['nan']; },
    'bundledDependencies in an entry': lockfile => { lockfile.packages['node_modules/canvas'].bundledDependencies = true; },
    'workspaces in the lockfile root': lockfile => { lockfile.packages[''].workspaces = ['packages/*']; },
    'workspaces in package.json': (lockfile, manifest) => { manifest.workspaces = ['packages/*']; },
    'bundleDependencies in package.json': (lockfile, manifest) => { manifest.bundleDependencies = ['pako']; },
    'bundledDependencies in package.json': (lockfile, manifest) => { manifest.bundledDependencies = ['pako']; },
  };
  for (const [label, mutate] of Object.entries(cases)) {
    assertRejected(withLockfile(mutate), 'lockfile-shape', label);
  }
});

test('the workspace-layout counterexample is rejected (review counterexample)', () => {
  const result = withLockfile((lockfile, manifest) => {
    manifest.dependencies['runtime-workspace'] = 'file:packages/group/app';
    lockfile.packages[''].dependencies['runtime-workspace'] = 'file:packages/group/app';
    lockfile.packages['node_modules/runtime-workspace'] = { resolved: 'packages/group/app', link: true };
    lockfile.packages['packages/group/app'] = { version: '1.0.0', optionalDependencies: { bridge: '1.0.0' } };
    lockfile.packages['packages/group/node_modules/bridge'] = { version: '1.0.0', dependencies: { tinyglobby: '^0.2.17' } };
  });
  assertRejected(result, 'lockfile-path');
  assertRejected(result, 'lockfile-shape');
});

test('package keys must be canonical nested install paths', () => {
  const entry = { version: '1.0.0', resolved: 'https://registry.npmjs.org/x/-/x-1.0.0.tgz', integrity: 'sha512-x', dev: true };
  for (const key of [
    'packages/group/app',
    'node_modules/picomatch/',
    'node_modules\\picomatch',
    'node_modules/../picomatch',
    'node_modules/./picomatch',
    'node_modules//picomatch',
    '/node_modules/picomatch',
    'node_modules/',
    'node_modules/@scope',
    'node_modules/@scope/',
    'node_modules/Picomatch',
    'node_modules/.picomatch',
    'node_modules/node_modules',
    'node_modules/a/node_modules',
    'node_modules/a/b',
    'vendor/http-cache-semantics',
  ]) {
    assertRejected(withLockfile(lockfile => { lockfile.packages[key] = { ...entry }; }), 'lockfile-path', key);
  }
});

test('the trailing-slash second copy with an http URL is rejected (review counterexample)', () => {
  const result = withLockfile(lockfile => {
    lockfile.packages['node_modules/picomatch/'] = {
      version: '4.0.5',
      resolved: 'http://registry.npmjs.org/picomatch/-/picomatch-4.0.5.tgz',
      integrity: PICOMATCH.integrity,
      dev: true,
    };
  });
  assertRejected(result, 'lockfile-path');
});

test('every package entry and declaration map must have the expected types', () => {
  const cases = {
    'chokidar entry []': lockfile => { lockfile.packages['node_modules/chokidar'] = []; },
    'chokidar entry string': lockfile => { lockfile.packages['node_modules/chokidar'] = 'node_modules/readdirp'; },
    'chokidar entry null': lockfile => { lockfile.packages['node_modules/chokidar'] = null; },
    'chokidar entry number': lockfile => { lockfile.packages['node_modules/chokidar'] = 4; },
    'dependencies array': lockfile => { lockfile.packages['node_modules/chokidar'].dependencies = ['readdirp']; },
    'dependencies string': lockfile => { lockfile.packages['node_modules/chokidar'].dependencies = 'readdirp'; },
    'dependency value object': lockfile => { lockfile.packages['node_modules/chokidar'].dependencies = { readdirp: {} }; },
    'dependency value number': lockfile => { lockfile.packages['node_modules/chokidar'].dependencies = { readdirp: 4 }; },
    'dependency value empty': lockfile => { lockfile.packages['node_modules/chokidar'].dependencies = { readdirp: '' }; },
    'optionalDependencies array': lockfile => { lockfile.packages['node_modules/canvas'].optionalDependencies = ['x']; },
    'peerDependencies value null': lockfile => { lockfile.packages['node_modules/canvas'].peerDependencies = { x: null }; },
    'devDependencies value object': lockfile => { lockfile.packages['node_modules/canvas'].devDependencies = { x: {} }; },
    'peerDependenciesMeta malformed': lockfile => { lockfile.packages['node_modules/node-fetch'].peerDependenciesMeta = { encoding: true }; },
    'peerDependenciesMeta optional string': lockfile => { lockfile.packages['node_modules/node-fetch'].peerDependenciesMeta = { encoding: { optional: 'true' } }; },
    'manifest dependency value {} (review counterexample)': (lockfile, manifest) => { manifest.dependencies.pako = {}; },
    'manifest dependencies array': (lockfile, manifest) => { manifest.dependencies = ['pako']; },
    'version number': lockfile => { lockfile.packages['node_modules/pako'].version = 2; },
    'resolved object': lockfile => { lockfile.packages['node_modules/pako'].resolved = {}; },
    'integrity array': lockfile => { lockfile.packages['node_modules/pako'].integrity = []; },
    'name number': lockfile => { lockfile.packages['node_modules/pako'].name = 1; },
    'optional string': lockfile => { lockfile.packages['node_modules/pako'].optional = 'false'; },
  };
  for (const [label, mutate] of Object.entries(cases)) {
    assertRejected(withLockfile(mutate), 'lockfile-shape', label);
  }
});

test('package.json and the lockfile root must declare the same runtime dependencies', () => {
  const cases = {
    'spec differs': lockfile => { lockfile.packages[''].dependencies.pako = '^2.0.0'; },
    'extra in package.json': (lockfile, manifest) => { manifest.dependencies['left-pad'] = '1.3.0'; },
    'extra in the lockfile root': lockfile => { lockfile.packages[''].dependencies['app-builder-lib'] = '26.15.7'; },
    'optionalDependencies only in package.json': (lockfile, manifest) => { manifest.optionalDependencies = { pako: '^2.1.0' }; },
    'peerDependencies only in the lockfile root': lockfile => { lockfile.packages[''].peerDependencies = { pako: '^2.1.0' }; },
  };
  for (const [label, mutate] of Object.entries(cases)) {
    assertRejected(withLockfile(mutate), 'lockfile-root', label);
  }
});

test('unresolved required runtime edges are rejected; only declared-optional absences are tolerated', () => {
  const cases = {
    'unresolved required dependency': lockfile => {
      lockfile.packages['node_modules/chokidar'].dependencies['not-in-lockfile'] = '^1.0.0';
    },
    'unresolved required peer (review counterexample)': lockfile => {
      lockfile.packages['node_modules/chokidar'].peerDependencies = { 'not-in-lockfile': '^1.0.0' };
    },
    'unresolved optional peer without the optional meta': lockfile => {
      lockfile.packages['node_modules/chokidar'].peerDependencies = { 'not-in-lockfile': '^1.0.0' };
      lockfile.packages['node_modules/chokidar'].peerDependenciesMeta = { other: { optional: true } };
    },
    'unresolved peer with optional: false': lockfile => {
      lockfile.packages['node_modules/chokidar'].peerDependencies = { 'not-in-lockfile': '^1.0.0' };
      lockfile.packages['node_modules/chokidar'].peerDependenciesMeta = { 'not-in-lockfile': { optional: false } };
    },
    'node-fetch encoding meta removed': lockfile => {
      delete lockfile.packages['node_modules/node-fetch'].peerDependenciesMeta;
    },
    'unresolved root dependency': (lockfile, manifest) => {
      manifest.dependencies['not-in-lockfile'] = '1.0.0';
      lockfile.packages[''].dependencies['not-in-lockfile'] = '1.0.0';
    },
    'name in dependencies and optionalDependencies counts as required': lockfile => {
      lockfile.packages['node_modules/chokidar'].dependencies['not-in-lockfile'] = '^1.0.0';
      lockfile.packages['node_modules/chokidar'].optionalDependencies = { 'not-in-lockfile': '^1.0.0' };
    },
  };
  for (const [label, mutate] of Object.entries(cases)) {
    assertRejected(withLockfile(mutate), 'runtime-unresolved', label);
  }
});

test('an excepted package reachable from runtime dependencies is rejected', () => {
  const both = (field, name, spec) => (lockfile, manifest) => {
    manifest[field] = { ...(manifest[field] || {}), [name]: spec };
    lockfile.packages[''][field] = { ...(lockfile.packages[''][field] || {}), [name]: spec };
  };
  const cases = {
    'direct root dependency': both('dependencies', 'node-gyp', '^12.4.0'),
    'direct root optionalDependency': both('optionalDependencies', 'tinyglobby', '^0.2.17'),
    'direct root peerDependency': both('peerDependencies', '@electron/rebuild', '^4.2.0'),
    'transitive dependency': lockfile => {
      lockfile.packages['node_modules/chokidar'].dependencies.tinyglobby = '^0.2.17';
    },
    'transitive optionalDependency': lockfile => {
      lockfile.packages['node_modules/canvas'].optionalDependencies = { 'node-gyp': '^12.4.0' };
    },
    'transitive peerDependency': lockfile => {
      lockfile.packages['node_modules/jose'].peerDependencies = { '@electron/rebuild': '*' };
    },
    'transitive optional peer': lockfile => {
      lockfile.packages['node_modules/jose'].peerDependencies = { 'app-builder-lib': '*' };
      lockfile.packages['node_modules/jose'].peerDependenciesMeta = { 'app-builder-lib': { optional: true } };
    },
  };
  for (const [label, mutate] of Object.entries(cases)) {
    const result = withLockfile(mutate);
    assertRejected(result, 'runtime-reachability', label);
  }
  // Reaching tinyglobby also reaches its nested picomatch and fdir copies.
  const messages = withLockfile(both('dependencies', 'tinyglobby', '^0.2.17')).failures.map(item => item.message).join('\n');
  assert.match(messages, /node_modules\/tinyglobby\/node_modules\/picomatch is reachable/u);
  assert.match(messages, /node_modules\/tinyglobby\/node_modules\/fdir is reachable/u);
});

test('the runtime closure follows nested resolution', () => {
  const closure = runtimeClosure(LIVE_LOCKFILE, LIVE_MANIFEST);
  assert.deepEqual(closure.unresolved, []);
  for (const lockPath of ['node_modules/canvas', 'node_modules/chokidar', 'node_modules/electron-store', 'node_modules/jose']) {
    assert.equal(closure.paths.has(lockPath), true, lockPath);
  }
  // decompress-response has its own nested mimic-response.
  assert.equal(closure.paths.has('node_modules/decompress-response/node_modules/mimic-response'), true);
  for (const item of EXCEPTED_FINDINGS) assert.equal(closure.paths.has(item.lockPath), false, item.lockPath);
});

// ---- Rule e: second copies and sources -------------------------------------------

test('a second copy of an excepted package anywhere in the lockfile is rejected', () => {
  const cases = {
    'second picomatch path': lockfile => {
      lockfile.packages['node_modules/picomatch'] = lockEntry('picomatch', '4.0.7');
    },
    'nested picomatch under an unrelated package': lockfile => {
      lockfile.packages['node_modules/glob/node_modules/picomatch'] = lockEntry('picomatch', '4.0.5', { integrity: PICOMATCH.integrity });
    },
    'by name field': lockfile => {
      lockfile.packages['node_modules/pm'] = lockEntry('picomatch', '4.0.5', { name: 'picomatch' });
    },
    'by registry tarball under another name': lockfile => {
      lockfile.packages['node_modules/not-picomatch'] = lockEntry('picomatch', '4.0.5');
    },
    'by http URL (review counterexample)': lockfile => {
      lockfile.packages['node_modules/not-picomatch'] = lockEntry('x', '1.0.0', {
        resolved: 'http://registry.npmjs.org/picomatch/-/picomatch-4.0.5.tgz',
      });
    },
    'by userinfo URL': lockfile => {
      lockfile.packages['node_modules/not-picomatch'] = lockEntry('x', '1.0.0', {
        resolved: 'https://user:pass@registry.npmjs.org/picomatch/-/picomatch-4.0.5.tgz',
      });
    },
    'by look-alike host': lockfile => {
      lockfile.packages['node_modules/not-picomatch'] = lockEntry('x', '1.0.0', {
        resolved: 'https://registry.npmjs.org.evil.example/picomatch/-/picomatch-4.0.5.tgz',
      });
    },
    'by percent-encoded scoped tarball': lockfile => {
      lockfile.packages['node_modules/not-rebuild'] = lockEntry('x', '1.0.0', {
        resolved: 'https://registry.npmjs.org/@electron%2frebuild/-/rebuild-4.2.0.tgz',
      });
    },
    'by integrity at a path with another name': lockfile => {
      lockfile.packages['node_modules/not-picomatch'] = lockEntry('not-picomatch', '1.0.0', { integrity: PICOMATCH.integrity });
    },
    'by integrity among several hashes': lockfile => {
      lockfile.packages['node_modules/not-fdir'] = lockEntry('not-fdir', '1.0.0', {
        integrity: `sha512-${'D'.repeat(86)}== ${EXCEPTED_FINDINGS[1].integrity}`,
      });
    },
    'second scoped @electron/rebuild': lockfile => {
      lockfile.packages['node_modules/app-builder-lib/node_modules/@electron/rebuild'] = lockEntry('@electron/rebuild', '4.2.1');
    },
    'second node-gyp': lockfile => {
      lockfile.packages['node_modules/canvas/node_modules/node-gyp'] = lockEntry('node-gyp', '11.1.0');
    },
  };
  for (const [label, mutate] of Object.entries(cases)) {
    assertRejected(withLockfile(mutate), 'duplicate-path', label);
  }
});

test('every resolved source must be the npm registry over https, except the pinned vendored backport', () => {
  const cases = {
    'non-registry host': lockfile => { lockfile.packages['node_modules/pako'].resolved = 'https://registry.yarnpkg.com/pako/-/pako-2.1.0.tgz'; },
    'http registry': lockfile => { lockfile.packages['node_modules/pako'].resolved = 'http://registry.npmjs.org/pako/-/pako-2.1.0.tgz'; },
    'registry with port': lockfile => { lockfile.packages['node_modules/pako'].resolved = 'https://registry.npmjs.org:8443/pako/-/pako-2.1.0.tgz'; },
    'registry with userinfo': lockfile => { lockfile.packages['node_modules/pako'].resolved = 'https://u@registry.npmjs.org/pako/-/pako-2.1.0.tgz'; },
    'registry with query': lockfile => { lockfile.packages['node_modules/pako'].resolved = 'https://registry.npmjs.org/pako/-/pako-2.1.0.tgz?x'; },
    'registry upper case': lockfile => { lockfile.packages['node_modules/pako'].resolved = 'HTTPS://REGISTRY.NPMJS.ORG/pako/-/pako-2.1.0.tgz'; },
    'git source': lockfile => { lockfile.packages['node_modules/pako'].resolved = 'git+ssh://git@github.com/nodeca/pako.git#abc'; },
    'file source elsewhere': lockfile => { lockfile.packages['node_modules/pako'].resolved = 'file:vendor/crate-http-cache-semantics-backport-0.1.0.tgz'; },
    'vendored backport changed': lockfile => {
      lockfile.packages['node_modules/cacheable-request/node_modules/http-cache-semantics'].resolved = 'file:vendor/other.tgz';
    },
    'not a URL': lockfile => { lockfile.packages['node_modules/pako'].resolved = 'pako-2.1.0.tgz'; },
  };
  for (const [label, mutate] of Object.entries(cases)) {
    assertRejected(withLockfile(mutate), 'lockfile-source', label);
  }
  assert.equal(
    LIVE_LOCKFILE.packages['node_modules/cacheable-request/node_modules/http-cache-semantics'].resolved,
    'file:vendor/crate-http-cache-semantics-backport-0.1.0.tgz'
  );
});

// ---- Rule f: expiry ---------------------------------------------------------------

test('the exception expires one millisecond after 2026-11-20T23:59:59Z', () => {
  assertPassed(evaluate({ now: new Date('2026-11-20T23:59:59.000Z') }), true, 'at expiry');
  assertRejected(evaluate({ now: new Date('2026-11-20T23:59:59.001Z') }), 'expiry', 'one millisecond after');
  assertRejected(evaluate({ now: new Date('2026-11-21T00:00:00.000Z') }), 'expiry', 'one second after');
  assertRejected(evaluate({ now: new Date('2027-01-01T00:00:00Z') }), 'expiry', 'long after');
  for (const now of [new Date('invalid'), undefined, null, Date.parse('2026-11-17T00:00:00Z'), '2026-11-17T00:00:00Z']) {
    assertRejected(evaluate({ now }), 'expiry', String(now));
  }
});

test('all violations are listed after the first', () => {
  const report = clone(REAL_REPORT);
  report.vulnerabilities.lodash = advisoryEntry('lodash');
  recount(report);
  report.vulnerabilities.picomatch.via[0].range = '<=4.0.8';
  const result = evaluate({ report, now: new Date('2026-12-01T00:00:00Z') });
  const rules = result.failures.map(item => item.rule);
  for (const rule of ['high-set', 'high-count', 'advisory', 'advisory-severity', 'expiry']) {
    assert.equal(rules.includes(rule), true, rule);
  }
  const errors = formatResult(result).errors;
  assert.equal(errors[0], `Dependency audit gate failed: [${result.failures[0].rule}] ${result.failures[0].message}`);
  assert.equal(errors.length, rules.length + 2);
});

// ---- Command line ---------------------------------------------------------------

function withStubNpm(body, callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-audit-stub-'));
  try {
    const marker = path.join(directory, 'invoked');
    const stub = path.join(directory, 'npm');
    fs.writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$PWD" "$@" > '${marker}'\n${body}\n`, { mode: 0o700 });
    return callback({ directory, marker });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function runCli({ directory, args = [], env = {} }) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: os.tmpdir(),
    encoding: 'utf8',
    env: { PATH: directory, HOME: os.tmpdir(), ...env },
    timeout: 60000,
  });
}

function writeReportFile(directory, name, value) {
  const file = path.join(directory, name);
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  return file;
}

test('the command runs npm audit itself with the fixed arguments from the repository root', () => {
  assert.deepEqual([...AUDIT_ARGS], ['audit', '--json', '--registry=https://registry.npmjs.org/']);
  withStubNpm('', ({ directory, marker }) => {
    const file = writeReportFile(directory, 'zero.json', zeroHighReport());
    fs.appendFileSync(path.join(directory, 'npm'), `/bin/cat '${file}'\nexit 0\n`);
    const result = runCli({ directory });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^Dependency audit gate passed: no high or critical findings\.$/mu);
    assert.doesNotMatch(result.stdout, /TEMPORARY/u);
    const [cwd, ...args] = fs.readFileSync(marker, 'utf8').trimEnd().split('\n');
    assert.equal(fs.realpathSync(cwd), fs.realpathSync(ROOT));
    assert.deepEqual(args, [...AUDIT_ARGS]);
  });
});

test('the command applies the exception to the real report only until expiry', () => {
  withStubNpm('', ({ directory }) => {
    const file = writeReportFile(directory, 'real.json', REAL_REPORT_TEXT);
    // npm audit exits 1 when it lists findings.
    fs.appendFileSync(path.join(directory, 'npm'), `/bin/cat '${file}'\nexit 1\n`);
    // The command reads the real clock once, somewhere inside this window, so
    // the expected outcome is decided from the window and cannot race.
    const before = Date.now();
    const result = runCli({ directory });
    const after = Date.now();
    const passed = result.status === 0 && /TEMPORARY exception for GHSA-fc5q-39xc-vjpf/u.test(result.stdout);
    const expired = result.status === 1 && /\[expiry\]/u.test(result.stderr) &&
      !/\[(?!expiry\])[a-z-]+\]/u.test(result.stderr.split('\n').slice(2).join('\n'));
    if (after <= EXPIRY_MS) assert.equal(passed, true, result.stderr);
    else if (before > EXPIRY_MS) assert.equal(expired, true, result.stderr);
    else assert.equal(passed || expired, true, result.stderr);
  });
});

test('the command fails on garbage, empty, oversized, signalled, failed or unexpected npm output', () => {
  const seventh = clone(REAL_REPORT);
  seventh.vulnerabilities.lodash = advisoryEntry('lodash');
  recount(seventh);
  const cases = [
    { label: 'garbage', body: "printf 'npm WARN something\\nnot json\\n'\nexit 1", pattern: /\[report-json\] npm audit output is not valid JSON/u },
    { label: 'nothing', body: 'exit 1', pattern: /\[report-json\] npm audit printed no report/u },
    { label: 'signal', body: 'kill -TERM $$', pattern: /\[report-json\] npm audit ended unexpectedly \(signal SIGTERM\)/u },
    { label: 'over the output limit', body: '/usr/bin/head -c 70000000 /dev/zero\nexit 1', pattern: /\[report-json\] npm audit failed: its output exceeded 67108864 bytes/u },
    { label: 'other status with a valid report', report: zeroHighReport(), status: 2, pattern: /\[report-json\] npm audit ended unexpectedly \(status 2\)/u },
    { label: 'error object', report: { error: { code: 'ENOTFOUND', summary: 'request failed' } }, status: 1, pattern: /\[report-error\]/u },
    { label: 'seventh high', report: seventh, status: 1, pattern: /\[high-set\] High findings outside the GHSA-fc5q-39xc-vjpf exception: lodash/u },
  ];
  for (const item of cases) {
    withStubNpm('', ({ directory }) => {
      const body = item.report
        ? `/bin/cat '${writeReportFile(directory, 'report.json', item.report)}'\nexit ${item.status}`
        : item.body;
      fs.appendFileSync(path.join(directory, 'npm'), `${body}\n`);
      const result = runCli({ directory });
      assert.equal(result.status, 1, item.label);
      assert.match(result.stderr, /^Dependency audit gate failed: /u, item.label);
      assert.match(result.stderr, item.pattern, item.label);
      assert.equal(result.stdout, '', item.label);
    });
  }
  // npm missing from PATH.
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-audit-nonpm-'));
  try {
    const result = runCli({ directory: empty });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /\[report-json\] npm audit failed: it could not be run \(ENOENT\)/u);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test('no argument or environment variable substitutes the report, moves the expiry or skips a check', () => {
  const seventh = clone(REAL_REPORT);
  seventh.vulnerabilities.lodash = advisoryEntry('lodash');
  recount(seventh);
  withStubNpm('', ({ directory, marker }) => {
    const bad = writeReportFile(directory, 'seventh.json', seventh);
    const good = writeReportFile(directory, 'zero.json', zeroHighReport());
    fs.appendFileSync(path.join(directory, 'npm'), `/bin/cat '${bad}'\nexit 1\n`);
    for (const args of [[good], ['--report', good], [`--report=${good}`], ['--now=2026-11-01T00:00:00Z'], ['--expires', '2099-01-01T00:00:00Z'], ['--skip-checks'], ['--']]) {
      const result = runCli({ directory, args });
      assert.equal(result.status, 2, args.join(' '));
      assert.equal(result.stderr.trim(), 'Usage: node scripts/verify-dependency-audit.js');
      assert.equal(fs.existsSync(marker), false, `npm must not run for ${args.join(' ')}`);
    }
    const hostileEnv = {
      CRATE_AUDIT_REPORT: good,
      CRATE_DEPENDENCY_AUDIT_REPORT: good,
      AUDIT_REPORT: good,
      CRATE_DEPENDENCY_AUDIT_EXPIRY: '2099-01-01T00:00:00Z',
      CRATE_DEPENDENCY_AUDIT_NOW: '2026-11-01T00:00:00Z',
      CRATE_DEPENDENCY_AUDIT_SKIP: '1',
      SKIP_DEPENDENCY_AUDIT: '1',
      TZ: 'Pacific/Kiritimati',
      FAKETIME: '2026-11-01 00:00:00',
    };
    const result = runCli({ directory, env: hostileEnv });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /\[high-set\]/u);
  });

  // Statically: the script reads no environment variable, uses argv only to
  // reject arguments, and reads only package.json and package-lock.json.
  const source = fs.readFileSync(SCRIPT, 'utf8');
  assert.doesNotMatch(source, /process\.env/u);
  assert.equal(source.match(/process\.argv/gu).length, 1);
  assert.match(source, /function run\(argv = process\.argv\.slice\(2\), dependencies = \{\}\) \{/u);
  assert.match(source, /if \(argv\.length !== 0\) \{\n\s+writeError\('Usage: node scripts\/verify-dependency-audit\.js'\);/u);
  assert.equal(source.match(/readFileSync\(/gu).length, 1);
  assert.equal(source.match(/readJsonFile\(path\.join\(projectRoot, '(?:package-lock|package)\.json'\)\)/gu).length, 2);
  assert.equal(source.match(/spawnSync\(/gu).length, 1);
  assert.match(source, /childProcess\.spawnSync\('npm', AUDIT_ARGS, \{/u);
  assert.match(source, /now: new Date\(\),/u);
  assert.equal(source.match(/EXCEPTION_EXPIRES_AT = /gu).length, 1);
  assert.match(source, /\nif \(require\.main === module\) run\(\);\n/u);
});

test('the workflow audit step runs exactly the verifier and nothing else', () => {
  const workflow = fs.readFileSync(WORKFLOW, 'utf8');
  const lines = workflow.split('\n');
  const start = lines.indexOf('      - name: Reject high-severity dependency findings');
  assert.notEqual(start, -1);
  let end = start + 1;
  while (end < lines.length && !/^ {6}- name: /u.test(lines[end])) end += 1;
  assert.deepEqual(lines.slice(start, end), [
    '      - name: Reject high-severity dependency findings',
    '        env:',
    '          npm_config_cache: ${{ runner.temp }}/crate-npm-cache',
    '          npm_config_globalconfig: ${{ runner.temp }}/crate-global-npmrc',
    '          npm_config_userconfig: ${{ runner.temp }}/crate-user-npmrc',
    '        run: node scripts/verify-dependency-audit.js',
    '',
  ]);
  const block = lines.slice(start, end).join('\n');
  assert.doesNotMatch(block, /continue-on-error|\|\||\btrue\b|\bif:|shell:/u);
  assert.equal(lines[end], '      - name: Verify dependency lifecycle policy');
  assert.doesNotMatch(workflow, /continue-on-error/u);
  assert.doesNotMatch(workflow, /npm audit/u);
  assert.equal(workflow.match(/verify-dependency-audit\.js/gu).length, 2);
  assert.match(workflow, /^ {10}node --check scripts\/verify-dependency-audit\.js$/mu);
});
