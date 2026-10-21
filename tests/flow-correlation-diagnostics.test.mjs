import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const observerSource = readFileSync(new URL('../extension/content/bridge/flow-correlation-observer.js', import.meta.url), 'utf8');
const projectId = '00000000-0000-4000-8000-000000000000';

function observerHarness({ priorStore } = {}) {
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
  if (priorStore) window.__tobyFlowCorrelationObserver = {
    health: () => ({ activeAttempts: 0 }),
    dispose() {},
    requestDiagnosticStore: priorStore,
  };
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

function arm(window, {
  attemptId = '00000000-0000-4000-8000-000000000001',
  prompt = 'fixture prompt',
  model = 'veo-3',
  mediaType = 'video',
  expectedReferenceIds = [],
  expectedMediaReferenceIds = [],
  expectedCharacterIds = [],
} = {}) {
  window.dispatchEvent(new window.CustomEvent('TOBY_FLOW_V2_CORRELATION_ARM', {
    detail: {
      schemaVersion: 1,
      nonce: 'test-nonce-12345678',
      attemptId,
      mediaType,
      projectId,
      expectedQuantity: 1,
      promptFingerprint: promptFingerprint(prompt),
      ...(mediaType === 'image' ? { expectedImageModelKey: model } : { expectedVideoModelKey: model }),
      expectedReferenceIds,
      expectedMediaReferenceIds,
      expectedCharacterIds,
      ttlMs: 60000,
    },
  }));
}

test('records sanitized same-origin RPC diagnostics without changing exact matching', async () => {
  const { window } = observerHarness();
  arm(window);
  const secretPrompt = 'PRIVATE PROMPT SHOULD NEVER LEAK';
  const secretToken = 'secret-token-query-value';
  const payload = [[['input', secretPrompt, 'model-private-value']]];
  const fReq = JSON.stringify([[['rpc.fixture', JSON.stringify(payload), null]]]);
  await window.fetch(`https://labs.google/private-account/${secretToken}?token=${secretToken}#${secretToken}`, {
    method: 'POST',
    body: new URLSearchParams({ 'f.req': fReq }).toString(),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const diagnostics = window.__tobyFlowCorrelationObserver.health().requestDiagnostics;
  assert.equal(diagnostics.version, 1);
  assert.equal(diagnostics.count, 1);
  const [entry] = diagnostics.events;
  assert.equal(entry.path, '/:segment/:segment');
  assert.equal(entry.rpcId, 'rpc.fixture', JSON.stringify(entry));
  assert.equal(entry.pathRecognized, false);
  assert.equal(entry.payloadMatched, false);
  assert.ok(entry.reasons.includes('request_path_unrecognized'));
  assert.ok(JSON.stringify(entry).includes('rpc.fixture'));
  assert.ok(!JSON.stringify(entry).includes(secretPrompt));
  assert.ok(!JSON.stringify(entry).includes(secretToken));
  assert.ok(!JSON.stringify(entry).includes('model-private-value'));
  assert.deepEqual(Object.keys(entry.fields).sort(), ['model', 'project', 'prompt', 'quantity', 'referenceIds', 'shape']);
});

test('recognizes the current video RPC fixture and records exact per-field results', async () => {
  const { window } = observerHarness();
  const prompt = 'A small red kite over a quiet field';
  arm(window, { prompt });
  const row = [null, null, [[[prompt]]], [], 'veo-3', 1];
  const payload = [[row]];
  const fReq = JSON.stringify([[['rpc.videoFixture', JSON.stringify(payload), null]]]);
  await window.fetch('https://labs.google/u/0/_/AiSandboxAngularFrontend/data/batchexecute?at=private', {
    method: 'POST',
    body: new URLSearchParams({ 'f.req': fReq }).toString(),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const [entry] = window.__tobyFlowCorrelationObserver.health().requestDiagnostics.events;
  assert.equal(entry.payloadVersion, 'video_inputs_v1');
  assert.equal(entry.path, '/u/:id/_/AiSandboxAngularFrontend/data/batchexecute');
  assert.equal(entry.rpcId, 'rpc.videoFixture');
  assert.equal(entry.pathRecognized, true);
  assert.equal(entry.payloadMatched, true);
  assert.deepEqual(JSON.parse(JSON.stringify(entry.fields)), {
    shape: true,
    prompt: true,
    model: true,
    quantity: true,
    referenceIds: true,
    project: true,
  });
  assert.ok(!JSON.stringify(entry).includes(prompt));
});

test('completed submit-only dispatch permits the same asset UUID on a new prompt and rejects a delayed old request', async () => {
  const { window } = observerHarness();
  const receipts = [];
  window.addEventListener('TOBY_FLOW_V2_CORRELATION_RECEIPT', event => receipts.push(event.detail));
  const assetId = '11111111-2222-4333-8444-555555555555';
  const promptOne = 'A kite over a grassy meadow';
  const promptTwo = 'A lantern on a snowy porch';
  const firstAttemptId = '00000000-0000-4000-8000-000000000021';
  const secondAttemptId = '00000000-0000-4000-8000-000000000022';
  arm(window, { attemptId: firstAttemptId, prompt: promptOne, expectedReferenceIds: [assetId] });
  const makePayload = prompt => {
    const row = [[null, null, [[[prompt]]]], 'veo-3', 1, [null, assetId], [null, null, null, null, assetId, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee']];
    return [[row]];
  };
  const send = async (prompt, rpcId) => {
    const payload = makePayload(prompt);
    const fReq = JSON.stringify([[[rpcId, JSON.stringify(payload), null]]]);
    await window.fetch('https://labs.google/u/0/_/AiSandboxAngularFrontend/data/batchexecute', {
      method: 'POST', body: new URLSearchParams({ 'f.req': fReq }).toString(),
    });
    await new Promise(resolve => setTimeout(resolve, 0));
  };

  await send(promptOne, 'rpc.firstSubmitOnly');
  assert.ok(window.__tobyFlowCorrelationObserver.health().requestDiagnostics.events.some(event =>
    event.attemptId === firstAttemptId && event.payloadMatched === true));
  window.dispatchEvent(new window.CustomEvent('TOBY_FLOW_V2_CORRELATION_DISARM', {
    detail: { nonce: 'test-nonce-12345678', attemptId: firstAttemptId, dispatched: true, completedDispatch: true },
  }));
  assert.equal(window.__tobyFlowCorrelationObserver.health().activeAttempts, 0);

  arm(window, { attemptId: secondAttemptId, prompt: promptTwo, expectedReferenceIds: [assetId] });
  await send(promptOne, 'rpc.delayedOldSubmit');
  await send(promptTwo, 'rpc.nextSubmitSameAsset');
  const events = window.__tobyFlowCorrelationObserver.health().requestDiagnostics.events;
  const next = events.find(event => event.rpcId === 'rpc.nextSubmitSameAsset');
  assert.equal(next.attemptId, secondAttemptId);
  assert.equal(next.payloadMatched, true);
  assert.ok(!receipts.some(receipt => receipt.attemptId === secondAttemptId && receipt.stage === 'request_seen' && receipt.rpcId === 'rpc.delayedOldSubmit'));
  assert.ok(!JSON.stringify(events).includes(assetId));
});

test('completed submit-only dispatch marks an identical replay unknown instead of attributing it to a new attempt', async () => {
  const { window } = observerHarness();
  const assetId = '11111111-2222-4333-8444-555555555555';
  const prompt = 'A lighthouse beside a stormy sea';
  const firstAttemptId = '00000000-0000-4000-8000-000000000031';
  const secondAttemptId = '00000000-0000-4000-8000-000000000032';
  const receipts = [];
  window.addEventListener('TOBY_FLOW_V2_CORRELATION_RECEIPT', event => receipts.push(event.detail));
  arm(window, { attemptId: firstAttemptId, prompt, expectedReferenceIds: [assetId] });
  const row = [[null, null, [[[prompt]]]], 'veo-3', 1, [null, assetId], [null, null, null, null, assetId, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee']];
  const body = new URLSearchParams({ 'f.req': JSON.stringify([[[
    'rpc.identicalSubmit', JSON.stringify([[row]]), null,
  ]]]) }).toString();
  const send = async () => {
    await window.fetch('https://labs.google/u/0/_/AiSandboxAngularFrontend/data/batchexecute', { method: 'POST', body });
    await new Promise(resolve => setTimeout(resolve, 0));
  };

  await send();
  assert.ok(receipts.some(receipt => receipt.attemptId === firstAttemptId && receipt.stage === 'request_seen'));
  window.dispatchEvent(new window.CustomEvent('TOBY_FLOW_V2_CORRELATION_DISARM', {
    detail: { nonce: 'test-nonce-12345678', attemptId: firstAttemptId, dispatched: true, completedDispatch: true },
  }));
  arm(window, { attemptId: secondAttemptId, prompt, expectedReferenceIds: [assetId] });

  await send();

  assert.ok(receipts.some(receipt => receipt.attemptId === secondAttemptId && receipt.stage === 'acceptance_unknown' && receipt.reason === 'completed_dispatch_replay'), JSON.stringify(receipts.filter(receipt => receipt.attemptId === secondAttemptId)));
  assert.ok(!receipts.some(receipt => receipt.attemptId === secondAttemptId && receipt.stage === 'request_seen'));
  const diagnostic = window.__tobyFlowCorrelationObserver.health().requestDiagnostics.events.find(event => event.attemptId === secondAttemptId);
  assert.ok(diagnostic.reasons.includes('completed_dispatch_replay'), JSON.stringify(diagnostic));
});

test('recognizes an image reference RPC only when the exact media UUID matches', async () => {
  const { window } = observerHarness();
  const prompt = 'Keep the exact blue ceramic cup';
  const expectedMediaId = '11111111-2222-4333-8444-555555555555';
  const unexpectedMediaId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  arm(window, {
    attemptId: '00000000-0000-4000-8000-000000000003',
    prompt,
    model: 'imagen-4',
    mediaType: 'image',
    expectedReferenceIds: [expectedMediaId],
    expectedMediaReferenceIds: [expectedMediaId],
  });
  const makeImagePayload = (mediaId) => {
    const row = [];
    row[2] = [[mediaId, null]];
    row[5] = 'imagen-4';
    row[8] = [[[prompt]]];
    row[10] = [];
    return [null, [row], 1, [null, null, null, null, null, projectId]];
  };
  const send = async (mediaId, rpcId) => {
    const fReq = JSON.stringify([[[rpcId, JSON.stringify(makeImagePayload(mediaId)), null]]]);
    await window.fetch('https://labs.google/u/0/_/AiSandboxAngularFrontend/data/batchexecute', {
      method: 'POST',
      body: new URLSearchParams({ 'f.req': fReq }).toString(),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  await send(unexpectedMediaId, 'rpc.imageReferenceMismatch');
  await send(expectedMediaId, 'rpc.imageReferenceMatch');

  const entries = window.__tobyFlowCorrelationObserver.health().requestDiagnostics.events;
  assert.equal(entries.length, 2);
  const [mismatch, match] = entries;
  assert.equal(mismatch.payloadMatched, false);
  assert.equal(mismatch.fields.referenceIds, false);
  assert.ok(mismatch.reasons.includes('reference_ids_mismatch'));
  assert.equal(match.payloadVersion, 'image_rows_v1');
  assert.equal(match.pathRecognized, true);
  assert.equal(match.payloadMatched, true);
  assert.deepEqual(JSON.parse(JSON.stringify(match.fields)), {
    shape: true,
    prompt: true,
    model: true,
    quantity: true,
    referenceIds: true,
    project: true,
  });
  assert.ok(!JSON.stringify(entries).includes(prompt));
  assert.ok(!JSON.stringify(entries).includes(expectedMediaId));
  assert.ok(!JSON.stringify(entries).includes(unexpectedMediaId));
});

test('records model and prompt mismatch reasons without exposing their values', async () => {
  const { window } = observerHarness();
  const expectedPrompt = 'Expected prompt never sent';
  const observedPrompt = 'Observed mismatch prompt';
  arm(window, { attemptId: '00000000-0000-4000-8000-000000000002', prompt: expectedPrompt, model: 'veo-3' });
  const row = [null, null, [[[observedPrompt]]], [], 'veo-2', 1];
  const payload = [[row]];
  const fReq = JSON.stringify([[['rpc.mismatchFixture', JSON.stringify(payload), null]]]);
  await window.fetch('https://labs.google/u/0/_/AiSandboxAngularFrontend/data/batchexecute', {
    method: 'POST',
    body: new URLSearchParams({ 'f.req': fReq }).toString(),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const [entry] = window.__tobyFlowCorrelationObserver.health().requestDiagnostics.events;
  assert.equal(entry.payloadMatched, false);
  assert.equal(entry.fields.prompt, false);
  assert.equal(entry.fields.model, false);
  assert.ok(entry.reasons.includes('prompt_mismatch'));
  assert.ok(entry.reasons.includes('model_mismatch'));
  assert.ok(!JSON.stringify(entry).includes(expectedPrompt));
  assert.ok(!JSON.stringify(entry).includes(observedPrompt));
});

test('bounds retained diagnostics to 32 events and expires records after the TTL', () => {
  const { window } = observerHarness();
  const store = window.__tobyFlowCorrelationObserver.requestDiagnosticStore;
  const fixtureEvent = (attemptId, observedAt = Date.now()) => ({
    observedAt, attemptId, mediaType: 'video', transport: 'fetch', path: '/rpc', rpcId: 'rpc.test',
    payloadVersion: 'unknown', payloadShape: { type: 'array', length: 0 }, pathRecognized: false,
    payloadMatched: false, fields: { shape: false, prompt: false, model: null, quantity: false, referenceIds: false, project: false }, reasons: [],
  });
  for (let i = 0; i < 40; i++) store.events.push(fixtureEvent(`00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`));
  assert.equal(window.__tobyFlowCorrelationObserver.health().requestDiagnostics.count, 32);
  store.events.push(fixtureEvent('00000000-0000-4000-8000-ffffffffffff', Date.now() - (15 * 60_000) - 1));
  const diagnostics = window.__tobyFlowCorrelationObserver.health().requestDiagnostics;
  assert.equal(diagnostics.count, 32);
  assert.ok(diagnostics.events.every((entry) => entry.attemptId !== '00000000-0000-4000-8000-ffffffffffff'));
});

test('sanitizes persisted diagnostic entries before reuse and clears incompatible stores', () => {
  const secretPrompt = 'PERSISTED RAW PROMPT SECRET';
  const secretToken = 'persisted-token-secret';
  const validLegacyEvent = {
    observedAt: Date.now(), attemptId: '00000000-0000-4000-8000-000000000010', mediaType: 'video', transport: 'fetch',
    path: `https://labs.google/private/${secretToken}?token=${secretToken}#${secretToken}`,
    rpcId: 'rpc.legacy', payloadVersion: 'unknown',
    payloadShape: { type: 'string', length: 24, leakedValue: secretPrompt },
    pathRecognized: false, payloadMatched: false,
    fields: { shape: false, prompt: false, model: null, quantity: false, referenceIds: false, project: false, leakedPrompt: secretPrompt },
    reasons: ['prompt_mismatch', secretPrompt], rawPrompt: secretPrompt, assetUrl: `https://labs.google/${secretToken}`,
  };
  const malformedLegacyEvent = { ...validLegacyEvent, attemptId: secretPrompt, payloadShape: { type: 'object', keyCount: 999, raw: secretPrompt } };
  const { window } = observerHarness({ priorStore: { version: 1, events: [validLegacyEvent, malformedLegacyEvent] } });
  const store = window.__tobyFlowCorrelationObserver.requestDiagnosticStore;
  const snapshot = window.__tobyFlowCorrelationObserver.health().requestDiagnostics;
  assert.equal(snapshot.count, 1);
  assert.equal(snapshot.events[0].path, '/:segment/:segment');
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot.events[0].payloadShape)), { type: 'string', length: 24 });
  assert.deepEqual(Array.from(snapshot.events[0].reasons), ['prompt_mismatch']);
  assert.ok(!JSON.stringify(snapshot).includes(secretPrompt));
  assert.ok(!JSON.stringify(snapshot).includes(secretToken));
  assert.ok(!JSON.stringify(store).includes(secretPrompt));
  assert.ok(!JSON.stringify(store).includes(secretToken));

  const incompatible = observerHarness({ priorStore: { version: 2, events: [validLegacyEvent] } });
  assert.equal(incompatible.window.__tobyFlowCorrelationObserver.health().requestDiagnostics.count, 0);
});
