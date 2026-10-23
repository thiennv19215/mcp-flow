import test from 'node:test';
import assert from 'node:assert/strict';

// GPT-15 — Download provenance for ChatGPT results (study (E)15, §D.3.5).
// ChatGPT result URLs live on the chat host (chatgpt.com — the
// backend-api estuary/file URLs GPT-04's result-image tier matches) and
// on the file-CDN host family (*.oaiusercontent.com — GPT-04's cdn-image
// tier). The download pipeline's provenance rules must accept exactly
// those hosts and reject foreign / lookalike hosts. Matching is
// exact-host or proper-subdomain (dot boundary) only, never substring:
// evil-oaiusercontent.com, oaiusercontent.com.evil.com,
// chatgpt.com.evil.com and notchatgpt.com must all be rejected.
//
// Flow provenance is the control group: its existing predicate
// (queueDownloadIsFlowPageUrl / isFlowMediaHost semantics) must behave
// byte-identically, and the new provider-keyed matcher must agree with
// it on every Flow row.

const downloads = await import('../extension/src/background/flow-queue-downloads.js');

const {
  CHATGPT_DOWNLOAD_HOST_BASES,
  DOWNLOAD_PROVENANCE_HOST_BASES,
  isChatGptDownloadHost,
  isProviderDownloadHost,
  queueDownloadIsChatGptUrl,
  queueDownloadProvenance,
  queueDownloadIsFlowPageUrl,
} = downloads;

// --- Host table ------------------------------------------------------------

test('GPT-15 provenance: the ChatGPT host table is exactly the chat host + file-CDN host', () => {
  assert.equal(typeof isChatGptDownloadHost, 'function', 'queue-downloads exports the ChatGPT host predicate');
  assert.deepEqual([...CHATGPT_DOWNLOAD_HOST_BASES], ['chatgpt.com', 'oaiusercontent.com']);
  assert.ok(Object.isFrozen(CHATGPT_DOWNLOAD_HOST_BASES), 'the host table is frozen');
  assert.deepEqual([...DOWNLOAD_PROVENANCE_HOST_BASES.chatgpt], ['chatgpt.com', 'oaiusercontent.com']);
  assert.deepEqual(
    [...DOWNLOAD_PROVENANCE_HOST_BASES.flow],
    ['flow.google.com', 'labs.google', 'storage.googleapis.com', 'googleusercontent.com', 'googleapis.com', 'usercontent.goog'],
    'the Flow row of the table lists exactly the bases the legacy Flow matcher accepts',
  );
  assert.ok(Object.isFrozen(DOWNLOAD_PROVENANCE_HOST_BASES));
});

// --- Accepted ChatGPT hosts --------------------------------------------------

const ACCEPTED_CHATGPT_URLS = [
  // Tier 2 (result-image): file/content URLs on the chat host itself.
  'https://chatgpt.com/backend-api/estuary/content?id=file_ABC123&ts=9',
  'https://chatgpt.com/backend-api/files/file-ABC123',
  'https://chatgpt.com/c/123e4567-e89b-12d3-a456-426614174000',
  // Tier 3 (cdn-image): the file-CDN host and its proper subdomains.
  'https://files.oaiusercontent.com/file-AAA111?sig=one',
  'https://oaiusercontent.com/file-AAA111',
  'https://cdn.oaiusercontent.com/media/image.png',
  // A proper subdomain of the chat host.
  'https://assets.chatgpt.com/image.png',
];

for (const url of ACCEPTED_CHATGPT_URLS) {
  test(`GPT-15 provenance: accepted ChatGPT URL ${url}`, () => {
    const hostname = new URL(url).hostname;
    assert.equal(isChatGptDownloadHost(hostname), true, `${hostname} is a ChatGPT download host`);
    assert.equal(isProviderDownloadHost(hostname, 'chatgpt'), true);
    assert.equal(queueDownloadIsChatGptUrl(url), true);
    assert.equal(queueDownloadProvenance(url), 'chatgpt');
  });
}

test('GPT-15 provenance: host matching is case-insensitive', () => {
  assert.equal(isChatGptDownloadHost('FILES.OAIUSERCONTENT.COM'), true);
  assert.equal(isChatGptDownloadHost('ChatGPT.com'), true);
  assert.equal(queueDownloadIsChatGptUrl('https://FILES.OAIUSERCONTENT.COM/file-A'), true);
});

// --- Rejected lookalike / foreign hosts --------------------------------------

const REJECTED_CHATGPT_URLS = [
  'https://evil-oaiusercontent.com/file-AAA111', // hyphen lookalike, not a subdomain
  'https://oaiusercontent.com.evil.com/file-AAA111', // CDN host as a subdomain of evil.com
  'https://chatgpt.com.evil.com/backend-api/estuary/content?id=file_ABC123',
  'https://notchatgpt.com/backend-api/estuary/content?id=file_ABC123',
  'https://evilchatgpt.com/file-AAA111',
  'https://chatgptx.com/file-AAA111',
  'https://xoaiusercontent.com/file-AAA111',
  'https://google.com/file-AAA111', // foreign host
  'https://storage.googleapis.com/file-AAA111', // a Flow media host is not a ChatGPT host
  'https://chatgpt.com@evil.com/file-AAA111', // userinfo trick: the real host is evil.com
  'https://user:pass@chatgpt.com/file-AAA111', // embedded credentials are never provenance
  'http://chatgpt.com/backend-api/estuary/content?id=file_ABC123', // https only
  'http://files.oaiusercontent.com/file-AAA111',
  'ftp://chatgpt.com/file-AAA111',
];

for (const url of REJECTED_CHATGPT_URLS) {
  test(`GPT-15 provenance: rejected ChatGPT URL ${url}`, () => {
    assert.equal(queueDownloadIsChatGptUrl(url), false, `${url} must not pass ChatGPT provenance`);
    assert.notEqual(queueDownloadProvenance(url), 'chatgpt', `${url} must not be attributed to chatgpt`);
  });
}

test('GPT-15 provenance: lookalike hostnames are rejected at the host predicate itself', () => {
  for (const hostname of [
    'evil-oaiusercontent.com',
    'oaiusercontent.com.evil.com',
    'chatgpt.com.evil.com',
    'notchatgpt.com',
    'evilchatgpt.com',
    'chatgpt.comm',
    'oaiusercontent.comm',
    'chatgpt.com.',
    '',
  ]) {
    assert.equal(isChatGptDownloadHost(hostname), false, `${hostname || '(empty)'} must be rejected`);
    assert.equal(isProviderDownloadHost(hostname, 'chatgpt'), false, `${hostname || '(empty)'} must be rejected`);
  }
});

test('GPT-15 provenance: malformed and empty values are rejected, never thrown on', () => {
  for (const value of ['', null, undefined, 'not a url', 'chatgpt.com/file', '//chatgpt.com/file', 42]) {
    assert.equal(queueDownloadIsChatGptUrl(value), false, `${String(value)} must be rejected`);
    assert.equal(queueDownloadProvenance(value), null, `${String(value)} has no provenance`);
  }
});

// --- Flow control group: byte-identical provenance ---------------------------

const FLOW_URL_ROWS = [
  ['https://flow.google.com/project/123e4567-e89b-12d3-a456-426614174000', true],
  ['https://labs.google/fx/tools/flow/project/x', true],
  ['https://storage.googleapis.com/media/file.png', true],
  ['https://lh3.googleusercontent.com/media/signed-file', true],
  ['https://googleusercontent.com/media/file.png', true],
  ['https://flow.google.com.evil.com/project/x', false],
  ['https://evilflow.google.com/project/x', false],
  ['https://notlabs.google/x', false],
  ['https://google.com/x', false],
];

for (const [url, expected] of FLOW_URL_ROWS) {
  test(`GPT-15 provenance: Flow row unchanged for ${url}`, () => {
    const hostname = new URL(url).hostname;
    assert.equal(queueDownloadIsFlowPageUrl(url), expected, 'the legacy Flow predicate keeps its verdict');
    assert.equal(isProviderDownloadHost(hostname, 'flow'), expected, 'the provider-keyed matcher agrees with the legacy Flow predicate');
    assert.equal(isChatGptDownloadHost(hostname), false, 'a Flow host is never a ChatGPT host');
    assert.equal(queueDownloadProvenance(url), expected ? 'flow' : null);
  });
}

test('GPT-15 provenance: unknown providers fail closed', () => {
  assert.equal(isProviderDownloadHost('chatgpt.com', 'bogus'), false);
  assert.equal(isProviderDownloadHost('chatgpt.com'), false, 'a provider key is required');
  assert.equal(isProviderDownloadHost('chatgpt.com', ''), false);
});
