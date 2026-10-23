import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

// GPT-05 — ChatGPT baseline snapshot + diff.
// ChatGPT result capture has no API/correlation signal: the content driver
// snapshots the conversation (turn identities + image URLs per turn)
// immediately before submit, and ALL later result attribution is a diff
// against that baseline. These tests pin the pure logic:
//  - identical snapshots -> no new turn, no new images;
//  - an appended USER turn is a new turn but contributes no result images
//    (user-turn images are uploaded refs, never results);
//  - appended assistant images -> exactly those URLs are new;
//  - a baseline image re-appearing (re-render / re-signed URL carrying the
//    same embedded file id, even inside a different turn) is NEVER new;
//  - malformed inputs degrade to empty snapshots/diffs, never throw.
// The DOM-reading builder consumes image extraction through an INJECTED
// extractor (GPT-04's result-extraction composes in later); tests pass
// fakes, plus one pass with the built-in img-scan default.

const baselineSource = readFileSync(
  new URL('../extension/src/content/providers/chatgpt/generation/baseline.js', import.meta.url),
  'utf8',
);

function loadBaseline() {
  const context = vm.createContext({ console, URL });
  vm.runInContext(baselineSource, context);
  assert.ok(context.ChatGptBaseline, 'module must expose ChatGptBaseline');
  return context.ChatGptBaseline;
}

// Module outputs live in the vm realm; round-trip them to host plain data
// (snapshots/diffs are JSON-serializable by contract) before deepEqual.
const plain = value => JSON.parse(JSON.stringify(value));

const FILE_A = 'https://files.oaiusercontent.com/file-AAA111?sig=one';
const FILE_A_RESIGNED = 'https://files.oaiusercontent.com/file-AAA111?sig=two';
const FILE_A_ALT_HOST = 'https://chatgpt.com/backend-api/estuary/content?id=file_AAA111&ts=9';
const FILE_B = 'https://files.oaiusercontent.com/file-BBB222?sig=one';
const FILE_C = 'https://files.oaiusercontent.com/file-CCC333?sig=one';
const PLAIN_1 = 'https://cdn.example.com/generated/plain-1.png';
const PLAIN_2 = 'https://cdn.example.com/generated/plain-2.png';
const REF_PREVIEW = 'https://files.oaiusercontent.com/file-REF999?sig=up';

// --------------------------------------------------------------------------
// Pure diff over plain snapshot data
// --------------------------------------------------------------------------

test('identical snapshots produce no new turn and no new images', () => {
  const { snapshotFromTurns, diffSnapshots } = loadBaseline();
  const turns = [
    { id: 't-user-1', role: 'user', imageUrls: [] },
    { id: 't-asst-1', role: 'assistant', imageUrls: [FILE_A, PLAIN_1] },
  ];
  const baseline = snapshotFromTurns(turns);
  const current = snapshotFromTurns(turns.map(t => ({ ...t, imageUrls: [...t.imageUrls] })));
  const diff = diffSnapshots(baseline, current);
  assert.deepEqual(plain(diff.newTurns), []);
  assert.deepEqual(plain(diff.newImages), []);
  assert.deepEqual(plain(diff.newImageUrls), []);
});

test('an appended user turn is detected as a new turn but contributes no result images', () => {
  const { snapshotFromTurns, diffSnapshots } = loadBaseline();
  const baseline = snapshotFromTurns([
    { id: 't-asst-1', role: 'assistant', imageUrls: [FILE_A] },
  ]);
  const current = snapshotFromTurns([
    { id: 't-asst-1', role: 'assistant', imageUrls: [FILE_A] },
    // The user turn carries the uploaded ref's preview image: still not a result.
    { id: 't-user-2', role: 'user', imageUrls: [REF_PREVIEW] },
  ]);
  const diff = diffSnapshots(baseline, current);
  assert.equal(diff.newTurns.length, 1);
  assert.equal(diff.newTurns[0].id, 't-user-2');
  assert.equal(diff.newTurns[0].role, 'user');
  assert.deepEqual(plain(diff.newImageUrls), []);
});

test('appended assistant images are exactly the URLs reported as new', () => {
  const { snapshotFromTurns, diffSnapshots } = loadBaseline();
  const baseline = snapshotFromTurns([
    { id: 't-user-1', role: 'user', imageUrls: [] },
    { id: 't-asst-1', role: 'assistant', imageUrls: [FILE_A] },
  ]);
  const current = snapshotFromTurns([
    { id: 't-user-1', role: 'user', imageUrls: [] },
    { id: 't-asst-1', role: 'assistant', imageUrls: [FILE_A] },
    { id: 't-user-2', role: 'user', imageUrls: [] },
    { id: 't-asst-2', role: 'assistant', imageUrls: [FILE_B, FILE_C] },
  ]);
  const diff = diffSnapshots(baseline, current);
  assert.deepEqual(plain(diff.newTurns.map(t => t.id)), ['t-user-2', 't-asst-2']);
  assert.deepEqual(plain(diff.newImageUrls), [FILE_B, FILE_C]);
  assert.deepEqual(plain(diff.newImages.map(i => i.turnId)), ['t-asst-2', 't-asst-2']);
});

test('a baseline image re-appearing re-signed or in another turn is never new', () => {
  const { snapshotFromTurns, diffSnapshots } = loadBaseline();
  const baseline = snapshotFromTurns([
    { id: 't-asst-1', role: 'assistant', imageUrls: [FILE_A] },
  ]);
  const current = snapshotFromTurns([
    // Same turn re-rendered: same file id, fresh signature.
    { id: 't-asst-1', role: 'assistant', imageUrls: [FILE_A_RESIGNED] },
    // A brand-new turn that quotes the same file via the other host form.
    { id: 't-asst-2', role: 'assistant', imageUrls: [FILE_A_ALT_HOST, FILE_B] },
  ]);
  const diff = diffSnapshots(baseline, current);
  assert.deepEqual(plain(diff.newTurns.map(t => t.id)), ['t-asst-2']);
  assert.deepEqual(plain(diff.newImageUrls), [FILE_B]);
});

test('new images dedupe by file id, falling back to the full URL', () => {
  const { snapshotFromTurns, diffSnapshots } = loadBaseline();
  const baseline = snapshotFromTurns([{ id: 't-asst-1', role: 'assistant', imageUrls: [] }]);
  const current = snapshotFromTurns([
    {
      id: 't-asst-1',
      role: 'assistant',
      imageUrls: [FILE_B, FILE_B.replace('sig=one', 'sig=two'), PLAIN_1, PLAIN_1, PLAIN_2],
    },
  ]);
  const diff = diffSnapshots(baseline, current);
  assert.deepEqual(plain(diff.newImageUrls), [FILE_B, PLAIN_1, PLAIN_2]);
});

test('malformed inputs degrade to empty snapshots and diffs, never throw', () => {
  const B = loadBaseline();
  assert.deepEqual(plain(B.diffSnapshots(null, undefined).newImageUrls), []);
  assert.deepEqual(plain(B.diffSnapshots(undefined, null).newTurns), []);
  assert.deepEqual(plain(B.diffSnapshots({}, { turns: 'nope' }).newImageUrls), []);
  const empty = B.normalizeSnapshot(null);
  assert.deepEqual(plain(empty.turns), []);
  assert.deepEqual(plain(empty.imageKeys), []);
  const coerced = B.snapshotFromTurns([null, 42, { id: 'x', imageUrls: [42, null, PLAIN_1] }]);
  assert.equal(coerced.turns.length, 1);
  assert.deepEqual(plain(coerced.turns[0].imageUrls), [PLAIN_1]);
  assert.deepEqual(plain(B.diffSnapshots(coerced, coerced).newImageUrls), []);
});

// --------------------------------------------------------------------------
// DOM snapshot builder with an injected extractor
// --------------------------------------------------------------------------

function fakeImg(src) {
  return {
    tagName: 'IMG',
    src,
    currentSrc: src,
    getAttribute(name) { return name === 'src' ? src : null; },
  };
}

function fakeTurn({ attrs = {}, imgs = [], roleEl = null } = {}) {
  return {
    getAttribute(name) { return attrs[name] ?? null; },
    querySelectorAll(selector) { return selector === 'img' ? imgs : []; },
    querySelector(selector) { return selector === '[data-message-author-role]' ? roleEl : null; },
  };
}

function fakeRoot(bySelector) {
  return { querySelectorAll(selector) { return bySelector[selector] ?? []; } };
}

test('captureBaseline reads attribute identities and roles, using the injected extractor', () => {
  const B = loadBaseline();
  const userTurn = fakeTurn({ attrs: { 'data-turn-id': 't-user-1', 'data-turn': 'user' } });
  const asstTurn = fakeTurn({ attrs: { 'data-turn-id': 't-asst-1', 'data-turn': 'assistant' } });
  const root = fakeRoot({ '[data-turn-id]': [userTurn, asstTurn] });
  const extractor = el => (el === asstTurn ? [{ url: FILE_A }, { url: PLAIN_1 }] : []);
  const snapshot = B.captureBaseline(root, { extractImageUrls: extractor });
  assert.deepEqual(plain(snapshot.turns.map(t => t.id)), ['t-user-1', 't-asst-1']);
  assert.deepEqual(plain(snapshot.turns.map(t => t.role)), ['user', 'assistant']);
  assert.deepEqual(plain(snapshot.turns[1].imageUrls), [FILE_A, PLAIN_1]);
  assert.deepEqual(plain(snapshot.turns[0].imageUrls), []);
});

test('captureBaseline identity is stable across re-renders (fresh elements, same attributes)', () => {
  const B = loadBaseline();
  const build = () => fakeRoot({
    '[data-turn-id]': [
      fakeTurn({ attrs: { 'data-turn-id': 't-asst-1', 'data-turn': 'assistant' }, imgs: [fakeImg(FILE_A)] }),
    ],
  });
  const before = B.captureBaseline(build());
  const after = B.captureBaseline(build());
  const diff = B.diffSnapshots(before, after);
  assert.deepEqual(plain(diff.newTurns), []);
  assert.deepEqual(plain(diff.newImageUrls), []);
});

test('captureBaseline falls back to positional identities when no attributes exist', () => {
  const B = loadBaseline();
  const bare = () => fakeTurn({});
  const before = B.captureBaseline(fakeRoot({ article: [bare(), bare()] }));
  assert.deepEqual(plain(before.turns.map(t => t.id)), ['turn:0', 'turn:1']);
  const after = B.captureBaseline(fakeRoot({ article: [bare(), bare(), bare()] }));
  const diff = B.diffSnapshots(before, after);
  assert.deepEqual(plain(diff.newTurns.map(t => t.id)), ['turn:2']);
});

test('captureBaseline defaults to an img scan and survives bad roots and throwing extractors', () => {
  const B = loadBaseline();
  const turn = fakeTurn({
    attrs: { 'data-turn-id': 't-asst-1', 'data-turn': 'assistant' },
    imgs: [fakeImg(FILE_B)],
  });
  const scanned = B.captureBaseline(fakeRoot({ '[data-turn-id]': [turn] }));
  assert.deepEqual(plain(scanned.turns[0].imageUrls), [FILE_B]);

  assert.deepEqual(plain(B.captureBaseline(null).turns), []);
  assert.deepEqual(plain(B.captureBaseline({}).turns), []);

  const throwing = B.captureBaseline(fakeRoot({ '[data-turn-id]': [turn] }), {
    extractImageUrls() { throw new Error('extractor boom'); },
  });
  assert.equal(throwing.turns.length, 1);
  assert.deepEqual(plain(throwing.turns[0].imageUrls), []);
});
