import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { flowComponentsSource } from './helpers/flow-components-source.mjs';

// IMG-05 — upload confirmation deadline extension while the owner tile
// processes. waitForNativeMediaTile used to fail FLOW_UPLOAD_TIMEOUT at a
// fixed cap (image 90 s, video 60 s) even when the new-owner tile had
// latched and was visibly still processing. The confirmation deadline now
// extends in steps while the latched owner is busy, up to a hard cap
// (image 240 s; video 480 s = 8x base). A caller-provided deadline remains
// an absolute cap: extension is armed only when no explicit deadline is in
// force, so budgeted callers (IMG-02 reconciliation's bounded share, the
// op-deadline upload paths) keep exactly their old behavior.
//
// The harness drives the wait with a fake clock: Date.now() reads the fake
// time and the poll wait advances it 250 ms per iteration, so multi-minute
// budgets run deterministically in milliseconds of real time.

function extensionHarness({ kind = 'image', name = 'large-upload.png', readyAt = Infinity, errorAt = Infinity, mountTile = true } = {}) {
  let now = 1_000_000;
  const startedAt = now;
  class FakeDate extends Date {
    static now() { return now; }
  }
  const ownerId = 'media-owner-1';
  const image = { getAttribute: attribute => (attribute === 'alt' ? name : null) };
  const tile = {
    get ready() { return now >= readyAt; },
    getAttribute: attribute => (attribute === 'aria-label' ? name : null),
    get innerText() { return name; },
    get textContent() { return name; },
    querySelector(selector) {
      if (selector === 'flow-error-tile') return now >= errorAt ? {} : null;
      if (selector === 'flow-scene-tile') return null;
      if (selector === 'flow-video-tile,video') return kind === 'video' ? {} : null;
      if (selector === 'flow-image-tile,img') return kind === 'image' ? image : null;
      if (selector.includes('img')) return image;
      return null;
    },
  };
  const mountedTiles = mountTile ? [tile] : [];
  const context = vm.createContext({
    Date: FakeDate,
    document: {
      visibilityState: 'visible',
      querySelector: () => null,
      querySelectorAll: selector => (selector === 'flow-grid-tile-container' ? [...mountedTiles] : []),
    },
    FlowTiles: { isTileMediaReady: candidate => candidate.ready === true },
    mediaId: () => ownerId,
    visible: () => true,
    wait: async ms => { now += Number(ms) || 0; },
    emitFlowProgress: () => {},
    flowError: (code, message, retryable, outcome_unknown) => Object.assign(new Error(message), { code, retryable, outcome_unknown }),
    FlowMediaMenu: {
      // Mirror the mounted tiles in library-scan shape, like the IMG-02
      // harness: the single asset is new since any baseline that lacks it.
      scanNativeAssets: async options => {
        const baseline = new Set((options?.baselineIds || []).map(String));
        return mountedTiles.map(candidate => ({
          id: ownerId,
          name,
          kind,
          ready: candidate.ready === true,
          busy: candidate.ready !== true,
          error: false,
          newSinceBaseline: !baseline.has(ownerId),
        }));
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

const DIAGNOSTICS_KEYS = [
  'baselineIdCount',
  'confirmationButtonClicked',
  'confirmationDialogSeen',
  'confirmationDialogUnrecognized',
  'dropAttempted',
  'dropReceiptConfirmed',
  'exactTileObserved',
  'filePickerSelectionConfirmed',
  'lastScan',
  'lastScanErrorCode',
  'newOwnerIdLatched',
  'pickerMethod',
  'pickerType',
  'scansAttempted',
  'uploadUi',
];

test('IMG-05: a latched owner tile still processing past the base cap confirms via deadline extension', async () => {
  // Image base cap is 90 s; the tile stays busy until 120 s, then is ready.
  const harness = extensionHarness({ readyAt: 1_000_000 + 120_000 });
  const result = await harness.waitForTile('large-upload.png', {}, 'image', {
    baselineIds: [],
    requireNewOwner: true,
    selectionDiagnostics: {},
  });
  assert.equal(result.id, 'media-owner-1');
  assert.equal(result.kind, 'image');
  assert.ok(harness.elapsed() >= 120_000, `confirmation waited past the 90 s base cap (elapsed ${harness.elapsed()} ms)`);
  assert.ok(harness.elapsed() < 240_000, `confirmation finished before the image hard cap (elapsed ${harness.elapsed()} ms)`);
});

test('IMG-05: a never-ready owner tile still fails at the extended hard deadline with the same diagnostics shape', async () => {
  const harness = extensionHarness({ readyAt: Infinity });
  let caught;
  try {
    await harness.waitForTile('large-upload.png', {}, 'image', {
      baselineIds: [],
      requireNewOwner: true,
      selectionDiagnostics: {},
    });
  } catch (error) { caught = error; }
  assert.ok(caught, 'confirmation must fail when the tile never becomes ready');
  assert.equal(caught.code, 'FLOW_UPLOAD_TIMEOUT', String(caught?.stack || caught));
  assert.equal(caught.outcome_unknown, true);
  assert.ok(harness.elapsed() >= 240_000, `failure happened at the extended hard deadline, not the 90 s base cap (elapsed ${harness.elapsed()} ms)`);
  assert.ok(harness.elapsed() <= 245_000, `failure did not run past the hard deadline (elapsed ${harness.elapsed()} ms)`);
  assert.deepEqual(Object.keys(caught.diagnostics).sort(), DIAGNOSTICS_KEYS,
    'the timeout diagnostics keep exactly the pre-IMG-05 shape');
  assert.equal(caught.diagnostics.newOwnerIdLatched, true);
  assert.equal(caught.diagnostics.exactTileObserved, true);
});

test('IMG-05 control: a tile that never latches gets no extension and fails at the original deadline', async () => {
  const harness = extensionHarness({ mountTile: false });
  let caught;
  try {
    await harness.waitForTile('large-upload.png', {}, 'image', {
      baselineIds: [],
      requireNewOwner: true,
      selectionDiagnostics: {},
    });
  } catch (error) { caught = error; }
  assert.ok(caught, 'confirmation must fail when no tile ever appears');
  assert.equal(caught.code, 'FLOW_UPLOAD_TIMEOUT', String(caught?.stack || caught));
  assert.ok(harness.elapsed() >= 90_000, `the base cap still applies (elapsed ${harness.elapsed()} ms)`);
  assert.ok(harness.elapsed() < 120_000, `no extension was granted without a latched owner (elapsed ${harness.elapsed()} ms)`);
  assert.equal(caught.diagnostics.newOwnerIdLatched, false);
  assert.equal(caught.diagnostics.exactTileObserved, false);
});

test('IMG-05 control: a tile rejected during the extension window surfaces FLOW_UPLOAD_REJECTED, not a timeout', async () => {
  // Busy past the 90 s base cap; at 120 s — inside the extension window —
  // Flow flips the tile to an error tile.
  const harness = extensionHarness({ readyAt: Infinity, errorAt: 1_000_000 + 120_000 });
  let caught;
  try {
    await harness.waitForTile('large-upload.png', {}, 'image', {
      baselineIds: [],
      requireNewOwner: true,
      selectionDiagnostics: {},
    });
  } catch (error) { caught = error; }
  assert.ok(caught, 'confirmation must fail when Flow rejects the tile');
  assert.equal(caught.code, 'FLOW_UPLOAD_REJECTED', String(caught?.stack || caught));
  assert.ok(harness.elapsed() >= 120_000, `the rejection was observed inside the extension window (elapsed ${harness.elapsed()} ms)`);
});

test('IMG-05 control: an explicit caller deadline stays an absolute cap — no extension beyond it', async () => {
  // The IMG-02 reconciliation contract: a caller that passes a bounded
  // budget must never inherit a longer wait, even while the tile is busy.
  const harness = extensionHarness({ readyAt: 1_000_000 + 120_000 });
  let caught;
  try {
    await harness.waitForTile('large-upload.png', {}, 'image', {
      deadline: harness.startedAt + 30_000,
      baselineIds: [],
      requireNewOwner: true,
      selectionDiagnostics: {},
    });
  } catch (error) { caught = error; }
  assert.ok(caught, 'confirmation must fail at the caller deadline');
  assert.equal(caught.code, 'FLOW_UPLOAD_TIMEOUT', String(caught?.stack || caught));
  assert.ok(harness.elapsed() >= 30_000, `the caller budget was fully used (elapsed ${harness.elapsed()} ms)`);
  assert.ok(harness.elapsed() < 60_000, `no extension beyond the caller deadline (elapsed ${harness.elapsed()} ms)`);
});

test('IMG-05: a video owner tile processing past the 60 s base confirms within the 8x hard window', async () => {
  // Video base cap is 60 s; the tile stays busy until 200 s, then is ready.
  const harness = extensionHarness({ kind: 'video', name: 'large-upload.mp4', readyAt: 1_000_000 + 200_000 });
  const result = await harness.waitForTile('large-upload.mp4', {}, 'video', {
    baselineIds: [],
    requireNewOwner: true,
    selectionDiagnostics: {},
  });
  assert.equal(result.id, 'media-owner-1');
  assert.equal(result.kind, 'video');
  assert.ok(harness.elapsed() >= 200_000, `confirmation waited past the 60 s video base cap (elapsed ${harness.elapsed()} ms)`);
  assert.ok(harness.elapsed() < 480_000, `confirmation finished before the video hard cap (elapsed ${harness.elapsed()} ms)`);
});
