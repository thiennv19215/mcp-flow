import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

// DL-02 — Video watermark removal (page-context frame pipeline).
// Phase 0 (study-download-watermark G2 / W10, W11): videos are cleaned
// frame-wise in a PAGE context (never the service worker): decode, sample
// ~12 frames to find the logo anchor via the image pipeline, process every
// frame with re-detection on verification drop, copy audio packets through
// untouched, re-encode near source bitrate; 300 MB input cap; progress +
// cancel. The codec layer sits behind an injected adapter so these tests
// drive the pipeline with synthetic frames and a fake codec in Node — the
// PIPELINE LOGIC is what is proven here, not any real WebCodecs stack.

const removerSource = readFileSync(new URL('../extension/src/content/bridge/WatermarkRemover.js', import.meta.url), 'utf8');
const cleanerSource = readFileSync(new URL('../extension/src/content/bridge/video-watermark-cleaner.js', import.meta.url), 'utf8');
const watermarkConfigSource = readFileSync(new URL('../extension/src/content/bridge/watermark-config.js', import.meta.url), 'utf8');

// ---------------------------------------------------------------------------
// Fixtures: the DL-04 pattern/render approach at video-frame size. A
// deterministic block-random alpha pattern, alpha-blended in white at a
// known corner of a smooth-gradient frame.
// ---------------------------------------------------------------------------
function hash2(a, b, seed) {
  let h = (seed * 374761393 + a * 668265263 + b * 974634211) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
// Alpha levels stay below 255 on purpose: the remover clamps alpha to
// 0.98, so a fully opaque pattern pixel can never be reverse-blended
// back and post-clean verification could never pass — a cleanable
// fixture must use a sub-opaque logo (as DL-11's fixtures do in effect).
const LEVELS = [0, 60, 110, 160];
function makePattern(seed, width = 24, height = 12) {
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data[y * width + x] = LEVELS[Math.floor(hash2(x >> 2, y >> 2, seed) * 4) % 4];
    }
  }
  return { width, height, data };
}
const PATTERN = makePattern(11);

const FRAME_W = 160;
const FRAME_H = 120;
// Positions chosen on the remover's own scan grids (corner scan step 5
// from (64, 54); full scan step 9 from the origin) so detection lands
// exactly, keeping these tests fast and deterministic.
const BR = { x: 129, y: 99 };
const TL = { x: 9, y: 9 };

function renderFrame(placedAt = null) {
  const width = FRAME_W;
  const height = FRAME_H;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const bg = 74 + Math.round(16 * Math.sin(x / 37) * Math.cos(y / 29)) + ((x + y) % 3);
      const offset = (y * width + x) * 4;
      data[offset] = data[offset + 1] = data[offset + 2] = bg;
      data[offset + 3] = 255;
    }
  }
  if (placedAt) {
    for (let y = 0; y < PATTERN.height; y++) {
      for (let x = 0; x < PATTERN.width; x++) {
        const a = PATTERN.data[y * PATTERN.width + x] / 255;
        if (a <= 0) continue;
        const offset = ((placedAt.y + y) * width + (placedAt.x + x)) * 4;
        for (let channel = 0; channel < 3; channel++) data[offset + channel] += a * (255 - data[offset + channel]);
      }
    }
  }
  return { width, height, data };
}

class FakeImageData {
  constructor(data, width, height) {
    this.data = data;
    this.width = width;
    this.height = height;
  }
}

function loadPipeline() {
  const sandbox = { console, ImageData: FakeImageData };
  const context = vm.createContext(sandbox);
  vm.runInContext(removerSource, context);
  vm.runInContext(cleanerSource, context);
  return { Remover: context.WatermarkRemover, Cleaner: context.VideoWatermarkCleaner, context };
}

// ---------------------------------------------------------------------------
// Fake codec adapter: the injected seam. It records everything the
// pipeline asked of it (open / samples requested / encoder options /
// frames encoded / finish / abort) and hands back an output descriptor
// whose audio packets are exactly the references finish() received.
// ---------------------------------------------------------------------------
function fakeAdapter({ frames, sampleFrames = null, metadata = {}, audioPackets = [] } = {}) {
  const state = {
    opened: false,
    sampleCounts: [],
    encoderCreated: false,
    encodeOptions: null,
    encodedFrames: [],
    finishCalled: false,
    finishOptions: null,
    abortCalled: false,
  };
  const fullMetadata = {
    sizeBytes: 2048,
    durationMs: 2000,
    mimeType: 'video/mp4',
    video: { width: FRAME_W, height: FRAME_H, codec: 'avc1.640028', bitrateBps: 2_500_000, fps: 30, frameCount: frames.length },
    audio: { codec: 'mp4a.40.2', packetCount: audioPackets.length },
    tracks: [
      { kind: 'video', codec: 'avc1.640028', width: FRAME_W, height: FRAME_H },
      { kind: 'audio', codec: 'mp4a.40.2' },
    ],
    ...metadata,
  };
  const adapter = {
    state,
    async open() {
      state.opened = true;
      const session = {
        metadata: fullMetadata,
        audioPackets,
        async sampleFrames(count) {
          state.sampleCounts.push(count);
          const source = sampleFrames || frames;
          const picked = [];
          const step = Math.max(1, Math.floor(source.length / Math.max(1, count)));
          for (let i = 0; i < source.length && picked.length < count; i += step) {
            picked.push({ index: i, timeMs: i * 100, imageData: new FakeImageData(source[i].data, source[i].width, source[i].height) });
          }
          return picked;
        },
        async *frames() {
          for (let i = 0; i < frames.length; i++) {
            yield { index: i, timeMs: i * 100, imageData: new FakeImageData(frames[i].data, frames[i].width, frames[i].height) };
          }
        },
        async createEncoder(options) {
          state.encoderCreated = true;
          state.encodeOptions = options;
          return {
            async addFrame(frame) { state.encodedFrames.push(frame); },
            async finish(finishOptions) {
              state.finishCalled = true;
              state.finishOptions = finishOptions;
              return {
                mimeType: 'video/mp4',
                bytes: new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]),
                frames: state.encodedFrames.map(frame => frame.imageData),
                audioPackets: finishOptions.audioPackets,
                durationMs: finishOptions.durationMs,
                tracks: finishOptions.tracks,
              };
            },
            async abort() { state.abortCalled = true; },
          };
        },
      };
      return session;
    },
  };
  return adapter;
}

function makeRemover(Remover) {
  return new Remover({ mask: PATTERN });
}

// ---------------------------------------------------------------------------
// (a) The headline test from the gap spec: a synthetic clip with a known
// logo burned into a corner is cleaned frame-wise; the processor reports
// applied/cleaned, the output corner's NCC vs the mask drops below the
// post-clean threshold, and audio/duration bookkeeping is unchanged.
// ---------------------------------------------------------------------------
test('DL-02 (a): watermarked clip → cleaned, output corner NCC below the post-clean threshold, audio/duration unchanged', async () => {
  const { Remover, Cleaner } = loadPipeline();
  assert.ok(Cleaner, 'the video cleaner module loads in a page-like context');
  const frames = Array.from({ length: 6 }, () => renderFrame(BR));
  const audioPackets = [{ id: 'a0', bytes: new Uint8Array([1]) }, { id: 'a1', bytes: new Uint8Array([2]) }, { id: 'a2', bytes: new Uint8Array([3]) }];
  const adapter = fakeAdapter({ frames, audioPackets });
  const progress = [];
  const input = { sizeBytes: 2048, mimeType: 'video/mp4' };

  const result = await Cleaner.cleanVideo(input, {
    adapter,
    remover: makeRemover(Remover),
    onProgress: event => progress.push(event),
  });

  assert.equal(result.status, 'cleaned', 'the DL-03 outcome vocabulary: cleaned');
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.equal(result.applied, true);
  assert.ok(result.output, 'a cleaned output is produced');
  assert.notEqual(result.output, input, 'the cleaned output is not the input object');

  // Anchor: found once from the samples, at the known corner, via the
  // image pipeline (the winning sample NCC clears the detection threshold).
  assert.equal(adapter.state.sampleCounts[0], 12, 'the pipeline samples ~12 frames to locate the anchor');
  assert.ok(Math.abs(result.anchor.x - BR.x) <= 2, `anchor x at the burned-in corner (${result.anchor.x} vs ${BR.x})`);
  assert.ok(Math.abs(result.anchor.y - BR.y) <= 2, `anchor y at the burned-in corner (${result.anchor.y} vs ${BR.y})`);
  assert.ok(result.anchor.ncc > 0.68, `anchor NCC above threshold (got ${result.anchor.ncc})`);

  // Every frame was processed and encoded, near the source bitrate.
  assert.equal(result.stats.framesProcessed, 6);
  assert.equal(result.stats.framesCleaned, 6);
  assert.equal(result.stats.redetections, 0, 'a stable anchor needs no re-detection');
  assert.equal(adapter.state.encodedFrames.length, 6);
  assert.equal(adapter.state.encodeOptions.videoBitrateBps, 2_500_000, 're-encode at the source bitrate by default');
  assert.equal(adapter.state.finishCalled, true);

  // The output corner no longer matches the mask: NCC of every output
  // frame at the anchor is below the post-clean threshold (0.25), while
  // the source frame's NCC was above the detection threshold.
  const probe = makeRemover(Remover);
  const sourceNcc = probe._nccAt(new FakeImageData(frames[0].data, FRAME_W, FRAME_H), PATTERN, BR.x, BR.y);
  assert.ok(sourceNcc > 0.68, `source corner NCC sanity check (got ${sourceNcc})`);
  for (const [index, outFrame] of result.output.frames.entries()) {
    const ncc = probe._nccAt(outFrame, PATTERN, result.anchor.x, result.anchor.y);
    assert.ok(ncc <= 0.25, `output frame ${index} corner NCC below the post-clean threshold (got ${ncc})`);
  }

  // Audio packets are copied through untouched — the same packet objects,
  // never decoded/re-encoded — and duration + track layout are preserved.
  assert.equal(result.output.audioPackets.length, 3);
  for (let i = 0; i < 3; i++) assert.equal(result.output.audioPackets[i], audioPackets[i], `audio packet ${i} is the identical object`);
  assert.equal(result.audio.copiedPackets, 3);
  assert.equal(result.audio.untouched, true);
  assert.equal(result.output.durationMs, 2000, 'duration preserved in the output bookkeeping');
  assert.equal(result.durationMs, 2000);
  assert.deepEqual(JSON.parse(JSON.stringify(result.output.tracks)), [
    { kind: 'video', codec: 'avc1.640028', width: FRAME_W, height: FRAME_H },
    { kind: 'audio', codec: 'mp4a.40.2' },
  ], 'track layout preserved in the output bookkeeping');
  assert.equal(adapter.state.finishOptions.audioPackets, audioPackets, 'the mux step receives the source packet list itself');

  // Progress was reported while cleaning.
  assert.ok(progress.some(event => event.phase === 'cleaning' && event.framesProcessed === 6), 'progress reaches the final frame count');
});

// ---------------------------------------------------------------------------
// (b) A watermark-free clip returns the no-watermark outcome with the
// original bytes untouched — no encoder is ever created.
// ---------------------------------------------------------------------------
test('DL-02 (b): watermark-free clip → original / not_found, original bytes untouched, no encode', async () => {
  const { Remover, Cleaner } = loadPipeline();
  const frames = Array.from({ length: 4 }, () => renderFrame(null));
  const adapter = fakeAdapter({ frames, audioPackets: [{ id: 'a0' }] });
  const input = { sizeBytes: 1024, mimeType: 'video/mp4', bytes: new Uint8Array([9, 9, 9]) };

  const result = await Cleaner.cleanVideo(input, { adapter, remover: makeRemover(Remover) });

  assert.equal(result.status, 'original', 'the DL-03 outcome vocabulary: original');
  assert.equal(result.reason, 'not_found');
  assert.equal(result.ok, true);
  assert.equal(result.changed, false);
  assert.equal(result.applied, false);
  assert.equal(result.output, input, 'the original input is returned untouched (same object, same bytes)');
  assert.equal(adapter.state.encoderCreated, false, 'no encoder is created for a no-watermark clip');
  assert.equal(adapter.state.finishCalled, false);
});

// ---------------------------------------------------------------------------
// (c) The 300 MB cap: refused up front with a typed error, before the
// adapter is even opened.
// ---------------------------------------------------------------------------
test('DL-02 (c): input over 300 MB is refused up front with a typed error', async () => {
  const { Remover, Cleaner } = loadPipeline();
  const adapter = fakeAdapter({ frames: [renderFrame(BR)] });
  const overCap = { sizeBytes: Cleaner.MAX_INPUT_BYTES + 1, mimeType: 'video/mp4' };
  await assert.rejects(
    Cleaner.cleanVideo(overCap, { adapter, remover: makeRemover(Remover) }),
    error => {
      assert.equal(error.code, 'FLOW_VIDEO_WATERMARK_INPUT_TOO_LARGE');
      assert.equal(error.output, null, 'a refused input yields no output');
      return true;
    },
  );
  assert.equal(adapter.state.opened, false, 'the refusal happens before any decode/open');

  // A Blob-shaped input reports its size the same way.
  const blobLike = { size: Cleaner.MAX_INPUT_BYTES + 1024, type: 'video/mp4' };
  await assert.rejects(
    Cleaner.cleanVideo(blobLike, { adapter, remover: makeRemover(Remover) }),
    error => error.code === 'FLOW_VIDEO_WATERMARK_INPUT_TOO_LARGE',
  );
  assert.equal(adapter.state.opened, false);
  assert.equal(Cleaner.MAX_INPUT_BYTES, 300 * 1024 * 1024, 'the cap is the spec 300 MB');
});

// ---------------------------------------------------------------------------
// (d) Cancellation stops processing between frames and yields NO output:
// the encode is aborted, finish() is never called, and the promise
// rejects with a typed cancellation error carrying no output.
// ---------------------------------------------------------------------------
test('DL-02 (d): cancellation stops between frames, aborts the encode and produces no output', async () => {
  const { Remover, Cleaner } = loadPipeline();
  const frames = Array.from({ length: 6 }, () => renderFrame(BR));
  const adapter = fakeAdapter({ frames });
  const controller = new AbortController();
  let progressEvents = 0;

  await assert.rejects(
    Cleaner.cleanVideo({ sizeBytes: 2048, mimeType: 'video/mp4' }, {
      adapter,
      remover: makeRemover(Remover),
      signal: controller.signal,
      onProgress: event => {
        if (event.phase !== 'cleaning') return;
        progressEvents += 1;
        if (event.framesProcessed === 2) controller.abort();
      },
    }),
    error => {
      assert.equal(error.code, 'FLOW_VIDEO_WATERMARK_CANCELLED');
      assert.equal(error.output, null, 'cancellation yields NO output — never a truncated video presented as cleaned');
      assert.equal(error.framesProcessed, 2, 'processing stopped at the cancel point');
      return true;
    },
  );
  assert.equal(progressEvents, 2);
  assert.equal(adapter.state.encodedFrames.length, 2, 'only the frames before the cancel were encoded');
  assert.equal(adapter.state.abortCalled, true, 'the in-flight encode is aborted');
  assert.equal(adapter.state.finishCalled, false, 'finish/mux never runs after a cancel');
});

// ---------------------------------------------------------------------------
// (e) Re-detection: the logo moves mid-clip. The anchor is established
// from the samples (early frames, bottom-right); when a later frame's
// pre-clean NCC at the anchor falls below the detection threshold the
// anchor is stale, the pipeline re-detects on that frame, adopts the new
// anchor and cleans the rest of the clip there.
// ---------------------------------------------------------------------------
test('DL-02 (e): a moved logo triggers re-detection and the new anchor cleans the remaining frames', async () => {
  const { Remover, Cleaner } = loadPipeline();
  const early = Array.from({ length: 3 }, () => renderFrame(BR));
  const late = Array.from({ length: 3 }, () => renderFrame(TL));
  const frames = [...early, ...late];
  // The adapter's samples come from the clip's first segment — the anchor
  // the pipeline starts from is the bottom-right one.
  const adapter = fakeAdapter({ frames, sampleFrames: early });

  const result = await Cleaner.cleanVideo({ sizeBytes: 2048, mimeType: 'video/mp4' }, {
    adapter,
    remover: makeRemover(Remover),
  });

  assert.equal(result.status, 'cleaned');
  assert.ok(result.stats.redetections >= 1, `re-detection ran after the anchor went stale (got ${result.stats.redetections})`);
  assert.ok(Math.abs(result.anchor.x - TL.x) <= 2 && Math.abs(result.anchor.y - TL.y) <= 2,
    `the final anchor is the moved logo position (${result.anchor.x},${result.anchor.y})`);
  const probe = makeRemover(Remover);
  const lastOut = result.output.frames[result.output.frames.length - 1];
  const nccTl = probe._nccAt(lastOut, PATTERN, TL.x, TL.y);
  assert.ok(nccTl <= 0.25, `the moved logo was cleaned at its new anchor (NCC ${nccTl})`);
  const firstOut = result.output.frames[0];
  assert.ok(probe._nccAt(firstOut, PATTERN, BR.x, BR.y) <= 0.25, 'the early frames were cleaned at the original anchor');
});

// ---------------------------------------------------------------------------
// (f) Page context only (W11): the cleaner refuses to run in a
// service-worker-shaped context, and the production browser adapter
// fails closed with a typed codec error when no codec/demux surface is
// available — it never silently produces an uncleaned "cleaned" file.
// ---------------------------------------------------------------------------
test('DL-02 (f): page-context guard + production adapter fails closed without a codec surface', async () => {
  const { Cleaner } = loadPipeline();
  assert.equal(typeof Cleaner.createBrowserAdapter, 'function', 'a production adapter factory is exposed');
  const adapter = Cleaner.createBrowserAdapter({});
  await assert.rejects(
    adapter.open({ size: 100, type: 'video/mp4' }),
    error => {
      assert.equal(error.code, 'FLOW_VIDEO_CODEC_UNAVAILABLE');
      return true;
    },
    'with no WebCodecs/video-element surface injected, the browser adapter refuses instead of faking a clean',
  );
});

// ---------------------------------------------------------------------------
// (g) watermark-config bridge: the video cleaner settings ride the same
// flowWatermark config family (sample count, input cap, bitrate ratio),
// validated per field; invalid values forward nothing for that field.
// ---------------------------------------------------------------------------
async function configBridgePosts(config) {
  const posted = [];
  const sandbox = {
    console,
    atob,
    location: { origin: 'https://flow.google.com' },
    window: { postMessage: message => posted.push(message) },
    chrome: {
      storage: {
        local: { get: async () => ({ flowWatermark: config }) },
        onChanged: { addListener: () => {} },
      },
      runtime: { onMessage: { addListener: () => {} } },
    },
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(watermarkConfigSource, context);
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  return posted.filter(message => message?.action === 'configure');
}

test('DL-02 (g): the config bridge forwards validated video-cleaner settings alongside the image config', async () => {
  const posts = await configBridgePosts({
    enabled: true,
    video: true,
    videoSampleFrames: 8,
    videoMaxInputBytes: 100 * 1024 * 1024,
    videoBitrateRatio: 0.95,
  });
  assert.equal(posts.length, 1);
  const options = posts[0].options;
  assert.equal(options.video, true, 'the DL-01 per-kind video flag still forwards');
  assert.equal(options.videoSampleFrames, 8);
  assert.equal(options.videoMaxInputBytes, 100 * 1024 * 1024);
  assert.equal(options.videoBitrateRatio, 0.95);
});

test('DL-02 (g2): invalid video-cleaner settings are dropped per field, never forwarded', async () => {
  const posts = await configBridgePosts({
    enabled: true,
    videoSampleFrames: 0,
    videoMaxInputBytes: 400 * 1024 * 1024,
    videoBitrateRatio: 9,
  });
  assert.equal(posts.length, 1);
  const options = posts[0].options;
  assert.equal(options.videoSampleFrames, undefined, 'a non-positive sample count forwards nothing');
  assert.equal(options.videoMaxInputBytes, undefined, 'a cap above the hard 300 MB ceiling forwards nothing');
  assert.equal(options.videoBitrateRatio, undefined, 'an out-of-range bitrate ratio forwards nothing');
});

// ---------------------------------------------------------------------------
// (h) Queue layer (background): the queue NEVER cleans video itself —
// it routes a video clean to the page context and records the video
// cleaner's outcome bookkeeping on the job result. The image path of
// queueWatermarkResult is unchanged.
// ---------------------------------------------------------------------------
test('DL-02 (h): queue routes video cleaning to the page context and records video outcome bookkeeping', async () => {
  const { queueWatermarkResult, queueVideoWatermarkRoute, FLOW_VIDEO_WATERMARK_MAX_INPUT_BYTES } =
    await import('../extension/src/background/flow-queue-downloads.js');

  assert.equal(FLOW_VIDEO_WATERMARK_MAX_INPUT_BYTES, 300 * 1024 * 1024);

  const route = queueVideoWatermarkRoute({ kind: 'video', mode: 'clean' });
  assert.equal(route.context, 'page', 'video cleaning runs in a page context');
  assert.equal(route.serviceWorker, false, 'never in the service worker (W11)');
  assert.equal(route.delegated, true, 'the background delegates and treats delegation as a routing signal');
  assert.equal(queueVideoWatermarkRoute({ kind: 'video', mode: 'original' }).route, 'none');
  assert.equal(queueVideoWatermarkRoute({ kind: 'image', mode: 'clean' }).context, 'page',
    'image cleaning also lives in the page (the interceptor), not the worker');

  const recorded = queueWatermarkResult({
    mode: 'clean',
    armed: true,
    cleaned: true,
    status: 'cleaned',
    kind: 'video',
    video: {
      framesProcessed: 6,
      framesCleaned: 6,
      redetections: 1,
      redetectionRatio: 0.17,
      audioPacketsCopied: 3,
      durationMs: 2000,
    },
  });
  assert.equal(recorded.status, 'cleaned');
  assert.equal(recorded.kind, 'video');
  assert.deepEqual(JSON.parse(JSON.stringify(recorded.video)), {
    framesProcessed: 6,
    framesCleaned: 6,
    redetections: 1,
    redetectionRatio: 0.17,
    audioPacketsCopied: 3,
    durationMs: 2000,
  }, 'the video bookkeeping lands on the queue result');

  // The pre-DL-02 image shape is byte-identical when no video fields ride along.
  assert.deepEqual(
    queueWatermarkResult({ mode: 'clean', armed: true, cleaned: true }),
    { mode: 'clean', armed: true, cleaned: true, status: 'cleaned' },
  );
});
