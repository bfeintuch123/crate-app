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
  const { buildFont, buildCollection, englishNames, nameRecord, OFL_STATEMENT } = require('./font-fixtures');
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
    assert.deepEqual(listTree(out.result.folderPath), ['PNG/Logo.png'], 'a never-chosen font is not named to recipients');
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

  fontTest('a symlinked font file is never copied; a font reached through a symlinked folder is judged on its real path', async () => {
    const f = await fixture();
    const realDir = path.join(f.dir, 'real');
    const real = path.join(realDir, 'Linked-Regular.otf');
    writeFont(real, { names: englishNames({ family: 'Linked', style: 'Regular', postscriptName: 'Linked-Regular', licence: OFL_STATEMENT }) });
    const fileLink = path.join(f.dir, 'Link.otf');
    fs.symlinkSync(real, fileLink);
    const adobeDir = path.join(TEST_HOME, 'Library', 'Application Support', 'Adobe', 'CoreSync', 'plugins', 'livetype', 'r');
    writeFont(path.join(adobeDir, 'Hidden-Regular.otf'), { names: englishNames({ family: 'Hidden', style: 'Regular', postscriptName: 'Hidden-Regular', licence: OFL_STATEMENT }) });
    const folderLink = path.join(f.dir, 'Brand Kit');
    fs.symlinkSync(adobeDir, folderLink);
    manualDialogFor([fileLink, path.join(folderLink, 'Hidden-Regular.otf')]);
    await callIpcRaw('fonts:add-files', f.project.id);
    const reviewResult = await review(f);
    assert.equal(row(reviewResult, 'Link.otf').reason, 'symlink');
    assert.equal(row(reviewResult, 'Hidden-Regular.otf').reason, 'adobe-fonts');
    const { result } = await packageNow(f, reviewResult);
    assert.deepEqual(listTree(result.folderPath), ['Fonts/Fonts in this package.txt', 'PNG/Logo.png']);
  });

  fontTest('Quick Package never copies a linked font and reports it by name', async () => {
    const f = await fixture();
    const zlib = require('node:zlib');
    const font = path.join(f.dir, 'BrandSans-Bold.otf');
    writeFont(font, brand('Bold', { licence: OFL_STATEMENT }));
    const project = path.join(f.dir, 'Edit.prproj');
    fs.writeFileSync(project, zlib.gzipSync(`<PremiereData><FilePath>${f.image}</FilePath><FilePath>${font}</FilePath></PremiereData>`));
    const result = await callIpcRaw('v2:package-file', project);
    assert.equal(result.success, true, JSON.stringify(result));
    assert.deepEqual(result.fontsNotIncluded, [{ name: 'BrandSans-Bold.otf', reason: 'quick-package' }]);
    const tree = listTree(result.outputDir);
    assert.ok(tree.some(file => file.endsWith('Logo.png')), tree.join(', '));
    assert.ok(!tree.some(file => /\.(otf|ttf|ttc|otc)$/i.test(file)), tree.join(', '));
    assert.ok(!JSON.stringify(result.fontsNotIncluded).includes(f.dir), 'no path in the font report');
  });

  fontTest('an expired sign-in during installed-font lookup leaves the project unchanged', async () => {
    const f = await fixture('Expiry');
    const font = path.join(fontsDir(), 'BrandSans-Regular.otf');
    writeFont(font, brand('Regular', { licence: OFL_STATEMENT }));
    registerInstalled(font, 'Regular');
    const previousNow = testAccountSession.now;
    registryResolveOverride = name => {
      testAccountSession.now = () => testAccountSession.accessExpiresAt;
      return [[name, 'Brand Sans', 'Regular', font]];
    };
    try {
      await assert.rejects(callIpcRaw('fonts:add-installed', f.project.id, { families: ['Brand Sans'] }), /Sign in/);
    } finally {
      testAccountSession.now = previousNow;
    }
    const stored = storeInstance.data.projects.find(item => item.id === f.project.id);
    assert.equal(stored.fontHandoff, undefined, 'no selection persisted by an unauthorized request');
  });

  fontTest('a font stored inside a Photoshop file is never packaged and is reported', async () => {
    const f = await fixture('Embedded');
    const parentPsd = path.join(f.dir, 'Parent.psd');
    fs.writeFileSync(parentPsd, Buffer.from('PSD container bytes'));
    currentPsdFixture = { children: [], linkedFiles: [{ name: 'Restricted.otf', data: buildFont({ fsType: 2 }) }] };
    await setProjectFiles(f.project.id, { files: [
      { path: f.image, name: 'Logo.png', ext: '.png', addedAt: Date.now(), source: 'manual-browse' },
      { path: parentPsd, parentPsd, name: 'Restricted.otf', ext: '.otf', source: 'scan-on-save-embedded', embedded: true,
        embeddedOriginalName: 'Restricted.otf', embeddedIndex: 0, fileId: 'synthetic-font-resource' },
    ] });
    const reviewResult = await review(f);
    assert.ok(!reviewResult.files.some(file => file.name === 'Restricted.otf'), 'not an ordinary output');
    const embedded = row(reviewResult, 'Restricted.otf');
    assert.equal(embedded.outcome, 'excluded');
    assert.equal(embedded.reason, 'embedded');
    assert.equal(embedded.canConfirm, false);
    assert.equal(embedded.canInclude, false);
    assert.equal((await callIpcRaw('fonts:set-row-choice', f.project.id, embedded.key, 'include')).error, 'font_not_eligible');
    assert.equal(row(await review(f), 'Restricted.otf').outcome, 'excluded');
    const { result } = await packageNow(f);
    assert.equal(result.success, true, JSON.stringify(result));
    const tree = listTree(result.folderPath);
    assert.ok(!tree.some(file => /\.(otf|ttf|ttc|otc)$/i.test(file)), tree.join(', '));
    // Never chosen by the sender, so it is not named to recipients and no note is written.
    assert.deepEqual(tree, ['PNG/Logo.png']);
  });

  fontTest('removed and never-chosen fonts are not named to recipients; no note when nothing is left to say', async () => {
    const f = await fixture('Private names');
    const file = path.join(f.dir, 'SecretClient-Bold.otf');
    writeFont(file, { names: englishNames({ family: 'Secret Client', style: 'Bold', postscriptName: 'SecretClient-Bold' }) });
    manualDialogFor([file]);
    await callIpcRaw('projects:add-files', f.project.id);
    const first = await review(f);
    assert.equal((await callIpcRaw('fonts:set-row-choice', f.project.id, row(first, 'SecretClient-Bold.otf').key, 'remove')).success, true);
    const removed = await review(f);
    assert.equal(row(removed, 'SecretClient-Bold.otf').reason, 'removed');
    const { result } = await packageNow(f, removed);
    assert.deepEqual(listTree(result.folderPath), ['PNG/Logo.png']);
  });

  fontTest('a PowerPoint deck that links a font file explains why Package Review cannot package it', async () => {
    const f = await fixture('Deck font link');
    const font = path.join(f.dir, 'BrandSans-Bold.otf');
    writeFont(font, brand('Bold', { licence: OFL_STATEMENT }));
    const stage = path.join(f.dir, 'zip');
    const rels = path.join(stage, 'ppt', 'slides', '_rels');
    fs.mkdirSync(rels, { recursive: true });
    fs.writeFileSync(path.join(stage, '[Content_Types].xml'), '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
    fs.writeFileSync(path.join(stage, 'ppt', 'slides', 'slide1.xml'), '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>');
    fs.writeFileSync(path.join(rels, 'slide1.xml.rels'), `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/oleObject" Target="file://${font}" TargetMode="External"/></Relationships>`);
    const deck = path.join(f.dir, 'Deck.pptx');
    assert.equal(realSpawnSync('/usr/bin/zip', ['-q', '-r', deck, '.'], { cwd: stage }).status, 0);
    manualDialogFor([deck, font]);
    await callIpcRaw('projects:add-files', f.project.id);
    await callIpcRaw('projects:set-existing-assets-decision', f.project.id, 'include');
    const result = await callIpcRaw('projects:prepare-package-review', f.project.id, f.out);
    assert.equal(result.materializable, false, JSON.stringify(result));
    assert.match(result.message || '', /links a font file/);
    assert.deepEqual(fs.readdirSync(f.out), []);
  });

  fontTest('adding the real file after its symlink replaces the link', async () => {
    const f = await fixture('Symlink then file');
    const real = path.join(f.dir, 'Real-Regular.otf');
    writeFont(real, { names: englishNames({ family: 'Real', style: 'Regular', postscriptName: 'Real-Regular', licence: OFL_STATEMENT }) });
    const link = path.join(f.dir, 'Link.otf');
    fs.symlinkSync(real, link);
    manualDialogFor([link]);
    await callIpcRaw('fonts:add-files', f.project.id);
    assert.equal(row(await review(f), 'Link.otf').reason, 'symlink');
    manualDialogFor([real]);
    assert.equal((await callIpcRaw('fonts:add-files', f.project.id)).added, 1);
    const after = await review(f);
    assert.equal(after.fonts.rows.length, 1);
    assert.equal(row(after, 'Real-Regular.otf').outcome, 'included');
  });

  fontTest('removing an added font leaves no stored choice behind', async () => {
    const f = await fixture('Prune');
    const file = path.join(f.dir, 'Gone-Regular.otf');
    writeFont(file, { names: englishNames({ family: 'Gone', style: 'Regular', postscriptName: 'Gone-Regular' }) });
    manualDialogFor([file]);
    await callIpcRaw('fonts:add-files', f.project.id);
    await callIpcRaw('fonts:set-row-choice', f.project.id, row(await review(f), 'Gone-Regular.otf').key, 'remove');
    assert.equal(storeInstance.data.projects.find(item => item.id === f.project.id).fontHandoff, undefined);
  });

  fontTest('the note never names a font the sender removed or never chose, even when it is also excluded', async () => {
    const f = await fixture('Private excluded names');
    const removedRestricted = path.join(f.dir, 'ClientSecret-Bold.otf');
    writeFont(removedRestricted, { fsType: 2, names: englishNames({ family: 'Client Secret', style: 'Bold', postscriptName: 'ClientSecret-Bold' }) });
    const foundRestricted = path.join(f.dir, 'FoundSecret-Regular.otf');
    writeFont(foundRestricted, { fsType: 2, names: englishNames({ family: 'Found Secret', style: 'Regular', postscriptName: 'FoundSecret-Regular' }) });
    const keptRestricted = path.join(f.dir, 'Kept-Regular.otf');
    writeFont(keptRestricted, { fsType: 2, names: englishNames({ family: 'Kept', style: 'Regular', postscriptName: 'Kept-Regular' }) });
    manualDialogFor([removedRestricted, keptRestricted]);
    await callIpcRaw('projects:add-files', f.project.id);
    const stored = storeInstance.data.projects.find(item => item.id === f.project.id);
    stored.pendingFiles = [makePendingFile(foundRestricted, 'lastused-scan')];
    await callIpcRaw('projects:accept-pending', f.project.id, foundRestricted);
    await callIpcRaw('projects:set-existing-assets-decision', f.project.id, 'include');
    const first = await review(f);
    await callIpcRaw('fonts:set-row-choice', f.project.id, row(first, 'ClientSecret-Bold.otf').key, 'remove');
    const reviewResult = await review(f);
    assert.equal(reviewResult.fonts.noteWritten, true);
    const { result } = await packageNow(f, reviewResult);
    const note = fs.readFileSync(path.join(result.folderPath, 'Fonts', 'Fonts in this package.txt'), 'utf8');
    assert.match(note, /Kept-Regular/, 'an explicitly added font that cannot be included is still listed');
    assert.doesNotMatch(note, /ClientSecret|Client Secret/);
    assert.doesNotMatch(note, /FoundSecret|Found Secret/);
  });

  fontTest('the Fonts summary only promises a note when one will be written', async () => {
    const f = await fixture('No note promise');
    const file = path.join(f.dir, 'Gone-Regular.otf');
    writeFont(file, { names: englishNames({ family: 'Gone', style: 'Regular', postscriptName: 'Gone-Regular' }) });
    manualDialogFor([file]);
    await callIpcRaw('projects:add-files', f.project.id);
    await callIpcRaw('fonts:set-row-choice', f.project.id, row(await review(f), 'Gone-Regular.otf').key, 'remove');
    assert.equal((await review(f)).fonts.noteWritten, false);
  });

  fontTest('an expired sign-in during the installed-font listing returns nothing', async () => {
    const f = await fixture('Listing expiry');
    registerInstalled(path.join(fontsDir(), 'BrandSans-Regular.otf'), 'Regular');
    const previousNow = testAccountSession.now;
    setChildProcessHandler(request => {
      if (!isFontRegistry(request)) return { stdout: '', stderr: '' };
      testAccountSession.now = () => testAccountSession.accessExpiresAt;
      return { stdout: JSON.stringify({ mode: 'list', rows: registryRows }) + '\n' };
    });
    try {
      await assert.rejects(callIpcRaw('fonts:list-installed', f.project.id), /Sign in/);
    } finally {
      testAccountSession.now = previousNow;
      installRegistry();
    }
  });

  fontTest('a font added through Add Files with a trailing space in its name is gated, not copied as an asset', async () => {
    const f = await fixture('Spaced name');
    const file = path.join(f.dir, 'Boundary.otf ');
    writeFont(file, { fsType: 2, names: englishNames({ family: 'Boundary', style: 'Regular', postscriptName: 'Boundary-Regular' }) });
    manualDialogFor([file]);
    await callIpcRaw('projects:add-files', f.project.id);
    const reviewResult = await review(f);
    assert.ok(!reviewResult.files.some(item => /Boundary/.test(item.name)), 'not an ordinary output');
    const { result } = await packageNow(f, reviewResult);
    assert.ok(!listTree(result.folderPath).some(item => /Boundary/.test(item)), listTree(result.folderPath).join(', '));
  });

  fontTest('include is refused for a font stored inside a Photoshop file', async () => {
    const f = await fixture('Embedded include');
    const parentPsd = path.join(f.dir, 'Parent.psd');
    fs.writeFileSync(parentPsd, Buffer.from('PSD container bytes'));
    currentPsdFixture = { children: [], linkedFiles: [{ name: 'Secret.otf', data: buildFont() }] };
    await setProjectFiles(f.project.id, { files: [
      { path: f.image, name: 'Logo.png', ext: '.png', addedAt: Date.now(), source: 'manual-browse' },
      { path: parentPsd, parentPsd, name: 'Secret.otf', ext: '.otf', source: 'scan-on-save-embedded', embedded: true,
        embeddedOriginalName: 'Secret.otf', embeddedIndex: 0, fileId: 'synthetic-secret' },
    ] });
    const key = row(await review(f), 'Secret.otf').key;
    assert.equal((await callIpcRaw('fonts:set-row-choice', f.project.id, key, 'include')).error, 'font_not_eligible');
  });

  fontTest('Add font files reports files it could not add at the project limit', async () => {
    const f = await fixture('File limit');
    const stored = storeInstance.data.projects.find(item => item.id === f.project.id);
    stored.fontHandoff = { version: 1, installed: [], choices: {}, confirmations: {},
      files: Array.from({ length: 199 }, (_, index) => ({ path: path.join(f.dir, `Pad-${index}.otf`), addedAt: index })) };
    const a = path.join(f.dir, 'A.otf'); const b = path.join(f.dir, 'B.otf'); const c = path.join(f.dir, 'C.otf');
    for (const file of [a, b, c]) writeFont(file, brand('Bold'));
    manualDialogFor([a, b, c]);
    const result = await callIpcRaw('fonts:add-files', f.project.id);
    assert.equal(result.added, 1);
    assert.equal(result.notStored, 2);
  });

  fontTest('a font with no readable English name is named in the note by its file name', async () => {
    const f = await fixture('Unnamed note');
    const { nameRecord } = require('./font-fixtures');
    const file = path.join(f.dir, 'Localized.otf');
    writeFont(file, { names: [nameRecord(6, 'Lokal-PS', 3, 1, 0x0407), nameRecord(1, 'Lokal', 3, 1, 0x0407)] });
    manualDialogFor([file]);
    await callIpcRaw('fonts:add-files', f.project.id);
    const { result } = await packageNow(f);
    const note = fs.readFileSync(path.join(result.folderPath, 'Fonts', 'Fonts in this package.txt'), 'utf8');
    assert.match(note, /- Localized\.otf: /);
    assert.doesNotMatch(note, /Unnamed font/);
  });

  fontTest('round 4: a font file with an invisible character after its extension is gated, keeps its name, and is never copied when restricted', async () => {
    const f = await fixture('Disguised');
    const restricted = path.join(f.dir, 'Hidden.otf​');
    writeFont(restricted, { fsType: 2, names: englishNames({ family: 'Hidden', style: 'Regular', postscriptName: 'Hidden-Regular' }) });
    const open = path.join(f.dir, 'Open.otf⁠');
    const openBytes = writeFont(open, { names: englishNames({ family: 'Open', style: 'Regular', postscriptName: 'Open-Regular', licence: OFL_STATEMENT }) });
    const png = path.join(f.dir, 'Photo.png​');
    fs.writeFileSync(png, createSyntheticPngBytes());
    manualDialogFor([restricted, open, png]);
    await callIpcRaw('projects:add-files', f.project.id);
    await callIpcRaw('projects:set-existing-assets-decision', f.project.id, 'include');
    const reviewResult = await review(f);
    assert.equal(row(reviewResult, 'Hidden.otf​').reason, 'restricted');
    assert.ok(!reviewResult.files.some(item => /Hidden|Open/.test(item.name)), 'fonts are not ordinary outputs');
    assert.ok(reviewResult.files.some(item => item.name === 'Photo.png​'), 'an ordinary file with the same suffix stays ordinary');
    // Open-licence font added by the user through Add Files: included after Include.
    assert.equal(row(reviewResult, 'Open.otf⁠').origin, 'project-file');
    const { result } = await packageNow(f, reviewResult);
    const tree = listTree(result.folderPath);
    assert.ok(!tree.some(item => item.includes('Hidden')), tree.join(', '));
    assert.ok(tree.includes('Fonts/Open.otf⁠'), 'output name unchanged, in the Fonts folder: ' + tree.join(', '));
    assert.deepEqual(fs.readFileSync(path.join(result.folderPath, 'Fonts', 'Open.otf⁠')), openBytes);
    assert.ok(tree.some(item => item.endsWith('Photo.png​')), 'ordinary asset still copied');
  });

  fontTest('round 4: contradictory or spoofed licence wording asks for the per-font confirmation before any copy', async () => {
    const f = await fixture('Contradiction');
    const cases = [
      ['Trial.otf', englishNames({ family: 'Trial', style: 'Regular', postscriptName: 'Trial-Regular', licence: `${OFL_STATEMENT} Trial version for evaluation.` })],
      ['Spoof.otf', englishNames({ family: 'Spoof', style: 'Regular', postscriptName: 'Spoof-Regular', licence: 'Licensed under the SIL Open Font License',
        licenceUrl: `${'a '.repeat(114)}https://openfontlicense.org.evil.example/terms` })],
    ];
    for (const [name, names] of cases) { writeFont(path.join(f.dir, name), { names }); }
    manualDialogFor(cases.map(([name]) => path.join(f.dir, name)));
    await callIpcRaw('fonts:add-files', f.project.id);
    const before = await review(f);
    for (const [name] of cases) assert.equal(row(before, name).outcome, 'needs-confirmation', name);
    let out = await packageNow(f, before);
    assert.deepEqual(listTree(out.result.folderPath).filter(item => item.endsWith('.otf')), []);
    fs.rmSync(out.result.folderPath, { recursive: true, force: true });
    const trial = row(before, 'Trial.otf');
    assert.equal((await callIpcRaw('fonts:confirm-licence', f.project.id, trial.key, { confirmed: true, sha256: trial.sha256 })).success, true);
    const after = await review(f);
    assert.equal(row(after, 'Trial.otf').basis, 'confirmed');
    assert.equal(row(after, 'Spoof.otf').outcome, 'needs-confirmation');
    out = await packageNow(f, after);
    assert.deepEqual(listTree(out.result.folderPath).filter(item => item.endsWith('.otf')), ['Fonts/Trial.otf']);
  });

  fontTest('round 5: restricted fonts behind a blank symbol or other non-letter after the extension are gated and never copied; output names unchanged', async () => {
    const f = await fixture('Blank suffix');
    const hidden = path.join(f.dir, 'Hidden.otf⠀');
    const lock = path.join(f.dir, 'Lock.ttf\u{1f512}');
    for (const [file, ps] of [[hidden, 'Hidden-Regular'], [lock, 'Lock-Regular']]) {
      writeFont(file, { fsType: 2, names: englishNames({ family: ps.split('-')[0], style: 'Regular', postscriptName: ps }) });
    }
    const open = path.join(f.dir, 'Open.otf~');
    const openBytes = writeFont(open, { names: englishNames({ family: 'Open', style: 'Regular', postscriptName: 'Open-Regular', licence: OFL_STATEMENT }) });
    const photo = path.join(f.dir, 'Photo.png⠀');
    fs.writeFileSync(photo, createSyntheticPngBytes());
    manualDialogFor([hidden, lock, open, photo]);
    await callIpcRaw('projects:add-files', f.project.id);
    await callIpcRaw('projects:set-existing-assets-decision', f.project.id, 'include');
    const reviewResult = await review(f);
    assert.equal(row(reviewResult, 'Hidden.otf⠀').reason, 'restricted');
    assert.equal(row(reviewResult, 'Lock.ttf\u{1f512}').reason, 'restricted');
    for (const name of ['Hidden.otf⠀', 'Lock.ttf\u{1f512}']) {
      const target = row(reviewResult, name);
      assert.equal((await callIpcRaw('fonts:set-row-choice', f.project.id, target.key, 'include')).success, true);
      const confirm = await callIpcRaw('fonts:confirm-licence', f.project.id, target.key, { confirmed: true, sha256: target.sha256 });
      assert.notEqual(confirm.success, true, `${name}: a restricted font cannot be confirmed`);
    }
    const again = await review(f);
    assert.ok(!again.files.some(item => /Hidden|Lock|Open/.test(item.name)), 'fonts are not ordinary outputs');
    assert.ok(again.files.some(item => item.name === 'Photo.png⠀'), 'an ordinary file with the same suffix stays ordinary');
    const { result } = await packageNow(f, again);
    const tree = listTree(result.folderPath);
    assert.ok(!tree.some(item => /Hidden|Lock/.test(item)), tree.join(', '));
    assert.ok(tree.includes('Fonts/Open.otf~'), 'output name unchanged, in the Fonts folder: ' + tree.join(', '));
    assert.deepEqual(fs.readFileSync(path.join(result.folderPath, 'Fonts', 'Open.otf~')), openBytes);
    assert.ok(tree.some(item => item.endsWith('Photo.png⠀')), 'ordinary asset still copied');
  });

  fontTest('round 5: a disagreeing secondary licence record (Fable P5) asks for the confirmation, through Add font files and installed fonts', async () => {
    const f = await fixture('Split licence');
    const split = path.join(f.dir, 'Split.otf');
    writeFont(split, { names: [...englishNames({ family: 'Split', style: 'Regular', postscriptName: 'Split-Regular', licence: OFL_STATEMENT }),
      nameRecord(13, 'Commercial font. Do not redistribute.', 1, 0, 0)] });
    const bold = path.join(fontsDir(), 'BrandSans-Bold.otf');
    const boldBytes = writeFont(bold, { names: [...englishNames({ family: 'Brand Sans', style: 'Bold', postscriptName: 'BrandSans-Bold', licence: OFL_STATEMENT }),
      nameRecord(13, 'Nicht weitergeben.', 3, 1, 0x0407)] });
    registerInstalled(bold, 'Bold');
    manualDialogFor([split]);
    await callIpcRaw('fonts:add-files', f.project.id);
    assert.equal((await callIpcRaw('fonts:add-installed', f.project.id, { families: ['Brand Sans'] })).added, 1);
    const before = await review(f);
    for (const name of ['Split.otf', 'BrandSans-Bold.otf']) {
      assert.equal(row(before, name).outcome, 'needs-confirmation', name);
      assert.equal(row(before, name).reason, 'licence-unknown', name);
    }
    let out = await packageNow(f, before);
    assert.deepEqual(listTree(out.result.folderPath).filter(item => item.endsWith('.otf')), []);
    const firstNote = fs.readFileSync(path.join(out.result.folderPath, 'Fonts', 'Fonts in this package.txt'), 'utf8');
    assert.doesNotMatch(firstNote, /Open Font License/, 'no OFL claim for a font whose records disagree');
    assert.equal(fs.existsSync(path.join(out.result.folderPath, 'Fonts', 'SIL Open Font License 1.1.txt')), false);
    fs.rmSync(out.result.folderPath, { recursive: true, force: true });
    const target = row(before, 'BrandSans-Bold.otf');
    assert.equal((await callIpcRaw('fonts:confirm-licence', f.project.id, target.key, { confirmed: true, sha256: target.sha256 })).success, true);
    const after = await review(f);
    assert.equal(row(after, 'BrandSans-Bold.otf').basis, 'confirmed');
    assert.equal(row(after, 'Split.otf').outcome, 'needs-confirmation');
    out = await packageNow(f, after);
    assert.deepEqual(listTree(out.result.folderPath).filter(item => item.endsWith('.otf')), ['Fonts/BrandSans-Bold.otf']);
    assert.deepEqual(fs.readFileSync(path.join(out.result.folderPath, 'Fonts', 'BrandSans-Bold.otf')), boldBytes);
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
