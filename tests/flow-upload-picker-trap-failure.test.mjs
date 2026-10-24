import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { File as NodeFile } from 'node:buffer';
import { TextEncoder as NodeTextEncoder } from 'node:util';

import { flowComponentsSource } from './helpers/flow-components-source.mjs';

// IMG-08 — no drag-and-drop fallback for a pre-selection picker-trap
// failure. When the picker trap fails before any file selection was made,
// nothing has been dispatched: the upload must fail with the trap's own
// error (code + diagnostics preserved) and must NOT attempt a synthetic
// drop dispatch, whose initiation cannot be verified. Post-selection
// behavior (picker succeeds, confirmation decides) is unchanged.

function stagedFile(fill = 0x41, name = 'IMG_1234.png') {
  return new NodeFile([new Uint8Array(1000).fill(fill)], name, { type: 'image/png' });
}

const TRAP_ERROR_CODE = 'FLOW_UPLOAD_PICKER_NOT_OPENED';
const TRAP_ERROR_MESSAGE = "Flow's Upload menu item was detached before it could be clicked.";
const TRAP_ERROR_DIAGNOSTICS = { phase: 'pre-selection', trapStage: 'open-picker' };

function trapHarness() {
  const mountedTiles = [];
  const libraryTiles = [];
  const pickerCalls = [];
  const dropCalls = [];
  let baselineScans = 0;
  let mediaCounter = 0;
  let pickerBehavior = { mode: 'success', landTile: true, tileReady: true };

  const makeTile = (name, id, { size = null, ready = true } = {}) => {
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
        pickerCalls.push(file);
        if (pickerBehavior.mode === 'trap-fail') {
          // The trap fails before the picker is ever opened and before any
          // selection exists — the same shape selectFileThroughPicker
          // produces for a pre-selection failure: a coded error with
          // outcome_unknown === false and its diagnostics attached.
          const error = new Error(TRAP_ERROR_MESSAGE);
          error.code = TRAP_ERROR_CODE;
          error.outcome_unknown = false;
          error.diagnostics = { ...TRAP_ERROR_DIAGNOSTICS };
          throw error;
        }
        await openPicker();
        if (pickerBehavior.landTile) {
          const tile = makeTile(file.name, `media-${++mediaCounter}`, {
            size: file.size, ready: pickerBehavior.tileReady,
          });
          mountedTiles.push(tile);
          libraryTiles.push(tile);
        }
        return { selected: true, method: 'input.click', type: file.type || 'image/png' };
      },
      // Spy: a confirmed drop receipt, so the old fallback path would
      // proceed all the way to tile confirmation (and time out there,
      // since a drop in this harness lands no tile).
      dropFileToFlow: async file => {
        dropCalls.push(file);
        return { dropped: true, accepted: true };
      },
    },
    flowError: (code, message, retryable, outcome_unknown) => Object.assign(new Error(message), { code, retryable, outcome_unknown }),
  });
  vm.runInContext(flowComponentsSource, context);
  return {
    uploader: context.FlowUploader,
    pickerCalls,
    dropCalls,
    libraryTiles,
    get baselineScans() { return baselineScans; },
    setPickerBehavior(patch) { pickerBehavior = { ...pickerBehavior, ...patch }; },
  };
}

test('IMG-08: a pre-selection picker-trap failure surfaces the trap error and never attempts a drop', async () => {
  const harness = trapHarness();
  harness.setPickerBehavior({ mode: 'trap-fail' });
  const file = stagedFile();

  await assert.rejects(
    harness.uploader.upload(file, 'image', {}, { callerKey: 'ref-1', deadline: Date.now() + 500 }),
    error => {
      assert.equal(error.code, TRAP_ERROR_CODE, 'the original trap error code must survive');
      assert.equal(error.message, TRAP_ERROR_MESSAGE, 'the original trap error message must survive');
      assert.deepEqual(
        JSON.parse(JSON.stringify(error.diagnostics)),
        TRAP_ERROR_DIAGNOSTICS,
        'the trap error diagnostics must survive unwrapped',
      );
      return true;
    },
  );
  assert.equal(harness.dropCalls.length, 0, 'no drag-and-drop dispatch may be attempted after a trap failure');
  assert.equal(harness.libraryTiles.length, 0, 'nothing was dispatched, so no tile can exist');

  // Nothing was dispatched, so no IMG-02 attempt record may exist either:
  // a retry with a working picker takes a fresh baseline and dispatches
  // normally instead of reconciling against a phantom attempt.
  harness.setPickerBehavior({ mode: 'success', landTile: true, tileReady: true });
  const receipt = await harness.uploader.upload(file, 'image', {}, { callerKey: 'ref-1', deadline: Date.now() + 9_000 });
  assert.equal(receipt.uploaded, true);
  assert.equal(receipt.reconciled, undefined, 'a fresh dispatch after a trap failure is not a reconciliation');
  assert.equal(receipt.id, harness.libraryTiles[0].id);
  assert.equal(harness.pickerCalls.length, 2, 'the retry dispatched through the picker exactly once more');
  assert.equal(harness.dropCalls.length, 0, 'the retry also never touches the drop path');
  assert.equal(harness.baselineScans, 2, 'the retry captured a fresh baseline: no stale attempt record was kept');
});

test('IMG-08 control: a successful picker selection confirms as today and never touches the drop path', async () => {
  const harness = trapHarness();
  const file = stagedFile();

  const receipt = await harness.uploader.upload(file, 'image', {}, { callerKey: 'ref-1', deadline: Date.now() + 9_000 });
  assert.equal(receipt.uploaded, true);
  assert.equal(receipt.id, harness.libraryTiles[0].id);
  assert.equal(receipt.name, 'IMG_1234.png');
  assert.equal(harness.pickerCalls.length, 1);
  assert.equal(harness.dropCalls.length, 0);
});

test('IMG-08 control: a post-selection confirmation failure behaves exactly as today', async () => {
  const harness = trapHarness();
  // The picker dispatches the selection and the tile lands, but it never
  // finishes processing: confirmation must time out exactly as before
  // IMG-08 (this item governs initiation, not confirmation).
  harness.setPickerBehavior({ mode: 'success', landTile: true, tileReady: false });
  const file = stagedFile();

  await assert.rejects(
    harness.uploader.upload(file, 'image', {}, { callerKey: 'ref-1', deadline: Date.now() + 500 }),
    error => {
      assert.equal(error.code, 'FLOW_UPLOAD_TIMEOUT');
      assert.equal(error.outcome_unknown, true);
      assert.equal(error.diagnostics?.filePickerSelectionConfirmed, true);
      assert.equal(error.diagnostics?.dropAttempted, false);
      return true;
    },
  );
  assert.equal(harness.pickerCalls.length, 1, 'the selection was dispatched exactly once');
  assert.equal(harness.dropCalls.length, 0, 'a confirmation failure never falls back to a drop either');
});
