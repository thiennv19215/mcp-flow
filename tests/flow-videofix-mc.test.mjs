import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const observerSource = readFileSync(new URL('../extension/src/content/bridge/flow-correlation-observer.js', import.meta.url), 'utf8');
const projectId = '00000000-0000-4000-8000-000000000000';
const REF = '11111111-2222-4333-8444-555555555555';
const EXTRA = '22222222-3333-4444-8555-666666666666';
const PROMPT = 'a cat sits on a sunny windowsill';

function observerHarness() {
  const listeners = new Map();
  const receipts = [];
  const window = {
    addEventListener(type, listener) {
      const entries = listeners.get(type) || [];
      entries.push(listener);
      listeners.set(type, entries);
    },
    removeEventListener(type, listener) {
      listeners.set(type, (listeners.get(type) || []).filter((entry) => entry !== listener));
    },
    dispatchEvent(event) {
      for (const listener of listeners.get(event.type) || []) listener(event);
      return true;
    },
    fetch: async () => ({ status: 200, clone: () => ({ text: async () => '' }) }),
  };
  class FakeXHR {
    open() {}
    send() {}
    addEventListener() {}
  }
  class FakeCustomEvent {
    constructor(type, options = {}) { this.type = type; this.detail = options.detail; }
  }
  window.CustomEvent = FakeCustomEvent;
  window.addEventListener('TOBY_FLOW_V2_CORRELATION_RECEIPT', (event) => receipts.push(event.detail));
  const context = vm.createContext({
    window,
    XMLHttpRequest: FakeXHR,
    CustomEvent: FakeCustomEvent,
    URL,
    URLSearchParams,
    FormData,
    ArrayBuffer,
    Uint8Array,
    TextDecoder,
    Blob,
    Request,
    location: { href: `https://labs.google/u/0/project/${projectId}`, origin: 'https://labs.google', pathname: `/u/0/project/${projectId}` },
    console: { info() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    Date,
    Map,
    WeakMap,
    Object,
    Array,
    Math,
    Number,
    String,
    RegExp,
    JSON,
    Promise,
  });
  vm.runInContext(observerSource, context);
  return { window, receipts };
}

function promptFingerprint(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `id-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

// [2]-layout row: row[2] = model string, row[3] = ratio enum, row[0] carries
// the first ref (as [null, uuid]) plus the prompt nodes at row[0][2][0].
// A second ref rides row[8] (the other reference slot for this layout).
function videoRow({ model = 'veo-3', ratio = 2, refs = [REF], prompt = PROMPT } = {}) {
  const nodes = [[prompt, null]];
  const row = [[null, refs[0] ?? null, [nodes]], null, model, ratio];
  if (refs[1] != null) row[8] = [null, refs[1]];
  return row;
}

function armVideo(window, { expectedQuantity = 1, prompt = PROMPT, attemptId = '00000000-0000-4000-8000-000000000001' } = {}) {
  window.dispatchEvent(new window.CustomEvent('TOBY_FLOW_V2_CORRELATION_ARM', {
    detail: {
      schemaVersion: 1,
      nonce: 'test-nonce-12345678',
      attemptId,
      mediaType: 'video',
      projectId,
      expectedQuantity,
      promptFingerprint: promptFingerprint(prompt),
      expectedVideoModelKey: 'veo-3',
      expectedVideoRatioEnum: 2,
      expectedReferenceIds: [REF],
      expectedMediaReferenceIds: [],
      expectedCharacterIds: [],
      ttlMs: 60000,
    },
  }));
}

async function sendRequest(window, rows) {
  const payload = [rows];
  const fReq = JSON.stringify([[['rpc.videoFixture', JSON.stringify(payload), null]]]);
  await window.fetch('https://labs.google/u/0/_/AiSandboxAngularFrontend/data/batchexecute', {
    method: 'POST',
    body: new URLSearchParams({ 'f.req': fReq }).toString(),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function requestSeen(receipts) {
  return receipts.find((receipt) => receipt.stage === 'request_seen');
}

test('M-C control: exact video request still matches strictly', async () => {
  const { window, receipts } = observerHarness();
  armVideo(window);
  await sendRequest(window, [videoRow()]);
  const seen = requestSeen(receipts);
  assert.ok(seen, 'expected a request_seen receipt');
  assert.ok(!String(seen.matchKind || '').startsWith('weak_'), 'strict match must not be marked weak');
});

test('M-C pin (VID-03): a different model wire key is still rejected — model is output identity', async () => {
  const { window, receipts } = observerHarness();
  armVideo(window);
  await sendRequest(window, [videoRow({ model: 'veo-3-renamed-key' })]);
  assert.equal(requestSeen(receipts), undefined,
    'a different model key must not weak-match: it is a different generation, and the observer has no wire-key registry to tell a renamed key from a different model');
});

test('M-C pin (VID-03): a different ratio enum is still rejected — ratio is output identity', async () => {
  const { window, receipts } = observerHarness();
  armVideo(window);
  await sendRequest(window, [videoRow({ ratio: 3 })]);
  assert.equal(requestSeen(receipts), undefined,
    'a different ratio enum must not weak-match: it is a different aspect, i.e. a different generation');
});

test('M-C: Flow-injected extra reference alone is accepted as a weak match', async () => {
  const { window, receipts } = observerHarness();
  armVideo(window);
  await sendRequest(window, [videoRow({ refs: [REF, EXTRA] })]);
  const seen = requestSeen(receipts);
  assert.ok(seen, 'expected a request_seen receipt for the extra-ref request');
  assert.equal(seen.matchKind, 'weak_refs');
});

test('M-C: quantity split alone is accepted as a weak match', async () => {
  const { window, receipts } = observerHarness();
  armVideo(window);
  // Two rows carrying the same prompt/model/ratio/refs union: Flow split
  // one variant into two request rows. The second row carries no ref so
  // the reference set stays exact and quantity is the only deviation.
  await sendRequest(window, [videoRow(), videoRow({ refs: [] })]);
  const seen = requestSeen(receipts);
  assert.ok(seen, 'expected a request_seen receipt for the quantity-deviation request');
  assert.equal(seen.matchKind, 'weak_quantity');
});

test('M-C pin: wholly different prompt is still rejected', async () => {
  const { window, receipts } = observerHarness();
  armVideo(window);
  await sendRequest(window, [videoRow({ prompt: 'a completely unrelated dog video' })]);
  assert.equal(requestSeen(receipts), undefined);
});

test('M-C pin: two simultaneous deviations are still rejected', async () => {
  const { window, receipts } = observerHarness();
  armVideo(window);
  await sendRequest(window, [videoRow({ model: 'veo-3-renamed-key', ratio: 3 })]);
  assert.equal(requestSeen(receipts), undefined);
});

test('M-C: a strict claim beats a weak claim — no interference, no cross-attribution', async () => {
  const { window, receipts } = observerHarness();
  armVideo(window, { expectedQuantity: 1, attemptId: '00000000-0000-4000-8000-000000000001' });
  armVideo(window, { expectedQuantity: 2, attemptId: '00000000-0000-4000-8000-000000000002' });
  // Two rows, each carrying the ref: a strict match for the quantity-2
  // attempt (per-row model/ratio/refs all exact), only a weak quantity
  // match for the quantity-1 attempt (same refs union, wrong row count).
  // The strict winner must claim the request and the weak loser must
  // drop silently — neither attempt may be marked interfered.
  await sendRequest(window, [videoRow(), videoRow()]);
  const seen = receipts.filter((receipt) => receipt.stage === 'request_seen');
  assert.equal(seen.length, 1, 'exactly one request_seen receipt');
  assert.equal(seen[0].attemptId, '00000000-0000-4000-8000-000000000002');
  assert.ok(!String(seen[0].matchKind || '').startsWith('weak_'), 'the strict winner is not marked weak');
  assert.ok(!receipts.some((receipt) => receipt.stage === 'acceptance_unknown'));
});

test('M-C pin: two weak claims for one request interfere instead of guessing', async () => {
  const { window, receipts } = observerHarness();
  armVideo(window, { expectedQuantity: 1, attemptId: '00000000-0000-4000-8000-000000000001' });
  armVideo(window, { expectedQuantity: 1, attemptId: '00000000-0000-4000-8000-000000000002' });
  await sendRequest(window, [videoRow(), videoRow({ refs: [] })]);
  assert.equal(requestSeen(receipts), undefined, 'no weak claim may win when two attempts weakly match');
  assert.ok(receipts.some((receipt) => receipt.stage === 'acceptance_unknown'));
});

test('M-C pin: replaced reference set (not a superset) is still rejected', async () => {
  const { window, receipts } = observerHarness();
  armVideo(window);
  await sendRequest(window, [videoRow({ refs: [EXTRA] })]);
  assert.equal(requestSeen(receipts), undefined);
});
