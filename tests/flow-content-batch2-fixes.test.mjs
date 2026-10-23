import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import { flowComponentsSource } from './helpers/flow-components-source.mjs';

const observerSource = readFileSync(new URL('../extension/src/content/bridge/flow-correlation-observer.js', import.meta.url), 'utf8');
const interceptorSource = readFileSync(new URL('../extension/src/content/bridge/media-interceptor.js', import.meta.url), 'utf8');
const projectId = '00000000-0000-4000-8000-000000000000';

// ---------------------------------------------------------------------------
// Fix 1 + Fix 6: correlation observer (with the media interceptor loaded
// after it, exactly as the manifest orders the MAIN-world scripts).
// ---------------------------------------------------------------------------

function observerHarness() {
  const listeners = new Map();
  const dispatched = [];
  const window = {
    addEventListener(type, listener) {
      const entries = listeners.get(type) || [];
      entries.push(listener);
      listeners.set(type, entries);
    },
    removeEventListener(type, listener) {
      listeners.set(type, (listeners.get(type) || []).filter((entry) => entry !== listener));
    },
    dispatchEvent(event) {
      dispatched.push(event);
      for (const listener of listeners.get(event.type) || []) listener(event);
      return true;
    },
    fetch: async () => ({ status: 200, clone: () => ({ text: async () => '' }) }),
  };
  class FakeXHR {
    open() {}
    send() {}
    addEventListener() {}
  }
  class FakeCustomEvent {
    constructor(type, options = {}) { this.type = type; this.detail = options.detail; }
  }
  window.CustomEvent = FakeCustomEvent;
  const context = vm.createContext({
    window,
    document: { addEventListener() {} },
    XMLHttpRequest: FakeXHR,
    CustomEvent: FakeCustomEvent,
    URL,
    URLSearchParams,
    FormData,
    ArrayBuffer,
    Uint8Array,
    TextDecoder,
    Blob,
    Request,
    Headers,
    location: { href: `https://labs.google/u/0/project/${projectId}`, origin: 'https://labs.google', pathname: `/u/0/project/${projectId}` },
    console: { info() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    Date,
    Map,
    WeakMap,
    Object,
    Array,
    Math,
    Number,
    String,
    RegExp,
    JSON,
    Promise,
  });
  vm.runInContext(observerSource, context);
  return { window, context, dispatched };
}

function promptFingerprint(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `id-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function armAttempt(window, { attemptId, nonce, prompt = 'fixture prompt' }) {
  window.dispatchEvent(new window.CustomEvent('TOBY_FLOW_V2_CORRELATION_ARM', {
    detail: {
      schemaVersion: 1,
      nonce,
      attemptId,
      mediaType: 'video',
      projectId,
      expectedQuantity: 1,
      promptFingerprint: promptFingerprint(prompt),
      expectedVideoModelKey: 'veo-3',
      expectedReferenceIds: [],
      expectedMediaReferenceIds: [],
      expectedCharacterIds: [],
      ttlMs: 60000,
    },
  }));
}

test('fix 1: observer still reports its fetch hook active after the media interceptor wraps fetch', () => {
  const { window, context } = observerHarness();
  const before = window.__tobyFlowCorrelationObserver.health();
  assert.equal(before.fetchHookActive, true);
  assert.equal(before.ready, true);

  // Manifest order: the interceptor loads AFTER the observer and wraps
  // window.fetch. Before the fix this made fetchHookActive false forever,
  // so the first strict generation on a fresh page could never arm.
  vm.runInContext(interceptorSource, context);
  assert.equal(window.fetch.name, 'flowMcpWatermarkFetch');
  assert.equal(typeof window.fetch.__flowMcpWrappedFetch, 'function');
  assert.notEqual(window.fetch.__flowMcpWrappedFetch, window.fetch);

  const after = window.__tobyFlowCorrelationObserver.health();
  assert.equal(after.fetchHookActive, true, 'the observer hook is still in the fetch chain via the interceptor wrapper');
  assert.equal(after.ready, true);
});

test('fix 1: an unrelated fetch wrapper does not masquerade as the observer hook', () => {
  const { window } = observerHarness();
  const observerFetch = window.fetch;
  window.fetch = async () => ({ status: 200 });
  const health = window.__tobyFlowCorrelationObserver.health();
  assert.equal(health.fetchHookActive, false);
  assert.equal(health.ready, false);
  window.fetch = observerFetch;
});

test('fix 6: one dispatch matching two live attempts marks both as interfered instead of expiring silently', async () => {
  const { window, dispatched } = observerHarness();
  const attemptA = '00000000-0000-4000-8000-000000000001';
  const attemptB = '00000000-0000-4000-8000-000000000002';
  armAttempt(window, { attemptId: attemptA, nonce: 'test-nonce-aaaaaaaa' });
  armAttempt(window, { attemptId: attemptB, nonce: 'test-nonce-bbbbbbbb' });

  const prompt = 'fixture prompt';
  const row = [null, null, [[[prompt]]], [], 'veo-3', 1];
  const payload = [[row]];
  const fReq = JSON.stringify([[['rpc.videoFixture', JSON.stringify(payload), null]]]);
  await window.fetch('https://labs.google/u/0/_/AiSandboxAngularFrontend/data/batchexecute?at=private', {
    method: 'POST',
    body: new URLSearchParams({ 'f.req': fReq }).toString(),
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  const receipts = dispatched.filter((event) => event.type === 'TOBY_FLOW_CORRELATION_RECEIPT').map((event) => event.detail);
  for (const attemptId of [attemptA, attemptB]) {
    const unknown = receipts.find((detail) => detail.attemptId === attemptId && detail.stage === 'acceptance_unknown');
    assert.ok(unknown, `attempt ${attemptId} must surface acceptance_unknown`);
    assert.equal(unknown.reason, 'ambiguous_live_request');
  }
  assert.equal(receipts.some((detail) => detail.stage === 'request_seen'), false, 'the dispatch must not be attributed to either attempt');
  assert.equal(window.__tobyFlowCorrelationObserver.health().activeAttempts, 2);
});

// ---------------------------------------------------------------------------
// Fix 2 + Fix 7: source contracts (these code paths need the full Flow UI
// to execute, so the regression is pinned at the exact broken expression).
// ---------------------------------------------------------------------------

test('fix 2: agent batch pass loop calls the local pass runner, not a nonexistent method', () => {
  const source = readFileSync(new URL('../extension/src/content/providers/flow/workflows/workflow-operations.js', import.meta.url), 'utf8');
  assert.ok(!source.includes('this.runAgentBatchPass'), 'this.runAgentBatchPass does not exist and throws TypeError on every batch');
  assert.match(source, /const runAgentBatchPass = async \(params, command, deadline, before\) =>/);
  assert.match(source, /await runAgentBatchPass\(passParams, command, deadline, before\)/);
});

test('fix 7: chooseRadio failure passes retryable as an argument, not inside the message', () => {
  const source = readFileSync(new URL('../extension/src/content/providers/flow/core/settings.js', import.meta.url), 'utf8');
  const index = source.indexOf('FLOW_OPTION_SELECTION_FAILED');
  assert.ok(index >= 0);
  const snippet = source.slice(index, index + 220);
  assert.ok(!snippet.includes('", true`'), 'the retryable flag must not be swallowed into the message template');
  assert.match(snippet, /Nothing was submitted\.`, true, false\)/);
});

// ---------------------------------------------------------------------------
// Fix 8: slate-bridge submit activation reports failure when every listener
// threw.
// ---------------------------------------------------------------------------

function slateBridgeHarness(listeners) {
  const posted = [];
  let messageListener = null;
  class FakeEventTarget {
    addEventListener() {}
    removeEventListener() {}
  }
  class FakeElement {}
  class FakeHTMLElement extends FakeElement {}
  class FakeButton extends FakeHTMLElement {}
  class FakeMouseEvent {
    constructor(type, init = {}) { this.type = type; Object.assign(this, init); }
  }
  const target = new FakeHTMLElement();
  const window = {
    addEventListener(type, listener) { if (type === 'message') messageListener = listener; },
    removeEventListener() {},
    postMessage(message) { posted.push(message); },
    location: { origin: 'https://flow.google.com' },
    ng: { getListeners: () => listeners },
  };
  const context = vm.createContext({
    window,
    document: { querySelector: () => target },
    EventTarget: FakeEventTarget,
    Element: FakeElement,
    HTMLElement: FakeHTMLElement,
    HTMLButtonElement: FakeButton,
    MouseEvent: FakeMouseEvent,
    Set,
    WeakMap,
    console: { log() {}, warn() {} },
  });
  vm.runInContext(readFileSync(new URL('../extension/src/content/bridge/slate-bridge.js', import.meta.url), 'utf8'), context);
  const activate = () => {
    posted.length = 0;
    messageListener({
      source: window,
      data: {
        source: 'flow-auto-slate',
        action: 'activateV2Submit',
        requestId: 'req-1',
        submitToken: '01234567-89ab-4cde-8f01-23456789abcd',
      },
    });
    return posted[0];
  };
  return { activate };
}

test('fix 8: slate bridge reports failure when every submit listener throws', () => {
  const { activate } = slateBridgeHarness([
    { name: 'click', callback() { throw new Error('boom-1'); } },
    { name: 'click', callback() { throw new Error('boom-2'); } },
  ]);
  const result = activate();
  assert.equal(result.invoked, 2);
  assert.equal(result.errors, 2);
  assert.equal(result.success, false);
});

test('fix 8: slate bridge keeps reporting success on partial listener failure', () => {
  const { activate } = slateBridgeHarness([
    { name: 'click', callback() { throw new Error('boom'); } },
    { name: 'click', callback() { return undefined; } },
  ]);
  const result = activate();
  assert.equal(result.invoked, 2);
  assert.equal(result.errors, 1);
  assert.equal(result.success, true);
});

// ---------------------------------------------------------------------------
// Fix 10: a duplicate execute with an active requestId is rejected and the
// first command stays cancellable.
// ---------------------------------------------------------------------------

test('fix 10: duplicate requestId cannot orphan the first command', async () => {
  const source = readFileSync(new URL('../extension/src/content/dom-actions.js', import.meta.url), 'utf8');
  let listener = null;
  const driver = {
    invoke: (name, payload, command) => new Promise((resolve, reject) => {
      command.signal.addEventListener('abort', () => {
        reject(Object.assign(new Error('cancelled'), { code: 'FLOW_OPERATION_CANCELLED' }));
      }, { once: true });
    }),
  };
  const context = vm.createContext({
    chrome: { runtime: { onMessage: { addListener: (fn) => { listener = fn; } } } },
    location: { href: 'https://flow.google.com/project/01234567-89ab-4cde-8f01-23456789abcd' },
    ProviderRegistry: { resolveForUrl: () => ({ driver }) },
    flowError: (code, message, retryable, outcome_unknown) => Object.assign(new Error(message), { code, retryable, outcome_unknown }),
    AbortController,
    Date,
    Map,
    Promise,
    Object,
    String,
    Error,
  });
  vm.runInContext(source, context);
  assert.equal(typeof listener, 'function');

  const send = (message) => {
    const responses = [];
    listener(message, {}, (data) => responses.push(data));
    return responses;
  };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
  const executeMessage = () => ({
    type: 'flow-mcp:execute',
    command: { op: 'flowOperation', name: 'flow.generation.submit', payload: {}, requestId: 'req-dup' },
  });

  const first = send(executeMessage());
  await tick();
  assert.equal(first.length, 0, 'the first command is still running');

  const duplicate = send(executeMessage());
  await tick();
  assert.equal(duplicate.length, 1, 'the duplicate must be answered immediately');
  assert.equal(duplicate[0].ok, false);
  assert.equal(duplicate[0].error.code, 'FLOW_COMMAND_ALREADY_ACTIVE');
  assert.equal(first.length, 0, 'the first command must not be disturbed by the duplicate');

  const cancelResponses = send({ type: 'flow-mcp:cancel', requestId: 'req-dup' });
  assert.deepEqual(JSON.parse(JSON.stringify(cancelResponses)), [{ ok: true, cancelled: true }]);
  await tick();
  assert.equal(first.length, 1, 'the first command must still be cancellable');
  assert.equal(first[0].ok, false);
  assert.equal(first[0].error.code, 'FLOW_OPERATION_CANCELLED');
});

// ---------------------------------------------------------------------------
// Fix 3: upload reuse requires size evidence when the staged size is known.
// ---------------------------------------------------------------------------

function sizedTileHarness({ tileSize }) {
  const name = 'IMG_1234.png';
  const mediaId = '22222222-2222-4222-8222-222222222222';
  const tile = {
    getAttribute(attribute) {
      if (attribute === 'aria-label') return name;
      if (attribute === 'data-file-size') return tileSize === null ? null : String(tileSize);
      return null;
    },
    get innerText() { return name; },
    get textContent() { return name; },
    querySelector(selector) {
      if (selector === 'flow-image-tile,img') return {};
      return null;
    },
  };
  const context = vm.createContext({
    document: { querySelectorAll: (selector) => (selector === 'flow-grid-tile-container' ? [tile] : []) },
    FlowTiles: { isTileMediaReady: () => true },
    mediaId: () => mediaId,
    flowError: (code, message, retryable, outcome_unknown) => Object.assign(new Error(message), { code, retryable, outcome_unknown }),
  });
  vm.runInContext(flowComponentsSource, context);
  return { uploader: context.FlowUploader, name, mediaId };
}

test('fix 3: a same-name tile with a different file size is not reused; the upload path runs instead', async () => {
  const { uploader, name } = sizedTileHarness({ tileSize: 2000 });
  await assert.rejects(
    uploader.upload({ name, size: 1000 }, 'image', {}),
    // No FlowMediaMenu exists in this harness, so reaching the fresh-upload
    // path surfaces as the baseline failure — proof the reuse path was NOT
    // taken (the old code resolved with reused: true here).
    (error) => error.code === 'FLOW_UPLOAD_BASELINE_UNAVAILABLE',
  );
});

test('fix 3: a same-name tile without any size evidence is not reused when the staged size is known', async () => {
  const { uploader, name } = sizedTileHarness({ tileSize: null });
  await assert.rejects(
    uploader.upload({ name, size: 1000 }, 'image', {}),
    (error) => error.code === 'FLOW_UPLOAD_BASELINE_UNAVAILABLE',
  );
});

test('fix 3: a same-name tile with the exact same size keeps the reuse fast-path', async () => {
  const { uploader, name, mediaId } = sizedTileHarness({ tileSize: 1000 });
  const result = await uploader.upload({ name, size: 1000 }, 'image', {});
  // IMG-03: the receipt surfaces the canonical media UUID (here the tile id
  // already is one) as mediaUuid alongside the unchanged legacy fields.
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    uploaded: true, name, kind: 'image', id: mediaId, reused: true, mediaUuid: mediaId,
  });
});

// ---------------------------------------------------------------------------
// Fix 9: resolveNativeMediaUuid waits out its window for a later publish.
// ---------------------------------------------------------------------------

function identitiesHarness() {
  const listeners = new Map();
  const window = {
    addEventListener(type, listener) {
      const entries = listeners.get(type) || [];
      entries.push(listener);
      listeners.set(type, entries);
    },
    removeEventListener(type, listener) {
      listeners.set(type, (listeners.get(type) || []).filter((entry) => entry !== listener));
    },
    dispatchEvent(event) {
      for (const listener of listeners.get(event.type) || []) listener(event);
      return true;
    },
  };
  class FakeCustomEvent {
    constructor(type, options = {}) { this.type = type; this.detail = options.detail; }
  }
  const uuid = '01234567-89ab-4cde-8f01-23456789abcd';
  const context = vm.createContext({
    window,
    CustomEvent: FakeCustomEvent,
    location: { pathname: `/project/${uuid}/`, href: `https://flow.google.com/project/${uuid}/` },
    setTimeout,
    clearTimeout,
    console: { info() {}, warn() {}, error() {} },
  });
  vm.runInContext(readFileSync(new URL('../extension/src/content/providers/flow/composer/reference-actions.js', import.meta.url), 'utf8'), context);
  const publish = (entries) => window.dispatchEvent({
    type: 'TOBY_FLOW_MEDIA_IDENTITIES',
    detail: { projectId: uuid, entries },
  });
  return { resolveNativeMediaUuid: context.resolveNativeMediaUuid, publish, uuid };
}

test('fix 9: media UUID resolution waits for a publish that actually contains the ASB', async () => {
  const { resolveNativeMediaUuid, publish, uuid } = identitiesHarness();
  const asb = `asb:${'A'.repeat(40)}`;
  let settled = false;
  const pending = resolveNativeMediaUuid(asb, 'image').then((value) => { settled = true; return value; });
  publish([{ asb: 'some-other-asset', mediaType: 'image', mediaUuid: '99999999-9999-4999-8999-999999999999' }]);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(settled, false, 'a publish without the requested ASB must not settle the lookup');
  publish([{ asb: 'A'.repeat(40), mediaType: 'image', mediaUuid: uuid }]);
  assert.equal(await pending, uuid);
});

test('fix 9: media UUID resolution still settles undefined on ambiguity', async () => {
  const { resolveNativeMediaUuid, publish, uuid } = identitiesHarness();
  const asb = `asb:${'B'.repeat(40)}`;
  const pending = resolveNativeMediaUuid(asb, 'video');
  publish([
    { asb: 'B'.repeat(40), mediaType: 'video', mediaUuid: uuid },
    { asb: 'B'.repeat(40), mediaType: 'video', mediaUuid: '99999999-9999-4999-8999-999999999999' },
  ]);
  assert.equal(await pending, undefined);
});

// ---------------------------------------------------------------------------
// Fix 4: project recovery must return to the operation's target project.
// ---------------------------------------------------------------------------

function navigationHarness() {
  const projectA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const projectB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const projectC = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const editorUrl = (id) => `https://flow.google.com/project/${id}`;
  const location = {
    href: 'https://flow.google.com/',
    origin: 'https://flow.google.com',
    get pathname() { return new URL(this.href).pathname; },
    assign(url) { this.href = url; },
  };
  let newProjectClicks = 0;
  const clickedCards = [];
  const newProjectBtn = {
    innerText: 'New project',
    textContent: 'New project',
    querySelectorAll: () => [],
    click() { newProjectClicks++; location.href = editorUrl(projectC); },
  };
  const makeCard = (id) => ({
    getAttribute: (attribute) => (attribute === 'href' ? `/project/${id}` : null),
    click() { clickedCards.push(id); location.href = editorUrl(id); },
  });
  const cards = [makeCard(projectB), makeCard(projectA)]; // B is first in the DOM
  const document = {
    querySelectorAll: (selector) => {
      if (selector === 'button, a[role="button"]') return [newProjectBtn];
      if (selector === 'a[href*="/project/"]') return cards;
      return [];
    },
    querySelector: (selector) => (selector === 'a[href*="/project/"]' ? cards[0] : null),
  };
  const context = vm.createContext({
    location,
    document,
    visible: () => true,
    accessibleName: (el) => el.innerText || '',
    matchesFlowUiRegex: (value, regex) => regex.test(value),
    wait: async () => {},
    console: { log() {}, warn() {}, error() {} },
    flowError: (code, message, retryable, outcome_unknown) => Object.assign(new Error(message), { code, retryable, outcome_unknown }),
    ProviderRegistry: {
      describeUrl: (url) => {
        const pathname = new URL(url).pathname;
        const editor = pathname.match(/^\/project\/([0-9a-f-]{36})\/?$/i);
        const sub = pathname.match(/^\/project\/([0-9a-f-]{36})\//i);
        if (editor) return { driverKey: 'flow', origin: 'https://flow.google.com', projectId: editor[1], routePrefix: '', isProjectEditor: true };
        if (sub) return { driverKey: 'flow', origin: 'https://flow.google.com', projectId: sub[1], routePrefix: '', isProjectEditor: false };
        return { driverKey: 'flow', origin: 'https://flow.google.com', projectId: null, routePrefix: '', isProjectEditor: false };
      },
    },
    FlowSelectors: { navigation: { newProjectButton: { textRegex: /new project/i } } },
    setTimeout, clearTimeout, Date, Promise, Object, String, Number, Array, Error, URL, RegExp, Map, Set,
  });
  vm.runInContext(readFileSync(new URL('../extension/src/content/providers/flow/core/navigation.js', import.meta.url), 'utf8'), context);
  return {
    nav: context.FlowNavigation,
    location,
    editorUrl,
    projectA, projectB, projectC,
    stats: () => ({ newProjectClicks, clickedCards: [...clickedCards] }),
  };
}

test('fix 4: recovery after leaving the project mid-operation reopens the verified project, not a new or arbitrary one', async () => {
  const h = navigationHarness();
  h.location.href = h.editorUrl(h.projectA);
  const first = await h.nav.ensureFlowProjectEditor();
  assert.equal(first.projectId, h.projectA);

  // The tab leaves the project (user navigation / Flow redirect) while an
  // operation bound to project A is in flight.
  h.location.href = 'https://flow.google.com/';
  const recovered = await h.nav.ensureFlowProjectEditor();
  assert.equal(recovered.projectId, h.projectA);
  assert.deepEqual(h.stats().clickedCards, [h.projectA]);
  assert.equal(h.stats().newProjectClicks, 0, 'recovery must never create a project for a targeted operation');
});

test('fix 4: an explicit target project is reopened by card, and fails closed when it cannot be', async () => {
  const h = navigationHarness();
  const recovered = await h.nav.ensureFlowProjectEditor({ expectedProjectId: h.projectB });
  assert.equal(recovered.projectId, h.projectB);
  assert.equal(h.stats().newProjectClicks, 0);

  const missing = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  h.location.href = 'https://flow.google.com/';
  await assert.rejects(
    h.nav.ensureFlowProjectEditor({ expectedProjectId: missing }),
    (error) => error.code === 'FLOW_EXECUTION_TARGET_CHANGED' && error.outcome_unknown === false,
  );
  assert.equal(h.stats().newProjectClicks, 0);
});

test('fix 4: with no target at all, the legacy open-any-project recovery is preserved', async () => {
  const h = navigationHarness();
  const result = await h.nav.ensureFlowProjectEditor();
  assert.equal(result.success, true);
  assert.equal(result.projectId, h.projectC, 'the no-target flow still uses the New project shortcut');
  assert.equal(h.stats().newProjectClicks, 1);
});

// ---------------------------------------------------------------------------
// Fix 11: rename input selection is scoped to the rename dialog when one is
// present, so the prompt editor is never rewritten.
// ---------------------------------------------------------------------------

test('fix 11: rename writes into the dialog field, never into a same-text prompt editor', async () => {
  const source = readFileSync(new URL('../extension/src/content/providers/flow/library/library-operations.js', import.meta.url), 'utf8');
  const assetId = '01234567-89ab-4cde-8f01-23456789abcd';
  const tile = {
    title: 'old title',
    id: assetId,
    getAttribute(name) { return name === 'aria-label' ? this.title : null; },
    scrollIntoView() {},
    querySelectorAll: () => [],
  };
  const dialogInput = {
    value: '',
    isContentEditable: false,
    getAttribute(name) { return name === 'placeholder' ? 'Rename' : null; },
    dispatchEvent() {},
  };
  const saveButton = {
    innerText: 'Save',
    click() { tile.title = dialogInput.value; },
  };
  const dialog = {
    querySelectorAll(selector) {
      if (selector === 'input:not([type="file"]),[contenteditable="true"]') return [dialogInput];
      if (selector === 'button,[role="button"]') return [saveButton];
      return [];
    },
    contains: (el) => el === dialogInput || el === saveButton,
  };
  // The prompt editor happens to contain exactly the asset's title text.
  const promptEditor = {
    isContentEditable: true,
    innerText: 'old title',
    textContent: 'old title',
    getAttribute: () => null,
    dispatchEvent() {},
  };
  const document = {
    querySelectorAll(selector) {
      if (selector === 'flow-grid-tile-container') return [tile];
      if (selector === '[role="menuitem"]') return [{ innerText: 'Rename', click() {} }];
      if (selector === '[role="dialog"],mat-dialog-container,.cdk-overlay-pane') return [dialog];
      if (selector === 'input:not([type="file"]),[contenteditable="true"]') return [promptEditor, dialogInput];
      return [];
    },
  };
  const context = vm.createContext({
    Date, Promise, Set, Object, String, Number, Array, Error,
    Event: class { constructor(type, options = {}) { this.type = type; Object.assign(this, options); } },
    KeyboardEvent: class { constructor(type, options = {}) { this.type = type; Object.assign(this, options); } },
    document,
    visible: () => true,
    accessibleName: (el) => el.innerText || '',
    mediaId: (el) => el.id,
    wait: async () => {},
    flowButton: (label) => (label === 'More options' ? { click() {} } : null),
    setEditable: (el, value) => { if (el.isContentEditable) { el.textContent = value; el.innerText = value; } else el.value = value; },
  });
  vm.runInContext(source, context);
  context.FlowTiles = { findFlowTile: async () => tile, countFlowTitleAcrossGrid: async () => 1 };
  context.FlowMediaMenu = { scanNativeAssets: async () => [{ id: assetId, name: 'old title' }] };
  const ops = new context.FlowLibraryOperations({
    error: (code, message, retryable, outcome_unknown) => Object.assign(new Error(message), { code, retryable, outcome_unknown }),
  });

  const result = await ops.execute('flow.asset.rename', { name: 'old title', id: assetId, newName: 'new title' }, { timeoutMs: 1000 });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { renamed: 'old title', name: 'new title', id: assetId });
  assert.equal(dialogInput.value, 'new title');
  assert.equal(promptEditor.textContent, 'old title', 'the prompt editor must never be rewritten by a rename');
});

// ---------------------------------------------------------------------------
// Fix 5: a frame slot is confirmed only when its content signature changes,
// not when the picker merely closes.
// ---------------------------------------------------------------------------

function slotAttachHarness({ applyToSlot }) {
  const source = readFileSync(new URL('../extension/src/content/providers/flow/composer/reference-actions.js', import.meta.url), 'utf8');
  let tick = 0;
  let pickerOpen = true;
  let slotMedia = [];
  const slotContainer = {
    querySelectorAll: (selector) => {
      if (selector === 'img,video') return slotMedia;
      return [];
    },
  };
  const slotButton = {
    name: 'Start',
    innerText: 'Start',
    textContent: 'Start',
    getAttribute: (key) => (key === 'aria-label' ? 'Start' : null),
    parentElement: { parentElement: slotContainer },
    click() {},
  };
  const optionTile = {
    getAttribute: (key) => (key === 'aria-label' ? 'frame.png' : null),
    querySelector: () => null,
  };
  const option = {
    name: 'frame.png',
    id: 'option-1',
    getAttribute: (key) => (key === 'aria-posinset' ? '1' : key === 'aria-label' ? 'frame.png' : null),
    querySelector: (selector) => (selector === 'flow-grid-tile-container' ? optionTile : null),
    querySelectorAll: () => [],
    click() {
      pickerOpen = false;
      if (applyToSlot) {
        slotMedia = [{ currentSrc: 'https://flow.google.com/asb/frame-1', getAttribute: () => null }];
      }
    },
  };
  const scroller = {
    style: { overflowY: 'auto' },
    clientHeight: 100,
    scrollHeight: 100,
    scrollTop: 0,
  };
  const owner = {
    parentElement: null,
    style: { overflowY: '' },
    clientHeight: 0,
    scrollHeight: 0,
    querySelectorAll: () => [],
  };
  const list = {
    clientHeight: 100,
    scrollTop: 0,
    scrollHeight: 100,
    getAttribute: (key) => (key === 'role' ? 'listbox' : null),
    querySelectorAll(selector) {
      if (selector === '[role="option"]') return [option];
      if (selector === '*') return [scroller];
      return [];
    },
    querySelector: () => null,
    closest: () => null,
  };
  list.parentElement = owner;
  const tab = {
    name: 'Tất cả',
    getAttribute: (key) => (key === 'aria-selected' ? 'true' : null),
    click() {},
  };
  const document = {
    documentElement: { lang: 'en' },
    body: { innerText: '' },
    querySelectorAll(selector) {
      if (selector === '[role="listbox"]') return pickerOpen ? [list] : [];
      if (selector === '[role="tab"]') return [tab];
      if (selector === '[role="dialog"],[role="menu"],[role="listbox"],mat-menu,mat-select-panel') return pickerOpen ? [list] : [];
      return [];
    },
    querySelector: () => null,
  };
  const context = vm.createContext({
    document,
    location: { href: 'https://flow.google.com/project/test', pathname: '/project/test' },
    Date: class MockDate extends Date { static now() { return tick; } },
    visible: () => true,
    mediaId: () => '22222222-2222-4222-8222-222222222222',
    accessibleName: (el) => el.name || el.getAttribute?.('aria-label') || '',
    flowButton: (name) => (name === 'Start' ? slotButton : null),
    wait: async (ms) => { tick += ms; },
    flowError: (code, message, retryable, outcome_unknown) => Object.assign(new Error(message), { code, retryable, outcome_unknown }),
  });
  vm.runInContext(source, context);
  return { api: context.FlowReferenceActions };
}

test('fix 5: picker closing without a slot change does not confirm a frame attach', async () => {
  const { api } = slotAttachHarness({ applyToSlot: false });
  // The old code resolved { confirmed: true } here. The fixed code keeps
  // waiting and fails with the loop's existing outcome-unknown timeout.
  await assert.rejects(
    api.attach({ assetName: 'frame.png', kind: 'image' }, 'start', {}),
    (error) => error.code === 'FLOW_OPERATION_TIMEOUT' && error.outcome_unknown === true,
  );
});

test('fix 5: picker closing after the slot content changed confirms the frame attach', async () => {
  const { api } = slotAttachHarness({ applyToSlot: true });
  const result = await api.attach({ assetName: 'frame.png', kind: 'image' }, 'start', {});
  assert.equal(result.confirmed, true);
  assert.equal(result.slot, 'start');
  assert.equal(result.name, 'frame.png');
});
