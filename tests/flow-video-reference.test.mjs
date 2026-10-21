import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { shapes } from '../dist/schemas.js';
import { validateFlowSceneCapabilities } from '../dist/flow-capabilities.js';
import { LocalCore } from '../dist/core.js';

const generateInput = z.object(shapes.generate);
const reference = { asset: 'Source clip', start_frame_index: 12, end_frame_index: 48 };
const scene = video_reference => ({ prompt: 'Continue the motion', type: 'video', video_reference });

test('video-reference mode parses exact source title and explicit frame range', () => {
  const parsed = generateInput.parse({ project: 'VideoEdit', scenes: [scene(reference)] });
  assert.deepEqual(parsed.scenes[0].video_reference, reference);
});

test('video-reference validation requires a nonempty integer frame range and excludes other inputs', () => {
  for (const bad of [
    { ...reference, end_frame_index: 12 },
    { ...reference, start_frame_index: 1.5 },
    { ...reference, asset: '   ' },
  ]) {
    assert.throws(() => generateInput.parse({ project: 'VideoEdit', scenes: [scene(bad)] }));
  }
  assert.throws(() => generateInput.parse({ project: 'VideoEdit', scenes: [{ ...scene(reference), first_frame: 'asset:Still' }] }));
  assert.throws(() => generateInput.parse({ project: 'VideoEdit', scenes: [{ ...scene(reference), reference_images: ['asset:Still'] }] }));
  assert.throws(() => generateInput.parse({ project: 'VideoEdit', scenes: [{ ...scene(reference), type: 'image' }] }));
});

test('video-reference mode fails closed before queueing when Toby dynamic RPC config is absent', async () => {
  validateFlowSceneCapabilities(scene(reference));
  await assert.rejects(new LocalCore().generate({ project: 'VideoEdit', scenes: [scene(reference)] }), error =>
    error.code === 'FLOW_VIDEO_REFERENCE_CONFIG_UNAVAILABLE' && /video_edit_submit RPC configuration/.test(error.message) && error.outcome_unknown === false
  );
});
