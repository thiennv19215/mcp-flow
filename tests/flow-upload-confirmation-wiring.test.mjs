import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { File as NodeFile } from 'node:buffer';
import { TextEncoder as NodeTextEncoder } from 'node:util';

import { flowComponentsSource } from './helpers/flow-components-source.mjs';

// IMG-05b — production wiring for the IMG-05 confirmation extension.
// IMG-05 armed the extension only when no explicit deadline was in force,
// but the production flow.media.upload operation ALWAYS passes one
// (makeDeadline(command, 75 s, 15 s)), so the extension never armed in
// production: a slow-but-live upload still died at the op budget.
// The op now marks its budget extendable for the confirmation phase: the
// uploader derives the external hard bound from the command's own timeout
// and hands the post-dispatch confirmation an `extendableTo` ceiling =
// min(confirmation start + hard cap, external bound). Every other phase
// and every other caller keeps the old absolute-deadline behavior.
//
// The harness drives the REAL flow.media.upload operation
// (upload-operations.js) end to end with a fake clock: Date.now() reads
// the fake time and every wait advances it, so multi-minute budgets run
// deterministically in milliseconds of real time.

const uploadOperationsSource = readFileSync(
  new URL('../extension/src/content/providers/flow/media/upload-operations.js', import.meta.url),
  'utf8',
);

const flowError = (code, message, retryable, outcome_unknown) =>
  Object.assign(new Error(message), { code, retryable, outcome_unknown });

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

function productionHarness({ readyAt = Infinity, landTile = true, name = 'IMG_1234.png' } = {}) {
  let now = 1_000_000;
  const startedAt = now;
  class FakeDate extends Date {
    static now() { return now; }
  }
  const mountedTiles = [];
  const libraryTiles = [];
  const dispatched = [];
  let mediaCounter = 0;

  const makeTile = tileName => {
    const image = { getAttribute: attribute => (attribute === 'alt' ? tileName : null) };
    const tile = {
      id: `media-${++mediaCounter}`,
      name: tileName,
      get ready() { return now >= readyAt; },
      getAttribute: attribute => (attribute === 'aria-label' ? tileName : null),
      get innerText() { return tileName; },
      get textContent() { return tileName; },
      querySelector(selector) {
        if (selector === 'flow-error-tile') return null;
        if (selector === 'flow-scene-tile') return null;
        if (selector === 'flow-video-tile,video') return null;
        if (selector.includes('img')) return image;
        return null;
      },
    };
    return tile;
  };

  const uploadItem = {
    isConnected: true,
    disabled: false,
    tagName: 'BUTTON',
    getAttribute: attribute => (attribute === 'aria-label' ? 'Upload media' : null),
    innerText: 'Upload media',
    textContent: 'Upload media',
    querySelector: () => null,
    cloneNode: () => ({ querySelectorAll: () => [], innerText: 'Upload media', textContent: 'Upload media' }),
    getBoundingClientRect: () => ({ width: 8, height: 8, left: 0, top: 0 }),
    dispatchEvent: () => true,
    matches: () => false,
  };
  const menuRoot = { querySelectorAll: () => [uploadItem], matches: () => false };
  uploadItem.parentElement = menuRoot;

  const addButton = {
    isConnected: true,
    disabled: false,
    getAttribute: () => null,
    innerText: '',
    textContent: '',
    querySelector: () => null,
    getBoundingClientRect: () => ({ width: 8, height: 8, left: 0, top: 0 }),
    dispatchEvent: () => true,
  };
  const submit = {};
  const composer = {
    tagName: 'DIV',
    className: 'composer-box',
    contains: element => [submit, addButton].includes(element) || element === editor,
    querySelectorAll: () => [addButton],
  };
  const editor = { parentElement: composer };

  const stagedNativeFiles = new Map();
  const context = vm.createContext({
    Date: FakeDate,
    document: {
      visibilityState: 'visible',
      querySelector: () => null,
      querySelectorAll: selector => {
        if (selector === 'flow-grid-tile-container') return [...mountedTiles];
        if (selector.includes('component-picker')) return [menuRoot];
        return [];
      },
    },
    crypto: webcrypto,
    File: NodeFile,
    TextEncoder: NodeTextEncoder,
    PointerEvent: class {},
    MouseEvent: class {},
    stagedNativeFiles,
    nativeUploadAssemblers: new Map(),
    FlowNavigation: { prepareFlowOperation: async () => ({ ready: true, popupDismissed: false }) },
    FlowTiles: { isTileMediaReady: tile => tile.ready !== false },
    FlowEditor: { getFlowSubmitButton: () => submit },
    flowQuery: key => (key === 'editor' ? editor : key === 'composerRoot' ? composer : null),
    flowButton: () => addButton,
    accessibleName: element => element.getAttribute?.('aria-label') || '',
    visible: () => true,
    wait: async ms => { now += Number(ms) || 0; },
    mediaId: tile => tile.id,
    emitFlowProgress: () => {},
    FlowMediaMenu: {
      scanNativeAssets: async options => {
        if (options?.requireComplete) return libraryTiles.map(tile => ({ id: tile.id }));
        const baseline = new Set((options?.baselineIds || []).map(String));
        return libraryTiles.map(tile => ({
          id: tile.id,
          name: tile.name,
          kind: 'image',
          ready: tile.ready === true,
          busy: tile.ready !== true,
          error: false,
          newSinceBaseline: !baseline.has(String(tile.id)),
        }));
      },
    },
    FlowNativeFileTransfer: {
      selectFileThroughPicker: async (file, openPicker) => {
        dispatched.push(file);
        await openPicker();
        if (landTile) {
          const tile = makeTile(file.name);
          mountedTiles.push(tile);
          libraryTiles.push(tile);
        }
        return { selected: true, method: 'input.click', type: file.type || 'image/png' };
      },
      dropFileToFlow: async () => ({ dropped: false }),
    },
    flowError,
  });
  vm.runInContext(flowComponentsSource, context);
  vm.runInContext(uploadOperationsSource, context);

  const file = new NodeFile([new Uint8Array(1000).fill(0x41)], name, { type: 'image/png' });
  stagedNativeFiles.set('transfer-1', file);
  const operations = new context.FlowUploadOperations({ error: flowError });
  return {
    startedAt,
    elapsed: () => now - startedAt,
    dispatched,
    libraryTiles,
    upload: (command = {}) =>
      operations.execute('flow.media.upload', { transferId: 'transfer-1', name, kind: 'image' }, command),
  };
}

test('IMG-05b: a production upload whose tile stays busy past the 75 s op budget confirms via extension', async () => {
  // The op budget is 75 s and the IMG-05 image base cap is 90 s; the tile
  // stays busy until 150 s, then becomes ready. Before the wiring this
  // failed FLOW_UPLOAD_TIMEOUT at the op deadline.
  const harness = productionHarness({ readyAt: 1_000_000 + 150_000 });
  const receipt = await harness.upload({});
  assert.equal(receipt.uploaded, true);
  assert.equal(receipt.name, 'IMG_1234.png', 'the receipt keeps the original file name');
  assert.equal(receipt.id, harness.libraryTiles[0].id, 'the receipt is the tile the dispatch created');
  assert.equal(harness.dispatched.length, 1, 'exactly one dispatch');
  assert.ok(harness.elapsed() >= 145_000, `confirmation waited past the 75 s op budget (elapsed ${harness.elapsed()} ms)`);
  assert.ok(harness.elapsed() < 240_000, `confirmation finished before the image hard cap (elapsed ${harness.elapsed()} ms)`);
});

test('IMG-05b: a never-ready production upload fails at the 240 s hard cap with the same diagnostics shape', async () => {
  const harness = productionHarness({ readyAt: Infinity });
  let caught;
  try { await harness.upload({}); } catch (error) { caught = error; }
  assert.ok(caught, 'the upload must fail when the tile never becomes ready');
  assert.equal(caught.code, 'FLOW_UPLOAD_TIMEOUT', String(caught?.stack || caught));
  assert.equal(caught.outcome_unknown, true);
  assert.ok(harness.elapsed() >= 240_000, `failure happened at the extended hard cap, not the 75 s op budget (elapsed ${harness.elapsed()} ms)`);
  assert.ok(harness.elapsed() <= 255_000, `failure did not run past the hard cap (elapsed ${harness.elapsed()} ms)`);
  assert.deepEqual(Object.keys(caught.diagnostics).sort(), DIAGNOSTICS_KEYS,
    'the timeout diagnostics keep exactly the pre-IMG-05 shape');
  assert.equal(caught.diagnostics.newOwnerIdLatched, true);
  assert.equal(caught.diagnostics.exactTileObserved, true);
});

test('IMG-05b: the command timeout is an external hard bound the extension never crosses', async () => {
  // Command timeout 120 s: the op budget is min(75 s, 120 s - 15 s) = 75 s,
  // and the extension ceiling must stop at the command's own 120 s bound
  // even though the image hard cap would allow 240 s. The tile would only
  // become ready at 150 s, so the upload must fail at ~120 s.
  const harness = productionHarness({ readyAt: 1_000_000 + 150_000 });
  let caught;
  try { await harness.upload({ timeoutMs: 120_000 }); } catch (error) { caught = error; }
  assert.ok(caught, 'the upload must fail when the tile is not ready before the command deadline');
  assert.equal(caught.code, 'FLOW_UPLOAD_TIMEOUT', String(caught?.stack || caught));
  assert.ok(harness.elapsed() >= 115_000, `the extension ran past the 75 s op budget up to the external bound (elapsed ${harness.elapsed()} ms)`);
  assert.ok(harness.elapsed() <= 135_000, `the wait stopped at the command's 120 s bound, not the 240 s hard cap (elapsed ${harness.elapsed()} ms)`);
});

test('IMG-05b control: a production upload whose tile never lands gets no extension and fails at the op budget', async () => {
  const harness = productionHarness({ landTile: false });
  let caught;
  try { await harness.upload({}); } catch (error) { caught = error; }
  assert.ok(caught, 'the upload must fail when no tile ever lands');
  assert.equal(caught.code, 'FLOW_UPLOAD_TIMEOUT', String(caught?.stack || caught));
  assert.ok(harness.elapsed() >= 70_000, `the op budget was fully used (elapsed ${harness.elapsed()} ms)`);
  assert.ok(harness.elapsed() <= 90_000, `no extension without a latched owner (elapsed ${harness.elapsed()} ms)`);
  assert.equal(caught.diagnostics.newOwnerIdLatched, false);
  assert.equal(caught.diagnostics.exactTileObserved, false);
});

test('IMG-05b control: a normal fast production upload is unchanged', async () => {
  const harness = productionHarness({ readyAt: 1_000_000 });
  const receipt = await harness.upload({});
  assert.equal(receipt.uploaded, true);
  assert.equal(receipt.name, 'IMG_1234.png');
  assert.equal(receipt.id, harness.libraryTiles[0].id);
  assert.equal(harness.dispatched.length, 1);
  assert.ok(harness.elapsed() < 10_000, `a ready tile confirms immediately (elapsed ${harness.elapsed()} ms)`);
});

test('IMG-05b: an aborted signal stops the extension instead of extending to the hard cap', async () => {
  // Direct confirmation wait with an extendable budget: base working
  // deadline 30 s, extendableTo at the 240 s hard cap. The caller aborts
  // at 60 s — inside the extension window — and the wait must stop there
  // rather than riding the extension to 240 s.
  let now = 1_000_000;
  const startedAt = now;
  class FakeDate extends Date {
    static now() { return now; }
  }
  const controller = new AbortController();
  const abortAt = startedAt + 60_000;
  const name = 'abort-upload.png';
  const ownerId = 'media-owner-abort';
  const image = { getAttribute: attribute => (attribute === 'alt' ? name : null) };
  const tile = {
    get ready() { return false; },
    getAttribute: attribute => (attribute === 'aria-label' ? name : null),
    get innerText() { return name; },
    get textContent() { return name; },
    querySelector(selector) {
      if (selector === 'flow-error-tile') return null;
      if (selector === 'flow-scene-tile') return null;
      if (selector === 'flow-video-tile,video') return null;
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
    wait: async ms => {
      now += Number(ms) || 0;
      if (now >= abortAt && !controller.signal.aborted) controller.abort();
    },
    emitFlowProgress: () => {},
    flowError,
    FlowMediaMenu: {
      scanNativeAssets: async options => {
        const baseline = new Set((options?.baselineIds || []).map(String));
        return [{
          id: ownerId,
          name,
          kind: 'image',
          ready: false,
          busy: true,
          error: false,
          newSinceBaseline: !baseline.has(ownerId),
        }];
      },
    },
  });
  vm.runInContext(flowComponentsSource, context);
  let caught;
  try {
    await context.FlowUploader.waitForNativeMediaTile(name, {}, 'image', {
      deadline: startedAt + 30_000,
      extendableTo: startedAt + 240_000,
      baselineIds: [],
      requireNewOwner: true,
      selectionDiagnostics: {},
      signal: controller.signal,
    });
  } catch (error) { caught = error; }
  assert.ok(caught, 'confirmation must fail once the caller aborts');
  assert.equal(caught.code, 'FLOW_UPLOAD_TIMEOUT', String(caught?.stack || caught));
  const elapsed = now - startedAt;
  assert.ok(elapsed >= 55_000, `the extension ran past the 30 s working deadline before the abort (elapsed ${elapsed} ms)`);
  assert.ok(elapsed <= 90_000, `the wait stopped at the abort instead of riding the extension to 240 s (elapsed ${elapsed} ms)`);
});
