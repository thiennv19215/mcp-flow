import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Audit cluster E — SW enqueue choreography, one place each:
//
// - enqueueJobs: single job -> queue.add, batch -> queue.addBatch
//   (atomic preflight), empty input -> [] without touching the queue.
// - startEnqueuedWork: pause-preserving start after enqueue.
//   autoStart === false suppresses the start; `started` lets
//   retry-batch skip the start when nothing was retried; a
//   caller-supplied snapshot is used as-is (draft runs snapshot before
//   bookkeeping, then apply the rule to that snapshot).
//
// The helpers are extracted verbatim from service-worker.js (brace
// matched, not re-implemented) and run against a stub queue.
// ---------------------------------------------------------------------------

function helpersHarness(queueStub) {
  const source = readFileSync(new URL('../extension/src/background/service-worker.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function enqueueJobs');
  assert.notEqual(start, -1, 'enqueueJobs must exist in service-worker.js');
  const second = source.indexOf('async function startEnqueuedWork', start);
  assert.notEqual(second, -1, 'startEnqueuedWork must exist in service-worker.js');
  // Brace-match the second helper's BODY to its closing brace: skip the
  // destructured parameter list first (its braces must not count).
  const parenOpen = source.indexOf('(', second);
  let pdepth = 0;
  let p = parenOpen;
  for (; p < source.length; p++) {
    if (source[p] === '(') pdepth++;
    else if (source[p] === ')') { pdepth--; if (pdepth === 0) break; }
  }
  let depth = 0;
  let i = source.indexOf('{', p);
  let end = -1;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  assert.notEqual(end, -1, 'startEnqueuedWork body must close');
  const helpers = source.slice(start, end);
  const sandbox = { flowJobQueue: queueStub, console };
  const context = vm.createContext(sandbox);
  vm.runInContext(`${helpers}\nthis.__helpers = { enqueueJobs, startEnqueuedWork };`, context);
  return context.__helpers;
}

function stubQueue({ snapshot, resumeSnapshot } = {}) {
  const calls = { add: [], addBatch: [], snapshot: 0, resume: 0 };
  return {
    calls,
    add: async (job) => { calls.add.push(job); return { ...job, id: job.id || 'q-1' }; },
    addBatch: async (jobs, options) => { calls.addBatch.push({ jobs, options }); return jobs.map((job, index) => ({ ...job, id: job.id || `q-${index + 1}` })); },
    snapshot: async () => { calls.snapshot++; return snapshot || { isPaused: false, waitingForUser: 0 }; },
    resume: async () => { calls.resume++; return resumeSnapshot || { resumed: true }; },
  };
}

test('enqueueJobs: empty input touches neither add nor addBatch', async () => {
  const queue = stubQueue();
  const { enqueueJobs } = helpersHarness(queue);
  // Cross-realm arrays fail deepStrictEqual; assert shape instead.
  const empty1 = await enqueueJobs([]);
  const empty2 = await enqueueJobs(null);
  assert.ok(Array.isArray(empty1) && empty1.length === 0);
  assert.ok(Array.isArray(empty2) && empty2.length === 0);
  assert.equal(queue.calls.add.length, 0);
  assert.equal(queue.calls.addBatch.length, 0);
});

test('enqueueJobs: one job via add, batch via addBatch with options', async () => {
  const queue = stubQueue();
  const { enqueueJobs } = helpersHarness(queue);
  const single = await enqueueJobs([{ operation: 'x' }]);
  assert.equal(single.length, 1);
  assert.equal(queue.calls.add.length, 1);
  assert.equal(queue.calls.addBatch.length, 0);
  const batch = await enqueueJobs([{ operation: 'a' }, { operation: 'b' }], { batchId: 'b-1', batchLabel: 'L' });
  assert.equal(batch.length, 2);
  assert.equal(queue.calls.addBatch.length, 1);
  assert.deepEqual(queue.calls.addBatch[0].options, { batchId: 'b-1', batchLabel: 'L' });
});

test('startEnqueuedWork: autoStart false, paused, or blocked all stay put', async () => {
  const queue = stubQueue();
  const { startEnqueuedWork } = helpersHarness(queue);
  const snap = { isPaused: false, waitingForUser: 0 };
  assert.equal(await startEnqueuedWork({ autoStart: false, snapshot: snap }), snap);
  assert.equal((await startEnqueuedWork({ snapshot: { isPaused: true, waitingForUser: 0 } })).isPaused, true);
  assert.equal((await startEnqueuedWork({ snapshot: { isPaused: false, waitingForUser: 2 } })).waitingForUser, 2);
  assert.equal(queue.calls.resume, 0);
});

test('startEnqueuedWork: runnable queue resumes; stale snapshot is honored', async () => {
  const queue = stubQueue();
  const { startEnqueuedWork } = helpersHarness(queue);
  const resumed = await startEnqueuedWork({});
  assert.equal(resumed.resumed, true);
  assert.equal(queue.calls.resume, 1);
  // Draft runs snapshot BEFORE bookkeeping, then apply the rule to that
  // snapshot: a stale paused snapshot must not be overridden by a fresh
  // runnable snapshot.
  const stale = { isPaused: true, waitingForUser: 0 };
  const kept = await startEnqueuedWork({ snapshot: stale });
  assert.equal(kept, stale);
  assert.equal(queue.calls.resume, 1, 'no second resume for the stale paused snapshot');
  // Retry-batch with nothing retried never starts.
  const skipped = await startEnqueuedWork({ started: false });
  assert.equal(skipped.waitingForUser, 0);
  assert.equal(queue.calls.resume, 1);
});
