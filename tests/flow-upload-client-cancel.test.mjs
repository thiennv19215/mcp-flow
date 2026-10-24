import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { Blob as NodeBlob } from 'node:buffer';

// IMG-09 (part 2, sidebar side) — FlowUploadClient mints a stable upload
// request id where the transfer is created, reports it via onRequestId,
// and threads it through the transfer record (begin metadata), the
// finish payload and the flow.media.upload command payload, so one
// specific in-flight upload is addressable end to end. The client also
// honors an AbortSignal: aborting stops the chunk stream, cleans up the
// staged transfer via flow.file.upload.abort, and — while the in-page
// upload command is running — stops waiting for it instead of riding it
// to completion. A second upload under a different id is unaffected.

const uploadClientSource = readFileSync(
  new URL('../extension/src/ui/flow-upload-client.js', import.meta.url),
  'utf8',
);
const sidebarSource = readFileSync(
  new URL('../extension/src/ui/sidebar.js', import.meta.url),
  'utf8',
);

function clientHarness({ hangMediaUploadFor = null, mediaUploadValue = null } = {}) {
  const sent = [];
  const context = vm.createContext({
    window: {},
    Blob: NodeBlob,
    btoa: value => Buffer.from(value, 'binary').toString('base64'),
    crypto: webcrypto,
    chrome: {
      runtime: {
        sendMessage: async message => {
          sent.push(message);
          const { operation, payload } = message;
          if (operation === 'flow.file.upload.begin') return { ok: true, value: { transferId: payload.transfer.transferId, ready: true } };
          if (operation === 'flow.file.upload.chunk') {
            harness.onChunk?.(payload.chunk);
            return { ok: true, value: { nextIndex: payload.chunk.index + 1 } };
          }
          if (operation === 'flow.file.upload.finish') return { ok: true, value: { transferId: payload.transferId, staged: true } };
          if (operation === 'flow.file.upload.abort') return { ok: true, value: { transferId: payload.transferId, aborted: true } };
          if (operation === 'flow.media.upload') {
            harness.onMediaUpload?.(payload);
            if (hangMediaUploadFor && payload.requestId === hangMediaUploadFor()) {
              return new Promise(() => {});
            }
            if (mediaUploadValue) {
              return { ok: true, value: typeof mediaUploadValue === 'function' ? mediaUploadValue(payload) : mediaUploadValue };
            }
            return { ok: true, value: { name: payload.name, id: 'media-xyz' } };
          }
          return { ok: true, value: {} };
        },
      },
    },
  });
  const harness = { context, sent, onChunk: null, onMediaUpload: null };
  vm.runInContext(uploadClientSource, context);
  harness.client = context.window.FlowUploadClient;
  return harness;
}

// FlowUploadClient only requires a Blob (it reads arrayBuffer/type);
// the display name is supplied via options.name in these tests.
function makeFile(fill, size) {
  return new NodeBlob([new Uint8Array(size).fill(fill)], { type: 'image/png' });
}

test('IMG-09 client: a stable upload request id is minted at transfer creation and threaded through every dispatch', async () => {
  const harness = clientHarness();
  const seen = [];
  const result = await harness.client.upload(makeFile(0x41, 128), {
    kind: 'image',
    name: 'ref.png',
    onRequestId: (requestId, transferId) => seen.push([requestId, transferId]),
  });
  assert.ok(result.requestId, 'the result carries the upload request id');
  assert.ok(result.transferId, 'the result carries the transfer id');
  assert.equal(result.requestId, `upload-${result.transferId}`, 'the request id is derived from the transfer id it was minted with');
  assert.deepEqual(seen, [[result.requestId, result.transferId]], 'onRequestId reported the ids once, before dispatching');

  const begin = harness.sent.find(m => m.operation === 'flow.file.upload.begin');
  assert.equal(begin.payload.transfer.requestId, result.requestId, 'the transfer record carries the request id');
  assert.equal(begin.payload.transfer.transferId, result.transferId);
  const finish = harness.sent.find(m => m.operation === 'flow.file.upload.finish');
  assert.equal(finish.payload.requestId, result.requestId);
  const mediaUpload = harness.sent.find(m => m.operation === 'flow.media.upload');
  assert.equal(mediaUpload.payload.requestId, result.requestId, 'the upload command payload carries the request id');
  assert.equal(mediaUpload.payload.transferId, result.transferId);
  assert.equal(result.id, 'media-xyz');
});

test('IMG-09 client: aborting during chunk streaming stops the stream and cleans up the staged transfer', async () => {
  const harness = clientHarness();
  const controller = new AbortController();
  harness.onChunk = chunk => {
    if (chunk.index === 0) queueMicrotask(() => controller.abort());
  };
  // 300 KB → two 256 KB chunks; the abort lands after chunk 0.
  let caught;
  try {
    await harness.client.upload(makeFile(0x42, 300 * 1024), {
      kind: 'image',
      name: 'big.png',
      signal: controller.signal,
    });
  } catch (error) { caught = error; }
  assert.ok(caught, 'the upload must reject once aborted');
  assert.equal(caught.code, 'FLOW_UPLOAD_CANCELLED', String(caught?.stack || caught));
  const chunkIndices = harness.sent.filter(m => m.operation === 'flow.file.upload.chunk').map(m => m.payload.chunk.index);
  assert.deepEqual(chunkIndices, [0], 'no further chunks were sent after the abort');
  assert.equal(harness.sent.some(m => m.operation === 'flow.media.upload'), false, 'the in-page upload was never dispatched');
  const cleanup = harness.sent.find(m => m.operation === 'flow.file.upload.abort');
  assert.ok(cleanup, 'the staged transfer was cleaned up');
  assert.equal(cleanup.payload.transferId, harness.sent.find(m => m.operation === 'flow.file.upload.begin').payload.transfer.transferId);
});

test('IMG-09 client: aborting while the in-page upload runs stops waiting for it; a second upload is unaffected', async () => {
  let firstRequestId = null;
  const harness = clientHarness({ hangMediaUploadFor: () => firstRequestId });
  const controller = new AbortController();
  let mediaUploadSeen;
  const mediaUploadSeenPromise = new Promise(resolve => { mediaUploadSeen = resolve; });
  harness.onMediaUpload = payload => { if (payload.requestId === firstRequestId) mediaUploadSeen(); };

  const first = harness.client.upload(makeFile(0x43, 64), {
    kind: 'image',
    name: 'first.png',
    signal: controller.signal,
    onRequestId: requestId => { firstRequestId = requestId; },
  });
  const firstOutcome = first.then(
    () => ({ resolved: true }),
    error => ({ error }),
  );
  const second = harness.client.upload(makeFile(0x44, 64), { kind: 'image', name: 'second.png' });

  const seen = await Promise.race([
    mediaUploadSeenPromise.then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), 3_000)),
  ]);
  assert.equal(seen, true, 'the first upload reached the in-page upload dispatch under its request id');
  controller.abort();

  const firstResult = await Promise.race([
    firstOutcome,
    new Promise(resolve => setTimeout(() => resolve({ timeout: true }), 5_000)),
  ]);
  assert.equal(firstResult.timeout, undefined, 'the aborted upload stopped waiting promptly');
  assert.ok(firstResult.error, 'the aborted upload rejected');
  assert.equal(firstResult.error.code, 'FLOW_UPLOAD_CANCELLED', String(firstResult.error?.stack || firstResult.error));

  const secondResult = await second;
  assert.ok(secondResult.requestId, 'the second upload completed with its own request id');
  assert.notEqual(secondResult.requestId, firstRequestId, 'each upload carries a distinct request id');
  assert.equal(secondResult.id, 'media-xyz');
});

test('IMG-09 sidebar contract: in-flight uploads are tracked with per-upload cancel buttons wired to their controllers', () => {
  assert.match(sidebarSource, /const inFlightUploads = new (?:Map|Set)\(/,
    'the sidebar keeps a registry of in-flight uploads');
  assert.match(sidebarSource, /async function uploadWithCancel\(/,
    'sidebar uploads go through one cancellable helper');
  assert.match(sidebarSource, /new AbortController\(\)/,
    'each tracked upload owns an AbortController');
  assert.match(sidebarSource, /signal: controller\.signal/,
    'the controller signal is passed to FlowUploadClient.upload');
  assert.match(sidebarSource, /onRequestId/,
    'the sidebar records the client-minted upload request id');
  assert.match(sidebarSource, /createElement\("button"\)/,
    'a cancel button element is created per in-flight upload');
  assert.match(sidebarSource, /entry\.controller\.abort\(\)/,
    'the cancel button aborts exactly its own upload controller');
  assert.match(sidebarSource, /#uploadCancelBar|uploadCancelBar/,
    'the cancel buttons render into a dedicated bar');
  const helperUses = sidebarSource.match(/uploadWithCancel\(/g) || [];
  assert.ok(helperUses.length >= 3, 'the helper is defined once and used by both the reference-upload path and the media-upload button');
});

// Upload identity (livefix/upload-identity) — the content-side uploader
// dispatches the staged file to Flow under a digest-derived uploadName, so
// the new tile carries THAT name, not the client's safeName; the receipt
// also carries the canonical mediaUuid when the raw id is an asb: handle.
// FlowUploadClient must surface both fields, and the sidebar must build
// generation attachments from them — an attachment naming the safeName
// matches no tile the picker can see (the live "selecting asset" hang).

test('upload identity client: uploadName and mediaUuid from the media upload receipt survive to the caller', async () => {
  const mediaUuid = '123e4567-e89b-12d3-a456-426614174000';
  const uploadName = '9f2c1ab4d6e847f5a0c3b2d1e4f50607.png';
  const harness = clientHarness({
    mediaUploadValue: payload => ({ name: payload.name, id: 'asb:media-xyz', mediaUuid, uploadName }),
  });
  const result = await harness.client.upload(makeFile(0x51, 64), { kind: 'image', name: 'photo.png' });
  assert.equal(result.uploadName, uploadName, 'the tile-carried upload name is preserved');
  assert.equal(result.mediaUuid, mediaUuid, 'the canonical media UUID is preserved');
  assert.equal(result.id, 'asb:media-xyz', 'id keeps its previous receipt semantics');
  assert.match(result.name, /^upload-image-photo-/, 'name still reports the client safe dispatch name');
  assert.equal(String(result), result.name, 'toString still yields the safe name');
  assert.ok(result.requestId && result.transferId, 'request/transfer ids are unchanged');
});

test('upload identity client: mediaUuid falls back to the nested receipt; absent identity fields stay null', async () => {
  const mediaUuid = '223e4567-e89b-12d3-a456-426614174001';
  const nested = clientHarness({
    mediaUploadValue: payload => ({ name: payload.name, id: 'asb:media-abc', receipt: { id: 'asb:media-abc', mediaUuid } }),
  });
  const nestedResult = await nested.client.upload(makeFile(0x52, 64), { kind: 'image', name: 'nested.png' });
  assert.equal(nestedResult.mediaUuid, mediaUuid, 'mediaUuid is read from the nested receipt when not top-level');
  assert.equal(nestedResult.uploadName, null, 'a missing uploadName stays null so callers fall back to name');

  const plain = clientHarness();
  const plainResult = await plain.client.upload(makeFile(0x53, 64), { kind: 'image', name: 'plain.png' });
  assert.equal(plainResult.uploadName, null, 'no uploadName in the receipt → null (legacy behaviour)');
  assert.equal(plainResult.mediaUuid, null, 'no mediaUuid in the receipt → null (legacy behaviour)');
  assert.equal(plainResult.id, 'media-xyz', 'the legacy receipt fields still flow through');
});

function extractUploadedAssetAttachment() {
  const match = sidebarSource.match(/function uploadedAssetAttachment\(uploaded\) \{[\s\S]*?\n  \}/);
  assert.ok(match, 'the sidebar defines one shared uploadedAssetAttachment helper');
  const context = vm.createContext({});
  vm.runInContext(`${match[0]}\nthis.__fn = uploadedAssetAttachment;`, context);
  return context.__fn;
}

test('upload identity sidebar: the shared helper builds attachments from uploadName + mediaUuid', () => {
  const build = extractUploadedAssetAttachment();
  const mediaUuid = '123e4567-e89b-12d3-a456-426614174000';
  const full = build({ name: 'ref-01-photo-deadbeef.png', uploadName: 'tile-name.png', mediaUuid, id: 'asb:media-xyz' });
  assert.equal(full.assetName, 'asset:tile-name.png', 'the attachment names the tile-carried uploadName');
  assert.equal(full.expectedId, mediaUuid, 'expectedId prefers the canonical mediaUuid over the asb: id');
  assert.deepEqual(Object.keys(full).sort(), ['assetName', 'expectedId']);

  const legacy = build({ name: 'ref-01-photo-deadbeef.png', id: 'asb:media-xyz' });
  assert.equal(legacy.assetName, 'asset:ref-01-photo-deadbeef.png', 'without uploadName the safe name is used as before');
  assert.equal(legacy.expectedId, 'asb:media-xyz', 'without mediaUuid the receipt id is used as before');

  const noId = build({ name: 'ref-01-photo-deadbeef.png' });
  assert.equal(noId.assetName, 'asset:ref-01-photo-deadbeef.png');
  assert.equal('expectedId' in noId, false, 'expectedId is omitted entirely when no id exists');

  const stringResult = build('ref-01-photo-deadbeef.png');
  assert.equal(stringResult.assetName, 'asset:ref-01-photo-deadbeef.png', 'a bare string upload result still works');
  assert.equal('expectedId' in stringResult, false);
});

test('upload identity sidebar: all three upload call sites route through the shared helper', () => {
  const mentions = sidebarSource.match(/uploadedAssetAttachment\(uploaded\)/g) || [];
  assert.equal(mentions.length, 4, 'one definition plus the image-submit, video-reference and video-frame call sites');
  assert.doesNotMatch(sidebarSource, /asset:\$\{uploadedName\}/,
    'no call site builds an attachment from the bare safe name anymore');
  assert.doesNotMatch(sidebarSource, /uploaded\?\.id \|\| uploaded\?\.mediaId/,
    'no call site resolves the expected id without preferring mediaUuid');
});
