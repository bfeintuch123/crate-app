'use strict';
// Literal Needs Save wording, shared by the renderer tests (alert, dashboard
// banner, Package Review) and, later, the notification tests. Expected text is
// written out in full so production code shares nothing with these cases.
const save = (sourceName, appFamily, index) => ({
  name: `Linked_${index + 1}.png`,
  path: `/synthetic/Linked_${index + 1}.png`,
  ext: '.png',
  captureState: 'needs-save',
  captureEvidence: {
    ...(appFamily ? { appFamily } : {}),
    ...(sourceName ? { sourceName } : {}),
    reason: 'linked-asset-observed',
  },
});

const rows = specs => specs.map(([sourceName, appFamily], index) => save(sourceName, appFamily, index));

// The working file itself, listed as Needs Save because it has unsaved changes.
const unsavedWorkingFile = ({ name = 'Campaign_Board.ai', appFamily = 'illustrator', sourceName = name, topLevelReasonOnly = false } = {}) => ({
  name,
  path: `/synthetic/${name}`,
  ext: name.slice(name.lastIndexOf('.')),
  captureState: 'needs-save',
  captureReason: 'unsaved-source-needs-save',
  captureEvidence: {
    appFamily,
    ...(sourceName ? { sourceName } : {}),
    ...(topLevelReasonOnly ? {} : { reason: 'unsaved-source-needs-save' }),
    documentModified: true,
  },
});

module.exports = [
  {
    name: 'one source file, two assets',
    rows: rows([['Campaign_Board.ai', 'illustrator'], ['Campaign_Board.ai', 'illustrator']]),
    alert: 'Save Campaign_Board.ai in Illustrator to add these 2 linked assets to the package.',
    banner: 'Save Campaign_Board.ai in Illustrator to add them to the package.',
  },
  {
    name: 'one asset',
    rows: rows([['Campaign_Board.ai', 'illustrator']]),
    alert: 'Save Campaign_Board.ai in Illustrator to add this linked asset to the package.',
    banner: 'Save Campaign_Board.ai in Illustrator to add it to the package.',
  },
  {
    name: 'two source files',
    rows: rows([['Campaign_Board.ai', 'illustrator'], ['Campaign_Board.ai', 'illustrator'], ['Shelf_Layout.indd', 'indesign'], ['Shelf_Layout.indd', 'indesign']]),
    alert: 'Save Campaign_Board.ai and 1 other file to add these 4 linked assets to the package.',
    banner: 'Save Campaign_Board.ai and 1 other file to add them to the package.',
  },
  {
    name: 'file name unknown, app known',
    rows: rows([[null, 'indesign'], [null, 'indesign']]),
    alert: 'Save your file in InDesign to add these 2 linked assets to the package.',
    banner: 'Save your file in InDesign to add them to the package.',
  },
  {
    name: 'file name and app unknown',
    rows: rows([[null, null], [null, null]]),
    alert: 'Save your working file to add these 2 linked assets to the package.',
    banner: 'Save your working file to add them to the package.',
  },
  {
    name: 'named Illustrator rows plus an unnamed Photoshop row',
    rows: rows([['Campaign_Board.ai', 'illustrator'], [null, 'photoshop']]),
    alert: 'Save Campaign_Board.ai and 1 other file to add these 2 linked assets to the package.',
    banner: 'Save Campaign_Board.ai and 1 other file to add them to the package.',
  },
  {
    name: 'source name known, app unknown',
    rows: rows([['Campaign_Board.ai', null], ['Campaign_Board.ai', null]]),
    alert: 'Save Campaign_Board.ai to add these 2 linked assets to the package.',
    banner: 'Save Campaign_Board.ai to add them to the package.',
  },
  {
    name: 'three source files',
    rows: rows([['Campaign_Board.ai', 'illustrator'], ['Shelf_Layout.indd', 'indesign'], ['Poster.psd', 'photoshop']]),
    alert: 'Save Campaign_Board.ai and 2 other files to add these 3 linked assets to the package.',
    banner: 'Save Campaign_Board.ai and 2 other files to add them to the package.',
  },
  {
    name: 'unnamed rows from two apps',
    rows: rows([[null, 'indesign'], [null, 'photoshop']]),
    alert: 'Save your working files to add these 2 linked assets to the package.',
    banner: 'Save your working files to add them to the package.',
  },
  {
    name: 'unnamed rows, one app known and one unknown',
    rows: rows([[null, 'indesign'], [null, null]]),
    alert: 'Save your working files to add these 2 linked assets to the package.',
    banner: 'Save your working files to add them to the package.',
  },
  {
    name: 'unsaved working file and one new linked asset',
    rows: [unsavedWorkingFile(), ...rows([['Campaign_Board.ai', 'illustrator']])],
    alert: 'Save Campaign_Board.ai in Illustrator to add this linked asset to the package.',
    banner: 'Save Campaign_Board.ai in Illustrator to add them to the package.',
  },
  {
    name: 'unsaved working file and two new linked assets',
    rows: [unsavedWorkingFile(), ...rows([['Campaign_Board.ai', 'illustrator'], ['Campaign_Board.ai', 'illustrator']])],
    alert: 'Save Campaign_Board.ai in Illustrator to add these 2 linked assets to the package.',
    banner: 'Save Campaign_Board.ai in Illustrator to add them to the package.',
  },
  {
    name: 'only the unsaved working file',
    rows: [unsavedWorkingFile()],
    alert: 'Save Campaign_Board.ai in Illustrator to add it to the package.',
    banner: 'Save Campaign_Board.ai in Illustrator to add it to the package.',
  },
  {
    name: 'two unsaved working files, no linked assets',
    rows: [unsavedWorkingFile(), unsavedWorkingFile({ name: 'Shelf_Layout.indd', appFamily: 'indesign' })],
    alert: 'Save Campaign_Board.ai and 1 other file to add them to the package.',
    banner: 'Save Campaign_Board.ai and 1 other file to add them to the package.',
  },
  {
    name: 'unsaved working file without a source name, marked only by its capture reason',
    rows: [unsavedWorkingFile({ sourceName: null, topLevelReasonOnly: true }), ...rows([['Campaign_Board.ai', 'illustrator']])],
    alert: 'Save Campaign_Board.ai in Illustrator to add this linked asset to the package.',
    banner: 'Save Campaign_Board.ai in Illustrator to add them to the package.',
  },
  {
    name: 'a source name that looks like a path is not shown',
    rows: rows([['/Users/private/Client/Board.ai', 'illustrator']]),
    alert: 'Save your file in Illustrator to add this linked asset to the package.',
    banner: 'Save your file in Illustrator to add it to the package.',
  },
];
