import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { FlowBatchDrafts, materializeDraftJobs } from '../extension/src/background/flow-batch-drafts.js';
import { FlowJobQueue } from '../extension/src/background/flow-job-queue.js';

const serviceWorkerSource = readFileSync(new URL('../extension/src/background/service-worker.js', import.meta.url), 'utf8');
const panelSource = readFileSync(new URL('../extension/src/ui/flow-queue-panel.js', import.meta.url), 'utf8');

function memoryStorage() {
  const data = {};
  return {
    data,
    async get(key) { return { [key]: data[key] }; },
    async set(entries) { Object.assign(data, entries); },
  };
}

const genJob = (prompt, extra = {}) => ({ operation: 'flow.generation.submit', payload: { type: 'image', prompt }, label: prompt, ...extra });

test('drafts save, list, persist across instances, and remove', async () => {
  const storage = memoryStorage();
  const drafts = new FlowBatchDrafts({ storage });
  const saved = await drafts.save({ label: 'My batch', jobs: [genJob('a'), genJob('b')] });
  assert.equal(saved.jobs.length, 2);
  assert.equal(saved.runCount, 0);

  const reopened = new FlowBatchDrafts({ storage });
  const listed = await reopened.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].label, 'My batch');

  assert.equal(await reopened.remove(saved.id), true);
  assert.equal((await reopened.list()).length, 0);
  assert.equal(await reopened.remove(saved.id), false);
});

test('draft save validates size and job shape', async () => {
  const drafts = new FlowBatchDrafts({ storage: memoryStorage() });
  await assert.rejects(drafts.save({ label: 'x', jobs: [] }), error => error.code === 'FLOW_BATCH_DRAFT_SIZE_INVALID');
  await assert.rejects(
    drafts.save({ label: 'x', jobs: Array.from({ length: 101 }, () => genJob('p')) }),
    error => error.code === 'FLOW_BATCH_DRAFT_SIZE_INVALID');
  await assert.rejects(
    drafts.save({ label: 'x', jobs: [{ payload: {} }] }),
    error => error.code === 'FLOW_BATCH_DRAFT_JOB_INVALID');
});

test('materializeDraftJobs remints chained ids and rewrites dependency edges without mutating the draft', () => {
  let counter = 0;
  const draft = {
    jobs: [
      genJob('scene 1', { id: 'orig-a' }),
      genJob('scene 2', { id: 'orig-b', metadata: { dependsOnId: 'orig-a', dependencyType: 'chain_previous' } }),
      genJob('standalone'),
    ],
  };
  const jobs = materializeDraftJobs(draft, () => `fresh-${++counter}`);
  assert.equal(jobs[0].id, 'fresh-1');
  assert.equal(jobs[1].id, 'fresh-2');
  assert.equal(jobs[1].metadata.dependsOnId, 'fresh-1');
  assert.equal(jobs[2].id, undefined);
  assert.equal(draft.jobs[0].id, 'orig-a', 'the stored draft keeps its original ids');
});

test('concurrent saves both survive the ordered write chain', async () => {
  const storage = memoryStorage();
  const drafts = new FlowBatchDrafts({ storage });
  const [a, b] = await Promise.all([
    drafts.save({ label: 'A', jobs: [genJob('a')] }),
    drafts.save({ label: 'B', jobs: [genJob('b')] }),
  ]);
  assert.notEqual(a.id, b.id);
  assert.equal((await drafts.list()).length, 2);
  const reopened = new FlowBatchDrafts({ storage });
  assert.equal((await reopened.list()).length, 2, 'both drafts persisted, neither overwrote the other');
});

test('a failing storage read degrades to an empty store instead of wedging every operation', async () => {
  const storage = {
    async get() { throw new Error('storage unavailable'); },
    async set() {},
  };
  const drafts = new FlowBatchDrafts({ storage });
  assert.deepEqual(await drafts.list(), []);
  const saved = await drafts.save({ label: 'Still works', jobs: [genJob('a')] });
  assert.equal(saved.label, 'Still works');
});

test('the per-draft run lock admits one run at a time', async () => {
  const drafts = new FlowBatchDrafts({ storage: memoryStorage() });
  assert.equal(drafts.beginRun('d1'), true);
  assert.equal(drafts.beginRun('d1'), false, 'a second concurrent run of the same draft is rejected');
  assert.equal(drafts.beginRun('d2'), true, 'other drafts are unaffected');
  drafts.endRun('d1');
  assert.equal(drafts.beginRun('d1'), true, 'the lock releases after the run settles');
});

test('recordRun tracks executions on the draft', async () => {
  const drafts = new FlowBatchDrafts({ storage: memoryStorage() });
  const saved = await drafts.save({ label: 'Runs', jobs: [genJob('a')] });
  const updated = await drafts.recordRun(saved.id, 'batch-123');
  assert.equal(updated.runCount, 1);
  assert.equal(updated.lastBatchId, 'batch-123');
  assert.ok(updated.lastRunAt > 0);
});

test('a materialized draft batch enters the queue and runs chained jobs in order', async () => {
  const drafts = new FlowBatchDrafts({ storage: memoryStorage() });
  const saved = await drafts.save({
    label: 'Chain draft',
    jobs: [
      genJob('scene 1', { id: 'd-a' }),
      { operation: 'flow.generation.submit', payload: { type: 'video', prompt: 'scene 2' }, label: 'scene 2', id: 'd-b', metadata: { dependsOnId: 'd-a', dependencyType: 'chain_previous' } },
    ],
  });
  const ran = [];
  const queue = new FlowJobQueue(async job => {
    ran.push(job.payload.prompt);
    return { completed: true, requestDispatched: true };
  }, { storage: memoryStorage(), minDelayMs: 0, maxDelayMs: 0 });

  const jobs = materializeDraftJobs(await drafts.get(saved.id));
  const added = await queue.addBatch(jobs, { batchLabel: saved.label });
  await queue.start();
  const last = await queue.wait(added[1].id, 5_000);
  assert.equal(last.job.status, 'completed');
  assert.deepEqual(ran, ['scene 1', 'scene 2']);
  assert.notEqual(added[0].id, 'd-a', 'the run uses fresh ids, so re-running never collides with earlier runs');
});

test('service worker and panel expose the batch-draft surface', () => {
  for (const type of ['flow-batch:list', 'flow-batch:save', 'flow-batch:run', 'flow-batch:remove']) {
    assert.ok(serviceWorkerSource.includes(`"${type}"`), `service worker handles ${type}`);
    assert.ok(panelSource.includes(`"${type}"`), `queue panel sends ${type}`);
  }
  assert.match(panelSource, /draft-run/);
  assert.match(panelSource, /draft-remove/);
  assert.match(panelSource, /value === "draft"/, 'composer can save instead of queueing');
  assert.match(serviceWorkerSource, /beginRun\(draftId\)/, 'draft runs take the per-draft lock');
  assert.match(serviceWorkerSource, /FLOW_BATCH_DRAFT_RUN_IN_PROGRESS/);
  assert.match(serviceWorkerSource, /endRun\(draftId\)/, 'the lock is released in a finally block');
});
