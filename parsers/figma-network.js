'use strict';

const FIGMA_NETWORK_LIMITS = Object.freeze({
  requestTimeoutMs: 30_000,
  apiOperationTimeoutMs: 120_000,
  assetOperationTimeoutMs: 120_000,
  apiResponseBytes: 128 * 1024 * 1024,
  apiOperationBytes: 512 * 1024 * 1024,
  assetResponseBytes: 100 * 1024 * 1024,
  assetOperationBytes: 1024 * 1024 * 1024,
  apiRedirects: 0,
  assetRedirects: 5,
});

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const SAFE_MESSAGES = Object.freeze({
  'aggregate-limit': 'Figma transfer exceeded the scan safety limit.',
  'insecure-url': 'Figma transfer blocked an insecure address.',
  'invalid-response': 'Figma transfer returned an invalid response.',
  'redirect-limit': 'Figma transfer exceeded the redirect safety limit.',
  'request-failed': 'Figma transfer failed.',
  'response-too-large': 'Figma transfer exceeded the response safety limit.',
  timeout: 'Figma transfer timed out.',
});

class FigmaNetworkError extends Error {
  constructor(reason) {
    super(SAFE_MESSAGES[reason] || 'Figma transfer failed.');
    this.name = 'FigmaNetworkError';
    this.reason = reason || 'request-failed';
    this._crateFigmaNetworkSafe = true;
  }
}

function createByteBudget(maxBytes, timeoutMs = null) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError('Figma byte budget must be a positive safe integer.');
  }
  if (timeoutMs != null && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)) {
    throw new TypeError('Figma operation timeout must be a positive safe integer.');
  }
  return {
    maxBytes,
    usedBytes: 0,
    deadlineAt: timeoutMs == null ? null : Date.now() + timeoutMs,
  };
}

function ensureBudget(budget, fallbackMaxBytes) {
  if (!budget) return createByteBudget(fallbackMaxBytes);
  if (
    !Number.isSafeInteger(budget.maxBytes) || budget.maxBytes <= 0 ||
    !Number.isSafeInteger(budget.usedBytes) || budget.usedBytes < 0 ||
    (budget.deadlineAt != null && (!Number.isSafeInteger(budget.deadlineAt) || budget.deadlineAt <= 0))
  ) {
    throw new TypeError('Figma byte budget is invalid.');
  }
  return budget;
}

function assertHttpsUrl(rawUrl, baseUrl = null) {
  let parsed;
  try {
    parsed = baseUrl ? new URL(rawUrl, baseUrl) : new URL(rawUrl);
  } catch (_) {
    throw new FigmaNetworkError('insecure-url');
  }
  if (parsed.protocol !== 'https:') throw new FigmaNetworkError('insecure-url');
  if (parsed.username || parsed.password) throw new FigmaNetworkError('insecure-url');
  return parsed.toString();
}

function getHeader(response, name) {
  if (!response || !response.headers) return null;
  if (typeof response.headers.get === 'function') return response.headers.get(name);
  const target = String(name).toLowerCase();
  for (const [key, value] of Object.entries(response.headers)) {
    if (String(key).toLowerCase() === target) return value;
  }
  return null;
}

function parseContentLength(response) {
  const rawValue = getHeader(response, 'content-length');
  if (rawValue == null || rawValue === '') return null;
  const text = String(rawValue).trim();
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

function destroyResponseBody(response) {
  const body = response && response.body;
  if (body && typeof body.destroy === 'function' && !body.destroyed) body.destroy();
  if (body && typeof body.cancel === 'function') {
    Promise.resolve(body.cancel()).catch(() => {});
  }
}

function accountChunk(chunkLength, responseBytes, maxBytes, budget) {
  const nextResponseBytes = responseBytes + chunkLength;
  if (nextResponseBytes > maxBytes) throw new FigmaNetworkError('response-too-large');
  const nextUsedBytes = budget.usedBytes + chunkLength;
  if (nextUsedBytes > budget.maxBytes) throw new FigmaNetworkError('aggregate-limit');
  budget.usedBytes = nextUsedBytes;
  return nextResponseBytes;
}

function remainingOperationMs(budget) {
  if (budget.deadlineAt == null) return null;
  return budget.deadlineAt - Date.now();
}

function assertBudgetAvailable(budget) {
  if (budget.usedBytes >= budget.maxBytes) throw new FigmaNetworkError('aggregate-limit');
  const remainingMs = remainingOperationMs(budget);
  if (remainingMs != null && remainingMs <= 0) throw new FigmaNetworkError('timeout');
  return remainingMs;
}

async function readBoundedBody(response, maxBytes, budget) {
  const contentLength = parseContentLength(response);
  if (contentLength != null) {
    if (contentLength > maxBytes) {
      destroyResponseBody(response);
      throw new FigmaNetworkError('response-too-large');
    }
    if (budget.usedBytes + contentLength > budget.maxBytes) {
      destroyResponseBody(response);
      throw new FigmaNetworkError('aggregate-limit');
    }
  }

  const body = response && response.body;
  if (body && typeof body[Symbol.asyncIterator] === 'function') {
    const chunks = [];
    let responseBytes = 0;
    try {
      for await (const value of body) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        responseBytes = accountChunk(chunk.length, responseBytes, maxBytes, budget);
        chunks.push(chunk);
      }
      return Buffer.concat(chunks, responseBytes);
    } catch (error) {
      destroyResponseBody(response);
      throw error;
    }
  }

  let buffer;
  if (response && typeof response.buffer === 'function') {
    buffer = await response.buffer();
  } else if (response && typeof response.arrayBuffer === 'function') {
    buffer = Buffer.from(await response.arrayBuffer());
  } else {
    throw new FigmaNetworkError('invalid-response');
  }

  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
  accountChunk(buffer.length, 0, maxBytes, budget);
  return buffer;
}

async function fetchBufferWithLimits({
  fetchImpl,
  url,
  headers = undefined,
  timeoutMs = FIGMA_NETWORK_LIMITS.requestTimeoutMs,
  maxBytes,
  budget = null,
  maxRedirects = 0,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('Figma fetch implementation is required.');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError('Figma timeout is invalid.');
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new TypeError('Figma response limit is invalid.');
  if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0) throw new TypeError('Figma redirect limit is invalid.');

  const byteBudget = ensureBudget(budget, maxBytes);
  const remainingMs = assertBudgetAvailable(byteBudget);
  const effectiveTimeoutMs = remainingMs == null ? timeoutMs : Math.min(timeoutMs, remainingMs);
  const controller = new AbortController();
  let activeResponse = null;
  let timeoutId;

  const operation = (async () => {
    let currentUrl = assertHttpsUrl(url);
    for (let redirects = 0; ; redirects += 1) {
      assertBudgetAvailable(byteBudget);
      const response = await fetchImpl(currentUrl, {
        headers,
        redirect: 'manual',
        signal: controller.signal,
      });
      activeResponse = response;
      if (!response || !Number.isInteger(response.status)) {
        throw new FigmaNetworkError('invalid-response');
      }

      if (REDIRECT_STATUSES.has(response.status)) {
        if (redirects >= maxRedirects) {
          destroyResponseBody(response);
          throw new FigmaNetworkError('redirect-limit');
        }
        const location = getHeader(response, 'location');
        if (!location) {
          destroyResponseBody(response);
          throw new FigmaNetworkError('invalid-response');
        }
        try {
          currentUrl = assertHttpsUrl(location, currentUrl);
        } finally {
          destroyResponseBody(response);
        }
        continue;
      }

      if (!response.ok) {
        destroyResponseBody(response);
        return { response, buffer: null };
      }
      const buffer = await readBoundedBody(response, maxBytes, byteBudget);
      activeResponse = null;
      return { response, buffer };
    }
  })();

  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      destroyResponseBody(activeResponse);
      reject(new FigmaNetworkError('timeout'));
    }, effectiveTimeoutMs);
  });

  try {
    return await Promise.race([operation, timeout]);
  } catch (error) {
    if (error && error._crateFigmaNetworkSafe) throw error;
    if (error && error.name === 'AbortError') throw new FigmaNetworkError('timeout');
    throw new FigmaNetworkError('request-failed');
  } finally {
    clearTimeout(timeoutId);
  }
}

module.exports = {
  FIGMA_NETWORK_LIMITS,
  FigmaNetworkError,
  createByteBudget,
  fetchBufferWithLimits,
};
