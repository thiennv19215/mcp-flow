import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const settingsSource = [
  '../extension/src/content/providers/flow/core/settings.js',
  '../extension/src/content/providers/flow/generation/image-settings.js',
  '../extension/src/content/providers/flow/generation/video-settings.js',
].map(file => readFileSync(new URL(file, import.meta.url), 'utf8')).join('\n');
// The canonical registry lives at the repo root; the build syncs it into
// extension/flow-model-capabilities.json.
const registry = JSON.parse(readFileSync(new URL('../flow-model-capabilities.json', import.meta.url), 'utf8'));
const sidebarHtml = readFileSync(new URL('../extension/src/ui/sidebar.html', import.meta.url), 'utf8');

function settingsContext() {
  const context = vm.createContext({
    Date, Map, Promise, Set, Object, Math, String, Number, Boolean, Array, Error,
    AbortController, setTimeout, clearTimeout, URL,
    chrome: { runtime: { getURL: () => 'flow-model-capabilities.json' } },
    fetch: async () => ({ ok: true, json: async () => registry }),
    document: { querySelectorAll: () => [], querySelector: () => null },
    visible: element => element?.visible !== false,
    accessibleName: element => element?.label || '',
    normalizeAspectRatio: value => value,
    normalizeFlowUiText: value => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim(),
    flowError: (code, message) => Object.assign(new Error(message), { code }),
  });
  vm.runInContext(settingsSource, context);
  return context;
}

test('the sidebar hides Veo 3.1 Quality while retaining tier capability compatibility', () => {
  const values = registry.uiModels.video.map(model => model.value);
  for (const tier of ['veo 3.1 lite', 'veo 3.1 fast']) {
    assert.ok(values.includes(tier), `sidebar video models include ${tier}`);
    assert.ok(sidebarHtml.includes(`value="${tier}"`), `sidebar.html static options include ${tier}`);
  }
  assert.ok(!values.includes('veo 3.1 quality'), 'Veo 3.1 Quality is omitted from the model picker');
  assert.ok(!sidebarHtml.includes('value="veo 3.1 quality"'), 'static model options omit Veo 3.1 Quality');
  const tierRule = registry.models.find(rule => rule.match?.includes('veo 3.1 fast'));
  assert.ok(tierRule, 'a registry rule matches the tiered models');
  assert.ok(tierRule.match.includes('veo 3.1 quality'), 'the hidden legacy alias remains supported for existing jobs');
  assert.equal(tierRule.supportsFrames, true);
  assert.equal(tierRule.maxReferences, 3);
  assert.deepEqual(tierRule.durations, [8]);
});

test('tiered Veo models validate against their registry rule instead of skipping capability checks', async () => {
  const context = settingsContext();
  const rule = await context.FlowSettings.assertNativeModelCapabilities(
    { model: 'Veo 3.1 - Fast', duration: 8, aspectRatio: '9:16' }, 'video', true, {});
  assert.ok(rule, 'frames mode is allowed for the tier rule');
  assert.deepEqual(rule.durations, [8]);

  await assert.rejects(
    context.FlowSettings.assertNativeModelCapabilities(
      { model: 'Veo 3.1 Fast', duration: 6 }, 'video', false, {}),
    error => error.code === 'FLOW_MODEL_UNSUPPORTED');
  await assert.rejects(
    context.FlowSettings.assertNativeModelCapabilities(
      { model: 'veo 3.1 quality', resolution: '720p' }, 'video', false, {}),
    error => error.code === 'FLOW_MODEL_UNSUPPORTED');
});

test('Omni video capabilities stay enforced: durations, resolutions and the 3-reference cap', async () => {
  const context = settingsContext();
  const rule = await context.FlowSettings.assertNativeModelCapabilities(
    { model: 'Omni 1.1 Flash', duration: 10, resolution: '360p', aspectRatio: '16:9' }, 'video', false, {});
  assert.ok(rule.durations.includes(10));

  await assert.rejects(
    context.FlowSettings.assertNativeModelCapabilities(
      { model: 'Omni 1.1 Flash', attachments: [{}, {}, {}, {}] }, 'video', false, {}),
    error => error.code === 'FLOW_MODEL_UNSUPPORTED' && /at most 3 references/.test(error.message));
});

test('Omni model labels match across the versioned and short picker forms', () => {
  const context = settingsContext();
  assert.equal(context.modelLabelMatchesRequest('Omni 1.1 Flash', 'Omni Flash'), true);
  assert.equal(context.modelLabelMatchesRequest('Omni Flash', 'Omni 1.1 Flash'), true);
  assert.equal(context.modelLabelMatchesRequest('Omni 1.1 Flash', 'Omni 1.1 Flash'), true);
  assert.equal(context.modelLabelMatchesRequest('Omni 1.1 Flash', 'Veo 3.1'), false);
});
