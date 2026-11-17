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
// The real `npm audit --json --registry=https://registry.npmjs.org/` output for
// the committed lockfile on 2026-11-17 (v2.4.x 21f386d).
const REAL_REPORT_TEXT = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'dependency-audit', 'audit-report-2026-11-17.json'),
  'utf8'
);
const REAL_REPORT = JSON.parse(REAL_REPORT_TEXT);
const LIVE_LOCKFILE = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
const LIVE_MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const BEFORE_EXPIRY = new Date('2026-11-17T12:00:00Z');
const SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical'];
const EXCEPTED_NAMES = EXCEPTED_FINDINGS.map(item => item.name);

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

function zeroHighReport() {
  const report = clone(REAL_REPORT);
  for (const name of EXCEPTED_NAMES) delete report.vulnerabilities[name];
  return recount(report);
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
  mutate(lockfile);
  return evaluate({ lockfile });
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

function highEntry(name) {
  return {
    name,
    severity: 'high',
    isDirect: false,
    via: [{
      source: 1,
      name,
      dependency: name,
      title: 'Synthetic advisory',
      url: 'https://github.com/advisories/GHSA-0000-0000-0000',
      severity: 'high',
      cwe: [],
      cvss: { score: 7.5, vectorString: null },
      range: '<2.0.0',
    }],
    effects: [],
    range: '<2.0.0',
    nodes: [`node_modules/${name}`],
    fixAvailable: true,
  };
}

test('the committed real report and lockfile pass under the temporary exception before expiry', () => {
  const result = evaluate();
  assert.deepEqual(result.failures, []);
  assert.equal(result.ok, true);
  assert.equal(result.usedException, true);
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

test('a report with no high and no critical findings passes without the exception', () => {
  const report = zeroHighReport();
  assert.equal(report.metadata.vulnerabilities.high, 0);
  const result = evaluate({ report });
  assert.deepEqual(result.failures, []);
  assert.equal(result.ok, true);
  assert.equal(result.usedException, false);
  const text = formatResult(result).output.join('\n');
  assert.match(text, /^Dependency audit gate passed: no high or critical findings\.$/mu);
  assert.doesNotMatch(text, /GHSA-fc5q-39xc-vjpf|TEMPORARY|expires/u);

  // The exception is not consulted at all: neither expiry nor the excepted
  // lockfile entries matter once the findings are gone.
  const bumped = clone(LIVE_LOCKFILE);
  bumped.packages['node_modules/tinyglobby/node_modules/picomatch'].version = '4.0.8';
  const later = evaluate({ report, lockfile: bumped, now: new Date('2027-06-01T00:00:00Z') });
  assert.equal(later.ok, true);
  assert.equal(later.usedException, false);

  const empty = evaluate({
    report: {
      auditReportVersion: 2,
      vulnerabilities: {},
      metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } },
    },
  });
  assert.equal(empty.ok, true);
  assert.equal(empty.usedException, false);
});

test('moderate and lower findings do not fail the gate', () => {
  const report = zeroHighReport();
  report.vulnerabilities.extra = { ...highEntry('extra'), severity: 'low' };
  const result = evaluate({ report: recount(report) });
  assert.equal(result.ok, true);
  assert.match(formatResult(result).output.join('\n'), /moderate 6, low 1, info 0\./u);
});

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

test('missing or malformed vulnerabilities and metadata are rejected', () => {
  const cases = {
    'no vulnerabilities': report => { delete report.vulnerabilities; report.extraField = {}; },
    'vulnerabilities array': report => { report.vulnerabilities = []; },
    'vulnerabilities null': report => { report.vulnerabilities = null; },
    'no metadata': report => { delete report.metadata; report.extraField = {}; },
    'metadata without vulnerabilities': report => { delete report.metadata.vulnerabilities; },
    'metadata vulnerabilities array': report => { report.metadata.vulnerabilities = []; },
    'string count': report => { report.metadata.vulnerabilities.high = '6'; },
    'negative count': report => { report.metadata.vulnerabilities.low = -1; report.metadata.vulnerabilities.total -= 1; },
    'fractional count': report => { report.metadata.vulnerabilities.info = 0.5; },
    'missing count': report => { delete report.metadata.vulnerabilities.critical; },
    'total mismatch': report => { report.metadata.vulnerabilities.total = 11; },
    'unexpected top-level field': report => { report.message = 'x'; },
    'entry name mismatch': report => { report.vulnerabilities.fdir.name = 'other'; },
    'entry unknown severity': report => { report.vulnerabilities.fdir.severity = 'severe'; },
    'entry via not array': report => { report.vulnerabilities.fdir.via = 'picomatch'; },
    'entry via empty': report => { report.vulnerabilities.fdir.via = []; },
    'entry via number': report => { report.vulnerabilities.fdir.via = [7]; },
    'entry nodes not array': report => { report.vulnerabilities.fdir.nodes = 'node_modules/x'; },
    'entry nodes number': report => { report.vulnerabilities.fdir.nodes = [1]; },
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
    report.vulnerabilities.extra = { ...highEntry('extra'), severity: 'critical' };
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
    report.vulnerabilities.extra = { ...highEntry('extra'), severity: 'critical' };
  }), 'critical', 'listed-only critical');
  const zero = zeroHighReport();
  zero.vulnerabilities.extra = { ...highEntry('extra'), severity: 'critical' };
  assertRejected(evaluate({ report: recount(zero) }), 'critical', 'critical without highs');
});

test('a seventh high finding is rejected', () => {
  const result = withReport(report => {
    report.vulnerabilities.lodash = highEntry('lodash');
    recount(report);
  });
  assertRejected(result, 'high-set');
  assert.match(result.failures.find(item => item.rule === 'high-set').message, /lodash/u);
  const zero = zeroHighReport();
  zero.vulnerabilities.lodash = highEntry('lodash');
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
  for (const name of EXCEPTED_NAMES) {
    assertRejected(withReport(report => {
      delete report.vulnerabilities[name];
      recount(report);
    }), 'high-set', `${name} missing`);
    assertRejected(withReport(report => {
      report.vulnerabilities[name].severity = 'moderate';
      recount(report);
    }), 'high-set', `${name} downgraded`);
  }
  for (let kept = 1; kept <= 5; kept += 1) {
    assertRejected(withReport(report => {
      for (const name of EXCEPTED_NAMES.slice(kept)) delete report.vulnerabilities[name];
      recount(report);
    }), 'high-set', `${kept} of six kept`);
  }
});

test('each excepted entry rejects an extra, different, duplicated or missing via', () => {
  for (const expected of EXCEPTED_FINDINGS) {
    const rule = expected.name === 'picomatch' ? 'advisory' : 'via';
    assertRejected(withReport(report => {
      report.vulnerabilities[expected.name].via.push('extra-package');
    }), rule, `${expected.name} extra via`);
    assertRejected(withReport(report => {
      report.vulnerabilities[expected.name].via = ['different-package'];
    }), rule, `${expected.name} different via`);
    assertRejected(withReport(report => {
      const via = report.vulnerabilities[expected.name].via;
      via.push(clone(via[0]));
    }), rule, `${expected.name} duplicated via`);
    if (expected.name !== 'picomatch') {
      assertRejected(withReport(report => {
        report.vulnerabilities[expected.name].via = [...expected.via.slice(1), clone(REAL_REPORT.vulnerabilities.picomatch.via[0])];
      }), rule, `${expected.name} advisory object in via`);
      if (expected.via.length > 1) {
        assertRejected(withReport(report => {
          report.vulnerabilities[expected.name].via = expected.via.slice(1);
        }), rule, `${expected.name} missing via member`);
      }
    }
  }
  // Order alone does not matter.
  const reordered = withReport(report => { report.vulnerabilities['app-builder-lib'].via.reverse(); });
  assert.equal(reordered.ok, true);
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
    }), 'nodes', `${expected.name} no nodes`);
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
    'range missing': item => { delete item.range; },
    'different source id': item => { item.source = 1247711; },
    'different package name': item => { item.name = 'micromatch'; },
    'different dependency': item => { item.dependency = 'micromatch'; },
  };
  for (const [label, mutate] of Object.entries(cases)) {
    assertRejected(advisory(mutate), 'advisory', label);
  }
  assertRejected(withReport(report => {
    report.vulnerabilities.picomatch.via.push({
      ...clone(report.vulnerabilities.picomatch.via[0]),
      source: 1300000,
      url: 'https://github.com/advisories/GHSA-dddd-eeee-ffff',
    });
  }), 'advisory', 'second advisory');
  assertRejected(withReport(report => {
    report.vulnerabilities.picomatch.via = ['fdir'];
  }), 'advisory', 'string via');
});

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
    assertRejected(withLockfile(lockfile => { at(lockfile).dev = 'true'; }), 'lockfile-dev', `${expected.name} dev string`);
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

test('an excepted package reachable from runtime dependencies is rejected', () => {
  const cases = {
    'direct root dependency': (lockfile, manifest) => {
      manifest.dependencies['node-gyp'] = '^12.4.0';
    },
    'direct root optionalDependency': (lockfile, manifest) => {
      manifest.optionalDependencies = { tinyglobby: '^0.2.17' };
    },
    'direct root peerDependency': (lockfile, manifest) => {
      manifest.peerDependencies = { '@electron/rebuild': '^4.2.0' };
    },
    'lockfile root dependency': lockfile => {
      lockfile.packages[''].dependencies['app-builder-lib'] = '26.15.7';
    },
    'transitive dependency': lockfile => {
      lockfile.packages['node_modules/chokidar'].dependencies = {
        ...lockfile.packages['node_modules/chokidar'].dependencies,
        tinyglobby: '^0.2.17',
      };
    },
    'transitive optionalDependency': lockfile => {
      lockfile.packages['node_modules/canvas'].optionalDependencies = { 'node-gyp': '^12.4.0' };
    },
    'transitive peerDependency': lockfile => {
      lockfile.packages['node_modules/jose'].peerDependencies = { '@electron/rebuild': '*' };
    },
  };
  for (const [label, mutate] of Object.entries(cases)) {
    const lockfile = clone(LIVE_LOCKFILE);
    const manifest = clone(LIVE_MANIFEST);
    mutate(lockfile, manifest);
    const result = evaluate({ lockfile, manifest });
    assertRejected(result, 'runtime-reachability', label);
    assert.match(
      result.failures.filter(item => item.rule === 'runtime-reachability').map(item => item.message).join('\n'),
      /reachable from runtime dependencies/u,
      label
    );
  }
  // Reaching tinyglobby also reaches its nested picomatch and fdir copies.
  const manifest = clone(LIVE_MANIFEST);
  manifest.dependencies.tinyglobby = '^0.2.17';
  const messages = evaluate({ manifest }).failures.map(item => item.message).join('\n');
  assert.match(messages, /node_modules\/tinyglobby\/node_modules\/picomatch is reachable/u);
  assert.match(messages, /node_modules\/tinyglobby\/node_modules\/fdir is reachable/u);
});

test('the runtime closure follows nested resolution and fails closed on unresolvable edges', () => {
  const closure = runtimeClosure(LIVE_LOCKFILE, LIVE_MANIFEST);
  assert.deepEqual(closure.unresolved, []);
  for (const lockPath of ['node_modules/canvas', 'node_modules/chokidar', 'node_modules/electron-store', 'node_modules/jose']) {
    assert.equal(closure.paths.has(lockPath), true, lockPath);
  }
  // decompress-response has its own nested mimic-response.
  assert.equal(closure.paths.has('node_modules/decompress-response/node_modules/mimic-response'), true);
  for (const item of EXCEPTED_FINDINGS) assert.equal(closure.paths.has(item.lockPath), false, item.lockPath);

  const manifest = clone(LIVE_MANIFEST);
  manifest.dependencies['not-in-lockfile'] = '1.0.0';
  assertRejected(evaluate({ manifest }), 'runtime-reachability', 'unresolved runtime dependency');
  const malformed = clone(LIVE_LOCKFILE);
  malformed.packages['node_modules/chokidar'].dependencies = ['readdirp'];
  assertRejected(evaluate({ lockfile: malformed }), 'runtime-reachability', 'malformed dependency map');
  const linked = clone(LIVE_LOCKFILE);
  linked.packages['node_modules/pako'] = { resolved: 'node_modules/tinyglobby', link: true };
  assertRejected(evaluate({ lockfile: linked }), 'runtime-reachability', 'runtime link to tinyglobby');
});

test('a second copy of an excepted package anywhere in the lockfile is rejected', () => {
  const cases = {
    'second picomatch path': lockfile => {
      lockfile.packages['node_modules/picomatch'] = {
        version: '4.0.7',
        resolved: 'https://registry.npmjs.org/picomatch/-/picomatch-4.0.7.tgz',
        integrity: `sha512-${'C'.repeat(86)}==`,
        dev: true,
      };
    },
    'nested picomatch under an unrelated package': lockfile => {
      lockfile.packages['node_modules/glob/node_modules/picomatch'] = {
        version: '4.0.5',
        resolved: 'https://registry.npmjs.org/picomatch/-/picomatch-4.0.5.tgz',
        integrity: EXCEPTED_FINDINGS[0].integrity,
        dev: true,
      };
    },
    'aliased picomatch': lockfile => {
      lockfile.packages['node_modules/pm'] = {
        name: 'picomatch',
        version: '4.0.5',
        resolved: 'https://registry.npmjs.org/picomatch/-/picomatch-4.0.5.tgz',
        integrity: EXCEPTED_FINDINGS[0].integrity,
        dev: true,
      };
    },
    'picomatch tarball under another name': lockfile => {
      lockfile.packages['node_modules/not-picomatch'] = {
        version: '4.0.5',
        resolved: 'https://registry.npmjs.org/picomatch/-/picomatch-4.0.5.tgz',
        dev: true,
      };
    },
    'second scoped @electron/rebuild': lockfile => {
      lockfile.packages['node_modules/app-builder-lib/node_modules/@electron/rebuild'] = { version: '4.2.1', dev: true };
    },
    'second node-gyp': lockfile => {
      lockfile.packages['node_modules/canvas/node_modules/node-gyp'] = { version: '11.1.0', dev: true };
    },
  };
  for (const [label, mutate] of Object.entries(cases)) {
    assertRejected(withLockfile(mutate), 'duplicate-path', label);
  }
});

test('the exception expires one millisecond after 2026-11-20T23:59:59Z', () => {
  const atExpiry = evaluate({ now: new Date('2026-11-20T23:59:59.000Z') });
  assert.deepEqual(atExpiry.failures, []);
  assert.equal(atExpiry.ok, true);
  assertRejected(evaluate({ now: new Date('2026-11-20T23:59:59.001Z') }), 'expiry', 'one millisecond after');
  assertRejected(evaluate({ now: new Date('2026-11-21T00:00:00.000Z') }), 'expiry', 'one second after');
  assertRejected(evaluate({ now: new Date('2027-01-01T00:00:00Z') }), 'expiry', 'long after');
  for (const now of [new Date('invalid'), undefined, null, Date.parse('2026-11-17T00:00:00Z'), '2026-11-17T00:00:00Z']) {
    assertRejected(evaluate({ now }), 'expiry', String(now));
  }
});

test('missing lockfile or manifest is rejected when the exception is needed', () => {
  assertRejected(evaluate({ lockfile: null }), 'lockfile-shape');
  assertRejected(evaluate({ manifest: null }), 'lockfile-shape');
  assertRejected(evaluate({ lockfile: { packages: [] } }), 'lockfile-shape');
});

test('all violations are listed after the first', () => {
  const report = clone(REAL_REPORT);
  report.vulnerabilities.lodash = highEntry('lodash');
  recount(report);
  report.vulnerabilities.picomatch.via[0].range = '<=4.0.8';
  const result = evaluate({ report, now: new Date('2026-12-01T00:00:00Z') });
  const rules = result.failures.map(item => item.rule);
  for (const rule of ['high-set', 'high-count', 'advisory', 'expiry']) assert.equal(rules.includes(rule), true, rule);
  const errors = formatResult(result).errors;
  assert.equal(errors[0], `Dependency audit gate failed: [${result.failures[0].rule}] ${result.failures[0].message}`);
  assert.equal(errors.length, rules.length + 2);
});

// ---- Command line ---------------------------------------------------------

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
    const result = runCli({ directory });
    if (Date.now() <= Date.parse(EXCEPTION_EXPIRES_AT)) {
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /TEMPORARY exception for GHSA-fc5q-39xc-vjpf/u);
    } else {
      assert.equal(result.status, 1);
      assert.match(result.stderr, /\[expiry\]/u);
    }
  });
});

test('the command fails on garbage, empty, signalled, failed or unexpected npm output', () => {
  const seventh = clone(REAL_REPORT);
  seventh.vulnerabilities.lodash = highEntry('lodash');
  recount(seventh);
  const cases = [
    { label: 'garbage', body: "printf 'npm WARN something\\nnot json\\n'\nexit 1", pattern: /\[report-json\] npm audit output is not valid JSON/u },
    { label: 'nothing', body: 'exit 1', pattern: /\[report-json\] npm audit printed no report/u },
    { label: 'signal', body: 'kill -TERM $$', pattern: /\[report-json\] npm audit ended unexpectedly \(signal SIGTERM\)/u },
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
    assert.match(result.stderr, /\[report-json\] npm audit could not be run \(ENOENT\)/u);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test('no argument or environment variable substitutes the report, moves the expiry or skips a check', () => {
  const seventh = clone(REAL_REPORT);
  seventh.vulnerabilities.lodash = highEntry('lodash');
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
