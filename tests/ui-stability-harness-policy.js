'use strict';

function withinTolerance(actual, expected, tolerancePx) {
  return Math.abs(actual - expected) <= tolerancePx;
}

function sizesMatch(actualSize, expectedSize, tolerancePx) {
  return (
    withinTolerance(actualSize.width, expectedSize.width, tolerancePx)
    && withinTolerance(actualSize.height, expectedSize.height, tolerancePx)
  );
}

function formatSize(size) {
  return size ? `${size.width}x${size.height}` : 'unavailable';
}

function analyzeOuterSizeRequest({
  requestedSize,
  actualSize,
  configuredMinimum,
  workArea = null,
  allowWorkAreaCap = false,
  tolerancePx = 1,
}) {
  const tolerance = Number.isFinite(tolerancePx) && tolerancePx >= 0 ? tolerancePx : 0;

  if (
    actualSize.width < configuredMinimum.width - tolerance
    || actualSize.height < configuredMinimum.height - tolerance
  ) {
    return {
      accepted: false,
      disposition: 'below-minimum',
      requestedSize,
      actualSize,
      expectedSize: configuredMinimum,
      workArea,
      workAreaCapped: false,
      cappedDimensions: [],
      failure: `observed outer size ${formatSize(actualSize)} is below the configured minimum ${formatSize(configuredMinimum)}`,
    };
  }

  if (sizesMatch(actualSize, requestedSize, tolerance)) {
    return {
      accepted: true,
      disposition: 'exact',
      requestedSize,
      actualSize,
      expectedSize: requestedSize,
      workArea,
      workAreaCapped: false,
      cappedDimensions: [],
      failure: null,
    };
  }

  const expectedSize = { ...requestedSize };
  const cappedDimensions = [];
  if (
    allowWorkAreaCap
    && workArea
    && Number.isFinite(workArea.width)
    && requestedSize.width > workArea.width + tolerance
  ) {
    expectedSize.width = Math.max(configuredMinimum.width, workArea.width);
    cappedDimensions.push('width');
  }
  if (
    allowWorkAreaCap
    && workArea
    && Number.isFinite(workArea.height)
    && requestedSize.height > workArea.height + tolerance
  ) {
    expectedSize.height = Math.max(configuredMinimum.height, workArea.height);
    cappedDimensions.push('height');
  }

  if (cappedDimensions.length > 0 && sizesMatch(actualSize, expectedSize, tolerance)) {
    return {
      accepted: true,
      disposition: 'work-area-capped',
      requestedSize,
      actualSize,
      expectedSize,
      workArea,
      workAreaCapped: true,
      cappedDimensions,
      failure: null,
    };
  }

  return {
    accepted: false,
    disposition: 'unexpected-size',
    requestedSize,
    actualSize,
    expectedSize,
    workArea,
    workAreaCapped: false,
    cappedDimensions,
    failure: `requested outer size ${formatSize(requestedSize)}, observed ${formatSize(actualSize)}; `
      + `eligible work area ${allowWorkAreaCap ? formatSize(workArea) : 'not enabled'} does not explain the mismatch`,
  };
}

function getHarnessExitCode({ pageErrors = [], consoleErrors = [], failures = [] } = {}) {
  return pageErrors.length > 0 || consoleErrors.length > 0 || failures.length > 0 ? 1 : 0;
}

function finalizeHarnessProcess({
  appModule,
  fsModule = null,
  processModule,
  temporaryUserData = null,
  exitCode,
  onCleanupError = () => {},
}) {
  let finalExitCode = exitCode === 0 ? 0 : 1;
  if (
    typeof temporaryUserData === 'string'
    && temporaryUserData.length > 0
    && fsModule
    && typeof fsModule.rmSync === 'function'
  ) {
    try {
      fsModule.rmSync(temporaryUserData, { recursive: true, force: true });
    } catch (error) {
      finalExitCode = 1;
      onCleanupError(error);
    }
  }

  processModule.exitCode = finalExitCode;
  appModule.exit(finalExitCode);
  return finalExitCode;
}

module.exports = {
  analyzeOuterSizeRequest,
  finalizeHarnessProcess,
  getHarnessExitCode,
};
