import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

import { flowComponentsSource } from './helpers/flow-components-source.mjs';

const domUtilsSource = readFileSync(new URL('../extension/src/content/shared/dom-utils.js', import.meta.url), 'utf8');
const mediaMenuSource = readFileSync(new URL('../extension/src/content/providers/flow/media/media-menu.js', import.meta.url), 'utf8');

const LOCATION = { href: 'https://flow.google.com/', origin: 'https://flow.google.com' };

function mediaElement({ attrs = {}, src = '', alt = '' } = {}) {
  return {
    tagName: 'IMG',
    currentSrc: src,
    complete: true,
    naturalWidth: 100,
    getAttribute(name) {
      if (name === 'src') return src || null;
      if (name === 'alt') return alt || null;
      return attrs[name] ?? null;
    },
  };
}

function tile({ attrs = {}, label = 'ref-01-upload-abc123.png', media = [], descendants = [] } = {}) {
  const img = media[0] || null;
  return {
    getAttribute(name) {
      if (name === 'aria-label') return label;
      return attrs[name] ?? null;
    },
    querySelector(selector) {
      if (selector === 'flow-error-tile' || selector === 'flow-scene-tile' || selector === 'flow-video-tile,video' || selector === 'flow-video-tile') return null;
      if (selector === 'flow-image-tile,img' || selector === 'flow-image-tile') return img;
      if (selector === 'img') return img;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === 'img,video') return media;
      if (selector === '[data-persistent-media-id],[data-media-id]') return descendants;
      return [];
    },
  };
}

function mediaIdContext() {
  const context = vm.createContext({ location: LOCATION, URL, console });
  vm.runInContext(domUtilsSource, context);
  return context;
}

test('mediaId reads the persistent identity from the tile container attributes', () => {
  const context = mediaIdContext();
  const persistentId = '33333333-3333-4333-8333-333333333333';
  // The image src is a blob: preview with no embedded ID: before the fix
  // mediaId() could only fall back to `title:<name>`, so upload confirmation
  // never latched the new tile as a persistent owner.
  const blobTile = tile({
    attrs: { 'data-media-id': persistentId },
    media: [mediaElement({ src: 'blob:https://flow.google.com/preview' })],
  });
  assert.equal(context.mediaId(blobTile), persistentId);

  const persistentAttrTile = tile({
    attrs: { 'data-persistent-media-id': persistentId },
    media: [mediaElement({ src: '' })],
  });
  assert.equal(context.mediaId(persistentAttrTile), persistentId);
});

test('mediaId reads identity attributes from descendant wrappers', () => {
  const context = mediaIdContext();
  const persistentId = '44444444-4444-4444-8444-444444444444';
  const wrapper = { getAttribute: name => (name === 'data-media-id' ? persistentId : null) };
  const wrappedTile = tile({ media: [mediaElement({ src: '' })], descendants: [wrapper] });
  assert.equal(context.mediaId(wrappedTile), persistentId);
});

test('mediaId keeps the previous src-derived identities and title fallback', () => {
  const context = mediaIdContext();
  const uuid = '22222222-2222-4222-8222-222222222222';
  const uuidTile = tile({ media: [mediaElement({ src: `https://flow-content.google/image/${uuid}` })] });
  assert.equal(context.mediaId(uuidTile), uuid);

  const asbTile = tile({ media: [mediaElement({ src: 'https://flow.google.com/asb/xyz123=s256' })] });
  assert.equal(context.mediaId(asbTile), 'asb:xyz123');

  const directTile = tile({ media: [mediaElement({ attrs: { 'data-media-id': uuid }, src: '' })] });
  assert.equal(context.mediaId(directTile), uuid);

  const bareTile = tile({ label: 'plain-name.png', media: [mediaElement({ src: '' })] });
  assert.equal(context.mediaId(bareTile), 'title:plain-name.png');
});

test('upload confirmation latches a new tile whose only identity is its container data-media-id', async () => {
  const name = 'ref-01-upload-abc123.png';
  const oldId = '11111111-1111-4111-8111-111111111111';
  const newId = '33333333-3333-4333-8333-333333333333';
  const oldTile = tile({
    label: name,
    attrs: { 'data-media-id': oldId },
    media: [mediaElement({ src: 'blob:https://flow.google.com/old', alt: name })],
  });
  const newTile = tile({
    label: name,
    attrs: { 'data-media-id': newId },
    media: [mediaElement({ src: 'blob:https://flow.google.com/new', alt: name })],
  });
  const tiles = [oldTile, newTile];
  const context = vm.createContext({
    location: LOCATION,
    URL,
    console,
    document: { querySelectorAll: selector => (selector === 'flow-grid-tile-container' ? tiles : []) },
    FlowTiles: { isTileMediaReady: () => true },
    FlowUiDeadline: { boundedWait: async () => {} },
  });
  vm.runInContext(domUtilsSource, context);
  vm.runInContext(flowComponentsSource, context);

  const result = await context.waitForNativeMediaTile(name, {}, 'image', {
    deadline: Date.now() + 2000,
    baselineIds: [oldId],
    requireNewOwner: true,
    maxLibraryScans: 0,
  });
  assert.equal(result.id, newId);
  assert.equal(result.name, name);
});

test('collectAssets uses the tile persistent-media-id when mediaId only yields a title', () => {
  const persistentId = '55555555-5555-4555-8555-555555555555';
  const name = 'ref-01-upload-abc123.png';
  const img = mediaElement({ src: 'https://lh3.googleusercontent.com/no-uuid-here', alt: name });
  const assetTile = {
    getAttribute(attribute) {
      if (attribute === 'aria-label') return name;
      if (attribute === 'data-persistent-media-id') return persistentId;
      return null;
    },
    querySelector(selector) {
      if (selector === 'flow-image-tile') return img;
      if (selector === 'img') return img;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === 'img,video') return [img];
      return [];
    },
  };
  const context = vm.createContext({
    location: LOCATION,
    URL,
    console,
    document: { querySelectorAll: selector => (selector === 'flow-grid-tile-container' ? [assetTile] : []) },
    // Simulate a mediaId implementation that cannot see the container
    // attribute: collectAssets must still surface the persistent ID it
    // resolved itself instead of dropping the asset's identity entirely.
    mediaId: () => `title:${name}`,
    FlowTiles: { isTileBusy: () => false, isTileMediaReady: () => true },
  });
  vm.runInContext(mediaMenuSource, context);

  const assets = context.collectAssets({ includeIncomplete: true });
  assert.equal(assets.length, 1);
  assert.equal(assets[0].id, persistentId);
  assert.equal(assets[0].identityDurability, 'persistent');
});
