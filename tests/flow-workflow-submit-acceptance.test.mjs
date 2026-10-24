import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const workflowSource = readFileSync(new URL('../extension/src/content/providers/flow/workflows/workflow-operations.js', import.meta.url), 'utf8');

// ---------------------------------------------------------------------------
// WF-ACC: the agent-batch submit path reports real server acceptance.
//
// VID-06 made `flow.generation.submit` derive `serverAcceptanceObserved`
// from the attempt's own correlation receipts via the tiles helper
// `nativeFlowCorrelationAcceptanceObserved` (response_seen / result_seen
// count; request_seen alone never does). The workflow path used by
// flow.agent.batch / flow.edit.run / flow.continue.run —
// `submitAndConfirmDispatch` — kept the old unconditional hardcode
// `serverAcceptanceObserved: false`, so batch consumers could not tell
// "request left the browser" from "Flow accepted it" either. The flag now
// comes from the SAME helper with the SAME stage semantics; a missing
// helper or a missing entry keeps the historical false with no new
// failure mode, and the value is read before the finally-block disarm
// deletes the correlation entry.
// ---------------------------------------------------------------------------

// The documented contract of the real tiles helper (VID-06): scan the
// attempt's OWN receipts for an accepted/result stage.
const ACCEPTANCE_STAGES = ['response_seen', 'result_seen'];

function workflowAcceptanceHarness({
  receipts = [{ stage: 'request_seen' }],
  withAcceptanceHelper = true,
  helperEntryMissing = false,
} = {}) {
  const correlations = new Map();
  let disarmed = false;
  const entry = { requestSeen: true, interfered: false, receipts };
  const tiles = {
    async armNativeFlowCorrelation() {
      correlations.set('attempt-1', entry);
      return 'attempt-1';
    },
    nativeFlowCorrelationMap: () => correlations,
    disarmNativeFlowCorrelation: id => { disarmed = true; correlations.delete(id); },
    emitFlowProgress() {},
  };
  if (withAcceptanceHelper) {
    tiles.nativeFlowCorrelationAcceptanceObserved = attemptId => {
      const found = helperEntryMissing ? undefined : correlations.get(String(attemptId || ''));
      if (!found || !Array.isArray(found.receipts)) return false;
      return found.receipts.some(receipt => ACCEPTANCE_STAGES.includes(receipt?.stage));
    };
  }
  const editor = {
    currentFlowSubmitErrors: () => [],
    waitForGenerationSubmitButton: async () => ({ disabled: false, getAttribute: () => null }),
    activateFlowSubmitButton: async () => ({ clickDelivered: true, strategy: 'test' }),
  };
  const context = vm.createContext({
    Date, Map, Promise, Set, Object, Math, String, Number, Boolean, Array, Error,
    setTimeout, clearTimeout,
    location: { href: 'https://flow.google.com/project/00000000-0000-4000-8000-000000000000' },
    ProviderRegistry: { describeUrl: () => ({ projectId: '00000000-0000-4000-8000-000000000000' }) },
    FlowUiDeadline: {
      makeDeadline: (_command, ms) => Date.now() + ms,
      requireTime: (deadline, operation, outcomeUnknown = false) => {
        if (Date.now() >= deadline) throw Object.assign(new Error(`Timed out ${operation}`), { code: 'FLOW_OPERATION_TIMEOUT', outcome_unknown: outcomeUnknown });
      },
      boundedWait: async () => {},
    },
    wait: async () => {},
  });
  vm.runInContext(workflowSource, context);
  const driver = { error: (code, message, retryable, outcome_unknown) => Object.assign(new Error(message), { code, retryable, outcome_unknown }) };
  return { ops: new context.FlowWorkflowOperations(driver), editor, tiles, wasDisarmed: () => disarmed };
}

async function dispatch(harness) {
  return harness.ops.submitAndConfirmDispatch({
    editor: harness.editor, tiles: harness.tiles, command: {}, prompt: 'one exact test prompt', deadline: Date.now() + 2_000,
  });
}

test('workflow submit: receipts reaching response_seen set serverAcceptanceObserved true', async () => {
  const harness = workflowAcceptanceHarness({ receipts: [{ stage: 'armed' }, { stage: 'request_seen' }, { stage: 'response_seen' }] });
  const result = await dispatch(harness);
  assert.equal(result.requestDispatched, true);
  assert.equal(result.serverAcceptanceObserved, true);
  // The finally-block disarm deleted the entry, so a true flag proves the
  // value was read BEFORE that release — reading it afterwards could only
  // ever produce false.
  assert.equal(harness.wasDisarmed(), true);
});

test('workflow submit: receipts reaching result_seen set serverAcceptanceObserved true', async () => {
  const harness = workflowAcceptanceHarness({ receipts: [{ stage: 'armed' }, { stage: 'request_seen' }, { stage: 'result_seen' }] });
  const result = await dispatch(harness);
  assert.equal(result.requestDispatched, true);
  assert.equal(result.serverAcceptanceObserved, true);
});

test('workflow submit: request-seen-only receipts keep serverAcceptanceObserved false', async () => {
  const harness = workflowAcceptanceHarness({ receipts: [{ stage: 'armed' }, { stage: 'input_seen' }, { stage: 'request_seen' }] });
  const result = await dispatch(harness);
  assert.equal(result.requestDispatched, true);
  assert.equal(result.serverAcceptanceObserved, false);
});

test('workflow submit: acceptance_unknown and poll receipts never count as acceptance', async () => {
  const harness = workflowAcceptanceHarness({ receipts: [{ stage: 'armed' }, { stage: 'request_seen' }, { stage: 'acceptance_unknown' }, { stage: 'poll_seen' }] });
  const result = await dispatch(harness);
  assert.equal(result.requestDispatched, true);
  assert.equal(result.serverAcceptanceObserved, false);
});

test('workflow submit: a missing correlation entry keeps the flag false and dispatch still succeeds', async () => {
  const harness = workflowAcceptanceHarness({
    receipts: [{ stage: 'armed' }, { stage: 'request_seen' }, { stage: 'response_seen' }],
    helperEntryMissing: true,
  });
  const result = await dispatch(harness);
  assert.equal(result.requestDispatched, true);
  assert.equal(result.serverAcceptanceObserved, false);
});

test('workflow submit: an unavailable acceptance helper keeps the flag false with no new failure mode', async () => {
  const harness = workflowAcceptanceHarness({
    receipts: [{ stage: 'armed' }, { stage: 'request_seen' }, { stage: 'response_seen' }],
    withAcceptanceHelper: false,
  });
  const result = await dispatch(harness);
  assert.equal(result.requestDispatched, true);
  assert.equal(result.serverAcceptanceObserved, false);
});

test('workflow submit: the dispatch return derives the flag from the tiles helper, not a hardcode', () => {
  const returnBranch = workflowSource.slice(workflowSource.indexOf('return { requestDispatched: true'));
  assert.match(returnBranch, /serverAcceptanceObserved,/);
  assert.doesNotMatch(returnBranch, /serverAcceptanceObserved: false/);
  assert.match(workflowSource, /nativeFlowCorrelationAcceptanceObserved\?\.\(attemptId\) === true/);
});
