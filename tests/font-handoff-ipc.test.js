'use strict';
// End-to-end font handoff through the real main-process IPC handlers, using
// the provenance-dual-write harness (stubbed Electron and child processes).
// Fonts are synthetic tables; the macOS font registry is stubbed.
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const root = process.env.CRATE_COVERAGE_SOURCE_ROOT || path.resolve(__dirname, '..');
const harnessPath = path.join(root, 'tests/provenance-dual-write.test.js');
let harness = fs.readFileSync(harnessPath, 'utf8');
if (harness.split("const test = require('node:test');").length !== 2) throw Error('harness drift');
harness = harness.replace("const test = require('node:test');", "const fontTest=require('node:test'); const test=new Proxy(fontTest,{apply(){}});");
harness = harness.replace("fs.mkdtempSync(path.join(os.tmpdir(), 'crate-provenance-dual-write-home-'))", "fs.mkdtempSync(path.join(path.dirname(MAIN_UNDER_TEST_ROOT), 'font-handoff-ipc-home-'))");
const compiled = new Module(harnessPath, module);
compiled.filename = harnessPath;
compiled.paths = Module._nodeModulePaths(path.dirname(harnessPath));
compiled._compile(harness + '\n(' + cases.toString() + ')();', harnessPath);

function cases() {
  const crypto = require('node:crypto');
  const { buildFont, buildCollection, englishNames, OFL_STATEMENT } = require('./font-fixtures');
  const sha = buffer => crypto.createHash('sha256').update(buffer).digest('hex');

  let registryRows = [];
  let registryResolveOverride = null;
  let registryFailure = false;
  let registryCalls = 0;
  function isFontRegistry(request) {
    return request.kind === 'execFile' && request.command === '/usr/bin/osascript' &&
      path.basename(request.args[request.args.length - 1] || '') === 'crate-font-registry.js';
  }
  function installRegistry() {
    setChildProcessHandler(request => {
      if (!isFontRegistry(request)) return { stdout: '', stderr: '' };
      registryCalls++;
      const scriptPath = request.args[request.args.length - 1];
      const script = fs.readFileSync(scriptPath, 'utf8');
      const requestPath = path.join(path.dirname(scriptPath), 'crate-font-registry-request.json');
      if (!script.includes(JSON.stringify(requestPath))) throw new Error('request path not bound');
      const body = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
      for (const name of body.names || []) {
        if (script.includes(name)) throw new Error('font name leaked into script text');
      }
      if (registryFailure) return { error: Object.assign(new Error('timed out'), { killed: true, signal: 'SIGKILL' }) };
      if (body.mode === 'list') return { stdout: JSON.stringify({ mode: 'list', rows: registryRows }) + '\n' };
      const results = {};
      for (const name of body.names) {
        results[name] = registryResolveOverride ? registryResolveOverride(name) : registryRows.filter(row => row[0] === name);
      }
      return { stdout: JSON.stringify({ mode: 'resolve', results }) + '\n' };
    });
  }

  function writeFont(filePath, options) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const bytes = Array.isArray(options) ? buildCollection(options) : buildFont(options);
    fs.writeFileSync(filePath, bytes);
    return bytes;
  }
  function brand(style, extra = {}) {
    return { names: englishNames({ family: 'Brand Sans', style, postscriptName: `BrandSans-${style}`, ...extra }) };
  }
  const fontsDir = () => path.join(TEST_HOME, 'Library', 'Fonts');

  async function fixture(name = 'Fonts') {
    resetTestHomeWorkspace();
    clearTrackedTimers();
    fs.rmSync(path.join(TEST_HOME, 'Library'), { recursive: true, force: true });
    registryRows = [];
    registryResolveOverride = null;
    registryFailure = false;
    registryCalls = 0;
    installRegistry();
    await callIpcRaw('settings:update', 'packageOutputLayoutMode', 'by-extension-v1');
    const dir = fs.mkdtempSync(path.join(TEST_HOME, 'Desktop', 'fonts-'));
    const image = path.join(dir, 'Logo.png');
    fs.writeFileSync(image, createSyntheticPngBytes());
    const out = path.join(dir, 'out');
    fs.mkdirSync(out);
    const project = await createProject(name);
    await callIpcRaw('projects:pause', project.id);
    manualDialogFor([image]);
    await callIpcRaw('projects:add-files', project.id);
    return { project, dir, image, out };
  }

  async function review(f) {
    const result = await callIpcRaw('projects:prepare-package-review', f.project.id, f.out);
    assert.equal(result.materializable, true, JSON.stringify(result));
    return result;
  }
  async function packageNow(f, reviewResult = null) {
    const current = reviewResult || await review(f);
    const result = await callIpcRaw('projects:package', f.project.id, f.out, current.token);
    return { review: current, result };
  }
  function listTree(folder) {
    const out = [];
    const walk = (dir, prefix) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
        else out.push(rel);
      }
    };
    walk(folder, '');
    return out;
  }
  function row(reviewResult, fileName) {
    const found = (reviewResult.fonts?.rows || []).find(item => item.fileName === fileName);
    assert.ok(found, `font row ${fileName}: ${JSON.stringify(reviewResult.fonts)}`);
    return found;
  }
  function registerInstalled(filePath, style) {
    registryRows.push([`BrandSans-${style}`, 'Brand Sans', style, filePath]);
  }

  fontTest('a package with no font candidates keeps the base plan and output', async () => {
    const f = await fixture();
    const reviewResult = await review(f);
    assert.equal(reviewResult.fonts, undefined);
    const { result } = await packageNow(f, reviewResult);
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.fontFileCount, undefined);
    assert.deepEqual(listTree(result.folderPath), ['PNG/Logo.png']);
    assert.equal(registryCalls, 0);
  });

  fontTest('installed unknown-licence font: not packaged until its own confirmation, then copied byte-identical into Fonts', async () => {
    const f = await fixture();
    const bold = path.join(fontsDir(), 'BrandSans-Bold.otf');
    const bytes = writeFont(bold, brand('Bold'));
    registerInstalled(bold, 'Bold');
    const listing = await callIpcRaw('fonts:list-installed', f.project.id);
    assert.deepEqual(listing.families.map(item => [item.family, item.status]), [['Brand Sans', 'available']]);
    const added = await callIpcRaw('fonts:add-installed', f.project.id, { families: ['Brand Sans'] });
    assert.equal(added.added, 1, JSON.stringify(added));

    const before = await review(f);
    const pending = row(before, 'BrandSans-Bold.otf');
    assert.equal(pending.outcome, 'needs-confirmation');
    assert.equal(pending.origin, 'installed');
    assert.match(pending.statement, /BrandSans-Bold/);
    assert.equal(pending.sha256, sha(bytes));
    assert.equal(before.fonts.includedCount, 0);
    const first = await packageNow(f, before);
    assert.equal(first.result.success, true, JSON.stringify(first.result));
    assert.deepEqual(listTree(first.result.folderPath), ['Fonts/Fonts in this package.txt', 'PNG/Logo.png']);
    const firstNote = fs.readFileSync(path.join(first.result.folderPath, 'Fonts', 'Fonts in this package.txt'), 'utf8');
    assert.match(firstNote, /Included font files \(0\)/);
    assert.match(firstNote, /BrandSans-Bold/);
    assert.match(firstNote, /did not confirm that their licen[cs]e allows sharing it/);
    assert.doesNotMatch(firstNote.slice(firstNote.indexOf('Fonts not included')), /below|\b[Yy]ou\b/);
    assert.doesNotMatch(firstNote, new RegExp(TEST_HOME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    fs.rmSync(first.result.folderPath, { recursive: true, force: true });

    const confirmed = await callIpcRaw('fonts:confirm-licence', f.project.id, pending.key, { confirmed: true, sha256: pending.sha256 });
    assert.equal(confirmed.success, true, JSON.stringify(confirmed));
    const after = await review(f);
    assert.equal(row(after, 'BrandSans-Bold.otf').outcome, 'included');
    assert.equal(row(after, 'BrandSans-Bold.otf').basis, 'confirmed');
    assert.equal(row(after, 'BrandSans-Bold.otf').packageFolder, 'Fonts');
    assert.equal(after.totalFiles, 2);
    const second = await packageNow(f, after);
    assert.equal(second.result.success, true, JSON.stringify(second.result));
    assert.equal(second.result.totalFiles, after.totalFiles);
    assert.equal(second.result.fontFileCount, 1);
    assert.deepEqual(listTree(second.result.folderPath), ['Fonts/BrandSans-Bold.otf', 'Fonts/Fonts in this package.txt', 'PNG/Logo.png']);
    assert.deepEqual(fs.readFileSync(path.join(second.result.folderPath, 'Fonts', 'BrandSans-Bold.otf')), bytes);
    const note = fs.readFileSync(path.join(second.result.folderPath, 'Fonts', 'Fonts in this package.txt'), 'utf8');
    assert.match(note, /Crate did not verify this/);
    assert.match(note, /stated on \d{4}-\d{2}-\d{2} that/);
    assert.match(note, new RegExp(sha(bytes)));
    assert.deepEqual(fs.readFileSync(bold), bytes, 'installed font unchanged');
  });

  fontTest('each weight needs its own confirmation; confirming one face never approves another', async () => {
    const f = await fixture();
    const regular = path.join(fontsDir(), 'BrandSans-Regular.otf');
    const bold = path.join(fontsDir(), 'BrandSans-Bold.otf');
    writeFont(regular, brand('Regular'));
    writeFont(bold, brand('Bold'));
    registerInstalled(regular, 'Regular');
    registerInstalled(bold, 'Bold');
    assert.equal((await callIpcRaw('fonts:add-installed', f.project.id, { families: ['Brand Sans'] })).added, 2);
    const before = await review(f);
    const boldRow = row(before, 'BrandSans-Bold.otf');
    assert.equal(row(before, 'BrandSans-Regular.otf').outcome, 'needs-confirmation');
    assert.equal((await callIpcRaw('fonts:confirm-licence', f.project.id, boldRow.key, { confirmed: true, sha256: boldRow.sha256 })).success, true);
    const after = await review(f);
    assert.equal(row(after, 'BrandSans-Bold.otf').outcome, 'included');
    assert.equal(row(after, 'BrandSans-Regular.otf').outcome, 'needs-confirmation');
    // A confirmation request carrying another file's hash is refused.
    const regularRow = row(after, 'BrandSans-Regular.otf');
    assert.equal((await callIpcRaw('fonts:confirm-licence', f.project.id, regularRow.key, { confirmed: true, sha256: boldRow.sha256 })).error, 'font_changed');
    const { result } = await packageNow(f);
    assert.deepEqual(listTree(result.folderPath), ['Fonts/BrandSans-Bold.otf', 'Fonts/Fonts in this package.txt', 'PNG/Logo.png']);
  });

  fontTest('a collection lists every font it contains and one confirmation covers that exact file', async () => {
    const f = await fixture();
    const ttc = path.join(f.dir, 'BrandSans.ttc');
    const bytes = writeFont(ttc, [brand('Regular'), brand('Bold'), brand('Black')]);
    manualDialogFor([ttc]);
    assert.equal((await callIpcRaw('fonts:add-files', f.project.id)).added, 1);
    const before = await review(f);
    const collection = row(before, 'BrandSans.ttc');
    assert.equal(collection.collection, true);
    assert.deepEqual(collection.faces.map(face => face.postscriptName), ['BrandSans-Regular', 'BrandSans-Bold', 'BrandSans-Black']);
    for (const name of ['BrandSans-Regular', 'BrandSans-Bold', 'BrandSans-Black']) assert.match(collection.statement, new RegExp(name));
    assert.equal((await callIpcRaw('fonts:confirm-licence', f.project.id, collection.key, { confirmed: true, sha256: collection.sha256 })).success, true);
    const { result } = await packageNow(f);
    assert.deepEqual(fs.readFileSync(path.join(result.folderPath, 'Fonts', 'BrandSans.ttc')), bytes);
    const note = fs.readFileSync(path.join(result.folderPath, 'Fonts', 'Fonts in this package.txt'), 'utf8');
    for (const name of ['BrandSans-Regular', 'BrandSans-Bold', 'BrandSans-Black']) assert.match(note, new RegExp(name));
  });

  fontTest('a changed font file loses its confirmation; a change after review stops packaging through review-changed', async () => {
    const f = await fixture();
    const file = path.join(f.dir, 'BrandSans-Bold.otf');
    writeFont(file, brand('Bold'));
    manualDialogFor([file]);
    await callIpcRaw('fonts:add-files', f.project.id);
    const first = row(await review(f), 'BrandSans-Bold.otf');
    await callIpcRaw('fonts:confirm-licence', f.project.id, first.key, { confirmed: true, sha256: first.sha256 });
    const included = await review(f);
    assert.equal(row(included, 'BrandSans-Bold.otf').outcome, 'included');

    writeFont(file, brand('Bold', { version: 'Version 2.000' }));
    const stale = await callIpcRaw('projects:package', f.project.id, f.out, included.token);
    assert.equal(stale.error, 'package_review_changed', JSON.stringify(stale));
    assert.deepEqual(fs.readdirSync(f.out), []);
    const refreshed = await review(f);
    assert.equal(row(refreshed, 'BrandSans-Bold.otf').outcome, 'needs-confirmation');
    assert.equal(row(refreshed, 'BrandSans-Bold.otf').confirmed, false);
  });

  fontTest('open-licence font added by the user is included with the licence text, and can be removed', async () => {
    const f = await fixture();
    await callIpcRaw('settings:update', 'packageOutputLayoutMode', 'flat');
    const file = path.join(f.dir, 'Open-Regular.ttf');
    const bytes = writeFont(file, { signature: 'TRUE', names: englishNames({ family: 'Open', style: 'Regular', postscriptName: 'Open-Regular', licence: OFL_STATEMENT }) });
    manualDialogFor([file]);
    await callIpcRaw('fonts:add-files', f.project.id);
    const reviewResult = await review(f);
    const open = row(reviewResult, 'Open-Regular.ttf');
    assert.equal(open.outcome, 'included');
    assert.equal(open.basis, 'open-licence');
    assert.equal(open.packageFolder, 'Package root');
    const { result } = await packageNow(f, reviewResult);
    assert.deepEqual(listTree(result.folderPath), ['Fonts in this package.txt', 'Logo.png', 'Open-Regular.ttf', 'SIL Open Font License 1.1.txt']);
    assert.deepEqual(fs.readFileSync(path.join(result.folderPath, 'Open-Regular.ttf')), bytes);
    assert.match(fs.readFileSync(path.join(result.folderPath, 'SIL Open Font License 1.1.txt'), 'utf8'), /^SIL OPEN FONT LICENSE Version 1\.1/);
    fs.rmSync(result.folderPath, { recursive: true, force: true });

    assert.equal((await callIpcRaw('fonts:set-row-choice', f.project.id, open.key, 'remove')).success, true);
    const removed = await review(f);
    assert.equal(removed.fonts, undefined, 'an added file that is removed leaves the list');
  });

  fontTest('Adobe Fonts, macOS, app-store and restricted fonts cannot be included by any request', async () => {
    const f = await fixture();
    const adobe = path.join(TEST_HOME, 'Library', 'Application Support', 'Adobe', 'CoreSync', 'plugins', 'livetype', 'r', 'Cloud.otf');
    writeFont(adobe, { names: englishNames({ family: 'Cloud Serif', style: 'Regular', postscriptName: 'CloudSerif-Regular' }) });
    registryRows.push(['CloudSerif-Regular', 'Cloud Serif', 'Regular', adobe]);
    registryRows.push(['Helvetica-Bold', 'Helvetica', 'Bold', '/System/Library/Fonts/Helvetica.ttc']);
    const listing = await callIpcRaw('fonts:list-installed', f.project.id);
    assert.deepEqual(listing.families.map(item => [item.family, item.status]), [['Cloud Serif', 'excluded'], ['Helvetica', 'excluded']]);
    const refused = await callIpcRaw('fonts:add-installed', f.project.id, { families: ['Cloud Serif', 'Helvetica'] });
    assert.equal(refused.added, 0);
    assert.equal(refused.refused.length, 2);

    // The same Adobe file supplied directly, and a restricted file: excluded,
    // and neither a confirmation nor an include choice changes that.
    const restricted = path.join(f.dir, 'Restricted-Regular.otf');
    const restrictedBytes = writeFont(restricted, { fsType: 0x0002, names: englishNames({ family: 'Restricted', style: 'Regular', postscriptName: 'Restricted-Regular', licence: OFL_STATEMENT }) });
    const appStore = path.join(TEST_HOME, 'Library', 'Application Support', 'FontManager', 'Rented-Regular.otf');
    writeFont(appStore, { names: englishNames({ family: 'Rented', style: 'Regular', postscriptName: 'Rented-Regular' }) });
    manualDialogFor([adobe, restricted, appStore]);
    assert.equal((await callIpcRaw('fonts:add-files', f.project.id)).added, 3);
    const reviewResult = await review(f);
    for (const [fileName, reason] of [['Cloud.otf', 'adobe-fonts'], ['Restricted-Regular.otf', 'restricted'], ['Rented-Regular.otf', 'app']]) {
      const item = row(reviewResult, fileName);
      assert.equal(item.outcome, 'excluded', fileName);
      assert.equal(item.reason, reason, fileName);
      assert.equal(item.canConfirm, false);
      assert.equal(item.sha256, null);
      const directSha = fileName === 'Restricted-Regular.otf' ? sha(restrictedBytes) : sha(fs.readFileSync(fileName === 'Cloud.otf' ? adobe : appStore));
      assert.equal((await callIpcRaw('fonts:confirm-licence', f.project.id, item.key, { confirmed: true, sha256: directSha })).error, 'font_not_eligible', fileName);
      await callIpcRaw('fonts:set-row-choice', f.project.id, item.key, 'include');
    }
    const after = await review(f);
    assert.ok(after.fonts.rows.every(item => item.outcome === 'excluded'));
    const { result } = await packageNow(f, after);
    assert.deepEqual(listTree(result.folderPath), ['Fonts/Fonts in this package.txt', 'PNG/Logo.png']);
    // Malformed IPC is refused outright; there is no batch form.
    assert.equal((await callIpcRaw('fonts:confirm-licence', f.project.id, 'all', { confirmed: true, sha256: directShaFor(restrictedBytes) })).error, 'font_request_invalid');
    assert.equal((await callIpcRaw('fonts:confirm-licence', f.project.id, [row(after, 'Cloud.otf').key], { confirmed: true, sha256: sha(restrictedBytes) })).error, 'font_request_invalid');
    assert.equal((await callIpcRaw('fonts:set-row-choice', f.project.id, row(after, 'Cloud.otf').key, 'include-all')).error, 'font_request_invalid');
  });
  function directShaFor(bytes) { return sha(bytes); }

  fontTest('fonts found while watching stay out after batch asset actions; only a per-font include and confirmation add them', async () => {
    const f = await fixture();
    const file = path.join(f.dir, 'Found-Regular.otf');
    const bytes = writeFont(file, { names: englishNames({ family: 'Found', style: 'Regular', postscriptName: 'Found-Regular' }) });
    // Staged as needing review by the pre-package scan, then accepted the way
    // Asset Review's "Add All" does (one accept per pending row).
    const stored = storeInstance.data.projects.find(item => item.id === f.project.id);
    stored.pendingFiles = [makePendingFile(file, 'lastused-scan')];
    const accepted = await callIpcRaw('projects:accept-pending', f.project.id, file);
    assert.ok(accepted.files.some(item => item.path === file), 'accepted into project files');
    await callIpcRaw('projects:set-existing-assets-decision', f.project.id, 'include');
    const first = await review(f);
    const found = row(first, 'Found-Regular.otf');
    assert.equal(found.outcome, 'not-included');
    assert.equal(found.reason, 'found');
    assert.ok(!first.files.some(file => file.name === 'Found-Regular.otf'), 'font never listed as an ordinary asset');
    let out = await packageNow(f, first);
    assert.deepEqual(listTree(out.result.folderPath), ['Fonts/Fonts in this package.txt', 'PNG/Logo.png']);
    fs.rmSync(out.result.folderPath, { recursive: true, force: true });

    // A confirmation alone does not include a found font.
    assert.equal((await callIpcRaw('fonts:confirm-licence', f.project.id, found.key, { confirmed: true, sha256: found.sha256 })).success, true);
    assert.equal(row(await review(f), 'Found-Regular.otf').outcome, 'not-included');
    assert.equal((await callIpcRaw('fonts:set-row-choice', f.project.id, found.key, 'include')).success, true);
    const included = await review(f);
    assert.equal(row(included, 'Found-Regular.otf').outcome, 'included');
    out = await packageNow(f, included);
    assert.deepEqual(fs.readFileSync(path.join(out.result.folderPath, 'Fonts', 'Found-Regular.otf')), bytes);
  });

  fontTest('loose registry matches never resolve; duplicates ask for a choice', async () => {
    const f = await fixture();
    const bold = path.join(fontsDir(), 'BrandSans-Bold.otf');
    writeFont(bold, brand('Bold'));
    registerInstalled(bold, 'Bold');
    registryResolveOverride = () => [['BrandSans Bold', 'Brand Sans', 'Bold', bold]];
    const loose = await callIpcRaw('fonts:add-installed', f.project.id, { families: ['Brand Sans'] });
    assert.equal(loose.added, 0);
    assert.equal(loose.unconfirmed.length, 1);

    // The registry names a file that does not contain the face.
    registryResolveOverride = name => [[name, 'Brand Sans', 'Bold', path.join(fontsDir(), 'Other.otf')]];
    writeFont(path.join(fontsDir(), 'Other.otf'), brand('Regular'));
    assert.equal((await callIpcRaw('fonts:add-installed', f.project.id, { families: ['Brand Sans'] })).unconfirmed.length, 1);

    const copy = path.join(TEST_HOME, 'Library', 'Fonts', 'Brand v2', 'BrandSans-Bold.otf');
    writeFont(copy, brand('Bold', { version: 'Version 2.000' }));
    registryResolveOverride = name => [[name, 'Brand Sans', 'Bold', bold], [name, 'Brand Sans', 'Bold', copy]];
    const ambiguous = await callIpcRaw('fonts:add-installed', f.project.id, { families: ['Brand Sans'] });
    assert.equal(ambiguous.added, 0);
    assert.equal(ambiguous.choices.length, 1);
    assert.deepEqual(ambiguous.choices[0].options.map(option => option.version).sort(), ['Version 1.000', 'Version 2.000']);
    const pick = ambiguous.choices[0].options.find(option => option.version === 'Version 2.000');
    assert.equal((await callIpcRaw('fonts:choose-installed-copy', f.project.id, 'not-an-offer')).error, 'font_choice_expired');
    assert.equal((await callIpcRaw('fonts:choose-installed-copy', f.project.id, pick.id)).success, true);
    const reviewResult = await review(f);
    assert.equal(reviewResult.fonts.rows.length, 1);
    assert.equal(reviewResult.fonts.rows[0].faces[0].version, 'Version 2.000');
  });

  fontTest('a variable font is added once as a whole file; synthesized instance names are covered, not confirmed', async () => {
    const f = await fixture();
    const flex = path.join(fontsDir(), 'Flex.ttf');
    const { nameRecord } = require('./font-fixtures');
    writeFont(flex, { signature: 'TRUE', names: [
      ...englishNames({ family: 'Flex', style: 'Regular', postscriptName: 'Flex-Regular' }),
      nameRecord(256, 'Bold'), nameRecord(257, 'Light'), nameRecord(258, 'Flex-Light'),
    ], fvar: { instances: [{ subfamilyNameId: 256 }, { subfamilyNameId: 257, postscriptNameId: 258 }] } });
    registryRows.push(['Flex-Regular', 'Flex', 'Regular', flex], ['Flex-Regular_Bold', 'Flex', 'Bold', flex], ['Flex-Light', 'Flex', 'Light', flex]);
    const added = await callIpcRaw('fonts:add-installed', f.project.id, { families: ['Flex'] });
    assert.equal(added.unconfirmed.length, 0, JSON.stringify(added));
    const reviewResult = await review(f);
    assert.equal(reviewResult.fonts.rows.length, 1);
    const variable = reviewResult.fonts.rows[0];
    assert.equal(variable.variable, true);
    assert.match(variable.contents, /Variable font; the whole file is included/);
    assert.match(variable.contents, /Bold/);
    assert.match(variable.contents, /Flex-Light/);
    assert.equal(variable.outcome, 'needs-confirmation');

    // A synthesized name alone, with no confirmed face in that file, stays unconfirmed.
    const g = await fixture('Variable only');
    writeFont(flex, { signature: 'TRUE', names: [
      ...englishNames({ family: 'Flex', style: 'Regular', postscriptName: 'Flex-Regular' }), nameRecord(256, 'Bold'),
    ], fvar: { instances: [{ subfamilyNameId: 256 }] } });
    registryRows.push(['Flex-Regular_Bold', 'Flex', 'Bold', flex]);
    const only = await callIpcRaw('fonts:add-installed', g.project.id, { families: ['Flex'] });
    assert.equal(only.added, 0);
    assert.equal(only.unconfirmed.length, 1);
  });

  fontTest('two different files claiming one font are not both included; identical copies count once', async () => {
    const f = await fixture();
    const a = path.join(f.dir, 'BrandSans-Bold.otf');
    const b = path.join(f.dir, 'BrandSans-Bold-v9.otf');
    const c = path.join(f.dir, 'BrandSans-Bold copy.otf');
    const ofl = { licence: OFL_STATEMENT };
    writeFont(a, brand('Bold', ofl));
    writeFont(b, brand('Bold', { ...ofl, version: 'Version 9' }));
    manualDialogFor([a, b]);
    await callIpcRaw('fonts:add-files', f.project.id);
    const conflict = await review(f);
    assert.deepEqual(conflict.fonts.rows.map(item => item.reason), ['conflict', 'conflict']);
    assert.equal(conflict.fonts.includedCount, 0);
    await callIpcRaw('fonts:set-row-choice', f.project.id, row(conflict, 'BrandSans-Bold-v9.otf').key, 'remove');
    fs.copyFileSync(a, c);
    await new Promise(resolve => originalSetTimeout(resolve, 5));
    manualDialogFor([c]);
    await callIpcRaw('fonts:add-files', f.project.id);
    const identical = await review(f);
    assert.deepEqual(identical.fonts.rows.map(item => [item.fileName, item.outcome, item.reason]).sort(), [
      ['BrandSans-Bold copy.otf', 'not-included', 'duplicate'],
      ['BrandSans-Bold.otf', 'included', null],
    ]);
    const { result } = await packageNow(f, identical);
    assert.deepEqual(listTree(result.folderPath), ['Fonts/BrandSans-Bold.otf', 'Fonts/Fonts in this package.txt',
      'Fonts/SIL Open Font License 1.1.txt', 'PNG/Logo.png']);
  });

  fontTest('a missing or unreadable font is skipped and reported; the rest of the package proceeds', async () => {
    const f = await fixture();
    const gone = path.join(f.dir, 'Gone-Regular.otf');
    writeFont(gone, { names: englishNames({ family: 'Gone', style: 'Regular', postscriptName: 'Gone-Regular', licence: OFL_STATEMENT }) });
    const broken = path.join(f.dir, 'Broken.ttf');
    fs.writeFileSync(broken, buildFont().subarray(0, 40));
    const other = path.join(f.dir, 'Other.otf');
    fs.writeFileSync(other, Buffer.from('not a font at all'));
    manualDialogFor([gone, broken, other]);
    await callIpcRaw('fonts:add-files', f.project.id);
    fs.rmSync(gone);
    const reviewResult = await review(f);
    assert.equal(row(reviewResult, 'Gone-Regular.otf').reason, 'missing');
    assert.equal(row(reviewResult, 'Broken.ttf').reason, 'malformed');
    assert.equal(row(reviewResult, 'Other.otf').reason, 'unsupported');
    const { result } = await packageNow(f, reviewResult);
    assert.equal(result.success, true);
    assert.deepEqual(listTree(result.folderPath), ['Fonts/Fonts in this package.txt', 'PNG/Logo.png']);
  });

  fontTest('a font added through Add Files is gated, not copied as an ordinary asset', async () => {
    const f = await fixture();
    const file = path.join(f.dir, 'Brand-Bold.otf');
    writeFont(file, brand('Bold'));
    manualDialogFor([file]);
    await callIpcRaw('projects:add-files', f.project.id);
    const reviewResult = await review(f);
    assert.equal(row(reviewResult, 'Brand-Bold.otf').origin, 'project-file');
    assert.equal(row(reviewResult, 'Brand-Bold.otf').outcome, 'needs-confirmation');
    const { result } = await packageNow(f, reviewResult);
    assert.deepEqual(listTree(result.folderPath), ['Fonts/Fonts in this package.txt', 'PNG/Logo.png']);
  });

  fontTest('registry failure reports unavailable and leaves packaging untouched', async () => {
    const f = await fixture();
    registryFailure = true;
    assert.equal((await callIpcRaw('fonts:list-installed', f.project.id)).error, 'font_registry_unavailable');
    assert.equal((await callIpcRaw('fonts:add-installed', f.project.id, { families: ['Brand Sans'] })).error, 'font_registry_unavailable');
    const { result } = await packageNow(f);
    assert.deepEqual(listTree(result.folderPath), ['PNG/Logo.png']);
  });
}
