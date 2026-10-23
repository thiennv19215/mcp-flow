import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { flowComponentsSource } from './helpers/flow-components-source.mjs';

function runInContext(context) {
  vm.runInContext(flowComponentsSource, context);
  return context;
}

function uploadHarness({ tileKind, name = 'same-name.png' }) {
  const mediaId = '22222222-2222-4222-8222-222222222222';
  const tile = {
    getAttribute(attribute) { return attribute === 'aria-label' ? name : null; },
    get innerText() { return name; },
    get textContent() { return name; },
    querySelector(selector) {
      if (selector === 'flow-error-tile') return null;
      if (selector === 'flow-scene-tile') return tileKind === 'scene' ? {} : null;
      if (selector === 'flow-video-tile,video') return tileKind === 'video' ? {} : null;
      if (selector === 'flow-image-tile,img') return tileKind === 'image' ? {} : null;
      return null;
    },
  };
  const context = vm.createContext({
    document: { querySelectorAll: selector => selector === 'flow-grid-tile-container' ? [tile] : [] },
    FlowTiles: { isTileMediaReady: () => true },
    mediaId: () => mediaId,
    scrollContainer: () => null,
    flowError: (code, message, retryable, outcome_unknown) => Object.assign(new Error(message), { code, retryable, outcome_unknown }),
  });
  runInContext(context);
  return { components: context.FlowComponents, uploader: context.FlowUploader, mediaId };
}

function mediaTile(id, name, kind = 'image') {
  const image = { getAttribute: attribute => attribute === 'alt' ? name : null };
  return {
    id,
    getAttribute: attribute => attribute === 'aria-label' ? name : null,
    get innerText() { return name; },
    get textContent() { return name; },
    querySelector(selector) {
      if (selector === 'flow-error-tile') return null;
      if (selector === 'flow-scene-tile') return kind === 'scene' ? {} : null;
      if (selector === 'flow-video-tile,video') return kind === 'video' ? {} : null;
      if (selector === 'flow-image-tile,img' || selector === 'img') return kind === 'image' ? image : null;
      return null;
    },
  };
}

test('Flow upload menu discovery keeps visible popups even before an Upload label is mounted', () => {
  const { uploader } = uploadHarness({ tileKind: 'image' });
  const unlabelledPicker = { isConnected: true };
  const hiddenPopup = { isConnected: true };
  const doc = { querySelectorAll: selector => {
    assert.match(selector, /component-picker/);
    return [unlabelledPicker, hiddenPopup];
  } };

  const roots = uploader.findVisibleUploadMenuRoots(doc, element => element === unlabelledPicker);
  assert.equal(roots.length, 1);
  assert.equal(roots[0], unlabelledPicker);
});

test('Flow upload menu recognizes common English and Vietnamese upload controls', () => {
  const { uploader } = uploadHarness({ tileKind: 'image' });

  for (const label of ['Upload media', 'Upload from device', 'Tải ảnh lên', 'Tải tệp từ máy tính', 'Chọn ảnh để tải lên']) {
    assert.equal(uploader.matchesUploadAction([label]), true, `expected upload action: ${label}`);
  }
  assert.equal(uploader.matchesUploadAction([], 'file_upload'), true);
  assert.equal(uploader.matchesUploadAction(['Upload'], '', 'tab'), false);
  assert.equal(uploader.matchesUploadAction(['Upload'], '', 'button', 'false'), false);
  assert.equal(uploader.matchesUploadAction(['Uploads']), false, 'the library category is not a file-upload action');
});

test('Flow category switching requires explicit tab semantics so Upload is never pre-clicked as a file action', () => {
  const { uploader } = uploadHarness({ tileKind: 'image' });

  assert.equal(uploader.matchesUploadCategoryTab({ label: 'Upload', role: 'tab' }), true);
  assert.equal(uploader.matchesUploadCategoryTab({ label: 'Upload media', role: 'button' }), false);
  assert.equal(uploader.matchesUploadCategoryTab({ label: 'Uploads', role: 'button' }), false);
});

test('upload confirmation selects the single new media ID when old Flow tiles share the filename', async () => {
  const name = 'same-name.png';
  const oldIds = ['old-media-1', 'old-media-2'];
  const newId = 'new-media-3';
  const tiles = [...oldIds.map(id => mediaTile(id, name)), mediaTile(newId, name)];
  const context = vm.createContext({
    document: { querySelectorAll: selector => selector === 'flow-grid-tile-container' ? tiles : [] },
    FlowTiles: { isTileMediaReady: () => true },
    mediaId: tile => tile.id,
    FlowUiDeadline: { boundedWait: async () => {} },
    flowError: (code, message, retryable, outcome_unknown) => Object.assign(new Error(message), { code, retryable, outcome_unknown }),
  });
  runInContext(context);

  const result = await context.waitForNativeMediaTile(name, {}, 'image', {
    deadline: Date.now() + 2000,
    baselineIds: oldIds,
    requireNewOwner: true,
    maxLibraryScans: 0,
  });
  assert.equal(result.id, newId);
  assert.equal(result.name, name);
});

test('upload confirmation rejects multiple new Flow media IDs with the same filename', async () => {
  const name = 'same-name.png';
  const tiles = [mediaTile('new-media-1', name), mediaTile('new-media-2', name)];
  const context = vm.createContext({
    document: { querySelectorAll: selector => selector === 'flow-grid-tile-container' ? tiles : [] },
    FlowTiles: { isTileMediaReady: () => true },
    mediaId: tile => tile.id,
    flowError: (code, message, retryable, outcome_unknown) => Object.assign(new Error(message), { code, retryable, outcome_unknown }),
  });
  runInContext(context);

  await assert.rejects(context.waitForNativeMediaTile(name, {}, 'image', {
    deadline: Date.now() + 2000,
    baselineIds: [],
    requireNewOwner: true,
    maxLibraryScans: 0,
  }), error => error.code === 'FLOW_UPLOAD_TILE_AMBIGUOUS' && error.outcome_unknown === true);
});

test('multiple existing Flow tiles with the same filename reuse an exact ready asset instead of uploading again', async () => {
  const name = 'same-name.png';
  const existingIds = ['existing-media-1', 'existing-media-2'];
  const tiles = existingIds.map(id => mediaTile(id, name));
  let progress = '';
  const context = vm.createContext({
    document: { querySelectorAll: selector => selector === 'flow-grid-tile-container' ? tiles : [] },
    FlowTiles: { isTileMediaReady: () => true },
    mediaId: tile => tile.id,
    scrollContainer: () => null,
    emitFlowProgress: (_command, message) => { progress = message; },
    flowError: (code, message, retryable, outcome_unknown) => Object.assign(new Error(message), { code, retryable, outcome_unknown }),
  });
  runInContext(context);

  const result = await context.FlowUploader.upload({ name }, 'image', {});
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    uploaded: true, name, kind: 'image', id: existingIds[0], reused: true,
  });
  assert.match(progress, /skipped upload/i);
});

test('reusing an exact-name tile rejects a ready tile of the wrong media kind', async () => {
  const { components } = uploadHarness({ tileKind: 'video' });
  await assert.rejects(
    components.uploadStagedFlowMedia({ name: 'same-name.png' }, 'image', {}),
    error => error.code === 'FLOW_UPLOAD_KIND_MISMATCH' && error.outcome_unknown === false && /video tile/.test(error.message),
  );
});

test('reusing an exact-name image tile of the requested kind remains successful', async () => {
  const { components, mediaId } = uploadHarness({ tileKind: 'image' });
  const result = await components.uploadStagedFlowMedia({ name: 'same-name.png' }, 'image', {});
  // IMG-03: the receipt surfaces the canonical media UUID (here the tile id
  // already is one) as mediaUuid alongside the unchanged legacy fields.
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    uploaded: true, name: 'same-name.png', kind: 'image', id: mediaId, reused: true, mediaUuid: mediaId,
  });
});

test('a Flow scene tile remains reusable as video media', async () => {
  const { components } = uploadHarness({ tileKind: 'scene', name: 'same-name.mp4' });
  const result = await components.uploadStagedFlowMedia({ name: 'same-name.mp4' }, 'video', {});
  assert.equal(result.uploaded, true);
  assert.equal(result.kind, 'video');
  assert.equal(result.reused, true);
});

test('a missing uploaded tile returns bounded scan evidence and an unknown outcome', async () => {
  let clock = 0;
  const nativeError = (code, message) => Object.assign(new Error(message), { code, outcome_unknown: true });
  const progress = { innerText: 'private progress detail', textContent: 'private progress detail' };
  const errorTile = { innerText: 'private rejected file name', textContent: 'private rejected file name' };
  const context = vm.createContext({
    Date: { now: () => (clock += 100) },
    document: { querySelectorAll: selector => selector === '[role="progressbar"],[aria-busy="true"],mat-progress-bar,.mat-mdc-progress-bar,[data-state="loading"]'
      ? [progress] : selector === 'flow-error-tile' ? [errorTile] : [] },
    FlowMediaMenu: {
      async scanNativeAssets({ onDiagnostics }) {
        onDiagnostics({ steps: 8, uniqueTiles: 17, reachedEnd: true, exactMatchCount: 0 });
        throw nativeError('FLOW_ASSET_NOT_FOUND', 'No exact title found');
      },
    },
    FlowUiDeadline: { boundedWait: async () => {} },
    wait: async () => { clock += 500; },
    visible: () => true,
    emitFlowProgress: () => {},
    flowError: (code, message, retryable, outcome_unknown) => Object.assign(new Error(message), { code, retryable, outcome_unknown }),
  });
  runInContext(context);

  let caught;
  try {
    await context.waitForNativeMediaTile('fm-test.mp4', {}, 'video', {
      deadline: 20_000,
      baselineIds: ['old-id'],
      requireNewOwner: true,
      selectionDiagnostics: { filePickerSelectionConfirmed: true, pickerMethod: 'input.click secret@example.test', pickerType: 'video/mp4;token=secret' },
    });
  } catch (error) { caught = error; }
  assert.ok(caught);
  assert.equal(caught.code, 'FLOW_UPLOAD_TIMEOUT', String(caught?.stack || caught));
  assert.equal(caught.outcome_unknown, true);
  assert.match(caught.message, /Picker selection confirmed: true/);
  assert.match(caught.message, /17 tiles, 8 pages, reached end true/);
  assert.deepEqual(JSON.parse(JSON.stringify(caught.diagnostics)), {
    filePickerSelectionConfirmed: true,
    pickerMethod: 'unknown',
    pickerType: 'unknown',
    dropAttempted: false,
    dropReceiptConfirmed: false,
    confirmationDialogSeen: false,
    confirmationButtonClicked: false,
    confirmationDialogUnrecognized: false,
    exactTileObserved: false,
    baselineIdCount: 1,
    newOwnerIdLatched: false,
    scansAttempted: 3,
    lastScan: { steps: 8, uniqueTiles: 17, reachedEnd: true, exactMatchCount: 0 },
    lastScanErrorCode: 'FLOW_ASSET_NOT_FOUND',
    uploadUi: { confirmationDialogVisible: false, visibleProgressIndicatorCount: 1, visibleErrorTileCount: 1, visibleUploadRejection: true },
  });
  assert.equal(JSON.stringify(caught.diagnostics).includes('secret'), false);
  assert.equal(JSON.stringify(caught.diagnostics).includes('private'), false);
});

test('video upload confirmation reports and clicks a recognized control', async () => {
  let ticks = 1;
  let clicks = 0;
  const dialog = { innerText: 'Upload video?', textContent: 'Upload video?', querySelectorAll: () => [{ label: 'Continue', getAttribute: () => null, click: () => { clicks++; } }] };
  const context = vm.createContext({
    document: { querySelectorAll: selector => selector.includes('dialog') ? [dialog] : [] },
    Date: { now: () => ticks },
    wait: async ms => { ticks += ms; },
    visible: () => true,
    accessibleName: element => element.label,
    FlowUiDeadline: { boundedWait: async () => {} },
    flowError: (code, message, retryable, outcome_unknown) => Object.assign(new Error(message), { code, retryable, outcome_unknown }),
  });
  runInContext(context);
  const result = await context.confirmFlowVideoUploadIfPrompted(Date.now() + 5000);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    confirmationDialogSeen: true,
    confirmationButtonClicked: true,
    confirmationDialogUnrecognized: false,
  });
  assert.equal(clicks, 1);
});

test('video upload confirmation waits briefly for a dialog that mounts after file selection', async () => {
  let ticks = 1;
  let polls = 0;
  let clicks = 0;
  const dialog = { innerText: 'Upload video?', textContent: 'Upload video?', querySelectorAll: () => [{ label: 'Continue', getAttribute: () => null, click: () => { clicks++; } }] };
  const context = vm.createContext({
    document: { querySelectorAll: selector => {
      if (!selector.includes('dialog')) return [];
      polls++;
      return polls < 4 ? [] : [dialog];
    } },
    Date: { now: () => ticks },
    visible: () => true,
    accessibleName: element => element.label,
    wait: async ms => { ticks += ms; },
    flowError: (code, message, retryable, outcome_unknown) => Object.assign(new Error(message), { code, retryable, outcome_unknown }),
  });
  runInContext(context);
  const result = await context.confirmFlowVideoUploadIfPrompted(Date.now() + 5000);
  assert.equal(result.confirmationButtonClicked, true);
  assert.equal(result.confirmationDialogUnrecognized, false);
  assert.equal(polls, 4, 'the helper must keep polling after the first empty snapshot');
  assert.equal(clicks, 1);
});

test('video upload confirmation fails safely on an unrecognized dialog and redacts its text', async () => {
  let ticks = 1;
  const secretText = 'Upload video for customer-secret@example.test';
  const dialog = { innerText: secretText, textContent: secretText, querySelectorAll: () => [{ label: 'Review', getAttribute: () => null, click() {} }] };
  const context = vm.createContext({
    document: { querySelectorAll: selector => selector.includes('dialog') ? [dialog] : [] },
    Date: { now: () => ticks },
    wait: async ms => { ticks += ms; },
    visible: () => true,
    accessibleName: element => element.label,
    FlowUiDeadline: { boundedWait: async () => {} },
    flowError: (code, message, retryable, outcome_unknown) => Object.assign(new Error(message), { code, retryable, outcome_unknown }),
  });
  runInContext(context);
  await assert.rejects(
    context.confirmFlowVideoUploadIfPrompted(Date.now() + 10_000, undefined, {
      filePickerSelectionConfirmed: true,
      pickerMethod: 'input.click',
      pickerType: 'video/mp4',
    }),
    error => {
      assert.equal(error.code, 'FLOW_UPLOAD_CONFIRMATION_UNRECOGNIZED');
      assert.equal(error.outcome_unknown, true);
      assert.equal(error.diagnostics.confirmationDialogSeen, true);
      assert.equal(error.diagnostics.confirmationButtonClicked, false);
      assert.equal(error.diagnostics.confirmationDialogUnrecognized, true);
      assert.equal(error.diagnostics.filePickerSelectionConfirmed, true);
      assert.equal(error.diagnostics.pickerMethod, 'input.click');
      assert.equal(error.diagnostics.pickerType, 'video/mp4');
      assert.equal(JSON.stringify(error.diagnostics).includes(secretText), false);
      assert.equal(error.message.includes(secretText), false);
      return true;
    },
  );
});

test('video upload confirmation rejects multiple independent dialogs without clicking', async () => {
  let ticks = 1;
  let clicks = 0;
  const makeDialog = label => ({
    innerText: `Upload video ${label}`,
    textContent: `Upload video ${label}`,
    querySelectorAll: () => [{ label: 'Continue', getAttribute: () => null, click: () => { clicks++; } }],
  });
  const context = vm.createContext({
    document: { querySelectorAll: selector => selector.includes('dialog') ? [makeDialog('secret-one'), makeDialog('secret-two')] : [] },
    Date: { now: () => ticks },
    wait: async ms => { ticks += ms; },
    visible: () => true,
    accessibleName: element => element.label,
    FlowUiDeadline: { boundedWait: async () => {} },
    flowError: (code, message, retryable, outcome_unknown) => Object.assign(new Error(message), { code, retryable, outcome_unknown }),
  });
  runInContext(context);
  await assert.rejects(context.confirmFlowVideoUploadIfPrompted(Date.now() + 5000), error => {
    assert.equal(error.code, 'FLOW_UPLOAD_CONFIRMATION_AMBIGUOUS');
    assert.equal(error.outcome_unknown, true);
    assert.equal(error.diagnostics.confirmationDialogCandidateCount, 2);
    assert.equal(error.diagnostics.enabledConfirmationControlCount, 0);
    assert.equal(error.message.includes('secret-one'), false);
    assert.equal(JSON.stringify(error.diagnostics).includes('secret'), false);
    return true;
  });
  assert.equal(clicks, 0);
});

test('video upload confirmation rejects duplicate enabled controls without clicking', async () => {
  let ticks = 1;
  let clicks = 0;
  const dialog = {
    innerText: 'Upload video?',
    textContent: 'Upload video?',
    querySelectorAll: () => [
      { label: 'Upload', getAttribute: () => null, click: () => { clicks++; } },
      { label: 'Confirm', getAttribute: () => null, click: () => { clicks++; } },
    ],
  };
  const context = vm.createContext({
    document: { querySelectorAll: selector => selector.includes('dialog') ? [dialog] : [] },
    Date: { now: () => ticks },
    wait: async ms => { ticks += ms; },
    visible: () => true,
    accessibleName: element => element.label,
    FlowUiDeadline: { boundedWait: async () => {} },
    flowError: (code, message, retryable, outcome_unknown) => Object.assign(new Error(message), { code, retryable, outcome_unknown }),
  });
  runInContext(context);
  await assert.rejects(context.confirmFlowVideoUploadIfPrompted(Date.now() + 5000), error => {
    assert.equal(error.code, 'FLOW_UPLOAD_CONFIRMATION_AMBIGUOUS');
    assert.equal(error.outcome_unknown, true);
    assert.equal(error.diagnostics.confirmationDialogCandidateCount, 1);
    assert.equal(error.diagnostics.enabledConfirmationControlCount, 2);
    assert.equal(error.message.includes('Upload video?'), false);
    return true;
  });
  assert.equal(clicks, 0);
});




test('matchesFlowTile correctly resolves Vietnamese and English prefixed/suffixed tile names', () => {
  const context = vm.createContext({
    visible: () => true,
    normalizeFlowUiText: s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim(),
  });
  runInContext(context);

  const makeTile = ariaLabel => ({
    getAttribute: attr => attr === 'aria-label' ? ariaLabel : null,
    querySelector: () => null,
  });

  const target = 'ref-174000123.png';

  // Tiếng Việt tiền tố (prefix)
  assert.equal(context.matchesFlowTile(makeTile('Hình ảnh ref-174000123.png'), target), true);
  assert.equal(context.matchesFlowTile(makeTile('Ảnh ref-174000123.png'), target), true);
  assert.equal(context.matchesFlowTile(makeTile('Nội dung nghe nhìn ref-174000123.png'), target), true);
  assert.equal(context.matchesFlowTile(makeTile('Video ref-174000123.mp4'), 'ref-174000123.mp4'), true);

  // Tiếng Việt hậu tố (suffix)
  assert.equal(context.matchesFlowTile(makeTile('ref-174000123.png hình ảnh'), target), true);
  assert.equal(context.matchesFlowTile(makeTile('ref-174000123.png ảnh'), target), true);
  assert.equal(context.matchesFlowTile(makeTile('ref-174000123.png nội dung'), target), true);

  // Tiếng Anh tiền tố & hậu tố
  assert.equal(context.matchesFlowTile(makeTile('Image ref-174000123.png'), target), true);
  assert.equal(context.matchesFlowTile(makeTile('ref-174000123.png image'), target), true);
  assert.equal(context.matchesFlowTile(makeTile('ref-174000123 image'), target), true);
  assert.equal(context.matchesFlowTile(makeTile('ref-174000123.png'), target), true);
});

test('flowUploadNameMatches matches bilingual asset names', () => {
  const context = vm.createContext({
    normalizeFlowUiText: s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim(),
  });
  runInContext(context);

  const file = 'ref-portrait-555.png';
  assert.equal(context.flowUploadNameMatches('Hình ảnh ref-portrait-555.png', file), true);
  assert.equal(context.flowUploadNameMatches('Ảnh ref-portrait-555', file), true);
  assert.equal(context.flowUploadNameMatches('ref-portrait-555.png hình ảnh', file), true);
  assert.equal(context.flowUploadNameMatches('ref-portrait-555 image', file), true);
  assert.equal(context.flowUploadNameMatches('ref-portrait-555.png', file), true);
});

test('video upload confirmation recognizes Vietnamese buttons like "Đồng ý và tiếp tục" and "Tải video lên"', async () => {
  let clicks = 0;
  const dialog = {
    innerText: 'Tải video lên dự án?',
    textContent: 'Tải video lên dự án?',
    querySelectorAll: () => [{ label: 'Đồng ý và tiếp tục', getAttribute: () => null, click: () => { clicks++; } }]
  };
  const context = vm.createContext({
    document: { querySelectorAll: selector => selector.includes('dialog') ? [dialog] : [] },
    Date: { now: () => 100 },
    wait: async () => {},
    visible: () => true,
    accessibleName: element => element.label,
    FlowUiDeadline: { boundedWait: async () => {} },
    flowError: (code, message, retryable, outcome_unknown) => Object.assign(new Error(message), { code, retryable, outcome_unknown }),
  });
  runInContext(context);
  const result = await context.confirmFlowVideoUploadIfPrompted(Date.now() + 5000);
  assert.equal(result.confirmationButtonClicked, true);
  assert.equal(clicks, 1);
});


test('findAddMediaButton finds Vietnamese composer add button', () => {
  const addBtn = {
    tagName: 'button',
    getAttribute: attr => attr === 'aria-label' ? 'Thêm thành phần vào hộp lời nhắc' : null,
    innerText: '',
    textContent: '',
    disabled: false,
    isConnected: true,
    querySelector: () => null,
  };
  const editor = { isContentEditable: true, parentElement: null };
  const submit = { previousElementSibling: addBtn };
  const composer = {
    contains: el => el === addBtn || el === editor || el === submit,
    querySelectorAll: () => [addBtn],
    tagName: 'DIV',
    className: 'composer-box',
  };
  editor.parentElement = composer;

  const context = vm.createContext({
    visible: () => true,
    accessibleName: el => el.getAttribute('aria-label'),
    flowButton: () => null,
    isFlowProjectNavigationControl: () => false,
    FlowEditor: { getFlowSubmitButton: () => submit },
    flowQuery: key => key === 'editor' ? editor : key === 'composerRoot' ? composer : null,
    document: { querySelector: () => editor },
    normalizeFlowUiText: s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim(),
  });
  runInContext(context);

  const found = context.findAddMediaButton();
  assert.equal(found, addBtn);
});
