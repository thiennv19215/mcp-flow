import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

// DL-08 — Direct-bytes fallback route + full-size URL canonicalization.
// The Flow menu is the web route's only download mechanism: when it breaks
// (menu never opens, no quality choice), the download simply fails. The
// reference route fetches verified bytes directly from the tile media
// element's URL, rewritten to the requested (or full) size. These tests pin:
//  - the fallback engages ONLY on menu-path failures, never after a
//    successful menu download (no double save);
//  - the fetch URL is the tile media URL with the Google size suffix
//    stripped (original quality), or rewritten to the requested size;
//  - magic bytes decide: an HTML body is REJECTED with a distinct error
//    and never saved; PNG/JPEG/WebP/GIF and MP4/WebM pass; bytes of the
//    wrong kind for the download are rejected;
//  - the saved filename is the planned filename (the tile's own
//    data-file-name / the asset title + the sniffed extension), never a
//    name derived from the media URL;
//  - the watermark honesty contract: the fallback fetch runs in the
//    isolated world and never passes through the MAIN-world interceptor,
//    so when a clean arm would have applied the result records the saved
//    bytes as ORIGINAL with the direct-bytes reason — never as cleaned.

const mediaMenuSource = readFileSync(new URL('../extension/src/content/providers/flow/media/media-menu.js', import.meta.url), 'utf8');

// --- byte fixtures --------------------------------------------------------
const PNG_BYTES = (() => {
  // Minimal valid PNG (same construction as the DL-01/DL-03 fixtures).
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
  function chunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  }
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
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
})();
const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF\0-fake-jpeg-body')]);
const GIF_BYTES = Buffer.from('GIF89a-fake-gif-body');
const WEBP_BYTES = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x20, 0x00, 0x00, 0x00]), Buffer.from('WEBP-fake-webp-body')]);
const MP4_BYTES = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x18]), Buffer.from('ftypisom-fake-mp4-body')]);
const WEBM_BYTES = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('-fake-webm-body')]);
const HTML_BYTES = Buffer.from('<!DOCTYPE html><html><head><title>Error</title></head><body>Not found</body></html>');

// Minimal valid alpha-PNG mask config (for the watermark honesty test).
const ALPHA_PNG_B64 = PNG_BYTES.toString('base64');
const CLEAN_CONFIG = { enabled: true, alpha_png_b64: ALPHA_PNG_B64 };

// --- harness ---------------------------------------------------------------
function fallbackHarness({
  config = {},
  menuSucceeds = false,
  tileSrc = 'https://lh3.googleusercontent.com/media-1=s512',
  tileKind = 'image',
  fileNameAttr = null,
  fetchRoutes = new Map(),
} = {}) {
  const posted = [];
  const fetchCalls = [];
  const saves = [];
  const objectUrlBlobs = [];
  let menuOpen = false;
  let menuClicks = 0;

  const cloneStub = () => ({ querySelectorAll: () => [], innerText: '', textContent: '' });
  const mediaEl = {
    tagName: tileKind === 'video' ? 'VIDEO' : 'IMG',
    currentSrc: tileSrc,
    src: tileSrc,
    complete: true,
    naturalWidth: 64,
    getAttribute(name) {
      if (name === 'src') return tileSrc;
      if (name === 'data-file-name' || name === 'data-filename') return fileNameAttr;
      return null;
    },
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
    click() { menuClicks += 1; },
  };
  const tile = {
    __id: 'media-1',
    isConnected: true,
    scrollIntoView() {},
    getAttribute(name) {
      if (name === 'data-file-name' || name === 'data-filename') return fileNameAttr;
      return null;
    },
    querySelector(sel) {
      if (sel === 'flow-scene-tile') return null;
      if (sel === 'flow-video-tile') return tileKind === 'video' ? {} : null;
      if (sel === 'img,video' || sel === 'img' || sel === 'video' || sel === 'img,video,[role=img]') return mediaEl;
      return null;
    },
    querySelectorAll(sel) {
      if (sel === 'button,[role="button"]') return [moreBtn];
      if (sel === '*') return [];
      return [mediaEl];
    },
  };

  class FakeURL extends URL {}
  FakeURL.createObjectURL = blob => {
    objectUrlBlobs.push(blob);
    return `blob:fake-${objectUrlBlobs.length}`;
  };
  FakeURL.revokeObjectURL = () => {};

  const documentFake = {
    visibilityState: 'visible',
    body: { appendChild() {} },
    querySelectorAll(sel) {
      if (sel === 'flow-grid-tile-container') return [tile];
      if (sel === '[role="menuitem"],button') return menuOpen && menuSucceeds ? [downloadItem] : [];
      return [];
    },
    createElement(tag) {
      assert.equal(tag, 'a', 'the fallback saves through an anchor');
      const anchor = {
        href: '',
        download: '',
        dataset: {},
        click() { saves.push({ href: this.href, download: this.download }); },
        remove() {},
      };
      return anchor;
    },
  };

  const fetchFake = async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    const route = fetchRoutes.get(String(url));
    if (!route) throw new Error(`no fetch route for ${url}`);
    if (route.error) throw route.error;
    return new Response(route.body, {
      status: route.status ?? 200,
      headers: { 'content-type': route.contentType || 'application/octet-stream' },
    });
  };

  const sandbox = {
    console,
    URL: FakeURL,
    atob,
    Blob,
    setTimeout,
    clearTimeout,
    fetch: fetchFake,
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
    addEventListener() {},
    flowError: (code, message, retryable, outcomeUnknown) =>
      Object.assign(new Error(message), { code, retryable, outcome_unknown: outcomeUnknown }),
    wait: async () => {},
    visible: () => true,
    mediaId: candidate => candidate.__id,
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(mediaMenuSource, context);
  return {
    run: (title = 'scene one', quality = 'original', options = {}) =>
      context.triggerFlowDownload(title, quality, 'media-1', options),
    posted,
    fetchCalls,
    saves,
    objectUrlBlobs,
    get menuClicks() { return menuClicks; },
  };
}

test('DL-08 (a): menu failure → fallback fetches the size-stripped URL and saves the PNG under the planned filename', async () => {
  const h = fallbackHarness({
    fileNameAttr: 'planned-name.png',
    fetchRoutes: new Map([
      ['https://lh3.googleusercontent.com/media-1', { body: PNG_BYTES, contentType: 'image/png' }],
    ]),
  });
  const result = await h.run();
  assert.equal(result.downloadTriggered, true);
  assert.equal(result.route, 'direct-bytes', 'the result names the fallback route');
  assert.equal(h.fetchCalls.length, 1);
  assert.equal(h.fetchCalls[0].url, 'https://lh3.googleusercontent.com/media-1', 'the =s512 size suffix is stripped for original quality');
  assert.equal(h.saves.length, 1, 'the verified bytes are handed to the save path exactly once');
  assert.equal(h.saves[0].download, 'planned-name.png', 'the planned filename wins — not a URL-derived name like media-1');
  assert.equal(h.objectUrlBlobs.length, 1);
  assert.equal(h.objectUrlBlobs[0].size, PNG_BYTES.length, 'the saved blob carries the fetched bytes');
  assert.equal(result.fallback?.mime, 'image/png');
  assert.equal(result.fallback?.filename, 'planned-name.png');
  assert.equal(result.fallback?.menuError, 'FLOW_TILE_MENU_MISSING', 'the triggering menu failure is recorded');
  assert.equal(h.posted.length, 0, 'the fallback posts no interceptor arm for its own isolated-world fetch');
});

test('DL-08 (a2): without a tile file name, the planned filename is the title + the sniffed extension', async () => {
  const h = fallbackHarness({
    fetchRoutes: new Map([
      ['https://lh3.googleusercontent.com/media-1', { body: JPEG_BYTES, contentType: 'image/jpeg' }],
    ]),
  });
  const result = await h.run();
  assert.equal(result.route, 'direct-bytes');
  assert.equal(h.saves[0].download, 'scene-one.jpg', 'title-derived stem + the SNIFFED extension (jpeg → .jpg)');
  assert.equal(result.fallback?.mime, 'image/jpeg');
});

test('DL-08 (b): an HTML body is rejected and never saved — even when the header claims image/png', async () => {
  const h = fallbackHarness({
    fetchRoutes: new Map([
      ['https://lh3.googleusercontent.com/media-1', { body: HTML_BYTES, contentType: 'image/png' }],
    ]),
  });
  await assert.rejects(h.run(), error => {
    assert.equal(error.code, 'FLOW_DOWNLOAD_HTML_RESPONSE', 'magic bytes decide: an HTML body gets the distinct HTML error');
    return true;
  });
  assert.equal(h.saves.length, 0, 'an HTML body is never handed to the save path');
});

test('DL-08 (c): bytes of the wrong kind (MP4 for an image download) are rejected', async () => {
  const h = fallbackHarness({
    fetchRoutes: new Map([
      ['https://lh3.googleusercontent.com/media-1', { body: MP4_BYTES, contentType: 'video/mp4' }],
    ]),
  });
  await assert.rejects(h.run(), error => {
    assert.equal(error.code, 'FLOW_DOWNLOAD_BYTES_INVALID');
    return true;
  });
  assert.equal(h.saves.length, 0);
});

test('DL-08 (c2): an empty body is rejected as invalid bytes', async () => {
  const h = fallbackHarness({
    fetchRoutes: new Map([
      ['https://lh3.googleusercontent.com/media-1', { body: Buffer.alloc(0), contentType: 'image/png' }],
    ]),
  });
  await assert.rejects(h.run(), error => {
    assert.equal(error.code, 'FLOW_DOWNLOAD_BYTES_INVALID');
    return true;
  });
  assert.equal(h.saves.length, 0);
});

test('DL-08 (d): control — a successful menu download never engages the fallback', async () => {
  const h = fallbackHarness({ menuSucceeds: true });
  const result = await h.run();
  assert.equal(result.downloadTriggered, true);
  assert.equal(result.route, undefined, 'the menu route result carries no fallback marker');
  assert.equal(h.menuClicks, 1, 'the menu download item was clicked');
  assert.equal(h.fetchCalls.length, 0, 'the fallback fetch never runs');
  assert.equal(h.saves.length, 0, 'no double save through the fallback');
});

test('DL-08 (e): a media.html tile URL is rejected up front — no fetch, the menu failure stands', async () => {
  const h = fallbackHarness({ tileSrc: 'https://flow.google.com/asb/media.html' });
  await assert.rejects(h.run(), error => {
    assert.equal(error.code, 'FLOW_TILE_MENU_MISSING', 'with no fetchable media URL the original menu failure surfaces');
    return true;
  });
  assert.equal(h.fetchCalls.length, 0, 'a media.html URL is never fetched');
  assert.equal(h.saves.length, 0);
});

test('DL-08 (f): the watermark outcome is honest — a clean-armed download saved via the fallback is original, never cleaned', async () => {
  const h = fallbackHarness({
    config: CLEAN_CONFIG,
    fetchRoutes: new Map([
      ['https://lh3.googleusercontent.com/media-1', { body: PNG_BYTES, contentType: 'image/png' }],
    ]),
  });
  const result = await h.run('scene one', 'original', { watermarkMode: 'clean' });
  assert.equal(result.route, 'direct-bytes');
  assert.equal(result.watermark?.mode, 'clean', 'the requested clean mode is reported');
  assert.equal(result.watermark?.armed, false, 'the fallback arms no interceptor context');
  assert.equal(result.watermark?.cleaned, false, 'bytes fetched outside the interceptor are NOT claimed as cleaned');
  assert.equal(result.watermark?.status, 'original');
  assert.equal(result.watermark?.outcomeReason, 'direct_bytes_fallback', 'the reason states the cleaning bypass plainly');
});

test('DL-08 (g): a requested size rewrites the suffix (=720p → =s720)', async () => {
  const h = fallbackHarness({
    tileKind: 'video',
    tileSrc: 'https://lh3.googleusercontent.com/media-1=s512',
    fetchRoutes: new Map([
      ['https://lh3.googleusercontent.com/media-1=s720', { body: MP4_BYTES, contentType: 'video/mp4' }],
    ]),
  });
  const result = await h.run('clip one', '720p');
  assert.equal(result.route, 'direct-bytes');
  assert.equal(result.kind, 'video');
  assert.equal(h.fetchCalls[0].url, 'https://lh3.googleusercontent.com/media-1=s720', 'the suffix is rewritten to the requested size');
  assert.equal(h.saves[0].download, 'clip-one.mp4');
  assert.equal(result.fallback?.mime, 'video/mp4');
});

test('DL-08 (h): image formats beyond PNG pass by magic bytes (GIF, WebP) and WebM passes for video', async () => {
  for (const [body, mime, ext] of [
    [GIF_BYTES, 'image/gif', '.gif'],
    [WEBP_BYTES, 'image/webp', '.webp'],
  ]) {
    const h = fallbackHarness({
      fetchRoutes: new Map([
        ['https://lh3.googleusercontent.com/media-1', { body, contentType: mime }],
      ]),
    });
    const result = await h.run();
    assert.equal(result.fallback?.mime, mime);
    assert.equal(h.saves[0].download, `scene-one${ext}`);
  }
  const hv = fallbackHarness({
    tileKind: 'video',
    fetchRoutes: new Map([
      ['https://lh3.googleusercontent.com/media-1', { body: WEBM_BYTES, contentType: 'video/webm' }],
    ]),
  });
  const videoResult = await hv.run('clip one');
  assert.equal(videoResult.fallback?.mime, 'video/webm');
  assert.equal(hv.saves[0].download, 'clip-one.webm');
});
