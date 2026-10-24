import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

// DL-01 — Watermark pipeline activation (toggle → config → arm mode → outcome).
// Phase 0 found the pipeline inert end-to-end: nothing wrote the
// `flowWatermark` storage config, the sidebar "No watermark" toggle was a
// dead shell, and download arms carried no mode/mask, so the interceptor
// could never turn on. These tests pin the activated mechanism:
//  - the sidebar toggle + per-kind flags persist `flowWatermark` and are
//    read back on load;
//  - download arms carry an explicit mode (clean/original/inherit)
//    derived from job parameters + config; toggle off / kind disabled →
//    no arm message at all; `original` never cleans; `inherit` resolves
//    from config;
//  - a mask is only ever used when it is a structurally valid alpha PNG;
//  - the download result records the watermark outcome.

const mediaMenuSource = readFileSync(new URL('../extension/src/content/providers/flow/media/media-menu.js', import.meta.url), 'utf8');
const watermarkConfigSource = readFileSync(new URL('../extension/src/content/bridge/watermark-config.js', import.meta.url), 'utf8');
const sidebarHtml = readFileSync(new URL('../extension/src/ui/sidebar.html', import.meta.url), 'utf8');
const sidebarJs = readFileSync(new URL('../extension/src/ui/sidebar.js', import.meta.url), 'utf8');
const libraryOpsSource = readFileSync(new URL('../extension/src/content/providers/flow/library/library-operations.js', import.meta.url), 'utf8');

// ---------------------------------------------------------------------------
// PNG fixtures: build real 1x1 PNGs (correct CRCs) at a chosen IHDR color
// type — 6 = RGBA (alpha), 2 = RGB (no alpha).
// ---------------------------------------------------------------------------
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
function pngBase64(colorType) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = colorType;
  const scanline = Buffer.from(colorType === 6 ? [0, 255, 0, 0, 255] : [0, 255, 0, 0]);
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
const ALPHA_PNG_B64 = pngBase64(6);
const RGB_PNG_B64 = pngBase64(2);

// ---------------------------------------------------------------------------
// media-menu harness: drive the REAL triggerFlowDownload through a fake
// Flow tile + menu, capturing window.postMessage arm traffic and the
// flowWatermark storage fixture the arm derivation reads.
// ---------------------------------------------------------------------------
function downloadHarness({ config = {}, kind = 'image', fireResult = null } = {}) {
  const posted = [];
  let resultListener = null;
  let menuOpen = false;
  let downloadClicked = false;

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
      downloadClicked = true;
      if (fireResult && resultListener) resultListener({ detail: fireResult });
    },
  };
  const tile = {
    __id: 'media-1',
    isConnected: true,
    scrollIntoView() {},
    getAttribute() { return null; },
    querySelector(sel) {
      if (sel === 'flow-video-tile') return kind === 'video' ? { tagName: 'FLOW-VIDEO-TILE' } : null;
      if (sel === 'img,video,[role=img]' || sel === 'img') return imgEl;
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
  return {
    posted,
    get downloadClicked() { return downloadClicked; },
    armMessages: () => posted.filter(message => message?.source === 'flow-mcp-watermark-v1' && message?.action === 'arm'),
    run: (options = {}) => context.triggerFlowDownload('scene one', 'original', 'media-1', options),
  };
}

test('DL-01 (a): enabled config + valid alpha-PNG mask arms a queue image download with mode clean and records the outcome', async () => {
  const harness = downloadHarness({ config: { enabled: true, alpha_png_b64: ALPHA_PNG_B64 } });
  const result = await harness.run();
  assert.equal(result.downloadTriggered, true);
  const arms = harness.armMessages();
  assert.equal(arms.length, 1, 'exactly one arm message is posted');
  assert.equal(arms[0].options.mode, 'clean', 'the arm carries the resolved mode');
  assert.equal(arms[0].options.enabled, true);
  assert.equal(arms[0].options.kind, 'image');
  assert.deepEqual(
    { mode: result.watermark?.mode, armed: result.watermark?.armed },
    { mode: 'clean', armed: true },
    'the download result records the watermark outcome',
  );
});

test('DL-01 (b): toggle off in config → no arm message is posted during a download', async () => {
  const harness = downloadHarness({ config: { enabled: false, alpha_png_b64: ALPHA_PNG_B64 } });
  const result = await harness.run();
  assert.equal(result.downloadTriggered, true, 'the download itself still happens');
  assert.equal(harness.armMessages().length, 0, 'no arm message while the toggle is off');
  assert.equal(result.watermark?.armed, false);
  assert.equal(result.watermark?.mode, 'original');
  assert.equal(result.watermark?.reason, 'disabled');
});

test('DL-01 (c): explicit original mode posts a suppressing arm and never cleans, even with cleaning enabled', async () => {
  const harness = downloadHarness({ config: { enabled: true, alpha_png_b64: ALPHA_PNG_B64 } });
  const result = await harness.run({ watermarkMode: 'original' });
  const arms = harness.armMessages();
  assert.equal(arms.length, 1, 'the explicit mode posts a one-shot ticket');
  assert.equal(arms[0].options.mode, 'original');
  assert.equal(arms[0].options.enabled, false, 'an original arm can never clean');
  assert.equal(result.watermark?.mode, 'original');
  assert.equal(result.watermark?.cleaned, false);
});

test('DL-01 (d): invalid mask in config → no clean arm, download proceeds, no crash', async () => {
  for (const badMask of [RGB_PNG_B64, 'not-a-png!!!', Buffer.from('plain text').toString('base64')]) {
    const harness = downloadHarness({ config: { enabled: true, alpha_png_b64: badMask } });
    const result = await harness.run();
    assert.equal(result.downloadTriggered, true, 'download proceeds with the original bytes');
    assert.equal(harness.armMessages().length, 0, `no clean arm for invalid mask ${badMask.slice(0, 16)}…`);
    assert.equal(result.watermark?.armed, false);
    assert.equal(result.watermark?.reason, 'mask_missing_or_invalid');
  }
});

test('DL-01 (e): per-kind flag off suppresses arms for that kind only', async () => {
  const imageHarness = downloadHarness({ config: { enabled: true, image: false, alpha_png_b64: ALPHA_PNG_B64 }, kind: 'image' });
  const imageResult = await imageHarness.run();
  assert.equal(imageHarness.armMessages().length, 0, 'image downloads do not arm while the image flag is off');
  assert.equal(imageResult.watermark?.reason, 'kind_disabled');

  const videoHarness = downloadHarness({ config: { enabled: true, image: false, alpha_png_b64: ALPHA_PNG_B64 }, kind: 'video' });
  const videoResult = await videoHarness.run();
  assert.equal(videoHarness.armMessages().length, 1, 'video downloads still arm (video flag untouched)');
  assert.equal(videoHarness.armMessages()[0].options.mode, 'clean');
  assert.equal(videoResult.watermark?.mode, 'clean');
});

test('DL-01 (f): explicit clean mode is a per-download ticket — it arms with a valid mask even when the global toggle is off', async () => {
  const harness = downloadHarness({ config: { enabled: false, alpha_png_b64: ALPHA_PNG_B64 } });
  const result = await harness.run({ watermarkMode: 'clean' });
  const arms = harness.armMessages();
  assert.equal(arms.length, 1);
  assert.equal(arms[0].options.mode, 'clean');
  assert.equal(result.watermark?.mode, 'clean');
  assert.equal(result.watermark?.reason, 'explicit_clean');
});

test('DL-01 (g): a watermark result event observed during the download is recorded as cleaned', async () => {
  const harness = downloadHarness({
    config: { enabled: true, alpha_png_b64: ALPHA_PNG_B64 },
    fireResult: { ok: true, changed: true, kind: 'image', nccBefore: 0.9, nccAfter: 0.1 },
  });
  const result = await harness.run();
  assert.equal(result.watermark?.armed, true);
  assert.equal(result.watermark?.cleaned, true, 'the outcome reports that cleaning ran');
});

test('DL-01 (h): without a result event the recorded cleaned state stays unknown, never invented', async () => {
  const harness = downloadHarness({ config: { enabled: true, alpha_png_b64: ALPHA_PNG_B64 } });
  const result = await harness.run();
  assert.equal(result.watermark?.armed, true);
  assert.equal(result.watermark?.cleaned, null);
});

// ---------------------------------------------------------------------------
// watermark-config bridge: the isolated world forwards the storage config
// to the MAIN-world interceptor — but only a structurally valid alpha-PNG
// mask may cross, and the per-kind flags travel with it.
// ---------------------------------------------------------------------------
async function configBridgePosts(config) {
  const posted = [];
  const sandbox = {
    console,
    atob,
    location: { origin: 'https://flow.google.com' },
    window: { postMessage: message => posted.push(message) },
    chrome: {
      storage: {
        local: { get: async () => ({ flowWatermark: config }) },
        onChanged: { addListener: () => {} },
      },
      runtime: { onMessage: { addListener: () => {} } },
    },
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(watermarkConfigSource, context);
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  return posted.filter(message => message?.action === 'configure');
}

test('DL-01 (i): the config bridge forwards enabled, per-kind flags and a valid alpha-PNG mask', async () => {
  const posts = await configBridgePosts({ enabled: true, image: true, video: false, alpha_png_b64: ALPHA_PNG_B64, nccThreshold: 0.8 });
  assert.equal(posts.length, 1);
  const options = posts[0].options;
  assert.equal(options.enabled, true);
  assert.equal(options.image, true);
  assert.equal(options.video, false);
  assert.equal(options.alpha_png_b64, ALPHA_PNG_B64);
  assert.equal(options.nccThreshold, 0.8);
});

test('DL-01 (j): the config bridge refuses to forward an invalid mask', async () => {
  for (const badMask of [RGB_PNG_B64, '%%%not-base64%%%', Buffer.from('hello world').toString('base64')]) {
    const posts = await configBridgePosts({ enabled: true, alpha_png_b64: badMask });
    assert.equal(posts.length, 1);
    assert.equal(posts[0].options.alpha_png_b64, undefined, `invalid mask must not cross the bridge: ${badMask.slice(0, 16)}…`);
    assert.equal(posts[0].options.enabled, true, 'the rest of the config still forwards');
  }
});

// ---------------------------------------------------------------------------
// Queue layer: the mode from the job parameters reaches the download
// invocation, and the outcome recorded by the content op lands on the
// queue download result.
// ---------------------------------------------------------------------------
test('DL-01 (k): queue downloads pass the watermark mode through and record the outcome on the result', async () => {
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
    const invocations = [];
    const invoke = async (operation, payload) => {
      invocations.push({ operation, payload });
      return { downloadTriggered: true, watermark: { mode: 'clean', armed: true, cleaned: true } };
    };
    const hooks = { progress: async () => {}, signal: undefined };
    const downloads = await downloadQueueMedia(
      [{ id: 'abcd1234-media-id', title: 'scene one', kind: 'image' }],
      '', 'scene-one', 'original', invoke, hooks, [], 'job-1', 5, '', null, 'clean',
    );
    assert.equal(invocations.length, 1);
    assert.equal(invocations[0].operation, 'flow.asset.download');
    assert.equal(invocations[0].payload.watermarkMode, 'clean', 'the job mode reaches the download op');
    assert.equal(downloads.length, 1);
    // DL-03 extends the recorded outcome with the per-download status
    // shape on the queue result; the DL-01 fields are preserved verbatim.
    assert.deepEqual(downloads[0].watermark, { mode: 'clean', armed: true, cleaned: true, status: 'cleaned' },
      'the queue download result records the watermark outcome');
  } finally {
    delete globalThis.chrome;
  }
});

// ---------------------------------------------------------------------------
// Sidebar: the toggle shell gains per-kind flags, and the JS persists the
// flowWatermark config (enabled + per-kind) and reads it back on load.
// ---------------------------------------------------------------------------
test('DL-01 (l): sidebar shell carries the main toggle plus per-kind image/video flags', () => {
  assert.match(sidebarHtml, /id="genTabWatermarkPill"/, 'main No-watermark toggle exists');
  assert.match(sidebarHtml, /id="genTabWatermarkImage"/, 'per-kind image flag exists');
  assert.match(sidebarHtml, /id="genTabWatermarkVideo"/, 'per-kind video flag exists');
});

test('DL-01 (m): sidebar persists flowWatermark from the toggle + kind flags and reads it back on init', () => {
  assert.match(sidebarJs, /readUiStorage\("flowWatermark"/, 'init reads the stored config back');
  assert.match(sidebarJs, /writeUiStorage\("flowWatermark",\s*\{[^}]*enabled:/, 'changes persist enabled');
  assert.match(sidebarJs, /genTabWatermarkPill/, 'the main toggle is wired');
  assert.match(sidebarJs, /genTabWatermarkImage/, 'the image flag is wired');
  assert.match(sidebarJs, /genTabWatermarkVideo/, 'the video flag is wired');
  assert.match(sidebarJs, /initWatermarkSettings\(\)/, 'the init chain runs the watermark wiring');
});

test('DL-01 (n): the download op forwards a job watermark mode into the download options', () => {
  assert.match(libraryOpsSource, /watermarkMode:\s*payload\.watermarkMode \?\? payload\.watermark_mode/,
    'flow.asset.download carries the mode from the payload into triggerFlowDownload options');
  const armSites = mediaMenuSource.match(/mode: operationOptions\.watermarkMode/g) || [];
  assert.equal(armSites.length, 3, 'every arm call site in triggerFlowDownload passes the job mode');
});
