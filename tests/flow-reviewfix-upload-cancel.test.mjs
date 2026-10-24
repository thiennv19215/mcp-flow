import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { flowComponentsSource } from './helpers/flow-components-source.mjs';

// ---------------------------------------------------------------------------
// Review round 1, item S6 — cancelling during upload confirmation was
// reported as a timeout. The wait loop broke on an aborted signal and
// then fell through to the FLOW_UPLOAD_TIMEOUT throw, so the panel (and
// the queue's retry logic) treated a user cancellation as a transient
// Flow delay.
//
// The fix checks the signal right before constructing the timeout error:
// an aborted wait throws FLOW_UPLOAD_CANCELLED (not retryable —
// re-running the same confirmation cannot help — outcome unknown, since
// the tile may still land in the library). The client already handles
// FLOW_UPLOAD_CANCELLED; the orphan tile is harmless library content.
// ---------------------------------------------------------------------------

function cancelHarness({ abortAtMs = 5_000 } = {}) {
  let now = 1_000_000;
  const startedAt = now;
  class FakeDate extends Date {
    static now() { return now; }
  }
  const controller = new AbortController();
  const ownerId = 'media-owner-1';
  const name = 'cancelled-upload.png';
  const image = { getAttribute: attribute => (attribute === 'alt' ? name : null) };
  const tile = {
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
    FlowTiles: { isTileMediaReady: () => false },
    mediaId: () => ownerId,
    visible: () => true,
    wait: async ms => {
      now += Number(ms) || 0;
      if (now - startedAt >= abortAtMs) controller.abort();
    },
    emitFlowProgress: () => {},
    flowError: (code, message, retryable, outcome_unknown) => Object.assign(new Error(message), { code, retryable, outcome_unknown }),
    FlowMediaMenu: {
      scanNativeAssets: async options => {
        const baseline = new Set((options?.baselineIds || []).map(String));
        return [{ id: ownerId, name, kind: 'image', ready: false, busy: true, error: false, newSinceBaseline: !baseline.has(ownerId) }];
      },
    },
  });
  vm.runInContext(flowComponentsSource, context);
  return {
    waitForTile: context.FlowUploader.waitForNativeMediaTile,
    signal: controller.signal,
    elapsed: () => now - startedAt,
  };
}

test('S6: aborting during upload confirmation reports FLOW_UPLOAD_CANCELLED, not a timeout', async () => {
  const harness = cancelHarness({ abortAtMs: 5_000 });
  let caught;
  try {
    await harness.waitForTile('cancelled-upload.png', {}, 'image', {
      baselineIds: [],
      requireNewOwner: true,
      selectionDiagnostics: {},
      signal: harness.signal,
    });
  } catch (error) { caught = error; }
  assert.ok(caught, 'the aborted confirmation must throw');
  assert.equal(caught.code, 'FLOW_UPLOAD_CANCELLED', String(caught?.stack || caught));
  assert.equal(caught.retryable, false, 'a cancelled confirmation is not retryable');
  assert.equal(caught.outcome_unknown, true, 'the tile may still land after cancellation');
  assert.ok(caught.diagnostics && typeof caught.diagnostics === 'object', 'the cancellation keeps the confirmation diagnostics');
  assert.ok(harness.elapsed() < 90_000, `cancellation must exit promptly, not at the deadline (elapsed ${harness.elapsed()} ms)`);
});
