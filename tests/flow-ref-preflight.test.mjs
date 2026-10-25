import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// IMG-04 (gap G6 / behavior 22): a queued generation job's references were
// resolved when the job was created; by run time a library tile may have
// been deleted or an uploaded asset may have vanished. The job-start ref
// pass resolves each attachment against the IMG-03 media catalog, then a
// targeted existence check: missing LIBRARY refs fail fast with
// FLOW_QUEUE_PREFLIGHT_REFERENCE_MISSING before settings/prompt stages,
// and UPLOADED refs whose bytes are still retained are re-uploaded with
// the attachment's expectedId rewritten to the new asset.

import { FlowJobQueue } from '../extension/src/background/flow-job-queue.js';
import {
  revalidateJobReferences,
  FLOW_REF_PREFLIGHT_MISSING_CODE,
} from '../extension/src/background/flow-ref-preflight.js';

const UUID_OLD = '123e4567-e89b-12d3-a456-426614174000';
const UUID_NEW = '223e4567-e89b-12d3-a456-426614174001';

function memoryStorage() {
  const data = {};
  return {
    async get(key) { return { [key]: data[key] }; },
    async set(entries) { Object.assign(data, entries); },
    async remove(key) { delete data[key]; },
  };
}

// Fake ref-preflight dependencies with a shared call-order log.
// catalog: Map assetName -> catalog entry (absent = no entry)
// existing: Set of assetNames whose tile still exists
// reuploads: Map assetName -> receipt ({id}) or null (bytes not retained)
function makeDeps({ catalog = new Map(), existing = new Set(), reuploads = new Map() } = {}) {
  const calls = { catalog: [], exists: [], reupload: [], order: [] };
  const deps = {
    catalogLookup: async ref => {
      calls.catalog.push(ref.assetName);
      calls.order.push(`catalog:${ref.assetName}`);
      return catalog.get(ref.assetName) ?? null;
    },
    assetExists: async ref => {
      calls.exists.push(ref.assetName);
      calls.order.push(`exists:${ref.assetName}`);
      return existing.has(ref.assetName);
    },
    reupload: async ref => {
      calls.reupload.push(ref.assetName);
      calls.order.push(`reupload:${ref.assetName}`);
      return reuploads.get(ref.assetName) ?? null;
    },
  };
  return { deps, calls };
}

function makeQueue({ runner, deps }) {
  return new FlowJobQueue(runner, {
    storage: memoryStorage(),
    minDelayMs: 0,
    maxDelayMs: 0,
    refPreflight: job => revalidateJobReferences(job, deps),
  });
}

const imageJobWithRef = (attachment) => ({
  operation: 'flow.generation.submit',
  payload: { type: 'image', prompt: 'a still', attachments: [attachment] },
  label: 'ref job',
});

test('IMG-04 (a): a queued job whose library tile was removed fails with the distinct preflight code and the submit stage never runs', async () => {
  const { deps } = makeDeps(); // no catalog entry, tile gone, nothing to re-upload
  let runnerCalls = 0;
  const queue = makeQueue({ runner: async () => { runnerCalls += 1; return { completed: true }; }, deps });
  const added = await queue.add(imageJobWithRef({ assetName: 'Beach.png', expectedId: UUID_OLD }));
  await queue.start();
  const { job } = await queue.wait(added.id, 5_000);
  assert.equal(job.status, 'failed');
  assert.equal(job.errorCode, FLOW_REF_PREFLIGHT_MISSING_CODE);
  assert.equal(job.errorCode, 'FLOW_QUEUE_PREFLIGHT_REFERENCE_MISSING');
  assert.equal(runnerCalls, 0, 'the submit stage must never run when a library ref is missing');
  assert.equal(job.retrySafe, false, 'a missing library ref is a user-action problem, not an auto-retry');
  assert.equal(job.attempts, 1, 'the job must not be auto-retried into the same missing ref');
  assert.match(job.error, /Beach\.png/);
});

test('IMG-04 (b): an uploaded ref whose tile vanished is re-uploaded from retained bytes and the submit receives the rewritten expectedId', async () => {
  const { deps, calls } = makeDeps({
    catalog: new Map([['Beach.png', { mediaId: UUID_OLD, uploadName: 'deadbeef-dead-beef-dead-beefdeadbeef.png', originalName: 'Beach.png' }]]),
    existing: new Set(), // tile vanished
    reuploads: new Map([['Beach.png', { id: UUID_NEW }]]),
  });
  let runnerPayload = null;
  const queue = makeQueue({
    runner: async job => { runnerPayload = job.payload; return { completed: true }; },
    deps,
  });
  const added = await queue.add(imageJobWithRef({ assetName: 'Beach.png', expectedId: UUID_OLD }));
  await queue.start();
  const { job } = await queue.wait(added.id, 5_000);
  assert.equal(job.status, 'completed');
  assert.deepEqual(calls.reupload, ['Beach.png']);
  assert.equal(runnerPayload.attachments[0].expectedId, UUID_NEW, 'the submit path must use the rewritten expectedId');
  const persisted = await queue.get(added.id);
  assert.equal(persisted.payload.attachments[0].expectedId, UUID_NEW, 'the rewrite must be persisted on the job record');
  // Catalog is consulted before the existence scan, and the scan before re-upload.
  assert.deepEqual(calls.order, ['catalog:Beach.png', 'exists:Beach.png', 'reupload:Beach.png']);
});

test('IMG-04 (c1): when every ref still exists there is no re-upload and the payload reaches the submit unchanged', async () => {
  const { deps, calls } = makeDeps({ existing: new Set(['Beach.png']) });
  let runnerPayload = null;
  const queue = makeQueue({
    runner: async job => { runnerPayload = job.payload; return { completed: true }; },
    deps,
  });
  const added = await queue.add(imageJobWithRef({ assetName: 'Beach.png', expectedId: UUID_OLD }));
  await queue.start();
  const { job } = await queue.wait(added.id, 5_000);
  assert.equal(job.status, 'completed');
  assert.deepEqual(calls.reupload, []);
  assert.equal(runnerPayload.attachments[0].expectedId, UUID_OLD);
});

test('IMG-04 (c2): a job without references passes through untouched (deps never consulted)', async () => {
  const { deps, calls } = makeDeps();
  const queue = makeQueue({ runner: async () => ({ completed: true }), deps });
  const added = await queue.add({ operation: 'flow.generation.submit', payload: { type: 'image', prompt: 'no refs' } });
  await queue.start();
  const { job } = await queue.wait(added.id, 5_000);
  assert.equal(job.status, 'completed');
  assert.deepEqual(calls.catalog, []);
  assert.deepEqual(calls.exists, []);
  assert.deepEqual(calls.reupload, []);
});

test('IMG-04 (c3): non-generation operations pass through untouched even with attachment-shaped payloads', async () => {
  const { deps, calls } = makeDeps();
  let runnerPayload = null;
  const queue = makeQueue({
    runner: async job => { runnerPayload = job.payload; return { completed: true }; },
    deps,
  });
  const payload = { title: 'x', attachments: [{ assetName: 'Beach.png', expectedId: UUID_OLD }] };
  const added = await queue.add({ operation: 'flow.asset.rename', payload });
  await queue.start();
  const { job } = await queue.wait(added.id, 5_000);
  assert.equal(job.status, 'completed');
  assert.deepEqual(calls.catalog, []);
  assert.deepEqual(runnerPayload.attachments, payload.attachments);
});

test('IMG-04 (d): an uploaded ref whose bytes are NOT retained fails like a missing ref (never guessed)', async () => {
  const { deps } = makeDeps({
    catalog: new Map([['Beach.png', { mediaId: UUID_OLD, uploadName: 'deadbeef-dead-beef-dead-beefdeadbeef.png', originalName: 'Beach.png' }]]),
    existing: new Set(),
    reuploads: new Map(), // reupload returns null: bytes gone
  });
  let runnerCalls = 0;
  const queue = makeQueue({ runner: async () => { runnerCalls += 1; return { completed: true }; }, deps });
  const added = await queue.add(imageJobWithRef({ assetName: 'Beach.png', expectedId: UUID_OLD }));
  await queue.start();
  const { job } = await queue.wait(added.id, 5_000);
  assert.equal(job.status, 'failed');
  assert.equal(job.errorCode, FLOW_REF_PREFLIGHT_MISSING_CODE);
  assert.equal(runnerCalls, 0);
});

test('IMG-04 (module): a missing first-frame ref fails the pass with a non-retryable, outcome-known error', async () => {
  const { deps } = makeDeps();
  await assert.rejects(
    revalidateJobReferences({
      operation: 'flow.generation.submit',
      payload: { type: 'video', prompt: 'clip', mode: 'frames', firstFrame: { assetName: 'Start.png', expectedId: UUID_OLD } },
    }, deps),
    error => error.code === FLOW_REF_PREFLIGHT_MISSING_CODE && error.retryable === false && error.outcomeUnknown === false,
  );
});

test('IMG-04 (module): staged local attachments carry their own bytes and are skipped by the pass', async () => {
  const { deps, calls } = makeDeps();
  const job = {
    operation: 'flow.generation.submit',
    payload: { type: 'image', prompt: 'x', attachments: [{ transferId: 'abc123', name: 'fm-abc123-ref1.png' }] },
  };
  const result = await revalidateJobReferences(job, deps);
  assert.deepEqual(calls.catalog, []);
  assert.equal(result.job.payload.attachments[0].transferId, 'abc123');
});

// ---------------------------------------------------------------------------
// Content layer: the production wiring inside flow.generation.submit runs
// the same pass as its first stage, before the settings/prompt stages.
// ---------------------------------------------------------------------------

const operationsSource = readFileSync(
  new URL('../extension/src/content/providers/flow/generation/generation-operations.js', import.meta.url),
  'utf8',
);
const PROJECT_ID = '123e4567-e89b-12d3-a456-426614174000';

function makeContentHarness({ catalogEntry = null, assets = [], stagedFiles = [] } = {}) {
  const calls = { prepare: 0, picker: [], uploads: [], order: [] };
  const correlationMap = new Map([
    ['attempt-1', { attemptId: 'attempt-1', requestSeen: true, receipts: [], interfered: false }],
  ]);
  const startButton = { disabled: false, getAttribute: () => null };
  const stagedNativeFiles = new Map(stagedFiles.map((file, index) => [`transfer-${index}`, file]));
  const sandbox = {
    Date, Map, Set, Promise, Object, Math, String, Number, Boolean, Array, Error, RegExp, JSON,
    AbortController, setTimeout, clearTimeout,
    location: { href: `https://flow.google.com/project/${PROJECT_ID}`, pathname: `/project/${PROJECT_ID}` },
    document: { querySelector: () => null, querySelectorAll: () => [] },
    addEventListener: () => {},
    removeEventListener: () => {},
    chrome: {
      runtime: {
        sendMessage: async message => {
          if (message?.type === 'flow-media-catalog:lookup') return { ok: true, entry: catalogEntry };
          return { ok: false };
        },
      },
    },
    stagedNativeFiles,
    flowError: (code, message, retryable, outcomeUnknown) =>
      Object.assign(new Error(message), { code, retryable, outcome_unknown: outcomeUnknown }),
    wait: async () => {},
    clearExistingIngredientChips: async () => {},
    FlowNavigation: {
      ensureFlowProjectEditor: async () => {},
      dismissBlockingOverlays: async () => {},
      ensureFlowLibrarySection: async () => {},
    },
    FlowEditor: {
      preflightGenerationPrompt: async () => ({}),
      insertNativeFlowPrompt: async () => true,
      waitForGenerationCreditQuote: async () => undefined,
      waitForGenerationSubmitButton: async () => startButton,
      activateFlowSubmitButton: async () => ({ clickDelivered: true, strategy: 'fake-click' }),
      currentFlowSubmitErrors: () => [],
    },
    FlowSettings: {},
    FlowComponents: {
      chooseNativePickerAsset: async (name, slot, options = {}) => {
        calls.picker.push({ name, expectedId: options.expectedId, verifiedIdentity: options.verifiedIdentity });
        calls.order.push('picker');
        return { confirmed: true, id: options.expectedId || UUID_OLD, kind: 'image' };
      },
      uploadStagedFlowMedia: async file => {
        calls.uploads.push(file.name);
        calls.order.push('reupload');
        return { id: UUID_NEW, name: file.name };
      },
    },
    FlowTiles: {
      stabilizeFlowResultViewport: async () => {},
      collectNativeMedia: () => [],
      armNativeFlowCorrelation: () => 'attempt-1',
      nativeFlowCorrelationMap: () => correlationMap,
      disarmNativeFlowCorrelation: () => {},
      emitFlowProgress: () => {},
      readNativeFlowCorrelationHealth: async () => null,
    },
    FlowMediaMenu: {
      nativeRead: () => ({ signedIn: true, inProject: true }),
      collectAssets: () => assets,
    },
    FlowAgent: { closeNativeAgentSession: async () => {} },
    FlowScreenState: { inspect: () => ({ state: 'ready' }), assertGenerationReady: () => {} },
    FlowImageActions: { prepare: async () => { calls.prepare += 1; calls.order.push('settings'); return {}; } },
    FlowVideoActions: { prepare: async () => { calls.prepare += 1; calls.order.push('settings'); return 12; } },
    FlowUiDeadline: {
      makeDeadline: () => Date.now() + 60_000,
      requireTime: () => 1_000,
      boundedWait: async () => {},
    },
    ProviderRegistry: { describeUrl: () => ({ projectId: PROJECT_ID }) },
  };
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(operationsSource, context);
  const driver = {
    error: (code, message, retryable, outcomeUnknown) =>
      Object.assign(new Error(message), { code, retryable, outcome_unknown: outcomeUnknown }),
  };
  const operations = new context.FlowGenerationOperations(driver);
  return { operations, calls };
}

test('IMG-04 (content a): submit with a removed library ref fails with the preflight code before the settings stage', async () => {
  const { operations, calls } = makeContentHarness({ catalogEntry: null, assets: [] });
  await assert.rejects(
    operations.execute('flow.generation.submit', {
      type: 'image', prompt: 'a still',
      attachments: [{ assetName: 'Beach.png', expectedId: UUID_OLD }],
    }, {}),
    error => error.code === 'FLOW_QUEUE_PREFLIGHT_REFERENCE_MISSING',
  );
  assert.equal(calls.prepare, 0, 'the settings stage must not run when a library ref is missing');
  assert.deepEqual(calls.picker, [], 'no attach may be attempted');
});

test('IMG-04 (content b): submit re-uploads a vanished uploaded ref from retained staged bytes and attaches the new id', async () => {
  const { operations, calls } = makeContentHarness({
    catalogEntry: { mediaId: UUID_OLD, uuid: UUID_OLD, uploadName: 'deadbeef-dead-beef-dead-beefdeadbeef.png', originalName: 'Beach.png' },
    assets: [],
    stagedFiles: [{ name: 'Beach.png' }],
  });
  const result = await operations.execute('flow.generation.submit', {
    type: 'image', prompt: 'a still',
    attachments: [{ assetName: 'Beach.png', expectedId: UUID_OLD }],
  }, {});
  assert.equal(result.submitted, true);
  assert.deepEqual(calls.uploads, ['Beach.png'], 'the retained staged file must be re-uploaded');
  assert.equal(calls.picker[0].expectedId, UUID_NEW, 'the attach must use the rewritten expectedId');
  assert.ok(calls.order.indexOf('reupload') < calls.order.indexOf('settings'), 're-upload happens before the settings stage');
});

test('IMG-04 (content c): submit with the ref tile still present does not re-upload and keeps the original id', async () => {
  const { operations, calls } = makeContentHarness({
    catalogEntry: null,
    assets: [{ name: 'Beach.png', id: UUID_OLD, persistentMediaId: UUID_OLD }],
  });
  const result = await operations.execute('flow.generation.submit', {
    type: 'image', prompt: 'a still',
    attachments: [{ assetName: 'Beach.png', expectedId: UUID_OLD }],
  }, {});
  assert.equal(result.submitted, true);
  assert.deepEqual(calls.uploads, []);
  assert.equal(calls.picker[0].expectedId, UUID_OLD);
});

test('IMG-04 (content frame): exact library title and matching media ID attest a frame when the picker DOM omits its ID', async () => {
  const { operations, calls } = makeContentHarness({
    assets: [{ name: 'Start.png', id: UUID_OLD, persistentMediaId: UUID_OLD }],
  });
  const result = await operations.execute('flow.generation.submit', {
    type: 'video', mode: 'frames', prompt: 'animate the still',
    firstFrame: { assetName: 'Start.png', expectedId: UUID_OLD },
  }, {});
  assert.equal(result.submitted, true);
  assert.deepEqual(calls.uploads, [], 'an image already in Flow is selected without another upload');
  assert.equal(calls.picker[0].name, 'Start.png');
  assert.equal(calls.picker[0].expectedId, UUID_OLD);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.picker[0].verifiedIdentity)), { assetName: 'Start.png', id: UUID_OLD });
});
