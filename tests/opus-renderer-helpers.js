'use strict';
// Reuse the repository's modeled DOM while exercising production renderer code.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const sharedPath = path.join(__dirname, 'renderer-figma-scope.test.js');
const shared = fs.readFileSync(sharedPath, 'utf8');
const scope = { require: createRequire(sharedPath), __dirname, console, setTimeout, clearTimeout };
vm.createContext(scope);
vm.runInContext(shared.slice(0, shared.indexOf('\ntest(')), scope);
function loadProjectedWorkspace(project, workspace) {
  const { document, elements, assetFilters } = scope.createInteractiveRendererDom();
  const renderer = scope.loadRendererHelpers(document, { crate: {} });
  const el = id => document.getElementById(id);
  for (const category of ['working', 'existing', 'added']) el(`${category}-assets-section`).appendChild(el(`${category}-assets-list`));
  el('pending-section').appendChild(el('pending-file-list'));
  el('pending-section').appendChild(el('pending-batch-slot'));
  el('existing-batch-slot').appendChild(el('asset-review-batch-controls'));
  for (const id of ['btn-include-all-existing','btn-skip-all-existing','asset-review-batch-reason']) el('asset-review-batch-controls').appendChild(el(id));
  for (const id of ['project-review-eyebrow','project-linking-alert','project-review-detail']) el('project-review-status').appendChild(el(id));
  renderer.testProject = project; renderer.testWorkspace = workspace;
  vm.runInContext('state.projects=[testProject];state.selectedProjectId=testProject.id;state.assetWorkspace=testWorkspace;', renderer);
  renderer.renderPendingFiles(project, workspace.pendingFiles);
  renderer.renderAssetWorkspace(project, {}, workspace.files);
  const filter = (name, query = '') => {
    renderer.testFilter = name; renderer.testQuery = query;
    vm.runInContext('state.assetReviewFilter=testFilter;state.assetReviewQuery=testQuery',renderer);
    renderer.applyAssetReviewFilter();
  };
  return {renderer,document,elements,assetFilters,filter,text:scope.getElementTreeText};
}
module.exports = {loadProjectedWorkspace};
