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

function hasDarkPixelInBox(rows, left, top, right, bottom) {
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      if (Math.max(...pixel(rows[y], x)) < 80) return true;
    }
  }
  return false;
}

function hasDarkPixelFarEnoughFromRect(rows, left, top, right, bottom, rectangle, gap) {
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      if (Math.max(...pixel(rows[y], x)) < 80) {
        const outsideHorizontally = x >= rectangle.right + gap || x <= rectangle.left - gap;
        const outsideVertically = y >= rectangle.bottom + gap || y <= rectangle.top - gap;
        if (!outsideHorizontally && !outsideVertically) return false;
      }
    }
  }
  return true;
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
    { bottom: 203, left: 224, right: 484, top: 131 }
  );
  assert.equal(graphicPixels.every(([, , current]) => current[0] === current[1] && current[1] === current[2] || current.join(',') === backgroundColor.join(',')), true);

  // The three incoming strokes remain distinct near the shared right-facing tip.
  assert.ok(darkRuns(rows[174]).some(([start, end]) => start === 294 && end === 298)); // upper head stem
  assert.ok(darkRuns(rows[184]).some(([start, end]) => start === 239 && end === 288)); // center shaft
  assert.ok(darkRuns(rows[202]).some(([start, end]) => start === 294 && end === 297)); // lower head stem
  assert.ok(darkRuns(rows[188]).some(([start, end]) => start === 287 && end === 313)); // shared tip

  const applications = dmgSpec.contents.find(({ path: itemPath }) => itemPath === '/Applications');
  const iconHalfSize = dmgSpec['icon-size'] / 2;
  const crate = dmgSpec.contents.find(({ path: itemPath }) => itemPath === '../dist/mac-arm64/Crate.app');
  const crateRectangle = {
    bottom: crate.y + iconHalfSize,
    left: crate.x - iconHalfSize,
    right: crate.x + iconHalfSize,
    top: crate.y - iconHalfSize,
  };
  const applicationsRectangle = {
    bottom: applications.y + iconHalfSize,
    left: applications.x - iconHalfSize,
    right: applications.x + iconHalfSize,
    top: applications.y - iconHalfSize,
  };
  const darkPixels = graphicPixels.filter(([, , current]) => Math.max(...current) < 80);
  const arrowPixels = darkPixels.filter(([x]) => x < 400);
  assert.equal(Math.min(...arrowPixels.map(([x]) => x)), 225);
  assert.equal(Math.max(...arrowPixels.map(([x]) => x)), 313);
  assert.equal(arrowPixels.every(([x]) => x >= crateRectangle.right + 25 && x <= applicationsRectangle.left - 30), true);
  assert.equal(hasDarkPixelInBox(rows, crateRectangle.left, crateRectangle.top, crateRectangle.right, crateRectangle.bottom), false);
  assert.equal(hasDarkPixelInBox(rows, applicationsRectangle.left, applicationsRectangle.top, applicationsRectangle.right, applicationsRectangle.bottom), false);
  const applicationsTopRight = {
    x: applicationsRectangle.right,
    y: applicationsRectangle.top,
  };
  assert.deepEqual(applicationsTopRight, { x: 465, y: 150 });
  assert.equal(hasDarkPixelInBox(rows, applicationsTopRight.x - 12, applicationsTopRight.y - 20, applicationsTopRight.x - 6, applicationsTopRight.y - 6), true);
  assert.equal(hasDarkPixelInBox(rows, applicationsTopRight.x + 1, applicationsTopRight.y - 20, applicationsTopRight.x + 13, applicationsTopRight.y - 6), true);
  assert.equal(hasDarkPixelInBox(rows, applicationsTopRight.x + 4, applicationsTopRight.y, applicationsTopRight.x + 20, applicationsTopRight.y + 10), true);
  assert.equal(hasDarkPixelFarEnoughFromRect(rows, applicationsRectangle.left, applicationsRectangle.top - 20, applicationsRectangle.right + 20, applicationsRectangle.bottom, applicationsRectangle, 5), true);
  assert.equal(hasDarkPixelInBox(rows, 375, 130, 435, 175), false);
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
