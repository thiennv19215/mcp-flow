import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Audit cluster E, item 4 — sidebar dual UI trees.
//
// The repo chose option (b): keep the visible/hidden pair design, but
// bind every pair in ONE function (bindGenerationControlSync, moved
// verbatim out of initGenerationControls) and pin its runtime behavior
// here. A single-tree merge was rejected: sidebar.js is 4000+ lines
// with ~60 read sites and no DOM harness, so merging would risk the
// whole Gen form for no behavioral gain.
//
// The test extracts bindGenerationControlSync from sidebar.js
// (brace-matched, not re-implemented) and drives it against stub
// elements: every pair must mirror in BOTH directions, and per-type
// pairs must only follow the active type.
// ---------------------------------------------------------------------------

function stubElement() {
  const listeners = {};
  const classes = new Set();
  const el = {
    value: '',
    checked: false,
    dataset: {},
    classList: {
      toggle: (name, force) => {
        if (force === undefined) { classes.has(name) ? classes.delete(name) : classes.add(name); }
        else if (force) classes.add(name);
        else classes.delete(name);
      },
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
    },
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    dispatchEvent: function (event) {
      if (event.target === undefined) event.target = this;
      for (const fn of (listeners[event.type] || [])) fn.call(this, event);
      return true;
    },
    setAttribute: () => {},
    getAttribute: () => null,
  };
  el.click = () => el.dispatchEvent({ type: 'click' });
  return el;
}

function bindHarness() {
  const source = readFileSync(new URL('../extension/src/ui/sidebar.js', import.meta.url), 'utf8');
  const start = source.indexOf('function bindGenerationControlSync()');
  assert.notEqual(start, -1, 'bindGenerationControlSync must exist in sidebar.js');
  const bodyOpen = source.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = bodyOpen; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  assert.notEqual(end, -1, 'bindGenerationControlSync body must close');
  const elements = new Map();
  const documentStub = {
    querySelector: (selector) => {
      if (!elements.has(selector)) elements.set(selector, stubElement());
      return elements.get(selector);
    },
    querySelectorAll: () => [],
  };
  class EventStub {
    constructor(type, options = {}) { this.type = type; this.bubbles = Boolean(options.bubbles); }
  }
  const sandbox = { document: documentStub, Event: EventStub, console };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(source.slice(start, end), context);
  context.bindGenerationControlSync();
  const el = (selector) => documentStub.querySelector(selector);
  const change = (selector, value) => {
    const element = el(selector);
    element.value = value;
    element.dispatchEvent(new EventStub('change', { bubbles: true }));
  };
  return { el, change };
}

test('model selects mirror visible -> hidden and dispatch change', () => {
  const { el, change } = bindHarness();
  let hiddenChanges = 0;
  el('#selectModelImage').addEventListener('change', () => hiddenChanges++);
  change('#imageModel', 'nano-banana');
  assert.equal(el('#selectModelImage').value, 'nano-banana');
  assert.equal(hiddenChanges, 1, 'hidden model change must dispatch for rule listeners');
  change('#videoModel', 'veo-3');
  assert.equal(el('#selectModelVideo').value, 'veo-3');
});

test('duration and resolution mirror in both directions', () => {
  const { el, change } = bindHarness();
  change('#flowVideoDuration', '8');
  assert.equal(el('#selectDurationVideo').value, '8');
  change('#selectDurationVideo', '4');
  assert.equal(el('#flowVideoDuration').value, '4');
  change('#flowVideoResolution', '1080p');
  assert.equal(el('#selectResolutionVideo').value, '1080p');
  change('#selectResolutionVideo', '720p');
  assert.equal(el('#flowVideoResolution').value, '720p');
});

test('aspect ratio: forward to both hidden; reverse only for the active type', () => {
  const { el, change } = bindHarness();
  change('#aspectRatio', '16:9');
  assert.equal(el('#selectRatioImage').value, '16:9');
  assert.equal(el('#selectRatioVideo').value, '16:9');
  // Active type defaults to image: image hidden drives visible, video hidden does not.
  el('#genType').value = 'image';
  change('#selectRatioImage', '9:16');
  assert.equal(el('#aspectRatio').value, '9:16');
  change('#selectRatioVideo', '1:1');
  assert.equal(el('#aspectRatio').value, '9:16', 'inactive type must not move the visible ratio');
  el('#genType').value = 'video';
  change('#selectRatioVideo', '1:1');
  assert.equal(el('#aspectRatio').value, '1:1');
});

test('quantity: input and buttons clamp and mirror; reverse gated by type', () => {
  const { el, change } = bindHarness();
  change('#quantitySelect', '9');
  assert.equal(el('#quantitySelect').value, '4');
  assert.equal(el('#selectQtyImage').value, '4');
  assert.equal(el('#selectCountVideo').value, '4');
  el('#quantitySelect').value = '2';
  el('#genQtyPlus').click();
  assert.equal(el('#quantitySelect').value, '3');
  el('#genQtyMinus').click();
  el('#genQtyMinus').click();
  assert.equal(el('#quantitySelect').value, '1');
  el('#genType').value = 'video';
  change('#selectCountVideo', '2');
  assert.equal(el('#quantitySelect').value, '2');
  el('#genType').value = 'image';
  change('#selectCountVideo', '4');
  assert.equal(el('#quantitySelect').value, '2', 'inactive type must not move the visible quantity');
});

test('restore writes both trees, not just the hidden selects', () => {
  // applyGenTemplateToComposer used to write only the hidden selects
  // (plus visible duration/resolution), leaving the visible ratio /
  // model / quantity / mode controls — and the image builder, which
  // reads #aspectRatio first — on pre-restore values.
  const source = readFileSync(new URL('../extension/src/ui/sidebar.js', import.meta.url), 'utf8');
  const start = source.indexOf('function applyGenTemplateToComposer');
  const end = source.indexOf('function renderGenTemplates', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const body = source.slice(start, end);
  for (const visible of ['"#aspectRatio"', '"#videoModel"', '"#imageModel"', '"#quantitySelect"', '"#videoInputType"']) {
    assert.match(body, new RegExp(`setValue\\(${visible.replace(/"/g, '"')}`), `restore must write visible ${visible}`);
  }
  assert.match(body, /updateVoiceUiState\(payload\.voice\)/, 'restore must sync the voice label and hidden voice select together');
});

test('mode: visible drives hidden plus section toggles; hidden drives visible value', () => {
  const { el, change } = bindHarness();
  change('#videoInputType', 'frames');
  assert.equal(el('#selectModeVideo').value, 'frames');
  assert.equal(el('#videoFramesSection').classList.contains('hidden'), false);
  assert.equal(el('#genVideoVoiceContainer').classList.contains('hidden'), true);
  change('#videoInputType', 'ingredients');
  assert.equal(el('#selectModeVideo').value, 'ingredients');
  assert.equal(el('#videoFramesSection').classList.contains('hidden'), true);
  change('#selectModeVideo', 'frames');
  assert.equal(el('#videoInputType').value, 'frames');
});
