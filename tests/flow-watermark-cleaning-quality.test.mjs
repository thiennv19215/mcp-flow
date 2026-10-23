import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

// DL-11 — Cleaning quality: dual gain estimate + edge smoothing.
// Phase 0 (study-download-watermark G11 / W4): the reference estimates the
// removal gain two independent ways — from the patch itself and from the
// surrounding background — keeps whichever yields the lower post-apply
// roughness, and smooths the patch edges. Our single roughness-only
// estimator compares each restored pixel against its still-watermarked
// neighbors, so on dense alpha patterns it under-estimates the gain badly:
// measured on the fixtures below, the pre-DL-11 code picks gain 0.45 for a
// watermark rendered at gain 1.0 and remove() ends in verification_failed
// (nccAfter 0.99 uniform / 0.98 textured). A manual apply with that single
// estimate leaves patch roughness 25.96 (uniform) / 24.03 (textured) and a
// patch-border gradient step of 111.96 / 103.41 — the pinned baselines the
// assertions below compare against. The true-gain floor is roughness
// 0.89 / 4.48 and border step 2.00 / 7.39, so the thresholds sit far from
// both the broken baseline and the ideal.

const removerSource = readFileSync(new URL('../extension/src/content/bridge/WatermarkRemover.js', import.meta.url), 'utf8');

function hash2(a, b, seed) {
  let h = (seed * 374761393 + a * 668265263 + b * 974634211) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// Dense alpha mask: 2x2 blocks (most neighbors of a mask pixel are themselves
// watermarked — the case that biases the patch-only estimator), alpha holes
// for the surround estimator to sample, and a strong border ring so the
// patch edge carries real alpha.
function makeMask(seed, width = 44, height = 22, block = 2) {
  const LEVELS = [0, 110, 190, 240];
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let value = LEVELS[Math.floor(hash2(Math.floor(x / block), Math.floor(y / block), seed) * 4) % 4];
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) value = Math.max(value, 200);
      data[y * width + x] = value;
    }
  }
  return { width, height, data };
}
const MASK = makeMask(5);

const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));

// Renders the watermark exactly the way the remover models it:
// observed = bg * (1 - a*g) + 255 * a*g, with the same 0.98 alpha clamp.
function render(width, height, bgFn, mask, ox, oy, gain = 1) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      data[offset] = data[offset + 1] = data[offset + 2] = bgFn(x, y);
      data[offset + 3] = 255;
    }
  }
  for (let my = 0; my < mask.height; my++) {
    for (let mx = 0; mx < mask.width; mx++) {
      const a = clamp(mask.data[my * mask.width + mx] / 255, 0, 0.98) * gain;
      if (a <= 0) continue;
      const offset = ((oy + my) * width + (ox + mx)) * 4;
      for (let channel = 0; channel < 3; channel++) data[offset + channel] = data[offset + channel] * (1 - a) + 255 * a;
    }
  }
  return { width, height, data };
}

const W = 200;
const H = 140;
const OX = 150;
const OY = 105;
const UNIFORM_BG = () => 100;
const TEXTURED_BG = (x, y) => Math.round(112 + 24 * Math.sin(x / 3.1) * Math.cos(y / 2.3) + (hash2(x, y, 99) - 0.5) * 14);

const lumaAt = (image, x, y) => {
  const offset = (y * image.width + x) * 4;
  return 0.2126 * image.data[offset] + 0.7152 * image.data[offset + 1] + 0.0722 * image.data[offset + 2];
};

// Mean |pixel - mean(4 neighbors)| over the mask's watermarked pixels of a
// RESULT image — the honest post-clean roughness (neighbors already cleaned).
function patchRoughness(image, mask, ox, oy) {
  let sum = 0;
  let count = 0;
  for (let my = 0; my < mask.height; my++) {
    for (let mx = 0; mx < mask.width; mx++) {
      if (mask.data[my * mask.width + mx] / 255 < 0.05) continue;
      const x = ox + mx;
      const y = oy + my;
      if (x <= 0 || y <= 0 || x >= image.width - 1 || y >= image.height - 1) continue;
      const neighbor = (lumaAt(image, x - 1, y) + lumaAt(image, x + 1, y) + lumaAt(image, x, y - 1) + lumaAt(image, x, y + 1)) / 4;
      sum += Math.abs(lumaAt(image, x, y) - neighbor);
      count++;
    }
  }
  return count ? sum / count : Number.NaN;
}

// Mean gradient step across the patch rectangle's perimeter: the halo gauge.
function edgeDiscontinuity(image, mask, ox, oy) {
  let sum = 0;
  let count = 0;
  for (let mx = 0; mx < mask.width; mx++) {
    sum += Math.abs(lumaAt(image, ox + mx, oy) - lumaAt(image, ox + mx, oy - 1));
    sum += Math.abs(lumaAt(image, ox + mx, oy + mask.height - 1) - lumaAt(image, ox + mx, oy + mask.height));
    count += 2;
  }
  for (let my = 0; my < mask.height; my++) {
    sum += Math.abs(lumaAt(image, ox, oy + my) - lumaAt(image, ox - 1, oy + my));
    sum += Math.abs(lumaAt(image, ox + mask.width - 1, oy + my) - lumaAt(image, ox + mask.width, oy + my));
    count += 2;
  }
  return sum / count;
}

class FakeImageData {
  constructor(data, width, height) {
    this.data = data;
    this.width = width;
    this.height = height;
  }
}

function loadRemover() {
  const sandbox = { console, ImageData: FakeImageData };
  const context = vm.createContext(sandbox);
  vm.runInContext(removerSource, context);
  return context.WatermarkRemover;
}

function cleanFixture(bgFn) {
  const Remover = loadRemover();
  const remover = new Remover({ mask: MASK });
  const fixture = render(W, H, bgFn, MASK, OX, OY, 1);
  const result = remover.remove(new FakeImageData(fixture.data, fixture.width, fixture.height));
  return { remover, fixture, result };
}

test('DL-11 (a): uniform background — the dense-pattern fixture that failed verification now cleans', () => {
  const { result } = cleanFixture(UNIFORM_BG);
  assert.equal(result.changed, true, `the gain under-estimate must no longer end in verification_failed (got reason=${result.reason}, nccAfter=${result.nccAfter})`);
  assert.ok(result.nccBefore > 0.68, `detection fed the removal (got ${result.nccBefore})`);
  assert.ok(result.nccAfter <= 0.25, `the cleaned patch verifies below minNccAfter (got ${result.nccAfter})`);
  assert.ok(result.gain >= 0.8 && result.gain <= 1.25, `the chosen gain tracks the true gain 1.0, not the biased 0.45 (got ${result.gain})`);
  // Result shape is unchanged from the pre-DL-11 contract.
  assert.equal(result.variant, null);
  assert.equal(result.scale, 1);
  assert.ok(result.image, 'a cleaned image is returned');
  const roughness = patchRoughness({ width: W, height: H, data: result.image.data }, MASK, result.x, Math.round(result.y));
  assert.ok(roughness <= 25.96, `post-clean roughness beats the single-estimate baseline 25.96 (got ${roughness})`);
  assert.ok(roughness <= 8, `post-clean roughness is near the true-gain floor 0.89, not merely under the baseline (got ${roughness})`);
});

test('DL-11 (b): textured background — dual estimate wins there too, roughness under the baseline', () => {
  const { result } = cleanFixture(TEXTURED_BG);
  assert.equal(result.changed, true, `textured fixture must clean (got reason=${result.reason}, nccAfter=${result.nccAfter})`);
  assert.ok(result.nccAfter <= 0.25, `verifies below minNccAfter (got ${result.nccAfter})`);
  assert.ok(result.gain >= 0.8 && result.gain <= 1.25, `gain tracks the true 1.0 (got ${result.gain})`);
  const roughness = patchRoughness({ width: W, height: H, data: result.image.data }, MASK, result.x, Math.round(result.y));
  assert.ok(roughness <= 24.03, `post-clean roughness beats the single-estimate baseline 24.03 (got ${roughness})`);
  assert.ok(roughness <= 10, `post-clean roughness is near the true-gain floor 4.48 (got ${roughness})`);
});

test('DL-11 (c): patch-border gradient step collapses on both fixtures (no halo ring)', () => {
  for (const [name, bgFn, baseline] of [['uniform', UNIFORM_BG, 111.96], ['textured', TEXTURED_BG, 103.41]]) {
    const { result } = cleanFixture(bgFn);
    assert.equal(result.changed, true, `${name} fixture cleans`);
    const step = edgeDiscontinuity({ width: W, height: H, data: result.image.data }, MASK, result.x, Math.round(result.y));
    assert.ok(step <= baseline, `${name}: border step beats the single-estimate baseline ${baseline} (got ${step})`);
    assert.ok(step <= 12, `${name}: border step is in the true-gain range, not a halo (got ${step})`);
  }
});

test('DL-11 (d): the surround estimator recovers the true gain where the patch estimator stays biased', () => {
  const Remover = loadRemover();
  const remover = new Remover({ mask: MASK });
  for (const [name, bgFn] of [['uniform', UNIFORM_BG], ['textured', TEXTURED_BG]]) {
    const fixture = render(W, H, bgFn, MASK, OX, OY, 1);
    const patchGain = remover._estimateGainFromPatch(fixture, MASK, OX, OY);
    const surroundGain = remover._estimateGainFromSurround(fixture, MASK, OX, OY);
    const chosen = remover._estimateGain(fixture, MASK, OX, OY);
    assert.ok(patchGain <= 0.65, `${name}: the legacy patch-only estimator is the biased one (got ${patchGain})`);
    assert.ok(surroundGain !== null && Math.abs(surroundGain - 1) <= 0.15, `${name}: the surround estimator recovers the true gain (got ${surroundGain})`);
    assert.ok(Math.abs(chosen - 1) <= 0.15, `${name}: the dual selection picks the surround winner (got ${chosen})`);
    assert.equal(remover._estimateGain(fixture, MASK, OX, OY), chosen, `${name}: selection is deterministic`);
  }
});

test('DL-11 (e): edge smoothing blends only the border band — the patch interior is bit-identical', () => {
  const Remover = loadRemover();
  const remover = new Remover({});
  const width = 60;
  const height = 40;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index++) {
    data[index * 4] = data[index * 4 + 1] = data[index * 4 + 2] = 100;
    data[index * 4 + 3] = 255;
  }
  const mask = { width: 12, height: 12, data: new Uint8Array(12 * 12).fill(200) };
  const px = 20;
  const py = 12;
  // A "cleaned but stepped" patch: every patch pixel sits at 170 against the
  // 100 surround — a 70-step across the border before smoothing.
  for (let my = 0; my < 12; my++) {
    for (let mx = 0; mx < 12; mx++) {
      const offset = ((py + my) * width + (px + mx)) * 4;
      data[offset] = data[offset + 1] = data[offset + 2] = 170;
    }
  }
  const image = new FakeImageData(data, width, height);
  const borderBefore = lumaAt(image, px, py + 5) - lumaAt(image, px - 1, py + 5);
  remover._smoothPatchEdges(image, mask, { x: px, y: py });
  const at = (x, y) => image.data[(y * width + x) * 4];
  assert.equal(at(px + 6, py + 6), 170, 'interior pixels (distance >= blend width) are untouched');
  assert.equal(at(px - 1, py + 5), 100, 'pixels outside the patch are untouched');
  const borderAfter = at(px, py + 5) - at(px - 1, py + 5);
  assert.ok(borderAfter < borderBefore - 5, `the border step shrinks (was ${borderBefore}, now ${borderAfter})`);
  assert.ok(at(px, py + 5) > 100 && at(px, py + 5) < 170, 'the border pixel blends toward the surround instead of jumping');
});

test('DL-11 (f): a patch with no clean surround anywhere still returns an honest result, never a crash', () => {
  const Remover = loadRemover();
  const remover = new Remover({ mask: MASK });
  // The mask covers the whole frame: the surround estimator has almost no
  // clean pixels to sample and must degrade to the patch estimate.
  const fixture = render(MASK.width, MASK.height, UNIFORM_BG, MASK, 0, 0, 1);
  const result = remover.remove(new FakeImageData(fixture.data, fixture.width, fixture.height));
  assert.equal(typeof result.changed, 'boolean');
  assert.ok(
    result.changed === true || result.reason === 'verification_failed' || result.reason === 'watermark_not_found',
    `an honest outcome (got changed=${result.changed}, reason=${result.reason})`,
  );
});

test('DL-11 (g): unchanged contracts — a logo-free image still reports watermark_not_found', () => {
  const Remover = loadRemover();
  const remover = new Remover({ mask: MASK });
  const data = new Uint8ClampedArray(W * H * 4);
  for (let index = 0; index < W * H; index++) {
    data[index * 4] = data[index * 4 + 1] = data[index * 4 + 2] = UNIFORM_BG();
    data[index * 4 + 3] = 255;
  }
  const result = remover.remove(new FakeImageData(data, W, H));
  assert.equal(result.changed, false);
  assert.equal(result.reason, 'watermark_not_found');
});
