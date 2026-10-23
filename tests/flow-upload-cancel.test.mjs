import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { File as NodeFile } from 'node:buffer';
import { TextEncoder as NodeTextEncoder } from 'node:util';

import { flowComponentsSource } from './helpers/flow-components-source.mjs';

// IMG-09 (part 2) — per-upload cancellation. An in-flight staged upload
// can be cancelled by its upload request id: the uploader registers an
// AbortController per upload (keyed by the request id the caller passes
// in options.uploadRequestId), linked with the caller's own signal, and
// FlowUploader.cancelUpload(requestId) aborts exactly that upload. The
// confirmation wait's per-iteration abort check (part 1) makes the
// cancellation land promptly instead of at the deadline. A concurrent
// upload under a different request id is unaffected, and the registry
// entry is removed when the upload settles.
//
// The harness drives two real uploadStagedMedia calls concurrently on a
// fake clock. The picker stub lands a tile per dispatch and picks the
// tile's ready time from the file's first content byte (the dispatch
// file carries the staged bytes under a content-derived name):
// 0x41 → never ready, 0x42 → ready at +30 s, 0x43 → ready immediately.
// At +10 s the harness cancels upload A by request id.

const PROJECT_A = '11111111-1111-4111-8111-111111111111';

function cancelHarness() {
  let now = 1_000_000;
  const startedAt = now;
  class FakeDate extends Date {
    static now() { return now; }
  }
  const mountedTiles = [];
  const libraryTiles = [];
  let mediaCounter = 0;
  let cancelAt = null;
  let onCancelTime = null;

  const readyAtForByte = byte => (byte === 0x42 ? startedAt + 30_000 : byte === 0x43 ? startedAt : Infinity);
  const makeTile = (name, readyAt) => {
    const image = { getAttribute: attribute => (attribute === 'alt' ? name : null) };
    const tile = {
      id: `media-${++mediaCounter}`,
      name,
      get ready() { return now >= readyAt; },
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
    FlowTiles: { isTileMediaReady: tile => tile.ready === true },
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
        await openPicker();
        const firstByte = new Uint8Array(await file.arrayBuffer())[0];
        const tile = makeTile(file.name, readyAtForByte(firstByte));
        mountedTiles.push(tile);
        libraryTiles.push(tile);
        return { selected: true, method: 'input.click', type: file.type || 'image/png' };
      },
    },
    flowError: (code, message, retryable, outcome_unknown) => Object.assign(new Error(message), { code, retryable, outcome_unknown }),
  });
  vm.runInContext(flowComponentsSource, context);
  return {
    uploader: context.FlowUploader,
    libraryTiles,
    startedAt,
    elapsed: () => now - startedAt,
    armCancel(atMs, fire) { cancelAt = atMs; onCancelTime = fire; },
  };
}

test('IMG-09: cancelling one in-flight upload by request id aborts it promptly and leaves a concurrent upload unaffected', async () => {
  const harness = cancelHarness();
  const startedAt = harness.startedAt;
  const fileA = new NodeFile([new Uint8Array(1000).fill(0x41)], 'alpha.png', { type: 'image/png' });
  const fileB = new NodeFile([new Uint8Array(1000).fill(0x42)], 'beta.png', { type: 'image/png' });

  let cancelReturn = 'not-called';
  harness.armCancel(startedAt + 10_000, () => {
    cancelReturn = typeof harness.uploader.cancelUpload === 'function'
      ? harness.uploader.cancelUpload('upload-req-a')
      : 'missing';
  });

  const settle = promise => promise.then(
    receipt => ({ receipt, elapsed: harness.elapsed() }),
    error => ({ error, elapsed: harness.elapsed() }),
  );
  const outcomeA = settle(harness.uploader.upload(fileA, 'image', {}, {
    callerKey: 'cancel-a', uploadRequestId: 'upload-req-a', deadline: startedAt + 120_000,
  }));
  const outcomeB = settle(harness.uploader.upload(fileB, 'image', {}, {
    callerKey: 'cancel-b', uploadRequestId: 'upload-req-b', deadline: startedAt + 120_000,
  }));

  const [a, b] = await Promise.all([outcomeA, outcomeB]);

  assert.equal(cancelReturn, true, 'cancelUpload found and aborted the registered upload');
  assert.ok(a.error, 'the cancelled upload must fail instead of confirming');
  assert.equal(a.error.code, 'FLOW_UPLOAD_TIMEOUT', String(a.error?.stack || a.error));
  assert.ok(a.elapsed < 25_000, `the cancelled upload stopped at the cancel, not its 120 s deadline (elapsed ${a.elapsed} ms)`);
  assert.ok(b.receipt, `the concurrent upload must be unaffected (got error ${b.error?.code || 'none'})`);
  assert.equal(b.receipt.uploaded, true);
  assert.equal(b.receipt.name, 'beta.png');
  assert.ok(b.elapsed >= 30_000, `upload B still waited for its own tile (elapsed ${b.elapsed} ms)`);

  // The registry is cleaned up as uploads settle: neither id can be
  // cancelled twice, and unknown ids report false.
  assert.equal(harness.uploader.cancelUpload('upload-req-a'), false);
  assert.equal(harness.uploader.cancelUpload('upload-req-b'), false);
  assert.equal(harness.uploader.cancelUpload('upload-req-never-existed'), false);
});

test('IMG-09 control: an upload with a request id that is never cancelled confirms normally', async () => {
  const harness = cancelHarness();
  const file = new NodeFile([new Uint8Array(1000).fill(0x43)], 'gamma.png', { type: 'image/png' });
  const receipt = await harness.uploader.upload(file, 'image', {}, {
    callerKey: 'cancel-control', uploadRequestId: 'upload-req-control', deadline: harness.startedAt + 120_000,
  });
  assert.equal(receipt.uploaded, true);
  assert.equal(receipt.name, 'gamma.png');
  assert.equal(receipt.id, harness.libraryTiles[0].id);
  assert.equal(typeof harness.uploader.cancelUpload, 'function');
  assert.equal(harness.uploader.cancelUpload('upload-req-control'), false,
    'a settled upload leaves no registry entry behind');
});
