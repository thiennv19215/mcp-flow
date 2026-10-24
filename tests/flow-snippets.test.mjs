import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

// FEAT-04 — Snippets with {{variables}} + addon prompts (study B4).
//
// The flat saved-prompts store (chrome.storage.local key
// "flowMcpSavedPrompts", legacy entries {id, name, prompt, createdAt})
// upgrades IN PLACE to snippets {id, title, content, category, tags,
// variables}: variables are extracted from {{name}} placeholders, the
// insert path collects values and replaces every occurrence, and one
// selected addon/style text is appended at batch-build time without
// ever being written into stored prompts. Old entries keep working.
//
// The logic lives in extension/src/ui/flow-snippets.js, a classic
// script in the flow-queue-panel.js idiom (IIFE attaching to the global
// root), so it is loaded here through node:vm against a bare sandbox.

const snippetsSource = readFileSync(new URL('../extension/src/ui/flow-snippets.js', import.meta.url), 'utf8');
const sidebarJs = readFileSync(new URL('../extension/src/ui/sidebar.js', import.meta.url), 'utf8');
const sidebarHtml = readFileSync(new URL('../extension/src/ui/sidebar.html', import.meta.url), 'utf8');

function loadSnippets() {
  const sandbox = {};
  vm.runInNewContext(snippetsSource, sandbox, { filename: 'flow-snippets.js' });
  assert.ok(sandbox.FlowSnippets, 'flow-snippets.js must attach FlowSnippets to the global root');
  return sandbox.FlowSnippets;
}

// chrome.storage.local-shaped fake (same idiom as flow-batch-drafts).
function memoryStorage(seed = {}) {
  const data = { ...seed };
  return {
    data,
    async get(key) { return { [key]: data[key] }; },
    async set(entries) { Object.assign(data, entries); },
  };
}

const KEY = 'flowMcpSavedPrompts';

// ---------------------------------------------------------------------------
// Variable extraction
// ---------------------------------------------------------------------------

test('extractSnippetVariables returns the unique {{name}} set in first-appearance order', () => {
  const { extractSnippetVariables } = loadSnippets();
  // Spread into a local-realm array: the module runs in a vm sandbox, so
  // its arrays carry the sandbox realm's prototype.
  assert.deepEqual(
    [...extractSnippetVariables('A {{subject}} in a {{style}} scene, again {{subject}} and {{style}}')],
    ['subject', 'style']);
  assert.deepEqual([...extractSnippetVariables('no placeholders at all')], []);
});

test('extractSnippetVariables ignores single braces and empty placeholders, trims inner whitespace', () => {
  const { extractSnippetVariables } = loadSnippets();
  assert.deepEqual(
    [...extractSnippetVariables('{single} and {{ spaced }} plus {{}} and {{   }} and {{real}}')],
    ['spaced', 'real']);
});

// ---------------------------------------------------------------------------
// Fill
// ---------------------------------------------------------------------------

test('fillSnippetContent replaces EVERY occurrence of a provided variable', () => {
  const { fillSnippetContent } = loadSnippets();
  assert.equal(
    fillSnippetContent('{{hero}} runs, {{hero}} jumps, {{hero}} wins', { hero: 'An' }),
    'An runs, An jumps, An wins');
});

test('fillSnippetContent leaves unknown variables untouched and ignores extra values', () => {
  const { fillSnippetContent } = loadSnippets();
  assert.equal(
    fillSnippetContent('{{known}} meets {{unknown}}', { known: 'yes', other: 'x' }),
    'yes meets {{unknown}}');
  assert.equal(fillSnippetContent('{{a}}', {}), '{{a}}');
  assert.equal(fillSnippetContent('{{a}}', { a: null }), '{{a}}');
});

// ---------------------------------------------------------------------------
// Shape upgrade (legacy flat prompts -> snippets)
// ---------------------------------------------------------------------------

test('normalizeSnippet upgrades a legacy {name, prompt} entry to the snippet shape', () => {
  const { normalizeSnippet } = loadSnippets();
  const upgraded = normalizeSnippet({ id: 'old-1', name: 'Hero shot', prompt: 'A {{thing}} on a table', createdAt: 42 });
  assert.equal(upgraded.id, 'old-1');
  assert.equal(upgraded.title, 'Hero shot');
  assert.equal(upgraded.content, 'A {{thing}} on a table');
  assert.equal(upgraded.category, '');
  assert.deepEqual([...upgraded.tags], []);
  assert.deepEqual([...upgraded.variables], ['thing']);
  assert.equal(upgraded.createdAt, 42);
});

test('normalizeSnippet passes new-shape entries through and re-derives variables from content', () => {
  const { normalizeSnippet } = loadSnippets();
  const snippet = normalizeSnippet({
    id: 'n-1', title: 'T', content: 'x {{a}} y {{b}}', category: 'style',
    tags: ['one', ' two ', 'one', ''], variables: ['stale'],
  });
  assert.equal(snippet.title, 'T');
  assert.equal(snippet.category, 'style');
  assert.deepEqual([...snippet.tags], ['one', 'two']);
  assert.deepEqual([...snippet.variables], ['a', 'b'], 'variables are derived from content, never trusted from storage');
  assert.equal(normalizeSnippet({ id: 'x', prompt: '   ' }), null, 'content-less entries are dropped');
  assert.equal(normalizeSnippet(null), null);
  assert.equal(normalizeSnippet('a string'), null);
});

test('createSnippet derives variables, parses comma-string tags, and mints an id', () => {
  const { createSnippet } = loadSnippets();
  const snippet = createSnippet({ title: '', content: 'A {{hero}} poses', tags: 'hero, studio' }, () => 'minted-1');
  assert.equal(snippet.id, 'minted-1');
  assert.equal(snippet.title, 'A {{hero}} poses'.slice(0, 36), 'empty title falls back to a content prefix like the legacy save did');
  assert.deepEqual([...snippet.tags], ['hero', 'studio']);
  assert.deepEqual([...snippet.variables], ['hero']);
  assert.equal(createSnippet({ content: '  ' }), null);
});

// ---------------------------------------------------------------------------
// Store: CRUD round-trip + in-place upgrade + legacy dedupe/cap semantics
// ---------------------------------------------------------------------------

test('snippet store CRUD round-trips through fake storage across instances', async () => {
  const { FlowSnippetStore } = loadSnippets();
  const storage = memoryStorage();
  let counter = 0;
  const store = new FlowSnippetStore({ storage, idFactory: () => `snip-${++counter}` });

  const added = await store.add({ title: 'Hero', content: 'A {{hero}} in {{place}}', category: 'product', tags: ['hero'] });
  assert.equal(added.id, 'snip-1');
  assert.deepEqual([...added.variables], ['hero', 'place']);

  const reopened = new FlowSnippetStore({ storage });
  const listed = await reopened.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].title, 'Hero');
  assert.equal((await reopened.get('snip-1')).content, 'A {{hero}} in {{place}}');

  const updated = await reopened.update('snip-1', { title: 'Hero v2', content: 'A {{hero}} returns' });
  assert.equal(updated.title, 'Hero v2');
  assert.deepEqual([...updated.variables], ['hero'], 'update re-derives variables from the new content');
  assert.equal(await reopened.update('missing', { title: 'x' }), null);

  assert.equal(await reopened.remove('snip-1'), true);
  assert.equal(await reopened.remove('snip-1'), false);
  assert.equal((await reopened.list()).length, 0);
});

test('snippet store upgrades legacy entries IN PLACE on first list', async () => {
  const { FlowSnippetStore } = loadSnippets();
  const legacy = [
    { id: 'old-1', name: 'Old one', prompt: 'Legacy {{var}} text', createdAt: 7 },
    { id: 'old-2', name: '', prompt: 'Second legacy', createdAt: 8 },
  ];
  const storage = memoryStorage({ [KEY]: legacy });
  const store = new FlowSnippetStore({ storage });

  const listed = await store.list();
  assert.equal(listed.length, 2);
  assert.equal(listed[0].title, 'Old one');
  assert.equal(listed[0].content, 'Legacy {{var}} text');
  assert.deepEqual([...listed[0].variables], ['var']);
  assert.equal(listed[1].title, 'Second legacy', 'legacy entry with empty name falls back to a content prefix');

  const raw = storage.data[KEY];
  assert.equal(raw[0].content, 'Legacy {{var}} text', 'storage itself was rewritten to the snippet shape');
  assert.equal(raw[0].title, 'Old one');
  assert.equal(raw[0].prompt, undefined, 'the flat prompt field is gone after the in-place upgrade');
});

test('snippet store add dedupes by content (newest wins) and enforces the cap', async () => {
  const { FlowSnippetStore } = loadSnippets();
  const storage = memoryStorage();
  let counter = 0;
  const store = new FlowSnippetStore({ storage, limit: 3, idFactory: () => `s-${++counter}` });

  await store.add({ title: 'first', content: 'same body' });
  await store.add({ title: 'second', content: 'other body' });
  const reAdded = await store.add({ title: 'first v2', content: 'same body' });
  let listed = await store.list();
  assert.equal(listed.length, 2, 'same content is stored once, like the legacy save deduped by prompt text');
  assert.equal(listed[0].id, reAdded.id, 'the re-added snippet is the newest entry');
  assert.equal(listed[0].title, 'first v2');

  await store.add({ title: 'third', content: 'third body' });
  await store.add({ title: 'fourth', content: 'fourth body' });
  listed = await store.list();
  assert.equal(listed.length, 3, 'cap holds');
  assert.equal(listed[0].title, 'fourth');
});

// ---------------------------------------------------------------------------
// Addon: appended at batch-build time, never written into stored prompts
// ---------------------------------------------------------------------------

test('applySnippetAddon appends the addon text after the prompt and tolerates empty sides', () => {
  const { applySnippetAddon } = loadSnippets();
  assert.equal(applySnippetAddon('A cat', 'cinematic lighting'), 'A cat\n\ncinematic lighting');
  assert.equal(applySnippetAddon('A cat', '  cinematic lighting  '), 'A cat\n\ncinematic lighting');
  assert.equal(applySnippetAddon('A cat', ''), 'A cat');
  assert.equal(applySnippetAddon('A cat', '   '), 'A cat');
  assert.equal(applySnippetAddon('A cat', null), 'A cat');
});

test('building a prompt with an addon never mutates the stored snippet', async () => {
  const { FlowSnippetStore, applySnippetAddon } = loadSnippets();
  const storage = memoryStorage();
  const store = new FlowSnippetStore({ storage, idFactory: () => 'keep-1' });
  await store.add({ title: 'Base', content: 'A product photo' });

  const built = applySnippetAddon('A product photo', 'soft studio light');
  assert.equal(built, 'A product photo\n\nsoft studio light');

  const [stored] = await store.list();
  assert.equal(stored.content, 'A product photo', 'stored prompt carries no addon residue');
  assert.equal(storage.data[KEY][0].content, 'A product photo');
});

// ---------------------------------------------------------------------------
// Sidebar wiring contracts
// ---------------------------------------------------------------------------

test('sidebar.html loads flow-snippets.js before sidebar.js and exposes the snippet form fields', () => {
  const snippetsTag = sidebarHtml.indexOf('<script src="flow-snippets.js"></script>');
  const sidebarTag = sidebarHtml.indexOf('<script src="sidebar.js"></script>');
  assert.ok(snippetsTag >= 0, 'sidebar.html must load flow-snippets.js');
  assert.ok(sidebarTag > snippetsTag, 'flow-snippets.js must load before sidebar.js');
  assert.ok(sidebarHtml.includes('id="promptCategory"'), 'save form gains a category field');
  assert.ok(sidebarHtml.includes('id="promptTags"'), 'save form gains a tags field');
  assert.ok(sidebarHtml.includes('id="promptAddonSelect"'), 'an addon picker is present');
});

test('sidebar.js routes insert through variable fill and batch-build through the addon', () => {
  assert.ok(sidebarJs.includes('FlowSnippetStore'), 'sidebar persists saved prompts through the snippet store');
  assert.ok(sidebarJs.includes('fillSnippetContent'), 'the use/insert path fills {{variables}} with collected values');
  const buildStart = sidebarJs.indexOf('function promptsForGeneration');
  assert.ok(buildStart >= 0);
  const buildSlice = sidebarJs.slice(buildStart, buildStart + 1200);
  assert.ok(buildSlice.includes('applySnippetAddon'), 'promptsForGeneration (the batch-build chokepoint) appends the selected addon');
});
