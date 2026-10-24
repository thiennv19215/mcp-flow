import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

import { FlowJobQueue } from '../extension/src/background/flow-job-queue.js';

const serviceWorkerSource = readFileSync(new URL('../extension/src/background/service-worker.js', import.meta.url), 'utf8');

// ---------------------------------------------------------------------------
// SW-FWD (wiring debt from VID-01 + VID-02): the queue layer already
// persists two checkpoint fields, but the service-worker runner dropped
// both when re-issuing work:
//
// 1. VID-01 — checkpointGenerationResult(id, media, extras) accepts
//    failedOutputs and #restore carries job.partial/job.failedOutputs, but
//    the runner called it with only (job.id, observed.media), so a worker
//    death between observe-partial and runner return lost the failed half
//    of the checkpoint.
// 2. VID-02 — the observation checkpoint persists dispatchedAt
//    (first-stamp-wins) and observe honors a caller-supplied dispatchedAt,
//    but the runner rebuilt the observe payload from the restored
//    checkpoint without it, so the anchored deadline only applied when
//    the original worker survived.
//
// This suite follows the existing service-worker test patterns: the real
// runExtensionFlowJob is extracted from the worker source and run in a vm
// sandbox (the flow-ref-preflight-sw-wiring pattern) against the REAL
// FlowJobQueue, with the page-side `execute` relay stubbed. Controls pin
// that jobs without the fields produce calls identical to before.
// ---------------------------------------------------------------------------

// Objects produced inside the vm realm carry that realm's prototypes, so
// deepStrictEqual against test-realm literals needs a plain round-trip
// (the same convention as the VID-01/VID-02 suites). The round-trip drops
// undefined-valued keys, so payload expectations below omit `retries`
// (the stubbed payloads carry no retries) — key-presence assertions that
// matter (dispatchedAt) are made on the raw captured payload instead.
const plain = value => JSON.parse(JSON.stringify(value));

const PROJECT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const PROJECT_URL = `https://flow.google.com/project/${PROJECT_ID}`;
const TAB_ID = 7;

const SUCCESS_MEDIA = [{ id: 'media-1', title: 'scene-01', kind: 'image' }];
const FAILED_OUTPUTS = [
  { title: 'scene-02', code: 'FLOW_GENERATION_FAILED' },
  { title: 'scene-03', code: 'FLOW_POLICY_VIOLATION' },
];

function memoryStorage(backing = {}) {
  return {
    backing,
    async get(key) { return { [key]: backing[key] }; },
    async set(entries) { Object.assign(backing, entries); },
    async remove(key) { delete backing[key]; },
  };
}

// Extract the runner by its surrounding markers: brace matching is not
// safe here (the runner body contains regex literals and template
// strings), but it is the last function before the flowMediaCatalog
// singleton the worker constructs from it.
function extractRunnerSource(source) {
  const start = source.indexOf('async function runExtensionFlowJob(job, hooks) {');
  assert.ok(start >= 0, 'service-worker.js must define runExtensionFlowJob');
  const end = source.indexOf('\nconst flowMediaCatalog = new FlowMediaCatalog();', start);
  assert.ok(end > start, 'the runner must precede the flowMediaCatalog singleton');
  return source.slice(start, end);
}

// Build a real FlowJobQueue whose runner is the worker's own
// runExtensionFlowJob, loaded into a vm sandbox. The sandbox supplies the
// worker-scope helpers the runner closes over; `execute` (the page relay)
// is the test's scripted Flow page, and checkpoint calls on the real queue
// are spied so the exact worker→queue call shape can be asserted.
function loadWorkerRunner({ onExecute, storage = memoryStorage() }) {
  const executeCalls = [];
  const checkpointResultCalls = [];
  let queue;
  const sandbox = {
    console,
    structuredClone,
    crypto,
    setTimeout,
    clearTimeout,
    resolveProviderForOperation: () => ({}),
    extensionQueueJobOperations: new Set([
      'flow.generation.submit', 'flow.edit.run', 'flow.continue.run', 'flow.agent.batch',
      'flow.character.create', 'flow.character.edit',
    ]),
    GENERATED_MEDIA_DOWNLOAD_OPERATION: 'flow.queue.download-generated',
    selectedTabId: TAB_ID,
    chooseTab: async () => ({ id: TAB_ID, url: PROJECT_URL }),
    chrome: {
      tabs: {
        get: async tabId => ({ id: tabId, url: PROJECT_URL }),
      },
    },
    flowUrl: value => {
      try { return new URL(value).hostname === 'flow.google.com'; } catch { return false; }
    },
    flowProjectIdFromUrl: value => {
      try { return new URL(value).pathname.match(/\/project\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i)?.[1]?.toLowerCase() || null; }
      catch { return null; }
    },
    tabOperationActive: () => false,
    waitForFlowProjectReady: async () => {},
    withQueueDownloads: async (_job, _payload, result) => result,
    queueCompletionProgress: (_result, message) => ({ phase: 'completed', message }),
    downloadGeneratedQueueJob: async () => { throw new Error('download jobs are not exercised by this suite'); },
    execute: async (_ws, _method, args = []) => {
      const command = args[0] || {};
      executeCalls.push({ name: command.name, payload: command.payload });
      return onExecute(command.name, command.payload);
    },
    flowJobQueue: null, // wired to the real queue below, before any job runs
  };
  queue = new FlowJobQueue(async (job, hooks) => sandbox.__runner(job, hooks), {
    storage, minDelayMs: 0, maxDelayMs: 0,
  });
  const realCheckpoint = queue.checkpointGenerationResult.bind(queue);
  queue.checkpointGenerationResult = async (...args) => {
    checkpointResultCalls.push(args);
    return realCheckpoint(...args);
  };
  sandbox.flowJobQueue = queue;
  vm.runInNewContext(
    `${extractRunnerSource(serviceWorkerSource)}\nthis.__runner = runExtensionFlowJob;`,
    sandbox,
  );
  assert.equal(typeof sandbox.__runner, 'function', 'the extracted runner must load in the sandbox');
  return { queue, executeCalls, checkpointResultCalls };
}

async function runJob(queue, input) {
  const added = await queue.add(input);
  await queue.start();
  return queue.wait(added.id, 5_000);
}

const pinnedMetadata = { flowTabId: TAB_ID, flowProjectId: PROJECT_ID };

// ---------------------------------------------------------------------------
// VID-01: failedOutputs forwarding into the result checkpoint.
// ---------------------------------------------------------------------------

test('SW-FWD wiring: the runner forwards observed.failedOutputs as the checkpoint extras argument', () => {
  const callStart = serviceWorkerSource.indexOf('await flowJobQueue.checkpointGenerationResult(job.id, observed.media');
  assert.ok(callStart >= 0, 'the runner checkpoints the observed result on the queue');
  const call = serviceWorkerSource.slice(callStart, serviceWorkerSource.indexOf('.catch(', callStart));
  assert.match(call, /observed\.failedOutputs/, 'the checkpoint call forwards the observe result\'s failedOutputs');
  assert.match(call, /failedOutputs: observed\.failedOutputs/, 'the extras carry the failedOutputs in the VID-01 checkpoint shape');
});

test('SW-FWD: a partial observe result reaching the worker checkpoint call carries its failedOutputs into the queue checkpoint', async () => {
  const { queue, executeCalls, checkpointResultCalls } = loadWorkerRunner({
    onExecute: name => {
      if (name === 'flow.generation.submit') {
        return { submitted: true, before: [], type: 'image', expectedCount: 3, correlationAttemptId: 'attempt-1' };
      }
      if (name === 'flow.generation.observe') {
        return { partial: true, media: SUCCESS_MEDIA, failedOutputs: FAILED_OUTPUTS };
      }
      throw new Error(`Unexpected page operation: ${name}`);
    },
  });
  const { job } = await runJob(queue, {
    operation: 'flow.generation.submit',
    payload: { prompt: 'three scenes', type: 'image', variants: 3 },
    label: 'three scenes',
    metadata: { ...pinnedMetadata },
  });
  assert.equal(job.status, 'completed');
  assert.deepEqual(executeCalls.map(call => call.name), ['flow.generation.submit', 'flow.generation.observe']);

  // The worker→queue call itself: media plus the failed half, passed
  // through exactly as observe produced it (no re-normalization here —
  // the queue's checkpoint owns normalization).
  assert.equal(checkpointResultCalls.length, 1, 'the runner checkpoints the generation result exactly once');
  const [checkpointId, checkpointMedia, checkpointExtras] = checkpointResultCalls[0];
  assert.equal(checkpointResultCalls[0].length, 3, 'a partial result adds the extras argument to the checkpoint call');
  assert.equal(checkpointId, job.id);
  assert.deepEqual(checkpointMedia, SUCCESS_MEDIA);
  assert.deepEqual(plain(checkpointExtras), { failedOutputs: FAILED_OUTPUTS });
  assert.strictEqual(checkpointExtras.failedOutputs, FAILED_OUTPUTS, 'the worker passes the observe list through untouched');

  // And the persisted checkpoint — the state a worker restart recovers
  // from — now carries the failed half alongside the successful media.
  const checkpoint = job.metadata?.generationResultCheckpoint;
  assert.ok(checkpoint, 'the result checkpoint must be persisted');
  assert.deepEqual(checkpoint.media, SUCCESS_MEDIA);
  assert.deepEqual(checkpoint.failedOutputs, FAILED_OUTPUTS);
  assert.equal(job.partial, true);
  assert.deepEqual(job.failedOutputs, FAILED_OUTPUTS);
});

test('SW-FWD control: a full-success observe result checkpoints exactly as before (no extras, no partial state)', async () => {
  const { queue, checkpointResultCalls } = loadWorkerRunner({
    onExecute: name => {
      if (name === 'flow.generation.submit') {
        return { submitted: true, before: [], type: 'image', expectedCount: 1, correlationAttemptId: 'attempt-1' };
      }
      if (name === 'flow.generation.observe') {
        return { media: SUCCESS_MEDIA };
      }
      throw new Error(`Unexpected page operation: ${name}`);
    },
  });
  const { job } = await runJob(queue, {
    operation: 'flow.generation.submit',
    payload: { prompt: 'one scene', type: 'image' },
    label: 'one scene',
    metadata: { ...pinnedMetadata },
  });
  assert.equal(job.status, 'completed');
  assert.equal(checkpointResultCalls.length, 1);
  assert.equal(checkpointResultCalls[0].length, 2, 'without failedOutputs the checkpoint call keeps its historical two-argument shape');
  assert.deepEqual(checkpointResultCalls[0][1], SUCCESS_MEDIA);
  const checkpoint = job.metadata?.generationResultCheckpoint;
  assert.ok(checkpoint, 'the result checkpoint must be persisted');
  assert.deepEqual(checkpoint.media, SUCCESS_MEDIA);
  assert.equal(Object.hasOwn(checkpoint, 'failedOutputs'), false, 'a full success records no failedOutputs in the checkpoint');
  assert.equal(job.partial, undefined);
  assert.equal(job.failedOutputs, undefined);
});

// ---------------------------------------------------------------------------
// VID-02: dispatchedAt forwarding into the re-issued observe payload.
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
      metadata: {
        ...pinnedMetadata,
        generationObservation: observation,
      },
    }],
  };
  return storage;
}

const VIDEO_MEDIA = [{ id: 'media-v1', title: 'scene-v1', kind: 'video' }];

function videoObserveHarness(observation) {
  return loadWorkerRunner({
    storage: seededObservationStorage(observation),
    onExecute: name => {
      if (name === 'flow.generation.observe') return { media: VIDEO_MEDIA };
      throw new Error(`Unexpected page operation: ${name}`);
    },
  });
}

test('SW-FWD wiring: the re-issued observe payload is built with the restored checkpoint\'s dispatchedAt', () => {
  const observeStart = serviceWorkerSource.indexOf('observed = await invoke("flow.generation.observe", {');
  assert.ok(observeStart >= 0, 'the runner re-issues flow.generation.observe');
  const observePayload = serviceWorkerSource.slice(observeStart, serviceWorkerSource.indexOf('});', observeStart));
  assert.match(observePayload, /dispatchedAt/, 'the observe command payload forwards a dispatchedAt');
  const savedStart = serviceWorkerSource.indexOf('const savedObservation = job.metadata?.generationObservation;');
  assert.ok(savedStart >= 0, 'the runner restores the saved observation checkpoint');
  const savedBranch = serviceWorkerSource.slice(savedStart, serviceWorkerSource.indexOf('} else if', savedStart));
  assert.match(savedBranch, /dispatchedAt: savedObservation\.dispatchedAt/,
    'the restored checkpoint\'s stamp is carried into the rebuilt submission receipt');
});

test('SW-FWD: a restored job with dispatchedAt in its checkpoint gets that exact value in the re-issued observe command payload', async () => {
  const dispatchedAt = 1_700_000_000_000 - 480_000;
  const { queue, executeCalls } = videoObserveHarness({
    correlationAttemptId: 'attempt-1',
    before: [],
    kind: 'video',
    expectedCount: 1,
    timeoutMs: 600_000,
    credits: 12,
    dispatchedAt,
    recordedAt: dispatchedAt,
  });
  const restored = await queue.get('job-observation');
  assert.equal(restored.status, 'pending', 'the interrupted job restores to pending');
  assert.equal(restored.metadata.generationObservation.dispatchedAt, dispatchedAt);

  await queue.start();
  const { job } = await queue.wait('job-observation', 5_000);
  assert.equal(job.status, 'completed');

  // No re-submit happened — the runner resumed from the checkpoint — and
  // the single observe command carries the ORIGINAL dispatch stamp, so
  // the content side anchors its deadline at dispatch, not at restart.
  assert.deepEqual(executeCalls.map(call => call.name), ['flow.generation.observe']);
  assert.equal(executeCalls[0].payload.dispatchedAt, dispatchedAt, 'the exact restored stamp reaches the observe payload');
  assert.deepEqual(plain(executeCalls[0].payload), {
    before: [],
    expectedCount: 1,
    variants: 1,
    correlationAttemptId: 'attempt-1',
    kind: 'video',
    timeoutMs: 600_000,
    dispatchedAt,
  });
});

test('SW-FWD control: a restored legacy checkpoint without dispatchedAt re-issues observe exactly as before', async () => {
  const { queue, executeCalls } = videoObserveHarness({
    correlationAttemptId: 'attempt-1',
    before: [],
    kind: 'video',
    expectedCount: 1,
    timeoutMs: 600_000,
    credits: 12,
    recordedAt: 1_700_000_000_000,
  });
  const restored = await queue.get('job-observation');
  assert.equal(restored.status, 'pending');
  assert.equal(restored.metadata.generationObservation.dispatchedAt, undefined);

  await queue.start();
  const { job } = await queue.wait('job-observation', 5_000);
  assert.equal(job.status, 'completed');
  assert.deepEqual(executeCalls.map(call => call.name), ['flow.generation.observe']);
  assert.equal(Object.hasOwn(executeCalls[0].payload, 'dispatchedAt'), false,
    'a legacy checkpoint must not gain a fabricated dispatch stamp in the observe payload');
  assert.deepEqual(plain(executeCalls[0].payload), {
    before: [],
    expectedCount: 1,
    variants: 1,
    correlationAttemptId: 'attempt-1',
    kind: 'video',
    timeoutMs: 600_000,
  });
});
