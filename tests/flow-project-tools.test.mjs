import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createFlowMcpServer } from '../dist/mcp-tools.js';
import { RemoteCore } from '../dist/remote.js';

test('registers Flow project list and open MCP tools and forwards to existing Core methods', async () => {
  const calls = [];
  const server = createFlowMcpServer({
    projects: async () => {
      calls.push(['projects']);
      return [{ id: '01234567-89ab-4cde-8f01-23456789abcd', name: 'Project A' }];
    },
    open_project: async args => {
      calls.push(['open_project', args]);
      return { opened: true, id: args.project_id, url: `https://flow.google.com/project/${args.project_id}` };
    },
  });

  const tools = server._registeredTools;
  assert.ok(tools.flow_projects);
  assert.ok(tools.flow_open_project);
  assert.equal(tools.flow_projects.annotations.readOnlyHint, true);
  assert.equal(tools.flow_open_project.annotations.readOnlyHint, false);
  assert.equal(tools.flow_open_project.inputSchema.safeParse({ project_id: 'not-a-uuid' }).success, false);

  const projects = await tools.flow_projects.handler({});
  assert.deepEqual(JSON.parse(projects.content[0].text), [
    { id: '01234567-89ab-4cde-8f01-23456789abcd', name: 'Project A' },
  ]);

  const opened = await tools.flow_open_project.handler({ project_id: '01234567-89ab-4cde-8f01-23456789abcd' });
  assert.deepEqual(JSON.parse(opened.content[0].text), {
    opened: true,
    id: '01234567-89ab-4cde-8f01-23456789abcd',
    url: 'https://flow.google.com/project/01234567-89ab-4cde-8f01-23456789abcd',
  });
  assert.deepEqual(calls, [
    ['projects'],
    ['open_project', { project_id: '01234567-89ab-4cde-8f01-23456789abcd' }],
  ]);
});

test('RemoteCore routes project listing and opening to the existing local API endpoints', async t => {
  const calls = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    calls.push({ method: request.method, url: request.url, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(request.url === '/api/projects'
      ? [{ id: '01234567-89ab-4cde-8f01-23456789abcd', name: 'Project A' }]
      : { opened: true, id: '01234567-89ab-4cde-8f01-23456789abcd' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));

  const remote = new RemoteCore({ baseUrl: `http://127.0.0.1:${server.address().port}`, deviceToken: 'test-device-token' });
  const projects = await remote.projects();
  const opened = await remote.open_project({ project_id: '01234567-89ab-4cde-8f01-23456789abcd' });

  assert.equal(projects[0].name, 'Project A');
  assert.equal(opened.opened, true);
  assert.deepEqual(calls, [
    { method: 'POST', url: '/api/projects', body: {} },
    { method: 'POST', url: '/api/open_project', body: { project_id: '01234567-89ab-4cde-8f01-23456789abcd' } },
  ]);
});
