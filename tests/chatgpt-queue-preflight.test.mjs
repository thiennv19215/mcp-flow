import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { FlowJobQueue } from '../extension/src/background/flow-job-queue.js';
import { validateFlowJobPayloads } from '../extension/src/background/flow-queue-preflight.js';
import { parseChatGptCapabilityRegistry } from '../extension/src/background/chatgpt-capabilities.js';
import {
  CHATGPT_GENERATION_OPERATION,
  isChatGptOperation,
  validateChatGptJobPayloads,
} from '../extension/src/background/chatgpt-queue-preflight.js';

// GPT-09: ChatGPT queue preflight. ChatGPT jobs are admitted by their own
// validator, dispatched by operation prefix alongside the Flow validator:
// prompt required, ratio in the capability enum, refs <= the registry cap
// and image-payload-only, each violation with its own per-job problem
// code. All limits come from the GPT-01 capability registry (never
// hard-coded), and batch atomicity is inherited from addBatch.

const chatGptRegistry = parseChatGptCapabilityRegistry(
  JSON.parse(readFileSync(new URL('../chatgpt-model-capabilities.json', import.meta.url), 'utf8')),
);
const flowRegistry = JSON.parse(readFileSync(new URL('../flow-model-capabilities.json', import.meta.url), 'utf8'));

// A stricter registry than the shipped one: model rule narrows the ratio
// enum to 1:1 and the ref cap to 1, defaults cap refs at 2. Proves the
// validator reads its limits from the registry instead of constants.
const strictRegistry = parseChatGptCapabilityRegistry({
  version: 1,
  defaults: {
    maxRefImages: 2,
    supportedRatios: ['1:1', '16:9'],
    defaultRatio: '1:1',
    ratioSemantics: { '1:1': 'square', '16:9': 'widescreen', '9:16': 'story', '4:3': 'landscape', '3:4': 'portrait' },
  },
  capabilities: {},
  models: [{ match: ['gpt-image-1'], types: ['image'], aspectRatios: ['1:1'], maxRefImages: 1 }],
});

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX///+/v7+jQ3Y5AAAADklEQVQI12P4AIX8EAgALgAD/aNpbtEAAAAASUVORK5CYII=';

const imageRef = (overrides = {}) => ({ name: 'ref.png', type: 'image/png', base64: PNG_BASE64, ...overrides });

const chatGptJob = (payload = {}) => ({
  operation: 'chatgpt.generation.submit',
  payload: { prompt: 'a cat astronaut', ratio: '16:9', model: 'gpt-4o', attachments: [imageRef()], ...payload },
});

const codesOf = problems => problems.map(problem => problem.code);

function memoryStorage() {
  const data = {};
  return {
    data,
    async get(key) { return { [key]: data[key] }; },
    async set(entries) { Object.assign(data, entries); },
  };
}

function queueWithRegistries({ flowLoader, chatGptLoader } = {}) {
  return new FlowJobQueue(async () => ({ completed: true }), {
    storage: memoryStorage(),
    minDelayMs: 0,
    maxDelayMs: 0,
    ...(flowLoader ? { loadCapabilityRegistry: flowLoader } : {}),
    ...(chatGptLoader ? { loadChatGptCapabilityRegistry: chatGptLoader } : {}),
  });
}

const bothLoaders = () => ({
  flowLoader: async () => flowRegistry,
  chatGptLoader: async () => chatGptRegistry,
});

const flowVideoJob = (payload = {}) => ({
  operation: 'flow.generation.submit',
  payload: { type: 'video', prompt: 'a clip', model: 'omni 1.1 flash', duration: 8, resolution: '720p', aspect_ratio: '9:16', attachments: [], ...payload },
});

// --- Operation dispatch -----------------------------------------------------

test('isChatGptOperation routes by the chatgpt. prefix only', () => {
  assert.equal(CHATGPT_GENERATION_OPERATION, 'chatgpt.generation.submit');
  assert.equal(isChatGptOperation('chatgpt.generation.submit'), true);
  assert.equal(isChatGptOperation('chatgpt.state'), true);
  assert.equal(isChatGptOperation('flow.generation.submit'), false);
  assert.equal(isChatGptOperation('chatgpt'), false);
  assert.equal(isChatGptOperation(''), false);
  assert.equal(isChatGptOperation(undefined), false);
  assert.equal(isChatGptOperation(null), false);
});

// --- Validator: the happy path ----------------------------------------------

test('a valid chatgpt job passes preflight', () => {
  assert.deepEqual(validateChatGptJobPayloads([chatGptJob()], chatGptRegistry), []);
  assert.deepEqual(validateChatGptJobPayloads([chatGptJob({ attachments: [] })], chatGptRegistry), []);
  assert.deepEqual(validateChatGptJobPayloads([chatGptJob({ ratio: undefined, model: undefined })], chatGptRegistry), []);
});

test('every accepted ref shape from the GPT-03 contract passes', () => {
  const refs = [
    imageRef(), // staged record: base64 + declared image type
    { fileId: 'file_1', base64: PNG_BASE64, name: 'a.png', type: 'image/png' }, // GPT-03 resolved ref
    { dataUrl: `data:image/png;base64,${PNG_BASE64}`, name: 'b.png' }, // data URL record
    { data_url: `data:image/jpeg;base64,${PNG_BASE64}` }, // snake_case data URL
    { bytes: [137, 80, 78, 71], type: 'image/png', name: 'c.png' }, // byte payload record
    { base64: PNG_BASE64 }, // payload with no declared type at all
    { base64: PNG_BASE64, type: 'application/octet-stream' }, // GPT-03 unknown-type placeholder
  ];
  for (const ref of refs) {
    assert.deepEqual(
      validateChatGptJobPayloads([chatGptJob({ attachments: [ref] })], chatGptRegistry),
      [],
      `ref shape should pass: ${JSON.stringify(Object.keys(ref))}`,
    );
  }
});

// --- Validator: prompt --------------------------------------------------------

test('a missing or blank prompt is rejected with the prompt code', () => {
  for (const payload of [{ prompt: undefined }, { prompt: '' }, { prompt: '   ' }, { prompt: 42 }]) {
    const problems = validateChatGptJobPayloads([chatGptJob(payload)], chatGptRegistry);
    assert.deepEqual(codesOf(problems), ['CHATGPT_QUEUE_PREFLIGHT_PROMPT']);
    assert.equal(problems[0].index, 0);
  }
});

// --- Validator: ratio ---------------------------------------------------------

test('a ratio outside the capability enum is rejected with the ratio code', () => {
  for (const ratio of ['21:9', '5:4', '2:1']) {
    const problems = validateChatGptJobPayloads([chatGptJob({ ratio })], chatGptRegistry);
    assert.deepEqual(codesOf(problems), ['CHATGPT_QUEUE_PREFLIGHT_RATIO'], `ratio ${ratio}`);
  }
});

test('ratio spellings and labels that normalize into the enum pass', () => {
  for (const ratio of ['16:9', '16x9', '16/9', '32:18', 'widescreen', '1:1', 'square', '9:16', '']) {
    assert.deepEqual(
      validateChatGptJobPayloads([chatGptJob({ ratio })], chatGptRegistry),
      [],
      `ratio ${JSON.stringify(ratio)} should pass`,
    );
  }
});

test('the ratio enum comes from the registry model rule, not the defaults', () => {
  // strictRegistry defaults allow 16:9, but the gpt-image-1 rule is 1:1-only.
  assert.deepEqual(
    codesOf(validateChatGptJobPayloads([chatGptJob({ model: 'gpt-image-1', ratio: '16:9' })], strictRegistry)),
    ['CHATGPT_QUEUE_PREFLIGHT_RATIO'],
  );
  assert.deepEqual(
    validateChatGptJobPayloads([chatGptJob({ model: 'gpt-image-1', ratio: '1:1' })], strictRegistry),
    [],
  );
  // A semantic label backed only by a ratio the rule excludes fails too.
  assert.deepEqual(
    codesOf(validateChatGptJobPayloads([chatGptJob({ model: 'gpt-image-1', ratio: 'widescreen' })], strictRegistry)),
    ['CHATGPT_QUEUE_PREFLIGHT_RATIO'],
  );
});

// --- Validator: references ----------------------------------------------------

test('more refs than the registry cap are rejected with the references code', () => {
  const six = Array.from({ length: 6 }, () => imageRef());
  assert.deepEqual(
    codesOf(validateChatGptJobPayloads([chatGptJob({ attachments: six })], chatGptRegistry)),
    ['CHATGPT_QUEUE_PREFLIGHT_REFERENCES'],
  );
  const five = Array.from({ length: 5 }, () => imageRef());
  assert.deepEqual(validateChatGptJobPayloads([chatGptJob({ attachments: five })], chatGptRegistry), []);
});

test('the ref cap comes from the registry (model rule first, then defaults)', () => {
  const two = [imageRef(), imageRef()];
  // Model rule cap is 1 (ratio pinned to the rule's only ratio so the cap
  // is the single violated rule).
  assert.deepEqual(
    codesOf(validateChatGptJobPayloads([chatGptJob({ model: 'gpt-image-1', ratio: '1:1', attachments: two })], strictRegistry)),
    ['CHATGPT_QUEUE_PREFLIGHT_REFERENCES'],
  );
  // Unknown model falls back to the defaults cap of 2: two pass, three fail.
  assert.deepEqual(validateChatGptJobPayloads([chatGptJob({ model: 'unknown', attachments: two })], strictRegistry), []);
  assert.deepEqual(
    codesOf(validateChatGptJobPayloads([chatGptJob({ model: 'unknown', attachments: [...two, imageRef()] })], strictRegistry)),
    ['CHATGPT_QUEUE_PREFLIGHT_REFERENCES'],
  );
});

test('a ref without an image payload is rejected with the payload code', () => {
  const payloadless = [
    'library-asset-42', // bare library ID — the library is a separate source
    { fileId: 'file_1', name: 'a.png' }, // ID-only record
    { type: 'image/png', name: 'a.png' }, // declared image, but carries no bytes
    { base64: '   ' }, // empty payload
    { dataUrl: 'data:image/png;base64,' }, // data URL with an empty body
    null,
  ];
  for (const ref of payloadless) {
    const problems = validateChatGptJobPayloads([chatGptJob({ attachments: [ref] })], chatGptRegistry);
    assert.deepEqual(codesOf(problems), ['CHATGPT_QUEUE_PREFLIGHT_REFERENCE_PAYLOAD'], `ref: ${JSON.stringify(ref)}`);
  }
});

test('a ref whose payload is not an image is rejected with the type code', () => {
  const nonImage = [
    imageRef({ type: 'video/mp4' }),
    { base64: PNG_BASE64, mimeType: 'application/pdf', name: 'doc.pdf' },
    { dataUrl: 'data:text/plain;base64,SGVsbG8=' },
    { base64: 'data:video/webm;base64,AAAA' },
  ];
  for (const ref of nonImage) {
    const problems = validateChatGptJobPayloads([chatGptJob({ attachments: [ref] })], chatGptRegistry);
    assert.deepEqual(codesOf(problems), ['CHATGPT_QUEUE_PREFLIGHT_REFERENCE_TYPE'], `ref: ${JSON.stringify(ref)}`);
  }
});

// --- Validator: scope of the checks -------------------------------------------

test('non-submit operations and foreign jobs are not validated here', () => {
  assert.deepEqual(validateChatGptJobPayloads([{ operation: 'chatgpt.state', payload: {} }], chatGptRegistry), []);
  assert.deepEqual(validateChatGptJobPayloads([flowVideoJob({ duration: 5 })], chatGptRegistry), []);
  assert.deepEqual(validateChatGptJobPayloads([chatGptJob({ prompt: '' })], null), []);
  assert.deepEqual(validateChatGptJobPayloads('not-an-array', chatGptRegistry), []);
});

test('problems carry the offending job index in a mixed list', () => {
  const problems = validateChatGptJobPayloads([
    chatGptJob(),
    chatGptJob({ prompt: '' }),
    chatGptJob(),
    chatGptJob({ ratio: '21:9' }),
  ], chatGptRegistry);
  assert.deepEqual(problems.map(problem => problem.index), [1, 3]);
  assert.deepEqual(codesOf(problems), ['CHATGPT_QUEUE_PREFLIGHT_PROMPT', 'CHATGPT_QUEUE_PREFLIGHT_RATIO']);
});

// --- Queue integration ----------------------------------------------------------

test('a valid chatgpt batch is queued whole through the queue preflight dispatch', async () => {
  const queue = queueWithRegistries(bothLoaders());
  const added = await queue.addBatch([chatGptJob(), chatGptJob({ ratio: '1:1' }), chatGptJob({ attachments: [] })]);
  assert.equal(added.length, 3);
  const snapshot = await queue.snapshot();
  assert.equal(snapshot.jobs.length, 3);
});

test('a 3-job batch with job 2 invalid queues nothing (atomic rejection)', async () => {
  const queue = queueWithRegistries(bothLoaders());
  await assert.rejects(
    queue.addBatch([chatGptJob(), chatGptJob({ ratio: '21:9' }), chatGptJob()]),
    error => {
      assert.equal(error.code, 'CHATGPT_QUEUE_PREFLIGHT_RATIO');
      assert.deepEqual(error.problems.map(problem => problem.index), [1]);
      return true;
    },
  );
  const snapshot = await queue.snapshot();
  assert.equal(snapshot.jobs.length, 0, 'no job from the rejected batch entered the queue');
});

test('a single invalid chatgpt add rejects with its specific code', async () => {
  const queue = queueWithRegistries(bothLoaders());
  await assert.rejects(queue.add(chatGptJob({ prompt: '  ' })), error => error.code === 'CHATGPT_QUEUE_PREFLIGHT_PROMPT');
  await assert.rejects(
    queue.add(chatGptJob({ attachments: [{ fileId: 'file_9' }] })),
    error => error.code === 'CHATGPT_QUEUE_PREFLIGHT_REFERENCE_PAYLOAD',
  );
  await assert.rejects(
    queue.add(chatGptJob({ attachments: Array.from({ length: 6 }, () => imageRef()) })),
    error => error.code === 'CHATGPT_QUEUE_PREFLIGHT_REFERENCES',
  );
});

test('mixed flow + chatgpt batches validate each job with its own validator', async () => {
  const queue = queueWithRegistries(bothLoaders());
  const added = await queue.addBatch([flowVideoJob(), chatGptJob()]);
  assert.equal(added.length, 2);
  // A Flow violation in a mixed batch reports Flow codes only, and stays atomic.
  await assert.rejects(
    queue.addBatch([chatGptJob(), flowVideoJob({ duration: 5 })]),
    error => {
      assert.ok(error.problems.every(problem => problem.code.startsWith('FLOW_QUEUE_PREFLIGHT')));
      return true;
    },
  );
  const snapshot = await queue.snapshot();
  assert.equal(snapshot.jobs.length, 2, 'the rejected mixed batch added nothing');
});

test('flow preflight behavior is unchanged when the chatgpt loader is also configured', async () => {
  const problems = validateFlowJobPayloads([flowVideoJob({ duration: 5 })], flowRegistry);
  assert.deepEqual(codesOf(problems), ['FLOW_QUEUE_PREFLIGHT_DURATION']);
  const queue = queueWithRegistries(bothLoaders());
  await assert.rejects(queue.add(flowVideoJob({ duration: 5 })), error => error.code === 'FLOW_QUEUE_PREFLIGHT_DURATION');
  const ok = await queue.add(flowVideoJob());
  assert.equal(ok.status, 'pending');
});

test('chatgpt preflight is skipped, not fatal, when its registry cannot be loaded', async () => {
  const queue = queueWithRegistries({
    flowLoader: async () => flowRegistry,
    chatGptLoader: async () => { throw new Error('no registry'); },
  });
  const job = await queue.add(chatGptJob({ ratio: '21:9' }));
  assert.equal(job.status, 'pending');
});

test('without an injected chatgpt registry loader, chatgpt jobs are admitted unchecked (Flow pattern)', async () => {
  const queue = queueWithRegistries({ flowLoader: async () => flowRegistry });
  const job = await queue.add(chatGptJob({ prompt: '' }));
  assert.equal(job.status, 'pending');
});

test('the chatgpt registry is only loaded when a submission carries a chatgpt job', async () => {
  let chatGptLoads = 0;
  const queue = queueWithRegistries({
    flowLoader: async () => flowRegistry,
    chatGptLoader: async () => { chatGptLoads += 1; return chatGptRegistry; },
  });
  await queue.add(flowVideoJob());
  assert.equal(chatGptLoads, 0);
  await queue.add(chatGptJob());
  assert.equal(chatGptLoads, 1);
  await queue.add(chatGptJob());
  assert.equal(chatGptLoads, 1, 'the loaded registry is cached across submissions');
});
