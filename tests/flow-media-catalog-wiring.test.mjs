import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { File as NodeFile } from 'node:buffer';
import { TextEncoder as NodeTextEncoder } from 'node:util';

import { flowComponentsSource } from './helpers/flow-components-source.mjs';
import { FlowMediaCatalog } from '../extension/src/background/flow-media-catalog.js';

// IMG-03 — rich upload receipt + catalog-first identity resolution.
// (a) an upload whose tile's persistent id is an `asb:` form and whose fake
//     observer publishes identity metadata resolves the canonical media
//     UUID, project id and thumbnail AT UPLOAD TIME onto the receipt, and
//     registers the asset in the background media catalog;
// (b) later, with the tile detached from the DOM, a catalog lookup still
//     resolves the asset identity — no grid scan, no observer round-trip.

const PROJECT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const MEDIA_UUID = '11111111-1111-4111-8111-111111111111';
const ASB_TOKEN = 'Ab3dEf6hIjKlMnOpQrStUvWxYz0123456789abcdEFGH';
const ASB_ID = `asb:${ASB_TOKEN}`;
const THUMBNAIL = 'https://flow.google.com/asb/thumb-for-upload';

class FakeCustomEvent {
  constructor(type, options = {}) { this.type = type; this.detail = options.detail; }
}

function fakeWindow() {
  const listeners = new Map();
  const dispatched = [];
  const win = {
    dispatched,
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    dispatchEvent(event) {
      dispatched.push(event.type);
      for (const listener of [...(listeners.get(event.type) || [])]) listener(event);
      return true;
    },
  };
  return win;
}

// The fake correlation observer: when an identity READ is requested it
// republishes the identities it observed from Flow's network traffic.
function installFakeObserver(win, entries) {
  const publish = () => win.dispatchEvent(new FakeCustomEvent('TOBY_FLOW_MEDIA_IDENTITIES', {
    detail: { projectId: PROJECT, entries },
  }));
  win.addEventListener('TOBY_FLOW_MEDIA_IDENTITIES_READ', publish);
  win.addEventListener('TOBY_FLOW_V2_MEDIA_IDENTITIES_READ', publish);
}

function uploadReceiptHarness({ observerEntries = [{ asb: ASB_TOKEN, mediaUuid: MEDIA_UUID, mediaType: 'image' }] } = {}) {
  const tiles = [];
  const sentMessages = [];
  const win = fakeWindow();
  installFakeObserver(win, observerEntries);

  const makeTile = (name, id) => {
    const image = {
      getAttribute: attribute => attribute === 'alt' ? name
        : attribute === 'src' ? THUMBNAIL : null,
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
    window: win,
    CustomEvent: FakeCustomEvent,
    setTimeout,
    clearTimeout,
    URL,
    location: { href: `https://flow.google.com/project/${PROJECT}`, pathname: `/project/${PROJECT}` },
    chrome: {
      runtime: {
        sendMessage: async message => {
          sentMessages.push(message);
          if (message?.type === 'flow-media-catalog:lookup') return { ok: true, entry: null };
          return { ok: true };
        },
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
        await openPicker();
        tiles.push(makeTile(file.name, ASB_ID));
        return { selected: true, method: 'input.click', type: file.type || 'image/png' };
      },
      dropFileToFlow: async () => ({ dropped: false }),
    },
    flowError: (code, message, retryable, outcome_unknown) => Object.assign(new Error(message), { code, retryable, outcome_unknown }),
  });
  vm.runInContext(flowComponentsSource, context);
  return { uploader: context.FlowUploader, sentMessages, tiles };
}

test('IMG-03 (a): upload receipt gains the canonical media UUID, project id and thumbnail, and registers the catalog entry', async () => {
  const { uploader, sentMessages } = uploadReceiptHarness();
  const file = new NodeFile([new Uint8Array(1000).fill(0x41)], 'IMG_1234.png', { type: 'image/png' });

  const receipt = await uploader.upload(file, 'image', {}, { callerKey: 'ref-1' });

  assert.equal(receipt.id, ASB_ID, 'the receipt id keeps the persistent id Flow exposed');
  assert.equal(receipt.mediaUuid, MEDIA_UUID, 'the receipt carries the canonical media UUID, not only the asb: form');
  assert.equal(receipt.projectId, PROJECT, 'the receipt carries the project id');
  assert.equal(receipt.thumbnailUrl, THUMBNAIL, 'the receipt carries the tile thumbnail URL');
  assert.equal(receipt.name, 'IMG_1234.png');

  const record = sentMessages.find(message => message?.type === 'flow-media-catalog:record');
  assert.ok(record, 'the upload registers the asset in the media catalog');
  assert.equal(record.entry.projectId, PROJECT);
  assert.equal(record.entry.mediaId, ASB_ID);
  assert.equal(record.entry.uuid, MEDIA_UUID);
  assert.equal(record.entry.thumbnailUrl, THUMBNAIL);
  assert.equal(record.entry.uploadName, receipt.uploadName);
  assert.equal(record.entry.originalName, 'IMG_1234.png');
  assert.equal(record.entry.kind, 'image');
});

test('IMG-03 (a2): without observer metadata the receipt keeps its current fields (no new failure mode)', async () => {
  const { uploader, sentMessages } = uploadReceiptHarness({ observerEntries: [] });
  // The observer never publishes identity metadata for this upload.
  const file = new NodeFile([new Uint8Array(1000).fill(0x42)], 'IMG_9999.png', { type: 'image/png' });
  const receipt = await uploader.upload(file, 'image', {}, { callerKey: 'ref-2' });
  assert.equal(receipt.id, ASB_ID);
  assert.equal(receipt.uploaded, true, 'the upload itself still succeeds');
  assert.equal(receipt.mediaUuid, undefined, 'no UUID is invented when the metadata never arrives');
  assert.equal(receipt.name, 'IMG_9999.png');
  const record = sentMessages.find(message => message?.type === 'flow-media-catalog:record');
  assert.ok(record, 'the asset is still registered with the identity that is known');
  assert.equal(record.entry.mediaId, ASB_ID);
});

function catalogResolutionHarness() {
  const storageData = {};
  const storage = {
    async get(key) { return { [key]: storageData[key] }; },
    async set(entries) { Object.assign(storageData, entries); },
  };
  const catalog = new FlowMediaCatalog({ storage });
  const win = fakeWindow();
  installFakeObserver(win, [{ asb: ASB_TOKEN, mediaUuid: MEDIA_UUID, mediaType: 'image' }]);
  let gridQueries = 0;
  const context = vm.createContext({
    document: {
      querySelectorAll: selector => { if (selector === 'flow-grid-tile-container') gridQueries++; return []; },
      querySelector: () => null,
    },
    window: win,
    CustomEvent: FakeCustomEvent,
    setTimeout,
    clearTimeout,
    location: { href: `https://flow.google.com/project/${PROJECT}`, pathname: `/project/${PROJECT}` },
    chrome: {
      runtime: {
        sendMessage: async message => {
          if (message?.type === 'flow-media-catalog:lookup') {
            return { ok: true, entry: await catalog.lookup(message.query || {}) };
          }
          return { ok: true };
        },
      },
    },
    visible: () => true,
    wait: async () => {},
    flowError: (code, message, retryable, outcome_unknown) => Object.assign(new Error(message), { code, retryable, outcome_unknown }),
  });
  const source = readFileSync(new URL('../extension/src/content/providers/flow/composer/reference-actions.js', import.meta.url), 'utf8');
  vm.runInContext(source, context);
  return { context, catalog, win, gridQueries: () => gridQueries };
}

test('IMG-03 (b): with the tile detached, identity resolution is served by the catalog — no grid scan, no observer round-trip', async () => {
  const { context, catalog, win, gridQueries } = catalogResolutionHarness();
  await catalog.record({
    projectId: PROJECT, mediaId: ASB_ID, uuid: MEDIA_UUID,
    uploadName: 'content-name.png', originalName: 'IMG_1234.png', name: 'IMG_1234.png', kind: 'image',
  });
  // The DOM is empty (the tile was detached): any grid scan would find
  // nothing, and the observer is never asked.
  const resolved = await context.resolveNativeMediaUuid(ASB_ID, 'image');
  assert.equal(resolved, MEDIA_UUID, 'the catalog resolves the canonical UUID');
  assert.equal(gridQueries(), 0, 'no DOM grid scan happens on the catalog-hit path');
  assert.equal(win.dispatched.filter(type => type.includes('MEDIA_IDENTITIES_READ')).length, 0,
    'the catalog hit short-circuits before the observer identity wait');
});

test('IMG-03 (b2): a catalog miss keeps the observer-event resolution path working', async () => {
  const { context, win } = catalogResolutionHarness();
  const resolved = await context.resolveNativeMediaUuid(ASB_ID, 'image');
  assert.equal(resolved, MEDIA_UUID, 'the observer metadata still resolves the UUID when the catalog has no entry');
  assert.ok(win.dispatched.some(type => type.includes('MEDIA_IDENTITIES_READ')), 'the miss fell through to the identity events');
});

test('IMG-03: the service worker serves the catalog behind sender gating', () => {
  const source = readFileSync(new URL('../extension/src/background/service-worker.js', import.meta.url), 'utf8');
  assert.match(source, /import \{ FlowMediaCatalog \} from "\.\/flow-media-catalog\.js";/);
  assert.match(source, /"flow-media-catalog:record"/);
  assert.match(source, /"flow-media-catalog:lookup"/);
  const handlerStart = source.indexOf('message.type.startsWith("flow-media-catalog:")');
  assert.ok(handlerStart >= 0, 'a flow-media-catalog message handler exists');
  const handlerBlock = source.slice(handlerStart, handlerStart + 700);
  assert.match(handlerBlock, /_sender\?\.id !== chrome\.runtime\.id/, 'catalog messages require this extension as sender');
  assert.match(handlerBlock, /FLOW_MEDIA_CATALOG_FORBIDDEN/, 'foreign senders are rejected with a typed error');
});
