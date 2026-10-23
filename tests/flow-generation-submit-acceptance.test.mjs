import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const tilesSource = readFileSync(new URL('../extension/src/content/providers/flow/generation/tiles.js', import.meta.url), 'utf8');
const operationsSource = readFileSync(new URL('../extension/src/content/providers/flow/generation/generation-operations.js', import.meta.url), 'utf8');

// ---------------------------------------------------------------------------
// VID-06: `serverAcceptanceObserved` reflects the real receipt stage.
//
// The submit result used to hardcode `serverAcceptanceObserved: false`, so
// status consumers could not tell "request left the browser" (request_seen)
// from "Flow accepted it" (an accepted/result receipt stage). The flag now
// derives from the attempt's OWN correlation receipts: only response_seen /
// result_seen — the pair nativeFlowCorrelationReceipt already treats as the
// accepted/result receipt — set it. Request-seen alone never does, an
// acceptance_unknown receipt explicitly does not, and a missing entry keeps
// the historical false with no new failure mode.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Part 1 — the tiles helper against the real tiles module.
// ---------------------------------------------------------------------------

function tilesHarness(entries = []) {
  const dispatched = [];
  const context = vm.createContext({
    Map, Set, Object, Math, String, Number, Boolean, Array, Promise, Date, RegExp,
    crypto: { randomUUID: () => 'test-nonce' },
    window: {
      removeEventListener() {},
      dispatchEvent(event) { dispatched.push(event); },
    },
    CustomEvent: class CustomEvent { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
  });
  vm.runInContext(tilesSource, context);
  context.__flowNativeGenerationCorrelations = new Map(entries.map(entry => [entry.attemptId, entry]));
  return { tiles: context.FlowTiles, context, dispatched };
}

const entryWith = (attemptId, stages) => ({
  attemptId,
  nonce: `nonce-${attemptId}`,
  requestSeen: stages.includes('request_seen'),
  listener() {},
  receipts: stages.map(stage => ({ stage })),
});

test('tiles: a response_seen receipt for the attempt proves server acceptance', () => {
  const { tiles } = tilesHarness([entryWith('attempt-1', ['armed', 'request_seen', 'response_seen'])]);
  assert.equal(tiles.nativeFlowCorrelationAcceptanceObserved('attempt-1'), true);
});

test('tiles: a result_seen receipt for the attempt proves server acceptance', () => {
  const { tiles } = tilesHarness([entryWith('attempt-1', ['armed', 'request_seen', 'result_seen'])]);
  assert.equal(tiles.nativeFlowCorrelationAcceptanceObserved('attempt-1'), true);
});

test('tiles: request-seen alone is NOT acceptance', () => {
  const { tiles } = tilesHarness([entryWith('attempt-1', ['armed', 'input_seen', 'request_seen'])]);
  assert.equal(tiles.nativeFlowCorrelationAcceptanceObserved('attempt-1'), false);
});

test('tiles: acceptance_unknown and poll receipts never count as acceptance', () => {
  const { tiles } = tilesHarness([entryWith('attempt-1', ['armed', 'request_seen', 'acceptance_unknown', 'poll_seen'])]);
  assert.equal(tiles.nativeFlowCorrelationAcceptanceObserved('attempt-1'), false);
});

test('tiles: a missing correlation entry keeps the flag false', () => {
  const { tiles } = tilesHarness([]);
  assert.equal(tiles.nativeFlowCorrelationAcceptanceObserved('attempt-1'), false);
  assert.equal(tiles.nativeFlowCorrelationAcceptanceObserved(''), false);
  assert.equal(tiles.nativeFlowCorrelationAcceptanceObserved(undefined), false);
});

test('tiles: acceptance is read from the attempt\'s own receipts only', () => {
  const { tiles } = tilesHarness([
    entryWith('attempt-1', ['armed', 'request_seen']),
    entryWith('attempt-2', ['armed', 'request_seen', 'response_seen']),
  ]);
  assert.equal(tiles.nativeFlowCorrelationAcceptanceObserved('attempt-1'), false);
  assert.equal(tiles.nativeFlowCorrelationAcceptanceObserved('attempt-2'), true);
});

// ---------------------------------------------------------------------------
// Part 2 — the submit result carries the derived flag.
// The FlowTiles stub below implements the helper's documented contract
// (scan the attempt's own receipts for an accepted/result stage) so these
// tests pin the generation-operations wiring: the flag is computed from the
// attempt's receipts, before any submit-only release deletes the entry, and
// its absence never breaks the submit.
// ---------------------------------------------------------------------------

const ACCEPTANCE_STAGES = ['response_seen', 'result_seen'];

function operationsHarness({ receipts = [{ stage: 'request_seen' }], withAcceptanceHelper = true, submitOnly = false } = {}) {
  const correlationMap = new Map([
    ['attempt-1', { attemptId: 'attempt-1', requestSeen: true, receipts, interfered: false }],
  ]);
  const startButton = { disabled: false, getAttribute: () => null };
  const fakeTiles = {
    stabilizeFlowResultViewport: async () => {},
    collectNativeMedia: () => [],
    armNativeFlowCorrelation: () => 'attempt-1',
    nativeFlowCorrelationMap: () => correlationMap,
    disarmNativeFlowCorrelation: () => {},
    emitFlowProgress: () => {},
    readNativeFlowCorrelationHealth: async () => null,
    releaseSubmitOnlyCorrelation: (attemptId, acknowledged) => {
      if (acknowledged !== true) return null;
      const entry = correlationMap.get(attemptId);
      if (!entry?.requestSeen) return null;
      correlationMap.delete(attemptId);
      return { stage: 'request_seen', attemptId };
    },
  };
  if (withAcceptanceHelper) {
    fakeTiles.nativeFlowCorrelationAcceptanceObserved = attemptId => {
      const entry = correlationMap.get(String(attemptId || ''));
      if (!entry || !Array.isArray(entry.receipts)) return false;
      return entry.receipts.some(receipt => ACCEPTANCE_STAGES.includes(receipt?.stage));
    };
  }
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
    FlowTiles: fakeTiles,
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
  const operations = new context.FlowGenerationOperations(driver);
  const submit = (payload = {}) => operations.execute('flow.generation.submit', {
    prompt: 'a lighthouse', type: 'video', ...(submitOnly ? { submitOnly: true } : {}), ...payload,
  }, {});
  return { submit, correlationMap };
}

test('submit: receipts reaching the accepted stage set serverAcceptanceObserved true', async () => {
  const { submit } = operationsHarness({
    receipts: [{ stage: 'armed' }, { stage: 'request_seen' }, { stage: 'response_seen' }],
  });
  const result = await submit();
  assert.equal(result.submitted, true);
  assert.equal(result.requestDispatched, true);
  assert.equal(result.serverAcceptanceObserved, true);
});

test('submit: receipts reaching the result stage set serverAcceptanceObserved true', async () => {
  const { submit } = operationsHarness({
    receipts: [{ stage: 'request_seen' }, { stage: 'result_seen' }],
  });
  const result = await submit();
  assert.equal(result.submitted, true);
  assert.equal(result.serverAcceptanceObserved, true);
});

test('submit: request-seen-only receipts keep serverAcceptanceObserved false', async () => {
  const { submit } = operationsHarness({
    receipts: [{ stage: 'armed' }, { stage: 'input_seen' }, { stage: 'request_seen' }],
  });
  const result = await submit();
  assert.equal(result.submitted, true);
  assert.equal(result.requestDispatched, true);
  assert.equal(result.serverAcceptanceObserved, false);
});

test('submit: an acceptance_unknown receipt does not set the flag', async () => {
  const { submit } = operationsHarness({
    receipts: [{ stage: 'request_seen' }, { stage: 'acceptance_unknown' }],
  });
  const result = await submit();
  assert.equal(result.submitted, true);
  assert.equal(result.serverAcceptanceObserved, false);
});

test('submit-only: the flag is read before the release deletes the correlation entry', async () => {
  const { submit, correlationMap } = operationsHarness({
    receipts: [{ stage: 'request_seen' }, { stage: 'response_seen' }],
    submitOnly: true,
  });
  const result = await submit();
  assert.equal(result.submitted, true);
  assert.equal(result.serverAcceptanceObserved, true);
  // The release really happened — the flag cannot have been read afterwards.
  assert.equal(correlationMap.has('attempt-1'), false);
  assert.equal(result.correlationReceipt?.stage, 'request_seen');
});

test('submit: a tiles surface without the acceptance helper keeps the historical false and still succeeds', async () => {
  const { submit } = operationsHarness({
    receipts: [{ stage: 'request_seen' }, { stage: 'response_seen' }],
    withAcceptanceHelper: false,
  });
  const result = await submit();
  assert.equal(result.submitted, true);
  assert.equal(result.serverAcceptanceObserved, false);
});
