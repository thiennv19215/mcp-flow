import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { FlowBatchDrafts } from '../extension/src/background/flow-batch-drafts.js';
import { FlowJobQueue } from '../extension/src/background/flow-job-queue.js';
import { validateFlowJobPayloads } from '../extension/src/background/flow-queue-preflight.js';

const serviceWorkerSource = readFileSync(new URL('../extension/src/background/service-worker.js', import.meta.url), 'utf8');

function memoryStorage() {
  const data = {};
  return {
    data,
    async get(key) { return { [key]: data[key] }; },
    async set(entries) { Object.assign(data, entries); },
  };
}

const genJob = (prompt, extra = {}) => ({ operation: 'flow.generation.submit', payload: { type: 'image', prompt }, label: prompt, ...extra });

// --- Fix 1: dead stopHttpSession() calls in the service worker -------------
// The bridge teardown lived on as calls to a free function that only exists
// as a FlowBridgeClient method, so the storage-change and manual-connect
// handlers threw ReferenceError before connect() was ever reached.

test('service worker reconnect paths go through the bridge client, not the dead legacy teardown', () => {
  assert.ok(!serviceWorkerSource.includes('stopHttpSession'),
    'service-worker scope must not reference the bridge client method as a free function');
  const storageBranch = serviceWorkerSource.slice(
    serviceWorkerSource.indexOf('chrome.storage.onChanged.addListener'),
    serviceWorkerSource.indexOf('chrome.runtime.onMessage.addListener'));
  assert.match(storageBranch, /bridgeClient\.disconnect\("Bridge URL changed"\)/,
    'a bridge config change drops the session through the bridge client');
  const connectHandler = serviceWorkerSource.slice(
    serviceWorkerSource.indexOf('message?.type === "flow-mcp:connect"'));
  assert.match(connectHandler, /bridgeClient\.disconnect\("User reconnect"\)/,
    'the manual connect handler drops the session through the bridge client');
  assert.match(connectHandler, /await connect\(\)/, 'the manual connect handler still reconnects afterwards');
  for (const declaration of ['let bridgeTransport', 'let opening', 'let reconnectTimer', 'let reconnectAttempt', 'let heartbeat']) {
    assert.ok(!serviceWorkerSource.includes(declaration), `dead legacy state is gone: ${declaration}`);
  }
});

// --- Fix 2: atomic bridge queue submission ---------------------------------
// The MCP bridge path used to enqueue planned jobs one by one; a failure on
// job N left jobs 1..N-1 queued and spending credits after the caller had
// already been told the submission failed.
// Audit cluster E: the dispatch lives in enqueueJobs now (single job ->
// add, batch -> addBatch, pinned at runtime by flow-audit-e-enqueue);
// the bridge path must still go through it, never a per-job loop.

test('bridge queue submissions admit multi-job batches atomically via addBatch', () => {
  const branch = serviceWorkerSource.slice(
    serviceWorkerSource.indexOf('const defaultFlowTarget = await captureFlowTargetMetadata();'),
    serviceWorkerSource.indexOf('if (command.name === "flow.queue.get")'));
  assert.match(branch, /await enqueueJobs\(jobInputs, \{ batchId \}\)/,
    'multi-job submissions go through the atomic batch admission');
  const helper = serviceWorkerSource.slice(
    serviceWorkerSource.indexOf('async function enqueueJobs'),
    serviceWorkerSource.indexOf('async function startEnqueuedWork'));
  assert.match(helper, /if \(list\.length === 1\) return \[await flowJobQueue\.add\(list\[0\]\)\];/,
    'single-job submissions keep using add');
  assert.match(helper, /return flowJobQueue\.addBatch\(list, batchOptions\);/,
    'multi-job submissions keep using the atomic addBatch');
  assert.ok(!branch.includes('added.push(await flowJobQueue.add('),
    'the non-atomic per-job enqueue loop is gone');
  assert.match(branch, /dependsOnId: previousId/,
    'workflow dependency metadata still points at the previous job id');
});

test('addBatch rejects a batch with a duplicate id without queueing any of it', async () => {
  const queue = new FlowJobQueue(async () => ({ completed: true }), {
    storage: memoryStorage(), minDelayMs: 0, maxDelayMs: 0,
  });
  await queue.add({ id: 'already-there', operation: 'flow.generation.submit', payload: { type: 'image', prompt: 'old' } });
  await assert.rejects(
    queue.addBatch([
      { id: 'batch-a', operation: 'flow.generation.submit', payload: { type: 'image', prompt: 'a' } },
      { id: 'already-there', operation: 'flow.generation.submit', payload: { type: 'image', prompt: 'dupe' } },
      { id: 'batch-b', operation: 'flow.generation.submit', payload: { type: 'image', prompt: 'b' } },
    ]),
    /Flow job already exists: already-there/);
  const snapshot = await queue.snapshot();
  assert.deepEqual(snapshot.jobs.map(job => job.id), ['already-there'],
    'no job from the rejected batch entered the queue');
});

// --- Fix 3: batch drafts write chain survives one storage failure ----------

test('a rejected draft write does not wedge later draft persistence', async () => {
  const data = {};
  let failNextSet = true;
  const storage = {
    data,
    async get(key) { return { [key]: data[key] }; },
    async set(entries) {
      if (failNextSet) {
        failNextSet = false;
        throw new Error('transient storage failure');
      }
      Object.assign(data, entries);
    },
  };
  const drafts = new FlowBatchDrafts({ storage });
  await assert.rejects(
    drafts.save({ label: 'First', jobs: [genJob('a')] }),
    /transient storage failure/,
    'the failed write itself still surfaces to its caller');
  const second = await drafts.save({ label: 'Second', jobs: [genJob('b')] });
  assert.equal(second.label, 'Second', 'a later save is not poisoned by the earlier rejection');
  const reopened = new FlowBatchDrafts({ storage });
  const labels = (await reopened.list()).map(draft => draft.label);
  assert.ok(labels.includes('Second'), 'the later draft actually persisted');
});

// --- Fix 4: flow-mcp:dispatch sender gating --------------------------------

test('flow-mcp:dispatch is gated to extension UI pages like its sibling handlers', () => {
  const handler = serviceWorkerSource.slice(
    serviceWorkerSource.indexOf('message?.type === "flow-mcp:dispatch"'),
    serviceWorkerSource.indexOf('message?.type === "flow-mcp:status"'));
  assert.match(handler, /_sender\?\.id !== chrome\.runtime\.id/, 'dispatch rejects foreign senders');
  assert.match(handler, /_sender\?\.tab/, 'dispatch rejects tab (content script) senders');
  assert.ok(handler.indexOf('FLOW_DISPATCH_FORBIDDEN') < handler.indexOf('execute('),
    'the gate runs before the operation executes');
});

// --- Fix 5: drain finalizer survives a failing final persist ---------------

test('a failing final drain persist still emits drained and runs the requested restart', async () => {
  const data = {};
  let armed = false;
  let injected = false;
  let queue;
  const storage = {
    async get(key) { return { [key]: data[key] }; },
    async set(entries) {
      // The drain finalizer's persist is the only queue write that runs
      // after running flips back to false. Fail exactly that write, once,
      // and have a job "arrive" at the same moment: visible to the
      // finalizer's restart check, too late for the drain loop itself.
      if (armed && !queue.running && !injected) {
        injected = true;
        queue.jobs.push({
          id: 'late-job', type: 'flow', operation: 'flow.generation.submit',
          payload: { type: 'image', prompt: 'late' }, label: 'late', name: 'late',
          data: { operation: 'flow.generation.submit', payload: { type: 'image', prompt: 'late' } },
          status: 'pending', outcomeUnknown: false, addedAt: Date.now(), attempts: 0, autoRetryCount: 0,
        });
        throw new Error('storage write failed');
      }
      Object.assign(data, entries);
    },
  };
  const ran = [];
  queue = new FlowJobQueue(async job => {
    ran.push(job.id);
    // Stand in for a start() requested while the drain was mid-job, and arm
    // the storage trap for the finalizer's persist.
    if (job.id === 'first-job') {
      queue.restartRequested = true;
      armed = true;
    }
    return { completed: true, requestDispatched: true };
  }, { storage, minDelayMs: 0, maxDelayMs: 0 });
  const reasons = [];
  queue.subscribe((_snapshot, reason) => reasons.push(reason));

  await queue.add({ id: 'first-job', operation: 'flow.generation.submit', payload: { type: 'image', prompt: 'first' } });
  await queue.start();
  const drainOutcome = await queue.drainPromise.then(() => 'resolved', () => 'rejected');
  assert.equal(drainOutcome, 'resolved', 'the drain must not reject when its final persist fails');
  assert.ok(reasons.includes('drained'), 'the drained notification still fires');

  const last = await queue.wait('late-job', 5_000);
  assert.equal(last.finished, true);
  assert.equal(last.job.status, 'completed', 'the restart follow-up picked up the late job instead of stranding it');
  assert.deepEqual(ran, ['first-job', 'late-job']);
});

// --- Fix 6: unique dispatch request ids ------------------------------------

test('dispatch command ids carry a sequence suffix so same-millisecond dispatches cannot collide', () => {
  const handler = serviceWorkerSource.slice(
    serviceWorkerSource.indexOf('message?.type === "flow-mcp:dispatch"'),
    serviceWorkerSource.indexOf('message?.type === "flow-mcp:status"'));
  assert.match(handler, /ui-\$\{Date\.now\(\)\}-\$\{\+\+uiDispatchSequence\}/,
    'dispatch ids are unique per dispatch, not just per millisecond');
  assert.match(serviceWorkerSource, /let uiDispatchSequence = 0;/, 'the sequence counter is module state');
});

// --- Fix 7: preflight prefers the most specific model rule -----------------

test('preflight matches the longest alias, so a generic rule cannot shadow a specific one', () => {
  const syntheticRegistry = {
    defaults: { maxReferences: 3 },
    models: [
      // Generic rule listed first: first-match-wins would pick this one for
      // every "veo 3.1 *" model.
      { match: ['veo 3.1'], types: ['video'], durations: [8] },
      { match: ['veo 3.1 fast'], types: ['video'], durations: [4] },
    ],
  };
  const fastJob = duration => ({
    operation: 'flow.generation.submit',
    payload: { type: 'video', model: 'Veo 3.1 Fast', duration, attachments: [] },
  });
  assert.deepEqual(validateFlowJobPayloads([fastJob(4)], syntheticRegistry), [],
    'the specific rule (4s) governs the Fast model even though the generic rule comes first');
  assert.equal(validateFlowJobPayloads([fastJob(8)], syntheticRegistry).length, 1,
    'a duration only the generic rule allows is rejected for the Fast model');
  assert.deepEqual(validateFlowJobPayloads([{
    operation: 'flow.generation.submit',
    payload: { type: 'video', model: 'veo 3.1', duration: 8, attachments: [] },
  }], syntheticRegistry), [], 'the plain model name still resolves to the generic rule');
});
