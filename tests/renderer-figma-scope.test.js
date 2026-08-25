'use strict';

const fs = require('fs');
const path = require('path');

const originalReadFileSync = fs.readFileSync;
const rendererDir = path.join(__dirname, '..', 'renderer');
const stylesheetEntryPath = path.resolve(rendererDir, 'styles.css');
const stylesheetBasePath = path.join(rendererDir, 'styles-base.css');
const stylesheetStabilityPath = path.join(rendererDir, 'ui-stability.css');

function readUtf8(filePath) {
  return originalReadFileSync.call(fs, filePath, 'utf8');
}

function readEffectiveRendererStyles() {
  const layers = [readUtf8(stylesheetBasePath)];
  if (fs.existsSync(stylesheetStabilityPath)) {
    layers.push(readUtf8(stylesheetStabilityPath));
  }
  return `${layers.join('\n\n')}\n`;
}

fs.readFileSync = function patchedReadFileSync(filePath, options) {
  const resolvedPath = typeof filePath === 'string' || Buffer.isBuffer(filePath)
    ? path.resolve(String(filePath))
    : null;

  if (resolvedPath !== stylesheetEntryPath) {
    return originalReadFileSync.apply(this, arguments);
  }

  const effectiveStyles = readEffectiveRendererStyles();
  const encoding = typeof options === 'string' ? options : options && options.encoding;
  if (!encoding) return Buffer.from(effectiveStyles, 'utf8');
  if (encoding === 'utf8' || encoding === 'utf-8') return effectiveStyles;
  return Buffer.from(effectiveStyles, 'utf8').toString(encoding);
};

try {
  require('./renderer-figma-scope-base.js');
} finally {
  fs.readFileSync = originalReadFileSync;
}
