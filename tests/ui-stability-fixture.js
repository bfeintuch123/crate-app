'use strict';

const SYNTHETIC_FIGMA_SOURCE = 'Synthetic Figma Board';

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
    excluded: false,
    visualIdentity: `synthetic-visual-${stableId}`,
    visualRevision: `synthetic-revision-${stableId}`,
  };
}

function createSourceFiles() {
  return [
    createPresentation({
      name: 'Synthetic_Working_File_Illustrator.ai',
      extension: '.ai',
      appFamily: 'illustrator',
      assetOrigin: 'existing',
      projectRole: 'source',
      protectedSource: true,
      index: 1,
    }),
    createPresentation({
      name: 'Synthetic_Working_File_Photoshop.psd',
      extension: '.psd',
      appFamily: 'photoshop',
      assetOrigin: 'existing',
      projectRole: 'source',
      protectedSource: true,
      index: 2,
    }),
    createPresentation({
      name: 'Synthetic_Working_File_InDesign.indd',
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
    return `Synthetic Figma Asset ${padded} — Deliberately Long Responsive Filename For Truncation.png`;
  }
  if (index % 29 === 0) {
    return `Synthetic-Figma-Asset_${padded} (alternate state).jpg`;
  }
  return `Synthetic_Figma_Asset_${padded}.png`;
}

function createAssets() {
  const assets = [];
  for (let index = 1; index <= 263; index += 1) {
    const existing = index <= 7;
    const jpeg = index % 29 === 0;
    assets.push(createPresentation({
      name: syntheticAssetName(index),
      extension: jpeg ? '.jpg' : '.png',
      appFamily: 'figma',
      sourceName: SYNTHETIC_FIGMA_SOURCE,
      assetOrigin: existing ? 'existing' : 'added',
      projectRole: 'asset',
      linked: index % 5 === 0,
      embedded: index % 37 === 0,
      index: index + 100,
    }));
  }
  return assets;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createUiStabilityFixture() {
  const sourceFiles = createSourceFiles();
  const assets = createAssets();
  const files = [...sourceFiles, ...assets];
  const project = {
    id: 'synthetic-ui-stability-project',
    name: 'Synthetic UI Stability Project',
    type: 'automatic',
    status: 'watching',
    createdAt: Date.UTC(2026, 7, 25, 12, 0, 0),
    watchStartedAt: Date.UTC(2026, 7, 25, 12, 1, 0),
    files,
    pendingFiles: [],
    excludedAssetKeys: [],
    assetBaseline: { status: 'included' },
    figmaScopeMode: 'current-page',
    figmaTrackedFiles: [{ displayName: SYNTHETIC_FIGMA_SOURCE }],
    figmaSession: {
      trackedFiles: [{ lockedPageName: 'Synthetic Current Page', lockStatus: 'resolved' }],
      warnings: [],
    },
  };

  return {
    project: clone(project),
    workspace: {
      projectId: project.id,
      files: clone(files),
      pendingFiles: [],
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
    expected: {
      sourceFiles: 4,
      physicalSourceFiles: 3,
      figmaSourceFiles: 1,
      existingAssets: 7,
      addedAssets: 256,
      totalAssets: 263,
      totalWorkspaceFiles: 266,
    },
  };
}

module.exports = {
  SYNTHETIC_FIGMA_SOURCE,
  createUiStabilityFixture,
};
