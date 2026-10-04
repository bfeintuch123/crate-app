'use strict';
const { consumerRequire, InstalledPolicy } = require('./policy-fixtures.cjs');

// Retain the sealed consumer tests' adapter interface, using ordinary installed
// Node resolution. The supplied fixture policy is checked, never injected.
module.exports = function installedLoader(Policy) {
  if (Object.getPrototypeOf(Policy.prototype) !== InstalledPolicy.prototype) {
    throw new Error('Consumer fixture requested a policy outside the installed module');
  }
  return { load: name => consumerRequire(name) };
};
