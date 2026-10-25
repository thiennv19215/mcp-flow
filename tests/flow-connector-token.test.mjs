import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import WebSocket from 'ws';

// Audit cluster D item 5: the extension connector endpoints must require
// the per-machine token like every other API route. This test drives a
// REAL server process (same pattern as flow-http-relay): the child runs
// dist/server.js with a stub core. Pre-fix, /api/extension/connect
// answers 200 without any token; post-fix it answers 401 unless the
// token is presented (x-flow-token header, ?token= query, or Bearer).
// poll/result/progress keep working off the unguessable session_id the
// connect call returns. WS: when FLOW_MCP_WS_TOKEN is configured, an
// upgrade without it is refused; with it, it opens.

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, '..', 'dist', 'server.js');
const serverUrl = pathToFileURL(serverPath).href;
const PORT = 19100 + Math.floor(Math.random() * 800);
const TOKEN = 'connector-test-token';
const WS_TOKEN = 'connector-ws-token';
// Extension ids are 32 lowercase letters a-p (see isExtensionOrigin).
const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

const childSource = `
import { startServer } from ${JSON.stringify(serverUrl)};
const core = { status: async () => ({ ok: true }) };
const role = await startServer(core);
if (role !== 'owner') { console.error('not owner: ' + role); process.exit(1); }
console.log('READY');
`;

let child;
let dir;

async function post(path, body, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

function wsAttempt(url) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers: { Origin: ORIGIN } });
    const timer = setTimeout(() => { try { ws.terminate(); } catch {} resolve('timeout'); }, 5000);
    ws.on('open', () => { clearTimeout(timer); ws.close(); resolve('open'); });
    ws.on('error', () => { clearTimeout(timer); resolve('error'); });
    ws.on('close', () => { clearTimeout(timer); resolve('close'); });
  });
}

test.before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'flow-connector-token-'));
  const childPath = join(dir, 'child.mjs');
  writeFileSync(childPath, childSource);
  child = spawn(process.execPath, [childPath], {
    env: {
      ...process.env,
      FLOW_MCP_HOME: join(dir, 'home'),
      FLOW_MCP_PORT: String(PORT),
      FLOW_MCP_TOKEN: TOKEN,
      FLOW_MCP_WS_TOKEN: WS_TOKEN,
      FLOW_MCP_ALLOWED_HOSTS: `127.0.0.1:${PORT},localhost:${PORT}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error('server child did not become ready; output: ' + out)), 15000);
    child.stdout.on('data', (chunk) => {
      out += chunk;
      if (out.includes('READY')) { clearTimeout(timer); resolve(); }
    });
    child.stderr.on('data', (chunk) => { out += chunk; });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error('server child exited early with ' + code + '; output: ' + out)); });
  });
});

test.after(() => {
  try { child?.kill(); } catch {}
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
});

test('D5: connect without a token is refused', async () => {
  const { status, data } = await post('/api/extension/connect', { protocol: 3 });
  assert.equal(status, 401, 'expected 401, got ' + status + ' ' + JSON.stringify(data));
  assert.match(String(data.error || ''), /token/i);
});

test('D5: connect accepts the token via header, query, or Bearer', async () => {
  const viaHeader = await post('/api/extension/connect', { protocol: 3 }, { 'x-flow-token': TOKEN });
  assert.equal(viaHeader.status, 200, JSON.stringify(viaHeader.data));
  assert.equal(typeof viaHeader.data.session_id, 'string');
  const viaQuery = await post(`/api/extension/connect?token=${TOKEN}`, { protocol: 3 });
  assert.equal(viaQuery.status, 200, JSON.stringify(viaQuery.data));
  assert.equal(typeof viaQuery.data.session_id, 'string');
  const viaBearer = await post('/api/extension/connect', { protocol: 3 }, { Authorization: `Bearer ${TOKEN}` });
  assert.equal(viaBearer.status, 200, JSON.stringify(viaBearer.data));
  assert.equal(typeof viaBearer.data.session_id, 'string');

  // The session_id is the credential for the follow-up endpoints. Each
  // connect replaces the previous session for device "local", so the poll
  // must use the LAST session issued (viaBearer).
  const poll = await post('/api/extension/poll', { session_id: viaBearer.data.session_id, wait_ms: 1 });
  assert.equal(poll.status, 200, JSON.stringify(poll.data));
});

test('D5: WebSocket upgrade without the configured ws token is refused, with it it opens', async () => {
  const denied = await wsAttempt(`ws://127.0.0.1:${PORT}/ws/bridge`);
  assert.notEqual(denied, 'open', 'WS without a token must not open when FLOW_MCP_WS_TOKEN is set');
  const allowed = await wsAttempt(`ws://127.0.0.1:${PORT}/ws/bridge?token=${WS_TOKEN}`);
  assert.equal(allowed, 'open', 'WS with the configured token must open');
});
