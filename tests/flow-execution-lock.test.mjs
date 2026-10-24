import test from 'node:test';
import assert from 'node:assert/strict';

// FEAT-11 — Cross-engine execution lock (study B6, feature #17 lock half;
// the server quota/gate half stays blocked). Transform engines (Angles,
// Effects, and later single-image engines) share ONE lock: a single owner
// runs at a time, the same owner may re-acquire, and an engine blocked by
// another owner is offered "stop current" — it can request a stop, which
// the running owner observes and honors by releasing.

import { FlowExecutionLock } from '../extension/src/background/flow-execution-lock.js';

test('acquire: a free lock is granted to the first engine', () => {
  const lock = new FlowExecutionLock({ now: () => 1_000 });
  const grant = lock.acquire('angles');
  assert.equal(grant.ok, true);
  assert.equal(grant.owner, 'angles');
  assert.equal(grant.reentrant, false);
  assert.equal(grant.acquiredAt, 1_000);
  assert.deepEqual(lock.current(), { owner: 'angles', since: 1_000 });
});

test('acquire: a second engine is blocked while one runs, and is offered stop-current', () => {
  const lock = new FlowExecutionLock({ now: () => 2_000 });
  lock.acquire('angles');
  const blocked = lock.acquire('effects');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.owner, 'angles');
  assert.equal(blocked.since, 2_000);
  assert.equal(blocked.canStopCurrent, true);
  // The lock still belongs to the first engine.
  assert.equal(lock.current().owner, 'angles');
});

test('acquire: the same owner re-acquiring succeeds without disturbing the hold', () => {
  let now = 3_000;
  const lock = new FlowExecutionLock({ now: () => now });
  lock.acquire('angles');
  now = 9_500;
  const again = lock.acquire('angles');
  assert.equal(again.ok, true);
  assert.equal(again.reentrant, true);
  assert.equal(again.acquiredAt, 3_000);
  assert.deepEqual(lock.current(), { owner: 'angles', since: 3_000 });
});

test('release: only the owner can release, and release frees the lock', () => {
  const lock = new FlowExecutionLock({ now: () => 4_000 });
  lock.acquire('angles');
  assert.equal(lock.release('effects'), false);
  assert.equal(lock.current().owner, 'angles');
  assert.equal(lock.release('angles'), true);
  assert.equal(lock.current(), null);
  const grant = lock.acquire('effects');
  assert.equal(grant.ok, true);
  assert.equal(grant.owner, 'effects');
});

test('stop request: a blocked engine can request stop; the owner observes it; a fresh acquire clears it', () => {
  const lock = new FlowExecutionLock({ now: () => 5_000 });
  lock.acquire('angles');
  assert.equal(lock.stopRequested(), null);
  const request = lock.requestStop('effects');
  assert.equal(request.ok, true);
  assert.equal(request.owner, 'angles');
  assert.deepEqual(lock.stopRequested(), { requestedBy: 'effects', at: 5_000 });
  // The owner itself asking to stop its own run is not a stop request.
  assert.equal(lock.requestStop('angles').ok, false);
  lock.release('angles');
  lock.acquire('effects');
  assert.equal(lock.stopRequested(), null);
});

test('requestStop on a free lock is refused', () => {
  const lock = new FlowExecutionLock({ now: () => 6_000 });
  assert.equal(lock.requestStop('effects').ok, false);
  assert.equal(lock.stopRequested(), null);
});
