import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const operationsSource = readFileSync(new URL('../extension/src/content/providers/flow/generation/generation-operations.js', import.meta.url), 'utf8');
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

function dispatchHarness({ health = HEALTH, waitMode = 'throw-timeout' } = {}) {
  const correlationMap = new Map([
    ['attempt-1', { attemptId: 'attempt-1', requestSeen: false, receipts: [], interfered: false }],
  ]);
  const disarmCalls = [];
  let now = 1_000_000;
  const fakeTiles = {
    stabilizeFlowResultViewport: async () => {},
    collectNativeMedia: () => [],
    armNativeFlowCorrelation: () => 'attempt-1',
    nativeFlowCorrelationMap: () => correlationMap,
    disarmNativeFlowCorrelation: id => { disarmCalls.push(id); },
    emitFlowProgress: () => {},
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
    },
    FlowEditor: {
      preflightGenerationPrompt: async () => ({}),
      insertNativeFlowPrompt: async () => true,
      waitForGenerationCreditQuote: async () => 10,
      waitForGenerationSubmitButton: async () => ({ disabled: false, getAttribute: () => null }),
      activateFlowSubmitButton: async () => ({ clickDelivered: true, strategy: 'fake-click' }),
      currentFlowSubmitErrors: () => [],
    },
    FlowSettings: {},
    FlowComponents: {},
    FlowTiles: fakeTiles,
    FlowMediaMenu: { nativeRead: () => ({ signedIn: true, inProject: true }) },
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
  return { submit, disarmCalls };
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
