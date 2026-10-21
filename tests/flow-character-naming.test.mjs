import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../extension/src/content/providers/flow/characters/flow-characters.js', import.meta.url), 'utf8');

function harness({ accepts = true } = {}) {
  const events = [];
  const context = vm.createContext({
    setEditable(input, value) {
      events.push('set');
      input.value = accepts ? value : 'Untitled character';
    },
    wait: async ms => { events.push(`wait:${ms}`); },
    KeyboardEvent: class MockKeyboardEvent { constructor(type, detail) { this.type = type; this.detail = detail; } },
    flowError: (code, message, retryable, outcome_unknown) => Object.assign(new Error(message), { code, retryable, outcome_unknown }),
  });
  vm.runInContext(source, context);
  const input = { value: 'Untitled character', dispatchEvent(event) { events.push(`${event.type}:${event.detail.key}`); }, blur() { events.push('blur'); } };
  return { context, input, events };
}

test('character name commit applies input and blur, without submitting the editor form via Enter', async () => {
  const { context, input, events } = harness();
  assert.equal(await context.FlowCharacterActions.commitName(input, 'Native E2E Character'), true);
  assert.equal(input.value, 'Native E2E Character');
  assert.deepEqual(events, ['set', 'blur', 'wait:800']);
  const diagnostics = context.FlowCharacterActions.inspectNameDiagnostics();
  assert.equal(diagnostics.stage, 'name_entry_confirmed');
  assert.equal(diagnostics.name_entry_confirmed, true);
  assert.equal(diagnostics.library_scan, null);
  assert.equal(JSON.stringify(diagnostics).includes('Native E2E Character'), false);
});

test('character name commit fails before save when Flow does not keep the requested value', async () => {
  const { context, input } = harness({ accepts: false });
  await assert.rejects(context.FlowCharacterActions.commitName(input, 'Native E2E Character'), error =>
    error.code === 'FLOW_CHARACTER_NAME_UNCONFIRMED' && error.outcome_unknown === false &&
    error.diagnostics?.name_entry_confirmed === false && error.diagnostics?.library_scan === null &&
    !JSON.stringify(error.diagnostics).includes('Native E2E Character'));
});

test('character rename save response records control, route exit, and exact library scan', async () => {
  const { context, input } = harness();
  await context.FlowCharacterActions.commitName(input, 'Native E2E Character');
  const diagnostics = context.FlowCharacterActions.recordNameSaveResponse({
    control_label: 'Done', click_sent: true, route_exited: true,
    post_save_route: '/project/example',
    library_scan: { requested_matches: 0, original_matches: 1, scan_complete: true, confirmed: false, visible_names: ['untitled character'] },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(diagnostics)), {
    stage: 'post_save_library_verification',
    name_entry_confirmed: true,
    save_clicked: true,
    route_exited: true,
    library_scan: {
      scan_complete: true,
      requested_name_matches: 0,
      previous_name_matches: 1,
      confirmed: false,
    },
  });
  assert.equal(JSON.stringify(diagnostics).includes('untitled character'), false);
});

test('character name persistence requires one new name and no remaining old name', () => {
  const { context } = harness();
  assert.deepEqual(JSON.parse(JSON.stringify(context.FlowCharacterActions.verifyNameLibrary(1, 0))), {
    scan_complete: true,
    requested_name_matches: 1,
    previous_name_matches: 0,
    confirmed: true,
  });
  for (const [newCount, oldCount] of [[0, 1], [2, 0], [1, 1]]) {
    assert.equal(context.FlowCharacterActions.verifyNameLibrary(newCount, oldCount).confirmed, false);
  }
  const incomplete = context.FlowCharacterActions.verifyNameLibrary(1, 0, false);
  assert.equal(incomplete.confirmed, false);
  assert.equal(incomplete.scan_complete, false);
});

function scanHarness({ measurable = true } = {}) {
  const tile = { innerText: 'Native E2E Character\nportrait', getAttribute: () => null, querySelector: () => null };
  const scroller = measurable ? { scrollTop: 0, scrollHeight: 500, clientHeight: 500 } : null;
  const document = {
    scrollingElement: measurable ? scroller : null,
    documentElement: measurable ? scroller : null,
    querySelectorAll(selector) { return selector === 'flow-character-tile' ? [tile] : []; },
  };
  const context = vm.createContext({ document, location: { pathname: '/project/test' },
    scrollContainer: () => null, visible: () => true, cleanCharacterName: value => value,
    wait: async () => {}, flowError: (code, message, retryable, outcome_unknown) => Object.assign(new Error(message), { code, retryable, outcome_unknown }),
  });
  vm.runInContext(source, context);
  return context;
}

test('character save scan only confirms after measurable full-library boundary', async () => {
  const context = scanHarness();
  const matches = await context.FlowCharacterActions.findCharacterTiles('Native E2E Character', 1000);
  assert.equal(matches.length, 1);
  assert.equal(context.FlowCharacterActions.inspectNameDiagnostics(), null);
});

test('character save scan fails closed when the library exposes no measurable end', async () => {
  const context = scanHarness({ measurable: false });
  await assert.rejects(context.FlowCharacterActions.findCharacterTiles('Native E2E Character', 1000), error =>
    error.code === 'FLOW_CHARACTER_SCAN_INCOMPLETE' && error.outcome_unknown !== true);
});

test('character save scan visits later pages through the measured end and restores scroll position', async () => {
  const scroller = { scrollTop: 40, scrollHeight: 500, clientHeight: 100 };
  const lateTile = { innerText: 'Native E2E Character\nportrait', getAttribute: () => null, querySelector: () => null };
  const document = { querySelectorAll(selector) {
    if (selector === 'flow-character-tile') return scroller.scrollTop >= 400 ? [lateTile] : [];
    return [];
  } };
  const context = vm.createContext({ document, location: { pathname: '/project/test' },
    scrollContainer: () => scroller, visible: () => true, cleanCharacterName: value => value,
    wait: async () => {}, flowError: (code, message, retryable, outcome_unknown) => Object.assign(new Error(message), { code, retryable, outcome_unknown }),
  });
  vm.runInContext(source, context);
  const matches = await context.FlowCharacterActions.findCharacterTiles('Native E2E Character', 1000);
  assert.equal(matches.length, 1);
  assert.equal(scroller.scrollTop, 40);
});
