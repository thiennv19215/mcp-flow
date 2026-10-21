import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { shapes } from '../dist/schemas.js';
import { LocalCore } from '../dist/core.js';
import { RemoteCore } from '../dist/remote.js';
import { createFlowMcpServer } from '../dist/mcp-tools.js';

const source = readFileSync(new URL('../extension/content/providers/flow/FlowGenerationOperations.js', import.meta.url), 'utf8');
const projectId = '00000000-0000-4000-8000-000000000000';

function harness({ prompt = 'known test prompt', controls = [{}], projectMatches = true, referenceStates = null, chipStates = null } = {}) {
  let currentPrompt = prompt;
  let clearCalls = 0;
  let referenceRead = 0;
  const preserved = { pickerOpen: true, chipCount: 2, chips: [{ kind: 'image' }, { kind: 'character' }] };
  const stateValues = referenceStates || [preserved, preserved];
  const chips = chipStates || [
    [{ kind: 'image', name: 'reference image', mediaId: '00000000-0000-4000-8000-000000000001' }, { kind: 'character', name: 'character one', mediaId: '00000000-0000-4000-8000-000000000002' }],
    [{ kind: 'image', name: 'reference image', mediaId: '00000000-0000-4000-8000-000000000001' }, { kind: 'character', name: 'character one', mediaId: '00000000-0000-4000-8000-000000000002' }],
  ];
  const context = vm.createContext({
    Date, Promise, Set, Object, Math, String, Number, Boolean, Array, Error,
    location: { href: `https://flow.google.com/project/${projectId}` },
    document: { querySelectorAll: () => controls },
    visible: () => true,
    ProviderRegistry: { describeUrl: () => ({ projectId, isProjectEditor: true }) },
    FlowMediaMenu: { nativeRead: () => ({ signedIn: true, inProject: true, isProjectEditor: true, projectId: projectMatches ? projectId : '11111111-1111-4111-8111-111111111111' }) },
    FlowEditor: {
      getEditorUserText: () => currentPrompt,
      clearEditorTextPreservingChips: async () => { clearCalls++; currentPrompt = ''; return true; },
    },
    FlowComponents: { FlowReferenceActions: {
      inspectDiagnostics: () => stateValues[Math.min(referenceRead++, stateValues.length - 1)],
      chips: () => chips[Math.min(referenceRead === 0 ? 0 : referenceRead - 1, chips.length - 1)],
    } },
  });
  vm.runInContext(source, context);
  const driver = { error: (code, message, retryable, outcome_unknown) => Object.assign(new Error(message), { code, retryable, outcome_unknown }) };
  return { ops: new context.FlowGenerationOperations(driver), getPrompt: () => currentPrompt, clearCalls: () => clearCalls };
}

test('flow_clear_prompt requires nonempty exact expected text', () => {
  assert.equal(z.object(shapes.clear_prompt).parse({ expected_prompt: 'known test prompt' }).expected_prompt, 'known test prompt');
  assert.throws(() => z.object(shapes.clear_prompt).parse({}), /expected_prompt/);
  assert.throws(() => z.object(shapes.clear_prompt).parse({ expected_prompt: '' }));
});

test('clears only the exact prompt and verifies reference chips and picker state are preserved', async () => {
  const { ops, getPrompt, clearCalls } = harness();
  const result = await ops.execute('flow.prompt.clear', { expectedPrompt: 'known test prompt' }, {});
  assert.deepEqual({ ...result }, {
    cleared: true, confirmed: true, projectId, references_preserved: true, picker_state_preserved: true,
  });
  assert.equal(getPrompt(), '');
  assert.equal(clearCalls(), 1);
});

test('prompt mismatch leaves the editor untouched', async () => {
  const { ops, getPrompt, clearCalls } = harness();
  await assert.rejects(ops.execute('flow.prompt.clear', { expectedPrompt: 'different prompt' }, {}), error =>
    error.code === 'FLOW_PROMPT_CLEAR_TEXT_MISMATCH' && error.outcome_unknown === false);
  assert.equal(getPrompt(), 'known test prompt');
  assert.equal(clearCalls(), 0);
});

test('ambiguous visible prompt controls fail before editing', async () => {
  const { ops, getPrompt, clearCalls } = harness({ controls: [{}, {}] });
  await assert.rejects(ops.execute('flow.prompt.clear', { expectedPrompt: 'known test prompt' }, {}), error =>
    error.code === 'FLOW_PROMPT_CONTROL_AMBIGUOUS' && error.outcome_unknown === false);
  assert.equal(getPrompt(), 'known test prompt');
  assert.equal(clearCalls(), 0);
});

test('project mismatch fails before editing', async () => {
  const { ops, getPrompt, clearCalls } = harness({ projectMatches: false });
  await assert.rejects(ops.execute('flow.prompt.clear', { expectedPrompt: 'known test prompt' }, {}), error =>
    error.code === 'FLOW_PROMPT_CLEAR_PROJECT_UNVERIFIED' && error.outcome_unknown === false);
  assert.equal(getPrompt(), 'known test prompt');
  assert.equal(clearCalls(), 0);
});

test('queue busy guard prevents the local API from issuing a prompt clear', async () => {
  const core = new LocalCore(`clear-prompt-busy-${randomUUID()}`);
  core.queue.list = () => [{ status: 'queued' }];
  await assert.rejects(core.clear_prompt({ expected_prompt: 'known test prompt' }), /generation is running/i);
});

test('MCP registers flow_clear_prompt and forwards the required exact prompt', async () => {
  const calls = [];
  const server = createFlowMcpServer({
    clear_prompt: async args => { calls.push(args); return { cleared: true }; },
  });
  const tool = server._registeredTools.flow_clear_prompt;
  assert.ok(tool);
  assert.equal(tool.annotations.destructiveHint, true);
  assert.equal(tool.inputSchema.safeParse({}).success, false);
  const result = await tool.handler({ expected_prompt: 'known test prompt' });
  assert.deepEqual(JSON.parse(result.content[0].text), { cleared: true });
  assert.deepEqual(calls, [{ expected_prompt: 'known test prompt' }]);
});

test('RemoteCore forwards flow_clear_prompt to the local owner API', async t => {
  const calls = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    calls.push({ method: request.method, url: request.url, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ cleared: true, confirmed: true }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));

  const remote = new RemoteCore({ baseUrl: `http://127.0.0.1:${server.address().port}`, deviceToken: 'test-device-token' });
  assert.deepEqual(await remote.clear_prompt({ expected_prompt: 'known test prompt' }), { cleared: true, confirmed: true });
  assert.deepEqual(calls, [{ method: 'POST', url: '/api/clear_prompt', body: { expected_prompt: 'known test prompt' } }]);
});

test('reference or picker state changes after prompt clearing are reported as unknown', async () => {
  const states = [
    { pickerOpen: true, chipCount: 2, chips: [{ kind: 'image' }, { kind: 'character' }] },
    { pickerOpen: false, chipCount: 2, chips: [{ kind: 'image' }, { kind: 'character' }] },
  ];
  const { ops, getPrompt, clearCalls } = harness({ referenceStates: states });
  await assert.rejects(ops.execute('flow.prompt.clear', { expectedPrompt: 'known test prompt' }, {}), error =>
    error.code === 'FLOW_PROMPT_CLEAR_STATE_CHANGED' && error.outcome_unknown === true);
  assert.equal(getPrompt(), '');
  assert.equal(clearCalls(), 1);
});

test('same-kind reference replacement after clearing is detected by stable chip identity', async () => {
  const chipStates = [
    [{ kind: 'image', name: 'reference image', mediaId: '00000000-0000-4000-8000-000000000001' }, { kind: 'character', name: 'character one', mediaId: '00000000-0000-4000-8000-000000000002' }],
    [{ kind: 'image', name: 'different image', mediaId: '00000000-0000-4000-8000-000000000003' }, { kind: 'character', name: 'character one', mediaId: '00000000-0000-4000-8000-000000000002' }],
  ];
  const { ops, getPrompt, clearCalls } = harness({ chipStates });
  await assert.rejects(ops.execute('flow.prompt.clear', { expectedPrompt: 'known test prompt' }, {}), error =>
    error.code === 'FLOW_PROMPT_CLEAR_STATE_CHANGED' && error.outcome_unknown === true);
  assert.equal(getPrompt(), '');
  assert.equal(clearCalls(), 1);
});

test('reference chips without unique stable identities block clearing before mutation', async () => {
  const chipStates = [[{ kind: 'image' }, { kind: 'character', name: 'character one' }]];
  const { ops, getPrompt, clearCalls } = harness({ chipStates });
  await assert.rejects(ops.execute('flow.prompt.clear', { expectedPrompt: 'known test prompt' }, {}), error =>
    error.code === 'FLOW_PROMPT_CLEAR_STATE_UNVERIFIABLE' && error.outcome_unknown === false);
  assert.equal(getPrompt(), 'known test prompt');
  assert.equal(clearCalls(), 0);
});
