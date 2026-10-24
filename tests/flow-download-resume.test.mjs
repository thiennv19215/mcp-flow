import test from 'node:test';
import assert from 'node:assert/strict';

// DL-05 — Interrupted-download resume + download retry classification.
// Today both download waiters throw FLOW_DOWNLOAD_FAILED the moment the
// claimed Chrome download reports `interrupted` — even when Chrome says
// the interruption is a transient network error and the download can be
// resumed in place (study D16/D17, gap G5). These tests pin the fix:
//  - a pure classifier maps Chrome interruption reasons (+ the native
//    waiter's pass-through reasons) to {transient|fatal, resumable};
//    identity/provenance/auth/policy/integrity reasons NEVER resume and
//    unknown reasons fail closed as fatal;
//  - the queue waiter resumes a transient, canResume interruption in
//    place under a small local budget, re-verifying ticket identity on
//    every poll after each resume; exhausting the budget fails with the
//    LAST error, its classification attached as diagnostics;
//  - the native (backend) waiter ships the same classifier + budget so
//    its interruption errors carry the same classification vocabulary.

const {
  waitForQueueFlowDownload,
  waitForExistingQueueFlowDownload,
  armQueueFilenameOverride,
  disarmQueueFilenameOverride,
  classifyDownloadInterruption,
  FLOW_DOWNLOAD_RESUME_BUDGET,
} = await import('../extension/src/background/flow-queue-downloads.js');

const nativeDownloads = await import('../dist/native-downloads.js');

const MEDIA_ID = 'media-123';
const TAB_ID = 5;

function flowItem(overrides = {}) {
  return {
    id: 7,
    state: 'in_progress',
    filename: '',
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

function installChrome({ search, resume }) {
  globalThis.chrome = {
    runtime: { id: 'test-extension' },
    downloads: { search, resume },
  };
}

function uninstallChrome() {
  delete globalThis.chrome;
}

// Search double driven by a snapshot script: each entry is the item list
// for one search call; the last entry repeats. `{id}` queries filter the
// current snapshot by id, mirroring chrome.downloads.search semantics.
function scriptedSearch(snapshots) {
  let calls = 0;
  return async query => {
    const snapshot = snapshots[Math.min(calls, snapshots.length - 1)];
    calls += 1;
    if (query && 'id' in query) return snapshot.filter(item => item.id === query.id);
    if (query && 'query' in query) return [];
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

// ---------------------------------------------------------------------------
// Classifier: the mapping both waiters share.
// ---------------------------------------------------------------------------

const TRANSIENT_REASONS = [
  'NETWORK_FAILED', 'NETWORK_TIMEOUT', 'NETWORK_DISCONNECTED', 'NETWORK_SERVER_DOWN',
  'SERVER_FAILED', 'SERVER_UNREACHABLE', 'SERVER_NO_RANGE', 'SERVER_CONTENT_LENGTH_MISMATCH',
  'FILE_TRANSIENT_ERROR', 'CRASH',
];
const FATAL_REASONS = [
  // identity / provenance / integrity — never resume
  'FILE_HASH_MISMATCH', 'FILE_SAME_AS_SOURCE', 'SERVER_BAD_CONTENT', 'SERVER_CROSS_ORIGIN_REDIRECT',
  // auth / policy — never resume
  'SERVER_UNAUTHORIZED', 'SERVER_FORBIDDEN', 'SERVER_CERT_PROBLEM',
  'FILE_VIRUS_INFECTED', 'FILE_BLOCKED', 'FILE_SECURITY_CHECK_FAILED',
  // user / system final states
  'USER_CANCELED', 'USER_SHUTDOWN', 'FILE_FAILED', 'FILE_ACCESS_DENIED', 'FILE_NO_SPACE',
  'FILE_NAME_TOO_LONG', 'FILE_TOO_LARGE', 'NETWORK_INVALID_REQUEST',
];

test('DL-05 classifier: transient network-class reasons resume only when Chrome says canResume', () => {
  assert.equal(typeof classifyDownloadInterruption, 'function');
  for (const reason of TRANSIENT_REASONS) {
    assert.deepEqual(
      classifyDownloadInterruption(reason, true),
      { category: 'transient', reason, resumable: true },
      `${reason} + canResume must be resumable`,
    );
    const noResume = classifyDownloadInterruption(reason, false);
    assert.equal(noResume.category, 'transient', `${reason} stays transient without canResume`);
    assert.equal(noResume.resumable, false, `${reason} must not resume when canResume is false`);
    assert.equal(classifyDownloadInterruption(reason, undefined).resumable, false,
      `${reason} must not resume when canResume is unknown`);
  }
});

test('DL-05 classifier: identity/provenance/auth/policy errors never resume, unknown fails closed', () => {
  for (const reason of FATAL_REASONS) {
    const result = classifyDownloadInterruption(reason, true);
    assert.equal(result.category, 'fatal', `${reason} must be fatal`);
    assert.equal(result.resumable, false, `${reason} must never resume, even with canResume: true`);
  }
  for (const reason of ['SOME_FUTURE_REASON', '', undefined, null]) {
    const result = classifyDownloadInterruption(reason, true);
    assert.equal(result.category, 'fatal', `unknown reason ${String(reason)} must fail closed`);
    assert.equal(result.resumable, false);
  }
});

test('DL-05 classifier: the native waiter ships the same classifier and budget', () => {
  assert.equal(typeof nativeDownloads.classifyDownloadInterruption, 'function',
    'native-downloads.ts must export the mirrored classifier');
  assert.equal(nativeDownloads.FLOW_DOWNLOAD_RESUME_BUDGET, FLOW_DOWNLOAD_RESUME_BUDGET,
    'both waiters share one resume budget value');
  assert.ok(Number.isInteger(FLOW_DOWNLOAD_RESUME_BUDGET) && FLOW_DOWNLOAD_RESUME_BUDGET >= 1 && FLOW_DOWNLOAD_RESUME_BUDGET <= 5,
    'the local resume budget is small');
  for (const reason of [...TRANSIENT_REASONS, ...FATAL_REASONS, 'SOME_FUTURE_REASON', '']) {
    for (const canResume of [true, false, undefined]) {
      assert.deepEqual(
        nativeDownloads.classifyDownloadInterruption(reason, canResume),
        classifyDownloadInterruption(reason, canResume),
        `native and queue classifiers must agree on ${reason}/canResume=${String(canResume)}`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// (a) Transient interruption + canResume → resumed in place, wait resolves.
// ---------------------------------------------------------------------------

test('DL-05 (a): a transient interruption is resumed in place and the wait resolves on completion', async () => {
  const ticket = armTicket();
  const resumeCalls = [];
  const interrupted = flowItem({ state: 'interrupted', error: 'NETWORK_TIMEOUT', canResume: true });
  const search = scriptedSearch([
    [flowItem({ state: 'in_progress' })],
    [interrupted],
    [flowItem({ state: 'in_progress', bytesReceived: 80 })],
    [flowItem({ state: 'complete', filename: 'C:\\Downloads\\scene-01.png', bytesReceived: 100 })],
  ]);
  installChrome({
    search,
    resume: async id => { resumeCalls.push(id); },
  });
  try {
    const result = await waitForQueueFlowDownload(new Set(), 'scene one', 15_000, ticket, null);
    assert.deepEqual(resumeCalls, [7], 'exactly one resume call for the interrupted download id');
    assert.equal(result.id, 7);
    assert.equal(result.filename, 'C:\\Downloads\\scene-01.png');
    assert.equal(result.matchedByQueueTicket, true);
  } finally {
    disarmQueueFilenameOverride(ticket);
    uninstallChrome();
  }
});

test('DL-05 (a2): the existing-download waiter resumes and re-verifies identity after the resume', async () => {
  const resumeCalls = [];
  // After the resume, the item that comes back carries a foreign identity:
  // the waiter must refuse it with the identity-mismatch error instead of
  // completing on an unrelated file.
  const search = scriptedSearch([
    [flowItem({ state: 'in_progress' })],
    [flowItem({ state: 'interrupted', error: 'NETWORK_DISCONNECTED', canResume: true })],
    [flowItem({ state: 'in_progress', url: 'https://example.com/other-file', finalUrl: 'https://example.com/other-file', tabId: 9 })],
  ]);
  installChrome({
    search,
    resume: async id => { resumeCalls.push(id); },
  });
  try {
    await assert.rejects(
      waitForExistingQueueFlowDownload(7, MEDIA_ID, TAB_ID, '', 'scene one', 15_000, null),
      error => {
        assert.equal(error.code, 'FLOW_DOWNLOAD_IDENTITY_MISMATCH',
          'identity must be re-verified after a resume; a foreign file is never attached');
        return true;
      },
    );
    assert.deepEqual(resumeCalls, [7], 'the transient interruption was resumed before the identity check failed');
  } finally {
    uninstallChrome();
  }
});

test('DL-05 (a3): the existing-download waiter resolves after a resumed download completes', async () => {
  const resumeCalls = [];
  const search = scriptedSearch([
    [flowItem({ state: 'interrupted', error: 'NETWORK_FAILED', canResume: true })],
    [flowItem({ state: 'in_progress', bytesReceived: 90 })],
    [flowItem({ state: 'complete', filename: 'C:\\Downloads\\scene-01.png', bytesReceived: 100 })],
  ]);
  installChrome({
    search,
    resume: async id => { resumeCalls.push(id); },
  });
  try {
    const result = await waitForExistingQueueFlowDownload(7, MEDIA_ID, TAB_ID, '', 'scene one', 15_000, null);
    assert.deepEqual(resumeCalls, [7]);
    assert.equal(result.id, 7);
    assert.equal(result.matchedByQueueTicket, true);
  } finally {
    uninstallChrome();
  }
});

// ---------------------------------------------------------------------------
// (b) Non-transient interruption → immediate failure, zero resume calls.
// ---------------------------------------------------------------------------

test('DL-05 (b): a non-transient interruption fails immediately with no resume call', async () => {
  const ticket = armTicket();
  const resumeCalls = [];
  const search = scriptedSearch([
    [flowItem({ state: 'interrupted', error: 'FILE_NO_SPACE', canResume: true })],
  ]);
  installChrome({
    search,
    resume: async id => { resumeCalls.push(id); },
  });
  try {
    await assert.rejects(
      waitForQueueFlowDownload(new Set(), 'scene one', 15_000, ticket, null),
      error => {
        assert.equal(error.code, 'FLOW_DOWNLOAD_FAILED');
        assert.match(error.message, /FILE_NO_SPACE/);
        assert.equal(error.downloadInterruption?.category, 'fatal');
        assert.equal(error.downloadInterruption?.reason, 'FILE_NO_SPACE');
        assert.equal(error.downloadInterruption?.resumeAttempts, 0);
        return true;
      },
    );
    assert.deepEqual(resumeCalls, [], 'a fatal interruption must never be resumed');
  } finally {
    disarmQueueFilenameOverride(ticket);
    uninstallChrome();
  }
});

// ---------------------------------------------------------------------------
// (c) Identity/provenance-class interruptions never resume, even when the
// item claims canResume: true.
// ---------------------------------------------------------------------------

test('DL-05 (c): a provenance/integrity interruption never resumes even if flagged resumable', async () => {
  const ticket = armTicket();
  const resumeCalls = [];
  const search = scriptedSearch([
    [flowItem({ state: 'interrupted', error: 'FILE_HASH_MISMATCH', canResume: true })],
  ]);
  installChrome({
    search,
    resume: async id => { resumeCalls.push(id); },
  });
  try {
    await assert.rejects(
      waitForQueueFlowDownload(new Set(), 'scene one', 15_000, ticket, null),
      error => {
        assert.equal(error.code, 'FLOW_DOWNLOAD_FAILED');
        assert.equal(error.downloadInterruption?.category, 'fatal');
        assert.equal(error.downloadInterruption?.reason, 'FILE_HASH_MISMATCH');
        assert.equal(error.downloadInterruption?.resumable, false);
        return true;
      },
    );
    assert.deepEqual(resumeCalls, [], 'identity/provenance errors must never be resumed');
  } finally {
    disarmQueueFilenameOverride(ticket);
    uninstallChrome();
  }
});

test('DL-05 (c2): a transient interruption Chrome cannot resume (canResume false) fails without a resume call', async () => {
  const resumeCalls = [];
  const search = scriptedSearch([
    [flowItem({ state: 'interrupted', error: 'NETWORK_TIMEOUT', canResume: false })],
  ]);
  installChrome({
    search,
    resume: async id => { resumeCalls.push(id); },
  });
  try {
    await assert.rejects(
      waitForExistingQueueFlowDownload(7, MEDIA_ID, TAB_ID, '', 'scene one', 15_000, null),
      error => {
        assert.equal(error.code, 'FLOW_DOWNLOAD_FAILED');
        assert.equal(error.downloadInterruption?.category, 'transient');
        assert.equal(error.downloadInterruption?.resumable, false);
        return true;
      },
    );
    assert.deepEqual(resumeCalls, []);
  } finally {
    uninstallChrome();
  }
});

// ---------------------------------------------------------------------------
// (d) Budget exhaustion: exactly FLOW_DOWNLOAD_RESUME_BUDGET resumes, then
// the wait fails with the LAST interruption error.
// ---------------------------------------------------------------------------

test('DL-05 (d): resuming stops at the local budget and fails with the last error', async () => {
  const ticket = armTicket();
  const resumeCalls = [];
  let phase = 'interrupted';
  let lastError = 'NETWORK_FAILED';
  const search = async query => {
    if (query && 'id' in query) return [];
    if (query && 'query' in query) return [];
    if (phase === 'in_progress') {
      phase = 'interrupted';
      lastError = 'NETWORK_TIMEOUT';
      return [flowItem({ state: 'in_progress', bytesReceived: 60 })];
    }
    return [flowItem({ state: 'interrupted', error: lastError, canResume: true })];
  };
  installChrome({
    search,
    resume: async id => { resumeCalls.push(id); phase = 'in_progress'; },
  });
  try {
    await assert.rejects(
      waitForQueueFlowDownload(new Set(), 'scene one', 30_000, ticket, null),
      error => {
        assert.equal(error.code, 'FLOW_DOWNLOAD_FAILED');
        assert.match(error.message, /NETWORK_TIMEOUT/, 'the failure carries the LAST interruption error');
        assert.equal(error.downloadInterruption?.resumeAttempts, FLOW_DOWNLOAD_RESUME_BUDGET);
        assert.equal(error.downloadInterruption?.reason, 'NETWORK_TIMEOUT');
        return true;
      },
    );
    assert.equal(resumeCalls.length, FLOW_DOWNLOAD_RESUME_BUDGET,
      'exactly the budgeted number of resumes were attempted');
    assert.ok(resumeCalls.every(id => id === 7));
  } finally {
    disarmQueueFilenameOverride(ticket);
    uninstallChrome();
  }
});
