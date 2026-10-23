import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

// DL-04 — Multi-variant, scale-aware watermark detection.
// Phase 0 (study-download-watermark G4 / W3): the remover located ONE mask at
// its native pixel size, but Flow renders its logo proportionally to the media
// size, so the same mask only ever matched one output resolution. These tests
// pin the reference logic:
//  - the config may carry several logo variants (own base size + priority);
//    each variant's mask is rescaled by (image short side / variant base
//    short side) before NCC location; the best score wins with a small
//    epsilon bias toward higher-priority variants, deterministically;
//  - DL-01's lone alpha_png_b64 stays a single native-scale variant — a
//    legacy config's behavior does not change;
//  - invalid variants are dropped individually, never poison the config.

const removerSource = readFileSync(new URL('../extension/src/content/bridge/WatermarkRemover.js', import.meta.url), 'utf8');
const watermarkConfigSource = readFileSync(new URL('../extension/src/content/bridge/watermark-config.js', import.meta.url), 'utf8');

// ---------------------------------------------------------------------------
// Fixtures: deterministic block-random alpha patterns, bilinear resampling
// (the way a renderer would scale the logo), and textured images with the
// logo alpha-blended in white at the bottom-right — Flow's layout.
// ---------------------------------------------------------------------------
function hash2(a, b, seed) {
  let h = (seed * 374761393 + a * 668265263 + b * 974634211) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const LEVELS = [0, 90, 170, 255];
function makePattern(seed, width = 48, height = 24) {
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data[y * width + x] = LEVELS[Math.floor(hash2(x >> 2, y >> 2, seed) * 4) % 4];
    }
  }
  return { width, height, data };
}
const PATTERN_A = makePattern(11);
const PATTERN_B = makePattern(77);

function resampleAlpha(mask, targetW, targetH) {
  const out = new Float32Array(targetW * targetH);
  const sx = mask.width / targetW;
  const sy = mask.height / targetH;
  for (let y = 0; y < targetH; y++) {
    for (let x = 0; x < targetW; x++) {
      const gx = (x + 0.5) * sx - 0.5;
      const gy = (y + 0.5) * sy - 0.5;
      const x0 = Math.floor(gx);
      const y0 = Math.floor(gy);
      const fx = gx - x0;
      const fy = gy - y0;
      let sum = 0;
      for (let dy = 0; dy <= 1; dy++) {
        for (let dx = 0; dx <= 1; dx++) {
          const px = Math.min(mask.width - 1, Math.max(0, x0 + dx));
          const py = Math.min(mask.height - 1, Math.max(0, y0 + dy));
          sum += mask.data[py * mask.width + px] * (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy);
        }
      }
      out[y * targetW + x] = sum;
    }
  }
  return out;
}

// Image whose short side is 240 * scale, with the pattern rendered at the
// matching size (48*scale x 24*scale) — i.e. a variant with baseShortSide 240
// matches at every scale exactly when the mask is rescaled by the ratio.
// The background is a smooth photo-like gradient: the pattern's alpha
// variance is what NCC correlates against (a constant-alpha template is
// degenerate for NCC, and high-frequency backgrounds are unrepresentative).
function renderImage(scale, pattern = null) {
  const width = Math.round(320 * scale);
  const height = Math.round(240 * scale);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const bg = 74 + Math.round(16 * Math.sin(x / 37) * Math.cos(y / 29)) + ((x + y) % 3);
      const offset = (y * width + x) * 4;
      data[offset] = data[offset + 1] = data[offset + 2] = bg;
      data[offset + 3] = 255;
    }
  }
  let placed = null;
  if (pattern) {
    const logoW = Math.round(pattern.width * scale);
    const logoH = Math.round(pattern.height * scale);
    const alpha = resampleAlpha(pattern, logoW, logoH);
    const ox = width - logoW - 12;
    const oy = height - logoH - 10;
    for (let y = 0; y < logoH; y++) {
      for (let x = 0; x < logoW; x++) {
        const a = alpha[y * logoW + x] / 255;
        if (a <= 0) continue;
        const offset = ((oy + y) * width + (ox + x)) * 4;
        for (let channel = 0; channel < 3; channel++) data[offset + channel] += a * (255 - data[offset + channel]);
      }
    }
    placed = { x: ox, y: oy };
  }
  return { image: { width, height, data }, placed };
}

class FakeImageData {
  constructor(data, width, height) {
    this.data = data;
    this.width = width;
    this.height = height;
  }
}

function loadRemover(extra = {}) {
  const sandbox = { console, ImageData: FakeImageData, ...extra };
  const context = vm.createContext(sandbox);
  vm.runInContext(removerSource, context);
  return context.WatermarkRemover;
}

function assertFoundAt(point, placed, variant, scale) {
  assert.ok(point, 'detection must succeed');
  assert.ok(point.ncc > 0.68, `NCC above the configured threshold (got ${point.ncc})`);
  assert.ok(Math.abs(point.x - placed.x) <= 2, `x near the rendered logo (${point.x} vs ${placed.x})`);
  assert.ok(Math.abs(point.y - placed.y) <= 2, `y near the rendered logo (${point.y} vs ${placed.y})`);
  assert.equal(point.variant, variant, 'the winning variant is reported');
  assert.ok(Math.abs(point.scale - scale) < 0.02, `the rescale ratio is reported (${point.scale} vs ${scale})`);
}

test('DL-04 (a): a variant mask rescaled by the short-side ratio detects the logo at 0.5x, 1x and 2x', () => {
  const Remover = loadRemover();
  // Production shape: the interceptor passes the decoded legacy mask AND the
  // configured variants; the variant carries baseShortSide 240.
  const remover = new Remover({
    mask: PATTERN_A,
    variants: [{ id: 'std', mask: PATTERN_A, baseShortSide: 240, priority: 10 }],
  });
  for (const scale of [0.5, 1, 2]) {
    const { image, placed } = renderImage(scale, PATTERN_A);
    assertFoundAt(remover.locate(image), placed, 'std', scale);
  }
});

test('DL-04 (b): a logo-free control image stays below threshold at every scale', () => {
  const Remover = loadRemover();
  const remover = new Remover({
    variants: [{ id: 'std', mask: PATTERN_A, baseShortSide: 240, priority: 10 }],
  });
  for (const scale of [0.5, 1, 2]) {
    const { image } = renderImage(scale, null);
    assert.equal(remover.locate(image), null, `no logo at ${scale}x → no detection`);
  }
});

test('DL-04 (c): when the second-priority variant is the one present, it is the one reported', () => {
  const Remover = loadRemover();
  const remover = new Remover({
    variants: [
      { id: 'a', mask: PATTERN_A, baseShortSide: 240, priority: 10 },
      { id: 'b', mask: PATTERN_B, baseShortSide: 240, priority: 5 },
    ],
  });
  for (const scale of [1, 2]) {
    const { image, placed } = renderImage(scale, PATTERN_B);
    assertFoundAt(remover.locate(image), placed, 'b', scale);
  }
});

test('DL-04 (d): evaluation follows priority, not config order', () => {
  const Remover = loadRemover();
  const remover = new Remover({
    variants: [
      { id: 'b', mask: PATTERN_B, baseShortSide: 240, priority: 5 },
      { id: 'a', mask: PATTERN_A, baseShortSide: 240, priority: 10 },
    ],
  });
  const { image, placed } = renderImage(1, PATTERN_A);
  assertFoundAt(remover.locate(image), placed, 'a', 1);
});

test('DL-04 (e): invalid variants are dropped individually and never poison detection', () => {
  const Remover = loadRemover();
  const remover = new Remover({
    variants: [
      null,
      'junk',
      {},
      { id: 'empty', mask: { width: 0, height: 0, data: [] } },
      { id: 'raw', alpha_png_b64: '%%%not-a-png%%%', baseShortSide: 240, priority: 99 },
      { id: 'ok', mask: PATTERN_A, baseShortSide: 240, priority: 1 },
    ],
  });
  const { image, placed } = renderImage(1, PATTERN_A);
  assertFoundAt(remover.locate(image), placed, 'ok', 1);
});

test('DL-04 (f): the lone legacy mask keeps DL-01 semantics — native scale only, no implicit rescale', () => {
  const Remover = loadRemover();
  const remover = new Remover({ mask: PATTERN_A });
  const at1x = renderImage(1, PATTERN_A);
  const found = remover.locate(at1x.image);
  assert.ok(found, 'native-size logo still found');
  assert.equal(found.variant, null, 'the legacy mask reports no variant');
  const explicit = remover.locate(at1x.image, PATTERN_A);
  assert.ok(explicit, 'an explicitly passed mask still locates as before');
  const at2x = renderImage(2, PATTERN_A);
  assert.equal(remover.locate(at2x.image), null, 'a lone mask does NOT gain scale awareness on its own');
});

test('DL-04 (g): remove() routes through the winning variant and reports it', () => {
  const Remover = loadRemover();
  const remover = new Remover({
    variants: [
      { id: 'a', mask: PATTERN_A, baseShortSide: 240, priority: 10 },
      { id: 'b', mask: PATTERN_B, baseShortSide: 240, priority: 5 },
    ],
  });
  const { image } = renderImage(1, PATTERN_B);
  const result = remover.remove(new FakeImageData(image.data, image.width, image.height));
  // DL-04's contract in the remove path is the routing: detection picked
  // variant b, the removal/verification ran with b's (rescaled) mask, and
  // the outcome names it. Whether the reverse-alpha pass verifies on a
  // given image is the removal-quality behavior (study W4), which keeps
  // its honest shape here: cleaned, or verification_failed with rollback.
  assert.equal(result.variant, 'b', 'the result names the variant that matched');
  assert.equal(result.scale, 1);
  assert.ok(result.nccBefore > 0.68, `the detection NCC fed the removal (got ${result.nccBefore})`);
  assert.ok(
    result.changed === true || result.reason === 'verification_failed',
    `the outcome is an honest removal result (got changed=${result.changed}, reason=${result.reason})`,
  );
  if (result.changed) assert.ok(result.nccAfter <= 0.25, 'a cleaned result verifies below minNccAfter');

  const clean = renderImage(1, null);
  const untouched = remover.remove(new FakeImageData(clean.image.data, clean.image.width, clean.image.height));
  assert.equal(untouched.changed, false);
  assert.equal(untouched.reason, 'watermark_not_found');
});

test('DL-04 (h): raw base64 variants (the production config form) decode lazily and detect at scale', async () => {
  // Fake the PNG decode surface maskFromAlphaPng relies on: fetch returns a
  // blob registered to a bitmap carrying the pattern's RGBA, createImageBitmap
  // resolves it, and the canvas hands its pixels back via getImageData.
  const bitmapByBlob = new WeakMap();
  const maskBitmap = pattern => {
    const rgba = new Uint8ClampedArray(pattern.width * pattern.height * 4);
    for (let index = 0; index < pattern.width * pattern.height; index++) rgba[index * 4 + 3] = pattern.data[index];
    return { width: pattern.width, height: pattern.height, rgba, close() {} };
  };
  const fetchFake = async url => {
    const b64 = String(url).split('base64,')[1];
    if (b64 === 'BROKEN') throw new Error('network down');
    const blob = new Blob(['png-bytes']);
    bitmapByBlob.set(blob, maskBitmap(PATTERN_A));
    return { blob: async () => blob };
  };
  const imageBitmap = renderImage(2, PATTERN_A);
  const imageBlob = new Blob(['image-bytes'], { type: 'image/png' });
  bitmapByBlob.set(imageBlob, { width: imageBitmap.image.width, height: imageBitmap.image.height, rgba: imageBitmap.image.data, close() {} });
  class FakeCanvas {
    getContext() {
      return {
        clearRect() {},
        drawImage: bitmap => { this.bitmap = bitmap; },
        getImageData: (x, y, w, h) => new FakeImageData(this.bitmap.rgba, w, h),
        putImageData() {},
      };
    }
    toBlob(callback) { callback(new Blob(['cleaned'], { type: 'image/png' })); }
  }
  const Remover = loadRemover({
    Blob,
    fetch: fetchFake,
    createImageBitmap: async blob => bitmapByBlob.get(blob),
    document: { createElement: () => new FakeCanvas() },
  });
  const remover = new Remover({
    variants: [
      { id: 'broken', alpha_png_b64: 'BROKEN', baseShortSide: 240, priority: 99 },
      { id: 'raw-a', alpha_png_b64: 'RAW_A_B64', baseShortSide: 240, priority: 10 },
    ],
  });
  const result = await remover.processBlob(imageBlob);
  assert.equal(result.variant, 'raw-a', 'the undecodable variant is dropped, the raw variant drives the attempt');
  assert.ok(Math.abs(result.scale - 2) < 0.02, `scale 2 reported (got ${result.scale})`);
  assert.ok(result.nccBefore > 0.68, `detection at 2x fed the removal (got ${result.nccBefore})`);
  assert.ok(
    result.changed === true || result.reason === 'verification_failed',
    `the outcome is an honest removal result (got changed=${result.changed}, reason=${result.reason})`,
  );
  if (!result.changed) assert.equal(result.blob, imageBlob, 'an unverified clean returns the original bytes, never a silent success');
});

// ---------------------------------------------------------------------------
// watermark-config bridge: variants are validated per entry (the mask must
// be a structural alpha PNG, exactly like the legacy mask gate) and
// normalized (baseWidth/baseHeight collapse to baseShortSide) before they
// are forwarded to the MAIN world; the legacy field is untouched.
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
function pngBase64(width, height, colorType) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  const idat = Buffer.from([0x78, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00]);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}
const ALPHA_1 = pngBase64(48, 24, 6);
const ALPHA_2 = pngBase64(64, 32, 6);
const ALPHA_3 = pngBase64(40, 40, 6);
const RGB_PNG = pngBase64(48, 24, 2);

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

test('DL-04 (i): the config bridge forwards valid variants normalized, dropping invalid ones individually', async () => {
  const posts = await configBridgePosts({
    enabled: true,
    alpha_png_b64: ALPHA_1,
    variants: [
      { id: 'big', alpha_png_b64: ALPHA_2, baseWidth: 480, baseHeight: 360, priority: 5 },
      { id: 'std', alpha_png_b64: ALPHA_3, baseShortSide: 240 },
      { id: 'bad', alpha_png_b64: RGB_PNG, baseShortSide: 240 },
      'junk',
      null,
      { alpha_png_b64: ALPHA_1, priority: 'high' },
    ],
  });
  assert.equal(posts.length, 1);
  const options = posts[0].options;
  assert.equal(options.alpha_png_b64, ALPHA_1, 'the legacy mask still forwards as before');
  // The posted objects are created inside the vm realm; round-trip through
  // JSON so deepEqual compares values, not realm prototypes.
  assert.deepEqual(JSON.parse(JSON.stringify(options.variants)), [
    { alpha_png_b64: ALPHA_2, id: 'big', baseShortSide: 360, priority: 5 },
    { alpha_png_b64: ALPHA_3, id: 'std', baseShortSide: 240 },
    { alpha_png_b64: ALPHA_1 },
  ], 'baseWidth/baseHeight collapse to the short side; the RGB-mask variant, junk entries and a non-numeric priority field are dropped');
});

test('DL-04 (j): when no variant is valid, no variants key is forwarded and the rest of the config is untouched', async () => {
  for (const variants of [[{ alpha_png_b64: RGB_PNG }], 'not-an-array', 42]) {
    const posts = await configBridgePosts({ enabled: true, alpha_png_b64: ALPHA_1, variants });
    assert.equal(posts.length, 1);
    assert.equal(posts[0].options.variants, undefined, `variants=${JSON.stringify(variants)} forwards nothing`);
    assert.equal(posts[0].options.alpha_png_b64, ALPHA_1);
    assert.equal(posts[0].options.enabled, true);
  }
});
