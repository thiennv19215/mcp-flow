import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  FlowTaskLists,
  expandTaskToJobs,
  expandTasksToJobs,
  requiresSequential,
  uniquifyTaskName,
} from '../extension/src/background/flow-task-lists.js';

const serviceWorkerSource = readFileSync(new URL('../extension/src/background/service-worker.js', import.meta.url), 'utf8');
const sidebarSource = readFileSync(new URL('../extension/src/ui/sidebar.js', import.meta.url), 'utf8');
const sidebarHtml = readFileSync(new URL('../extension/src/ui/sidebar.html', import.meta.url), 'utf8');

// ---------------------------------------------------------------------------
// FEAT-05: saved multi-task lists.
//
// A task is a named, reusable generation config of its own (prompts,
// ratio, model, refs + refs-per-prompt / mention mode, frame slots,
// download settings, project scope) — unlike a batch draft, which is one
// settings snapshot shared by its jobs, every task carries its own.
// Running tasks expands each into queue jobs tagged with the task id;
// results fold back onto the originating task through FEAT-02's shared
// receipt fold (foldQueueSnapshotIntoRun), never a re-implementation.
// The forced-sequential rule (multi-prompt / chat provider / mixed
// providers) is a pure predicate.
// ---------------------------------------------------------------------------

function memoryStorage() {
  const data = {};
  return {
    data,
    async get(key) { return { [key]: data[key] }; },
    async set(entries) { Object.assign(data, entries); },
  };
}

const ref = name => ({ assetName: `asset:${name}`, expectedId: `id-${name}`, kind: 'image' });

const imageConfig = (overrides = {}) => ({
  provider: 'flow',
  mediaType: 'image',
  prompts: ['a red cat'],
  ratio: '16:9',
  model: 'nano-banana',
  quantity: 1,
  refs: [],
  refsPerPrompt: null,
  mentionMode: false,
  frames: { firstFrame: null, lastFrame: null },
  download: { autoDownload: false, imageResolution: null, videoResolution: null },
  projectId: null,
  ...overrides,
});

const MEDIA = id => ({ id, title: `title-${id}`, kind: 'image' });

// A queue job in its finished shape, as queue snapshots carry it.
const finishedJob = ({ id, batchId = 'batch-1', status = 'completed', media = [], failedOutputs = [], error = null }) => ({
  id,
  operation: 'flow.generation.submit',
  payload: { type: 'image', prompt: 'scene', attachments: [] },
  label: 'scene',
  status,
  batch: { batchId, batchLabel: 'Tasks', batchIndex: 0, batchCount: 1 },
  startedAt: 1_000,
  finishedAt: 2_000,
  ...(error ? { error, errorCode: 'FLOW_GENERATION_FAILED' } : {}),
  ...(status === 'completed'
    ? { result: { completed: true, result: { media, ...(failedOutputs.length ? { failedOutputs } : {}) } } }
    : {}),
});

// --- create / CRUD -----------------------------------------------------------

test('create stores a named task with its full config and pending defaults', async () => {
  const store = new FlowTaskLists({ storage: memoryStorage() });
  const task = await store.create({ name: 'Cats', config: imageConfig() });
  assert.equal(task.name, 'Cats');
  assert.equal(task.status, 'pending');
  assert.deepEqual(task.results, []);
  assert.equal(task.error, null);
  assert.equal(task.runCount, 0);
  assert.equal(task.config.provider, 'flow');
  assert.equal(task.config.mediaType, 'image');
  assert.deepEqual(task.config.prompts, ['a red cat']);
  assert.equal(task.config.ratio, '16:9');
  assert.equal(task.config.model, 'nano-banana');
});

test('create derives a name from the first prompt when none is given', async () => {
  const store = new FlowTaskLists({ storage: memoryStorage() });
  const task = await store.create({ config: imageConfig({ prompts: ['sunset over the bay'] }) });
  assert.equal(task.name, 'sunset over the bay');
});

test('create rejects a config without any usable prompt', async () => {
  const store = new FlowTaskLists({ storage: memoryStorage() });
  await assert.rejects(
    store.create({ name: 'Empty', config: imageConfig({ prompts: ['  ', ''] }) }),
    error => error.code === 'FLOW_TASK_CONFIG_INVALID',
  );
  await assert.rejects(
    store.create({ name: 'Missing', config: { provider: 'flow' } }),
    error => error.code === 'FLOW_TASK_CONFIG_INVALID',
  );
});

test('tasks persist across store instances and update/remove round-trip', async () => {
  const storage = memoryStorage();
  const first = new FlowTaskLists({ storage });
  const created = await first.create({ name: 'Persisted', config: imageConfig() });
  await first.flush();

  const second = new FlowTaskLists({ storage });
  const listed = await second.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, created.id);

  const updated = await second.update(created.id, { name: 'Renamed', config: imageConfig({ model: 'other-model' }) });
  assert.equal(updated.name, 'Renamed');
  assert.equal(updated.config.model, 'other-model');
  await assert.rejects(second.update('missing-id', { name: 'x' }), error => error.code === 'FLOW_TASK_NOT_FOUND');

  assert.equal(await second.remove(created.id), true);
  assert.equal(await second.remove(created.id), false);
  assert.deepEqual(await second.list(), []);
});

test('stored configs are deep copies — mutating the input or a listed task changes nothing', async () => {
  const store = new FlowTaskLists({ storage: memoryStorage() });
  const config = imageConfig({ refs: [ref('one')] });
  const task = await store.create({ name: 'Copy', config });
  config.prompts.push('sneaky');
  config.refs[0].assetName = 'asset:mutated';
  const listed = await store.list();
  assert.deepEqual(listed[0].config.prompts, ['a red cat']);
  assert.equal(listed[0].config.refs[0].assetName, 'asset:one');
  listed[0].config.prompts.push('sneaky-2');
  assert.deepEqual((await store.get(task.id)).config.prompts, ['a red cat']);
});

// --- duplicate + uniquified names ---------------------------------------------

test('uniquifyTaskName appends the first free numeric suffix', () => {
  assert.equal(uniquifyTaskName('Alpha', []), 'Alpha');
  assert.equal(uniquifyTaskName('Alpha', ['Alpha']), 'Alpha (2)');
  assert.equal(uniquifyTaskName('Alpha', ['Alpha', 'Alpha (2)']), 'Alpha (3)');
  assert.equal(uniquifyTaskName('Alpha', ['alpha']), 'Alpha');
});

test('duplicate clones the config under a uniquified name and resets run state', async () => {
  const store = new FlowTaskLists({ storage: memoryStorage() });
  const original = await store.create({ name: 'Alpha', config: imageConfig({ prompts: ['p1', 'p2'] }) });
  const copy1 = await store.duplicate(original.id);
  assert.equal(copy1.name, 'Alpha (2)');
  assert.notEqual(copy1.id, original.id);
  assert.deepEqual(copy1.config, original.config);
  assert.equal(copy1.status, 'pending');
  assert.deepEqual(copy1.results, []);
  const copy2 = await store.duplicate(original.id);
  assert.equal(copy2.name, 'Alpha (3)');
  await assert.rejects(store.duplicate('missing-id'), error => error.code === 'FLOW_TASK_NOT_FOUND');
});

// --- search / filter -----------------------------------------------------------

test('search matches name and prompt text case-insensitively; filters scope by project and provider', async () => {
  const store = new FlowTaskLists({ storage: memoryStorage() });
  await store.create({ name: 'Cat Portraits', config: imageConfig({ prompts: ['a red cat'], projectId: 'proj-1' }) });
  await store.create({ name: 'Landscapes', config: imageConfig({ prompts: ['a blue DOG'], projectId: 'proj-2' }) });
  await store.create({ name: 'Global chat', config: imageConfig({ provider: 'chatgpt', prompts: ['studio portrait'] }) });

  assert.deepEqual((await store.search({ query: 'cat' })).map(task => task.name), ['Cat Portraits']);
  assert.deepEqual((await store.search({ query: 'dog' })).map(task => task.name), ['Landscapes']);
  assert.deepEqual((await store.search({ query: 'PORTRAIT' })).map(task => task.name).sort(), ['Cat Portraits', 'Global chat']);
  // Project filter: tasks scoped to the project plus unscoped (global) tasks.
  assert.deepEqual((await store.search({ projectId: 'proj-1' })).map(task => task.name).sort(), ['Cat Portraits', 'Global chat']);
  assert.deepEqual((await store.search({ provider: 'chatgpt' })).map(task => task.name), ['Global chat']);
  assert.equal((await store.search({})).length, 3);
});

// --- expansion: task -> queue jobs ----------------------------------------------

test('expandTaskToJobs expands a flow task per prompt with its own settings and the task id tag', async () => {
  const store = new FlowTaskLists({ storage: memoryStorage() });
  const task = await store.create({
    name: 'Two scenes',
    config: imageConfig({
      prompts: ['scene one', 'scene two'],
      quantity: 2,
      download: { autoDownload: true, imageResolution: '2K', videoResolution: null },
    }),
  });
  const jobs = expandTaskToJobs(task);
  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs.map(job => job.payload.prompt), ['scene one', 'scene two']);
  for (const job of jobs) {
    assert.equal(job.operation, 'flow.generation.submit');
    assert.equal(job.payload.type, 'image');
    assert.equal(job.payload.model, 'nano-banana');
    assert.equal(job.payload.aspectRatio, '16:9');
    assert.equal(job.payload.aspect_ratio, '16:9');
    assert.equal(job.payload.variants, 2);
    assert.equal(job.payload.count, 2);
    assert.equal(job.payload.autoDownload, true);
    assert.equal(job.payload.download_resolution, '2K');
    assert.equal(job.metadata.taskId, task.id);
  }
});

test('refs are sliced per prompt by refsPerPrompt, shared in full without it, and never sliced in mention mode', async () => {
  const store = new FlowTaskLists({ storage: memoryStorage() });
  const refs = [ref('a'), ref('b'), ref('c'), ref('d')];
  const sliced = await store.create({ name: 'Sliced', config: imageConfig({ prompts: ['p1', 'p2'], refs, refsPerPrompt: 2 }) });
  const slicedJobs = expandTaskToJobs(sliced);
  assert.deepEqual(slicedJobs[0].payload.attachments, [refs[0], refs[1]]);
  assert.deepEqual(slicedJobs[1].payload.attachments, [refs[2], refs[3]]);

  const shared = await store.create({ name: 'Shared', config: imageConfig({ prompts: ['p1', 'p2'], refs }) });
  for (const job of expandTaskToJobs(shared)) assert.deepEqual(job.payload.attachments, refs);

  const mention = await store.create({
    name: 'Mention',
    config: imageConfig({ prompts: ['p1 @a', 'p2 @b'], refs, refsPerPrompt: 1, mentionMode: true }),
  });
  for (const job of expandTaskToJobs(mention)) assert.deepEqual(job.payload.attachments, refs);
});

test('video tasks carry frame slots and the video download resolution into every job', async () => {
  const store = new FlowTaskLists({ storage: memoryStorage() });
  const task = await store.create({
    name: 'Clip',
    config: imageConfig({
      mediaType: 'video',
      prompts: ['pan across the room'],
      refs: [ref('still')],
      frames: { firstFrame: 'asset:first', lastFrame: { assetName: 'asset:last' } },
      download: { autoDownload: true, imageResolution: null, videoResolution: '1080p' },
    }),
  });
  const [job] = expandTaskToJobs(task);
  assert.equal(job.payload.type, 'video');
  assert.deepEqual(job.payload.firstFrame, { assetName: 'asset:first' });
  assert.deepEqual(job.payload.lastFrame, { assetName: 'asset:last' });
  assert.equal(job.payload.download_resolution, '1080p');
  assert.deepEqual(job.payload.refMediaTypeMap, { 'asset:still': 'image', 'id-still': 'image', still: 'image' });
});

test('chat tasks expand to chatgpt jobs with the provider pin and the task id tag', async () => {
  const store = new FlowTaskLists({ storage: memoryStorage() });
  const task = await store.create({
    name: 'Chat task',
    config: imageConfig({ provider: 'chatgpt', prompts: ['draw a lighthouse'], refs: [{ name: 'ref.png', type: 'image/png', base64: 'AAAA' }] }),
  });
  const [job] = expandTaskToJobs(task);
  assert.equal(job.operation, 'chatgpt.generation.submit');
  assert.equal(job.metadata.provider, 'chatgpt');
  assert.equal(job.metadata.taskId, task.id);
  assert.equal(job.payload.prompt, 'draw a lighthouse');
  assert.equal(job.payload.ratio, '16:9');
  assert.equal(job.payload.attachments.length, 1);
  assert.equal(job.payload.autoDownload, false);
});

test('expandTasksToJobs keeps task order and per-task settings, and reports segments', async () => {
  const store = new FlowTaskLists({ storage: memoryStorage() });
  const a = await store.create({ name: 'A', config: imageConfig({ prompts: ['a1', 'a2'], model: 'model-a' }) });
  const b = await store.create({ name: 'B', config: imageConfig({ prompts: ['b1'], model: 'model-b' }) });
  const { jobs, segments } = expandTasksToJobs([a, b]);
  assert.deepEqual(jobs.map(job => job.payload.prompt), ['a1', 'a2', 'b1']);
  assert.deepEqual(jobs.map(job => job.payload.model), ['model-a', 'model-a', 'model-b']);
  assert.deepEqual(jobs.map(job => job.metadata.taskId), [a.id, a.id, b.id]);
  assert.deepEqual(segments, [
    { taskId: a.id, jobCount: 2 },
    { taskId: b.id, jobCount: 1 },
  ]);
});

// --- forced-sequential predicate -------------------------------------------------

test('requiresSequential stays parallel for plain single-prompt flow selections', () => {
  const tasks = [
    { id: 't1', config: imageConfig({ prompts: ['one'] }) },
    { id: 't2', config: imageConfig({ prompts: ['two'] }) },
  ];
  assert.deepEqual(requiresSequential(tasks), { sequential: false, reasons: [] });
  assert.deepEqual(requiresSequential([]), { sequential: false, reasons: [] });
});

test('requiresSequential fires for a multi-prompt task in the selection', () => {
  const tasks = [
    { id: 't1', config: imageConfig({ prompts: ['one'] }) },
    { id: 't2', config: imageConfig({ prompts: ['a', 'b'] }) },
  ];
  const result = requiresSequential(tasks);
  assert.equal(result.sequential, true);
  assert.deepEqual(result.reasons, [{ taskId: 't2', reason: 'multi_prompt' }]);
});

test('requiresSequential fires for chat providers and for mixed providers', () => {
  const chatOnly = requiresSequential([{ id: 'c1', config: imageConfig({ provider: 'chatgpt', prompts: ['x'] }) }]);
  assert.equal(chatOnly.sequential, true);
  assert.deepEqual(chatOnly.reasons, [{ taskId: 'c1', reason: 'chat_provider' }]);

  const mixed = requiresSequential([
    { id: 'f1', config: imageConfig({ prompts: ['x'] }) },
    { id: 'c1', config: imageConfig({ provider: 'chatgpt', prompts: ['y'] }) },
  ]);
  assert.equal(mixed.sequential, true);
  assert.ok(mixed.reasons.some(entry => entry.reason === 'chat_provider' && entry.taskId === 'c1'));
  assert.ok(mixed.reasons.some(entry => entry.reason === 'mixed_providers'));
});

// --- run recording + results write-back through FEAT-02's fold --------------------

test('write-back attaches output identities to the originating task only', async () => {
  const store = new FlowTaskLists({ storage: memoryStorage() });
  const a = await store.create({ name: 'A', config: imageConfig({ prompts: ['a1', 'a2'] }) });
  const b = await store.create({ name: 'B', config: imageConfig({ prompts: ['b1'] }) });

  await store.recordTaskRun(a.id, {
    batchId: 'batch-1',
    jobs: [{ id: 'job-a1' }, { id: 'job-a2' }],
  });
  assert.equal((await store.get(a.id)).status, 'running');

  await store.observeSnapshot({ jobs: [
    finishedJob({ id: 'job-a1', media: [MEDIA('m1')] }),
    finishedJob({ id: 'job-a2', media: [MEDIA('m2')] }),
    // A finished job that was never recorded for B must not write onto B:
    // the fold matches recorded runtime job ids only.
    finishedJob({ id: 'job-b1', media: [MEDIA('mB')] }),
  ] });

  const afterA = await store.get(a.id);
  assert.equal(afterA.status, 'completed');
  assert.equal(afterA.partial, false);
  assert.deepEqual(afterA.results.map(entry => entry.id), ['m1', 'm2']);
  assert.deepEqual(afterA.results.map(entry => entry.promptIndex), [0, 1]);
  assert.deepEqual(afterA.results.map(entry => entry.jobId), ['job-a1', 'job-a2']);

  const afterB = await store.get(b.id);
  assert.equal(afterB.status, 'pending');
  assert.deepEqual(afterB.results, []);
});

test('write-back is idempotent across repeated snapshots', async () => {
  const store = new FlowTaskLists({ storage: memoryStorage() });
  const task = await store.create({ name: 'Once', config: imageConfig({ prompts: ['p'] }) });
  await store.recordTaskRun(task.id, { batchId: 'batch-1', jobs: [{ id: 'job-1' }] });
  const snapshot = { jobs: [finishedJob({ id: 'job-1', media: [MEDIA('m1')] })] };
  await store.observeSnapshot(snapshot);
  await store.observeSnapshot(snapshot);
  const after = await store.get(task.id);
  assert.equal(after.results.length, 1);
  assert.equal(after.status, 'completed');
});

test('a fully failed run marks the task failed with the receipt error', async () => {
  const store = new FlowTaskLists({ storage: memoryStorage() });
  const task = await store.create({ name: 'Fail', config: imageConfig({ prompts: ['p'] }) });
  await store.recordTaskRun(task.id, { batchId: 'batch-1', jobs: [{ id: 'job-1' }] });
  await store.observeSnapshot({ jobs: [
    finishedJob({ id: 'job-1', status: 'failed', error: 'Flow refused the prompt.' }),
  ] });
  const after = await store.get(task.id);
  assert.equal(after.status, 'failed');
  assert.equal(after.error, 'Flow refused the prompt.');
  assert.deepEqual(after.results, []);
});

test('a mixed run completes as partial and keeps only the successful outputs', async () => {
  const store = new FlowTaskLists({ storage: memoryStorage() });
  const task = await store.create({ name: 'Mixed', config: imageConfig({ prompts: ['ok', 'bad'] }) });
  await store.recordTaskRun(task.id, { batchId: 'batch-1', jobs: [{ id: 'job-ok' }, { id: 'job-bad' }] });
  await store.observeSnapshot({ jobs: [
    finishedJob({ id: 'job-ok', media: [MEDIA('m-ok')] }),
    finishedJob({ id: 'job-bad', status: 'failed', error: 'nope' }),
  ] });
  const after = await store.get(task.id);
  assert.equal(after.status, 'completed');
  assert.equal(after.partial, true);
  assert.deepEqual(after.results.map(entry => entry.id), ['m-ok']);
});

test('a second run cannot be recorded while one is active; a finished task can run again', async () => {
  const store = new FlowTaskLists({ storage: memoryStorage() });
  const task = await store.create({ name: 'Guarded', config: imageConfig({ prompts: ['p'] }) });
  await store.recordTaskRun(task.id, { batchId: 'batch-1', jobs: [{ id: 'job-1' }] });
  await assert.rejects(
    store.recordTaskRun(task.id, { batchId: 'batch-2', jobs: [{ id: 'job-2' }] }),
    error => error.code === 'FLOW_TASK_RUN_IN_PROGRESS',
  );
  await store.observeSnapshot({ jobs: [finishedJob({ id: 'job-1', media: [MEDIA('m1')] })] });
  await store.recordTaskRun(task.id, { batchId: 'batch-2', jobs: [{ id: 'job-2' }] });
  const running = await store.get(task.id);
  assert.equal(running.status, 'running');
  assert.equal(running.runCount, 2);
  // Earlier outputs stay on the task across runs.
  assert.deepEqual(running.results.map(entry => entry.id), ['m1']);
  await assert.rejects(
    store.recordTaskRun('missing-id', { jobs: [] }),
    error => error.code === 'FLOW_TASK_NOT_FOUND',
  );
});

// --- wiring contracts ---------------------------------------------------------------

test('service worker wires the task list store, its snapshot fold, and the flow-tasks handlers', () => {
  assert.match(serviceWorkerSource, /from "\.\/flow-task-lists\.js"/);
  assert.match(serviceWorkerSource, /new FlowTaskLists\(\)/);
  assert.match(serviceWorkerSource, /flowTaskLists\.observeSnapshot\(snapshot\)/);
  for (const action of ['flow-tasks:list', 'flow-tasks:create', 'flow-tasks:update', 'flow-tasks:duplicate', 'flow-tasks:remove', 'flow-tasks:run']) {
    assert.ok(serviceWorkerSource.includes(`case "${action}"`), `missing handler ${action}`);
  }
  // The run handler is the real pipeline, not a stub: per-task run
  // locks, selection expansion, the sequential verdict, and run
  // recording all happen in the worker.
  assert.ok(serviceWorkerSource.includes('flowTaskLists.beginRun('), 'run handler takes the per-task run lock');
  assert.ok(serviceWorkerSource.includes('expandTasksToJobs('), 'run handler expands the selection to jobs');
  assert.ok(serviceWorkerSource.includes('requiresSequential('), 'run handler surfaces the sequential verdict');
  assert.ok(serviceWorkerSource.includes('flowTaskLists.recordTaskRun('), 'run handler records each task run for write-back');
});

test('sidebar renders the saved task list surface and talks to flow-tasks', () => {
  assert.ok(sidebarHtml.includes('id="flowTaskList"'), 'task list container exists');
  assert.ok(sidebarHtml.includes('id="flowTaskSearch"'), 'task search input exists');
  assert.ok(sidebarHtml.includes('id="flowTaskEmpty"'), 'task list empty note exists');
  assert.ok(sidebarSource.includes('flow-tasks:list'), 'sidebar loads task lists');
  assert.ok(sidebarSource.includes('flow-tasks:run'), 'sidebar can run tasks');
  assert.ok(sidebarSource.includes('flow-tasks:create'), 'sidebar can create tasks from the gen form');
  assert.ok(sidebarSource.includes('flow-tasks:duplicate'), 'sidebar can duplicate tasks');
  assert.ok(sidebarSource.includes('flow-tasks:remove'), 'sidebar can remove tasks');
  assert.ok(sidebarSource.includes('renderFlowTaskLists'), 'sidebar renders task lists');
});
