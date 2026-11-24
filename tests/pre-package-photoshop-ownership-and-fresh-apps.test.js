'use strict';
// Ordinary benign functional coverage of the real production projects:pre-package-scan
// entry point for:
//   1. Photoshop per-PSD dependency ownership isolation (app-wide broad-observer results
//      stay non-owned pending candidates and never cross-contaminate per-PSD ownership or
//      exclusion/packaging behavior).
//   2. Fresh pre-package running-app detection for Photoshop and InDesign in both
//      directions (absent -> running and running -> stopped), plus non-launching
//      AppleScript guards.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const assert = require('./bounded-assert');

const root = process.env.CRATE_DIAGNOSTIC_SOURCE_ROOT || path.resolve(__dirname, '..');
assert.ok(root && path.isAbsolute(root));
const entry = path.join(root, 'tests/provenance-dual-write.test.js');
let source = fs.readFileSync(entry, 'utf8');
function replaceOnce(before, after) {
  assert.equal(source.split(before).length, 2, 'adapter drift');
  source = source.replace(before, after);
}
replaceOnce("const test = require('node:test');", "const prePkgTest = require('node:test'); const test = new Proxy(prePkgTest, { apply() {} });");
replaceOnce("fs.mkdtempSync(path.join(os.tmpdir(), 'crate-provenance-dual-write-home-'))", "fs.mkdtempSync(path.join(path.dirname(MAIN_UNDER_TEST_ROOT), 'ps-own-stage-home-'))");
replaceOnce('if (!key) return this.data;', 'if (!key) return JSON.parse(JSON.stringify(this.data));');
replaceOnce('return cur === undefined ? fallback : cur;', 'return cur === undefined ? fallback : JSON.parse(JSON.stringify(cur));');
replaceOnce('  set(key, value) {', '  set(key, value) { value = value === undefined ? undefined : JSON.parse(JSON.stringify(value));');
source += '\n(' + cases.toString() + ')();\n';
const compiled = new Module(entry, module);
compiled.filename = entry;
compiled.paths = Module._nodeModulePaths(path.dirname(entry));
compiled._compile(source, entry);

function cases() {
  const realAgPsd = originalLoad.call(Module, 'ag-psd/dist/index.js', module);

  function buildSyntheticPsdWithLink(linkedFilePath) {
    return realAgPsd.writePsdBuffer({
      width: 4,
      height: 4,
      channels: 3,
      bitsPerChannel: 8,
      colorMode: 3,
      children: [{ name: 'Hero Smart Object' }],
      linkedFiles: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          name: path.basename(linkedFilePath),
          childDocumentID: '',
          linkedFile: {
            fileSize: 64,
            name: path.basename(linkedFilePath),
            fullPath: linkedFilePath,
            originalPath: linkedFilePath,
            relativePath: `./${path.basename(linkedFilePath)}`,
          },
        },
      ],
    });
  }

  function isPsCommand(request) {
    const cmd = String(request?.command || '');
    return cmd.includes('/bin/ps');
  }

  function getOsascriptPath(request) {
    const cmd = String(request?.command || '');
    const args = Array.isArray(request?.args) ? request.args : [];
    if (cmd.includes('osascript')) {
      const scriptArg = args.find(a => typeof a === 'string' && a.endsWith('.applescript'));
      return scriptArg || args[args.length - 1] || '';
    }
    return null;
  }

  prePkgTest(
    'pre-package scan keeps app-wide Photoshop discoveries out of per-PSD ownership and preserves exclusion behavior',
    { timeout: 30000 },
    async () => {
      resetTestHomeWorkspace();
      storeInstance.set('quickPackageOutputPaths', []);
      setChildProcessHandler(() => ({ stdout: '' }));

      const project = await createProject('Photoshop Ownership Isolation');
      await callIpcRaw('projects:pause', project.id);
      clearTrackedTimers();

      const folder = path.join(TEST_HOME, 'Desktop', 'PsdOwnership');
      fs.mkdirSync(folder, { recursive: true });

      const assetA = path.join(folder, 'AssetA.png');
      const assetB = path.join(folder, 'AssetB.png');
      const assetC = path.join(folder, 'AssetC.png');
      const assetABytes = Buffer.from('synthetic-asset-a-bytes');
      const assetBBytes = Buffer.from('synthetic-asset-b-bytes');
      const assetCBytes = Buffer.from('synthetic-asset-c-bytes');
      fs.writeFileSync(assetA, assetABytes);
      fs.writeFileSync(assetB, assetBBytes);
      fs.writeFileSync(assetC, assetCBytes);

      const docA = path.join(folder, 'DocA.psd');
      fs.writeFileSync(docA, buildSyntheticPsdWithLink(assetA));
      const priorPsdFixture = currentPsdFixture;
      currentPsdFixture = () => realAgPsd.readPsd(fs.readFileSync(docA), {
        skipLayerImageData: true,
        skipCompositeImageData: true,
      });

      await setProjectFiles(project.id, {
        files: [
          { path: docA, ext: '.psd', name: 'DocA.psd', source: 'manual-browse' },
          { path: assetA, ext: '.png', name: 'AssetA.png', source: 'psd-linked' },
          { path: assetB, ext: '.png', name: 'AssetB.png', source: 'psd-linked' },
        ],
      });

      let psScriptCalls = 0;
      const capturedPsScripts = [];
      setChildProcessHandler(request => {
        if (isPsCommand(request)) {
          return {
            stdout: '4101 /Applications/Adobe Photoshop 2025/Adobe Photoshop 2025.app/Contents/MacOS/Adobe Photoshop 2025\n',
          };
        }
        const scriptPath = getOsascriptPath(request);
        if (scriptPath && scriptPath.includes('crate-ps-scan.applescript')) {
          psScriptCalls += 1;
          if (fs.existsSync(scriptPath)) {
            capturedPsScripts.push(fs.readFileSync(scriptPath, 'utf8'));
          }
          // Simulates app-wide Photoshop query returning links from open DocA AND unrelated open DocB
          return { stdout: `${assetA}\n${assetB}\n${assetC}\n` };
        }
        return { stdout: '' };
      });

      try {
        const scanResult = await callIpcRaw('projects:pre-package-scan', project.id);
        assert.equal(scanResult.error, undefined);
        assert.equal(psScriptCalls, 1, 'app-wide Photoshop query runs once in broad-observer pass, never per PSD in double-check');
        assert.equal(capturedPsScripts.length, 1);
        assert.ok(
          capturedPsScripts[0].includes('if application "Adobe Photoshop" is running then'),
          'Photoshop AppleScript must guard with is running before tell'
        );

        const stored = await getProject(project.id);
        const storedA = stored.files.find(f => f.path === assetA);
        const storedB = stored.files.find(f => f.path === assetB);
        const pendingC = (stored.pendingFiles || []).find(f => f.path === assetC);

        assert.ok(storedA, 'AssetA.png remains an accepted project file');
        assert.ok(storedB, 'AssetB.png remains an accepted project file');
        assert.ok(pendingC, 'AssetC.png from broad-observer Photoshop query is staged as pending');
        assert.equal(stored.files.some(f => f.path === assetC), false, 'broad-observer Photoshop discovery must not directly promote to files');

        // Document-scoped ag-psd ownership is recorded ONLY for DocA's true link (AssetA)
        assert.ok(
          Array.isArray(storedA.dependencyOwners) && storedA.dependencyOwners.includes(docA),
          'DocA.psd must be recorded as dependency owner of its own linked AssetA.png'
        );
        assert.equal(
          Array.isArray(storedB.dependencyOwners) && storedB.dependencyOwners.includes(docA),
          false,
          'unrelated accepted AssetB.png must NOT be attributed to DocA.psd from app-wide Photoshop query'
        );
        assert.notEqual(storedB.captureEvidence?.relationshipSourcePath, docA);
        assert.equal(
          Array.isArray(pendingC.dependencyOwners) && pendingC.dependencyOwners.includes(docA),
          false,
          'pending AssetC.png from app-wide Photoshop query must NOT record DocA.psd as dependency owner'
        );
        assert.notEqual(pendingC.captureEvidence?.relationshipSourcePath, docA);

        // Verify user-facing exclusion and package materialization honor the clean ownership graph:
        // Excluding DocA.psd withholds DocA.psd and its owned AssetA.png, while keeping AssetB.png.
        const workspace = await callIpcRaw('projects:get-asset-workspace', project.id);
        const docARow = workspace.files.find(f => f.name === 'DocA.psd');
        assert.ok(docARow, 'DocA.psd appears in asset workspace');
        const excluded = await callIpcRaw('projects:set-working-source-selection', project.id, docARow.visualIdentity, {
          action: 'exclude',
          expectedRevision: docARow.selectionRevision,
        });
        assert.equal(excluded.success, true);

        const outDir = path.join(TEST_HOME, 'PsdOwnershipPackageOut');
        fs.mkdirSync(outDir, { recursive: true });
        const review = await callIpcRaw('projects:prepare-package-review', project.id, outDir);
        assert.equal(review.materializable, true, JSON.stringify(review));
        const reviewedNames = review.files.map(f => f.name);
        assert.equal(reviewedNames.includes('DocA.psd'), false, 'excluded DocA.psd is withheld from package review');
        assert.equal(reviewedNames.includes('AssetA.png'), false, 'AssetA.png owned only by excluded DocA.psd is withheld');
        assert.equal(reviewedNames.includes('AssetB.png'), true, 'independent AssetB.png remains included when DocA.psd is excluded');
        assert.equal(reviewedNames.includes('AssetC.png'), false, 'pending AssetC.png is not packaged');

        const packaged = await callIpcRaw('projects:package', project.id, outDir, review.token);
        assert.equal(packaged.success, true, JSON.stringify(packaged));
        const outputFiles = [];
        const walk = dir => {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else outputFiles.push(full);
          }
        };
        walk(packaged.folderPath);
        const outputBasenames = outputFiles.map(p => path.basename(p));
        assert.equal(outputBasenames.includes('DocA.psd'), false);
        assert.equal(outputBasenames.includes('AssetA.png'), false);
        assert.equal(outputBasenames.includes('AssetC.png'), false);
        const packagedB = outputFiles.find(p => path.basename(p) === 'AssetB.png');
        assert.ok(packagedB, 'independent AssetB.png is written into final package');
        assert.deepEqual(fs.readFileSync(packagedB), assetBBytes);
      } finally {
        currentPsdFixture = priorPsdFixture;
        clearTrackedTimers();
      }
    }
  );

  prePkgTest(
    'pre-package scan refreshes Photoshop and InDesign running state right before scripting (absent -> running)',
    { timeout: 20000 },
    async () => {
      resetTestHomeWorkspace();
      storeInstance.set('quickPackageOutputPaths', []);
      setChildProcessHandler(() => ({ stdout: '' }));

      const project = await createProject('Fresh App Detection Absent To Running');
      await callIpcRaw('projects:pause', project.id);
      clearTrackedTimers();

      const folder = path.join(TEST_HOME, 'Desktop', 'FreshAppsStart');
      fs.mkdirSync(folder, { recursive: true });
      const anchor = path.join(folder, 'Anchor.ai');
      writeSyntheticAiFile(anchor);
      await setProjectFiles(project.id, {
        files: [{ path: anchor, ext: '.ai', name: 'Anchor.ai', source: 'manual-browse' }],
      });

      let psCallCount = 0;
      const executedScripts = { photoshop: [], indesign: [] };
      setChildProcessHandler(request => {
        if (isPsCommand(request)) {
          psCallCount += 1;
          if (psCallCount === 1) {
            // Initial Figma discovery snapshot: neither Photoshop nor InDesign running yet
            return { stdout: '101 /usr/sbin/syslogd\n' };
          }
          // Subsequent refreshed checks right before Photoshop and InDesign scripting: both running
          return {
            stdout: [
              '5101 /Applications/Adobe Photoshop 2025/Adobe Photoshop 2025.app/Contents/MacOS/Adobe Photoshop 2025',
              '5102 /Applications/Adobe InDesign 2025/Adobe InDesign 2025.app/Contents/MacOS/Adobe InDesign 2025',
            ].join('\n') + '\n',
          };
        }
        const scriptPath = getOsascriptPath(request);
        if (scriptPath && scriptPath.includes('crate-ps-scan.applescript')) {
          executedScripts.photoshop.push(fs.existsSync(scriptPath) ? fs.readFileSync(scriptPath, 'utf8') : '');
          return { stdout: '' };
        }
        if (scriptPath && scriptPath.includes('crate-indd-scan.applescript')) {
          executedScripts.indesign.push(fs.existsSync(scriptPath) ? fs.readFileSync(scriptPath, 'utf8') : '');
          return { stdout: '' };
        }
        return { stdout: '' };
      });

      try {
        const res = await callIpcRaw('projects:pre-package-scan', project.id);
        assert.equal(res.error, undefined);
        assert.ok(psCallCount >= 3, `expected at least 3 fresh running-app checks (Figma, Photoshop, InDesign), got ${psCallCount}`);
        assert.equal(executedScripts.photoshop.length, 1, 'Photoshop script runs after fresh check detects Photoshop started');
        assert.equal(executedScripts.indesign.length, 1, 'InDesign script runs after fresh check detects InDesign started');
        assert.ok(
          executedScripts.photoshop[0].includes('if application "Adobe Photoshop" is running then'),
          'Photoshop AppleScript guards against launching closed app'
        );
        assert.ok(
          executedScripts.indesign[0].includes('if application "Adobe InDesign" is running then'),
          'InDesign AppleScript guards against launching closed app'
        );
      } finally {
        clearTrackedTimers();
      }
    }
  );

  prePkgTest(
    'pre-package scan refreshes Photoshop and InDesign running state right before scripting (running -> stopped)',
    { timeout: 20000 },
    async () => {
      resetTestHomeWorkspace();
      storeInstance.set('quickPackageOutputPaths', []);
      setChildProcessHandler(() => ({ stdout: '' }));

      const project = await createProject('Fresh App Detection Running To Stopped');
      await callIpcRaw('projects:pause', project.id);
      clearTrackedTimers();

      const folder = path.join(TEST_HOME, 'Desktop', 'FreshAppsStop');
      fs.mkdirSync(folder, { recursive: true });
      const anchor = path.join(folder, 'Anchor.ai');
      writeSyntheticAiFile(anchor);
      await setProjectFiles(project.id, {
        files: [{ path: anchor, ext: '.ai', name: 'Anchor.ai', source: 'manual-browse' }],
      });

      let psCallCount = 0;
      let psScriptCalls = 0;
      let inddScriptCalls = 0;
      setChildProcessHandler(request => {
        if (isPsCommand(request)) {
          psCallCount += 1;
          if (psCallCount === 1) {
            // Initial Figma discovery snapshot: both Photoshop and InDesign were running
            return {
              stdout: [
                '6101 /Applications/Adobe Photoshop 2025/Adobe Photoshop 2025.app/Contents/MacOS/Adobe Photoshop 2025',
                '6102 /Applications/Adobe InDesign 2025/Adobe InDesign 2025.app/Contents/MacOS/Adobe InDesign 2025',
              ].join('\n') + '\n',
            };
          }
          // Both apps quit before their scripting passes
          return { stdout: '101 /usr/sbin/syslogd\n' };
        }
        const scriptPath = getOsascriptPath(request);
        if (scriptPath && scriptPath.includes('crate-ps-scan.applescript')) {
          psScriptCalls += 1;
          return { stdout: '' };
        }
        if (scriptPath && scriptPath.includes('crate-indd-scan.applescript')) {
          inddScriptCalls += 1;
          return { stdout: '' };
        }
        return { stdout: '' };
      });

      try {
        const res = await callIpcRaw('projects:pre-package-scan', project.id);
        assert.equal(res.error, undefined);
        assert.ok(psCallCount >= 3, `expected at least 3 fresh running-app checks (Figma, Photoshop, InDesign), got ${psCallCount}`);
        assert.equal(psScriptCalls, 0, 'Photoshop AppleScript must NOT run after fresh check sees Photoshop stopped');
        assert.equal(inddScriptCalls, 0, 'InDesign AppleScript must NOT run after fresh check sees InDesign stopped');
      } finally {
        clearTrackedTimers();
      }
    }
  );
}
