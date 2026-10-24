import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Audit cluster B — retry identity for title-only tiles:
//
// retryIdentityForTile used to return `element:<lower-title>:<n>` for a
// tile with no media id and no runtime id, while retryIdentity for a
// title-only item returned `title:<lower-title>`. The two sides never
// matched, so when Flow re-rendered a failed tile (new element object,
// same title) matchesTarget found nothing and the retry was silently
// skipped. A title-only tile now gets the stable `title:<lower-title>`
// key, so the original item and its re-rendered tile agree.
// ---------------------------------------------------------------------------

function tilesHarness() {
  const tilesSource = readFileSync(new URL('../extension/src/content/providers/flow/generation/tiles.js', import.meta.url), 'utf8');
  const sandbox = {
    document: { querySelectorAll: () => [], querySelector: () => null },
    location: { href: 'https://flow.google.com/project/x' },
    console, setTimeout, clearTimeout, Date, Map, Set, WeakMap, Promise,
    Object, Array, Math, String, Number, Boolean, RegExp, JSON, Error,
    MutationObserver: class { observe() {} disconnect() {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  // Title-only tiles: mediaId reports a title: key, exactly like the
  // production dom-utils mediaId for a tile without a persistent id.
  sandbox.mediaId = (el) => {
    const persistent = el.getAttribute?.('data-media-id');
    if (persistent) return persistent;
    return 'title:' + (el.getAttribute?.('aria-label') || '');
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(tilesSource, context);
  return context.FlowTiles;
}

function titleOnlyTile(title) {
  return {
    getAttribute: (attribute) => (attribute === 'aria-label' ? title : null),
    id: '',
  };
}

test('retry identity: two re-rendered elements with the same title-only identity agree', () => {
  const { retryIdentity } = tilesHarness();
  const firstRender = titleOnlyTile('My Title');
  const secondRender = titleOnlyTile('My Title');
  const firstKey = retryIdentity({ element: firstRender });
  const secondKey = retryIdentity({ element: secondRender });
  assert.equal(firstKey, 'title:my title');
  assert.equal(secondKey, 'title:my title');
  assert.equal(firstKey, secondKey, 'a re-render must not change the retry key');
});

test('retry identity: a title-only item matches its re-rendered tile', () => {
  const { retryIdentity } = tilesHarness();
  const itemKey = retryIdentity({ title: 'My Title' });
  const tileKey = retryIdentity({ element: titleOnlyTile('My Title') });
  assert.equal(itemKey, tileKey, 'matchesTarget compares these two sides');
});

test('retry identity: runtime-id and media-id tiles keep their existing keys', () => {
  const { retryIdentity } = tilesHarness();
  const runtimeTile = {
    getAttribute: (attribute) => (attribute === 'data-tile-id' ? 'tile-9' : attribute === 'aria-label' ? 'Other' : null),
    id: '',
  };
  assert.equal(retryIdentity({ element: runtimeTile }), 'tile:tile-9');
  const mediaTile = {
    getAttribute: (attribute) => (attribute === 'data-media-id' ? 'AAAAAAAA-1111-4111-8111-111111111111' : null),
    id: '',
  };
  assert.equal(retryIdentity({ element: mediaTile }), 'media:aaaaaaaa-1111-4111-8111-111111111111');
});
