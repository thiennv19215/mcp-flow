import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import {
  projectRegenSlots,
  computeSlotAggregate,
  stampRegenLineage,
  regenSlotKey,
  regenRootJobId,
  regenReceiptId,
  foldRegenReceiptIntoRun,
} from '../extension/src/background/flow-regen-projection.js';
import { FlowJobQueue } from '../extension/src/background/flow-job-queue.js';
import { computeFinalizeState } from '../extension/src/background/flow-batch-runs.js';

const queueSource = readFileSync(new URL('../extension/src/background/flow-job-queue.js', import.meta.url), 'utf8');
const panelSource = readFileSync(new URL('../extension/src/ui/flow-queue-panel.js', import.meta.url), 'utf8');
const trackerSource = readFileSync(new URL('../extension/src/content/floating-tracker-flow.js', import.meta.url), 'utf8');

// ---------------------------------------------------------------------------
// FEAT-12: regenerate-in-place (slot lineage + projection).
//
// Regenerating one item does NOT create an unrelated new job: the new
// attempt carries a regen-of lineage pointer to the original item (the
// root). A projection folds all attempts of a slot into one display slot
// (newest wins), recomputes the owning scope's status/counts from slot
// winners (active -> running/paused; otherwise stopped > failed >
// completed), and folds regen receipts back into the FEAT-02 batch record
// idempotently via a seen-receipt set. A regen attempt whose live
// snapshot disappears projects as failed with recovery exhausted, never
// stuck "running".
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

// A queue job in snapshot shape.
const job = ({
  id, status = 'completed', addedAt = 1_000, finishedAt = 2_000,
  batchId = null, batchIndex = null, prompt = `prompt-${id}`,
  regen = null, regenOf = null, partial = false, media = [], failedOutputs = [],
  error = null, errorCode = null,
}) => ({
  id,
  operation: 'flow.generation.submit',
  payload: { type: 'image', prompt, attachments: [] },
  label: prompt,
  status,
  addedAt,
  finishedAt: ['completed', 'failed', 'cancelled'].includes(status) ? finishedAt : undefined,
  ...(batchId ? { batch: { batchId, batchLabel: 'Run', batchIndex, batchCount: 3 } } : {}),
  ...(partial ? { partial: true } : {}),
  metadata: {
    source: 'extension',
    ...(regen ? { regen } : {}),
    ...(regenOf ? { regenOf } : {}),
    ...(media.length || failedOutputs.length
      ? { generationResultCheckpoint: { media, ...(failedOutputs.length ? { failedOutputs } : {}), recordedAt: finishedAt } }
      : {}),
  },
  ...(error ? { error } : {}),
  ...(errorCode ? { errorCode } : {}),
});

const regenMeta = (rootJobId, slotKey, attempt) => ({ rootJobId, slotKey, attempt });

// --- lineage ----------------------------------------------------------------

test('lineage: the root of a regen chain is the original job, however deep the chain', () => {
  const original = job({ id: 'root', batchId: 'b1', batchIndex: 0 });
  const attempt2 = job({
    id: 'a2', batchId: 'b1', batchIndex: 0, addedAt: 3_000,
    regen: regenMeta('root', 'batch:b1:0', 2),
  });
  const attempt3 = job({
    id: 'a3', batchId: 'b1', batchIndex: 0, addedAt: 5_000,
    regen: regenMeta('root', 'batch:b1:0', 3),
  });
  const byId = new Map([original, attempt2, attempt3].map(item => [item.id, item]));
  assert.equal(regenRootJobId(original, byId), 'root');
  assert.equal(regenRootJobId(attempt2, byId), 'root');
  assert.equal(regenRootJobId(attempt3, byId), 'root');
  assert.equal(regenSlotKey(attempt3, byId), 'batch:b1:0');
  // A standalone job is its own slot, keyed by its own id.
  const solo = job({ id: 'solo' });
  assert.equal(regenSlotKey(solo, new Map([['solo', solo]])), 'job:solo');
});

test('lineage: stampRegenLineage resolves the root through a chain and counts attempts', () => {
  const original = job({ id: 'root', batchId: 'b1', batchIndex: 1 });
  const attempt2 = job({
    id: 'a2', batchId: 'b1', batchIndex: 1, addedAt: 3_000,
    regen: regenMeta('root', 'batch:b1:1', 2),
  });
  const jobs = [original, attempt2];
  // Regenerating attempt 2 must point at the ROOT, not at attempt 2.
  const stamped = stampRegenLineage({ source: 'extension' }, attempt2, jobs);
  assert.equal(stamped.regenOf, 'a2');
  assert.deepEqual(stamped.regen, { rootJobId: 'root', slotKey: 'batch:b1:1', attempt: 3 });
  // The input metadata is not mutated.
  assert.equal(stamped.source, 'extension');
  // Unknown target -> no lineage (the queue turns this into a typed error).
  assert.equal(stampRegenLineage({}, null, jobs), null);
  assert.equal(stampRegenLineage({}, undefined, jobs), null);
});

// --- projection: folding -----------------------------------------------------

test('projection: attempts of one slot fold to a single display slot, newest wins', () => {
  const original = job({ id: 'root', batchId: 'b1', batchIndex: 0, status: 'failed', error: 'boom', errorCode: 'FLOW_X' });
  const attempt2 = job({
    id: 'a2', batchId: 'b1', batchIndex: 0, addedAt: 4_000, status: 'completed', media: [MEDIA('m2')],
    regen: regenMeta('root', 'batch:b1:0', 2),
  });
  const other = job({ id: 'other', batchId: 'b1', batchIndex: 1, status: 'completed', media: [MEDIA('m1')] });
  const slots = projectRegenSlots([original, attempt2, other]);
  assert.equal(slots.length, 2, 'three jobs, two slots');
  const folded = slots.find(slot => slot.slotKey === 'batch:b1:0');
  assert.equal(folded.winner.id, 'a2', 'the newest attempt wins the slot');
  assert.equal(folded.status, 'completed');
  assert.equal(folded.attemptCount, 2);
  assert.deepEqual(folded.attemptIds, ['root', 'a2']);
  assert.equal(folded.rootJobId, 'root');
  const plain = slots.find(slot => slot.slotKey === 'batch:b1:1');
  assert.equal(plain.attemptCount, 1);
  assert.equal(plain.winner.id, 'other');
});

test('projection: an in-flight regen attempt wins over the completed original', () => {
  const original = job({ id: 'root', status: 'completed', media: [MEDIA('m1')] });
  const attempt2 = job({
    id: 'a2', status: 'running', addedAt: 9_000,
    regen: regenMeta('root', 'job:root', 2),
  });
  const slots = projectRegenSlots([original, attempt2]);
  assert.equal(slots.length, 1);
  assert.equal(slots[0].winner.id, 'a2');
  assert.equal(slots[0].status, 'running', 'the slot reflects the live attempt, not the stale completion');
});

// --- projection: aggregate status/counts -------------------------------------

test('aggregate: status recomputed from slot winners — active beats everything', () => {
  const slots = projectRegenSlots([
    job({ id: 'a', status: 'completed' }),
    job({ id: 'b', status: 'failed' }),
    job({ id: 'c', status: 'running' }),
  ]);
  const aggregate = computeSlotAggregate(slots);
  assert.equal(aggregate.status, 'running');
  assert.deepEqual(
    { total: aggregate.total, completed: aggregate.completed, failed: aggregate.failed, active: aggregate.active },
    { total: 3, completed: 1, failed: 1, active: 1 },
  );
  assert.equal(computeSlotAggregate(slots, { paused: true }).status, 'paused');
});

test('aggregate: precedence stopped > failed > completed once nothing is active', () => {
  const stopped = computeSlotAggregate(projectRegenSlots([
    job({ id: 'a', status: 'completed' }),
    job({ id: 'b', status: 'failed' }),
    job({ id: 'c', status: 'cancelled' }),
  ]));
  assert.equal(stopped.status, 'stopped', 'a cancelled winner makes the scope stopped, outranking failed');
  const failed = computeSlotAggregate(projectRegenSlots([
    job({ id: 'a', status: 'completed' }),
    job({ id: 'b', status: 'failed' }),
  ]));
  assert.equal(failed.status, 'failed');
  const completed = computeSlotAggregate(projectRegenSlots([
    job({ id: 'a', status: 'completed' }),
    job({ id: 'b', status: 'completed' }),
  ]));
  assert.equal(completed.status, 'completed');
  assert.equal(computeSlotAggregate([]).status, 'idle');
});

// --- projection: vanished regen attempt --------------------------------------

test('projection: a regen attempt whose snapshot disappears projects failed with recovery exhausted', () => {
  const original = job({ id: 'root', batchId: 'b1', batchIndex: 0, status: 'completed', media: [MEDIA('m1')] });
  const attempt2 = job({
    id: 'a2', batchId: 'b1', batchIndex: 0, addedAt: 4_000, status: 'running',
    regen: regenMeta('root', 'batch:b1:0', 2),
  });
  const previous = projectRegenSlots([original, attempt2]);
  assert.equal(previous[0].status, 'running');
  // The next snapshot no longer carries the regen attempt at all (its live
  // snapshot disappeared). The slot must NOT fall back to the stale
  // completion NOR stay "running" forever: it projects failed with
  // recovery exhausted.
  const next = projectRegenSlots([original], previous);
  const slot = next.find(item => item.slotKey === 'batch:b1:0');
  assert.equal(slot.status, 'failed');
  assert.equal(slot.recoveryExhausted, true);
  assert.equal(slot.winner.id, 'a2', 'the ghost winner is the vanished attempt, marked failed');
  assert.equal(slot.winner.status, 'failed');
  const aggregate = computeSlotAggregate(next);
  assert.equal(aggregate.status, 'failed');
  assert.equal(aggregate.active, 0, 'nothing is stuck active');
});

test('projection: no ghost when a newer attempt exists or the vanished winner was terminal', () => {
  const original = job({ id: 'root', status: 'completed', media: [MEDIA('m1')] });
  const attempt2 = job({
    id: 'a2', status: 'running', addedAt: 4_000,
    regen: regenMeta('root', 'job:root', 2),
  });
  const previous = projectRegenSlots([original, attempt2]);
  // A newer attempt arrived: the slot lives on, no ghost.
  const attempt3 = job({
    id: 'a3', status: 'completed', addedAt: 8_000, media: [MEDIA('m3')],
    regen: regenMeta('root', 'job:root', 3),
  });
  const continued = projectRegenSlots([original, attempt3], previous);
  assert.equal(continued.length, 1);
  assert.equal(continued[0].winner.id, 'a3');
  assert.equal(continued[0].recoveryExhausted, false);
  // A terminal winner that disappears is just gone (explicit removal).
  const terminalPrevious = projectRegenSlots([original]);
  const emptied = projectRegenSlots([], terminalPrevious);
  assert.equal(emptied.length, 0);
});

// --- receipt fold into the batch record --------------------------------------

function makeRun() {
  return {
    id: 'run-1',
    version: 1,
    label: 'Run',
    settings: null,
    refPool: [],
    revision: 3,
    state: 'finalized',
    finalizeState: 'needs_review',
    batchId: 'b1',
    segments: [{ batchId: 'b1', kind: 'initial', indexes: [0, 1], admittedAt: 1_500 }],
    resumeIndexes: [0],
    createdAt: 100,
    updatedAt: 2_000,
    items: [
      {
        index: 0, input: { operation: 'flow.generation.submit' }, hidden: false, runtimeJobId: 'root',
        receipt: {
          status: 'completed', jobId: 'root', finishedAt: 2_000,
          results: [MEDIA('m1')], failedOutputs: [{ title: 'tile-2', code: 'FLOW_GENERATION_FAILED' }],
          partial: true, error: null, errorCode: null,
        },
      },
      {
        index: 1, input: { operation: 'flow.generation.submit' }, hidden: false, runtimeJobId: 'other',
        receipt: {
          status: 'completed', jobId: 'other', finishedAt: 2_000,
          results: [MEDIA('m9')], failedOutputs: [], partial: false, error: null, errorCode: null,
        },
      },
    ],
  };
}

test('receipt fold: a clean regen receipt heals a partial item and can complete the run', () => {
  const run = makeRun();
  const regenJob = job({
    id: 'a2', batchId: 'b1', batchIndex: 0, addedAt: 5_000, finishedAt: 6_000,
    status: 'completed', media: [MEDIA('m1'), MEDIA('m2')],
    regen: regenMeta('root', 'batch:b1:0', 2),
  });
  assert.equal(regenReceiptId(regenJob), 'a2:6000');
  const folded = foldRegenReceiptIntoRun(run, regenJob);
  assert.equal(folded.changed, true);
  const item = folded.run.items[0];
  assert.equal(item.receipt.jobId, 'a2', 'the item receipt is now the regen attempt receipt');
  assert.equal(item.receipt.partial, false);
  assert.deepEqual(item.receipt.results.map(media => media.id), ['m1', 'm2']);
  assert.deepEqual(folded.run.regenReceiptIds, ['a2:6000']);
  assert.deepEqual(folded.run.resumeIndexes, [], 'nothing is left unfinished');
  assert.equal(computeFinalizeState(folded.run), 'completed', 'partial -> completed after a successful regen');
  // The input run record was not mutated.
  assert.equal(run.items[0].receipt.jobId, 'root');
  assert.equal(run.regenReceiptIds, undefined);
});

test('receipt fold: a duplicate regen receipt folds idempotently (seen-receipt set)', () => {
  const run = makeRun();
  const regenJob = job({
    id: 'a2', batchId: 'b1', batchIndex: 0, addedAt: 5_000, finishedAt: 6_000,
    status: 'completed', media: [MEDIA('m1'), MEDIA('m2')],
    regen: regenMeta('root', 'batch:b1:0', 2),
  });
  const once = foldRegenReceiptIntoRun(run, regenJob);
  const twice = foldRegenReceiptIntoRun(once.run, regenJob);
  assert.equal(twice.changed, false, 'the same receipt never folds twice');
  assert.deepEqual(twice.run, once.run, 'the record is byte-identical after the duplicate fold');
  assert.deepEqual(twice.run.regenReceiptIds, ['a2:6000'], 'the seen set holds the receipt id exactly once');
});

test('receipt fold: foreign sessions, unknown roots and live jobs never fold', () => {
  const run = makeRun();
  const foreign = job({
    id: 'x1', batchId: 'other-batch', batchIndex: 0, status: 'completed', media: [MEDIA('mx')],
    regen: regenMeta('root', 'batch:other-batch:0', 2),
  });
  assert.equal(foldRegenReceiptIntoRun(run, foreign).changed, false, 'tracker session (batch id) must match');
  const unknownRoot = job({
    id: 'x2', batchId: 'b1', batchIndex: 0, status: 'completed', media: [MEDIA('mx')],
    regen: regenMeta('no-such-job', 'batch:b1:0', 2),
  });
  assert.equal(foldRegenReceiptIntoRun(run, unknownRoot).changed, false, 'the root must own a run item');
  const live = job({
    id: 'x3', batchId: 'b1', batchIndex: 0, status: 'running',
    regen: regenMeta('root', 'batch:b1:0', 2),
  });
  assert.equal(foldRegenReceiptIntoRun(run, live).changed, false, 'only terminal attempts produce receipts');
  assert.equal(regenReceiptId(live), null);
});

// --- queue integration --------------------------------------------------------

function makeQueue(runner, storage = memoryStorage()) {
  return new FlowJobQueue(runner, { storage, minDelayMs: 0, maxDelayMs: 0 });
}

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

test('queue: regenerate() creates a new attempt carrying the regen-of lineage to the root', async () => {
  const queue = makeQueue(async () => ({ ok: true }));
  const original = await queue.add({ operation: 'flow.generation.submit', payload: { type: 'image', prompt: 'scene' }, label: 'scene' });
  const drained = untilSnapshot(queue, snapshot => !snapshot.isRunning && snapshot.jobs.every(item => item.status === 'completed'));
  await queue.start();
  await drained;
  const attempt2 = await queue.regenerate(original.id);
  assert.notEqual(attempt2.id, original.id, 'regen is a NEW job, not the old record revived');
  assert.equal(attempt2.status, 'pending');
  assert.equal(attempt2.payload.prompt, 'scene', 'the new attempt re-runs the same item inputs');
  assert.equal(attempt2.metadata.regenOf, original.id);
  assert.deepEqual(attempt2.metadata.regen, { rootJobId: original.id, slotKey: `job:${original.id}`, attempt: 2 });
  // Regenerating the regen attempt still roots at the original.
  const drained2 = untilSnapshot(queue, snapshot => !snapshot.isRunning && snapshot.jobs.every(item => item.status === 'completed'));
  await queue.start();
  await drained2;
  const attempt3 = await queue.regenerate(attempt2.id);
  assert.equal(attempt3.metadata.regen.rootJobId, original.id);
  assert.equal(attempt3.metadata.regen.attempt, 3);
  await queue.stop();
});

test('queue: regenerate() refuses a job that has not finished', async () => {
  const queue = makeQueue(async () => ({ ok: true }));
  const pending = await queue.add({ operation: 'flow.generation.submit', payload: { prompt: 'later' }, label: 'later' });
  await assert.rejects(queue.regenerate(pending.id), error => error.code === 'FLOW_REGEN_TARGET_NOT_TERMINAL');
  await assert.rejects(queue.regenerate('missing-id'), error => error.code === 'FLOW_REGEN_TARGET_NOT_FOUND');
});

test('queue: add() with metadata.regenOf stamps canonical lineage; an unknown target is refused', async () => {
  const queue = makeQueue(async () => ({ ok: true }));
  const original = await queue.add({ operation: 'flow.generation.submit', payload: { prompt: 'scene' }, label: 'scene' });
  const drained = untilSnapshot(queue, snapshot => !snapshot.isRunning && snapshot.jobs.every(item => item.status === 'completed'));
  await queue.start();
  await drained;
  const added = await queue.add({
    operation: 'flow.generation.submit',
    payload: { prompt: 'scene' },
    label: 'scene',
    metadata: { source: 'extension', regenOf: original.id },
  });
  assert.deepEqual(added.metadata.regen, { rootJobId: original.id, slotKey: `job:${original.id}`, attempt: 2 });
  await assert.rejects(
    queue.add({ operation: 'flow.generation.submit', payload: { prompt: 'ghost' }, metadata: { regenOf: 'no-such-job' } }),
    error => error.code === 'FLOW_REGEN_TARGET_NOT_FOUND',
  );
  const listed = await queue.list();
  assert.equal(listed.some(item => item.label === 'ghost'), false, 'a refused regen never becomes an unrelated job');
  await queue.stop();
});

test('queue: the snapshot projection folds attempts and recomputes counts from winners', async () => {
  const queue = makeQueue(async () => ({ ok: true }));
  const batch = await queue.addBatch([
    { operation: 'flow.generation.submit', payload: { type: 'image', prompt: 'one' }, label: 'one' },
    { operation: 'flow.generation.submit', payload: { type: 'image', prompt: 'two' }, label: 'two' },
  ], { batchId: 'batch-regen', batchLabel: 'Regen batch' });
  const drained = untilSnapshot(queue, snapshot => !snapshot.isRunning && snapshot.jobs.every(item => item.status === 'completed'));
  await queue.start();
  const drainedSnapshot = await drained;
  assert.equal(drainedSnapshot.slots.length, 2);
  assert.equal(drainedSnapshot.slotStatus, 'completed');
  const attempt2 = await queue.regenerate(batch[0].id);
  const snapshot = await queue.snapshot();
  assert.equal(snapshot.jobs.length, 3, 'the raw job list still carries every attempt');
  assert.equal(snapshot.slots.length, 2, 'the projection folds the regen attempt into its slot');
  const slot = snapshot.slots.find(item => item.slotKey === 'batch:batch-regen:0');
  assert.equal(slot.winner.id, attempt2.id);
  assert.equal(slot.attemptCount, 2);
  assert.equal(snapshot.slotCounts.total, 2);
  assert.equal(snapshot.slotCounts.completed, 1, 'counts come from winners: the slot being re-run is not completed');
  assert.equal(snapshot.slotCounts.active, 1);
  assert.equal(snapshot.slotStatus, 'running');
  await queue.stop();
});

test('queue source: regenerate + projection wiring lives in flow-job-queue.js', () => {
  assert.match(queueSource, /regenerate\(/, 'the queue exposes regenerate()');
  assert.match(queueSource, /flow-regen-projection\.js/, 'the queue imports the projection module');
  assert.match(queueSource, /projectRegenSlots/, 'snapshots carry the slot projection');
  assert.match(queueSource, /FLOW_REGEN_TARGET_NOT_FOUND/);
});

// --- panel consumption --------------------------------------------------------

class FakeEl {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.attributes = {};
    this.className = '';
    this.textContent = '';
    this.hidden = false;
    this.disabled = false;
  }

  append(...nodes) { this.children.push(...nodes); }
  appendChild(node) { this.children.push(node); return node; }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  querySelector() { return null; }
  querySelectorAll() { return []; }
}

function findByClass(element, needle, found = []) {
  if (!element || typeof element !== 'object') return found;
  if (String(element.className || '').split(/\s+/).includes(needle)) found.push(element);
  for (const child of element.children || []) findByClass(child, needle, found);
  return found;
}

function findButtons(element, found = []) {
  if (!element || typeof element !== 'object') return found;
  if (element.dataset?.flowQueueAction) found.push(element);
  for (const child of element.children || []) findButtons(child, found);
  return found;
}

function makePanel(sent) {
  const documentFake = {
    createElement: tag => new FakeEl(tag),
    createDocumentFragment: () => new FakeEl('#fragment'),
    getElementById: () => null,
    head: new FakeEl('head'),
    documentElement: new FakeEl('html'),
  };
  const runtime = {
    sendMessage: async message => {
      sent.push(message);
      if (message.type === 'flow-queue:get') return { ok: true, jobs: [], slots: [] };
      return { ok: true };
    },
    onMessage: { addListener() {}, removeListener() {} },
  };
  const sandbox = { console, document: documentFake, structuredClone: value => JSON.parse(JSON.stringify(value)) };
  const context = vm.createContext(sandbox);
  vm.runInContext(panelSource, context);
  const container = new FakeEl('div');
  container.ownerDocument = documentFake;
  container.contains = () => true;
  const panel = new context.FlowQueuePanel(container, { runtime });
  panel.itemsElement = new FakeEl('div');
  panel.summary = new FakeEl('span');
  panel.attentionBanner = new FakeEl('div');
  return panel;
}

const panelJobs = () => {
  const original = job({ id: 'root', batchId: 'b1', batchIndex: 0, status: 'completed', prompt: 'first scene', media: [MEDIA('m1')] });
  const attempt2 = job({
    id: 'a2', batchId: 'b1', batchIndex: 0, addedAt: 4_000, status: 'completed', prompt: 'first scene', media: [MEDIA('m2')],
    regen: regenMeta('root', 'batch:b1:0', 2),
  });
  const other = job({ id: 'other', batchId: 'b1', batchIndex: 1, status: 'failed', prompt: 'second scene', error: 'boom', errorCode: 'FLOW_X' });
  return { original, attempt2, other, slots: projectRegenSlots([original, attempt2, other]) };
};

test('panel: a snapshot with slots renders one folded row per slot with the attempt count', () => {
  const sent = [];
  const panel = makePanel(sent);
  const { original, attempt2, other, slots } = panelJobs();
  panel.snapshot = { jobs: [original, attempt2, other], items: [original, attempt2, other], slots, slotCounts: computeSlotAggregate(slots) };
  panel.render();
  const rows = findByClass(panel.itemsElement, 'flow-queue-panel__item');
  assert.equal(rows.length, 2, 'three attempts render as two display slots');
  const foldedRow = rows.find(row => row.dataset.regenSlot === 'batch:b1:0');
  assert.ok(foldedRow, 'the folded row carries its slot key');
  const badges = findByClass(foldedRow, 'flow-queue-panel__regen-badge');
  assert.equal(badges.length, 1);
  assert.match(badges[0].textContent, /2/, 'the badge names the attempt count');
  assert.match(panel.summary.textContent, /^2 /, 'the summary counts slots, not raw attempts');
});

test('panel: the regenerate button re-adds the winner with a regenOf lineage pointer', async () => {
  const sent = [];
  const panel = makePanel(sent);
  const { original, attempt2, other, slots } = panelJobs();
  panel.snapshot = { jobs: [original, attempt2, other], items: [original, attempt2, other], slots, slotCounts: computeSlotAggregate(slots) };
  panel.render();
  const rows = findByClass(panel.itemsElement, 'flow-queue-panel__item');
  const foldedRow = rows.find(row => row.dataset.regenSlot === 'batch:b1:0');
  const regenButton = findButtons(foldedRow).find(button => button.dataset.flowQueueAction === 'regenerate');
  assert.ok(regenButton, 'a terminal generation winner offers regenerate');
  assert.equal(regenButton.dataset.itemId, 'a2', 'regenerating targets the winning attempt');
  regenButton.closest = () => regenButton;
  await panel._handleClick({ target: regenButton });
  const addMessage = sent.find(message => message.type === 'flow-queue:add');
  assert.ok(addMessage, 'regenerate rides the existing flow-queue:add message');
  assert.equal(addMessage.job.metadata.regenOf, 'a2');
  assert.equal(addMessage.job.operation, 'flow.generation.submit');
  assert.equal(addMessage.job.payload.prompt, 'first scene', 'the new attempt re-runs the winner inputs');
  assert.equal(addMessage.job.metadata.generationResultCheckpoint, undefined, 'stale receipts never ride into the new attempt');
});

test('panel source: slot folding + regenerate action are wired', () => {
  assert.match(panelSource, /snapshot\?\.slots|snapshot\.slots/, 'the panel consumes the snapshot projection');
  assert.match(panelSource, /"regenerate"/, 'the panel handles the regenerate action');
  assert.match(panelSource, /regenOf/, 'the panel sends the lineage pointer');
});

// --- tracker consumption ------------------------------------------------------

test('tracker source: syncQueueSnapshot folds attempts via snapshot slots and tombstones a vanished regen', () => {
  assert.match(trackerSource, /snapshot\?\.slots|snapshot\.slots/, 'the tracker consumes the snapshot projection');
  assert.match(trackerSource, /recoveryExhausted/, 'the tracker marks a vanished regen attempt recovery-exhausted');
  assert.match(trackerSource, /attemptCount/, 'the tracker surfaces the folded attempt count');
});

test('tracker: cards fold to the slot winner and a vanished regen attempt tombstones as failed', () => {
  const sandbox = { console };
  sandbox.window = { addEventListener() {} };
  const context = vm.createContext(sandbox);
  vm.runInContext(trackerSource, context);
  const tracker = sandbox.flowFloatingTracker;
  assert.ok(tracker, 'the tracker instance is exposed');

  const original = job({ id: 'root', batchId: 'b1', batchIndex: 0, status: 'completed', media: [MEDIA('m1')] });
  const attempt2 = job({
    id: 'a2', batchId: 'b1', batchIndex: 0, addedAt: 4_000, status: 'running',
    regen: regenMeta('root', 'batch:b1:0', 2),
  });
  tracker.syncQueueSnapshot({ jobs: [original, attempt2], slots: projectRegenSlots([original, attempt2]) });
  assert.equal(tracker.jobs.size, 1, 'two attempts fold into one card');
  const winnerCard = tracker.jobs.get('a2');
  assert.ok(winnerCard, 'the card belongs to the winning attempt');
  assert.equal(winnerCard.status, 'rendering');
  assert.equal(winnerCard.attemptCount, 2);

  // The regen attempt disappears from the next snapshot entirely.
  tracker.syncQueueSnapshot({ jobs: [original], slots: projectRegenSlots([original]) });
  const tombstone = tracker.jobs.get('a2');
  assert.ok(tombstone, 'the vanished attempt is NOT purged');
  assert.equal(tombstone.status, 'failed', 'it projects failed, never stuck rendering');
  assert.equal(tombstone.recoveryExhausted, true);
  assert.ok(tracker.jobs.get('root'), 'the original attempt keeps its own card');

  // A newer attempt of the same slot supersedes the tombstone.
  const attempt3 = job({
    id: 'a3', batchId: 'b1', batchIndex: 0, addedAt: 9_000, status: 'completed', media: [MEDIA('m3')],
    regen: regenMeta('root', 'batch:b1:0', 3),
  });
  tracker.syncQueueSnapshot({ jobs: [original, attempt3], slots: projectRegenSlots([original, attempt3]) });
  assert.equal(tracker.jobs.has('a2'), false, 'the tombstone is superseded');
  assert.equal(tracker.jobs.get('a3')?.status, 'completed');
});
