import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const tilesSource = readFileSync(new URL('../extension/src/content/providers/flow/generation/tiles.js', import.meta.url), 'utf8');
const librarySource = readFileSync(new URL('../extension/src/content/providers/flow/library/library-operations.js', import.meta.url), 'utf8');

// Cluster A2, trash path: trashing "anh" must never delete "anh 2".
// Before this fix, countFlowTitleAcrossGrid + findFlowTile matched title
// prefixes, so the trash gate counted 1 copy and handed the "anh 2" tile
// to the destructive menu flow. These tests drive the REAL tiles.js
// functions inside the library-operations trash flow.

function trashHarness(mountedLabels) {
  const mounted = mountedLabels.map((label, i) => ({
    label,
    __id: `id-${i}`,
    parentElement: null,
    scrollIntoView() {},
    getAttribute(name) { return name === 'aria-label' ? this.label : null; },
  }));
  let menuOpen = false;
  let dialogOpen = false;
  let moreClicks = 0;
  const confirmBtn = {
    innerText: 'Move to trash',
    disabled: false,
    getAttribute: () => null,
    click() {
      const idx = mounted.indexOf(tile);
      if (idx >= 0) mounted.splice(idx, 1);
    },
  };
  // `tile` is referenced by confirmBtn; set after creation below.
  let tile = mounted[0];
  const dialog = {
    innerText: 'Move to trash',
    textContent: 'Move to trash',
    contains: () => false,
    querySelectorAll: () => [confirmBtn],
  };
  const trashItem = {
    innerText: 'Move to trash',
    disabled: false,
    getAttribute: () => null,
    click() { dialogOpen = true; },
  };
  const moreButton = {
    click() { menuOpen = true; moreClicks++; },
  };
  const documentElement = { scrollHeight: 100, clientHeight: 100, scrollTop: 100 };
  const document = {
    scrollingElement: null,
    documentElement,
    querySelectorAll(selector) {
      if (selector === 'flow-grid-tile-container') return [...mounted];
      if (selector === '[role="menuitem"]') return menuOpen ? [trashItem] : [];
      if (selector === '[role="dialog"],mat-dialog-container,[aria-modal="true"]') return dialogOpen ? [dialog] : [];
      return [];
    },
  };
  const context = vm.createContext({
    document,
    getComputedStyle: () => ({ overflowY: 'visible' }),
    wait: async () => {},
    mediaId: el => el?.__id,
    visible: () => true,
    accessibleName: el => el?.innerText || '',
    flowButton: label => label === 'More options' ? moreButton : null,
    console,
  });
  vm.runInContext(tilesSource, context);
  vm.runInContext(librarySource, context);
  const ops = new context.FlowLibraryOperations({
    error: (code, message, retryable, outcome_unknown) => Object.assign(new Error(message), { code, retryable, outcome_unknown }),
  });
  return { ops, moreClicks: () => moreClicks, mounted };
}

test('A2: trash "anh" refuses when only "anh 2" exists and never opens the tile menu', async () => {
  const h = trashHarness(['anh 2']);
  await assert.rejects(
    h.ops.execute('flow.asset.trash', { name: 'anh' }, { timeoutMs: 100 }),
    error => error.code === 'FLOW_ASSET_NOT_FOUND',
  );
  assert.equal(h.moreClicks(), 0, 'the destructive menu must not open for a prefix-only match');
  assert.equal(h.mounted.length, 1, 'no tile may be removed');
});

test('A2: trash "anh" deletes exactly the "anh" tile when it exists', async () => {
  const h = trashHarness(['anh', 'anh 2']);
  const result = await h.ops.execute('flow.asset.trash', { name: 'anh' }, { timeoutMs: 100 });
  // Compare by field, not deepEqual: the result object lives in the vm
  // realm, so its prototype differs from this realm's Object.
  assert.equal(result.trashed, 'anh');
  assert.equal(h.moreClicks(), 1);
  assert.deepEqual(h.mounted.map(t => t.label), ['anh 2']);
});
