import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

import { FlowJobQueue } from '../extension/src/background/flow-job-queue.js';
import { generatedMediaForQueueJob } from '../extension/src/background/flow-queue-downloads.js';

const domUtilsSource = readFileSync(new URL('../extension/src/content/shared/dom-utils.js', import.meta.url), 'utf8');
const operationsSource = readFileSync(new URL('../extension/src/content/providers/flow/generation/generation-operations.js', import.meta.url), 'utf8');

// ---------------------------------------------------------------------------
// VID-01: partial-success outcome in observe.
//
// When a multi-output generation ends with some outputs ready and some
// terminally failed, observe must resolve with the ready media plus a
// structured failedOutputs list instead of throwing everything away, and
// the queue must record a partial state (successes stay downloadable, the
// failure is surfaced, the job is NOT marked wholly failed). All-failed
// behavior is unchanged.
// ---------------------------------------------------------------------------

// Objects produced inside the vm realm carry that realm's prototypes, so
// deepStrictEqual against test-realm literals needs a plain round-trip.
const plain = value => JSON.parse(JSON.stringify(value));

const READY_TILE = { id: 'media-1', title: 'scene-01', kind: 'image', mediaReady: true, busy: false, failed: false };
const FAILED_TILE = { id: 'media-2', title: 'scene-02', kind: 'image', mediaReady: false, busy: false, failed: true, failureReason: 'Generation failed' };
const RECEIPT_BOTH = { mediaIds: ['media-1', 'media-2'], children: [] };

function observeHarness({ mediaScript, receipt = RECEIPT_BOTH, retries, retryOutcome = false }) {
  const attemptId = 'attempt-1';
  const correlation = new Map([[attemptId, {
    attemptId, receipts: [], requestSeen: true, interfered: false, projectId: 'project-1', mediaType: 'image',
  }]]);
  let now = 1_000_000;
  let scans = 0;
  let retryCalls = 0;
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
      retryNativeErrorTile: async () => { retryCalls++; return retryOutcome; },
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
  return { observe, progressEvents, scanCount: () => scans, retryCalls: () => retryCalls };
}

test('observe: one ready + one terminally failed output resolves partial with the ready media and failedOutputs', async () => {
  const { observe, progressEvents } = observeHarness({
    mediaScript: () => [READY_TILE, FAILED_TILE],
    retries: 0,
  });
  // Before VID-01 the terminally failed tile made observe throw
  // FLOW_GENERATION_FAILED and the ready output was discarded.
  const result = await observe({ retries: 0 });
  assert.equal(result.partial, true);
  assert.equal(result.media.length, 1);
  assert.deepEqual(plain(result.media[0]), { id: 'media-1', title: 'scene-01', kind: 'image' });
  assert.deepEqual(plain(result.failedOutputs), [{ title: 'scene-02', code: 'FLOW_GENERATION_FAILED' }]);
  // The result checkpoint emitted to the queue carries only the success.
  const checkpointEvent = progressEvents.find(event => event.extra?.generationResult);
  assert.ok(checkpointEvent, 'a generationResult progress event must be emitted for the partial media');
  assert.deepEqual(plain(checkpointEvent.extra.generationResult.media), [{ id: 'media-1', title: 'scene-01', kind: 'image' }]);
});

test('observe: a classified non-retryable failure with a ready sibling resolves partial with the classified code', async () => {
  const policyTile = { ...FAILED_TILE, failureReason: 'Content blocked by safety guidelines (policy violation)' };
  const { observe } = observeHarness({ mediaScript: () => [READY_TILE, policyTile] });
  // Before VID-01 the classified throw fired even though scene-01 rendered.
  const result = await observe();
  assert.equal(result.partial, true);
  assert.equal(result.media.length, 1);
  assert.deepEqual(plain(result.failedOutputs), [{ title: 'scene-02', code: 'FLOW_POLICY_VIOLATION' }]);
});

test('observe: a failed tile whose in-place retry fails still resolves partial when a sibling is ready', async () => {
  const { observe, retryCalls } = observeHarness({
    mediaScript: () => [READY_TILE, FAILED_TILE],
    retryOutcome: false,
  });
  const result = await observe({ retries: 1 });
  assert.equal(retryCalls(), 1, 'the bounded in-place retry runs before the terminal judgment');
  assert.equal(result.partial, true);
  assert.equal(result.media.length, 1);
  assert.deepEqual(plain(result.failedOutputs), [{ title: 'scene-02', code: 'FLOW_GENERATION_FAILED' }]);
});

test('observe: a still-processing sibling defers the terminal judgment until it settles', async () => {
  const busyTile = { ...READY_TILE, mediaReady: false, busy: true };
  const { observe, scanCount } = observeHarness({
    mediaScript: scan => (scan === 0 ? [busyTile, FAILED_TILE] : [READY_TILE, FAILED_TILE]),
    retries: 0,
  });
  // Before VID-01 the first poll threw FLOW_GENERATION_FAILED while
  // scene-01 was still rendering; its completed render was thrown away.
  const result = await observe({ retries: 0 });
  assert.ok(scanCount() >= 2, 'observe must keep polling while a sibling is still processing');
  assert.equal(result.partial, true);
  assert.equal(result.media.length, 1);
  assert.equal(result.media[0].id, 'media-1');
  assert.deepEqual(plain(result.failedOutputs), [{ title: 'scene-02', code: 'FLOW_GENERATION_FAILED' }]);
});

test('observe: all outputs failed still rejects with the classified failure (unchanged)', async () => {
  const secondFailure = { ...FAILED_TILE, id: 'media-1', title: 'scene-01' };
  const { observe } = observeHarness({
    mediaScript: () => [secondFailure, FAILED_TILE],
    retries: 0,
  });
  await assert.rejects(observe({ retries: 0 }), error => {
    assert.equal(error.code, 'FLOW_GENERATION_FAILED');
    assert.equal(error.outcome_unknown, false);
    return true;
  });
});

test('observe: a single failed output rejects exactly as before (no partial for single-output jobs)', async () => {
  const { observe } = observeHarness({
    mediaScript: () => [FAILED_TILE],
    receipt: { mediaIds: ['media-2'], children: [] },
    retries: 0,
  });
  await assert.rejects(observe({ expectedCount: 1, retries: 0 }), error => {
    assert.equal(error.code, 'FLOW_GENERATION_FAILED');
    assert.equal(error.outcome_unknown, false);
    return true;
  });
});

test('observe: a rate-limit tile failure still throws retryable even with a ready sibling (unchanged)', async () => {
  const rateLimitedTile = { ...FAILED_TILE, failureReason: 'RATE_LIMIT: too many requests, try again in a few moments' };
  const { observe } = observeHarness({ mediaScript: () => [READY_TILE, rateLimitedTile] });
  await assert.rejects(observe(), error => {
    assert.equal(error.code, 'FLOW_RATE_LIMIT');
    assert.equal(error.retryable, true);
    return true;
  });
});

// ---------------------------------------------------------------------------
// Queue-level: partial state recording, checkpointing, restart recovery.
// ---------------------------------------------------------------------------

const SUCCESS_MEDIA = [{ id: 'media-1', title: 'scene-01', kind: 'image' }];
const FAILED_OUTPUTS = [{ title: 'scene-02', code: 'FLOW_GENERATION_FAILED' }];

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

test('queue: a partial generation result completes the job as partial — not failed — with successes downloadable', async () => {
  const queue = makeQueue(async () => ({
    completed: true,
    requestDispatched: true,
    result: { media: SUCCESS_MEDIA, failedOutputs: FAILED_OUTPUTS, partial: true },
  }));
  const { job, snapshot } = await runJob(queue, {
    operation: 'flow.generation.submit',
    payload: { prompt: 'two scenes', variants: 2 },
    label: 'two scenes',
  });
  assert.equal(job.status, 'completed');
  assert.equal(job.partial, true);
  assert.deepEqual(job.failedOutputs, FAILED_OUTPUTS);
  assert.equal(job.error, undefined);
  assert.equal(snapshot.completed, 1);
  assert.equal(snapshot.failed, 0);
  // The result keeps the ready media plus the failure record at both levels.
  assert.deepEqual(job.result.result.media, SUCCESS_MEDIA);
  assert.deepEqual(job.result.failedOutputs, FAILED_OUTPUTS);
  // The existing queue-download path reads exactly the successful media.
  assert.deepEqual(generatedMediaForQueueJob(job), SUCCESS_MEDIA);
});

test('queue: a full-success result records no partial state (unchanged)', async () => {
  const queue = makeQueue(async () => ({
    completed: true,
    requestDispatched: true,
    result: { media: SUCCESS_MEDIA },
  }));
  const { job } = await runJob(queue, {
    operation: 'flow.generation.submit',
    payload: { prompt: 'one scene' },
    label: 'one scene',
  });
  assert.equal(job.status, 'completed');
  assert.equal(job.partial, undefined);
  assert.equal(job.failedOutputs, undefined);
});

test('queue: an all-failed generation still fails the job (unchanged)', async () => {
  const queue = makeQueue(async () => {
    throw Object.assign(new Error('Flow báo cáo 2 tile render thất bại'), { code: 'FLOW_GENERATION_FAILED', retryable: false, outcomeUnknown: false });
  });
  const { job } = await runJob(queue, {
    operation: 'flow.generation.submit',
    payload: { prompt: 'two scenes', variants: 2 },
    label: 'two scenes',
  });
  assert.equal(job.status, 'failed');
  assert.equal(job.errorCode, 'FLOW_GENERATION_FAILED');
  assert.equal(job.partial, undefined);
});

test('queue: checkpointGenerationResult persists failedOutputs alongside the successful media', async () => {
  let capturedId = null;
  const queue = makeQueue(async job => {
    capturedId = job.id;
    await queue.checkpointGenerationResult(job.id, SUCCESS_MEDIA, { failedOutputs: FAILED_OUTPUTS });
    return { completed: true, requestDispatched: true, result: { media: SUCCESS_MEDIA, failedOutputs: FAILED_OUTPUTS, partial: true } };
  });
  const { job } = await runJob(queue, {
    operation: 'flow.generation.submit',
    payload: { prompt: 'two scenes', variants: 2 },
    label: 'two scenes',
  });
  assert.equal(job.id, capturedId);
  const checkpoint = job.metadata?.generationResultCheckpoint;
  assert.ok(checkpoint, 'the result checkpoint must be persisted');
  assert.deepEqual(checkpoint.media, SUCCESS_MEDIA);
  assert.deepEqual(checkpoint.failedOutputs, FAILED_OUTPUTS);
});

test('queue: a worker restart recovers a partial checkpoint without claiming the failed output', async () => {
  const storage = memoryStorage();
  storage.backing.flowMcpJobQueueV1 = {
    version: 1,
    paused: false,
    attention: null,
    running: true,
    stopped: false,
    stopRequested: false,
    currentJobId: 'job-partial',
    jobs: [{
      id: 'job-partial',
      type: 'flow',
      operation: 'flow.generation.submit',
      payload: { prompt: 'two scenes', variants: 2 },
      label: 'two scenes',
      status: 'running',
      outcomeUnknown: false,
      attempts: 1,
      autoRetryCount: 0,
      metadata: {
        generationResultCheckpoint: {
          media: SUCCESS_MEDIA,
          failedOutputs: FAILED_OUTPUTS,
          quoteFields: {},
          recordedAt: Date.now(),
        },
      },
    }],
  };
  // The rebuilt runner result after a restart is assembled from the
  // checkpoint media alone and no longer carries failedOutputs.
  const queue = makeQueue(async () => ({
    completed: true,
    requestDispatched: true,
    result: { media: SUCCESS_MEDIA, recoveredAfterWorkerRestart: true },
  }), storage);
  const restored = await queue.get('job-partial');
  assert.equal(restored.status, 'pending');
  assert.equal(restored.partial, true);
  assert.deepEqual(restored.failedOutputs, FAILED_OUTPUTS);
  // The checkpoint itself only ever claimed the one observed success.
  assert.deepEqual(restored.metadata.generationResultCheckpoint.media, SUCCESS_MEDIA);

  await queue.start();
  const { job } = await queue.wait('job-partial', 5_000);
  assert.equal(job.status, 'completed');
  assert.equal(job.partial, true);
  assert.deepEqual(job.failedOutputs, FAILED_OUTPUTS);
  assert.deepEqual(generatedMediaForQueueJob(job), SUCCESS_MEDIA);
});
