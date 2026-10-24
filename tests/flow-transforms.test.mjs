import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

// FEAT-11 — Shared single-image transform engine (study B6: Angles #10,
// Effects #11). ONE engine serves both preset families: a preset is a
// prompt template plus per-parameter keyword maps keyed by numeric
// anchors; building a prompt substitutes the NEAREST anchor's phrase per
// parameter and strips slots that resolve to no phrase. Execution is a
// single image job with the source image as the sole reference through
// the existing queue — the engine only shapes that job payload.
// The vendor preset catalogs stay blocked (FEAT-B2): the starter set
// shipped here is locally authored and flagged as such.

const transformsSource = readFileSync(new URL('../extension/src/content/shared/flow-transforms.js', import.meta.url), 'utf8');
const sidebarSource = readFileSync(new URL('../extension/src/ui/sidebar.js', import.meta.url), 'utf8');
const sidebarHtml = readFileSync(new URL('../extension/src/ui/sidebar.html', import.meta.url), 'utf8');

function loadTransforms() {
  const sandbox = {};
  vm.runInNewContext(transformsSource, sandbox, { filename: 'flow-transforms.js' });
  assert.ok(sandbox.FlowTransforms, 'flow-transforms.js must attach FlowTransforms to the global root');
  return sandbox.FlowTransforms;
}

// The module runs in a vm sandbox, so its objects carry the sandbox
// realm's prototype — round-trip through JSON before deepEqual.
const plain = value => JSON.parse(JSON.stringify(value));

const AZIMUTH = {
  '-90': 'viewed from the left side profile',
  '-45': 'viewed from a three-quarter left angle',
  '0': 'viewed straight from the front',
  '45': 'viewed from a three-quarter right angle',
  '90': 'viewed from the right side profile',
  '180': 'viewed from directly behind',
};

// ---------------------------------------------------------------------------
// Nearest-anchor lookup
// ---------------------------------------------------------------------------

test('nearestAnchorPhrase: an exact anchor returns its own phrase', () => {
  const { nearestAnchorPhrase } = loadTransforms();
  assert.equal(nearestAnchorPhrase(AZIMUTH, 45), 'viewed from a three-quarter right angle');
  assert.equal(nearestAnchorPhrase(AZIMUTH, -90), 'viewed from the left side profile');
  assert.equal(nearestAnchorPhrase(AZIMUTH, '0'), 'viewed straight from the front');
});

test('nearestAnchorPhrase: between anchors the closer one wins', () => {
  const { nearestAnchorPhrase } = loadTransforms();
  // 30 is 15 away from 45 and 30 away from 0 → the 45 phrase.
  assert.equal(nearestAnchorPhrase(AZIMUTH, 30), 'viewed from a three-quarter right angle');
  // -60 is 15 away from -45 and 30 away from -90 → the -45 phrase.
  assert.equal(nearestAnchorPhrase(AZIMUTH, -60), 'viewed from a three-quarter left angle');
  // An exact midpoint resolves deterministically to the lower anchor.
  assert.equal(nearestAnchorPhrase({ '0': 'low', '10': 'high' }, 5), 'low');
});

test('nearestAnchorPhrase: an empty or missing map yields an empty phrase', () => {
  const { nearestAnchorPhrase } = loadTransforms();
  assert.equal(nearestAnchorPhrase({}, 45), '');
  assert.equal(nearestAnchorPhrase(null, 45), '');
  assert.equal(nearestAnchorPhrase(undefined, 45), '');
  assert.equal(nearestAnchorPhrase(AZIMUTH, Number.NaN), '');
});

test('nearestAnchorPhrase: values outside the range clamp to the boundary phrase', () => {
  const { nearestAnchorPhrase } = loadTransforms();
  const intensity = { '0': '', '40': 'subtly', '70': 'clearly', '100': 'dramatically' };
  // Range boundaries: below the lowest anchor → lowest phrase, above the
  // highest anchor → highest phrase (the intensity word at each end).
  assert.equal(nearestAnchorPhrase(intensity, -25), '');
  assert.equal(nearestAnchorPhrase(intensity, 0), '');
  assert.equal(nearestAnchorPhrase(intensity, 100), 'dramatically');
  assert.equal(nearestAnchorPhrase(intensity, 250), 'dramatically');
  assert.equal(nearestAnchorPhrase(intensity, 55), 'subtly');
  assert.equal(nearestAnchorPhrase(intensity, 56), 'clearly');
});

// ---------------------------------------------------------------------------
// Template substitution
// ---------------------------------------------------------------------------

const ORBIT = {
  id: 'test-orbit',
  family: 'angles',
  name: 'Test orbit',
  template: 'Recreate the subject: {azimuth} {tilt} {zoom}. Keep everything else identical.',
  params: {
    azimuth: { anchors: AZIMUTH },
    tilt: { anchors: { '-30': 'from a low angle', '0': 'at eye level', '30': 'from a high angle' } },
    zoom: { anchors: { '0.5': 'wide shot', '1': '', '2': 'close-up framing' } },
  },
};

test('buildTransformPrompt: substitutes the nearest phrase for every parameter', () => {
  const { buildTransformPrompt } = loadTransforms();
  const prompt = buildTransformPrompt(ORBIT, { azimuth: 45, tilt: 30, zoom: 2 });
  assert.equal(prompt, 'Recreate the subject: viewed from a three-quarter right angle from a high angle close-up framing. Keep everything else identical.');
});

test('buildTransformPrompt: slots resolving to no phrase are stripped cleanly', () => {
  const { buildTransformPrompt } = loadTransforms();
  // zoom = 1 maps to the empty phrase → the slot disappears without
  // leaving double spaces or stray punctuation behind.
  const prompt = buildTransformPrompt(ORBIT, { azimuth: 0, tilt: 0, zoom: 1 });
  assert.equal(prompt, 'Recreate the subject: viewed straight from the front at eye level. Keep everything else identical.');
  // A parameter with no supplied value is stripped the same way.
  const partial = buildTransformPrompt(ORBIT, { azimuth: 90 });
  assert.equal(partial, 'Recreate the subject: viewed from the right side profile. Keep everything else identical.');
  assert.ok(!prompt.includes('{') && !prompt.includes('}'));
  assert.ok(!partial.includes('  '));
});

// ---------------------------------------------------------------------------
// Starter preset set (locally authored — FEAT-B2 catalog stays blocked)
// ---------------------------------------------------------------------------

test('starter presets: both families ship, flagged locally authored, slots match params', () => {
  const T = loadTransforms();
  const angles = T.listTransformPresets('angles');
  const effects = T.listTransformPresets('effects');
  assert.ok(angles.length >= 1, 'angles family ships at least one preset');
  assert.ok(effects.length >= 1, 'effects family ships at least one preset');
  for (const preset of [...angles, ...effects]) {
    assert.equal(preset.locallyAuthored, true, `${preset.id} is flagged locally authored`);
    const slots = [...preset.template.matchAll(/\{([A-Za-z][\w-]*)\}/g)].map(match => match[1]);
    assert.ok(slots.length >= 1, `${preset.id} template has slots`);
    for (const slot of slots) {
      assert.ok(preset.params[slot], `${preset.id} template slot {${slot}} has a param map`);
      assert.ok(Object.keys(preset.params[slot].anchors).length >= 2, `${preset.id}.${slot} has anchors`);
    }
  }
  assert.equal(T.getTransformPreset(angles[0].id).family, 'angles');
  assert.equal(T.getTransformPreset('does-not-exist'), null);
});

// ---------------------------------------------------------------------------
// Execution contract: ONE image job, source as the sole reference
// ---------------------------------------------------------------------------

test('buildTransformJob: one image job whose only attachment is the source image', () => {
  const T = loadTransforms();
  const preset = T.listTransformPresets('angles')[0];
  const source = { assetName: 'asset:hero', kind: 'image' };
  const job = T.buildTransformJob({ presetId: preset.id, values: { azimuth: 45 }, source });
  assert.equal(job.operation, 'flow.generation.submit');
  assert.equal(job.payload.type, 'image');
  assert.deepEqual(plain(job.payload.attachments), [source]);
  assert.equal(job.payload.attachments.length, 1);
  assert.equal(job.payload.prompt, T.buildTransformPrompt(preset, { azimuth: 45 }));
  assert.equal(job.metadata.transform.presetId, preset.id);
  assert.equal(job.metadata.transform.family, 'angles');
});

test('buildTransformJob: refuses to build without a source image', () => {
  const T = loadTransforms();
  const preset = T.listTransformPresets('effects')[0];
  assert.throws(
    () => T.buildTransformJob({ presetId: preset.id, values: {}, source: null }),
    error => error.code === 'FLOW_TRANSFORM_SOURCE_REQUIRED',
  );
  assert.throws(
    () => T.buildTransformJob({ presetId: 'nope', values: {}, source: { assetName: 'asset:x' } }),
    error => error.code === 'FLOW_TRANSFORM_PRESET_NOT_FOUND',
  );
});

// ---------------------------------------------------------------------------
// Sidebar wiring (source contracts)
// ---------------------------------------------------------------------------

test('sidebar wiring: Tools buttons open the transform panel and apply enqueues one job', () => {
  assert.ok(sidebarHtml.includes('<script src="../content/shared/flow-transforms.js"></script>'), 'sidebar.html loads flow-transforms.js');
  assert.ok(sidebarHtml.indexOf('flow-transforms.js') < sidebarHtml.indexOf('<script src="sidebar.js"></script>'), 'transforms load before sidebar.js');
  assert.ok(sidebarHtml.includes('id="flowTransformPanel"'), 'sidebar.html has the transform panel');
  assert.ok(sidebarHtml.includes('id="flowTransformPreset"'), 'panel has a preset select');
  assert.ok(sidebarHtml.includes('id="btnApplyTransform"'), 'panel has an apply button');
  assert.ok(sidebarSource.includes('anglesToolbarBtn'), 'sidebar.js wires the Angles button');
  assert.ok(sidebarSource.includes('effectsToolbarBtn'), 'sidebar.js wires the Effects button');
  assert.ok(sidebarSource.includes('FlowTransforms.buildTransformJob'), 'apply path builds the job through the shared engine');
  assert.ok(sidebarSource.includes('referencePicker.getReferences("image")'), 'the source image comes from the reference picker');
});
