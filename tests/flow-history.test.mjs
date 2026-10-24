import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { FlowHistory, recordFromJob, buildJobFromRecord } from '../extension/src/background/flow-history.js';
import { FlowJobQueue } from '../extension/src/background/flow-job-queue.js';

const serviceWorkerSource = readFileSync(new URL('../extension/src/background/service-worker.js', import.meta.url), 'utf8');
const sidebarSource = readFileSync(new URL('../extension/src/ui/sidebar.js', import.meta.url), 'utf8');
const sidebarHtml = readFileSync(new URL('../extension/src/ui/sidebar.html', import.meta.url), 'utf8');

// ---------------------------------------------------------------------------
// FEAT-01: structured generation-history records + re-run.
//
// Every finished queue job becomes a durable record carrying the full
// settings snapshot (prompt, model, ratio, refs, results, derived
// success/partial/failed/stopped status, duration, project, provider), so
// the History tab can show what actually ran and Re-run can rebuild the
// exact job from the record — never re-resolving refs from the library.
// ---------------------------------------------------------------------------

function memoryStorage() {
  const data = {};
  return {
    data,
    async get(key) { return { [key]: data[key] }; },
    async set(entries) { Object.assign(data, entries); },
  };
}

const MEDIA_1 = { id: 'media-1', title: 'cat-01', kind: 'image' };
const MEDIA_2 = { id: 'media-2', title: 'cat-02', kind: 'image' };

const finishedImageJob = (overrides = {}) => ({
  id: 'job-1',
  operation: 'flow.generation.submit',
  payload: {
    type: 'image',
    prompt: 'a cat in a garden',
    model: 'nano-banana',
    aspectRatio: '16:9',
    aspect_ratio: '16:9',
    variants: 2,
    count: 2,
    autoDownload: true,
    attachments: [{ assetName: 'asset:hero', kind: 'image' }],
  },
  label: '[IMAGE] a cat in a garden',
  metadata: { source: 'extension', flowProjectId: 'project-9' },
  status: 'completed',
  addedAt: 1_000,
  startedAt: 2_000,
  finishedAt: 5_000,
  result: { completed: true, result: { media: [MEDIA_1, MEDIA_2] } },
  ...overrides,
});

test('recordFromJob: a completed job becomes a success record with the full settings snapshot', () => {
  const record = recordFromJob(finishedImageJob());
  assert.equal(record.status, 'success');
  assert.equal(record.jobStatus, 'completed');
  assert.equal(record.jobId, 'job-1');
  assert.equal(record.operation, 'flow.generation.submit');
  assert.equal(record.provider, 'flow');
  assert.equal(record.prompt, 'a cat in a garden');
  assert.equal(record.mediaType, 'image');
  assert.equal(record.model, 'nano-banana');
  assert.equal(record.ratio, '16:9');
  assert.equal(record.quantity, 2);
  assert.deepEqual(record.refs, [{ assetName: 'asset:hero', kind: 'image' }]);
  assert.deepEqual(record.results, [MEDIA_1, MEDIA_2]);
  assert.deepEqual(record.failedOutputs, []);
  assert.equal(record.autoDownload, true);
  assert.equal(record.projectId, 'project-9');
  assert.equal(record.durationMs, 3_000);
  assert.equal(record.startedAt, 2_000);
  assert.equal(record.finishedAt, 5_000);
  assert.equal(record.error, null);
});

test('recordFromJob: a completed job with VID-01 failedOutputs derives partial, not success', () => {
  const job = finishedImageJob({
    partial: true,
    failedOutputs: [{ title: 'cat-02', code: 'FLOW_POLICY_VIOLATION' }],
    result: { completed: true, partial: true, result: { media: [MEDIA_1] }, failedOutputs: [{ title: 'cat-02', code: 'FLOW_POLICY_VIOLATION' }] },
  });
  const record = recordFromJob(job);
  assert.equal(record.status, 'partial');
  assert.deepEqual(record.results, [MEDIA_1]);
  assert.deepEqual(record.failedOutputs, [{ title: 'cat-02', code: 'FLOW_POLICY_VIOLATION' }]);
});

test('recordFromJob: failed and cancelled jobs derive failed / stopped with the error kept', () => {
  const failed = recordFromJob(finishedImageJob({
    status: 'failed', result: undefined, error: 'Flow rejected the prompt.', errorCode: 'FLOW_POLICY_VIOLATION',
  }));
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'Flow rejected the prompt.');
  assert.equal(failed.errorCode, 'FLOW_POLICY_VIOLATION');

  const stopped = recordFromJob(finishedImageJob({ status: 'cancelled', result: undefined }));
  assert.equal(stopped.status, 'stopped');
});

test('recordFromJob: non-terminal jobs and content-free jobs are skipped', () => {
  assert.equal(recordFromJob(finishedImageJob({ status: 'running' })), null);
  assert.equal(recordFromJob(finishedImageJob({ status: 'pending' })), null);
  assert.equal(recordFromJob(finishedImageJob({ status: 'waiting_for_user' })), null);
  // A finished download job has neither a prompt nor generated results:
  // history records generations, not bookkeeping operations.
  assert.equal(recordFromJob({
    id: 'job-dl', operation: 'flow.queue.download-generated', payload: { sourceJobId: 'job-1' },
    status: 'completed', finishedAt: 9_000, result: { completed: true, downloaded: 2 },
  }), null);
  assert.equal(recordFromJob(null), null);
  assert.equal(recordFromJob({ status: 'completed' }), null);
});

test('recordFromJob: checkpoint media win over the runner result, ChatGPT jobs keep their provider', () => {
  const fromCheckpoint = recordFromJob(finishedImageJob({
    metadata: {
      source: 'extension', flowProjectId: 'project-9',
      generationResultCheckpoint: { media: [{ id: 'media-cp', title: 'cp', kind: 'image' }], recordedAt: 4_000 },
    },
  }));
  assert.deepEqual(fromCheckpoint.results, [{ id: 'media-cp', title: 'cp', kind: 'image' }]);

  const chatgpt = recordFromJob({
    id: 'job-gpt', operation: 'chatgpt.generation.submit',
    payload: { prompt: 'draw a house', ratio: '1:1', attachments: [{ name: 'ref.png', mimeType: 'image/png', dataBase64: 'AAAA' }], autoDownload: false },
    label: 'ChatGPT image: draw a house',
    metadata: { provider: 'chatgpt', source: 'extension' },
    status: 'completed', startedAt: 100, finishedAt: 400,
    result: { completed: true, result: { media: [{ id: 'file-1', title: 'house', kind: 'image' }] } },
  });
  assert.equal(chatgpt.provider, 'chatgpt');
  assert.equal(chatgpt.mediaType, 'image');
  assert.equal(chatgpt.ratio, '1:1');
  assert.equal(chatgpt.refs.length, 1);
  assert.equal(chatgpt.durationMs, 300);
});

test('buildJobFromRecord: the re-run round-trip reproduces the original job input deep-equal', () => {
  const originalInput = {
    operation: 'flow.generation.submit',
    payload: {
      type: 'video',
      prompt: 'scene 2: the argument',
      model: 'veo-3',
      aspectRatio: '9:16',
      aspect_ratio: '9:16',
      variants: 1,
      count: 1,
      autoDownload: false,
      attachments: [{ assetName: 'asset:mom', kind: 'image' }],
      firstFrame: { assetName: 'asset:frame-a' },
    },
    label: '[VIDEO] scene 2: the argument',
    metadata: { dependsOnId: 'job-parent', dependencyType: 'chain_previous', source: 'extension' },
  };
  const finishedJob = {
    ...structuredClone(originalInput),
    id: 'job-child',
    status: 'completed',
    startedAt: 10_000,
    finishedAt: 70_000,
    // Runtime receipts land on metadata while the job runs; they are not
    // settings and must not leak into the re-run.
    metadata: {
      ...structuredClone(originalInput.metadata),
      generationResultCheckpoint: { media: [{ id: 'm', title: 't', kind: 'video' }], recordedAt: 69_000 },
      generationObservation: { correlationAttemptId: 'attempt-1' },
    },
    result: { completed: true, result: { media: [{ id: 'm', title: 't', kind: 'video' }] } },
  };
  const record = recordFromJob(finishedJob);
  const rebuilt = buildJobFromRecord(record);
  assert.deepEqual(rebuilt, originalInput);
  assert.equal(rebuilt.id, undefined, 'a re-run never reuses the finished job id');
  assert.equal(rebuilt.metadata.dependsOnId, 'job-parent', 'chain fields survive the round-trip');
});

test('buildJobFromRecord: a malformed record is rejected with a typed error', () => {
  assert.throws(() => buildJobFromRecord(null), error => error.code === 'FLOW_HISTORY_RECORD_INVALID');
  assert.throws(() => buildJobFromRecord({ id: 'hist-x' }), error => error.code === 'FLOW_HISTORY_RECORD_INVALID');
});

test('history store: records persist across instances and observeSnapshot is idempotent', async () => {
  const storage = memoryStorage();
  const history = new FlowHistory({ storage });
  const snapshot = { jobs: [finishedImageJob(), finishedImageJob({ id: 'job-2', status: 'running' })] };
  const added = await history.observeSnapshot(snapshot);
  assert.equal(added.length, 1, 'only the finished job is recorded');
  assert.equal((await history.observeSnapshot(snapshot)).length, 0, 'the same snapshot never records twice');
  await history.flush();

  const reopened = new FlowHistory({ storage });
  const records = await reopened.list();
  assert.equal(records.length, 1);
  assert.equal(records[0].jobId, 'job-1');
  assert.equal((await reopened.observeSnapshot(snapshot)).length, 0, 'a restart does not re-record finished jobs');
});

test('history store: the cap evicts the oldest records and evicted jobs stay evicted', async () => {
  const storage = memoryStorage();
  const history = new FlowHistory({ storage, maxRecords: 3 });
  for (let i = 1; i <= 5; i++) {
    await history.recordJob(finishedImageJob({ id: `job-${i}`, finishedAt: 5_000 + i }));
  }
  await history.flush();
  const records = await history.list();
  assert.deepEqual(records.map(record => record.jobId), ['job-5', 'job-4', 'job-3'], 'newest first, oldest evicted');

  const reopened = new FlowHistory({ storage, maxRecords: 3 });
  const reAdded = await reopened.recordJob(finishedImageJob({ id: 'job-1', finishedAt: 5_001 }));
  assert.equal(reAdded, null, 'an evicted job still in the queue snapshot is not resurrected after a restart');
  assert.equal((await reopened.list()).length, 3);
});

test('history store: list filters by status / provider / search, remove and clear work', async () => {
  const history = new FlowHistory({ storage: memoryStorage() });
  await history.recordJob(finishedImageJob());
  await history.recordJob(finishedImageJob({
    id: 'job-2', finishedAt: 6_000, status: 'failed', result: undefined, error: 'boom', errorCode: 'FLOW_JOB_FAILED',
    payload: { type: 'video', prompt: 'a dog running', attachments: [] },
  }));
  assert.equal((await history.list()).length, 2);
  assert.equal((await history.list({ status: 'failed' })).length, 1);
  assert.equal((await history.list({ provider: 'chatgpt' })).length, 0);
  assert.equal((await history.list({ mediaType: 'video' })).length, 1);
  assert.equal((await history.list({ search: 'DOG' })).length, 1);

  const [first] = await history.list();
  assert.equal(await history.remove(first.id), true);
  assert.equal((await history.list()).length, 1);
  assert.equal(await history.remove(first.id), false);
  await history.clear();
  assert.equal((await history.list()).length, 0);
});

test('history store: a corrupt stored state degrades to an empty history', async () => {
  const storage = memoryStorage();
  storage.data.flowMcpHistoryV1 = { version: 99, records: 'nope' };
  const history = new FlowHistory({ storage });
  assert.deepEqual(await history.list(), []);
  const record = await history.recordJob(finishedImageJob());
  assert.ok(record);
  assert.equal((await history.list()).length, 1);
});

test('history store: a failing storage write never breaks recording', async () => {
  const failingStorage = {
    async get() { return {}; },
    async set() { throw new Error('quota exceeded'); },
  };
  const history = new FlowHistory({ storage: failingStorage });
  const record = await history.recordJob(finishedImageJob());
  assert.ok(record, 'the record is kept in memory even when persistence fails');
  await history.flush();
  assert.equal((await history.list()).length, 1);
});

test('queue integration: finished jobs are recorded from queue snapshots with partial intact', async () => {
  const history = new FlowHistory({ storage: memoryStorage() });
  const queue = new FlowJobQueue(async job => {
    if (job.payload.prompt === 'partial scene') {
      return {
        completed: true,
        requestDispatched: true,
        result: { media: [MEDIA_1], failedOutputs: [{ title: 'cat-02', code: 'FLOW_GENERATION_FAILED' }] },
      };
    }
    throw Object.assign(new Error('Flow refused.'), { code: 'FLOW_GENERATION_FAILED', retryable: false, outcomeUnknown: false });
  }, { storage: memoryStorage(), minDelayMs: 0, maxDelayMs: 0 });
  const feeds = [];
  queue.subscribe(snapshot => { feeds.push(history.observeSnapshot(snapshot)); });

  const added = await queue.addBatch([
    { operation: 'flow.generation.submit', payload: { type: 'image', prompt: 'partial scene', count: 2, attachments: [] }, label: 'partial scene' },
    { operation: 'flow.generation.submit', payload: { type: 'image', prompt: 'doomed scene', attachments: [] }, label: 'doomed scene' },
  ], { batchLabel: 'History integration' });
  await queue.start();
  await queue.wait(added[1].id, 5_000);
  await Promise.all(feeds);
  await history.observeSnapshot(await queue.snapshot());
  await history.flush();

  const records = await history.list();
  assert.equal(records.length, 2);
  const partial = records.find(record => record.prompt === 'partial scene');
  assert.equal(partial.status, 'partial');
  assert.deepEqual(partial.results, [MEDIA_1]);
  assert.deepEqual(partial.failedOutputs, [{ title: 'cat-02', code: 'FLOW_GENERATION_FAILED' }]);
  assert.equal(partial.batchLabel, 'History integration');
  const failed = records.find(record => record.prompt === 'doomed scene');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.errorCode, 'FLOW_GENERATION_FAILED');

  // The recorded partial job re-runs as the same payload it originally ran.
  const rebuilt = buildJobFromRecord(partial);
  assert.equal(rebuilt.operation, 'flow.generation.submit');
  assert.deepEqual(rebuilt.payload, added[0].payload);
});

test('wiring: service worker records queue snapshots and serves the history surface', () => {
  assert.match(serviceWorkerSource, /from "\.\/flow-history\.js"/, 'service worker imports the history module');
  assert.match(serviceWorkerSource, /new FlowHistory\(\)/, 'service worker owns a history store');
  assert.match(serviceWorkerSource, /flowHistory\.observeSnapshot\(snapshot\)/, 'queue snapshots feed the history recorder');
  for (const type of ['flow-history:list', 'flow-history:rerun', 'flow-history:remove', 'flow-history:clear']) {
    assert.ok(serviceWorkerSource.includes(`"${type}"`), `service worker handles ${type}`);
  }
  assert.match(serviceWorkerSource, /FLOW_HISTORY_NOT_FOUND/);
  assert.match(serviceWorkerSource, /buildJobFromRecord\(record\)/, 're-run rebuilds the job from the record');
});

test('wiring: the History tab renders generation records with a re-run action', () => {
  assert.ok(sidebarHtml.includes('id="flowGenHistoryList"'), 'sidebar.html has the generation-history list');
  assert.ok(sidebarHtml.includes('id="flowGenHistoryEmpty"'), 'sidebar.html has the generation-history empty note');
  assert.ok(sidebarSource.includes('"flow-history:list"'), 'sidebar loads records from the worker');
  assert.ok(sidebarSource.includes('"flow-history:rerun"'), 'sidebar re-runs records through the worker');
  assert.match(sidebarSource, /data-history-rerun/, 'each record row carries a re-run button');
});
