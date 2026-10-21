import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { sceneSchema } from '../dist/schemas.js';

const source = readFileSync(new URL('../extension/content/providers/flow/FlowComponents.js', import.meta.url), 'utf8');

test('Flow voice input is accepted for text video and rejected for image or frame generation', () => {
  assert.equal(sceneSchema.safeParse({ prompt: 'A test', type: 'video', voice: 'Kore' }).success, true);
  assert.equal(sceneSchema.safeParse({ prompt: 'A test', type: 'image', voice: 'Kore' }).success, false);
  assert.equal(sceneSchema.safeParse({ prompt: 'A test', type: 'video', voice: 'Kore', first_frame: 'asset:start' }).success, false);
});

test('voice picker replaces only voice chips and confirms the exact selected chip', async () => {
  let pickerOpen = false;
  let voiceTabSelected = false;
  const chips = [];
  const removeVoice = {
    label: 'Remove voice',
    getAttribute: () => null,
    click() { chips.splice(chips.indexOf(oldVoiceChip), 1); },
  };
  const oldVoiceChip = {
    className: 'ingredient-voice-chip',
    label: 'Voice: Old Voice',
    querySelectorAll: selector => selector === 'button,[role="button"]' ? [removeVoice] : [],
    getAttribute: () => null,
  };
  const referenceChip = { className: 'image-ingredient-chip', label: 'Ingredient: Mug', getAttribute: () => null, querySelectorAll: () => [] };
  chips.push(oldVoiceChip, referenceChip);
  const newVoiceChip = {
    className: 'ingredient-voice-chip', label: 'Voice: Kore',
    querySelectorAll: () => [], getAttribute: () => null,
  };
  const option = {
    label: 'Kore', getAttribute: () => null, querySelectorAll: () => [],
    click() { chips.push(newVoiceChip); },
  };
  const list = {
    getAttribute: name => name === 'role' ? 'listbox' : null,
    querySelectorAll: selector => selector === '[role="option"]' ? [option] : [],
    closest: () => null,
    innerText: 'Kore',
  };
  const voiceTab = {
    label: 'Voices', getAttribute: name => name === 'aria-selected' ? String(voiceTabSelected) : null,
    click() { voiceTabSelected = true; },
  };
  const opener = { click() { pickerOpen = true; } };
  const closer = { click() { pickerOpen = false; } };
  const editor = { isContentEditable: true, parentElement: null };
  const submit = {};
  const composer = { className: 'flow-composer', contains: node => node === editor || node === submit || node === opener,
    querySelectorAll: selector => selector.includes('voice-chip') ? chips.filter(chip => chip.className.includes('voice-chip')) : selector === 'button,[role="button"],mat-button,[tabindex="0"]' ? [opener] : [] };
  editor.parentElement = composer;
  const document = {
    querySelectorAll(selector) {
      if (selector === '[role="tab"]') return [voiceTab];
      if (selector === '[role="progressbar"],[aria-busy="true"]') return [];
      if (selector === '[role="listbox"]') return pickerOpen ? [list] : [];
      if (selector === '[role="dialog"],[role="menu"],[role="listbox"],mat-menu,mat-select-panel') return pickerOpen ? [list] : [];
      return [];
    },
    querySelector(selector) { return selector.includes('.ProseMirror') ? editor : selector.includes("composer") || selector.includes("prompt-box") ? composer : null; },
    dispatchEvent() { return true; },
    activeElement: null,
  };
  const context = vm.createContext({
    document, location: { href: 'https://flow.google.com/project/test', pathname: '/project/test' }, Date, Map, Set, Promise, Object, String, Number, Boolean, Array, Math, URL,
    KeyboardEvent: class { constructor(type, options) { this.type = type; Object.assign(this, options); } },
    visible: () => true,
    accessibleName: element => element?.label || '',
    flowQuery: key => key === 'composerRoot' ? composer : key === 'editor' ? editor : key === 'components.listBox' ? (pickerOpen ? list : null) : null,
    flowQueryAll: (key, scope) => key === 'components.voiceChip' ? chips.filter(chip => chip.className.includes('voice-chip')) : key === 'components.optionItem' && scope === list ? [option] : [],
    flowButton: name => name === 'Add ingredients to the prompt box' ? opener : name === 'Close' ? closer : null,
    FlowEditor: { getFlowSubmitButton: () => submit },
    wait: async () => {},
    flowError: (code, message, retryable, outcome_unknown) => Object.assign(new Error(message), { code, retryable, outcome_unknown }),
  });
  vm.runInContext(source, context);
  const result = await context.FlowComponents.selectNativeFlowVoice('Kore', { deadline: Date.now() + 3000 });
  assert.equal(result.confirmed, true);
  assert.equal(chips.includes(referenceChip), true);
  assert.equal(chips.includes(oldVoiceChip), false);
  assert.equal(chips.includes(newVoiceChip), true);
  assert.equal(pickerOpen, false);
});

test('voice picker restores the composer add trigger from Video Frames and confirms Ingredients mode', async () => {
  let mode = 'Frames';
  let pickerOpen = false;
  let voiceTabSelected = false;
  const voiceChip = { className: 'ingredient-voice-chip', label: 'Voice: Kore', querySelectorAll: () => [] };
  const option = { label: 'Kore', getAttribute: () => null, querySelectorAll: () => [], click() { chips.push(voiceChip); } };
  const chips = [];
  const list = { getAttribute: name => name === 'role' ? 'listbox' : null, querySelectorAll: selector => selector === '[role="option"]' ? [option] : [], closest: () => null, innerText: 'Kore' };
  const tab = { label: 'Voices', getAttribute: name => name === 'aria-selected' ? String(voiceTabSelected) : null, click() { voiceTabSelected = true; } };
  const opener = { click() { pickerOpen = true; } };
  const close = { click() { pickerOpen = false; } };
  const settings = { label: 'Settings', visible: true, click() {}, getAttribute: () => null, querySelector: () => null };
  const frames = { label: 'Frames', selected: true };
  const ingredients = { label: 'Ingredients', selected: false };
  const editor = { isContentEditable: true, parentElement: null };
  const submit = {};
  const composer = { className: 'flow-composer', contains: node => node === editor || node === submit || node === opener || node === settings,
    querySelectorAll: selector => selector.includes('voice-chip') ? chips : selector === 'button,[role="button"],mat-button,[tabindex="0"]' ? [settings, ...(mode === 'Ingredients' ? [opener] : [])] : [] };
  editor.parentElement = composer;
  const document = {
    querySelectorAll(selector) {
      if (selector === '[role="tab"]') return [tab];
      if (selector === '[role="progressbar"],[aria-busy="true"]') return [];
      if (selector === '[role="listbox"]') return pickerOpen ? [list] : [];
      if (selector === '[role="dialog"],[role="menu"],[role="listbox"],mat-menu,mat-select-panel') return pickerOpen ? [list] : [];
      return [];
    },
    querySelector(selector) { return selector.includes('.ProseMirror') ? editor : selector.includes('composer') || selector.includes('prompt-box') ? composer : null; },
    dispatchEvent() { return true; }, activeElement: null,
  };
  const context = vm.createContext({
    document, location: { href: 'https://flow.google.com/project/test', pathname: '/project/test' }, Date, Map, Set, Promise, Object, String, Number, Boolean, Array, Math, URL,
    KeyboardEvent: class { constructor(type, options) { this.type = type; Object.assign(this, options); } },
    visible: () => true, accessibleName: element => element?.label || '',
    isFlowProjectNavigationControl: () => false,
    flowQuery: key => key === 'editor' ? editor : key === 'composerRoot' ? composer : key === 'components.listBox' ? (pickerOpen ? list : null) : null,
    flowQueryAll: (key, scope) => key === 'components.optionItem' && scope === list ? [option] : [],
    flowButton: name => name === 'Add ingredients to the prompt box' ? (mode === 'Ingredients' ? opener : null) : name === 'Settings trigger' ? settings : name === 'Close' ? close : null,
    FlowEditor: { getFlowSubmitButton: () => submit },
    FlowSettings: {
      openFlowSettings: async () => {},
      flowRadio: name => name === 'Frames' ? frames : name === 'Ingredients' ? ingredients : null,
      nativeRadioSelected: radio => radio.selected === true,
      chooseRadio: async name => { mode = name; frames.selected = name === 'Frames'; ingredients.selected = name === 'Ingredients'; },
      closeFlowSettings: async () => {},
    },
    wait: async () => {},
    flowError: (code, message, retryable, outcome_unknown) => Object.assign(new Error(message), { code, retryable, outcome_unknown }),
  });
  vm.runInContext(source, context);
  const result = await context.FlowComponents.selectNativeFlowVoice('Kore', { deadline: Date.now() + 3000 });
  assert.equal(result.confirmed, true);
  assert.equal(mode, 'Ingredients');
  assert.equal(frames.selected, false);
  assert.equal(ingredients.selected, true);
  assert.equal(chips.length, 1);
});

test('voice options inspection opens and closes its picker without selecting anything', async () => {
  let pickerOpen = false;
  let voiceTabSelected = false;
  let optionClicks = 0;
  const labels = ['Voice Alpha', 'Voice Beta'];
  const options = labels.map(label => ({
    label, getAttribute: () => null, querySelectorAll: () => [],
    click() { optionClicks++; },
  }));
  const list = {
    scrollTop: 0, clientHeight: 200, scrollHeight: 200, innerText: labels.join('\n'),
    getAttribute: name => name === 'role' ? 'listbox' : null,
    querySelectorAll: selector => selector === '[role="option"]' ? options : [],
    closest: () => null,
  };
  const tab = {
    label: 'Voices',
    getAttribute: name => name === 'aria-selected' ? String(voiceTabSelected) : null,
    click() { voiceTabSelected = true; },
  };
  const opener = { click() { pickerOpen = true; } };
  const closer = { click() { pickerOpen = false; } };
  const editor = { isContentEditable: true, parentElement: null };
  const submit = {};
  const composer = { className: 'flow-composer', contains: node => node === editor || node === submit || node === opener,
    querySelectorAll: selector => selector === 'button,[role="button"],mat-button,[tabindex="0"]' ? [opener] : [] };
  editor.parentElement = composer;
  const document = {
    querySelectorAll(selector) {
      if (selector === '[role="tab"]') return [tab];
      if (selector === '[role="progressbar"],[aria-busy="true"]') return [];
      if (selector === '[role="listbox"]') return pickerOpen ? [list] : [];
      if (selector === '[role="dialog"],[role="menu"],[role="listbox"],mat-menu,mat-select-panel') return pickerOpen ? [list] : [];
      return [];
    },
    querySelector(selector) { return selector.includes('.ProseMirror') ? editor : selector.includes('composer') || selector.includes('prompt-box') ? composer : null; },
    dispatchEvent() { return true; },
    activeElement: null,
  };
  const context = vm.createContext({
    document, location: { href: 'https://flow.google.com/project/test', pathname: '/project/test' }, Date, Map, Set, Promise, Object, String, Number, Boolean, Array, Math, URL,
    KeyboardEvent: class { constructor(type, options) { this.type = type; Object.assign(this, options); } },
    visible: () => true,
    accessibleName: element => element?.label || '',
    flowQuery: key => key === 'composerRoot' ? composer : key === 'editor' ? editor : key === 'components.listBox' ? (pickerOpen ? list : null) : null,
    flowQueryAll: (key, scope) => key === 'components.optionItem' && scope === list ? options : [],
    flowButton: name => name === 'Add ingredients to the prompt box' ? opener : name === 'Close' ? closer : null,
    FlowEditor: { getFlowSubmitButton: () => submit },
    wait: async () => {},
    flowError: (code, message, retryable, outcome_unknown) => Object.assign(new Error(message), { code, retryable, outcome_unknown }),
  });
  vm.runInContext(source, context);
  const result = await context.FlowComponents.listNativeFlowVoiceOptions({ deadline: Date.now() + 3000 });
  assert.deepEqual(Array.from(result.voices), labels);
  assert.equal(result.source, 'flow_v2_picker');
  assert.equal(result.readOnly, true);
  assert.equal(optionClicks, 0);
  assert.equal(pickerOpen, false);
});

test('voice options scan scrolls the nested virtual list inside the listbox', async () => {
  let pickerOpen = false;
  let voiceTabSelected = false;
  let optionClicks = 0;
  let scrollTop = 0;
  const labels = ['Voice Alpha', 'Voice Beta', 'Voice Gamma', 'Voice Delta'];
  const options = () => {
    const start = Math.min(labels.length - 2, Math.floor(scrollTop / 80));
    return labels.slice(start, start + 2).map(label => ({
      label, getAttribute: () => null, querySelectorAll: () => [], click() { optionClicks++; },
    }));
  };
  const scroller = {
    clientHeight: 100, scrollHeight: 300,
    get scrollTop() { return scrollTop; },
    set scrollTop(value) { scrollTop = value; },
  };
  const list = {
    clientHeight: 0, scrollHeight: 0,
    getAttribute: name => name === 'role' ? 'listbox' : null,
    querySelectorAll: selector => selector === '[role="option"]' ? options() : selector === '*' ? [scroller] : [],
    closest: () => null,
  };
  const tab = { label: 'Voices', getAttribute: name => name === 'aria-selected' ? String(voiceTabSelected) : null, click() { voiceTabSelected = true; } };
  const opener = { click() { pickerOpen = true; } };
  const closer = { click() { pickerOpen = false; } };
  const editor = { isContentEditable: true, parentElement: null };
  const submit = {};
  const composer = { className: 'flow-composer', contains: node => node === editor || node === submit || node === opener,
    querySelectorAll: selector => selector === 'button,[role="button"],mat-button,[tabindex="0"]' ? [opener] : [] };
  editor.parentElement = composer;
  const document = {
    querySelectorAll(selector) {
      if (selector === '[role="tab"]') return [tab];
      if (selector === '[role="progressbar"],[aria-busy="true"]') return [];
      if (selector === '[role="listbox"]') return pickerOpen ? [list] : [];
      if (selector === '[role="dialog"],[role="menu"],[role="listbox"],mat-menu,mat-select-panel') return pickerOpen ? [list] : [];
      return [];
    },
    querySelector(selector) { return selector.includes('.ProseMirror') ? editor : selector.includes('composer') || selector.includes('prompt-box') ? composer : null; },
    dispatchEvent() { return true; }, activeElement: null,
  };
  const context = vm.createContext({
    document, location: { href: 'https://flow.google.com/project/test', pathname: '/project/test' }, Date, Map, Set, Promise, Object, String, Number, Boolean, Array, Math, URL,
    visible: () => true, accessibleName: element => element?.label || '',
    flowQuery: key => key === 'editor' ? editor : key === 'composerRoot' ? composer : key === 'components.listBox' ? (pickerOpen ? list : null) : null,
    flowQueryAll: (key, scope) => key === 'components.optionItem' && scope === list ? options() : [],
    flowButton: name => name === 'Add ingredients to the prompt box' ? opener : name === 'Close' ? closer : null,
    FlowEditor: { getFlowSubmitButton: () => submit },
    wait: async () => {},
    flowError: (code, message, retryable, outcome_unknown) => Object.assign(new Error(message), { code, retryable, outcome_unknown }),
  });
  vm.runInContext(source, context);
  const result = await context.FlowComponents.listNativeFlowVoiceOptions({ deadline: Date.now() + 3000 });
  assert.deepEqual(Array.from(result.voices), labels);
  assert.equal(optionClicks, 0);
  assert.equal(pickerOpen, false);
});

test('voice options inspection leaves a pre-existing non-voice picker untouched', async () => {
  let pickerOpen = true;
  let optionClicks = 0;
  const list = { getAttribute: name => name === 'role' ? 'listbox' : null, querySelectorAll: () => [], closest: () => null };
  const tab = { label: 'Characters', getAttribute: () => 'true', click() { optionClicks++; } };
  const document = { querySelectorAll: selector => selector === '[role="tab"]' ? [tab] : [], querySelector: () => null };
  const context = vm.createContext({
    document, location: { href: 'https://flow.google.com/project/test', pathname: '/project/test' }, Date, Map, Set, Promise, Object, String, Number, Boolean, Array, Math, URL,
    visible: () => true,
    accessibleName: element => element?.label || '',
    flowQuery: key => key === 'components.listBox' ? list : null,
    flowQueryAll: () => [],
    wait: async () => {},
    flowError: (code, message, retryable, outcome_unknown) => Object.assign(new Error(message), { code, retryable, outcome_unknown }),
  });
  vm.runInContext(source, context);
  await assert.rejects(context.FlowComponents.listNativeFlowVoiceOptions(), error => error.code === 'FLOW_VOICE_PICKER_ALREADY_OPEN');
  assert.equal(pickerOpen, true);
  assert.equal(optionClicks, 0);
});
