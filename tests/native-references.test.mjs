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

test('Vietnamese localization: readGenerationCreditQuote accurately parses Vietnamese credit text', () => {
  const domUtilsSource = readFileSync(new URL('../extension/content/shared/dom-utils.js', import.meta.url), 'utf8');
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
  const domUtilsSource = readFileSync(new URL('../extension/content/shared/dom-utils.js', import.meta.url), 'utf8');
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

test('Vietnamese localization: flowRadio and flowNavigationItem resolve Vietnamese labels', () => {
  const domUtilsSource = readFileSync(new URL('../extension/content/shared/dom-utils.js', import.meta.url), 'utf8');
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
  const domUtilsSource = readFileSync(new URL('../extension/content/shared/dom-utils.js', import.meta.url), 'utf8');
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

test('I18n core: translations, plurals, string interpolation and UI pattern lookup work seamlessly', async () => {
  const i18nSource = readFileSync(new URL('../extension/content/shared/I18n.js', import.meta.url), 'utf8');
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
  assert.equal(I18n.t('popup.wsConnected'), 'Đã kết nối WebSocket');
  assert.equal(I18n.t('popup.tabsCount', 3), '3 tab đang mở');
  assert.equal(I18n.t('errors.navUnavailable', { label: 'All media' }), 'Không thể mở mục "All media" từ giao diện này.');

  // Check pattern lookup in VI
  const viPatterns = I18n.getPatterns('all_media');
  assert.ok(viPatterns.includes('tất cả nội dung nghe nhìn'));
  assert.ok(viPatterns.includes('all media'));

  // Switch to English
  await I18n.setLocale('en');
  assert.equal(I18n.getLocale(), 'en');
  assert.equal(I18n.t('popup.wsConnected'), 'Connected via WebSocket');
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
  const domUtilsSource = readFileSync(new URL('../extension/content/shared/dom-utils.js', import.meta.url), 'utf8');
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
  const domUtilsSource = readFileSync(new URL('../extension/content/shared/dom-utils.js', import.meta.url), 'utf8');
  const editorSource = readFileSync(new URL('../extension/content/providers/flow/FlowEditor.js', import.meta.url), 'utf8');

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
  const domUtilsSource = readFileSync(new URL('../extension/content/shared/dom-utils.js', import.meta.url), 'utf8');
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
  const domUtilsSource = readFileSync(new URL('../extension/content/shared/dom-utils.js', import.meta.url), 'utf8');
  const tilesSource = readFileSync(new URL('../extension/content/providers/flow/FlowTiles.js', import.meta.url), 'utf8');

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
