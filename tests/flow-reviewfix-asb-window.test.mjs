import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Review round 1 S5 / round 2 S3 / round 3 S1 (merged) — the asb: -> UUID
// resolver waited exactly one 500 ms window for the observer's identities
// publish. Identities that hydrated just after that window fell back to
// title-only matching (or fail-closed) even though the UUID arrived a
// moment later.
//
// The fix retries exactly once: a second 500 ms window with fresh
// listeners and a fresh READ dispatch. Ambiguity still settles
// immediately (it can never resolve to one UUID), and two empty windows
// still fail closed — the wait is bounded, never infinite.
// ---------------------------------------------------------------------------

const PROJECT_ID = '11111111-2222-4333-8444-555555555555';
const ASB = 'a'.repeat(32);
const MEDIA_UUID = '22222222-2222-4222-8222-222222222222';

function identitiesHarness() {
  const listeners = new Map();
  let readDispatches = 0;
  const windowStub = {
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener: (type, fn) => { listeners.get(type)?.delete(fn); },
    dispatchEvent: (event) => {
      if (String(event?.type || '').includes('_READ')) readDispatches++;
      for (const fn of [...(listeners.get(event?.type) || [])]) fn(event);
    },
  };
  const source = readFileSync(new URL('../extension/src/content/providers/flow/composer/reference-actions.js', import.meta.url), 'utf8');
  const context = vm.createContext({
    window: windowStub,
    location: { pathname: `/project/${PROJECT_ID}` },
    CustomEvent: class CustomEvent { constructor(type) { this.type = type; } },
    setTimeout, clearTimeout,
  });
  vm.runInContext(source, context);
  return {
    resolve: context.resolveNativeMediaUuid,
    publish: (entries) => windowStub.dispatchEvent({
      type: 'TOBY_FLOW_MEDIA_IDENTITIES',
      detail: { projectId: PROJECT_ID, entries },
    }),
    readDispatches: () => readDispatches,
  };
}

test('asb window: identities arriving after the first 500 ms window still resolve within the retry window', async () => {
  const harness = identitiesHarness();
  const pending = harness.resolve(`asb:${ASB}`, 'image');
  // Publish at 750 ms: past the old single window, inside the retry window.
  setTimeout(() => harness.publish([{ asb: ASB, mediaType: 'image', mediaUuid: MEDIA_UUID }]), 750);
  const resolved = await pending;
  assert.equal(resolved, MEDIA_UUID, 'the retry window must catch late-hydrating identities');
  assert.equal(harness.readDispatches(), 4, 'the retry re-dispatches both READ events (v1 + v2)');
});

test('asb window control: identities that never arrive still fail closed after both windows', async () => {
  const harness = identitiesHarness();
  const resolved = await harness.resolve(`asb:${ASB}`, 'image');
  assert.equal(resolved, undefined, 'two empty windows still fail closed, never hang');
  assert.equal(harness.readDispatches(), 4, 'both windows dispatch their READ events (2 per window: v1 + v2)');
});

test('asb window control: an ambiguous publish settles immediately without a retry window', async () => {
  const harness = identitiesHarness();
  const pending = harness.resolve(`asb:${ASB}`, 'image');
  // Let the resolver finish its (empty) catalog lookup and attach its
  // listeners first — in production the publish only ever follows the
  // READ dispatch, i.e. after the listeners exist.
  await new Promise((resolve) => setTimeout(resolve, 0));
  harness.publish([
    { asb: ASB, mediaType: 'image', mediaUuid: MEDIA_UUID },
    { asb: ASB, mediaType: 'image', mediaUuid: '33333333-3333-4333-8333-333333333333' },
  ]);
  const resolved = await pending;
  assert.equal(resolved, undefined, 'ambiguity can never resolve to one UUID');
  assert.equal(harness.readDispatches(), 2, 'ambiguity must not burn a second window (only the first window\'s 2 READ events)');
});
