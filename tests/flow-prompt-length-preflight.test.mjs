import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { FlowJobQueue } from '../extension/src/background/flow-job-queue.js';
import { validateFlowJobPayloads } from '../extension/src/background/flow-queue-preflight.js';

// VID-07: prompt-length admission guard. The capability registry gains an
// optional `maxPromptLength` (per-model rule first, `defaults` fallback,
// mirroring `maxReferences`). Absent/invalid value = no check at all, so
// admission behaves exactly as before until a limit is configured. Length
// is the JS string length of the job's final `payload.prompt` — the exact
// string the content side submits — and every job in a batch is measured
// on its own prompt, never on a sum.

const shippedRegistry = JSON.parse(readFileSync(new URL('../flow-model-capabilities.json', import.meta.url), 'utf8'));

// Clone the shipped registry and stamp `maxPromptLength` onto the slots a
// test asks for, so fixtures keep every other rule (durations, ratios…)
// realistic and only the new field varies.
function registryWithLimits({ defaultsLimit, omniLimit, imageLimit } = {}) {
  const registry = JSON.parse(JSON.stringify(shippedRegistry));
  if (defaultsLimit !== undefined) registry.defaults.maxPromptLength = defaultsLimit;
  for (const rule of registry.models) {
    if (rule.match.includes('omni') && omniLimit !== undefined) rule.maxPromptLength = omniLimit;
    if (rule.types?.includes('image') && imageLimit !== undefined) rule.maxPromptLength = imageLimit;
  }
  return registry;
}

function memoryStorage() {
  const data = {};
  return {
    data,
    async get(key) { return { [key]: data[key] }; },
    async set(entries) { Object.assign(data, entries); },
  };
}

function queueWithRegistry(registry, runner = async () => ({ completed: true })) {
  return new FlowJobQueue(runner, {
    storage: memoryStorage(),
    minDelayMs: 0,
    maxDelayMs: 0,
    loadCapabilityRegistry: async () => registry,
  });
}

const videoJob = (payload = {}) => ({
  operation: 'flow.generation.submit',
  payload: { type: 'video', prompt: 'a clip', model: 'omni 1.1 flash', duration: 8, resolution: '720p', aspect_ratio: '9:16', attachments: [], ...payload },
});

test('a video job whose prompt exceeds the per-model limit is flagged at admission', () => {
  const registry = registryWithLimits({ omniLimit: 10 });
  const problems = validateFlowJobPayloads([videoJob({ prompt: 'x'.repeat(11) })], registry);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].index, 0);
  assert.equal(problems[0].code, 'FLOW_QUEUE_PREFLIGHT_PROMPT_LENGTH');
});

test('prompts at or under the limit pass', () => {
  const registry = registryWithLimits({ omniLimit: 10 });
  assert.deepEqual(validateFlowJobPayloads([videoJob({ prompt: 'x'.repeat(10) })], registry), [],
    'a prompt exactly at the limit is allowed');
  assert.deepEqual(validateFlowJobPayloads([videoJob({ prompt: 'short' })], registry), []);
  assert.deepEqual(validateFlowJobPayloads([videoJob({ prompt: '' })], registry), [],
    'an empty prompt is not this guard\'s problem');
});

test('length is the JS string length of the final prompt', () => {
  const registry = registryWithLimits({ omniLimit: 10 });
  // '🎬' is one visible glyph but two UTF-16 code units; six of them are
  // length 12 in the string the content side submits, so the guard fires.
  const problems = validateFlowJobPayloads([videoJob({ prompt: '🎬'.repeat(6) })], registry);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].code, 'FLOW_QUEUE_PREFLIGHT_PROMPT_LENGTH');
});

test('an over-limit job is rejected by the queue and never enqueued', async () => {
  const registry = registryWithLimits({ omniLimit: 10 });
  let runnerCalls = 0;
  const queue = queueWithRegistry(registry, async () => { runnerCalls += 1; return { completed: true }; });
  await assert.rejects(
    queue.add(videoJob({ prompt: 'x'.repeat(11) })),
    error => error.code === 'FLOW_QUEUE_PREFLIGHT_PROMPT_LENGTH');
  const snapshot = await queue.snapshot();
  assert.equal(snapshot.jobs.length, 0, 'the doomed job never entered the queue');
  assert.equal(runnerCalls, 0, 'the runner (content side) never saw the job');
});

test('one over-limit prompt fails the whole batch atomically', async () => {
  const registry = registryWithLimits({ omniLimit: 10 });
  const queue = queueWithRegistry(registry);
  await assert.rejects(
    queue.addBatch([
      videoJob({ prompt: 'fine' }),
      videoJob({ prompt: 'x'.repeat(11) }),
    ]),
    error => error.code === 'FLOW_QUEUE_PREFLIGHT_PROMPT_LENGTH' || error.code === 'FLOW_QUEUE_BATCH_PREFLIGHT_FAILED');
  const snapshot = await queue.snapshot();
  assert.equal(snapshot.jobs.length, 0, 'no job from the rejected batch entered the queue');
});

test('each prompt in a batch is measured individually, never summed', () => {
  const registry = registryWithLimits({ omniLimit: 10 });
  const problems = validateFlowJobPayloads([
    videoJob({ prompt: 'x'.repeat(8) }),
    videoJob({ prompt: 'y'.repeat(8) }),
    videoJob({ prompt: 'z'.repeat(11) }),
  ], registry);
  assert.deepEqual(problems.map(problem => problem.index), [2],
    'two 8-char prompts do not add up to a violation; only the 11-char one is flagged');
});

test('the shipped registry carries no limit, so admission is unchanged', async () => {
  const hugePrompt = 'x'.repeat(200_000);
  assert.deepEqual(validateFlowJobPayloads([videoJob({ prompt: hugePrompt })], shippedRegistry), [],
    'no maxPromptLength anywhere in the shipped registry = no prompt check');
  const queue = queueWithRegistry(shippedRegistry);
  const job = await queue.add(videoJob({ prompt: hugePrompt }));
  assert.equal(job.status, 'pending');
});

test('a defaults-level limit applies when the model rule has none', () => {
  const registry = registryWithLimits({ defaultsLimit: 5 });
  const problems = validateFlowJobPayloads([videoJob({ prompt: 'x'.repeat(6) })], registry);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].code, 'FLOW_QUEUE_PREFLIGHT_PROMPT_LENGTH');
});

test('a per-model limit overrides the defaults limit', () => {
  const registry = registryWithLimits({ defaultsLimit: 5, omniLimit: 100 });
  assert.deepEqual(validateFlowJobPayloads([videoJob({ prompt: 'x'.repeat(50) })], registry), [],
    'the omni rule\'s own limit (100) governs omni jobs, not the defaults limit (5)');
  const veoProblems = validateFlowJobPayloads([
    { operation: 'flow.generation.submit', payload: { type: 'video', prompt: 'x'.repeat(6), model: 'veo 3.1', duration: 8, attachments: [] } },
  ], registry);
  assert.equal(veoProblems.length, 1, 'a model without its own limit falls back to defaults');
  assert.equal(veoProblems[0].code, 'FLOW_QUEUE_PREFLIGHT_PROMPT_LENGTH');
});

test('an unknown model is still bounded by a defaults-level limit', () => {
  const registry = registryWithLimits({ defaultsLimit: 5 });
  const problems = validateFlowJobPayloads([videoJob({ model: 'some future model', prompt: 'x'.repeat(6), duration: 7, resolution: '1080p' })], registry);
  assert.deepEqual(problems.map(problem => problem.code), ['FLOW_QUEUE_PREFLIGHT_PROMPT_LENGTH'],
    'unknown models skip model-rule checks but a configured defaults limit still applies');
});

test('the guard covers image jobs whose rule carries a limit', () => {
  const registry = registryWithLimits({ imageLimit: 4 });
  const problems = validateFlowJobPayloads([
    { operation: 'flow.generation.submit', payload: { type: 'image', prompt: 'x'.repeat(5), model: 'nano banana', aspect_ratio: '1:1', attachments: [] } },
  ], registry);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].code, 'FLOW_QUEUE_PREFLIGHT_PROMPT_LENGTH');
});

test('non-generation operations are untouched by the guard', async () => {
  const registry = registryWithLimits({ defaultsLimit: 1, omniLimit: 1, imageLimit: 1 });
  assert.deepEqual(validateFlowJobPayloads([
    { operation: 'flow.edit.run', payload: { params: { prompt: 'x'.repeat(500) } } },
  ], registry), []);
  const queue = queueWithRegistry(registry);
  const job = await queue.add({ operation: 'flow.edit.run', payload: { params: { prompt: 'x'.repeat(500) } } });
  assert.equal(job.status, 'pending');
});

test('invalid limit values disable the check instead of breaking admission', () => {
  for (const badValue of [0, -5, '100', null, true]) {
    const registry = registryWithLimits({ omniLimit: badValue });
    assert.deepEqual(validateFlowJobPayloads([videoJob({ prompt: 'x'.repeat(500) })], registry), [],
      `maxPromptLength ${JSON.stringify(badValue)} must not activate (or crash) the guard`);
  }
});
