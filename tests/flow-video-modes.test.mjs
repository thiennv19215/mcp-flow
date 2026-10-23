import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { shapes } from '../dist/schemas.js';
import { planFlowAgentBatch, planFlowContinue, planFlowEdit } from '../extension/src/background/flow-workflows.js';

const workflowSource = readFileSync(new URL('../extension/src/content/providers/flow/workflows/workflow-operations.js', import.meta.url), 'utf8');
const agentSource = readFileSync(new URL('../extension/src/content/providers/flow/agent/flow-agent.js', import.meta.url), 'utf8');
const settingsSource = [
  '../extension/src/content/providers/flow/core/settings.js',
  '../extension/src/content/providers/flow/generation/image-settings.js',
  '../extension/src/content/providers/flow/generation/video-settings.js',
].map(file => readFileSync(new URL(file, import.meta.url), 'utf8')).join('\n');

test('video option lookup skips an unrelated earlier overlay and uses the settings panel', async () => {
  const makeOption = (label, selected = false) => ({
    label, visible: true, checked: selected, classList: [],
    closest: () => null,
    getAttribute(name) { return name === 'aria-checked' ? String(this.checked) : null; },
    querySelector: () => null,
    click() { this.checked = true; },
  });
  const addMenu = { visible: true, querySelector: () => null, querySelectorAll: () => [] };
  const ratio = makeOption('16:9');
  const settingsOptions = [makeOption('Image'), makeOption('Video'), makeOption('x1'), ratio];
  const settings = {
    visible: true,
    querySelector(selector) { return selector.includes('[role="radio"]') ? settingsOptions[0] : null; },
    querySelectorAll() { return settingsOptions; },
  };
  const context = vm.createContext({
    Date, Map, Promise, Set, Object, Math, String, Number, Boolean, Array, Error,
    document: { querySelectorAll: () => [addMenu, settings], querySelector: () => null },
    visible: element => element.visible !== false,
    accessibleName: element => element.label || '',
    normalizeAspectRatio: value => value,
    normalizeFlowUiText: value => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim(),
    flowError: (code, message) => Object.assign(new Error(message), { code }),
  });
  vm.runInContext(settingsSource, context);
  await context.FlowSettings.chooseVideoOption('ratio', '16:9');
  assert.equal(ratio.checked, true);
});

test('quote diagnostics expose only fixed reason codes, never nearby prompt text or quote values', () => {
  const secret = 'secret-prompt-7f4d2a';
  const context = vm.createContext({
    Date, Map, Promise, Set, Object, Math, String, Number, Boolean, Array, Error,
    document: { querySelectorAll: () => [], querySelector: () => null },
    FlowEditor: { inspectGenerationCreditQuote: () => ({ quote: undefined, candidates: [`${secret} will use credits` ] }) },
    visible: () => false,
    normalizeFlowUiText: value => String(value || '').toLowerCase().trim(),
  });
  vm.runInContext(settingsSource, context);
  const serialized = JSON.stringify(context.FlowSettings.safeCreditQuoteDiagnostics());
  assert.deepEqual(JSON.parse(serialized), {
    candidateCount: 1,
    reasonCodes: ['unrecognized_credit_text'],
  });
  assert.equal(serialized.includes(secret), false);
});

test('image quote diagnostics distinguish no candidate without exposing account balance', () => {
  const context = vm.createContext({
    Date, Map, Promise, Set, Object, Math, String, Number, Boolean, Array, Error,
    document: { querySelectorAll: () => [], querySelector: () => null },
    FlowEditor: { inspectGenerationCreditQuote: () => ({ quote: undefined, candidates: [] }) },
    visible: () => false,
    normalizeFlowUiText: value => String(value || '').toLowerCase().trim(),
  });
  vm.runInContext(settingsSource, context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.FlowSettings.safeCreditQuoteDiagnostics())), {
    candidateCount: 0,
    reasonCodes: ['no_candidate'],
  });
});

test('image quote diagnostics distinguish unrecognized visible quote text', () => {
  const context = vm.createContext({
    Date, Map, Promise, Set, Object, Math, String, Number, Boolean, Array, Error,
    document: { querySelectorAll: () => [], querySelector: () => null },
    FlowEditor: { inspectGenerationCreditQuote: () => ({ quote: undefined, candidates: ['Quote this generation: 12 credits'] }) },
    visible: () => false,
    normalizeFlowUiText: value => String(value || '').toLowerCase().trim(),
  });
  vm.runInContext(settingsSource, context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.FlowSettings.safeCreditQuoteDiagnostics())), {
    candidateCount: 1,
    reasonCodes: ['unrecognized_credit_text'],
  });
});

test('quote failure cleanup closes only a settings surface opened by video preparation', async () => {
  const settingsControls = ['Image', 'Video', 'x1'].map(label => ({
    label, visible: true, classList: [], closest: () => null,
    getAttribute: () => null, querySelector: () => null,
  }));
  let closeCount = 0;
  const panel = {
    visible: true,
    querySelector: () => settingsControls[0],
    querySelectorAll: () => settingsControls,
  };
  const context = vm.createContext({
    Date, Map, Promise, Set, Object, Math, String, Number, Boolean, Array, Error,
    document: { querySelectorAll: () => [panel], querySelector: () => null },
    visible: element => element.visible !== false,
    accessibleName: element => element.label || '',
    normalizeFlowUiText: value => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim(),
    dispatchEscapeKey: () => { closeCount++; panel.visible = false; },
    flowError: (code, message) => Object.assign(new Error(message), { code }),
  });
  vm.runInContext(settingsSource, context);
  const primaryError = new Error('quote read failed');
  await assert.rejects((async () => {
    try { await Promise.reject(primaryError); }
    finally { await context.FlowSettings.closeOwnedSettingsSurface(true); }
  })(), error => error === primaryError);
  assert.equal(closeCount, 1);

  panel.visible = true;
  closeCount = 0;
  await context.FlowSettings.closeOwnedSettingsSurface(false);
  assert.equal(panel.visible, true);
  assert.equal(closeCount, 0);
  assert.match(settingsSource, /finally\s*\{\s*await closeOwnedSettingsSurface\(ownsSettingsSurface, options\);/);
});

function agentModeHarness({ composerControls = [], outsideControls = [], dialogs = [], onWait } = {}) {
  const composer = { querySelectorAll: () => composerControls };
  const context = vm.createContext({
    Date, Map, Promise, Set, Object, Math, String, Number, Boolean, Array, Error,
    document: {
      activeElement: null,
      querySelector: selector => selector === 'flow-base-prompt-box,.flow-composer' ? composer : null,
      querySelectorAll: () => [...dialogs, ...outsideControls],
    },
    flowQuery: path => path === 'composerRoot' ? composer : null,
    flowButton: (name, scope) => name === 'Save' && scope ? scope.saveButton || null : null,
    visible: element => element.visible !== false,
    accessibleName: element => element.label || '',
    wait: async ms => { await onWait?.(ms); },
    flowError: (code, message, retryable, outcome_unknown) => Object.assign(new Error(message), { code, retryable, outcome_unknown }),
  });
  vm.runInContext(agentSource, context);
  return { agent: context.FlowAgent };
}

function agentModeButton(pressed, { label = 'Agent', onClick } = {}) {
  return {
    label,
    visible: true,
    getAttribute: name => name === 'aria-pressed' ? String(pressed.value) : null,
    click() { if (onClick) onClick(pressed); },
  };
}

function workflowHarness({ requestSeen = true, clickDelivered = true, boundedWait, agentPressed = true } = {}) {
  const correlations = new Map();
  let disarmed = false;
  const tiles = {
    async armNativeFlowCorrelation() {
      correlations.set('attempt-1', { requestSeen, interfered: false });
      return 'attempt-1';
    },
    nativeFlowCorrelationMap: () => correlations,
    disarmNativeFlowCorrelation: id => { disarmed = true; correlations.delete(id); },
    emitFlowProgress() {},
  };
  const editor = {
    currentFlowSubmitErrors: () => [],
    waitForGenerationSubmitButton: async () => ({ disabled: false, getAttribute: () => null }),
    activateFlowSubmitButton: async () => ({ clickDelivered, strategy: 'test' }),
  };
  const context = vm.createContext({
    Date, Map, Promise, Set, Object, Math, String, Number, Boolean, Array, Error,
    setTimeout, clearTimeout,
    location: { href: 'https://flow.google.com/project/00000000-0000-4000-8000-000000000000' },
    ProviderRegistry: { describeUrl: () => ({ projectId: '00000000-0000-4000-8000-000000000000' }) },
    FlowUiDeadline: {
      makeDeadline: (_command, ms) => Date.now() + ms,
      requireTime: (deadline, operation, outcomeUnknown = false) => {
        if (Date.now() >= deadline) throw Object.assign(new Error(`Timed out ${operation}`), { code: 'FLOW_OPERATION_TIMEOUT', outcome_unknown: outcomeUnknown });
      },
      boundedWait: boundedWait || (async () => {}),
    },
    FlowTiles: tiles,
    flowButton: name => name === 'Agent' ? { getAttribute: key => key === 'aria-pressed' ? String(agentPressed) : null } : null,
  });
  vm.runInContext(workflowSource, context);
  const driver = { error: (code, message, retryable, outcome_unknown) => Object.assign(new Error(message), { code, retryable, outcome_unknown }) };
  return { ops: new context.FlowWorkflowOperations(driver), editor, tiles, correlations, wasDisarmed: () => disarmed };
}

test('video submit helper returns only after a correlated request dispatch', async () => {
  const { ops, editor, tiles, wasDisarmed } = workflowHarness({ requestSeen: true });
  const result = await ops.submitAndConfirmDispatch({
    editor, tiles, command: {}, prompt: 'one exact test prompt', deadline: Date.now() + 2_000,
  });
  assert.equal(result.requestDispatched, true);
  assert.equal(result.serverAcceptanceObserved, false);
  assert.equal(result.activation, 'test');
  assert.equal(wasDisarmed(), true);
});

test('continuation submit requires unique verified UUIDs for the saved frame and every likeness reference', () => {
  const { ops } = workflowHarness();
  const frameId = '11111111-1111-4111-8111-111111111111';
  const characterId = '22222222-2222-4222-8222-222222222222';
  assert.deepEqual(Array.from(ops.validateContinuationReferenceIds(frameId)), [frameId]);
  assert.deepEqual(Array.from(ops.validateContinuationReferenceIds(frameId, [characterId], 1)), [frameId, characterId]);
  assert.throws(() => ops.validateContinuationReferenceIds(undefined), error =>
    error.code === 'FLOW_SUBMIT_CORRELATION_REFERENCE_ID_UNAVAILABLE' && error.outcome_unknown === false);
  assert.throws(() => ops.validateContinuationReferenceIds(frameId, [], 1), error =>
    error.code === 'FLOW_SUBMIT_CORRELATION_REFERENCE_ID_UNAVAILABLE' && error.outcome_unknown === false);
  assert.throws(() => ops.validateContinuationReferenceIds(frameId, ['not-a-uuid'], 1), error =>
    error.code === 'FLOW_SUBMIT_CORRELATION_REFERENCE_ID_UNAVAILABLE' && error.outcome_unknown === false);
  assert.throws(() => ops.validateContinuationReferenceIds(frameId, [frameId], 1), error =>
    error.code === 'FLOW_SUBMIT_CORRELATION_REFERENCE_ID_UNAVAILABLE' && error.outcome_unknown === false);
});

test('continuation resolves frame aliases and preserves composer state after submit-only or unknown outcomes', () => {
  const start = workflowSource.indexOf('if (name === "flow.continue.run")');
  const branch = workflowSource.slice(start);
  assert.match(branch, /resolveNativeMediaUuid\?\.\(rawFrameId, "image"\)/);
  assert.match(branch, /if \(params\.submit_only === true\)\s*\{\s*submitOnlyDispatched = true;/);
  assert.match(branch, /outcomeUnknown = Boolean\(error\?\.outcome_unknown\) \|\| submitted;/);
  assert.match(branch, /if \(!outcomeUnknown && !submitOnlyDispatched\) await agent\.resetNativeAgentWorkflow\(\)/);
});

test('a delivered click without dispatch evidence becomes unknown and cannot be retried safely', async () => {
  const boundedWait = async () => { throw Object.assign(new Error('dispatch wait timed out'), { code: 'FLOW_OPERATION_TIMEOUT', outcome_unknown: true }); };
  const { ops, editor, tiles, wasDisarmed } = workflowHarness({ requestSeen: false, boundedWait });
  await assert.rejects(
    ops.submitAndConfirmDispatch({ editor, tiles, command: {}, prompt: 'unknown outcome', deadline: Date.now() + 2_000 }),
    error => error.code === 'FLOW_OPERATION_TIMEOUT' && error.outcome_unknown === true,
  );
  assert.equal(wasDisarmed(), true);
});

test('a submit click that was not delivered is a definite pre-dispatch failure', async () => {
  const { ops, editor, tiles } = workflowHarness({ requestSeen: true, clickDelivered: false });
  await assert.rejects(
    ops.submitAndConfirmDispatch({ editor, tiles, command: {}, prompt: 'no click', deadline: Date.now() + 2_000 }),
    error => error.code === 'FLOW_SUBMIT_CLICK_NOT_DELIVERED' && error.outcome_unknown === false,
  );
});

test('Agent submit can confirm only a clearly one-run, explicitly zero-credit dialog', () => {
  let clicked = 0;
  const button = { label: 'Generate', visible: true, disabled: false, getAttribute: () => null, click: () => clicked++ };
  const dialog = { innerText: 'Generate one image? This run uses 0 credits.', visible: true, querySelectorAll: () => [button] };
  const context = vm.createContext({
    document: { querySelectorAll: () => [dialog] },
    visible: element => element.visible !== false,
    accessibleName: element => element.label || '',
  });
  vm.runInContext(agentSource, context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.FlowAgent.inspectAgentRunConfirmation())), {
    state: 'confirmed', credits: 0, one_run: true, label: 'Generate', text: 'Generate one image? This run uses 0 credits.',
    diagnostics: { visibleDialogCount: 1, confirmationSurfaceCount: 1, persistentSetting: false, oneRun: true, zeroCredits: true, matchingConfirmControls: 1 },
  });
  assert.equal(clicked, 1);

  clicked = 0;
  dialog.innerText = 'Generate one image? The credit cost is not shown.';
  const blocked = context.FlowAgent.inspectAgentRunConfirmation();
  assert.equal(blocked.state, 'blocked');
  assert.equal(blocked.reason, 'credit_quote_not_explicitly_zero');
  assert.equal(clicked, 0);

  dialog.innerText = 'Agent settings: Always ask. Generate one image? This run uses 0 credits.';
  const persistent = context.FlowAgent.inspectAgentRunConfirmation();
  assert.equal(persistent.state, 'blocked');
  assert.equal(persistent.reason, 'persistent_setting_dialog');
  assert.equal(clicked, 0);
});

test('Agent confirmation selects one exact nested dialog and rejects independent dialogs', () => {
  let clicks = 0;
  const button = { label: 'Generate', visible: true, disabled: false, getAttribute: () => null, click: () => { clicks++; } };
  const inner = { innerText: 'Generate one image? This run uses 0 credits.', visible: true, contains: () => false, querySelectorAll: () => [button] };
  const outer = { innerText: inner.innerText, visible: true, contains: element => element === inner, querySelectorAll: () => [button] };
  const independent = { innerText: 'Create one image? This run uses 0 credits.', visible: true, contains: () => false, querySelectorAll: () => [button] };
  const context = vm.createContext({
    document: { querySelectorAll: () => [outer, inner] },
    visible: element => element.visible !== false,
    accessibleName: element => element.label || '',
  });
  vm.runInContext(agentSource, context);
  const result = context.FlowAgent.inspectAgentRunConfirmation();
  assert.equal(result.state, 'confirmed');
  assert.equal(result.diagnostics.visibleDialogCount, 2);
  assert.equal(result.diagnostics.confirmationSurfaceCount, 1);
  assert.equal(clicks, 1);

  clicks = 0;
  context.document.querySelectorAll = () => [inner, independent];
  const blocked = context.FlowAgent.inspectAgentRunConfirmation();
  assert.equal(blocked.state, 'blocked');
  assert.equal(blocked.reason, 'confirmation_surface_ambiguous');
  assert.equal(blocked.diagnostics.confirmationSurfaceCount, 2);
  assert.equal(clicks, 0);
});

test('Agent dispatch checker confirms only free one-run dialogs and stops on unknown cost', async () => {
  const blockedHarness = workflowHarness({ requestSeen: false });
  await assert.rejects(blockedHarness.ops.submitAndConfirmDispatch({
    editor: blockedHarness.editor, tiles: blockedHarness.tiles, command: {}, prompt: 'one exact test prompt', deadline: Date.now() + 2_000,
    checkConfirmation: async () => ({ state: 'blocked', reason: 'credit_quote_not_explicitly_zero' }),
  }), error => error.code === 'FLOW_AGENT_CONFIRMATION_UNVERIFIED' && error.outcome_unknown === false);
  assert.equal(blockedHarness.wasDisarmed(), true);

  const freeHarness = workflowHarness({ requestSeen: false });
  const result = await freeHarness.ops.submitAndConfirmDispatch({
    editor: freeHarness.editor, tiles: freeHarness.tiles, command: {}, prompt: 'one exact test prompt', deadline: Date.now() + 2_000,
    checkConfirmation: async () => {
      freeHarness.correlations.get('attempt-1').requestSeen = true;
      return { state: 'confirmed', credits: 0, one_run: true, label: 'Generate', text: 'Generate one image? Uses 0 credits.' };
    },
  });
  assert.equal(result.requestDispatched, true);
  assert.equal(result.per_run_confirmation.credits, 0);
  assert.equal(freeHarness.wasDisarmed(), true);
});

test('Agent confirmation settings recognize Always ask and refuse auto-spend before opening settings', async () => {
  let queried = false;
  const context = vm.createContext({
    document: { querySelector: () => { queried = true; return null; }, querySelectorAll: () => [] },
    flowError: (code, message, retryable, outcome_unknown) => Object.assign(new Error(message), { code, retryable, outcome_unknown }),
  });
  vm.runInContext(agentSource, context);
  assert.equal(context.FlowAgent.agentConfirmationOptionMatches('Always', 'Always ask before using credits'), true);
  assert.equal(context.FlowAgent.agentConfirmationOptionMatches('Always', 'Luôn hỏi trước khi sử dụng'), true);
  assert.equal(context.FlowAgent.agentConfirmationOptionMatches('Never', 'Never auto-spend'), true);
  assert.equal(context.FlowAgent.agentConfirmationOptionMatches('Always', 'Never auto-spend'), false);
  await assert.rejects(context.FlowAgent.setNativeAgentSettings('Never', '16:9'), error =>
    error.code === 'FLOW_AGENT_AUTOSPEND_BLOCKED' && error.outcome_unknown === false);
  assert.equal(queried, false);
});

test('Agent mode toggle clicks the unique composer control and waits for aria-pressed confirmation', async () => {
  const pressed = { value: false };
  const toggle = agentModeButton(pressed);
  const other = agentModeButton({ value: false });
  let waits = 0;
  const { agent } = agentModeHarness({ composerControls: [toggle], outsideControls: [other], onWait: () => {
    if (++waits === 1) pressed.value = true;
  } });
  await agent.setNativeAgentMode(true);
  assert.equal(pressed.value, true);
  assert.equal(waits, 1);
  assert.equal(agent.findNativeAgentModeControl().control, toggle);
});

test('Agent mode toggle can switch off and confirms the resulting false state', async () => {
  const pressed = { value: true };
  const toggle = agentModeButton(pressed, { onClick: state => { state.value = false; } });
  const { agent } = agentModeHarness({ composerControls: [toggle] });
  await agent.setNativeAgentMode(false);
  assert.equal(pressed.value, false);
});

test('Agent mode toggle fails closed when the composer control stays aria-pressed false', async () => {
  const pressed = { value: false };
  let clicks = 0;
  const toggle = agentModeButton(pressed, { onClick: () => { clicks++; } });
  const { agent } = agentModeHarness({ composerControls: [toggle] });
  await assert.rejects(agent.setNativeAgentMode(true), error =>
    error.code === 'FLOW_AGENT_MODE_FAILED' && /pressed: false/.test(error.message) && error.outcome_unknown === false);
  assert.equal(clicks, 1);
});

test('Agent mode toggle rejects ambiguous composer buttons and ignores persistent settings radios', async () => {
  const first = agentModeButton({ value: false });
  const second = agentModeButton({ value: false });
  const ambiguous = agentModeHarness({ composerControls: [first, second] });
  await assert.rejects(ambiguous.agent.setNativeAgentMode(true), error =>
    error.code === 'FLOW_AGENT_MODE_FAILED' && /matches: 2/.test(error.message));

  let saveClicks = 0;
  const radio = { label: 'Always ask before using credits', selected: true };
  const dialog = { innerText: 'Agent settings', querySelectorAll: () => [radio], saveButton: { click: () => { saveClicks++; } } };
  const settingsOnly = agentModeHarness({ dialogs: [dialog] });
  await assert.rejects(settingsOnly.agent.setNativeAgentMode(true), error =>
    error.code === 'FLOW_AGENT_MODE_FAILED' && /matches: 0/.test(error.message));
  assert.equal(saveClicks, 1);
});

test('Agent settings save keeps an already selected Always ask preference unchanged', async () => {
  let alwaysClicked = 0;
  let saved = 0;
  const always = { label: 'Always ask', selected: true, click: () => { alwaysClicked++; always.selected = true; } };
  const aspect = { label: '16:9', selected: true, click() { this.selected = true; } };
  const variant = { label: 'x1', selected: true, click() { this.selected = true; } };
  const settings = { label: 'Settings', visible: true, icon: 'settings_2', click() {}, querySelector() { return null; } };
  const save = { label: 'Save', visible: true, click() { saved++; surface.visible = false; } };
  const surface = { tagName: 'DIV', visible: true, innerText: 'Agent settings', contains: () => false,
    getAttribute: name => name === 'role' ? 'dialog' : null,
    querySelectorAll: selector => selector === '[role="radio"],mat-radio-button' ? [always, aspect, variant] : selector === 'button,[role="button"]' ? [save] : [] };
  const composer = { querySelectorAll: () => [settings] };
  const context = vm.createContext({
    document: { querySelector: () => composer, querySelectorAll: selector => selector === '[role="dialog"],mat-dialog-container,.cdk-overlay-pane,flow-dialog,[role="menu"],mat-menu-panel' ? [surface] : [] },
    flowQuery: () => composer,
    flowQueryAll: () => [always],
    flowButton: () => null,
    visible: element => element.visible !== false,
    accessibleName: element => element.label || '',
    FlowSettings: {
      nativeRadioSelected: element => element.selected === true,
      flowRadio: (name, scope) => scope === surface ? name === '16:9' ? aspect : name === 'x1' ? variant : null : null,
    },
    wait: async () => {},
    flowError: (code, message, retryable, outcome_unknown) => Object.assign(new Error(message), { code, retryable, outcome_unknown }),
  });
  vm.runInContext(agentSource, context);
  const result = await context.FlowAgent.setNativeAgentSettings('Always', '16:9');
  assert.equal(alwaysClicked, 0);
  assert.equal(saved, 1);
  assert.equal(result.confirmation_mode, 'Always');
  assert.equal(result.confirmation_label, 'Always ask');
  assert.equal(result.confirmation_changed, false);
  assert.equal(result.settingsSurfaceVerified, true);
  assert.equal(result.settingsSaveConfirmed, true);
});

test('Agent settings trigger recognizes the settings_2 icon inside the composer', async () => {
  let settingsClicks = 0;
  let saved = 0;
  const always = { label: 'Always ask', selected: true, click() { this.selected = true; } };
  const settings = {
    label: '', icon: 'settings_2', visible: true,
    click() { settingsClicks++; },
    querySelector() { return null; },
  };
  const composer = { querySelectorAll: () => [settings] };
  const save = { label: 'Save', visible: true, click() { saved++; surface.visible = false; } };
  const surface = { tagName: 'DIV', visible: true, innerText: 'Agent settings', contains: () => false,
    getAttribute: name => name === 'role' ? 'dialog' : null,
    querySelectorAll: selector => selector === '[role="radio"],mat-radio-button' ? [always] : selector === 'button,[role="button"]' ? [save] : [] };
  const context = vm.createContext({
    document: { querySelector: () => composer, querySelectorAll: selector => selector === '[role="dialog"],mat-dialog-container,.cdk-overlay-pane,flow-dialog,[role="menu"],mat-menu-panel' ? [surface] : [] },
    flowQuery: () => composer,
    flowQueryAll: () => [always],
    flowFindIcon: element => ({ textContent: element.icon }),
    flowButton: () => null,
    visible: element => element.visible !== false,
    accessibleName: element => element.label || '',
    FlowSettings: {
      nativeRadioSelected: element => element.selected === true,
    },
    wait: async () => {},
    flowError: (code, message, retryable, outcome_unknown) => Object.assign(new Error(message), { code, retryable, outcome_unknown }),
  });
  vm.runInContext(agentSource, context);

  const result = await context.FlowAgent.setNativeAgentSettings('Always');
  assert.equal(settingsClicks, 1);
  assert.equal(saved, 1);
  assert.equal(result.confirmation_changed, false);
  assert.equal(result.settingsSurfaceVerified, true);
  assert.equal(result.settingsSaveConfirmed, true);
});

test('Agent settings inspector reports missing exact settings controls without selecting anything', () => {
  const radio = { label: 'Always ask', selected: true, getAttribute: () => 'radio', innerText: 'Always ask' };
  const menu = { tagName: 'DIV', visible: true, innerText: 'Add to prompt', contains: () => false,
    getAttribute: name => name === 'role' ? 'menu' : null,
    querySelectorAll: selector => selector === '[role="radio"],mat-radio-button' ? [radio] : [] };
  const context = vm.createContext({
    document: { querySelectorAll: selector => selector === '[role="dialog"],mat-dialog-container,.cdk-overlay-pane,flow-dialog,[role="menu"],mat-menu-panel' ? [menu] : [] },
    visible: element => element.visible !== false,
    accessibleName: element => element.label || '',
  });
  vm.runInContext(agentSource, context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.FlowAgent.inspectNativeAgentSettings())), {
    state: 'unverified', reason: 'agent_settings_surface_missing_exact_controls', visibleSurfaceCount: 1,
    surfaces: [{ role: 'menu', heading: 'Add to prompt', confirmationOptions: ['Always ask'], saveControlCount: 0 }],
    matchingSurfaceCount: 0,
  });
});

test('Agent workflow preserves Always ask and supplies the safe one-run confirmation checker', () => {
  const agentBranchStart = workflowSource.indexOf('if (name === "flow.agent.batch")');
  const continueBranchStart = workflowSource.indexOf('if (name === "flow.continue.run")');
  const agentBranch = workflowSource.slice(agentBranchStart, continueBranchStart);
  assert.match(agentBranch, /setNativeAgentSettings\("Always"/);
  assert.doesNotMatch(agentBranch, /setNativeAgentSettings\("Never"/);
  assert.match(agentBranch, /checkConfirmation:\s*\(\)\s*=>\s*agent\.inspectAgentRunConfirmation\(\)/);
});

test('Agent batch preflight requires active Agent mode, exact prompt, and enabled submit', async () => {
  const { ops } = workflowHarness();
  const editor = {
    getEditorUserText: () => 'Generate one image.',
    normalizeFlowPrompt: value => String(value || '').replace(/\s+/g, ' ').trim(),
    getFlowSubmitButton: () => ({ disabled: false, getAttribute: () => null }),
  };
  const preflight = ops.verifyAgentBatchPreflight({ editor, box: {}, prompt: 'Generate one image.' });
  assert.equal(preflight.agent_mode, true);
  assert.equal(preflight.prompt_characters, 19);
  assert.equal(preflight.submit_enabled, true);
  assert.throws(
    () => workflowHarness({ agentPressed: false }).ops.verifyAgentBatchPreflight({ editor, box: {}, prompt: 'Generate one image.' }),
    error => error.code === 'FLOW_AGENT_MODE_UNCONFIRMED' && error.outcome_unknown === false,
  );
  assert.throws(
    () => ops.verifyAgentBatchPreflight({ editor: { ...editor, getEditorUserText: () => 'wrong prompt' }, box: {}, prompt: 'Generate one image.' }),
    error => error.code === 'FLOW_PROMPT_INPUT_UNCONFIRMED' && error.outcome_unknown === false,
  );
  assert.throws(
    () => ops.verifyAgentBatchPreflight({ editor: { ...editor, getFlowSubmitButton: () => ({ disabled: true, getAttribute: () => null }) }, box: {}, prompt: 'Generate one image.' }),
    error => error.code === 'FLOW_SUBMIT_DISABLED' && error.outcome_unknown === false,
  );
});

test('edit, continue, and Agent schemas expose optional submit_only', () => {
  assert.equal(z.object(shapes.edit).parse({ project: 'test', asset: 'clip', prompt: 'edit', acknowledge_cost: true, submit_only: true }).submit_only, true);
  assert.equal(z.object(shapes.continue_shot).parse({ project: 'test', from_asset: 'clip', prompt: 'continue', acknowledge_cost: true, submit_only: true }).submit_only, true);
  assert.equal(z.object(shapes.agent).parse({ project: 'test', scenes: ['scene'], submit_only: true }).submit_only, true);
});

test('submit_only edit, continue, and Agent jobs force retries to zero', () => {
  // The extension planners own this rule now: submit_only work must carry
  // retries: 0 into the queue (see flow-queue-retry-budget tests for the
  // queue honoring that budget).
  const edit = planFlowEdit({ project: 'SubmitSafety', asset: 'source clip', prompt: 'edit prompt', submit_only: true });
  assert.equal(edit.job.payload.params.submit_only, true);
  assert.equal(edit.job.payload.params.retries, 0);
  const cont = planFlowContinue({ project: 'SubmitSafety', from_asset: 'source clip', prompt: 'continue prompt', submit_only: true, force: true });
  assert.equal(cont.job.payload.params.submit_only, true);
  assert.equal(cont.job.payload.params.retries, 0);
  const agent = planFlowAgentBatch({ project: 'SubmitSafety', scenes: ['one scene'], submit_only: true });
  assert.equal(agent.job.payload.params.submit_only, true);
  assert.equal(agent.job.payload.params.retries, 0);
  assert.equal(planFlowEdit({ project: 'SubmitSafety', asset: 'source clip', prompt: 'edit prompt' }).job.payload.params.retries, undefined);
});


test('selectAndConfirmMode gracefully skips missing control when optional: true', async () => {
  const context = vm.createContext({
    Date, Map, Promise, Set, Object, Math, String, Number, Boolean, Array, Error, console,
    document: { querySelectorAll: () => [], querySelector: () => null },
    visible: () => false,
    accessibleName: () => '',
    normalizeFlowUiText: v => String(v || '').toLowerCase().trim(),
    flowError: (code, message) => Object.assign(new Error(message), { code }),
  });
  vm.runInContext(settingsSource, context);
  // Pure text-to-video mode with optional: true should not throw when Ingredients control is absent
  await assert.doesNotReject(async () => {
    await context.FlowSettings.selectAndConfirmMode('Ingredients', false, { optional: true });
  });
});

test('selectAndConfirmMode throws FLOW_FRAMES_MODE_UNAVAILABLE when frames control is absent and required', async () => {
  const context = vm.createContext({
    Date, Map, Promise, Set, Object, Math, String, Number, Boolean, Array, Error, console,
    document: { querySelectorAll: () => [], querySelector: () => null },
    visible: () => false,
    accessibleName: () => '',
    normalizeFlowUiText: v => String(v || '').toLowerCase().trim(),
    flowError: (code, message) => Object.assign(new Error(message), { code }),
  });
  vm.runInContext(settingsSource, context);
  await assert.rejects(
    async () => {
      await context.FlowSettings.selectAndConfirmMode('Frames', true, { optional: false });
    },
    error => error.code === 'FLOW_FRAMES_MODE_UNAVAILABLE'
  );
});

test('exactModeControl resolves Radix trigger suffix for VIDEO_FRAMES and VIDEO_REFERENCES', () => {
  const framesBtn = {
    id: 'radix-vue-trigger-VIDEO_FRAMES',
    visible: true,
    classList: [],
    getAttribute: () => null,
    querySelector: () => null,
  };
  const refsBtn = {
    id: 'radix-vue-trigger-VIDEO_REFERENCES',
    visible: true,
    classList: [],
    getAttribute: () => null,
    querySelector: () => null,
  };
  const context = vm.createContext({
    Date, Map, Promise, Set, Object, Math, String, Number, Boolean, Array, Error, console,
    document: {
      querySelectorAll: (sel) => [framesBtn, refsBtn],
      querySelector: () => null,
    },
    visible: (el) => el.visible !== false,
    accessibleName: () => '',
    normalizeFlowUiText: v => String(v || '').toLowerCase().trim(),
    flowError: (code, message) => Object.assign(new Error(message), { code }),
  });
  vm.runInContext(settingsSource, context);
  assert.equal(context.FlowSettings.exactModeControl('Frames'), framesBtn);
  assert.equal(context.FlowSettings.exactModeControl('Ingredients'), refsBtn);
});

test('chooseVideoOption allows absent option when allowAbsent: true is provided', async () => {
  const makeOption = (label, selected = false) => ({
    label, visible: true, checked: selected, classList: [],
    closest: () => null,
    getAttribute(name) { return name === 'aria-checked' ? String(this.checked) : null; },
    querySelector: () => null,
    click() { this.checked = true; },
  });
  const settingsOptions = [makeOption('Image'), makeOption('Video'), makeOption('x1')];
  const settings = {
    visible: true,
    querySelector(selector) { return selector.includes('[role="radio"]') ? settingsOptions[0] : null; },
    querySelectorAll() { return settingsOptions; },
  };
  const context = vm.createContext({
    Date, Map, Promise, Set, Object, Math, String, Number, Boolean, Array, Error, console,
    document: { querySelectorAll: () => [settings], querySelector: () => null },
    visible: () => true,
    accessibleName: (el) => el.label || '',
    normalizeAspectRatio: v => v,
    normalizeFlowUiText: v => String(v || '').toLowerCase().trim(),
    flowError: (code, message) => Object.assign(new Error(message), { code }),
  });
  vm.runInContext(settingsSource, context);
  // When model does not provide duration or resolution tabs, allowAbsent: true avoids throwing
  await assert.doesNotReject(async () => {
    await context.FlowSettings.chooseVideoOption('duration', '8s', { allowAbsent: true });
  });
  await assert.doesNotReject(async () => {
    await context.FlowSettings.chooseVideoOption('resolution', '1080p', { allowAbsent: true });
  });
});

