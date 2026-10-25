import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Cluster A1: the owner's generic HTTP dispatch (/api/<method>) must pass
// the request body through to the Core method. Before this fix, methods
// with no entry in schemas.ts shapes (chatgpt_generate,
// run_workflow_graph) reached the core as `undefined`, so LocalCore threw
// "needs a project…" even for valid args — RemoteCore forwards were dead.
// This test drives a REAL server process (no fetch mock): the child runs
// dist/server.js with a stub core that records exactly what it receives.

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, '..', 'dist', 'server.js');
const serverUrl = pathToFileURL(serverPath).href;
const PORT = 19000 + Math.floor(Math.random() * 900);
const TOKEN = 'relay-test-token';

const childSource = `
import { startServer } from ${JSON.stringify(serverUrl)};
const seen = {};
const core = {
  chatgpt_generate: async (args) => {
    seen.chatgpt_generate = args;
    if (!args?.project?.trim() || !args?.prompt?.trim()) throw new Error('chatgpt_generate needs a project folder name for the downloaded images.');
    return { seen: args };
  },
  run_workflow_graph: async (args) => {
    seen.run_workflow_graph = args;
    if (!args?.project?.trim()) throw new Error('run_workflow_graph needs a project folder name.');
    return { seen: args };
  },
  status: async () => ({ ok: true }),
};
const role = await startServer(core);
if (role !== 'owner') { console.error('not owner: ' + role); process.exit(1); }
console.log('READY');
`;

let child;
let dir;

async function post(path, body) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-flow-token': TOKEN },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

test.before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'flow-http-relay-'));
  const childPath = join(dir, 'child.mjs');
  writeFileSync(childPath, childSource);
  child = spawn(process.execPath, [childPath], {
    env: {
      ...process.env,
      FLOW_MCP_HOME: join(dir, 'home'),
      FLOW_MCP_PORT: String(PORT),
      FLOW_MCP_TOKEN: TOKEN,
      FLOW_MCP_ALLOWED_HOSTS: `127.0.0.1:${PORT},localhost:${PORT}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error('server child did not become ready; output: ' + out)), 15000);
    child.stdout.on('data', chunk => {
      out += chunk;
      if (out.includes('READY')) { clearTimeout(timer); resolve(); }
    });
    child.stderr.on('data', chunk => { out += chunk; });
    child.on('exit', code => { clearTimeout(timer); reject(new Error('server child exited early with ' + code + '; output: ' + out)); });
  });
});

test.after(() => {
  try { child?.kill(); } catch {}
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
});

test('A1: /api/chatgpt_generate delivers the parsed body to the core (not undefined)', async () => {
  const { status, data } = await post('/api/chatgpt_generate', { project: 'ChatArt', prompt: 'a cat wearing a hat' });
  assert.equal(status, 200, 'expected 200, got ' + status + ' ' + JSON.stringify(data));
  assert.equal(data.seen.project, 'ChatArt');
  assert.equal(data.seen.prompt, 'a cat wearing a hat');
});

test('A1: /api/run_workflow_graph delivers the parsed body to the core (not undefined)', async () => {
  const graph = { nodes: [{ id: 'n1', type: 'text' }], edges: [] };
  const { status, data } = await post('/api/run_workflow_graph', { project: 'WfProj', graph });
  assert.equal(status, 200, 'expected 200, got ' + status + ' ' + JSON.stringify(data));
  assert.equal(data.seen.project, 'WfProj');
  assert.deepEqual(data.seen.graph, graph);
});

test('A1: a missing required field is rejected by shape validation, not by a core undefined-args error', async () => {
  const { status, data } = await post('/api/chatgpt_generate', { project: 'ChatArt' });
  assert.equal(status, 400);
  assert.match(String(data.error || ''), /prompt/, 'expected a zod prompt error, got: ' + JSON.stringify(data));
});

test('A1: an already-shaped method still works, and an unknown method is not dispatched', async () => {
  const ok = await post('/api/status', {});
  assert.equal(ok.status, 200);
  const unknown = await post('/api/localAssets', {});
  assert.equal(unknown.status, 404, 'private/prototype methods must not be dispatched, got ' + unknown.status);
});
