import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalCore, extensionJobAsLegacy, jobView, materializeQueueJob } from '../dist/core.js';
import { extensionHttpPoll, extensionHttpResult, extensionRegisterHttpPoll } from '../dist/extension.js';
import { sanitizeFlowOperationDiagnostics, sanitizeUnknownSubmitDiagnostics } from '../dist/flow-request-diagnostics.js';
import { sceneSchema } from '../dist/schemas.js';

// Audit cluster D (backend hygiene), TDD first: these tests fail on the
// pre-fix code and pass after the fixes. Items: (1) Flow-branch metadata
// write fallback + stale downloadError clearing, (2) wait() unknown ids,
// (3) frame id accepts asb:, (6) jobView shows both diagnostics,
// (7) video aspect restricted to 16:9/9:16.

// ---- (1) fake in-process connector -------------------------------------
// The core talks to the extension through dist/extension.js's connection
// registry, so a test can BE the connector: register an http-poll session,
// answer its outbound commands, and observe the exact patches it sends.

const CAPABILITIES = ['flow.native.context', 'flow.native.asset.download', 'flow.native.queue.metadata'];

function startFakeConnector(handler) {
  const sessionId = extensionRegisterHttpPoll('local', { protocol: 3, capabilities: CAPABILITIES });
  const state = { stopped: false, recentCalls: 0, patches: [] };
  const loop = (async () => {
    while (!state.stopped) {
      const message = await extensionHttpPoll('local', sessionId, 1000).catch(() => null);
      if (state.stopped) break;
      if (!message) continue;
      if (message.type !== 'command') continue;
      const result = await handler(message, state);
      if (state.stopped) break;
      extensionHttpResult('local', sessionId, message.id, result);
    }
  })();
  return {
    state,
    async stop() {
      state.stopped = true;
      await loop;
    },
  };
}

function flowJob(overrides = {}) {
  return {
    id: 'job-flow-1',
    operation: 'flow.generation.submit',
    payload: { prompt: 'a cat wearing a hat', type: 'video' },
    metadata: {},
    status: 'completed',
    attempts: 1,
    ...overrides,
  };
}

function completedDownloadEntry(fixturePath, size) {
  return {
    id: 99, filename: fixturePath, state: 'complete',
    bytesReceived: size, totalBytes: size,
    url: 'https://flow.google.com/asset/clip-1',
  };
}

test('D1: Flow-branch metadata write failure must not bury files already on disk', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'flow-audit-d1-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const fixture = join(dir, 'clip-source.png');
  writeFileSync(fixture, png);
  const entry = completedDownloadEntry(fixture, png.length);

  const fake = startFakeConnector(async (message, state) => {
    if (message.method === 'flow.downloads.recent') {
      state.recentCalls += 1;
      return { ok: true, value: state.recentCalls === 1 ? [] : [entry] };
    }
    if (message.method !== 'flow.dom.execute') return { ok: false, error: { message: 'unexpected method' } };
    const command = message.args[0];
    if (command.name === 'flow.context') return { ok: true, value: { tabId: 7, isProjectEditor: true, projectId: 'proj-1' } };
    if (command.name === 'flow.asset.download') return { ok: true, value: { downloadTriggered: true } };
    if (command.name === 'flow.queue.metadata') {
      state.patches.push(command.payload.patch);
      return { ok: false, error: { message: 'metadata write failed' } };
    }
    return { ok: false, error: { message: `unexpected command ${command.name}` } };
  });
  try {
    const job = flowJob({
      metadata: { output_dir: dir, file_stem: 'scene-01' },
      result: { result: { media: [{ id: 'media-1', title: 'clip-1' }] } },
    });
    const materialized = await materializeQueueJob(job);
    assert.deepEqual(materialized.metadata.files, [join(dir, 'scene-01.png')]);
    assert.equal(materialized.metadata.downloadComplete, true);
    assert.equal(existsSync(join(dir, 'scene-01.png')), true);
    assert.deepEqual(readFileSync(join(dir, 'scene-01.png')), png);
  } finally {
    await fake.stop();
  }
});

test('D1: a successful Flow-branch materialization clears a stale downloadError', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'flow-audit-d1b-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const fixture = join(dir, 'clip-source.png');
  writeFileSync(fixture, png);
  const entry = completedDownloadEntry(fixture, png.length);

  const fake = startFakeConnector(async (message, state) => {
    if (message.method === 'flow.downloads.recent') return { ok: true, value: [entry] };
    if (message.method !== 'flow.dom.execute') return { ok: false, error: { message: 'unexpected method' } };
    const command = message.args[0];
    if (command.name === 'flow.context') return { ok: true, value: { tabId: 7, isProjectEditor: true, projectId: 'proj-1' } };
    if (command.name === 'flow.queue.metadata') {
      state.patches.push(command.payload.patch);
      return { ok: true, value: { job: { id: 'job-flow-1', metadata: { ...command.payload.patch } } } };
    }
    return { ok: false, error: { message: `unexpected command ${command.name}` } };
  });
  try {
    const job = flowJob({
      metadata: { output_dir: dir, file_stem: 'scene-01' },
      result: { result: { downloadError: 'previous boom', browserDownloads: [{ id: 99 }] } },
    });
    const materialized = await materializeQueueJob(job);
    assert.equal(materialized.metadata.downloadComplete, true);
    assert.equal(fake.state.patches.length, 1);
    assert.equal(fake.state.patches[0].downloadError ?? null, null, 'success patch must not carry the stale downloadError');
    assert.equal(materialized.metadata.downloadError ?? null, null);
  } finally {
    await fake.stop();
  }
});

// ---- (2) wait() unknown ids ---------------------------------------------
test('D2: wait() with unknown job ids must report them instead of finished:true with no jobs', async () => {
  const core = new LocalCore();
  const result = await core.wait({ job_ids: ['no-such-job'], timeout_seconds: 5 });
  assert.deepEqual(result.unknown_ids, ['no-such-job']);
  assert.equal(result.finished, true, 'finished still reflects the (empty) selected set; unknown_ids is what distinguishes it');
});

test('D2: wait() without a filter keeps the old shape (no unknown ids)', async () => {
  const core = new LocalCore();
  const result = await core.wait({ timeout_seconds: 5 });
  assert.deepEqual(result.unknown_ids ?? [], []);
});

// ---- (3) frame id accepts asb: -------------------------------------------
test('D3: frame asset id accepts an asb: id and still rejects garbage', () => {
  const ok = sceneSchema.safeParse({
    prompt: 'A cat', type: 'video',
    first_frame: { asset: 'clip-1', id: 'asb:01234567-89ab-cdef-0123-456789abcdef' },
  });
  assert.equal(ok.success, true, JSON.stringify(ok.error?.issues));
  const bad = sceneSchema.safeParse({
    prompt: 'A cat', type: 'video',
    first_frame: { asset: 'clip-1', id: 'not-an-id' },
  });
  assert.equal(bad.success, false);
  // A genuine v4 UUID (zod v4 validates version/variant strictly; the
  // earlier fixture's version nibble 'c' is not a real UUID version).
  const uuidStillOk = sceneSchema.safeParse({
    prompt: 'A cat', type: 'video',
    first_frame: { asset: 'clip-1', id: '01234567-89ab-4def-8123-456789abcdef' },
  });
  assert.equal(uuidStillOk.success, true);
});

// ---- (6) jobView diagnostics ---------------------------------------------
test('D6: jobView shows both diagnostics when a dispatched job carries operation diagnostics', () => {
  const rawOperation = {
    quoteDiagnostics: { candidateCount: 1, reasonCodes: ['no_candidate'], rawCandidateText: 'x', quote: 10 },
  };
  const rawUnknown = {
    clickDelivered: true, observerReady: true, xhrHookActive: true, fetchHookActive: true,
    requestDiagnostics: { version: 1, count: 0, events: [] },
  };
  const view = jobView({
    id: 'job-1', status: 'done',
    params: { output_dir: '/films/P', file_stem: 'scene-01', prompt: 'p' },
    files: [], attempts: 1, credits: null, progress: undefined, note: undefined,
    error: undefined, errorCategory: undefined, retryAfterAt: undefined, failed_scenes: undefined,
    outcomeUnknown: false, requestDispatched: true, serverAcceptanceObserved: false,
    creditQuoteVerified: false, requestDiagnostics: rawUnknown, operationDiagnostics: rawOperation,
  });
  assert.deepEqual(view.operation_diagnostics, sanitizeFlowOperationDiagnostics(rawOperation));
  assert.deepEqual(view.request_diagnostics, sanitizeUnknownSubmitDiagnostics(rawUnknown));
});

// ---- (7) video aspect ------------------------------------------------------
test('D7: video scenes accept only 16:9/9:16; image scenes keep all five ratios', () => {
  for (const ratio of ['16:9', '9:16']) {
    assert.equal(sceneSchema.safeParse({ prompt: 'p', type: 'video', aspect_ratio: ratio }).success, true, ratio);
  }
  for (const ratio of ['1:1', '4:3', '3:4']) {
    const parsed = sceneSchema.safeParse({ prompt: 'p', type: 'video', aspect_ratio: ratio });
    assert.equal(parsed.success, false, `video ${ratio} must be rejected at the schema, got ${JSON.stringify(parsed.data)}`);
  }
  for (const ratio of ['16:9', '9:16', '1:1', '4:3', '3:4']) {
    assert.equal(sceneSchema.safeParse({ prompt: 'p', type: 'image', aspect_ratio: ratio }).success, true, `image ${ratio}`);
  }
  // Type omitted defaults to video, so a bare 1:1 scene is a video 1:1 scene.
  assert.equal(sceneSchema.safeParse({ prompt: 'p', aspect_ratio: '1:1' }).success, false);
});
