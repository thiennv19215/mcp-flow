import test from 'node:test';
import assert from 'node:assert/strict';

import { FlowJobQueue } from '../extension/src/background/flow-job-queue.js';

function memoryStorage() {
  const data = {};
  return {
    async get(key) { return { [key]: data[key] }; },
    async set(entries) { Object.assign(data, entries); },
    async remove(key) { delete data[key]; },
  };
}

async function runToSettled(queue, job) {
  const added = await queue.add(job);
  await queue.start();
  return queue.wait(added.id, 5_000);
}

test('a job declaring retries: 0 (the submit_only shape) is attempted exactly once', async () => {
  let runs = 0;
  const queue = new FlowJobQueue(async () => {
    runs++;
    throw Object.assign(new Error('Picker could not prove a complete scan.'), { code: 'FLOW_REFERENCE_SCAN_INCOMPLETE', retryable: true });
  }, { storage: memoryStorage(), minDelayMs: 0, maxDelayMs: 0 });
  const { job } = await runToSettled(queue, {
    operation: 'flow.edit.run',
    payload: { params: { prompt: 'edit', submit_only: true, retries: 0 } },
    label: 'submit-only edit',
  });
  assert.equal(job.status, 'failed');
  assert.equal(runs, 1, 'retries: 0 must disable queue auto-retry entirely');
});

test('a job declaring retries: 1 is attempted at most twice', async () => {
  let runs = 0;
  const queue = new FlowJobQueue(async () => {
    runs++;
    throw Object.assign(new Error('Transient picker failure.'), { code: 'FLOW_REFERENCE_SCAN_INCOMPLETE', retryable: true });
  }, { storage: memoryStorage(), minDelayMs: 0, maxDelayMs: 0 });
  const { job } = await runToSettled(queue, {
    operation: 'flow.generation.submit',
    payload: { prompt: 'scene', retries: 1 },
    label: 'one-retry scene',
  });
  assert.equal(job.status, 'failed');
  assert.equal(runs, 2);
});

test('a job without a declared budget keeps the global auto-retry cap', async () => {
  let runs = 0;
  const queue = new FlowJobQueue(async () => {
    runs++;
    throw Object.assign(new Error('Transient picker failure.'), { code: 'FLOW_REFERENCE_SCAN_INCOMPLETE', retryable: true });
  }, { storage: memoryStorage(), minDelayMs: 0, maxDelayMs: 0 });
  const { job } = await runToSettled(queue, {
    operation: 'flow.generation.submit',
    payload: { prompt: 'panel scene' },
    label: 'panel scene',
  });
  assert.equal(job.status, 'failed');
  assert.equal(runs, 3, 'initial attempt plus the global cap of 2 auto-retries');
});

test('a dispatched failure is never auto-retried even with budget left', async () => {
  let runs = 0;
  const queue = new FlowJobQueue(async () => {
    runs++;
    throw Object.assign(new Error('Submit outcome unknown.'), { code: 'FLOW_SUBMIT_OUTCOME_UNKNOWN', retryable: true, requestDispatched: true, outcomeUnknown: true });
  }, { storage: memoryStorage(), minDelayMs: 0, maxDelayMs: 0 });
  const { job } = await runToSettled(queue, {
    operation: 'flow.generation.submit',
    payload: { prompt: 'scene', retries: 3 },
    label: 'dispatched scene',
  });
  assert.equal(job.status, 'failed');
  assert.equal(job.outcomeUnknown, true);
  assert.equal(runs, 1);
});

test('S2 reviewfix: FLOW_TRANSFER_UNKNOWN is never auto-retried, even when the error still claims retryable', async () => {
  // Staged-transfer bytes live only in page memory; a tab reload loses
  // them, so re-running the same job with the same transferId can never
  // succeed — it just burns the retry budget and delays the real fix
  // (re-attaching the file). The queue therefore refuses this code
  // outright, covering every site that throws it (generation, character
  // attach, upload-operations), not just the one the error came from.
  let runs = 0;
  const queue = new FlowJobQueue(async () => {
    runs++;
    throw Object.assign(new Error('The staged image is no longer available.'), { code: 'FLOW_TRANSFER_UNKNOWN', retryable: true });
  }, { storage: memoryStorage(), minDelayMs: 0, maxDelayMs: 0 });
  const { job } = await runToSettled(queue, {
    operation: 'flow.generation.submit',
    payload: { prompt: 'scene' },
    label: 'lost-transfer scene',
  });
  assert.equal(job.status, 'failed');
  assert.equal(job.retrySafe, false, 'a lost transfer is not retry-safe: manual retry would fail identically');
  assert.equal(runs, 1, 'the job must fail on the first attempt, not loop through the auto-retry budget');
});
