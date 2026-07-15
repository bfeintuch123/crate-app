const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyDiagnosticPackageError,
  summarizeDiagnosticPackageErrors,
} = require('../diagnostic-summary');

test('diagnostic package errors use fixed categories without retaining raw messages', () => {
  const privateMessage = 'Unexpected failure for /Users/designer/private/client-project.ai';

  assert.equal(classifyDiagnosticPackageError(privateMessage), 'other');
  assert.deepEqual(summarizeDiagnosticPackageErrors([
    'File not found: missing.ai',
    'Failed to copy logo.ai: denied',
    'Could not inspect embedded media in slides.pptx.',
    'Could not extract embedded media image.png from deck.key.',
    privateMessage,
  ]), {
    copy_failed: 1,
    embedded_media_extraction_failed: 1,
    embedded_media_inspection_failed: 1,
    file_not_found: 1,
    other: 1,
  });
  assert.equal(JSON.stringify(summarizeDiagnosticPackageErrors([privateMessage])).includes(privateMessage), false);
});
