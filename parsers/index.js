/**
 * Crate v2.0 — Parser Registry & Orchestrator
 *
 * Main entry point for the v2.0 parser system.
 *
 * Exports:
 *   - getParser(filePath): Returns the correct parser for a file extension
 *   - packageMasterFile(filePath, outputDir, options): Core packaging orchestrator
 *   - SUPPORTED_EXTENSIONS: Array of all handled file extensions
 *
 * Usage:
 *   const { getParser, packageMasterFile, SUPPORTED_EXTENSIONS } = require('./parsers');
 *
 *   // Get parser for a specific file
 *   const parser = getParser('/path/to/file.ai');
 *   const assets = await parser.extractAssets('/path/to/file.ai');
 *
 *   // Or use the full orchestrator
 *   const result = await packageMasterFile('/path/to/file.ai', '/output/folder');
 */

'use strict';

const fs = require('fs');
const path = require('path');
const {
  assertSafeCopySource,
  copyFileIntoPackage,
  ensureSafePackageDirectory,
} = require('./package-safety');

// Import all parsers
const { AIParser } = require('./ai');
const { PSDParser } = require('./psd');
const { InDesignParser } = require('./indesign');
const { PowerPointParser } = require('./powerpoint');
const { PremiereParser } = require('./premiere');
const { AfterEffectsParser } = require('./aftereffects');
const { FigmaParser } = require('./figma');

// Parser registry: maps file extensions to parser classes
const PARSER_REGISTRY = {
  // Adobe Illustrator
  '.ai': AIParser,
  '.ait': AIParser,

  // Adobe Photoshop
  '.psd': PSDParser,
  '.psb': PSDParser,

  // Adobe InDesign
  '.indd': InDesignParser,
  '.idml': InDesignParser,

  // Adobe Premiere Pro
  '.prproj': PremiereParser,

  // Adobe After Effects
  '.aep': AfterEffectsParser,
  '.aet': AfterEffectsParser,

  // PowerPoint / Keynote
  '.pptx': PowerPointParser,
  '.ppt': PowerPointParser,
  '.key': PowerPointParser,

  // Figma (URL-based, handled specially)
  '.fig': FigmaParser
};

// All supported file extensions
const SUPPORTED_EXTENSIONS = Object.keys(PARSER_REGISTRY);

function isArchiveEmbeddedAsset(asset) {
  if (!asset || typeof asset !== 'object') return false;
  if (typeof asset.zipPath === 'string' && asset.zipPath.length > 0) return true;
  return asset.source === 'pptx-embedded' || asset.source === 'keynote-embedded';
}

/**
 * Get the appropriate parser for a file based on its extension.
 *
 * @param {string} filePath - Path to the file (or just the extension with dot)
 * @returns {BaseParser|null} - Parser instance, or null if no parser exists
 */
function getParser(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  const ParserClass = PARSER_REGISTRY[ext];
  if (!ParserClass) return null;

  return new ParserClass();
}

/**
 * Check if a file extension is supported.
 *
 * @param {string} extOrPath - File extension (with dot) or file path
 * @returns {boolean}
 */
function isSupported(extOrPath) {
  const ext = extOrPath.startsWith('.') ? extOrPath.toLowerCase() : path.extname(extOrPath).toLowerCase();
  return PARSER_REGISTRY.hasOwnProperty(ext);
}

/**
 * Get parser info (display name, status) for a file extension.
 *
 * @param {string} extOrPath - File extension or file path
 * @returns {{displayName: string, extensions: string[], implemented: boolean}|null}
 */
function getParserInfo(extOrPath) {
  const ext = extOrPath.startsWith('.') ? extOrPath.toLowerCase() : path.extname(extOrPath).toLowerCase();
  const ParserClass = PARSER_REGISTRY[ext];

  if (!ParserClass) return null;

  // Check if the parser is a stub by trying to create and call it
  let implemented = true;
  try {
    const instance = new ParserClass();
    // If extractAssets throws an Error that says "not yet implemented" or "requires:",
    // it's a stub
    // We can't actually call it here, so check for known stub classes
    if (ParserClass === PSDParser || ParserClass === AfterEffectsParser || ParserClass === FigmaParser) {
      implemented = false;
    }
  } catch (e) {
    implemented = false;
  }

  return {
    displayName: ParserClass.displayName,
    extensions: ParserClass.extensions,
    implemented
  };
}

/**
 * Core v2.0 orchestrator: package a master design file with all its linked assets.
 *
 * @param {string} filePath - Absolute path to the master design file
 * @param {string} outputDir - Directory to copy files into
 * @param {Object} options - Configuration options
 * @param {boolean} [options.flat=false] - If true, copy all files to root of outputDir.
 *                                         If false, preserve relative folder structure.
 * @param {boolean} [options.includeEmbedded=true] - For PowerPoint/Keynote, extract embedded media
 * @param {boolean} [options.skipMissing=true] - Continue even if linked assets don't exist
 * @param {function} [options.onProgress] - Callback: ({stage, current, total, file}) => void
 *
 * @returns {Promise<{
 *   masterFile: string,
 *   assetsFound: number,
 *   assetsCopied: number,
 *   assetsMissing: Array<{path: string, source: string}>,
 *   outputDir: string,
 *   files: Array<{original: string, copied: string, source: string}>
 * }>}
 */
async function packageMasterFile(filePath, outputDir, options = {}) {
  const {
    flat = false,
    includeEmbedded = true,
    skipMissing = true,
    onProgress = null
  } = options;

  const result = {
    masterFile: filePath,
    assetsFound: 0,
    assetsCopied: 0,
    assetsMissing: [],
    outputDir: outputDir,
    files: []
  };

  // Validate input file exists
  if (!fs.existsSync(filePath)) {
    throw new Error(`Master file not found: ${filePath}`);
  }

  // Get the appropriate parser
  const parser = getParser(filePath);
  if (!parser) {
    throw new Error(`No parser available for file type: ${path.extname(filePath)}`);
  }
  assertSafeCopySource(filePath);

  const outputRoot = ensureSafePackageDirectory(outputDir);

  // Report progress: starting
  if (onProgress) {
    onProgress({ stage: 'extracting', current: 0, total: 0, file: filePath });
  }

  // Extract assets
  let assets;
  try {
    assets = await parser.extractAssets(filePath);
  } catch (e) {
    // Parser threw an error (likely a stub)
    throw new Error(`Parser error for ${path.basename(filePath)}: ${e.message}`);
  }

  result.assetsFound = assets.length;

  // Copy master file to output directory
  const masterFileName = path.basename(filePath);
  const masterDestPath = copyFileIntoPackage(filePath, outputRoot, masterFileName, {
    fallbackName: masterFileName || 'master-file'
  });
  result.files.push({
    original: filePath,
    copied: masterDestPath,
    source: 'master'
  });

  // Report progress: copying assets
  if (onProgress) {
    onProgress({ stage: 'copying', current: 0, total: assets.length, file: masterFileName });
  }

  // Reference directory for relative paths (parent of master file)
  const masterDir = path.dirname(filePath);

  // Copy each linked asset
  for (let i = 0; i < assets.length; i++) {
    const asset = assets[i];

    if (onProgress) {
      onProgress({ stage: 'copying', current: i + 1, total: assets.length, file: path.basename(asset.path) });
    }

    if (isArchiveEmbeddedAsset(asset)) {
      continue;
    }

    // Handle missing assets
    if (!asset.exists) {
      result.assetsMissing.push({ path: asset.path, source: asset.source });
      if (!skipMissing) {
        throw new Error(`Linked asset not found: ${asset.path}`);
      }
      console.warn(`[packageMasterFile] Missing asset: ${asset.path}`);
      continue;
    }

    // Determine destination path
    let destName;
    let preserveRelativePath = false;
    if (flat) {
      // Flat mode: all files in root of outputDir
      destName = path.basename(asset.path);
    } else {
      // Preserve relative structure
      // Calculate path relative to master file's directory
      const relativePath = path.relative(masterDir, asset.path);

      // If the asset is outside the master's directory tree (starts with ..),
      // fall back to flat mode for that file
      if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        destName = path.basename(asset.path);
      } else {
        destName = relativePath;
        preserveRelativePath = true;
      }
    }

    // Copy the file
    try {
      const destPath = copyFileIntoPackage(asset.path, outputRoot, destName, {
        preserveRelativePath,
        fallbackName: path.basename(asset.path) || 'asset'
      });
      result.assetsCopied++;
      result.files.push({
        original: asset.path,
        copied: destPath,
        source: asset.source
      });
    } catch (e) {
      console.error(`[packageMasterFile] Failed to copy ${asset.path}: ${e.message}`);
      result.assetsMissing.push({ path: asset.path, source: asset.source });
    }
  }

  // For PowerPoint/Keynote, also extract embedded media if requested
  if (includeEmbedded && parser.extractToDirectory) {
    try {
      const embeddedAssets = await parser.extractAssets(filePath);
      const extracted = await parser.extractToDirectory(filePath, outputRoot, embeddedAssets, {
        onExtractionError: (failure) => {
          result.assetsMissing.push({
            path: failure && failure.message ? failure.message : `Could not extract embedded media from ${path.basename(filePath)}.`,
            source: failure && failure.asset && failure.asset.source ? failure.asset.source : 'embedded'
          });
        }
      });

      for (const item of extracted) {
        result.assetsCopied++;
        result.files.push({
          original: `${filePath}!${item.originalZipPath}`,
          copied: item.extractedPath,
          source: 'embedded'
        });
      }
    } catch (e) {
      console.warn(`[packageMasterFile] Could not extract embedded media from ${path.basename(filePath)}.`);
    }
  }

  // Report progress: done
  if (onProgress) {
    onProgress({ stage: 'complete', current: result.assetsCopied, total: result.assetsFound, file: null });
  }

  return result;
}

module.exports = {
  getParser,
  isSupported,
  getParserInfo,
  packageMasterFile,
  SUPPORTED_EXTENSIONS,

  // Also export individual parser classes for direct use
  AIParser,
  PSDParser,
  InDesignParser,
  PowerPointParser,
  PremiereParser,
  AfterEffectsParser,
  FigmaParser
};
