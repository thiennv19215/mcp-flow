import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

// DL-10 — Already-clean fingerprint registry (background half).
// Study W6 keeps the fingerprint set in two places: a fingerprint map
// in the network interceptor (where the check + record both live) and
// a recent-cleaned hash set in the background. The download relay is
// the background module that already owns SHA-256 (per-chunk digests),
// so it hosts the background registry primitives with identical
// semantics: fingerprint = SHA-256(bytes ‖ mime), bounded set,
// oldest-first eviction, explicit record only.

const relay = await import('../extension/src/background/flow-download-relay.js');

test('DL-10 (relay): fingerprintMediaBytes is SHA-256 of bytes concatenated with the mime', async () => {
  assert.equal(typeof relay.fingerprintMediaBytes, 'function', 'the relay exports the fingerprint helper');
  const bytes = new TextEncoder().encode('cleaned-image-bytes');
  const expected = createHash('sha256')
    .update(bytes)
    .update(new TextEncoder().encode('image/png'))
    .digest('hex');
  assert.equal(await relay.fingerprintMediaBytes(bytes, 'image/png'), expected);
  assert.equal(await relay.fingerprintMediaBytes(bytes, 'image/png'), expected, 'the fingerprint is deterministic');
  assert.notEqual(await relay.fingerprintMediaBytes(bytes, 'image/jpeg'), expected, 'the mime participates in the fingerprint');
  assert.notEqual(await relay.fingerprintMediaBytes(new TextEncoder().encode('other-bytes'), 'image/png'), expected, 'the bytes participate in the fingerprint');
});

test('DL-10 (relay): the registry records explicitly, hits on recorded fingerprints, and evicts oldest-first at its cap', () => {
  assert.equal(typeof relay.createCleanedFingerprintRegistry, 'function', 'the relay exports the registry factory');
  assert.equal(relay.MAX_CLEANED_FINGERPRINTS, 64, 'the background cap matches the interceptor cap');
  const registry = relay.createCleanedFingerprintRegistry(3);
  assert.equal(registry.has('a'), false);
  registry.record('a');
  registry.record('b');
  registry.record('a');
  assert.equal(registry.size, 2, 're-recording the same fingerprint does not duplicate it');
  assert.equal(registry.has('a'), true);
  registry.record('c');
  registry.record('d');
  assert.equal(registry.size, 3, 'the registry stays within its cap');
  assert.equal(registry.has('a'), false, 'the oldest fingerprint is evicted first');
  assert.equal(registry.has('b'), true);
  assert.equal(registry.has('d'), true);
  registry.clear();
  assert.equal(registry.size, 0);
  assert.equal(registry.has('d'), false);
});

test('DL-10 (relay): the default registry uses the named cap', () => {
  const registry = relay.createCleanedFingerprintRegistry();
  for (let i = 0; i < relay.MAX_CLEANED_FINGERPRINTS + 5; i++) registry.record(`fp-${i}`);
  assert.equal(registry.size, relay.MAX_CLEANED_FINGERPRINTS);
  assert.equal(registry.has('fp-0'), false, 'the oldest entries are evicted');
  assert.equal(registry.has(`fp-${relay.MAX_CLEANED_FINGERPRINTS + 4}`), true, 'the newest entry is kept');
});
