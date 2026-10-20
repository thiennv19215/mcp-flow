import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { extensionSetWebSocket } from '../dist/extension.js';
import { runGeneration } from '../dist/flow.js';
import { getCachedProjectMedia, cacheProjectMedia } from '../dist/flow-transfer.js';

const source = readFileSync(new URL('../extension/content/providers/flow/FlowComponents.js', import.meta.url), 'utf8');
function harness({ names = ['MCP Test Mug'], addedKind = 'character', hideAttached = false } = {}) {
  let open = true, ticks = 0;
  const attached = [];
  let clicks = 0;
  const image = src => ({ alt: addedKind === 'character' ? 'Character ingredient image' : 'Image ingredient image', getAttribute: () => src });
  const option = name => ({ name, getAttribute: () => null, querySelectorAll: () => [], click() {
    clicks++; open = false;
    if (hideAttached) entries.splice(0, entries.length);
    attached.push({ querySelector: () => image('https://flow.google.com/asb/portrait=s512-rw'), closest: () => addedKind === 'character' ? {} : null });
  } });
  const entries = names.map(option);
  const list = { querySelectorAll: selector => selector === '[role="option"]' ? entries : [] };
  const opener = { getAttribute: () => open ? 'true' : 'false', click: () => { open = !open; } };
  const tab = { name: 'Characters', getAttribute: () => 'true' };
  const tile = { getAttribute: () => 'MCP Test Mug', querySelector: selector => selector === 'flow-character-tile' ? {} : image('https://flow-content.google/image/different-thumbnail') };
  const document = { body: { innerText: '' },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || (selector === '.ProseMirror' ? {} : null); },
    querySelectorAll(selector) {
    if (selector === '[role="listbox"]') return open ? [list] : [];
    if (selector === '[role="progressbar"]') return [];
    if (selector === '[role="tab"]') return [tab];
    if (selector === 'button[aria-label="Ingredient"]') return attached;
    if (selector === 'flow-grid-tile-container') return [tile];
    return [];
  } };
  const context = vm.createContext({ document, location: { href: 'https://flow.google.com/project/test', pathname: '/project/test' }, Date: { now: () => ticks += 500 }, visible: () => true,
    accessibleName: el => el.name || '', flowButton: name => name === 'Add ingredients to the prompt box' ? opener : null,
    wait: async () => {}, flowError: (code, message) => Object.assign(new Error(message), { code }),
  });
  vm.runInContext(source, context);
  return { api: context.FlowReferenceActions, clicks: () => clicks };
}

test('character is confirmed by a new typed chip even when thumbnail and chip CDN URLs differ', async () => {
  const { api } = harness();
  const result = await api.attach('character:MCP Test Mug');
  assert.equal(result.confirmed, true);
  assert.equal(result.kind, 'character');
  assert.equal(result.name, 'MCP Test Mug');
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
  await assert.rejects(api.attach('character:MCP Test Mug'), error => error.code === 'FLOW_REFERENCE_ATTACH_UNCONFIRMED');
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

test('classifyFlowError identifies quota, unusual activity, policy, and rate limits correctly', () => {
  const domUtilsSource = readFileSync(new URL('../extension/content/shared/dom-utils.js', import.meta.url), 'utf8');
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
  const domUtilsSource = readFileSync(new URL('../extension/content/shared/dom-utils.js', import.meta.url), 'utf8');
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
  const domUtilsSource = readFileSync(new URL('../extension/content/shared/dom-utils.js', import.meta.url), 'utf8');
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
  const domUtilsSource = readFileSync(new URL('../extension/content/shared/dom-utils.js', import.meta.url), 'utf8');
  let closeClicked = false;
  let escapeCount = 0;

  const closeButton = {
    nodeType: 1,
    name: 'Close dialog',
    innerText: 'Close',
    getAttribute: (attr) => attr === 'aria-label' ? 'Close dialog' : null,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ width: 40, height: 40 }),
    click: () => { closeClicked = true; },
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
        if (selector.includes('[role="dialog"]')) return [modalDialog];
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
});

test('FlowDriverRegistry correctly flags sub-routes like /character as not project editor', () => {
  const registrySource = readFileSync(new URL('../extension/content/providers/ProviderRegistry.js', import.meta.url), 'utf8');
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
  const registrySource = readFileSync(new URL('../extension/content/providers/ProviderRegistry.js', import.meta.url), 'utf8');
  const domUtilsSource = readFileSync(new URL('../extension/content/shared/dom-utils.js', import.meta.url), 'utf8');

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
  const domUtilsSource = readFileSync(new URL('../extension/content/shared/dom-utils.js', import.meta.url), 'utf8');
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
  const domUtilsSource = readFileSync(new URL('../extension/content/shared/dom-utils.js', import.meta.url), 'utf8');
  let removedCount = 0;
  const chips = [
    {
      nodeType: 1,
      name: 'Ingredient: Old Cat',
      innerText: 'Ingredient: Old Cat',
      getAttribute: () => null,
      getBoundingClientRect: () => ({ width: 100, height: 30 }),
      querySelectorAll: selector => [],
      click: () => { chips.shift(); removedCount++; },
    }
  ];

  const context = vm.createContext({
    globalThis: {},
    window: {},
    URL,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    setTimeout: fn => fn(),
    clearTimeout: () => {},
    document: {
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
