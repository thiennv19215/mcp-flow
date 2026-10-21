import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDevExtensionServer, DEV_RELOAD_HEADER, DEV_RELOAD_HOST } from '../scripts/dev-extension-server.mjs';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'flow-dev-reload-'));
  const extensionDir = join(root, 'extension');
  const epochFile = join(root, '.reload-epoch');
  await mkdir(extensionDir);
  await writeFile(join(extensionDir, 'extension.js'), 'globalThis.revision = 1;\n');
  const app = await createDevExtensionServer({ extensionDir, epochFile });
  const address = await app.listen();
  return {
    root, extensionDir, epochFile, app,
    baseUrl: `http://${DEV_RELOAD_HOST}:${address.port}`,
    async dispose() { await app.close(); await rm(root, { recursive: true, force: true }); },
  };
}

test('dev reload server binds loopback and exposes only status plus guarded POST trigger', async () => {
  const f = await fixture();
  try {
    assert.equal(f.app.server.address().address, '127.0.0.1');
    const statusResponse = await fetch(`${f.baseUrl}/status`);
    assert.equal(statusResponse.status, 200);
    const initial = await statusResponse.json();
    assert.equal(initial.reloadEpoch, 0);
    assert.match(initial.revision, /^[a-f0-9]{64}$/);
    assert.match(initial.buildRevision, /^[a-f0-9]{64}$/);
    assert.equal(initial.reloadKey, initial.revision);
    assert.notEqual(initial.revision, initial.buildRevision, 'revision includes the reload epoch so old workers detect it');

    assert.equal((await fetch(`${f.baseUrl}/reload`)).status, 404);
    assert.equal((await fetch(`${f.baseUrl}/status`, { method: 'POST' })).status, 404);
    assert.equal((await fetch(`${f.baseUrl}/reload`, { method: 'POST' })).status, 403);
    assert.equal((await fetch(`${f.baseUrl}/reload`, {
      method: 'POST', headers: { Origin: 'https://example.com', [DEV_RELOAD_HEADER]: '1' },
    })).status, 403);
    assert.equal((await fetch(`${f.baseUrl}/reload`, {
      method: 'OPTIONS', headers: {
        Origin: 'https://example.com',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': DEV_RELOAD_HEADER,
      },
    })).status, 403);

    const trigger = await fetch(`${f.baseUrl}/reload`, {
      method: 'POST', headers: { [DEV_RELOAD_HEADER]: '1' },
    });
    assert.equal(trigger.status, 202);
    const triggered = await trigger.json();
    assert.equal(triggered.accepted, true);
    assert.equal(triggered.reloadEpoch, 1);
    assert.notEqual(triggered.revision, initial.revision, 'legacy workers polling revision detect the trigger');
    assert.equal(triggered.buildRevision, initial.buildRevision, 'buildRevision remains the exact extension file fingerprint');
    assert.equal(triggered.reloadKey, triggered.revision);
    assert.deepEqual(await readFile(f.epochFile, 'utf8'), '1\n');
    assert.deepEqual(await (await fetch(`${f.baseUrl}/status`)).json(), {
      revision: triggered.revision,
      buildRevision: triggered.buildRevision,
      reloadEpoch: triggered.reloadEpoch,
      reloadKey: triggered.reloadKey,
    });
  } finally {
    await f.dispose();
  }
});

test('reload epoch persists and stable status does not retrigger after worker adopts revision', async () => {
  const f = await fixture();
  let second;
  try {
    const firstTrigger = await fetch(`${f.baseUrl}/reload`, {
      method: 'POST', headers: { [DEV_RELOAD_HEADER]: '1' },
    });
    const adoptedRevision = (await firstTrigger.json()).revision;
    await f.app.close();

    second = await createDevExtensionServer({ extensionDir: f.extensionDir, epochFile: f.epochFile });
    const address = await second.listen();
    assert.equal(address.address, '127.0.0.1');
    const status = await (await fetch(`http://${DEV_RELOAD_HOST}:${address.port}/status`)).json();
    assert.equal(status.reloadEpoch, 1);
    assert.equal(status.reloadKey, adoptedRevision, 'after worker stores this reload key before runtime.reload, the next check sees equality');
    assert.equal((await second.refreshFiles()), false, 'unchanged files and persisted epoch do not cause a second reload');
  } finally {
    await second?.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
