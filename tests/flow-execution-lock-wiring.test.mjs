import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

import { FlowExecutionLock } from '../extension/src/background/flow-execution-lock.js';

// ---------------------------------------------------------------------------
// FEAT-11b — production wiring for the FEAT-11 cross-engine execution
// lock. FEAT-11 shipped FlowExecutionLock as a standalone module; the
// sidebar's transform jobs (metadata.transform stamped by
// buildTransformJob) already flowed through the regular queue, but no
// service-worker code held the lock, refused a cross-family submission,
// or surfaced a stop request. This suite pins the wiring:
//
//   - the worker owns ONE gate built on ONE FlowExecutionLock;
//   - the gate is extracted from the worker source and exercised in a
//     vm sandbox against the REAL lock (the flow-ref-preflight /
//     checkpoint-forwarding extraction pattern), fed with queue-shaped
//     snapshots and the real buildTransformJob output;
//   - source contracts pin the call sites: snapshot observation in the
//     queue subscribe callback, admission refusal in the UI add paths,
//     the transform-lock message surface, and the stop-request stamp
//     the snapshot fold writes onto the running job's record at the
//     queue's own generation checkpoints.
// ---------------------------------------------------------------------------

const serviceWorkerSource = readFileSync(new URL('../extension/src/background/service-worker.js', import.meta.url), 'utf8');
const transformsSource = readFileSync(new URL('../extension/src/content/shared/flow-transforms.js', import.meta.url), 'utf8');

// Objects produced inside the vm realm carry that realm's prototypes, so
// deepStrictEqual against test-realm literals needs a plain round-trip
// (the same convention as the other service-worker suites).
const plain = value => JSON.parse(JSON.stringify(value));

function extractGateFactory(source) {
  const start = source.indexOf('function createTransformExecutionGate(lock) {');
  assert.ok(start >= 0, 'service-worker.js must define createTransformExecutionGate');
  const end = source.indexOf('\nconst flowJobQueue = new FlowJobQueue(', start);
  assert.ok(end > start, 'the gate factory must precede the flowJobQueue singleton');
  return source.slice(start, end);
}

function loadGate({ now } = {}) {
  const factorySource = extractGateFactory(serviceWorkerSource);
  const sandbox = {};
  vm.runInNewContext(`${factorySource}\nthis.__createGate = createTransformExecutionGate;`, sandbox, { filename: 'service-worker-gate.js' });
  assert.equal(typeof sandbox.__createGate, 'function', 'the extracted factory must be callable');
  const lock = new FlowExecutionLock(now ? { now } : {});
  return { gate: sandbox.__createGate(lock), lock };
}

function loadTransforms() {
  const sandbox = {};
  vm.runInNewContext(transformsSource, sandbox, { filename: 'flow-transforms.js' });
  assert.ok(sandbox.FlowTransforms, 'flow-transforms.js must attach FlowTransforms to the global root');
  return sandbox.FlowTransforms;
}

const transformJob = (id, family, status = 'pending') => ({
  id,
  operation: 'flow.generation.submit',
  status,
  payload: { type: 'image', prompt: 'p', attachments: [{ assetName: 'src' }] },
  metadata: { source: 'extension', transform: { presetId: `${family}-preset`, family, params: {} } },
});
const plainJob = (id, status = 'pending') => ({
  id,
  operation: 'flow.generation.submit',
  status,
  payload: { type: 'image', prompt: 'p' },
  metadata: { source: 'extension' },
});
const snapshotOf = (...jobs) => ({ jobs });

// ---------------------------------------------------------------------------
// familyOf — the transform stamp is the only identification
// ---------------------------------------------------------------------------

test('familyOf reads the family from the buildTransformJob stamp', () => {
  const { gate } = loadGate();
  const transforms = loadTransforms();
  const preset = transforms.listTransformPresets('angles')[0];
  const built = transforms.buildTransformJob({ presetId: preset.id, values: {}, source: { assetName: 'hero' } });
  assert.equal(gate.familyOf(built), 'angles');
});

test('familyOf returns null for plain jobs and malformed stamps', () => {
  const { gate } = loadGate();
  assert.equal(gate.familyOf(plainJob('a')), null);
  assert.equal(gate.familyOf({ id: 'b', metadata: { transform: { family: '  ' } } }), null);
  assert.equal(gate.familyOf({ id: 'c', metadata: { transform: 'angles' } }), null);
  assert.equal(gate.familyOf({ id: 'd' }), null);
  assert.equal(gate.familyOf(null), null);
  // Family names normalize so casing/spacing in a stamp cannot split owners.
  assert.equal(gate.familyOf(transformJob('e', ' Angles ')), 'angles');
});

// ---------------------------------------------------------------------------
// Admission — a second family is refused while the lock is held
// ---------------------------------------------------------------------------

test('admissionRefusal admits everything while the lock is free', () => {
  const { gate } = loadGate();
  assert.equal(gate.admissionRefusal([transformJob('a', 'angles')]), null);
  assert.equal(gate.admissionRefusal([transformJob('b', 'effects')]), null);
  assert.equal(gate.admissionRefusal([transformJob('a', 'angles'), transformJob('b', 'effects')]), null);
  assert.equal(gate.admissionRefusal([plainJob('c')]), null);
  assert.equal(gate.admissionRefusal([]), null);
});

test('admissionRefusal refuses a different family with the typed lock payload', () => {
  const { gate } = loadGate({ now: () => 4242 });
  gate.observeSnapshot(snapshotOf(transformJob('run-1', 'angles', 'running')));
  const refusal = plain(gate.admissionRefusal([transformJob('new', 'effects')]));
  assert.equal(refusal.code, 'FLOW_TRANSFORM_EXECUTION_LOCKED');
  assert.equal(refusal.owner, 'angles');
  assert.equal(refusal.since, 4242);
  assert.equal(refusal.canStopCurrent, true);
  assert.match(refusal.message, /angles/);
});

test('admissionRefusal admits the holding family and plain jobs while locked', () => {
  const { gate } = loadGate();
  gate.observeSnapshot(snapshotOf(transformJob('run-1', 'angles', 'running')));
  assert.equal(gate.admissionRefusal([transformJob('next', 'angles')]), null);
  assert.equal(gate.admissionRefusal([plainJob('ordinary')]), null);
  // A mixed batch carrying even one foreign-family transform is refused whole.
  const refusal = plain(gate.admissionRefusal([transformJob('n', 'angles'), transformJob('x', 'effects')]));
  assert.equal(refusal.code, 'FLOW_TRANSFORM_EXECUTION_LOCKED');
  assert.equal(refusal.owner, 'angles');
});

// ---------------------------------------------------------------------------
// Snapshot observation — acquire at start, release at terminal
// ---------------------------------------------------------------------------

test('observeSnapshot acquires when a transform job starts running and releases when it ends', () => {
  const { gate, lock } = loadGate({ now: () => 1000 });
  gate.observeSnapshot(snapshotOf(transformJob('j1', 'effects', 'pending')));
  assert.equal(lock.current(), null, 'a pending job must not hold the lock');
  gate.observeSnapshot(snapshotOf(transformJob('j1', 'effects', 'running')));
  assert.deepEqual(lock.current(), { owner: 'effects', since: 1000 });
  // Repeated snapshots of the same run are re-entrant, never a conflict.
  gate.observeSnapshot(snapshotOf(transformJob('j1', 'effects', 'running')));
  assert.deepEqual(lock.current(), { owner: 'effects', since: 1000 });
  assert.equal(gate.status().conflict, null);
  gate.observeSnapshot(snapshotOf(transformJob('j1', 'effects', 'completed')));
  assert.equal(lock.current(), null, 'a terminal job releases the lock');
});

test('observeSnapshot releases on failed and cancelled terminal states too', () => {
  const { gate, lock } = loadGate();
  for (const terminal of ['failed', 'cancelled']) {
    gate.observeSnapshot(snapshotOf(transformJob('j', 'angles', 'running')));
    assert.equal(lock.current()?.owner, 'angles');
    gate.observeSnapshot(snapshotOf(transformJob('j', 'angles', terminal)));
    assert.equal(lock.current(), null, `${terminal} must release`);
  }
});

test('observeSnapshot: a same-family successor keeps the hold across the hand-off', () => {
  const { gate, lock } = loadGate({ now: () => 77 });
  gate.observeSnapshot(snapshotOf(transformJob('a1', 'angles', 'running'), transformJob('a2', 'angles', 'pending')));
  gate.observeSnapshot(snapshotOf(transformJob('a1', 'angles', 'completed'), transformJob('a2', 'angles', 'running')));
  assert.deepEqual(lock.current(), { owner: 'angles', since: 77 });
});

test('observeSnapshot: a cross-family overlap is surfaced as a conflict, then self-heals', () => {
  const { gate, lock } = loadGate();
  gate.observeSnapshot(snapshotOf(transformJob('a', 'angles', 'running')));
  // The effects job somehow started anyway (queued before, worker
  // restart recovery): the gate must not seize the lock, only surface it.
  gate.observeSnapshot(snapshotOf(transformJob('a', 'angles', 'running'), transformJob('e', 'effects', 'running')));
  assert.equal(lock.current()?.owner, 'angles');
  const conflict = plain(gate.status().conflict);
  assert.equal(conflict.family, 'effects');
  assert.equal(conflict.owner, 'angles');
  assert.equal(conflict.canStopCurrent, true);
  // Once the holder finishes, the still-running family acquires.
  gate.observeSnapshot(snapshotOf(transformJob('a', 'angles', 'completed'), transformJob('e', 'effects', 'running')));
  assert.equal(lock.current()?.owner, 'effects');
  assert.equal(gate.status().conflict, null);
});

// ---------------------------------------------------------------------------
// Stop requests — recorded on the lock, visible at the owner's checkpoint
// ---------------------------------------------------------------------------

test('requestStop records on the lock and stopRequestFor only answers the owner', () => {
  const { gate } = loadGate({ now: () => 555 });
  gate.observeSnapshot(snapshotOf(transformJob('a', 'angles', 'running')));
  const result = plain(gate.requestStop('effects'));
  assert.equal(result.ok, true);
  assert.equal(result.owner, 'angles');
  assert.deepEqual(plain(gate.stopRequestFor('angles')), { requestedBy: 'effects', at: 555 });
  assert.equal(gate.stopRequestFor('effects'), null);
  assert.deepEqual(plain(gate.status().stopRequested), { requestedBy: 'effects', at: 555 });
  // The owner asking to stop itself is refused by the lock discipline.
  assert.equal(gate.requestStop('angles').ok, false);
  // Terminal release clears the recorded request.
  gate.observeSnapshot(snapshotOf(transformJob('a', 'angles', 'completed')));
  assert.equal(gate.status().stopRequested, null);
});

test('status reports the hold for the transform-lock surface', () => {
  const { gate } = loadGate({ now: () => 9 });
  assert.deepEqual(plain(gate.status()), {
    held: false, owner: null, since: null, stopRequested: null, conflict: null, runningFamilies: [],
  });
  gate.observeSnapshot(snapshotOf(transformJob('a', 'angles', 'running')));
  const status = plain(gate.status());
  assert.equal(status.held, true);
  assert.equal(status.owner, 'angles');
  assert.equal(status.since, 9);
  assert.deepEqual(status.runningFamilies, ['angles']);
});

// ---------------------------------------------------------------------------
// Source contracts — the worker actually wires the gate in
// ---------------------------------------------------------------------------

test('wiring: the worker owns exactly one gate on one FlowExecutionLock', () => {
  assert.match(serviceWorkerSource, /import \{ FlowExecutionLock \} from "\.\/flow-execution-lock\.js";/);
  assert.equal(serviceWorkerSource.split('createTransformExecutionGate(new FlowExecutionLock())').length - 1, 1);
});

test('wiring: queue snapshots fold through the gate in the subscribe callback', () => {
  const start = serviceWorkerSource.indexOf('flowJobQueue.subscribe((snapshot, reason) => {');
  assert.ok(start >= 0);
  const region = serviceWorkerSource.slice(start, start + 2600);
  assert.match(region, /flowTransformGate\.observeSnapshot\(snapshot\)/);
});

test('wiring: the UI add paths refuse through the gate before enqueueing', () => {
  const addStart = serviceWorkerSource.indexOf('case "flow-queue:add":');
  const batchStart = serviceWorkerSource.indexOf('case "flow-queue:add-batch":');
  assert.ok(addStart >= 0 && batchStart > addStart);
  const addRegion = serviceWorkerSource.slice(addStart, batchStart);
  assert.match(addRegion, /flowTransformGate\.admissionRefusal\(/);
  assert.ok(addRegion.indexOf('flowTransformGate.admissionRefusal(') < addRegion.indexOf('flowJobQueue.add('),
    'the refusal check must precede the enqueue in flow-queue:add');
  const nextCase = serviceWorkerSource.indexOf('case "flow-queue:pause":', batchStart);
  const batchRegion = serviceWorkerSource.slice(batchStart, nextCase);
  assert.match(batchRegion, /flowTransformGate\.admissionRefusal\(/);
  assert.ok(batchRegion.indexOf('flowTransformGate.admissionRefusal(') < batchRegion.indexOf('flowJobQueue.addBatch('),
    'the refusal check must precede the enqueue in flow-queue:add-batch');
});

test('wiring: the transform-lock message surface exists', () => {
  assert.match(serviceWorkerSource, /case "flow-queue:transform-lock":/);
  assert.match(serviceWorkerSource, /case "flow-queue:transform-lock-stop":/);
  assert.match(serviceWorkerSource, /flowTransformGate\.requestStop\(/);
  assert.match(serviceWorkerSource, /flowTransformGate\.status\(\)/);
});

test('wiring: the snapshot fold surfaces a pending stop request on the job at queue checkpoints', () => {
  const start = serviceWorkerSource.indexOf('flowJobQueue.subscribe((snapshot, reason) => {');
  assert.ok(start >= 0);
  const end = serviceWorkerSource.indexOf('async function trackDraftRun(', start);
  const callback = serviceWorkerSource.slice(start, end);
  // The stamp is gated on the queue's own generation checkpoint
  // emissions and consults the gate for running transform jobs only.
  assert.match(callback, /reason === "generation-observation-checkpoint"/);
  assert.match(callback, /reason === "generation-result-checkpoint"/);
  assert.match(callback, /flowTransformGate\.stopRequestFor\(flowTransformGate\.familyOf\(job\)\)/);
  assert.match(callback, /flowJobQueue\.updateMetadata\(job\.id, \{ transformStopRequested: stop \}\)/);
  // The runner itself stays free of gate references: extraction-based
  // worker suites run it in a sandbox that supplies only its existing
  // closure helpers, and the fold above is the honest checkpoint hook.
  const runnerStart = serviceWorkerSource.indexOf('async function runExtensionFlowJob(job, hooks) {');
  const runnerEnd = serviceWorkerSource.indexOf('\nconst flowMediaCatalog = new FlowMediaCatalog();', runnerStart);
  const runner = serviceWorkerSource.slice(runnerStart, runnerEnd);
  assert.ok(!runner.includes('flowTransformGate'), 'the runner must not reference the gate directly');
});
