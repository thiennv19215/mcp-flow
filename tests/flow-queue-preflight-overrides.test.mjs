import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { FlowJobQueue } from '../extension/src/background/flow-job-queue.js';
import { validateFlowJobPayloads } from '../extension/src/background/flow-queue-preflight.js';

// FEAT-03: per-item settings overrides + admission completion.
// A job may carry payload.overrides — a whitelisted subset of its own
// settings snapshot (the payload's top-level fields, with video_settings
// as fallback). Route-defining fields (media type, frames flag, input
// type) may be restated but never changed; model/ratio/quantity/duration/
// resolution merge over the snapshot and the merged settings are what the
// capability registry validates. The batch-level rules (chain quantity,
// ref pool, pending-upload exact set) read the whole submission.

const registry = JSON.parse(readFileSync(new URL('../flow-model-capabilities.json', import.meta.url), 'utf8'));

// A model that OFFERS several durations but FORCES one of them: the tier
// list alone cannot express the forcing, which is what fixedDuration is.
const forcedRegistry = {
  version: 1,
  defaults: { maxReferences: 3, maxPromptLength: null },
  models: [
    {
      match: ['forcecam'],
      types: ['video'],
      durations: [4, 6, 8, 10],
      fixedDuration: 8,
      resolutions: [],
      aspectRatios: ['16:9', '9:16'],
      maxReferences: 3,
      supportsFrames: true,
    },
  ],
};

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

const videoJob = (payload = {}, extra = {}) => ({
  operation: 'flow.generation.submit',
  payload: { type: 'video', prompt: 'a clip', model: 'omni 1.1 flash', duration: 8, resolution: '720p', aspect_ratio: '9:16', attachments: [], ...payload },
  ...extra,
});

const codes = (problems) => problems.map(problem => problem.code);

// --- overrides: whitelist -------------------------------------------------

test('an unknown override key is rejected with its specific code, naming the key', () => {
  const problems = validateFlowJobPayloads([
    videoJob({ overrides: { turboMode: true } }),
  ], registry);
  assert.deepEqual(codes(problems), ['FLOW_QUEUE_PREFLIGHT_OVERRIDE_KEY']);
  assert.equal(problems[0].index, 0);
  assert.match(problems[0].message, /turboMode/);
});

test('a non-object overrides value is rejected instead of ignored', () => {
  const problems = validateFlowJobPayloads([
    videoJob({ overrides: 'faster' }),
  ], registry);
  assert.deepEqual(codes(problems), ['FLOW_QUEUE_PREFLIGHT_OVERRIDE_KEY']);
});

test('an empty overrides object changes nothing', () => {
  const problems = validateFlowJobPayloads([videoJob({ overrides: {} })], registry);
  assert.deepEqual(problems, []);
});

// --- overrides: route conflicts -------------------------------------------

test('an override that changes the media type is a route conflict', () => {
  const problems = validateFlowJobPayloads([
    videoJob({ overrides: { type: 'image' } }),
  ], registry);
  assert.deepEqual(codes(problems), ['FLOW_QUEUE_PREFLIGHT_ROUTE_CONFLICT']);
});

test('an override that turns frames mode on is a route conflict', () => {
  for (const overrides of [{ mode: 'frames' }, { frames: true }]) {
    const problems = validateFlowJobPayloads([videoJob({ overrides })], registry);
    assert.deepEqual(codes(problems), ['FLOW_QUEUE_PREFLIGHT_ROUTE_CONFLICT'], JSON.stringify(overrides));
  }
});

test('an override that introduces an input type is a route conflict', () => {
  const problems = validateFlowJobPayloads([
    videoJob({ overrides: { inputType: 'image' } }),
  ], registry);
  assert.deepEqual(codes(problems), ['FLOW_QUEUE_PREFLIGHT_ROUTE_CONFLICT']);
});

test('restating the snapshot route in an override is a harmless no-op', () => {
  const problems = validateFlowJobPayloads([
    videoJob({ overrides: { type: 'video' } }),
    videoJob({ mode: 'frames', firstFrame: { assetName: 'asset:a' }, overrides: { mode: 'frames', frames: true } }),
  ], registry);
  assert.deepEqual(problems, []);
});

// --- overrides: mergeable fields ------------------------------------------

test('model/ratio/quantity/duration overrides merge and are validated as merged', () => {
  // Merged model (veo 3.1 fast: durations [8], fixed 8) + snapshot duration 8 → fine.
  // (The base fixture's 720p is unset: the veo rules offer no resolutions,
  // exactly as the pre-existing validator already enforced.)
  assert.deepEqual(validateFlowJobPayloads([
    videoJob({ resolution: undefined, overrides: { model: 'veo 3.1 fast' } }),
  ], registry), []);
  // Merged duration is validated against the MERGED model's tier list.
  assert.deepEqual(codes(validateFlowJobPayloads([
    videoJob({ resolution: undefined, overrides: { model: 'veo 3.1 fast', duration: 5 } }),
  ], registry)), ['FLOW_QUEUE_PREFLIGHT_DURATION']);
  // Ratio override via the canonical name and via the `ratio` alias.
  assert.deepEqual(codes(validateFlowJobPayloads([
    videoJob({ overrides: { aspectRatio: '1:1' } }),
  ], registry)), ['FLOW_QUEUE_PREFLIGHT_ASPECT_RATIO']);
  assert.deepEqual(validateFlowJobPayloads([
    videoJob({ overrides: { ratio: '16:9' } }),
  ], registry), []);
  // Duration override inside the tier list passes; outside is rejected.
  assert.deepEqual(validateFlowJobPayloads([
    videoJob({ overrides: { duration: 6 } }),
  ], registry), []);
  assert.deepEqual(codes(validateFlowJobPayloads([
    videoJob({ overrides: { duration: 5 } }),
  ], registry)), ['FLOW_QUEUE_PREFLIGHT_DURATION']);
  // Quantity override merges, then the provider range applies.
  assert.deepEqual(validateFlowJobPayloads([
    videoJob({ overrides: { quantity: 3 } }),
  ], registry), []);
  assert.deepEqual(codes(validateFlowJobPayloads([
    videoJob({ overrides: { quantity: 9 } }),
  ], registry)), ['FLOW_QUEUE_PREFLIGHT_QUANTITY']);
});

test('a snapshot quantity outside the provider range is rejected without any override', () => {
  const problems = validateFlowJobPayloads([videoJob({ quantity: 9 })], registry);
  assert.deepEqual(codes(problems), ['FLOW_QUEUE_PREFLIGHT_QUANTITY']);
});

// --- chain quantity ---------------------------------------------------------

test('a chain batch rejects any item whose quantity is not exactly 1', () => {
  const head = videoJob({ quantity: 2 }, { id: 'chain-1' });
  const tail = videoJob({}, { id: 'chain-2', metadata: { dependsOnId: 'chain-1' } });
  const problems = validateFlowJobPayloads([head, tail], registry);
  assert.deepEqual(codes(problems), ['FLOW_QUEUE_PREFLIGHT_CHAIN_QUANTITY']);
  assert.equal(problems[0].index, 0, 'the chain head participates because the tail depends on it');
});

test('a chain item quantity arriving via override is still rejected', () => {
  const head = videoJob({}, { id: 'chain-1' });
  const tail = videoJob({ overrides: { quantity: 2 } }, { id: 'chain-2', metadata: { dependsOnId: 'chain-1' } });
  const problems = validateFlowJobPayloads([head, tail], registry);
  assert.deepEqual(codes(problems), ['FLOW_QUEUE_PREFLIGHT_CHAIN_QUANTITY']);
  assert.equal(problems[0].index, 1);
});

test('a chain batch with quantities of 1 (or unset) passes', () => {
  const head = videoJob({ quantity: 1 }, { id: 'chain-1' });
  const tail = videoJob({}, { id: 'chain-2', metadata: { dependsOnId: 'chain-1' } });
  assert.deepEqual(validateFlowJobPayloads([head, tail], registry), []);
});

test('quantity 2 is fine for a non-chain batch', () => {
  assert.deepEqual(validateFlowJobPayloads([videoJob({ quantity: 2 }), videoJob({})], registry), []);
});

// --- frames first-frame rule ------------------------------------------------

test('a frames item missing its first frame is rejected, naming the item', () => {
  const problems = validateFlowJobPayloads([
    videoJob({ mode: 'frames', firstFrame: { assetName: 'asset:a' } }),
    videoJob({ mode: 'frames', lastFrame: { assetName: 'asset:b' } }),
  ], registry);
  assert.deepEqual(codes(problems), ['FLOW_QUEUE_PREFLIGHT_FRAMES_FIRST_FRAME']);
  assert.equal(problems[0].index, 1);
  assert.match(problems[0].message, /Job 2/);
});

test('a chain-from-last-frame item after the first is exempt from the first-frame rule', () => {
  const head = videoJob({ mode: 'frames', firstFrame: { assetName: 'asset:a' }, lastFrame: { assetName: 'asset:b' } }, { id: 'frame-1' });
  const tail = videoJob({ mode: 'frames', lastFrame: { assetName: 'asset:c' } }, { id: 'frame-2', metadata: { dependsOnId: 'frame-1' } });
  assert.deepEqual(validateFlowJobPayloads([head, tail], registry), []);
});

test('the first item of a batch gets no chain exemption', () => {
  const problems = validateFlowJobPayloads([
    videoJob({ mode: 'frames', lastFrame: { assetName: 'asset:b' } }),
  ], registry);
  assert.deepEqual(codes(problems), ['FLOW_QUEUE_PREFLIGHT_FRAMES_FIRST_FRAME']);
  assert.equal(problems[0].index, 0);
});

// --- batch ref pool -----------------------------------------------------------

test('a referenced key missing from the declared batch ref pool is rejected', () => {
  const problems = validateFlowJobPayloads([
    videoJob({ refPool: ['asset:a', 'asset:b'], attachments: [{ assetName: 'asset:a' }] }),
    videoJob({ attachments: [{ assetName: 'asset:c' }] }),
  ], registry);
  assert.deepEqual(codes(problems), ['FLOW_QUEUE_PREFLIGHT_REF_POOL']);
  assert.equal(problems[0].index, 1);
  // "asset:c" is the dialect's prefixed spelling of the asset named "c"
  // (the same asset: convention flow-ref-preflight uses).
  assert.match(problems[0].message, /reference "c"/);
});

test('frame refs are pool refs too, and a fully covered batch passes', () => {
  const problems = validateFlowJobPayloads([
    videoJob({ mode: 'frames', firstFrame: { assetName: 'asset:a' }, refPool: [{ assetName: 'asset:a' }] }),
    videoJob({ attachments: ['asset:a'] }),
  ], registry);
  assert.deepEqual(problems, []);
});

test('with no pool declared anywhere, inline refs stay unchecked (unchanged behavior)', () => {
  assert.deepEqual(validateFlowJobPayloads([
    videoJob({ attachments: [{ assetName: 'asset:anything' }] }),
    videoJob({ attachments: [{ assetName: 'asset:else' }] }),
  ], registry), []);
});

test('staged (transferId) attachments are pending uploads, not pool refs', () => {
  const problems = validateFlowJobPayloads([
    videoJob({ refPool: ['asset:a'], attachments: [{ transferId: 't-1', assetName: 'local.png' }] }),
  ], registry);
  assert.deepEqual(problems, []);
});

// --- model-forced duration ----------------------------------------------------

test('a duration the model forces must equal the chosen duration', () => {
  // 6s is in forcecam's tier list, so only the forced-duration rule can reject it.
  const problems = validateFlowJobPayloads([
    { operation: 'flow.generation.submit', payload: { type: 'video', prompt: 'x', model: 'forcecam', duration: 6 } },
  ], forcedRegistry);
  assert.deepEqual(codes(problems), ['FLOW_QUEUE_PREFLIGHT_FORCED_DURATION']);
  assert.deepEqual(validateFlowJobPayloads([
    { operation: 'flow.generation.submit', payload: { type: 'video', prompt: 'x', model: 'forcecam', duration: 8 } },
  ], forcedRegistry), []);
});

test('a forced duration arriving via override is checked against the merged model', () => {
  const problems = validateFlowJobPayloads([
    { operation: 'flow.generation.submit', payload: { type: 'video', prompt: 'x', model: 'forcecam', duration: 8, overrides: { duration: 10 } } },
  ], forcedRegistry);
  assert.deepEqual(codes(problems), ['FLOW_QUEUE_PREFLIGHT_FORCED_DURATION']);
});

// --- pending uploads: exact set at admission ----------------------------------

test('a declared pending-upload set must match the referenced staged set exactly', () => {
  const staged = { transferId: 't-1', assetName: 'local.png' };
  // Declared set names a transfer nothing references → not exact.
  assert.deepEqual(codes(validateFlowJobPayloads([
    videoJob({ attachments: [staged], pendingRefs: ['t-1', 't-2'] }),
  ], registry)), ['FLOW_QUEUE_PREFLIGHT_PENDING_REFS']);
  // Referenced staged transfer missing from the declared set → not exact.
  assert.deepEqual(codes(validateFlowJobPayloads([
    videoJob({ attachments: [staged], pendingRefs: ['t-1'] }),
    videoJob({ attachments: [{ transferId: 't-2', assetName: 'other.png' }] }),
  ], registry)), ['FLOW_QUEUE_PREFLIGHT_PENDING_REFS']);
  // Exact declaration passes; no declaration at all stays inert.
  assert.deepEqual(validateFlowJobPayloads([
    videoJob({ attachments: [staged], pendingRefs: ['t-1'] }),
  ], registry), []);
  assert.deepEqual(validateFlowJobPayloads([
    videoJob({ attachments: [staged] }),
  ], registry), []);
});

// --- pins: non-overridden admission is unchanged -------------------------------

test('pins: pre-existing admission outcomes are unchanged when no overrides are present', () => {
  const problems = validateFlowJobPayloads([
    { operation: 'flow.generation.submit', payload: { type: 'video', model: 'omni 1.1 flash', duration: 5 } },
    { operation: 'flow.generation.submit', payload: { type: 'video', model: 'omni 1.1 flash', duration: 8 } },
    { operation: 'flow.generation.submit', payload: { type: 'video', model: 'veo 3.1', aspect_ratio: '1:1' } },
  ], registry);
  assert.deepEqual(problems.map(problem => problem.index), [0, 2]);
  assert.deepEqual(codes(problems), ['FLOW_QUEUE_PREFLIGHT_DURATION', 'FLOW_QUEUE_PREFLIGHT_ASPECT_RATIO']);
});

test('queue: a batch carrying a route-conflict override is rejected atomically', async () => {
  const queue = queueWithRegistry();
  await assert.rejects(
    queue.addBatch([
      videoJob({ overrides: { type: 'image' } }),
      videoJob(),
    ]),
    error => error.code === 'FLOW_QUEUE_PREFLIGHT_ROUTE_CONFLICT');
  const snapshot = await queue.snapshot();
  assert.equal(snapshot.jobs.length, 0, 'no job from the rejected batch entered the queue');
});
