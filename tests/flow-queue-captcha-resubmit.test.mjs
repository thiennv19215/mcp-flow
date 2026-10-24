import test from 'node:test';
import assert from 'node:assert/strict';

import { FlowJobQueue } from '../extension/src/background/flow-job-queue.js';

// VID-05: captcha bounded auto-resume at batch tail.
// classifyFlowError (content/shared/dom-utils.js) maps the whole captcha
// family (PUBLIC_ERROR_UNUSUAL_ACTIVITY, bot_detected, captcha_failed,
// "unusual activity", …) to category "captcha" with this single code, as a
// non-retryable pre-submit failure whose outcome is known.
const captchaError = () => Object.assign(
  new Error('Flow detected unusual activity or requires captcha verification.'),
  { code: 'FLOW_UNUSUAL_ACTIVITY', retryable: false, outcomeUnknown: false },
);

function memoryStorage() {
  const data = {};
  return {
    async get(key) { return { [key]: data[key] }; },
    async set(entries) { Object.assign(data, entries); },
    async remove(key) { delete data[key]; },
  };
}

function makeQueue(runner, storage = memoryStorage()) {
  return new FlowJobQueue(runner, { storage, minDelayMs: 0, maxDelayMs: 0 });
}

// Wait until a future queue snapshot satisfies the predicate. Callers create
// the promise BEFORE the action that should produce the snapshot, so a fast
// drain cannot emit the expected state before the subscription exists.
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

const pausedOnBlocker = snapshot =>
  snapshot.isPaused && snapshot.attention?.type === 'flow-page-blocked';
const drained = snapshot =>
  !snapshot.isRunning && snapshot.pending === 0 &&
  snapshot.jobs.every(job => job.status === 'completed');

test('a captcha-classified failure pauses the queue with attention instead of dying terminally', async () => {
  const queue = makeQueue(async () => { throw captchaError(); });
  const added = await queue.add({ operation: 'flow.generation.submit', payload: { prompt: 'scene' }, label: 'captcha scene' });
  const pausedPromise = untilSnapshot(queue, pausedOnBlocker);
  await queue.start();
  const snapshot = await pausedPromise;
  const job = snapshot.jobs.find(item => item.id === added.id);
  assert.equal(job.status, 'failed');
  assert.equal(job.errorCode, 'FLOW_UNUSUAL_ACTIVITY');
  assert.equal(snapshot.attention.jobId, added.id);
  assert.equal(snapshot.attention.code, 'FLOW_UNUSUAL_ACTIVITY');
  // The budget is spent on resume, not when the failure lands.
  assert.equal(job.captchaResubmits, 0);
  await queue.stop();
});

test('resume requeues a captcha-blocked job once at the batch tail with captchaResubmits = 1', async () => {
  const attempts = [];
  let captchaAttempts = 0;
  const queue = makeQueue(async job => {
    attempts.push(job.label);
    if (job.label === 'captcha scene') {
      captchaAttempts++;
      if (captchaAttempts === 1) throw captchaError();
    }
    return { completed: true };
  });
  const jobs = await queue.addBatch([
    { operation: 'flow.generation.submit', payload: { prompt: 'one' }, label: 'captcha scene' },
    { operation: 'flow.generation.submit', payload: { prompt: 'two' }, label: 'scene two' },
    { operation: 'flow.generation.submit', payload: { prompt: 'three' }, label: 'scene three' },
  ]);
  const pausedPromise = untilSnapshot(queue, pausedOnBlocker);
  await queue.start();
  const paused = await pausedPromise;
  assert.equal(paused.attention.jobId, jobs[0].id);
  // Simulate the user solving the captcha on the Flow tab, then resuming.
  const drainedPromise = untilSnapshot(queue, drained);
  await queue.resume();
  const settled = await drainedPromise;
  assert.deepEqual(attempts, ['captcha scene', 'scene two', 'scene three', 'captcha scene'],
    'the resubmitted job must run after every job that was already queued');
  const job = settled.jobs.find(item => item.id === jobs[0].id);
  assert.equal(job.status, 'completed');
  assert.equal(job.captchaResubmits, 1);
  assert.equal(settled.jobs.find(item => item.id === jobs[1].id).captchaResubmits, 0);
});

test('a second identical captcha failure gets no further automatic resubmit', async () => {
  const attempts = [];
  const queue = makeQueue(async job => {
    attempts.push(job.label);
    if (job.label === 'captcha scene') throw captchaError();
    return { completed: true };
  });
  const jobs = await queue.addBatch([
    { operation: 'flow.generation.submit', payload: { prompt: 'one' }, label: 'captcha scene' },
    { operation: 'flow.generation.submit', payload: { prompt: 'two' }, label: 'scene two' },
  ]);
  const captchaJob = jobs[0];
  const firstPausePromise = untilSnapshot(queue, pausedOnBlocker);
  await queue.start();
  await firstPausePromise;

  // First resume: the one bounded automatic resubmit, at the tail — scene
  // two runs first, then the captcha job fails identically and pauses again.
  const secondPausePromise = untilSnapshot(queue, pausedOnBlocker);
  await queue.resume();
  const pausedAgain = await secondPausePromise;
  const afterSecond = pausedAgain.jobs.find(item => item.id === captchaJob.id);
  assert.equal(afterSecond.status, 'failed');
  assert.equal(afterSecond.captchaResubmits, 1, 'the counter increments on the automatic resubmit, not on failure');
  assert.deepEqual(attempts, ['captcha scene', 'scene two', 'captcha scene']);

  // A fresh pending job arrives behind the paused queue. The next resume is
  // over the cap, so the manual attention flow applies: the blocked job is
  // retried from the front (today's page-blocker behavior), NOT moved to the
  // tail again, and the counter stays at the cap.
  const late = await queue.add({ operation: 'flow.generation.submit', payload: { prompt: 'late' }, label: 'late scene' });
  const thirdPausePromise = untilSnapshot(queue, pausedOnBlocker);
  await queue.resume();
  const pausedThird = await thirdPausePromise;
  assert.deepEqual(attempts, ['captcha scene', 'scene two', 'captcha scene', 'captcha scene'],
    'over the cap, resume must retry the blocked job before later pending jobs (manual flow), not requeue it at the tail');
  assert.equal(pausedThird.jobs.find(item => item.id === late.id).status, 'pending');
  const finalSnapshot = await queue.stop();
  assert.equal(finalSnapshot.jobs.find(item => item.id === captchaJob.id).captchaResubmits, 1,
    'the automatic-resubmit budget is never exceeded');
});

test('the captcha resubmit budget survives a service-worker restart', async () => {
  const storage = memoryStorage();
  const attempts = [];
  const runner = async job => {
    attempts.push(job.label);
    if (job.label === 'captcha scene') throw captchaError();
    return { completed: true };
  };
  const first = makeQueue(runner, storage);
  const jobs = await first.addBatch([
    { operation: 'flow.generation.submit', payload: { prompt: 'one' }, label: 'captcha scene' },
    { operation: 'flow.generation.submit', payload: { prompt: 'two' }, label: 'scene two' },
  ]);
  const firstPausePromise = untilSnapshot(first, pausedOnBlocker);
  await first.start();
  await firstPausePromise;
  const secondPausePromise = untilSnapshot(first, pausedOnBlocker);
  await first.resume();
  await secondPausePromise;
  assert.deepEqual(attempts, ['captcha scene', 'scene two', 'captcha scene']);

  // A fresh queue over the same storage = the worker restarted while paused.
  const restarted = makeQueue(runner, storage);
  const restored = await restarted.ready;
  const restoredJob = restored.jobs.find(item => item.id === jobs[0].id);
  assert.equal(restored.isPaused, true);
  assert.equal(restored.attention?.type, 'flow-page-blocked');
  assert.equal(restoredJob.captchaResubmits, 1, 'the persisted counter must survive the restart');

  // Resuming the restarted queue must NOT grant a fresh automatic resubmit:
  // the manual flow retries the blocked job first and the counter stays put.
  const late = await restarted.add({ operation: 'flow.generation.submit', payload: { prompt: 'late' }, label: 'late scene' });
  const pausedPromise = untilSnapshot(restarted, pausedOnBlocker);
  await restarted.resume();
  const paused = await pausedPromise;
  assert.equal(paused.jobs.find(item => item.id === jobs[0].id).captchaResubmits, 1);
  assert.equal(paused.jobs.find(item => item.id === late.id).status, 'pending',
    'manual-path resume retries the blocked job before later pending jobs');
  assert.deepEqual(attempts, ['captcha scene', 'scene two', 'captcha scene', 'captcha scene']);
  await restarted.stop();
});

test('a non-captcha page-blocked job keeps the existing resume path (front retry, no counter use)', async () => {
  const attempts = [];
  let blockedAttempts = 0;
  const queue = makeQueue(async job => {
    attempts.push(job.label);
    if (job.label === 'blocked scene') {
      blockedAttempts++;
      if (blockedAttempts === 1) {
        throw Object.assign(new Error('Flow is not ready.'), { code: 'FLOW_NOT_READY', retryable: false, outcomeUnknown: false });
      }
    }
    return { completed: true };
  });
  const jobs = await queue.addBatch([
    { operation: 'flow.generation.submit', payload: { prompt: 'one' }, label: 'blocked scene' },
    { operation: 'flow.generation.submit', payload: { prompt: 'two' }, label: 'scene two' },
  ]);
  const pausedPromise = untilSnapshot(queue, pausedOnBlocker);
  await queue.start();
  await pausedPromise;
  const drainedPromise = untilSnapshot(queue, drained);
  await queue.resume();
  const settled = await drainedPromise;
  assert.deepEqual(attempts, ['blocked scene', 'blocked scene', 'scene two'],
    'a non-captcha blocker is retried before later jobs on resume, exactly as today');
  const job = settled.jobs.find(item => item.id === jobs[0].id);
  assert.equal(job.status, 'completed');
  assert.equal(job.captchaResubmits, 0, 'the captcha budget is only spent on captcha-classified jobs');
});
