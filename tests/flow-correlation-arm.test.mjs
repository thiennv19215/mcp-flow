import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../extension/src/content/providers/flow/generation/tiles.js', import.meta.url), 'utf8');
const projectId = '00000000-0000-4000-8000-000000000000';
const eventsByTiles = new WeakMap();

function harness({ xhrHookActive = true, fetchHookActive = true } = {}) {
  const listeners = new Map();
  const dispatched = [];
  let nextId = 1;
  const window = {
    addEventListener(type, listener) {
      const entries = listeners.get(type) || [];
      entries.push(listener);
      listeners.set(type, entries);
    },
    removeEventListener(type, listener) {
      listeners.set(type, (listeners.get(type) || []).filter(entry => entry !== listener));
    },
    dispatchEvent(event) {
      dispatched.push(event);
      for (const listener of listeners.get(event.type) || []) listener(event);
      if (event.type === 'TOBY_FLOW_CORRELATION_ARM') {
        const detail = event.detail;
        this.dispatchEvent(new CustomEvent('TOBY_FLOW_CORRELATION_RECEIPT', {
          detail: {
            schemaVersion: 1,
            nonce: detail.nonce,
            attemptId: detail.attemptId,
            stage: 'armed',
            projectId: detail.projectId,
            mediaType: detail.mediaType,
            reason: null,
            xhrHookActive,
            fetchHookActive,
          },
        }));
      }
      return true;
    },
  };
  class FakeCustomEvent {
    constructor(type, options = {}) { this.type = type; this.detail = options.detail; }
  }
  const context = vm.createContext({
    window,
    CustomEvent: FakeCustomEvent,
    crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}` },
    document: { querySelectorAll: () => [], querySelector: () => null },
    location: { href: `https://flow.google.com/project/${projectId}` },
    setTimeout,
    clearTimeout,
    Map,
    Set,
    Date,
    Math,
    String,
    Number,
    Array,
    Object,
    Promise,
    JSON,
  });
  vm.runInContext(source, context);
  eventsByTiles.set(context.FlowTiles, dispatched);
  return context.FlowTiles;
}

const arm = tiles => tiles.armNativeFlowCorrelation({
  projectId,
  mediaType: 'image',
  prompt: 'fixture image',
  expectedQuantity: 1,
});

test('FlowTiles refuses to arm if the observer receipt reports an inactive transport hook', async () => {
  for (const hooks of [{ xhrHookActive: false, fetchHookActive: true }, { xhrHookActive: true, fetchHookActive: false }]) {
    const tiles = harness(hooks);
    assert.equal(await arm(tiles), null);
    assert.equal(tiles.nativeFlowCorrelationMap().size, 0);
  }
});

test('FlowTiles accepts an arm receipt only when both request hooks are active', async () => {
  const tiles = harness();
  const attemptId = await arm(tiles);
  assert.match(attemptId, /^[0-9a-f-]{36}$/);
  assert.equal(tiles.nativeFlowCorrelationMap().get(attemptId).armed, true);
});

test('voice correlation records only the expected voice count, never the selected label', async () => {
  const tiles = harness();
  const attemptId = await tiles.armNativeFlowCorrelation({
    projectId,
    mediaType: 'video',
    prompt: 'A video with a selected Flow voice',
    expectedQuantity: 1,
    expectedVoiceCount: 1,
  });
  assert.ok(attemptId);
  const arm = eventsByTiles.get(tiles).find(event => event.type === 'TOBY_FLOW_CORRELATION_ARM');
  assert.equal(arm.detail.expectedVoiceCount, 1);
  assert.equal(Object.hasOwn(arm.detail, 'voice'), false);
  assert.equal(JSON.stringify(arm.detail).includes('selected Flow voice'), false);
});
