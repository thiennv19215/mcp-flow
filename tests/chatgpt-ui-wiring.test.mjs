import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

// GPT-14 — UI wiring contracts (provider tabs -> ChatGPT jobs).
//
// Selecting ChatGPT in #genProviderTabs switches the Gen form to the
// image-only configuration (ratio select repopulated from the GPT-01
// capability registry, ref picker capped at the registry maxRefImages)
// and makes submit build a `chatgpt.generation.submit` queue job with
// metadata.provider = "chatgpt" — the shape GPT-09's preflight admits
// and GPT-10's runner drains. The queue panel renders the provider
// badge from job.metadata.provider ONLY (absent -> Flow presentation
// as today). Flow form behavior is pinned unchanged.

import { parseChatGptCapabilityRegistry } from '../extension/src/background/chatgpt-capabilities.js';
import { validateChatGptJobPayloads } from '../extension/src/background/chatgpt-queue-preflight.js';

const sidebarJs = readFileSync(new URL('../extension/src/ui/sidebar.js', import.meta.url), 'utf8');
const sidebarHtml = readFileSync(new URL('../extension/src/ui/sidebar.html', import.meta.url), 'utf8');
const panelJs = readFileSync(new URL('../extension/src/ui/flow-queue-panel.js', import.meta.url), 'utf8');
const registryJson = JSON.parse(readFileSync(new URL('../chatgpt-model-capabilities.json', import.meta.url), 'utf8'));
const registry = parseChatGptCapabilityRegistry(registryJson);

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX///+/v7+jQ3Y5AAAADklEQVQI12P4AIX8EAgALgAD/aNpbtEAAAAASUVORK5CYII=';

// ---------------------------------------------------------------------------
// Extraction harness: the GPT-14 helpers live in sidebar.js between explicit
// markers, next to the Flow loader they mirror. Slice them (plus the
// pre-existing replaceSelectOptions they reuse) and run them against a fake
// DOM, the same extraction style other suites use for classic scripts.
// ---------------------------------------------------------------------------
function sliceBetween(source, startMarker, endMarker, label) {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `${label}: start marker not found: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `${label}: end marker not found: ${endMarker}`);
  return source.slice(start, end);
}

class FakeOption {
  constructor() { this.value = ''; this.textContent = ''; }
}

class FakeSelect {
  constructor(values = []) {
    this.children = [];
    this._value = '';
    for (const value of values) {
      const option = new FakeOption();
      option.value = value;
      option.textContent = value;
      this.children.push(option);
    }
    if (values.length) this._value = values[0];
  }

  replaceChildren() { this.children = []; }
  appendChild(child) { this.children.push(child); return child; }
  get options() { return this.children; }
  get value() { return this._value; }
  set value(next) {
    const text = String(next);
    this._value = this.children.some(option => option.value === text) ? text : '';
  }
  optionValues() { return this.children.map(option => option.value); }
}

function loadGpt14Helpers({ aspectValues = ['9:16'], ratioImageValues = ['9:16'] } = {}) {
  const replaceSource = sliceBetween(
    sidebarJs,
    'function replaceSelectOptions(',
    'function applyFlowModelControls(',
    'replaceSelectOptions',
  );
  const helpersSource = sliceBetween(
    sidebarJs,
    '// GPT-14:BEGIN chatgpt-form-helpers',
    '// GPT-14:END chatgpt-form-helpers',
    'GPT-14 helpers',
  );
  const aspectRatio = new FakeSelect(aspectValues);
  const selectRatioImage = new FakeSelect(ratioImageValues);
  const refSection = { dataset: {} };
  const refHint = { textContent: '' };
  const bySelector = {
    '#aspectRatio': aspectRatio,
    '#selectRatioImage': selectRatioImage,
    '#refImagesSection': refSection,
    '#refPickerLimitHint': refHint,
  };
  const documentFake = {
    querySelector: selector => bySelector[selector] || null,
    createElement: tag => (tag === 'option' ? new FakeOption() : {}),
  };
  const sandbox = { console, document: documentFake };
  const context = vm.createContext(sandbox);
  vm.runInContext(
    `${replaceSource}\n${helpersSource}\n;globalThis.__gpt14 = {`
    + ' chatGptSupportedRatios, chatGptMaxRefImages, applyChatGptRatioOptions,'
    + ' applyChatGptRefCap, buildChatGptGenerationJob };',
    context,
  );
  return { api: context.__gpt14, aspectRatio, selectRatioImage, refSection, refHint };
}

// ---------------------------------------------------------------------------
// Source contracts: the submit branch reads #genProvider
// ---------------------------------------------------------------------------
test('GPT-14: the unified Gen submit branch reads #genProvider and routes chatgpt to the chatgpt submit', () => {
  const start = sidebarJs.indexOf('document.querySelector("#genSubmitBtn")?.addEventListener');
  assert.ok(start >= 0, 'sidebar.js wires #genSubmitBtn');
  const branch = sidebarJs.slice(start, start + 1400);
  assert.match(branch, /document\.querySelector\("#genProvider"\)\?\.value === "chatgpt"/,
    'the submit branch reads the #genProvider hidden field');
  assert.match(branch, /submitChatGptGeneration\(\)/, 'the chatgpt branch calls the chatgpt submit');
  assert.match(branch, /#btnSubmitImage.*#btnSubmitVideo|isImage \? "#btnSubmitImage" : "#btnSubmitVideo"/,
    'the Flow path still delegates to the legacy Flow submit buttons');
});

test('GPT-14: the legacy image submit is also guarded so a chatgpt selection can never build a Flow job', () => {
  const start = sidebarJs.indexOf('document.querySelector("#btnSubmitImage").onclick');
  assert.ok(start >= 0, 'sidebar.js wires #btnSubmitImage');
  const head = sidebarJs.slice(start, start + 500);
  assert.match(head, /document\.querySelector\("#genProvider"\)\?\.value === "chatgpt"/);
  assert.match(head, /submitChatGptGeneration\(\)/);
});

test('GPT-14: the chatgpt submit sends flow-queue:add / add-batch with the built jobs', () => {
  const start = sidebarJs.indexOf('async function submitChatGptGeneration(');
  assert.ok(start >= 0, 'sidebar.js defines submitChatGptGeneration');
  const body = sidebarJs.slice(start, start + 6000);
  assert.match(body, /buildChatGptGenerationJob\(/, 'jobs are built by the GPT-14 builder');
  assert.match(body, /type: "flow-queue:add-batch", jobs/, 'multi-prompt submissions use add-batch');
  assert.match(body, /type: "flow-queue:add", job: jobs\[0\]/, 'single submissions use add');
  assert.match(body, /referencePicker\.getReferences\("image"\)/, 'refs come from the image reference picker');
  assert.match(body, /chatGptMaxRefImages\(registry\)/, 'the ref cap is read from the loaded registry');
  assert.match(body, /slice\(0, maxRefImages\)/, 'attachments are capped at the registry maxRefImages');
});

// ---------------------------------------------------------------------------
// The exact job shape (behavioral, via the extracted builder)
// ---------------------------------------------------------------------------
test('GPT-14: buildChatGptGenerationJob emits the exact chatgpt job shape', () => {
  const { api } = loadGpt14Helpers();
  const attachments = [{ name: 'ref.png', type: 'image/png', base64: PNG_BASE64 }];
  const job = api.buildChatGptGenerationJob({
    prompt: 'a cat astronaut', ratio: '16:9', attachments, autoDownload: true,
  });
  // The builder runs in a vm realm; compare structure via a JSON round-trip.
  assert.deepEqual(JSON.parse(JSON.stringify(job)), {
    operation: 'chatgpt.generation.submit',
    payload: {
      prompt: 'a cat astronaut',
      ratio: '16:9',
      attachments: [{ name: 'ref.png', type: 'image/png', base64: PNG_BASE64 }],
      autoDownload: true,
    },
    metadata: { provider: 'chatgpt', source: 'extension' },
    label: 'ChatGPT image: a cat astronaut',
  });
  assert.notEqual(job.payload.attachments, attachments, 'the job owns its attachments array');
});

test('GPT-14: a job built by the UI builder passes GPT-09 preflight shape validation', () => {
  const { api } = loadGpt14Helpers();
  const withRef = api.buildChatGptGenerationJob({
    prompt: 'a cat astronaut',
    ratio: '16:9',
    attachments: [{ name: 'ref.png', type: 'image/png', base64: PNG_BASE64 }],
    autoDownload: false,
  });
  assert.deepEqual(validateChatGptJobPayloads([withRef], registry), []);
  const bare = api.buildChatGptGenerationJob({ prompt: 'just a prompt', ratio: '1:1' });
  assert.deepEqual(JSON.parse(JSON.stringify(bare.payload.attachments)), []);
  assert.deepEqual(validateChatGptJobPayloads([bare], registry), []);
  assert.equal(bare.metadata.provider, 'chatgpt', 'GPT-10 runner pin: metadata.provider is chatgpt');
});

// ---------------------------------------------------------------------------
// Registry source: the sidebar loads the same JSON the build ships
// ---------------------------------------------------------------------------
test('GPT-14: the sidebar loads chatgpt capabilities from the shipped JSON, like the Flow loader', () => {
  assert.match(sidebarJs, /chrome\.runtime\.getURL\("chatgpt-model-capabilities\.json"\)/,
    'the loader resolves chatgpt-model-capabilities.json through chrome.runtime.getURL');
  assert.match(sidebarJs, /async function loadChatGptCapabilities\(\)/, 'a cached loader mirrors loadFlowModelCapabilities');
  // The ratio list and the cap must be read from that registry — never a
  // second hard-coded list in the sidebar GPT-14 helpers.
  const helpersSource = sliceBetween(
    sidebarJs,
    '// GPT-14:BEGIN chatgpt-form-helpers',
    '// GPT-14:END chatgpt-form-helpers',
    'GPT-14 helpers',
  );
  assert.match(helpersSource, /defaults\?\.supportedRatios/, 'ratios come from registry defaults');
  assert.match(helpersSource, /defaults\?\.maxRefImages/, 'the cap comes from registry defaults');
  assert.match(helpersSource, /aspectRatios/, 'per-model ratios come from the registry model rule');
  assert.doesNotMatch(helpersSource, /"16:9",\s*"9:16"/, 'no hard-coded ratio list in the helpers');
});

// ---------------------------------------------------------------------------
// DOM fixture: ratio repopulation + ref cap from the registry
// ---------------------------------------------------------------------------
test('GPT-14 (DOM): selecting chatgpt repopulates both ratio selects from the registry', () => {
  const { api, aspectRatio, selectRatioImage } = loadGpt14Helpers();
  const ratios = api.applyChatGptRatioOptions(registryJson);
  assert.deepEqual(ratios, ['16:9', '9:16', '1:1', '4:3', '3:4']);
  assert.deepEqual(ratios, registryJson.defaults.supportedRatios, 'options are the registry values verbatim');
  assert.deepEqual(aspectRatio.optionValues(), registryJson.defaults.supportedRatios);
  assert.deepEqual(selectRatioImage.optionValues(), registryJson.defaults.supportedRatios);
  assert.equal(aspectRatio.value, '9:16', 'a still-valid previous selection is preserved');
});

test('GPT-14 (DOM): an out-of-registry previous ratio falls back to the registry default ratio', () => {
  const { api, aspectRatio } = loadGpt14Helpers({ aspectValues: ['21:9'] });
  api.applyChatGptRatioOptions(registryJson);
  assert.equal(aspectRatio.value, registryJson.defaults.defaultRatio);
});

test('GPT-14 (DOM): model-rule ratios and cap win over defaults; unknown models use defaults', () => {
  const { api, aspectRatio } = loadGpt14Helpers();
  const custom = {
    defaults: { supportedRatios: ['1:1', '16:9'], maxRefImages: 2, defaultRatio: '1:1', ratioSemantics: {} },
    models: [{ match: ['gpt-image-1'], aspectRatios: ['1:1'], maxRefImages: 1 }],
  };
  assert.deepEqual(api.chatGptSupportedRatios(custom, 'gpt-image-1'), ['1:1']);
  assert.equal(api.chatGptMaxRefImages(custom, 'gpt-image-1'), 1);
  assert.deepEqual(api.chatGptSupportedRatios(custom, 'some-future-model'), ['1:1', '16:9']);
  assert.equal(api.chatGptMaxRefImages(custom, 'some-future-model'), 2);
  api.applyChatGptRatioOptions(custom, 'gpt-image-1');
  assert.deepEqual(aspectRatio.optionValues(), ['1:1']);
  // Shipped registry: no model selected -> defaults (the form has no
  // ChatGPT model picker, so the default rule is the selected rule).
  assert.equal(api.chatGptMaxRefImages(registryJson), registryJson.defaults.maxRefImages);
  assert.deepEqual(api.chatGptSupportedRatios(registryJson), registryJson.defaults.supportedRatios);
});

test('GPT-14 (DOM): the ref cap lands on the ref section dataset and the picker limit hint', () => {
  const { api, refSection, refHint } = loadGpt14Helpers();
  const cap = api.applyChatGptRefCap(registryJson);
  assert.equal(cap, registryJson.defaults.maxRefImages);
  assert.equal(refSection.dataset.maxRefImages, String(registryJson.defaults.maxRefImages));
  assert.equal(refHint.textContent, `Tối đa ${registryJson.defaults.maxRefImages} ảnh tham chiếu`);
});

test('GPT-14: sidebar.html carries the Flow ref cap as the section default the wiring updates', () => {
  assert.match(sidebarHtml, /<section class="section" id="refImagesSection" data-max-ref-images="3">/,
    'the ref section starts at the Flow cap of 3');
  assert.match(sidebarHtml, /id="genProvider" value="flow"/, 'the provider field defaults to flow');
});

// ---------------------------------------------------------------------------
// Provider switching: image-only configuration + Flow restoration
// ---------------------------------------------------------------------------
test('GPT-14: the provider tab handler applies the provider config and keeps the tab bookkeeping', () => {
  const start = sidebarJs.indexOf('// Provider Tabs');
  assert.ok(start >= 0, 'provider tabs block exists');
  const block = sidebarJs.slice(start, start + 5000);
  assert.match(block, /applyGenProviderConfig\(provider\)/, 'tab clicks apply the provider configuration');
  assert.match(block, /hiddenProvider\.value = provider/, 'the #genProvider field still tracks the tab');
  assert.match(block, /provider-tab--active/, 'the active-tab styling behavior is unchanged');
});

test('GPT-14: chatgpt mode forces image, disables the video type, and hides video-only controls', () => {
  const start = sidebarJs.indexOf('function applyGenProviderConfig(');
  assert.ok(start >= 0, 'sidebar.js defines applyGenProviderConfig');
  const block = sidebarJs.slice(start, start + 5000);
  assert.match(block, /provider === "chatgpt"/, 'the config branches on the chatgpt provider');
  assert.match(block, /setGenType\("image"\)/, 'chatgpt mode forces the image gen type');
  assert.match(block, /gen-type-btn\[data-value="video"\]/, 'the video type button is addressed');
  assert.match(block, /\.disabled = isChatGpt/, 'the video type button is disabled in chatgpt mode');
  for (const selector of [
    '#videoModelContainer', '#videoInputTypeContainer', '#flowVideoDurationContainer',
    '#flowVideoResolutionContainer', '#genVideoVoiceContainer', '#videoFramesSection', '#genChainSection',
  ]) {
    assert.ok(block.includes(`"${selector}"`), `video-only control ${selector} is hidden in chatgpt mode`);
  }
  assert.match(block, /applyChatGptRatioOptions\(registry\)/, 'chatgpt mode repopulates the ratio select');
  assert.match(block, /applyChatGptRefCap\(registry\)/, 'chatgpt mode applies the registry ref cap');
  assert.match(block, /loadChatGptCapabilities\(\)/, 'chatgpt mode loads the registry');
});

test('GPT-14: leaving chatgpt mode restores the Flow form (Flow behavior unchanged)', () => {
  const start = sidebarJs.indexOf('function applyGenProviderConfig(');
  const block = sidebarJs.slice(start, start + 5000);
  assert.match(block, /applyFlowModelControls\(\)/, 'the Flow ratio/model controls are re-applied on restore');
  assert.match(block, /dataset\.maxRefImages = "3"/, 'the ref cap returns to the Flow cap');
  assert.match(block, /Tối đa 3 ảnh tham chiếu/, 'the picker limit hint returns to the Flow text');
  // The Flow submit path itself is untouched: executeGenerationTask still
  // builds flow.generation.submit jobs with the Flow payload shape.
  const execStart = sidebarJs.indexOf('async function executeGenerationTask(');
  const execBody = sidebarJs.slice(execStart, execStart + 6000);
  assert.match(execBody, /operation: "flow\.generation\.submit"/);
  assert.match(execBody, /aspectRatio: aspect_ratio/);
  assert.doesNotMatch(execBody, /chatgpt/, 'the Flow job builder never mentions chatgpt');
});

// ---------------------------------------------------------------------------
// Queue panel provider badge (fake-DOM render)
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

test('GPT-14 (DOM): the queue panel renders the provider badge from metadata.provider', () => {
  const itemsElement = renderPanelItems([
    { id: 'job-gpt', label: 'ChatGPT image: cat', status: 'pending', operation: 'chatgpt.generation.submit', metadata: { provider: 'chatgpt', source: 'extension' } },
  ]);
  const badges = findByClass(itemsElement, 'flow-queue-panel__provider-badge');
  assert.equal(badges.length, 1, 'exactly one provider badge renders');
  assert.equal(badges[0].textContent, 'chatgpt');
  assert.equal(badges[0].dataset.provider, 'chatgpt');
  // The pre-existing source badge still renders alongside it.
  assert.equal(findByClass(itemsElement, 'flow-queue-panel__badge').length >= 1, true);
});

test('GPT-14 (DOM): no provider badge without metadata.provider — Flow presentation as today', () => {
  const flowItems = renderPanelItems([
    { id: 'job-flow', label: 'a flow scene', status: 'pending', operation: 'flow.generation.submit', metadata: { source: 'manual' } },
    { id: 'job-op-only', label: 'chatgpt op without provider metadata', status: 'pending', operation: 'chatgpt.generation.submit', metadata: { source: 'extension' } },
    { id: 'job-bare', label: 'no metadata at all', status: 'pending', operation: 'flow.generation.submit' },
  ]);
  assert.equal(findByClass(flowItems, 'flow-queue-panel__provider-badge').length, 0,
    'the badge is driven ONLY by metadata.provider — not by operation or source');
  const rows = findByClass(flowItems, 'flow-queue-panel__item')
    .filter(element => String(element.className).split(/\s+/).includes('flow-queue-panel__item'));
  assert.equal(rows.length, 3, 'all rows still render');
});

test('GPT-14 (DOM): the badge is generic over the provider value, not chatgpt-specific markup', () => {
  const itemsElement = renderPanelItems([
    { id: 'job-gem', label: 'gemini job', status: 'pending', metadata: { provider: 'gemini', source: 'manual' } },
  ]);
  const badges = findByClass(itemsElement, 'flow-queue-panel__provider-badge');
  assert.equal(badges.length, 1);
  assert.equal(badges[0].textContent, 'gemini');
  assert.equal(badges[0].dataset.provider, 'gemini');
});

test('GPT-14: the panel badge source reads task.metadata.provider only', () => {
  assert.match(panelJs, /task\?\.metadata\?\.provider/, 'the badge helper reads metadata.provider');
  const renderStart = panelJs.indexOf('_renderItem(task, index, count)');
  assert.ok(renderStart >= 0);
  const renderBody = panelJs.slice(renderStart, renderStart + 4000);
  assert.match(renderBody, /providerBadge/, 'the item renderer creates the provider badge');
  assert.match(renderBody, /flow-queue-panel__provider-badge/, 'the badge carries its own class');
});
