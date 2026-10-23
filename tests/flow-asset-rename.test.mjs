import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createFlowMcpServer } from '../dist/mcp-tools.js';
import { RemoteCore } from '../dist/remote.js';

const source = readFileSync(new URL('../extension/src/content/providers/flow/library/library-operations.js', import.meta.url), 'utf8');
const assetId = '01234567-89ab-4cde-8f01-23456789abcd';

function extensionHarness({ initialTitle = 'old title', currentId = assetId, extraAssets = [] } = {}) {
  const tile = {
    title: initialTitle,
    id: currentId,
    getAttribute(name) { return name === 'aria-label' ? this.title : null; },
    scrollIntoView() {},
  };
  const input = {
    value: initialTitle,
    isContentEditable: false,
    dispatchEvent(event) {
      if (event.type === 'keyup' && event.key === 'Enter') tile.title = this.value;
    },
  };
  const renameItem = { innerText: 'Rename', click() {} };
  const moreButton = { click() {} };
  const document = {
    querySelectorAll(selector) {
      if (selector === 'flow-grid-tile-container') return [tile];
      if (selector === '[role="menuitem"]') return [renameItem];
      if (selector === 'input:not([type="file"]),[contenteditable="true"]') return [input];
      return [];
    },
  };
  const context = vm.createContext({
    Date, Promise, Set, Object, String, Number, Array, Error,
    Event: class { constructor(type, options = {}) { this.type = type; Object.assign(this, options); } },
    KeyboardEvent: class { constructor(type, options = {}) { this.type = type; Object.assign(this, options); } },
    document,
    visible: () => true,
    accessibleName: element => element.innerText || '',
    mediaId: element => element.id,
    wait: async () => {},
    flowButton: label => label === 'More options' ? moreButton : null,
  });
  vm.runInContext(source, context);
  const ops = new context.FlowLibraryOperations({ error: (code, message, retryable, outcome_unknown) => Object.assign(new Error(message), { code, retryable, outcome_unknown }) });
  const tiles = {
    countFlowTitleAcrossGrid: async title => tile.title === title ? 1 : 0,
    findFlowTile: async title => tile.title === title ? tile : null,
  };
  context.FlowTiles = tiles;
  context.FlowMediaMenu = { scanNativeAssets: async () => [{ id: tile.id, name: tile.title }, ...extraAssets] };
  return { ops, tile, input, renameItem, tiles };
}

test('registers asset rename MCP tool with exact-title, optional UUID, and safe new-name validation', async () => {
  const calls = [];
  const server = createFlowMcpServer({ rename_asset: async args => { calls.push(args); return { renamed: args.name, name: args.new_name, id: args.id }; } });
  const tool = server._registeredTools.flow_asset_rename;
  assert.ok(tool);
  assert.equal(tool.annotations.readOnlyHint, false);
  assert.equal(tool.annotations.destructiveHint, false);
  const parsed = tool.inputSchema.safeParse({ name: ' old ', new_name: ' new ' });
  assert.equal(parsed.success, true);
  assert.deepEqual(parsed.data, { name: 'old', new_name: 'new' });
  assert.equal(tool.inputSchema.safeParse({ name: '', new_name: 'new' }).success, false);
  assert.equal(tool.inputSchema.safeParse({ name: 'old', id: 'bad-id', new_name: 'new' }).success, false);
  assert.equal(tool.inputSchema.safeParse({ name: 'old', new_name: 'bad\nname' }).success, false);
  const result = await tool.handler({ name: 'old', id: assetId, new_name: 'new' });
  assert.deepEqual(JSON.parse(result.content[0].text), { renamed: 'old', name: 'new', id: assetId });
  assert.deepEqual(calls, [{ name: 'old', id: assetId, new_name: 'new' }]);
});

test('RemoteCore forwards asset rename to the owner API endpoint', async t => {
  const calls = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    calls.push({ url: request.url, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ renamed: 'old', name: 'new', id: assetId }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const remote = new RemoteCore(`http://127.0.0.1:${server.address().port}`);
  assert.deepEqual(await remote.rename_asset({ name: 'old', new_name: 'new', id: assetId }), { renamed: 'old', name: 'new', id: assetId });
  assert.deepEqual(calls, [{ url: '/api/rename_asset', body: { name: 'old', new_name: 'new', id: assetId } }]);
});

test('Flow rename commits only against a unique exact title and confirms the same media UUID', async () => {
  const { ops, tile } = extensionHarness();
  const result = await ops.execute('flow.asset.rename', { name: 'old title', id: assetId, newName: 'new title' }, { timeoutMs: 1000 });
  assert.equal(tile.title, 'new title');
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { renamed: 'old title', name: 'new title', id: assetId });
});

test('Flow rename fails closed on an ID mismatch before opening the menu', async () => {
  const { ops, renameItem } = extensionHarness({ currentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
  let clicks = 0;
  renameItem.click = () => { clicks++; };
  await assert.rejects(ops.execute('flow.asset.rename', { name: 'old title', id: assetId, newName: 'new title' }), error => error.code === 'FLOW_ASSET_ID_MISMATCH' && error.outcome_unknown === false);
  assert.equal(clicks, 0);
});

test('Flow rename refuses a duplicate destination title before opening the menu', async () => {
  const { ops, renameItem } = extensionHarness({ extraAssets: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'occupied title' }] });
  let clicks = 0;
  renameItem.click = () => { clicks++; };
  await assert.rejects(ops.execute('flow.asset.rename', { name: 'old title', newName: 'occupied title' }), error => error.code === 'FLOW_ASSET_NAME_TAKEN' && error.outcome_unknown === false);
  assert.equal(clicks, 0);
});
