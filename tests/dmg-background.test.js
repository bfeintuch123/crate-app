'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { inflateSync } = require('node:zlib');
const test = require('node:test');

const PNG_SIGNATURE = Buffer.from('\x89PNG\r\n\x1a\n', 'binary');
const dmgSpec = require('../build/dmg-spec.json');

function paeth(a, b, c) {
  const estimate = a + b - c;
  const distances = [Math.abs(estimate - a), Math.abs(estimate - b), Math.abs(estimate - c)];
  return [a, b, c][distances.indexOf(Math.min(...distances))];
}

function decodeRgbPng(filePath) {
  const png = fs.readFileSync(filePath);
  assert.deepEqual(png.subarray(0, 8), PNG_SIGNATURE);
  let offset = 8;
  let header;
  const imageData = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString('ascii');
    const payload = png.subarray(offset + 8, offset + 8 + length);
    offset += length + 12;
    if (type === 'IHDR') header = payload;
    if (type === 'IDAT') imageData.push(payload);
  }
  assert.ok(header, 'PNG must contain an IHDR chunk');
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  assert.deepEqual([header[8], header[9], header[10], header[11], header[12]], [8, 2, 0, 0, 0]);

  const stride = width * 3;
  const raw = inflateSync(Buffer.concat(imageData));
  const rows = [];
  let rawOffset = 0;
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filterType = raw[rawOffset];
    rawOffset += 1;
    const row = Buffer.from(raw.subarray(rawOffset, rawOffset + stride));
    rawOffset += stride;
    for (let index = 0; index < stride; index += 1) {
      const left = index >= 3 ? row[index - 3] : 0;
      const above = previous[index];
      const upperLeft = index >= 3 ? previous[index - 3] : 0;
      if (filterType === 1) row[index] = (row[index] + left) & 0xff;
      else if (filterType === 2) row[index] = (row[index] + above) & 0xff;
      else if (filterType === 3) row[index] = (row[index] + Math.floor((left + above) / 2)) & 0xff;
      else if (filterType === 4) row[index] = (row[index] + paeth(left, above, upperLeft)) & 0xff;
      else assert.equal(filterType, 0, `unsupported PNG filter ${filterType}`);
    }
    rows.push(row);
    previous = row;
  }
  assert.equal(rawOffset, raw.length, 'PNG scanline payload must be exact');
  return { height, rows, width };
}

function pixel(row, x) {
  const offset = x * 3;
  return [row[offset], row[offset + 1], row[offset + 2]];
}

function darkRuns(row, threshold = 80) {
  const runs = [];
  let start = null;
  for (let x = 0; x < row.length / 3; x += 1) {
    const isDark = Math.max(...pixel(row, x)) < threshold;
    if (isDark && start === null) start = x;
    if (!isDark && start !== null) {
      runs.push([start, x - 1]);
      start = null;
    }
  }
  if (start !== null) runs.push([start, row.length / 3 - 1]);
  return runs;
}

test('DMG background keeps its dimensions and a clear two-stem right-facing graphic', () => {
  const { height, rows, width } = decodeRgbPng(path.join(__dirname, '..', 'build', 'dmg-background.png'));
  const backgroundColor = [245, 245, 247];
  const graphicPixels = [];

  assert.deepEqual([width, height], [540, 360]);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const current = pixel(rows[y], x);
      if (current.join(',') !== backgroundColor.join(',')) graphicPixels.push([x, y, current]);
    }
  }

  assert.deepEqual(
    graphicPixels.reduce((bounds, [x, y]) => ({
      bottom: Math.max(bounds.bottom, y),
      left: Math.min(bounds.left, x),
      right: Math.max(bounds.right, x),
      top: Math.min(bounds.top, y),
    }), { bottom: -1, left: width, right: -1, top: height }),
    { bottom: 207, left: 185, right: 431, top: 129 }
  );
  assert.equal(graphicPixels.every(([, , current]) => current[0] === current[1] && current[1] === current[2] || current.join(',') === backgroundColor.join(',')), true);

  // The three incoming strokes remain distinct near the shared right-facing tip.
  assert.ok(darkRuns(rows[180]).some(([start, end]) => start === 339 && end === 343)); // upper head stem
  assert.ok(darkRuns(rows[184]).some(([start, end]) => start === 315 && end === 335)); // center shaft
  assert.ok(darkRuns(rows[198]).some(([start, end]) => start === 336 && end === 340)); // lower head stem
  assert.ok(darkRuns(rows[188]).some(([start, end]) => start === 334 && end === 351)); // shared tip
  assert.ok(Math.max(...graphicPixels.filter(([, , current]) => Math.max(...current) < 80).map(([x]) => x)) >= 430);
  assert.ok(Math.min(...graphicPixels.filter(([, , current]) => Math.max(...current) < 80).map(([x]) => x)) <= 188);
});

test('DMG layout keeps the Crate and Applications positions beside the graphic', () => {
  assert.equal(dmgSpec.title, 'Crate');
  assert.equal(dmgSpec.background, 'dmg-background.png');
  assert.equal(dmgSpec['icon-size'], 120);
  assert.deepEqual(dmgSpec.window.size, { height: 380, width: 540 });
  assert.deepEqual(dmgSpec.contents.map(({ path: itemPath, type, x, y }) => ({ itemPath, type, x, y })), [
    { itemPath: '../dist/mac-arm64/Crate.app', type: 'file', x: 135, y: 210 },
    { itemPath: '/Applications', type: 'link', x: 405, y: 210 },
  ]);
});
