#!/usr/bin/env node
// Run with --write after changing crate-site CSS, JS, or images. The default
// --check mode catches stale URLs before a site snapshot is deployed.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const site = path.resolve(__dirname, '..', 'crate-site');
const write = process.argv[2] === '--write';
if (process.argv.length > 3 || (process.argv[2] && !['--write', '--check'].includes(process.argv[2]))) {
  throw new Error('Usage: node scripts/version-crate-site-assets.js [--check|--write]');
}

const localAsset = name => name === 'styles.css' || name === 'site.js' || name.startsWith('assets/');
const digest = name => crypto.createHash('sha256')
  .update(fs.readFileSync(path.join(site, name))).digest('hex').slice(0, 16);
let stale = false;
let refreshed = 0;

function versionUrl(url) {
  const [name, query] = url.split('?');
  if (!localAsset(name)) return url;
  if (!/^(?:styles\.css|site\.js|assets\/[a-z0-9/_-]+\.(?:png|svg|webp|jpe?g))$/.test(name)) {
    throw new Error(`Unsupported local asset path: ${name}`);
  }
  if (query && !/^v=[a-f0-9]{16}$/.test(query)) {
    throw new Error(`Unexpected query on local asset: ${url}`);
  }
  const expected = `${name}?v=${digest(name)}`;
  if (url !== expected) refreshed++;
  return expected;
}

function processFile(name, pattern, replace) {
  const file = path.join(site, name);
  const before = fs.readFileSync(file, 'utf8');
  const after = before.replace(pattern, replace);
  if (after === before) return;
  if (write) fs.writeFileSync(file, after);
  else stale = true;
}

// CSS is first because its own hash includes the versioned image URLs.
processFile('styles.css', /url\((['"]?)([^'"\)]+)\1\)/g,
  (whole, quote, url) => `url(${quote}${versionUrl(url)}${quote})`);
processFile('index.html', /(\b(?:src|href)=")([^"]+)(")/g,
  (whole, start, url, end) => `${start}${versionUrl(url)}${end}`);

if (stale) {
  console.error(`${refreshed} stale crate-site asset URL(s); run with --write`);
  process.exitCode = 1;
} else {
  console.log(write ? `Refreshed ${refreshed} crate-site asset URL(s)` : 'Crate site asset URLs match their file hashes');
}
