import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  FlowBatchRuns,
  receiptFromJob,
  foldQueueSnapshotIntoRun,
  computeFinalizeState,
} from '../extension/src/background/flow-batch-runs.js';
import { FlowJobQueue } from '../extension/src/background/flow-job-queue.js';

const serviceWorkerSource = readFileSync(new URL('../extension/src/background/service-worker.js', import.meta.url), 'utf8');
const panelSource = readFileSync(new URL('../extension/src/ui/flow-queue-panel.js', import.meta.url), 'utf8');

// ---------------------------------------------------------------------------
// FEAT-02: persistent batch run records + per-item resume.
//
// A draft run becomes a durable run record (ordered items, settings
// snapshot, ref pool, revision counter, index-aligned runtime item ids
// and terminal receipts, execution segments, resume index list). A
// serialized scheduler folds queue snapshots into receipts and computes
// finalize states (completed / failed / needs_review); resume re-admits
// only the unfinished indexes. The receipt-fold helper is shared: FEAT-05
// task lists fold their results back through the same code.
// ---------------------------------------------------------------------------

function memoryStorage() {
  const data = {};
  return {
    data,
    async get(key) { return { [key]: data[key] }; },
    async set(entries) { Object.assign(data, entries); },
  };
}

const genItem = (prompt, extra = {}) => ({
  operation: 'flow.generation.submit',
  payload: { type: 'image', prompt, attachments: [] },
  label: prompt,
  ...extra,
});

const makeItems = (...prompts) => prompts.map(prompt => genItem(prompt));

const MEDIA = id => ({ id, title: `title-${id}`, kind: 'image' });

// A queue job in its finished shape, as queue snapshots carry it.
const finishedJob = ({
  id, batchId = 'batch-1', batchIndex = 0, status = 'completed', prompt = 'scene',
  media = [], failedOutputs = [], error = null, errorCode = null, partial = false,
}) => ({
  id,
  operation: 'flow.generation.submit',
  payload: { type: 'image', prompt, attachments: [] },
  label: prompt,
  status,
  batch: { batchId, batchLabel: 'Run', batchIndex, batchCount: 3 },
  startedAt: 1_000,
  finishedAt: 2_000,
  ...(error ? { error, errorCode } : {}),
  ...(partial ? { partial: true } : {}),
  ...(status === 'completed'
    ? { result: { completed: true, result: { media, ...(failedOutputs.length ? { failedOutputs } : {}) } } }
    : {}),
});

const snapshotOf = jobs => ({ jobs });

// Create + claim + admit a run; runtime ids are `job-<index>` under the
// given batch id. Returns the admitted run record.
async function admittedRun(store, { items = makeItems('a', 'b', 'c'), batchId = 'batch-1', createArgs = {} } = {}) {
  const run = await store.create({ draftId: 'draft-1', label: 'Run', items, ...createArgs });
  const claim = await store.claim(run.id, run.revision);
  const mapping = claim.indexes.map(index => ({ index, jobId: `job-${index}` }));
  return store.recordAdmission(run.id, { batchId, kind: 'initial', mapping });
}

const hasCode = code => error => {
  assert.equal(error?.code, code, `expected error code ${code}, got ${error?.code} (${error?.message})`);
  return true;
};

// --- create ---------------------------------------------------------------

test('create: a draft run becomes a persistent record with items, settings snapshot, ref pool and revision', async () => {
  const store = new FlowBatchRuns({ storage: memoryStorage() });
  const items = makeItems('a', 'b');
  const run = await store.create({
    draftId: 'draft-1',
    label: 'My batch',
    items,
    refPool: [{ assetName: 'asset:hero', kind: 'image' }],
    settings: { model: 'nano-banana', aspectRatio: '16:9' },
  });
  assert.equal(typeof run.id, 'string');
  assert.equal(run.draftId, 'draft-1');
  assert.equal(run.label, 'My batch');
  assert.equal(run.state, 'created');
  assert.equal(run.finalizeState, null);
  assert.equal(run.revision, 0);
  assert.equal(run.batchId, null);
  assert.deepEqual(run.settings, { model: 'nano-banana', aspectRatio: '16:9' });
  assert.deepEqual(run.refPool, [{ assetName: 'asset:hero', kind: 'image' }]);
  assert.deepEqual(run.segments, []);
  assert.deepEqual(run.resumeIndexes, []);
  assert.equal(run.items.length, 2);
  assert.deepEqual(run.items[0].input, items[0]);
  assert.equal(run.items[0].index, 0);
  assert.equal(run.items[1].index, 1);
  assert.equal(run.items[0].hidden, false);
  assert.equal(run.items[0].runtimeJobId, null);
  assert.equal(run.items[0].receipt, null);
  // Mutating the caller's inputs afterwards must not rewrite the record.
  items[0].payload.prompt = 'tampered';
  const stored = await store.get(run.id);
  assert.equal(stored.items[0].input.payload.prompt, 'a');
});

test('create: validates the item list', async () => {
  const store = new FlowBatchRuns({ storage: memoryStorage() });
  await assert.rejects(store.create({ label: 'x', items: [] }), hasCode('FLOW_BATCH_RUN_SIZE_INVALID'));
  await assert.rejects(
    store.create({ label: 'x', items: [{ payload: { prompt: 'no operation' } }] }),
    hasCode('FLOW_BATCH_RUN_ITEM_INVALID'),
  );
});

// --- claim ----------------------------------------------------------------

test('claim: admits every non-hidden index in order and bumps the revision', async () => {
  const store = new FlowBatchRuns({ storage: memoryStorage() });
  const items = makeItems('a', 'b', 'c');
  items[1] = { ...items[1], hidden: true };
  const run = await store.create({ label: 'Run', items });
  const claim = await store.claim(run.id, run.revision);
  assert.deepEqual(claim.indexes, [0, 2], 'hidden items are never admitted');
  assert.equal(claim.run.state, 'active');
  assert.equal(claim.run.revision, run.revision + 1);
});

test('claim: a revision mismatch is rejected and the run stays claimable', async () => {
  const store = new FlowBatchRuns({ storage: memoryStorage() });
  const run = await store.create({ label: 'Run', items: makeItems('a') });
  await assert.rejects(store.claim(run.id, 99), hasCode('FLOW_BATCH_RUN_REVISION_MISMATCH'));
  const after = await store.get(run.id);
  assert.equal(after.state, 'created');
  const claim = await store.claim(run.id, after.revision);
  assert.deepEqual(claim.indexes, [0]);
});

test('claim: a second claim while one batch is active is refused', async () => {
  const store = new FlowBatchRuns({ storage: memoryStorage() });
  const first = await store.create({ label: 'One', items: makeItems('a') });
  const second = await store.create({ label: 'Two', items: makeItems('b') });
  await store.claim(first.id, first.revision);
  await assert.rejects(store.claim(second.id, second.revision), hasCode('FLOW_BATCH_RUN_CLAIM_CONFLICT'));
  await assert.rejects(store.claim(first.id, 1), hasCode('FLOW_BATCH_RUN_NOT_CLAIMABLE'));
  await assert.rejects(store.claim('missing-id', 0), hasCode('FLOW_BATCH_RUN_NOT_FOUND'));
});

// --- admission mapping ------------------------------------------------------

test('recordAdmission: the mapping write is index-aligned and records the segment', async () => {
  const store = new FlowBatchRuns({ storage: memoryStorage() });
  const run = await store.create({ label: 'Run', items: makeItems('a', 'b', 'c') });
  await store.claim(run.id, run.revision);
  const admitted = await store.recordAdmission(run.id, {
    batchId: 'batch-1',
    kind: 'initial',
    // Deliberately scrambled: alignment is by index, not by position.
    mapping: [{ index: 2, jobId: 'job-c' }, { index: 0, jobId: 'job-a' }, { index: 1, jobId: 'job-b' }],
  });
  assert.equal(admitted.items[0].runtimeJobId, 'job-a');
  assert.equal(admitted.items[1].runtimeJobId, 'job-b');
  assert.equal(admitted.items[2].runtimeJobId, 'job-c');
  assert.equal(admitted.batchId, 'batch-1');
  assert.equal(admitted.segments.length, 1);
  assert.equal(admitted.segments[0].kind, 'initial');
  assert.equal(admitted.segments[0].batchId, 'batch-1');
  assert.deepEqual(admitted.segments[0].indexes, [0, 1, 2]);
});

test('recordAdmission: rejects a non-active run and malformed mappings', async () => {
  const store = new FlowBatchRuns({ storage: memoryStorage() });
  const run = await store.create({ label: 'Run', items: makeItems('a', 'b') });
  await assert.rejects(
    store.recordAdmission(run.id, { batchId: 'b', kind: 'initial', mapping: [{ index: 0, jobId: 'j0' }] }),
    hasCode('FLOW_BATCH_RUN_NOT_ACTIVE'),
  );
  await store.claim(run.id, run.revision);
  await assert.rejects(
    store.recordAdmission(run.id, { batchId: 'b', kind: 'initial', mapping: [{ index: 9, jobId: 'jx' }] }),
    hasCode('FLOW_BATCH_RUN_ADMISSION_INVALID'),
  );
  await assert.rejects(
    store.recordAdmission(run.id, {
      batchId: 'b', kind: 'initial',
      mapping: [{ index: 0, jobId: 'j0' }, { index: 0, jobId: 'j0b' }],
    }),
    hasCode('FLOW_BATCH_RUN_ADMISSION_INVALID'),
  );
  await assert.rejects(
    store.recordAdmission(run.id, { batchId: 'b', kind: 'initial', mapping: [{ index: 0, jobId: '' }] }),
    hasCode('FLOW_BATCH_RUN_ADMISSION_INVALID'),
  );
  const after = await store.get(run.id);
  assert.equal(after.items[0].runtimeJobId, null, 'a rejected mapping writes nothing');
  assert.equal(after.segments.length, 0);
});

// --- receipt fold + finalize ------------------------------------------------

test('fold: terminal queue jobs become receipts and finalize computes completed', async () => {
  const store = new FlowBatchRuns({ storage: memoryStorage() });
  const run = await admittedRun(store);
  const outcome = await store.observeSnapshot(snapshotOf([
    finishedJob({ id: 'job-0', batchIndex: 0, media: [MEDIA('m0')] }),
    finishedJob({ id: 'job-1', batchIndex: 1, media: [MEDIA('m1')] }),
    finishedJob({ id: 'job-2', batchIndex: 2, media: [MEDIA('m2')] }),
  ]));
  assert.equal(outcome.finalizeState, 'completed');
  assert.equal(outcome.run.state, 'finalized');
  assert.deepEqual(outcome.updatedIndexes, [0, 1, 2]);
  assert.equal(outcome.run.items[0].receipt.status, 'completed');
  assert.equal(outcome.run.items[0].receipt.jobId, 'job-0');
  assert.deepEqual(outcome.run.items[0].receipt.results, [MEDIA('m0')]);
  assert.equal(outcome.run.items[0].receipt.partial, false);
  assert.deepEqual(outcome.run.resumeIndexes, []);
});

test('fold: finalize computes failed when nothing completed', async () => {
  const store = new FlowBatchRuns({ storage: memoryStorage() });
  await admittedRun(store);
  const outcome = await store.observeSnapshot(snapshotOf([
    finishedJob({ id: 'job-0', batchIndex: 0, status: 'failed', error: 'boom', errorCode: 'FLOW_GENERATION_FAILED' }),
    finishedJob({ id: 'job-1', batchIndex: 1, status: 'cancelled' }),
    finishedJob({ id: 'job-2', batchIndex: 2, status: 'failed', error: 'boom', errorCode: 'FLOW_GENERATION_FAILED' }),
  ]));
  assert.equal(outcome.finalizeState, 'failed');
  assert.equal(outcome.run.items[0].receipt.status, 'failed');
  assert.equal(outcome.run.items[0].receipt.errorCode, 'FLOW_GENERATION_FAILED');
  assert.equal(outcome.run.items[1].receipt.status, 'cancelled');
  assert.deepEqual(outcome.run.resumeIndexes, [0, 1, 2], 'every unfinished index stays resumable');
});

test('fold: finalize computes needs_review for a mixed batch and lists the resume indexes', async () => {
  const store = new FlowBatchRuns({ storage: memoryStorage() });
  await admittedRun(store);
  const outcome = await store.observeSnapshot(snapshotOf([
    finishedJob({ id: 'job-0', batchIndex: 0, media: [MEDIA('m0')] }),
    finishedJob({ id: 'job-1', batchIndex: 1, status: 'failed', error: 'boom', errorCode: 'FLOW_GENERATION_FAILED' }),
    finishedJob({ id: 'job-2', batchIndex: 2, media: [MEDIA('m2')] }),
  ]));
  assert.equal(outcome.finalizeState, 'needs_review');
  assert.deepEqual(outcome.run.resumeIndexes, [1]);
});

test('fold: finalize computes needs_review for the partial case', async () => {
  const store = new FlowBatchRuns({ storage: memoryStorage() });
  await admittedRun(store);
  const outcome = await store.observeSnapshot(snapshotOf([
    finishedJob({
      id: 'job-0', batchIndex: 0, media: [MEDIA('m0')], partial: true,
      failedOutputs: [{ title: 'lost tile', code: 'FLOW_GENERATION_FAILED' }],
    }),
    finishedJob({ id: 'job-1', batchIndex: 1, media: [MEDIA('m1')] }),
    finishedJob({ id: 'job-2', batchIndex: 2, media: [MEDIA('m2')] }),
  ]));
  assert.equal(outcome.run.items[0].receipt.partial, true);
  assert.deepEqual(outcome.run.items[0].receipt.failedOutputs, [{ title: 'lost tile', code: 'FLOW_GENERATION_FAILED' }]);
  assert.equal(outcome.finalizeState, 'needs_review', 'a partial output needs a human look, not a clean completed');
  assert.deepEqual(outcome.run.resumeIndexes, [0]);
});

test('fold: unrelated or non-terminal jobs never write receipts', async () => {
  const store = new FlowBatchRuns({ storage: memoryStorage() });
  const run = await admittedRun(store);
  const outcome = await store.observeSnapshot(snapshotOf([
    finishedJob({ id: 'someone-else', batchIndex: 0, media: [MEDIA('mx')] }),
    { ...finishedJob({ id: 'job-0', batchIndex: 0 }), status: 'running', result: undefined },
    finishedJob({ id: 'job-1', batchIndex: 1, media: [MEDIA('m1')] }),
  ]));
  assert.equal(outcome.changed, true);
  assert.deepEqual(outcome.updatedIndexes, [1]);
  assert.equal(outcome.finalizeState, null, 'the run stays active while items are unfinished');
  const after = await store.get(run.id);
  assert.equal(after.state, 'active');
  assert.equal(after.items[0].receipt, null);
  assert.equal(computeFinalizeState(after), null);
  await assert.rejects(store.finalize(run.id), hasCode('FLOW_BATCH_RUN_NOT_FINISHED'));
});

test('fold helper: foldQueueSnapshotIntoRun is pure and index-aligned by runtime id', async () => {
  const store = new FlowBatchRuns({ storage: memoryStorage() });
  const run = await admittedRun(store);
  const before = structuredClone(run);
  const folded = foldQueueSnapshotIntoRun(run, snapshotOf([
    finishedJob({ id: 'job-2', batchIndex: 2, media: [MEDIA('m2')] }),
  ]));
  assert.deepEqual(run, before, 'the input run is not mutated');
  assert.equal(folded.changed, true);
  assert.deepEqual(folded.updatedIndexes, [2]);
  assert.equal(folded.run.items[2].receipt.status, 'completed');
  assert.equal(folded.run.items[0].receipt, null);
  assert.equal(receiptFromJob({ id: 'x', status: 'pending' }), null);
  assert.equal(receiptFromJob(finishedJob({ id: 'job-9', status: 'cancelled' })).status, 'cancelled');
});

test('fold: hidden items are never admitted and never block finalize', async () => {
  const store = new FlowBatchRuns({ storage: memoryStorage() });
  const items = makeItems('a', 'b', 'c');
  items[1] = { ...items[1], hidden: true };
  const run = await admittedRun(store, { items });
  assert.equal(run.items[1].runtimeJobId, null);
  const outcome = await store.observeSnapshot(snapshotOf([
    finishedJob({ id: 'job-0', batchIndex: 0, media: [MEDIA('m0')] }),
    finishedJob({ id: 'job-2', batchIndex: 2, media: [MEDIA('m2')] }),
  ]));
  assert.equal(outcome.finalizeState, 'completed');
});

// --- resume -----------------------------------------------------------------

async function needsReviewRun(store) {
  const run = await admittedRun(store);
  await store.observeSnapshot(snapshotOf([
    finishedJob({ id: 'job-0', batchIndex: 0, media: [MEDIA('m0')] }),
    finishedJob({ id: 'job-1', batchIndex: 1, status: 'failed', error: 'boom', errorCode: 'FLOW_GENERATION_FAILED' }),
    finishedJob({ id: 'job-2', batchIndex: 2, media: [MEDIA('m2')] }),
  ]));
  return store.get(run.id);
}

test('resume: [done, failed, done] admits only the failed index, keeps the other receipts, finalize merges to completed', async () => {
  const store = new FlowBatchRuns({ storage: memoryStorage() });
  const finalized = await needsReviewRun(store);
  assert.equal(finalized.finalizeState, 'needs_review');
  const receipt0 = structuredClone(finalized.items[0].receipt);
  const receipt2 = structuredClone(finalized.items[2].receipt);

  const resumed = await store.resume(finalized.id, { expectedRevision: finalized.revision });
  assert.deepEqual(resumed.indexes, [1]);
  assert.equal(resumed.jobs.length, 1);
  assert.equal(resumed.jobs[0].payload.prompt, 'b');
  assert.equal(resumed.run.state, 'active');

  const admitted = await store.recordAdmission(finalized.id, {
    batchId: 'batch-2', kind: 'resume', mapping: [{ index: 1, jobId: 'job-1-retry' }],
  });
  assert.deepEqual(admitted.items[0].receipt, receipt0, 'receipt [0] is kept');
  assert.deepEqual(admitted.items[2].receipt, receipt2, 'receipt [2] is kept');
  assert.equal(admitted.items[1].receipt, null, 'the resumed index awaits its new receipt');
  assert.equal(admitted.items[1].runtimeJobId, 'job-1-retry');
  assert.equal(admitted.segments.length, 2);
  assert.equal(admitted.segments[1].kind, 'resume');
  assert.equal(admitted.segments[1].supersededReceipts[1].status, 'failed', 'the superseded failure stays on the segment for audit');

  const outcome = await store.observeSnapshot(snapshotOf([
    finishedJob({ id: 'job-1-retry', batchId: 'batch-2', batchIndex: 0, media: [MEDIA('m1b')] }),
  ]));
  assert.equal(outcome.finalizeState, 'completed', 'finalize merges the kept receipts with the new one');
  assert.deepEqual(outcome.run.resumeIndexes, []);
  assert.deepEqual(outcome.run.items[0].receipt, receipt0);
  assert.deepEqual(outcome.run.items[2].receipt, receipt2);
});

test('resume: index validation rejects duplicates, out-of-range, hidden and finished items', async () => {
  const store = new FlowBatchRuns({ storage: memoryStorage() });
  const finalized = await needsReviewRun(store);
  await assert.rejects(store.resume(finalized.id, { indexes: [1, 1] }), hasCode('FLOW_BATCH_RUN_RESUME_INDEX_INVALID'));
  await assert.rejects(store.resume(finalized.id, { indexes: [9] }), hasCode('FLOW_BATCH_RUN_RESUME_INDEX_INVALID'));
  await assert.rejects(store.resume(finalized.id, { indexes: [0] }), hasCode('FLOW_BATCH_RUN_RESUME_INDEX_INVALID'));
  await assert.rejects(store.resume(finalized.id, { indexes: [1.5] }), hasCode('FLOW_BATCH_RUN_RESUME_INDEX_INVALID'));
  const after = await store.get(finalized.id);
  assert.equal(after.state, 'finalized', 'a rejected resume mutates nothing');
  const resumed = await store.resume(finalized.id, { indexes: [1] });
  assert.deepEqual(resumed.indexes, [1], 'a valid resume still works after rejected attempts');
});

test('resume: a hidden item cannot be resumed', async () => {
  const store = new FlowBatchRuns({ storage: memoryStorage() });
  const items = makeItems('a', 'b', 'c');
  items[2] = { ...items[2], hidden: true };
  const run = await admittedRun(store, { items });
  await store.observeSnapshot(snapshotOf([
    finishedJob({ id: 'job-0', batchIndex: 0, media: [MEDIA('m0')] }),
    finishedJob({ id: 'job-1', batchIndex: 1, status: 'failed', error: 'boom', errorCode: 'FLOW_GENERATION_FAILED' }),
  ]));
  const finalized = await store.get(run.id);
  assert.equal(finalized.finalizeState, 'needs_review');
  await assert.rejects(store.resume(run.id, { indexes: [2] }), hasCode('FLOW_BATCH_RUN_RESUME_INDEX_INVALID'));
});

test('resume: refuses a non-finalized run and any resume while another batch is active', async () => {
  const store = new FlowBatchRuns({ storage: memoryStorage() });
  const finalized = await needsReviewRun(store);
  const other = await store.create({ label: 'Other', items: makeItems('x') });
  await store.claim(other.id, other.revision);
  await assert.rejects(store.resume(finalized.id), hasCode('FLOW_BATCH_RUN_CLAIM_CONFLICT'));
  await assert.rejects(store.resume(other.id), hasCode('FLOW_BATCH_RUN_NOT_RESUMABLE'));
  await assert.rejects(store.resume('missing-id'), hasCode('FLOW_BATCH_RUN_NOT_FOUND'));
});

test('resume: a claim that never admits can be released back to finalized', async () => {
  const store = new FlowBatchRuns({ storage: memoryStorage() });
  const finalized = await needsReviewRun(store);
  await store.resume(finalized.id);
  const released = await store.releaseClaim(finalized.id);
  assert.equal(released.state, 'finalized');
  assert.equal(released.finalizeState, 'needs_review');
  assert.deepEqual(released.resumeIndexes, [1]);
  const again = await store.resume(finalized.id);
  assert.deepEqual(again.indexes, [1], 'the run can be claimed again after a release');
});

// --- persistence --------------------------------------------------------------

test('persistence: runs survive a restart with receipts, segments and revision intact', async () => {
  const storage = memoryStorage();
  const store = new FlowBatchRuns({ storage });
  const finalized = await needsReviewRun(store);
  await store.flush();
  const reopened = new FlowBatchRuns({ storage });
  const restored = await reopened.get(finalized.id);
  assert.equal(restored.state, 'finalized');
  assert.equal(restored.finalizeState, 'needs_review');
  assert.equal(restored.revision, finalized.revision);
  assert.equal(restored.items[1].receipt.status, 'failed');
  assert.equal(restored.segments.length, 1);
  assert.deepEqual(restored.resumeIndexes, [1]);
  const resumed = await reopened.resume(finalized.id);
  assert.deepEqual(resumed.indexes, [1], 'resume works straight after a restart');
});

test('persistence: a corrupt stored state degrades to an empty run store', async () => {
  const storage = memoryStorage();
  storage.data.flowMcpBatchRunsV1 = { version: 99, runs: 'nope' };
  const store = new FlowBatchRuns({ storage });
  assert.deepEqual(await store.list(), []);
  const run = await store.create({ label: 'Run', items: makeItems('a') });
  assert.ok(run.id);
});

// --- queue integration --------------------------------------------------------

test('queue integration: a real queue batch folds into receipts, finalizes, and resume re-runs only the failed item', async () => {
  const store = new FlowBatchRuns({ storage: memoryStorage() });
  let failBadScene = true;
  const queue = new FlowJobQueue(async job => {
    if (job.payload.prompt === 'bad scene' && failBadScene) {
      throw Object.assign(new Error('Flow refused.'), { code: 'FLOW_GENERATION_FAILED', retryable: false, outcomeUnknown: false });
    }
    return {
      completed: true,
      requestDispatched: true,
      result: { media: [{ id: `media-${job.payload.prompt}`, title: job.payload.prompt, kind: 'image' }] },
    };
  }, { storage: memoryStorage(), minDelayMs: 0, maxDelayMs: 0 });
  const feeds = [];
  queue.subscribe(snapshot => { feeds.push(store.observeSnapshot(snapshot)); });

  const run = await store.create({
    draftId: 'draft-9',
    label: 'Integration batch',
    items: [
      genItem('good scene'),
      genItem('bad scene'),
      genItem('last scene'),
    ],
  });
  const claim = await store.claim(run.id, run.revision);
  const added = await queue.addBatch(claim.indexes.map(index => run.items[index].input), { batchId: 'batch-q', batchLabel: run.label });
  await store.recordAdmission(run.id, {
    batchId: 'batch-q',
    kind: 'initial',
    mapping: added.map(job => ({ index: job.batch.batchIndex, jobId: job.id })),
  });
  await queue.start();
  await queue.wait(added[2].id, 5_000);
  await Promise.all(feeds);
  await store.observeSnapshot(await queue.snapshot());
  await store.flush();

  const finalized = await store.get(run.id);
  assert.equal(finalized.state, 'finalized');
  assert.equal(finalized.finalizeState, 'needs_review');
  assert.deepEqual(finalized.resumeIndexes, [1]);
  assert.equal(finalized.items[0].receipt.status, 'completed');
  assert.deepEqual(finalized.items[0].receipt.results, [{ id: 'media-good scene', title: 'good scene', kind: 'image' }]);
  assert.equal(finalized.items[1].receipt.status, 'failed');
  assert.equal(finalized.items[1].receipt.errorCode, 'FLOW_GENERATION_FAILED');
  assert.equal(finalized.items[2].receipt.status, 'completed');

  failBadScene = false;
  const resumed = await store.resume(run.id);
  assert.deepEqual(resumed.indexes, [1]);
  const retry = await queue.add(resumed.jobs[0]);
  await store.recordAdmission(run.id, { batchId: null, kind: 'resume', mapping: [{ index: 1, jobId: retry.id }] });
  await queue.start();
  await queue.wait(retry.id, 5_000);
  await Promise.all(feeds);
  await store.observeSnapshot(await queue.snapshot());

  const merged = await store.get(run.id);
  assert.equal(merged.state, 'finalized');
  assert.equal(merged.finalizeState, 'completed', 'the resumed item merges with the kept receipts');
  assert.equal(merged.items[1].receipt.status, 'completed');
  assert.equal(merged.items[1].receipt.jobId, retry.id);
  assert.equal(merged.segments.length, 2);
});

// --- wiring -------------------------------------------------------------------

test('wiring: service worker owns the run store, folds snapshots and serves the batch-run surface', () => {
  assert.match(serviceWorkerSource, /from "\.\/flow-batch-runs\.js"/, 'service worker imports the batch-runs module');
  assert.match(serviceWorkerSource, /new FlowBatchRuns\(\)/, 'service worker owns a batch-run store');
  assert.match(serviceWorkerSource, /flowBatchRuns\.observeSnapshot\(snapshot\)/, 'queue snapshots fold into the active run');
  for (const type of ['flow-batch-runs:list', 'flow-batch-runs:create', 'flow-batch-runs:resume', 'flow-batch-runs:remove']) {
    assert.ok(serviceWorkerSource.includes(`"${type}"`), `service worker handles ${type}`);
  }
  assert.match(serviceWorkerSource, /FLOW_BATCH_RUNS_FORBIDDEN/);
  assert.match(serviceWorkerSource, /trackDraftRun\(/, 'draft runs are tracked as batch runs');
  assert.match(serviceWorkerSource, /releaseClaim\(/, 'a failed resume enqueue releases the claim');
});

test('wiring: the queue panel shows run state on drafts and offers resume for partial runs', () => {
  assert.ok(panelSource.includes('"flow-batch-runs:list"'), 'panel loads batch runs');
  assert.ok(panelSource.includes('"flow-batch-runs:resume"'), 'panel resumes through the worker');
  assert.match(panelSource, /run-resume/, 'drafts carry a resume action');
  assert.match(panelSource, /resumeUnfinished/, 'the resume action has a label');
});
