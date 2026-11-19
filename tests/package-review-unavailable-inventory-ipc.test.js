'use strict';
// A real working-file refusal from the main process, carried into the production
// renderer. Electron, the store and the DOM are the repository's synthetic
// harnesses and all files are synthetic; nothing here is native evidence.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const assert = require('./bounded-assert');

const harnessPath = path.join(__dirname, 'provenance-dual-write.test.js');
let harness = fs.readFileSync(harnessPath, 'utf8');
const anchor = "const test = require('node:test');";
assert.equal(harness.split(anchor).length - 1, 1, 'harness test anchor');
harness = harness.replace(anchor, "const inventoryTest = require('node:test'); const test = new Proxy(inventoryTest, { apply() {} });");
const compiled = new Module(harnessPath, module);
compiled.filename = harnessPath;
compiled.paths = Module._nodeModulePaths(__dirname);
compiled._compile(harness + '\n(' + inventoryCases.toString() + ')();', harnessPath);

function inventoryCases() {
  inventoryTest('a real working-file refusal reaches the window with unavailable values', async () => {
    resetTestHomeWorkspace();
    const project = await createProject('Sample refusal project');
    await callIpcRaw('projects:pause', project.id);
    clearTrackedTimers();
    for (const name of ['First.ai', 'Second.ai']) {
      const target = path.join(TEST_HOME, 'Desktop', name);
      fs.writeFileSync(target, '%PDF-1.7\n\n%%EOF\n');
      manualDialogFor([target]);
      await callIpcRaw('projects:add-files', project.id);
    }
    const vm = require('node:vm');
    const sharedPath = path.join(__dirname, 'renderer-figma-scope.test.js');
    const shared = fs.readFileSync(sharedPath, 'utf8');
    const scope = { require: Module.createRequire(sharedPath), __dirname, console, setTimeout, clearTimeout };
    vm.createContext(scope);
    vm.runInContext(shared.slice(0, shared.indexOf('\ntest(')), scope);
    const { document, elements } = scope.createInteractiveRendererDom();
    const answers = [];
    const renderer = scope.loadRendererHelpers(document, { crate: {
      getProjects: () => callIpcRaw('projects:get-all'),
      getAssetWorkspace: id => callIpcRaw('projects:get-asset-workspace', id),
      preparePackageReview: async id => {
        const answer = await callIpcRaw('projects:prepare-package-review', id);
        answers.push(answer);
        return answer;
      },
      preScanSession: async () => null,
    } });
    renderer.fixtureProject = JSON.parse(JSON.stringify(storeInstance.data.projects.find(item => item.id === project.id)));
    renderer.fixtureWorkspace = await callIpcRaw('projects:get-asset-workspace', project.id);
    vm.runInContext(`state.projects = [fixtureProject]; state.selectedProjectId = fixtureProject.id;
      state.assetWorkspace = fixtureWorkspace; state.settings = { namingTemplate: '{Project}' };
      accountStatus.canUseWorkspace = true;`, renderer);
    renderer.showToast = () => {};
    document.getElementById('package-review-total').textContent = '0 visual assets';
    let shownReview;
    const render = renderer.renderPackageReview;
    renderer.renderPackageReview = (...args) => { shownReview = args[1]; return render(...args); };

    assert.equal(await renderer.showPackageModal({ runPreScan: false }), false);
    assert.equal(answers.at(-1).error, 'working_file_choice_required');
    assert.equal(Object.prototype.hasOwnProperty.call(answers.at(-1), 'files'), false, 'the main process sends no file list');
    assert.equal(Object.prototype.hasOwnProperty.call(answers.at(-1), 'inventoryUnavailable'), false, 'only the window sets the field');
    assert.equal(shownReview.inventoryUnavailable, true);
    assert.equal(elements['package-review-total'].textContent, 'Visual assets unavailable');
    const rows = new Map(Array.from(elements['package-review-summary-list'].children, row => [row.children[0].textContent, row.children[1].textContent]));
    for (const label of ['Working files', 'Existing assets', 'Added while working', 'Needs Review']) assert.equal(rows.get(label), 'Unavailable', label);
    assert.equal(rows.get('Package status'), 'Review required');
    assert.equal(elements['package-review-ready'].textContent, 'Review required');
    assert.equal(elements['modal-package-review-message'].textContent, 'Decide how to use the new working files before packaging.');
    assert.match(scope.getElementTreeText(elements['source-continuation-choices']), /Packaging blocked/);
    assert.equal(elements['btn-confirm-package'].disabled, true);
    assert.equal(vm.runInContext('state.packageReviewToken', renderer), null);
  });
}
