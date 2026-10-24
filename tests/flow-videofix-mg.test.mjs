import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

import { FlowJobQueue } from '../extension/src/background/flow-job-queue.js';

const domUtilsSource = readFileSync(new URL('../extension/src/content/shared/dom-utils.js', import.meta.url), 'utf8');
const operationsSource = readFileSync(new URL('../extension/src/content/providers/flow/generation/generation-operations.js', import.meta.url), 'utf8');

// ---------------------------------------------------------------------------
// Video fix M-G — observe must accept a DOM-accepted submit's rendered tile:
//
// Before this fix the service worker never forwarded the DOM-accept flag
// to observe, and observe only ever accepted tiles whose id was in the
// correlated set. A submit Flow itself accepted (button disabled /
// editor cleared / new tile) but the observer never correlated therefore
// waited out the full 600 s video timeout even though its tile had
// rendered — the only path that turns a truly finished video into a
// failed job.
//
// After the fix, when observe carries domAccepted:true and no correlation
// exists at all (empty correlated set, no request ever seen), a new,
// ready, kind-matched tile set whose count is EXACTLY the expected count
// is accepted as this job's media. More ready new tiles than expected is
// ambiguous and must NOT be accepted (safe direction: keep waiting).
// A settled-but-failed new set of exactly the expected count fails fast
// with a diagnosis instead of waiting out the deadline.
// ---------------------------------------------------------------------------

const plain = (value) => JSON.parse(JSON.stringify(value));

const READY_VIDEO = { id: 'media-new-1', title: 'new scene', kind: 'video', mediaReady: true, busy: false, failed: false };
const READY_VIDEO_2 = { id: 'media-new-2', title: 'new scene 2', kind: 'video', mediaReady: true, busy: false, failed: false };
const FAILED_VIDEO = { id: 'media-new-1', title: 'new scene', kind: 'video', mediaReady: false, busy: false, failed: true, failureReason: 'Generation failed' };

function observeHarness({ mediaScript, receipt = null, requestSeen = false }) {
  const attemptId = 'attempt-1';
  const correlation = new Map([[attemptId, {
    attemptId, receipts: [], requestSeen, interfered: false, projectId: 'project-1', mediaType: 'video',
  }]]);
  let now = 1_000_000;
  let scans = 0;
  const progressEvents = [];
  const context = vm.createContext({
    Date: { now: () => now },
    Promise, Map, Set, Object, String, Number, Boolean, Array, Math, RegExp, Error, JSON,
    setTimeout, clearTimeout,
    window: { addEventListener() {}, removeEventListener() {} },
    document: { querySelectorAll: () => [], querySelector: () => null, body: null },
    location: { href: 'https://flow.google.com/u/0/?hl=vi', origin: 'https://flow.google.com' },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    checkFlowCreditLimitAlert: () => null,
    FlowEditor: {
      currentFlowSubmitErrors: () => [],
      getFlowSubmitButton: () => null,
      getEditorUserText: () => '',
    },
    FlowTiles: {
      nativeFlowCorrelationMap: () => correlation,
      nativeFlowCorrelationReceipt: () => receipt,
      collectNativeMedia: () => mediaScript(scans++),
      emitFlowProgress: async (command, message, extra) => { progressEvents.push({ message, extra }); },
      disarmNativeFlowCorrelation: () => {},
      retryIdentity: (item) => item.id,
      retryNativeErrorTile: async () => false,
    },
  });
  vm.runInContext(domUtilsSource, context);
  vm.runInContext(operationsSource, context);
  vm.runInContext('globalThis.wait = ms => { globalThis.__advanceClock(ms); return Promise.resolve(); };', context);
  context.__advanceClock = (ms) => { now += Math.max(0, Number(ms) || 0); };
  const driver = {
    error: (code, message, retryable, outcome_unknown) => Object.assign(new Error(message), { code, retryable, outcome_unknown }),
  };
  const operations = new context.FlowGenerationOperations(driver);
  const observe = (payload = {}) => operations.execute('flow.generation.observe', {
    before: [], kind: 'video', expectedCount: 1, timeoutMs: 30_000, correlationAttemptId: attemptId, ...payload,
  }, {});
  return { observe, progressEvents };
}

test('M-G: DOM-accepted submit with no correlation accepts its rendered new tile', async () => {
  const { observe } = observeHarness({ mediaScript: () => [READY_VIDEO] });
  const result = await observe({ domAccepted: true, retries: 0 });
  assert.deepEqual(plain(result.media), [{ id: 'media-new-1', title: 'new scene', kind: 'video' }]);
});

test('M-G: without domAccepted the same uncorrelated tile is NOT accepted', async () => {
  const { observe } = observeHarness({ mediaScript: () => [READY_VIDEO] });
  await assert.rejects(observe({ retries: 0 }), (error) => {
    assert.equal(error.code, 'FLOW_GENERATION_TIMEOUT');
    return true;
  });
});

test('M-G: DOM-accepted submit whose new tile settled failed fails fast with a diagnosis', async () => {
  const { observe } = observeHarness({ mediaScript: () => [FAILED_VIDEO] });
  await assert.rejects(observe({ domAccepted: true, retries: 0 }), (error) => {
    assert.equal(error.code, 'FLOW_GENERATION_FAILED');
    assert.equal(error.outcome_unknown, false, 'a settled failure is known, not outcome-unknown');
    return true;
  });
});

test('M-G: DOM-accepted submit with MORE ready new tiles than expected does not guess', async () => {
  const { observe } = observeHarness({ mediaScript: () => [READY_VIDEO, READY_VIDEO_2] });
  await assert.rejects(observe({ domAccepted: true, retries: 0 }), (error) => {
    assert.equal(error.code, 'FLOW_GENERATION_TIMEOUT');
    return true;
  });
});

test('M-G: the queue checkpoint preserves the domAccepted flag for SW-restart resume', async () => {
  const queue = new FlowJobQueue(async () => ({}), { storage: { get: async () => null, set: async () => {} } });
  const job = await queue.add({ operation: 'flow.generation.submit', payload: { prompt: 'x' }, label: 'video job' });
  // Checkpoints only apply to a running job (the runner's state); mirror
  // that state directly, as the queue-consistency tests do.
  queue.jobs.find((entry) => entry.id === job.id).status = 'running';
  await queue.checkpointGenerationObservation(job.id, {
    correlationAttemptId: 'attempt-1',
    before: [],
    kind: 'video',
    expectedCount: 1,
    timeoutMs: 600_000,
    domAccepted: true,
  });
  const stored = queue.jobs.find((entry) => entry.id === job.id);
  assert.equal(stored.metadata.generationObservation.domAccepted, true);
  await queue.stop();
});
