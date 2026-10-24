import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

// FEAT-06 — Character/voice selection normalization layer (study #18).
//
// One normalization function shared by the sidebar modal, queue payloads
// and the MCP workflow planners: a selection, wherever it is stored (gen
// settings, batch snapshot, workflow node), is normalized through
// extension/src/content/shared/selection-normalize.js — it accepts a slug
// string, a JSON string, a single object or node/settings shapes,
// resolves each entry against the cached character list to fill
// name/thumbnail/search_value, dedupes by slug, and shapes the payload
// (primary = first selection + full list). Unknown slugs pass through
// marked unresolved; nothing is fabricated for them. Voices mirror this
// over local/scraped voices (the server-fetched base catalog stays
// blocked — FEAT-B6).

const normalizeSource = readFileSync(new URL('../extension/src/content/shared/selection-normalize.js', import.meta.url), 'utf8');
const sidebarSource = readFileSync(new URL('../extension/src/ui/sidebar.js', import.meta.url), 'utf8');
const workflowsSource = readFileSync(new URL('../extension/src/background/flow-workflows.js', import.meta.url), 'utf8');

function loadNormalize() {
  const sandbox = {};
  vm.runInNewContext(normalizeSource, sandbox, { filename: 'selection-normalize.js' });
  assert.ok(sandbox.FlowSelectionNormalize, 'selection-normalize.js must attach FlowSelectionNormalize to the global root');
  return sandbox.FlowSelectionNormalize;
}

// The module runs in a vm sandbox, so its objects carry the sandbox
// realm's prototype — round-trip through JSON before deepEqual.
const plain = value => JSON.parse(JSON.stringify(value));

// Reference-shaped cached character list (slug, search_value, name,
// thumbnail), as scraped from the Flow page.
const characterCatalog = [
  { slug: 'anh-hung', search_value: 'Anh Hùng', name: 'Anh Hùng', thumbnail: 'https://img/anh-hung.png' },
  { slug: 'meo-mun', search_value: 'Mèo Mun', name: 'Mèo Mun', thumbnail: 'https://img/meo-mun.png' },
];

// The repo's own scraper shape (listCharacters with identities):
// { name, uuid, thumbnailUrl } — no slug/search_value fields.
const repoCatalog = [
  { name: 'Bé Na', uuid: '123e4567-e89b-42d3-a456-426614174000', thumbnailUrl: 'https://img/be-na.png' },
];

const resolvedAnhHung = {
  slug: 'anh-hung', name: 'Anh Hùng', search_value: 'Anh Hùng',
  thumbnail: 'https://img/anh-hung.png', resolved: true,
};
const resolvedMeoMun = {
  slug: 'meo-mun', name: 'Mèo Mun', search_value: 'Mèo Mun',
  thumbnail: 'https://img/meo-mun.png', resolved: true,
};

// ---------------------------------------------------------------------------
// Slug derivation
// ---------------------------------------------------------------------------

test('slugifySelectionName folds accents, lowercases and dashes non-alphanumerics', () => {
  const { slugifySelectionName } = loadNormalize();
  assert.equal(slugifySelectionName('Anh Hùng'), 'anh-hung');
  assert.equal(slugifySelectionName('  Mèo   Mun! '), 'meo-mun');
  assert.equal(slugifySelectionName('Bé Na'), 'be-na');
  assert.equal(slugifySelectionName(''), '');
});

// ---------------------------------------------------------------------------
// Character normalization — every accepted shape resolves identically
// ---------------------------------------------------------------------------

test('slug string / JSON string / object / name string normalize to the same resolved selection', () => {
  const { normalizeCharacterSelection } = loadNormalize();
  const fromSlug = plain(normalizeCharacterSelection('anh-hung', characterCatalog));
  const fromJson = plain(normalizeCharacterSelection('{"slug":"anh-hung"}', characterCatalog));
  const fromObject = plain(normalizeCharacterSelection({ slug: 'anh-hung' }, characterCatalog));
  const fromName = plain(normalizeCharacterSelection('Anh Hùng', characterCatalog));
  const fromSearchValueObject = plain(normalizeCharacterSelection({ search_value: 'Anh Hùng' }, characterCatalog));
  assert.deepEqual(fromSlug, [resolvedAnhHung]);
  assert.deepEqual(fromJson, fromSlug);
  assert.deepEqual(fromObject, fromSlug);
  assert.deepEqual(fromName, fromSlug);
  assert.deepEqual(fromSearchValueObject, fromSlug);
});

test('repo scraper catalog entries resolve by uuid, by name and by character:<name> settings string', () => {
  const { normalizeCharacterSelection } = loadNormalize();
  const expected = [{
    slug: 'be-na', name: 'Bé Na', search_value: 'Bé Na',
    thumbnail: 'https://img/be-na.png', uuid: '123e4567-e89b-42d3-a456-426614174000', resolved: true,
  }];
  assert.deepEqual(plain(normalizeCharacterSelection({ uuid: '123e4567-e89b-42d3-a456-426614174000' }, repoCatalog)), expected);
  assert.deepEqual(plain(normalizeCharacterSelection('Bé Na', repoCatalog)), expected);
  assert.deepEqual(plain(normalizeCharacterSelection('character:Bé Na', repoCatalog)), expected);
  assert.deepEqual(plain(normalizeCharacterSelection({ name: 'Bé Na' }, repoCatalog)), expected);
});

test('node/settings shapes unwrap to the same selection', () => {
  const { normalizeCharacterSelection } = loadNormalize();
  const expected = [resolvedAnhHung];
  assert.deepEqual(plain(normalizeCharacterSelection({ character: 'anh-hung' }, characterCatalog)), expected);
  assert.deepEqual(plain(normalizeCharacterSelection({ settings: { character: { slug: 'anh-hung' } } }, characterCatalog)), expected);
  assert.deepEqual(plain(normalizeCharacterSelection({ node: { value: 'anh-hung' } }, characterCatalog)), expected);
  assert.deepEqual(plain(normalizeCharacterSelection({ selectedCharacter: ['anh-hung'] }, characterCatalog)), expected);
});

test('multi-selection dedupes by slug (first wins) and keeps input order', () => {
  const { normalizeCharacterSelection } = loadNormalize();
  const result = plain(normalizeCharacterSelection(
    ['meo-mun', { slug: 'anh-hung' }, 'Mèo Mun', '{"slug":"meo-mun"}', 'anh-hung'],
    characterCatalog));
  assert.deepEqual(result, [resolvedMeoMun, resolvedAnhHung]);
});

test('payload shaping takes the first selection as primary plus the full list; re-normalizing is idempotent', () => {
  const { shapeCharacterSelectionPayload, normalizeCharacterSelection } = loadNormalize();
  const payload = plain(shapeCharacterSelectionPayload(['anh-hung', 'meo-mun'], characterCatalog));
  assert.deepEqual(payload, { primary: resolvedAnhHung, selections: [resolvedAnhHung, resolvedMeoMun] });
  assert.deepEqual(plain(normalizeCharacterSelection(payload, characterCatalog)), payload.selections);
  assert.deepEqual(plain(shapeCharacterSelectionPayload([], characterCatalog)), { primary: null, selections: [] });
});

// ---------------------------------------------------------------------------
// Unknown slugs pass through, marked unresolved — nothing fabricated
// ---------------------------------------------------------------------------

test('unknown slug passes through marked unresolved with no fabricated fields', () => {
  const { normalizeCharacterSelection } = loadNormalize();
  assert.deepEqual(plain(normalizeCharacterSelection('nguoi-la', characterCatalog)),
    [{ slug: 'nguoi-la', resolved: false }]);
  assert.deepEqual(plain(normalizeCharacterSelection('Người Lạ', characterCatalog)),
    [{ slug: 'nguoi-la', name: 'Người Lạ', resolved: false }]);
});

test('an unresolved item keeps the fields it carried (never gains catalog data)', () => {
  const { normalizeCharacterSelection } = loadNormalize();
  const [entry] = plain(normalizeCharacterSelection(
    [{ slug: 'tam', name: 'Tạm', thumbnail: 'https://img/tam.png' }], characterCatalog));
  assert.deepEqual(entry, { slug: 'tam', name: 'Tạm', thumbnail: 'https://img/tam.png', resolved: false });
});

test('with no catalog every item passes through unresolved', () => {
  const { normalizeCharacterSelection } = loadNormalize();
  assert.deepEqual(plain(normalizeCharacterSelection(['anh-hung'], undefined)),
    [{ slug: 'anh-hung', resolved: false }]);
  assert.deepEqual(plain(normalizeCharacterSelection(['anh-hung'], [])),
    [{ slug: 'anh-hung', resolved: false }]);
});

test('a resolved entry keeps item-carried fields the catalog lacks', () => {
  const { normalizeCharacterSelection } = loadNormalize();
  const catalog = [{ slug: 'khong-anh', name: 'Không Ảnh' }];
  const [entry] = plain(normalizeCharacterSelection(
    [{ slug: 'khong-anh', thumbnail: 'https://img/item.png' }], catalog));
  assert.equal(entry.resolved, true);
  assert.equal(entry.thumbnail, 'https://img/item.png');
  assert.equal(entry.search_value, 'Không Ảnh');
});

test('empty inputs normalize to an empty selection', () => {
  const { normalizeCharacterSelection } = loadNormalize();
  assert.deepEqual(plain(normalizeCharacterSelection(null, characterCatalog)), []);
  assert.deepEqual(plain(normalizeCharacterSelection('', characterCatalog)), []);
  assert.deepEqual(plain(normalizeCharacterSelection([], characterCatalog)), []);
  assert.deepEqual(plain(normalizeCharacterSelection({}, characterCatalog)), []);
  assert.deepEqual(plain(normalizeCharacterSelection('not json {', characterCatalog)),
    [{ slug: 'not-json', name: 'not json {', resolved: false }]);
});

// ---------------------------------------------------------------------------
// Voices mirror the same logic over local/scraped voice lists
// ---------------------------------------------------------------------------

const voiceCatalog = ['Kore', { name: 'Puck' }, { slug: 'gio-doc', name: 'Giọng Đọc' }];

test('voice selections mirror character normalization over string/object catalogs', () => {
  const { normalizeVoiceSelection, shapeVoiceSelectionPayload } = loadNormalize();
  const kore = { slug: 'kore', name: 'Kore', resolved: true };
  assert.deepEqual(plain(normalizeVoiceSelection('Kore', voiceCatalog)), [kore]);
  assert.deepEqual(plain(normalizeVoiceSelection('{"name":"Kore"}', voiceCatalog)), [kore]);
  assert.deepEqual(plain(normalizeVoiceSelection({ voice: 'Kore' }, voiceCatalog)), [kore]);
  assert.deepEqual(plain(normalizeVoiceSelection('voice:Kore', voiceCatalog)), [kore]);
  assert.deepEqual(plain(normalizeVoiceSelection('gio-doc', voiceCatalog)),
    [{ slug: 'gio-doc', name: 'Giọng Đọc', resolved: true }]);
  assert.deepEqual(plain(normalizeVoiceSelection(['Kore', 'kore', 'Puck'], voiceCatalog)),
    [kore, { slug: 'puck', name: 'Puck', resolved: true }]);
  assert.deepEqual(plain(shapeVoiceSelectionPayload('Kore', voiceCatalog)),
    { primary: kore, selections: [kore] });
});

test('unknown voice passes through marked unresolved', () => {
  const { normalizeVoiceSelection } = loadNormalize();
  assert.deepEqual(plain(normalizeVoiceSelection('Giọng Lạ', voiceCatalog)),
    [{ slug: 'giong-la', name: 'Giọng Lạ', resolved: false }]);
});

// ---------------------------------------------------------------------------
// Wiring — workflow planners (queue payloads) go through the shared layer
// ---------------------------------------------------------------------------

test('planFlowBatch payloads stay byte-identical when no catalogs are supplied', async () => {
  const { planFlowBatch } = await import('../extension/src/background/flow-workflows.js');
  const { jobs } = planFlowBatch({
    project: 'proj',
    scenes: [{ prompt: 'A cat scene.', reference_images: ['character:Bé Na'], voice: 'Kore' }],
  }, {});
  assert.equal(jobs.length, 1);
  assert.ok(!('characterSelection' in jobs[0].payload), 'no characterSelection key without a catalog');
  assert.ok(!('voiceSelection' in jobs[0].payload), 'no voiceSelection key without a catalog');
});

test('planFlowBatch shapes character/voice selections through the shared layer when catalogs ride the plan', async () => {
  const { planFlowBatch } = await import('../extension/src/background/flow-workflows.js');
  const { jobs } = planFlowBatch({
    project: 'proj',
    characterCatalog: repoCatalog,
    voiceCatalog,
    scenes: [{
      prompt: 'A cat scene.',
      reference_images: ['character:Bé Na', 'asset:Backdrop'],
      characters: [{ slug: 'be-na' }],
      voice: 'Kore',
    }],
  }, { knownAssets: [{ name: 'Backdrop', kind: 'image', project: 'proj' }] });
  const payload = jobs[0].payload;
  assert.deepEqual(payload.characterSelection, {
    primary: {
      slug: 'be-na', name: 'Bé Na', search_value: 'Bé Na',
      thumbnail: 'https://img/be-na.png', uuid: '123e4567-e89b-42d3-a456-426614174000', resolved: true,
    },
    selections: [{
      slug: 'be-na', name: 'Bé Na', search_value: 'Bé Na',
      thumbnail: 'https://img/be-na.png', uuid: '123e4567-e89b-42d3-a456-426614174000', resolved: true,
    }],
  });
  assert.deepEqual(payload.voiceSelection, {
    primary: { slug: 'kore', name: 'Kore', resolved: true },
    selections: [{ slug: 'kore', name: 'Kore', resolved: true }],
  });
});

// ---------------------------------------------------------------------------
// Wiring — sidebar modal resolves the selected character through the layer
// ---------------------------------------------------------------------------

test('sidebar selectedFlowCharacter delegates resolution to FlowSelectionNormalize', () => {
  const start = sidebarSource.indexOf('function selectedFlowCharacter');
  assert.ok(start >= 0, 'selectedFlowCharacter exists in sidebar.js');
  const region = sidebarSource.slice(start, start + 4000);
  assert.ok(region.includes('FlowSelectionNormalize'), 'sidebar resolves through the shared normalization layer');
  assert.ok(region.includes('normalizeCharacterSelection'), 'sidebar calls the shared character normalizer');
  assert.ok(workflowsSource.includes('selection-normalize'), 'flow-workflows loads the shared module');
});

// ---------------------------------------------------------------------------
// Wiring — MCP character looks resolve selection-shaped input (src/characters)
// ---------------------------------------------------------------------------

test('characterLookForSelection resolves slug / JSON / object / array selections to the same look', async () => {
  const { characterLookForSelection, characterSlug } = await import('../dist/characters.js');
  const looks = { 'anh hung': 'tall, red coat' };
  assert.equal(characterSlug('Anh Hùng'), 'anh-hung');
  assert.equal(characterLookForSelection('anh-hung', looks), 'tall, red coat');
  assert.equal(characterLookForSelection('Anh Hùng', looks), 'tall, red coat');
  assert.equal(characterLookForSelection('{"slug":"anh-hung"}', looks), 'tall, red coat');
  assert.equal(characterLookForSelection({ slug: 'anh-hung' }, looks), 'tall, red coat');
  assert.equal(characterLookForSelection({ name: 'Anh Hùng' }, looks), 'tall, red coat');
  assert.equal(characterLookForSelection(['anh-hung', 'meo-mun'], looks), 'tall, red coat');
  assert.equal(characterLookForSelection('character:Anh Hùng', looks), 'tall, red coat');
  assert.equal(characterLookForSelection('nguoi-la', looks), undefined);
  assert.equal(characterLookForSelection(null, looks), undefined);
});
