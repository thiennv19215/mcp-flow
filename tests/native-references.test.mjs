import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { extensionSetWebSocket } from '../dist/extension.js';
import { runGeneration } from '../dist/flow.js';

const source = readFileSync(new URL('../extension/content/reference-actions.js', import.meta.url), 'utf8');
function harness({ names = ['MCP Test Mug'], addedKind = 'character', hideAttached = false } = {}) {
  let open = true, ticks = 0;
  const attached = [];
  let clicks = 0;
  const image = src => ({ alt: addedKind === 'character' ? 'Character ingredient image' : 'Image ingredient image', getAttribute: () => src });
  const option = name => ({ name, getAttribute: () => null, querySelectorAll: () => [], click() {
    clicks++; open = false;
    if (hideAttached) entries.splice(0, entries.length);
    attached.push({ querySelector: () => image('https://flow.google.com/asb/portrait=s512-rw'), closest: () => addedKind === 'character' ? {} : null });
  } });
  const entries = names.map(option);
  const list = { querySelectorAll: selector => selector === '[role="option"]' ? entries : [] };
  const opener = { getAttribute: () => open ? 'true' : 'false', click: () => { open = !open; } };
  const tab = { name: 'Characters', getAttribute: () => 'true' };
  const tile = { getAttribute: () => 'MCP Test Mug', querySelector: selector => selector === 'flow-character-tile' ? {} : image('https://flow-content.google/image/different-thumbnail') };
  const document = { body: { innerText: '' },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || (selector === '.ProseMirror' ? {} : null); },
    querySelectorAll(selector) {
    if (selector === '[role="listbox"]') return open ? [list] : [];
    if (selector === '[role="progressbar"]') return [];
    if (selector === '[role="tab"]') return [tab];
    if (selector === 'button[aria-label="Ingredient"]') return attached;
    if (selector === 'flow-grid-tile-container') return [tile];
    return [];
  } };
  const context = vm.createContext({ document, location: { href: 'https://flow.google.com/project/test', pathname: '/project/test' }, Date: { now: () => ticks += 500 }, visible: () => true,
    accessibleName: el => el.name || '', flowButton: name => name === 'Add ingredients to the prompt box' ? opener : null,
    wait: async () => {}, flowError: (code, message) => Object.assign(new Error(message), { code }),
  });
  vm.runInContext(source, context);
  return { api: context.FlowReferenceActions, clicks: () => clicks };
}

test('character is confirmed by a new typed chip even when thumbnail and chip CDN URLs differ', async () => {
  const { api } = harness();
  const result = await api.attach('character:MCP Test Mug');
  assert.equal(result.confirmed, true);
  assert.equal(result.kind, 'character');
  assert.equal(result.name, 'MCP Test Mug');
});
test('a confirmed character is reused without clicking its option a second time', async () => {
  const { api, clicks } = harness({ hideAttached: true });
  await api.attach('character:MCP Test Mug');
  assert.equal((await api.attach('character:MCP Test Mug')).reused, true);
  assert.equal(clicks(), 1);
  assert.equal((await api.listCharacters())[0], 'MCP Test Mug');
});
test('an ordinary image chip cannot confirm an explicitly requested character', async () => {
  const { api } = harness({ addedKind: 'image' });
  await assert.rejects(api.attach('character:MCP Test Mug'), error => error.code === 'FLOW_REFERENCE_ATTACH_UNCONFIRMED');
});
test('exact matching rejects duplicates and does not choose a prefix match', async () => {
  const { api, clicks } = harness({ names: ['MCP Test Mug', 'MCP Test Mug'] });
  await assert.rejects(api.attach('character:MCP Test Mug'), error => error.code === 'FLOW_ASSET_AMBIGUOUS');
  assert.equal(clicks(), 0);
  const other = harness({ names: ['MCP Test Mug extra'] });
  await assert.rejects(other.api.attach('character:MCP Test Mug'), error => error.code === 'FLOW_ASSET_NOT_FOUND');
  const suffixed = harness({ names: ['MCP Test Mug Character'] });
  await assert.rejects(suffixed.api.attach('character:MCP Test Mug'), error => error.code === 'FLOW_ASSET_NOT_FOUND');
});
test('asset names ending in media decoration are matched without broad substrings', () => {
  const { api } = harness();
  const option = { name: 'Mug Character', getAttribute: () => null, querySelectorAll: () => [] };
  assert.equal(api.exactOption([option], 'Mug'), option);
  assert.equal(api.exactOption([option], 'Mu'), null);
});

test('generation transports character:<name> as a named reference, not a local file', async () => {
  class Connector extends EventEmitter {
    readyState = 1;
    sent = [];
    send(raw) {
      const command = JSON.parse(raw);
      this.sent.push(command);
      const operation = command.args[0];
      const result = operation.name === 'flow.context'
        ? { ok: true, value: { driverKey: 'flow_v2', origin: 'https://flow.google.com', projectId: 'test-project', routePrefix: '', isProjectEditor: true, tabId: 101 } }
        : { ok: false, error: { message: 'Stopped at submit boundary for test', outcome_unknown: false } };
      queueMicrotask(() => this.emit('message', JSON.stringify({ type: 'result', id: command.id, result })));
    }
  }
  const connector = new Connector();
  extensionSetWebSocket(connector);
  connector.emit('message', JSON.stringify({ type: 'event', method: 'extension.initialized', params: [{ protocol: 2, version: '0.2.13', capabilities: ['context', 'generation.submit', 'generation.observe', 'asset.download', 'references.attach'].map(name => `flow.native.${name}`) }] }));
  try {
    await assert.rejects(runGeneration({ params: { type: 'image', prompt: 'Test character', reference_images: ['character:MCP Test Mug'], max_credits: 0 } }), /Stopped at submit boundary/);
    assert.deepEqual(connector.sent.map(command => command.args[0].name), ['flow.context', 'flow.generation.submit']);
    assert.deepEqual(connector.sent[1].args[0].payload.attachments, [{ assetName: 'character:MCP Test Mug' }]);
  } finally { connector.emit('close', 1000, Buffer.from('test complete')); }
});
