import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  FlowGenTemplates,
  GenTemplateError,
  GEN_TEMPLATES_STORAGE_KEY,
  createGenTemplateRecord,
  normalizeGenTemplateState,
  buildJobPayloadFromGenTemplate,
} from '../extension/src/background/flow-gen-templates.js';

const sidebarSource = readFileSync(new URL('../extension/src/ui/sidebar.js', import.meta.url), 'utf8');
const sidebarHtml = readFileSync(new URL('../extension/src/ui/sidebar.html', import.meta.url), 'utf8');

// ---------------------------------------------------------------------------
// FEAT-09: local generation-config template library (study feature #15,
// local half). The Templates subtab becomes a working LOCAL library: save
// the current composer state (prompt + settings + refs) as a named
// template, list / apply / delete; apply reproduces prompt + settings +
// refs into a new job payload in the exact shape the sidebar's
// executeGenerationTask builds for the queue. The server-served catalog
// stays blocked (FEAT-B5) — this store is local only and must never
// disturb the pre-existing saved-prompts store (FEAT-04 snippets).
// ---------------------------------------------------------------------------

function memoryStorage(seed = {}) {
  const data = { ...seed };
  return {
    data,
    async get(key) { return { [key]: data[key] }; },
    async set(entries) { Object.assign(data, entries); },
  };
}

const hasCode = code => error => {
  assert.equal(error?.code, code, `expected error code ${code}, got ${error?.code} (${error?.message})`);
  return true;
};

const imageState = () => ({
  prompt: 'A red car on a mountain road at dawn',
  type: 'image',
  model: 'nano banana',
  aspectRatio: '16:9',
  count: 2,
  autoDownload: true,
  attachments: [
    { assetName: 'hero-ref', expectedId: 'media-1', kind: 'image' },
    { assetName: 'asset:style-ref', kind: 'image' },
  ],
});

const videoState = () => ({
  prompt: 'Slow push-in on a rainy Saigon street',
  type: 'video',
  aspect_ratio: '9:16',
  count: 1,
  settings: { mode: 'ingredients', model: 'veo-3', duration: 8, resolution: '720p', voice: 'voice-1' },
  attachments: [{ assetName: 'street-ref', expectedId: 'media-9', kind: 'image' }],
  firstFrame: 'opening-frame',
  lastFrame: { assetName: 'closing-frame', expectedId: 'media-10', kind: 'image' },
});

// ---------------------------------------------------------------------------
// Record creation / state normalization
// ---------------------------------------------------------------------------

test('createGenTemplateRecord normalizes a composer state and drops foreign fields', () => {
  const record = createGenTemplateRecord(
    { ...imageState(), serverRank: 42, runtimeJobId: 'job-x' },
    { name: '  Hero car  ', id: 'tpl-1', now: 1234 },
  );
  assert.equal(record.id, 'tpl-1');
  assert.equal(record.name, 'Hero car');
  assert.equal(record.createdAt, 1234);
  assert.equal(record.updatedAt, 1234);
  assert.equal(record.state.prompt, 'A red car on a mountain road at dawn');
  assert.equal(record.state.type, 'image');
  assert.equal(record.state.model, 'nano banana');
  assert.equal(record.state.aspectRatio, '16:9');
  assert.equal(record.state.count, 2);
  assert.equal(record.state.autoDownload, true);
  assert.deepEqual(record.state.attachments, imageState().attachments);
  assert.equal('serverRank' in record.state, false);
  assert.equal('runtimeJobId' in record.state, false);
  assert.equal('serverRank' in record, false);
});

test('createGenTemplateRecord requires a name and a non-empty prompt', () => {
  assert.throws(() => createGenTemplateRecord(imageState(), {}), hasCode('FLOW_GEN_TEMPLATE_NAME_REQUIRED'));
  assert.throws(() => createGenTemplateRecord(imageState(), { name: '   ' }), hasCode('FLOW_GEN_TEMPLATE_NAME_REQUIRED'));
  assert.throws(
    () => createGenTemplateRecord({ ...imageState(), prompt: '  ' }, { name: 'x' }),
    hasCode('FLOW_GEN_TEMPLATE_PROMPT_REQUIRED'),
  );
  assert.throws(() => createGenTemplateRecord(null, { name: 'x' }), hasCode('FLOW_GEN_TEMPLATE_STATE_INVALID'));
  assert.throws(() => createGenTemplateRecord('nope', { name: 'x' }), hasCode('FLOW_GEN_TEMPLATE_STATE_INVALID'));
});

test('normalizeGenTemplateState clamps count, defaults type, and normalizes frame refs', () => {
  const state = normalizeGenTemplateState({
    prompt: 'p', count: 0, firstFrame: 'frame-a', lastFrame: { assetName: 'frame-b' },
  });
  assert.equal(state.type, 'image');
  assert.equal(state.count, 1);
  assert.deepEqual(state.firstFrame, { assetName: 'frame-a' });
  assert.deepEqual(state.lastFrame, { assetName: 'frame-b' });
  assert.equal(normalizeGenTemplateState({ prompt: 'p', count: 99 }).count, 20);
  assert.equal(normalizeGenTemplateState({ prompt: 'p', type: 'video' }).type, 'video');
  assert.equal(normalizeGenTemplateState({ prompt: 'p', type: 'weird' }).type, 'image');
  // Non-object attachments and settings are dropped, never carried through.
  const cleaned = normalizeGenTemplateState({ prompt: 'p', attachments: [null, 'x', { assetName: 'ok' }], settings: 'junk' });
  assert.deepEqual(cleaned.attachments, [{ assetName: 'ok' }]);
  assert.deepEqual(cleaned.settings, {});
});

// ---------------------------------------------------------------------------
// Apply → job payload (the entry's round-trip)
// ---------------------------------------------------------------------------

test('buildJobPayloadFromGenTemplate reproduces prompt + settings + refs into an image job payload', () => {
  const record = createGenTemplateRecord(imageState(), { name: 'Hero car', id: 'tpl-1', now: 1 });
  const job = buildJobPayloadFromGenTemplate(record);
  assert.equal(job.operation, 'flow.generation.submit');
  assert.equal(job.label, '[IMAGE] A red car on a mountain road at dawn');
  assert.deepEqual(job.payload, {
    type: 'image',
    autoDownload: true,
    prompt: 'A red car on a mountain road at dawn',
    model: 'nano banana',
    aspectRatio: '16:9',
    aspect_ratio: '16:9',
    variants: 2,
    count: 2,
    attachments: imageState().attachments,
    refMediaTypeMap: {
      'hero-ref': 'image',
      'media-1': 'image',
      'style-ref': 'image',
      'asset:style-ref': 'image',
    },
  });
});

test('buildJobPayloadFromGenTemplate spreads video settings and frame slots like the submit path', () => {
  const record = createGenTemplateRecord(videoState(), { name: 'Rainy street', id: 'tpl-2', now: 1 });
  const job = buildJobPayloadFromGenTemplate(record);
  assert.equal(job.operation, 'flow.generation.submit');
  assert.deepEqual(job.payload, {
    type: 'video',
    autoDownload: false,
    prompt: 'Slow push-in on a rainy Saigon street',
    aspectRatio: '9:16',
    aspect_ratio: '9:16',
    variants: 1,
    count: 1,
    attachments: videoState().attachments,
    refMediaTypeMap: { 'street-ref': 'image', 'media-9': 'image' },
    firstFrame: { assetName: 'opening-frame' },
    lastFrame: { assetName: 'closing-frame', expectedId: 'media-10', kind: 'image' },
    mode: 'ingredients',
    model: 'veo-3',
    duration: 8,
    resolution: '720p',
    voice: 'voice-1',
  });
});

test('apply returns a fresh payload — mutating it never touches the stored record', async () => {
  const store = new FlowGenTemplates({ storage: memoryStorage() });
  const saved = await store.save(imageState(), { name: 'Hero car' });
  const job = await store.apply(saved.id);
  job.payload.prompt = 'mutated';
  job.payload.attachments[0].assetName = 'mutated';
  const again = await store.apply(saved.id);
  assert.equal(again.payload.prompt, 'A red car on a mountain road at dawn');
  assert.equal(again.payload.attachments[0].assetName, 'hero-ref');
  assert.throws(() => buildJobPayloadFromGenTemplate(null), hasCode('FLOW_GEN_TEMPLATE_INVALID'));
  assert.throws(() => buildJobPayloadFromGenTemplate({ name: 'x' }), hasCode('FLOW_GEN_TEMPLATE_INVALID'));
});

// ---------------------------------------------------------------------------
// Store behavior
// ---------------------------------------------------------------------------

test('store save → list → get round-trips and persists across instances', async () => {
  const storage = memoryStorage();
  const store = new FlowGenTemplates({ storage });
  const saved = await store.save(videoState(), { name: 'Rainy street' });
  await store.flush();
  assert.ok(storage.data[GEN_TEMPLATES_STORAGE_KEY], 'state persisted under the versioned key');

  const listed = await store.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].name, 'Rainy street');
  assert.deepEqual(listed[0].state, (await store.get(saved.id)).state);

  const reopened = new FlowGenTemplates({ storage });
  const relisted = await reopened.list();
  assert.equal(relisted.length, 1);
  assert.equal(relisted[0].id, saved.id);
  assert.deepEqual(relisted[0].state, listed[0].state);

  const found = await reopened.list({ search: 'rainy' });
  assert.equal(found.length, 1);
  assert.equal((await reopened.list({ search: 'nope' })).length, 0);
});

test('delete removes the template for good', async () => {
  const storage = memoryStorage();
  const store = new FlowGenTemplates({ storage });
  const saved = await store.save(imageState(), { name: 'Hero car' });
  assert.equal(await store.remove(saved.id), true);
  assert.equal(await store.remove(saved.id), false);
  assert.equal(await store.get(saved.id), null);
  assert.equal((await store.list()).length, 0);
  await assert.rejects(() => store.apply(saved.id), hasCode('FLOW_GEN_TEMPLATE_NOT_FOUND'));
  await store.flush();
  const reopened = new FlowGenTemplates({ storage });
  assert.equal((await reopened.list()).length, 0);
});

test('store evicts the oldest templates beyond the cap', async () => {
  const store = new FlowGenTemplates({ storage: memoryStorage(), maxTemplates: 2 });
  const a = await store.save({ prompt: 'a' }, { name: 'A' });
  const b = await store.save({ prompt: 'b' }, { name: 'B' });
  const c = await store.save({ prompt: 'c' }, { name: 'C' });
  const ids = (await store.list()).map(template => template.id);
  assert.deepEqual(ids, [b.id, c.id]);
  assert.equal(await store.get(a.id), null);
});

test('a corrupt store starts empty instead of wedging the library', async () => {
  const storage = memoryStorage({ [GEN_TEMPLATES_STORAGE_KEY]: { version: 99, templates: 'junk' } });
  const store = new FlowGenTemplates({ storage });
  assert.deepEqual(await store.list(), []);
  const saved = await store.save({ prompt: 'fresh' }, { name: 'Fresh' });
  assert.equal(saved.name, 'Fresh');
});

// ---------------------------------------------------------------------------
// The pre-existing saved-prompts store is never disturbed
// ---------------------------------------------------------------------------

test('gen-template operations leave the saved-prompts store byte-identical', async () => {
  const legacyPrompts = [
    { id: 'old-1', name: 'Legacy flat prompt', prompt: 'old content', createdAt: 5 },
    { id: 'snip-1', title: 'Snippet', content: 'Hi {{name}}', category: '', tags: [], variables: ['name'] },
  ];
  const storage = memoryStorage({ flowMcpSavedPrompts: legacyPrompts });
  const before = JSON.stringify(storage.data.flowMcpSavedPrompts);
  const store = new FlowGenTemplates({ storage });
  const saved = await store.save(imageState(), { name: 'Hero car' });
  await store.apply(saved.id);
  await store.remove(saved.id);
  await store.flush();
  assert.equal(JSON.stringify(storage.data.flowMcpSavedPrompts), before);
  // And the legacy entries still parse as saved prompts (FEAT-04 shapes).
  const parsed = JSON.parse(JSON.stringify(storage.data.flowMcpSavedPrompts));
  assert.equal(parsed[0].prompt, 'old content');
  assert.equal(parsed[1].content, 'Hi {{name}}');
});

// ---------------------------------------------------------------------------
// Sidebar surface contracts
// ---------------------------------------------------------------------------

test('sidebar Templates subtab carries the gen-template library surface', () => {
  const paneStart = sidebarHtml.indexOf('id="subtab-templates"');
  assert.ok(paneStart >= 0, 'templates subtab exists');
  const pane = sidebarHtml.slice(paneStart, sidebarHtml.indexOf('id="subtab-myprompts"'));
  for (const id of ['genTemplateName', 'saveGenTemplateBtn', 'genTemplateList', 'genTemplateEmpty']) {
    assert.ok(pane.includes(`id="${id}"`), `templates subtab contains #${id}`);
  }
});

test('sidebar wires the gen-template message contract and composer capture/apply', () => {
  for (const type of ['flow-gen-templates:list', 'flow-gen-templates:save', 'flow-gen-templates:apply', 'flow-gen-templates:remove']) {
    assert.ok(sidebarSource.includes(`"${type}"`), `sidebar sends ${type}`);
  }
  assert.ok(sidebarSource.includes('currentGenComposerState'), 'sidebar captures the current composer state');
  assert.ok(sidebarSource.includes('applyGenTemplateToComposer'), 'sidebar loads an applied payload into the composer');
  assert.ok(sidebarSource.includes('data-gen-template-apply'), 'template rows carry an apply action');
  assert.ok(sidebarSource.includes('data-gen-template-delete'), 'template rows carry a delete action');
});
