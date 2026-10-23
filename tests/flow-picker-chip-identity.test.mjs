import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// IMG-06: the picker-path attach must verify the newly added chip's exposed
// media UUID against the selected option's canonical id (mirroring the tile
// path). A chip exposing a different UUID fails the attach with
// FLOW_ASSET_ID_MISMATCH; a chip exposing no UUID keeps the legacy
// count-based confirmation.

const EXPECTED = '11111111-1111-4111-8111-111111111111';
const WRONG = '99999999-9999-4999-8999-999999999999';

function pickerChipHarness({ chipUuid }) {
  const source = readFileSync(new URL('../extension/src/content/providers/flow/composer/reference-actions.js', import.meta.url), 'utf8');
  let tick = 0;
  let chipAttached = false;
  let pickerOpen = true;

  const chipImg = {
    alt: '',
    getAttribute: (key) => (key === 'src' ? 'https://flow.google.com/asb/chip-thumb' : null),
  };
  const chipButton = {
    className: '',
    getAttribute(key) {
      if (key === 'aria-label') return 'Ingredient';
      if (key === 'data-media-id') return chipUuid;
      return null;
    },
    querySelector: (selector) => (selector === 'img' ? chipImg : null),
    querySelectorAll: (selector) => (chipUuid && selector.includes('data-media-id') ? [chipButton] : []),
    closest: () => null,
    click() {},
  };

  const optionTile = {
    fakeMediaId: EXPECTED,
    getAttribute: (key) => (key === 'aria-label' ? 'ref.png' : null),
    querySelector: () => null,
  };
  const option = {
    name: 'ref.png',
    getAttribute: (key) => (key === 'aria-posinset' ? '1' : key === 'aria-label' ? 'ref.png' : null),
    querySelector: (selector) => (selector === 'flow-grid-tile-container' ? optionTile : null),
    querySelectorAll: () => [],
    click() { chipAttached = true; pickerOpen = false; },
  };
  const scroller = { style: { overflowY: 'auto' }, clientHeight: 100, scrollHeight: 100, scrollTop: 0 };
  const owner = { parentElement: null, style: { overflowY: '' }, clientHeight: 0, scrollHeight: 0, querySelectorAll: () => [] };
  const tab = {
    name: 'Tất cả',
    getAttribute: (key) => (key === 'aria-selected' ? 'true' : key === 'role' ? 'tab' : null),
    click() {},
  };
  const list = {
    clientHeight: 100,
    scrollTop: 0,
    scrollHeight: 100,
    getAttribute: (key) => (key === 'role' ? 'listbox' : null),
    querySelectorAll(selector) {
      if (selector === '[role="option"]') return [option];
      if (selector === '*') return [scroller];
      if (selector.includes('[role="tab"]')) return [tab];
      if (selector.includes('button')) return chipAttached ? [chipButton] : [];
      return [];
    },
    querySelector: () => null,
    closest: () => null,
  };
  list.parentElement = owner;
  const document = {
    documentElement: { lang: 'en' },
    body: { innerText: '' },
    querySelectorAll(selector) {
      if (selector === '[role="listbox"]') return pickerOpen ? [list] : [];
      if (selector === '[role="tab"]') return [tab];
      if (selector === '[role="dialog"],[role="menu"],[role="listbox"],mat-menu,mat-select-panel') return pickerOpen ? [list] : [];
      if (selector === 'button[aria-label="Ingredient"]') return chipAttached ? [chipButton] : [];
      if (selector === 'button,[role="button"]') return chipAttached ? [chipButton] : [];
      return [];
    },
    querySelector: () => null,
    dispatchEvent: () => true,
  };
  const context = vm.createContext({
    document,
    Event: class { constructor(type, options = {}) { this.type = type; Object.assign(this, options); } },
    KeyboardEvent: class { constructor(type, options = {}) { this.type = type; Object.assign(this, options); } },
    location: { href: 'https://flow.google.com/project/test', pathname: '/project/test' },
    Date: class MockDate extends Date { static now() { return tick; } },
    visible: () => true,
    mediaId: (el) => el.fakeMediaId || '22222222-2222-4222-8222-222222222222',
    accessibleName: (el) => el.name || el.getAttribute?.('aria-label') || '',
    flowButton: () => null,
    wait: async (ms) => { tick += ms; },
    flowError: (code, message, retryable, outcome_unknown) => Object.assign(new Error(message), { code, retryable, outcome_unknown }),
  });
  vm.runInContext(source, context);
  return { api: context.FlowReferenceActions };
}

test('IMG-06: picker attach fails when the added chip exposes a different UUID than the selected option', async () => {
  const { api } = pickerChipHarness({ chipUuid: WRONG });
  await assert.rejects(
    api.attach({ assetName: 'ref.png', kind: 'image' }, null, { expectedId: EXPECTED }),
    (error) => error.code === 'FLOW_ASSET_ID_MISMATCH',
    'a chip whose exposed UUID conflicts with the selected option must fail the attach, not confirm by count',
  );
});

test('IMG-06: picker attach confirms when the added chip exposes the selected UUID', async () => {
  const { api } = pickerChipHarness({ chipUuid: EXPECTED });
  const result = await api.attach({ assetName: 'ref.png', kind: 'image' }, null, { expectedId: EXPECTED });
  assert.equal(result.confirmed, true);
  assert.equal(result.id, EXPECTED);
});

test('IMG-06: picker attach keeps count-based confirmation when the chip exposes no UUID', async () => {
  const { api } = pickerChipHarness({ chipUuid: null });
  const result = await api.attach({ assetName: 'ref.png', kind: 'image' }, null, { expectedId: EXPECTED });
  assert.equal(result.confirmed, true);
  assert.equal(result.id, EXPECTED);
});
