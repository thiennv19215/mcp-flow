import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { flowComponentsSource } from './helpers/flow-components-source.mjs';

// ---------------------------------------------------------------------------
// Review round 2, item S5 — the frame picker scanned only the opened
// listbox (title search + scroll + 3 categories). An asset that existed
// in the project but had not been loaded into that listbox died with
// FLOW_ASSET_NOT_FOUND, even though the library scan that loads tiles
// (scanNativeAssets, the virtualized grid's loader) could have brought
// it in — the same situation TobyFlow answers with ensureFlowTilesLoaded
// + a filename re-resolve.
//
// The fix: when the category scan finds nothing, the picker runs ONE
// bounded library scan (no exactName — a scan miss must not itself
// throw) and then repeats the category scan exactly once before giving
// up with NOT_FOUND. The scan is guarded (missing FlowMediaMenu or a
// scan failure just proceeds to the second pass / NOT_FOUND), and the
// overall deadline still bounds everything.
// ---------------------------------------------------------------------------

const WANTED_UUID = '77777777-7777-4777-8777-777777777777';
const OTHER_UUID = '88888888-8888-4888-8888-888888888888';

function fallbackHarness({ loadOnScan = true } = {}) {
  let clock = 1_000_000;
  let pickerOpen = false;
  let clicked = false;
  let scanCalls = 0;
  const tileIds = new Map();
  const makeOption = (label, id) => {
    const tile = { getAttribute: name => name === 'aria-label' ? label : null, querySelectorAll: () => [] };
    tileIds.set(tile, id);
    return {
      name: label,
      getAttribute: name => name === 'aria-label' ? label
        : name === 'aria-selected' ? String(clicked && label === 'library-photo.png') : null,
      querySelectorAll: selector => selector === 'flow-grid-tile-container' ? [tile] : [],
      querySelector: () => null,
      click() { clicked = true; },
    };
  };
  const options = [makeOption('Unrelated.png', OTHER_UUID)];
  const list = {
    isConnected: true,
    getAttribute: name => name === 'role' ? 'listbox' : null,
    querySelectorAll: selector => selector === '[role="option"]' ? [...options] : [],
    closest: () => null,
  };
  const opener = {
    name: 'Start',
    getAttribute: name => name === 'aria-label' ? 'Start' : name === 'aria-expanded' ? String(pickerOpen) : null,
    innerText: 'Start',
    parentElement: { parentElement: { querySelectorAll: () => [] } },
    click() { pickerOpen = !pickerOpen; },
  };
  const allTab = { name: 'All', getAttribute: name => name === 'aria-selected' ? 'true' : null };
  const document = {
    querySelectorAll(selector) {
      if (selector === '[role="listbox"]') return pickerOpen ? [list] : [];
      if (selector === '[role="progressbar"],[aria-busy="true"]') return [];
      if (selector === '[role="tab"]') return [allTab];
      return [];
    },
    getElementById: () => null,
    dispatchEvent: () => {},
  };
  const context = vm.createContext({ document, location: { href: 'https://flow.google.com/project/test', pathname: '/project/test' },
    Date: class MockDate extends Date { static now() { return clock; } }, setTimeout, clearTimeout,
    window: { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} },
    CustomEvent: class CustomEvent { constructor(type) { this.type = type; } },
    mediaId: value => tileIds.get(value),
    visible: el => el !== list || pickerOpen,
    accessibleName: el => el.name || '',
    flowButton: name => name === 'Start' ? opener : null,
    flowFrameButton: slot => slot === 'start' ? opener : null,
    flowError: (code, message, retryable, outcome_unknown) => Object.assign(new Error(message), { code, retryable, outcome_unknown }),
    KeyboardEvent: class KeyboardEvent {},
    wait: async ms => { clock += ms; },
    FlowMediaMenu: {
      scanNativeAssets: async () => {
        scanCalls++;
        // The library scan loads tiles into the grid surface the picker
        // reads: after it runs, the wanted asset appears in the listbox.
        if (loadOnScan && !options.some(option => option.name === 'library-photo.png')) {
          options.push(makeOption('library-photo.png', WANTED_UUID));
        }
        return [];
      },
    },
  });
  vm.runInContext(flowComponentsSource, context);
  return { context, scanCalls: () => scanCalls, deadline: clock + 35_000 };
}

test('S5: an asset missing from the opened listbox is found after one library scan', async () => {
  const harness = fallbackHarness({ loadOnScan: true });
  const result = await harness.context.chooseNativePickerAsset('library-photo.png', 'start',
    { expectedId: WANTED_UUID, deadline: harness.deadline });
  assert.equal(result.confirmed, true);
  assert.equal(result.id, WANTED_UUID);
  assert.equal(harness.scanCalls(), 1, 'exactly one library scan runs before the retry pass');
});

test('S5 control: a genuinely absent asset still fails NOT_FOUND after the single scan', async () => {
  const harness = fallbackHarness({ loadOnScan: false });
  await assert.rejects(harness.context.chooseNativePickerAsset('library-photo.png', 'start',
    { expectedId: WANTED_UUID, deadline: harness.deadline }),
  error => error.code === 'FLOW_ASSET_NOT_FOUND');
  assert.equal(harness.scanCalls(), 1, 'the scan runs once even when it loads nothing');
});
