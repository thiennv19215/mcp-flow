import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

// DL-10 — Already-clean fingerprint registry (interceptor half).
// Cleaned outputs are fingerprinted (SHA-256 of bytes+mime) into a
// bounded set in the MAIN-world interceptor. When bytes that match a
// recorded cleaned output flow through the pipeline a second time
// (cleaned bytes being re-fetched, the manual tool applied twice), the
// run must short-circuit with the already-clean outcome and return the
// bytes unchanged instead of invoking the remover again — re-running
// the remover on clean bytes wastes time and can degrade quality.
// Only successful CLEANED outputs may be recorded: recording anything
// else would poison the registry and skip cleaning for dirty bytes.

const interceptorSource = readFileSync(new URL('../extension/src/content/bridge/media-interceptor.js', import.meta.url), 'utf8');

// ---------------------------------------------------------------------------
// Interceptor harness: the REAL media-interceptor in a vm, with a fake
// page fetch (per-URL canned bodies + mime types), a counting fake
// WatermarkRemover whose cleaned output echoes its input (so outputs
// are distinct per input), captured result events and window messages.
// ---------------------------------------------------------------------------
let processCalls = 0;
class FakeRemover {
  constructor(options = {}) { this.mask = options.mask; }
  async processBlob(blob) {
    processCalls += 1;
    const text = await blob.text();
    if (text.includes('BOOM')) throw new Error('remover exploded');
    if (text.includes('WATERMARKED')) {
      return { blob: new Blob([`CLEANED(${text})`], { type: blob.type || 'image/png' }), changed: true, nccBefore: 0.91, nccAfter: 0.04 };
    }
    return { blob, changed: false, reason: 'watermark_not_found' };
  }
  static async maskFromAlphaPng() { return { fakeMask: true }; }
}

function interceptorHarness() {
  processCalls = 0;
  const resultEvents = [];
  const replies = [];
  const messageListeners = [];
  const bodies = new Map(); // url -> { body, type }
  let fakeNow = 1_700_000_000_000;

  const nativeFetch = async input => {
    const url = typeof input === 'string' ? input : input?.url || '';
    const entry = bodies.get(url) ?? { body: 'PLAIN-BYTES', type: 'image/png' };
    return new Response(new Blob([entry.body], { type: entry.type }), {
      status: 200,
      headers: { 'content-type': entry.type },
    });
  };

  class FakeURL extends URL {}
  FakeURL.createObjectURL = () => 'blob:fake-object-url';
  FakeURL.revokeObjectURL = () => {};

  const windowFake = {
    fetch: nativeFetch,
    dispatchEvent(event) {
      if (event?.type === 'TOBY_FLOW_WATERMARK_RESULT') resultEvents.push(event.detail);
      return true;
    },
    addEventListener(type, listener) { if (type === 'message') messageListeners.push(listener); },
    postMessage(message) { replies.push(message); },
    WatermarkRemover: FakeRemover,
  };
  const documentFake = {
    addEventListener() {},
    createElement() { return { href: '', download: '', click() {}, remove() {} }; },
    body: { appendChild() {} },
  };
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    URL: FakeURL,
    Headers,
    Request,
    Response,
    Blob,
    TextEncoder,
    crypto: globalThis.crypto,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    Date: { now: () => fakeNow },
    location: { href: 'https://flow.google.com/project/abc', origin: 'https://flow.google.com' },
    window: windowFake,
    document: documentFake,
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(interceptorSource, context);
  const api = windowFake.__flowMcpMediaInterceptor;
  assert.ok(api, 'the interceptor exposes its API');

  const armViaMessage = options => {
    const requestId = `req-${replies.length + 1}`;
    for (const listener of messageListeners) {
      listener({ source: windowFake, data: { source: 'flow-mcp-watermark-v1', action: 'arm', requestId, options } });
    }
    return replies.filter(message => message?.requestId === requestId).at(-1);
  };

  return {
    resultEvents,
    api,
    armViaMessage,
    configure: options => api.configure(options),
    setBody: (url, body, type = 'image/png') => bodies.set(url, { body, type }),
    fetch: (url, init) => windowFake.fetch(url, init),
    get processCalls() { return processCalls; },
    get registrySize() { return api.state.cleanedFingerprints?.length; },
  };
}

const MEDIA = id => `https://lh3.googleusercontent.com/${id}`;

test('DL-10 (spec): cleaned bytes fed through the pipeline a second time short-circuit as already_clean, remover not invoked, bytes unchanged', async () => {
  const h = interceptorHarness();
  h.configure({ enabled: true, mask: { fakeMask: true } });

  // First pass: a watermarked fixture is cleaned and its output recorded.
  h.setBody(MEDIA('first'), 'WATERMARKED-A');
  h.armViaMessage({ operationId: 'op-first', mode: 'clean', kind: 'image', url: MEDIA('first'), timeoutMs: 60_000 });
  const first = await h.fetch(MEDIA('first'));
  const cleanedBytes = await first.text();
  assert.equal(cleanedBytes, 'CLEANED(WATERMARKED-A)');
  assert.equal(h.resultEvents.find(e => e.operationId === 'op-first')?.status, 'cleaned');
  assert.equal(h.processCalls, 1, 'the remover ran once for the first pass');
  assert.equal(h.registrySize, 1, 'the cleaned output fingerprint is recorded');

  // Second pass: the cleaned bytes themselves flow through the pipeline
  // (e.g. cleaned bytes being re-fetched under a fresh download arm).
  h.setBody(MEDIA('second'), cleanedBytes);
  h.armViaMessage({ operationId: 'op-second', mode: 'clean', kind: 'image', url: MEDIA('second'), timeoutMs: 60_000 });
  const second = await h.fetch(MEDIA('second'));
  assert.equal(await second.text(), cleanedBytes, 'the bytes are returned unchanged');
  assert.equal(h.processCalls, 1, 'the remover is NOT invoked on the second pass');
  const outcome = h.resultEvents.find(e => e.operationId === 'op-second');
  assert.ok(outcome, 'the second pass still reports an outcome');
  assert.equal(outcome.status, 'original', 'already-clean reports under the original status family');
  assert.equal(outcome.reason, 'already_clean', 'the already-clean reason is distinguishable from not_found');
  assert.equal(outcome.ok, true);
  assert.equal(outcome.changed, false);
  assert.equal(h.registrySize, 1, 'a short-circuit records nothing new');
});

test('DL-10 (control): unrecorded bytes are processed by the remover normally', async () => {
  const h = interceptorHarness();
  h.configure({ enabled: true, mask: { fakeMask: true } });
  h.setBody(MEDIA('plain'), 'PLAIN-BYTES');
  h.armViaMessage({ operationId: 'op-plain', mode: 'clean', kind: 'image', url: MEDIA('plain'), timeoutMs: 60_000 });

  const response = await h.fetch(MEDIA('plain'));
  assert.equal(await response.text(), 'PLAIN-BYTES');
  assert.equal(h.processCalls, 1, 'unrecorded bytes still go through the remover');
  const outcome = h.resultEvents.find(e => e.operationId === 'op-plain');
  assert.equal(outcome.status, 'original');
  assert.equal(outcome.reason, 'not_found', 'a never-cleaned original keeps the not_found reason');
  assert.equal(h.registrySize, 0, 'an unchanged (not cleaned) result records nothing');
});

test('DL-10 (control): a failed cleaning records nothing — the same bytes are processed again on a later pass', async () => {
  const h = interceptorHarness();
  h.configure({ enabled: true, mask: { fakeMask: true } });
  h.setBody(MEDIA('boom'), 'BOOM-WATERMARKED');
  h.armViaMessage({ operationId: 'op-boom-1', mode: 'clean', kind: 'image', url: MEDIA('boom'), timeoutMs: 60_000 });

  await h.fetch(MEDIA('boom'));
  const failed = h.resultEvents.find(e => e.operationId === 'op-boom-1');
  assert.equal(failed.status, 'failed');
  assert.equal(h.registrySize, 0, 'a failed cleaning must not record a fingerprint');

  h.armViaMessage({ operationId: 'op-boom-2', mode: 'clean', kind: 'image', url: MEDIA('boom'), timeoutMs: 60_000 });
  await h.fetch(MEDIA('boom'));
  assert.equal(h.processCalls, 2, 'no short-circuit after a failure: the remover runs again');
  assert.equal(h.resultEvents.find(e => e.operationId === 'op-boom-2')?.status, 'failed');
});

test('DL-10 (mime): the same bytes under a different mime type do not hit the registry', async () => {
  const h = interceptorHarness();
  h.configure({ enabled: true, mask: { fakeMask: true } });
  h.setBody(MEDIA('png'), 'WATERMARKED-M', 'image/png');
  h.armViaMessage({ operationId: 'op-png', mode: 'clean', kind: 'image', url: MEDIA('png'), timeoutMs: 60_000 });
  const cleaned = await (await h.fetch(MEDIA('png'))).text();
  assert.equal(h.registrySize, 1);

  // Identical byte content, but delivered as image/jpeg: the fingerprint
  // covers bytes+mime, so this is a different registry entry.
  h.setBody(MEDIA('jpeg'), cleaned, 'image/jpeg');
  h.armViaMessage({ operationId: 'op-jpeg', mode: 'clean', kind: 'image', url: MEDIA('jpeg'), timeoutMs: 60_000 });
  await h.fetch(MEDIA('jpeg'));
  assert.equal(h.processCalls, 2, 'a different mime misses the registry and reaches the remover');
  assert.notEqual(h.resultEvents.find(e => e.operationId === 'op-jpeg')?.reason, 'already_clean');
});

test('DL-10 (eviction): the registry is bounded with oldest-first eviction', async () => {
  const h = interceptorHarness();
  h.configure({ enabled: true, mask: { fakeMask: true } });

  const outputs = [];
  for (let i = 0; i < 65; i++) {
    const url = MEDIA(`evict-${i}`);
    h.setBody(url, `WATERMARKED-${i}`);
    h.armViaMessage({ operationId: `op-evict-${i}`, mode: 'clean', kind: 'image', url, timeoutMs: 60_000 });
    outputs.push(await (await h.fetch(url)).text());
  }
  assert.equal(h.registrySize, 64, 'the registry never grows past its cap');

  // The most recent cleaned output still short-circuits.
  const callsBefore = h.processCalls;
  h.setBody(MEDIA('evict-recent'), outputs[64]);
  h.armViaMessage({ operationId: 'op-evict-recent', mode: 'clean', kind: 'image', url: MEDIA('evict-recent'), timeoutMs: 60_000 });
  await h.fetch(MEDIA('evict-recent'));
  assert.equal(h.processCalls, callsBefore, 'the newest fingerprint still hits');
  assert.equal(h.resultEvents.find(e => e.operationId === 'op-evict-recent')?.reason, 'already_clean');

  // The oldest cleaned output was evicted: it is processed again.
  h.setBody(MEDIA('evict-oldest'), outputs[0]);
  h.armViaMessage({ operationId: 'op-evict-oldest', mode: 'clean', kind: 'image', url: MEDIA('evict-oldest'), timeoutMs: 60_000 });
  await h.fetch(MEDIA('evict-oldest'));
  assert.equal(h.processCalls, callsBefore + 1, 'the evicted oldest fingerprint misses and reaches the remover');
  assert.notEqual(h.resultEvents.find(e => e.operationId === 'op-evict-oldest')?.reason, 'already_clean');
});

test('DL-10 (precedence): an original-mode context still reports mode_original for already-clean bytes', async () => {
  const h = interceptorHarness();
  h.configure({ enabled: true, mask: { fakeMask: true } });
  h.setBody(MEDIA('seed'), 'WATERMARKED-S');
  h.armViaMessage({ operationId: 'op-seed', mode: 'clean', kind: 'image', url: MEDIA('seed'), timeoutMs: 60_000 });
  const cleaned = await (await h.fetch(MEDIA('seed'))).text();
  assert.equal(h.registrySize, 1);

  h.setBody(MEDIA('orig'), cleaned);
  h.armViaMessage({ operationId: 'op-orig', mode: 'original', kind: 'image', url: MEDIA('orig'), timeoutMs: 60_000 });
  const response = await h.fetch(MEDIA('orig'));
  assert.equal(await response.text(), cleaned, 'the original context returns the bytes untouched');
  const outcome = h.resultEvents.find(e => e.operationId === 'op-orig');
  assert.equal(outcome.status, 'original');
  assert.equal(outcome.reason, 'mode_original', 'the explicit original mode keeps precedence over the fingerprint short-circuit');
});
