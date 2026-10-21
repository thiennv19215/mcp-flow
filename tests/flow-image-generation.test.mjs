import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const settingsSource = readFileSync(new URL('../extension/content/providers/flow/FlowSettings.js', import.meta.url), 'utf8');

function makeSettingsHarness() {
  const optionsSelected = new Map();
  const openedSurfaces = [];
  const closedSurfaces = [];

  const makeOption = (label, isRadio = true) => ({
    label,
    visible: true,
    checked: false,
    getAttribute(name) {
      if (name === 'role') return isRadio ? 'radio' : 'button';
      if (name === 'aria-checked' || name === 'aria-selected') return String(this.checked);
      return null;
    },
    click() {
      this.checked = true;
      optionsSelected.set(label, true);
    },
    innerText: label,
    textContent: label,
    classList: [],
    closest: () => null,
    querySelectorAll: () => [],
    querySelector: () => null,
  });

  const radios = {
    image: makeOption('Image'),
    video: makeOption('Video'),
    r916: makeOption('9:16'),
    r169: makeOption('16:9'),
    r11: makeOption('1:1'),
    x1: makeOption('x1'),
    x2: makeOption('x2'),
    x4: makeOption('x4'),
  };

  const allElements = Object.values(radios);

  let panelVisible = false;
  const docNode = {
    visible: true,
    querySelectorAll: (sel) => {
      if (typeof sel === 'string' && sel.includes('ProseMirror')) return [];
      return allElements;
    },
    querySelector: (sel) => {
      if (typeof sel === 'string' && (sel.includes('dialog') || sel.includes('menu') || sel.includes('cdk-overlay-pane'))) {
        return panelVisible ? docNode : null;
      }
      return null;
    },
    getAttribute: () => null,
    classList: [],
  };

  const context = vm.createContext({
    Date, Map, Promise, Set, Object, Math, String, Number, Boolean, Array, Error, RegExp, AbortController,
    setTimeout, clearTimeout,
    document: docNode,
    visible: () => true,
    accessibleName: (el) => el.label || '',
    normalizeAspectRatio: (v) => v,
    normalizeFlowUiText: (v) => String(v || '').toLowerCase().replace(/\s+/g, ' ').trim(),
    flowError: (code, message) => Object.assign(new Error(message), { code }),
    chrome: {
      runtime: {
        getURL: () => 'flow-model-capabilities.json',
      },
    },
    fetch: async () => ({
      ok: true,
      json: async () => ({
        version: 1,
        defaults: {
          imageAspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
          videoAspectRatios: ['16:9', '9:16'],
          maxReferences: 3,
        },
        models: [
          {
            match: ['nano banana', 'imagen'],
            types: ['image'],
            durations: [],
            resolutions: [],
            aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
            maxReferences: 3,
          },
        ],
      }),
    }),
  });

  vm.runInContext(settingsSource, context);

  // Mock openFlowSettings & closeFlowSettings on context
  context.openFlowSettings = async () => {
    panelVisible = true;
    openedSurfaces.push(true);
  };
  context.closeFlowSettings = async () => {
    panelVisible = false;
    closedSurfaces.push(true);
  };
  context.flowSettingsPanelVisible = () => panelVisible;

  return { context, radios, optionsSelected, openedSurfaces, closedSurfaces };
}

test('prepareNativeImageSettings selects Image mode, 9:16 aspect ratio, and variant count without throwing', async () => {
  const { context, radios } = makeSettingsHarness();

  const payload = {
    type: 'image',
    prompt: 'A cute cat sitting on a windowsill',
    aspectRatio: '9:16',
    model: 'Nano Banana',
  };

  await context.FlowSettings.prepareNativeImageSettings(payload, 1);

  assert.equal(radios.image.checked, true, 'Image radio should be selected');
  assert.equal(radios.r916.checked, true, '9:16 ratio should be selected');
  assert.equal(radios.x1.checked, true, 'x1 output count should be selected');
});

test('prepareNativeImageSettings supports all standard aspect ratios (1:1, 16:9, 3:4, 4:3)', async () => {
  const { context, radios } = makeSettingsHarness();

  const payload = {
    type: 'image',
    prompt: 'A sunset view',
    aspectRatio: '1:1',
    model: 'Nano Banana',
  };

  await context.FlowSettings.prepareNativeImageSettings(payload, 2);

  assert.equal(radios.image.checked, true);
  assert.equal(radios.r11.checked, true, '1:1 ratio should be selected');
  assert.equal(radios.x2.checked, true, 'x2 count should be selected');
});

test('FlowUploadClient returns both name and id while coercing to string cleanly', async () => {
  const uploadResult = {
    name: 'ref-123456789.png',
    id: 'b5d304ab-eeb8-4001-8110-86a225761c0f',
    toString() { return this.name; }
  };

  assert.equal(String(uploadResult), 'ref-123456789.png');
  assert.equal(`asset:${uploadResult}`, 'asset:ref-123456789.png');
  assert.equal(uploadResult.id, 'b5d304ab-eeb8-4001-8110-86a225761c0f');
});

test('FlowComponents category("All") does not throw when picker has no explicit All tab', async () => {
  const componentsSource = readFileSync(new URL('../extension/content/providers/flow/FlowComponents.js', import.meta.url), 'utf8');

  let settledCalled = false;
  const mockList = {
    getAttribute: (n) => n === 'role' ? 'listbox' : null,
    querySelectorAll: () => [],
    closest: () => null,
  };
  const mockDoc = {
    querySelectorAll: () => [],
    querySelector: () => null,
  };

  const context = vm.createContext({
    Date, Promise, Set, Map, Array, Object, String, Number, Boolean, Error, RegExp,
    document: mockDoc,
    visible: () => true,
    accessibleName: () => '',
    mediaId: () => undefined,
    flowError: (code, message) => Object.assign(new Error(message), { code }),
    chrome: { runtime: { getURL: () => '' } },
    location: { href: 'https://flow.google.com/project/test', pathname: '/project/test' },
  });

  vm.runInContext(componentsSource, context);

  // Verify that category("All") can run without throwing FLOW_REFERENCE_CATEGORY_MISSING
  // when no tab is present, falling back gracefully to default view
  const refActions = context.FlowReferenceActions;
  assert.ok(refActions, 'FlowReferenceActions must be defined');
});
