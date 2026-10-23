import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

import { FlowJobQueue } from '../extension/src/background/flow-job-queue.js';

const domUtilsSource = readFileSync(new URL('../extension/src/content/shared/dom-utils.js', import.meta.url), 'utf8');
const operationsSource = readFileSync(new URL('../extension/src/content/providers/flow/generation/generation-operations.js', import.meta.url), 'utf8');

// ---------------------------------------------------------------------------
// VID-04: structured evidence bundle on observe timeout/failure.
//
// Every terminal observe error carries a `diagnostics` bundle maintained
// from the observe loop's own counters — {requestSeen, lastReceiptStage,
// correlatedMediaIds, readyCount, busyCount, failedCount, elapsedMs} — so
// live triage can distinguish "Flow never started" (requestSeen false,
// zeroed tallies) from "rendered but unmatched" (request seen, correlated
// ids known, a tile still busy at the deadline). Success and VID-01
// partial resolutions are not errors and must NOT gain the bundle. The
// queue already persists error diagnostics on the failed job (post-sweep
// plumbing in flow-job-queue.js); the last tests pin that contract.
// ---------------------------------------------------------------------------

// Objects produced inside the vm realm carry that realm's prototypes, so
// deepStrictEqual against test-realm literals needs a plain round-trip.
const plain = value => JSON.parse(JSON.stringify(value));

const BUSY_TILE = { id: 'media-1', title: 'scene-01', kind: 'image', mediaReady: false, busy: true, failed: false };
const READY_TILE = { id: 'media-1', title: 'scene-01', kind: 'image', mediaReady: true, busy: false, failed: false };
const READY_TILE_2 = { id: 'media-2', title: 'scene-02', kind: 'image', mediaReady: true, busy: false, failed: false };
const FAILED_TILE = { id: 'media-2', title: 'scene-02', kind: 'image', mediaReady: false, busy: false, failed: true, failureReason: 'Generation failed' };
const FAILED_TILE_1 = { ...FAILED_TILE, id: 'media-1', title: 'scene-01' };
const RECEIPT_BOTH = { stage: 'response_seen', mediaIds: ['media-1', 'media-2'], children: [] };

function observeHarness({ mediaScript, receipt = RECEIPT_BOTH, entryReceipts = [], requestSeen = true }) {
  const attemptId = 'attempt-1';
  const correlation = new Map([[attemptId, {
    attemptId, receipts: entryReceipts, requestSeen, interfered: false, projectId: 'project-1', mediaType: 'image',
  }]]);
  let now = 1_000_000;
  let scans = 0;
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
    before: [], kind: 'image', expectedCount: 2, timeoutMs: 30_000, correlationAttemptId: attemptId, ...payload,
  }, {});
  return { observe, progressEvents, scanCount: () => scans };
}

test('observe timeout: request seen + one tile still busy → diagnostics bundle separates "rendered but unmatched" from "never started"', async () => {
  const { observe } = observeHarness({ mediaScript: () => [BUSY_TILE] });
  // Before VID-04 the timeout error was prose only: no counters, no last
  // receipt stage, no correlated ids — triage could not tell this state
  // (Flow accepted the request, one output is still rendering) from a
  // generation that never started.
  await assert.rejects(observe({ retries: 0 }), error => {
    assert.equal(error.code, 'FLOW_GENERATION_TIMEOUT');
    assert.equal(error.outcome_unknown, true);
    assert.ok(error.diagnostics, 'the timeout error must carry the evidence bundle');
    const diagnostics = plain(error.diagnostics);
    assert.equal(diagnostics.requestSeen, true);
    assert.equal(diagnostics.lastReceiptStage, 'response_seen');
    assert.deepEqual(diagnostics.correlatedMediaIds, ['media-1', 'media-2']);
    assert.equal(diagnostics.readyCount, 0);
    assert.equal(diagnostics.busyCount, 1);
    assert.equal(diagnostics.failedCount, 0);
    assert.ok(diagnostics.elapsedMs >= 30_000, `elapsedMs must cover the full observe window, got ${diagnostics.elapsedMs}`);
    return true;
  });
});

test('observe timeout: never started → requestSeen false, no receipt stage, zeroed tallies', async () => {
  const { observe } = observeHarness({
    mediaScript: () => [],
    receipt: null,
    requestSeen: false,
  });
  await assert.rejects(observe({ retries: 0 }), error => {
    assert.equal(error.code, 'FLOW_GENERATION_TIMEOUT');
    assert.ok(error.diagnostics, 'the timeout error must carry the evidence bundle');
    const diagnostics = plain(error.diagnostics);
    assert.equal(diagnostics.requestSeen, false);
    assert.equal(diagnostics.lastReceiptStage, null);
    assert.deepEqual(diagnostics.correlatedMediaIds, []);
    assert.equal(diagnostics.readyCount, 0);
    assert.equal(diagnostics.busyCount, 0);
    assert.equal(diagnostics.failedCount, 0);
    assert.ok(diagnostics.elapsedMs >= 30_000, `elapsedMs must cover the full observe window, got ${diagnostics.elapsedMs}`);
    return true;
  });
});

test('observe all-failed: the terminal failure carries the final poll tallies', async () => {
  const { observe } = observeHarness({ mediaScript: () => [FAILED_TILE_1, FAILED_TILE] });
  await assert.rejects(observe({ retries: 0 }), error => {
    assert.equal(error.code, 'FLOW_GENERATION_FAILED');
    assert.equal(error.outcome_unknown, false);
    assert.ok(error.diagnostics, 'the all-failed error must carry the evidence bundle');
    const diagnostics = plain(error.diagnostics);
    assert.equal(diagnostics.requestSeen, true);
    assert.equal(diagnostics.lastReceiptStage, 'response_seen');
    assert.deepEqual(diagnostics.correlatedMediaIds, ['media-1', 'media-2']);
    assert.equal(diagnostics.readyCount, 0);
    assert.equal(diagnostics.busyCount, 0);
    assert.equal(diagnostics.failedCount, 2);
    assert.equal(typeof diagnostics.elapsedMs, 'number');
    assert.ok(diagnostics.elapsedMs >= 0);
    return true;
  });
});

test('observe receipt error: the classified receipt failure carries request evidence from the same poll', async () => {
  const { observe } = observeHarness({
    mediaScript: () => [],
    receipt: { stage: 'response_seen', mediaIds: ['media-1'], children: [], error: 'Generation failed' },
  });
  await assert.rejects(observe({ retries: 0 }), error => {
    assert.equal(error.code, 'FLOW_GENERATION_FAILED');
    assert.ok(error.diagnostics, 'the receipt error must carry the evidence bundle');
    const diagnostics = plain(error.diagnostics);
    assert.equal(diagnostics.requestSeen, true);
    assert.equal(diagnostics.lastReceiptStage, 'response_seen');
    return true;
  });
});

test('observe partial resolution (VID-01) is not an error: no diagnostics bundle, failedOutputs shape untouched', async () => {
  const { observe } = observeHarness({ mediaScript: () => [READY_TILE, FAILED_TILE] });
  const result = await observe({ retries: 0 });
  assert.equal(result.partial, true);
  assert.equal(result.diagnostics, undefined);
  assert.deepEqual(plain(result.failedOutputs), [{ title: 'scene-02', code: 'FLOW_GENERATION_FAILED' }]);
  assert.deepEqual(plain(result.media), [{ id: 'media-1', title: 'scene-01', kind: 'image' }]);
});

test('observe full success carries no diagnostics bundle (unchanged)', async () => {
  const { observe } = observeHarness({ mediaScript: () => [READY_TILE, READY_TILE_2] });
  const result = await observe({ retries: 0 });
  assert.equal(result.diagnostics, undefined);
  assert.equal(result.media.length, 2);
});

// ---------------------------------------------------------------------------
// Queue-level: the post-sweep plumbing persists error diagnostics on the
// failed job. These tests pin that contract at the runner boundary — the
// level the queue actually sees — so the VID-04 bundle produced above is
// what lands on the job record.
// ---------------------------------------------------------------------------

function memoryStorage(backing = {}) {
  return {
    backing,
    async get(key) { return { [key]: backing[key] }; },
    async set(entries) { Object.assign(backing, entries); },
    async remove(key) { delete backing[key]; },
  };
}

function makeQueue(runner, storage = memoryStorage()) {
  return new FlowJobQueue(runner, { storage, minDelayMs: 0, maxDelayMs: 0 });
}

async function runJob(queue, input) {
  const added = await queue.add(input);
  await queue.start();
  return queue.wait(added.id, 5_000);
}

test('queue: a failed job persists the observe diagnostics bundle from the runner error', async () => {
  const bundle = {
    requestSeen: true,
    lastReceiptStage: 'response_seen',
    correlatedMediaIds: ['media-1', 'media-2'],
    readyCount: 0,
    busyCount: 1,
    failedCount: 0,
    elapsedMs: 30_000,
  };
  const queue = makeQueue(async () => {
    throw Object.assign(new Error('Hết thời gian chờ Flow render.'), {
      code: 'FLOW_GENERATION_TIMEOUT', retryable: false, outcomeUnknown: false, diagnostics: bundle,
    });
  });
  const { job } = await runJob(queue, {
    operation: 'flow.generation.submit',
    payload: { prompt: 'two scenes', variants: 2 },
    label: 'two scenes',
  });
  assert.equal(job.status, 'failed');
  assert.equal(job.errorCode, 'FLOW_GENERATION_TIMEOUT');
  assert.deepEqual(job.diagnostics, bundle);
});

test('queue: a failed job whose error carries no diagnostics keeps job.diagnostics unset (unchanged)', async () => {
  const queue = makeQueue(async () => {
    throw Object.assign(new Error('Flow báo cáo 2 tile render thất bại'), { code: 'FLOW_GENERATION_FAILED', retryable: false, outcomeUnknown: false });
  });
  const { job } = await runJob(queue, {
    operation: 'flow.generation.submit',
    payload: { prompt: 'two scenes', variants: 2 },
    label: 'two scenes',
  });
  assert.equal(job.status, 'failed');
  assert.equal(job.diagnostics, undefined);
});
