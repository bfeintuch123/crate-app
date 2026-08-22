#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const contract = require('./visual_evidence_contract');

const REQUEST_KEYS = [
  'repository', 'repositoryId', 'prNumber', 'headSha', 'media', 'scenario',
  'expected', 'observed', 'captureEnvironment', 'mediaInspection', 'privacyReview',
];

function fail(code) { throw new Error(code); }
function exactKeys(value, keys, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) fail(code);
}

function parseArgs(argv) {
  if (argv.length !== 4 || argv[0] !== '--input-dir' || argv[2] !== '--output') fail('invalid_arguments');
  return { input: path.resolve(argv[1]), output: path.resolve(argv[3]) };
}

function readJSONFileNoFollow(file, code) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const metadata = fs.fstatSync(descriptor);
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > 1024 * 1024) fail(code);
    const body = Buffer.alloc(metadata.size);
    if (fs.readSync(descriptor, body, 0, body.length, 0) !== body.length) fail(code);
    return JSON.parse(body.toString('utf8'));
  } catch (error) {
    if (error && error.message === code) throw error;
    fail(code);
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

function stageExactMedia(source, expected, stageParent = path.dirname(source)) {
  const parent = path.resolve(stageParent);
  if (fs.realpathSync(parent) !== parent) fail('unsafe_output_directory');
  const directory = fs.mkdtempSync(path.join(parent, '.crate-crabbox-media-'));
  fs.chmodSync(directory, 0o700);
  const staged = path.join(directory, expected.name);
  let sourceDescriptor;
  let destinationDescriptor;
  let failure;
  try {
    sourceDescriptor = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const metadata = fs.fstatSync(sourceDescriptor);
    if (!metadata.isFile() || metadata.size !== expected.bytes) fail('collection_media_mismatch');
    destinationDescriptor = fs.openSync(staged, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (offset < metadata.size) {
      const read = fs.readSync(sourceDescriptor, buffer, 0, Math.min(buffer.length, metadata.size - offset), offset);
      if (read === 0) fail('collection_media_mismatch');
      let written = 0;
      while (written < read) written += fs.writeSync(destinationDescriptor, buffer, written, read - written, offset + written);
      offset += read;
    }
  } catch (error) { failure = error; }
  finally {
    if (sourceDescriptor !== undefined) fs.closeSync(sourceDescriptor);
    if (destinationDescriptor !== undefined) fs.closeSync(destinationDescriptor);
  }
  try {
    if (failure) throw failure;
    const inspected = contract.inspectMedia(staged, expected.mime);
    if (inspected.name !== expected.name || inspected.bytes !== expected.bytes || inspected.sha256 !== expected.sha256) fail('collection_media_mismatch');
    return { directory, file: staged };
  } catch (error) {
    try { fs.unlinkSync(staged); } catch {}
    try { fs.rmdirSync(directory); } catch {}
    if (error && error.message === 'collection_media_mismatch') throw error;
    fail('collection_media_mismatch');
  }
}

function build(inputDirectory, outputDirectory) {
  let inputMetadata;
  try { inputMetadata = fs.lstatSync(inputDirectory); } catch { fail('unsafe_input_directory'); }
  if (!inputMetadata.isDirectory() || inputMetadata.isSymbolicLink() || fs.realpathSync(inputDirectory) !== inputDirectory) fail('unsafe_input_directory');
  const outputParent = path.dirname(outputDirectory);
  let outputParentMetadata;
  try { outputParentMetadata = fs.lstatSync(outputParent); } catch { fail('unsafe_output_directory'); }
  if (!outputParentMetadata.isDirectory() || outputParentMetadata.isSymbolicLink() || fs.realpathSync(outputParent) !== outputParent) fail('unsafe_output_directory');
  if (fs.existsSync(outputDirectory)) fail('unsafe_output_directory');

  const request = readJSONFileNoFollow(path.join(inputDirectory, 'request.json'), 'invalid_collection_request');
  exactKeys(request, REQUEST_KEYS, 'invalid_collection_request');
  exactKeys(request.media, ['name', 'mime', 'bytes', 'sha256'], 'invalid_collection_request');
  try { contract.safeName(request.media.name); } catch { fail('invalid_collection_request'); }
  const source = path.join(inputDirectory, request.media.name);
  const media = contract.inspectMedia(source, request.media.mime);
  if (media.name !== request.media.name || media.bytes !== request.media.bytes || media.sha256 !== request.media.sha256) fail('collection_media_mismatch');
  const expectedEntries = ['request.json', request.media.name].sort();
  if (JSON.stringify(fs.readdirSync(inputDirectory).sort()) !== JSON.stringify(expectedEntries)) fail('unexpected_collection_input');

  const manifest = contract.buildManifest({ ...request, media, uploadPath: 'crabbox-artifact', url: '', crabbox: null });
  const staged = stageExactMedia(source, media, outputParent);
  try {
    fs.mkdirSync(outputDirectory, { mode: 0o700 });
    const mediaDirectory = path.join(outputDirectory, 'media');
    fs.mkdirSync(mediaDirectory, { mode: 0o700 });
    fs.renameSync(staged.file, path.join(mediaDirectory, media.name));
    fs.writeFileSync(path.join(outputDirectory, 'visual-evidence.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    return manifest;
  } finally {
    try { fs.unlinkSync(staged.file); } catch {}
    try { fs.rmdirSync(staged.directory); } catch {}
  }
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const manifest = build(args.input, args.output);
  process.stdout.write(`${JSON.stringify({ collected: true, name: manifest.media.name, bytes: manifest.media.bytes, sha256: manifest.media.sha256 })}\n`);
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(`Crabbox visual collection failed: ${error.message}`); process.exitCode = 1; }
}

module.exports = { build, parseArgs, readJSONFileNoFollow, stageExactMedia };
