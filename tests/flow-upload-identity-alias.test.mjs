import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

import { flowComponentsSource } from './helpers/flow-components-source.mjs';

// ---------------------------------------------------------------------------
// Audit cluster B — upload confirmation must use the repo's identity
// alias system instead of a raw ===:
//
// waitForNativeMediaTile filtered exact-name tiles with
// String(getMediaId(item)) === expectedId, so an expectedId in a
// different-but-equivalent form (UUID in another case, or an asb: id
// vs its bare form) filtered out the true tile and the confirmation
// timed out. The filter now uses tileIdentityValuesMatch — the same
// matcher the generation side already uses (UUID case-insensitive,
// asb: matching with or without the prefix, otherwise exact).
// ---------------------------------------------------------------------------

function tilesContext() {
  const tilesSource = readFileSync(new URL('../extension/src/content/providers/flow/generation/tiles.js', import.meta.url), 'utf8');
  const sandbox = {
    document: { querySelectorAll: () => [], querySelector: () => null },
    location: { href: 'https://flow.google.com/project/x' },
    console, setTimeout, clearTimeout, Date, Map, Set, WeakMap, Promise,
    Object, Array, Math, String, Number, Boolean, RegExp, JSON, Error,
    MutationObserver: class { observe() {} disconnect() {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.mediaId = (el) => 'title:' + (el.getAttribute?.('aria-label') || '');
  const context = vm.createContext(sandbox);
  vm.runInContext(tilesSource, context);
  return context;
}

test('tileIdentityValuesMatch (real matcher): UUID case, asb: forms, and exact fallback', () => {
  const { FlowTiles } = tilesContext();
  const match = FlowTiles.tileIdentityValuesMatch;
  assert.equal(match('AAAAAAAA-1111-4111-8111-111111111111', 'aaaaaaaa-1111-4111-8111-111111111111'), true);
  assert.equal(match('asb:media-xyz', 'media-xyz'), true);
  assert.equal(match('media-xyz', 'asb:media-xyz'), true);
  assert.equal(match('asb:media-xyz', 'asb:media-xyz'), true);
  assert.equal(match('11111111-2222-4333-8444-555555555555', '22222222-3333-4444-8555-666666666666'), false);
  assert.equal(match('', 'x'), false);
  assert.equal(match('media-1', 'media-2'), false);
});

function uploaderHarness({ tileMediaId, assetName = 'my-ref.png' }) {
  let now = 1_000_000;
  class FakeDate extends Date {
    static now() { return now; }
  }
  const tile = {
    getAttribute: (attribute) => {
      if (attribute === 'aria-label') return assetName;
      if (attribute === 'data-media-id') return tileMediaId;
      return null;
    },
    get innerText() { return assetName; },
    get textContent() { return assetName; },
    querySelector: (selector) => (String(selector).includes('img') ? { getAttribute: () => null } : null),
  };
  const tilesCtx = tilesContext();
  const context = vm.createContext({
    Date: FakeDate,
    document: {
      visibilityState: 'visible',
      querySelector: () => null,
      querySelectorAll: (selector) => (selector === 'flow-grid-tile-container' ? [tile] : []),
    },
    FlowTiles: {
      isTileMediaReady: () => true,
      tileIdentityValuesMatch: tilesCtx.FlowTiles.tileIdentityValuesMatch,
    },
    visible: () => true,
    wait: async (ms) => { now += Number(ms) || 0; },
    emitFlowProgress: () => {},
    flowError: (code, message, retryable, outcome_unknown) =>
      Object.assign(new Error(message), { code, retryable, outcome_unknown }),
    FlowMediaMenu: undefined,
    setTimeout, clearTimeout, Map, Set, WeakMap, Promise,
    Object, Array, Math, String, Number, Boolean, RegExp, JSON, Error, console,
  });
  vm.runInContext(flowComponentsSource, context);
  // The components bundle may install its own global mediaId; the
  // uploader must fall back to the tile's data-media-id for this test,
  // which is exactly the production fallback when no mediaId helper
  // is installed ahead of it.
  try { delete context.mediaId; } catch {}
  const waitForTile = context.FlowUploader.waitForNativeMediaTile;
  return {
    confirm: (expectedId) => waitForTile(assetName, {}, 'image', {
      baselineIds: [],
      requireNewOwner: false,
      expectedId,
      selectionDiagnostics: {},
    }),
  };
}

test('upload confirmation: an expectedId in another UUID case still confirms the tile', async () => {
  const harness = uploaderHarness({ tileMediaId: 'AAAAAAAA-1111-4111-8111-111111111111' });
  const result = await harness.confirm('aaaaaaaa-1111-4111-8111-111111111111');
  assert.equal(result.id, 'AAAAAAAA-1111-4111-8111-111111111111', 'the tile id is returned as the tile carries it');
  assert.equal(result.kind, 'image');
});

test('upload confirmation: a bare expectedId confirms an asb: tile id', async () => {
  const harness = uploaderHarness({ tileMediaId: 'asb:media-xyz' });
  const result = await harness.confirm('media-xyz');
  assert.equal(result.id, 'asb:media-xyz');
});

test('upload confirmation: a genuinely different id still times out (no false positive)', async () => {
  const harness = uploaderHarness({ tileMediaId: 'AAAAAAAA-1111-4111-8111-111111111111' });
  await assert.rejects(harness.confirm('22222222-3333-4444-8555-666666666666'), (error) => {
    assert.equal(error.code, 'FLOW_UPLOAD_TIMEOUT');
    return true;
  });
});
