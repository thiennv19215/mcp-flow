import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ensureCorrelationObserver } from '../extension/background/flow-observer-health.js';

const healthy = (overrides = {}) => ({
  ready: true,
  version: 1,
  observerRevision: 24,
  projectId: '00000000-0000-4000-8000-000000000000',
  activeAttempts: 0,
  xhrHookActive: true,
  fetchHookActive: true,
  ...overrides,
});

function scriptingHarness({ initial, afterRepair = initial } = {}) {
  let repairs = 0;
  const scripting = {
    async executeScript(details) {
      if (details.files?.includes('content/bridge/flow-correlation-observer.js')) {
        repairs++;
        return [];
      }
      return [{ result: repairs ? afterRepair : initial }];
    },
  };
  return { scripting, repairs: () => repairs };
}

test('observer health returns the existing healthy state without reinjecting', async () => {
  const harness = scriptingHarness({ initial: healthy() });
  const result = await ensureCorrelationObserver(17, harness.scripting);
  assert.equal(result.ready, true);
  assert.equal(result.observerRevision, 24);
  assert.equal(harness.repairs(), 0);
});

test('observer health repairs once and returns the verified state', async () => {
  const harness = scriptingHarness({ initial: healthy({ ready: false, xhrHookActive: false, fetchHookActive: false }), afterRepair: healthy() });
  const result = await ensureCorrelationObserver(17, harness.scripting);
  assert.equal(result.ready, true);
  assert.equal(harness.repairs(), 1);
});

test('failed observer repair rejects as a definite pre-send failure', async () => {
  const harness = scriptingHarness({ initial: healthy({ ready: false }), afterRepair: healthy({ ready: false }) });
  await assert.rejects(
    ensureCorrelationObserver(17, harness.scripting),
    error => error.code === 'FLOW_CORRELATION_OBSERVER_NOT_READY' && error.outcome_unknown === false && error.retryable === false,
  );
  assert.equal(harness.repairs(), 1);
});

test('generation dispatch awaits observer repair before sending the content command', () => {
  const source = readFileSync(new URL('../extension/background/service-worker.js', import.meta.url), 'utf8');
  const ensureIndex = source.indexOf('if (correlationRequiredOperations.has(operation)) await ensureCorrelationObserver(tabId);');
  const sendIndex = source.indexOf('response = await sendFlowCommand(tabId, {', ensureIndex);
  assert.ok(ensureIndex >= 0 && sendIndex > ensureIndex, 'observer health must be verified before the content command can submit');
});
