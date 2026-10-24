import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

import {
  CHATGPT_DEFAULT_RATIO_SEMANTIC,
  loadChatGptCapabilityRegistry,
  maxRefImagesFor,
  normalizeChatGptRatio,
  parseChatGptCapabilityRegistry,
  ratioSemanticsFor,
  supportedRatiosFor,
} from '../extension/src/background/chatgpt-capabilities.js';

const rootRegistry = JSON.parse(
  readFileSync(new URL('../chatgpt-model-capabilities.json', import.meta.url), 'utf8'),
);

// --- Ratio normalization: spelling -> semantic bucket -----------------------

const RATIO_CASES = [
  // Canonical spellings (study §D.2 ratioSemantics).
  ['16:9', 'widescreen'],
  ['9:16', 'story'],
  ['1:1', 'square'],
  ['4:3', 'landscape'],
  ['3:4', 'portrait'],
  // Separator / whitespace variants.
  ['16x9', 'widescreen'],
  ['16/9', 'widescreen'],
  ['16-9', 'widescreen'],
  ['16 : 9', 'widescreen'],
  ['  9:16  ', 'story'],
  ['9X16', 'story'],
  // Reducible spellings normalize to the canonical ratio first.
  ['32:18', 'widescreen'],
  ['18:32', 'story'],
  ['8:6', 'landscape'],
  ['6:8', 'portrait'],
  ['2:2', 'square'],
  // Semantic words pass through (case-insensitive).
  ['widescreen', 'widescreen'],
  ['WideScreen', 'widescreen'],
  ['story', 'story'],
  ['square', 'square'],
  ['landscape', 'landscape'],
  ['portrait', 'portrait'],
  // English descriptive labels.
  ['wide', 'widescreen'],
  ['horizontal', 'landscape'],
  ['vertical', 'portrait'],
  // Vietnamese localized labels (with and without diacritics).
  ['vuông', 'square'],
  ['vuong', 'square'],
  ['hình vuông', 'square'],
  ['dọc', 'portrait'],
  ['doc', 'portrait'],
  ['chân dung', 'portrait'],
  ['chan dung', 'portrait'],
  ['ngang', 'landscape'],
  ['khổ ngang', 'landscape'],
  ['kho ngang', 'landscape'],
  ['màn hình rộng', 'widescreen'],
  ['man hinh rong', 'widescreen'],
  ['câu chuyện', 'story'],
  ['cau chuyen', 'story'],
  // A ratio embedded in a longer label wins over the label words.
  ['Ngang (4:3)', 'landscape'],
  ['Story 9:16', 'story'],
  ['Aspect ratio: 3:4', 'portrait'],
];

for (const [input, expected] of RATIO_CASES) {
  test(`normalizeChatGptRatio(${JSON.stringify(input)}) -> ${expected}`, () => {
    assert.equal(normalizeChatGptRatio(input), expected);
  });
}

const GARBAGE_CASES = [
  '',
  '   ',
  'auto',
  'abc',
  'ultrawide',
  '21:9',
  '2:3',
  '0:0',
  '16:0',
  '0:9',
  null,
  undefined,
  42,
  1.78,
  Number.NaN,
  {},
  [],
  ['16:9'],
];

for (const input of GARBAGE_CASES) {
  test(`normalizeChatGptRatio(garbage ${String(input)}) -> default bucket, never throws`, () => {
    assert.equal(normalizeChatGptRatio(input), CHATGPT_DEFAULT_RATIO_SEMANTIC);
  });
}

test('the default bucket is one of the five semantic buckets', () => {
  assert.ok(['widescreen', 'story', 'square', 'landscape', 'portrait'].includes(CHATGPT_DEFAULT_RATIO_SEMANTIC));
});

test('normalizeChatGptRatio honors a registry-provided semantics map', () => {
  const semantics = { '16:9': 'widescreen', '9:16': 'story', '1:1': 'square', '4:3': 'landscape', '3:4': 'portrait' };
  assert.equal(normalizeChatGptRatio('4:3', semantics), 'landscape');
  // A spelling absent from a custom map falls back to the default bucket.
  assert.equal(normalizeChatGptRatio('16:9', {}), CHATGPT_DEFAULT_RATIO_SEMANTIC);
});

// --- Capability registry ----------------------------------------------------

test('registry parses and exposes defaults: maxRefImages, ratios, semantics', () => {
  const registry = parseChatGptCapabilityRegistry(rootRegistry);
  assert.ok(registry, 'root chatgpt-model-capabilities.json must parse');
  assert.equal(typeof registry.defaults.maxRefImages, 'number');
  assert.ok(registry.defaults.maxRefImages > 0);
  assert.deepEqual(registry.defaults.supportedRatios, ['16:9', '9:16', '1:1', '4:3', '3:4']);
  assert.deepEqual(ratioSemanticsFor(registry), {
    '16:9': 'widescreen',
    '9:16': 'story',
    '1:1': 'square',
    '4:3': 'landscape',
    '3:4': 'portrait',
  });
});

test('registry exposes per-model maxRefImages and supported ratios', () => {
  const registry = parseChatGptCapabilityRegistry(rootRegistry);
  assert.ok(Array.isArray(registry.models) && registry.models.length > 0);
  for (const model of registry.models) {
    assert.equal(typeof model.maxRefImages, 'number', `model ${model.match} must expose maxRefImages`);
    assert.ok(Array.isArray(model.aspectRatios) && model.aspectRatios.length > 0, `model ${model.match} must expose ratios`);
  }
  // A known ChatGPT image model resolves to its rule, not just the defaults.
  const ruleMax = maxRefImagesFor(registry, 'gpt-4o');
  assert.equal(ruleMax, registry.models[0].maxRefImages);
  assert.deepEqual(supportedRatiosFor(registry, 'gpt-4o'), registry.models[0].aspectRatios);
});

test('unknown model falls back to registry defaults', () => {
  const registry = parseChatGptCapabilityRegistry(rootRegistry);
  assert.equal(maxRefImagesFor(registry, 'some-future-model'), registry.defaults.maxRefImages);
  assert.deepEqual(supportedRatiosFor(registry, 'some-future-model'), registry.defaults.supportedRatios);
  assert.equal(maxRefImagesFor(registry, ''), registry.defaults.maxRefImages);
  assert.equal(maxRefImagesFor(registry, undefined), registry.defaults.maxRefImages);
});

test('capabilities block mirrors the study contract (image-only, refs, ratios)', () => {
  const registry = parseChatGptCapabilityRegistry(rootRegistry);
  assert.equal(registry.capabilities.supportsRatio, true);
  assert.equal(registry.capabilities.supportsRefImage, true);
  assert.equal(registry.capabilities.supportsVideo, false);
  assert.equal(registry.capabilities.supportsQuantity, false);
  assert.equal(registry.capabilities.supportsAutoDownload, true);
});

test('parse rejects garbage instead of throwing', () => {
  assert.equal(parseChatGptCapabilityRegistry(null), null);
  assert.equal(parseChatGptCapabilityRegistry(undefined), null);
  assert.equal(parseChatGptCapabilityRegistry('nope'), null);
  assert.equal(parseChatGptCapabilityRegistry(42), null);
  assert.equal(parseChatGptCapabilityRegistry({}), null);
  assert.equal(parseChatGptCapabilityRegistry({ version: 1 }), null);
});

test('accessors degrade to built-in defaults when the registry is missing', () => {
  assert.equal(typeof maxRefImagesFor(null), 'number');
  assert.deepEqual(supportedRatiosFor(null), ['16:9', '9:16', '1:1', '4:3', '3:4']);
  assert.equal(ratioSemanticsFor(null)['9:16'], 'story');
});

// --- Loader (mirrors the service worker Flow registry loader) ----------------

function fakeFetch(response) {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    if (response instanceof Error) throw response;
    return response;
  };
  return { fetchImpl, calls };
}

test('loader fetches chatgpt-model-capabilities.json and parses it', async () => {
  const { fetchImpl, calls } = fakeFetch({
    ok: true,
    json: async () => rootRegistry,
  });
  const registry = await loadChatGptCapabilityRegistry({
    fetchImpl,
    getURL: path => `chrome-extension://test/${path}`,
  });
  assert.deepEqual(calls, ['chrome-extension://test/chatgpt-model-capabilities.json']);
  assert.ok(registry);
  assert.equal(maxRefImagesFor(registry, 'gpt-4o'), rootRegistry.models[0].maxRefImages);
});

test('loader returns null on http failure, network failure, or invalid json', async () => {
  const notOk = fakeFetch({ ok: false, json: async () => rootRegistry });
  assert.equal(await loadChatGptCapabilityRegistry({ fetchImpl: notOk.fetchImpl, getURL: p => p }), null);

  const boom = fakeFetch(new Error('offline'));
  assert.equal(await loadChatGptCapabilityRegistry({ fetchImpl: boom.fetchImpl, getURL: p => p }), null);

  const invalid = fakeFetch({ ok: true, json: async () => ({ hello: 'world' }) });
  assert.equal(await loadChatGptCapabilityRegistry({ fetchImpl: invalid.fetchImpl, getURL: p => p }), null);
});

// --- Build sync --------------------------------------------------------------

test('build sync copies the registry into the extension source tree', () => {
  const syncedPath = new URL('../extension/chatgpt-model-capabilities.json', import.meta.url);
  assert.ok(existsSync(syncedPath), 'extension/chatgpt-model-capabilities.json must exist after the sync step');
  assert.deepEqual(JSON.parse(readFileSync(syncedPath, 'utf8')), rootRegistry);
});

test('build copies the registry into dist/extension', () => {
  const packagedPath = new URL('../dist/extension/chatgpt-model-capabilities.json', import.meta.url);
  assert.ok(existsSync(packagedPath), 'dist/extension/chatgpt-model-capabilities.json must exist after a build');
  assert.deepEqual(JSON.parse(readFileSync(packagedPath, 'utf8')), rootRegistry);
});
