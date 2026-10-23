import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// DL-07 — Explicit HTML-response rejection in download waits (study D15,
// gap G7). When Flow serves an HTML error/placeholder page instead of
// media, both download waiters must fail fast with a distinct
// non-retryable code instead of timing out or treating the payload as
// media:
//  - detection is mime OR filename: mime `text/html` (parameters and
//    case tolerated) OR a filename ending `.html`/`.htm`. The OR is
//    pinned: a `.html` filename rejects even when the item carries a
//    real media mime (the study/gap text lists the two signals as
//    alternatives, unlike queueDownloadExtension's naming discipline,
//    where a media mime rescues an .html name for extension purposes);
//  - the check runs on every poll sighting of a completed item BEFORE
//    it can be returned as a media result, in the ticketed queue wait,
//    the existing-download queue wait, and the native (backend) waits;
//  - HTML detection wins over the DL-05 resume classifier: an
//    interrupted HTML-ish item is not a media download at all, so it
//    is never resumed;
//  - on detection the queue side requests file removal through
//    chrome.downloads.removeFile (guarded — a missing removeFile must
//    not mask the HTML error). The native bridge exposes no removal
//    method (flow.downloads.recent / .read only), so the native side
//    mirrors detection + the same error code and records that removal
//    was not available to it.

const queue = await import('../extension/src/background/flow-queue-downloads.js');
const {
  waitForQueueFlowDownload,
  waitForExistingQueueFlowDownload,
  findExistingQueueFlowDownload,
  armQueueFilenameOverride,
  disarmQueueFilenameOverride,
  detectFlowDownloadHtmlResponse,
} = queue;

const nativeDownloads = await import('../dist/native-downloads.js');

const MEDIA_ID = 'media-123';
const TAB_ID = 5;

function flowItem(overrides = {}) {
  return {
    id: 7,
    state: 'in_progress',
    filename: '',
    mime: 'image/png',
    tabId: TAB_ID,
    url: `https://flow.google.com/asb/${MEDIA_ID}`,
    finalUrl: `https://flow.google.com/asb/${MEDIA_ID}`,
    referrer: 'https://flow.google.com/',
    startTime: new Date().toISOString(),
    bytesReceived: 40,
    totalBytes: 100,
    ...overrides,
  };
}

function installChrome({ search, resume, removeFile }) {
  globalThis.chrome = {
    runtime: { id: 'test-extension' },
    downloads: {
      search,
      ...(resume ? { resume } : {}),
      ...(removeFile ? { removeFile } : {}),
    },
  };
}

function uninstallChrome() {
  delete globalThis.chrome;
}

// Same snapshot-scripted search double as the DL-05 tests: each entry
// is the item list for one search call; the last entry repeats. `{id}`
// queries filter the current snapshot by id.
function scriptedSearch(snapshots) {
  let calls = 0;
  return async query => {
    const snapshot = snapshots[Math.min(calls, snapshots.length - 1)];
    calls += 1;
    if (query && 'id' in query) return snapshot.filter(item => item.id === query.id);
    if (query && 'query' in query) return snapshot.filter(item =>
      [item.url, item.finalUrl, item.filename].some(value => String(value || '').includes(query.query[0])));
    return snapshot;
  };
}

function armTicket() {
  const ticket = armQueueFilenameOverride({
    jobId: 'job-1', flowMediaId: MEDIA_ID, fileStem: 'scene-01',
    flowTabId: TAB_ID, flowProjectId: '', mediaKind: 'image', title: 'scene one',
  });
  assert.ok(ticket, 'ticket must arm');
  return ticket;
}

function assertHtmlError(error, { via } = {}) {
  assert.equal(error.code, 'FLOW_DOWNLOAD_HTML_RESPONSE',
    'the failure carries the distinct HTML-response code, not FLOW_DOWNLOAD_FAILED');
  assert.equal(error.retryable, false, 'an HTML response is non-retryable');
  assert.equal(error.outcomeUnknown, false);
  assert.equal(error.outcome_unknown, false);
  assert.match(error.message, /HTML/i);
  assert.match(error.message, /remains in Flow/, 'house style: the message says the media remains in Flow');
  assert.ok(error.downloadHtmlResponse, 'the error carries HTML-response diagnostics');
  assert.equal(error.downloadHtmlResponse.downloadId, 7);
  if (via) assert.equal(error.downloadHtmlResponse.via, via);
  return true;
}

// ---------------------------------------------------------------------------
// Detector: mime OR filename, on both sides.
// ---------------------------------------------------------------------------

test('DL-07 detector: mime text/html is detected (case/parameters tolerated)', () => {
  assert.equal(typeof detectFlowDownloadHtmlResponse, 'function');
  for (const mime of ['text/html', 'TEXT/HTML', 'text/html; charset=utf-8', ' text/html ']) {
    const signal = detectFlowDownloadHtmlResponse({ filename: 'scene-01.png', mime });
    assert.ok(signal, `${mime} must be detected`);
    assert.equal(signal.via, 'mime');
  }
});

test('DL-07 detector: a .html/.htm filename is detected even with a real media mime (OR is pinned)', () => {
  for (const filename of ['scene-01.html', 'scene-01.htm', 'C:\\Downloads\\Scene.HTML']) {
    const signal = detectFlowDownloadHtmlResponse({ filename, mime: 'application/octet-stream' });
    assert.ok(signal, `${filename} must be detected`);
    assert.equal(signal.via, 'filename');
  }
  // The pinned reading: filename signal alone suffices — a media mime
  // does NOT rescue a .html filename in the waiters' HTML check.
  const rescued = detectFlowDownloadHtmlResponse({ filename: 'scene-01.html', mime: 'image/png' });
  assert.ok(rescued, 'a .html filename with a media mime is still an HTML response for DL-07');
  assert.equal(rescued.via, 'filename');
});

test('DL-07 detector: genuine media completions are not flagged (control)', () => {
  for (const item of [
    { filename: 'scene-01.png', mime: 'image/png' },
    { filename: 'scene-01.mp4', mime: 'video/mp4' },
    { filename: 'scene-01.webp', mime: '' },
    { filename: '', mime: 'image/jpeg' },
    { filename: 'page.html.png', mime: 'image/png' },
    {},
    null,
    undefined,
  ]) {
    assert.equal(detectFlowDownloadHtmlResponse(item), null,
      `${JSON.stringify(item)} must not be flagged as HTML`);
  }
});

test('DL-07 detector: the native waiter ships the same detector and agrees on the matrix', () => {
  assert.equal(typeof nativeDownloads.detectFlowDownloadHtmlResponse, 'function',
    'native-downloads.ts must export the mirrored detector');
  const matrix = [
    { filename: 'a.png', mime: 'text/html' },
    { filename: 'a.html', mime: 'application/octet-stream' },
    { filename: 'a.htm', mime: 'video/mp4' },
    { filename: 'a.html', mime: 'image/png' },
    { filename: 'a.png', mime: 'image/png' },
    { filename: 'a.mp4', mime: 'video/mp4' },
    { filename: '', mime: '' },
  ];
  for (const item of matrix) {
    assert.deepEqual(
      nativeDownloads.detectFlowDownloadHtmlResponse(item),
      detectFlowDownloadHtmlResponse(item),
      `native and queue detectors must agree on ${JSON.stringify(item)}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Queue waiter (ticketed): completed HTML items fail fast + removal.
// ---------------------------------------------------------------------------

test('DL-07 (a): a completed item with mime text/html rejects with the HTML code, requests removal, never returns', async () => {
  const ticket = armTicket();
  const removeCalls = [];
  const resumeCalls = [];
  const search = scriptedSearch([
    [flowItem({ state: 'complete', filename: 'C:\\Downloads\\scene-01.png', mime: 'text/html; charset=utf-8', bytesReceived: 100 })],
  ]);
  installChrome({
    search,
    resume: async id => { resumeCalls.push(id); },
    removeFile: async id => { removeCalls.push(id); },
  });
  try {
    await assert.rejects(
      waitForQueueFlowDownload(new Set(), 'scene one', 15_000, ticket, null),
      error => assertHtmlError(error, { via: 'mime' }),
    );
    assert.deepEqual(removeCalls, [7], 'file removal was requested for the HTML payload');
    assert.deepEqual(resumeCalls, [], 'an HTML payload is never resumed');
  } finally {
    disarmQueueFilenameOverride(ticket);
    uninstallChrome();
  }
});

test('DL-07 (a2): the claimed-by-id sighting is checked before it can be returned', async () => {
  const ticket = armTicket();
  ticket.downloadId = 7;
  const removeCalls = [];
  const search = scriptedSearch([
    [flowItem({ state: 'complete', filename: 'C:\\Downloads\\scene-01.png', mime: 'text/html', bytesReceived: 100 })],
  ]);
  installChrome({ search, removeFile: async id => { removeCalls.push(id); } });
  try {
    await assert.rejects(
      waitForQueueFlowDownload(new Set(), 'scene one', 15_000, ticket, null),
      error => assertHtmlError(error, { via: 'mime' }),
    );
    assert.deepEqual(removeCalls, [7]);
  } finally {
    disarmQueueFilenameOverride(ticket);
    uninstallChrome();
  }
});

test('DL-07 (b): a completed .html-filename item rejects likewise (filename variant)', async () => {
  const ticket = armTicket();
  const removeCalls = [];
  const search = scriptedSearch([
    [flowItem({ state: 'complete', filename: 'C:\\Downloads\\scene-01.html', mime: 'application/octet-stream', bytesReceived: 100 })],
  ]);
  installChrome({ search, removeFile: async id => { removeCalls.push(id); } });
  try {
    await assert.rejects(
      waitForQueueFlowDownload(new Set(), 'scene one', 15_000, ticket, null),
      error => assertHtmlError(error, { via: 'filename' }),
    );
    assert.deepEqual(removeCalls, [7]);
  } finally {
    disarmQueueFilenameOverride(ticket);
    uninstallChrome();
  }
});

test('DL-07 (b2): a completed .html filename carrying a media mime still rejects (OR, behaviorally)', async () => {
  const ticket = armTicket();
  const removeCalls = [];
  const search = scriptedSearch([
    [flowItem({ state: 'complete', filename: 'C:\\Downloads\\scene-01.html', mime: 'image/png', bytesReceived: 100 })],
  ]);
  installChrome({ search, removeFile: async id => { removeCalls.push(id); } });
  try {
    await assert.rejects(
      waitForQueueFlowDownload(new Set(), 'scene one', 15_000, ticket, null),
      error => assertHtmlError(error, { via: 'filename' }),
    );
    assert.deepEqual(removeCalls, [7]);
  } finally {
    disarmQueueFilenameOverride(ticket);
    uninstallChrome();
  }
});

test('DL-07 (c): the unticketed queue wait also rejects a title-matched HTML completion', async () => {
  const removeCalls = [];
  const search = scriptedSearch([
    [flowItem({ state: 'complete', filename: 'scene one.png', mime: 'text/html', bytesReceived: 100 })],
  ]);
  installChrome({ search, removeFile: async id => { removeCalls.push(id); } });
  try {
    await assert.rejects(
      waitForQueueFlowDownload(new Set(), 'scene one', 15_000, null, null),
      error => assertHtmlError(error, { via: 'mime' }),
    );
    assert.deepEqual(removeCalls, [7]);
  } finally {
    uninstallChrome();
  }
});

// ---------------------------------------------------------------------------
// Existing-download waiter + DL-05 interplay: HTML wins over resume.
// ---------------------------------------------------------------------------

test('DL-07 (d): the existing-download waiter rejects a completed HTML item and requests removal', async () => {
  const removeCalls = [];
  const search = scriptedSearch([
    [flowItem({ state: 'complete', filename: 'C:\\Downloads\\scene-01.htm', mime: '', bytesReceived: 100 })],
  ]);
  installChrome({ search, removeFile: async id => { removeCalls.push(id); } });
  try {
    await assert.rejects(
      waitForExistingQueueFlowDownload(7, MEDIA_ID, TAB_ID, '', 'scene one', 15_000, null),
      error => assertHtmlError(error, { via: 'filename' }),
    );
    assert.deepEqual(removeCalls, [7]);
  } finally {
    uninstallChrome();
  }
});

test('DL-07 (e): an interrupted HTML-ish item is never resumed — HTML detection wins over the DL-05 classifier', async () => {
  const removeCalls = [];
  const resumeCalls = [];
  const search = scriptedSearch([
    [flowItem({ state: 'interrupted', error: 'NETWORK_TIMEOUT', canResume: true, filename: 'C:\\Downloads\\scene-01.png', mime: 'text/html' })],
  ]);
  installChrome({
    search,
    resume: async id => { resumeCalls.push(id); },
    removeFile: async id => { removeCalls.push(id); },
  });
  try {
    await assert.rejects(
      waitForExistingQueueFlowDownload(7, MEDIA_ID, TAB_ID, '', 'scene one', 15_000, null),
      error => assertHtmlError(error, { via: 'mime' }),
    );
    assert.deepEqual(resumeCalls, [], 'a transient+canResume HTML item must NOT be resumed');
    assert.deepEqual(removeCalls, [7]);
  } finally {
    uninstallChrome();
  }
});

test('DL-07 (e2): the ticketed wait likewise never resumes an interrupted HTML-ish candidate', async () => {
  const ticket = armTicket();
  const removeCalls = [];
  const resumeCalls = [];
  const search = scriptedSearch([
    [flowItem({ state: 'interrupted', error: 'NETWORK_FAILED', canResume: true, filename: 'C:\\Downloads\\scene-01.html', mime: '' })],
  ]);
  installChrome({
    search,
    resume: async id => { resumeCalls.push(id); },
    removeFile: async id => { removeCalls.push(id); },
  });
  try {
    await assert.rejects(
      waitForQueueFlowDownload(new Set(), 'scene one', 15_000, ticket, null),
      error => assertHtmlError(error, { via: 'filename' }),
    );
    assert.deepEqual(resumeCalls, []);
    assert.deepEqual(removeCalls, [7]);
  } finally {
    disarmQueueFilenameOverride(ticket);
    uninstallChrome();
  }
});

// ---------------------------------------------------------------------------
// findExisting: a completed HTML item is never handed back as a result.
// ---------------------------------------------------------------------------

test('DL-07 (f): findExistingQueueFlowDownload rejects a completed HTML match instead of returning it as media', async () => {
  const removeCalls = [];
  const search = scriptedSearch([
    [flowItem({ state: 'complete', filename: 'C:\\Downloads\\scene-01.png', mime: 'text/html', bytesReceived: 100 })],
  ]);
  installChrome({ search, removeFile: async id => { removeCalls.push(id); } });
  try {
    await assert.rejects(
      findExistingQueueFlowDownload(MEDIA_ID, TAB_ID, '', 'scene one'),
      error => assertHtmlError(error, { via: 'mime' }),
    );
    assert.deepEqual(removeCalls, [7]);
  } finally {
    uninstallChrome();
  }
});

// ---------------------------------------------------------------------------
// Controls + removal guard.
// ---------------------------------------------------------------------------

test('DL-07 control: a genuine media completion still returns normally and is never removed', async () => {
  const ticket = armTicket();
  const removeCalls = [];
  const search = scriptedSearch([
    [flowItem({ state: 'complete', filename: 'C:\\Downloads\\scene-01.png', mime: 'image/png', bytesReceived: 100 })],
  ]);
  installChrome({ search, removeFile: async id => { removeCalls.push(id); } });
  try {
    const result = await waitForQueueFlowDownload(new Set(), 'scene one', 15_000, ticket, null);
    assert.equal(result.id, 7);
    assert.equal(result.filename, 'C:\\Downloads\\scene-01.png');
    assert.deepEqual(removeCalls, [], 'a media file is never removed');
  } finally {
    disarmQueueFilenameOverride(ticket);
    uninstallChrome();
  }

  const search2 = scriptedSearch([
    [flowItem({ state: 'complete', filename: 'C:\\Downloads\\scene-01.mp4', mime: 'video/mp4', bytesReceived: 100 })],
  ]);
  installChrome({ search: search2, removeFile: async id => { removeCalls.push(id); } });
  try {
    const result = await waitForExistingQueueFlowDownload(7, MEDIA_ID, TAB_ID, '', 'scene one', 15_000, null);
    assert.equal(result.id, 7);
    assert.deepEqual(removeCalls, []);
  } finally {
    uninstallChrome();
  }
});

test('DL-07 guard: a missing chrome.downloads.removeFile does not mask the HTML error', async () => {
  const ticket = armTicket();
  const search = scriptedSearch([
    [flowItem({ state: 'complete', filename: 'C:\\Downloads\\scene-01.png', mime: 'text/html', bytesReceived: 100 })],
  ]);
  installChrome({ search }); // no removeFile on this chrome double
  try {
    await assert.rejects(
      waitForQueueFlowDownload(new Set(), 'scene one', 15_000, ticket, null),
      error => {
        assertHtmlError(error, { via: 'mime' });
        assert.equal(error.downloadHtmlResponse.fileRemoved, false,
          'removal is reported honestly when the surface is unavailable');
        return true;
      },
    );
  } finally {
    disarmQueueFilenameOverride(ticket);
    uninstallChrome();
  }
});

// ---------------------------------------------------------------------------
// Native side: selection never returns HTML; both native waits are wired.
// ---------------------------------------------------------------------------

test('DL-07 native: selectCompletedFlowDownload never selects an HTML item', () => {
  const before = new Set([1]);
  const base = {
    state: 'complete', totalBytes: 10, bytesReceived: 10,
    url: 'https://flow.google.com/project/abc', finalUrl: 'https://storage.googleapis.com/flow/scene',
    referrer: 'https://flow.google.com/',
  };
  const htmlByMime = { ...base, id: 2, filename: '/tmp/scene.png', mime: 'text/html' };
  const htmlByName = { ...base, id: 3, filename: '/tmp/scene.html', mime: 'image/png' };
  const media = { ...base, id: 4, filename: '/tmp/scene.mp4' };
  assert.equal(nativeDownloads.selectCompletedFlowDownload([htmlByMime], before), undefined);
  assert.equal(nativeDownloads.selectCompletedFlowDownload([htmlByName], before), undefined);
  assert.equal(nativeDownloads.selectCompletedFlowDownload([htmlByMime, htmlByName, media], before), media,
    'the media item behind HTML items is still selectable');
});

test('DL-07 native: both native waits check HTML before returning a download (wiring contract)', () => {
  const source = readFileSync(new URL('../src/native-downloads.ts', import.meta.url), 'utf8');
  const waitBody = source.slice(source.indexOf('export async function waitForNativeDownload'), source.indexOf('export async function materializeNativeDownload'));
  const queuedBody = source.slice(source.indexOf('export async function materializeQueuedNativeDownloads'));
  for (const [name, body] of [['waitForNativeDownload', waitBody], ['materializeQueuedNativeDownloads', queuedBody]]) {
    assert.ok(body.includes('throwIfHtmlNativeDownload('), `${name} must run the HTML check on poll sightings`);
  }
  assert.ok(source.includes('FLOW_DOWNLOAD_HTML_RESPONSE'),
    'the native HTML check fails with the distinct HTML-response code');
  // The bridge exposes no removal surface to the backend — the native
  // side must record that honestly instead of pretending to remove.
  assert.ok(source.includes('fileRemoved: false') || source.includes('removalAvailable: false'),
    'the native HTML error records that file removal is not available through the bridge');
});
