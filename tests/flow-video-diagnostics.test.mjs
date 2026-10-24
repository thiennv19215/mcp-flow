import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const operationsSource = readFileSync(new URL('../extension/src/content/providers/flow/generation/generation-operations.js', import.meta.url), 'utf8');
const editorSource = readFileSync(new URL('../extension/src/content/providers/flow/composer/flow-editor.js', import.meta.url), 'utf8');
const pickerSource = readFileSync(new URL('../extension/src/content/providers/flow/generation/native-frame-picker.js', import.meta.url), 'utf8');
const panelJs = readFileSync(new URL('../extension/src/ui/flow-queue-panel.js', import.meta.url), 'utf8');

// ---------------------------------------------------------------------------
// Live diagnostics for the two video-path failures seen on the user's PC:
//
//  1. A video submit whose click was delivered but whose generation request
//     was never observed died with the boundedWait error "Timed out while
//     waiting for Flow request dispatch" — the ONE submit error that carried
//     no correlation-observer diagnostics, so the failure was unexplainable.
//     The dispatch wait must now surface the same diagnostics payload that
//     unknownSubmitError already attaches to its sibling exits.
//
//  2. A Frames-mode submit hung in the native frame picker, whose rich
//     diagnostics (phase, opener, visible options) were recorded into a
//     page global nobody reads. The picker's catch must now attach that
//     snapshot to the rethrown error so it reaches the queue record.
//
//  3. The queue panel must render a compact, escaped summary of
//     job.diagnostics under the error line; jobs without diagnostics must
//     render exactly as before.
// ---------------------------------------------------------------------------

// Objects produced inside the vm realm carry that realm's prototypes, so
// deepStrictEqual against test-realm literals needs a plain round-trip.
const plain = value => JSON.parse(JSON.stringify(value));

const HEALTH = {
  ready: true,
  xhrHookActive: true,
  fetchHookActive: false,
  requestDiagnostics: {
    version: 1,
    count: 1,
    events: [{
      observedAt: '2026-10-24T04:00:00.000Z',
      mediaType: 'video',
      transport: 'xhr',
      payloadVersion: 2,
      payloadShape: 'structured',
      pathClass: 'other',
      pathRecognized: false,
      payloadMatched: false,
      fields: { prompt: true },
      reasons: ['PATH_UNRECOGNIZED'],
    }],
  },
};

const EXPECTED_DIAGNOSTICS = {
  clickDelivered: true,
  observerReady: true,
  xhrHookActive: true,
  fetchHookActive: false,
  requestDiagnostics: HEALTH.requestDiagnostics,
};

// ---------------------------------------------------------------------------
// Part 1 — dispatch wait diagnostics (generation-operations.js)
// ---------------------------------------------------------------------------

function dispatchHarness({ health = HEALTH, waitMode = 'throw-timeout', activation = null, requestSeen = false, components = null, liveButtonDisabledAfterMs = null, liveTilesAfterMs = null, editorClearedAfterMs = null, menuAssets = null, stagedFiles = null } = {}) {
  const correlationMap = new Map([
    ['attempt-1', { attemptId: 'attempt-1', requestSeen, receipts: [], interfered: false }],
  ]);
  const disarmCalls = [];
  const disarmOptions = [];
  const progressMessages = [];
  let now = 1_000_000;
  const startNow = now;
  const editorTextAt = () => (editorClearedAfterMs !== null && now - startNow >= editorClearedAfterMs ? '' : 'a lighthouse');
  const fakeTiles = {
    stabilizeFlowResultViewport: async () => {},
    collectNativeMedia: () => (liveTilesAfterMs !== null && now - startNow >= liveTilesAfterMs
      ? [{ id: 'new-tile-1', title: 'Fresh tile' }]
      : []),
    armNativeFlowCorrelation: () => 'attempt-1',
    nativeFlowCorrelationMap: () => correlationMap,
    disarmNativeFlowCorrelation: (id, options) => { disarmCalls.push(id); disarmOptions.push(options); },
    emitFlowProgress: (_command, message) => { progressMessages.push(message); },
    readNativeFlowCorrelationHealth: async () => health,
    releaseSubmitOnlyCorrelation: () => null,
  };
  const sandbox = {
    Date: { now: () => now },
    Map, Set, Promise, Object, Math, String, Number, Boolean, Array, Error, RegExp, JSON,
    AbortController, setTimeout, clearTimeout,
    location: { href: 'https://flow.google.com/project/proj-1' },
    document: { querySelector: () => null, querySelectorAll: () => [] },
    addEventListener: () => {},
    removeEventListener: () => {},
    flowError: (code, message, retryable, outcomeUnknown) =>
      Object.assign(new Error(message), { code, retryable, outcome_unknown: outcomeUnknown }),
    wait: async () => {},
    clearExistingIngredientChips: async () => {},
    FlowNavigation: {
      ensureFlowProjectEditor: async () => {},
      dismissBlockingOverlays: async () => {},
      ensureFlowLibrarySection: async () => {},
      prepareFlowOperation: async () => {},
    },
    FlowEditor: {
      preflightGenerationPrompt: async () => ({}),
      insertNativeFlowPrompt: async () => true,
      waitForGenerationCreditQuote: async () => 10,
      waitForGenerationSubmitButton: async () => ({ disabled: false, getAttribute: () => null }),
      activateFlowSubmitButton: async () => activation || ({ clickDelivered: true, strategy: 'fake-click' }),
      currentFlowSubmitErrors: () => [],
      getFlowSubmitButton: () => (liveButtonDisabledAfterMs !== null && now - startNow >= liveButtonDisabledAfterMs
        ? { disabled: true, getAttribute: () => null }
        : null),
      getVisibleFlowPromptEditor: () => ({}),
      getEditorUserText: () => editorTextAt(),
    },
    getEditorUserText: () => editorTextAt(),
    FlowSettings: { restoreNativeFramesMode: async () => {} },
    FlowComponents: components || {},
    validStagedLocalImage: (value) => Boolean(value && value.transferId),
    stagedNativeFiles: stagedFiles || new Map(),
    FlowTiles: fakeTiles,
    FlowMediaMenu: { nativeRead: () => ({ signedIn: true, inProject: true }), ...(menuAssets !== null ? { collectAssets: () => menuAssets } : {}) },
    FlowAgent: { closeNativeAgentSession: async () => {} },
    FlowScreenState: { inspect: () => ({ state: 'ready' }), assertGenerationReady: () => {} },
    FlowImageActions: { prepare: async () => ({}) },
    FlowVideoActions: { prepare: async () => 12 },
    FlowUiDeadline: {
      makeDeadline: () => now + 60_000,
      requireTime: () => 1_000,
      boundedWait: async ms => {
        if (waitMode === 'throw-timeout') {
          throw sandbox.flowError('FLOW_OPERATION_TIMEOUT',
            'Timed out while waiting for Flow request dispatch; no further Flow actions were started.', true, true);
        }
        if (waitMode === 'throw-other') {
          throw sandbox.flowError('FLOW_WAIT_BROKEN', 'The wait primitive failed.', false, false);
        }
        now += Math.max(0, Number(ms) || 0);
      },
    },
    ProviderRegistry: { describeUrl: () => ({ projectId: 'proj-1' }) },
  };
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(operationsSource, context);
  const driver = {
    error: (code, message, retryable, outcomeUnknown) =>
      Object.assign(new Error(message), { code, retryable, outcome_unknown: outcomeUnknown }),
  };
  const operations = new context.FlowGenerationOperations(driver);
  const submit = (payload = {}) => operations.execute('flow.generation.submit', {
    prompt: 'a lighthouse', type: 'video', ...payload,
  }, {});
  return { submit, disarmCalls, disarmOptions, correlationMap, progressMessages, elapsed: () => now - startNow };
}

test('dispatch wait: a boundedWait timeout surfaces with correlation-observer diagnostics attached', async () => {
  const { submit, disarmCalls } = dispatchHarness({ waitMode: 'throw-timeout' });
  await assert.rejects(submit(), error => {
    assert.equal(error.code, 'FLOW_OPERATION_TIMEOUT', 'the timeout keeps its code');
    assert.equal(error.message,
      'Timed out while waiting for Flow request dispatch; no further Flow actions were started.',
      'the boundedWait message is preserved verbatim');
    assert.equal(error.retryable, true, 'the boundedWait retryable flag is preserved');
    assert.equal(error.outcome_unknown, true, 'the submit outcome stays unknown');
    assert.deepEqual(plain(error.diagnostics), EXPECTED_DIAGNOSTICS,
      'the error carries the observer health + request diagnostics, like unknownSubmitError');
    return true;
  });
  assert.deepEqual(disarmCalls, ['attempt-1'], 'the correlation attempt is disarmed, like every sibling submit exit');
});

test('M-D: a no-signal dispatch timeout disarms with outcome "none" so the identical retry is not retired', async () => {
  const { submit, disarmOptions } = dispatchHarness({ waitMode: 'throw-timeout' });
  await assert.rejects(submit(), error => error.code === 'FLOW_OPERATION_TIMEOUT');
  // Compare primitives only: option objects are created inside the vm
  // realm, so strict deepEqual rejects them despite identical structure.
  assert.deepEqual(disarmOptions.map((option) => (option ? option.dispatchOutcome : undefined)), ['none'],
    'the timeout exit checked requestSeen, Flow errors and DOM acceptance first and found zero signal');
});

test('M-D: exhausting the submit deadline without acknowledgement disarms with outcome "none"', async () => {
  const { submit, disarmOptions } = dispatchHarness({ waitMode: 'advance' });
  await assert.rejects(submit(), error => error.code === 'FLOW_SUBMIT_UNCONFIRMED');
  assert.deepEqual(disarmOptions.map((option) => (option ? option.dispatchOutcome : undefined)), ['none']);
});

test('M-A: a fallback-only reference name with no id fails fast before submit', async () => {
  const { submit } = dispatchHarness({
    waitMode: 'throw-timeout',
    menuAssets: [{ name: 'Request for text translation', nameSource: 'fallback' }],
  });
  await assert.rejects(submit({ firstFrame: { assetName: 'Request for text translation', kind: 'image' } }), (error) => {
    assert.equal(error.code, 'FLOW_QUEUE_PREFLIGHT_REFERENCE_MISSING');
    assert.match(error.message, /UI label/, 'the error must name the fallback-label cause, not just "missing"');
    return true;
  });
});

test('M-A: a dedicated-name reference with no id passes revalidation', async () => {
  const { submit } = dispatchHarness({
    waitMode: 'throw-timeout',
    menuAssets: [{ name: 'My photo.png', nameSource: 'dedicated' }],
  });
  // It must get PAST revalidation: any later failure (here the unmocked
  // frame picker) proves the gate did not stop it. Only the preflight
  // code itself would prove the gate stopped it.
  await assert.rejects(submit({ firstFrame: { assetName: 'My photo.png', kind: 'image' } }), (error) => {
    assert.notEqual(error.code, 'FLOW_QUEUE_PREFLIGHT_REFERENCE_MISSING');
    return true;
  });
});

test('M-A: a reference with an expectedId passes revalidation by identity even when its name is fallback-only', async () => {
  const { submit } = dispatchHarness({
    waitMode: 'throw-timeout',
    menuAssets: [{ id: '11111111-2222-4333-8444-555555555555', name: 'Request for text translation', nameSource: 'fallback' }],
  });
  await assert.rejects(submit({ firstFrame: { assetName: 'Request for text translation', kind: 'image', expectedId: '11111111-2222-4333-8444-555555555555' } }), (error) => {
    assert.notEqual(error.code, 'FLOW_QUEUE_PREFLIGHT_REFERENCE_MISSING');
    return true;
  });
});

test('M-B: in-submit frame upload passes the tile uploadName to the picker, not the client name', async () => {
  const picked = [];
  const staged = new Map([['t1', { name: 'client-photo.png' }]]);
  const components = {
    clearExistingIngredientChips: async () => {},
    uploadStagedFlowMedia: async () => ({ id: 'receipt-id', uploadName: 'a1b2c3d4-upload.png', name: 'client-photo.png' }),
    chooseNativePickerAsset: async (title, slot, options) => {
      picked.push({ title, slot, expectedId: options.expectedId });
      return { id: '11111111-2222-4333-8444-555555555555' };
    },
  };
  const { submit } = dispatchHarness({ waitMode: 'throw-timeout', components, stagedFiles: staged });
  // The submit runs past frame selection and then dies at the mocked
  // dispatch wait; the picker call itself is what this test observes.
  await assert.rejects(submit({ firstFrame: { transferId: 't1', name: 'client-photo.png' } }), (error) => error.code === 'FLOW_OPERATION_TIMEOUT');
  assert.deepEqual(picked.map((call) => call.title), ['a1b2c3d4-upload.png'],
    'the dispatched tile bears the digest-derived uploadName, not the client safeName');
  assert.equal(picked[0].slot, 'start');
  assert.equal(picked[0].expectedId, 'receipt-id');
});

test('dispatch wait: exhausting the submit deadline without acknowledgement also carries diagnostics', async () => {
  const { submit } = dispatchHarness({ waitMode: 'advance' });
  await assert.rejects(submit(), error => {
    assert.equal(error.code, 'FLOW_SUBMIT_UNCONFIRMED');
    assert.deepEqual(plain(error.diagnostics), EXPECTED_DIAGNOSTICS,
      'the unconfirmed-submit error keeps its diagnostics payload');
    return true;
  });
});

test('dispatch wait: a non-timeout wait failure passes through untouched (no fabricated diagnostics)', async () => {
  const { submit } = dispatchHarness({ waitMode: 'throw-other' });
  await assert.rejects(submit(), error => {
    assert.equal(error.code, 'FLOW_WAIT_BROKEN');
    assert.equal(error.message, 'The wait primitive failed.');
    assert.equal(error.diagnostics, undefined, 'only the dispatch timeout is converted');
    return true;
  });
});

test('dispatch wait: a missing observer health still yields the default diagnostics shell', async () => {
  const { submit } = dispatchHarness({ waitMode: 'throw-timeout', health: null });
  await assert.rejects(submit(), error => {
    assert.equal(error.code, 'FLOW_OPERATION_TIMEOUT');
    assert.deepEqual(plain(error.diagnostics), {
      clickDelivered: true,
      observerReady: false,
      xhrHookActive: false,
      fetchHookActive: false,
      requestDiagnostics: { version: 1, count: 0, events: [] },
    }, 'no health read -> the same default shell unknownSubmitError produces');
    return true;
  });
});

// ---------------------------------------------------------------------------
// Part 2 — frame picker diagnostics attach (native-frame-picker.js)
// ---------------------------------------------------------------------------

function pickerHarness({ optionNames = ['Alpha Asset', 'Beta Asset'], withOpener = true } = {}) {
  let pickerOpen = false;
  const container = { querySelectorAll: () => [] };
  const opener = {
    innerText: '',
    disabled: false,
    parentElement: { parentElement: container },
    getAttribute: name => name === 'aria-expanded' ? String(pickerOpen)
      : name === 'aria-label' ? 'Start' : null,
    click: () => { pickerOpen = !pickerOpen; },
  };
  const options = optionNames.map(name => ({
    name,
    getAttribute: attr => (attr === 'aria-label' ? name : null),
    querySelectorAll: () => [],
  }));
  const list = {
    id: 'frame-list',
    isConnected: true,
    parentElement: container,
    getAttribute: name => (name === 'role' ? 'listbox' : null),
    querySelectorAll: selector => (selector === '[role="option"]' ? options : []),
    closest: () => null,
  };
  const documentFake = {
    querySelectorAll: selector => (selector === '[role="listbox"]' ? (pickerOpen ? [list] : []) : []),
    getElementById: () => null,
    dispatchEvent: () => { pickerOpen = false; },
  };
  const sandbox = {
    document: documentFake,
    location: { href: 'https://flow.google.com/project/proj-1', pathname: '/project/proj-1' },
    visible: el => el !== list || pickerOpen,
    accessibleName: el => el?.name || '',
    flowButton: label => (label === 'Start' && withOpener ? opener : null),
    flowError: (code, message, retryable, outcome_unknown) =>
      Object.assign(new Error(message), { code, retryable, outcome_unknown }),
    KeyboardEvent: class KeyboardEvent { constructor(type, init) { this.type = type; Object.assign(this, init); } },
    wait: async () => {},
    FlowUiDeadline: {
      makeDeadline: () => Date.now() + 35_000,
      requireTime: () => {},
      boundedWait: async () => {},
    },
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(pickerSource, context);
  return { context };
}

test('frame picker: an in-try failure rethrows with the recorded picker diagnostics attached', async () => {
  const { context } = pickerHarness();
  await assert.rejects(
    context.chooseNativePickerAsset('Wanted Asset', 'start', { deadline: Date.now() + 35_000 }),
    error => {
      assert.equal(error.code, 'FLOW_ASSET_NOT_FOUND', 'the error code is unchanged');
      assert.match(error.message, /no exact asset titled "Wanted Asset"/, 'the error message is unchanged');
      const framePicker = error.diagnostics?.framePicker;
      assert.ok(framePicker, 'error.diagnostics.framePicker is attached');
      assert.equal(framePicker.phase, 'selection_failed',
        'the snapshot is taken at the failure, before cleanup phases overwrite the live global');
      assert.equal(framePicker.assetName, 'Wanted Asset');
      assert.equal(framePicker.slot, 'start');
      assert.deepEqual(
        plain((framePicker.exactFrameList?.options || []).map(option => option.label)),
        ['Alpha Asset', 'Beta Asset'],
        'the options the picker actually showed travel with the error',
      );
      return true;
    },
  );
  // The live global moved on to the cleanup phase; the error kept its copy.
  assert.equal(context.FlowNativeFramePicker.inspectDiagnostics().phase, 'picker_closed');
});

test('frame picker: a failure before the guarded section keeps no fabricated diagnostics', async () => {
  const { context } = pickerHarness({ withOpener: false });
  await assert.rejects(
    context.chooseNativePickerAsset('Wanted Asset', 'start', { deadline: Date.now() + 35_000 }),
    error => {
      assert.equal(error.code, 'FLOW_FRAMES_CONTROLS_UNAVAILABLE');
      assert.equal(error.diagnostics, undefined,
        'errors thrown before the picker try block are not retro-fitted with diagnostics');
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Part 3 — queue panel diagnostics summary (flow-queue-panel.js)
// ---------------------------------------------------------------------------

class FakeEl {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.attributes = {};
    this.className = '';
    this.textContent = '';
    this.hidden = false;
    this.disabled = false;
  }

  append(...nodes) { this.children.push(...nodes); }
  appendChild(node) { this.children.push(node); return node; }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  querySelector() { return null; }
  querySelectorAll() { return []; }
}

function findByClass(element, needle, found = []) {
  if (!element || typeof element !== 'object') return found;
  if (String(element.className || '').includes(needle)) found.push(element);
  for (const child of element.children || []) findByClass(child, needle, found);
  return found;
}

function renderPanelItems(items) {
  const documentFake = {
    createElement: tag => new FakeEl(tag),
    createDocumentFragment: () => new FakeEl('#fragment'),
    getElementById: () => null,
    head: new FakeEl('head'),
    documentElement: new FakeEl('html'),
  };
  const sandbox = { console, document: documentFake };
  const context = vm.createContext(sandbox);
  vm.runInContext(panelJs, context);
  const container = new FakeEl('div');
  container.ownerDocument = documentFake;
  const panel = new context.FlowQueuePanel(container, { runtime: null });
  panel.itemsElement = new FakeEl('div');
  panel.summary = new FakeEl('span');
  panel.attentionBanner = new FakeEl('div');
  panel.snapshot = { items };
  panel.render();
  return panel.itemsElement;
}

function diagnosticsText(itemsElement) {
  return findByClass(itemsElement, 'flow-queue-panel__diagnostics')
    .map(element => element.textContent).join('\n');
}

test('panel: request diagnostics render as a compact summary under the error', () => {
  const itemsElement = renderPanelItems([{
    id: 'job-dispatch-timeout',
    label: 'video job',
    status: 'failed',
    errorCode: 'FLOW_OPERATION_TIMEOUT',
    error: 'Timed out while waiting for Flow request dispatch; no further Flow actions were started.',
    diagnostics: {
      clickDelivered: true,
      observerReady: true,
      xhrHookActive: true,
      fetchHookActive: false,
      requestDiagnostics: {
        version: 1,
        count: 2,
        events: [
          { transport: 'xhr', pathClass: 'video', pathRecognized: true, payloadMatched: false, fields: { prompt: true, videoModel: true, aspectRatio: false }, reasons: ['PAYLOAD_MISMATCH'] },
          { transport: 'fetch', path: '/api/<script>alert(1)</script>', pathRecognized: false, payloadMatched: false, fields: {}, reasons: ['PATH_UNRECOGNIZED'] },
        ],
      },
    },
  }]);
  const blocks = findByClass(itemsElement, 'flow-queue-panel__diagnostics');
  assert.ok(blocks.length >= 1, 'a diagnostics block renders for the failed job');
  const text = diagnosticsText(itemsElement);
  assert.match(text, /xhr/, 'the event transport is shown');
  assert.match(text, /video/, 'the event path class is shown');
  assert.match(text, /prompt/, 'matched field flags are shown');
  assert.match(text, /videoModel/, 'matched field flags are shown');
  assert.doesNotMatch(text, /aspectRatio/, 'unmatched field flags are not listed as matched');
  assert.match(text, /PAYLOAD_MISMATCH/, 'event reasons are shown');
  assert.match(text, /fetch/, 'the last events are shown, not just the first');
  assert.match(text, /PATH_UNRECOGNIZED/, 'the last event reasons are shown');
  assert.match(text, /ready/, 'the observer readiness flag is summarized');
  assert.ok(text.includes('/api/<script>alert(1)</script>'),
    'diagnostic strings reach the DOM as literal text (textContent), never as markup');
});

test('panel: an observer that saw no requests says so explicitly', () => {
  const itemsElement = renderPanelItems([{
    id: 'job-no-requests',
    label: 'video job',
    status: 'failed',
    errorCode: 'FLOW_OPERATION_TIMEOUT',
    error: 'Timed out while waiting for Flow request dispatch; no further Flow actions were started.',
    diagnostics: {
      clickDelivered: true,
      observerReady: false,
      xhrHookActive: false,
      fetchHookActive: false,
      requestDiagnostics: { version: 1, count: 0, events: [] },
    },
  }]);
  const text = diagnosticsText(itemsElement);
  assert.match(text, /none|no requests|0/i, 'an empty event list is stated, not silently omitted');
});

test('panel: frame picker diagnostics render phase, asset and the first option labels', () => {
  const options = Array.from({ length: 8 }, (_, i) => ({ label: `Option ${i + 1}`, ariaSelected: 'false' }));
  const itemsElement = renderPanelItems([{
    id: 'job-picker',
    label: 'frames job',
    status: 'failed',
    errorCode: 'FLOW_ASSET_NOT_FOUND',
    error: 'Flow\'s start frame picker has no exact asset titled "My Ref.png".',
    diagnostics: {
      framePicker: {
        phase: 'selection_failed',
        assetName: 'My Ref.png',
        slot: 'start',
        exactFrameList: { present: true, optionCount: 8, options },
      },
    },
  }]);
  const text = diagnosticsText(itemsElement);
  assert.match(text, /selection_failed/, 'the picker phase is shown');
  assert.match(text, /My Ref\.png/, 'the wanted asset name is shown');
  for (let i = 1; i <= 6; i++) assert.ok(text.includes(`Option ${i}`), `option label ${i} is shown`);
  assert.ok(!text.includes('Option 7'), 'option labels are capped at ~6');
  assert.ok(!text.includes('Option 8'), 'option labels are capped at ~6');
});

test('panel: a job without diagnostics renders no diagnostics block', () => {
  const itemsElement = renderPanelItems([
    { id: 'job-plain-fail', label: 'plain fail', status: 'failed', errorCode: 'FLOW_JOB_FAILED', error: 'boom' },
    { id: 'job-plain-ok', label: 'plain ok', status: 'completed' },
  ]);
  assert.equal(findByClass(itemsElement, 'flow-queue-panel__diagnostics').length, 0,
    'no diagnostics -> no extra DOM, exactly the historical rendering');
});

// ---------------------------------------------------------------------------
// Part 4 — DOM acceptance downgrade (generation-operations.js dispatch wait)
//
// Live failure: Flow accepted the submit click (the button state changed)
// but the correlation observer never matched a request payload, and the
// job died FLOW_SUBMIT_UNCONFIRMED after the full dispatch budget.
// TobyFlow treats the submit control's own acceptance as a confirmation
// signal and never lets payload correlation alone decide whether a submit
// lived. The dispatch wait now resolves at the acknowledged level via DOM
// acceptance after a short grace window — WITHOUT disarming the
// correlation attempt, so the observe phase keeps reading it and a late
// requestSeen is still recorded on the live entry.
// ---------------------------------------------------------------------------

test('dispatch wait: DOM acceptance resolves the submit as acknowledged (dom_acceptance) when no request is observed', async () => {
  const { submit, disarmCalls, correlationMap, elapsed } = dispatchHarness({
    waitMode: 'advance',
    requestSeen: false,
    activation: { clickDelivered: true, controlAccepted: true, strategy: 'fake-click' },
  });
  const result = await submit();
  assert.equal(result.submitted, true, 'the submit resolves instead of throwing');
  assert.equal(result.confirmationSignal, 'dom_acceptance');
  assert.equal(result.matchKind, 'dom_acceptance');
  assert.equal(result.requestDispatched, true, 'resolution is at the acknowledged level');
  assert.equal(result.serverAcceptanceObserved, false, 'no receipts -> no server-acceptance claim');
  assert.deepEqual(disarmCalls, [], 'the correlation attempt is NOT disarmed on the DOM-acceptance exit');
  assert.equal(correlationMap.has('attempt-1'), true, 'the attempt stays live for the observe phase');
  correlationMap.get('attempt-1').requestSeen = true;
  assert.equal(correlationMap.get('attempt-1').requestSeen, true, 'a late requestSeen still lands on the live entry');
  assert.ok(elapsed() >= 4_000 && elapsed() <= 10_000,
    `DOM acceptance resolves after a short grace (${elapsed()}ms), not the full 30s dispatch budget`);
});

test('dispatch wait: without requestSeen or DOM acceptance the unconfirmed timeout is unchanged', async () => {
  const { submit, disarmCalls } = dispatchHarness({
    waitMode: 'advance',
    requestSeen: false,
    activation: { clickDelivered: true, controlAccepted: false, strategy: 'fake-click' },
  });
  await assert.rejects(submit(), error => {
    assert.equal(error.code, 'FLOW_SUBMIT_UNCONFIRMED');
    assert.equal(error.outcome_unknown, true, 'a true no-signal timeout keeps outcome_unknown semantics');
    assert.deepEqual(plain(error.diagnostics), EXPECTED_DIAGNOSTICS, 'the diagnostics attach is unchanged');
    return true;
  });
  assert.deepEqual(disarmCalls, ['attempt-1'], 'a true no-signal timeout still disarms the attempt');
});

test('dispatch wait: a correlated request keeps the requestSeen path with no DOM-acceptance marking', async () => {
  const { submit } = dispatchHarness({
    waitMode: 'advance',
    requestSeen: true,
    activation: { clickDelivered: true, controlAccepted: true, strategy: 'fake-click' },
  });
  const result = await submit();
  assert.equal(result.submitted, true);
  assert.equal(result.requestDispatched, true);
  assert.equal(result.confirmationSignal, undefined, 'the requestSeen resolution carries no downgrade signal');
  assert.equal(result.matchKind, undefined, 'the requestSeen resolution keeps its historical shape');
});

test('frames submit: the selecting-asset stage label uses the stripped asset name', async () => {
  const { submit, progressMessages } = dispatchHarness({
    waitMode: 'advance',
    requestSeen: true,
    components: {
      chooseNativePickerAsset: async () => ({ id: '11111111-1111-4111-8111-111111111111' }),
    },
  });
  const result = await submit({
    video_settings: { mode: 'frames' },
    firstFrame: { assetName: 'asset:My Ref.png', kind: 'image' },
  });
  assert.equal(result.submitted, true);
  assert.ok(progressMessages.includes('Flow submit: selecting asset My Ref.png'),
    `expected the stripped stage label, saw: ${JSON.stringify(progressMessages)}`);
  assert.ok(!progressMessages.some(message => String(message).includes('asset asset:')),
    'no stage label may double the asset: scheme prefix');
});

// ---------------------------------------------------------------------------
// Part 5 — bridge timeout ambiguity (flow-editor.js activateFlowSubmitButton)
//
// The main-world slate bridge invokes Flow's Angular click listeners
// directly; when its result message is lost the activation used to throw
// FLOW_SUBMIT_BRIDGE_TIMEOUT even though the click had already landed on
// the button (the capture listener fired). TobyFlow treats that case as
// "dispatched, ambiguous": the activation returns with clickDelivered
// intact and an ambiguity flag, and no second click is attempted. Only a
// timeout where NO click ever landed still throws.
// ---------------------------------------------------------------------------

function editorHarness({ clickDuringBridge = false } = {}) {
  const clickListeners = new Set();
  let domClickCount = 0;
  const button = {
    isConnected: true,
    disabled: false,
    parentElement: {},
    attrs: {},
    scrollIntoView() {},
    focus() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 12, height: 12 }),
    getAttribute(name) { return this.attrs[name] ?? null; },
    setAttribute(name, value) { this.attrs[name] = String(value); },
    removeAttribute(name) { delete this.attrs[name]; },
    addEventListener(type, fn) { if (type === 'click') clickListeners.add(fn); },
    removeEventListener(type, fn) { if (type === 'click') clickListeners.delete(fn); },
    dispatchEvent(event) {
      if (event?.type === 'click') {
        for (const fn of [...clickListeners]) fn(event);
        clickListeners.clear(); // the delivered marker is registered once:true
      }
      return true;
    },
    click() { domClickCount++; },
  };
  const sandbox = {
    console, Date, Map, Set, Promise, Object, Math, String, Number, Boolean, Array, Error, RegExp, JSON,
    setTimeout, clearTimeout,
    location: { origin: 'https://flow.google.com', href: 'https://flow.google.com/project/proj-1' },
    crypto: { randomUUID: () => '123e4567-e89b-42d3-a456-426614174000' },
    flowError: (code, message, retryable, outcomeUnknown) =>
      Object.assign(new Error(message), { code, retryable, outcome_unknown: outcomeUnknown }),
    MutationObserver: class { observe() {} disconnect() {} },
    PointerEvent: class { constructor(type, init) { this.type = type; Object.assign(this, init || {}); } },
    MouseEvent: class { constructor(type, init) { this.type = type; Object.assign(this, init || {}); } },
    addEventListener: () => {},
    removeEventListener: () => {},
    postMessage: () => {
      if (clickDuringBridge) {
        // The main-world listener ran and its click landed on the button,
        // but its result message never comes back: the bridge times out.
        setTimeout(() => button.dispatchEvent({ type: 'click' }), 30);
      }
    },
  };
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(editorSource, context);
  return { activate: context.activateFlowSubmitButton, button, domClickCount: () => domClickCount };
}

test('editor bridge: a bridge timeout after the click landed returns an ambiguous delivered activation', async () => {
  const { activate, button, domClickCount } = editorHarness({ clickDuringBridge: true });
  const activation = await activate(button, 'a lighthouse');
  assert.equal(activation.clickDelivered, true, 'the delivered click stays delivered');
  assert.equal(activation.mainActivationAmbiguous, true, 'the lost bridge reply is flagged ambiguous');
  assert.equal(activation.mainListenerInvoked, false, 'no bridge reply -> the listener is not claimed invoked');
  assert.equal(domClickCount(), 0, 'no second DOM click after an ambiguous dispatch');
});

test('editor bridge: a bridge timeout with no delivered click still throws FLOW_SUBMIT_BRIDGE_TIMEOUT', async () => {
  const { activate, button, domClickCount } = editorHarness({ clickDuringBridge: false });
  await assert.rejects(activate(button, 'a lighthouse'), error => {
    assert.equal(error.code, 'FLOW_SUBMIT_BRIDGE_TIMEOUT');
    assert.equal(error.outcome_unknown, true, 'the genuine bridge failure keeps its unknown-outcome semantics');
    return true;
  });
  assert.equal(domClickCount(), 0, 'the throw happens before any fallback click');
});

// ---------------------------------------------------------------------------
// Part 6 — live DOM acceptance re-check (audit cluster B)
//
// The 585a50b DOM acceptance only saw the activation-time snapshot:
// activateFlowSubmitButton's acceptanceObserver disconnects ~180 ms after
// activation, so a submit control that Flow disables LATER (async Angular
// handling), an editor Flow clears later, or a first result tile rendered
// later all went unseen and the job still burned the full 30 s budget
// into FLOW_SUBMIT_UNCONFIRMED. The dispatch wait must re-check those
// three live signals on every iteration; any of them resolves exactly
// like the snapshot signal (dom_acceptance, observer kept alive).
// ---------------------------------------------------------------------------

test('dispatch wait: a LATE submit-button disable still resolves as dom_acceptance', async () => {
  const { submit, disarmCalls, elapsed } = dispatchHarness({
    waitMode: 'advance',
    requestSeen: false,
    activation: { clickDelivered: true, controlAccepted: false, strategy: 'fake-click' },
    liveButtonDisabledAfterMs: 1000,
  });
  const result = await submit();
  assert.equal(result.submitted, true, 'the submit resolves instead of throwing');
  assert.equal(result.confirmationSignal, 'dom_acceptance');
  assert.equal(result.matchKind, 'dom_acceptance');
  assert.deepEqual(disarmCalls, [], 'the correlation attempt is NOT disarmed on the live-DOM exit');
  assert.ok(elapsed() < 30_000, `late disable resolves before the full dispatch budget (${elapsed()}ms)`);
});

test('dispatch wait: a newly rendered result tile still resolves as dom_acceptance', async () => {
  const { submit, disarmCalls } = dispatchHarness({
    waitMode: 'advance',
    requestSeen: false,
    activation: { clickDelivered: true, controlAccepted: false, strategy: 'fake-click' },
    liveTilesAfterMs: 1000,
  });
  const result = await submit();
  assert.equal(result.submitted, true, 'a new tile vs the submit baseline resolves the submit');
  assert.equal(result.confirmationSignal, 'dom_acceptance');
  assert.deepEqual(disarmCalls, [], 'the correlation attempt is NOT disarmed on the live-DOM exit');
});

test('dispatch wait: an editor cleared after activation still resolves as dom_acceptance', async () => {
  const { submit, disarmCalls } = dispatchHarness({
    waitMode: 'advance',
    requestSeen: false,
    activation: { clickDelivered: true, controlAccepted: false, strategy: 'fake-click' },
    editorClearedAfterMs: 1000,
  });
  const result = await submit();
  assert.equal(result.submitted, true, 'an editor that held text pre-click and is empty now resolves the submit');
  assert.equal(result.confirmationSignal, 'dom_acceptance');
  assert.deepEqual(disarmCalls, [], 'the correlation attempt is NOT disarmed on the live-DOM exit');
});

test('dispatch wait: live signals that never arrive keep the unconfirmed timeout', async () => {
  const { submit, disarmCalls } = dispatchHarness({
    waitMode: 'advance',
    requestSeen: false,
    activation: { clickDelivered: true, controlAccepted: false, strategy: 'fake-click' },
    liveButtonDisabledAfterMs: 10_000_000,
  });
  await assert.rejects(submit(), error => {
    assert.equal(error.code, 'FLOW_SUBMIT_UNCONFIRMED');
    assert.equal(error.outcome_unknown, true, 'a true no-signal timeout keeps outcome_unknown semantics');
    return true;
  });
  assert.deepEqual(disarmCalls, ['attempt-1'], 'a true no-signal timeout still disarms the attempt');
});
