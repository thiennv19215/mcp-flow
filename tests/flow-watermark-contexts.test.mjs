import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

// DL-03 — Per-download interceptor contexts + cleaned/original reporting.
// DL-01 activated the watermark pipeline but left the interceptor arm a
// one-shot GLOBAL slot: the first image response after an arm consumes
// it, so an unrelated thumbnail/preview fetch can eat the arm and leave
// the real download uncleaned — and the outcome attribution ("any result
// event seen during the op") is guesswork. These tests pin the fix:
//  - the interceptor keeps per-download contexts keyed by operation id
//    (canonical URL + time window); a fetch is cleaned only when it
//    matches an armed `clean` context, an `original` context guarantees
//    its download is never cleaned, contexts are single-use and expire;
//  - the result event carries the operation id and an explicit outcome
//    (cleaned / original + reason / failed);
//  - media-menu attributes the outcome to the right download via the
//    operation id and the queue job result records
//    `watermark: {status: "cleaned"}` / `{status: "original", reason}`.

const interceptorSource = readFileSync(new URL('../extension/src/content/bridge/media-interceptor.js', import.meta.url), 'utf8');
const mediaMenuSource = readFileSync(new URL('../extension/src/content/providers/flow/media/media-menu.js', import.meta.url), 'utf8');

// ---------------------------------------------------------------------------
// Interceptor harness: run the REAL MAIN-world media-interceptor in a vm
// with a fake page fetch (per-URL canned image bodies), a fake
// WatermarkRemover, captured result events and captured window messages.
// ---------------------------------------------------------------------------
class FakeRemover {
  constructor(options = {}) { this.mask = options.mask; }
  async processBlob(blob) {
    const text = await blob.text();
    if (text.includes('WATERMARKED')) {
      return { blob: new Blob(['CLEANED-BYTES'], { type: blob.type || 'image/png' }), changed: true, nccBefore: 0.91, nccAfter: 0.04 };
    }
    return { blob, changed: false, reason: 'watermark_not_found' };
  }
  static async maskFromAlphaPng() { return { fakeMask: true }; }
}

function interceptorHarness() {
  const resultEvents = [];
  const replies = [];
  const messageListeners = [];
  const clickListeners = [];
  const bodies = new Map();
  let fakeNow = 1_700_000_000_000;
  let syntheticDownloads = 0;

  const nativeFetch = async input => {
    const url = typeof input === 'string' ? input : input?.url || '';
    const body = bodies.get(url) ?? 'PLAIN-BYTES';
    return new Response(new Blob([body], { type: 'image/png' }), {
      status: 200,
      headers: { 'content-type': 'image/png' },
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
    addEventListener(type, listener) { if (type === 'click') clickListeners.push(listener); },
    createElement() {
      return { href: '', download: '', click() { syntheticDownloads += 1; }, remove() {} };
    },
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
    setBody: (url, body) => bodies.set(url, body),
    fetch: (url, init) => windowFake.fetch(url, init),
    advanceTime: ms => { fakeNow += ms; },
    get syntheticDownloads() { return syntheticDownloads; },
    dispatchAnchorClick(anchor) {
      let prevented = false;
      const event = {
        target: { closest: selector => (selector === 'a[download]' ? anchor : null) },
        preventDefault() { prevented = true; },
        stopImmediatePropagation() {},
      };
      for (const listener of clickListeners) listener(event);
      return { prevented: () => prevented };
    },
    flush: async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); },
  };
}

const MEDIA_A = 'https://lh3.googleusercontent.com/media-a';
const MEDIA_B = 'https://lh3.googleusercontent.com/media-b';

test('DL-03 (a): an unrelated fetch cannot consume the arm — only the armed download is cleaned', async () => {
  const h = interceptorHarness();
  h.configure({ enabled: true, mask: { fakeMask: true } });
  h.setBody(`${MEDIA_A}=s2048`, 'WATERMARKED-A');
  h.setBody('https://lh3.googleusercontent.com/media-other=s512', 'WATERMARKED-OTHER');

  const reply = h.armViaMessage({ operationId: 'op-a', mode: 'clean', kind: 'image', url: `${MEDIA_A}=s1024`, timeoutMs: 60_000 });
  assert.equal(reply?.ok, true);
  assert.equal(reply?.operationId, 'op-a', 'the arm acknowledgement carries the operation id');

  const unrelated = await h.fetch('https://lh3.googleusercontent.com/media-other=s512');
  assert.equal(await unrelated.text(), 'WATERMARKED-OTHER', 'the unrelated fetch is returned untouched');
  assert.equal(h.resultEvents.length, 0, 'no outcome is reported for the unrelated fetch');

  const mine = await h.fetch(`${MEDIA_A}=s2048`);
  assert.equal(await mine.text(), 'CLEANED-BYTES', 'the armed download is still the one cleaned');
  assert.equal(h.resultEvents.length, 1);
  assert.equal(h.resultEvents[0].operationId, 'op-a', 'the outcome is attributed to the armed operation');
  assert.equal(h.resultEvents[0].status, 'cleaned');
  assert.equal(h.resultEvents[0].ok, true);

  const again = await h.fetch(`${MEDIA_A}=s2048`);
  assert.equal(await again.text(), 'WATERMARKED-A', 'the context is single-use: a repeat fetch is not cleaned');
  assert.equal(h.resultEvents.length, 1, 'no second outcome is reported');
});

test('DL-03 (a2): a download with no watermark reports original + not_found against its operation', async () => {
  const h = interceptorHarness();
  h.configure({ enabled: true, mask: { fakeMask: true } });
  h.setBody(`${MEDIA_A}=s2048`, 'PLAIN-A');
  h.armViaMessage({ operationId: 'op-plain', mode: 'clean', kind: 'image', url: MEDIA_A, timeoutMs: 60_000 });

  const response = await h.fetch(`${MEDIA_A}=s2048`);
  assert.equal(await response.text(), 'PLAIN-A', 'the original bytes are returned');
  assert.equal(h.resultEvents.length, 1);
  assert.equal(h.resultEvents[0].operationId, 'op-plain');
  assert.equal(h.resultEvents[0].status, 'original');
  assert.equal(h.resultEvents[0].reason, 'not_found', 'the remover not-found reason is normalized');
});

test('DL-03 (a3): an original context guarantees its download is not cleaned, even while another clean context is armed', async () => {
  const h = interceptorHarness();
  h.configure({ enabled: true, mask: { fakeMask: true } });
  h.setBody(`${MEDIA_A}=s2048`, 'WATERMARKED-A');
  h.setBody(`${MEDIA_B}=s2048`, 'WATERMARKED-B');
  h.armViaMessage({ operationId: 'op-clean-b', mode: 'clean', kind: 'image', url: MEDIA_B, timeoutMs: 60_000 });
  h.armViaMessage({ operationId: 'op-original-a', mode: 'original', kind: 'image', url: MEDIA_A, timeoutMs: 60_000 });

  const a = await h.fetch(`${MEDIA_A}=s2048`);
  assert.equal(await a.text(), 'WATERMARKED-A', 'the original-context download is never cleaned');
  const aOutcome = h.resultEvents.find(event => event.operationId === 'op-original-a');
  assert.ok(aOutcome, 'the original outcome is reported against its operation');
  assert.equal(aOutcome.status, 'original');

  const b = await h.fetch(`${MEDIA_B}=s2048`);
  assert.equal(await b.text(), 'CLEANED-BYTES', 'the clean context still cleans its own download');
  assert.equal(h.resultEvents.find(event => event.operationId === 'op-clean-b')?.status, 'cleaned');
});

test('DL-03 (c): an expired context cleans nothing', async () => {
  const h = interceptorHarness();
  h.configure({ enabled: true, mask: { fakeMask: true } });
  h.setBody(`${MEDIA_A}=s2048`, 'WATERMARKED-A');
  h.armViaMessage({ operationId: 'op-old', mode: 'clean', kind: 'image', url: MEDIA_A, timeoutMs: 5_000 });
  h.advanceTime(6_000);

  const stale = await h.fetch(`${MEDIA_A}=s2048`);
  assert.equal(await stale.text(), 'WATERMARKED-A', 'an expired context must not clean');
  assert.equal(h.resultEvents.length, 0, 'an expired context reports no outcome');

  // A fresh arm after expiry works normally (regression pin).
  h.armViaMessage({ operationId: 'op-fresh', mode: 'clean', kind: 'image', url: MEDIA_A, timeoutMs: 60_000 });
  const fresh = await h.fetch(`${MEDIA_A}=s2048`);
  assert.equal(await fresh.text(), 'CLEANED-BYTES');
  assert.equal(h.resultEvents[0]?.operationId, 'op-fresh');
});

test('DL-03 (a4): an anchor download binds the armed unbound context and reports against its operation', async () => {
  const h = interceptorHarness();
  h.configure({ enabled: true, mask: { fakeMask: true } });
  const href = 'https://lh3.googleusercontent.com/media-z=s1024';
  h.setBody(href, 'WATERMARKED-Z');
  h.armViaMessage({ operationId: 'op-anchor', mode: 'clean', kind: 'image', timeoutMs: 60_000 });

  let nativeClicks = 0;
  const anchor = { href, download: 'z.png', dataset: {}, click() { nativeClicks += 1; } };
  const { prevented } = h.dispatchAnchorClick(anchor);
  await h.flush();
  assert.equal(prevented(), true, 'the anchor click is intercepted for cleaning');
  assert.equal(h.syntheticDownloads, 1, 'a synthetic blob download delivers the cleaned bytes');
  assert.equal(nativeClicks, 0, 'the original anchor click is not replayed on success');
  assert.equal(h.resultEvents.length, 1);
  assert.equal(h.resultEvents[0].operationId, 'op-anchor');
  assert.equal(h.resultEvents[0].status, 'cleaned');
});

test('DL-03 (a5): an anchor download under an original context proceeds natively and reports original', async () => {
  const h = interceptorHarness();
  h.configure({ enabled: true, mask: { fakeMask: true } });
  const href = 'https://lh3.googleusercontent.com/media-z=s1024';
  h.setBody(href, 'WATERMARKED-Z');
  h.armViaMessage({ operationId: 'op-anchor-original', mode: 'original', kind: 'image', timeoutMs: 60_000 });

  let nativeClicks = 0;
  const anchor = { href, download: 'z.png', dataset: {}, click() { nativeClicks += 1; } };
  const { prevented } = h.dispatchAnchorClick(anchor);
  await h.flush();
  assert.equal(prevented(), false, 'an original context never intercepts the click');
  assert.equal(h.syntheticDownloads, 0, 'no synthetic download is triggered');
  const outcome = h.resultEvents.find(event => event.operationId === 'op-anchor-original');
  assert.ok(outcome, 'the original outcome is reported against its operation');
  assert.equal(outcome.status, 'original');
});

// ---------------------------------------------------------------------------
// media-menu harness: drive the REAL triggerFlowDownload (DL-01 pattern),
// capturing the posted arm messages and firing interceptor result events
// during the download click.
// ---------------------------------------------------------------------------
function downloadHarness({ config = {}, fireResult = null } = {}) {
  const posted = [];
  let resultListener = null;
  let menuOpen = false;

  const cloneStub = () => ({ querySelectorAll: () => [], innerText: '', textContent: '' });
  const imgEl = {
    tagName: 'IMG',
    currentSrc: 'https://lh3.googleusercontent.com/media-1',
    complete: true,
    naturalWidth: 64,
    getAttribute(name) { return name === 'src' ? this.currentSrc : null; },
    dispatchEvent() { return true; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 20, height: 20 }; },
  };
  const moreBtn = {
    disabled: false,
    getAttribute() { return null; },
    querySelector(sel) { return sel.includes('mat-icon') ? { textContent: 'more_vert' } : null; },
    cloneNode() { return cloneStub(); },
    click() { menuOpen = true; },
  };
  const downloadItem = {
    disabled: false,
    getAttribute() { return null; },
    querySelector(sel) { return sel.includes('.label') ? { innerText: 'Download', textContent: 'Download' } : null; },
    cloneNode() { return cloneStub(); },
    click() {
      if (fireResult && resultListener) {
        const arms = posted.filter(message => message?.source === 'flow-mcp-watermark-v1' && message?.action === 'arm');
        resultListener({ detail: fireResult(arms) });
      }
    },
  };
  const tile = {
    __id: 'media-1',
    isConnected: true,
    scrollIntoView() {},
    getAttribute() { return null; },
    querySelector(sel) {
      if (sel === 'flow-video-tile') return null;
      if (sel === 'img,video,[role=img]' || sel === 'img' || sel === 'img,video') return imgEl;
      return null;
    },
    querySelectorAll(sel) {
      if (sel === 'button,[role="button"]') return [moreBtn];
      if (sel === '*') return [];
      return [imgEl];
    },
  };
  const documentFake = {
    visibilityState: 'visible',
    querySelectorAll(sel) {
      if (sel === 'flow-grid-tile-container') return [tile];
      if (sel === '[role="menuitem"],button') return menuOpen ? [downloadItem] : [];
      return [];
    },
  };
  const sandbox = {
    console,
    URL,
    atob,
    setTimeout,
    clearTimeout,
    HTMLVideoElement: class {},
    HTMLImageElement: class {},
    PointerEvent: class {},
    MouseEvent: class {},
    KeyboardEvent: class {},
    Event: class {},
    location: { origin: 'https://flow.google.com', href: 'https://flow.google.com/project/11111111-1111-4111-8111-111111111111' },
    window: { postMessage: message => posted.push(message) },
    document: documentFake,
    chrome: {
      storage: { local: { get: async () => ({ flowWatermark: config }) } },
      runtime: { sendMessage: async () => ({ ok: true }) },
    },
    addEventListener(type, listener) { if (type === 'TOBY_FLOW_WATERMARK_RESULT') resultListener = listener; },
    flowError: (code, message, retryable, outcomeUnknown) =>
      Object.assign(new Error(message), { code, retryable, outcome_unknown: outcomeUnknown }),
    wait: async () => {},
    visible: () => true,
    mediaId: candidate => candidate.__id,
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(mediaMenuSource, context);
  return { run: (options = {}) => context.triggerFlowDownload('scene one', 'original', 'media-1', options) };
}

// Minimal valid alpha-PNG mask fixture (same construction as DL-01 tests).
function crc32(buf) {
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xFFFFFFFF;
  for (const byte of buf) crc = table[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
function alphaPngBase64() {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const scanline = Buffer.from([0, 255, 0, 0, 255]);
  let a = 1, b = 0;
  for (const byte of scanline) { a = (a + byte) % 65521; b = (b + a) % 65521; }
  const adler = Buffer.alloc(4);
  adler.writeUInt32BE(((b << 16) | a) >>> 0);
  const len = Buffer.alloc(2); len.writeUInt16LE(scanline.length);
  const nlen = Buffer.alloc(2); nlen.writeUInt16LE((~scanline.length) & 0xFFFF);
  const idat = Buffer.concat([Buffer.from([0x78, 0x01, 0x01]), len, nlen, scanline, adler]);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}
const ALPHA_PNG_B64 = alphaPngBase64();
const CLEAN_CONFIG = { enabled: true, alpha_png_b64: ALPHA_PNG_B64 };

test('DL-03 (b1): media-menu attributes the outcome carrying its own operation id', async () => {
  const harness = downloadHarness({
    config: CLEAN_CONFIG,
    fireResult: arms => ({
      ok: true, changed: true, kind: 'image', status: 'cleaned',
      operationId: arms[0]?.options?.operationId,
    }),
  });
  const result = await harness.run();
  assert.equal(result.watermark?.armed, true);
  assert.ok(result.watermark?.operationId, 'the download result records the operation id');
  assert.equal(result.watermark?.status, 'cleaned');
  assert.equal(result.watermark?.cleaned, true);
});

test('DL-03 (b2): an outcome for a DIFFERENT operation is never attributed to this download', async () => {
  const harness = downloadHarness({
    config: CLEAN_CONFIG,
    fireResult: () => ({ ok: true, changed: true, kind: 'image', status: 'cleaned', operationId: 'some-other-operation' }),
  });
  const result = await harness.run();
  assert.equal(result.watermark?.armed, true);
  assert.equal(result.watermark?.cleaned, null, 'a foreign outcome must not be claimed');
  assert.equal(result.watermark?.status, 'unknown', 'no attributed outcome → honest unknown, never invented');
});

test('DL-03 (b3): a not-found outcome is recorded as original + not_found on the download result', async () => {
  const harness = downloadHarness({
    config: CLEAN_CONFIG,
    fireResult: arms => ({
      ok: true, changed: false, kind: 'image', status: 'original', reason: 'not_found',
      operationId: arms[0]?.options?.operationId,
    }),
  });
  const result = await harness.run();
  assert.equal(result.watermark?.cleaned, false);
  assert.equal(result.watermark?.status, 'original');
  assert.equal(result.watermark?.outcomeReason, 'not_found');
});

// ---------------------------------------------------------------------------
// Queue layer: the op-level watermark fields are mapped into the job
// result status shape on the browser download entry.
// ---------------------------------------------------------------------------
async function queueDownloadWatermark(opWatermark) {
  const completedItem = {
    id: 42,
    state: 'complete',
    filename: 'C:\\Downloads\\scene-one.png',
    tabId: 5,
    url: 'https://flow.google.com/asb/abcd1234-media-id',
    finalUrl: 'https://flow.google.com/asb/abcd1234-media-id',
    referrer: 'https://flow.google.com/',
    startTime: new Date().toISOString(),
  };
  let searchCount = 0;
  globalThis.chrome = {
    runtime: { id: 'test-extension' },
    downloads: {
      search: async query => {
        if (query && 'query' in query) return [];
        if (query && 'id' in query) return [];
        searchCount += 1;
        return searchCount === 1 ? [] : [completedItem];
      },
    },
  };
  try {
    const { downloadQueueMedia } = await import('../extension/src/background/flow-queue-downloads.js');
    const invoke = async () => ({ downloadTriggered: true, watermark: opWatermark });
    const hooks = { progress: async () => {}, signal: undefined };
    const downloads = await downloadQueueMedia(
      [{ id: 'abcd1234-media-id', title: 'scene one', kind: 'image' }],
      '', 'scene-one', 'original', invoke, hooks, [], 'job-1', 5, '', null, 'clean',
    );
    assert.equal(downloads.length, 1);
    return downloads[0].watermark;
  } finally {
    delete globalThis.chrome;
  }
}

test('DL-03 (b4): a cleaned download yields job result watermark {status: "cleaned"}', async () => {
  const watermark = await queueDownloadWatermark({ mode: 'clean', armed: true, cleaned: true, status: 'cleaned', operationId: 'op-1' });
  assert.equal(watermark?.status, 'cleaned');
  assert.equal(watermark?.cleaned, true);
  assert.equal(watermark?.mode, 'clean', 'DL-01 op-level fields are preserved');
  assert.equal(watermark?.armed, true);
});

test('DL-03 (b5): a no-watermark download yields job result watermark {status: "original", reason: "not_found"}', async () => {
  const watermark = await queueDownloadWatermark({ mode: 'clean', armed: true, cleaned: false, status: 'original', outcomeReason: 'not_found', operationId: 'op-2' });
  assert.deepEqual(
    { status: watermark?.status, reason: watermark?.reason },
    { status: 'original', reason: 'not_found' },
  );
  assert.equal(watermark?.cleaned, false);
});

test('DL-03 (b6): a failed cleaning yields job result watermark {status: "failed", reason}', async () => {
  const watermark = await queueDownloadWatermark({ mode: 'clean', armed: true, cleaned: false, status: 'failed', outcomeReason: 'verification_failed', operationId: 'op-3' });
  assert.deepEqual(
    { status: watermark?.status, reason: watermark?.reason },
    { status: 'failed', reason: 'verification_failed' },
  );
});

test('DL-03 (b7): legacy op results without a status are mapped honestly', async () => {
  const unknown = await queueDownloadWatermark({ mode: 'clean', armed: true, cleaned: null });
  assert.equal(unknown?.status, 'unknown', 'armed + no observed outcome stays unknown');
  assert.equal(unknown?.cleaned, null);

  const original = await queueDownloadWatermark({ mode: 'original', armed: true, cleaned: false, reason: 'explicit_original' });
  assert.equal(original?.status, 'original');
  assert.equal(original?.reason, 'explicit_original', 'the arm reason explains an original-by-mode result');
});
