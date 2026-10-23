import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

// GPT-03 — ChatGPT ref resolution contract (uploaded refs only).
// Reference images for the ChatGPT provider are uploaded payloads, never
// library references: the gate accepts only records that already carry a
// base64/bytes payload and builds the ref payload list from those alone.
// Bare library/tile/media IDs (or URLs without a payload) are dropped with a
// per-item rejection marker — they are NEVER resolved against any library —
// and the accepted list is capped at maxRefImages (a parameter supplied by
// the capability registry, GPT-01).

const source = readFileSync(
  new URL('../extension/src/content/providers/chatgpt/core/ref-resolution.js', import.meta.url),
  'utf8',
);

// Values built inside the vm realm carry its prototypes; normalize through
// JSON before deep comparison (the repo's convention for vm-loaded modules).
const plain = value => JSON.parse(JSON.stringify(value));

function loadModule() {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox.ChatGptRefResolution;
}

const b64 = bytes => Buffer.from(bytes).toString('base64');
const PNG_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_BYTES = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10];

function payloadRecord(overrides = {}) {
  return {
    fileId: 'staged-1',
    base64: b64(PNG_BYTES),
    name: 'ref-1.png',
    type: 'image/png',
    ...overrides,
  };
}

test('base64-carrying records pass through in order, normalized to the payload shape', () => {
  const { resolveRefs } = loadModule();
  const records = [
    payloadRecord({ fileId: 'staged-a', base64: b64([1, 2, 3]), name: 'a.png' }),
    payloadRecord({ fileId: 'staged-b', base64: b64([4, 5, 6]), name: 'b.png', type: 'image/jpeg' }),
    // transfer-style id is carried through as the payload's own fileId
    { transferId: 'transfer-9', base64: b64([7, 8, 9]), name: 'c.png', type: 'image/png' },
  ];
  const result = plain(resolveRefs(records, { maxRefImages: 10 }));
  assert.equal(result.capped, false);
  assert.deepEqual(result.rejected, []);
  assert.deepEqual(
    result.refs.map(ref => ref.base64),
    [b64([1, 2, 3]), b64([4, 5, 6]), b64([7, 8, 9])],
    'payload order is the input order',
  );
  assert.deepEqual(result.refs[0], {
    fileId: 'staged-a', base64: b64([1, 2, 3]), name: 'a.png', type: 'image/png',
  });
  assert.equal(result.refs[1].type, 'image/jpeg');
  assert.equal(result.refs[2].fileId, 'transfer-9');
});

test('ID-only inputs yield an empty list plus per-item rejection markers', () => {
  const { resolveRefs, REJECTION_REASONS } = loadModule();
  const records = [
    { id: 'library-item-1' },
    { mediaId: '11111111-1111-4111-8111-111111111111' },
    { tileId: 'tile-42' },
    { url: 'https://flow.google.com/asb/some-tile' },
    'bare-tile-id',
    'https://cdn.example.com/image.png',
  ];
  const result = plain(resolveRefs(records, { maxRefImages: 4 }));
  assert.deepEqual(result.refs, []);
  assert.equal(result.capped, false);
  assert.equal(result.rejected.length, records.length, 'every dropped input is reported');
  assert.deepEqual(result.rejected.map(entry => entry.index), [0, 1, 2, 3, 4, 5]);
  for (const entry of result.rejected.slice(0, 4)) {
    assert.equal(entry.reason, REJECTION_REASONS.MISSING_PAYLOAD, 'ID-only objects carry no payload');
  }
  assert.equal(result.rejected[4].reason, REJECTION_REASONS.BARE_REFERENCE);
  assert.equal(result.rejected[5].reason, REJECTION_REASONS.BARE_REFERENCE);
});

test('5 refs with cap 3 → first 3 pass, capped flag set, excess reported as over_cap', () => {
  const { resolveRefs, REJECTION_REASONS } = loadModule();
  const records = [0, 1, 2, 3, 4].map(i => payloadRecord({
    fileId: `staged-${i}`, base64: b64([i + 1]), name: `ref-${i}.png`,
  }));
  const result = plain(resolveRefs(records, { maxRefImages: 3 }));
  assert.equal(result.refs.length, 3);
  assert.deepEqual(result.refs.map(ref => ref.fileId), ['staged-0', 'staged-1', 'staged-2'], 'first-N wins');
  assert.equal(result.capped, true);
  assert.deepEqual(
    result.rejected.map(entry => [entry.index, entry.reason]),
    [[3, REJECTION_REASONS.OVER_CAP], [4, REJECTION_REASONS.OVER_CAP]],
  );
});

test('mixed input keeps payload order and reports each rejection with its reason', () => {
  const { resolveRefs, REJECTION_REASONS } = loadModule();
  const records = [
    payloadRecord({ fileId: 'keep-1', base64: b64([10]) }),
    { id: 'library-only' },
    payloadRecord({ fileId: 'keep-2', base64: b64([20]) }),
    null,
    payloadRecord({ fileId: 'keep-3', base64: b64([30]) }),
    'bare-id',
    payloadRecord({ fileId: 'dropped-by-cap', base64: b64([40]) }),
  ];
  const result = plain(resolveRefs(records, { maxRefImages: 3 }));
  assert.deepEqual(result.refs.map(ref => ref.fileId), ['keep-1', 'keep-2', 'keep-3']);
  assert.equal(result.capped, true);
  assert.deepEqual(
    result.rejected.map(entry => [entry.index, entry.reason]),
    [
      [1, REJECTION_REASONS.MISSING_PAYLOAD],
      [3, REJECTION_REASONS.MALFORMED_RECORD],
      [5, REJECTION_REASONS.BARE_REFERENCE],
      [6, REJECTION_REASONS.OVER_CAP],
    ],
  );
});

test('bytes and data-url payloads are normalized to raw base64', () => {
  const { resolveRefs } = loadModule();
  const records = [
    { fileId: 'bytes-1', bytes: new Uint8Array(PNG_BYTES), name: 'from-bytes.png', type: 'image/png' },
    { fileId: 'bytes-2', bytes: [0xff, 0xd8, 0xff], name: 'array-bytes.jpg', type: 'image/jpeg' },
    { fileId: 'url-1', dataUrl: `data:image/jpeg;base64,${b64(JPEG_BYTES)}`, name: 'from-url.jpg' },
    { fileId: 'url-2', base64: `data:image/png;base64,${b64(PNG_BYTES)}`, name: 'data-url-in-base64.png' },
  ];
  const result = plain(resolveRefs(records, { maxRefImages: 8 }));
  assert.deepEqual(result.rejected, []);
  assert.equal(result.refs[0].base64, b64(PNG_BYTES));
  assert.equal(result.refs[1].base64, b64([0xff, 0xd8, 0xff]));
  assert.equal(result.refs[2].base64, b64(JPEG_BYTES), 'data-url payload is extracted');
  assert.equal(result.refs[2].type, 'image/jpeg', 'type derives from the data url when absent');
  assert.equal(result.refs[3].base64, b64(PNG_BYTES), 'a data url in the base64 field is stripped to raw base64');
  assert.equal(result.refs[3].type, 'image/png');
});

test('malformed records are dropped with reasons and never throw', () => {
  const { resolveRefs, REJECTION_REASONS } = loadModule();
  const records = [
    null,
    undefined,
    42,
    true,
    [],
    {},
    { base64: '' },
    { base64: '!!!not-base64!!!' },
    { base64: 12345 },
    { bytes: 'not-bytes' },
    { bytes: [] },
    { bytes: [1, 300, -1] },
    { dataUrl: 'data:text/plain,hello' },
    { dataUrl: 'not-a-data-url' },
  ];
  let result;
  assert.doesNotThrow(() => { result = resolveRefs(records, { maxRefImages: 4 }); });
  result = plain(result);
  assert.deepEqual(result.refs, []);
  assert.equal(result.rejected.length, records.length);
  const reasons = result.rejected.map(entry => entry.reason);
  assert.equal(reasons[0], REJECTION_REASONS.MALFORMED_RECORD);
  assert.equal(reasons[1], REJECTION_REASONS.MALFORMED_RECORD);
  assert.equal(reasons[2], REJECTION_REASONS.BARE_REFERENCE);
  assert.equal(reasons[3], REJECTION_REASONS.BARE_REFERENCE);
  assert.equal(reasons[4], REJECTION_REASONS.MALFORMED_RECORD);
  assert.equal(reasons[5], REJECTION_REASONS.MISSING_PAYLOAD);
  for (const reason of reasons.slice(6)) {
    assert.equal(reason, REJECTION_REASONS.INVALID_PAYLOAD);
  }
});

test('cap parameter: absent cap accepts every payload; cap 0 caps everything', () => {
  const { resolveRefs, REJECTION_REASONS } = loadModule();
  const records = [0, 1, 2].map(i => payloadRecord({ fileId: `s-${i}`, base64: b64([i + 1]) }));

  const uncapped = plain(resolveRefs(records));
  assert.equal(uncapped.refs.length, 3);
  assert.equal(uncapped.capped, false);

  const zero = plain(resolveRefs(records, { maxRefImages: 0 }));
  assert.deepEqual(zero.refs, []);
  assert.equal(zero.capped, true);
  assert.ok(zero.rejected.every(entry => entry.reason === REJECTION_REASONS.OVER_CAP));

  assert.deepEqual(plain(resolveRefs([], { maxRefImages: 3 })), { refs: [], rejected: [], capped: false });
  assert.deepEqual(plain(resolveRefs(undefined, { maxRefImages: 3 })), { refs: [], rejected: [], capped: false });
});

test('a record with a payload is accepted even when it also carries an id field', () => {
  const { resolveRefs } = loadModule();
  // The gate keys on payload presence, not on the absence of id-shaped
  // fields: a staged record's own id is metadata, the payload is the ref.
  const result = plain(resolveRefs([
    { id: 'staged-own-id', base64: b64([9, 9]), name: 'x.png', type: 'image/png' },
  ], { maxRefImages: 2 }));
  assert.equal(result.refs.length, 1);
  assert.equal(result.refs[0].fileId, 'staged-own-id');
  assert.deepEqual(result.rejected, []);
});
