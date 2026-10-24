// Live MCP smoke test. Attaches a saved character; never submits generation.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const name = process.argv[2] || 'MCP Test Mug';
const client = new Client({ name: 'character-attachment-smoke', version: '1' });
const results = [];
const call = async (tool, args = {}) => {
  const response = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 85000 });
  const data = JSON.parse(response.content.find(item => item.type === 'text').text);
  results.push({ tool, args, isError: Boolean(response.isError), result: data });
  return { data, isError: response.isError };
};
try {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['dist/index.js'], env: process.env }));
  let ready = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    const status = await call('flow_status', { detailed: false });
    if (status.data.flow?.composer) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert.equal(ready, true, 'Flow composer must finish loading before testing references');
  const before = await call('flow_status', { detailed: true });
  const cast = await call('flow_characters');
  assert.equal(Boolean(cast.isError), false, JSON.stringify(cast.data));
  assert.ok(cast.data.some(character => character.name === name), 'Saved test character must exist in Characters picker');
  const attached = await call('flow_attach_references', { references: [`character:${name}`] });
  assert.equal(attached.data.submitted, false);
  assert.equal(attached.data.attached[0].confirmed, true);
  assert.equal(attached.data.attached[0].kind, 'character');
  assert.equal(attached.data.attached[0].name, name);
  const repeated = await call('flow_attach_references', { references: [`character:${name}`] });
  assert.equal(Boolean(repeated.isError), false, JSON.stringify(repeated.data));
  assert.equal(repeated.data.attached[0].reused, true);
  const absent = await call('flow_attach_references', { references: ['character:__missing_character_smoke__'] });
  assert.equal(absent.isError, true);
  assert.match(absent.data.error, /No exact character/);
  const after = await call('flow_status', { detailed: true });
  assert.equal(after.data.flow.credits_remaining, before.data.flow.credits_remaining);
  console.log(JSON.stringify({ passed: true, character: name, credits_before: before.data.flow.credits_remaining, credits_after: after.data.flow.credits_remaining }));
} finally {
  mkdirSync('diagnostics', { recursive: true });
  writeFileSync('diagnostics/character-mcp-smoke.json', JSON.stringify(results, null, 2));
  await client.close();
}
