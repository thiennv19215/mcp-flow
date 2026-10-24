import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const domUtilsSource = readFileSync(new URL('../extension/src/content/shared/dom-utils.js', import.meta.url), 'utf8');
const operationsSource = readFileSync(new URL('../extension/src/content/providers/flow/generation/generation-operations.js', import.meta.url), 'utf8');

// ---------------------------------------------------------------------------
// VID-08: virtualization recovery sweep for claimed tiles in observe.
//
// Flow's grid virtualizes tiles out of the DOM while they render. When that
// happens to a tile this observe has claimed, the periodic grid scans lose
// it entirely — observe sees no fresh media and no receipt movement and
// idles to the deadline even though the finished media exists elsewhere in
// the library. After a sustained quiet window (~30 s with neither fresh
// media nor receipt progress) observe must run a bounded number of
// full-library scans (the media-menu scanNativeAssets machinery) filtered
// by the attempt's correlated id set, and feed recovered media through the
// same success / VID-01 partial resolution as grid-observed media. The
// sweep never extends the VID-02 anchored deadline, never runs while
// progress is happening, and never accepts ids outside the correlated set.
// ---------------------------------------------------------------------------

// Objects produced inside the vm realm carry that realm's prototypes, so
// deepStrictEqual against test-realm literals needs a plain round-trip.
const plain = value => JSON.parse(JSON.stringify(value));

const START = 1_000_000;
const BUSY_TILE = { id: 'media-1', title: 'scene-01', kind: 'image', mediaReady: false, busy: true, failed: false };
const BUSY_TILE_2 = { id: 'media-2', title: 'scene-02', kind: 'image', mediaReady: false, busy: true, failed: false };
const READY_TILE = { id: 'media-1', title: 'scene-01', kind: 'image', mediaReady: true, busy: false, failed: false };
const RECEIPT_ONE = { stage: 'response_seen', mediaIds: ['media-1'], children: [] };
const RECEIPT_BOTH = { stage: 'response_seen', mediaIds: ['media-1', 'media-2'], children: [] };

function sweepHarness({ mediaScript, receipt = RECEIPT_ONE, scanScript = () => [], expectedCount = 1 }) {
  const attemptId = 'attempt-1';
  const correlation = new Map([[attemptId, {
    attemptId, receipts: [], requestSeen: true, interfered: false, projectId: 'project-1', mediaType: 'image',
  }]]);
  let now = START;
  let scans = 0;
  const scanCalls = [];
  const progressEvents = [];
  const context = vm.createContext({
    Date: { now: () => now },
    Promise, Map, Set, Object, String, Number, Boolean, Array, Math, RegExp, Error, JSON,
    setTimeout, clearTimeout,
    window: { addEventListener() {}, removeEventListener() {} },
    document: { querySelectorAll: () => [], querySelector: () => null, body: null },
    location: { href: 'https://flow.google.com/u/0/?hl=vi', origin: 'https://flow.google.com' },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    checkFlowCreditLimitAlert: () => null,
    FlowEditor: {
      currentFlowSubmitErrors: () => [],
      getFlowSubmitButton: () => null,
      getEditorUserText: () => '',
    },
    FlowTiles: {
      nativeFlowCorrelationMap: () => correlation,
      nativeFlowCorrelationReceipt: () => receipt,
      collectNativeMedia: () => mediaScript(scans++),
      emitFlowProgress: async (command, message, extra) => { progressEvents.push({ message, extra }); },
      disarmNativeFlowCorrelation: () => {},
      retryIdentity: item => item.id,
      retryNativeErrorTile: async () => false,
    },
    FlowMediaMenu: {
      scanNativeAssets: async options => {
        scanCalls.push(options);
        return scanScript(scanCalls.length, options);
      },
    },
  });
  context.__advanceClock = ms => { now += Math.max(0, Number(ms) || 0); };
  vm.runInContext(domUtilsSource, context);
  vm.runInContext(operationsSource, context);
  // Deterministic clock: every wait advances fake time so the 5 s media
  // rescan interval elapses between polls without real delays.
  vm.runInContext('globalThis.wait = ms => { globalThis.__advanceClock(ms); return Promise.resolve(); };', context);
  const driver = {
    error: (code, message, retryable, outcome_unknown) => Object.assign(new Error(message), { code, retryable, outcome_unknown }),
  };
  const operations = new context.FlowGenerationOperations(driver);
  const observe = (payload = {}) => operations.execute('flow.generation.observe', {
    before: [], kind: 'image', expectedCount, timeoutMs: 120_000, correlationAttemptId: attemptId, ...payload,
  }, {});
  return { observe, scanCalls, progressEvents };
}

test('observe sweep: busy tile virtualized out of the grid mid-render → finished media recovered from a full-library scan instead of timing out', async () => {
  const { observe, scanCalls } = sweepHarness({
    // The claimed tile renders in the grid for two scans, then Flow
    // virtualizes it out of the DOM: grid scans see nothing ever again.
    mediaScript: scan => (scan < 2 ? [BUSY_TILE] : []),
    scanScript: () => [{ id: 'media-1', name: 'scene-01', kind: 'image', busy: false, ready: true, error: false }],
  });
  const result = await observe({ retries: 0 });
  assert.deepEqual(plain(result.media), [{ id: 'media-1', title: 'scene-01', kind: 'image' }]);
  assert.equal(result.partial, undefined);
  assert.equal(scanCalls.length, 1, 'exactly one recovery sweep should have run');
  // The sweep is a full-library scan bounded by the observe deadline: it
  // must ask for incomplete tiles (busy/ready/error states) and must never
  // be handed a deadline beyond the observe deadline (START + 120 s).
  assert.equal(scanCalls[0].includeIncomplete, true);
  assert.ok(scanCalls[0].deadline <= START + 120_000, `sweep deadline ${scanCalls[0].deadline} must not exceed the observe deadline`);
});

test('observe sweep: a recovered failed tile flows through the VID-01 partial resolution', async () => {
  const { observe, scanCalls } = sweepHarness({
    expectedCount: 2,
    receipt: RECEIPT_BOTH,
    // media-1 finishes in the grid; the media-2 tile is virtualized away
    // after two scans and only exists in the full library — as a failure.
    mediaScript: scan => (scan < 2 ? [READY_TILE, BUSY_TILE_2] : [READY_TILE]),
    scanScript: () => [{ id: 'media-2', name: 'scene-02', kind: 'image', busy: false, ready: false, error: true }],
  });
  const result = await observe({ retries: 0 });
  assert.equal(result.partial, true);
  assert.deepEqual(plain(result.media), [{ id: 'media-1', title: 'scene-01', kind: 'image' }]);
  assert.deepEqual(plain(result.failedOutputs), [{ title: 'scene-02', code: 'FLOW_GENERATION_FAILED' }]);
  assert.equal(scanCalls.length, 1);
});

test('observe sweep: progress happening (busy tile percentage advancing) → no sweep ever runs', async () => {
  const { observe, scanCalls } = sweepHarness({
    mediaScript: scan => [{ ...BUSY_TILE, progress: `${(scan % 9) * 10 + 10}%` }],
    scanScript: () => [{ id: 'media-1', name: 'scene-01', kind: 'image', busy: false, ready: true, error: false }],
  });
  await assert.rejects(observe({ retries: 0 }), error => {
    assert.equal(error.code, 'FLOW_GENERATION_TIMEOUT');
    assert.ok(error.diagnostics, 'the timeout error must carry the evidence bundle');
    assert.equal(error.diagnostics.recoverySweeps, 0);
    return true;
  });
  assert.equal(scanCalls.length, 0, 'a rendering tile that keeps moving must never trigger a sweep');
});

test('observe sweep: scan hits outside the correlated set are ignored, the sweep bound caps out, and the normal timeout still fires', async () => {
  const { observe, scanCalls } = sweepHarness({
    mediaScript: scan => (scan < 1 ? [BUSY_TILE] : []),
    // The library scan finds finished media — but it belongs to another
    // attempt. Attribution discipline (VID-03/VID-06): not evidence.
    scanScript: () => [{ id: 'media-foreign', name: 'someone-else', kind: 'image', busy: false, ready: true, error: false }],
  });
  await assert.rejects(observe({ retries: 0 }), error => {
    assert.equal(error.code, 'FLOW_GENERATION_TIMEOUT');
    assert.ok(error.diagnostics, 'the timeout error must carry the evidence bundle');
    assert.deepEqual(plain(error.diagnostics.correlatedMediaIds), ['media-1']);
    assert.equal(error.diagnostics.recoverySweeps, 3, 'the diagnostics bundle records how many sweeps ran');
    return true;
  });
  assert.equal(scanCalls.length, 3, 'sweeps are bounded and spaced by the quiet window, never one per poll');
});

test('observe sweep: the VID-02 anchored deadline is never extended — a quiet window that would end after the deadline produces no sweep', async () => {
  const { observe, scanCalls } = sweepHarness({
    mediaScript: scan => (scan < 1 ? [BUSY_TILE] : []),
    scanScript: () => [{ id: 'media-1', name: 'scene-01', kind: 'image', busy: false, ready: true, error: false }],
  });
  // Dispatched 90 s ago with a 120 s budget: only 30 s remain. The tile
  // vanishes immediately, so the 30 s quiet window completes right at the
  // deadline — recovery happens inside the existing budget or not at all.
  await assert.rejects(observe({ retries: 0, dispatchedAt: START - 90_000 }), error => {
    assert.equal(error.code, 'FLOW_GENERATION_TIMEOUT');
    assert.ok(error.diagnostics.elapsedMs >= 30_000 && error.diagnostics.elapsedMs < 35_000,
      `elapsed must stay inside the anchored budget, got ${error.diagnostics.elapsedMs}`);
    return true;
  });
  assert.equal(scanCalls.length, 0);
});
