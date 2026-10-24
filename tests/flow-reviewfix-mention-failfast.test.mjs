import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Review round 3, item S2 — an unresolved @mention used to only warn
// AFTER the job was already queued (showUnresolvedMentionWarning ran
// after executeGenerationTask). The prompt kept the @name, Flow dropped
// the mention, and the fingerprint skewed — or the video lost an
// ingredient after credits were spent.
//
// The fix fails fast in BOTH submit handlers immediately after
// resolveMentionReferences succeeds: an unresolved non-character mention
// shows the unresolved-mention feedback and returns before any upload
// or enqueue. This is a source-structure pin in the repo's own precedent
// (the F9 gentype test pins source structure): the guard must appear
// before executeGenerationTask in each handler region, and the
// post-enqueue warning call stays as a defensive no-op for the
// now-unreachable case.
// ---------------------------------------------------------------------------

function handlerRegion(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `${startMarker} must exist in sidebar.js`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `${endMarker} must follow ${startMarker}`);
  return source.slice(start, end);
}

test('S2: both submit handlers fail fast on unresolved mentions before any enqueue', () => {
  const source = readFileSync(new URL('../extension/src/ui/sidebar.js', import.meta.url), 'utf8');
  for (const [handler, startMarker, endMarker] of [
    ['image', 'document.querySelector("#btnSubmitImage").onclick', 'showUnresolvedMentionWarning("image"'],
    ['video', 'document.querySelector("#btnSubmitVideo").onclick', 'showUnresolvedMentionWarning("video"'],
  ]) {
    const region = handlerRegion(source, startMarker, endMarker);
    const guardAt = region.indexOf('mentionResolution?.unresolvedNames?.length');
    assert.notEqual(guardAt, -1, `${handler} handler must check unresolvedNames right after mention resolution`);
    const enqueueAt = region.indexOf('executeGenerationTask({');
    assert.notEqual(enqueueAt, -1, `${handler} handler must enqueue via executeGenerationTask`);
    assert.ok(guardAt < enqueueAt,
      `${handler} handler must fail fast on unresolved mentions BEFORE executeGenerationTask (guard at ${guardAt}, enqueue at ${enqueueAt})`);
    const returnAfterGuard = region.indexOf('return;', guardAt);
    assert.ok(returnAfterGuard !== -1 && returnAfterGuard < enqueueAt,
      `${handler} handler must return after the unresolved-mention guard, before enqueue`);
  }
});
