function classifyDiagnosticPackageError(error) {
  const message = typeof error === 'string' ? error.trim() : '';
  if (/^File not found:/i.test(message)) return 'file_not_found';
  if (/^Failed to copy /i.test(message)) return 'copy_failed';
  if (/^Could not inspect embedded media/i.test(message)) return 'embedded_media_inspection_failed';
  if (/^Could not extract embedded media/i.test(message)) return 'embedded_media_extraction_failed';
  return 'other';
}

function summarizeDiagnosticPackageErrors(errors) {
  const counts = {};
  for (const error of Array.isArray(errors) ? errors : []) {
    const category = classifyDiagnosticPackageError(error);
    counts[category] = (counts[category] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

module.exports = {
  classifyDiagnosticPackageError,
  summarizeDiagnosticPackageErrors,
};
