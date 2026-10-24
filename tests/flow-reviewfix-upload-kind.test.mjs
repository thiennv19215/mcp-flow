import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Review round 1, item V1 (MUST) — sidebar forced kind "image" for every
// reference upload, so a local VIDEO file used as a video reference could
// never confirm: Flow creates a video tile, but waitForNativeMediaTile was
// asked to match kind "image" (flowUploadKindMatches("image","video") is
// false) and the upload died with FLOW_UPLOAD_TIMEOUT after 75 s even
// though the tile existed in the library.
//
// The fix derives the upload kind from the FILE's media type — the tile
// Flow creates follows the file, not the reference role — with a file
// extension fallback when the MIME type is empty. The derivation lives in
// referenceUploadKind() in sidebar.js, extracted here brace-matched (not
// re-implemented), and uploadReferenceImage must call it.
// ---------------------------------------------------------------------------

function extractSidebarFunction(source, signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `${signature} must exist in sidebar.js`);
  const bodyOpen = source.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = bodyOpen; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  assert.notEqual(end, -1, `${signature} body must close`);
  return source.slice(start, end);
}

function loadReferenceUploadKind() {
  const source = readFileSync(new URL('../extension/src/ui/sidebar.js', import.meta.url), 'utf8');
  const fnSource = extractSidebarFunction(source, 'function referenceUploadKind(file)');
  const context = vm.createContext({});
  vm.runInContext(`${fnSource}; globalThis.__fn = referenceUploadKind;`, context);
  // Pin the wiring: uploadReferenceImage must derive its kind from the file.
  const uploadStart = source.indexOf('async function uploadReferenceImage(');
  assert.notEqual(uploadStart, -1, 'uploadReferenceImage must exist in sidebar.js');
  const uploadBody = source.slice(uploadStart, uploadStart + 400);
  assert.match(uploadBody, /referenceUploadKind\(file\)/,
    'uploadReferenceImage must pass the file through referenceUploadKind instead of hardcoding kind "image"');
  assert.doesNotMatch(uploadBody, /kind:\s*"image"/,
    'uploadReferenceImage must not hardcode kind "image" anymore');
  return context.__fn;
}

test('V1: reference upload kind follows the file media type, not the reference role', () => {
  const kindOf = loadReferenceUploadKind();
  assert.equal(kindOf({ type: 'video/mp4', name: 'clip.mp4' }), 'video');
  assert.equal(kindOf({ type: 'video/quicktime', name: 'clip.mov' }), 'video');
  assert.equal(kindOf({ type: 'VIDEO/MP4', name: 'clip.mp4' }), 'video', 'MIME comparison is case-insensitive');
  assert.equal(kindOf({ type: 'image/png', name: 'photo.png' }), 'image');
  assert.equal(kindOf({ type: 'image/jpeg', name: 'photo.jpg' }), 'image');
  assert.equal(kindOf({ type: '', name: 'clip.webm' }), 'video', 'empty MIME falls back to the file extension');
  assert.equal(kindOf({ type: '', name: 'photo.png' }), 'image');
  assert.equal(kindOf(null), 'image');
  assert.equal(kindOf(undefined), 'image');
});
