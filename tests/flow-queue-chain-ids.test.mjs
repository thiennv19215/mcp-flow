import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { FlowJobQueue } from '../extension/src/background/flow-job-queue.js';

const serviceWorkerSource = readFileSync(new URL('../extension/src/background/service-worker.js', import.meta.url), 'utf8');

function memoryStorage() {
  const data = {};
  return {
    data,
    async get(key) { return { [key]: data[key] }; },
    async set(entries) { Object.assign(data, entries); },
  };
}

test('panel queue handlers preserve client-assigned job ids so dependency edges survive enqueue', () => {
  const addCase = serviceWorkerSource.slice(
    serviceWorkerSource.indexOf('case "flow-queue:add"'),
    serviceWorkerSource.indexOf('case "flow-queue:add-batch"'));
  assert.match(addCase, /id: source\.id/, 'flow-queue:add forwards the job id');
  const batchCase = serviceWorkerSource.slice(
    serviceWorkerSource.indexOf('case "flow-queue:add-batch"'),
    serviceWorkerSource.indexOf('case "flow-queue:pause"'));
  assert.match(batchCase, /id: job\.id/, 'flow-queue:add-batch forwards each job id');
});

test('a chained batch runs in order when job ids are preserved', async () => {
  const ran = [];
  const queue = new FlowJobQueue(async job => {
    ran.push(job.id);
    return { completed: true, requestDispatched: true };
  }, { storage: memoryStorage(), minDelayMs: 0, maxDelayMs: 0 });

  await queue.addBatch([
    { id: 'chain-a', operation: 'flow.generation.submit', payload: { type: 'video', prompt: 'scene 1' } },
    { id: 'chain-b', operation: 'flow.generation.submit', payload: { type: 'video', prompt: 'scene 2' }, metadata: { dependsOnId: 'chain-a', dependencyType: 'chain_previous' } },
  ]);
  await queue.start();
  const last = await queue.wait('chain-b', 5_000);
  assert.equal(last.finished, true);
  assert.equal(last.job.status, 'completed');
  assert.deepEqual(ran, ['chain-a', 'chain-b']);
});

test('a dependent whose parent id never entered the queue is dependency-skipped (the dropped-id failure mode)', async () => {
  const queue = new FlowJobQueue(async () => ({ completed: true }), {
    storage: memoryStorage(), minDelayMs: 0, maxDelayMs: 0,
  });
  await queue.add({
    operation: 'flow.generation.submit',
    payload: { type: 'video', prompt: 'scene 2' },
    metadata: { dependsOnId: 'id-that-was-dropped', dependencyType: 'chain_previous' },
  });
  await queue.start();
  const snapshot = await queue.snapshot();
  assert.equal(snapshot.jobs[0].status, 'cancelled');
  assert.equal(snapshot.jobs[0].errorCode, 'FLOW_SCENE_DEPENDENCY_SKIPPED');
});
