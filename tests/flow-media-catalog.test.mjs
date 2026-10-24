import test from 'node:test';
import assert from 'node:assert/strict';

import { FlowMediaCatalog, FLOW_MEDIA_CATALOG_MAX_ENTRIES } from '../extension/src/background/flow-media-catalog.js';

// IMG-03 — per-project media catalog (background store).
// Upload receipts resolve the canonical media UUID / project / thumbnail at
// upload time and register them here; later identity resolutions consult
// this store before any DOM scan. The store follows the batch-drafts
// persistence discipline: synchronous snapshots, a write chain with a
// rejection guard, and a restore that degrades to empty instead of wedging.

const PROJECT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROJECT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const UUID_1 = '11111111-1111-4111-8111-111111111111';
const UUID_2 = '22222222-2222-4222-8222-222222222222';
const ASB_1 = `asb:${'A'.repeat(48)}`;

function memoryStorage() {
  const data = {};
  return {
    data,
    async get(key) { return { [key]: data[key] }; },
    async set(entries) { Object.assign(data, entries); },
  };
}

test('catalog records an entry and a fresh instance reads it back (persistence round-trip)', async () => {
  const storage = memoryStorage();
  const catalog = new FlowMediaCatalog({ storage });
  const recorded = await catalog.record({
    projectId: PROJECT_A, mediaId: ASB_1, uuid: UUID_1,
    uploadName: 'upload-a.png', originalName: 'IMG_1234.png', name: 'IMG_1234.png',
    thumbnailUrl: 'https://flow.google.com/asb/thumb-a', kind: 'image',
  });
  assert.equal(recorded.projectId, PROJECT_A);
  assert.equal(recorded.mediaId, ASB_1);
  assert.equal(recorded.uuid, UUID_1);
  assert.equal(typeof recorded.recordedAt, 'number');

  const reopened = new FlowMediaCatalog({ storage });
  const found = await reopened.lookup({ projectId: PROJECT_A, mediaId: ASB_1 });
  assert.equal(found.uuid, UUID_1);
  assert.equal(found.thumbnailUrl, 'https://flow.google.com/asb/thumb-a');
  assert.equal(found.uploadName, 'upload-a.png');
  assert.equal(found.originalName, 'IMG_1234.png');
});

test('catalog dedupes by (projectId, mediaId): a second record merges instead of duplicating', async () => {
  const catalog = new FlowMediaCatalog({ storage: memoryStorage() });
  await catalog.record({ projectId: PROJECT_A, mediaId: ASB_1, name: 'first.png', kind: 'image' });
  const merged = await catalog.record({
    projectId: PROJECT_A, mediaId: ASB_1, uuid: UUID_1,
    thumbnailUrl: 'https://flow.google.com/asb/thumb-a', kind: 'image',
  });
  assert.equal(merged.uuid, UUID_1, 'the later record fills in the canonical uuid');
  assert.equal(merged.name, 'first.png', 'fields the later record omits are preserved');
  const entries = await catalog.list(PROJECT_A);
  assert.equal(entries.length, 1, 'one entry per (project, mediaId)');
});

test('catalog dedupes by uuid when the mediaId form differs', async () => {
  const catalog = new FlowMediaCatalog({ storage: memoryStorage() });
  await catalog.record({ projectId: PROJECT_A, uuid: UUID_1, name: 'by-uuid.png', kind: 'image' });
  await catalog.record({ projectId: PROJECT_A, mediaId: ASB_1, uuid: UUID_1, thumbnailUrl: 'https://flow.google.com/asb/t', kind: 'image' });
  const entries = await catalog.list(PROJECT_A);
  assert.equal(entries.length, 1, 'the asb-form record merges into the uuid-keyed entry');
  assert.equal(entries[0].mediaId, ASB_1);
  const byUuid = await catalog.lookup({ projectId: PROJECT_A, uuid: UUID_1 });
  assert.equal(byUuid.mediaId, ASB_1);
  const byMediaId = await catalog.lookup({ projectId: PROJECT_A, mediaId: ASB_1 });
  assert.equal(byMediaId.uuid, UUID_1);
});

test('catalog isolates projects: the same mediaId in another project is a different entry', async () => {
  const catalog = new FlowMediaCatalog({ storage: memoryStorage() });
  await catalog.record({ projectId: PROJECT_A, mediaId: ASB_1, uuid: UUID_1, kind: 'image' });
  await catalog.record({ projectId: PROJECT_B, mediaId: ASB_1, uuid: UUID_2, kind: 'image' });
  assert.equal((await catalog.list()).length, 2);
  assert.equal((await catalog.lookup({ projectId: PROJECT_A, mediaId: ASB_1 })).uuid, UUID_1);
  assert.equal((await catalog.lookup({ projectId: PROJECT_B, mediaId: ASB_1 })).uuid, UUID_2);
  assert.equal(await catalog.lookup({ projectId: PROJECT_B, uuid: UUID_1 }), null, 'a uuid known only in project A must not resolve in project B');
});

test('catalog lookup falls back mediaId -> uuid -> uploadName -> name within the project', async () => {
  const catalog = new FlowMediaCatalog({ storage: memoryStorage() });
  await catalog.record({
    projectId: PROJECT_A, mediaId: ASB_1, uuid: UUID_1,
    uploadName: 'content-name.png', name: 'Pretty Name.png', kind: 'image',
  });
  assert.equal((await catalog.lookup({ projectId: PROJECT_A, uploadName: 'content-name.png' })).mediaId, ASB_1);
  assert.equal((await catalog.lookup({ projectId: PROJECT_A, name: 'Pretty Name.png' })).mediaId, ASB_1);
  assert.equal(await catalog.lookup({ projectId: PROJECT_A, name: 'missing.png' }), null);
  assert.equal(await catalog.lookup({ projectId: PROJECT_A }), null, 'a query with no identity matches nothing');
});

test('catalog rejects entries without a project or without any identity', async () => {
  const catalog = new FlowMediaCatalog({ storage: memoryStorage() });
  assert.equal(await catalog.record({ mediaId: ASB_1, kind: 'image' }), null);
  assert.equal(await catalog.record({ projectId: PROJECT_A, name: 'name-only.png', kind: 'image' }), null);
  assert.equal((await catalog.list()).length, 0);
});

test('catalog is bounded: oldest entries are evicted past the cap', async () => {
  const catalog = new FlowMediaCatalog({ storage: memoryStorage() });
  const total = FLOW_MEDIA_CATALOG_MAX_ENTRIES + 10;
  for (let i = 0; i < total; i++) {
    await catalog.record({ projectId: PROJECT_A, mediaId: `media-${i}`, name: `f${i}.png`, kind: 'image' });
  }
  const entries = await catalog.list(PROJECT_A);
  assert.equal(entries.length, FLOW_MEDIA_CATALOG_MAX_ENTRIES);
  assert.equal(await catalog.lookup({ projectId: PROJECT_A, mediaId: 'media-0' }), null, 'the oldest entries are evicted first');
  assert.ok(await catalog.lookup({ projectId: PROJECT_A, mediaId: `media-${total - 1}` }), 'the newest entry survives');
});

test('catalog write chain survives a rejected storage write (later records still persist)', async () => {
  const data = {};
  let failNextSet = true;
  const storage = {
    async get(key) { return { [key]: data[key] }; },
    async set(entries) {
      if (failNextSet) { failNextSet = false; throw new Error('transient storage failure'); }
      Object.assign(data, entries);
    },
  };
  const catalog = new FlowMediaCatalog({ storage });
  await catalog.record({ projectId: PROJECT_A, mediaId: ASB_1, uuid: UUID_1, kind: 'image' }).catch(() => {});
  await catalog.record({ projectId: PROJECT_A, mediaId: 'media-2', uuid: UUID_2, kind: 'image' });
  const reopened = new FlowMediaCatalog({ storage });
  assert.ok(await reopened.lookup({ projectId: PROJECT_A, mediaId: 'media-2' }), 'a later record persists after an earlier write rejection');
});

test('catalog restore degrades to empty when storage reads fail', async () => {
  const storage = {
    async get() { throw new Error('storage unavailable'); },
    async set() {},
  };
  const catalog = new FlowMediaCatalog({ storage });
  assert.deepEqual(await catalog.list(), []);
  assert.equal(await catalog.lookup({ projectId: PROJECT_A, mediaId: ASB_1 }), null);
});
