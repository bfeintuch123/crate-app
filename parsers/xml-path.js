'use strict';
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeXMLPath(value) {
  return value.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, entity => {
    const name = entity.slice(1, -1);
    if (Object.prototype.hasOwnProperty.call(ENTITIES, name)) return ENTITIES[name];
    if (name[0] !== '#') return entity;
    const point = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return Number.isInteger(point) && point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
      ? String.fromCodePoint(point) : entity;
  });
}

// Reads a local file URI as an absolute path. Pure string handling: no
// filesystem access. The input must already be XML-entity-decoded.
//
// Accepts file:/abs, file:///abs and file://localhost/abs (scheme and
// localhost case-insensitive). Any other host, a relative form, extra leading
// slashes or a bare root returns null. The path is percent-decoded; text that
// does not decode is kept as written, as both link readers did before.
function fileUriToPath(value) {
  if (typeof value !== 'string' || value.slice(0, 5).toLowerCase() !== 'file:') return null;
  let rest = value.slice(5);
  if (rest.startsWith('//')) {
    const pathStart = rest.indexOf('/', 2);
    if (pathStart === -1) return null;
    const host = rest.slice(2, pathStart);
    if (host !== '' && host.toLowerCase() !== 'localhost') return null;
    rest = rest.slice(pathStart);
  }
  // Decoding never turns a relative form into an absolute one (file:%2FUsers).
  if (rest[0] !== '/') return null;
  let decoded = rest;
  try { decoded = decodeURIComponent(rest); } catch (_) {}
  if (decoded.length < 2 || decoded[0] !== '/' || decoded[1] === '/') return null;
  return decoded;
}

module.exports = { decodeXMLPath, fileUriToPath };
