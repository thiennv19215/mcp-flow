import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  FlowAlbums,
  normalizeAlbumImage,
  albumImageToReference,
  uniquifyAlbumName,
} from '../extension/src/background/flow-albums.js';

const serviceWorkerSource = readFileSync(new URL('../extension/src/background/service-worker.js', import.meta.url), 'utf8');
const sidebarSource = readFileSync(new URL('../extension/src/ui/sidebar.js', import.meta.url), 'utf8');
const sidebarHtml = readFileSync(new URL('../extension/src/ui/sidebar.html', import.meta.url), 'utf8');
const pickerSource = readFileSync(new URL('../extension/src/ui/reference-picker.js', import.meta.url), 'utf8');

// ---------------------------------------------------------------------------
// FEAT-10: generation albums / photo organization.
//
// An album is a named, ordered list of image IDENTITIES (Flow media id,
// name, kind, project, thumbnail) kept in extension storage — the media
// itself stays in the Flow library / project folders, so there is no blob
// store here. The same image may belong to many albums; an album may be
// empty; the cover is the first image. "Use as ref" on an album image
// returns the exact identity shape the reference picker produces for a
// library pick, so it rides the existing attach path unchanged.
// ---------------------------------------------------------------------------

function memoryStorage() {
  const data = {};
  return {
    data,
    async get(key) { return { [key]: data[key] }; },
    async set(entries) { Object.assign(data, entries); },
  };
}

const IMG = (id, overrides = {}) => ({
  id,
  name: `img-${id}`,
  kind: 'image',
  projectId: 'project-1',
  thumbnailUrl: `https://example.test/${id}.jpg`,
  ...overrides,
});

async function makeStore(storage = memoryStorage()) {
  const store = new FlowAlbums({ storage });
  await store.ready;
  return store;
}

test('album CRUD: create, get, rename, remove', async () => {
  const store = await makeStore();
  const album = await store.create({ name: 'Cats' });
  assert.equal(album.name, 'Cats');
  assert.deepEqual(album.images, []);
  assert.equal(typeof album.id, 'string');
  assert.ok(album.id.length > 0);
  assert.equal(album.createdAt, album.updatedAt);

  const fetched = await store.get(album.id);
  assert.equal(fetched.name, 'Cats');

  const renamed = await store.rename(album.id, 'Dogs');
  assert.equal(renamed.name, 'Dogs');
  assert.equal((await store.get(album.id)).name, 'Dogs');

  assert.equal(await store.remove(album.id), true);
  assert.equal(await store.get(album.id), null);
  assert.equal(await store.remove(album.id), false);
  assert.deepEqual(await store.list(), []);
});

test('album operations on an unknown id fail with FLOW_ALBUM_NOT_FOUND', async () => {
  const store = await makeStore();
  await assert.rejects(store.rename('nope', 'X'), error => error.code === 'FLOW_ALBUM_NOT_FOUND');
  await assert.rejects(store.addImage('nope', IMG('a')), error => error.code === 'FLOW_ALBUM_NOT_FOUND');
  await assert.rejects(store.removeImage('nope', 'a'), error => error.code === 'FLOW_ALBUM_NOT_FOUND');
});

test('album names are unique: duplicates are uniquified, never colliding', async () => {
  const store = await makeStore();
  const first = await store.create({ name: 'Album' });
  const second = await store.create({ name: 'Album' });
  const third = await store.create({ name: 'album' });
  const names = (await store.list()).map(album => album.name);
  assert.equal(new Set(names.map(name => name.toLowerCase())).size, 3, `names must be unique case-insensitively, got ${names}`);
  assert.equal(first.name, 'Album');
  assert.notEqual(second.name, first.name);

  // Renaming onto another album's name is uniquified too; renaming to
  // its own current name is a no-op for the name.
  const renamed = await store.rename(third.id, 'Album');
  assert.notEqual(renamed.name.toLowerCase(), first.name.toLowerCase());
  assert.notEqual(renamed.name.toLowerCase(), second.name.toLowerCase());
  const selfRenamed = await store.rename(first.id, 'Album');
  assert.equal(selfRenamed.name, 'Album');
});

test('creating or renaming without a name is rejected', async () => {
  const store = await makeStore();
  await assert.rejects(store.create({ name: '   ' }), error => error.code === 'FLOW_ALBUM_NAME_REQUIRED');
  await assert.rejects(store.create({}), error => error.code === 'FLOW_ALBUM_NAME_REQUIRED');
  const album = await store.create({ name: 'Named' });
  await assert.rejects(store.rename(album.id, ''), error => error.code === 'FLOW_ALBUM_NAME_REQUIRED');
});

test('uniquifyAlbumName appends a counter until the name is free', () => {
  assert.equal(uniquifyAlbumName('Pets', []), 'Pets');
  assert.equal(uniquifyAlbumName('Pets', ['Pets']), 'Pets (2)');
  assert.equal(uniquifyAlbumName('Pets', ['Pets', 'pets (2)']), 'Pets (3)');
  assert.equal(uniquifyAlbumName('Pets', ['Pets'], { exclude: 'Pets' }), 'Pets');
});

test('add/remove keeps album order and bumps updated_at', async () => {
  const realNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    const store = await makeStore();
    const album = await store.create({ name: 'Ordered' });
    assert.equal(album.updatedAt, 1_000);

    now = 2_000;
    await store.addImage(album.id, IMG('a'));
    await store.addImage(album.id, IMG('b'));
    const filled = await store.addImage(album.id, IMG('c'));
    assert.deepEqual(filled.images.map(image => image.id), ['a', 'b', 'c']);
    assert.equal(filled.updatedAt, 2_000);
    assert.equal(filled.createdAt, 1_000);

    now = 3_000;
    const pruned = await store.removeImage(album.id, 'b');
    assert.deepEqual(pruned.images.map(image => image.id), ['a', 'c']);
    assert.equal(pruned.updatedAt, 3_000);

    // Removing an image that is not a member changes nothing.
    const untouched = await store.removeImage(album.id, 'missing');
    assert.deepEqual(untouched.images.map(image => image.id), ['a', 'c']);
    assert.equal(untouched.updatedAt, 3_000);
  } finally {
    Date.now = realNow;
  }
});

test('adding the same image twice keeps a single membership', async () => {
  const store = await makeStore();
  const album = await store.create({ name: 'Dedup' });
  await store.addImage(album.id, IMG('a'));
  const again = await store.addImage(album.id, IMG('a', { name: 'renamed-elsewhere' }));
  assert.equal(again.images.length, 1);
  assert.deepEqual((await store.get(album.id)).images.map(image => image.id), ['a']);
});

test('one image can belong to many albums; cover is the first image', async () => {
  const store = await makeStore();
  const one = await store.create({ name: 'One' });
  const two = await store.create({ name: 'Two' });
  await store.addImage(one.id, IMG('shared'));
  await store.addImage(one.id, IMG('only-one'));
  await store.addImage(two.id, IMG('shared'));

  const listed = await store.list();
  const byName = new Map(listed.map(album => [album.name, album]));
  assert.equal(byName.get('One').imageCount, 2);
  assert.equal(byName.get('Two').imageCount, 1);
  assert.equal(byName.get('One').cover.id, 'shared');
  assert.equal(byName.get('Two').cover.id, 'shared');

  // Removing from one album leaves the other membership intact.
  await store.removeImage(one.id, 'shared');
  assert.equal((await store.get(one.id)).cover.id, 'only-one');
  assert.equal((await store.get(two.id)).imageCount, 1);
});

test('an empty album still exists and lists with no cover', async () => {
  const store = await makeStore();
  const album = await store.create({ name: 'Empty' });
  const listed = await store.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, album.id);
  assert.equal(listed[0].imageCount, 0);
  assert.equal(listed[0].cover, null);
});

test('membership survives a store reload over the same storage', async () => {
  const storage = memoryStorage();
  const first = await makeStore(storage);
  const album = await first.create({ name: 'Persistent' });
  await first.addImage(album.id, IMG('x'));
  await first.addImage(album.id, IMG('y'));
  await first.flush();

  const second = await makeStore(storage);
  const reloaded = await second.get(album.id);
  assert.equal(reloaded.name, 'Persistent');
  assert.deepEqual(reloaded.images.map(image => image.id), ['x', 'y']);
  assert.equal(reloaded.cover.id, 'x');
});

test('normalizeAlbumImage requires an identity and normalizes the rest', () => {
  assert.throws(() => normalizeAlbumImage({ name: 'no id' }), error => error.code === 'FLOW_ALBUM_IMAGE_INVALID');
  assert.throws(() => normalizeAlbumImage(null), error => error.code === 'FLOW_ALBUM_IMAGE_INVALID');
  const minimal = normalizeAlbumImage({ id: 'm-1' });
  assert.equal(minimal.id, 'm-1');
  assert.equal(minimal.name, 'm-1');
  assert.equal(minimal.kind, 'image');
  assert.equal(minimal.projectId, null);
  assert.equal(minimal.thumbnailUrl, null);
  const video = normalizeAlbumImage({ id: 'v-1', name: 'Clip', kind: 'video', expectedId: 'ignored' });
  assert.equal(video.kind, 'video');
  assert.equal(video.name, 'Clip');
});

test('"use as ref" returns the same identity shape as a library pick', () => {
  const image = normalizeAlbumImage(IMG('media-1', { name: 'Sunset' }));
  const reference = albumImageToReference(image);
  // The shape the reference picker builds for a Flow library asset:
  // { source, projectId, id, name, kind, assetName, expectedId, thumbnailUrl }.
  assert.deepEqual(Object.keys(reference).sort(), [
    'assetName', 'expectedId', 'id', 'kind', 'name', 'projectId', 'source', 'thumbnailUrl',
  ]);
  assert.equal(reference.source, 'flow');
  assert.equal(reference.id, 'media-1');
  assert.equal(reference.expectedId, 'media-1');
  assert.equal(reference.name, 'Sunset');
  assert.equal(reference.assetName, 'asset:Sunset');
  assert.equal(reference.kind, 'image');
  assert.equal(reference.projectId, 'project-1');
  assert.equal(reference.thumbnailUrl, 'https://example.test/media-1.jpg');

  // A caller-side project (the picker's current project) wins when given.
  const overridden = albumImageToReference(image, { projectId: 'project-9' });
  assert.equal(overridden.projectId, 'project-9');
});

test('service worker wires the album store and the flow-albums handlers', () => {
  assert.match(serviceWorkerSource, /from "\.\/flow-albums\.js"/);
  assert.match(serviceWorkerSource, /new FlowAlbums\(\)/);
  for (const action of ['flow-albums:list', 'flow-albums:create', 'flow-albums:rename', 'flow-albums:remove', 'flow-albums:add-image', 'flow-albums:remove-image']) {
    assert.ok(serviceWorkerSource.includes(`case "${action}"`), `missing handler ${action}`);
  }
});

test('sidebar renders the albums subtab and result cards can save to an album', () => {
  assert.ok(sidebarHtml.includes('id="albumListContainer"'), 'albums pane keeps its container');
  assert.ok(sidebarHtml.includes('id="createAlbumBtn"'), 'albums pane has a create button');
  assert.ok(sidebarSource.includes('"flow-albums:list"') || sidebarSource.includes("'flow-albums:list'") || sidebarSource.includes('flow-albums:list'), 'sidebar loads albums');
  assert.ok(sidebarSource.includes('flow-albums:add-image'), 'photo cards gain save-to-album');
  assert.ok(sidebarSource.includes('flow-albums:remove-image'), 'album images can be removed');
  assert.ok(sidebarSource.includes('albumListContainer'), 'sidebar renders into the albums container');
});

test('reference picker gains an Albums source returning library-shaped references', () => {
  assert.ok(sidebarHtml.includes('id="refPickerAlbumGrid"'), 'picker markup has an album grid');
  assert.ok(sidebarHtml.includes('id="refPickerAlbumSelect"'), 'picker markup has an album select');
  assert.ok(pickerSource.includes('flow-albums:list'), 'picker loads albums from the store');
  assert.ok(pickerSource.includes('refPickerAlbumGrid'), 'picker renders album images');
  // One shared builder produces the reference object for BOTH the Flow
  // library grid and the Albums source, so the shapes cannot drift.
  const builders = pickerSource.match(/assetName:/g) || [];
  assert.equal(builders.length, 1, 'library and album picks share one reference builder');
});
