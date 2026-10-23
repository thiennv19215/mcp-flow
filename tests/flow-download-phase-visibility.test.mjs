import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

// DL-12 — Download phase visibility (fetching → cleaning → saving).
// The queue reports only download/downloading/complete/failed, so a user
// watching a download cannot tell fetching from cleaning from saving —
// which matters when cleaning a large file takes a while (study D21,
// gap G12). These tests pin the fix across the three layers in scope:
//  - the MAIN-world interceptor emits attributed phase signals
//    (TOBY_FLOW_WATERMARK_PHASE) around fetch / clean / save, alongside
//    the DL-03 TOBY_FLOW_WATERMARK_RESULT outcome event;
//  - media-menu collects the signals FOR ITS OWN operation id only,
//    builds the HONEST phase sequence for the saved file (a
//    no-watermark outcome emits original → saving and never claims a
//    cleaning phase; a failed cleaning ends in a terminal
//    cleaning_failed phase, never a stuck "cleaning"), and returns it
//    on the op result's watermark.phases;
//  - the queue download op forwards those phases onto the job's
//    existing progress stream (hooks.progress), mapping them onto
//    download_fetching / download_cleaning / download_original /
//    download_saving / download_cleaning_failed while download.state
//    stays in the existing vocabulary ("downloading").
// Attribution is DL-03 operationId discipline at every layer: a phase
// signal from a different operation must never move this job's phase.

const interceptorSource = readFileSync(new URL('../extension/src/content/bridge/media-interceptor.js', import.meta.url), 'utf8');
const mediaMenuSource = readFileSync(new URL('../extension/src/content/providers/flow/media/media-menu.js', import.meta.url), 'utf8');

// ---------------------------------------------------------------------------
// Interceptor harness (DL-03 pattern): REAL media-interceptor in a vm,
// fake page fetch, fake WatermarkRemover, captured result + phase events.
// ---------------------------------------------------------------------------
class FakeRemover {
  constructor(options = {}) { this.mask = options.mask; }
  async processBlob(blob) {
    const text = await blob.text();
    if (text.includes('BOOM')) throw new Error('remover exploded');
    if (text.includes('UNCLEANABLE')) return { blob, changed: false, reason: 'verification_failed' };
    if (text.includes('WATERMARKED')) {
      return { blob: new Blob(['CLEANED-BYTES'], { type: blob.type || 'image/png' }), changed: true, nccBefore: 0.91, nccAfter: 0.04 };
    }
    return { blob, changed: false, reason: 'watermark_not_found' };
  }
  static async maskFromAlphaPng() { return { fakeMask: true }; }
}

function interceptorHarness() {
  const resultEvents = [];
  const phaseEvents = [];
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
      if (event?.type === 'TOBY_FLOW_WATERMARK_PHASE') phaseEvents.push(event.detail);
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
    phaseEvents,
    api,
    armViaMessage,
    configure: options => api.configure(options),
    setBody: (url, body) => bodies.set(url, body),
    fetch: (url, init) => windowFake.fetch(url, init),
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

test('DL-12 (a1): a cleaned fetch emits fetching → cleaning → saving phase signals in order, attributed to its operation', async () => {
  const h = interceptorHarness();
  h.configure({ enabled: true, mask: { fakeMask: true } });
  h.setBody(`${MEDIA_A}=s2048`, 'WATERMARKED-A');
  h.armViaMessage({ operationId: 'op-phases', mode: 'clean', kind: 'image', url: MEDIA_A, timeoutMs: 60_000 });

  const response = await h.fetch(`${MEDIA_A}=s2048`);
  assert.equal(await response.text(), 'CLEANED-BYTES');
  assert.deepEqual(h.phaseEvents.map(event => event.phase), ['fetching', 'cleaning', 'saving'],
    'the phase signals distinguish fetching, cleaning and saving, in order');
  assert.ok(h.phaseEvents.every(event => event.operationId === 'op-phases'), 'every phase signal is attributed to the operation');
  assert.equal(h.resultEvents[0]?.status, 'cleaned');
});

test('DL-12 (a2): an original-mode download emits fetching → original and never a cleaning phase', async () => {
  const h = interceptorHarness();
  h.configure({ enabled: true, mask: { fakeMask: true } });
  h.setBody(`${MEDIA_A}=s2048`, 'WATERMARKED-A');
  h.armViaMessage({ operationId: 'op-original', mode: 'original', kind: 'image', url: MEDIA_A, timeoutMs: 60_000 });

  const response = await h.fetch(`${MEDIA_A}=s2048`);
  assert.equal(await response.text(), 'WATERMARKED-A', 'the original bytes are untouched');
  assert.deepEqual(h.phaseEvents.map(event => event.phase), ['fetching', 'original']);
  assert.ok(!h.phaseEvents.some(event => event.phase === 'cleaning'), 'no cleaning phase for a download that was never cleaned');
});

test('DL-12 (a3): a not-found outcome ends on the original phase, never a cleaning-done/saving claim', async () => {
  const h = interceptorHarness();
  h.configure({ enabled: true, mask: { fakeMask: true } });
  h.setBody(`${MEDIA_A}=s2048`, 'PLAIN-A');
  h.armViaMessage({ operationId: 'op-plain', mode: 'clean', kind: 'image', url: MEDIA_A, timeoutMs: 60_000 });

  await h.fetch(`${MEDIA_A}=s2048`);
  const phases = h.phaseEvents.map(event => event.phase);
  assert.equal(phases[0], 'fetching');
  assert.equal(phases.at(-1), 'original', 'the terminal interceptor phase is original, not cleaned/saving');
  assert.ok(!phases.includes('saving'), 'uncleaned bytes are not reported as a cleaned save');
  assert.equal(h.resultEvents[0]?.status, 'original');
  assert.equal(h.resultEvents[0]?.reason, 'not_found');
});

test('DL-12 (a4): a failed cleaning emits a terminal cleaning_failed phase, not a stuck cleaning state', async () => {
  const h = interceptorHarness();
  h.configure({ enabled: true, mask: { fakeMask: true } });
  h.setBody(`${MEDIA_A}=s2048`, 'BOOM-A');
  h.armViaMessage({ operationId: 'op-boom', mode: 'clean', kind: 'image', url: MEDIA_A, timeoutMs: 60_000 });

  await h.fetch(`${MEDIA_A}=s2048`);
  const phases = h.phaseEvents.map(event => event.phase);
  assert.equal(phases.at(-1), 'cleaning_failed', 'the last phase is terminal and matches the failed outcome');
  assert.equal(h.phaseEvents.at(-1)?.operationId, 'op-boom');
  assert.equal(h.resultEvents[0]?.status, 'failed');
});

test('DL-12 (a5): an unrelated fetch emits no phase signals at all', async () => {
  const h = interceptorHarness();
  h.configure({ enabled: true, mask: { fakeMask: true } });
  h.setBody('https://lh3.googleusercontent.com/media-other=s512', 'WATERMARKED-OTHER');
  h.armViaMessage({ operationId: 'op-mine', mode: 'clean', kind: 'image', url: MEDIA_A, timeoutMs: 60_000 });

  await h.fetch('https://lh3.googleusercontent.com/media-other=s512');
  assert.equal(h.phaseEvents.length, 0, 'an ungoverned fetch produces no phase signals');
  assert.equal(h.resultEvents.length, 0);
});

// ---------------------------------------------------------------------------
// media-menu harness (DL-03 pattern, extended): drive the REAL
// triggerFlowDownload, firing interceptor phase + result events during
// the download click.
// ---------------------------------------------------------------------------
function downloadHarness({ config = {}, fireEvents = null } = {}) {
  const posted = [];
  const listeners = new Map();
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
  const fire = (type, detail) => { listeners.get(type)?.({ detail }); };
  const downloadItem = {
    disabled: false,
    getAttribute() { return null; },
    querySelector(sel) { return sel.includes('.label') ? { innerText: 'Download', textContent: 'Download' } : null; },
    cloneNode() { return cloneStub(); },
    click() {
      if (!fireEvents) return;
      const arms = posted.filter(message => message?.source === 'flow-mcp-watermark-v1' && message?.action === 'arm');
      fireEvents({ arms, fire });
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
    addEventListener(type, listener) { listeners.set(type, listener); },
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
const CLEAN_CONFIG = { enabled: true, alpha_png_b64: alphaPngBase64() };

const ownResult = (arms, fields) => ({
  kind: 'image',
  operationId: arms[0]?.options?.operationId,
  ...fields,
});

test('DL-12 (b1): a cleaned download records fetching → cleaning → saving phases on the op result', async () => {
  const harness = downloadHarness({
    config: CLEAN_CONFIG,
    fireEvents: ({ arms, fire }) => {
      const operationId = arms[0]?.options?.operationId;
      fire('TOBY_FLOW_WATERMARK_PHASE', { operationId, kind: 'image', phase: 'fetching' });
      fire('TOBY_FLOW_WATERMARK_PHASE', { operationId, kind: 'image', phase: 'cleaning' });
      fire('TOBY_FLOW_WATERMARK_PHASE', { operationId, kind: 'image', phase: 'saving' });
      fire('TOBY_FLOW_WATERMARK_RESULT', ownResult(arms, { ok: true, changed: true, status: 'cleaned' }));
    },
  });
  const result = await harness.run();
  assert.equal(result.watermark?.status, 'cleaned');
  assert.deepEqual([...(result.watermark?.phases || [])], ['fetching', 'cleaning', 'saving']);
});

test('DL-12 (b2): a no-watermark outcome records the original/saving phases instead of cleaning', async () => {
  const harness = downloadHarness({
    config: CLEAN_CONFIG,
    fireEvents: ({ arms, fire }) => {
      const operationId = arms[0]?.options?.operationId;
      fire('TOBY_FLOW_WATERMARK_PHASE', { operationId, kind: 'image', phase: 'fetching' });
      // The remover ran a detection attempt (a cleaning stage signal),
      // but no watermark was found: the saved bytes were NOT cleaned,
      // so the honest recorded sequence must not claim cleaning.
      fire('TOBY_FLOW_WATERMARK_PHASE', { operationId, kind: 'image', phase: 'cleaning' });
      fire('TOBY_FLOW_WATERMARK_PHASE', { operationId, kind: 'image', phase: 'original' });
      fire('TOBY_FLOW_WATERMARK_RESULT', ownResult(arms, { ok: true, changed: false, status: 'original', reason: 'not_found' }));
    },
  });
  const result = await harness.run();
  assert.equal(result.watermark?.status, 'original');
  assert.deepEqual([...(result.watermark?.phases || [])], ['fetching', 'original', 'saving'],
    'the original/saving phase replaces cleaning for a no-watermark outcome');
});

test('DL-12 (b3): phase signals from a DIFFERENT operation never leak into this download', async () => {
  const harness = downloadHarness({
    config: CLEAN_CONFIG,
    fireEvents: ({ fire }) => {
      fire('TOBY_FLOW_WATERMARK_PHASE', { operationId: 'some-other-operation', kind: 'image', phase: 'cleaning' });
      fire('TOBY_FLOW_WATERMARK_PHASE', { operationId: 'some-other-operation', kind: 'image', phase: 'saving' });
      fire('TOBY_FLOW_WATERMARK_RESULT', { ok: true, changed: true, kind: 'image', status: 'cleaned', operationId: 'some-other-operation' });
    },
  });
  const result = await harness.run();
  assert.equal(result.watermark?.status, 'unknown', 'no attributed outcome (DL-03 discipline, unchanged)');
  assert.deepEqual([...(result.watermark?.phases || [])], ['fetching'],
    'only this download’s own fetching stage is recorded; foreign cleaning/saving phases do not leak');
});

test('DL-12 (b4): an own cleaning stage with no outcome stays visible without an invented terminal phase', async () => {
  const harness = downloadHarness({
    config: CLEAN_CONFIG,
    fireEvents: ({ arms, fire }) => {
      const operationId = arms[0]?.options?.operationId;
      fire('TOBY_FLOW_WATERMARK_PHASE', { operationId, kind: 'image', phase: 'cleaning' });
    },
  });
  const result = await harness.run();
  assert.equal(result.watermark?.status, 'unknown');
  assert.deepEqual([...(result.watermark?.phases || [])], ['fetching', 'cleaning'],
    'the cleaning stage is shown, but no saving/original/failed terminal is invented');
});

test('DL-12 (b5): a failed cleaning ends the recorded phases with cleaning_failed', async () => {
  const harness = downloadHarness({
    config: CLEAN_CONFIG,
    fireEvents: ({ arms, fire }) => {
      const operationId = arms[0]?.options?.operationId;
      fire('TOBY_FLOW_WATERMARK_PHASE', { operationId, kind: 'image', phase: 'cleaning' });
      fire('TOBY_FLOW_WATERMARK_PHASE', { operationId, kind: 'image', phase: 'cleaning_failed', reason: 'error' });
      fire('TOBY_FLOW_WATERMARK_RESULT', ownResult(arms, { ok: false, changed: false, status: 'failed', reason: 'error' }));
    },
  });
  const result = await harness.run();
  assert.equal(result.watermark?.status, 'failed');
  assert.deepEqual([...(result.watermark?.phases || [])], ['fetching', 'cleaning', 'cleaning_failed'],
    'a terminal phase consistent with the recorded failed outcome, not a stuck cleaning state');
});

// ---------------------------------------------------------------------------
// Queue layer: the op's phases are forwarded onto the job progress
// stream (hooks.progress) by downloadQueueMedia, mapped onto the
// existing progress vocabulary.
// ---------------------------------------------------------------------------
async function queueDownloadWithProgress(opWatermark) {
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
    const progress = [];
    const hooks = { progress: async entry => progress.push(entry), signal: undefined };
    const downloads = await downloadQueueMedia(
      [{ id: 'abcd1234-media-id', title: 'scene one', kind: 'image' }],
      '', 'scene-one', 'original', invoke, hooks, [], 'job-1', 5, '', null, 'clean',
    );
    assert.equal(downloads.length, 1);
    return { downloads, progress };
  } finally {
    delete globalThis.chrome;
  }
}

const phaseProgressOf = progress =>
  progress.filter(entry => /^download_(fetching|cleaning|original|saving|cleaning_failed)$/.test(entry.phase || ''));

test('DL-12 (c1): a cleaned download emits fetching → cleaning → saving on the job progress stream, in order', async () => {
  const { downloads, progress } = await queueDownloadWithProgress({
    mode: 'clean', armed: true, cleaned: true, status: 'cleaned', operationId: 'op-1',
    phases: ['fetching', 'cleaning', 'saving'],
  });
  assert.deepEqual(phaseProgressOf(progress).map(entry => entry.phase),
    ['download_fetching', 'download_cleaning', 'download_saving']);
  for (const entry of phaseProgressOf(progress)) {
    assert.equal(entry.download?.state, 'downloading', 'download.state stays in the existing vocabulary');
    assert.equal(entry.download?.current?.id, 'abcd1234-media-id', 'the phase is attributed to this media item');
  }
  assert.equal(downloads[0].watermark?.status, 'cleaned');
  assert.deepEqual(downloads[0].watermark?.phases, ['fetching', 'cleaning', 'saving'],
    'the recorded job-result watermark keeps the honest phase sequence');
});

test('DL-12 (c2): a no-watermark outcome emits the original/saving phases instead of cleaning-done', async () => {
  const { progress } = await queueDownloadWithProgress({
    mode: 'clean', armed: true, cleaned: false, status: 'original', outcomeReason: 'not_found', operationId: 'op-2',
    // Legacy-shaped op result: no phases array — the queue derives the
    // honest sequence from the recorded outcome alone.
  });
  assert.deepEqual(phaseProgressOf(progress).map(entry => entry.phase),
    ['download_fetching', 'download_original', 'download_saving']);
  assert.ok(!progress.some(entry => entry.phase === 'download_cleaning'), 'no cleaning phase is ever emitted for original bytes');
});

test('DL-12 (c3): phases carrying a different operationId do not leak into this job’s stream', async () => {
  const { progress } = await queueDownloadWithProgress({
    mode: 'clean', armed: true, cleaned: null, status: 'unknown', operationId: 'op-mine',
    phases: [
      { phase: 'cleaning', operationId: 'op-other' },
      { phase: 'saving', operationId: 'op-other' },
      { phase: 'fetching', operationId: 'op-mine' },
    ],
  });
  assert.deepEqual(phaseProgressOf(progress).map(entry => entry.phase), ['download_fetching'],
    'foreign cleaning/saving phases are dropped at the queue layer too');
});

test('DL-12 (c4): a failed cleaning emits a terminal download_cleaning_failed progress phase', async () => {
  const { downloads, progress } = await queueDownloadWithProgress({
    mode: 'clean', armed: true, cleaned: false, status: 'failed', outcomeReason: 'error', operationId: 'op-3',
    phases: ['fetching', 'cleaning', 'cleaning_failed'],
  });
  const phases = phaseProgressOf(progress).map(entry => entry.phase);
  assert.deepEqual(phases, ['download_fetching', 'download_cleaning', 'download_cleaning_failed']);
  assert.equal(phases.at(-1), 'download_cleaning_failed', 'terminal phase matches the recorded failed outcome');
  assert.equal(downloads[0].watermark?.status, 'failed');
  assert.deepEqual(downloads[0].watermark?.phases, ['fetching', 'cleaning', 'cleaning_failed']);
});
