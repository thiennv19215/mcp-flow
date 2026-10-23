import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// GPT-04 — ChatGPT result extraction over fixtures (study behavior B21).
// Given a completed assistant turn element, extract the generated image URLs
// via three tiers (generated-image, result-image, CDN-image), skipping
// blurred placeholders and uploaded refs (alt-text heuristic), with
// generated-first ordering and dedupe by the file id embedded in the URL.

const source = readFileSync(
  new URL('../extension/src/content/providers/chatgpt/generation/result-extraction.js', import.meta.url),
  'utf8',
);

function loadExtraction() {
  const sandbox = { console };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox.ChatGptResultExtraction;
}

function fakeImg({ src = '', alt = '', className = '', style = '', attrs = {} } = {}) {
  const map = { src, alt, class: className, style, ...attrs };
  return {
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(map, name) ? map[name] : null;
    },
  };
}

function fakeTurn(imgs) {
  return { querySelectorAll: (selector) => (selector === 'img' ? imgs.slice() : []) };
}

const ESTUARY = (id, extra = '') => `https://chatgpt.com/backend-api/estuary/content?id=${id}${extra}`;
const CDN = (path) => `https://files.oaiusercontent.com/${path}`;

test('mixed fixture: dedupes by file id, skips blurred placeholder, ref and unrelated images', () => {
  const { extractImageUrls, extractImages } = loadExtraction();
  const genA1 = ESTUARY('file_AAA111', '&ts=1&p=fs');
  const genA2 = CDN('file-AAA111/generated.png?se=2099&sp=r');
  const turn = fakeTurn([
    fakeImg({ src: genA1, alt: 'Generated image: a red cat on a roof' }),
    fakeImg({ src: genA2, alt: 'Generated image: a red cat on a roof' }),
    fakeImg({ src: ESTUARY('file_BLUR99'), alt: 'Generated image: still rendering', className: 'blur-lg' }),
    fakeImg({ src: CDN('file-REF777/upload.png'), alt: 'holiday-photo.png' }),
    fakeImg({ src: 'https://chatgpt.com/images/avatar.png', alt: 'ChatGPT' }),
  ]);
  assert.deepEqual([...extractImageUrls(turn)], [genA1]);
  const entries = extractImages(turn);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].tier, 'generated-image');
  assert.equal(entries[0].url, genA1);
});

test('empty turn and missing turn yield an empty list', () => {
  const { extractImageUrls } = loadExtraction();
  assert.deepEqual([...extractImageUrls(fakeTurn([]))], []);
  assert.deepEqual([...extractImageUrls(null)], []);
  assert.deepEqual([...extractImageUrls(undefined)], []);
  assert.deepEqual([...extractImageUrls({})], []);
});

test('a throwing query surface degrades to an empty list instead of throwing', () => {
  const { extractImageUrls } = loadExtraction();
  const broken = { querySelectorAll() { throw new Error('detached subtree'); } };
  assert.deepEqual([...extractImageUrls(broken)], []);
});

test('tier precedence: a generated-marked CDN image is reported once, as generated-image', () => {
  const { extractImages } = loadExtraction();
  const url = CDN('file-TIER01/pic.png');
  const turn = fakeTurn([fakeImg({ src: url, alt: 'Generated image: a lighthouse' })]);
  const entries = extractImages(turn);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].tier, 'generated-image');
  assert.equal(entries[0].generatedAlt, true);
});

test('CDN image with descriptive alt and no exclusion signals is included via the cdn-image tier', () => {
  const { extractImages } = loadExtraction();
  const url = CDN('file-CDN555/art.png');
  const turn = fakeTurn([fakeImg({ src: url, alt: 'A watercolor harbor at dawn' })]);
  const entries = extractImages(turn);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].tier, 'cdn-image');
  assert.equal(entries[0].generatedAlt, false);
});

test('generated-first ordering: generated-alt images precede descriptive-alt results regardless of DOM order', () => {
  const { extractImageUrls, extractImages } = loadExtraction();
  const descriptive = ESTUARY('file_BBB222');
  const generated = CDN('file-CCC333/pic.png');
  const turn = fakeTurn([
    fakeImg({ src: descriptive, alt: 'A blue dog running through snow' }),
    fakeImg({ src: generated, alt: 'Generated image: a blue dog running through snow' }),
  ]);
  assert.deepEqual([...extractImageUrls(turn)], [generated, descriptive]);
  const entries = extractImages(turn);
  assert.equal(entries[0].tier, 'generated-image');
  assert.equal(entries[1].tier, 'result-image');
});

test('blurred placeholders are skipped via style filter and placeholder data signals too', () => {
  const { extractImageUrls } = loadExtraction();
  const good = ESTUARY('file_OK0001');
  const turn = fakeTurn([
    fakeImg({ src: ESTUARY('file_BLUR01'), alt: 'Generated image: x', style: 'filter: blur(18px)' }),
    fakeImg({ src: ESTUARY('file_BLUR02'), alt: 'Generated image: y', attrs: { 'data-placeholder': 'true' } }),
    fakeImg({ src: good, alt: 'Generated image: the finished picture' }),
  ]);
  assert.deepEqual([...extractImageUrls(turn)], [good]);
});

test('uploaded refs are skipped: filename alt and empty alt, unless an explicit generated marker is present', () => {
  const { extractImageUrls } = loadExtraction();
  const marked = ESTUARY('file_MARK01');
  const turn = fakeTurn([
    fakeImg({ src: CDN('file-REF001/a.png'), alt: 'scan_2024.jpg' }),
    fakeImg({ src: ESTUARY('file_REF002'), alt: '' }),
    fakeImg({ src: ESTUARY('file_REF003'), alt: '   ' }),
    fakeImg({ src: marked, alt: '', attrs: { 'data-generated': 'true' } }),
  ]);
  assert.deepEqual([...extractImageUrls(turn)], [marked]);
});

test('dedupe falls back to the full URL when no file id is embedded', () => {
  const { extractImageUrls } = loadExtraction();
  const url = CDN('static/banner.webp');
  const turn = fakeTurn([
    fakeImg({ src: url, alt: 'A promotional banner' }),
    fakeImg({ src: url, alt: 'A promotional banner' }),
    fakeImg({ src: CDN('static/other.webp'), alt: 'Another banner' }),
  ]);
  assert.deepEqual([...extractImageUrls(turn)], [url, CDN('static/other.webp')]);
});

test('malformed images never throw: broken attribute reads and unusable sources are skipped', () => {
  const { extractImageUrls } = loadExtraction();
  const good = ESTUARY('file_GOOD01');
  const broken = { getAttribute() { throw new Error('gone'); } };
  const turn = fakeTurn([
    broken,
    null,
    fakeImg({ src: '', alt: 'Generated image: nothing' }),
    fakeImg({ src: 'data:image/png;base64,iVBORw0KGgo=', alt: 'Generated image: inline' }),
    fakeImg({ src: good, alt: 'Generated image: the real one' }),
  ]);
  assert.deepEqual([...extractImageUrls(turn)], [good]);
});

test('fileIdFromUrl extracts the embedded file id and normalizes the separator', () => {
  const { fileIdFromUrl } = loadExtraction();
  assert.equal(fileIdFromUrl(ESTUARY('file_AAA111', '&ts=1')), 'aaa111');
  assert.equal(fileIdFromUrl(CDN('file-AAA111/pic.png?se=1')), 'aaa111');
  assert.equal(fileIdFromUrl('https://chatgpt.com/images/avatar.png'), null);
  assert.equal(fileIdFromUrl('not a url at all'), null);
  assert.equal(fileIdFromUrl(''), null);
  assert.equal(fileIdFromUrl(null), null);
});
