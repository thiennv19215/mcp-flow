import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { flowComponentsSource } from './helpers/flow-components-source.mjs';

// ---------------------------------------------------------------------------
// Review round 1, item S1 — the in-submit upload path could not extend its
// tile-confirmation deadline the way the sidebar path can. The sidebar
// flow.media.upload call passes confirmExtendable, so a latched owner tile
// still processing may extend confirmation up to the hard cap. The
// in-submit staged upload (generation-operations uploadAndResolve and the
// revalidation restore upload) passed only { deadline: flowDeadline }:
// waitForNativeMediaTile then capped confirmation at
// min(flowDeadline, startedAt + BASE 90 s) with extensionCeiling ==
// deadline, so a tile that finished just past the 90 s base cap — still
// inside the 105 s submit budget — died with FLOW_UPLOAD_TIMEOUT.
//
// Implementation note, discovered while writing this test: the wait layer
// (waitForNativeMediaTile) already honored an explicit extendableTo —
// the missing pieces were uploadStagedMedia never forwarding it and the
// in-submit call sites never passing it. These three tests pin the wait
// layer's semantics (extension only while the latched owner processes,
// 15 s steps, never past the hard cap); the generation-operations wiring
// test in flow-video-diagnostics.test.mjs is the failing-first pin for
// the actual fix (extendableTo === the submit deadline on the upload
// call). Extension still never passes the hard cap or the caller's own
// ceiling.
// ---------------------------------------------------------------------------

function extendHarness({ readyAt }) {
  let now = 1_000_000;
  const startedAt = now;
  class FakeDate extends Date {
    static now() { return now; }
  }
  const ownerId = 'media-owner-1';
  const name = 'in-submit-upload.png';
  const image = { getAttribute: attribute => (attribute === 'alt' ? name : null) };
  const tile = {
    get ready() { return now >= readyAt; },
    getAttribute: attribute => (attribute === 'aria-label' ? name : null),
    get innerText() { return name; },
    get textContent() { return name; },
    querySelector(selector) {
      if (selector === 'flow-error-tile') return null;
      if (selector === 'flow-scene-tile') return null;
      if (selector === 'flow-video-tile,video') return null;
      if (selector === 'flow-image-tile,img') return image;
      if (selector.includes('img')) return image;
      return null;
    },
  };
  const context = vm.createContext({
    Date: FakeDate,
    document: {
      visibilityState: 'visible',
      querySelector: () => null,
      querySelectorAll: selector => (selector === 'flow-grid-tile-container' ? [tile] : []),
    },
    FlowTiles: { isTileMediaReady: candidate => candidate.ready === true },
    mediaId: () => ownerId,
    visible: () => true,
    wait: async ms => { now += Number(ms) || 0; },
    emitFlowProgress: () => {},
    flowError: (code, message, retryable, outcome_unknown) => Object.assign(new Error(message), { code, retryable, outcome_unknown }),
    FlowMediaMenu: {
      scanNativeAssets: async options => {
        const baseline = new Set((options?.baselineIds || []).map(String));
        return [{
          id: ownerId, name, kind: 'image',
          ready: now >= readyAt, busy: now < readyAt, error: false,
          newSinceBaseline: !baseline.has(ownerId),
        }];
      },
    },
  });
  vm.runInContext(flowComponentsSource, context);
  return {
    waitForTile: context.FlowUploader.waitForNativeMediaTile,
    startedAt,
    elapsed: () => now - startedAt,
  };
}

test('S1: an explicit extendableTo lets a processing owner tile confirm past the 90 s base cap within the submit budget', async () => {
  // Tile ready at +100 s: past the 90 s image base cap, inside a 105 s
  // submit budget. Without the fix this times out at 90 s.
  const harness = extendHarness({ readyAt: 1_000_000 + 100_000 });
  const result = await harness.waitForTile('in-submit-upload.png', {}, 'image', {
    baselineIds: [],
    requireNewOwner: true,
    selectionDiagnostics: {},
    deadline: harness.startedAt + 105_000,
    extendableTo: harness.startedAt + 105_000,
  });
  assert.equal(result.id, 'media-owner-1');
  assert.ok(harness.elapsed() >= 100_000, `confirmation waited for the tile (elapsed ${harness.elapsed()} ms)`);
  assert.ok(harness.elapsed() <= 105_000, `confirmation stayed inside the submit budget (elapsed ${harness.elapsed()} ms)`);
});

test('S1 control: without extendableTo the same tile still times out at the base cap', async () => {
  const harness = extendHarness({ readyAt: 1_000_000 + 100_000 });
  let caught;
  try {
    await harness.waitForTile('in-submit-upload.png', {}, 'image', {
      baselineIds: [],
      requireNewOwner: true,
      selectionDiagnostics: {},
      deadline: harness.startedAt + 105_000,
    });
  } catch (error) { caught = error; }
  assert.ok(caught, 'confirmation must fail without an extension ceiling');
  assert.equal(caught.code, 'FLOW_UPLOAD_TIMEOUT', String(caught?.stack || caught));
  assert.ok(harness.elapsed() >= 90_000 && harness.elapsed() <= 91_000,
    `failure happened at the 90 s base cap (elapsed ${harness.elapsed()} ms)`);
});

test('S1 control: extendableTo never passes the hard cap', async () => {
  const harness = extendHarness({ readyAt: Infinity });
  let caught;
  try {
    await harness.waitForTile('in-submit-upload.png', {}, 'image', {
      baselineIds: [],
      requireNewOwner: true,
      selectionDiagnostics: {},
      deadline: harness.startedAt + 105_000,
      extendableTo: harness.startedAt + 999_000,
    });
  } catch (error) { caught = error; }
  assert.ok(caught, 'confirmation must fail when the tile never becomes ready');
  assert.equal(caught.code, 'FLOW_UPLOAD_TIMEOUT', String(caught?.stack || caught));
  assert.ok(harness.elapsed() >= 240_000 && harness.elapsed() <= 245_000,
    `failure happened at the 240 s image hard cap (elapsed ${harness.elapsed()} ms)`);
});
