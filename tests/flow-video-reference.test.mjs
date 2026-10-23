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

test('video reference attachments record expectedVideoReferenceIds and verify composer video chips', async () => {
  const { readFileSync } = await import('node:fs');
  const vm = await import('node:vm');
  const generationOperationsSource = readFileSync(new URL('../extension/src/content/providers/flow/generation/generation-operations.js', import.meta.url), 'utf8');
  const videoUuid = 'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d';
  let correlationOptions;
  const correlation = new Map();
  const attemptId = 'test-attempt';
  let videoChipPresent = true;

  const makeContext = () => vm.createContext({
    Date, Promise, Map, Set, Object, String, Number, Boolean, Array, Math, RegExp, Error, AbortController,
    setTimeout, clearTimeout,
    FlowUiDeadline: { makeDeadline: () => Date.now() + 60_000, requireTime: () => {} },
    FlowNavigation: {
      ensureFlowProjectEditor: async () => ({ isProjectEditor: true }),
      dismissBlockingOverlays: async () => false,
      ensureFlowLibrarySection: async () => true,
      prepareFlowOperation: async () => ({ ready: true }),
    },
    FlowMediaMenu: { nativeRead: () => ({ signedIn: true, inProject: true }) },
    FlowAgent: { closeNativeAgentSession: async () => true },
    FlowComponents: {
      clearExistingIngredientChips: async () => ({ remaining: 0 }),
      chooseNativePickerAsset: async (_name, _slot, _options) => {
        return { name: 'reference-clip.mp4', kind: 'video', id: videoUuid, confirmed: true };
      },
    },
    FlowVideoActions: { prepare: async () => 10 },
    FlowEditor: {
      preflightGenerationPrompt: async () => ({}),
      insertNativeFlowPrompt: async () => true,
      waitForGenerationCreditQuote: async () => 10,
      waitForGenerationSubmitButton: async () => ({ disabled: false, getAttribute: () => null }),
      currentFlowSubmitErrors: () => [],
      activateFlowSubmitButton: async () => ({ clickDelivered: true, strategy: 'test' }),
    },
    FlowTiles: {
      collectNativeMedia: () => [],
      stabilizeFlowResultViewport: async () => true,
      emitFlowProgress: () => {},
      armNativeFlowCorrelation: async options => {
        correlationOptions = options;
        correlation.set(attemptId, { requestSeen: true, armedAt: Date.now(), interfered: false });
        return attemptId;
      },
      nativeFlowCorrelationMap: () => correlation,
    },
    ProviderRegistry: { describeUrl: () => ({ projectId: 'test-project' }) },
    FlowSettings: {},
    flowButton: () => null,
    flowQuery: key => key === 'composerRoot' ? {
      querySelectorAll: selector => selector.includes('ingredient_video_chip') && videoChipPresent
        ? [{ className: 'ingredient_video_chip', getAttribute: () => 'video' }]
        : []
    } : null,
    clearExistingIngredientChips: async () => ({ remaining: 0 }),
    checkFlowCreditLimitAlert: () => null,
    flowError: (code, message, retryable, outcome_unknown) => Object.assign(new Error(message), { code, retryable, outcome_unknown }),
    location: { href: 'https://flow.google.com/project/test-project' },
  });

  const ctx1 = makeContext();
  vm.runInContext(generationOperationsSource, ctx1);
  const ops1 = new ctx1.FlowGenerationOperations({ error: (code, msg, retry, outcome) => Object.assign(new Error(msg), { code, retry, outcome }) });

  const result = await ops1.execute('flow.generation.submit', {
    type: 'video',
    prompt: 'A cinematic drone shot',
    attachments: [{ assetName: 'asset:reference-clip.mp4', kind: 'video', expectedId: videoUuid }],
    variants: 1,
  });
  assert.equal(result.submitted, true);
  assert.deepEqual([...correlationOptions.expectedReferenceIds], [videoUuid]);

  videoChipPresent = false;
  const ctx2 = makeContext();
  vm.runInContext(generationOperationsSource, ctx2);
  const ops2 = new ctx2.FlowGenerationOperations({ error: (code, msg, retry, outcome) => Object.assign(new Error(msg), { code, retry, outcome }) });
  await assert.rejects(
    ops2.execute('flow.generation.submit', {
      type: 'video',
      prompt: 'A cinematic drone shot',
      attachments: [{ assetName: 'asset:reference-clip.mp4', kind: 'video', expectedId: videoUuid }],
      variants: 1,
    }),
    error => error.code === 'FLOW_REFERENCE_ATTACH_UNCONFIRMED'
  );
});

test('character selection resolves search_value in FlowReferenceActions and FlowCharacterActions', async () => {
  const { readFileSync } = await import('node:fs');
  const vm = await import('node:vm');
  const charactersSource = readFileSync(new URL('../extension/src/content/providers/flow/characters/flow-characters.js', import.meta.url), 'utf8');

  let attachedWith;
  const context = vm.createContext({
    Date, Promise, Map, Set, Object, String, Number, Boolean, Array, Math, RegExp, Error,
    setTimeout, clearTimeout,
    location: { href: 'https://flow.google.com/project/test', pathname: '/project/test' },
    document: {
      querySelectorAll: () => [],
      querySelector: () => null,
      dispatchEvent: () => true,
    },
    visible: () => true,
    accessibleName: el => el?.label || '',
    flowButton: () => null,
    flowError: (code, msg, retry, outcome) => Object.assign(new Error(msg), { code, retry, outcome }),
    FlowUiDeadline: { makeDeadline: () => Date.now() + 60_000, requireTime: () => {} },
    FlowReferenceActions: {
      attach: async (name, slot, options) => {
        attachedWith = { name, slot, options };
        return { name, kind: 'character', confirmed: true };
      }
    }
  });

  vm.runInContext(charactersSource, context);
  const char = { name: 'Ada Lovelace', search_value: 'ada_slug', uuid: '11111111-2222-3333-4444-555555555555' };
  const res = await context.FlowCharacterActions.select(char);
  assert.equal(res.confirmed, true);
  assert.equal(attachedWith.name, 'ada_slug');
  assert.equal(attachedWith.options.kind, 'character');
  assert.equal(attachedWith.options.search_value, 'ada_slug');
  assert.equal(attachedWith.options.expectedId, '11111111-2222-3333-4444-555555555555');
});

test('per-prompt character mention parsing resolution', () => {
  const characters = [
    { name: 'Ada Lovelace', uuid: '11111111-2222-3333-4444-555555555555' },
    { name: 'Bob_Smith', uuid: '22222222-3333-4444-5555-666666666666' },
  ];
  const pattern = /@(?:\[([^\]]+)\]|([\p{L}\p{N}_]+))/gu;
  const normalize = val => String(val || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[đĐ]/g, "d").trim().toLowerCase();

  const charMap = new Map();
  for (const c of characters) {
    const name = c.name;
    const key = normalize(name);
    charMap.set(key, c);
    charMap.set(key.replace(/_/g, " "), c);
    charMap.set(key.replace(/\s+/g, "_"), c);
  }

  const findMention = promptText => {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(promptText)) !== null) {
      if (promptText[pattern.lastIndex] === ":") continue;
      const raw = String(match[1] || match[2] || "").trim();
      const key = normalize(raw);
      const found = charMap.get(key) || charMap.get(key.replace(/_/g, " ")) || charMap.get(key.replace(/\s+/g, "_"));
      if (found) return found;
    }
    return null;
  };

  assert.equal(findMention('A portrait of @[Ada Lovelace] in a garden').name, 'Ada Lovelace');
  assert.equal(findMention('A scene with @Bob_Smith walking').name, 'Bob_Smith');
  assert.equal(findMention('A landscape without characters'), null);
});
