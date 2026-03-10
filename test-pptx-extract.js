#!/usr/bin/env node
// Self-contained test for extractEmbeddedMedia on .pptx files

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const { exec, execFile } = require('child_process');
const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

// --- Copied from main.js ---

const EMBEDDED_MEDIA_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.tif', '.tiff', '.heic',
  '.svg', '.pdf', '.eps', '.mp4', '.mov',
]);

function parseZipEntryDate(dateStr, timeStr) {
  const parts = dateStr.split('-');
  if (parts.length !== 3) return null;
  const [mm, dd, yyyy] = parts;
  const year = parseInt(yyyy, 10);
  const month = parseInt(mm, 10) - 1;
  const day = parseInt(dd, 10);
  if (isNaN(year) || isNaN(month) || isNaN(day)) return null;

  let hours = 0, minutes = 0;
  if (timeStr) {
    const tp = timeStr.split(':');
    hours = parseInt(tp[0], 10) || 0;
    minutes = parseInt(tp[1], 10) || 0;
  }

  return new Date(year, month, day, hours, minutes);
}

async function extractEmbeddedMedia(presentationPath, destFolder, projectFiles) {
  const ext = path.extname(presentationPath).toLowerCase();
  const base = path.basename(presentationPath, ext);
  const extracted = [];

  const alreadyCapturedBases = new Set();
  if (projectFiles) {
    for (const f of projectFiles) {
      const n = path.basename(f.name, path.extname(f.name)).toLowerCase().replace(/\s+/g, ' ').trim();
      alreadyCapturedBases.add(n);
    }
  }

  const contentFingerprints = new Set();
  const capturedSizes = new Set();
  if ((ext === '.pptx' || ext === '.ppt') && projectFiles) {
    for (const f of projectFiles) {
      try {
        const buf = fs.readFileSync(f.path);
        const size = buf.length;
        capturedSizes.add(size);
        const hash = crypto.createHash('md5').update(buf).digest('hex');
        contentFingerprints.add(`${size}:${hash}`);
      } catch (e) {
        // file may no longer exist on disk — skip
      }
    }
  }

  try {
    const { stdout: listing } = await execFileAsync("/usr/bin/unzip", ["-l", presentationPath], {
      timeout: 10000, encoding: 'utf8'
    });

    console.log('[DEBUG] unzip -l output:');
    console.log(listing);

    for (const line of listing.split('\n')) {
      const m = line.match(/^\s+(\d+)\s+(\d{2}-\d{2}-\d{4})\s+(\d{2}:\d{2})\s+(.+)$/);
      if (!m) {
        console.log(`[DEBUG] no match for line: "${line}"`);
        continue;
      }

      const fileSize = parseInt(m[1], 10);
      const zipPath = m[4].trim();

      console.log(`[DEBUG] matched entry: zipPath="${zipPath}", size=${fileSize}`);

      if (zipPath.endsWith('/')) { console.log('[DEBUG] skip: directory'); continue; }
      if (zipPath.includes('__MACOSX')) { console.log('[DEBUG] skip: __MACOSX'); continue; }
      if (path.basename(zipPath).startsWith('.')) { console.log('[DEBUG] skip: dot file'); continue; }

      const fileExt = path.extname(zipPath).toLowerCase();
      if (!EMBEDDED_MEDIA_EXTENSIONS.has(fileExt)) { console.log(`[DEBUG] skip: ext "${fileExt}" not in EMBEDDED_MEDIA_EXTENSIONS`); continue; }

      const inMediaFolder =
        (ext === '.pptx' || ext === '.ppt') ? zipPath.startsWith('ppt/media/') :
        (ext === '.key')                     ? zipPath.startsWith('Data/')       :
        false;
      if (!inMediaFolder) { console.log(`[DEBUG] skip: not in media folder (zipPath="${zipPath}")`); continue; }

      if (fileSize < 500) {
        console.log(`[DEBUG] skip: tiny file (${fileSize} bytes)`);
        continue;
      }

      if (ext === '.key') {
        // Keynote-specific filters... (skipped for this test)
      }

      try {
        const { stdout: data } = await execFileAsync('/usr/bin/unzip', ['-p', presentationPath, zipPath], {
          timeout: 10000, maxBuffer: 50 * 1024 * 1024,
          encoding: 'buffer'
        });

        if ((ext === '.pptx' || ext === '.ppt') && contentFingerprints.size > 0) {
          const extractedSize = data.length;
          if (capturedSizes.has(extractedSize)) {
            const extractedHash = crypto.createHash('md5').update(data).digest('hex');
            if (contentFingerprints.has(`${extractedSize}:${extractedHash}`)) {
              console.log(`[DEBUG] skip: content fingerprint match`);
              continue;
            }
          }
        }

        let outputName = path.basename(zipPath);
        if (ext === '.key') {
          outputName = outputName.replace(/-\d{3,6}(\.[a-z]+)$/i, '$1');
        }
        outputName = `${base} — ${outputName}`;

        let destPath = path.join(destFolder, outputName);
        let counter = 1;
        while (fs.existsSync(destPath)) {
          const e = path.extname(outputName);
          const b = path.basename(outputName, e);
          destPath = path.join(destFolder, `${b}_${counter}${e}`);
          counter++;
        }

        fs.writeFileSync(destPath, data);
        extracted.push(destPath);
        console.log(`[EXTRACTED] ${outputName} (${data.length} bytes)`);
      } catch (e) {
        console.error(`[ERROR] failed to read ${zipPath}:`, e.message);
      }
    }
  } catch (e) {
    console.error('[ERROR] extractEmbeddedMedia error:', e.message);
  }

  return extracted;
}

// --- Create test .pptx ---

async function main() {
  const pptxPath = '/tmp/test-crate.pptx';
  const outputDir = '/tmp/crate-test-output';

  // Clean up
  if (fs.existsSync(outputDir)) fs.rmSync(outputDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });

  // Create a valid PNG file (>500 bytes)
  // PNG header: 89 50 4E 47 0D 0A 1A 0A
  const pngHeader = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const pngPadding = Buffer.alloc(600 - pngHeader.length, 0x42);
  const pngData = Buffer.concat([pngHeader, pngPadding]);

  // Create directory structure and zip it
  const tmpDir = '/tmp/test-pptx-build';
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'ppt', 'media'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'ppt', 'media', 'image1.png'), pngData);
  // Add a content type file (required for valid pptx structure)
  fs.writeFileSync(path.join(tmpDir, '[Content_Types].xml'), '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>');

  // Remove old pptx if exists
  if (fs.existsSync(pptxPath)) fs.unlinkSync(pptxPath);

  // Create zip
  await execAsync(`cd "${tmpDir}" && /usr/bin/zip -r "${pptxPath}" .`);

  console.log('=== Created test .pptx ===');
  const { stdout: listing } = await execAsync(`/usr/bin/unzip -l "${pptxPath}"`);
  console.log(listing);

  // Run extraction
  console.log('=== Running extractEmbeddedMedia ===');
  const results = await extractEmbeddedMedia(pptxPath, outputDir, []);

  console.log('\n=== Results ===');
  console.log(`Extracted ${results.length} files:`);
  for (const r of results) {
    console.log(`  ${r}`);
  }

  // Verify output directory
  const outputFiles = fs.readdirSync(outputDir);
  console.log(`\nOutput directory contents: ${outputFiles.length} files`);
  for (const f of outputFiles) {
    const stat = fs.statSync(path.join(outputDir, f));
    console.log(`  ${f} (${stat.size} bytes)`);
  }

  // Clean up
  fs.rmSync(tmpDir, { recursive: true });

  if (results.length === 0) {
    console.log('\n*** FAIL: No files extracted! ***');
    process.exit(1);
  } else {
    console.log('\n*** PASS: Files extracted successfully ***');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
