import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const tilesSource = readFileSync(new URL('../extension/content/providers/flow/FlowTiles.js', import.meta.url), 'utf8');
const operationsSource = readFileSync(new URL('../extension/content/providers/flow/FlowGenerationOperations.js', import.meta.url), 'utf8');

function tilesHarness() {
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
  return { tiles: context.FlowTiles, context, dispatched };
}

test('submit-only cleanup preserves the correlated dispatch receipt and disarms after confirmed dispatch', () => {
  const { tiles, context, dispatched } = tilesHarness();
  context.__flowNativeGenerationCorrelations = new Map([['attempt-1', {
    attemptId: 'attempt-1', nonce: 'nonce-1', requestSeen: true, listener() {},
    receipts: [{ stage: 'armed' }, {
      stage: 'request_seen', requestOrdinal: 0, requestCardinality: 1, matchKind: 'structured_ids', privatePayload: 'must not escape',
    }],
  }]]);

  const receipt = tiles.releaseSubmitOnlyCorrelation('attempt-1', true);

  assert.deepEqual({ ...receipt }, {
    stage: 'request_seen', attemptId: 'attempt-1', requestOrdinal: 0, requestCardinality: 1, matchKind: 'structured_ids',
  });
  assert.equal(context.__flowNativeGenerationCorrelations.has('attempt-1'), false);
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].type, 'TOBY_FLOW_CORRELATION_DISARM');
  assert.equal(dispatched[0].detail.dispatched, true);
  assert.equal(dispatched[0].detail.completedDispatch, true);
});

test('submit-only cleanup does not release an attempt without authoritative dispatch evidence', () => {
  const { tiles, context, dispatched } = tilesHarness();
  context.__flowNativeGenerationCorrelations = new Map([['attempt-1', {
    attemptId: 'attempt-1', nonce: 'nonce-1', requestSeen: true, listener() {},
    receipts: [{ stage: 'request_seen', requestOrdinal: 0, requestCardinality: 1, matchKind: 'plain_text' }],
  }]]);

  assert.equal(tiles.releaseSubmitOnlyCorrelation('attempt-1', false), null);
  assert.equal(context.__flowNativeGenerationCorrelations.has('attempt-1'), true);
  assert.equal(dispatched.length, 0);
});

test('only the successful submit-only return path releases correlation and dispatch is not acceptance', () => {
  const successBranch = operationsSource.slice(operationsSource.indexOf('const dispatchReceipt = payload.submitOnly'));
  assert.match(successBranch, /payload\.submitOnly === true[\s\S]*?releaseSubmitOnlyCorrelation\?\.\(correlationAttemptId, acknowledged\)/);
  assert.match(successBranch, /requestDispatched: acknowledged,[\s\S]*?serverAcceptanceObserved: false/);
  const unknownBranch = operationsSource.slice(operationsSource.indexOf('if \(!acknowledged\)'), operationsSource.indexOf('const dispatchReceipt = payload.submitOnly'));
  assert.match(unknownBranch, /FLOW_SUBMIT_UNCONFIRMED/);
  assert.doesNotMatch(unknownBranch, /releaseSubmitOnlyCorrelation/);
});
