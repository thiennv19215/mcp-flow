import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { LocalCore } from '../dist/core.js';
import { RemoteCore } from '../dist/remote.js';

const coreSource = readFileSync(new URL('../src/core.ts', import.meta.url), 'utf8');
const remoteSource = readFileSync(new URL('../src/remote.ts', import.meta.url), 'utf8');

// ---------------------------------------------------------------------------
// Phase 5 core forwards — two small debts left by earlier items:
//
//   GPT-11: LocalCore.chatgpt_generate shipped, but RemoteCore's explicit
//   forwarding list did not include it, so an MCP server hosted by a
//   relay process answered chatgpt_generate with a "not forwarded yet"
//   error even though the owner process could serve it. The owner's HTTP
//   API dispatches /api/<method> generically, so the one-line forward
//   is the whole fix.
//
//   FEAT-07: the flow_run_workflow MCP tool forwards to the extension
//   bridge command flow.queue.workflow, but LocalCore never grew the
//   run_workflow_graph method the tool looks up — the tool answered a
//   clear "not implemented yet" error. LocalCore now forwards
//   { graph, project, output_dir, auto_start } to that bridge command.
// ---------------------------------------------------------------------------

// --- GPT-11: RemoteCore forwards chatgpt_generate ----------------------------

test('RemoteCore exposes chatgpt_generate (the MCP tool no longer hits the missing-method fallback)', () => {
  const remote = new RemoteCore('http://127.0.0.1:1');
  assert.equal(typeof remote.chatgpt_generate, 'function');
});

test('RemoteCore.chatgpt_generate relays the args to the owner /api/chatgpt_generate endpoint', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ relayed: true, jobs: [] }) };
  };
  try {
    const remote = new RemoteCore('http://127.0.0.1:18899');
    const args = { project: 'ChatArt', prompt: 'a cat wearing a hat', ratio: '16:9' };
    const out = await remote.chatgpt_generate(args);
    assert.deepEqual(out, { relayed: true, jobs: [] }, 'the owner answer is relayed verbatim');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://127.0.0.1:18899/api/chatgpt_generate');
    assert.equal(calls[0].init.method, 'POST');
    assert.deepEqual(JSON.parse(calls[0].init.body), args, 'the args cross the relay unchanged');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('remote.ts source: chatgpt_generate is a one-line request forward, like its siblings', () => {
  assert.ok(remoteSource.includes('chatgpt_generate = (a'), 'RemoteCore declares the forwarding property');
  assert.ok(remoteSource.includes('this.request("chatgpt_generate", a)'), 'the forward posts to the chatgpt_generate API method');
});

// --- FEAT-07 follow-up: RemoteCore forwards run_workflow_graph ----------------

test('RemoteCore exposes run_workflow_graph (the relay no longer answers not-implemented)', () => {
  const remote = new RemoteCore('http://127.0.0.1:1');
  assert.equal(typeof remote.run_workflow_graph, 'function');
});

test('RemoteCore.run_workflow_graph relays the args to the owner /api/run_workflow_graph endpoint', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ run: { id: 'run-1' }, jobs: [] }) };
  };
  try {
    const remote = new RemoteCore('http://127.0.0.1:18899');
    const args = { project: 'P', graph: { nodes: [], edges: [] } };
    const out = await remote.run_workflow_graph(args);
    assert.deepEqual(out, { run: { id: 'run-1' }, jobs: [] }, 'the owner answer is relayed verbatim');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://127.0.0.1:18899/api/run_workflow_graph');
    assert.equal(calls[0].init.method, 'POST');
    assert.deepEqual(JSON.parse(calls[0].init.body), args, 'the args cross the relay unchanged');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// --- FEAT-07: LocalCore.run_workflow_graph -----------------------------------

test('LocalCore exposes run_workflow_graph (the MCP tool lookup finds it)', () => {
  const core = new LocalCore();
  assert.equal(typeof core.run_workflow_graph, 'function');
});

test('LocalCore.run_workflow_graph validates its envelope before touching the bridge', async () => {
  const core = new LocalCore();
  await assert.rejects(
    () => core.run_workflow_graph({ graph: { nodes: [] } }),
    /project/,
    'a missing project is refused locally',
  );
  await assert.rejects(
    () => core.run_workflow_graph({ project: 'Proj' }),
    /graph/,
    'a missing graph document is refused locally',
  );
  await assert.rejects(
    () => core.run_workflow_graph({ project: 'Proj', graph: 'not-a-document' }),
    /graph/,
    'a non-object graph is refused locally',
  );
});

test('core.ts source: run_workflow_graph forwards the envelope to flow.queue.workflow', () => {
  assert.ok(coreSource.includes('async run_workflow_graph('), 'LocalCore implements the method');
  assert.ok(coreSource.includes('"flow.queue.workflow"'), 'the forward targets the FEAT-07 bridge command');
  assert.ok(coreSource.includes('graph: args.graph'), 'the graph document is forwarded');
  assert.ok(coreSource.includes('project: args.project'), 'the project is forwarded');
  assert.ok(coreSource.includes('output_dir: args.output_dir'), 'output_dir is forwarded');
  assert.ok(coreSource.includes('autoStart: args.auto_start'), 'auto_start maps to the bridge payload spelling the worker reads');
});
