import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { shapes } from '../dist/schemas.js';

const source = readFileSync(new URL('../extension/content/providers/flow/FlowGenerationOperations.js', import.meta.url), 'utf8');

function harness(clearResult, { pickerOpen = false, promptBefore = '', promptValues = null, closeError = null, referenceChipCounts = [0, 0] } = {}) {
  const calls = [];
  const closeCalls = [];
  const promptEditor = { id: 'prompt' };
  let promptRead = 0;
  let referenceRead = 0;
  const context = vm.createContext({
    Date, Promise, Set, Object, Math, String, Number, Boolean, Array, Error,
    document: { querySelector: () => promptEditor },
    flowQuery: selector => selector === 'editor' ? promptEditor : null,
    FlowEditor: { getEditorUserText: () => {
      if (!promptValues) return promptBefore;
      const value = promptValues[Math.min(promptRead, promptValues.length - 1)];
      promptRead++;
      return value;
    } },
    FlowUiDeadline: { makeDeadline: (_command, duration, reserve) => Date.now() + duration - reserve },
    clearExistingIngredientChips: async options => { calls.push(options); return clearResult; },
    FlowComponents: {
      clearExistingIngredientChips: async options => { calls.push(options); return clearResult; },
      FlowReferenceActions: {
        closePicker: async () => { closeCalls.push(true); if (closeError) throw Object.assign(new Error(closeError), { code: closeError }); return { wasOpen: pickerOpen, closed: true }; },
        inspectDiagnostics: () => ({ pickerOpen, chipCount: referenceChipCounts[Math.min(referenceRead++, referenceChipCounts.length - 1)] }),
      },
    },
  });
  vm.runInContext(source, context);
  const driver = { error: (code, message, retryable, outcome_unknown) => Object.assign(new Error(message), { code, retryable, outcome_unknown }) };
  return { ops: new context.FlowGenerationOperations(driver), calls, closeCalls };
}

test('clear references exposes an empty API schema', () => {
  assert.deepEqual(z.object(shapes.clear_references).parse({}), {});
});

test('clear references reports success only after the helper confirms no chips remain', async () => {
  const { ops, calls, closeCalls } = harness({ cleared: 2, remaining: 0 });
  const result = await ops.execute('flow.references.clear', {}, {});
  assert.equal(result.confirmed, true);
  assert.equal(result.cleared, 2);
  assert.equal(result.remaining, 0);
  assert.equal(result.picker_closed, true);
  assert.equal(result.prompt_preserved, true);
  assert.equal(result.prompt_text, '');
  assert.equal(calls.length, 1);
  assert.equal(closeCalls.length, 1);
  assert.ok(Number.isFinite(calls[0].deadline));
});

test('clear references stops before chip cleanup if the safe picker close fails', async () => {
  const { ops, calls } = harness({ cleared: 0, remaining: 0 }, { closeError: 'FLOW_ASSET_PICKER_CLOSE_FAILED' });
  const action = ops.execute('flow.references.clear', {}, {});
  await assert.rejects(action, error => error.code === 'FLOW_ASSET_PICKER_CLOSE_FAILED');
  assert.equal(calls.length, 0);
});

test('clear references rejects an incomplete removal result', async () => {
  const { ops } = harness({ cleared: 1, remaining: 1 });
  await assert.rejects(
    ops.execute('flow.references.clear', {}, {}),
    error => error.code === 'FLOW_REFERENCE_CLEAR_UNCONFIRMED' && error.outcome_unknown === false,
  );
});

test('clear references rejects a zero-op result while Flow still reports an Ingredient chip', async () => {
  const { ops, calls } = harness({ cleared: 0, remaining: 0 }, { referenceChipCounts: [1, 1] });
  await assert.rejects(
    ops.execute('flow.references.clear', {}, {}),
    error => error.code === 'FLOW_REFERENCE_CLEAR_UNCONFIRMED' && /still reports 1 attached reference chip/.test(error.message),
  );
  assert.equal(calls.length, 1);
});

test('clear references confirms a zero-op only when the canonical Flow chip count is zero', async () => {
  const { ops } = harness({ cleared: 0, remaining: 0 }, { referenceChipCounts: [0, 0] });
  const result = await ops.execute('flow.references.clear', {}, {});
  assert.equal(result.confirmed, true);
  assert.equal(result.cleared, 0);
  assert.equal(result.remaining, 0);
});

test('clear references reports a prompt mutation after chip cleanup', async () => {
  const { ops, calls } = harness({ cleared: 1, remaining: 0 }, { promptValues: ['keep this prompt', 'changed prompt'] });
  await assert.rejects(
    ops.execute('flow.references.clear', {}, {}),
    error => error.code === 'FLOW_PROMPT_CHANGED_DURING_REFERENCE_CLEAR' && error.outcome_unknown === false,
  );
  assert.equal(calls.length, 1);
});
