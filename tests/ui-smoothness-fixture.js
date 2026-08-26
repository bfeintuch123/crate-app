'use strict';

const SMOOTHNESS_ASSET_COUNTS = Object.freeze([0, 7, 30, 100, 263, 500]);
const SYNTHETIC_FIGMA_SOURCE = 'Synthetic Smoothness Board';

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function normalizeCount(value, fallback = 0, maximum = 500) {
  const count = Number(value);
  if (!Number.isFinite(count)) return fallback;
  return Math.max(0, Math.min(maximum, Math.floor(count)));
}

function createPresentation({
  name,
  extension,
  appFamily,
  sourceName = null,
  assetOrigin,
  projectRole,
  protectedSource = false,
  linked = false,
  embedded = false,
  excluded = false,
  index,
}) {
  const stableId = String(index).padStart(4, '0');
  return {
    name,
    ext: extension,
    appFamily,
    sourceName,
    assetOrigin,
    projectRole,
    protectedSource,
    linked,
    embedded,
    excluded,
    visualIdentity: `synthetic-smoothness-visual-${stableId}`,
    visualRevision: `synthetic-smoothness-revision-${stableId}`,
  };
}

function createPhysicalSourceFiles() {
  return [
    createPresentation({
      name: 'Synthetic_Smoothness_Illustrator.ai',
      extension: '.ai',
      appFamily: 'illustrator',
      assetOrigin: 'existing',
      projectRole: 'source',
      protectedSource: true,
      index: 1,
    }),
    createPresentation({
      name: 'Synthetic_Smoothness_Photoshop.psd',
      extension: '.psd',
      appFamily: 'photoshop',
      assetOrigin: 'existing',
      projectRole: 'source',
      protectedSource: true,
      index: 2,
    }),
    createPresentation({
      name: 'Synthetic_Smoothness_InDesign.indd',
      extension: '.indd',
      appFamily: 'indesign',
      assetOrigin: 'existing',
      projectRole: 'source',
      protectedSource: true,
      index: 3,
    }),
  ];
}

function syntheticAssetName(index) {
  const padded = String(index).padStart(4, '0');
  if (index % 41 === 0) {
    return `Synthetic Smoothness Asset ${padded} — Deliberately Long Filename For Stable Truncation.png`;
  }
  if (index % 29 === 0) {
    return `Synthetic-Smoothness-Asset_${padded} (alternate state).jpg`;
  }
  return `Synthetic_Smoothness_Asset_${padded}.png`;
}

function createAssets(assetCount, excludedCount = 0) {
  const assets = [];
  const existingCount = Math.min(7, assetCount);
  const safeExcludedCount = Math.min(assetCount, excludedCount);
  for (let index = 1; index <= assetCount; index += 1) {
    const jpeg = index % 29 === 0;
    assets.push(createPresentation({
      name: syntheticAssetName(index),
      extension: jpeg ? '.jpg' : '.png',
      appFamily: 'figma',
      sourceName: SYNTHETIC_FIGMA_SOURCE,
      assetOrigin: index <= existingCount ? 'existing' : 'added',
      projectRole: 'asset',
      linked: index % 5 === 0,
      embedded: index % 37 === 0,
      excluded: index > assetCount - safeExcludedCount,
      index: index + 100,
    }));
  }
  return assets;
}

function createPendingFiles(pendingCount) {
  const pending = [];
  for (let index = 1; index <= pendingCount; index += 1) {
    const stableId = String(index).padStart(4, '0');
    pending.push({
      name: `Synthetic_Pending_Asset_${stableId}.png`,
      ext: '.png',
      appFamily: 'figma',
      sourceName: SYNTHETIC_FIGMA_SOURCE,
      projectRole: 'asset',
      assetOrigin: 'added',
      protectedSource: false,
      excluded: false,
      captureState: index % 2 === 0 ? 'needs-save' : 'pending',
      captureEvidence: {
        appFamily: 'figma',
        sourceName: SYNTHETIC_FIGMA_SOURCE,
      },
      visualIdentity: `synthetic-smoothness-pending-${stableId}`,
      visualRevision: `synthetic-smoothness-pending-revision-${stableId}`,
    });
  }
  return pending;
}

function createUiSmoothnessFixture(options = {}) {
  const assetCount = normalizeCount(options.assetCount, 30);
  const pendingCount = normalizeCount(options.pendingCount, 0, 20);
  const excludedCount = normalizeCount(options.excludedCount, 0, assetCount);
  const physicalSourceFiles = createPhysicalSourceFiles();
  const assets = createAssets(assetCount, excludedCount);
  const pendingFiles = createPendingFiles(pendingCount);
  const files = [...physicalSourceFiles, ...assets];
  const hasFigmaAssets = assets.length > 0 || pendingFiles.length > 0;
  const projectId = `synthetic-smoothness-project-${assetCount}`;
  const excludedAssetKeys = assets
    .filter(file => file.excluded)
    .map(file => file.visualIdentity);
  const project = {
    id: projectId,
    name: `Synthetic Smoothness ${assetCount} Assets`,
    type: 'automatic',
    status: options.status === 'paused' ? 'paused' : 'watching',
    createdAt: Date.UTC(2026, 7, 26, 12, 0, 0),
    watchStartedAt: Date.UTC(2026, 7, 26, 12, 1, 0),
    files,
    pendingFiles,
    excludedAssetKeys,
    assetBaseline: {
      status: options.decisionRequired === true ? 'decision-required' : 'included',
    },
    figmaScopeMode: 'current-page',
    figmaTrackedFiles: hasFigmaAssets
      ? [{ displayName: SYNTHETIC_FIGMA_SOURCE }]
      : [],
    figmaSession: {
      trackedFiles: hasFigmaAssets
        ? [{ lockedPageName: 'Synthetic Current Page', lockStatus: 'resolved' }]
        : [],
      warnings: [],
    },
  };
  const existingAssets = assets.filter(file => file.assetOrigin === 'existing');
  const addedAssets = assets.filter(file => file.assetOrigin !== 'existing');

  return {
    projects: [clone(project)],
    project: clone(project),
    workspace: {
      projectId,
      files: clone(files),
      pendingFiles: clone(pendingFiles),
    },
    settings: {
      namingTemplate: '{Project}_{Date}',
      notifications: false,
      includeDiagnosticReport: false,
      showPackageDetails: true,
      packageOutputLayoutMode: 'flat',
    },
    usage: {
      packagesThisMonth: 0,
      packageLimit: 25,
      limit: 25,
      planId: 'closed-beta',
      planName: 'Beta tester',
    },
    figmaStatus: {
      connected: true,
      activeProjectCount: 1,
      totalFigmaAssets: assetCount,
    },
    expected: {
      assetCount,
      pendingCount,
      excludedCount,
      physicalSourceFiles: physicalSourceFiles.length,
      representedSourceFiles: physicalSourceFiles.length + (hasFigmaAssets ? 1 : 0),
      existingAssets: existingAssets.length,
      addedAssets: addedAssets.length,
      totalWorkspaceFiles: files.length,
      projectId,
    },
  };
}

function collectUnsafeSyntheticStrings(value, pathLabel = 'fixture', findings = []) {
  if (typeof value === 'string') {
    if (
      /(?:\/Users\/|\/Volumes\/|\/private\/|\/tmp\/|figma\.com\/|figd_|Bearer\s|sk-[A-Za-z0-9])/i.test(value)
    ) findings.push(`${pathLabel}: ${value}`);
    return findings;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectUnsafeSyntheticStrings(item, `${pathLabel}[${index}]`, findings));
    return findings;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      collectUnsafeSyntheticStrings(item, `${pathLabel}.${key}`, findings);
    }
  }
  return findings;
}

module.exports = {
  SMOOTHNESS_ASSET_COUNTS,
  SYNTHETIC_FIGMA_SOURCE,
  collectUnsafeSyntheticStrings,
  createUiSmoothnessFixture,
};
