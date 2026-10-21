import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createFlowMcpServer } from '../dist/mcp-tools.js';
import { RemoteCore } from '../dist/remote.js';

test('flow_voice_options is exposed as a read-only MCP tool and forwards the exact labels', async () => {
  const calls = [];
  const server = createFlowMcpServer({
    voice_options: async () => {
      calls.push('voice_options');
      return { voices: ['Voice Alpha', 'Voice Beta'], count: 2, source: 'flow_v2_picker', readOnly: true };
    },
  });
  const tool = server._registeredTools.flow_voice_options;
  assert.ok(tool);
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool.inputSchema.safeParse({}).success, true);
  const response = await tool.handler({});
  assert.deepEqual(JSON.parse(response.content[0].text), {
    voices: ['Voice Alpha', 'Voice Beta'], count: 2, source: 'flow_v2_picker', readOnly: true,
  });
  assert.deepEqual(calls, ['voice_options']);
});

test('RemoteCore calls the local voice_options API endpoint', async t => {
  const calls = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    calls.push({ method: request.method, url: request.url, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ voices: ['Voice Alpha'], count: 1, source: 'flow_v2_picker', readOnly: true }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));

  const remote = new RemoteCore({ baseUrl: `http://127.0.0.1:${server.address().port}`, deviceToken: 'test-device-token' });
  assert.deepEqual(await remote.voice_options(), { voices: ['Voice Alpha'], count: 1, source: 'flow_v2_picker', readOnly: true });
  assert.deepEqual(calls, [{ method: 'POST', url: '/api/voice_options', body: {} }]);
});

test('voice options operation is registered as a Flow-native read-only capability', () => {
  const generation = readFileSync(new URL('../extension/content/providers/flow/FlowGenerationOperations.js', import.meta.url), 'utf8');
  const baseDriver = readFileSync(new URL('../extension/content/providers/BaseProviderDriver.js', import.meta.url), 'utf8');
  const worker = readFileSync(new URL('../extension/background/service-worker.js', import.meta.url), 'utf8');
  assert.match(generation, /"flow\.voices\.options"/);
  assert.match(baseDriver, /"flow\.voices\.options"/);
  assert.match(worker, /"flow\.voices\.options"/);
  assert.match(worker, /flow\.voices\.options.*?includes\(operation\)/s);
});
