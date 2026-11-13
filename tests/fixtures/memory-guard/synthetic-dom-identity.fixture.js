'use strict';
// Run only by tests/bounded-assert.test.js, under the memory guard. Fails an
// identity assertion between two nodes of the synthetic renderer DOM: the
// failure that used to allocate without limit while Node rendered its diff.
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const assert = require('../../bounded-assert');

const sharedPath = path.join(__dirname, '..', '..', 'renderer-figma-scope.test.js');
const shared = fs.readFileSync(sharedPath, 'utf8');
const scope = { require: createRequire(sharedPath), __dirname: path.dirname(sharedPath), console, setTimeout, clearTimeout };
vm.createContext(scope);
vm.runInContext(shared.slice(0, shared.indexOf('\ntest(')), scope);

test('focus is on Search', () => {
  const { document, elements } = scope.createInteractiveRendererDom();
  elements['btn-package'].focus();
  assert.equal(document.activeElement, elements['asset-review-search'], 'focus stays on Search');
});
