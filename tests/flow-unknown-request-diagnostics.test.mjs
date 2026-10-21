import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const tilesSource = readFileSync(new URL('../extension/src/content/providers/flow/generation/tiles.js', import.meta.url), 'utf8');

test('unknown-submit observer diagnostics serialize with event evidence and omit IDs, prompt, and URL tokens', async () => {
  const listeners = new Map();
  const detail = {
    ready: true, xhrHookActive: true, fetchHookActive: true,
    requestDiagnostics: { version: 1, count: 1, events: [{
      observedAt: '2026-10-21T00:00:00.000Z', attemptId: 'attempt-secret', rpcId: 'rpc-secret', mediaType: 'image',
      transport: 'fetch', path: '/api/image:submit?token=secret', payloadVersion: 2, payloadShape: 'image_request',
      pathRecognized: true, payloadMatched: false, fields: { promptPresent: true, mediaIdPresent: true }, reasons: ['reference_mismatch'],
    }] },
  };
  const window = {
    addEventListener(type, fn) { const list = listeners.get(type) || []; list.push(fn); listeners.set(type, list); },
    removeEventListener(type, fn) { listeners.set(type, (listeners.get(type) || []).filter(item => item !== fn)); },
    dispatchEvent(event) {
      if (event.type === 'TOBY_FLOW_CORRELATION_HEALTH_READ') {
        for (const fn of listeners.get('TOBY_FLOW_CORRELATION_HEALTH_RESPONSE') || []) fn({ detail: { nonce: event.detail.nonce, ...detail } });
      }
      for (const fn of listeners.get(event.type) || []) fn(event);
      return true;
    },
  };
  class CustomEvent { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } }
  const context = vm.createContext({ window, CustomEvent, crypto: { randomUUID: () => 'nonce-12345678' }, setTimeout, clearTimeout, Date, Map });
  vm.runInContext(tilesSource, context);
  const snapshot = await context.FlowTiles.readNativeFlowCorrelationHealth();
  const serialized = JSON.stringify({ diagnostics: { clickDelivered: true, requestDiagnostics: snapshot.requestDiagnostics } });
  const parsed = JSON.parse(serialized);
  assert.equal(parsed.diagnostics.requestDiagnostics.count, 1);
  assert.equal(parsed.diagnostics.requestDiagnostics.events[0].payloadMatched, false);
  assert.equal(parsed.diagnostics.requestDiagnostics.events[0].pathClass, 'image');
  assert.doesNotMatch(serialized, /attempt-secret|rpc-secret|token=secret|prompt text/);
  assert.equal(parsed.diagnostics.requestDiagnostics.events[0].fields.promptPresent, true);
  assert.equal(parsed.diagnostics.requestDiagnostics.events[0].fields.mediaIdPresent, true);
});

test('the background command result preserves page-side diagnostics for server-side allowlisting', () => {
  const source = readFileSync(new URL('../extension/src/background/service-worker.js', import.meta.url), 'utf8');
  assert.match(source, /error\?\.diagnostics \? \{ diagnostics: error\.diagnostics \} : \{\}/);
  assert.match(source, /if \(response\?\.error\?\.diagnostics && typeof response\.error\.diagnostics === "object"\)\s*\{\s*error\.diagnostics = response\.error\.diagnostics;\s*\}/);
});
