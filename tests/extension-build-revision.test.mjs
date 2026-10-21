import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fingerprintExtension, writeExtensionBuildRevision } from '../scripts/extension-build-revision.mjs';

test('generated extension marker is excluded from its deterministic revision', async () => {
  const root = await mkdtemp(join(tmpdir(), 'flow-extension-revision-'));
  try {
    await mkdir(join(root, 'nested'));
    await mkdir(join(root, '_metadata'));
    await writeFile(join(root, 'nested', 'driver.js'), 'globalThis.driver = true;\n');
    await writeFile(join(root, '_metadata', 'ignored.json'), 'ignored');
    await writeFile(join(root, 'build-revision.js'), 'stale marker');

    const revision = await fingerprintExtension(root);
    assert.match(revision, /^[a-f0-9]{64}$/);
    assert.equal(await writeExtensionBuildRevision(root), revision);
    assert.match(await readFile(join(root, 'build-revision.js'), 'utf8'), new RegExp(revision));
    assert.equal(await fingerprintExtension(root), revision, 'writing the marker must not change its own revision');
    assert.equal(await fingerprintExtension(root), revision, 'unchanged extension files must have a stable revision');

    await writeFile(join(root, 'nested', 'driver.js'), 'globalThis.driver = false;\n');
    const changed = await fingerprintExtension(root);
    assert.notEqual(changed, revision);
    assert.equal(await writeExtensionBuildRevision(root), changed);
    assert.equal(await fingerprintExtension(root), changed);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
