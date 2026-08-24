'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('stream');
const Module = require('module');

const {
  FIGMA_NETWORK_LIMITS,
  createByteBudget,
  fetchBufferWithLimits,
} = require('../parsers/figma-network');

function headers(values = {}) {
  const normalized = new Map(
    Object.entries(values).map(([key, value]) => [key.toLowerCase(), String(value)])
  );
  return {
    get(name) {
      return normalized.get(String(name).toLowerCase()) || null;
    },
  };
}

function response({
  status = 200,
  body = null,
  headerValues = {},
} = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: headers(headerValues),
    body,
  };
}

function loadFigmaParser(fetchImpl) {
  const parserPath = require.resolve('../parsers/figma');
  const originalLoad = Module._load;
  delete require.cache[parserPath];

  Module._load = function loadWithFetchStub(request, parent, isMain) {
    if (request === 'node-fetch') return fetchImpl;
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return require('../parsers/figma').FigmaParser;
  } finally {
    Module._load = originalLoad;
    delete require.cache[parserPath];
  }
}

test('bounded Figma fetch returns normal streamed bytes', async () => {
  const budget = createByteBudget(32);
  const result = await fetchBufferWithLimits({
    fetchImpl: async () => response({
      body: Readable.from([Buffer.from('normal bytes')]),
      headerValues: { 'content-length': 12 },
    }),
    url: 'https://cdn.figma.test/asset.png',
    maxBytes: 16,
    budget,
  });

  assert.equal(result.buffer.toString(), 'normal bytes');
  assert.equal(result.response.status, 200);
  assert.equal(budget.usedBytes, 12);
});

test('bounded Figma fetch rejects oversized Content-Length before reading', async () => {
  let bodyRead = false;
  const body = Readable.from((async function* generate() {
    bodyRead = true;
    yield Buffer.from('should not be read');
  })());

  await assert.rejects(
    fetchBufferWithLimits({
      fetchImpl: async () => response({
        body,
        headerValues: { 'content-length': 17 },
      }),
      url: 'https://cdn.figma.test/oversized.png',
      maxBytes: 16,
      budget: createByteBudget(64),
    }),
    error => error && error.reason === 'response-too-large'
  );
  assert.equal(bodyRead, false);
  assert.equal(body.destroyed, true);
});

test('bounded Figma fetch stops a stream that exceeds its response cap', async () => {
  const body = Readable.from([Buffer.alloc(8), Buffer.alloc(9)]);
  const budget = createByteBudget(64);

  await assert.rejects(
    fetchBufferWithLimits({
      fetchImpl: async () => response({ body }),
      url: 'https://cdn.figma.test/streamed.png',
      maxBytes: 16,
      budget,
    }),
    error => error && error.reason === 'response-too-large'
  );
  assert.equal(body.destroyed, true);
  assert.equal(budget.usedBytes, 8);
});

test('bounded Figma fetch shares an aggregate byte budget across responses', async () => {
  const budget = createByteBudget(12);
  const fetchImpl = async () => response({ body: Readable.from([Buffer.alloc(8)]) });

  await fetchBufferWithLimits({
    fetchImpl,
    url: 'https://cdn.figma.test/one.png',
    maxBytes: 10,
    budget,
  });
  await assert.rejects(
    fetchBufferWithLimits({
      fetchImpl,
      url: 'https://cdn.figma.test/two.png',
      maxBytes: 10,
      budget,
    }),
    error => error && error.reason === 'aggregate-limit'
  );
  assert.equal(budget.usedBytes, 8);
});

test('bounded Figma fetch rejects an exhausted aggregate budget before another request', async () => {
  const budget = createByteBudget(12);
  budget.usedBytes = budget.maxBytes;
  let fetchCalls = 0;

  await assert.rejects(
    fetchBufferWithLimits({
      fetchImpl: async () => {
        fetchCalls += 1;
        return response({ body: Readable.from([Buffer.alloc(1)]) });
      },
      url: 'https://cdn.figma.test/exhausted.png',
      maxBytes: 10,
      budget,
    }),
    error => error && error.reason === 'aggregate-limit'
  );
  assert.equal(fetchCalls, 0);
  assert.equal(budget.usedBytes, budget.maxBytes);
});

test('bounded Figma fetch rejects an expired operation deadline before another request', async () => {
  const budget = createByteBudget(12, 1000);
  budget.deadlineAt = Date.now() - 1;
  let fetchCalls = 0;

  await assert.rejects(
    fetchBufferWithLimits({
      fetchImpl: async () => {
        fetchCalls += 1;
        return response({ body: Readable.from([Buffer.alloc(1)]) });
      },
      url: 'https://cdn.figma.test/expired.png',
      maxBytes: 10,
      budget,
    }),
    error => error && error.reason === 'timeout'
  );
  assert.equal(fetchCalls, 0);
});

test('bounded Figma fetch caps redirects and rejects HTTPS downgrade', async () => {
  let redirectCalls = 0;
  const redirectFetch = async () => {
    redirectCalls += 1;
    return response({
      status: 302,
      headerValues: { location: `https://cdn.figma.test/redirect-${redirectCalls}` },
    });
  };

  await assert.rejects(
    fetchBufferWithLimits({
      fetchImpl: redirectFetch,
      url: 'https://cdn.figma.test/start',
      maxBytes: 16,
      maxRedirects: 2,
    }),
    error => error && error.reason === 'redirect-limit'
  );
  assert.equal(redirectCalls, 3);

  const downgradeBody = new Readable({ read() {} });
  await assert.rejects(
    fetchBufferWithLimits({
      fetchImpl: async () => response({
        status: 302,
        body: downgradeBody,
        headerValues: { location: 'http://cdn.figma.test/insecure' },
      }),
      url: 'https://cdn.figma.test/start',
      maxBytes: 16,
      maxRedirects: 2,
    }),
    error => error && error.reason === 'insecure-url'
  );
  assert.equal(downgradeBody.destroyed, true);
});

test('bounded Figma fetch times out with a privacy-safe error', async () => {
  const secretUrl = 'https://cdn.figma.test/private.png?token=SHOULD_NOT_LEAK';
  await assert.rejects(
    fetchBufferWithLimits({
      fetchImpl: async () => new Promise(() => {}),
      url: secretUrl,
      maxBytes: 16,
      timeoutMs: 5,
    }),
    error => {
      assert.equal(error.reason, 'timeout');
      assert.equal(error.message.includes('SHOULD_NOT_LEAK'), false);
      assert.equal(error.message.includes('cdn.figma.test'), false);
      return true;
    }
  );
});

test('bounded Figma fetch propagates a caller abort without exposing request details', async () => {
  const controller = new AbortController();
  let requestSignal = null;
  let abortObserved = false;
  const pending = fetchBufferWithLimits({
    fetchImpl: async (_url, options) => new Promise((resolve, reject) => {
      requestSignal = options.signal;
      options.signal.addEventListener('abort', () => {
        abortObserved = true;
        const error = new Error('aborted private Figma request');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    }),
    url: 'https://cdn.figma.test/private.png?token=SHOULD_NOT_LEAK',
    signal: controller.signal,
    maxBytes: 16,
  });

  controller.abort();
  await assert.rejects(pending, error => {
    assert.equal(error.reason, 'timeout');
    assert.equal(error.message.includes('SHOULD_NOT_LEAK'), false);
    assert.equal(error.message.includes('cdn.figma.test'), false);
    return true;
  });
  assert.equal(requestSignal.aborted, true);
  assert.equal(abortObserved, true);
});

test('bounded Figma fetch destroys an active response body on timeout', async () => {
  const body = new Readable({ read() {} });
  await assert.rejects(
    fetchBufferWithLimits({
      fetchImpl: async () => response({ body }),
      url: 'https://cdn.figma.test/stalled.png',
      maxBytes: 16,
      timeoutMs: 5,
    }),
    error => error && error.reason === 'timeout'
  );
  assert.equal(body.destroyed, true);
});

test('bounded Figma fetch destroys non-success response bodies', async () => {
  const body = new Readable({ read() {} });
  const result = await fetchBufferWithLimits({
    fetchImpl: async () => response({ status: 500, body }),
    url: 'https://cdn.figma.test/failure.png',
    maxBytes: 16,
  });

  assert.equal(result.response.status, 500);
  assert.equal(result.buffer, null);
  assert.equal(body.destroyed, true);
});

test('bounded Figma fetch replaces unknown network errors with safe text', async () => {
  const secretUrl = 'https://cdn.figma.test/private.png?token=SHOULD_NOT_LEAK';
  await assert.rejects(
    fetchBufferWithLimits({
      fetchImpl: async () => {
        throw new Error(`network failed for ${secretUrl}`);
      },
      url: secretUrl,
      maxBytes: 16,
    }),
    error => {
      assert.equal(error.reason, 'request-failed');
      assert.equal(error.message.includes('SHOULD_NOT_LEAK'), false);
      assert.equal(error.message.includes('cdn.figma.test'), false);
      return true;
    }
  );
});

test('Figma API rejects oversized JSON without exposing endpoint or token', async () => {
  const fetchImpl = async () => response({
    body: Readable.from([Buffer.from('{}')]),
    headerValues: {
      'content-length': FIGMA_NETWORK_LIMITS.apiResponseBytes + 1,
    },
  });
  const FigmaParser = loadFigmaParser(fetchImpl);
  const parser = new FigmaParser();

  await assert.rejects(
    parser._fetchAPI('/files/FILEKEY?token=SHOULD_NOT_LEAK', 'SHOULD_NOT_LEAK'),
    error => {
      assert.equal(error._crateFigmaApiFailureReason, 'response-too-large');
      assert.equal(error.message.includes('SHOULD_NOT_LEAK'), false);
      assert.equal(error.message.includes('api.figma.com'), false);
      return true;
    }
  );
});

test('autoTrackScan shares one API byte budget through verification, discovery, and extraction', async () => {
  const FigmaParser = loadFigmaParser(async () => response({ status: 500 }));
  const seenBudgets = [];

  class BudgetProbeParser extends FigmaParser {
    async verifyToken(apiBudget) {
      seenBudgets.push(apiBudget);
      return { valid: true };
    }

    async discoverRecentFiles(options) {
      seenBudgets.push(options.apiBudget);
      return {
        recentFiles: [{ key: 'FILEKEY', name: 'Tracked', isTracked: true }],
        errors: [],
      };
    }

    async extractAssetsFromFileKey(fileKey, scopeEntry, apiBudget) {
      seenBudgets.push(apiBudget);
      return {
        assets: [],
        errors: [],
        warnings: [],
        scope: {
          scopeMode: 'current-page',
          lockStatus: 'locked',
          lockedPageId: '1:1',
          lockedPageName: 'Page One',
          fileFetchStatus: 'success',
          assetFetchStatus: 'success',
        },
      };
    }
  }

  const result = await new BudgetProbeParser().autoTrackScan({
    fileKeys: ['FILEKEY'],
    scopeEntries: [{ key: 'FILEKEY', primaryKey: 'PRIMARYKEY', scopeMode: 'current-page' }],
  });
  assert.equal(result.files.length, 1);
  assert.equal(result.scopeEntries[0].primaryKey, 'PRIMARYKEY');
  assert.equal(result.scopeEntries[0].assetFetchStatus, 'success');
  assert.equal(seenBudgets.length, 3);
  assert.equal(seenBudgets.every(budget => budget === seenBudgets[0]), true);
  assert.equal(seenBudgets[0].maxBytes, FIGMA_NETWORK_LIMITS.apiOperationBytes);
});
