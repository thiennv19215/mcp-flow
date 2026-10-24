import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

import { FlowJobQueue } from '../extension/src/background/flow-job-queue.js';

// Audit cluster C — queue consistency: one shared retry reset, add()
// rollback, cancel-before-submit must not pause as outcome-unknown,
// transform-lock admission on every enqueue path, and auto-retry
// progress must report the job's own budget.

function memoryStorage() {
  const data = {};
  return {
    async get(key) { return { [key]: data[key] }; },
    async set(entries) { Object.assign(data, entries); },
    async remove(key) { delete data[key]; },
  };
}

function makeQueue(runner, options = {}) {
  return new FlowJobQueue(runner, { storage: memoryStorage(), minDelayMs: 0, maxDelayMs: 0, ...options });
}

function untilSnapshot(queue, predicate, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = snapshot => {
      if (settled || !predicate(snapshot)) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(snapshot);
    };
    const unsubscribe = queue.subscribe(finish);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      unsubscribe();
      reject(new Error('Timed out waiting for the expected queue snapshot.'));
    }, timeoutMs);
  });
}

const retryableError = (diagnostics = undefined) => Object.assign(
  new Error('Transient picker failure.'),
  { code: 'FLOW_REFERENCE_SCAN_INCOMPLETE', retryable: true, ...(diagnostics ? { diagnostics } : {}) },
);

// Drive one job to failed (retrySafe) and return its internal record so
// the test can seed stale attempt fields the way a real dirty record
// would carry them.
async function failedJobWithSeededStaleFields(queue, seed) {
  const added = await queue.add({ operation: 'flow.generation.submit', payload: { prompt: 'scene' }, label: 'seeded scene' });
  await queue.start();
  await queue.wait(added.id, 5_000);
  const internal = queue.jobs.find(job => job.id === added.id);
  assert.equal(internal.status, 'failed');
  assert.equal(internal.retrySafe, true);
  Object.assign(internal, seed);
  if (seed.metadata) internal.metadata = { ...(internal.metadata || {}), ...seed.metadata };
  return internal;
}

function assertCleanPending(job) {
  assert.equal(job.status, 'pending');
  assert.equal(job.diagnostics, undefined);
  assert.equal(job.error, undefined);
  assert.equal(job.errorCode, undefined);
  assert.equal(job.finishedAt, undefined);
  assert.equal(job.retrySafe, false);
  assert.equal(job.autoRetryCount, 0);
  assert.equal(job.overlayRecheckCount, 0);
  assert.equal(job.progress, undefined);
  assert.equal(job.result, undefined);
  assert.equal(job.partial, undefined);
  assert.equal(job.failedOutputs, undefined);
  assert.equal(job.metadata?.generationObservation, undefined);
  assert.equal(job.metadata?.generationResultCheckpoint, undefined);
  assert.equal(job.metadata?.generationQuoteFields, undefined);
}

const staleSeed = () => ({
  diagnostics: { observerReady: false },
  partial: true,
  failedOutputs: [{ outputIndex: 0, reason: 'stale' }],
  autoRetryCount: 2,
  overlayRecheckCount: 1,
  metadata: {
    generationObservation: { correlationAttemptId: 'stale', before: [] },
    generationResultCheckpoint: { media: [] },
    generationQuoteFields: { stale: true },
  },
});

test('retry() resets every stale attempt field to a clean pending state', async () => {
  const queue = makeQueue(async () => { throw retryableError({ observerReady: false }); });
  const internal = await failedJobWithSeededStaleFields(queue, staleSeed());
  const retried = await queue.retry(internal.id);
  assertCleanPending(retried);
  await queue.stop();
});

test('retryBatch() resets diagnostics and stale fields like retry()', async () => {
  const queue = makeQueue(async () => { throw retryableError({ observerReady: false }); });
  const jobs = await queue.addBatch([
    { operation: 'flow.generation.submit', payload: { prompt: 'one' }, label: 'batch one' },
    { operation: 'flow.generation.submit', payload: { prompt: 'two' }, label: 'batch two' },
  ]);
  await queue.start();
  await Promise.all(jobs.map(job => queue.wait(job.id, 5_000)));
  const batchId = jobs[0].batch.batchId;
  for (const job of jobs) {
    const internal = queue.jobs.find(item => item.id === job.id);
    assert.equal(internal.status, 'failed');
    Object.assign(internal, staleSeed());
    internal.metadata = { ...(internal.metadata || {}), ...staleSeed().metadata };
  }
  const { retried } = await queue.retryBatch(batchId);
  assert.equal(retried.length, 2);
  for (const job of retried) assertCleanPending(job);
  await queue.stop();
});

test('captcha resume clears diagnostics and stale fields, not just error/result', async () => {
  let attempts = 0;
  const queue = makeQueue(async () => {
    attempts++;
    if (attempts === 1) {
      throw Object.assign(new Error('Flow detected unusual activity.'), { code: 'FLOW_UNUSUAL_ACTIVITY', retryable: false, outcomeUnknown: false });
    }
    return { completed: true };
  });
  const added = await queue.add({ operation: 'flow.generation.submit', payload: { prompt: 'captcha scene' }, label: 'captcha scene' });
  const pausedPromise = untilSnapshot(queue, snapshot => snapshot.isPaused && snapshot.attention?.type === 'flow-page-blocked');
  await queue.start();
  await pausedPromise;
  const internal = queue.jobs.find(job => job.id === added.id);
  assert.equal(internal.status, 'failed');
  Object.assign(internal, staleSeed());
  internal.metadata = { ...(internal.metadata || {}), ...staleSeed().metadata };
  await queue.resume();
  const { job } = await queue.wait(added.id, 5_000);
  assert.equal(job.status, 'completed');
  assert.equal(job.captchaResubmits, 1);
  assert.equal(job.diagnostics, undefined);
  assert.equal(job.partial, undefined);
  assert.equal(job.failedOutputs, undefined);
  assert.equal(job.metadata?.generationObservation, undefined);
  assert.equal(job.metadata?.generationResultCheckpoint, undefined);
  await queue.stop();
});

test('retrying a parent also resets its dependency-skipped descendants', async () => {
  // Unit-level: build the post-failure state directly instead of driving
  // the drain, so a restarted drain cannot re-fail the parent and
  // re-skip the child before the assertion runs.
  const queue = makeQueue(async () => ({ completed: true }));
  const parent = await queue.add({ operation: 'flow.generation.submit', payload: { prompt: 'parent' }, label: 'parent scene' });
  const child = await queue.add({ operation: 'flow.generation.submit', payload: { prompt: 'child' }, label: 'child scene', metadata: { dependsOnId: parent.id } });
  const parentInternal = queue.jobs.find(job => job.id === parent.id);
  Object.assign(parentInternal, { status: 'failed', retrySafe: true });
  const childInternal = queue.jobs.find(job => job.id === child.id);
  Object.assign(childInternal, { status: 'cancelled', errorCode: 'FLOW_SCENE_DEPENDENCY_SKIPPED' }, staleSeed());
  // NB: staleSeed() carries its own metadata object, so Object.assign
  // above overwrote dependsOnId — restore it explicitly here.
  childInternal.metadata = { dependsOnId: parent.id, ...staleSeed().metadata };
  await queue.retry(parent.id);
  const restored = queue.jobs.find(job => job.id === child.id);
  assertCleanPending(restored);
  await queue.stop();
});

test('resume of a retrySafe page-blocked job clears diagnostics too', async () => {
  let attempts = 0;
  const queue = makeQueue(async () => {
    attempts++;
    if (attempts === 1) {
      throw Object.assign(new Error('Flow page not ready.'), { code: 'FLOW_SCREEN_NOT_READY', retryable: true, outcomeUnknown: false });
    }
    return { completed: true };
  });
  const added = await queue.add({ operation: 'flow.generation.submit', payload: { prompt: 'blocked', params: { retries: 0 } }, label: 'blocked scene' });
  const pausedPromise = untilSnapshot(queue, snapshot => snapshot.isPaused && snapshot.attention?.type === 'flow-page-blocked');
  await queue.start();
  await pausedPromise;
  const internal = queue.jobs.find(job => job.id === added.id);
  assert.equal(internal.status, 'failed');
  assert.equal(internal.retrySafe, true);
  internal.diagnostics = { observerReady: false };
  internal.metadata = { ...(internal.metadata || {}), generationObservation: { correlationAttemptId: 'stale', before: [] } };
  await queue.resume();
  const { job } = await queue.wait(added.id, 5_000);
  assert.equal(job.status, 'completed');
  assert.equal(job.diagnostics, undefined);
  assert.equal(job.metadata?.generationObservation, undefined);
  await queue.stop();
});

test('add() rolls back the staged job when persist fails, like addBatch()', async () => {
  const data = {};
  let failSets = false;
  const storage = {
    async get(key) { return { [key]: data[key] }; },
    async set(entries) {
      if (failSets) throw new Error('storage boom');
      Object.assign(data, entries);
    },
    async remove(key) { delete data[key]; },
  };
  const queue = new FlowJobQueue(async () => ({ completed: true }), { storage, minDelayMs: 0, maxDelayMs: 0 });
  await queue.ready;
  failSets = true;
  await assert.rejects(
    queue.add({ operation: 'flow.generation.submit', payload: { prompt: 'rollback' }, label: 'rollback scene' }),
    /storage boom/,
  );
  assert.equal((await queue.list()).length, 0, 'a failed add must not leave the job staged');
  failSets = false;
  const added = await queue.add({ operation: 'flow.generation.submit', payload: { prompt: 'after' }, label: 'after scene' });
  assert.equal((await queue.list()).length, 1);
  assert.equal(added.label, 'after scene');
  await queue.stop();
});

// NOTE: a cancel that lands between the runner's awaits and its abort
// listener registration would otherwise be lost (AbortSignal listeners
// added after abort never fire). The runner therefore checks
// signal.aborted at registration time, and the submit/checkpoint tests
// below wait for a snapshot the runner only emits after its last await
// (progress phase / dispatch checkpoint), so registration has already
// happened synchronously by the time cancel runs.
async function blockedRunnerQueue(onBlock) {
  const queue = makeQueue(async (job, hooks) => {
    await onBlock(job, hooks);
    await new Promise((_, reject) => {
      if (hooks.signal.aborted) reject(new Error('aborted by test'));
      else hooks.signal.addEventListener('abort', () => reject(new Error('aborted by test')));
    });
  });
  return queue;
}

test('cancelling a job stuck in preflight fails cleanly without pausing the queue', async () => {
  const queue = await blockedRunnerQueue(async () => {});
  const added = await queue.add({ operation: 'flow.generation.submit', payload: { prompt: 'preflight' }, label: 'preflight scene' });
  const waitPromise = queue.wait(added.id, 5_000);
  await queue.start();
  await untilSnapshot(queue, snapshot => snapshot.jobs.some(job => job.id === added.id && job.status === 'running'));
  const cancelled = await queue.cancel(added.id);
  assert.equal(cancelled.active, true);
  const { job } = await waitPromise;
  assert.equal(job.status, 'failed');
  assert.equal(job.outcomeUnknown, false);
  const snapshot = await queue.snapshot();
  assert.equal(snapshot.isPaused, false);
  assert.equal(snapshot.attention, null);
  await queue.stop();
});

test('cancelling a job in the submit phase still pauses as outcome-unknown', async () => {
  const queue = await blockedRunnerQueue(async (job, hooks) => {
    await hooks.progress({ phase: 'submit', message: 'Submitting to Google Flow…' });
  });
  const added = await queue.add({ operation: 'flow.generation.submit', payload: { prompt: 'submitting' }, label: 'submitting scene' });
  const waitPromise = queue.wait(added.id, 5_000);
  await queue.start();
  await untilSnapshot(queue, snapshot => snapshot.jobs.some(job => job.id === added.id && job.progress?.phase === 'submit'));
  await queue.cancel(added.id);
  const { job } = await waitPromise;
  assert.equal(job.status, 'failed');
  assert.equal(job.outcomeUnknown, true);
  const snapshot = await queue.snapshot();
  assert.equal(snapshot.isPaused, true);
  assert.equal(snapshot.attention?.type, 'flow-outcome-unknown');
  await queue.stop();
});

test('cancelling a job after a dispatch checkpoint still pauses as outcome-unknown', async () => {
  let queue;
  queue = await blockedRunnerQueue(async job => {
    await queue.checkpointGenerationObservation(job.id, {
      correlationAttemptId: 'attempt-1',
      before: [],
      kind: 'image',
      expectedCount: 1,
      timeoutMs: 60_000,
      dispatchedAt: Date.now(),
    });
  });
  const added = await queue.add({ operation: 'flow.generation.submit', payload: { prompt: 'dispatched' }, label: 'dispatched scene' });
  const waitPromise = queue.wait(added.id, 5_000);
  await queue.start();
  await untilSnapshot(queue, snapshot => snapshot.jobs.some(job => job.id === added.id && Number(job.metadata?.generationObservation?.dispatchedAt) > 0));
  await queue.cancel(added.id);
  const { job } = await waitPromise;
  assert.equal(job.status, 'failed');
  assert.equal(job.outcomeUnknown, true);
  const snapshot = await queue.snapshot();
  assert.equal(snapshot.isPaused, true);
  assert.equal(snapshot.attention?.type, 'flow-outcome-unknown');
  await queue.stop();
});

const transformAdmissionCheck = owner => jobs => {
  const foreign = (Array.isArray(jobs) ? jobs : []).some(job => {
    const family = job?.metadata?.transform?.family;
    return typeof family === 'string' && family.trim().toLowerCase() !== owner;
  });
  if (!foreign) return null;
  return { code: 'FLOW_TRANSFORM_EXECUTION_LOCKED', message: `A ${owner} transform is still running.`, owner };
};

test('admissionCheck refuses a foreign transform family on add()', async () => {
  const queue = makeQueue(async () => ({ completed: true }), { admissionCheck: transformAdmissionCheck('alpha') });
  await assert.rejects(
    queue.add({ operation: 'flow.generation.submit', payload: { prompt: 'beta' }, label: 'beta scene', metadata: { transform: { family: 'beta' } } }),
    error => error.code === 'FLOW_TRANSFORM_EXECUTION_LOCKED',
  );
  assert.equal((await queue.list()).length, 0);
  const same = await queue.add({ operation: 'flow.generation.submit', payload: { prompt: 'alpha' }, label: 'alpha scene', metadata: { transform: { family: 'alpha' } } });
  assert.equal(same.label, 'alpha scene');
  const plain = await queue.add({ operation: 'flow.generation.submit', payload: { prompt: 'plain' }, label: 'plain scene' });
  assert.equal(plain.label, 'plain scene');
  await queue.stop();
});

test('admissionCheck refuses a whole batch carrying a foreign transform', async () => {
  const queue = makeQueue(async () => ({ completed: true }), { admissionCheck: transformAdmissionCheck('alpha') });
  await assert.rejects(
    queue.addBatch([
      { operation: 'flow.generation.submit', payload: { prompt: 'alpha' }, label: 'alpha scene', metadata: { transform: { family: 'alpha' } } },
      { operation: 'flow.generation.submit', payload: { prompt: 'beta' }, label: 'beta scene', metadata: { transform: { family: 'beta' } } },
    ]),
    error => error.code === 'FLOW_TRANSFORM_EXECUTION_LOCKED',
  );
  assert.equal((await queue.list()).length, 0, 'a refused batch must not enqueue any of its jobs');
  await queue.stop();
});

test('service worker wires the transform gate into the queue constructor', () => {
  const serviceWorkerJs = readFileSync(new URL('../extension/src/background/service-worker.js', import.meta.url), 'utf8');
  assert.match(serviceWorkerJs, /admissionCheck:\s*jobs\s*=>\s*flowTransformGate\.admissionRefusal\(jobs\)/);
});

test('auto-retry progress reports the job declared budget, not the global cap', async () => {
  const queue = makeQueue(async () => { throw retryableError(); });
  const added = await queue.add({ operation: 'flow.generation.submit', payload: { prompt: 'scene', retries: 1 }, label: 'one-retry scene' });
  const retrySnapshot = untilSnapshot(queue, snapshot => snapshot.jobs.some(job => job.id === added.id && job.progress?.phase === 'auto_retry'));
  await queue.start();
  const snapshot = await retrySnapshot;
  const retrying = snapshot.jobs.find(job => job.id === added.id);
  assert.equal(retrying.progress.attempt, 1);
  assert.equal(retrying.progress.maxAttempts, 1, 'retries: 1 must report maxAttempts 1, not the global cap 2');
  await queue.wait(added.id, 5_000);
  await queue.stop();
});

test('auto-retry progress still reports the global cap when no budget is declared', async () => {
  const queue = makeQueue(async () => { throw retryableError(); });
  const added = await queue.add({ operation: 'flow.generation.submit', payload: { prompt: 'scene' }, label: 'uncapped scene' });
  const retrySnapshot = untilSnapshot(queue, snapshot => snapshot.jobs.some(job => job.id === added.id && job.progress?.phase === 'auto_retry'));
  await queue.start();
  const snapshot = await retrySnapshot;
  const retrying = snapshot.jobs.find(job => job.id === added.id);
  assert.equal(retrying.progress.maxAttempts, 2);
  await queue.wait(added.id, 5_000);
  await queue.stop();
});

test('queue panel renders a dropped_references reason verbatim in request diagnostics', () => {
  // Audit cluster C follow-up (cluster B decoder drop count): the
  // panel-visible request events carry the drop as a reason string
  // (dropped_references:<n>), NOT as a droppedReferenceCount field —
  // the count lives only in the observer's request_seen/input_seen
  // payloads, which the queue never stores on the job. So the reason
  // line is the surface that shows the drop, and this test pins it.
  // diagnosticsSummaryLines is self-contained (argument only), so it
  // extracts cleanly into a vm sandbox like the gate factory suites.
  const panelJs = readFileSync(new URL('../extension/src/ui/flow-queue-panel.js', import.meta.url), 'utf8');
  const start = panelJs.indexOf('  function diagnosticsSummaryLines(diagnostics) {');
  assert.ok(start >= 0, 'diagnosticsSummaryLines not found in panel source');
  const end = panelJs.indexOf('\n  function progressPercent(task) {', start);
  assert.ok(end > start, 'diagnosticsSummaryLines must precede progressPercent');
  const sandbox = {};
  vm.runInNewContext(`${panelJs.slice(start, end)}\nthis.__diagnosticsSummaryLines = diagnosticsSummaryLines;`, sandbox, { filename: 'flow-queue-panel-diagnostics.js' });
  const lines = sandbox.__diagnosticsSummaryLines({
    observerReady: true,
    xhrHookActive: true,
    fetchHookActive: true,
    requestDiagnostics: {
      version: 1,
      count: 1,
      events: [{
        transport: 'fetch',
        path: '/video/generate',
        fields: { shape: true, prompt: true, model: true, quantity: true, referenceIds: true, project: true },
        reasons: ['dropped_references:2'],
      }],
    },
  });
  assert.ok(lines.some(line => line.includes('reasons: dropped_references:2')), `expected a verbatim dropped_references reason line, got: ${JSON.stringify(lines)}`);
});

test('queue panel only renders diagnostics for failed items', () => {
  const panelJs = readFileSync(new URL('../extension/src/ui/flow-queue-panel.js', import.meta.url), 'utf8');
  const callSite = panelJs.indexOf('for (const line of diagnosticsSummaryLines(diagnostics))');
  assert.ok(callSite >= 0, 'diagnostics render call site not found');
  const guardWindow = panelJs.slice(Math.max(0, callSite - 400), callSite);
  assert.match(guardWindow, /if\s*\(\s*failed\s*\)/, 'diagnostics must render only when the item is failed');
});
