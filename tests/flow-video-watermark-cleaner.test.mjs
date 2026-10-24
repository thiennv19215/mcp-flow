import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

// Cluster A3 (DL-02): video watermark cleaning is UNSUPPORTED and the
// page-context frame pipeline (video-watermark-cleaner.js) was REMOVED,
// not wired in. It was never in the manifest's content_scripts, no
// download path ever called it, and its only codec adapter failed
// closed (FLOW_VIDEO_CODEC_UNAVAILABLE — no demuxer or WebCodecs surface
// exists anywhere in the extension), so wiring it in could not have
// produced a working video clean. A video download with mode=clean
// therefore saves the original; the queue records that honestly (see
// the route test below) instead of claiming a clean.
//
// What remains tested here:
// (g)/(g2) the watermark-config bridge NO LONGER forwards the DL-02 video
//   settings (videoSampleFrames/videoMaxInputBytes/videoBitrateRatio):
//   audit cluster F removed them because no consumer ever read them —
//   the MAIN-world interceptor only spreads them into state.options and
//   WatermarkRemover (image-only) never reads them. The DL-01 per-kind
//   `video` flag still forwards.
// (h) the queue route no longer advertises a video frame pipeline, and
//   queueWatermarkResult still records op-supplied outcome bookkeeping.

const watermarkConfigSource = readFileSync(new URL('../extension/src/content/bridge/watermark-config.js', import.meta.url), 'utf8');

// ---------------------------------------------------------------------------
// (g) watermark-config bridge: the DL-02 video settings are gone — a config
// carrying them must NOT forward them (no consumer ever read them), while
// the DL-01 per-kind video flag still forwards.
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

test('DL-02 (g): the config bridge no longer forwards DL-02 video settings', async () => {
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
  assert.equal(options.videoSampleFrames, undefined, 'removed in audit cluster F: no consumer');
  assert.equal(options.videoMaxInputBytes, undefined, 'removed in audit cluster F: no consumer');
  assert.equal(options.videoBitrateRatio, undefined, 'removed in audit cluster F: no consumer');
});

test('DL-02 (g2): a config without video settings posts cleanly', async () => {
  const posts = await configBridgePosts({
    enabled: true,
    video: true,
  });
  assert.equal(posts.length, 1);
  const options = posts[0].options;
  assert.equal(options.video, true);
  assert.equal('videoSampleFrames' in options, false);
  assert.equal('videoMaxInputBytes' in options, false);
  assert.equal('videoBitrateRatio' in options, false);
});

// ---------------------------------------------------------------------------
// (h) Queue layer (background): video cleaning is unsupported, so the
// route must not advertise a page-context video frame pipeline anymore.
// queueWatermarkResult itself is unchanged: it still records
// op-supplied outcome bookkeeping on the job result.
// ---------------------------------------------------------------------------
test('DL-02 (h): queue routes video cleaning to "unsupported" and still records outcome bookkeeping', async () => {
  const { queueWatermarkResult, queueVideoWatermarkRoute } =
    await import('../extension/src/background/flow-queue-downloads.js');

  const route = queueVideoWatermarkRoute({ kind: 'video', mode: 'clean' });
  assert.equal(route.route, 'none', 'no video frame pipeline exists to delegate to');
  assert.equal(route.delegated, false, 'video clean is unsupported, not delegated');
  assert.equal(route.reason, 'video_cleaning_unsupported');
  assert.equal(route.serviceWorker, false, 'never in the service worker');
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
