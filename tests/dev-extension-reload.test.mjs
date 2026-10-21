import test from 'node:test';
import assert from 'node:assert/strict';
import { decideDevExtensionReload } from '../extension/src/background/dev-extension-reload.js';

const oldRevision = 'a'.repeat(64);
const newRevision = 'b'.repeat(64);
const signalRevision = 'c'.repeat(64);
const triggeredRevision = 'd'.repeat(64);

test('dev reload adopts an initial epoch key and does not reload after runtime reload', () => {
  const initialized = decideDevExtensionReload({ revision: signalRevision, buildRevision: newRevision, reloadKey: signalRevision, reloadEpoch: 2 });
  assert.deepEqual(initialized, { action: 'initialize', reloadKey: signalRevision });
  assert.deepEqual(decideDevExtensionReload({
    revision: signalRevision, buildRevision: newRevision, reloadKey: signalRevision, reloadEpoch: 2, previousRevision: initialized.reloadKey,
  }), { action: 'current', reloadKey: initialized.reloadKey });
});

test('dev reload migrates old file-only baseline and reloads only when idle', () => {
  assert.deepEqual(decideDevExtensionReload({
    revision: signalRevision, buildRevision: newRevision, reloadKey: signalRevision, reloadEpoch: 0, previousRevision: newRevision,
  }), { action: 'migrate', reloadKey: signalRevision });
  assert.deepEqual(decideDevExtensionReload({
    revision: triggeredRevision, buildRevision: newRevision, reloadKey: triggeredRevision, reloadEpoch: 1, previousRevision: signalRevision, activeOperations: 1,
  }), { action: 'wait', reloadKey: triggeredRevision });
  assert.deepEqual(decideDevExtensionReload({
    revision: triggeredRevision, buildRevision: newRevision, reloadKey: triggeredRevision, reloadEpoch: 1, previousRevision: signalRevision, activeOperations: 0,
  }), { action: 'reload', reloadKey: triggeredRevision });
  assert.deepEqual(decideDevExtensionReload({
    revision: triggeredRevision, buildRevision: newRevision, reloadKey: triggeredRevision, reloadEpoch: 1, previousRevision: triggeredRevision, activeOperations: 0,
  }), { action: 'current', reloadKey: triggeredRevision });
});

test('old workers react to the changed revision signal and build diagnostics use the exact fingerprint', () => {
  assert.notEqual(signalRevision, triggeredRevision, 'legacy workers only compare revision');
  assert.equal(decideDevExtensionReload({
    revision: triggeredRevision, buildRevision: newRevision, reloadKey: triggeredRevision, previousRevision: signalRevision,
  }).action, 'reload');
});

test('dev reload ignores invalid revision input', () => {
  assert.deepEqual(decideDevExtensionReload({ revision: 'not-a-revision', previousRevision: oldRevision }), { action: 'invalid' });
});
