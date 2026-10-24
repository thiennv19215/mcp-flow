import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Audit cluster E — identity/title keys and title folds, one source each:
//
// - tileSnapshotKey is the single builder for before/after tile-set keys
//   (generation baselines, wait, character flows). It is RAW on purpose:
//   `before` arrays cross the SW/content boundary as strings, so the
//   producer and every consumer must build byte-identical keys.
// - foldTileTitleStrict is the single strict fold for EXACT-match paths
//   (findFlowTile, countFlowTitleAcrossGrid): whitespace/trim/lowercase
//   only, NO accent folding — trash "anh" must not match tile "ánh".
// - configuredNavigationItem folds BOTH sides of the synonym comparison
//   with the canonical UI fold, so a decomposed-accent label still
//   matches its synonym; the lookup key stays strict-folded.
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
  const context = vm.createContext(sandbox);
  vm.runInContext(tilesSource, context);
  return context.FlowTiles;
}

test('tileSnapshotKey: string keys pass through unchanged', () => {
  const { tileSnapshotKey } = tilesHarness();
  assert.equal(tileSnapshotKey('title:hello'), 'title:hello');
  assert.equal(tileSnapshotKey('01234567-89ab-4def-8123-456789abcdef'), '01234567-89ab-4def-8123-456789abcdef');
});

test('tileSnapshotKey: media id wins, otherwise raw title', () => {
  const { tileSnapshotKey } = tilesHarness();
  assert.equal(tileSnapshotKey({ id: 'abc-123', title: 'Ignored' }), 'abc-123');
  assert.equal(tileSnapshotKey({ title: 'My Title' }), 'title:My Title');
  assert.equal(tileSnapshotKey({}), 'title:');
  assert.equal(tileSnapshotKey({ id: 'title:from-media-id', title: 'Other' }), 'title:from-media-id');
});

test('foldTileTitleStrict: whitespace/case only, accents preserved', () => {
  const { foldTileTitleStrict } = tilesHarness();
  assert.equal(foldTileTitleStrict('  My   Title '), 'my title');
  assert.equal(foldTileTitleStrict('ánh'), 'ánh');
  assert.notEqual(foldTileTitleStrict('ánh'), foldTileTitleStrict('anh'));
});

test('findFlowTile exact: accent-different titles do not match', async () => {
  const tile = (title) => ({ getAttribute: (name) => (name === 'aria-label' ? title : null) });
  // findFlowTile scans via document.querySelectorAll fallback when no
  // flowQueryAll adapter is present; no scroller means one scan pass.
  const grid = [tile('ánh'), tile('other')];
  const tilesSource = readFileSync(new URL('../extension/src/content/providers/flow/generation/tiles.js', import.meta.url), 'utf8');
  const sandbox2 = {
    document: {
      querySelectorAll: () => grid,
      querySelector: () => null,
      scrollingElement: null,
      documentElement: { scrollHeight: 0, clientHeight: 0 },
    },
    location: { href: 'https://flow.google.com/project/x' },
    console, setTimeout, clearTimeout, Date, Map, Set, WeakMap, Promise,
    Object, Array, Math, String, Number, Boolean, RegExp, JSON, Error,
    MutationObserver: class { observe() {} disconnect() {} },
  };
  sandbox2.window = sandbox2;
  sandbox2.globalThis = sandbox2;
  sandbox2.wait = () => Promise.resolve();
  const context2 = vm.createContext(sandbox2);
  vm.runInContext(tilesSource, context2);
  const found = await context2.FlowTiles.findFlowTile('anh');
  assert.equal(found, null, 'trash "anh" must not resolve to tile "ánh"');
  const foundExact = await context2.FlowTiles.findFlowTile('  ÁNH  ');
  assert.equal(foundExact, grid[0], 'whitespace/case variants of the exact title still match');
});

function navigationHarness() {
  const domUtils = readFileSync(new URL('../extension/src/content/shared/dom-utils.js', import.meta.url), 'utf8');
  const navigation = readFileSync(new URL('../extension/src/content/providers/flow/core/navigation.js', import.meta.url), 'utf8');
  const sandbox = {
    document: {
      querySelectorAll: () => [],
      querySelector: () => null,
      getElementById: () => null,
      body: null,
    },
    location: { href: 'https://flow.google.com/project/x' },
    console, setTimeout, clearTimeout, Date, Map, Set, WeakMap, Promise,
    Object, Array, Math, String, Number, Boolean, RegExp, JSON, Error,
    MutationObserver: class { observe() {} disconnect() {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(domUtils, context);
  vm.runInContext(navigation, context);
  // Real dom-utils visible() needs layout; the harness pins it to true.
  context.visible = () => true;
  return context;
}

function navCandidate(text) {
  return {
    innerText: text,
    textContent: text,
    disabled: false,
    getAttribute: () => null,
    closest: () => ({}),
    querySelectorAll: () => [],
  };
}

test('navigation synonyms: decomposed-accent label matches its synonym', () => {
  const context = navigationHarness();
  const decomposed = 'Tất cả phương tiện'.normalize('NFD');
  assert.notEqual(decomposed, 'Tất cả phương tiện', 'test precondition: NFD form differs');
  context.FlowSelectors = { navigation: { allMediaButton: {} } };
  context.flowQueryAll = () => [navCandidate(decomposed)];
  const found = context.FlowNavigation.flowNavigationItem('All media');
  assert.ok(found, 'NFD label must match the "all media" synonym after canonical folding');
  assert.equal(found.innerText, decomposed);
});

test('navigation synonyms: unrelated label still matches nothing', () => {
  const context = navigationHarness();
  context.FlowSelectors = { navigation: { allMediaButton: {} } };
  context.flowQueryAll = () => [navCandidate('Không liên quan')];
  const found = context.FlowNavigation.flowNavigationItem('All media');
  assert.equal(found, null);
});
