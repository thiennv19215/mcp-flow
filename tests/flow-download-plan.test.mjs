import test from 'node:test';
import assert from 'node:assert/strict';

// DL-06 — Filename/folder plan + persisted armed renames + web-recovery
// records (study D12/D13/D22, gap G6).
// Today queue downloads get a flat stem in the browser's default folder:
// there is no template, no root/per-task folder planning, and no shared
// batch timestamp. Armed rename tickets live only in a module-level
// array, so a service-worker restart mid-download silently loses the
// intended filename. And nothing remembers the name a media id was first
// downloaded under, so a later re-download derives a fresh name.
// These tests pin the fix:
//  - a pure plan builder: template tokens (date/time/project/prompt/
//    index), ONE shared timestamp per batch, ASCII-folded + truncated +
//    whitelisted project/prompt segments, traversal-proof folder
//    normalization (../ and absolute inputs collapse to the default
//    root), upscale `_<resolution>` suffix;
//  - armed tickets persist to chrome.storage.session and are restored
//    after a simulated SW restart (fresh module state) — the filename
//    listener still suggests the armed folder+name; ambiguous matches
//    still refuse to suggest anything;
//  - per-project records (chrome.storage.local) map media id -> the
//    planned filename, and a later re-download of the same media reuses
//    that exact name even when the caller now asks for a different stem.

const plan = await import('../extension/src/background/flow-download-plan.js');
const {
  buildFlowDownloadPlan,
  sanitizePlanSegment,
  normalizePlanFolderPath,
  FlowDownloadFilenameRecords,
  FLOW_FILENAME_TICKETS_STORAGE_KEY,
  FLOW_FILENAME_RECORDS_STORAGE_KEY,
  DEFAULT_FLOW_DOWNLOAD_ROOT,
} = plan;

const NOW = new Date(2026, 9, 24, 5, 37, 16).getTime(); // local: 2026-10-24 05:37:16

// ---------------------------------------------------------------------------
// In-memory chrome.storage area (get/set/remove with string/array/object
// key forms, mirroring the real API surface the modules use).
// ---------------------------------------------------------------------------
function fakeStorageArea() {
  const map = new Map();
  return {
    _map: map,
    async get(keys) {
      if (keys == null) return Object.fromEntries(map);
      if (typeof keys === 'string') return map.has(keys) ? { [keys]: map.get(keys) } : {};
      if (Array.isArray(keys)) {
        const out = {};
        for (const key of keys) if (map.has(key)) out[key] = map.get(key);
        return out;
      }
      const out = {};
      for (const [key, fallback] of Object.entries(keys)) out[key] = map.has(key) ? map.get(key) : fallback;
      return out;
    },
    async set(entries) { for (const [key, value] of Object.entries(entries)) map.set(key, value); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) map.delete(key); },
  };
}

const PROJECT_ID = '123e4567-e89b-12d3-a456-426614174000';
const MEDIA_ID = 'abcd1234-media-id';
const TAB_ID = 5;

// ---------------------------------------------------------------------------
// (a) Plan builder: shared timestamp, tokens, folding, truncation.
// ---------------------------------------------------------------------------
test('DL-06 (a): a 3-item batch plan shares one timestamp and applies template tokens', () => {
  const built = buildFlowDownloadPlan([
    { project: 'Dự án con mèo', prompt: 'Vẽ một con mèo đội mũ', kind: 'image' },
    { project: 'Dự án con mèo', prompt: 'Chó chạy ngoài đồng', kind: 'image' },
    { project: 'Dự án con mèo', prompt: 'Hoàng hôn trên biển', kind: 'video' },
  ], { template: '{project}-{prompt}-{index}-{date}', now: NOW });
  assert.equal(built.items.length, 3);
  // One shared timestamp for the whole batch.
  assert.equal(built.createdAt, NOW);
  assert.equal(built.timestamp.date, '20261024');
  assert.equal(built.timestamp.time, '053716');
  for (const item of built.items) assert.ok(item.fileStem.endsWith('-20261024'), item.fileStem);
  // Tokens applied; index zero-padded to 3; segments ASCII-folded.
  assert.equal(built.items[0].fileStem, 'Du-an-con-meo-Ve-mot-con-meo-doi-mu-001-20261024');
  assert.equal(built.items[1].fileStem, 'Du-an-con-meo-Cho-chay-ngoai-dong-002-20261024');
  assert.equal(built.items[2].fileStem, 'Du-an-con-meo-Hoang-hon-tren-bien-003-20261024');
});

test('DL-06 (a2): project segments truncate at 30 chars and prompt segments at 40', () => {
  const built = buildFlowDownloadPlan([
    { project: 'abcdefghijklmnopqrstuvwxyz0123456789-long-project-name', prompt: 'abcdefghijklmnopqrstuvwxyz0123456789-long-prompt-text-here' },
  ], { template: '{project}~{prompt}', now: NOW });
  const [projectSegment, promptSegment] = built.items[0].fileStem.split('~');
  assert.equal(projectSegment.length, 30);
  assert.equal(promptSegment.length, 40);
  assert.equal(built.items[0].project, projectSegment);
  assert.equal(built.items[0].prompt, promptSegment);
});

test('DL-06 (a3): sanitizePlanSegment folds Vietnamese diacritics and whitelists characters', () => {
  assert.equal(sanitizePlanSegment('Đồ gia dụng — đẹp!', 40), 'Do-gia-dung-dep');
  assert.equal(sanitizePlanSegment('  nhiều   khoảng   trắng  ', 40), 'nhieu-khoang-trang');
  assert.equal(sanitizePlanSegment('a/b\\c:d*e?f"g<h>i|j', 40), 'a-b-c-d-e-f-g-h-i-j');
  assert.equal(sanitizePlanSegment('!!!', 40), '');
  assert.equal(sanitizePlanSegment('', 40), '');
  assert.equal(sanitizePlanSegment(null, 40), '');
});

test('DL-06 (a4): unknown template tokens are dropped without leaving separator runs', () => {
  const built = buildFlowDownloadPlan([
    { project: 'proj', prompt: 'prompt' },
  ], { template: '{project}-{bogus}-{index}', now: NOW });
  assert.equal(built.items[0].fileStem, 'proj-001');
});

test('DL-06 (a5): upscale items get a _<resolution> suffix; plain items do not', () => {
  const built = buildFlowDownloadPlan([
    { project: 'proj', prompt: 'one', resolution: '1080p' },
    { project: 'proj', prompt: 'two' },
  ], { template: '{prompt}-{index}', now: NOW });
  assert.equal(built.items[0].fileStem, 'one-001_1080p');
  assert.equal(built.items[1].fileStem, 'two-002');
});

// ---------------------------------------------------------------------------
// (b) Folder normalization: traversal-proof, default-root fallback.
// ---------------------------------------------------------------------------
test('DL-06 (b): traversal and absolute folder inputs collapse to the default root', () => {
  assert.equal(normalizePlanFolderPath('../evil', DEFAULT_FLOW_DOWNLOAD_ROOT), DEFAULT_FLOW_DOWNLOAD_ROOT);
  assert.equal(normalizePlanFolderPath('/abs/path', DEFAULT_FLOW_DOWNLOAD_ROOT), DEFAULT_FLOW_DOWNLOAD_ROOT);
  assert.equal(normalizePlanFolderPath('C:\\Windows\\Temp', DEFAULT_FLOW_DOWNLOAD_ROOT), DEFAULT_FLOW_DOWNLOAD_ROOT);
  assert.equal(normalizePlanFolderPath('a/../../b', DEFAULT_FLOW_DOWNLOAD_ROOT), DEFAULT_FLOW_DOWNLOAD_ROOT);
  assert.equal(normalizePlanFolderPath('', DEFAULT_FLOW_DOWNLOAD_ROOT), DEFAULT_FLOW_DOWNLOAD_ROOT);
  // Legitimate relative folders survive, with backslashes normalized.
  assert.equal(normalizePlanFolderPath('Downloads\\Flow Media', ''), 'Downloads/Flow Media');
  assert.equal(normalizePlanFolderPath('Task A/B', ''), 'Task A/B');
});

test('DL-06 (b2): plan folder = root + subfolder, collapsing a subfolder equal to the root', () => {
  const withSub = buildFlowDownloadPlan([{ project: 'p', prompt: 'x' }], { rootFolder: 'Flow', subfolder: 'Task A', now: NOW });
  assert.equal(withSub.folder, 'Flow/Task A');
  assert.equal(withSub.items[0].folder, 'Flow/Task A');
  const collapsed = buildFlowDownloadPlan([{ project: 'p', prompt: 'x' }], { rootFolder: 'Flow', subfolder: 'Flow', now: NOW });
  assert.equal(collapsed.folder, 'Flow');
  const traversal = buildFlowDownloadPlan([{ project: 'p', prompt: 'x' }], { rootFolder: '../evil', subfolder: '../../escape', now: NOW });
  assert.equal(traversal.folder, DEFAULT_FLOW_DOWNLOAD_ROOT);
});

// ---------------------------------------------------------------------------
// (c) Per-project filename records (D22) — the store itself.
// ---------------------------------------------------------------------------
test('DL-06 (c): filename records persist media id -> planned name per project and upsert in place', async () => {
  const storage = fakeStorageArea();
  const records = new FlowDownloadFilenameRecords({ storage });
  await records.record({ projectId: PROJECT_ID, mediaId: MEDIA_ID, folder: 'Flow/Task A', filename: 'Flow/Task A/proj-title-001.png' });
  const hit = await records.lookup(PROJECT_ID, MEDIA_ID);
  assert.equal(hit.filename, 'Flow/Task A/proj-title-001.png');
  assert.equal(hit.folder, 'Flow/Task A');
  assert.equal(await records.lookup('another-project', MEDIA_ID), null);
  assert.equal(await records.lookup(PROJECT_ID, 'other-media'), null);
  // Media ids match case-insensitively, like the queue's own id checks.
  assert.equal((await records.lookup(PROJECT_ID, MEDIA_ID.toUpperCase()))?.filename, 'Flow/Task A/proj-title-001.png');
  // A re-plan for the same media replaces the record instead of duplicating it.
  await records.record({ projectId: PROJECT_ID, mediaId: MEDIA_ID, folder: 'Flow', filename: 'Flow/new-name.png' });
  assert.equal((await records.lookup(PROJECT_ID, MEDIA_ID)).filename, 'Flow/new-name.png');
  const stored = storage._map.get(FLOW_FILENAME_RECORDS_STORAGE_KEY);
  assert.equal(stored.version, 1);
  assert.equal(stored.entries.filter(entry => entry.mediaId === MEDIA_ID).length, 1);
  // A second store instance over the same storage sees the record (durable).
  const reopened = new FlowDownloadFilenameRecords({ storage });
  assert.equal((await reopened.lookup(PROJECT_ID, MEDIA_ID)).filename, 'Flow/new-name.png');
});

test('DL-06 (c2): a corrupt records store degrades to misses instead of throwing', async () => {
  const storage = fakeStorageArea();
  storage._map.set(FLOW_FILENAME_RECORDS_STORAGE_KEY, { version: 99, entries: 'garbage' });
  const records = new FlowDownloadFilenameRecords({ storage });
  assert.equal(await records.lookup(PROJECT_ID, MEDIA_ID), null);
  await records.record({ projectId: PROJECT_ID, mediaId: MEDIA_ID, folder: '', filename: 'plain.png' });
  assert.equal((await records.lookup(PROJECT_ID, MEDIA_ID)).filename, 'plain.png');
});

// ---------------------------------------------------------------------------
// Queue integration harness: scripted chrome.downloads + captured
// filename listeners + fake session/local storage. The invoke stub fires
// the determining-filename listeners the way Chrome does after the page
// triggers a download and before it completes.
// ---------------------------------------------------------------------------
function queueHarness({ session, local }) {
  const listeners = { created: [], determining: [] };
  const suggestions = [];
  const completedItem = {
    id: 42,
    state: 'complete',
    filename: 'C:\\Downloads\\flow-original-name.png',
    tabId: TAB_ID,
    url: `https://flow.google.com/project/${PROJECT_ID}/asb/${MEDIA_ID}`,
    finalUrl: `https://flow.google.com/project/${PROJECT_ID}/asb/${MEDIA_ID}`,
    referrer: 'https://flow.google.com/',
    startTime: new Date().toISOString(),
    mime: 'image/png',
  };
  const chrome = {
    runtime: { id: 'test-extension' },
    storage: { session, local },
    downloads: {
      search: async query => {
        if (query && 'query' in query) return [];
        if (query && 'id' in query) return query.id === completedItem.id ? [completedItem] : [];
        return [];
      },
      onCreated: { addListener: fn => listeners.created.push(fn) },
      onDeterminingFilename: { addListener: fn => listeners.determining.push(fn) },
    },
  };
  const invoke = async () => {
    for (const listener of listeners.determining) {
      listener(completedItem, suggestion => suggestions.push(suggestion));
    }
    return { downloadTriggered: true };
  };
  return { chrome, listeners, suggestions, completedItem, invoke };
}

const flushMicrotasks = () => new Promise(resolve => setTimeout(resolve, 10));

// ---------------------------------------------------------------------------
// (d) Tickets persist to session storage and survive an SW restart.
// ---------------------------------------------------------------------------
test('DL-06 (d): an armed ticket survives a service-worker restart and still suggests its folder+name', async () => {
  const session = fakeStorageArea();
  const local = fakeStorageArea();
  const first = queueHarness({ session, local });
  globalThis.chrome = first.chrome;
  try {
    const modA = await import('../extension/src/background/flow-queue-downloads.js?dl06-restart-a');
    modA.initQueueDownloadListeners();
    const ticket = modA.armQueueFilenameOverride({
      jobId: 'job-1', flowMediaId: MEDIA_ID, fileStem: 'proj-title-001',
      flowTabId: TAB_ID, flowProjectId: PROJECT_ID, mediaKind: 'image', title: 'title one',
      folder: 'Flow/Task A',
    });
    assert.ok(ticket, 'ticket must arm');
    await flushMicrotasks();
    const persisted = session._map.get(FLOW_FILENAME_TICKETS_STORAGE_KEY);
    assert.equal(persisted?.version, 1);
    assert.equal(persisted?.tickets?.length, 1);
    assert.equal(persisted.tickets[0].fileStem, 'proj-title-001');
    assert.equal(persisted.tickets[0].folder, 'Flow/Task A');

    // Simulated SW restart: a fresh module instance over the same storage.
    const second = queueHarness({ session, local });
    globalThis.chrome = second.chrome;
    const modB = await import('../extension/src/background/flow-queue-downloads.js?dl06-restart-b');
    modB.initQueueDownloadListeners();
    const restored = await modB.restoreQueueFilenameOverrides();
    assert.equal(restored, 1);
    for (const listener of second.listeners.determining) {
      listener(second.completedItem, suggestion => second.suggestions.push(suggestion));
    }
    assert.equal(second.suggestions.length, 1);
    assert.equal(second.suggestions[0].filename, 'Flow/Task A/proj-title-001.png');
    assert.equal(second.suggestions[0].conflictAction, 'uniquify');
    // The ticket was consumed by the suggestion; the persisted set is empty.
    await flushMicrotasks();
    assert.equal(session._map.get(FLOW_FILENAME_TICKETS_STORAGE_KEY)?.tickets?.length, 0);
  } finally {
    delete globalThis.chrome;
  }
});

test('DL-06 (d2): expired or malformed persisted tickets are not restored', async () => {
  const session = fakeStorageArea();
  session._map.set(FLOW_FILENAME_TICKETS_STORAGE_KEY, {
    version: 1,
    tickets: [
      { jobId: 'old', flowMediaId: MEDIA_ID, fileStem: 'stale-name', flowTabId: TAB_ID, flowProjectId: PROJECT_ID, expiresAt: Date.now() - 1_000 },
      { flowMediaId: MEDIA_ID },
      'garbage',
    ],
  });
  const local = fakeStorageArea();
  const harness = queueHarness({ session, local });
  globalThis.chrome = harness.chrome;
  try {
    const mod = await import('../extension/src/background/flow-queue-downloads.js?dl06-expired');
    mod.initQueueDownloadListeners();
    assert.equal(await mod.restoreQueueFilenameOverrides(), 0);
    for (const listener of harness.listeners.determining) {
      listener(harness.completedItem, suggestion => harness.suggestions.push(suggestion));
    }
    assert.equal(harness.suggestions.length, 0);
  } finally {
    delete globalThis.chrome;
  }
});

// ---------------------------------------------------------------------------
// (e) Ambiguity refuses: two plausibly-matching tickets -> no suggestion.
// ---------------------------------------------------------------------------
test('DL-06 (e): two armed tickets that both plausibly match produce no suggestion', async () => {
  const session = fakeStorageArea();
  const local = fakeStorageArea();
  const harness = queueHarness({ session, local });
  globalThis.chrome = harness.chrome;
  try {
    const mod = await import('../extension/src/background/flow-queue-downloads.js?dl06-ambiguous');
    mod.initQueueDownloadListeners();
    assert.ok(mod.armQueueFilenameOverride({
      jobId: 'job-1', flowMediaId: MEDIA_ID, fileStem: 'first-name',
      flowTabId: TAB_ID, flowProjectId: PROJECT_ID, mediaKind: 'image', title: 'title one',
    }));
    assert.ok(mod.armQueueFilenameOverride({
      jobId: 'job-2', flowMediaId: MEDIA_ID, fileStem: 'second-name',
      flowTabId: TAB_ID, flowProjectId: PROJECT_ID, mediaKind: 'image', title: 'title two',
    }));
    for (const listener of harness.listeners.determining) {
      listener(harness.completedItem, suggestion => harness.suggestions.push(suggestion));
    }
    assert.equal(harness.suggestions.length, 0, 'an ambiguous match must refuse to rename');
  } finally {
    delete globalThis.chrome;
  }
});

// ---------------------------------------------------------------------------
// (f) End-to-end: a planned download records its name; a later
// re-download of the same media reuses the recorded name exactly.
// ---------------------------------------------------------------------------
test('DL-06 (f): a re-download reuses the recorded planned filename instead of the new requested stem', async () => {
  const session = fakeStorageArea();
  const local = fakeStorageArea();

  const first = queueHarness({ session, local });
  globalThis.chrome = first.chrome;
  try {
    const modA = await import('../extension/src/background/flow-queue-downloads.js?dl06-reuse-a');
    modA.initQueueDownloadListeners();
    const downloads = await modA.downloadQueueMedia(
      [{ id: MEDIA_ID, title: 'title one', kind: 'image' }],
      '', 'caller-stem', 'original', first.invoke,
      { progress: async () => {}, signal: undefined },
      [], 'job-1', TAB_ID, PROJECT_ID, null, undefined,
      { template: '{project}-{prompt}-{index}', rootFolder: 'Flow', subfolder: 'Task A' },
    );
    assert.equal(downloads.length, 1);
    assert.equal(first.suggestions.length, 1);
    const plannedPath = first.suggestions[0].filename;
    assert.match(plannedPath, /^Flow\/Task A\/.+-001\.png$/);
    assert.equal(downloads[0].filenameOverrideApplied, true);
    await flushMicrotasks();
    const stored = local._map.get(FLOW_FILENAME_RECORDS_STORAGE_KEY);
    assert.equal(stored?.entries?.length, 1);
    assert.equal(stored.entries[0].filename, plannedPath);
    assert.equal(stored.entries[0].mediaId, MEDIA_ID);
    assert.equal(stored.entries[0].projectId, PROJECT_ID);

    // Later re-download (fresh module state = SW restart in between),
    // with a completely different caller stem and no plan options: the
    // recorded name wins, exactly.
    const second = queueHarness({ session, local });
    globalThis.chrome = second.chrome;
    const modB = await import('../extension/src/background/flow-queue-downloads.js?dl06-reuse-b');
    modB.initQueueDownloadListeners();
    const redownloads = await modB.downloadQueueMedia(
      [{ id: MEDIA_ID, title: 'title one', kind: 'image' }],
      '', 'totally-different-stem', 'original', second.invoke,
      { progress: async () => {}, signal: undefined },
      [], 'job-2', TAB_ID, PROJECT_ID, null, undefined, null,
    );
    assert.equal(redownloads.length, 1);
    assert.equal(second.suggestions.length, 1);
    assert.equal(second.suggestions[0].filename, plannedPath);
    assert.equal(redownloads[0].filenameOverrideApplied, true);
  } finally {
    delete globalThis.chrome;
  }
});
