'use strict';
// Production renderer on the existing modeled DOM. No native app acceptance.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const sharedPath = path.join(__dirname, 'renderer-figma-scope.test.js');
const shared = fs.readFileSync(sharedPath, 'utf8');
const scope = { require: createRequire(sharedPath), __dirname, console, setTimeout, clearTimeout };
vm.createContext(scope);
vm.runInContext(shared.slice(0, shared.indexOf('\ntest(')), scope);
function fixture() {
  const { document, elements } = scope.createInteractiveRendererDom();
  return { renderer: scope.loadRendererHelpers(document, { crate: {} }), document, elements };
}
const routes = ['ai','ait','psd','psb','indd','idml','prproj','aep','aet','pptx','ppt','key','fig','sketch','xd','afdesign','afphoto','afpub','pxd','pdf','svg'];
for (const ext of routes) test(`opaque hierarchy and shared-dependency refusal: physical .${ext}`, () => {
  const { renderer } = fixture();
  const source = { name: `Working.${ext}`, visualIdentity: 'source-one', included: true };
  const sameName = { ...source, visualIdentity: 'source-two' };
  const asset = { name: 'image.png', included: true, sourceName: source.name, requiredSourceIdentities: ['source-one'] };
  assert.equal(renderer.getAssetReviewParent(asset, [source, sameName]), source);
  assert.equal(renderer.getAssetReviewParent({ ...asset, requiredSourceIdentities: [] }, [source]), null, 'names never establish ownership');
  assert.equal(renderer.getAssetReviewParent({ ...asset, requiredSourceIdentities: ['source-one','source-two'] }, [source,sameName]), null, 'shared assets remain standalone');
  assert.equal(renderer.getAssetReviewParent({ ...asset, included: false }, [source]), null);
  assert.equal(renderer.getAssetReviewParent(asset, [{ ...source, included: false }]), null);
  assert.equal(renderer.getAssetReviewParent(asset, [source,{...source}]), null, 'duplicate source identities cannot choose an owner');
});
test('virtual Figma identity is separate from physical .fig and keyless same-name sources', () => {
  const { renderer } = fixture();
  const virtual = { name: 'Design.fig', virtualFigmaSource: true, visualIdentity: 'figma-source:cloud-one' };
  const physical = { name: 'Design.fig', visualIdentity: 'physical-one', included: true };
  const asset = { included: true, figmaSourceIdentity: 'cloud-one' };
  assert.equal(renderer.getAssetReviewParent(asset, [virtual,physical]), virtual);
  assert.equal(renderer.getAssetReviewParent({ included: true, sourceName: 'Design.fig' }, [virtual,physical]), null);
});
test('approved review entry and exits keep one button, attention order, and no invented pair copy', () => {
  const html = fs.readFileSync(path.join(__dirname, '../renderer/index.html'), 'utf8');
  assert.equal((html.match(/id="btn-review-assets"/g)||[]).length,1);
  assert.ok(html.indexOf('id="pending-section"') < html.indexOf('id="working-assets-section"'));
  assert.ok(html.indexOf('data-asset-filter="missing"') < html.indexOf('data-asset-filter="existing"'));
  assert.ok(!html.includes('id="btn-review-assets-cancel"'));
  assert.ok(!html.includes('id="asset-review-summary"'));
  assert.ok(!html.includes('Treated as a separate file from'));
});

test('Needs Review filter retains pending rows explicitly not included in the package', () => {
  const { renderer, elements } = fixture();
  const pending = { name: 'Opened.pptx', ext: '.pptx', path: '/synthetic/Opened.pptx', included: false, excluded: false, captureState: 'observed', visualIdentity: 'pending-source', sourceIndex: 0 };
  const project = { id: 'pending-filter', files: [], pendingFiles: [pending], excludedAssetKeys: [] };
  renderer.testProject = project;
  renderer.testPending = pending;
  vm.runInContext("state.projects=[testProject];state.selectedProjectId=testProject.id;state.assetWorkspace={projectId:testProject.id,files:[],pendingFiles:[testPending]};", renderer);
  renderer.renderPendingFiles(project, [pending]);
  renderer.renderAssetWorkspace(project, {}, []);
  vm.runInContext("state.assetReviewFilter='missing'", renderer);
  renderer.applyAssetReviewFilter();
  assert.equal(elements['pending-section'].classList.contains('filtered-out'), false);
  assert.equal(elements['pending-file-list'].__assetReviewVirtualState.items.length, 1);
  vm.runInContext("state.assetReviewFilter='excluded'", renderer);
  renderer.applyAssetReviewFilter();
  assert.equal(elements['pending-section'].classList.contains('filtered-out'), true, 'not included is not an explicit exclusion');
});
