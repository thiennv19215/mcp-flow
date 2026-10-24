import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const tilesSource = readFileSync(new URL('../extension/src/content/providers/flow/generation/tiles.js', import.meta.url), 'utf8');

// Cluster A2: grid tile lookup must be EXACT for destructive paths.
// Before this fix, findFlowTile / countFlowTitleAcrossGrid also matched
// title prefixes, so trashing "anh" in a library that only held "anh 2"
// counted 1 copy and returned the "anh 2" tile — a wrong-asset delete.
// Prefix semantics belong to the scan filters (download / workflow
// source resolution), which resolve to a full name BEFORE calling these.

function makeTile(label, id) {
  return {
    label,
    __id: id,
    parentElement: null,
    getAttribute(name) {
      if (name === 'aria-label') return this.label;
      return null;
    },
  };
}

function tilesHarness(mounted) {
  const documentElement = { scrollHeight: 100, clientHeight: 100, scrollTop: 100 };
  const document = {
    scrollingElement: null,
    documentElement,
    querySelectorAll(selector) {
      if (selector === 'flow-grid-tile-container') return [...mounted];
      return [];
    },
  };
  const context = vm.createContext({
    document,
    getComputedStyle: () => ({ overflowY: 'visible' }),
    wait: async () => {},
    mediaId: tile => tile?.__id,
    console,
  });
  vm.runInContext(tilesSource, context);
  return context.FlowTiles;
}

test('A2: findFlowTile("anh") returns null when only "anh 2" exists', async () => {
  const tiles = tilesHarness([makeTile('anh 2', 'id-anh-2')]);
  assert.equal(await tiles.findFlowTile('anh'), null);
});

test('A2: findFlowTile("anh") returns the exact tile when both "anh" and "anh 2" exist', async () => {
  const exact = makeTile('anh', 'id-anh');
  const tiles = tilesHarness([makeTile('anh 2', 'id-anh-2'), exact]);
  assert.equal(await tiles.findFlowTile('anh'), exact);
});

test('A2: findFlowTile still finds a full title ("anh 2")', async () => {
  const tile = makeTile('anh 2', 'id-anh-2');
  const tiles = tilesHarness([tile]);
  assert.equal(await tiles.findFlowTile('anh 2'), tile);
});

test('A2: countFlowTitleAcrossGrid("anh") counts only exact titles', async () => {
  const tiles = tilesHarness([makeTile('anh', 'id-anh'), makeTile('anh 2', 'id-anh-2')]);
  assert.equal(await tiles.countFlowTitleAcrossGrid('anh'), 1);
});

test('A2: countFlowTitleAcrossGrid("anh") is 0 when only "anh 2" exists', async () => {
  const tiles = tilesHarness([makeTile('anh 2', 'id-anh-2')]);
  assert.equal(await tiles.countFlowTitleAcrossGrid('anh'), 0);
});
