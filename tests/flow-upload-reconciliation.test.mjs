import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { File as NodeFile } from 'node:buffer';
import { TextEncoder as NodeTextEncoder } from 'node:util';

import { flowComponentsSource } from './helpers/flow-components-source.mjs';

// IMG-02 — reconciliation of dispatched-but-unconfirmed uploads.
// If an upload was dispatched (Flow accepted the file, the tile exists in
// the library) but confirmation is interrupted, a retry must reconcile
// against the ORIGINAL baseline (the tile set captured before the first
// dispatch) and confirm the already-present tile instead of dispatching a
// duplicate upload.

function stagedFile(fill = 0x41, name = 'IMG_1234.png') {
  return new NodeFile([new Uint8Array(1000).fill(fill)], name, { type: 'image/png' });
}

function reconcileHarness() {
  const mountedTiles = [];
  const libraryTiles = [];
  const dispatched = [];
  let baselineScans = 0;
  let mediaCounter = 0;
  let dispatchBehavior = { landTile: true, tileReady: false, tileError: false };

  const makeTile = (name, id, { size = null, ready = true, error = false } = {}) => {
    const image = {
      getAttribute: attribute => attribute === 'alt' ? name
        : attribute === 'data-file-size' && size != null ? String(size) : null,
    };
    const tile = {
      id,
      name,
      ready,
      getAttribute: attribute => attribute === 'aria-label' ? name : null,
      get innerText() { return name; },
      get textContent() { return name; },
      querySelector(selector) {
        if (selector === 'flow-error-tile') return error ? {} : null;
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
    getAttribute: attribute => attribute === 'aria-label' ? 'Upload media' : null,
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

  const context = vm.createContext({
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
    FlowTiles: { isTileMediaReady: tile => tile.ready !== false },
    FlowEditor: { getFlowSubmitButton: () => submit },
    flowQuery: key => key === 'editor' ? editor : key === 'composerRoot' ? composer : null,
    flowButton: () => addButton,
    accessibleName: element => element.getAttribute?.('aria-label') || '',
    visible: () => true,
    wait: async () => {},
    mediaId: tile => tile.id,
    emitFlowProgress: () => {},
    FlowMediaMenu: {
      // Emulates the library scan: the baseline variant reports every tile
      // in the library; the confirmation variant reports assets in
      // media-menu shape, flagging which are new since the given baseline.
      scanNativeAssets: async options => {
        if (options?.requireComplete) {
          baselineScans++;
          return libraryTiles.map(tile => ({ id: tile.id }));
        }
        const baseline = new Set((options?.baselineIds || []).map(String));
        return libraryTiles.map(tile => ({
          id: tile.id,
          name: tile.name,
          kind: 'image',
          ready: tile.ready !== false,
          busy: tile.ready === false,
          error: false,
          newSinceBaseline: !baseline.has(String(tile.id)),
        }));
      },
    },
    FlowNativeFileTransfer: {
      selectFileThroughPicker: async (file, openPicker) => {
        dispatched.push(file);
        await openPicker();
        if (dispatchBehavior.landTile) {
          const tile = makeTile(file.name, `media-${++mediaCounter}`, {
            size: file.size, ready: dispatchBehavior.tileReady, error: dispatchBehavior.tileError,
          });
          mountedTiles.push(tile);
          libraryTiles.push(tile);
        }
        return { selected: true, method: 'input.click', type: file.type || 'image/png' };
      },
      dropFileToFlow: async () => ({ dropped: false }),
    },
    flowError: (code, message, retryable, outcome_unknown) => Object.assign(new Error(message), { code, retryable, outcome_unknown }),
  });
  vm.runInContext(flowComponentsSource, context);
  return {
    uploader: context.FlowUploader,
    mountedTiles,
    libraryTiles,
    dispatched,
    makeTile,
    get baselineScans() { return baselineScans; },
    setDispatchBehavior(patch) { dispatchBehavior = { ...dispatchBehavior, ...patch }; },
    unmountAll() { mountedTiles.length = 0; },
  };
}

test('IMG-02: an interrupted confirmation reconciles against the original baseline instead of re-dispatching', async () => {
  const harness = reconcileHarness();
  const file = stagedFile();

  // Attempt 1: the picker dispatch lands the tile, but it is still
  // processing, so confirmation times out — the upload is dispatched but
  // unconfirmed.
  await assert.rejects(
    harness.uploader.upload(file, 'image', {}, { callerKey: 'ref-1', deadline: Date.now() + 500 }),
    error => error.code === 'FLOW_UPLOAD_TIMEOUT' && error.outcome_unknown === true,
  );
  assert.equal(harness.dispatched.length, 1, 'the first attempt dispatched exactly once');
  assert.equal(harness.libraryTiles.length, 1, 'Flow accepted the file: its tile is in the library');
  const landedTile = harness.libraryTiles[0];

  // The grid remounts (virtualized list) so the tile is no longer in the
  // mounted DOM, and it finishes processing.
  landedTile.ready = true;
  harness.unmountAll();

  // Attempt 2 (the retry): must confirm the already-present tile against
  // the ORIGINAL baseline — no second picker dispatch, no fresh baseline.
  const receipt = await harness.uploader.upload(file, 'image', {}, { callerKey: 'ref-1', deadline: Date.now() + 9_000 });
  assert.equal(receipt.id, landedTile.id, 'the retry returns the tile the first dispatch created');
  assert.equal(receipt.reconciled, true, 'the receipt marks the confirmation as reconciled');
  assert.equal(receipt.uploadName, harness.dispatched[0].name, 'the receipt carries the content-derived upload name');
  assert.equal(receipt.name, 'IMG_1234.png', 'the receipt keeps the original file name');
  assert.equal(harness.dispatched.length, 1, 'no second picker dispatch on retry');
  assert.equal(harness.baselineScans, 1, 'no fresh baseline was captured on retry: the original baseline was used');
});

test('IMG-02: after a reconciled success the attempt record is cleared and later calls reuse normally', async () => {
  const harness = reconcileHarness();
  const file = stagedFile();

  await assert.rejects(
    harness.uploader.upload(file, 'image', {}, { callerKey: 'ref-1', deadline: Date.now() + 500 }),
    error => error.code === 'FLOW_UPLOAD_TIMEOUT',
  );
  const landedTile = harness.libraryTiles[0];
  landedTile.ready = true;

  const reconciled = await harness.uploader.upload(file, 'image', {}, { callerKey: 'ref-1', deadline: Date.now() + 9_000 });
  assert.equal(reconciled.reconciled, true);
  assert.equal(reconciled.id, landedTile.id);

  const again = await harness.uploader.upload(file, 'image', {}, { callerKey: 'ref-1', deadline: Date.now() + 9_000 });
  assert.equal(again.reused, true, 'a later call takes the ordinary reuse path');
  assert.equal(again.reconciled, undefined, 'the reconciled marker belongs only to the reconciling call');
  assert.equal(again.id, landedTile.id);
  assert.equal(harness.dispatched.length, 1, 'still only one dispatch across all calls');
});

test('IMG-02 negative: when no tile from the earlier dispatch exists, the retry dispatches normally', async () => {
  const harness = reconcileHarness();
  harness.setDispatchBehavior({ landTile: false, tileReady: true });
  const file = stagedFile();

  // Attempt 1: the picker reports selection but no tile ever lands in the
  // library (Flow silently dropped it); confirmation times out with no
  // trace of a tile.
  await assert.rejects(
    harness.uploader.upload(file, 'image', {}, { callerKey: 'ref-1', deadline: Date.now() + 500 }),
    error => error.code === 'FLOW_UPLOAD_TIMEOUT',
  );
  assert.equal(harness.dispatched.length, 1);
  assert.equal(harness.libraryTiles.length, 0);

  // Attempt 2: reconciliation finds no matching tile, so the retry must
  // fall through to a real dispatch rather than blocking on the record.
  harness.setDispatchBehavior({ landTile: true, tileReady: true });
  const receipt = await harness.uploader.upload(file, 'image', {}, { callerKey: 'ref-1', deadline: Date.now() + 9_000 });
  assert.equal(harness.dispatched.length, 2, 'a real second dispatch happens when no tile can be reconciled');
  assert.equal(receipt.reconciled, undefined, 'a fresh dispatch is not marked reconciled');
  assert.equal(receipt.id, harness.libraryTiles[0].id);
});

test('IMG-02 negative: two new tiles matching the upload name fail closed instead of guessing', async () => {
  const harness = reconcileHarness();
  const file = stagedFile();

  await assert.rejects(
    harness.uploader.upload(file, 'image', {}, { callerKey: 'ref-1', deadline: Date.now() + 500 }),
    error => error.code === 'FLOW_UPLOAD_TIMEOUT',
  );
  assert.equal(harness.dispatched.length, 1);
  const uploadName = harness.dispatched[0].name;

  // A second, distinct tile carrying the same upload name appears. Neither
  // was in the original baseline, so reconciliation cannot tell which one
  // the dispatch created.
  const duplicate = harness.makeTile(uploadName, 'media-duplicate', { size: file.size, ready: true });
  harness.mountedTiles.push(duplicate);
  harness.libraryTiles.push(duplicate);
  harness.libraryTiles[0].ready = true;

  await assert.rejects(
    harness.uploader.upload(file, 'image', {}, { callerKey: 'ref-1', deadline: Date.now() + 9_000 }),
    error => error.code === 'FLOW_UPLOAD_TILE_AMBIGUOUS' && error.outcome_unknown === true,
  );
  assert.equal(harness.dispatched.length, 1, 'ambiguity must not trigger another dispatch');
});

test('IMG-02: a tile Flow rejected clears the attempt, so a retry surfaces the rejection instead of reconciling forever', async () => {
  const harness = reconcileHarness();
  harness.setDispatchBehavior({ landTile: true, tileReady: true, tileError: true });
  const file = stagedFile();

  await assert.rejects(
    harness.uploader.upload(file, 'image', {}, { callerKey: 'ref-1', deadline: Date.now() + 5_000 }),
    error => error.code === 'FLOW_UPLOAD_REJECTED',
  );
  assert.equal(harness.dispatched.length, 1);

  await assert.rejects(
    harness.uploader.upload(file, 'image', {}, { callerKey: 'ref-1', deadline: Date.now() + 5_000 }),
    error => error.code === 'FLOW_UPLOAD_REJECTED',
  );
  assert.equal(harness.dispatched.length, 1, 'the rejected tile is never re-dispatched or reconciled');
});
