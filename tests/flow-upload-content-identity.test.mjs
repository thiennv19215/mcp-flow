import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { File as NodeFile } from 'node:buffer';
import { TextEncoder as NodeTextEncoder } from 'node:util';

import { flowComponentsSource } from './helpers/flow-components-source.mjs';

// IMG-01 — deterministic content-derived upload identity.
// A staged file is dispatched under a name derived from a digest over
// (salt, caller key, MIME type, SHA-256 of the bytes), so tile matching and
// reuse are content-exact: same name + same byte size can no longer conflate
// two different files, and the same file under the same caller key dedupes.

const UUID_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/;

function sizedBytes(fill, length = 1000) {
  return new Uint8Array(length).fill(fill);
}

function stagedFile(bytes, name = 'IMG_1234.png') {
  return new NodeFile([bytes], name, { type: 'image/png' });
}

function identityHarness({ seedTiles = [] } = {}) {
  const tiles = [...seedTiles];
  const dispatched = [];
  let mediaCounter = 0;

  const makeTile = (name, id, sizeAttr) => {
    const image = {
      getAttribute: attribute => attribute === 'alt' ? name
        : attribute === 'data-file-size' && sizeAttr != null ? String(sizeAttr) : null,
    };
    return {
      id,
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
        if (selector === 'flow-grid-tile-container') return [...tiles];
        if (selector.includes('component-picker')) return [menuRoot];
        return [];
      },
    },
    crypto: webcrypto,
    File: NodeFile,
    TextEncoder: NodeTextEncoder,
    PointerEvent: class {},
    MouseEvent: class {},
    FlowTiles: { isTileMediaReady: () => true },
    FlowEditor: { getFlowSubmitButton: () => submit },
    flowQuery: key => key === 'editor' ? editor : key === 'composerRoot' ? composer : null,
    flowButton: () => addButton,
    accessibleName: element => element.getAttribute?.('aria-label') || '',
    visible: () => true,
    wait: async () => {},
    mediaId: tile => tile.id,
    emitFlowProgress: () => {},
    FlowMediaMenu: {
      scanNativeAssets: async options => options?.requireComplete
        ? tiles.map(tile => ({ id: tile.id }))
        : [],
    },
    FlowNativeFileTransfer: {
      selectFileThroughPicker: async (file, openPicker) => {
        dispatched.push(file);
        await openPicker();
        // Flow names the new tile after the dispatched file and exposes the
        // file's byte size on it — the strongest name+size evidence there is.
        tiles.push(makeTile(file.name, `media-${++mediaCounter}`, file.size));
        return { selected: true, method: 'input.click', type: file.type || 'image/png' };
      },
      dropFileToFlow: async () => ({ dropped: false }),
    },
    flowError: (code, message, retryable, outcome_unknown) => Object.assign(new Error(message), { code, retryable, outcome_unknown }),
  });
  vm.runInContext(flowComponentsSource, context);
  return { uploader: context.FlowUploader, tiles, dispatched, makeTile };
}

test('IMG-01 (a): two different files with identical name AND byte size are never conflated', async () => {
  const { uploader, dispatched } = identityHarness();
  const fileA = stagedFile(sizedBytes(0x41));
  const fileB = stagedFile(sizedBytes(0x42));
  assert.equal(fileA.name, fileB.name);
  assert.equal(fileA.size, fileB.size);

  const receiptA = await uploader.upload(fileA, 'image', {}, { callerKey: 'ref-1' });
  const receiptB = await uploader.upload(fileB, 'image', {}, { callerKey: 'ref-1' });

  assert.notEqual(receiptB.reused, true, 'the second, different file must not be reported as reused');
  assert.equal(dispatched.length, 2, 'a second dispatch must occur for the different file');
  assert.notEqual(receiptA.id, receiptB.id, 'receipts must carry different media ids');
  assert.match(receiptA.uploadName, UUID_NAME);
  assert.match(receiptB.uploadName, UUID_NAME);
  assert.notEqual(receiptA.uploadName, receiptB.uploadName, 'different bytes must derive different upload names');
  assert.equal(dispatched[0].name, receiptA.uploadName, 'dispatch uses the content-derived name');
  assert.equal(dispatched[1].name, receiptB.uploadName, 'dispatch uses the content-derived name');
  assert.equal(receiptA.name, 'IMG_1234.png', 'the receipt keeps the original file name for callers');
  assert.equal(receiptB.name, 'IMG_1234.png');
  assert.equal(receiptA.originalName, 'IMG_1234.png');
});

test('IMG-01 (b): the exact same file under the same caller key dedupes to one identity', async () => {
  const { uploader, dispatched } = identityHarness();
  const file = stagedFile(sizedBytes(0x41));

  const first = await uploader.upload(file, 'image', {}, { callerKey: 'ref-1' });
  const second = await uploader.upload(file, 'image', {}, { callerKey: 'ref-1' });

  assert.equal(second.reused, true, 'the same file + same key must be a dedupe/reuse');
  assert.equal(second.id, first.id, 'dedupe returns the same media id');
  assert.equal(second.uploadName, first.uploadName, 'dedupe returns the same content-derived name');
  assert.match(first.uploadName, UUID_NAME);
  assert.equal(dispatched.length, 1, 'no second dispatch for the exact same file and key');
});

test('IMG-01 (c): the same bytes under a different caller key get a different identity', async () => {
  const { uploader, dispatched } = identityHarness();
  const bytes = sizedBytes(0x41);
  const fileKey1 = stagedFile(bytes);
  const fileKey2 = stagedFile(bytes);

  const receipt1 = await uploader.upload(fileKey1, 'image', {}, { callerKey: 'ref-1' });
  const receipt2 = await uploader.upload(fileKey2, 'image', {}, { callerKey: 'ref-2' });

  assert.notEqual(receipt2.uploadName, receipt1.uploadName, 'the caller key separates identities for identical bytes');
  assert.notEqual(receipt2.reused, true, 'a different caller key must not reuse the first key\'s tile');
  assert.equal(dispatched.length, 2, 'a second dispatch must occur under the second key');
  assert.notEqual(receipt2.id, receipt1.id);
});

test('IMG-01 (d): the derived name is deterministic across sessions (a tile from an earlier session is reused)', async () => {
  const file = stagedFile(sizedBytes(0x41));
  const first = identityHarness();
  const receipt = await first.uploader.upload(file, 'image', {}, { callerKey: 'ref-1' });
  assert.match(receipt.uploadName, UUID_NAME);

  // A brand-new content-script session: the only trace of the earlier upload
  // is the tile Flow kept, named with the content-derived name.
  const second = identityHarness({ seedTiles: [] });
  second.tiles.push(second.makeTile(receipt.uploadName, 'media-previous', file.size));
  const again = await second.uploader.upload(file, 'image', {}, { callerKey: 'ref-1' });
  assert.equal(again.reused, true, 'the same file + key must re-derive the same name and reuse its tile');
  assert.equal(again.id, 'media-previous');
  assert.equal(again.uploadName, receipt.uploadName);
  assert.equal(second.dispatched.length, 0, 'no dispatch when the deterministic tile already exists');
});

test('IMG-01 legacy: a staged file without readable bytes keeps the name-only reuse path', async () => {
  const { uploader, tiles, makeTile, dispatched } = identityHarness();
  tiles.push(makeTile('plain-name.png', 'media-legacy', null));
  const receipt = await uploader.upload({ name: 'plain-name.png' }, 'image', {});
  assert.equal(receipt.reused, true);
  assert.equal(receipt.id, 'media-legacy');
  assert.equal(receipt.name, 'plain-name.png');
  assert.equal(dispatched.length, 0);
});
