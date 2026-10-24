import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Audit cluster D item 4: flow_generate / flow_agent_images / flow_edit
// must be wrapped in patient() like flow_continue, so a slow core hands
// back a task_id instead of holding the MCP call past the client's
// timeout (which used to cause double-paid re-calls). The child runs
// dist/mcp-tools.js with FLOW_MCP_PATIENCE_MS=300 and a stub core whose
// three tools sleep 2 s; the parent drives them through an in-memory MCP
// client. Pre-fix, the calls return the direct result after 2 s (no
// still_working); post-fix they answer still_working + task_id within
// the patience window, and flow_wait collects the finished answer.

const here = dirname(fileURLToPath(import.meta.url));
const toolsPath = join(here, '..', 'dist', 'mcp-tools.js');

const childSource = `
import { createFlowMcpServer } from ${JSON.stringify(toolsPath)};
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const core = {
  generate: async () => { await sleep(2000); return { jobs: [{ id: 'job-1' }] }; },
  agent: async () => { await sleep(2000); return { jobs: [{ id: 'job-2' }] }; },
  edit: async () => { await sleep(2000); return { jobs: [{ id: 'job-3' }] }; },
  wait: async () => ({ finished: true, jobs: [] }),
};
const server = createFlowMcpServer(core);
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
const client = new Client({ name: 'patient-test', version: '1.0.0' }, { capabilities: {} });
await client.connect(clientTransport);

const results = {};
for (const [tool, args] of [
  ['flow_generate', { project: 'P', scenes: [{ prompt: 'a cat' }] }],
  ['flow_agent_images', { project: 'P', scenes: ['a cat'] }],
  ['flow_edit', { project: 'P', asset: 'clip', prompt: 'make it snow', acknowledge_cost: true }],
]) {
  const started = Date.now();
  const res = await client.callTool({ name: tool, arguments: args });
  const text = res.content?.[0]?.text ?? '';
  results[tool] = { ms: Date.now() - started, body: JSON.parse(text) };
}
console.log('RESULTS ' + JSON.stringify(results));
process.exit(0);
`;

test('D4: slow generate/agent/edit answer still_working + task_id within the patience window', async (t) => {
  // The child must live UNDER the repo root so node can resolve
  // @modelcontextprotocol/sdk from the repo's node_modules (a /tmp child
  // cannot). It is removed in t.after.
  const dir = mkdtempSync(join(here, '..', '.tmp-patient-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const childPath = join(dir, 'child.mjs');
  writeFileSync(childPath, childSource);
  const out = await new Promise((resolve, reject) => {
    let buf = '';
    const child = spawn(process.execPath, [childPath], {
      env: { ...process.env, FLOW_MCP_PATIENCE_MS: '300' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => { child.kill(); reject(new Error('patient child timed out; output: ' + buf)); }, 30000);
    child.stdout.on('data', (chunk) => { buf += chunk; });
    child.stderr.on('data', (chunk) => { buf += chunk; });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error('patient child exited ' + code + '; output: ' + buf));
      else resolve(buf);
    });
  });
  const line = out.split('\n').find((l) => l.startsWith('RESULTS '));
  assert.ok(line, 'expected RESULTS line, got: ' + out);
  const results = JSON.parse(line.slice('RESULTS '.length));
  for (const tool of ['flow_generate', 'flow_agent_images', 'flow_edit']) {
    const { ms, body } = results[tool];
    assert.equal(body.still_working, true, `${tool} must hand back still_working, got ${JSON.stringify(body)}`);
    assert.match(String(body.task_id || ''), /^task-/, `${tool} must hand back a task_id`);
    assert.ok(ms < 1500, `${tool} must answer within the patience window, took ${ms}ms`);
  }
});
