import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// VID-03 (study G3, behaviors 25/28): correlation attribution must check the
// model key and aspect-ratio enum, not only prompt + references. The codec's
// payload summary gains model + ratio, the arm carries
// expectedVideoModelKey / expectedVideoRatioEnum / expectedImageModelKey, and
// the observer requires equality when an expectation is present (absent =
// don't care, exactly the historical behavior).

const codecSource = readFileSync(new URL('../extension/src/content/bridge/flow-v2-correlation-codec.js', import.meta.url), 'utf8');
const observerSource = readFileSync(new URL('../extension/src/content/bridge/flow-correlation-observer.js', import.meta.url), 'utf8');
const tilesSource = readFileSync(new URL('../extension/src/content/providers/flow/generation/tiles.js', import.meta.url), 'utf8');
const operationsSource = readFileSync(new URL('../extension/src/content/providers/flow/generation/generation-operations.js', import.meta.url), 'utf8');

const projectId = '00000000-0000-4000-8000-000000000000';
const mediaId = '11111111-2222-4333-8444-555555555555';

// ---------------------------------------------------------------------------
// Part A — codec payload summary
// ---------------------------------------------------------------------------

function codecHarness() {
  const sandbox = {};
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(codecSource, context);
  return context.FlowV2CorrelationCodec;
}

// Plain-text video input row with the wire model at [1] and ratio enum at [2]
// (one of the positional layouts the observer decodes).
function videoRow(prompt, model, ratio, refs = []) {
  const row = [];
  row[0] = [null, null, [[[prompt]]]];
  if (model !== undefined) row[1] = model;
  if (ratio !== undefined) row[2] = ratio;
  row[3] = refs.map(id => [id]);
  return row;
}

function bareVideoRow(prompt) {
  const row = [];
  row[0] = [null, null, [[[prompt]]]];
  return row;
}

test('VID-03 codec: payload summary gains the unanimous model key and ratio enum', () => {
  const codec = codecHarness();
  const summary = codec.plainInputSummary([[videoRow('a kite over a field', 'veo-3', 1)]]);
  assert.ok(summary);
  assert.equal(summary.fingerprint, codec.promptFingerprint('a kite over a field'));
  assert.equal(summary.model, 'veo-3');
  assert.equal(summary.ratio, 1);
});

test('VID-03 codec: multi-row payloads keep unanimous model and ratio', () => {
  const codec = codecHarness();
  const summary = codec.plainInputSummary([[
    videoRow('same prompt', 'veo-3-fast', 2),
    videoRow('same prompt', 'veo-3-fast', 2),
  ]]);
  assert.ok(summary);
  assert.equal(summary.model, 'veo-3-fast');
  assert.equal(summary.ratio, 2);
});

test('VID-03 codec: fields are summarised independently — disagreement drops only that field', () => {
  const codec = codecHarness();
  const summary = codec.plainInputSummary([[
    videoRow('same prompt', 'veo-3', 1),
    videoRow('same prompt', 'veo-2', 1),
  ]]);
  assert.ok(summary);
  assert.equal(Object.hasOwn(summary, 'model'), false);
  assert.equal(summary.ratio, 1);
});

test('VID-03 codec: a payload without model/ratio yields a summary without them (historical shape)', () => {
  const codec = codecHarness();
  const summary = codec.plainInputSummary([[bareVideoRow('plain prompt only')]]);
  assert.ok(summary);
  assert.equal(Object.hasOwn(summary, 'model'), false);
  assert.equal(Object.hasOwn(summary, 'ratio'), false);
  assert.deepEqual(Object.keys(summary).sort(), ['anchorFingerprint', 'fingerprint', 'normalizedLength']);
});

test('VID-03 codec: malformed model/ratio values degrade to absent fields, never throw', () => {
  const codec = codecHarness();
  assert.equal(codec.plainInputSummary(null), null);
  assert.equal(codec.plainInputSummary({}), null);
  assert.equal(codec.plainInputSummary([[]]), null);
  // (A non-integer ratio: a string at the ratio position would be the
  // model-at-[2] wire layout instead, exactly as the observer decodes it.)
  const badRatio = codec.plainInputSummary([[videoRow('prompt', 'veo-3', 1.5)]]);
  assert.equal(badRatio.model, 'veo-3');
  assert.equal(Object.hasOwn(badRatio, 'ratio'), false);
  const zeroRatio = codec.plainInputSummary([[videoRow('prompt', 'veo-3', 0)]]);
  assert.equal(Object.hasOwn(zeroRatio, 'ratio'), false);
  const emptyModel = codec.plainInputSummary([[videoRow('prompt', '', 1)]]);
  assert.equal(Object.hasOwn(emptyModel, 'model'), false);
  assert.equal(emptyModel.ratio, 1);
});

// ---------------------------------------------------------------------------
// Part B — tiles arm pass-through
// ---------------------------------------------------------------------------

function tilesHarness() {
  const listeners = new Map();
  const dispatched = [];
  let nextId = 1;
  const window = {
    addEventListener(type, listener) {
      const entries = listeners.get(type) || [];
      entries.push(listener);
      listeners.set(type, entries);
    },
    removeEventListener(type, listener) {
      listeners.set(type, (listeners.get(type) || []).filter(entry => entry !== listener));
    },
    dispatchEvent(event) {
      dispatched.push(event);
      for (const listener of listeners.get(event.type) || []) listener(event);
      if (event.type === 'TOBY_FLOW_CORRELATION_ARM') {
        const detail = event.detail;
        this.dispatchEvent(new CustomEvent('TOBY_FLOW_CORRELATION_RECEIPT', {
          detail: {
            schemaVersion: 1,
            nonce: detail.nonce,
            attemptId: detail.attemptId,
            stage: 'armed',
            projectId: detail.projectId,
            mediaType: detail.mediaType,
            reason: null,
            xhrHookActive: true,
            fetchHookActive: true,
          },
        }));
      }
      return true;
    },
  };
  class FakeCustomEvent {
    constructor(type, options = {}) { this.type = type; this.detail = options.detail; }
  }
  const context = vm.createContext({
    window,
    CustomEvent: FakeCustomEvent,
    crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}` },
    document: { querySelectorAll: () => [], querySelector: () => null },
    location: { href: `https://flow.google.com/project/${projectId}` },
    setTimeout,
    clearTimeout,
    Map,
    Set,
    Date,
    Math,
    String,
    Number,
    Array,
    Object,
    Promise,
    JSON,
  });
  vm.runInContext(tilesSource, context);
  const armDetail = () => dispatched.find(event => event.type === 'TOBY_FLOW_CORRELATION_ARM')?.detail;
  return { tiles: context.FlowTiles, armDetail };
}

test('VID-03 arm: video model key and ratio enum are carried into the ARM detail', async () => {
  const { tiles, armDetail } = tilesHarness();
  const attemptId = await tiles.armNativeFlowCorrelation({
    projectId,
    mediaType: 'video',
    prompt: 'fixture video',
    expectedQuantity: 1,
    expectedVideoModelKey: 'veo-3',
    expectedVideoRatioEnum: 2,
  });
  assert.ok(attemptId);
  assert.equal(armDetail().expectedVideoModelKey, 'veo-3');
  assert.equal(armDetail().expectedVideoRatioEnum, 2);
});

test('VID-03 arm: image model key is carried into the ARM detail', async () => {
  const { tiles, armDetail } = tilesHarness();
  const attemptId = await tiles.armNativeFlowCorrelation({
    projectId,
    mediaType: 'image',
    prompt: 'fixture image',
    expectedQuantity: 1,
    expectedImageModelKey: 'imagen-4',
  });
  assert.ok(attemptId);
  assert.equal(armDetail().expectedImageModelKey, 'imagen-4');
});

test('VID-03 arm: invalid expectations are dropped or normalised exactly as the observer stores them', async () => {
  const { tiles, armDetail } = tilesHarness();
  await tiles.armNativeFlowCorrelation({
    projectId,
    mediaType: 'video',
    prompt: 'fixture video',
    expectedQuantity: 1,
    expectedVideoModelKey: 'bad key with spaces',
    expectedVideoRatioEnum: 2.5,
    expectedImageModelKey: 42,
  });
  assert.equal(Object.hasOwn(armDetail(), 'expectedVideoModelKey'), false);
  assert.equal(Object.hasOwn(armDetail(), 'expectedVideoRatioEnum'), false);
  assert.equal(Object.hasOwn(armDetail(), 'expectedImageModelKey'), false);

  const second = tilesHarness();
  await second.tiles.armNativeFlowCorrelation({
    projectId,
    mediaType: 'video',
    prompt: 'fixture video',
    expectedQuantity: 1,
    expectedVideoRatioEnum: 99,
  });
  assert.equal(second.armDetail().expectedVideoRatioEnum, 16);
});

test('VID-03 arm: an arm without expectations produces the historical detail shape', async () => {
  const { tiles, armDetail } = tilesHarness();
  await tiles.armNativeFlowCorrelation({
    projectId,
    mediaType: 'video',
    prompt: 'fixture video',
    expectedQuantity: 1,
  });
  assert.equal(Object.hasOwn(armDetail(), 'expectedVideoModelKey'), false);
  assert.equal(Object.hasOwn(armDetail(), 'expectedVideoRatioEnum'), false);
  assert.equal(Object.hasOwn(armDetail(), 'expectedImageModelKey'), false);
});

// ---------------------------------------------------------------------------
// Part C — end to end: codec + observer + tiles in one page
// ---------------------------------------------------------------------------

function pageHarness() {
  const listeners = new Map();
  const receipts = [];
  let nextId = 1;
  const window = {
    addEventListener(type, listener) {
      const entries = listeners.get(type) || [];
      entries.push(listener);
      listeners.set(type, entries);
    },
    removeEventListener(type, listener) {
      listeners.set(type, (listeners.get(type) || []).filter(entry => entry !== listener));
    },
    dispatchEvent(event) {
      for (const listener of [...(listeners.get(event.type) || [])]) listener(event);
      return true;
    },
    fetch: async () => ({ status: 200, clone: () => ({ text: async () => '' }) }),
  };
  class FakeCustomEvent {
    constructor(type, options = {}) { this.type = type; this.detail = options.detail; }
  }
  class FakeXHR {
    open() {}
    send() {}
    addEventListener() {}
  }
  window.CustomEvent = FakeCustomEvent;
  window.window = window;
  Object.assign(window, {
    XMLHttpRequest: FakeXHR,
    URL,
    URLSearchParams,
    FormData,
    ArrayBuffer,
    Uint8Array,
    TextDecoder,
    Blob,
    Request,
    location: { href: `https://labs.google/u/0/project/${projectId}`, origin: 'https://labs.google', pathname: `/u/0/project/${projectId}` },
    crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}` },
    document: { querySelectorAll: () => [], querySelector: () => null },
    console: { info() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    Date,
    Map,
    Set,
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
  const context = vm.createContext(window);
  vm.runInContext(codecSource, context);
  vm.runInContext(observerSource, context);
  vm.runInContext(tilesSource, context);
  window.addEventListener('TOBY_FLOW_CORRELATION_RECEIPT', event => receipts.push(event.detail));
  window.addEventListener('TOBY_FLOW_V2_CORRELATION_RECEIPT', event => receipts.push(event.detail));
  return { window, tiles: context.FlowTiles, receipts };
}

async function sendPayload(window, payload, rpcId) {
  const fReq = JSON.stringify([[[rpcId, JSON.stringify(payload), null]]]);
  await window.fetch('https://labs.google/u/0/_/AiSandboxAngularFrontend/data/batchexecute', {
    method: 'POST',
    body: new URLSearchParams({ 'f.req': fReq }).toString(),
  });
  await new Promise(resolve => setTimeout(resolve, 10));
}

function imagePayload(prompt, model, id) {
  const row = [];
  row[2] = [[id, null]];
  row[5] = model;
  row[8] = [[[prompt]]];
  row[10] = [];
  return [null, [row], 1, [null, null, null, null, null, projectId]];
}

test('VID-03 e2e: a payload matching prompt + refs but with a different video model is not attributed', async () => {
  const { window, tiles, receipts } = pageHarness();
  const prompt = 'A small red kite over a quiet field';
  const attemptId = await tiles.armNativeFlowCorrelation({
    projectId,
    mediaType: 'video',
    prompt,
    expectedQuantity: 1,
    expectedReferenceIds: [mediaId],
    expectedVideoModelKey: 'veo-3',
    expectedVideoRatioEnum: 1,
  });
  assert.ok(attemptId);
  const entry = tiles.nativeFlowCorrelationMap().get(attemptId);

  await sendPayload(window, [[videoRow(prompt, 'veo-2', 1, [mediaId])]], 'rpc.wrongModel');
  assert.equal(entry.requestSeen, false);
  assert.ok(!receipts.some(receipt => receipt.attemptId === attemptId && receipt.stage === 'request_seen'));

  await sendPayload(window, [[videoRow(prompt, 'veo-3', 1, [mediaId])]], 'rpc.rightModel');
  assert.equal(entry.requestSeen, true);
});

test('VID-03 e2e: a payload matching prompt + refs but with a different ratio enum is not attributed', async () => {
  const { window, tiles } = pageHarness();
  const prompt = 'Waves rolling onto a dark beach';
  const attemptId = await tiles.armNativeFlowCorrelation({
    projectId,
    mediaType: 'video',
    prompt,
    expectedQuantity: 1,
    expectedReferenceIds: [mediaId],
    expectedVideoModelKey: 'veo-3',
    expectedVideoRatioEnum: 2,
  });
  assert.ok(attemptId);
  const entry = tiles.nativeFlowCorrelationMap().get(attemptId);

  await sendPayload(window, [[videoRow(prompt, 'veo-3', 1, [mediaId])]], 'rpc.wrongRatio');
  assert.equal(entry.requestSeen, false);

  await sendPayload(window, [[videoRow(prompt, 'veo-3', 2, [mediaId])]], 'rpc.rightRatio');
  assert.equal(entry.requestSeen, true);
});

test('VID-03 e2e: a payload matching prompt + refs but with a different image model is not attributed', async () => {
  const { window, tiles } = pageHarness();
  const prompt = 'Keep the exact blue ceramic cup';
  const attemptId = await tiles.armNativeFlowCorrelation({
    projectId,
    mediaType: 'image',
    prompt,
    expectedQuantity: 1,
    expectedReferenceIds: [mediaId],
    expectedMediaReferenceIds: [mediaId],
    expectedImageModelKey: 'imagen-4',
  });
  assert.ok(attemptId);
  const entry = tiles.nativeFlowCorrelationMap().get(attemptId);

  await sendPayload(window, imagePayload(prompt, 'imagen-3', mediaId), 'rpc.wrongImageModel');
  assert.equal(entry.requestSeen, false);

  await sendPayload(window, imagePayload(prompt, 'imagen-4', mediaId), 'rpc.rightImageModel');
  assert.equal(entry.requestSeen, true);
});

test('VID-03 e2e: overlapping attempts sharing prompt + refs are separated by model — no cross-attribution, no interference', async () => {
  const { window, tiles } = pageHarness();
  const prompt = 'A lighthouse beside a stormy sea';
  const firstId = await tiles.armNativeFlowCorrelation({
    projectId,
    mediaType: 'video',
    prompt,
    expectedQuantity: 1,
    expectedReferenceIds: [mediaId],
    expectedVideoModelKey: 'veo-3',
    expectedVideoRatioEnum: 1,
  });
  const secondId = await tiles.armNativeFlowCorrelation({
    projectId,
    mediaType: 'video',
    prompt,
    expectedQuantity: 1,
    expectedReferenceIds: [mediaId],
    expectedVideoModelKey: 'veo-2',
    expectedVideoRatioEnum: 1,
  });
  assert.ok(firstId && secondId && firstId !== secondId);
  const first = tiles.nativeFlowCorrelationMap().get(firstId);
  const second = tiles.nativeFlowCorrelationMap().get(secondId);

  await sendPayload(window, [[videoRow(prompt, 'veo-2', 1, [mediaId])]], 'rpc.secondAttemptRequest');
  assert.equal(second.requestSeen, true);
  assert.equal(first.requestSeen, false);
  // Tiles entries carry no `interfered` flag until an interference receipt
  // sets it, so falsy is the "not interfered" state.
  assert.ok(!first.interfered);
  assert.ok(!second.interfered);
});

test('VID-03 e2e control: an arm without expectations attributes exactly as before, whatever the model', async () => {
  const { window, tiles } = pageHarness();
  const prompt = 'A train crossing a long bridge';
  const attemptId = await tiles.armNativeFlowCorrelation({
    projectId,
    mediaType: 'video',
    prompt,
    expectedQuantity: 1,
    expectedReferenceIds: [mediaId],
  });
  assert.ok(attemptId);
  const entry = tiles.nativeFlowCorrelationMap().get(attemptId);

  await sendPayload(window, [[videoRow(prompt, 'some-other-model', 7, [mediaId])]], 'rpc.anyModel');
  assert.equal(entry.requestSeen, true);
});

// ---------------------------------------------------------------------------
// Part D — generation-operations forwards caller-supplied wire expectations
// ---------------------------------------------------------------------------

function operationsHarness() {
  let correlationOptions = null;
  const correlationMap = new Map([
    ['attempt-1', { attemptId: 'attempt-1', requestSeen: true, receipts: [], interfered: false }],
  ]);
  const startButton = { disabled: false, getAttribute: () => null };
  const sandbox = {
    Date, Map, Set, Promise, Object, Math, String, Number, Boolean, Array, Error, RegExp, JSON,
    AbortController, setTimeout, clearTimeout,
    location: { href: 'https://flow.google.com/project/proj-1' },
    document: { querySelector: () => null, querySelectorAll: () => [] },
    addEventListener: () => {},
    removeEventListener: () => {},
    flowError: (code, message, retryable, outcomeUnknown) =>
      Object.assign(new Error(message), { code, retryable, outcome_unknown: outcomeUnknown }),
    wait: async () => {},
    clearExistingIngredientChips: async () => {},
    FlowNavigation: {
      ensureFlowProjectEditor: async () => {},
      dismissBlockingOverlays: async () => {},
      ensureFlowLibrarySection: async () => {},
    },
    FlowEditor: {
      preflightGenerationPrompt: async () => ({}),
      insertNativeFlowPrompt: async () => true,
      waitForGenerationCreditQuote: async () => 10,
      waitForGenerationSubmitButton: async () => startButton,
      activateFlowSubmitButton: async () => ({ clickDelivered: true, strategy: 'fake-click' }),
      currentFlowSubmitErrors: () => [],
    },
    FlowSettings: {},
    FlowComponents: {},
    FlowTiles: {
      stabilizeFlowResultViewport: async () => {},
      collectNativeMedia: () => [],
      armNativeFlowCorrelation: options => {
        correlationOptions = options;
        return 'attempt-1';
      },
      nativeFlowCorrelationMap: () => correlationMap,
      disarmNativeFlowCorrelation: () => {},
      emitFlowProgress: () => {},
      readNativeFlowCorrelationHealth: async () => null,
    },
    FlowMediaMenu: { nativeRead: () => ({ signedIn: true, inProject: true }) },
    FlowAgent: { closeNativeAgentSession: async () => {} },
    FlowScreenState: { inspect: () => ({ state: 'ready' }), assertGenerationReady: () => {} },
    FlowImageActions: { prepare: async () => ({}) },
    FlowVideoActions: { prepare: async () => 12 },
    FlowUiDeadline: {
      makeDeadline: () => Date.now() + 60_000,
      requireTime: () => 1_000,
      boundedWait: async () => {},
    },
    ProviderRegistry: { describeUrl: () => ({ projectId: 'proj-1' }) },
  };
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(operationsSource, context);
  const driver = {
    error: (code, message, retryable, outcomeUnknown) =>
      Object.assign(new Error(message), { code, retryable, outcome_unknown: outcomeUnknown }),
  };
  return { operations: new context.FlowGenerationOperations(driver), armOptions: () => correlationOptions };
}

test('VID-03 submit: video wire expectations on the payload reach the correlation arm', async () => {
  const { operations, armOptions } = operationsHarness();
  const result = await operations.execute('flow.generation.submit', {
    prompt: 'a lighthouse',
    type: 'video',
    expectedVideoModelKey: 'veo-3-wire-key',
    expectedVideoRatioEnum: 2,
  }, {});
  assert.equal(result.submitted, true);
  assert.equal(armOptions().expectedVideoModelKey, 'veo-3-wire-key');
  assert.equal(armOptions().expectedVideoRatioEnum, 2);
});

test('VID-03 submit: video wire expectations in the params bag reach the correlation arm', async () => {
  const { operations, armOptions } = operationsHarness();
  const result = await operations.execute('flow.generation.submit', {
    prompt: 'a lighthouse',
    type: 'video',
    params: { expectedVideoModelKey: 'veo-3-wire-key', expectedVideoRatioEnum: 3 },
  }, {});
  assert.equal(result.submitted, true);
  assert.equal(armOptions().expectedVideoModelKey, 'veo-3-wire-key');
  assert.equal(armOptions().expectedVideoRatioEnum, 3);
});

test('VID-03 submit: image wire expectation on the payload reaches the correlation arm', async () => {
  const { operations, armOptions } = operationsHarness();
  const result = await operations.execute('flow.generation.submit', {
    prompt: 'a cat',
    type: 'image',
    expectedImageModelKey: 'imagen-4-wire-key',
  }, {});
  assert.equal(result.submitted, true);
  assert.equal(armOptions().expectedImageModelKey, 'imagen-4-wire-key');
});

test('VID-03 submit control: no expectations on the payload — the arm options keep the historical shape', async () => {
  const { operations, armOptions } = operationsHarness();
  const result = await operations.execute('flow.generation.submit', {
    prompt: 'a lighthouse',
    type: 'video',
  }, {});
  assert.equal(result.submitted, true);
  assert.equal(Object.hasOwn(armOptions(), 'expectedVideoModelKey'), false);
  assert.equal(Object.hasOwn(armOptions(), 'expectedVideoRatioEnum'), false);
  assert.equal(Object.hasOwn(armOptions(), 'expectedImageModelKey'), false);
});
