import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createHash, webcrypto } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { extensionSetWebSocket } from '../dist/extension.js';
import { runGeneration, normalizeFlowCharacters } from '../dist/flow.js';
import { getCachedProjectMedia, cacheProjectMedia } from '../dist/flow-transfer.js';
import { materializeNativeDownload } from '../dist/native-downloads.js';
import { readFlowDownloadChunk } from '../extension/src/background/flow-download-relay.js';
import { flowComponentsSource } from './helpers/flow-components-source.mjs';
const source = flowComponentsSource;

const charactersSource = readFileSync(new URL('../extension/src/content/providers/flow/characters/flow-characters.js', import.meta.url), 'utf8');
const mediaMenuSource = readFileSync(new URL('../extension/src/content/providers/flow/media/media-menu.js', import.meta.url), 'utf8');
const libraryOperationsSource = readFileSync(new URL('../extension/src/content/providers/flow/library/library-operations.js', import.meta.url), 'utf8');
const generationOperationsSource = readFileSync(new URL('../extension/src/content/providers/flow/generation/generation-operations.js', import.meta.url), 'utf8');
const nativeFileTransferSource = readFileSync(new URL('../extension/src/content/shared/native-file-transfer.js', import.meta.url), 'utf8');

test('generation frame routing passes its explicit UUID through to the picker', async () => {
  const context = vm.createContext({ Object, String, RegExp });
  vm.runInContext(generationOperationsSource, context);
  const operations = new context.FlowGenerationOperations({});
  const uuid = 'b5d304ab-eeb8-4001-8110-86a225761c0f';
  const frame = operations.frameValue({ assetName: 'fm-a6f6c32f9203-upload.png', expectedId: uuid });
  assert.deepEqual(JSON.parse(JSON.stringify(frame)), { assetName: 'fm-a6f6c32f9203-upload.png', expectedId: uuid });

  let selected;
  await operations.selectFrameAsset({ chooseNativePickerAsset: async (name, slot, options) => { selected = { name, slot, options }; } }, frame, 'start', { deadline: 1000 });
  assert.equal(selected.name, 'fm-a6f6c32f9203-upload.png');
  assert.equal(selected.slot, 'start');
  assert.equal(selected.options.expectedId, uuid);
  assert.equal(operations.frameValue({ assetName: 'still.png', expectedId: 'bad-id' }), null);
});

function localUploadGenerationHarness({ failPopupCleanup = false } = {}) {
  const events = [];
  const mediaId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const attemptId = 'attempt-1';
  const transferId = 'transfer-1';
  const correlation = new Map();
  let uploadPopupOpen = false;
  const context = vm.createContext({
    Date, Promise, Map, Set, Object, String, Number, Boolean, Array, Math, RegExp, Error, AbortController,
    setTimeout, clearTimeout,
    FlowUiDeadline: {
      makeDeadline: () => Date.now() + 60_000,
      requireTime: () => {},
    },
    stagedNativeFiles: new Map([[transferId, { name: 'local-ref.png', size: 20, type: 'image/png' }]]),
    validStagedLocalImage: () => true,
    FlowNavigation: {
      ensureFlowProjectEditor: async () => ({ isProjectEditor: true }),
      dismissBlockingOverlays: async () => false,
      ensureFlowLibrarySection: async () => true,
      prepareFlowOperation: async () => {
        events.push('popup-cleanup');
        if (failPopupCleanup) throw Object.assign(new Error('popup remains open'), { code: 'FLOW_BLOCKING_OVERLAY_UNRESOLVED' });
        uploadPopupOpen = false;
        return { ready: true, popupDismissed: true };
      },
    },
    FlowMediaMenu: { nativeRead: () => ({ signedIn: true, inProject: true }) },
    FlowAgent: { closeNativeAgentSession: async () => true },
    FlowComponents: {
      clearExistingIngredientChips: async () => ({ remaining: 0 }),
      uploadStagedFlowMedia: async () => {
        events.push('upload-complete');
        uploadPopupOpen = true;
        return { id: mediaId, uploaded: true };
      },
      chooseNativePickerAsset: async (_name, _slot, options) => {
        events.push('attach-reference');
        assert.equal(uploadPopupOpen, false, 'reference selection waits until the upload popup is closed');
        assert.equal(options.expectedId, mediaId);
        return { name: 'local-ref.png', kind: 'image', id: mediaId, confirmed: true };
      },
    },
    FlowImageActions: { prepare: async () => { events.push('prepare-image'); } },
    FlowEditor: {
      preflightGenerationPrompt: async () => { events.push('prompt-editor-ready'); return {}; },
      insertNativeFlowPrompt: async () => { events.push('prompt-entered'); return true; },
      waitForGenerationSubmitButton: async () => ({ disabled: false, getAttribute: () => null }),
      currentFlowSubmitErrors: () => [],
      activateFlowSubmitButton: async () => { events.push('submit'); return { clickDelivered: true, strategy: 'test' }; },
    },
    FlowTiles: {
      collectNativeMedia: () => [],
      emitFlowProgress: () => {},
      armNativeFlowCorrelation: async () => {
        correlation.set(attemptId, { requestSeen: true, armedAt: Date.now(), interfered: false });
        return attemptId;
      },
      nativeFlowCorrelationMap: () => correlation,
    },
    ProviderRegistry: { describeUrl: () => ({ projectId: 'project-1' }) },
    FlowSettings: {},
    flowButton: () => null,
    scrollContainer: () => ({ scrollTop: 0 }),
    clearExistingIngredientChips: async () => ({ remaining: 0 }),
    checkFlowCreditLimitAlert: () => null,
    flowError: (code, message, retryable, outcome_unknown) => Object.assign(new Error(message), { code, retryable, outcome_unknown }),
    location: { href: 'https://flow.google.com/project/project-1' },
  });
  vm.runInContext(generationOperationsSource, context);
  const driver = { error: (code, message, retryable, outcome_unknown) => Object.assign(new Error(message), { code, retryable, outcome_unknown }) };
  const operations = new context.FlowGenerationOperations(driver);
  return {
    events,
    submit: () => operations.execute('flow.generation.submit', {
      type: 'image',
      prompt: 'A studio portrait',
      attachments: [{ transferId, name: 'local-ref.png', type: 'image/png', size: 20 }],
      model: 'Nano Banana',
      aspectRatio: '1:1',
      variants: 1,
    }),
  };
}

test('local-reference generation closes the upload popup before attaching the reference and submitting', async () => {
  const fixture = localUploadGenerationHarness();
  const result = await fixture.submit();
  assert.equal(result.submitted, true);
  assert.ok(fixture.events.indexOf('upload-complete') < fixture.events.indexOf('popup-cleanup'));
  assert.ok(fixture.events.indexOf('popup-cleanup') < fixture.events.indexOf('attach-reference'));
  assert.ok(fixture.events.indexOf('attach-reference') < fixture.events.indexOf('prompt-entered'));
  assert.ok(fixture.events.indexOf('prompt-entered') < fixture.events.indexOf('submit'));
});

test('local-reference generation stops before attaching or submitting if the upload popup cannot close', async () => {
  const fixture = localUploadGenerationHarness({ failPopupCleanup: true });
  await assert.rejects(fixture.submit(), error => error.code === 'FLOW_BLOCKING_OVERLAY_UNRESOLVED');
  assert.ok(fixture.events.includes('upload-complete'));
  assert.ok(fixture.events.includes('popup-cleanup'));
  assert.equal(fixture.events.includes('attach-reference'), false);
  assert.equal(fixture.events.includes('prompt-entered'), false);
  assert.equal(fixture.events.includes('submit'), false);
});
function harness({ names = ['MCP Test Mug'], addedKind = 'character', hideAttached = false, openInitially = true, afterOpenSurface = 'listbox', ambiguousSurface = false, menuTransitionMs = 0, closeDelayMs = 0, characterUuid = '22222222-2222-4222-8222-222222222222' } = {}) {
  let open = openInitially, ticks = 0;
  let pendingCloseAt = null;
  const attached = [];
  let clicks = 0;
  let addToPromptClicks = 0;
  const image = src => ({ alt: addedKind === 'character' ? 'Character ingredient image' : 'Image ingredient image', getAttribute: () => src });
  const attachChip = () => attached.push({ querySelector: () => image('https://flow.google.com/asb/portrait=s512-rw'), closest: () => addedKind === 'character' ? {} : null });
  const option = name => ({ name, getAttribute: key => key === 'data-character-id' ? characterUuid : null, querySelector: selector => selector === '[data-character-id]' && characterUuid ? { getAttribute: () => characterUuid } : null, querySelectorAll: () => [], click() {
    clicks++;
    if (addedKind === 'character') {
      open = false;
      if (hideAttached) entries.splice(0, entries.length);
      attachChip();
    }
  } });
  const entries = names.map(option);
  const list = { clientHeight: 100, scrollHeight: 100, scrollTop: 0, getAttribute: name => name === 'role' ? 'listbox' : null, querySelectorAll: selector => selector === '[role="option"]' ? entries : [], closest: () => null };
  const surfaceState = { value: openInitially ? 'listbox' : 'closed' };
  const menuItem = { name: 'Characters', getAttribute: key => key === 'role' ? 'menuitem' : null, querySelectorAll: () => [], innerText: 'Characters' };
  const menu = { tagName: 'DIV', getAttribute: key => key === 'role' ? 'menu' : null, querySelectorAll: selector => selector === 'button,[role="button"],[role="menuitem"],[role="option"],mat-option' ? [menuItem] : [], innerText: 'Characters' };
  const dialog = { tagName: 'DIV', getAttribute: key => key === 'role' ? 'dialog' : null, querySelectorAll: () => [], innerText: 'Choose a character' };
  const tab = { name: 'Characters', getAttribute: () => 'true' };
  const tile = { getAttribute: key => key === 'aria-label' ? 'MCP Test Mug' : key === 'data-character-id' ? characterUuid : null, querySelector: selector => selector === 'flow-character-tile' ? (addedKind === 'character' ? {} : null) : image('https://flow-content.google/image/different-thumbnail') };
  const opener = { getAttribute: () => open ? 'true' : 'false', click: () => {
    if (open && closeDelayMs > 0) pendingCloseAt = ticks + closeDelayMs;
    else { open = !open; surfaceState.value = open ? afterOpenSurface : 'closed'; }
  } };
  const submit = {};
  const editor = { isContentEditable: true, parentElement: null };
  const composer = { tagName: 'DIV', className: 'flow-composer', contains: node => node === editor || node === submit || node === opener,
    querySelectorAll: selector => selector === 'button,[role="button"],mat-button,[tabindex="0"]' ? [opener] : [] };
  editor.parentElement = composer;
  const document = { body: { innerText: '' },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || (selector.includes('.ProseMirror') ? editor : null); },
    querySelectorAll(selector) {
    if (selector === '[role="listbox"]') return open && surfaceState.value === 'listbox' ? [list] : [];
    if (selector === '[role="dialog"],[role="menu"],[role="listbox"],mat-menu,mat-select-panel') {
      if (!open || surfaceState.value === 'closed') return [];
      if (surfaceState.value === 'menu') return ambiguousSurface ? [menu, dialog] : [menu];
      if (surfaceState.value === 'dialog') return [dialog];
      return [list];
    }
    if (selector === '[role="progressbar"]') return [];
    if (selector === '[role="tab"]') return [{ name: 'All', getAttribute: () => 'true' }, tab];
    if (selector === 'button[aria-label="Ingredient"]') return attached;
    if (selector === 'flow-grid-tile-container') return [tile];
    return [];
  } };
  const context = vm.createContext({ document, location: { href: 'https://flow.google.com/project/test', pathname: '/project/test' }, Date: class MockDate extends Date { static now() { return ticks; } }, visible: () => true,
    mediaId: () => '33333333-3333-4333-8333-333333333333',
    FlowEditor: { getFlowSubmitButton: () => submit },
    accessibleName: el => el.name || '', flowButton: name => name === 'Add ingredients to the prompt box' ? opener : name === 'Add to prompt' && addedKind === 'image' ? { disabled: false, click() { addToPromptClicks++; open = false; attachChip(); } } : null,
    wait: async ms => {
      ticks += ms;
      if (pendingCloseAt !== null && ticks >= pendingCloseAt) { open = false; surfaceState.value = 'closed'; pendingCloseAt = null; }
      if (open && surfaceState.value === 'menu' && menuTransitionMs > 0 && ticks >= menuTransitionMs) surfaceState.value = 'listbox';
    }, flowError: (code, message, retryable, outcome_unknown) => Object.assign(new Error(message), { code, retryable, outcome_unknown }),
  });
  vm.runInContext(source, context);
  return { api: context.FlowReferenceActions, clicks: () => clicks, addToPromptClicks: () => addToPromptClicks,
    attachedCount: () => attached.length, pickerOpen: () => open };
}

function referencePickerHarness({ pages = [['Old asset']], uploadsPages = null, mediaIds = {}, locale = 'vi', searchPlaceholder = '', searchUpdates = true, stuck = false, decoySearch = false, parentScroll = false, ambiguousScroll = false, outsideScroller = false, viewportHeight = 100, scrollHeightOverride = null } = {}) {
  let tick = 0, scrollTop = 0, pickerOpen = true, clicks = 0, activeCategory = 'all';
  const activePages = () => activeCategory === 'uploads' && uploadsPages ? uploadsPages : pages;
  let searchText = '';
  const attached = [];
  const makeOption = (name, position) => {
    const tile = { getAttribute: key => key === 'aria-label' ? name : null, querySelector: () => null };
    return {
      name,
      id: `option-${position}`,
      getAttribute: key => key === 'aria-posinset' ? String(position) : key === 'aria-label' ? name : null,
      querySelector: selector => selector === 'flow-grid-tile-container' ? tile : null,
      querySelectorAll: () => [],
      click() { clicks++; },
    };
  };
  const visiblePage = () => {
    const current = activePages();
    const page = Math.min(current.length - 1, Math.ceil(scrollTop / 80));
    return current[page].map((name, index) => makeOption(name, page * 10 + index + 1));
  };
  const scroller = {
    style: { overflowY: 'auto' },
    clientHeight: viewportHeight,
    get scrollHeight() {
      if (searchText && searchUpdates && tick >= 500) return 100;
      return scrollHeightOverride ?? Math.max(viewportHeight, activePages().length * 100);
    },
    get scrollTop() { return scrollTop; },
    set scrollTop(value) { if (!stuck) scrollTop = value; },
  };
  const list = {
    clientHeight: viewportHeight,
    scrollTop: 0,
    get scrollHeight() { return parentScroll ? viewportHeight : scroller.scrollHeight; },
    getAttribute: key => key === 'role' ? 'listbox' : null,
    querySelectorAll(selector) {
      if (selector === '[role="option"]') {
        if (searchText && searchUpdates && tick >= 500) {
          const all = activePages().flat();
          const filtered = all.filter(name => name.toLowerCase().includes(searchText.toLowerCase()));
          return filtered.map((name, index) => makeOption(name, index + 1));
        }
        return visiblePage();
      }
      if (selector === '*') return outsideScroller ? [] : parentScroll ? (ambiguousScroll ? [scroller] : []) : [scroller];
      return [];
    },
    closest: () => null,
  };
  const input = searchPlaceholder ? {
    placeholder: searchPlaceholder,
    isContentEditable: true,
    focus() {},
    set textContent(value) { searchText = String(value); },
    get textContent() { return searchText; },
    get innerText() { return searchText; },
    dispatchEvent() {},
  } : null;
  const tab = { name: 'Tất cả', getAttribute: key => key === 'aria-selected' ? String(activeCategory === 'all') : null };
  const uploadsTab = uploadsPages ? { name: 'Tải lên', getAttribute: key => key === 'aria-selected' ? String(activeCategory === 'uploads') : null,
    click() { activeCategory = 'uploads'; scrollTop = 0; } } : null;
  tab.click = () => { activeCategory = 'all'; scrollTop = 0; };
  const owner = { parentElement: null,
    style: { overflowY: parentScroll ? 'auto' : '' },
    get clientHeight() { return parentScroll ? viewportHeight : 0; },
    get scrollHeight() { return parentScroll ? (scrollHeightOverride ?? Math.max(viewportHeight, pages.length * 100)) : 0; },
    get scrollTop() { return parentScroll ? scrollTop : undefined; },
    set scrollTop(value) { if (parentScroll && !stuck) scrollTop = value; },
    querySelectorAll(selector) { return selector === 'input,[role="textbox"]' ? (input ? [input] : []) : []; } };
  list.parentElement = owner;
  const decoy = decoySearch ? { placeholder: 'Search assets', isContentEditable: true, textContent: '', innerText: '', dispatchEvent() {} } : null;
  const document = {
    documentElement: { lang: locale },
    body: { innerText: '' },
    querySelectorAll(selector) {
      if (selector === '[role="listbox"]') return pickerOpen ? [list] : [];
      if (selector === '[role="tab"]') return [tab, uploadsTab].filter(Boolean);
      if (selector === '[role="progressbar"],[aria-busy="true"]') return [];
      if (selector === 'button[aria-label="Ingredient"]') return attached;
      if (selector === 'flow-grid-tile-container') return [];
      if (selector === 'input,[role="textbox"]') return [input, decoy].filter(Boolean);
      if (selector === '[role="dialog"],[role="menu"],[role="listbox"],mat-menu,mat-select-panel') return pickerOpen ? [list] : [];
      if (selector === '*') return outsideScroller ? [scroller] : [];
      return [];
    },
  };
  const context = vm.createContext({
    document,
    location: { href: `https://flow.google.com/project/test?hl=${locale}`, pathname: '/project/test' },
    Date: class MockDate extends Date { static now() { return tick; } },
    visible: () => true,
    setEditable: (element, value) => { element.textContent = value; },
    mediaId: tile => tile?.getAttribute?.('aria-label') ?
      (mediaIds[`${activeCategory}:${tile.getAttribute('aria-label')}`] || mediaIds[tile.getAttribute('aria-label')] || '22222222-2222-4222-8222-222222222222') : undefined,
    accessibleName: el => el.name || el.getAttribute?.('aria-label') || '',
    flowButton: name => name === 'Add to prompt' ? { disabled: false, click() {
      pickerOpen = false;
      attached.push({ getAttribute: key => key === 'aria-label' ? 'Ingredient' : null, querySelector: () => ({ alt: 'Image ingredient image', getAttribute: () => 'https://flow.google.com/asb/image' }), closest: () => null });
    } } : null,
    wait: async ms => { tick += ms; },
    flowError: (code, message, retryable, outcome_unknown) => Object.assign(new Error(message), { code, retryable, outcome_unknown }),
  });
  vm.runInContext(source, context);
  return { api: context.FlowReferenceActions, clicks: () => clicks, diagnostics: () => context.FlowReferenceActions.inspectDiagnostics() };
}

test('Vietnamese reference picker finds an exact asset after bounded scrolling without a recognized search control', async () => {
  const name = 'fm-a6f6c32f9203-upload.png';
  const fixture = referencePickerHarness({ pages: [['Earlier image'], [name]], locale: 'vi' });
  const result = await fixture.api.attach(name);
  assert.equal(result.confirmed, true);
  assert.equal(fixture.clicks(), 1);
  const diagnostics = fixture.diagnostics();
  assert.equal(diagnostics.locale, 'vi');
  assert.equal(diagnostics.searchLabelRecognized, false);
  assert.equal(diagnostics.pickerScanEndReached, true);
  assert.equal(diagnostics.activeCategory, 'all');
  assert.equal(diagnostics.categorySelected, true);
  assert.equal(diagnostics.exactTargetFound, true);
  assert.ok(diagnostics.optionLabelHashes.length > 0);
  assert.ok(diagnostics.pickerScanPages >= 2);
});

test('UUID-bound image reference scans the discoverable Uploads category after All misses', async () => {
  const name = 'uploaded-only.png';
  const expectedId = 'b5d304ab-eeb8-4001-8110-86a225761c0f';
  const fixture = referencePickerHarness({ pages: [[name]], uploadsPages: [[name]], mediaIds: {
    [`all:${name}`]: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', [`uploads:${name}`]: expectedId,
  } });
  const result = await fixture.api.attach({ assetName: name, kind: 'image' }, undefined, { expectedId });
  assert.equal(result.confirmed, true);
  assert.equal(result.id, expectedId);
  assert.equal(fixture.clicks(), 1);
  const diagnostics = fixture.diagnostics();
  assert.equal(diagnostics.activeCategory, 'uploads');
  assert.deepEqual(Array.from(diagnostics.categoriesScanned), ['all', 'uploads']);
  assert.equal(diagnostics.exactTargetFound, true);
  assert.equal(diagnostics.pickerScanEndReached, true);
});

test('UUID-bound image reference fails closed after complete scans of discoverable categories miss', async () => {
  const expectedId = 'b5d304ab-eeb8-4001-8110-86a225761c0f';
  const fixture = referencePickerHarness({ pages: [['Other image']], uploadsPages: [['Another image']] });
  await assert.rejects(fixture.api.attach({ assetName: 'Missing image', kind: 'image' }, undefined, { expectedId }), error =>
    error.code === 'FLOW_ASSET_NOT_FOUND' && error.diagnostics?.endReached === true &&
      JSON.stringify(error.diagnostics?.categoriesScanned) === JSON.stringify(['all', 'uploads']));
  assert.equal(fixture.clicks(), 0);
});

test('UUID-bound image reference does not assume an Uploads category when no matching visible tab exists', async () => {
  const expectedId = 'b5d304ab-eeb8-4001-8110-86a225761c0f';
  const fixture = referencePickerHarness({ pages: [['Other image']] });
  await assert.rejects(fixture.api.attach({ assetName: 'Missing image', kind: 'image' }, undefined, { expectedId }), error =>
    error.code === 'FLOW_ASSET_NOT_FOUND' && error.diagnostics?.endReached === true &&
      JSON.stringify(error.diagnostics?.categoriesScanned) === JSON.stringify(['all']));
  assert.equal(fixture.clicks(), 0);
});

test('reference search recognizes a Vietnamese search label and waits for matching results', async () => {
  const name = 'fm-a6f6c32f9203-upload.png';
  const fixture = referencePickerHarness({ pages: [['Earlier image'], [name]], locale: 'vi', searchPlaceholder: 'Tìm kiếm nội dung nghe nhìn' });
  const result = await fixture.api.attach(name);
  assert.equal(result.confirmed, true);
  assert.equal(fixture.diagnostics().searchLabelRecognized, true);
  assert.equal(fixture.diagnostics().searchLabel, 'tìm kiếm nội dung nghe nhìn');
});

test('reference search never types into a recognized global decoy outside the picker', async () => {
  const name = 'Requested image';
  const fixture = referencePickerHarness({ pages: [['Earlier image'], [name]], decoySearch: true });
  const result = await fixture.api.attach(name);
  assert.equal(result.confirmed, true);
  assert.equal(fixture.clicks(), 1);
  assert.equal(fixture.diagnostics().searchLabelRecognized, false);
  assert.equal(fixture.diagnostics().pickerScanEndReached, true);
});

test('reference picker clears verified stale search results and scans the full list before selecting', async () => {
  const name = 'Requested image';
  const fixture = referencePickerHarness({ pages: [['Old result'], [name]], searchPlaceholder: 'Search assets', searchUpdates: false });
  const result = await fixture.api.attach(name);
  assert.equal(result.confirmed, true);
  assert.equal(fixture.clicks(), 1);
  assert.equal(fixture.diagnostics().searchLabelRecognized, true);
  assert.equal(fixture.diagnostics().searchResultsVerified, false);
  assert.equal(fixture.diagnostics().pickerScanEndReached, true);
  assert.ok(fixture.diagnostics().pickerScanPages >= 2);
});

test('reference picker rejects duplicate exact titles found on separate pages', async () => {
  const name = 'Duplicate image';
  const fixture = referencePickerHarness({ pages: [[name], [name]], searchUpdates: false });
  await assert.rejects(fixture.api.attach(name), error => error.code === 'FLOW_ASSET_AMBIGUOUS' && error.diagnostics?.endReached === true);
  assert.equal(fixture.clicks(), 0);
});

test('reference picker fails closed when its virtualized list cannot advance to a proven end', async () => {
  const fixture = referencePickerHarness({ pages: [['Visible image'], ['Target image']], stuck: true, searchUpdates: false, parentScroll: true });
  await assert.rejects(fixture.api.attach('Target image'), error =>
    error.code === 'FLOW_REFERENCE_SCAN_INCOMPLETE' && error.diagnostics?.endReached === false && error.diagnostics?.pages === 1 &&
      error.diagnostics?.activeCategory === 'all' && error.diagnostics?.categorySelected === true &&
      error.diagnostics?.searchLabelRecognized === false && error.diagnostics?.searchResultsVerified === false &&
      error.diagnostics?.scrollOwnerCount === 1 && error.diagnostics?.scrollOwnerDepth === -1 &&
      error.diagnostics?.scrollClientHeight === 100 && error.diagnostics?.scrollHeight === 200 && error.diagnostics?.scrollTop === 0);
  assert.equal(fixture.clicks(), 0);
});

test('reference scanner accepts a verified 13px final scroll to bottom when visible options do not change', async () => {
  const fixture = referencePickerHarness({
    pages: [['Exact target']], viewportHeight: 515, scrollHeightOverride: 528, searchUpdates: false,
  });
  const result = await fixture.api.attach('Exact target');
  assert.equal(result.confirmed, true);
  assert.equal(fixture.clicks(), 1);
  const diagnostics = fixture.diagnostics();
  assert.equal(diagnostics.scrollOwnerCount, 1);
  assert.equal(diagnostics.scrollOwnerDepth, 1);
  assert.equal(diagnostics.scrollClientHeight, 515);
  assert.equal(diagnostics.scrollHeight, 528);
  assert.equal(diagnostics.scrollTop, 13);
  assert.equal(diagnostics.pickerScanPages, 1);
  assert.equal(diagnostics.pickerScanEndReached, true);
});

test('reference scanner still fails closed when the selected owner cannot move to its bottom', async () => {
  const fixture = referencePickerHarness({
    pages: [['Exact target'], ['Hidden target']], viewportHeight: 515, scrollHeightOverride: 528,
    searchUpdates: false, stuck: true,
  });
  await assert.rejects(fixture.api.attach('Hidden target'), error =>
    error.code === 'FLOW_REFERENCE_SCAN_INCOMPLETE' && error.diagnostics?.endReached === false &&
      error.diagnostics?.scrollOwnerCount === 1 && error.diagnostics?.scrollClientHeight === 515 &&
      error.diagnostics?.scrollHeight === 528 && error.diagnostics?.scrollTop === 0);
  assert.equal(fixture.clicks(), 0);
});

test('reference scanner uses the unique scroll owner in a parent wrapper', async () => {
  const name = 'Parent viewport target';
  const fixture = referencePickerHarness({ pages: [['Earlier image'], [name]], parentScroll: true });
  const result = await fixture.api.attach(name);
  assert.equal(result.confirmed, true);
  const diagnostics = fixture.diagnostics();
  assert.equal(diagnostics.activeCategory, 'all');
  assert.equal(diagnostics.scrollOwnerCount, 1);
  assert.equal(diagnostics.scrollOwnerDepth, -1);
  assert.equal(diagnostics.scrollClientHeight, 100);
  assert.equal(diagnostics.scrollHeight, 200);
  assert.equal(diagnostics.exactTargetFound, true);
});

test('reference scanner rejects multiple plausible scroll owners', async () => {
  const fixture = referencePickerHarness({ pages: [['Earlier image'], ['Target image']], parentScroll: true, ambiguousScroll: true });
  await assert.rejects(fixture.api.attach('Target image'), error =>
    error.code === 'FLOW_REFERENCE_SCAN_SCROLL_OWNER_AMBIGUOUS' && error.diagnostics?.scrollOwnerCount === 2);
  assert.equal(fixture.clicks(), 0);
});

test('reference scanner ignores a global-only scroll decoy and fails closed without a picker owner', async () => {
  const fixture = referencePickerHarness({ pages: [['Earlier image'], ['Target image']], outsideScroller: true });
  await assert.rejects(fixture.api.attach('Target image'), error =>
    error.code === 'FLOW_REFERENCE_SCAN_SCROLL_OWNER_MISSING' && error.diagnostics?.scrollOwnerCount === 0);
  assert.equal(fixture.clicks(), 0);
});

function uploadedTileMenuHarness({ preexistingMenu = false, multipleNewMenus = false, noNewMenu = false, chipIdentity = 'matching', leaveOwnedMenuOpen = false, openUnrelatedAfterAction = false, relation = true, farMenu = false, farMenuClose = false, actionText = 'Add to prompt', accessibleActionLabel = null, nestedChipControls = false, broadConfiguredButtons = false, addChipCount = 1 } = {}) {
  const mediaUuid = '22222222-2222-4222-8222-222222222222';
  const chips = [];
  let activeMediaUuid = mediaUuid;
  let activeTileName = 'Uploaded exact.png';
  const menuStates = [];
  const logs = [];
  let contextEvents = 0, actionClicks = 0, closeClicks = 0, unrelatedKeyEvents = 0;
  const controlsForChip = chip => chip.controls || [chip];
  const allChipControls = () => chips.flatMap(controlsForChip);
  const unrelatedControl = { tagName: 'BUTTON', innerText: 'Settings', textContent: 'Settings', getAttribute: key => key === 'aria-label' ? 'Open settings' : null, querySelector: () => null, closest: () => null };
  const unrelatedAfterClick = { tagName: 'BUTTON', innerText: 'Favorite', textContent: 'Favorite', getAttribute: key => key === 'aria-label' ? 'Favorite' : null, querySelector: () => null, closest: () => null };
  const target = { id: 'media-trigger', getBoundingClientRect: () => ({ left: 100, top: 100, width: 20, height: 20 }), dispatchEvent(event) {
    if (event.type !== 'contextmenu') return;
    contextEvents++;
    if (noNewMenu) return;
    const count = multipleNewMenus ? 2 : 1;
    for (let index = 0; index < count; index++) menuStates.push({ open: true, owned: true });
  } };
  const makeMenu = state => {
    const action = { tagName: 'BUTTON', disabled: false, innerText: actionText, textContent: actionText, getAttribute: key => key === 'role' ? 'menuitem' : key === 'aria-label' ? accessibleActionLabel : null, click() {
      actionClicks++;
      const id = chipIdentity === 'mismatched' ? '33333333-3333-4333-8333-333333333333' : chipIdentity === 'matching' ? activeMediaUuid : null;
      for (let index = 0; index < addChipCount; index++) {
        const image = { alt: 'Image ingredient image', getAttribute: key => key === 'data-media-id' ? id : key === 'src' ? `https://flow-content.google/image/${id || index}` : null };
        const owner = { tagName: 'DIV', getAttribute: key => key === 'data-kind' ? 'image' : null,
          querySelectorAll: selector => /img|role='img'/.test(selector) ? [image] : [] };
        const makeControl = withImage => ({ tagName: 'BUTTON', innerText: 'Ingredient', textContent: 'Ingredient',
          getAttribute: key => key === 'aria-label' ? 'Ingredient' : key === 'role' ? 'button' : null,
          querySelector: selector => withImage && /img/.test(selector) ? image : null,
          closest: selector => selector.includes("[data-kind='image']") ? owner : null });
        const mainControl = makeControl(true);
        if (nestedChipControls) mainControl.controls = [mainControl, makeControl(false)];
        chips.push(mainControl);
      }
      if (!leaveOwnedMenuOpen) state.open = false;
      if (openUnrelatedAfterAction) unrelatedState.open = true;
    } };
    const closeAction = { tagName: 'BUTTON', disabled: false, innerText: 'Close', textContent: 'Close', getAttribute: key => key === 'role' ? 'menuitem' : null, click() { closeClicks++; state.open = false; } };
    return { tagName: 'DIV', id: `owned-menu-${menuStates.indexOf(state)}`, isConnected: true,
      getAttribute: key => key === 'role' ? 'menu' : key === 'aria-labelledby' && relation ? target.id : null,
      getBoundingClientRect: () => farMenu ? { left: 400, top: 110, width: 120, height: 80, right: 520, bottom: 190 } : { left: 110, top: 110, width: 120, height: 80, right: 230, bottom: 190 },
      querySelectorAll: selector => /menuitem|button|radix-collection/.test(selector) ? (farMenuClose ? [action, closeAction] : [action]) : [],
      dispatchEvent(event) { if (state.owned && event.key === 'Escape') state.open = false; else unrelatedKeyEvents++; } };
  };
  const unrelatedState = { open: preexistingMenu, owned: false };
  const unrelatedMenu = makeMenu(unrelatedState);
  const menuObjects = new WeakMap();
  const menuFor = state => { if (!menuObjects.has(state)) menuObjects.set(state, makeMenu(state)); return menuObjects.get(state); };
  const tile = { isConnected: true, getAttribute: key => key === 'aria-label' ? activeTileName : null,
    querySelector: selector => selector === 'flow-video-tile,flow-scene-tile' ? null : selector === 'img,[role=\'img\']' ? target : null,
    scrollIntoView() {} };
  const document = { body: { innerText: '' }, querySelectorAll(selector) {
    if (selector === 'flow-grid-tile-container') return [tile];
    if (selector === '[role="menu"],mat-menu-panel') return [...(unrelatedState.open ? [unrelatedMenu] : []), ...menuStates.filter(state => state.open).map(menuFor)];
    if (selector === '[role="dialog"],[role="menu"],[role="listbox"],mat-menu,mat-select-panel') return this.querySelectorAll('[role="menu"],mat-menu-panel');
    if (selector === '[role="listbox"]' || selector === '[role="progressbar"]' || selector === '[role="tab"]') return [];
    if (selector === 'button[aria-label="Ingredient"]') return allChipControls();
    if (selector === 'button,[role="button"]') return allChipControls();
    return [];
  }, querySelector() { return null; }, activeElement: null, dispatchEvent(event) { if (event.key === 'Escape') unrelatedKeyEvents++; } };
  const context = vm.createContext({ document, location: { pathname: '/project/test' }, Date,
    MouseEvent: class { constructor(type, options) { this.type = type; Object.assign(this, options); } },
    KeyboardEvent: class { constructor(type, options) { this.type = type; Object.assign(this, options); } },
    window: { innerWidth: 1280, innerHeight: 800 },
    console: { error: (...args) => logs.push(args), warn() {}, info() {}, log() {}, debug() {} },
    visible: el => [actionText, 'Add to prompt', 'Ingredient'].includes(el?.innerText) || (broadConfiguredButtons && [unrelatedControl, unrelatedAfterClick].includes(el)) || (el === unrelatedMenu ? unrelatedState.open : menuStates.some(state => state.open && menuFor(state) === el)),
    ...(broadConfiguredButtons ? { flowQueryAll: (path, scope) => {
      if (['components.chips', 'common.buttons'].includes(path) && scope === document) return [...allChipControls(), unrelatedControl, ...(actionClicks ? [unrelatedAfterClick] : [])];
      if (path === 'components.actionMenus' && scope === document) return [...(unrelatedState.open ? [unrelatedMenu] : []), ...menuStates.filter(state => state.open).map(menuFor)];
      if (path === 'tiles.container' && scope === document) return [tile];
      if (path === 'tiles.image' && scope === tile) return [target];
      return [];
    } } : {}),
    mediaId: () => activeMediaUuid, findFlowTile: async title => title === activeTileName ? tile : null,
    accessibleName: el => el.getAttribute?.('aria-label') || el.innerText || '', wait: async () => {}, flowButton: () => null,
    flowError: (code, message, retryable, outcome_unknown) => Object.assign(new Error(message), { code, retryable, outcome_unknown }) });
  vm.runInContext(source, context);
  return { api: context.FlowReferenceActions, mediaUuid, contextEvents: () => contextEvents, actionClicks: () => actionClicks,
    closeClicks: () => closeClicks, chipCount: () => chips.length, setUploadTarget: (name, id) => { activeTileName = name; activeMediaUuid = id; },
    unrelatedOpen: () => unrelatedState.open, ownedOpen: () => menuStates.some(state => state.open), unrelatedKeyEvents: () => unrelatedKeyEvents, logs: () => logs };
}

test('character is confirmed by a new typed chip even when thumbnail and chip CDN URLs differ', async () => {
  const { api } = harness();
  const result = await api.attach('character:MCP Test Mug');
  assert.equal(result.confirmed, true);
  assert.equal(result.kind, 'character');
  assert.equal(result.name, 'MCP Test Mug');
  assert.equal(result.id, '22222222-2222-4222-8222-222222222222');
  assert.notEqual(result.id, '33333333-3333-4333-8333-333333333333');
});

test('character attach fails closed before clicking when no explicit character UUID is exposed', async () => {
  const { api, clicks } = harness({ characterUuid: null });
  await assert.rejects(api.attach('character:MCP Test Mug'), error =>
    error.code === 'FLOW_CHARACTER_ID_UNAVAILABLE' && error.outcome_unknown === false);
  assert.equal(clicks(), 0);
});

test('character list API normalization unwraps nested names and drops unsafe IDs', () => {
  const normalized = normalizeFlowCharacters([
    { name: { name: ' Untitled   character ' }, use_as: 'character:[object Object]', uuid: 'not-a-uuid' },
    { name: 'MCP Test Mug', id: '22222222-2222-4222-8222-222222222222' },
    { name: 'Ada', uuid: '33333333-3333-4333-8333-333333333333', id: '44444444-4444-4444-8444-444444444444' },
  ]);
  assert.deepEqual(normalized, [
    { name: 'Untitled character' },
    { name: 'MCP Test Mug' },
    { name: 'Ada', uuid: '33333333-3333-4333-8333-333333333333' },
  ]);
});

test('inspect-only reports an exact match without selecting or attaching and closes its owned picker', async () => {
  const { api, clicks, addToPromptClicks, attachedCount, pickerOpen } = harness({ addedKind: 'image', openInitially: false });
  const result = await api.inspectPicker('asset:MCP Test Mug');
  assert.equal(result.exact_match, true);
  assert.equal(result.selected, false);
  assert.equal(clicks(), 0);
  assert.equal(addToPromptClicks(), 0);
  assert.equal(attachedCount(), 0);
  assert.equal(pickerOpen(), false);
});

test('inspect-only refuses a pre-existing picker and leaves it open without selection', async () => {
  const { api, clicks, addToPromptClicks, attachedCount, pickerOpen } = harness({ addedKind: 'image', openInitially: true });
  await assert.rejects(api.inspectPicker('asset:MCP Test Mug'), error =>
    error.code === 'FLOW_REFERENCE_PICKER_ALREADY_OPEN' && error.outcome_unknown === false && /left it open/.test(error.message));
  assert.equal(clicks(), 0);
  assert.equal(addToPromptClicks(), 0);
  assert.equal(attachedCount(), 0);
  assert.equal(pickerOpen(), true);
});

test('a confirmed character is reused without clicking its option a second time', async () => {
  const { api, clicks } = harness({ hideAttached: true });
  await api.attach('character:MCP Test Mug');
  assert.equal((await api.attach('character:MCP Test Mug')).reused, true);
  assert.equal(clicks(), 1);
  assert.equal((await api.listCharacters())[0], 'MCP Test Mug');
});
test('an ordinary image chip cannot confirm an explicitly requested character', async () => {
  const { api } = harness({ addedKind: 'image' });
  await assert.rejects(api.attach('character:MCP Test Mug', undefined, { deadline: Date.now() + 350 }), error =>
    ['FLOW_REFERENCE_ATTACH_UNCONFIRMED', 'FLOW_OPERATION_TIMEOUT'].includes(error.code) && error.outcome_unknown === true);
});
test('an image reference is successful only after Flow adds its ingredient chip', async () => {
  const { api, clicks, addToPromptClicks } = harness({ addedKind: 'image' });
  const result = await api.attach('MCP Test Mug');
  assert.equal(clicks(), 1, 'the exact image option is clicked once');
  assert.equal(addToPromptClicks(), 1, 'Add to prompt is clicked once');
  assert.equal(result.confirmed, true);
  assert.equal(result.kind, 'image');
});

test('uploaded image attachment leaves an unrelated pre-existing menu untouched', async () => {
  const fixture = uploadedTileMenuHarness({ preexistingMenu: true });
  await assert.rejects(fixture.api.attach('Uploaded exact.png', undefined, { expectedId: fixture.mediaUuid, deadline: Date.now() + 1000 }), error => error.code === 'FLOW_REFERENCE_CONTEXT_MENU_BUSY');
  assert.equal(fixture.contextEvents(), 0);
  assert.equal(fixture.actionClicks(), 0);
  assert.equal(fixture.unrelatedOpen(), true);
  assert.equal(fixture.unrelatedKeyEvents(), 0);
});

test('uploaded image reuses Flow\'s open asset picker and confirms Add to prompt instead of treating its overlay as a menu', async () => {
  const mediaUuid = '22222222-2222-4222-8222-222222222222';
  const attached = [];
  let pickerOpen = true;
  let contextMenuEvents = 0;
  let optionClicks = 0;
  let addClicks = 0;
  let selected = false;
  const image = { alt: 'Image ingredient image', getAttribute: key => key === 'data-media-id' ? mediaUuid : key === 'src' ? 'https://flow.google.com/asb/uploaded-image' : null };
  const chipOwner = { tagName: 'DIV', getAttribute: key => key === 'data-kind' ? 'image' : null,
    querySelectorAll: selector => /img|role='img'/.test(selector) ? [image] : [] };
  const chip = { tagName: 'BUTTON', innerText: 'Ingredient', textContent: 'Ingredient',
    getAttribute: key => key === 'aria-label' ? 'Ingredient' : key === 'role' ? 'button' : null,
    querySelector: selector => /img/.test(selector) ? image : null,
    querySelectorAll: () => [], closest: selector => selector.includes("[data-kind='image']") ? chipOwner : null };
  const addButton = { tagName: 'BUTTON', innerText: 'Add to prompt', textContent: 'Add to prompt', disabled: false,
    getAttribute: key => key === 'role' ? 'button' : key === 'aria-label' ? 'Add to prompt' : null,
    querySelectorAll: () => [], getBoundingClientRect: () => ({ left: 10, top: 10, width: 100, height: 30 }),
    click() { addClicks++; pickerOpen = false; attached.push(chip); } };
  const allTab = { tagName: 'DIV', name: 'All', innerText: 'All', getAttribute: key => key === 'role' ? 'tab' : key === 'aria-label' ? 'All' : key === 'aria-selected' ? 'true' : null };
  const tile = { getAttribute: key => key === 'aria-label' ? 'Uploaded exact.png' : key === 'data-media-id' ? mediaUuid : null,
    querySelector: () => null, querySelectorAll: () => [], dispatchEvent(event) { if (event.type === 'contextmenu') contextMenuEvents++; } };
  const option = { id: 'uploaded-option', tagName: 'DIV', innerText: 'Uploaded exact.png', textContent: 'Uploaded exact.png',
    getAttribute: key => key === 'role' ? 'option' : key === 'aria-label' ? 'Uploaded exact.png' : key === 'aria-posinset' ? '1' : key === 'aria-selected' ? String(selected) : null,
    querySelector: selector => selector === 'flow-grid-tile-container' ? tile : null, querySelectorAll: () => [],
    click() { optionClicks++; selected = true; } };
  const dialog = { tagName: 'DIV', className: 'cdk-overlay-pane', innerText: 'Images Search assets Add to prompt',
    getAttribute: key => key === 'role' ? 'dialog' : null,
    querySelectorAll(selector) {
      if (selector.includes('button') || selector.includes('[role="button"]') || selector.includes('[role="tab"]')) return [allTab, addButton];
      if (selector === 'input,[role="textbox"]') return [];
      if (selector.includes('flow-grid-tile-container')) return [tile];
      return [];
    } };
  const list = { tagName: 'DIV', clientHeight: 100, scrollHeight: 100, scrollTop: 0, style: { overflowY: 'auto' },
    getAttribute: key => key === 'role' ? 'listbox' : null,
    querySelector: selector => selector.includes('flow-grid-tile-container') ? tile : null,
    querySelectorAll(selector) { return selector === '[role="option"]' ? [option] : []; },
    closest: selector => selector.includes('[role="dialog"]') ? dialog : null };
  const document = { documentElement: { lang: 'en' }, body: { innerText: '' },
    querySelector(selector) { return selector === '[role="dialog"], mat-dialog-container, flow-dialog, .cdk-overlay-pane' && pickerOpen ? dialog : null; },
    querySelectorAll(selector) {
      if (selector === '[role="listbox"]') return pickerOpen ? [list] : [];
      if (selector === '[role="tab"]') return pickerOpen ? [allTab] : [];
      if (selector === '[role="dialog"],[role="menu"],[role="listbox"],mat-menu,mat-select-panel') return pickerOpen ? [dialog, list] : [];
      if (selector === '[role="progressbar"],[aria-busy="true"]') return [];
      if (selector === 'flow-grid-tile-container') return pickerOpen ? [tile] : [];
      if (selector === 'button[aria-label="Ingredient"]') return attached;
      if (selector === 'button,[role="button"]') return [...attached, ...(pickerOpen ? [addButton] : [])];
      if (selector === '[role="menu"],mat-menu-panel') return [];
      if (selector === '.cdk-overlay-pane') return pickerOpen ? [dialog] : [];
      return [];
    } };
  const context = vm.createContext({ document, location: { href: 'https://flow.google.com/project/test', pathname: '/project/test' }, Date,
    visible: el => Boolean(el && (el === list || el === dialog || el === option || el === tile || el === allTab || el === addButton || attached.includes(el))),
    mediaId: item => item?.getAttribute?.('data-media-id') || mediaUuid,
    accessibleName: el => el?.getAttribute?.('aria-label') || el?.innerText || el?.name || '',
    findFlowTile: async () => tile,
    flowButton: name => name === 'Add to prompt' ? addButton : null,
    wait: async () => {},
    MouseEvent: class { constructor(type, options) { this.type = type; Object.assign(this, options); } },
    flowError: (code, message, retryable, outcome_unknown) => Object.assign(new Error(message), { code, retryable, outcome_unknown }) });
  vm.runInContext(source, context);
  const result = await context.FlowReferenceActions.attach('Uploaded exact.png', undefined, { expectedId: mediaUuid, deadline: Date.now() + 5000 });
  assert.equal(result.confirmed, true);
  assert.equal(result.id, mediaUuid);
  assert.equal(contextMenuEvents, 0, 'the open asset picker does not enter the tile context-menu path');
  assert.equal(optionClicks, 1, 'the exact uploaded image option is selected once');
  assert.equal(addClicks, 1, 'the picker footer Add to prompt action is activated once');
});

test('missing project-tile menu retries three times and retains tile-attempt evidence when picker fallback is unavailable', async () => {
  const fixture = uploadedTileMenuHarness({ noNewMenu: true });
  await assert.rejects(fixture.api.attach('Uploaded exact.png', undefined, { expectedId: fixture.mediaUuid, deadline: Date.now() + 5000 }), error =>
    error.code === 'FLOW_ASSET_PICKER_MISSING' && error.diagnostics?.tileActionAttempted === true &&
      error.diagnostics?.tileActionStep === 'menu_missing' && error.diagnostics?.tileActionMenuObserved === false);
  assert.equal(fixture.contextEvents(), 3);
  assert.equal(fixture.actionClicks(), 0);
  assert.equal(fixture.chipCount(), 0);
});

test('uploaded image attachment rejects multiple newly opened menus', async () => {
  const fixture = uploadedTileMenuHarness({ multipleNewMenus: true });
  await assert.rejects(fixture.api.attach('Uploaded exact.png', undefined, { expectedId: fixture.mediaUuid, deadline: Date.now() + 1000 }), error => error.code === 'FLOW_REFERENCE_CONTEXT_MENU_AMBIGUOUS');
  assert.equal(fixture.contextEvents(), 1);
  assert.equal(fixture.actionClicks(), 0);
  assert.equal(fixture.chipCount(), 0);
});

test('uploaded image attachment uses the unique newly visible Add to prompt menu without requiring ARIA ancestry', async () => {
  const fixture = uploadedTileMenuHarness({ relation: false });
  const result = await fixture.api.attach('Uploaded exact.png', undefined, { expectedId: fixture.mediaUuid, deadline: Date.now() + 1000 });
  assert.equal(result.confirmed, true);
  assert.equal(fixture.contextEvents(), 1);
  assert.equal(fixture.actionClicks(), 1);
  assert.equal(fixture.chipCount(), 1);
  assert.equal(fixture.ownedOpen(), false);
});

test('generic configured buttons and controls appearing beside a reference are not counted as chips', async () => {
  const fixture = uploadedTileMenuHarness({ broadConfiguredButtons: true });
  const result = await fixture.api.attach('Uploaded exact.png', undefined, { expectedId: fixture.mediaUuid, deadline: Date.now() + 1500 });
  assert.equal(result.confirmed, true);
  assert.equal(fixture.actionClicks(), 1);
  assert.equal(fixture.api.inspectDiagnostics().chipCount, 1);
});

test('multiple DOM controls inside one explicitly marked image chip count as one reference', async () => {
  const fixture = uploadedTileMenuHarness({ nestedChipControls: true });
  const result = await fixture.api.attach('Uploaded exact.png', undefined, { expectedId: fixture.mediaUuid, deadline: Date.now() + 1500 });
  assert.equal(result.confirmed, true);
  assert.equal(fixture.api.inspectDiagnostics().chipCount, 1);
  assert.equal(fixture.api.inspectDiagnostics().chipAttachScan.confirmationMode, 'identity_delta');
});

test('two uploaded image references are attached and confirmed sequentially', async () => {
  const fixture = uploadedTileMenuHarness();
  const first = await fixture.api.attach('Uploaded exact.png', undefined, { expectedId: fixture.mediaUuid, deadline: Date.now() + 1500 });
  fixture.setUploadTarget('Uploaded second.png', '33333333-3333-4333-8333-333333333333');
  const second = await fixture.api.attach('Uploaded second.png', undefined, { expectedId: '33333333-3333-4333-8333-333333333333', deadline: Date.now() + 1500 });
  assert.equal(first.confirmed, true);
  assert.equal(second.confirmed, true);
  assert.equal(fixture.actionClicks(), 2);
  assert.equal(fixture.chipCount(), 2);
  assert.equal(fixture.api.inspectDiagnostics().chipCount, 2);
});

test('unexpected multiple reference chips leave bounded before/after diagnostics for agent triage', async () => {
  const fixture = uploadedTileMenuHarness({ addChipCount: 2 });
  await assert.rejects(fixture.api.attach('Uploaded exact.png', undefined, { expectedId: fixture.mediaUuid, deadline: Date.now() + 1500 }), error =>
    error.code === 'FLOW_REFERENCE_ATTACH_AMBIGUOUS' && error.diagnostics?.chipAttachScan?.beforeCount === 0 &&
      error.diagnostics.chipAttachScan.afterCount === 2 && /changed from 0 to 2 reference chip\(s\).*delta 2/.test(error.message));
  const diagnostics = fixture.api.inspectDiagnostics().chipAttachScan;
  assert.equal(diagnostics.stage, 'stable_unexpected_chip_count');
  assert.equal(diagnostics.deltaKinds.length, 2);
  assert.equal(fixture.logs().length, 1);
  assert.match(fixture.logs()[0][0], /image reference chip delta failed/);
});

test('uploaded image action detection uses rendered menu text when the accessible name is only the add icon', async () => {
  const fixture = uploadedTileMenuHarness({ accessibleActionLabel: 'add' });
  const result = await fixture.api.attach('Uploaded exact.png', undefined, { expectedId: fixture.mediaUuid, deadline: Date.now() + 1500 });
  assert.equal(result.confirmed, true);
  assert.equal(fixture.actionClicks(), 1);
  const scan = fixture.api.inspectDiagnostics().menuActionScan;
  assert.equal(scan.matchCount, 1);
  assert.equal(scan.items[0].visibleText, 'Add to prompt');
  assert.equal(scan.items[0].accessibleName, 'add');
  assert.equal(scan.items[0].matchSource, 'innerText');
});

test('uploaded image action detection accepts Vietnamese and unaccented Vietnamese menu labels', async () => {
  for (const actionText of ['Thêm vào lời nhắc', 'Them vao loi nhac']) {
    const fixture = uploadedTileMenuHarness({ actionText, accessibleActionLabel: 'add' });
    const result = await fixture.api.attach('Uploaded exact.png', undefined, { expectedId: fixture.mediaUuid, deadline: Date.now() + 1500 });
    assert.equal(result.confirmed, true, `${actionText} should be recognized as Add to prompt`);
    assert.equal(fixture.actionClicks(), 1);
    assert.equal(fixture.api.inspectDiagnostics().menuActionScan.items[0].matchSource, 'innerText');
  }
});

test('uploaded image action failure includes menu item evidence in diagnostics and console log', async () => {
  const fixture = uploadedTileMenuHarness({ actionText: 'Save image', accessibleActionLabel: 'add' });
  await assert.rejects(fixture.api.attach('Uploaded exact.png', undefined, { expectedId: fixture.mediaUuid, deadline: Date.now() + 1500 }), error =>
    error.code === 'FLOW_REFERENCE_CONTEXT_ACTION_MISSING' && error.diagnostics?.menuActionScan?.itemCount === 1 &&
      error.diagnostics.menuActionScan.items[0].visibleText === 'Save image' && error.message.includes('text="Save image"'));
  const scan = fixture.api.inspectDiagnostics().menuActionScan;
  assert.equal(scan.matchCount, 0);
  assert.equal(scan.items[0].accessibleName, 'add');
  assert.equal(fixture.logs().length, 1);
  assert.match(fixture.logs()[0][0], /Add-to-prompt menu action scan failed/);
  assert.match(fixture.logs()[0][1], /Save image/);
});

test('uploaded image attachment uses the unique newly visible Add to prompt menu at the viewport edge', async () => {
  const fixture = uploadedTileMenuHarness({ farMenu: true, farMenuClose: true });
  const result = await fixture.api.attach('Uploaded exact.png', undefined, { expectedId: fixture.mediaUuid, deadline: Date.now() + 1000 });
  assert.equal(result.confirmed, true);
  assert.equal(fixture.actionClicks(), 1);
  assert.equal(fixture.closeClicks(), 0);
  assert.equal(fixture.ownedOpen(), false);
});

test('uploaded image attachment rejects a conflicting chip UUID and dismisses only its owned menu', async () => {
  const fixture = uploadedTileMenuHarness({ chipIdentity: 'mismatched', leaveOwnedMenuOpen: true, openUnrelatedAfterAction: true });
  await assert.rejects(fixture.api.attach('Uploaded exact.png', undefined, { expectedId: fixture.mediaUuid, deadline: Date.now() + 1000 }), error => error.code === 'FLOW_ASSET_ID_MISMATCH' && error.outcome_unknown === true);
  assert.equal(fixture.actionClicks(), 1);
  assert.equal(fixture.unrelatedOpen(), true, 'the unrelated menu opened by an independent UI event is not closed');
  assert.equal(fixture.ownedOpen(), false, 'the owned menu is dismissed with Escape');
  assert.equal(fixture.unrelatedKeyEvents(), 0);
  assert.equal(fixture.api.inspectDiagnostics().cleanup, 'escape');
});

test('uploaded image attachment records provenance separately when the new chip exposes no UUID', async () => {
  const fixture = uploadedTileMenuHarness({ chipIdentity: 'missing' });
  const result = await fixture.api.attach('Uploaded exact.png', undefined, { expectedId: fixture.mediaUuid, deadline: Date.now() + 1000 });
  assert.equal(result.confirmed, true);
  assert.equal(result.idSource, 'verified_tile_action_provenance');
  assert.equal(result.chipUuidConfirmed, false);
  const diagnostics = fixture.api.inspectDiagnostics();
  assert.equal(diagnostics.provenanceConfirmed, true);
  assert.equal(diagnostics.chipUuidConfirmed, false);
  const serialized = JSON.stringify(diagnostics);
  assert.doesNotMatch(serialized, /Uploaded exact\.png|22222222-2222-4222-8222-222222222222|searchValue|pickerOptionLabels/);
});

test('uploaded image context actions serialize concurrent requests and reuse the first confirmed chip', async () => {
  const fixture = uploadedTileMenuHarness({ chipIdentity: 'missing' });
  const results = await Promise.all([
    fixture.api.attach('Uploaded exact.png', undefined, { expectedId: fixture.mediaUuid, deadline: Date.now() + 1500 }),
    fixture.api.attach('Uploaded exact.png', undefined, { expectedId: fixture.mediaUuid, deadline: Date.now() + 1500 }),
  ]);
  assert.equal(fixture.actionClicks(), 1);
  assert.equal(results.filter(result => result.reused).length, 1);
});

test('cancelled reference attachment gets a bounded picker cleanup window after its signal aborts', async () => {
  const fixture = harness({ openInitially: true, closeDelayMs: 200 });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(fixture.api.attach('character:MCP Test Mug', undefined, { signal: controller.signal }), error =>
    error.code === 'FLOW_OPERATION_TIMEOUT');
  assert.equal(fixture.pickerOpen(), false, 'the opened reference picker is dismissed and verified even after the operation signal aborts');
  assert.equal(fixture.api.inspectDiagnostics().cleanupErrorCode, null, 'successful cleanup does not inherit the operation cancellation');
});

test('reference picker waits for a bounded menu-to-listbox transition without clicking menu items', async () => {
  const { api, clicks } = harness({ names: ['MCP Test Mug'], addedKind: 'image', openInitially: false, afterOpenSurface: 'menu', menuTransitionMs: 450 });
  const result = await api.attach('MCP Test Mug', undefined, { deadline: Date.now() + 5000 });
  assert.equal(result.confirmed, true);
  assert.equal(clicks(), 1, 'only the exact asset option is clicked once the listbox appears');
});

test('a uniquely recognized intermediate menu is bounded and rejected without selecting an item', async () => {
  const { api, clicks } = harness({ openInitially: false, afterOpenSurface: 'menu' });
  await assert.rejects(api.attach('character:MCP Test Mug', undefined, { deadline: Date.now() + 1000 }), error =>
    error.code === 'FLOW_ASSET_PICKER_TRANSITION_UNSUPPORTED' && /no menu item was selected/i.test(error.message) && error.diagnostics?.visibleSurfaces?.length === 1);
  const diagnostics = api.inspectDiagnostics();
  assert.equal(clicks(), 0, 'no menu item or asset option is selected');
  assert.equal(diagnostics.surfaceStatus, 'menu_transition_timeout');
  assert.deepEqual(JSON.parse(JSON.stringify(diagnostics.visibleSurfaces.map(surface => ({ role: surface.role, labelCount: surface.labelCount })))), [
    { role: 'menu', labelCount: 1 },
  ]);
});

test('ambiguous visible picker surfaces fail closed and preserve bounded surface labels', async () => {
  const { api, clicks } = harness({ openInitially: false, afterOpenSurface: 'menu', ambiguousSurface: true });
  await assert.rejects(api.attach('character:MCP Test Mug', undefined, { deadline: Date.now() + 1000 }), error =>
    error.code === 'FLOW_ASSET_PICKER_SURFACE_AMBIGUOUS');
  const diagnostics = api.inspectDiagnostics();
  assert.equal(clicks(), 0, 'ambiguous popup surfaces never reach option selection');
  assert.equal(diagnostics.surfaceStatus, 'ambiguous');
  assert.equal(diagnostics.visibleSurfaces.length, 2);
  assert.deepEqual(Array.from(diagnostics.visibleSurfaces, surface => surface.role), ['menu', 'dialog']);
});

test('first-frame selection is confirmed by the chosen asset appearing in the Start slot', async () => {
  let pickerOpen = false;
  let frameListPresent = true;
  let omitExpandedState = false;
  let slotAsset = '';
  let optionClicks = 0;
  let openerClicks = 0;
  let clock = 0;
  const projectId = '11111111-1111-4111-8111-111111111111';
  const mediaUuid = '22222222-2222-4222-8222-222222222222';
  const conflictingMediaUuid = '33333333-3333-4333-8333-333333333333';
  const asbId = '0123456789abcdefghij0123456789ab';
  let provideAlias = true;
  let aliasEntries = [{ asb: asbId, mediaUuid, mediaType: 'image' }];
  const listeners = new Map();
  const identityWindow = {
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: (type, listener) => { if (listeners.get(type) === listener) listeners.delete(type); },
    dispatchEvent: event => {
      if (provideAlias && (event.type === 'TOBY_FLOW_MEDIA_IDENTITIES_READ' || event.type === 'TOBY_FLOW_V2_MEDIA_IDENTITIES_READ')) {
        for (const type of ['TOBY_FLOW_MEDIA_IDENTITIES', 'TOBY_FLOW_V2_MEDIA_IDENTITIES']) listeners.get(type)?.({ detail: {
          projectId, entries: aliasEntries,
        } });
      }
    },
  };
  const opener = {
    name: 'Start',
    getAttribute: name => name === 'aria-label' ? 'Start' : name === 'aria-expanded' && !omitExpandedState ? String(pickerOpen) : null,
    parentElement: { parentElement: { querySelectorAll: selector => selector === 'img,video' && slotAsset ? [{ currentSrc: slotAsset, getAttribute: () => null }] : [] } },
    click: () => { openerClicks++; pickerOpen = !pickerOpen; },
  };
  const selectedTile = { querySelectorAll: () => [], getAttribute: name => name === 'aria-label' ? 'MCP Test Mug' : null };
  const option = {
    name: 'MCP Test Mug',
    getAttribute: name => name === 'aria-selected' && slotAsset ? 'true' : null,
    querySelectorAll: () => [],
    querySelector: () => null,
    click() { optionClicks++; slotAsset = 'https://flow.google.com/asb/asset-123?token=private-test#fragment'; pickerOpen = true; frameListPresent = false; },
  };
  const list = { getAttribute: name => name === 'role' ? 'listbox' : null, querySelectorAll: selector => selector === '[role="option"]' ? [option] : selector === 'flow-grid-tile-container' ? [selectedTile] : [], closest: () => null };
  const unrelatedList = { querySelectorAll: () => [], closest: () => null };
  const allTab = { name: 'All', getAttribute: name => name === 'aria-selected' ? 'true' : null };
  const document = {
    querySelectorAll(selector) {
      if (selector === '[role="listbox"]') return pickerOpen && frameListPresent ? [unrelatedList, list] : [unrelatedList];
      if (selector === '[role="progressbar"],[aria-busy="true"]') return [];
      if (selector === '[role="tab"]') return [allTab];
      if (selector.startsWith('input')) return [];
      return [];
    },
    getElementById: () => null,
    dispatchEvent: () => {},
  };
  const context = vm.createContext({ document, location: { pathname: `/project/${projectId}` }, Date: class MockDate extends Date { static now() { return clock; } }, setTimeout, clearTimeout, window: identityWindow,
    CustomEvent: class CustomEvent { constructor(type) { this.type = type; } }, mediaId: value => value === selectedTile ? `asb:${asbId}` : undefined,
    visible: el => el !== list || (pickerOpen && frameListPresent),
    accessibleName: el => el.name || '', flowButton: name => name === 'Start' ? opener : null,
    flowError: (code, message, retryable, outcome_unknown) => Object.assign(new Error(message), { code, retryable, outcome_unknown }),
    KeyboardEvent: class KeyboardEvent {},
    wait: async ms => { clock += ms; },
  });
  vm.runInContext(source, context);
  const result = await context.chooseNativePickerAsset('MCP Test Mug', 'start', { expectedId: mediaUuid });
  assert.equal(optionClicks, 1);
  assert.equal(result.confirmed, true);
  assert.equal(result.slot, 'start');
  assert.equal(result.id, mediaUuid, 'the selected thumbnail ASB identity is resolved to its exact Flow UUID');
  assert.equal(slotAsset, 'https://flow.google.com/asb/asset-123?token=private-test#fragment');
  assert.equal(pickerOpen, false, 'the frame picker is closed and verified after Flow confirms the selection');
  assert.equal(openerClicks, 2, 'when Escape is ignored, cleanup toggles the exact Start opener once');
  assert.deepEqual(context.document.querySelectorAll('[role="listbox"]'), [unrelatedList], 'the unrelated listbox remains visible and untouched');
  const frameDiagnostics = context.FlowComponents.inspectFramePickerDiagnostics();
  assert.equal(frameDiagnostics.phase, 'picker_closed');
  assert.equal(frameDiagnostics.selectedMediaId, mediaUuid);
  assert.equal(frameDiagnostics.confirmation, 'slot_signature_changed_and_exact_list_disappeared');
  assert.equal(frameDiagnostics.stateSource, 'frame_opener_aria_expanded');
  assert.equal(frameDiagnostics.exactFrameList.present, false, 'diagnostics distinguish the vanished exact frame list from the still-visible unrelated listbox');
  const exportedFrameDiagnostics = JSON.stringify(frameDiagnostics);
  assert.match(exportedFrameDiagnostics, /https:\/\/flow\.google\.com\/asb\/asset-123/);
  assert.doesNotMatch(exportedFrameDiagnostics, /private-test|fragment|\?token|#/i, 'frame diagnostics omit URL query strings and fragments');
  slotAsset = '';
  frameListPresent = true;
  await assert.rejects(context.chooseNativePickerAsset('MCP Test Mug', 'start', { expectedId: conflictingMediaUuid }), error =>
    error.code === 'FLOW_ASSET_ID_MISMATCH' && error.outcome_unknown === false);
  assert.equal(optionClicks, 1, 'a mismatched expected ID is rejected before clicking the option');
  provideAlias = false;
  await assert.rejects(context.chooseNativePickerAsset('MCP Test Mug', 'start'), error =>
    error.code === 'FLOW_ASSET_ID_UNAVAILABLE' && error.outcome_unknown === false && /No frame was selected/.test(error.message));
  assert.equal(optionClicks, 1, 'an unresolved ASB alias is rejected before changing the frame slot');
  provideAlias = true;
  aliasEntries = [
    { asb: asbId, mediaUuid, mediaType: 'image' },
    { asb: asbId, mediaUuid: conflictingMediaUuid, mediaType: 'image' },
  ];
  await assert.rejects(context.chooseNativePickerAsset('MCP Test Mug', 'start'), error =>
    error.code === 'FLOW_ASSET_ID_UNAVAILABLE' && error.outcome_unknown === false);
  assert.equal(optionClicks, 1, 'conflicting ASB mappings are rejected before changing the frame slot');
  aliasEntries = [{ asb: asbId, mediaUuid, mediaType: 'image' }];
  omitExpandedState = true;
  const clicksBeforeAmbiguousAttempt = openerClicks;
  await assert.rejects(context.chooseNativePickerAsset('MCP Test Mug', 'start'), error =>
    error.code === 'FLOW_ASSET_PICKER_CLOSE_FAILED' && error.outcome_unknown === false &&
      /no_exact_list_or_expanded_state/.test(error.message) && /selectedMediaId/.test(error.message));
  assert.equal(optionClicks, 2, 'the option was selected once before the picker became unidentifiable');
  assert.equal(openerClicks - clicksBeforeAmbiguousAttempt, 1, 'ambiguous cleanup does not toggle a control without visible expanded-state evidence');
  assert.deepEqual(context.document.querySelectorAll('[role="listbox"]'), [unrelatedList], 'ambiguous cleanup never treats the unrelated listbox as the frame picker');
});

test('an unconfirmed frame choice keeps its primary error when the exact picker state becomes unknown', async () => {
  let clock = 0;
  let pickerOpen = false;
  const uuid = '22222222-2222-4222-8222-222222222222';
  const option = {
    getAttribute: name => name === 'aria-label' ? 'MCP Test Mug' : null,
    querySelectorAll: () => [], querySelector: () => null,
    click() { pickerOpen = false; },
  };
  const tile = { getAttribute: name => name === 'aria-label' ? 'MCP Test Mug' : null, querySelectorAll: () => [] };
  const list = {
    isConnected: true,
    getAttribute: name => name === 'role' ? 'listbox' : null,
    querySelectorAll: selector => selector === '[role="option"]' ? [option] : selector === 'flow-grid-tile-container' ? [tile] : [],
  };
  const opener = {
    getAttribute: name => name === 'aria-label' ? 'Start' : null,
    innerText: 'Start',
    parentElement: { parentElement: { querySelectorAll: () => [] } },
    click() { pickerOpen = !pickerOpen; },
  };
  const allTab = { getAttribute: name => name === 'aria-selected' ? 'true' : null, name: 'All' };
  const context = vm.createContext({
    document: {
      body: {},
      getElementById: () => null,
      dispatchEvent() {},
      querySelectorAll(selector) {
        if (selector === '[role="listbox"]') return pickerOpen ? [list] : [];
        if (selector === '[role="progressbar"],[aria-busy="true"]') return [];
        if (selector === '[role="tab"]') return [allTab];
        if (selector === 'input,[role="textbox"]') return [];
        return [];
      },
    },
    location: { href: 'https://flow.google.com/project/test', pathname: '/project/test' },
    Date: class MockDate extends Date { static now() { return clock; } },
    setTimeout, clearTimeout, KeyboardEvent: class KeyboardEvent {},
    CustomEvent: class CustomEvent {},
    window: { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} },
    mediaId: value => value === tile ? uuid : undefined,
    visible: value => value !== list || pickerOpen,
    accessibleName: value => value === opener ? 'Start' : value === allTab ? 'All' : value.getAttribute?.('aria-label') || '',
    flowButton: name => name === 'Start' ? opener : null,
    wait: async ms => { clock += ms; },
    flowError: (code, message, retryable, outcome_unknown) => Object.assign(new Error(message), { code, retryable, outcome_unknown }),
  });
  vm.runInContext(source, context);
  await assert.rejects(context.chooseNativePickerAsset('MCP Test Mug', 'start', { deadline: 15000 }), error =>
    error.code === 'FLOW_FRAME_ATTACH_UNCONFIRMED' && error.outcome_unknown === true && error.cleanupError?.code === 'FLOW_ASSET_PICKER_CLOSE_FAILED');
  const diagnostics = context.FlowComponents.inspectFramePickerDiagnostics();
  assert.equal(diagnostics.phase, 'cleanup_unverified');
  assert.equal(diagnostics.operationErrorCode, 'FLOW_FRAME_ATTACH_UNCONFIRMED');
  assert.equal(diagnostics.cleanupErrorCode, 'FLOW_ASSET_PICKER_CLOSE_FAILED');
});
test('exact matching rejects duplicates and does not choose a prefix match', async () => {
  const { api, clicks } = harness({ names: ['MCP Test Mug', 'MCP Test Mug'] });
  await assert.rejects(api.attach('character:MCP Test Mug'), error => error.code === 'FLOW_ASSET_AMBIGUOUS');
  assert.equal(clicks(), 0);
  const other = harness({ names: ['MCP Test Mug extra'] });
  await assert.rejects(other.api.attach('character:MCP Test Mug'), error => error.code === 'FLOW_ASSET_NOT_FOUND');
  const suffixed = harness({ names: ['MCP Test Mug Character'] });
  await assert.rejects(suffixed.api.attach('character:MCP Test Mug'), error => error.code === 'FLOW_ASSET_NOT_FOUND');
});
test('asset names ending in media decoration are matched without broad substrings', () => {
  const { api } = harness();
  const option = { name: 'Mug Character', getAttribute: () => null, querySelectorAll: () => [] };
  assert.equal(api.exactOption([option], 'Mug'), option);
  assert.equal(api.exactOption([option], 'Mu'), null);
});

test('character scan fails instead of returning a partial list when scrolling stalls before the bottom', async () => {
  let ticks = 0;
  const tile = { innerText: 'First character', textContent: 'First character' };
  const container = { scrollTop: 0, scrollHeight: 1800, clientHeight: 500 };
  Object.defineProperty(container, 'scrollTop', {
    get: () => 0,
    set: () => {},
  });
  let navigationOptions;
  const context = vm.createContext({
    document: { querySelectorAll: selector => selector.includes('progressbar') || selector.includes('aria-busy') ? [] : selector === 'flow-character-tile' ? [tile] : selector === 'flow-custom-tile' ? [{ innerText: 'New character', querySelectorAll: () => [{ innerText: 'add' }] }] : [] },
    location: { href: 'https://flow.google.com/project/test', pathname: '/project/test' },
    Date: class MockDate extends Date { static now() { return ticks; } },
    visible: () => true,
    scrollContainer: () => container,
    ensureFlowLibrarySection: async (_label, options) => { navigationOptions = options; },
    flowQueryAll: () => [tile],
    wait: async ms => { ticks += ms; },
    clickFlowNavigation: () => false,
    flowError: (code, message, retryable, outcome_unknown) => Object.assign(new Error(message), { code, retryable, outcome_unknown }),
  });
  vm.runInContext(mediaMenuSource, context);
  await assert.rejects(context.FlowMediaMenu.scanNativeCharacters({ deadline: 20_000 }), error =>
    error.code === 'FLOW_CHARACTER_SCAN_INCOMPLETE' && /no complete list/.test(error.message));
  assert.equal(navigationOptions.deadline, 20_000, 'navigation shares the caller deadline');
});

test('character scanner refuses to report an empty list when the Characters section is not proven active', async () => {
  let ticks = 0;
  const context = vm.createContext({
    document: { querySelectorAll: () => [] },
    location: { href: 'https://flow.google.com/project/proj_123', pathname: '/project/proj_123' },
    Date: class MockDate extends Date { static now() { return ticks; } },
    visible: () => true,
    scrollContainer: () => null,
    ensureFlowLibrarySection: async () => {},
    wait: async ms => { ticks += ms; },
    flowError: (code, message, retryable, outcome_unknown) => Object.assign(new Error(message), { code, retryable, outcome_unknown }),
  });
  vm.runInContext(mediaMenuSource, context);

  await assert.rejects(context.FlowMediaMenu.scanNativeCharacters({ deadline: 5000 }), error => {
    assert.equal(error.code, 'FLOW_CHARACTER_SCAN_INCOMPLETE');
    assert.equal(error.outcome_unknown, false);
    assert.equal(error.diagnostics.currentSection, null);
    assert.equal(error.diagnostics.visibleTileCount, 0);
    assert.match(error.message, /no empty or partial list was returned/);
    return true;
  });
});

test('character scanner returns an empty list only after an active empty section stays stable', async () => {
  let ticks = 0;
  const createTile = { innerText: 'New character', textContent: 'New character', querySelectorAll: () => [{ innerText: 'add', textContent: 'add' }] };
  const context = vm.createContext({
    document: { scrollingElement: { scrollHeight: 500, clientHeight: 500, scrollTop: 0 }, querySelectorAll: selector => selector === 'flow-custom-tile' ? [createTile] : [] },
    location: { href: 'https://flow.google.com/project/proj_123', pathname: '/project/proj_123' },
    Date: class MockDate extends Date { static now() { return ticks; } },
    visible: () => true,
    scrollContainer: () => null,
    ensureFlowLibrarySection: async () => {},
    wait: async ms => { ticks += ms; },
    clickFlowNavigation: () => false,
    flowError: (code, message, retryable, outcome_unknown) => Object.assign(new Error(message), { code, retryable, outcome_unknown }),
  });
  vm.runInContext(mediaMenuSource, context);

  const result = await context.FlowMediaMenu.scanNativeCharacters({ deadline: 10_000 });
  assert.deepEqual(Array.from(result), []);
  const diagnostics = context.FlowMediaMenu.inspectCharacterScanDiagnostics();
  assert.equal(diagnostics.result, 'confirmed_empty');
  assert.equal(diagnostics.currentSection, 'Characters');
  assert.equal(diagnostics.createActionVisible, true);
  assert.equal(diagnostics.visibleTileCount, 0);
});

test('character scanner waits for late character tiles instead of returning an early empty list', async () => {
  let ticks = 0;
  const tile = { innerText: 'Late character', textContent: 'Late character' };
  const createTile = { innerText: 'New character', textContent: 'New character', querySelectorAll: () => [{ innerText: 'add', textContent: 'add' }] };
  const context = vm.createContext({
    document: { scrollingElement: { scrollHeight: 500, clientHeight: 500, scrollTop: 0 }, querySelectorAll: selector => selector === 'flow-character-tile' ? (ticks >= 1200 ? [tile] : []) : selector === 'flow-custom-tile' ? [createTile] : [] },
    location: { href: 'https://flow.google.com/project/proj_123', pathname: '/project/proj_123' },
    Date: class MockDate extends Date { static now() { return ticks; } },
    visible: () => true,
    scrollContainer: () => null,
    flowQueryAll: () => [tile],
    ensureFlowLibrarySection: async () => {},
    wait: async ms => { ticks += ms; },
    clickFlowNavigation: () => false,
    flowError: (code, message, retryable, outcome_unknown) => Object.assign(new Error(message), { code, retryable, outcome_unknown }),
  });
  vm.runInContext(mediaMenuSource, context);

  assert.deepEqual(JSON.parse(JSON.stringify(await context.FlowMediaMenu.scanNativeCharacters({ deadline: 10_000 }))), [{ name: 'Late character' }]);
  const diagnostics = context.FlowMediaMenu.inspectCharacterScanDiagnostics();
  assert.equal(diagnostics.result, 'complete');
  assert.equal(diagnostics.scanComplete, true);
  assert.equal(diagnostics.visibleTileCount, 1);
});

test('character scanner exposes only a character-specific stable UUID and records complete scan metadata', async () => {
  let ticks = 0;
  const uuid = '22222222-2222-4222-8222-222222222222';
  const tile = { innerText: 'Ada', textContent: 'Ada', getAttribute: name => name === 'data-character-id' ? uuid : null, querySelector: () => null };
  const createTile = { innerText: 'New character', textContent: 'New character', querySelectorAll: () => [{ innerText: 'add', textContent: 'add' }] };
  const context = vm.createContext({
    document: { scrollingElement: { scrollHeight: 500, clientHeight: 500, scrollTop: 0 }, querySelectorAll: selector => selector === 'flow-character-tile' ? [tile] : selector === 'flow-custom-tile' ? [createTile] : [] },
    location: { href: 'https://flow.google.com/project/proj_123', pathname: '/project/proj_123' },
    Date: class MockDate extends Date { static now() { return ticks; } },
    visible: () => true,
    scrollContainer: () => null,
    ensureFlowLibrarySection: async () => {},
    flowQueryAll: () => [tile],
    wait: async ms => { ticks += ms; },
    clickFlowNavigation: () => false,
    flowError: (code, message, retryable, outcome_unknown) => Object.assign(new Error(message), { code, retryable, outcome_unknown }),
  });
  vm.runInContext(mediaMenuSource, context);

  assert.deepEqual(JSON.parse(JSON.stringify(await context.FlowMediaMenu.scanNativeCharacters({ deadline: 10_000 }))), [{ name: 'Ada', uuid }]);
  const diagnostics = context.FlowMediaMenu.inspectCharacterScanDiagnostics();
  assert.equal(diagnostics.result, 'complete');
  assert.equal(diagnostics.scanComplete, true);
  assert.equal(diagnostics.nameCount, 1);
  assert.equal(diagnostics.stableUuidCount, 1);
});

test('character scanner does not promote generic data-id to a character UUID', async () => {
  let ticks = 0;
  const portraitId = '22222222-2222-4222-8222-222222222222';
  const tile = { innerText: 'Ada', textContent: 'Ada', getAttribute: name => name === 'data-id' ? portraitId : null, querySelector: () => null };
  const createTile = { innerText: 'New character', textContent: 'New character', querySelectorAll: () => [{ innerText: 'add', textContent: 'add' }] };
  const context = vm.createContext({
    document: { scrollingElement: { scrollHeight: 500, clientHeight: 500, scrollTop: 0 }, querySelectorAll: selector => selector === 'flow-character-tile' ? [tile] : selector === 'flow-custom-tile' ? [createTile] : [] },
    location: { href: 'https://flow.google.com/project/proj_123', pathname: '/project/proj_123' },
    Date: class MockDate extends Date { static now() { return ticks; } },
    visible: () => true, scrollContainer: () => null,
    ensureFlowLibrarySection: async () => {}, flowQueryAll: () => [tile],
    wait: async ms => { ticks += ms; }, clickFlowNavigation: () => false,
    flowError: (code, message, retryable, outcome_unknown) => Object.assign(new Error(message), { code, retryable, outcome_unknown }),
  });
  vm.runInContext(mediaMenuSource, context);

  assert.deepEqual(JSON.parse(JSON.stringify(await context.FlowMediaMenu.scanNativeCharacters({ deadline: 10_000 }))), [{ name: 'Ada' }]);
  const diagnostics = context.FlowMediaMenu.inspectCharacterScanDiagnostics();
  assert.equal(diagnostics.scanComplete, true);
  assert.equal(diagnostics.stableUuidCount, 0);
});

test('character scanner fails incomplete when a visible character tile has no usable name', async () => {
  let ticks = 0;
  const tile = { innerText: '', textContent: '', getAttribute: () => null, querySelector: () => null };
  const createTile = { innerText: 'New character', textContent: 'New character', querySelectorAll: () => [{ innerText: 'add', textContent: 'add' }] };
  const context = vm.createContext({
    document: { scrollingElement: { scrollHeight: 500, clientHeight: 500, scrollTop: 0 }, querySelectorAll: selector => selector === 'flow-character-tile' ? [tile] : selector === 'flow-custom-tile' ? [createTile] : [] },
    location: { href: 'https://flow.google.com/project/proj_123', pathname: '/project/proj_123' },
    Date: class MockDate extends Date { static now() { return ticks; } },
    visible: () => true, scrollContainer: () => null,
    ensureFlowLibrarySection: async () => {}, flowQueryAll: () => [tile],
    wait: async ms => { ticks += ms; }, clickFlowNavigation: () => false,
    flowError: (code, message, retryable, outcome_unknown) => Object.assign(new Error(message), { code, retryable, outcome_unknown }),
  });
  vm.runInContext(mediaMenuSource, context);

  await assert.rejects(context.FlowMediaMenu.scanNativeCharacters({ deadline: 10_000 }), error => {
    assert.equal(error.code, 'FLOW_CHARACTER_SCAN_INVALID_RESULT');
    assert.equal(error.diagnostics.scanComplete, false);
    return true;
  });
});

test('character scanner does not mark a visible but unbounded library as complete', async () => {
  let ticks = 0;
  const tile = { innerText: 'Ada', textContent: 'Ada' };
  const createTile = { innerText: 'New character', textContent: 'New character', querySelectorAll: () => [{ innerText: 'add', textContent: 'add' }] };
  const context = vm.createContext({
    document: { querySelectorAll: selector => selector === 'flow-character-tile' ? [tile] : selector === 'flow-custom-tile' ? [createTile] : [] },
    location: { href: 'https://flow.google.com/project/proj_123', pathname: '/project/proj_123' },
    Date: class MockDate extends Date { static now() { return ticks; } },
    visible: () => true,
    scrollContainer: () => null,
    ensureFlowLibrarySection: async () => {},
    flowQueryAll: () => [tile],
    wait: async ms => { ticks += ms; },
    clickFlowNavigation: () => false,
    flowError: (code, message, retryable, outcome_unknown) => Object.assign(new Error(message), { code, retryable, outcome_unknown }),
  });
  vm.runInContext(mediaMenuSource, context);

  await assert.rejects(context.FlowMediaMenu.scanNativeCharacters({ deadline: 10_000 }), error => {
    assert.equal(error.code, 'FLOW_CHARACTER_SCAN_INCOMPLETE');
    assert.equal(error.diagnostics.scanComplete, false);
    assert.match(error.message, /no complete list was returned/);
    return true;
  });
});

function nativeFileTransferHarness() {
  const listeners = new Set();
  const actions = [];
  const window = {
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
    postMessage(message) {
      actions.push(message.action);
      const result = message.action === 'status'
        ? { success: true, fired: 'input.click', fileName: 'local-reference.png', fileSize: 3, fileType: 'image/png' }
        : { success: true };
      for (const listener of [...listeners]) listener({ source: window, data: { source: 'flow-mcp-upload-v8-result', requestId: message.requestId, ...result } });
    },
  };
  const context = vm.createContext({ window, location: { origin: 'https://flow.google.com' }, crypto: webcrypto, Blob, atob, setTimeout, clearTimeout });
  vm.runInContext(nativeFileTransferSource, context);
  return { transfer: context.FlowNativeFileTransfer, actions };
}

test('file picker records the click boundary before a menu callback can throw', async () => {
  const { transfer, actions } = nativeFileTransferHarness();
  const file = new Blob(['abc']);
  Object.defineProperty(file, 'name', { value: 'local-reference.png' });
  await assert.rejects(transfer.selectFileThroughPicker(file, async () => {
    throw new Error('Flow menu rerendered after dispatching its click');
  }), error => error.outcome_unknown === true && error.code === 'FLOW_UPLOAD_PICKER_OUTCOME_UNKNOWN');
  assert.deepEqual(actions, ['arm', 'cancel']);
});

test('file picker reports success only after the bridge confirms the selected file', async () => {
  const { transfer } = nativeFileTransferHarness();
  const file = new Blob(['abc']);
  Object.defineProperty(file, 'name', { value: 'local-reference.png' });
  const result = await transfer.selectFileThroughPicker(file, async () => true);
  assert.equal(result.selected, true);
  assert.equal(result.method, 'input.click');
  assert.equal(result.type, 'image/png');
  assert.equal(result.trustedGesture, false);
});

test('dynamic selector sync keeps regex-valued extension selectors executable', () => {
  const selectorsSource = readFileSync(new URL('../extension/src/content/providers/flow/core/selectors.js', import.meta.url), 'utf8');
  const remoteSelectors = JSON.parse(readFileSync(new URL('../flow-selectors.json', import.meta.url), 'utf8'));
  const context = vm.createContext({ chrome: { storage: {
    local: { get: (_key, callback) => callback({ flow_remote_selectors: remoteSelectors }) },
    onChanged: { addListener: () => {} },
  } } });
  vm.runInContext(selectorsSource, context);
  const excludedAria = context.FlowSelectors.submitButton.excludedComposerAria;
  assert.equal(typeof excludedAria.test, 'function');
  assert.equal(excludedAria.test('add media'), true);
});

test('generation transports character:<name> as a named reference, not a local file', async () => {
  class Connector extends EventEmitter {
    readyState = 1;
    sent = [];
    send(raw) {
      const command = JSON.parse(raw);
      this.sent.push(command);
      const operation = command.args[0];
      const result = operation.name === 'flow.context'
        ? { ok: true, value: { driverKey: 'flow_v2', origin: 'https://flow.google.com', projectId: 'test-project', routePrefix: '', isProjectEditor: true, tabId: 101 } }
        : { ok: false, error: { message: 'Stopped at submit boundary for test', outcome_unknown: false } };
      queueMicrotask(() => this.emit('message', JSON.stringify({ type: 'result', id: command.id, result })));
    }
  }
  const connector = new Connector();
  extensionSetWebSocket(connector);
  connector.emit('message', JSON.stringify({ type: 'event', method: 'extension.initialized', params: [{ protocol: 2, version: '0.2.13', capabilities: ['context', 'generation.submit', 'generation.observe', 'asset.download', 'references.attach'].map(name => `flow.native.${name}`) }] }));
  try {
    await assert.rejects(runGeneration({ params: { type: 'image', prompt: 'Test character', reference_images: ['character:MCP Test Mug'], max_credits: 0 } }), /Stopped at submit boundary/);
    assert.deepEqual(connector.sent.map(command => command.args[0].name), ['flow.context', 'flow.generation.submit']);
    assert.deepEqual(connector.sent[1].args[0].payload.attachments, [{ assetName: 'character:MCP Test Mug' }]);
  } finally { connector.emit('close', 1000, Buffer.from('test complete')); }
});

test('remote browser downloads are relayed in ordered, checksum-verified chunks', async () => {
  const bytes = Buffer.alloc(300_000, 37);
  const commands = [];
  class Connector extends EventEmitter {
    readyState = 1;
    send(raw) {
      const command = JSON.parse(raw);
      commands.push(command);
      const input = command.args[0];
      assert.equal(command.method, 'flow.downloads.read');
      const chunk = bytes.subarray(input.offset, input.offset + input.length);
      const result = {
        ok: true,
        value: {
          index: input.index,
          offset: input.offset,
          data: chunk.toString('base64'),
          chunkSha256: createHash('sha256').update(chunk).digest('hex'),
          totalBytes: bytes.length,
        },
      };
      queueMicrotask(() => this.emit('message', JSON.stringify({ type: 'result', id: command.id, result })));
    }
  }
  const connector = new Connector();
  extensionSetWebSocket(connector);
  connector.emit('message', JSON.stringify({
    type: 'event', method: 'extension.initialized',
    params: [{ protocol: 2, version: '0.2.23', capabilities: ['downloads.read'].map(name => `flow.native.${name}`) }],
  }));
  const output = mkdtempSync(join(tmpdir(), 'flow-download-relay-test-'));
  try {
    const path = await materializeNativeDownload({
      id: 17, filename: 'C:\\Users\\test\\Downloads\\flow-result.png', state: 'complete',
      bytesReceived: bytes.length, totalBytes: bytes.length,
    }, output);
    assert.equal(readFileSync(path).length, bytes.length);
    assert.deepEqual(readFileSync(path), bytes);
    assert.equal(commands.length, 2);
    assert.deepEqual(commands.map(command => command.args[0].index), [0, 1]);
  } finally {
    connector.emit('close', 1000, Buffer.from('test complete'));
    rmSync(output, { recursive: true, force: true });
  }
});

test('extension download relay accepts only completed Flow downloads and validates HTTP ranges', async () => {
  const file = Buffer.from('abcde');
  const calls = [];
  const downloads = { search: async query => [{
    id: query.id, state: 'complete', referrer: 'https://flow.google.com/project/test',
    url: 'https://flow.google.com/download/1', finalUrl: 'https://lh3.googleusercontent.com/media/signed-file', totalBytes: file.length,
  }] };
  const chunk = await readFlowDownloadChunk({ id: 3, index: 0, offset: 1, length: 3 }, {
    downloads,
    cryptoApi: webcrypto,
    fetchImpl: async (url, options) => {
      calls.push({ url, range: options.headers.Range, credentials: options.credentials });
      return new Response(file.subarray(1, 4), { status: 206, headers: { 'content-range': 'bytes 1-3/5' } });
    },
  });
  assert.equal(Buffer.from(chunk.data, 'base64').toString(), 'bcd');
  assert.equal(chunk.totalBytes, 5);
  assert.equal(chunk.chunkSha256, createHash('sha256').update('bcd').digest('hex'));
  assert.deepEqual(calls, [{ url: 'https://lh3.googleusercontent.com/media/signed-file', range: 'bytes=1-3', credentials: 'omit' }]);

  await assert.rejects(readFlowDownloadChunk({ id: 3, index: 0, offset: 0, length: 2 }, {
    downloads: { search: async query => [{ id: query.id, state: 'complete', referrer: 'https://flow.google.com/project/test', url: 'https://flow.google.com/download', finalUrl: 'http://127.0.0.1/private', totalBytes: 5 }] },
    fetchImpl: async () => { throw new Error('must not fetch an untrusted URL'); },
  }), /approved Google media host/);
});

test('classifyFlowError identifies quota, unusual activity, policy, and rate limits correctly', () => {
  const domUtilsSource = readFileSync(new URL('../extension/src/content/shared/dom-utils.js', import.meta.url), 'utf8');
  const context = vm.createContext({ window: {}, document: {}, location: { href: 'https://flow.google.com' } });
  vm.runInContext(domUtilsSource, context);
  const classify = context.classifyFlowError;

  const quota = classify('Error: PUBLIC_ERROR_USER_QUOTA_REACHED');
  assert.equal(quota.category, 'quota');
  assert.equal(quota.code, 'FLOW_QUOTA_EXCEEDED');
  assert.equal(quota.retryable, false);

  const unusual = classify('We noticed some unusual activity and blocked this request.');
  assert.equal(unusual.category, 'captcha');
  assert.equal(unusual.code, 'FLOW_UNUSUAL_ACTIVITY');
  assert.equal(unusual.retryable, false);

  const policy = classify('Prompt rejected: CONTENT_BLOCKED by safety guidelines');
  assert.equal(policy.category, 'policy');
  assert.equal(policy.code, 'FLOW_POLICY_VIOLATION');
  assert.equal(policy.retryable, false);

  const rateLimit = classify('Server returned RATE_LIMIT: too many requests');
  assert.equal(rateLimit.category, 'rate_limit');
  assert.equal(rateLimit.code, 'FLOW_RATE_LIMIT');
  assert.equal(rateLimit.retryable, true);

  const genericPublicError = classify('Flow returned PUBLIC_ERROR_SERVICE_UNAVAILABLE');
  assert.equal(genericPublicError.category, 'provider_error');
  assert.equal(genericPublicError.code, 'PUBLIC_ERROR_SERVICE_UNAVAILABLE');
  assert.equal(genericPublicError.retryable, false);

  assert.equal(classify('A normal unknown error occurred'), null);
});

test('getCachedProjectMedia reuses previously uploaded asset by sha256', () => {
  const filePath = new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
  const projectId = 'proj-123';
  assert.equal(getCachedProjectMedia(projectId, filePath), undefined);

  cacheProjectMedia(projectId, filePath, { name: 'fm-cached-asset', kind: 'image' });
  const hit = getCachedProjectMedia(projectId, filePath);
  assert.deepEqual(hit, { name: 'fm-cached-asset', kind: 'image' });

  // Different project should not hit
  assert.equal(getCachedProjectMedia('other-proj', filePath), undefined);
});

test('getEditorUserText extracts plain prompt text while completely excluding inline chips', () => {
  const domUtilsSource = readFileSync(new URL('../extension/src/content/shared/dom-utils.js', import.meta.url), 'utf8');
  const context = vm.createContext({ window: {}, document: {}, location: { href: 'https://flow.google.com' } });
  vm.runInContext(domUtilsSource, context);
  const getEditorUserText = context.getEditorUserText;

  // Mock an editor with a chip and user prompt text
  const chipElement = {
    nodeType: 1,
    tagName: 'SPAN',
    getAttribute: attr => attr === 'contenteditable' ? 'false' : null,
    childNodes: [{ nodeType: 3, nodeValue: '@HeroCharacter' }],
    querySelectorAll: () => [],
    closest: selector => selector === '[contenteditable="false"]' ? chipElement : null,
  };
  const promptTextNode = {
    nodeType: 3,
    nodeValue: ' jumping over mountains at sunrise',
    parentElement: { closest: () => null },
  };

  const editor = {
    nodeType: 1,
    isContentEditable: true,
    childNodes: [chipElement, promptTextNode],
    querySelectorAll: selector => selector === '[contenteditable="false"]' ? [chipElement] : [],
  };

  const extracted = getEditorUserText(editor);
  assert.equal(extracted, 'jumping over mountains at sunrise');
});

test('clearEditorTextPreservingChips wipes user text without removing reference chips', async () => {
  const domUtilsSource = readFileSync(new URL('../extension/src/content/shared/dom-utils.js', import.meta.url), 'utf8');
  const dispatchedEvents = [];
  const context = vm.createContext({
    window: { getSelection: () => null },
    setTimeout: (fn) => fn(),
    clearTimeout: () => {},
    document: {
      createRange: () => ({ selectNode: () => {}, selectNodeContents: () => {} }),
      execCommand: () => true,
    },
    location: { href: 'https://flow.google.com' },
    InputEvent: class InputEvent { constructor(type, init) { this.type = type; this.init = init; } },
  });
  vm.runInContext(domUtilsSource, context);
  const clearEditorTextPreservingChips = context.clearEditorTextPreservingChips;
  const getEditorUserText = context.getEditorUserText;
  const countInlineChips = context.countInlineChips;

  const chipElement = {
    nodeType: 1,
    tagName: 'SPAN',
    getAttribute: attr => attr === 'contenteditable' ? 'false' : null,
    childNodes: [{ nodeType: 3, nodeValue: '@CharacterChip' }],
    querySelectorAll: () => [],
    closest: selector => selector === '[contenteditable="false"]' ? chipElement : null,
  };
  const promptTextNode = {
    nodeType: 3,
    nodeValue: 'old stale prompt from previous attempt',
    parentElement: { closest: () => null },
  };

  const editor = {
    nodeType: 1,
    isContentEditable: true,
    focus: () => {},
    dispatchEvent: evt => dispatchedEvents.push(evt),
    childNodes: [chipElement, promptTextNode],
    querySelectorAll: selector => selector === '[contenteditable="false"]' ? [chipElement] : [],
  };

  assert.equal(countInlineChips(editor), 1);
  assert.equal(getEditorUserText(editor), 'old stale prompt from previous attempt');

  const cleared = await clearEditorTextPreservingChips(editor);
  assert.equal(cleared, true);
  // Text node value wiped
  assert.equal(promptTextNode.nodeValue, '');
  // Chip still intact
  assert.equal(countInlineChips(editor), 1);
  assert.equal(getEditorUserText(editor), '');
});

test('dismissBlockingOverlays clicks close buttons or dispatches Escape for open dialogs', async () => {
  const domUtilsSource = readFileSync(new URL('../extension/src/content/shared/dom-utils.js', import.meta.url), 'utf8');
  let closeClicked = false;
  let dialogOpen = true;
  let escapeCount = 0;

  const closeButton = {
    nodeType: 1,
    name: 'Close dialog',
    innerText: 'Close',
    getAttribute: (attr) => attr === 'aria-label' ? 'Close dialog' : null,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ width: 40, height: 40 }),
    click: () => { closeClicked = true; dialogOpen = false; },
  };

  const modalDialog = {
    nodeType: 1,
    getAttribute: () => null,
    querySelectorAll: selector => selector.includes('button') ? [closeButton] : [],
    querySelector: () => null,
    getBoundingClientRect: () => ({ width: 300, height: 200 }),
  };

  const context = vm.createContext({
    window: {},
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    setTimeout: (fn) => fn(),
    clearTimeout: () => {},
    document: {
      querySelectorAll: selector => {
        if (selector.includes('[role="dialog"]')) return dialogOpen ? [modalDialog] : [];
        if (selector.includes('cdk-overlay-backdrop')) return [];
        return [];
      },
      dispatchEvent: evt => { if (evt.key === 'Escape') escapeCount++; },
    },
    KeyboardEvent: class KeyboardEvent { constructor(type, init) { this.type = type; this.key = init?.key; } },
    accessibleName: el => el.name || el.innerText || '',
    location: { href: 'https://flow.google.com' },
  });
  vm.runInContext(domUtilsSource, context);
  const dismissBlockingOverlays = context.dismissBlockingOverlays;

  const result = await dismissBlockingOverlays();
  assert.equal(result, true);
  assert.equal(closeClicked, true);
  assert.equal(dialogOpen, false, 'the blocking dialog is verified closed before returning');
});

test('prepareFlowOperation closes and verifies an already-open Flow reference picker before continuing', async () => {
  const navigationSource = readFileSync(new URL('../extension/src/content/providers/flow/core/navigation.js', import.meta.url), 'utf8');
  const domUtilsSource = readFileSync(new URL('../extension/src/content/shared/dom-utils.js', import.meta.url), 'utf8');
  let pickerOpen = true;
  let closeCalls = 0;
  const context = vm.createContext({
    window: {},
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    setTimeout: (fn) => fn(),
    clearTimeout: () => {},
    document: {
      querySelectorAll: selector => selector.includes('[role="dialog"]') || selector.includes('.cdk-overlay-pane') ? [] : [],
      dispatchEvent: () => {},
    },
    KeyboardEvent: class KeyboardEvent { constructor(type, init) { this.type = type; this.key = init?.key; } },
    FlowReferenceActions: {
      inspectDiagnostics: () => ({ pickerOpen }),
      closePicker: async () => { closeCalls++; pickerOpen = false; return { closed: true }; },
    },
    flowError: (code, message, retryable, outcome_unknown) => Object.assign(new Error(message), { code, retryable, outcome_unknown }),
    location: { href: 'https://flow.google.com' },
  });
  vm.runInContext(domUtilsSource, context);
  vm.runInContext(navigationSource, context);

  const result = await context.FlowNavigation.prepareFlowOperation();
  assert.equal(closeCalls, 1);
  assert.equal(result.ready, true);
  assert.equal(result.popupDismissed, true);
});

test('FlowDriverRegistry correctly flags sub-routes like /character as not project editor', () => {
  const registrySource = readFileSync(new URL('../extension/src/content/providers/base/provider-registry.js', import.meta.url), 'utf8');
  const rootObj = {};
  const context = vm.createContext({ globalThis: rootObj, URL });
  vm.runInContext(registrySource, context);
  const Registry = rootObj.FlowDriverRegistry;

  const rootEditor = Registry.describeUrl('https://flow.google.com/project/172cc8b0-cb73-44fb-9300-e1484f84a4bc');
  assert.equal(rootEditor.projectId, '172cc8b0-cb73-44fb-9300-e1484f84a4bc');
  assert.equal(rootEditor.isProjectEditor, true);

  const characterSubroute = Registry.describeUrl('https://flow.google.com/project/172cc8b0-cb73-44fb-9300-e1484f84a4bc/character');
  assert.equal(characterSubroute.projectId, '172cc8b0-cb73-44fb-9300-e1484f84a4bc');
  assert.equal(characterSubroute.isProjectEditor, false);

  const videoEditSubroute = Registry.describeUrl('https://flow.google.com/project/172cc8b0-cb73-44fb-9300-e1484f84a4bc/edit/some-video-id');
  assert.equal(videoEditSubroute.projectId, '172cc8b0-cb73-44fb-9300-e1484f84a4bc');
  assert.equal(videoEditSubroute.isProjectEditor, false);

  const localizedRoot = Registry.describeUrl('https://flow.google.com/u/0/project/172cc8b0-cb73-44fb-9300-e1484f84a4bc');
  assert.equal(localizedRoot.isProjectEditor, true);
});

test('ensureFlowProjectEditor navigates to project root when stuck on sub-routes', async () => {
  const registrySource = readFileSync(new URL('../extension/src/content/providers/base/provider-registry.js', import.meta.url), 'utf8');
  const domUtilsSource = readFileSync(new URL('../extension/src/content/shared/dom-utils.js', import.meta.url), 'utf8');

  let assignedUrl = null;
  const mockLocation = {
    href: 'https://flow.google.com/project/172cc8b0-cb73-44fb-9300-e1484f84a4bc/character',
    origin: 'https://flow.google.com',
    pathname: '/project/172cc8b0-cb73-44fb-9300-e1484f84a4bc/character',
    assign: (url) => {
      assignedUrl = url;
      mockLocation.href = url;
      mockLocation.pathname = new URL(url).pathname;
    },
  };

  const rootObj = {};
  const context = vm.createContext({
    globalThis: rootObj,
    window: rootObj,
    URL,
    document: {
      querySelectorAll: () => [],
      querySelector: () => null,
      dispatchEvent: () => {},
    },
    location: mockLocation,
    setTimeout: (fn) => fn(),
    clearTimeout: () => {},
    console: { log: () => {} },
  });

  vm.runInContext(registrySource, context);
  vm.runInContext(domUtilsSource, context);

  const ensureFlowProjectEditor = rootObj.ensureFlowProjectEditor;
  const result = await ensureFlowProjectEditor();

  assert.equal(result.success, true);
  assert.equal(result.isProjectEditor, true);
  assert.equal(assignedUrl, 'https://flow.google.com/project/172cc8b0-cb73-44fb-9300-e1484f84a4bc');
});

test('checkFlowCreditLimitAlert detects quota exhaustion banners immediately', () => {
  const domUtilsSource = readFileSync(new URL('../extension/src/content/shared/dom-utils.js', import.meta.url), 'utf8');
  const alertEl = {
    nodeType: 1,
    innerText: "You've run out of credits. Upgrade your account or wait for reset.",
    getBoundingClientRect: () => ({ width: 200, height: 40 }),
  };

  const context = vm.createContext({
    globalThis: {},
    window: {},
    URL,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    document: {
      querySelectorAll: selector => selector.includes('[role="alert"]') ? [alertEl] : [],
      body: { innerText: "" },
    },
    location: { href: 'https://flow.google.com' },
  });

  vm.runInContext(domUtilsSource, context);
  const checkFlowCreditLimitAlert = context.globalThis.checkFlowCreditLimitAlert;

  const detected = checkFlowCreditLimitAlert();
  assert.match(detected, /run out of credits/i);

  // Clean DOM without alert
  const cleanContext = vm.createContext({
    globalThis: {},
    window: {},
    URL,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    document: {
      querySelectorAll: () => [],
      body: { innerText: "Welcome to Flow" },
    },
    location: { href: 'https://flow.google.com' },
  });
  vm.runInContext(domUtilsSource, cleanContext);
  assert.equal(cleanContext.globalThis.checkFlowCreditLimitAlert(), null);
});

test('clearExistingIngredientChips removes stale reference chips before attaching new ones', async () => {
  const domUtilsSource = readFileSync(new URL('../extension/src/content/shared/dom-utils.js', import.meta.url), 'utf8');
  let removedCount = 0;
  let chips;
  const removeButton = {
    name: 'Remove ingredient',
    disabled: false,
    getAttribute: name => name === 'aria-label' ? 'Remove ingredient' : null,
    click: () => { chips.shift(); removedCount++; },
  };
  chips = [
    {
      nodeType: 1,
      tagName: 'DIV',
      matches: selector => selector.includes("[role='listitem']"),
      hasAttribute: () => false,
      name: 'Ingredient: Old Cat',
      innerText: 'Ingredient: Old Cat',
      getAttribute: () => null,
      getBoundingClientRect: () => ({ width: 100, height: 30 }),
      querySelectorAll: selector => selector.includes('button') ? [removeButton] : [],
    }
  ];
  const composer = { querySelectorAll: selector => selector.includes('button') || selector.includes('role="button"') || selector.includes('role="listitem"') || selector.includes('mat-chip') || selector.includes('data-chip') ? chips : [] };
  const editor = { closest: selector => selector.includes('composer') ? composer : null };

  const context = vm.createContext({
    globalThis: {},
    window: {},
    URL,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    setTimeout: fn => fn(),
    clearTimeout: () => {},
    document: {
      querySelector: selector => selector.includes('.ProseMirror') ? editor : null,
      querySelectorAll: selector => selector.includes('button') ? chips : [],
    },
    location: { href: 'https://flow.google.com' },
    accessibleName: el => el.name || el.innerText || '',
    flowButton: () => null,
  });

  vm.runInContext(domUtilsSource, context);
  const clearExistingIngredientChips = context.globalThis.clearExistingIngredientChips;

  await clearExistingIngredientChips();
  assert.equal(removedCount, 1);
  assert.equal(chips.length, 0);
});

test('clearExistingIngredientChips removes the exact button[aria-label="Ingredient"] chip used by attach diagnostics', async () => {
  const domUtilsSource = readFileSync(new URL('../extension/src/content/shared/dom-utils.js', import.meta.url), 'utf8');
  let chips;
  const ingredientChip = {
    nodeType: 1,
    tagName: 'BUTTON',
    name: 'Ingredient',
    innerText: 'cancel',
    textContent: 'cancel',
    disabled: false,
    isConnected: true,
    matches: selector => selector.includes('button[aria-label="Ingredient"]'),
    hasAttribute: () => false,
    getAttribute: name => name === 'aria-label' ? 'Ingredient' : null,
    getBoundingClientRect: () => ({ width: 28, height: 28 }),
    querySelectorAll: () => [],
    click: () => { chips.shift(); },
  };
  chips = [ingredientChip];
  const composer = { querySelectorAll: selector => selector.includes('button[aria-label="Ingredient"]') ? chips : [] };
  const editor = { closest: selector => selector.includes('prompt-box') ? composer : null };
  const context = vm.createContext({
    globalThis: {}, window: {}, URL,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    setTimeout: fn => { fn(); return 0; }, clearTimeout: () => {},
    document: { querySelector: selector => selector.includes('.ProseMirror') ? editor : null, querySelectorAll: () => [] },
    location: { href: 'https://flow.google.com' },
    accessibleName: el => el.getAttribute?.('aria-label') || el.innerText || '',
    flowButton: () => null,
  });
  vm.runInContext(domUtilsSource, context);

  const result = await context.globalThis.clearExistingIngredientChips();
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { cleared: 1, remaining: 0 });
  assert.equal(chips.length, 0);
  assert.equal(context.globalThis.inspectFlowReferenceClearDiagnostics().chipCount, 0);
});

test('Vietnamese localization: readGenerationCreditQuote accurately parses Vietnamese credit text', () => {
  const domUtilsSource = readFileSync(new URL('../extension/src/content/shared/dom-utils.js', import.meta.url), 'utf8');
  const makeContext = text => {
    const ctx = vm.createContext({
      globalThis: {},
      window: {},
      document: {
        body: { innerText: text },
        querySelectorAll: () => [],
      },
      location: { href: 'https://flow.google.com/u/0/?hl=vi' },
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
      accessibleName: el => el.innerText || '',
    });
    vm.runInContext(domUtilsSource, ctx);
    return ctx.globalThis.readGenerationCreditQuote;
  };

  assert.equal(makeContext('Quá trình tạo sẽ dùng 20 tín dụng.')(), 20);
  assert.equal(makeContext('Sẽ sử dụng 10 tín dụng để tạo video')(), 10);
  assert.equal(makeContext('Tiêu tốn 5 tín dụng')(), 5);
  assert.equal(makeContext('Generating will use 30 credits')(), 30);
});

test('Vietnamese localization: flowButton recognizes Vietnamese button synonyms and icons', () => {
  const domUtilsSource = readFileSync(new URL('../extension/src/content/shared/dom-utils.js', import.meta.url), 'utf8');
  const buttons = [
    { innerText: 'Cài đặt', querySelector: () => null, getAttribute: () => null, disabled: false, getBoundingClientRect: () => ({ width: 100, height: 30 }) },
    { innerText: 'Bắt đầu tạo', querySelector: () => null, getAttribute: () => null, disabled: false, getBoundingClientRect: () => ({ width: 100, height: 30 }) },
    { innerText: 'Xóa câu lệnh', querySelector: () => null, getAttribute: () => null, disabled: false, getBoundingClientRect: () => ({ width: 100, height: 30 }) },
    { innerText: 'Quay lại', querySelector: () => null, getAttribute: () => null, disabled: false, getBoundingClientRect: () => ({ width: 100, height: 30 }) },
  ];

  const ctx = vm.createContext({
    globalThis: {},
    window: {},
    document: {
      querySelectorAll: selector => selector.includes('button') ? buttons : [],
      getElementById: () => null,
    },
    location: { href: 'https://flow.google.com/u/0/?hl=vi' },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    accessibleName: el => el.innerText || '',
  });
  vm.runInContext(domUtilsSource, ctx);
  const flowButton = ctx.globalThis.flowButton;

  assert.equal(flowButton('Settings trigger'), buttons[0]);
  assert.equal(flowButton('Start generation'), buttons[1]);
  assert.equal(flowButton('Clear prompt'), buttons[2]);
  assert.equal(flowButton('Back'), buttons[3]);
});

test('Vietnamese upload, confirmation, and character save labels resolve as exact aliases', () => {
  const domUtilsSource = readFileSync(new URL('../extension/src/content/shared/dom-utils.js', import.meta.url), 'utf8');
  const buttons = ['Tải lên tệp', 'Xác nhận', 'Hoàn tất'].map(name => ({ name, innerText: name, querySelector: () => null,
    getAttribute: () => null, disabled: false, getBoundingClientRect: () => ({ width: 100, height: 30 }) }));
  const context = vm.createContext({ globalThis: {}, window: {},
    document: { querySelectorAll: selector => selector.includes('button') ? buttons : [], getElementById: () => null },
    location: { href: 'https://flow.google.com/u/0/?hl=vi' },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    accessibleName: element => element.name || element.innerText || '',
  });
  vm.runInContext(domUtilsSource, context);
  assert.equal(context.globalThis.flowButton('Upload file'), buttons[0]);
  assert.equal(context.globalThis.flowButton('Confirm'), buttons[1]);
  assert.equal(context.globalThis.flowButton('Done editing'), buttons[2]);
});

test('video upload confirmation accepts one exact Vietnamese action and rejects ambiguous aliases', async () => {
  function makeContext(labels) {
    let clicks = 0;
    const buttons = labels.map(name => ({ name, innerText: name, disabled: false, click() { clicks++; }, getAttribute: () => null }));
    const dialog = { innerText: 'Tải lên video', textContent: 'Tải lên video', contains: child => buttons.includes(child), querySelectorAll: selector => selector === 'button,[role=button]' ? buttons : [] };
    const document = { querySelectorAll: selector => selector === '[role="dialog"],mat-dialog-container' ? [dialog] : [] };
    const context = vm.createContext({ document, Date, wait: async () => {}, visible: () => true, accessibleName: element => element.name || element.innerText || '',
      flowError: (code, message, retryable, outcome_unknown) => Object.assign(new Error(message), { code, retryable, outcome_unknown }),
    });
    vm.runInContext(source, context);
    return { api: context.FlowComponents, clicks: () => clicks };
  }
  const single = makeContext(['Tiếp tục']);
  const result = await single.api.confirmVideoUploadIfPrompted(Date.now() + 1000);
  assert.equal(result.confirmationDialogSeen, true);
  assert.equal(result.confirmationButtonClicked, true);
  assert.equal(single.clicks(), 1);

  const ambiguous = makeContext(['Tải lên', 'Xác nhận']);
  await assert.rejects(ambiguous.api.confirmVideoUploadIfPrompted(Date.now() + 1000), error => error.code === 'FLOW_UPLOAD_CONFIRMATION_AMBIGUOUS');
  assert.equal(ambiguous.clicks(), 0);
});

test('Vietnamese empty asset and voice picker messages settle without waiting for options', async () => {
  const context = vm.createContext({ document: { querySelectorAll: () => [] }, visible: () => true, wait: async () => {},
    flowError: (code, message) => Object.assign(new Error(message), { code }) });
  vm.runInContext(charactersSource, context);
  for (const [label, text] of [['asset', 'Không tìm thấy tài sản nào'], ['voice', 'Không có giọng nói nào']]) {
    const list = { innerText: text, querySelectorAll: () => [] };
    assert.equal(await context.FlowCharacterActions.waitForPicker(() => list, label, 100), list);
  }
});

test('duplicate Vietnamese upload category and action targets fail closed', () => {
  const context = vm.createContext({ window: {}, flowError: (code, message) => Object.assign(new Error(message), { code }) });
  vm.runInContext(source, context);
  const api = context.FlowComponents;
  assert.throws(() => api.resolveUniqueUploadTarget([{ label: 'Tải lên' }, { label: 'Tải lên' }], 'FLOW_UPLOAD_CATEGORY_AMBIGUOUS', 'Upload category'),
    error => error.code === 'FLOW_UPLOAD_CATEGORY_AMBIGUOUS');
  assert.throws(() => api.resolveUniqueUploadTarget([{ label: 'Tải tệp lên' }, { label: 'Tải tệp lên' }], 'FLOW_UPLOAD_MENU_ITEM_AMBIGUOUS', 'Upload action'),
    error => error.code === 'FLOW_UPLOAD_MENU_ITEM_AMBIGUOUS');
});

test('All media navigation refuses duplicate exact Vietnamese targets', () => {
  const navigationSource = readFileSync(new URL('../extension/src/content/providers/flow/core/navigation.js', import.meta.url), 'utf8');
  const items = ['Tất cả nội dung nghe nhìn', 'Tất cả nội dung nghe nhìn'].map(text => ({ innerText: text, textContent: text,
    disabled: false, getAttribute: () => null, querySelectorAll: () => [], closest: () => ({}) }));
  const navigation = { getAttribute: () => 'Điều hướng dự án', querySelector: () => null,
    querySelectorAll: selector => selector.includes('a,button') ? items : [] };
  const context = vm.createContext({ document: { body: {}, querySelectorAll: selector => selector === 'nav,[role="navigation"],mat-sidenav' ? [navigation] : [],
    querySelector: () => navigation }, visible: () => true, accessibleName: () => 'Điều hướng dự án' });
  vm.runInContext(navigationSource, context);
  assert.equal(context.FlowNavigation.flowNavigationItem('All media'), null);
  assert.equal(context.FlowNavigation.clickFlowNavigation('All media'), false);
});

test('asset rename and trash actions match exact Vietnamese menu labels', async () => {
  const uuid = '22222222-2222-4222-8222-222222222222';
  async function run(operation, localizedAction) {
    let clicks = 0;
    let menuOpen = false;
    let title = 'Original asset';
    const tile = {
      scrollIntoView() {},
      getAttribute: key => key === 'aria-label' ? title : null,
    };
    const menuItem = { innerText: localizedAction, getAttribute: key => key === 'role' ? 'menuitem' : null,
      click() { clicks++; } };
    const input = { value: '', dispatchEvent(event) {
      if (event.type === 'keyup' && event.key === 'Enter') title = this.value;
    } };
    const dialog = { querySelectorAll: selector => selector.includes('input') ? [input] : [] };
    const document = { querySelectorAll(selector) {
      if (selector === '[role="menuitem"]') return menuOpen ? [menuItem] : [];
      if (selector === '[role="dialog"],mat-dialog-container,.cdk-overlay-pane') return operation === 'rename' && clicks > 0 ? [dialog] : [];
      if (selector === 'flow-grid-tile-container') return operation === 'trash' && clicks > 0 ? [] : [tile];
      return [];
    } };
    const more = { click() { menuOpen = true; } };
    const context = vm.createContext({ document, location: { pathname: '/project/test' }, Date,
      FlowTiles: { countFlowTitleAcrossGrid: async () => 1, findFlowTile: async () => tile },
      FlowMediaMenu: { scanNativeAssets: async () => [{ name: 'Original asset', id: uuid }] },
      visible: () => true, accessibleName: element => element.innerText || '', mediaId: () => uuid,
      flowButton: name => name === 'More options' ? more : null,
      wait: async () => {}, Event: class { constructor(type) { this.type = type; } },
      KeyboardEvent: class { constructor(type, detail) { this.type = type; Object.assign(this, detail); } },
    });
    vm.runInContext(libraryOperationsSource, context);
    const adapter = new context.FlowLibraryOperations({ error: (code, message, retryable, outcome_unknown) => Object.assign(new Error(message), { code, retryable, outcome_unknown }) });
    const result = await adapter.execute(operation === 'rename' ? 'flow.asset.rename' : 'flow.asset.trash',
      operation === 'rename' ? { name: 'Original asset', newName: 'Renamed asset' } : { name: 'Original asset' }, { timeoutMs: 1000 });
    return { result, clicks };
  }
  const renamed = await run('rename', 'Đổi tên tệp');
  assert.equal(renamed.result.name, 'Renamed asset');
  assert.equal(renamed.clicks, 1);
  const trashed = await run('trash', 'Đưa vào thùng rác');
  assert.deepEqual(JSON.parse(JSON.stringify(trashed.result)), { trashed: 'Original asset' });
  assert.equal(trashed.clicks, 1);
});

test('Vietnamese localization: flowRadio and flowNavigationItem resolve Vietnamese labels', () => {
  const domUtilsSource = readFileSync(new URL('../extension/src/content/shared/dom-utils.js', import.meta.url), 'utf8');
  const radios = [
    { innerText: 'Hình ảnh', name: 'Hình ảnh', getAttribute: () => null, querySelectorAll: () => [], getBoundingClientRect: () => ({ width: 100, height: 30 }) },
    { innerText: 'Thành phần', name: 'Thành phần', getAttribute: () => null, querySelectorAll: () => [], getBoundingClientRect: () => ({ width: 100, height: 30 }) },
  ];
  const navItems = [
    { innerText: 'Tất cả nội dung nghe nhìn', name: 'Tất cả nội dung nghe nhìn', getAttribute: () => null, querySelectorAll: () => [], getBoundingClientRect: () => ({ width: 100, height: 30 }) },
    { innerText: 'Nhân vật', name: 'Nhân vật', getAttribute: () => null, querySelectorAll: () => [], getBoundingClientRect: () => ({ width: 100, height: 30 }) },
  ];

  const ctx = vm.createContext({
    globalThis: {},
    window: {},
    document: {
      querySelectorAll: selector => {
        if (selector.includes('role="radio"')) return radios;
        if (selector.includes('role="button"]') || selector.includes('mat-list-item')) return navItems;
        return [];
      },
      querySelector: () => null,
    },
    location: { href: 'https://flow.google.com/u/0/?hl=vi' },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    accessibleName: el => el.name || el.innerText || '',
  });
  vm.runInContext(domUtilsSource, ctx);

  assert.equal(ctx.globalThis.flowRadio('Image'), radios[0]);
  assert.equal(ctx.globalThis.flowRadio('Ingredients'), radios[1]);
  assert.equal(ctx.globalThis.flowNavigationItem('All media'), navItems[0]);
  assert.equal(ctx.globalThis.flowNavigationItem('Characters'), navItems[1]);
});

test('Vietnamese localization: ensureFlowLibrarySection("All media") succeeds safely when already at project root editor', async () => {
  const domUtilsSource = readFileSync(new URL('../extension/src/content/shared/dom-utils.js', import.meta.url), 'utf8');
  const ctx = vm.createContext({
    globalThis: {},
    window: {},
    document: {
      querySelectorAll: selector => {
        if (selector.includes('.ProseMirror')) return [{ innerText: '' }];
        return [];
      },
      querySelector: selector => {
        if (selector.includes('.ProseMirror')) return { innerText: '' };
        return null;
      },
    },
    location: { href: 'https://flow.google.com/u/0/project/proj_123', pathname: '/project/proj_123' },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    accessibleName: () => '',
  });
  vm.runInContext(domUtilsSource, ctx);

  // Even if no navigation item exists in the sidebar, ensureFlowLibrarySection("All media") must not throw
  const result = await ctx.globalThis.ensureFlowLibrarySection('All media');
  assert.equal(result, true);
});

test('Characters navigation waits for project sidebar controls to mount', async () => {
  const domUtilsSource = readFileSync(new URL('../extension/src/content/shared/dom-utils.js', import.meta.url), 'utf8');
  const navigationSource = readFileSync(new URL('../extension/src/content/providers/flow/core/navigation.js', import.meta.url), 'utf8');
  let ticks = 0;
  let clicked = false;
  const navButton = { innerText: 'Characters', disabled: false, getAttribute: () => null, querySelectorAll: () => [], getBoundingClientRect: () => ({ width: 100, height: 30 }), click: () => { clicked = true; } };
  const createTile = { innerText: 'New character', textContent: 'New character', querySelectorAll: selector => selector === 'mat-icon' ? [{ innerText: 'add', textContent: 'add' }] : [], getBoundingClientRect: () => ({ width: 100, height: 30 }) };
  const document = {
    body: {},
    activeElement: { closest: () => null },
    querySelector: selector => selector.includes('.ProseMirror') ? {} : null,
    querySelectorAll: selector => {
      if (selector === 'nav,[role="navigation"],mat-sidenav') return [];
      if (selector.startsWith('a,button,')) return ticks >= 300 ? [navButton] : [];
      if (selector === 'flow-custom-tile') return clicked ? [createTile] : [];
      if (selector.includes('progressbar') || selector.includes('aria-busy')) return [];
      return [];
    },
  };
  const context = vm.createContext({
    window: {}, document,
    location: { href: 'https://flow.google.com/u/0/project/proj_123', pathname: '/project/proj_123' },
    Date: class MockDate extends Date { static now() { return ticks; } },
    visible: () => true,
    accessibleName: el => el.innerText || '',
    FlowUiDeadline: { requireTime: () => {}, boundedWait: async ms => { ticks += ms; } },
    wait: async ms => { ticks += ms; },
    flowError: (code, message, retryable) => Object.assign(new Error(message), { code, retryable }),
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
  });
  vm.runInContext(domUtilsSource, context);
  vm.runInContext(navigationSource, context);

  await context.ensureFlowLibrarySection('Characters');
  assert.equal(clicked, true, 'the Characters item is clicked after it mounts');
});

test('flow.characters.list uses the bounded library scanner instead of the composer add-menu picker', async () => {
  const source = readFileSync(new URL('../extension/src/content/providers/flow/library/library-operations.js', import.meta.url), 'utf8');
  let receivedDeadline;
  let libraryScanCalled = false;
  const context = vm.createContext({
    FlowUiDeadline: { makeDeadline: () => 12_345 },
    FlowReferenceActions: { listCharacters: async () => { throw new Error('The add-menu picker is not used for library listing.'); } },
    FlowMediaMenu: { scanNativeCharacters: async options => { libraryScanCalled = true; receivedDeadline = options.deadline; return [{ name: 'MCP character', uuid: '22222222-2222-4222-8222-222222222222' }]; } },
    Date,
  });
  vm.runInContext(source, context);
  const operations = new context.FlowLibraryOperations({ error: (code, message, retryable) => Object.assign(new Error(message), { code, retryable }) });

  const result = await operations.execute('flow.characters.list', {}, { timeoutMs: 30_000 });
  assert.deepEqual(result, [{ name: 'MCP character', uuid: '22222222-2222-4222-8222-222222222222' }]);
  assert.equal(receivedDeadline, 12_345);
  assert.equal(libraryScanCalled, true, 'listing uses the complete Characters library scan');
});

test('Flow Characters navigation recognizes its face icon', () => {
  const domUtilsSource = readFileSync(new URL('../extension/src/content/shared/dom-utils.js', import.meta.url), 'utf8');
  const navigationSource = readFileSync(new URL('../extension/src/content/providers/flow/core/navigation.js', import.meta.url), 'utf8');
  const icon = { innerText: 'face', textContent: 'face' };
  const button = { innerText: '', disabled: false, getAttribute: () => null, querySelectorAll: () => [icon], getBoundingClientRect: () => ({ width: 40, height: 40 }) };
  const navigation = { querySelector: () => ({}), querySelectorAll: selector => selector.startsWith('a,button,') ? [button] : [] };
  const context = vm.createContext({
    window: {},
    document: { body: {}, querySelectorAll: selector => selector === 'nav,[role="navigation"],mat-sidenav' ? [navigation] : [], querySelector: () => navigation },
    location: { href: 'https://flow.google.com/u/0/project/proj_123', pathname: '/project/proj_123' },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
  });
  vm.runInContext(domUtilsSource, context);
  vm.runInContext(navigationSource, context);
  assert.equal(context.FlowNavigation.flowNavigationItem('Characters'), button);
});

test('character picker list fails rather than returning partial names when its scroller stalls', async () => {
  const source = flowComponentsSource;
  let ticks = 0;
  let pickerOpen = false;
  const opener = { getAttribute: () => pickerOpen ? 'true' : 'false', click: () => { pickerOpen = !pickerOpen; }, querySelector: () => null, closest: () => null };
  const submit = {};
  const editor = { isContentEditable: true, parentElement: null };
  const composer = { tagName: 'DIV', className: 'flow-composer', contains: node => node === editor || node === submit || node === opener,
    querySelectorAll: selector => selector === 'button,[role="button"],mat-button,[tabindex="0"]' ? [opener] : [] };
  editor.parentElement = composer;
  const option = { innerText: 'Pip', textContent: 'Pip', getAttribute: () => null, querySelectorAll: () => [] };
  const scroller = { clientHeight: 100, scrollHeight: 1000, get scrollTop() { return 0; }, set scrollTop(_value) {} };
  const list = { innerText: '', getAttribute: name => name === 'role' ? 'listbox' : null, querySelectorAll: selector => selector === '[role="option"]' ? [option] : selector === '*' ? [scroller] : [] };
  const tab = { innerText: 'Characters', getAttribute: name => name === 'aria-selected' ? 'true' : null, click: () => {} };
  const context = vm.createContext({
    window: {}, location: { href: 'https://flow.google.com/u/0/project/proj_123', pathname: '/project/proj_123' },
    Date: class MockDate extends Date { static now() { return ticks; } },
    visible: () => true,
    accessibleName: el => el.innerText || '',
    flowButton: name => name === 'Add ingredients to the prompt box' ? opener : null,
    flowQuery: selector => selector === 'editor' ? editor : selector === 'composerRoot' ? composer : null,
    FlowEditor: { getFlowSubmitButton: () => submit },
    flowQueryAll: () => null,
    wait: async ms => { ticks += ms; },
    flowError: (code, message, retryable, outcome_unknown) => Object.assign(new Error(message), { code, retryable, outcome_unknown }),
    document: {
      activeElement: { dispatchEvent: () => {} }, dispatchEvent: () => {},
      querySelectorAll: selector => {
        if (selector === '[role="listbox"]') return pickerOpen ? [list] : [];
        if (selector === '[role="tab"]') return pickerOpen ? [tab] : [];
        if (selector === '[role="progressbar"],[aria-busy="true"]') return [];
        if (selector === 'button[aria-label="Ingredient"]' || selector === 'button[aria-label="Thành phần"],button[aria-label="Nguyên liệu"]') return [];
        if (selector === 'button,[role="button"]') return [opener];
        if (selector === '[role="dialog"],main,[role="listbox"]') return pickerOpen ? [list] : [];
        return [];
      },
    },
  });
  vm.runInContext(source, context);
  await assert.rejects(context.FlowReferenceActions.listCharacters(), error =>
    error.code === 'FLOW_CHARACTER_SCAN_INCOMPLETE' && /no complete list/.test(error.message));
  assert.equal(pickerOpen, false, 'the picker is closed after the scan fails');
});

test('I18n core: translations, plurals, string interpolation and UI pattern lookup work seamlessly', async () => {
  const i18nSource = readFileSync(new URL('../extension/src/content/shared/i18n.js', import.meta.url), 'utf8');
  const ctx = vm.createContext({
    globalThis: {},
    self: {},
    console,
  });
  vm.runInContext(i18nSource, ctx);

  const I18n = ctx.globalThis.I18n;
  assert.ok(I18n, 'I18n class must be exported to globalThis');

  // Default locale is Vietnamese
  assert.equal(I18n.getLocale(), 'vi');
  assert.equal(I18n.t('popup.wsConnected'), 'Đã kết nối backend');
  assert.equal(I18n.t('popup.tabsCount', 3), '3 tab đang mở');
  assert.equal(I18n.t('errors.navUnavailable', { label: 'All media' }), 'Không thể mở mục "All media" từ giao diện này.');

  // Check pattern lookup in VI
  const viPatterns = I18n.getPatterns('all_media');
  assert.ok(viPatterns.includes('tất cả nội dung nghe nhìn'));
  assert.ok(viPatterns.includes('all media'));

  // Switch to English
  await I18n.setLocale('en');
  assert.equal(I18n.getLocale(), 'en');
  assert.equal(I18n.t('popup.wsConnected'), 'Backend connected');
  assert.equal(I18n.t('popup.tabsCount', 1), '1 open tab');
  assert.equal(I18n.t('popup.tabsCount', 4), '4 open tabs');
  assert.equal(I18n.t('errors.navUnavailable', { label: 'All media' }), 'Flow\'s project navigation could not open "All media" from this view.');

  // Pattern lookup still works in EN and includes synonyms
  const enPatterns = I18n.getPatterns('start_generation');
  assert.ok(enPatterns.includes('start generation'));
  assert.ok(enPatterns.includes('generate'));
  assert.ok(enPatterns.includes('tạo'));
});

test('Vietnamese localization anti-misclick: flowButton("More options") never matches "Thêm thành phần" or "Thêm"', () => {
  const domUtilsSource = readFileSync(new URL('../extension/src/content/shared/dom-utils.js', import.meta.url), 'utf8');
  const buttons = [
    { innerText: 'Thêm thành phần', name: 'Thêm thành phần', querySelector: () => null, getAttribute: () => null, disabled: false, getBoundingClientRect: () => ({ width: 100, height: 30 }) },
    { innerText: 'Thêm vào dự án', name: 'Thêm vào dự án', querySelector: () => null, getAttribute: () => null, disabled: false, getBoundingClientRect: () => ({ width: 100, height: 30 }) },
    { innerText: '', name: 'Tùy chọn khác', querySelector: (s) => s.includes('mat-icon') ? { textContent: 'more_vert' } : null, getAttribute: () => 'Tùy chọn khác', disabled: false, getBoundingClientRect: () => ({ width: 30, height: 30 }) },
  ];

  const ctx = vm.createContext({
    globalThis: {},
    window: {},
    document: {
      querySelectorAll: selector => selector.includes('button') ? buttons : [],
      getElementById: () => null,
    },
    location: { href: 'https://flow.google.com/u/0/?hl=vi' },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    accessibleName: el => el.name || el.innerText || '',
  });
  vm.runInContext(domUtilsSource, ctx);
  const flowButton = ctx.globalThis.flowButton;

  const matched = flowButton('More options');
  // Must match the 3-dots button, NOT "Thêm thành phần"
  assert.equal(matched, buttons[2]);
});

test('Vietnamese localization anti-misclick: getFlowSubmitButton prioritizes composer submit button over header "+ Tạo" or "Tạo dự án"', () => {
  const domUtilsSource = readFileSync(new URL('../extension/src/content/shared/dom-utils.js', import.meta.url), 'utf8');
  const editorSource = readFileSync(new URL('../extension/src/content/providers/flow/composer/flow-editor.js', import.meta.url), 'utf8');

  const headerCreateBtn = {
    innerText: 'Tạo dự án',
    name: 'Tạo dự án',
    disabled: false,
    getAttribute: () => null,
    getBoundingClientRect: () => ({ width: 100, height: 36 }),
    closest: (s) => s.includes('header') ? {} : null,
    querySelector: () => null,
  };

  const composerSubmitBtn = {
    innerText: 'Bắt đầu tạo',
    name: 'Bắt đầu tạo',
    disabled: false,
    getAttribute: (a) => a === 'type' ? 'submit' : null,
    getBoundingClientRect: () => ({ width: 120, height: 40 }),
    closest: (s) => s.includes('composer') ? {} : null,
    querySelector: (s) => s.includes('mat-icon') ? { textContent: 'arrow_forward' } : null,
  };

  const composerContainer = {
    querySelectorAll: (s) => s.includes('button') ? [composerSubmitBtn] : [],
    contains: element => element === composerSubmitBtn,
  };

  const proseMirror = {
    isContentEditable: true,
    innerText: 'A magical landscape in Vietnam',
    closest: (s) => s.includes('composer') ? composerContainer : null,
    getBoundingClientRect: () => ({ width: 500, height: 80 }),
  };

  const allButtons = [headerCreateBtn, composerSubmitBtn];

  const ctx = vm.createContext({
    globalThis: {},
    window: {},
    document: {
      querySelectorAll: (selector) => {
        if (selector.includes('.ProseMirror')) return [proseMirror];
        if (selector.includes('button')) return allButtons;
        return [];
      },
      querySelector: (selector) => {
        if (selector.includes('.ProseMirror')) return proseMirror;
        if (selector.includes('composer')) return composerContainer;
        return null;
      },
    },
    location: { href: 'https://flow.google.com/u/0/?hl=vi' },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    accessibleName: el => el.name || el.innerText || '',
  });

  vm.runInContext(domUtilsSource, ctx);
  vm.runInContext(editorSource, ctx);

  const getFlowSubmitButton = ctx.globalThis.getFlowSubmitButton;
  const submitButton = getFlowSubmitButton('A magical landscape in Vietnam');

  assert.equal(submitButton, composerSubmitBtn);
});

test('Vietnamese localization anti-misclick: flowNavigationItem never misclicks "Nội dung tải lên" or "Tất cả dự án" as All media', () => {
  const domUtilsSource = readFileSync(new URL('../extension/src/content/shared/dom-utils.js', import.meta.url), 'utf8');
  const navItems = [
    { innerText: 'Nội dung tải lên', name: 'Nội dung tải lên', getAttribute: () => null, querySelectorAll: () => [], getBoundingClientRect: () => ({ width: 150, height: 30 }) },
    { innerText: 'Tất cả dự án', name: 'Tất cả dự án', getAttribute: () => null, querySelectorAll: () => [], getBoundingClientRect: () => ({ width: 150, height: 30 }) },
    { innerText: 'Tất cả nội dung nghe nhìn', name: 'Tất cả nội dung nghe nhìn', getAttribute: () => null, querySelectorAll: () => [{ textContent: 'perm_media' }], getBoundingClientRect: () => ({ width: 150, height: 30 }) },
  ];

  const ctx = vm.createContext({
    globalThis: {},
    window: {},
    document: {
      querySelectorAll: selector => selector.includes('button') || selector.includes('a') ? navItems : [],
      querySelector: () => null,
    },
    location: { href: 'https://flow.google.com/u/0/?hl=vi' },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    accessibleName: el => el.name || el.innerText || '',
  });
  vm.runInContext(domUtilsSource, ctx);
  const flowNavigationItem = ctx.globalThis.flowNavigationItem;

  const matched = flowNavigationItem('All media');
  // Must match exact "Tất cả nội dung nghe nhìn", NOT "Nội dung tải lên" or "Tất cả dự án"
  assert.equal(matched, navItems[2]);
});

test('FlowTiles: isTileBusy and isTileMediaReady correctly distinguish rendering vs finished tiles', () => {
  const domUtilsSource = readFileSync(new URL('../extension/src/content/shared/dom-utils.js', import.meta.url), 'utf8');
  const tilesSource = readFileSync(new URL('../extension/src/content/providers/flow/generation/tiles.js', import.meta.url), 'utf8');

  const ctx = vm.createContext({
    globalThis: {},
    window: {},
    document: { querySelectorAll: () => [], querySelector: () => null },
    location: { href: 'https://flow.google.com/u/0/?hl=vi' },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    accessibleName: el => el.innerText || '',
  });
  vm.runInContext(domUtilsSource, ctx);
  vm.runInContext(tilesSource, ctx);

  const { isTileBusy, isTileMediaReady } = ctx.globalThis.FlowTiles;

  // Case 1: Tile with mat-progress-spinner / loading spinner
  const spinnerTile = {
    innerText: '',
    textContent: '',
    getAttribute: () => null,
    querySelector: sel => sel.includes('spinner') ? {} : null,
    querySelectorAll: () => [],
  };
  assert.equal(isTileBusy(spinnerTile), true, 'Spinner tile must be flagged as busy');
  assert.equal(isTileMediaReady(spinnerTile), false, 'Spinner tile must NOT be mediaReady');

  // Case 2: Tile with Vietnamese progress text: "Đang tạo... 45%"
  const viProgressTile = {
    innerText: 'Đang tạo... 45%',
    textContent: 'Đang tạo... 45%',
    getAttribute: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  assert.equal(isTileBusy(viProgressTile), true, 'Tile with Vietnamese percentage must be busy');
  assert.equal(isTileMediaReady(viProgressTile), false, 'Tile with Vietnamese percentage must NOT be mediaReady');

  // Case 3: Tile with English text: "Generating 80%"
  const enProgressTile = {
    innerText: 'Generating 80%',
    textContent: 'Generating 80%',
    getAttribute: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  assert.equal(isTileBusy(enProgressTile), true, 'Tile with English percentage must be busy');
  assert.equal(isTileMediaReady(enProgressTile), false, 'Tile with English percentage must NOT be mediaReady');

  // Case 4: Newly created empty tile without loaded media and without spinner yet
  const emptyTile = {
    innerText: 'scene-01',
    textContent: 'scene-01',
    getAttribute: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  assert.equal(isTileBusy(emptyTile), true, 'Empty newly created tile must be busy/pending');
  assert.equal(isTileMediaReady(emptyTile), false, 'Empty newly created tile must NOT be mediaReady');

  // Case 5: Completed image tile with loaded image
  const finishedImgTile = {
    innerText: 'scene-01',
    textContent: 'scene-01',
    getAttribute: attr => attr === 'aria-label' ? 'scene-01' : null,
    querySelector: () => null,
    querySelectorAll: sel => sel.includes('img') ? [{
      src: 'https://flow.google.com/asb/test-image-123',
      currentSrc: 'https://flow.google.com/asb/test-image-123',
      complete: true,
      naturalWidth: 1024,
      naturalHeight: 768,
    }] : [],
  };
  assert.equal(isTileBusy(finishedImgTile), false, 'Finished image tile must NOT be busy');
  assert.equal(isTileMediaReady(finishedImgTile), true, 'Finished image tile MUST be mediaReady');

  // Case 6: Completed video tile with loaded poster
  const finishedVideoTile = {
    innerText: 'scene-02',
    textContent: 'scene-02',
    getAttribute: attr => attr === 'aria-label' ? 'scene-02' : null,
    querySelector: sel => sel.includes('flow-video-tile') ? {
      querySelector: sub => sub.includes('img') ? {
        complete: true,
        naturalWidth: 1280,
      } : null,
    } : null,
    querySelectorAll: () => [],
  };
  assert.equal(isTileBusy(finishedVideoTile), false, 'Finished video tile must NOT be busy');
  assert.equal(isTileMediaReady(finishedVideoTile), true, 'Finished video tile MUST be mediaReady');
});

test('FlowTiles: Error tile with retry button or Vietnamese failure text is immediately marked failed and not busy', () => {
  const domUtilsSource = readFileSync(new URL('../extension/src/content/shared/dom-utils.js', import.meta.url), 'utf8');
  const tilesSource = readFileSync(new URL('../extension/src/content/providers/flow/generation/tiles.js', import.meta.url), 'utf8');

  const ctx = vm.createContext({
    globalThis: {},
    window: {},
    document: { querySelectorAll: () => [], querySelector: () => null },
    location: { href: 'https://flow.google.com/u/0/?hl=vi' },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    accessibleName: el => el.innerText || '',
  });
  vm.runInContext(domUtilsSource, ctx);
  vm.runInContext(tilesSource, ctx);

  const { isTileBusy, isTileMediaReady, collectNativeMedia } = ctx.globalThis.FlowTiles;

  const retryTile = {
    innerText: 'Thử lại',
    textContent: 'Thử lại',
    getAttribute: attr => attr === 'aria-label' ? 'Lỗi tạo ảnh' : null,
    querySelector: () => null,
    querySelectorAll: sel => sel.includes('button') ? [{
      getAttribute: a => a === 'aria-label' ? 'Thử lại' : null,
      innerText: 'Thử lại',
    }] : [],
  };

  assert.equal(isTileBusy(retryTile), false, 'Tile with retry button must NOT be marked busy');
  assert.equal(isTileMediaReady(retryTile), false, 'Tile with retry button must NOT be marked mediaReady');

  ctx.document.querySelectorAll = sel => sel.includes('flow-grid-tile-container') ? [retryTile] : [];
  const media = collectNativeMedia();
  assert.equal(media.length, 1);
  assert.equal(media[0].failed, true, 'Tile with retry button must be marked failed: true');
  assert.equal(media[0].busy, false, 'Tile with retry button must have busy: false');
});

test('FlowEditor: currentFlowSubmitErrors detects Angular MDC snackbars and Vietnamese failure toasts', () => {
  const domUtilsSource = readFileSync(new URL('../extension/src/content/shared/dom-utils.js', import.meta.url), 'utf8');
  const editorSource = readFileSync(new URL('../extension/src/content/providers/flow/composer/flow-editor.js', import.meta.url), 'utf8');

  const snackbarEl = {
    innerText: 'Đã xảy ra lỗi. Vui lòng thử lại sau',
    textContent: 'Đã xảy ra lỗi. Vui lòng thử lại sau',
    getBoundingClientRect: () => ({ width: 300, height: 48 }),
  };

  const ctx = vm.createContext({
    globalThis: {},
    window: {},
    document: {
      querySelectorAll: sel => {
        if (sel.includes('mat-snack-bar-container') || sel.includes('.mat-mdc-snack-bar-label')) return [snackbarEl];
        return [];
      },
      querySelector: () => null,
    },
    location: { href: 'https://flow.google.com/u/0/?hl=vi' },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    accessibleName: el => el.innerText || '',
  });
  vm.runInContext(domUtilsSource, ctx);
  vm.runInContext(editorSource, ctx);

  const errors = ctx.globalThis.currentFlowSubmitErrors();
  assert.equal(errors.length, 1);
  assert.equal(errors[0], 'Đã xảy ra lỗi. Vui lòng thử lại sau');
});

test('getFlowSubmitButton ignores aspect ratio chip and clear button in ProseMirror parent, choosing Vietnamese submit button with credits', () => {
  const domUtilsSource = readFileSync(new URL('../extension/src/content/shared/dom-utils.js', import.meta.url), 'utf8');
  const selectorsSource = readFileSync(new URL('../extension/src/content/providers/flow/core/selectors.js', import.meta.url), 'utf8');
  const editorSource = readFileSync(new URL('../extension/src/content/providers/flow/composer/flow-editor.js', import.meta.url), 'utf8');

  // Aspect ratio chip inside immediate parent
  const aspectRatioBtn = {
    innerText: '16:9',
    textContent: '16:9',
    name: 'Tỷ lệ khung hình 16:9',
    getAttribute: a => a === 'aria-label' ? 'Tỷ lệ khung hình 16:9' : null,
    getBoundingClientRect: () => ({ width: 60, height: 32, top: 100 }),
    closest: () => null,
    querySelector: () => null,
  };

  // Clear button inside immediate parent
  const clearBtn = {
    innerText: 'close',
    textContent: 'close',
    name: 'Xóa câu lệnh',
    getAttribute: a => a === 'aria-label' ? 'Xóa câu lệnh' : null,
    getBoundingClientRect: () => ({ width: 32, height: 32, top: 100 }),
    closest: () => null,
    querySelector: () => ({ textContent: 'close' }),
  };

  // True submit button with credits
  const submitBtn = {
    innerText: 'Bắt đầu tạo (1 credit)',
    textContent: 'Bắt đầu tạo (1 credit)',
    name: 'Bắt đầu tạo (1 credit)',
    getAttribute: a => a === 'type' ? 'button' : null,
    getBoundingClientRect: () => ({ width: 140, height: 40, top: 100 }),
    closest: s => s.includes('composer') ? {} : null,
    querySelector: s => s.includes('mat-icon') ? {
      getAttribute: a => a === 'fonticon' ? 'arrow_forward' : null,
      textContent: '',
    } : null,
  };

  // Immediate parent containing ProseMirror, aspect ratio, and clear button
  const innerWrapper = {
    className: 'ProseMirror-wrapper',
    tagName: 'DIV',
    querySelectorAll: s => s.includes('button') ? [aspectRatioBtn, clearBtn] : [],
    querySelector: s => s.includes('button') ? aspectRatioBtn : null,
  };

  // Outer composer container containing innerWrapper and submitBtn
  const composerContainer = {
    className: 'flow-composer',
    tagName: 'DIV',
    querySelectorAll: s => s.includes('button') ? [aspectRatioBtn, clearBtn, submitBtn] : [],
    querySelector: s => null,
    contains: element => element === submitBtn || element === aspectRatioBtn || element === clearBtn,
  };
  innerWrapper.parentElement = composerContainer;

  const proseMirror = {
    isContentEditable: true,
    innerText: 'A cinematic landscape',
    parentElement: innerWrapper,
    closest: s => s.includes('composer') ? composerContainer : null,
    getBoundingClientRect: () => ({ width: 500, height: 80, top: 100 }),
  };

  const allButtons = [aspectRatioBtn, clearBtn, submitBtn];

  const ctx = vm.createContext({
    globalThis: {},
    window: {},
    document: {
      querySelectorAll: s => {
        if (s.includes('.ProseMirror')) return [proseMirror];
        if (s.includes('button')) return allButtons;
        return [];
      },
      querySelector: s => {
        if (s.includes('.ProseMirror')) return proseMirror;
        if (s.includes('composer')) return composerContainer;
        return null;
      },
    },
    location: { href: 'https://flow.google.com/u/0/?hl=vi' },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    accessibleName: el => el.name || el.innerText || '',
  });

  vm.runInContext(domUtilsSource, ctx);
  vm.runInContext(selectorsSource, ctx);
  vm.runInContext(editorSource, ctx);

  const getFlowSubmitButton = ctx.globalThis.getFlowSubmitButton;
  const picked = getFlowSubmitButton('A cinematic landscape');

  assert.equal(picked, submitBtn, 'getFlowSubmitButton MUST choose the submit button, not the aspect ratio or clear button');
});

test('getFlowSubmitButton detects submit button via fonticon with empty textContent', () => {
  const domUtilsSource = readFileSync(new URL('../extension/src/content/shared/dom-utils.js', import.meta.url), 'utf8');
  const selectorsSource = readFileSync(new URL('../extension/src/content/providers/flow/core/selectors.js', import.meta.url), 'utf8');
  const editorSource = readFileSync(new URL('../extension/src/content/providers/flow/composer/flow-editor.js', import.meta.url), 'utf8');

  const matIconBtn = {
    innerText: '',
    textContent: '',
    name: '',
    getAttribute: a => a === 'type' ? 'button' : null,
    getBoundingClientRect: () => ({ width: 48, height: 48, top: 200 }),
    closest: () => null,
    querySelector: s => s.includes('mat-icon') ? {
      getAttribute: a => a === 'fonticon' ? 'arrow_forward' : null,
      textContent: '',
    } : null,
  };

  const proseMirror = {
    isContentEditable: true,
    innerText: 'Modern architecture',
    parentElement: null,
    closest: () => null,
    getBoundingClientRect: () => ({ width: 500, height: 80, top: 190 }),
  };

  const ctx = vm.createContext({
    globalThis: {},
    window: {},
    document: {
      querySelectorAll: s => {
        if (s.includes('.ProseMirror')) return [proseMirror];
        if (s.includes('button')) return [matIconBtn];
        return [];
      },
      querySelector: s => s.includes('.ProseMirror') ? proseMirror : null,
    },
    location: { href: 'https://flow.google.com/u/0/?hl=vi' },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    accessibleName: el => el.name || el.innerText || '',
  });

  vm.runInContext(domUtilsSource, ctx);
  vm.runInContext(selectorsSource, ctx);
  vm.runInContext(editorSource, ctx);

  const getFlowSubmitButton = ctx.globalThis.getFlowSubmitButton;
  const picked = getFlowSubmitButton('Modern architecture');

  assert.equal(picked, matIconBtn, 'Submit button with fonticon="arrow_forward" must be detected even with empty textContent');
});
