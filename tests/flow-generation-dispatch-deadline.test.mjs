import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

import { FlowJobQueue } from '../extension/src/background/flow-job-queue.js';

const domUtilsSource = readFileSync(new URL('../extension/src/content/shared/dom-utils.js', import.meta.url), 'utf8');
const operationsSource = readFileSync(new URL('../extension/src/content/providers/flow/generation/generation-operations.js', import.meta.url), 'utf8');

// ---------------------------------------------------------------------------
// VID-02: render deadline anchored at dispatch.
//
// The observation checkpoint stores `dispatchedAt` at submit acknowledgement
// and observe computes deadline = dispatchedAt + timeoutMs, so a
// service-worker restart resumes with the REMAINING budget instead of a
// fresh full window. Legacy checkpoints without the stamp keep the
// historical behavior (fresh window from observe entry).
// ---------------------------------------------------------------------------

// Objects produced inside the vm realm carry that realm's prototypes, so
// deepStrictEqual against test-realm literals needs a plain round-trip.
const plain = value => JSON.parse(JSON.stringify(value));

const READY_TILE = { id: 'media-1', title: 'scene-01', kind: 'image', mediaReady: true, busy: false, failed: false };
const FAILED_TILE = { id: 'media-2', title: 'scene-02', kind: 'image', mediaReady: false, busy: false, failed: true, failureReason: 'Generation failed' };
const RECEIPT_BOTH = { mediaIds: ['media-1', 'media-2'], children: [] };
const RECEIPT_NONE = { mediaIds: [], children: [] };

function operationsHarness({ mediaScript = () => [], receipt = RECEIPT_NONE, startAt = 1_000_000 } = {}) {
  const attemptId = 'attempt-1';
  const correlation = new Map([[attemptId, {
    attemptId,
    receipts: [{ stage: 'request_seen', requestOrdinal: 0, requestCardinality: 1, matchKind: 'structured_ids' }],
    requestSeen: true, interfered: false, projectId: 'project-1', mediaType: 'video',
  }]]);
  let now = startAt;
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
    FlowEditor: { currentFlowSubmitErrors: () => [] },
    FlowTiles: {
      nativeFlowCorrelationMap: () => correlation,
      nativeFlowCorrelationReceipt: () => receipt,
      collectNativeMedia: () => mediaScript(scans++),
      emitFlowProgress: async (command, message, extra) => { progressEvents.push({ message, extra }); },
      disarmNativeFlowCorrelation: () => {},
      retryIdentity: item => item.id,
      retryNativeErrorTile: async () => false,
      releaseSubmitOnlyCorrelation: () => null,
    },
  });
  context.__advanceClock = ms => { now += Math.max(0, Number(ms) || 0); };
  vm.runInContext(domUtilsSource, context);
  vm.runInContext(operationsSource, context);
  // Deterministic clock: every wait advances fake time so poll intervals
  // elapse between iterations without real delays.
  vm.runInContext('globalThis.wait = ms => { globalThis.__advanceClock(ms); return Promise.resolve(); };', context);
  const driver = {
    error: (code, message, retryable, outcome_unknown) => Object.assign(new Error(message), { code, retryable, outcome_unknown }),
  };
  const operations = new context.FlowGenerationOperations(driver);
  const execute = (name, payload = {}, command = {}) => operations.execute(name, payload, command);
  const observe = (payload = {}) => execute('flow.generation.observe', {
    before: [], kind: 'video', expectedCount: 1, timeoutMs: 600_000, correlationAttemptId: attemptId, ...payload,
  });
  return { execute, observe, progressEvents, elapsed: () => now - startAt, scanCount: () => scans, startAt };
}

// ---------------------------------------------------------------------------
// Content observe: the deadline is anchored at dispatchedAt.
// ---------------------------------------------------------------------------

test('observe: a checkpoint dispatched 8 min ago with a 10 min budget times out after only the remaining ~2 min', async () => {
  const startAt = 1_000_000;
  const { observe, elapsed } = operationsHarness({ startAt });
  // Before VID-02 observe ignored the dispatch time and granted a fresh
  // full 10 min window, so this rejection arrived at elapsed 600_000.
  await assert.rejects(
    observe({ dispatchedAt: startAt - 480_000, timeoutMs: 600_000 }),
    error => {
      assert.equal(error.code, 'FLOW_GENERATION_TIMEOUT');
      assert.equal(error.retryable, false);
      assert.equal(error.outcome_unknown, true);
      return true;
    },
  );
  assert.ok(elapsed() >= 100_000 && elapsed() <= 140_000, `timeout must fire at the anchored deadline (~120s remaining), elapsed=${elapsed()}`);
});

test('observe: a checkpoint whose anchored deadline already passed times out immediately', async () => {
  const startAt = 1_000_000;
  const { observe, elapsed, scanCount } = operationsHarness({ startAt });
  await assert.rejects(
    observe({ dispatchedAt: startAt - 660_000, timeoutMs: 600_000 }),
    error => {
      assert.equal(error.code, 'FLOW_GENERATION_TIMEOUT');
      assert.equal(error.outcome_unknown, true);
      return true;
    },
  );
  assert.equal(elapsed(), 0, 'no fresh window may be granted once the anchored deadline has passed');
  assert.equal(scanCount(), 0, 'observe must not poll at all when the anchored deadline already passed');
});

test('observe: a fresh dispatch keeps the full budget', async () => {
  const startAt = 1_000_000;
  const { observe, elapsed } = operationsHarness({ startAt });
  await assert.rejects(
    observe({ dispatchedAt: startAt, timeoutMs: 600_000 }),
    error => error.code === 'FLOW_GENERATION_TIMEOUT',
  );
  assert.ok(elapsed() >= 590_000 && elapsed() <= 610_000, `a fresh dispatch must observe for the full window, elapsed=${elapsed()}`);
});

test('observe: a legacy payload without dispatchedAt keeps the historical fresh-window behavior', async () => {
  const { observe, elapsed } = operationsHarness({});
  await assert.rejects(
    observe({ timeoutMs: 30_000 }),
    error => error.code === 'FLOW_GENERATION_TIMEOUT',
  );
  assert.ok(elapsed() >= 25_000 && elapsed() <= 35_000, `legacy observe must run the full window from entry, elapsed=${elapsed()}`);
});

test('observe: an invalid dispatchedAt falls back to the legacy fresh window', async () => {
  const { observe, elapsed } = operationsHarness({});
  await assert.rejects(
    observe({ dispatchedAt: 'not-a-timestamp', timeoutMs: 30_000 }),
    error => error.code === 'FLOW_GENERATION_TIMEOUT',
  );
  assert.ok(elapsed() >= 25_000 && elapsed() <= 35_000, `an unusable stamp must not shorten or extend the window, elapsed=${elapsed()}`);
});

test('observe: a partial result reached before the anchored deadline still resolves partial (VID-01 interplay)', async () => {
  const startAt = 1_000_000;
  const { observe, elapsed } = operationsHarness({
    startAt,
    mediaScript: () => [READY_TILE, FAILED_TILE],
    receipt: RECEIPT_BOTH,
  });
  const result = await observe({
    kind: 'image', expectedCount: 2, retries: 0,
    dispatchedAt: startAt - 480_000, timeoutMs: 600_000,
  });
  assert.equal(result.partial, true);
  assert.equal(result.media.length, 1);
  assert.deepEqual(plain(result.failedOutputs), [{ title: 'scene-02', code: 'FLOW_GENERATION_FAILED' }]);
  assert.ok(elapsed() < 120_000, 'the anchored deadline only changes when timeout fires, not what counts as terminal');
});

// ---------------------------------------------------------------------------
// Submit acknowledgement: dispatchedAt is stamped once, at acknowledgement,
// into the generationObservation progress payload the queue persists.
// ---------------------------------------------------------------------------

test('manual.confirm: the recovery checkpoint payload is stamped with dispatchedAt at acknowledgement', async () => {
  const startAt = 1_000_000;
  const { execute, progressEvents } = operationsHarness({ startAt });
  const result = await execute('flow.generation.manual.confirm', {
    attemptId: 'attempt-1',
    prepared: { before: [], type: 'video', expectedCount: 2, credits: 12, submitOnly: false },
  });
  assert.equal(result.submitted, true);
  const checkpointEvent = progressEvents.find(event => event.extra?.generationObservation);
  assert.ok(checkpointEvent, 'manual confirm must emit the observation checkpoint payload');
  assert.equal(checkpointEvent.extra.generationObservation.dispatchedAt, startAt);
  assert.equal(result.dispatchedAt, startAt);
});

test('submit: the acknowledgement branch stamps dispatchedAt into the checkpoint payload and the result', () => {
  const branch = operationsSource.slice(
    operationsSource.indexOf('const dispatchReceipt = payload.submitOnly'),
    operationsSource.indexOf('if (name === "flow.generation.observe")'),
  );
  assert.ok(branch.length > 0, 'the submit acknowledgement branch must exist');
  assert.match(branch, /generationObservation: \{[^}]*dispatchedAt/);
  assert.match(branch, /return \{[^}]*dispatchedAt/);
});

// ---------------------------------------------------------------------------
// Queue: the checkpoint persists the stamp; the first stamp wins.
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

test('queue: checkpointGenerationObservation persists dispatchedAt and the first stamp wins', async () => {
  const D1 = 1_700_000_000_000;
  const stamps = [];
  const queue = makeQueue(async job => {
    const base = { correlationAttemptId: 'attempt-1', kind: 'video', expectedCount: 1, timeoutMs: 600_000 };
    // A checkpoint carrying an invalid stamp must not fabricate one.
    stamps.push((await queue.checkpointGenerationObservation(job.id, { ...base, dispatchedAt: Number.NaN }))?.metadata?.generationObservation?.dispatchedAt);
    // The runner's own checkpoint carries no stamp (legacy shape).
    stamps.push((await queue.checkpointGenerationObservation(job.id, base))?.metadata?.generationObservation?.dispatchedAt);
    // The content progress checkpoint carries the acknowledgement stamp.
    const stamped = await queue.checkpointGenerationObservation(job.id, { ...base, dispatchedAt: D1 });
    stamps.push(stamped?.metadata?.generationObservation?.dispatchedAt);
    assert.equal(stamped?.metadata?.generationObservation?.timeoutMs, 600_000);
    // Later checkpoints — with a different stamp or none — never re-stamp.
    stamps.push((await queue.checkpointGenerationObservation(job.id, { ...base, dispatchedAt: D1 + 60_000 }))?.metadata?.generationObservation?.dispatchedAt);
    stamps.push((await queue.checkpointGenerationObservation(job.id, { ...base, dispatchedAt: 'not-a-timestamp' }))?.metadata?.generationObservation?.dispatchedAt);
    stamps.push((await queue.checkpointGenerationObservation(job.id, base))?.metadata?.generationObservation?.dispatchedAt);
    return { completed: true, requestDispatched: true, result: { submitted: true } };
  });
  const { job } = await runJob(queue, {
    operation: 'flow.generation.submit',
    payload: { prompt: 'a scene', type: 'video' },
    label: 'a scene',
  });
  assert.equal(job.status, 'completed');
  assert.deepEqual(stamps, [undefined, undefined, D1, D1, D1, D1]);
});

// ---------------------------------------------------------------------------
// Restart: restore + observe resumes with the remaining budget.
// ---------------------------------------------------------------------------

function seededObservationStorage(observation) {
  const storage = memoryStorage();
  storage.backing.flowMcpJobQueueV1 = {
    version: 1,
    paused: false,
    attention: null,
    running: true,
    stopped: false,
    stopRequested: false,
    currentJobId: 'job-observation',
    jobs: [{
      id: 'job-observation',
      type: 'flow',
      operation: 'flow.generation.submit',
      payload: { prompt: 'a scene', type: 'video' },
      label: 'a scene',
      status: 'running',
      outcomeUnknown: false,
      attempts: 1,
      autoRetryCount: 0,
      metadata: { generationObservation: observation },
    }],
  };
  return storage;
}

test('queue: a restart restores the observation checkpoint with its original dispatchedAt, and observe resumes with the remaining budget', async () => {
  const T = 1_700_000_000_000;
  const dispatchedAt = T - 480_000;
  const storage = seededObservationStorage({
    correlationAttemptId: 'attempt-1',
    before: [],
    kind: 'video',
    expectedCount: 1,
    timeoutMs: 600_000,
    dispatchedAt,
    recordedAt: dispatchedAt,
  });
  const queue = makeQueue(async () => { throw new Error('the runner must not run during restore assertions'); }, storage);
  const restored = await queue.get('job-observation');
  assert.equal(restored.status, 'pending');
  assert.equal(restored.progress.phase, 'recovering_generation_observation');
  // Restore must never re-stamp: the persisted dispatch time survives intact.
  assert.equal(restored.metadata.generationObservation.dispatchedAt, dispatchedAt);
  assert.equal(restored.metadata.generationObservation.timeoutMs, 600_000);

  // Observe resumed from the restored checkpoint at time T sees only the
  // remaining ~2 min of the original 10 min render window.
  const checkpoint = restored.metadata.generationObservation;
  const { observe, elapsed } = operationsHarness({ startAt: T });
  await assert.rejects(
    observe({
      before: checkpoint.before,
      kind: checkpoint.kind,
      expectedCount: checkpoint.expectedCount,
      timeoutMs: checkpoint.timeoutMs,
      dispatchedAt: checkpoint.dispatchedAt,
    }),
    error => error.code === 'FLOW_GENERATION_TIMEOUT',
  );
  assert.ok(elapsed() >= 100_000 && elapsed() <= 140_000, `resumed observe must stop at the anchored deadline, elapsed=${elapsed()}`);
});

test('queue: a legacy observation checkpoint without dispatchedAt restores unchanged and observes with the full window', async () => {
  const storage = seededObservationStorage({
    correlationAttemptId: 'attempt-1',
    before: [],
    kind: 'video',
    expectedCount: 1,
    timeoutMs: 600_000,
    recordedAt: 1_700_000_000_000,
  });
  const queue = makeQueue(async () => { throw new Error('the runner must not run during restore assertions'); }, storage);
  const restored = await queue.get('job-observation');
  assert.equal(restored.status, 'pending');
  assert.equal(restored.metadata.generationObservation.dispatchedAt, undefined, 'restore must not fabricate a dispatch stamp for legacy checkpoints');

  const checkpoint = restored.metadata.generationObservation;
  const { observe, elapsed } = operationsHarness({ startAt: 1_700_000_000_000 });
  await assert.rejects(
    observe({
      before: checkpoint.before,
      kind: checkpoint.kind,
      expectedCount: checkpoint.expectedCount,
      timeoutMs: checkpoint.timeoutMs,
      dispatchedAt: checkpoint.dispatchedAt,
    }),
    error => error.code === 'FLOW_GENERATION_TIMEOUT',
  );
  assert.ok(elapsed() >= 590_000 && elapsed() <= 610_000, `legacy checkpoints keep the fresh full window, elapsed=${elapsed()}`);
});
