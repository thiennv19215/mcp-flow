import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

// GPT-15 — Tab-fetch relay contract for ChatGPT downloads (study (E)15,
// §D.3.5, behavior B24). Result bytes are fetched with a credentialed
// fetch executed in the provider tab's context and returned base64 —
// the same out-contract as the existing Flow relay
// (readFlowDownloadChunk returns { data: base64, ...Sha256, totalBytes }
// after validating the media URL's host before it fetches). The relay
// generalizes by a provider/host table, never a second implementation:
//
//   - BEFORE the fetch is issued: a non-allowlisted host (exact-host /
//     proper-subdomain matching only), a non-https URL, embedded URL
//     credentials, an unknown provider, or a declared size over the cap
//     all refuse with the fetch never called;
//   - AFTER response headers, BEFORE the body is read: an oversized
//     Content-Length or a non-image Content-Type refuses with the body
//     never consumed (and cancelled);
//   - AFTER the read: an actual byte count over the cap, or one that
//     disagrees with the declared size, refuses instead of returning
//     bytes.
// The size cap is the repo's image-transfer cap (25 MiB, the same cap
// flow-transfer applies to images) exposed as a named constant; the
// accepted content types are the image types the queue download
// pipeline already maps (png / jpeg / webp / gif).

const relay = await import('../extension/src/background/flow-download-relay.js');

const {
  relayTabFetchImage,
  validateTabFetchImageRequest,
  isTabFetchHostAllowed,
  TAB_FETCH_PROVIDER_HOSTS,
  TAB_FETCH_IMAGE_MAX_BYTES,
  TAB_FETCH_IMAGE_CONTENT_TYPES,
  TAB_FETCH_TIMEOUT_MS,
} = relay;

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const CHATGPT_FILE_URL = 'https://files.oaiusercontent.com/file-AAA111?sig=one';
const CHATGPT_PAGE_URL = 'https://chatgpt.com/backend-api/estuary/content?id=file_AAA111&ts=9';

// A fake fetch harness: records every call, and a fake response that
// records whether its body was read or cancelled.
function fakeHarness(responseSpec = {}) {
  const calls = [];
  let bodyRead = false;
  let bodyCancelled = false;
  const bytes = responseSpec.bytes ?? PNG_BYTES;
  const headers = new Map();
  if (responseSpec.contentType !== null) headers.set('content-type', responseSpec.contentType ?? 'image/png');
  if (responseSpec.contentLength !== undefined && responseSpec.contentLength !== null) {
    headers.set('content-length', String(responseSpec.contentLength));
  }
  const response = {
    status: responseSpec.status ?? 200,
    ok: (responseSpec.status ?? 200) >= 200 && (responseSpec.status ?? 200) < 300,
    headers: { get: name => headers.get(String(name).toLowerCase()) ?? null },
    body: { cancel: async () => { bodyCancelled = true; } },
    arrayBuffer: async () => {
      bodyRead = true;
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (responseSpec.fetchError) throw responseSpec.fetchError;
    return response;
  };
  return { calls, fetchImpl, wasBodyRead: () => bodyRead, wasBodyCancelled: () => bodyCancelled };
}

const webcrypto = globalThis.crypto;

// --- Named constants / host table -------------------------------------------

test('GPT-15 relay: caps and accepted types are named constants following the existing discipline', () => {
  assert.equal(TAB_FETCH_IMAGE_MAX_BYTES, 25 * 1024 * 1024, 'the image cap mirrors the repo image-transfer cap');
  assert.deepEqual([...TAB_FETCH_IMAGE_CONTENT_TYPES], ['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
  assert.ok(Object.isFrozen(TAB_FETCH_IMAGE_CONTENT_TYPES));
  assert.equal(TAB_FETCH_TIMEOUT_MS, 45_000, 'the fetch timeout mirrors the Flow relay chunk timeout');
  assert.deepEqual([...TAB_FETCH_PROVIDER_HOSTS.chatgpt], ['chatgpt.com', 'oaiusercontent.com']);
  assert.ok(Object.isFrozen(TAB_FETCH_PROVIDER_HOSTS));
});

test('GPT-15 relay: host table accepts exact hosts and proper subdomains only', () => {
  for (const hostname of ['chatgpt.com', 'files.oaiusercontent.com', 'oaiusercontent.com', 'cdn.oaiusercontent.com']) {
    assert.equal(isTabFetchHostAllowed(hostname, 'chatgpt'), true, `${hostname} accepted`);
  }
  for (const hostname of [
    'evil-oaiusercontent.com', 'oaiusercontent.com.evil.com', 'chatgpt.com.evil.com',
    'notchatgpt.com', 'google.com', 'flow.google.com',
  ]) {
    assert.equal(isTabFetchHostAllowed(hostname, 'chatgpt'), false, `${hostname} rejected`);
  }
  // The Flow row goes through the same table-driven check and keeps the
  // legacy Flow relay verdicts (allowedMediaHost in readFlowDownloadChunk).
  assert.equal(isTabFetchHostAllowed('lh3.googleusercontent.com', 'flow'), true);
  assert.equal(isTabFetchHostAllowed('storage.googleapis.com', 'flow'), true);
  assert.equal(isTabFetchHostAllowed('chatgpt.com', 'flow'), false);
  assert.equal(isTabFetchHostAllowed('chatgpt.com', 'bogus'), false);
  assert.equal(isTabFetchHostAllowed('chatgpt.com'), true, 'chatgpt is the default provider for the tab-fetch relay');
});

// --- Pre-fetch refusals: the fetch is never issued ----------------------------

const PRE_FETCH_REFUSALS = [
  ['lookalike CDN host', { url: 'https://evil-oaiusercontent.com/file-A' }, 'TAB_FETCH_URL_REJECTED'],
  ['CDN host under an evil parent', { url: 'https://oaiusercontent.com.evil.com/file-A' }, 'TAB_FETCH_URL_REJECTED'],
  ['chat host under an evil parent', { url: 'https://chatgpt.com.evil.com/backend-api/estuary/content?id=file_A' }, 'TAB_FETCH_URL_REJECTED'],
  ['lookalike chat host', { url: 'https://notchatgpt.com/file-A' }, 'TAB_FETCH_URL_REJECTED'],
  ['foreign host', { url: 'https://example.com/file-A.png' }, 'TAB_FETCH_URL_REJECTED'],
  ['non-https URL', { url: 'http://files.oaiusercontent.com/file-A' }, 'TAB_FETCH_URL_REJECTED'],
  ['embedded URL credentials', { url: 'https://user:pass@files.oaiusercontent.com/file-A' }, 'TAB_FETCH_URL_REJECTED'],
  ['unknown provider', { url: CHATGPT_FILE_URL, provider: 'bogus' }, 'TAB_FETCH_URL_REJECTED'],
  ['declared size over the cap', { url: CHATGPT_FILE_URL, declaredBytes: TAB_FETCH_IMAGE_MAX_BYTES + 1 }, 'TAB_FETCH_SIZE_REJECTED'],
  ['invalid declared size', { url: CHATGPT_FILE_URL, declaredBytes: -1 }, 'TAB_FETCH_SIZE_REJECTED'],
  ['missing URL', { url: '' }, 'TAB_FETCH_URL_REJECTED'],
];

for (const [label, input, code] of PRE_FETCH_REFUSALS) {
  test(`GPT-15 relay: refuses ${label} before fetching`, async () => {
    const harness = fakeHarness();
    await assert.rejects(
      relayTabFetchImage(input, { fetchImpl: harness.fetchImpl, cryptoApi: webcrypto }),
      error => {
        assert.equal(error.code, code, `${label} carries its typed refusal code`);
        return true;
      },
    );
    assert.equal(harness.calls.length, 0, `the fetch must not be issued for ${label}`);
  });
}

test('GPT-15 relay: validateTabFetchImageRequest normalizes an acceptable request', () => {
  const validated = validateTabFetchImageRequest({ url: CHATGPT_PAGE_URL, declaredBytes: PNG_BYTES.length });
  assert.equal(validated.url, CHATGPT_PAGE_URL);
  assert.equal(validated.provider, 'chatgpt');
  assert.equal(validated.host, 'chatgpt.com');
  assert.equal(validated.declaredBytes, PNG_BYTES.length);
  assert.equal(validated.maxBytes, TAB_FETCH_IMAGE_MAX_BYTES);
});

// --- Header-stage refusals: body is never read --------------------------------

test('GPT-15 relay: refuses an oversized Content-Length before reading the body', async () => {
  const harness = fakeHarness({ contentLength: TAB_FETCH_IMAGE_MAX_BYTES + 1 });
  await assert.rejects(
    relayTabFetchImage({ url: CHATGPT_FILE_URL }, { fetchImpl: harness.fetchImpl, cryptoApi: webcrypto }),
    error => {
      assert.equal(error.code, 'TAB_FETCH_SIZE_REJECTED');
      return true;
    },
  );
  assert.equal(harness.calls.length, 1, 'the fetch was issued (headers are how the size is known)');
  assert.equal(harness.wasBodyRead(), false, 'the oversized body is never read');
  assert.equal(harness.wasBodyCancelled(), true, 'the refused body is cancelled');
});

test('GPT-15 relay: refuses a non-image response before reading the body', async () => {
  for (const contentType of ['text/html; charset=utf-8', 'application/json', 'video/mp4', '']) {
    const harness = fakeHarness({ contentType: contentType || null, bytes: new TextEncoder().encode('<html>nope</html>') });
    await assert.rejects(
      relayTabFetchImage({ url: CHATGPT_FILE_URL }, { fetchImpl: harness.fetchImpl, cryptoApi: webcrypto }),
      error => {
        assert.equal(error.code, 'TAB_FETCH_CONTENT_REJECTED', `"${contentType}" is not an accepted image type`);
        return true;
      },
    );
    assert.equal(harness.wasBodyRead(), false, `the non-image body (${contentType || 'no type'}) is never read`);
    assert.equal(harness.wasBodyCancelled(), true);
  }
});

test('GPT-15 relay: refuses an HTTP error status without returning bytes', async () => {
  const harness = fakeHarness({ status: 403 });
  await assert.rejects(
    relayTabFetchImage({ url: CHATGPT_FILE_URL }, { fetchImpl: harness.fetchImpl, cryptoApi: webcrypto }),
    error => {
      assert.equal(error.code, 'TAB_FETCH_FAILED');
      assert.match(error.message, /403/);
      return true;
    },
  );
  assert.equal(harness.wasBodyRead(), false);
});

// --- Post-read refusals ---------------------------------------------------------

test('GPT-15 relay: refuses actual bytes over the cap even with no Content-Length', async () => {
  const harness = fakeHarness({ contentLength: null });
  await assert.rejects(
    relayTabFetchImage(
      { url: CHATGPT_FILE_URL, maxBytes: 8 },
      { fetchImpl: harness.fetchImpl, cryptoApi: webcrypto },
    ),
    error => {
      assert.equal(error.code, 'TAB_FETCH_SIZE_REJECTED');
      return true;
    },
  );
  assert.equal(harness.wasBodyRead(), true, 'with no declared length the body must be read to know');
});

test('GPT-15 relay: refuses when the actual size disagrees with the declared size', async () => {
  const harness = fakeHarness({ contentLength: PNG_BYTES.length });
  await assert.rejects(
    relayTabFetchImage(
      { url: CHATGPT_FILE_URL, declaredBytes: PNG_BYTES.length + 5 },
      { fetchImpl: harness.fetchImpl, cryptoApi: webcrypto },
    ),
    error => {
      assert.equal(error.code, 'TAB_FETCH_SIZE_REJECTED');
      assert.match(error.message, /did not match/);
      return true;
    },
  );
});

test('GPT-15 relay: refuses an empty image body', async () => {
  const harness = fakeHarness({ bytes: new Uint8Array(0), contentLength: 0 });
  await assert.rejects(
    relayTabFetchImage({ url: CHATGPT_FILE_URL }, { fetchImpl: harness.fetchImpl, cryptoApi: webcrypto }),
    error => {
      assert.equal(error.code, 'TAB_FETCH_CONTENT_REJECTED');
      return true;
    },
  );
});

// --- Success contract -----------------------------------------------------------

test('GPT-15 relay: a ChatGPT file-CDN image returns the base64-out contract, fetched credentialed', async () => {
  const harness = fakeHarness({ contentLength: PNG_BYTES.length });
  const result = await relayTabFetchImage(
    { url: CHATGPT_FILE_URL, declaredBytes: PNG_BYTES.length },
    { fetchImpl: harness.fetchImpl, cryptoApi: webcrypto },
  );
  assert.equal(harness.calls.length, 1);
  assert.equal(harness.calls[0].url, CHATGPT_FILE_URL);
  // Credentialed in-tab execution semantics: the tab's own session
  // cookies ride the fetch, results are not cached, redirects follow.
  assert.equal(harness.calls[0].options.credentials, 'include');
  assert.equal(harness.calls[0].options.cache, 'no-store');
  assert.equal(harness.calls[0].options.redirect, 'follow');
  assert.ok(harness.calls[0].options.signal instanceof AbortSignal, 'the fetch carries the relay timeout signal');
  // Base64-out contract, mirroring readFlowDownloadChunk's shape.
  assert.equal(Buffer.from(result.data, 'base64').equals(Buffer.from(PNG_BYTES)), true);
  assert.equal(result.mime, 'image/png');
  assert.equal(result.size, PNG_BYTES.length);
  assert.equal(result.totalBytes, PNG_BYTES.length);
  assert.equal(result.provider, 'chatgpt');
  assert.equal(result.sha256, createHash('sha256').update(PNG_BYTES).digest('hex'));
});

test('GPT-15 relay: a chat-host estuary image and a Flow media image ride the same relay', async () => {
  const chatHarness = fakeHarness({ contentType: 'image/jpeg' });
  const chat = await relayTabFetchImage(
    { url: CHATGPT_PAGE_URL },
    { fetchImpl: chatHarness.fetchImpl, cryptoApi: webcrypto },
  );
  assert.equal(chat.mime, 'image/jpeg');
  assert.equal(chat.provider, 'chatgpt');

  const flowHarness = fakeHarness({ contentType: 'image/webp' });
  const flow = await relayTabFetchImage(
    { url: 'https://lh3.googleusercontent.com/media/signed-file', provider: 'flow' },
    { fetchImpl: flowHarness.fetchImpl, cryptoApi: webcrypto },
  );
  assert.equal(flow.mime, 'image/webp');
  assert.equal(flow.provider, 'flow', 'one relay implementation, generalized by the provider host table');
});

test('GPT-15 relay: a network failure surfaces as a typed fetch failure, never partial bytes', async () => {
  const harness = fakeHarness({ fetchError: new Error('socket closed') });
  await assert.rejects(
    relayTabFetchImage({ url: CHATGPT_FILE_URL }, { fetchImpl: harness.fetchImpl, cryptoApi: webcrypto }),
    error => {
      assert.equal(error.code, 'TAB_FETCH_FAILED');
      return true;
    },
  );
});

// --- The existing Flow chunk relay is untouched ---------------------------------

test('GPT-15 relay: readFlowDownloadChunk keeps its existing export and discipline', async () => {
  assert.equal(typeof relay.readFlowDownloadChunk, 'function');
  // A non-Flow download record still refuses before any fetch.
  let fetched = false;
  await assert.rejects(
    relay.readFlowDownloadChunk({ id: 3, index: 0, offset: 0, length: 2 }, {
      downloads: {
        search: async query => [{
          id: query.id, state: 'complete', referrer: 'https://example.com/x',
          url: 'https://example.com/download', finalUrl: 'https://lh3.googleusercontent.com/media/x', totalBytes: 5,
        }],
      },
      fetchImpl: async () => { fetched = true; throw new Error('must not fetch'); },
      cryptoApi: webcrypto,
    }),
    /not a completed Flow download/,
  );
  assert.equal(fetched, false);
});
