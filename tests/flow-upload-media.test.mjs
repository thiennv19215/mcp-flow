import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../extension/content/providers/flow/FlowComponents.js', import.meta.url), 'utf8');

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
  vm.runInContext(source, context);
  return { components: context.FlowComponents, mediaId };
}

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
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    uploaded: true, name: 'same-name.png', kind: 'image', id: mediaId, reused: true,
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
  vm.runInContext(source, context);

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
  const dialog = { innerText: 'Upload video?', textContent: 'Upload video?', querySelectorAll: () => [{ label: 'Continue', click: () => { clicks++; } }] };
  const context = vm.createContext({
    document: { querySelectorAll: selector => selector.includes('dialog') ? [dialog] : [] },
    Date: { now: () => ticks },
    wait: async ms => { ticks += ms; },
    visible: () => true,
    accessibleName: element => element.label,
    FlowUiDeadline: { boundedWait: async () => {} },
    flowError: (code, message, retryable, outcome_unknown) => Object.assign(new Error(message), { code, retryable, outcome_unknown }),
  });
  vm.runInContext(source, context);
  const result = await context.confirmFlowVideoUploadIfPrompted(Date.now() + 5000);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    confirmationDialogSeen: true,
    confirmationButtonClicked: true,
    confirmationDialogUnrecognized: false,
  });
  assert.equal(clicks, 1);
});

test('video upload confirmation fails safely on an unrecognized dialog and redacts its text', async () => {
  let ticks = 1;
  const secretText = 'Upload video for customer-secret@example.test';
  const dialog = { innerText: secretText, textContent: secretText, querySelectorAll: () => [{ label: 'Review', click() {} }] };
  const context = vm.createContext({
    document: { querySelectorAll: selector => selector.includes('dialog') ? [dialog] : [] },
    Date: { now: () => ticks },
    wait: async ms => { ticks += ms; },
    visible: () => true,
    accessibleName: element => element.label,
    FlowUiDeadline: { boundedWait: async () => {} },
    flowError: (code, message, retryable, outcome_unknown) => Object.assign(new Error(message), { code, retryable, outcome_unknown }),
  });
  vm.runInContext(source, context);
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


