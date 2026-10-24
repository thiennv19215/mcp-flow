import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// ---------------------------------------------------------------------------
// Video fix M-D — retired-conflict must not lock an identical retry forever:
//
// Before this fix every dispatch-loop error exit disarmed with
// `dispatched: true`, the observer retired the attempt's fingerprint
// (requestCount 0 < cardinality 1, no TTL), and the next identical arm in
// the same tab hit `ambiguous_retired_request` -> armed=false ->
// FLOW_SUBMIT_CORRELATION_UNAVAILABLE before the click. A dispatch failure
// therefore became permanent until a full tab reload.
//
// After the fix the disarm carries the observed outcome:
//   - "none" (click delivered, zero signal: no request, no DOM acceptance,
//     no Flow error) or "rejected" (Flow displayed an error) with no
//     request observed -> no retire, the identical retry arms clean.
//   - "ambiguous" (or a legacy disarm with no outcome) -> retire as before,
//     but the retired entry now expires after 15 minutes, so the block is
//     bounded instead of permanent.
// ---------------------------------------------------------------------------

const observerSource = readFileSync(new URL('../extension/src/content/bridge/flow-correlation-observer.js', import.meta.url), 'utf8');
const projectId = '00000000-0000-4000-8000-000000000000';

let fakeNow = 1_700_000_000_000;
class FakeDate extends Date {
  constructor(...args) { super(...args); }
  static now() { return fakeNow; }
}

function observerHarness() {
  const listeners = new Map();
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
    Date: FakeDate,
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
  return { window, context };
}

function promptFingerprint(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `id-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function arm(window, { attemptId, prompt = 'fixture prompt' }) {
  const receipts = [];
  window.addEventListener('TOBY_FLOW_V2_CORRELATION_RECEIPT', (event) => receipts.push(event.detail));
  window.dispatchEvent(new window.CustomEvent('TOBY_FLOW_V2_CORRELATION_ARM', {
    detail: {
      schemaVersion: 1,
      nonce: 'test-nonce-12345678',
      attemptId,
      mediaType: 'video',
      projectId,
      expectedQuantity: 1,
      promptFingerprint: promptFingerprint(prompt),
      expectedVideoModelKey: 'veo-3',
      expectedReferenceIds: [],
      expectedMediaReferenceIds: [],
      expectedCharacterIds: [],
      ttlMs: 60000,
    },
  }));
  const armed = receipts.find((receipt) => receipt.attemptId === attemptId && receipt.stage === 'armed');
  return armed || null;
}

function disarm(window, { attemptId, outcome }) {
  window.dispatchEvent(new window.CustomEvent('TOBY_FLOW_V2_CORRELATION_DISARM', {
    detail: {
      nonce: 'test-nonce-12345678',
      attemptId,
      dispatched: true,
      ...(outcome !== undefined ? { dispatchOutcome: outcome } : {}),
    },
  }));
}

const firstAttemptId = '00000000-0000-4000-8000-000000000001';
const secondAttemptId = '00000000-0000-4000-8000-000000000002';

// --- tiles.js side: disarm must forward the observed outcome ---------

const tilesSource = readFileSync(new URL('../extension/src/content/providers/flow/generation/tiles.js', import.meta.url), 'utf8');

function tilesHarness() {
  const events = [];
  const sandbox = {
    document: { querySelectorAll: () => [], querySelector: () => null },
    location: { href: 'https://flow.google.com/project/x' },
    console, setTimeout, clearTimeout, Date, Map, Set, WeakMap, Promise,
    Object, Array, Math, String, Number, Boolean, RegExp, JSON, Error,
    MutationObserver: class { observe() {} disconnect() {} },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent(event) { events.push(event); return true; },
    CustomEvent: class { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(tilesSource, context);
  return { tiles: context.FlowTiles, events };
}

function seedAttempt(tiles, attemptId) {
  tiles.nativeFlowCorrelationMap().set(attemptId, { attemptId, nonce: 'n1', listener: null });
}

test('M-D: tiles disarm forwards a whitelisted dispatchOutcome into the event', () => {
  const { tiles, events } = tilesHarness();
  seedAttempt(tiles, 'attempt-1');
  tiles.disarmNativeFlowCorrelation('attempt-1', { dispatchOutcome: 'none' });
  const disarm = events.find((event) => event.type === 'TOBY_FLOW_CORRELATION_DISARM');
  assert.equal(disarm.detail.dispatchOutcome, 'none');
  assert.equal(disarm.detail.dispatched, true);
});

test('M-D: tiles disarm drops an unknown dispatchOutcome instead of forwarding it', () => {
  const { tiles, events } = tilesHarness();
  seedAttempt(tiles, 'attempt-1');
  tiles.disarmNativeFlowCorrelation('attempt-1', { dispatchOutcome: 'bogus' });
  const disarm = events.find((event) => event.type === 'TOBY_FLOW_CORRELATION_DISARM');
  assert.equal('dispatchOutcome' in disarm.detail, false);
});

test('M-D: disarm with outcome "none" does not block an identical retry arm', () => {
  const { window } = observerHarness();
  const first = arm(window, { attemptId: firstAttemptId });
  assert.equal(first.reason, null);
  disarm(window, { attemptId: firstAttemptId, outcome: 'none' });
  const second = arm(window, { attemptId: secondAttemptId });
  assert.equal(second.reason, null, 'a no-signal dispatch failure must not retire the fingerprint');
});

test('M-D: disarm with outcome "rejected" does not block an identical retry arm', () => {
  const { window } = observerHarness();
  arm(window, { attemptId: firstAttemptId });
  disarm(window, { attemptId: firstAttemptId, outcome: 'rejected' });
  const second = arm(window, { attemptId: secondAttemptId });
  assert.equal(second.reason, null, 'a Flow-rejected submit must not retire the fingerprint');
});

test('M-D: legacy disarm without outcome still blocks an identical retry arm', () => {
  const { window } = observerHarness();
  arm(window, { attemptId: firstAttemptId });
  disarm(window, { attemptId: firstAttemptId });
  const second = arm(window, { attemptId: secondAttemptId });
  assert.equal(second.reason, 'ambiguous_retired_request');
});

test('M-D: disarm with outcome "ambiguous" still blocks an identical retry arm', () => {
  const { window } = observerHarness();
  arm(window, { attemptId: firstAttemptId });
  disarm(window, { attemptId: firstAttemptId, outcome: 'ambiguous' });
  const second = arm(window, { attemptId: secondAttemptId });
  assert.equal(second.reason, 'ambiguous_retired_request');
});

test('M-D: a retired entry expires, so an identical arm after the TTL succeeds', () => {
  const { window } = observerHarness();
  fakeNow = 1_700_000_000_000;
  arm(window, { attemptId: firstAttemptId });
  disarm(window, { attemptId: firstAttemptId, outcome: 'ambiguous' });
  const blocked = arm(window, { attemptId: secondAttemptId });
  assert.equal(blocked.reason, 'ambiguous_retired_request');
  fakeNow += 16 * 60_000;
  const thirdAttemptId = '00000000-0000-4000-8000-000000000003';
  const afterTtl = arm(window, { attemptId: thirdAttemptId });
  assert.equal(afterTtl.reason, null, 'the retired block must be bounded by a TTL, not permanent');
});
