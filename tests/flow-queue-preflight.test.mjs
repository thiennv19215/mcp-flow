import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { FlowJobQueue } from '../extension/src/background/flow-job-queue.js';
import { validateFlowJobPayloads } from '../extension/src/background/flow-queue-preflight.js';

const registry = JSON.parse(readFileSync(new URL('../flow-model-capabilities.json', import.meta.url), 'utf8'));

function memoryStorage() {
  const data = {};
  return {
    data,
    async get(key) { return { [key]: data[key] }; },
    async set(entries) { Object.assign(data, entries); },
  };
}

function queueWithRegistry(loadCapabilityRegistry = async () => registry) {
  return new FlowJobQueue(async () => ({ completed: true }), {
    storage: memoryStorage(),
    minDelayMs: 0,
    maxDelayMs: 0,
    loadCapabilityRegistry,
  });
}

const videoJob = (payload = {}) => ({
  operation: 'flow.generation.submit',
  payload: { type: 'video', prompt: 'a clip', model: 'omni 1.1 flash', duration: 8, resolution: '720p', aspect_ratio: '9:16', attachments: [], ...payload },
});

test('a valid image and video batch passes preflight and is queued whole', async () => {
  const queue = queueWithRegistry();
  const added = await queue.addBatch([
    { operation: 'flow.generation.submit', payload: { type: 'image', prompt: 'a still', model: 'nano banana', aspect_ratio: '1:1', attachments: [] } },
    videoJob(),
    videoJob({ model: 'veo 3.1 fast', duration: 8, resolution: undefined }),
  ]);
  assert.equal(added.length, 3);
  const snapshot = await queue.snapshot();
  assert.equal(snapshot.jobs.length, 3);
});

test('one impossible job fails the whole batch atomically, before anything is queued', async () => {
  const queue = queueWithRegistry();
  await assert.rejects(
    queue.addBatch([
      videoJob(),
      videoJob({ duration: 5 }), // Omni offers 4/6/8/10 only
      videoJob({ model: 'veo 3.1', duration: 8 }),
    ]),
    error => error.code === 'FLOW_QUEUE_PREFLIGHT_DURATION' || error.code === 'FLOW_QUEUE_BATCH_PREFLIGHT_FAILED');
  const snapshot = await queue.snapshot();
  assert.equal(snapshot.jobs.length, 0, 'no job from the rejected batch entered the queue');
});

test('frames combined with ingredient references is rejected at admission', async () => {
  const queue = queueWithRegistry();
  await assert.rejects(
    queue.add(videoJob({ mode: 'frames', firstFrame: { assetName: 'asset:a' }, attachments: [{ assetName: 'asset:b' }] })),
    error => error.code === 'FLOW_QUEUE_PREFLIGHT_FRAMES_CONFLICT');
});

test('reference cap and image/video setting misuse are rejected at admission', async () => {
  const queue = queueWithRegistry();
  await assert.rejects(
    queue.add(videoJob({ attachments: [{}, {}, {}, {}] })),
    error => error.code === 'FLOW_QUEUE_PREFLIGHT_REFERENCES');
  await assert.rejects(
    queue.add({ operation: 'flow.generation.submit', payload: { type: 'image', prompt: 'x', duration: 8 } }),
    error => error.code === 'FLOW_QUEUE_PREFLIGHT_VIDEO_SETTINGS');
  await assert.rejects(
    queue.add(videoJob({ model: 'veo 3.1 quality', duration: 6, resolution: undefined })),
    error => error.code === 'FLOW_QUEUE_PREFLIGHT_DURATION');
});

test('non-generation operations and unknown models are left to their own validators', async () => {
  const queue = queueWithRegistry();
  const edit = await queue.add({ operation: 'flow.edit.run', payload: { params: { prompt: 'edit' } } });
  assert.equal(edit.status, 'pending');
  const unknownModel = await queue.add(videoJob({ model: 'some future model', duration: 7, resolution: '1080p' }));
  assert.equal(unknownModel.status, 'pending');
});

test('preflight is skipped, not fatal, when the registry cannot be loaded', async () => {
  const queue = queueWithRegistry(async () => { throw new Error('no registry'); });
  const job = await queue.add(videoJob({ duration: 5 }));
  assert.equal(job.status, 'pending');
});

test('validator reports every offending job index in a mixed batch', () => {
  const problems = validateFlowJobPayloads([
    { operation: 'flow.generation.submit', payload: { type: 'video', model: 'omni 1.1 flash', duration: 5 } },
    { operation: 'flow.generation.submit', payload: { type: 'video', model: 'omni 1.1 flash', duration: 8 } },
    { operation: 'flow.generation.submit', payload: { type: 'video', model: 'veo 3.1', aspect_ratio: '1:1' } },
  ], registry);
  assert.deepEqual(problems.map(problem => problem.index), [0, 2]);
});
