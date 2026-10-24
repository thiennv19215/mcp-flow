import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// D5-extension — the extension must send the backend server token on HTTP
// connect (cluster D made /api/extension/connect require it). The token is
// stored once by the user in chrome.storage.local (key: serverToken) via the
// options page; connect() reads it through readBridgeConfig, exactly like the
// bridge URL. Without a stored token the old behaviour must survive: HTTP
// connect 401s and the client falls back to WebSocket.

const SERVER_TOKEN = 'test-server-token-abc';
const SESSION_ID = 'test-session-1';

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    async get(keys) {
      if (keys === null || keys === undefined) return { ...data };
      if (typeof keys === 'string') return { [keys]: data[keys] };
      if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, data[key]]));
      return Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [key, data[key] ?? fallback]));
    },
    async set(entries) { Object.assign(data, entries); },
  };
}

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = MockWebSocket.CONNECTING;
    this.sent = [];
    MockWebSocket.instances.push(this);
  }
  send(data) { this.sent.push(data); }
  close() { this.readyState = 3; }
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

// Emulates the real server (cluster D): connect requires the token; poll
// answers with no message. Any other path is not used by these tests.
function makeFetchMock() {
  const calls = [];
  const mockFetch = async (url, options = {}) => {
    calls.push({ url, headers: options.headers || {} });
    if (String(url).includes('/api/extension/connect')) {
      const presented = options.headers?.authorization?.replace(/^Bearer /, '');
      if (presented !== SERVER_TOKEN) return jsonResponse(401, { error: 'Missing or wrong token.' });
      return jsonResponse(200, { ok: true, protocol: 3, transport: 'http-poll', session_id: SESSION_ID });
    }
    if (String(url).includes('/api/extension/poll')) return jsonResponse(200, { message: null });
    return jsonResponse(404, { error: 'Not found.' });
  };
  return { calls, mockFetch };
}

let bridgeModule;
async function loadBridge(storage) {
  globalThis.chrome = {
    storage: { local: storage },
    runtime: { getManifest: () => ({ version: '9.9.9-test' }) },
  };
  globalThis.WebSocket = MockWebSocket;
  if (!bridgeModule) bridgeModule = await import('../extension/src/background/flow-bridge-client.js');
  return bridgeModule;
}

test('readBridgeConfig preserves a stored serverToken', async () => {
  const { readBridgeConfig } = await loadBridge(memoryStorage({ serverToken: SERVER_TOKEN }));
  const settings = await readBridgeConfig();
  assert.equal(settings.serverToken, SERVER_TOKEN);
});

test('connect with a stored serverToken uses HTTP-poll (no WebSocket fallback)', async () => {
  const { calls, mockFetch } = makeFetchMock();
  globalThis.fetch = mockFetch;
  MockWebSocket.instances = [];
  const { FlowBridgeClient } = await loadBridge(memoryStorage({ serverToken: SERVER_TOKEN }));
  const client = new FlowBridgeClient({});
  await client.connect();
  try {
    const connectCall = calls.find((call) => String(call.url).includes('/api/extension/connect'));
    assert.ok(connectCall, 'expected a connect call');
    assert.equal(connectCall.headers.authorization, `Bearer ${SERVER_TOKEN}`,
      'connect must present the stored server token');
    assert.equal(client.getStatus().transport, 'http-poll');
    assert.equal(client.getStatus().connected, true);
    assert.equal(MockWebSocket.instances.length, 0, 'no WebSocket fallback when HTTP connect succeeds');
  } finally {
    client.stopHttpSession();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
});

test('connect without a stored serverToken keeps the WebSocket fallback', async () => {
  const { calls, mockFetch } = makeFetchMock();
  globalThis.fetch = mockFetch;
  MockWebSocket.instances = [];
  const { FlowBridgeClient } = await loadBridge(memoryStorage({}));
  const client = new FlowBridgeClient({});
  await client.connect();
  try {
    const connectCall = calls.find((call) => String(call.url).includes('/api/extension/connect'));
    assert.ok(connectCall, 'expected a connect attempt');
    assert.equal(connectCall.headers.authorization, undefined, 'no token stored means no auth header');
    assert.equal(MockWebSocket.instances.length, 1, '401 must fall back to exactly one WebSocket');
    assert.ok(!MockWebSocket.instances[0].url.includes('token='), 'fallback URL must not carry an empty token');
  } finally {
    client.disconnect();
  }
});

test('options page wires a server token field that saves and reconnects', () => {
  const optionsJs = readFileSync(new URL('../extension/src/ui/options.js', import.meta.url), 'utf8');
  const optionsHtml = readFileSync(new URL('../extension/src/ui/options.html', import.meta.url), 'utf8');
  assert.match(optionsHtml, /id="serverToken"/, 'options page needs a server token input');
  assert.match(optionsJs, /serverToken/, 'options script must read/write the serverToken key');
  assert.match(optionsJs, /flow-mcp:connect/, 'saving the token must trigger a reconnect');
});
