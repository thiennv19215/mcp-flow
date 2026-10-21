import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inspectExtensionBuild } from '../extension/src/background/flow-build-info.js';

const current = 'a'.repeat(64);
const previous = 'b'.repeat(64);

function runtimeHarness({ contentRevision = current, watcherRevision = current, contentError, watcherError } = {}) {
  const scripting = {
    async executeScript(details) {
      assert.equal(details.target.tabId, 42);
      assert.equal(details.world, 'ISOLATED');
      if (contentError) throw contentError;
      return [{ result: contentRevision }];
    },
  };
  const fetchImpl = async url => {
    assert.equal(url, 'http://127.0.0.1:18898/status');
    if (watcherError) throw watcherError;
    return { ok: true, json: async () => ({ revision: watcherRevision }) };
  };
  return { scripting, fetchImpl };
}

test('runtime build diagnostic confirms background, content and watcher revisions match', async () => {
  const harness = runtimeHarness();
  const result = await inspectExtensionBuild(42, { ...harness, backgroundRevision: current });
  assert.deepEqual(result, {
    status: 'current',
    matchesWatcher: true,
    backgroundRevision: current,
    contentRevision: current,
    watcherRevision: current,
  });
});

test('runtime build diagnostic uses exact buildRevision when watcher revision is a reload signal', async () => {
  const harness = runtimeHarness({
    fetchImpl: undefined,
  });
  harness.fetchImpl = async url => {
    assert.equal(url, 'http://127.0.0.1:18898/status');
    return { ok: true, json: async () => ({ revision: previous, buildRevision: current, reloadEpoch: 4 }) };
  };
  const result = await inspectExtensionBuild(42, { ...harness, backgroundRevision: current });
  assert.equal(result.status, 'current');
  assert.equal(result.watcherRevision, current);
});

test('runtime build diagnostic reports a stale content script', async () => {
  const harness = runtimeHarness({ contentRevision: previous });
  const result = await inspectExtensionBuild(42, { ...harness, backgroundRevision: current });
  assert.equal(result.status, 'mismatch');
  assert.equal(result.matchesWatcher, false);
  assert.equal(result.contentRevision, previous);
});

test('runtime build diagnostic fails closed when watcher or content revision is unavailable', async () => {
  const harness = runtimeHarness({ contentError: new Error('no content world'), watcherError: new Error('watcher offline') });
  const result = await inspectExtensionBuild(42, { ...harness, backgroundRevision: current });
  assert.deepEqual(result, {
    status: 'unavailable',
    matchesWatcher: false,
    backgroundRevision: current,
    contentRevision: null,
    watcherRevision: null,
  });
});

test('observer health wires the build probe and manifest loads its marker before Flow content', () => {
  const worker = readFileSync(new URL('../extension/src/background/service-worker.js', import.meta.url), 'utf8');
  const manifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  const contentScripts = manifest.content_scripts.find(entry => entry.world !== 'MAIN');
  assert.match(worker, /const extensionBuild = await inspectExtensionBuild\(tabId\)/);
  assert.match(worker, /return \{ \.\.\.health, extensionBuild \}/);
  assert.equal(contentScripts.js[0], 'build-revision.js');
});
