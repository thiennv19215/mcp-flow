import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Review round 3, item S5 (minor) — the Ingredients flow-ref builder
// defaulted a kind-less reference to "video", pushing it down the
// video attach path (canonical-UUID-demanding, fail-closed) instead of
// the image path. The picker always sets kind today so this is
// unreachable in live use, but the safe default is "image" — matching
// the image submit handler, which already defaults kind-less references
// to "image". Both video-handler sites (library flow refs and uploaded
// refs) take the same default.
// ---------------------------------------------------------------------------

test('S5: kind-less video references default to the image path, not the video path', () => {
  const source = readFileSync(new URL('../extension/src/ui/sidebar.js', import.meta.url), 'utf8');
  const videoStart = source.indexOf('document.querySelector("#btnSubmitVideo").onclick');
  assert.notEqual(videoStart, -1, 'the video submit handler must exist');
  const videoRegion = source.slice(videoStart);
  assert.doesNotMatch(videoRegion, /kind: reference\.kind \|\| "video"/,
    'no video-handler reference may default its kind to "video"');
  const imageDefaults = videoRegion.match(/kind: reference\.kind \|\| "image"/g) || [];
  assert.ok(imageDefaults.length >= 2,
    `both video-handler reference builders (flow refs and uploaded refs) must default kind to "image" (found ${imageDefaults.length})`);
});
