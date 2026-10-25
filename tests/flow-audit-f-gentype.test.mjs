import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

// Audit cluster F, item 9: setGenType used to live INSIDE initGenerationControls,
// so the `typeof setGenType === "function"` guard in applyGenTemplateToComposer
// always skipped and the gen-type toggle buttons went stale after a template
// restore. setGenType is now an IIFE-level function (it only touches
// document/I18n/referencePicker, all IIFE-level) and restore calls it directly.

const source = readFileSync(new URL('../extension/src/ui/sidebar.js', import.meta.url), 'utf8');

function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must be declared`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

function functionBodySpan(src, name) {
  const start = src.indexOf(`function ${name}(`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return [start, i + 1];
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

function makeElement() {
  const classes = new Set();
  return {
    value: '',
    checked: false,
    hidden: false,
    dataset: {},
    textContent: '',
    classList: {
      toggle: (name, force) => { if (force) classes.add(name); else classes.delete(name); },
      add: name => classes.add(name),
      remove: name => classes.delete(name),
      contains: name => classes.has(name),
    },
    setAttribute: () => {},
    _classes: classes,
  };
}

function runRestore(job) {
  const elements = new Map();
  const el = sel => {
    if (!elements.has(sel)) elements.set(sel, makeElement());
    return elements.get(sel);
  };
  const imgBtn = makeElement(); imgBtn.dataset.value = 'image';
  const vidBtn = makeElement(); vidBtn.dataset.value = 'video';
  const calls = { feedback: [], voice: [], renderCards: [], frameInputs: 0 };
  const sandbox = {
    document: {
      querySelector: sel => el(sel),
      querySelectorAll: sel => (sel === '#genTypeToggle .gen-type-btn' ? [imgBtn, vidBtn] : []),
    },
    I18n: { getLocale: () => 'vi' },
    referencePicker: { renderReferenceCards: type => calls.renderCards.push(type) },
    updateVideoFrameInputs: () => { calls.frameInputs++; },
    setFeedback: (msg, ok) => calls.feedback.push([msg, ok]),
    updateVoiceUiState: voice => calls.voice.push(voice),
    t: (key, fallback) => (typeof fallback === 'string' ? fallback : key),
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(`${extractFunction(source, 'setGenType')}\n${extractFunction(source, 'applyGenTemplateToComposer')}`, context);
  vm.runInContext(`applyGenTemplateToComposer(${JSON.stringify(job)})`, context);
  return { elements, imgBtn, vidBtn, calls };
}

test('setGenType is declared at IIFE level, not nested in initGenerationControls', () => {
  const [initStart, initEnd] = functionBodySpan(source, 'initGenerationControls');
  const decl = source.indexOf('function setGenType(');
  assert.notEqual(decl, -1, 'setGenType must be declared');
  assert.ok(decl < initStart || decl > initEnd, 'setGenType declaration must sit outside initGenerationControls');
  assert.doesNotMatch(source, /typeof setGenType/, 'the always-skipping guard must be gone');
  assert.match(source, /setGenType\(type\);/, 'restore must call setGenType directly');
});

test('template restore to video updates the gen-type toggle (not just the hidden select)', () => {
  const { elements, imgBtn, vidBtn, calls } = runRestore({ payload: { type: 'video', prompt: 'p', aspectRatio: '9:16', count: 2, mode: 'text', model: 'm' } });
  assert.equal(elements.get('#genType').value, 'video');
  assert.equal(vidBtn._classes.has('active'), true, 'video toggle button must become active');
  assert.equal(imgBtn._classes.has('active'), false, 'image toggle button must deactivate');
  assert.equal(elements.get('#videoModelContainer')._classes.has('hidden'), false);
  assert.equal(elements.get('#imageModelContainer')._classes.has('hidden'), true);
  assert.equal(calls.frameInputs, 1, 'video mode changes should refresh the active Frames UI');
});

test('template restore to image flips the toggle back', () => {
  const { elements, imgBtn, vidBtn, calls } = runRestore({ payload: { type: 'image', prompt: 'p', aspectRatio: '16:9', count: 1, model: 'm' } });
  assert.equal(elements.get('#genType').value, 'image');
  assert.equal(imgBtn._classes.has('active'), true);
  assert.equal(vidBtn._classes.has('active'), false);
  assert.equal(elements.get('#imageModelContainer')._classes.has('hidden'), false);
  assert.equal(elements.get('#videoModelContainer')._classes.has('hidden'), true);
  assert.equal(calls.frameInputs, 1, 'image mode changes should restore the regular picker UI');
});
