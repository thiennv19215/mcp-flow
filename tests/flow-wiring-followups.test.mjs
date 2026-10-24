import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { FlowBatchRuns } from '../extension/src/background/flow-batch-runs.js';

const serviceWorkerSource = readFileSync(new URL('../extension/src/background/service-worker.js', import.meta.url), 'utf8');
const batchRunsSource = readFileSync(new URL('../extension/src/background/flow-batch-runs.js', import.meta.url), 'utf8');

// ---------------------------------------------------------------------------
// Phase 5 wiring follow-ups: three sidebar surfaces shipped with their
// stores/modules in FEAT-08 (workflow templates), FEAT-09 (generation
// templates) and FEAT-14 (prompt assistant), but the service worker never
// answered their message contracts — the panels degraded to an empty list
// or a plain error. This suite pins the worker side of each contract
// (import, singleton, sender guard, one case per action, the response
// keys the sidebar actually reads) in the same style as the flow-tasks /
// flow-albums wiring suites.
//
// FEAT-12b is the behavioral half: FEAT-12 shipped the pure
// foldRegenReceiptIntoRun, but nothing called it — the batch run store
// folded snapshots only into the ACTIVE run, and regenerating an item
// happens after its run finalized, so regen receipts never landed in the
// durable record. The store now folds regen receipts into finalized runs
// from the same snapshot stream, and the worker subscribes it next to
// the FEAT-02 fold.
// ---------------------------------------------------------------------------

function memoryStorage() {
  const data = {};
  return {
    data,
    async get(key) { return { [key]: data[key] }; },
    async set(entries) { Object.assign(data, entries); },
    async remove(key) { delete data[key]; },
  };
}

const MEDIA = id => ({ id, title: `title-${id}`, kind: 'image' });

// --- FEAT-08b: flow-workflow-templates handlers ------------------------------

test('service worker wires the workflow template store and its handlers', () => {
  assert.match(serviceWorkerSource, /from "\.\/flow-workflow-templates\.js"/);
  assert.match(serviceWorkerSource, /new FlowWorkflowTemplates\(\)/);
  assert.ok(serviceWorkerSource.includes('message.type.startsWith("flow-workflow-templates:")'), 'workflow templates get their own message block');
  assert.ok(serviceWorkerSource.includes('FLOW_WORKFLOW_TEMPLATES_FORBIDDEN'), 'the block is restricted to the extension UI');
  for (const action of [
    'flow-workflow-templates:list', 'flow-workflow-templates:save', 'flow-workflow-templates:instantiate',
    'flow-workflow-templates:export', 'flow-workflow-templates:import', 'flow-workflow-templates:remove',
  ]) {
    assert.ok(serviceWorkerSource.includes(`case "${action}"`), `missing handler ${action}`);
  }
  // The response keys are the ones the sidebar reads: res.templates for
  // the list, res.template after save/import, res.graph after
  // instantiate, res.document after export.
  assert.ok(serviceWorkerSource.includes('templates: await flowWorkflowTemplates.list('), 'list answers with the template list');
  assert.ok(serviceWorkerSource.includes('flowWorkflowTemplates.save(message.graph'), 'save hands the sidebar graph to the store');
  assert.ok(serviceWorkerSource.includes('flowWorkflowTemplates.instantiate('), 'instantiate goes through the store');
  assert.ok(serviceWorkerSource.includes('flowWorkflowTemplates.exportTemplate('), 'export goes through the store');
  assert.ok(serviceWorkerSource.includes('flowWorkflowTemplates.importTemplate(message.document)'), 'import hands the file document to the store');
  assert.ok(serviceWorkerSource.includes('flowWorkflowTemplates.remove('), 'remove goes through the store');
});

// --- FEAT-09b: flow-gen-templates handlers -----------------------------------

test('service worker wires the generation template store and its handlers', () => {
  assert.match(serviceWorkerSource, /from "\.\/flow-gen-templates\.js"/);
  assert.match(serviceWorkerSource, /new FlowGenTemplates\(\)/);
  assert.ok(serviceWorkerSource.includes('message.type.startsWith("flow-gen-templates:")'), 'generation templates get their own message block');
  assert.ok(serviceWorkerSource.includes('FLOW_GEN_TEMPLATES_FORBIDDEN'), 'the block is restricted to the extension UI');
  for (const action of [
    'flow-gen-templates:list', 'flow-gen-templates:save', 'flow-gen-templates:apply', 'flow-gen-templates:remove',
  ]) {
    assert.ok(serviceWorkerSource.includes(`case "${action}"`), `missing handler ${action}`);
  }
  // The sidebar reads res.templates, res.template and res.job.
  assert.ok(serviceWorkerSource.includes('templates: await flowGenTemplates.list('), 'list answers with the template list');
  assert.ok(serviceWorkerSource.includes('flowGenTemplates.save(message.state'), 'save hands the composer state to the store');
  assert.ok(serviceWorkerSource.includes('const job = await flowGenTemplates.apply('), 'apply builds the queue job through the store');
  assert.ok(serviceWorkerSource.includes('flowGenTemplates.remove('), 'remove goes through the store');
});

// --- FEAT-14b: flow-prompt-assistant handlers --------------------------------

test('service worker wires the prompt assistant functions and its handlers', () => {
  assert.match(serviceWorkerSource, /from "\.\/flow-prompt-assistant\.js"/);
  assert.ok(serviceWorkerSource.includes('message.type.startsWith("flow-prompt-assistant:")'), 'prompt assistant gets its own message block');
  assert.ok(serviceWorkerSource.includes('FLOW_PROMPT_ASSISTANT_FORBIDDEN'), 'the block is restricted to the extension UI');
  for (const action of [
    'flow-prompt-assistant:build', 'flow-prompt-assistant:parse', 'flow-prompt-assistant:parse-i2p',
  ]) {
    assert.ok(serviceWorkerSource.includes(`case "${action}"`), `missing handler ${action}`);
  }
  // The sidebar reads res.text after build, res.prompts after parse and
  // res.result after parse-i2p — the pure module functions answer them.
  assert.ok(serviceWorkerSource.includes('buildAssistantRequest({'), 'build assembles the request through the module');
  assert.ok(serviceWorkerSource.includes('parseAssistantReply(message.text)'), 'parse goes through the module');
  assert.ok(serviceWorkerSource.includes('parseImageToPromptReply(message.text)'), 'parse-i2p goes through the module');
});

// --- FEAT-12b: regen receipt fold — wiring -----------------------------------

test('service worker subscribes the regen receipt fold next to the batch run fold', () => {
  assert.ok(
    serviceWorkerSource.includes('flowBatchRuns.foldRegenReceipts(snapshot)'),
    'the queue subscribe callback folds regen receipts from every snapshot',
  );
  assert.match(batchRunsSource, /from "\.\/flow-regen-projection\.js"/, 'the run store imports the FEAT-12 fold');
  assert.ok(batchRunsSource.includes('foldRegenReceiptIntoRun('), 'the store fold is built on the pure FEAT-12 helper');
});

// --- FEAT-12b: regen receipt fold — behavior ---------------------------------

const genItem = prompt => ({
  operation: 'flow.generation.submit',
  payload: { type: 'image', prompt, attachments: [] },
  label: prompt,
});

const finishedJob = ({ id, batchIndex, media = [], failedOutputs = [], finishedAt = 2_000 }) => ({
  id,
  operation: 'flow.generation.submit',
  payload: { type: 'image', prompt: `prompt-${id}`, attachments: [] },
  label: `prompt-${id}`,
  status: 'completed',
  batch: { batchId: 'b1', batchLabel: 'Run', batchIndex, batchCount: 2 },
  addedAt: 1_000,
  finishedAt,
  metadata: {
    source: 'extension',
    generationResultCheckpoint: {
      media,
      ...(failedOutputs.length ? { failedOutputs } : {}),
      recordedAt: finishedAt,
    },
  },
});

const regenJob = ({ id = 'a2', batchId = 'b1', finishedAt = 6_000 } = {}) => ({
  id,
  operation: 'flow.generation.submit',
  payload: { type: 'image', prompt: 'prompt-root', attachments: [] },
  label: 'prompt-root',
  status: 'completed',
  batch: { batchId, batchLabel: 'Run', batchIndex: 0, batchCount: 2 },
  addedAt: 5_000,
  finishedAt,
  metadata: {
    source: 'extension',
    regenOf: 'root',
    regen: { rootJobId: 'root', slotKey: `batch:${batchId}:0`, attempt: 2 },
    generationResultCheckpoint: { media: [MEDIA('m1'), MEDIA('m2')], recordedAt: finishedAt },
  },
});

// Drive one run through its lifecycle: item 0 finishes partial, item 1
// finishes clean, the run finalizes as needs_review.
async function finalizedRun(storage = memoryStorage()) {
  const store = new FlowBatchRuns({ storage });
  const created = await store.create({ label: 'Run', items: [genItem('scene a'), genItem('scene b')] });
  const claim = await store.claim(created.id, created.revision);
  await store.recordAdmission(created.id, {
    batchId: 'b1',
    kind: 'initial',
    mapping: [
      { index: claim.indexes[0], jobId: 'root' },
      { index: claim.indexes[1], jobId: 'other' },
    ],
  });
  await store.observeSnapshot({
    jobs: [
      finishedJob({ id: 'root', batchIndex: 0, media: [MEDIA('m1')], failedOutputs: [{ title: 'tile-2', code: 'FLOW_GENERATION_FAILED' }] }),
      finishedJob({ id: 'other', batchIndex: 1, media: [MEDIA('m9')] }),
    ],
  });
  const run = await store.get(created.id);
  assert.equal(run.state, 'finalized', 'fixture run must be finalized');
  assert.equal(run.finalizeState, 'needs_review', 'fixture run finalized with a partial item');
  return { store, runId: created.id };
}

test('regen fold: a clean regen receipt lands in the finalized run and completes it', async () => {
  const { store, runId } = await finalizedRun();
  const results = await store.foldRegenReceipts({ jobs: [regenJob()] });
  assert.equal(results.length, 1, 'one run record changed');
  assert.equal(results[0].runId, runId);
  assert.equal(results[0].finalizeState, 'completed');
  const run = await store.get(runId);
  assert.equal(run.state, 'finalized', 'the run stays finalized — the fold rewrites its verdict, not its lifecycle');
  assert.equal(run.finalizeState, 'completed', 'the healed partial completes the run');
  const item = run.items.find(entry => entry.index === 0);
  assert.equal(item.receipt.jobId, 'a2', 'the item receipt is now the regen attempt receipt');
  assert.equal(item.receipt.partial, false);
  assert.deepEqual(item.receipt.results.map(media => media.id), ['m1', 'm2']);
  assert.deepEqual(run.regenReceiptIds, ['a2:6000'], 'the seen-receipt set records the folded receipt');
  assert.deepEqual(run.resumeIndexes, [], 'nothing is left unfinished');
});

test('regen fold: folding the same snapshot twice changes nothing the second time', async () => {
  const { store, runId } = await finalizedRun();
  await store.foldRegenReceipts({ jobs: [regenJob()] });
  const afterFirst = await store.get(runId);
  const second = await store.foldRegenReceipts({ jobs: [regenJob()] });
  assert.deepEqual(second, [], 'a duplicate receipt reports no change');
  assert.deepEqual(await store.get(runId), afterFirst, 'the record is untouched by the duplicate fold');
});

test('regen fold: a foreign batch or an unknown root never lands in a finalized run', async () => {
  const { store, runId } = await finalizedRun();
  const foreign = regenJob({ id: 'x1', batchId: 'other-batch' });
  assert.deepEqual(await store.foldRegenReceipts({ jobs: [foreign] }), []);
  const unknownRoot = regenJob({ id: 'x2' });
  unknownRoot.metadata.regen = { rootJobId: 'no-such-job', slotKey: 'batch:b1:0', attempt: 2 };
  unknownRoot.metadata.regenOf = 'no-such-job';
  assert.deepEqual(await store.foldRegenReceipts({ jobs: [unknownRoot] }), []);
  const run = await store.get(runId);
  assert.equal(run.finalizeState, 'needs_review', 'the run verdict is unchanged');
  assert.equal(run.items.find(entry => entry.index === 0).receipt.jobId, 'root');
});

test('regen fold: the active run is left to the regular snapshot fold', async () => {
  const storage = memoryStorage();
  const store = new FlowBatchRuns({ storage });
  const created = await store.create({ label: 'Run', items: [genItem('scene a'), genItem('scene b')] });
  const claim = await store.claim(created.id, created.revision);
  await store.recordAdmission(created.id, {
    batchId: 'b1',
    kind: 'initial',
    mapping: [
      { index: claim.indexes[0], jobId: 'root' },
      { index: claim.indexes[1], jobId: 'other' },
    ],
  });
  // Only item 0 has finished (partial): the run is still active, and a
  // regen of item 0 already completed — its receipt must NOT be folded
  // while the run is active (the regular fold owns active runs, and the
  // root job still rides the snapshot).
  const partialRoot = finishedJob({ id: 'root', batchIndex: 0, media: [MEDIA('m1')], failedOutputs: [{ title: 'tile-2', code: 'FLOW_GENERATION_FAILED' }] });
  await store.observeSnapshot({ jobs: [partialRoot] });
  assert.deepEqual(await store.foldRegenReceipts({ jobs: [regenJob()] }), []);
  let run = await store.get(created.id);
  assert.equal(run.state, 'active');
  assert.equal(run.items.find(entry => entry.index === 0).receipt.jobId, 'root', 'the original receipt stands while the run is active');
  // Once the run finalizes, the very next snapshot carrying the regen
  // job folds its receipt in.
  const cleanOther = finishedJob({ id: 'other', batchIndex: 1, media: [MEDIA('m9')] });
  await store.observeSnapshot({ jobs: [partialRoot, cleanOther] });
  run = await store.get(created.id);
  assert.equal(run.state, 'finalized');
  const results = await store.foldRegenReceipts({ jobs: [partialRoot, cleanOther, regenJob()] });
  assert.equal(results.length, 1);
  run = await store.get(created.id);
  assert.equal(run.finalizeState, 'completed');
  assert.equal(run.items.find(entry => entry.index === 0).receipt.jobId, 'a2');
});

test('regen fold: the folded record persists across a store reload', async () => {
  const storage = memoryStorage();
  const { store, runId } = await finalizedRun(storage);
  await store.foldRegenReceipts({ jobs: [regenJob()] });
  await store.flush();
  const reloaded = new FlowBatchRuns({ storage });
  const run = await reloaded.get(runId);
  assert.equal(run.finalizeState, 'completed');
  assert.deepEqual(run.regenReceiptIds, ['a2:6000']);
  assert.equal(run.items.find(entry => entry.index === 0).receipt.jobId, 'a2');
});
