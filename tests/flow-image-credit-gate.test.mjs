import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// IMG-07 (gap G4 / behavior 36): the credit quote + maxCredits gate must run
// for image jobs too, not just video. These tests drive the real
// flow.generation.submit operation with a fake Flow page whose composer shows
// a configurable credit quote.

const operationsSource = readFileSync(
  new URL('../extension/src/content/providers/flow/generation/generation-operations.js', import.meta.url),
  'utf8',
);

function makeHarness({ quote } = {}) {
  const calls = { quoteReads: 0, arms: 0, activations: 0 };
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
      waitForGenerationCreditQuote: async () => {
        calls.quoteReads += 1;
        return quote;
      },
      waitForGenerationSubmitButton: async () => startButton,
      activateFlowSubmitButton: async () => {
        calls.activations += 1;
        return { clickDelivered: true, strategy: 'fake-click' };
      },
      currentFlowSubmitErrors: () => [],
    },
    FlowSettings: {},
    FlowComponents: {},
    FlowTiles: {
      stabilizeFlowResultViewport: async () => {},
      collectNativeMedia: () => [],
      armNativeFlowCorrelation: () => {
        calls.arms += 1;
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
  const operations = new context.FlowGenerationOperations(driver);
  return { operations, calls };
}

function submit(operations, payload) {
  return operations.execute('flow.generation.submit', { prompt: 'a cat', ...payload }, {});
}

test('IMG-07 (a): image job with maxCredits below the shown quote aborts with FLOW_MAX_CREDITS_EXCEEDED before arming or clicking', async () => {
  const { operations, calls } = makeHarness({ quote: 40 });
  await assert.rejects(
    submit(operations, { type: 'image', maxCredits: 5 }),
    error => error.code === 'FLOW_MAX_CREDITS_EXCEEDED',
  );
  assert.equal(calls.arms, 0, 'correlation must not be armed when the gate aborts');
  assert.equal(calls.activations, 0, 'the submit button must not be clicked when the gate aborts');
});

test('IMG-07 (a2): snake_case max_credits on an image job is enforced the same way', async () => {
  const { operations, calls } = makeHarness({ quote: 40 });
  await assert.rejects(
    submit(operations, { type: 'image', max_credits: 10 }),
    error => error.code === 'FLOW_MAX_CREDITS_EXCEEDED',
  );
  assert.equal(calls.arms, 0);
  assert.equal(calls.activations, 0);
});

test('IMG-07 (b): image job with a sufficient cap proceeds and reports the read quote', async () => {
  const { operations, calls } = makeHarness({ quote: 40 });
  const result = await submit(operations, { type: 'image', maxCredits: 50 });
  assert.equal(result.submitted, true);
  assert.equal(result.credits, 40);
  assert.equal(calls.quoteReads, 1);
  assert.equal(calls.arms, 1);
  assert.equal(calls.activations, 1);
});

test('IMG-07 (c): image job with a cap but no readable quote fails closed with FLOW_CREDIT_QUOTE_UNAVAILABLE', async () => {
  const { operations, calls } = makeHarness({ quote: undefined });
  await assert.rejects(
    submit(operations, { type: 'image', maxCredits: 5 }),
    error => error.code === 'FLOW_CREDIT_QUOTE_UNAVAILABLE',
  );
  assert.equal(calls.arms, 0, 'an unreadable quote with a cap set must abort before arming');
  assert.equal(calls.activations, 0);
});

test('IMG-07 (d): image job with NO cap proceeds exactly as before, without any quote read', async () => {
  const { operations, calls } = makeHarness({ quote: 40 });
  const result = await submit(operations, { type: 'image' });
  assert.equal(result.submitted, true);
  assert.equal(calls.quoteReads, 0, 'uncapped image jobs must not gain a quote read');
  assert.equal(result.credits, null, 'uncapped image jobs keep reporting no credits, as today');
  assert.equal(calls.activations, 1);
});

test('IMG-07 pin: video job with a cap above the quote still aborts (pre-existing gate unchanged)', async () => {
  const { operations, calls } = makeHarness({ quote: 40 });
  await assert.rejects(
    submit(operations, { type: 'video', maxCredits: 5 }),
    error => error.code === 'FLOW_MAX_CREDITS_EXCEEDED',
  );
  assert.equal(calls.arms, 0);
  assert.equal(calls.activations, 0);
});

test('IMG-07 pin: video job with no cap still reads the quote for credit reporting (pre-existing behavior)', async () => {
  const { operations, calls } = makeHarness({ quote: 40 });
  const result = await submit(operations, { type: 'video' });
  assert.equal(result.submitted, true);
  assert.equal(calls.quoteReads, 1);
  assert.equal(result.credits, 40);
});
