import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { FlowJobQueue } from '../extension/src/background/flow-job-queue.js';

function memoryStorage() {
  const data = {};
  return {
    async get(key) { return { [key]: data[key] }; },
    async set(entries) { Object.assign(data, entries); },
    async remove(key) { delete data[key]; },
  };
}

test('a failed job record persists the error diagnostics for status reporting', async () => {
  const diagnostics = {
    requestDiagnostics: { version: 1, count: 1, events: [{ kind: 'request_seen' }] },
    operationDiagnostics: { phase: 'submit' },
  };
  const queue = new FlowJobQueue(async () => {
    throw Object.assign(new Error('Submit could not be confirmed.'), {
      code: 'FLOW_SUBMIT_OUTCOME_UNKNOWN', outcomeUnknown: true, diagnostics,
    });
  }, { storage: memoryStorage(), minDelayMs: 0, maxDelayMs: 0 });
  const added = await queue.add({ operation: 'flow.generation.submit', payload: { prompt: 'scene' }, label: 'scene' });
  await queue.start();
  const { job } = await queue.wait(added.id, 5_000);
  assert.equal(job.status, 'failed');
  assert.deepEqual(job.diagnostics, diagnostics);
});

test('a failed job without diagnostics keeps the field empty, and retry clears stored diagnostics', async () => {
  let calls = 0;
  const queue = new FlowJobQueue(async () => {
    calls++;
    if (calls === 1) {
      throw Object.assign(new Error('Transient picker failure.'), {
        code: 'FLOW_REFERENCE_SCAN_INCOMPLETE', retryable: true,
        diagnostics: { requestDiagnostics: { version: 1, count: 0, events: [] } },
      });
    }
    return { ok: true };
  }, { storage: memoryStorage(), minDelayMs: 0, maxDelayMs: 0 });
  const added = await queue.add({
    operation: 'flow.generation.submit',
    payload: { prompt: 'scene', retries: 0 },
    label: 'scene',
  });
  await queue.start();
  const { job: failed } = await queue.wait(added.id, 5_000);
  assert.equal(failed.status, 'failed');
  assert.ok(failed.diagnostics, 'first failure must persist diagnostics');
  await queue.retry(added.id);
  const snapshot = await queue.snapshot();
  const retried = snapshot.jobs.find(job => job.id === added.id);
  assert.equal(retried.diagnostics, undefined, 'retry must clear the previous failure diagnostics');
});

test('core adapter maps extension job diagnostics instead of hardcoding them away', () => {
  const core = readFileSync(new URL('../src/core.ts', import.meta.url), 'utf8');
  assert.match(core, /requestDiagnostics: job\.diagnostics\?\.requestDiagnostics/);
  assert.match(core, /operationDiagnostics: job\.diagnostics\?\.operationDiagnostics/);
  assert.doesNotMatch(core, /requestDiagnostics: undefined,\s*\n\s*operationDiagnostics: undefined/);
});

test('legacy dom-utils credit quote returns the maximum quote, never the cheapest', () => {
  const domUtils = readFileSync(new URL('../extension/src/content/shared/dom-utils.js', import.meta.url), 'utf8');
  const start = domUtils.indexOf('function readGenerationCreditQuote()');
  assert.ok(start >= 0, 'readGenerationCreditQuote must exist');
  const body = domUtils.slice(start, domUtils.indexOf('\n}', start));
  assert.match(body, /Math\.max\(\.\.\.values\)/);
  assert.doesNotMatch(body, /sort\(\(a, b\) => a\.text\.length - b\.text\.length\)/);
});
