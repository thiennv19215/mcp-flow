import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { File as NodeFile } from 'node:buffer';
import { TextEncoder as NodeTextEncoder } from 'node:util';

import { flowComponentsSource } from './helpers/flow-components-source.mjs';

// IMG-09b — production wiring for IMG-09's per-upload cancel.
// IMG-09 shipped the full cancel chain except one link: the sidebar's
// FlowUploadClient mints a stable request id (`upload-<transferId>`) and
// the uploader registers an AbortController under the id it receives in
// options — but the production flow.media.upload operation forwarded
// payload fields selectively (callerKey, per IMG-01) and never forwarded
// payload.requestId, so a cancel stopped at the client layer and could
// not reach an already-dispatched in-page confirmation loop.
//
// The harness drives the REAL flow.media.upload operation
// (upload-operations.js) end to end on a fake clock. The dispatched tile
// lands but never becomes ready, so without a working cancel the
// confirmation wait rides the IMG-05b extension to the 240 s image hard
// cap. At +10 s the harness cancels by request id through the same page
// facade the sidebar ultimately reaches — FlowUploader.cancelUpload —
// and the in-flight upload must abort promptly.

const uploadOperationsSource = readFileSync(
  new URL('../extension/src/content/providers/flow/media/upload-operations.js', import.meta.url),
  'utf8',
);

const flowError = (code, message, retryable, outcome_unknown) =>
  Object.assign(new Error(message), { code, retryable, outcome_unknown });

const PROJECT_A = '11111111-1111-4111-8111-111111111111';

function productionCancelHarness({ readyAt = Infinity, name = 'IMG_1234.png' } = {}) {
  let now = 1_000_000;
  const startedAt = now;
  class FakeDate extends Date {
    static now() { return now; }
  }
  const mountedTiles = [];
  const libraryTiles = [];
  const dispatched = [];
  let mediaCounter = 0;
  let cancelAt = null;
  let onCancelTime = null;

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
    AbortController,
    setTimeout,
    clearTimeout,
    location: {
      pathname: `/project/${PROJECT_A}/`,
      href: `https://flow.google.com/project/${PROJECT_A}/`,
    },
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
    wait: async ms => {
      now += Number(ms) || 0;
      if (cancelAt !== null && now >= cancelAt && onCancelTime) {
        const fire = onCancelTime;
        onCancelTime = null;
        fire();
      }
    },
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
        const tile = makeTile(file.name);
        mountedTiles.push(tile);
        libraryTiles.push(tile);
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
    uploader: context.FlowUploader,
    armCancel(atMs, fire) { cancelAt = atMs; onCancelTime = fire; },
    upload: (payloadExtra = {}, command = {}) =>
      operations.execute('flow.media.upload', { transferId: 'transfer-1', name, kind: 'image', ...payloadExtra }, command),
  };
}

async function expectPromptCancel(payloadExtra, requestId) {
  // The tile lands but never becomes ready: an un-cancellable upload
  // would ride the confirmation extension to the 240 s hard cap.
  const harness = productionCancelHarness({ readyAt: Infinity });
  let cancelReturn = 'not-called';
  harness.armCancel(harness.startedAt + 10_000, () => {
    cancelReturn = harness.uploader.cancelUpload(requestId);
  });
  let caught;
  try { await harness.upload(payloadExtra); } catch (error) { caught = error; }
  assert.ok(caught, 'the cancelled upload must fail instead of confirming');
  assert.equal(cancelReturn, true,
    'cancelUpload must find the in-flight upload — the request id has to reach the uploader through the operation');
  assert.equal(caught.code, 'FLOW_UPLOAD_TIMEOUT', String(caught?.stack || caught));
  assert.ok(harness.elapsed() >= 9_000, `the cancel was armed during the confirmation wait (elapsed ${harness.elapsed()} ms)`);
  assert.ok(harness.elapsed() < 25_000,
    `the upload aborted at the cancel, not the 240 s hard cap (elapsed ${harness.elapsed()} ms)`);
  assert.equal(harness.uploader.cancelUpload(requestId), false,
    'the registry entry is removed once the upload settles');
}

test('IMG-09b: a sidebar cancel by payload requestId aborts an in-flight production upload promptly', async () => {
  await expectPromptCancel({ requestId: 'upload-req-op-1' }, 'upload-req-op-1');
});

test('IMG-09b: the payload uploadRequestId spelling is forwarded the same way', async () => {
  await expectPromptCancel({ uploadRequestId: 'upload-req-op-2' }, 'upload-req-op-2');
});

test('IMG-09b control: a production upload without a request id is untouched by cancels and confirms normally', async () => {
  const harness = productionCancelHarness({ readyAt: 1_000_000 });
  assert.equal(harness.uploader.cancelUpload('upload-req-never-registered'), false,
    'no upload is registered under an id the operation never received');
  const receipt = await harness.upload({});
  assert.equal(receipt.uploaded, true);
  assert.equal(receipt.name, 'IMG_1234.png');
  assert.equal(harness.dispatched.length, 1);
  assert.ok(harness.elapsed() < 10_000, `a ready tile confirms immediately (elapsed ${harness.elapsed()} ms)`);
});
