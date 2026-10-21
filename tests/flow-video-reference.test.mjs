import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { shapes } from '../dist/schemas.js';
import { validateFlowSceneCapabilities } from '../dist/flow-capabilities.js';
import { LocalCore } from '../dist/core.js';
import { mapFlowFrameInput, bindFlowReferenceIds } from '../dist/flow.js';

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

test('first and last frame schemas accept an exact title with an explicit Flow media UUID', () => {
  const id = 'b5d304ab-eeb8-4001-8110-86a225761c0f';
  const parsed = generateInput.parse({ project: 'FrameIdentity', scenes: [{
    prompt: 'Animate the image', type: 'video', max_credits: 15,
    first_frame: { asset: 'Start still.png', id },
    last_frame: { asset: 'End still.png', id: 'c9d304ab-eeb8-4001-8110-86a225761c0f' },
  }] });
  assert.deepEqual(parsed.scenes[0].first_frame, { asset: 'Start still.png', id });
  assert.deepEqual(parsed.scenes[0].last_frame, { asset: 'End still.png', id: 'c9d304ab-eeb8-4001-8110-86a225761c0f' });
  assert.throws(() => generateInput.parse({ project: 'FrameIdentity', scenes: [{
    prompt: 'Animate the image', type: 'video', first_frame: { asset: 'Still.png', id: 'not-a-uuid' },
  }] }));
  assert.throws(() => generateInput.parse({ project: 'FrameIdentity', scenes: [{
    prompt: 'Animate the image', type: 'video', first_frame: { asset: 'Still.png', id }, last_frame: { asset: 'Still.png', id },
  }] }));
});

test('generation route preserves explicit frame UUIDs while legacy asset and local path inputs keep their behavior', async () => {
  const id = 'b5d304ab-eeb8-4001-8110-86a225761c0f';
  const frame = { asset: 'Start still.png', id };
  const core = new LocalCore('frame-identity-route');
  let captured;
  core.queue.add = params => {
    captured = params;
    return { id: 'frame-test-job', status: 'queued', params, files: [], attempts: 0 };
  };
  await core.generate(generateInput.parse({ project: `FrameIdentity-${Date.now()}`, scenes: [{
    prompt: 'Animate the image', type: 'video', first_frame: frame, submit_only: true, variants: 1, max_credits: 15,
  }] }));
  assert.deepEqual(captured.first_frame, frame);

  assert.deepEqual(mapFlowFrameInput(frame, 'start'), { assetName: 'Start still.png', expectedId: id });
  assert.deepEqual(mapFlowFrameInput('asset:Legacy still.png', 'end'), { assetName: 'Legacy still.png' });
  assert.deepEqual(mapFlowFrameInput('C:\\fixtures\\local.png', 'start', new Map([['C:\\fixtures\\local.png', 'uploaded-local.png']])), {
    assetName: 'uploaded-local.png', slot: 'start',
  });
  assert.throws(() => mapFlowFrameInput({ asset: 'Still.png', id: 'bad-id' }, 'start'), error => error.code === 'FLOW_FRAME_ID_INVALID');
});

test('asset references bind through one exact image title and UUID from the Flow library', () => {
  const id = '123e4567-e89b-42d3-a456-426614174000';
  assert.deepEqual(bindFlowReferenceIds(['asset:Portrait.png', 'character:Ada'], [
    { name: 'Portrait.png', kind: 'image', id },
    { name: 'clip.mp4', kind: 'video', id: '123e4567-e89b-42d3-a456-426614174001' },
  ]), [{ assetName: 'Portrait.png', expectedId: id }, 'character:Ada']);
});

test('asset reference binding fails closed for missing, duplicate, wrong-kind, and missing UUID', () => {
  const id = '123e4567-e89b-42d3-a456-426614174000';
  assert.throws(() => bindFlowReferenceIds(['asset:Missing.png'], []), error => error.code === 'FLOW_ASSET_NOT_FOUND');
  assert.throws(() => bindFlowReferenceIds(['asset:Same.png'], [
    { name: 'Same.png', kind: 'image', id }, { name: 'Same.png', kind: 'image', id: '123e4567-e89b-42d3-a456-426614174001' },
  ]), error => error.code === 'FLOW_ASSET_AMBIGUOUS');
  assert.throws(() => bindFlowReferenceIds(['asset:Same.png'], [{ name: 'Same.png', kind: 'video', id }]), error => error.code === 'FLOW_ASSET_NOT_FOUND');
  assert.throws(() => bindFlowReferenceIds(['asset:Same.png'], [{ name: 'Same.png', kind: 'image' }]), error => error.code === 'FLOW_ASSET_ID_UNAVAILABLE');
});
