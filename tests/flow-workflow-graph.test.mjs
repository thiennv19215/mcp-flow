import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  FlowWorkflowGraphRuns,
  WorkflowGraphError,
  compileWorkflowGraph,
  computeWorkflowFinalizeState,
  createWorkflowGraphRun,
  exportWorkflowGraph,
  foldWorkflowSnapshotIntoRun,
  importWorkflowGraph,
  levelWorkflowGraph,
  normalizeWorkflowGraph,
  validateWorkflowGraph,
  workflowPortsCompatible,
} from '../extension/src/background/flow-workflow-graph.js';
import { planFlowBatch } from '../extension/src/background/flow-workflows.js';
import { createFlowMcpServer } from '../dist/mcp-tools.js';

const serviceWorkerSource = readFileSync(new URL('../extension/src/background/service-worker.js', import.meta.url), 'utf8');
const mcpToolsSource = readFileSync(new URL('../src/mcp-tools.ts', import.meta.url), 'utf8');

// ---------------------------------------------------------------------------
// FEAT-07: node-graph workflow executor on the queue (study B8, executor
// half). A pure graph module (validate, topological leveling, port
// compatibility matrix, node → queue-job compilation) plus a runner that
// enqueues compiled jobs with workflow metadata and folds receipts like
// FEAT-02; export/import under a per-type field whitelist. MCP gains a
// "run workflow graph" surface using the existing planners' job shapes.
// ---------------------------------------------------------------------------

function memoryStorage() {
  const data = {};
  return {
    data,
    async get(key) { return { [key]: data[key] }; },
    async set(entries) { Object.assign(data, entries); },
  };
}

const hasCode = code => error => {
  assert.equal(error?.code, code, `expected error code ${code}, got ${error?.code} (${error?.message})`);
  return true;
};

const genNode = (id, config = {}) => ({ id, type: 'generate', config: { prompt: `prompt ${id}`, type: 'image', ...config } });
const edge = (source, sourcePort, target, targetPort) => ({ source, sourcePort, target, targetPort });

const diamondGraph = () => ({
  name: 'Diamond',
  nodes: [genNode('a'), genNode('b'), genNode('c'), genNode('d')],
  edges: [
    edge('a', 'media', 'b', 'image_ref'),
    edge('a', 'media', 'c', 'image_ref'),
    edge('b', 'media', 'd', 'image_ref'),
    edge('c', 'media', 'd', 'image_ref'),
  ],
});

const MEDIA = id => ({ id, title: `title-${id}`, kind: 'image' });

const finishedJob = ({ id, status = 'completed', media = [], failedOutputs = [], partial = false, error = null, errorCode = null }) => ({
  id,
  operation: 'flow.generation.submit',
  payload: { type: 'image', prompt: 'scene', attachments: [] },
  status,
  startedAt: 1_000,
  finishedAt: 2_000,
  ...(error ? { error, errorCode } : {}),
  ...(partial ? { partial: true } : {}),
  ...(status === 'completed'
    ? { result: { completed: true, result: { media, ...(failedOutputs.length ? { failedOutputs } : {}) } } }
    : {}),
});

const snapshotOf = jobs => ({ jobs });

// --- port compatibility matrix ---------------------------------------------

test('port compatibility follows the reference matrix (frame rejects text, image accepts frame)', () => {
  assert.equal(workflowPortsCompatible('image', 'frame'), true);
  assert.equal(workflowPortsCompatible('frame', 'image'), true);
  assert.equal(workflowPortsCompatible('text', 'frame'), false);
  assert.equal(workflowPortsCompatible('frame', 'text'), false);
  assert.equal(workflowPortsCompatible('text', 'text'), true);
  assert.equal(workflowPortsCompatible('video', 'video'), true);
  assert.equal(workflowPortsCompatible('video', 'image'), false);
  assert.equal(workflowPortsCompatible('image', 'video'), false);
  assert.equal(workflowPortsCompatible('any', 'frame'), true);
  assert.equal(workflowPortsCompatible('video', 'any'), true);
});

// --- validation --------------------------------------------------------------

test('validate: a frame port rejects a text edge', () => {
  const graph = {
    nodes: [
      { id: 't1', type: 'text', config: { text: 'hello' } },
      genNode('g1', { type: 'video' }),
    ],
    edges: [edge('t1', 'text', 'g1', 'frame_1')],
  };
  assert.throws(() => validateWorkflowGraph(graph), hasCode('FLOW_WORKFLOW_PORT_INCOMPATIBLE'));
});

test('validate: unknown node types, duplicate ids and dangling edges are rejected', () => {
  assert.throws(
    () => validateWorkflowGraph({ nodes: [{ id: 'x', type: 'nope', config: {} }], edges: [] }),
    hasCode('FLOW_WORKFLOW_NODE_TYPE_UNKNOWN'),
  );
  assert.throws(
    () => validateWorkflowGraph({ nodes: [genNode('a'), genNode('a')], edges: [] }),
    hasCode('FLOW_WORKFLOW_NODE_ID_DUPLICATE'),
  );
  assert.throws(
    () => validateWorkflowGraph({ nodes: [genNode('a')], edges: [edge('a', 'media', 'ghost', 'image_ref')] }),
    hasCode('FLOW_WORKFLOW_EDGE_NODE_MISSING'),
  );
  assert.throws(
    () => validateWorkflowGraph({ nodes: [genNode('a')], edges: [edge('a', 'bogus', 'a', 'image_ref')] }),
    hasCode('FLOW_WORKFLOW_PORT_UNKNOWN'),
  );
});

test('validate: a second edge into a single (non-multiple) port is rejected, and required ports must be fed', () => {
  const twoFrames = {
    nodes: [
      { id: 'i1', type: 'image', config: { asset: 'One' } },
      { id: 'i2', type: 'image', config: { asset: 'Two' } },
      genNode('g1', { type: 'video' }),
    ],
    edges: [edge('i1', 'media', 'g1', 'frame_1'), edge('i2', 'media', 'g1', 'frame_1')],
  };
  assert.throws(() => validateWorkflowGraph(twoFrames), hasCode('FLOW_WORKFLOW_PORT_MULTIPLE'));

  const hungryDownload = { nodes: [{ id: 'd1', type: 'download', config: {} }], edges: [] };
  assert.throws(() => validateWorkflowGraph(hungryDownload), hasCode('FLOW_WORKFLOW_PORT_REQUIRED'));
});

test('validate: a generate node with no prompt anywhere is rejected; a text edge can supply the prompt', () => {
  const bare = { nodes: [{ id: 'g1', type: 'generate', config: { type: 'image' } }], edges: [] };
  assert.throws(() => validateWorkflowGraph(bare), hasCode('FLOW_WORKFLOW_PROMPT_MISSING'));

  const fed = {
    nodes: [
      { id: 't1', type: 'text', config: { text: 'a castle on a hill' } },
      { id: 'g1', type: 'generate', config: { type: 'image' } },
    ],
    edges: [edge('t1', 'text', 'g1', 'text')],
  };
  assert.doesNotThrow(() => validateWorkflowGraph(fed));
});

test('validate: chatgpt nodes refuse library/dynamic image edges — their refs must be payload records', () => {
  const graph = {
    nodes: [
      { id: 'i1', type: 'image', config: { asset: 'Hero' } },
      { id: 'c1', type: 'chatgpt', config: { prompt: 'draw it' } },
    ],
    edges: [edge('i1', 'media', 'c1', 'image_ref')],
  };
  assert.throws(() => validateWorkflowGraph(graph), hasCode('FLOW_WORKFLOW_CHATGPT_REFS_PAYLOAD_ONLY'));
});

// --- leveling ------------------------------------------------------------------

test('leveling: a diamond graph levels into [a] [b, c] [d]', () => {
  const { levels, levelOf } = levelWorkflowGraph(diamondGraph());
  assert.deepEqual(levels, [['a'], ['b', 'c'], ['d']]);
  assert.equal(levelOf.get('a'), 0);
  assert.equal(levelOf.get('d'), 2);
});

test('leveling: a cycle is rejected and names the trapped nodes', () => {
  const cyclic = {
    nodes: [genNode('a'), genNode('b')],
    edges: [edge('a', 'media', 'b', 'image_ref'), edge('b', 'media', 'a', 'image_ref')],
  };
  assert.throws(() => levelWorkflowGraph(cyclic), error => {
    assert.equal(error.code, 'FLOW_WORKFLOW_GRAPH_CYCLE');
    assert.match(error.message, /a/);
    assert.match(error.message, /b/);
    return true;
  });
  assert.throws(() => compileWorkflowGraph(cyclic, { project: 'P' }), hasCode('FLOW_WORKFLOW_GRAPH_CYCLE'));
});

// --- compilation -----------------------------------------------------------------

test('compile: a Flow generate node compiles field-for-field to the planner generation payload', () => {
  const scene = {
    prompt: 'A lighthouse at dawn',
    type: 'video',
    model: 'veo-3.1-fast',
    aspect_ratio: '16:9',
    duration: 8,
    resolution: '720p',
    reference_images: ['asset:Hero Rock'],
    first_frame: 'asset:Start Frame',
    max_credits: 25,
  };
  const planned = planFlowBatch({ project: 'Proj', scenes: [scene] }, {}).jobs[0];
  const compiled = compileWorkflowGraph(
    { nodes: [{ id: 'g1', type: 'generate', config: { ...scene } }], edges: [] },
    { project: 'Proj', outputDir: 'Proj', runId: 'run-1' },
  );
  const node = compiled.nodes[0];
  assert.equal(node.disposition, 'job');
  assert.equal(node.job.operation, planned.operation);
  // workflow + file_stem legitimately differ (graph bookkeeping vs scene
  // numbering); every generation field must match the planner exactly.
  const strip = payload => {
    const { workflow, file_stem, ...rest } = payload;
    return rest;
  };
  assert.deepEqual(strip(node.job.payload), strip(planned.payload));
  assert.equal(node.job.payload.output_dir, planned.payload.output_dir);
  assert.equal(node.job.payload.workflow.project, 'Proj');
  assert.equal(node.job.payload.workflow.workflowGraph.nodeId, 'g1');
  assert.equal(node.job.metadata.workflowGraphRunId, 'run-1');
  assert.equal(node.job.metadata.workflowNodeId, 'g1');
});

test('compile: text edges feed the prompt in edge order and image nodes feed attachments', () => {
  const graph = {
    nodes: [
      { id: 't1', type: 'text', config: { text: 'golden hour light' } },
      { id: 'i1', type: 'image', config: { asset: 'Hero Rock', expected_id: 'media-1' } },
      genNode('g1', { prompt: 'A lighthouse', type: 'image' }),
    ],
    edges: [
      edge('t1', 'text', 'g1', 'text'),
      edge('i1', 'media', 'g1', 'image_ref'),
    ],
  };
  const compiled = compileWorkflowGraph(graph, { project: 'P', runId: 'run-2' });
  const job = compiled.nodes.find(node => node.nodeId === 'g1').job;
  assert.equal(job.payload.prompt, 'A lighthouse. golden hour light');
  assert.deepEqual(job.payload.attachments, [{ assetName: 'Hero Rock', expectedId: 'media-1' }]);
  assert.equal(compiled.nodes.find(node => node.nodeId === 't1').disposition, 'source');
  assert.equal(compiled.nodes.find(node => node.nodeId === 'i1').disposition, 'source');
});

test('compile: dynamic generation edges are recorded as upstream inputs, not baked into the payload', () => {
  const compiled = compileWorkflowGraph(diamondGraph(), { project: 'P', runId: 'run-3' });
  const d = compiled.nodes.find(node => node.nodeId === 'd');
  assert.deepEqual(d.dependsOnNodeIds, ['b', 'c']);
  assert.deepEqual(d.job.payload.workflow.upstreamInputs, [
    { fromNodeId: 'b', fromPort: 'media', intoPort: 'image_ref' },
    { fromNodeId: 'c', fromPort: 'media', intoPort: 'image_ref' },
  ]);
  assert.equal(d.job.payload.attachments, undefined);
});

// --- export / import ---------------------------------------------------------------

test('export/import: the round-trip preserves only whitelisted fields per node type', () => {
  const graph = {
    name: 'Export me',
    nodes: [
      {
        id: 'g1', type: 'generate', name: 'Hero shot', x: 10, y: 20,
        config: {
          prompt: 'A lighthouse', type: 'video', model: 'veo-3.1-fast', aspect_ratio: '16:9',
          hackerField: 'drop me', runtimeState: { status: 'running' },
        },
      },
      { id: 't1', type: 'text', config: { text: 'hello', junk: 1 } },
    ],
    edges: [edge('t1', 'text', 'g1', 'text')],
  };
  const exported = exportWorkflowGraph(graph);
  assert.equal(exported.kind, 'flow.workflow-graph');
  assert.equal(exported.version, 1);
  const g1 = exported.nodes.find(node => node.id === 'g1');
  assert.equal(g1.config.hackerField, undefined);
  assert.equal(g1.config.runtimeState, undefined);
  assert.equal(g1.config.prompt, 'A lighthouse');
  assert.equal(g1.x, 10);
  assert.equal(exported.nodes.find(node => node.id === 't1').config.junk, undefined);

  const imported = importWorkflowGraph(exported);
  // Import yields the normalized graph of exactly the whitelisted
  // document — the junk fields are gone for good.
  assert.deepEqual(imported, normalizeWorkflowGraph({
    name: 'Export me',
    nodes: [
      { id: 'g1', type: 'generate', name: 'Hero shot', x: 10, y: 20, config: { prompt: 'A lighthouse', type: 'video', model: 'veo-3.1-fast', aspect_ratio: '16:9' } },
      { id: 't1', type: 'text', config: { text: 'hello' } },
    ],
    edges: [edge('t1', 'text', 'g1', 'text')],
  }));
});

test('import: foreign documents are rejected and junk fields never survive', () => {
  assert.throws(() => importWorkflowGraph({ kind: 'something-else', version: 1, nodes: [], edges: [] }), hasCode('FLOW_WORKFLOW_IMPORT_KIND'));
  assert.throws(() => importWorkflowGraph(null), hasCode('FLOW_WORKFLOW_IMPORT_INVALID'));
  assert.throws(() => importWorkflowGraph({ kind: 'flow.workflow-graph', version: 99, nodes: [], edges: [] }), hasCode('FLOW_WORKFLOW_IMPORT_VERSION'));
});

// --- run records + receipt fold ------------------------------------------------------

test('run: creation compiles the graph and hands out only the first level', async () => {
  const store = new FlowWorkflowGraphRuns({ storage: memoryStorage() });
  const { run, toEnqueue } = await store.create({ graph: diamondGraph(), project: 'P', outputDir: 'P' });
  assert.equal(run.state, 'active');
  assert.deepEqual(toEnqueue.map(entry => entry.nodeId), ['a']);
  assert.equal(toEnqueue[0].job.operation, 'flow.generation.submit');
  const nodeA = run.nodes.find(node => node.nodeId === 'a');
  assert.equal(nodeA.handedOut, true);
  assert.equal(run.nodes.find(node => node.nodeId === 'd').handedOut, false);
});

test('run: receipts fold by runtime job id and levels advance as dependencies complete', async () => {
  const store = new FlowWorkflowGraphRuns({ storage: memoryStorage() });
  const { run, toEnqueue } = await store.create({ graph: diamondGraph(), project: 'P', outputDir: 'P' });
  await store.recordAdmission(run.id, { mapping: [{ nodeId: 'a', jobId: 'job-a' }] });

  const [fold1] = await store.observeSnapshot(snapshotOf([
    finishedJob({ id: 'job-a', media: [MEDIA('m-a')] }),
  ]));
  assert.equal(fold1.run.id, run.id);
  assert.deepEqual(fold1.toEnqueue.map(entry => entry.nodeId), ['b', 'c']);
  // The dynamic media edge resolves from the upstream receipt at admission.
  const bJob = fold1.toEnqueue.find(entry => entry.nodeId === 'b').job;
  assert.deepEqual(bJob.payload.attachments, [{ assetName: 'title-m-a', expectedId: 'm-a' }]);

  await store.recordAdmission(run.id, { mapping: [{ nodeId: 'b', jobId: 'job-b' }, { nodeId: 'c', jobId: 'job-c' }] });
  const [fold2] = await store.observeSnapshot(snapshotOf([
    finishedJob({ id: 'job-a', media: [MEDIA('m-a')] }),
    finishedJob({ id: 'job-b', media: [MEDIA('m-b')] }),
    finishedJob({ id: 'job-c', media: [MEDIA('m-c')] }),
  ]));
  assert.deepEqual(fold2.toEnqueue.map(entry => entry.nodeId), ['d']);
  const dJob = fold2.toEnqueue[0].job;
  assert.deepEqual(dJob.payload.attachments, [
    { assetName: 'title-m-b', expectedId: 'm-b' },
    { assetName: 'title-m-c', expectedId: 'm-c' },
  ]);

  await store.recordAdmission(run.id, { mapping: [{ nodeId: 'd', jobId: 'job-d' }] });
  const [fold3] = await store.observeSnapshot(snapshotOf([
    finishedJob({ id: 'job-a', media: [MEDIA('m-a')] }),
    finishedJob({ id: 'job-b', media: [MEDIA('m-b')] }),
    finishedJob({ id: 'job-c', media: [MEDIA('m-c')] }),
    finishedJob({ id: 'job-d', media: [MEDIA('m-d')] }),
  ]));
  assert.equal(fold3.finalizeState, 'completed');
  assert.equal(fold3.run.state, 'finalized');
  assert.deepEqual(fold3.toEnqueue, []);
});

test('fold: a dependency-failed node is skipped with a reason and its downstream is skipped transitively', () => {
  const run = createWorkflowGraphRun({
    nodes: [genNode('a'), genNode('b'), genNode('c'), genNode('solo')],
    edges: [
      edge('a', 'media', 'b', 'image_ref'),
      edge('b', 'media', 'c', 'image_ref'),
    ],
  }, { project: 'P', runId: 'run-fail' });
  // Simulate admission of a + solo (the level-0 job nodes).
  run.nodes.find(node => node.nodeId === 'a').runtimeJobId = 'job-a';
  run.nodes.find(node => node.nodeId === 'solo').runtimeJobId = 'job-solo';

  const folded = foldWorkflowSnapshotIntoRun(run, snapshotOf([
    finishedJob({ id: 'job-a', status: 'failed', error: 'boom', errorCode: 'FLOW_GENERATION_FAILED' }),
    finishedJob({ id: 'job-solo', media: [MEDIA('m-solo')] }),
  ]));
  const b = folded.run.nodes.find(node => node.nodeId === 'b');
  const c = folded.run.nodes.find(node => node.nodeId === 'c');
  assert.equal(b.state, 'skipped');
  assert.equal(b.skipReason.code, 'FLOW_WORKFLOW_DEPENDENCY_FAILED');
  assert.equal(b.skipReason.dependency, 'a');
  assert.equal(c.state, 'skipped');
  assert.equal(c.skipReason.dependency, 'b');
  assert.equal(folded.run.nodes.find(node => node.nodeId === 'solo').state, 'completed');
  assert.equal(folded.allTerminal, true);
  // One clean completion + skips = a human decides (FEAT-02 semantics).
  assert.equal(computeWorkflowFinalizeState(folded.run), 'needs_review');
});

test('fold: when every generation fails the run finalizes as failed', () => {
  const run = createWorkflowGraphRun({
    nodes: [genNode('a'), genNode('b')],
    edges: [edge('a', 'media', 'b', 'image_ref')],
  }, { project: 'P', runId: 'run-allfail' });
  run.nodes.find(node => node.nodeId === 'a').runtimeJobId = 'job-a';
  const folded = foldWorkflowSnapshotIntoRun(run, snapshotOf([
    finishedJob({ id: 'job-a', status: 'failed', error: 'boom', errorCode: 'FLOW_GENERATION_FAILED' }),
  ]));
  assert.equal(computeWorkflowFinalizeState(folded.run), 'failed');
});

test('run: a handed-out node whose enqueue failed can be released and is handed out again', async () => {
  const store = new FlowWorkflowGraphRuns({ storage: memoryStorage() });
  const { run } = await store.create({ graph: { nodes: [genNode('only')], edges: [] }, project: 'P' });
  await store.releaseEnqueue(run.id, ['only']);
  const [fold] = await store.observeSnapshot(snapshotOf([]));
  assert.deepEqual(fold.toEnqueue.map(entry => entry.nodeId), ['only']);
});

// --- service-worker wiring contracts ------------------------------------------------------

test('service worker wires the workflow graph runner (import, bridge command, snapshot fold)', () => {
  assert.match(serviceWorkerSource, /import \{ FlowWorkflowGraphRuns \} from "\.\/flow-workflow-graph\.js";/);
  assert.match(serviceWorkerSource, /const flowWorkflowGraphRuns = new FlowWorkflowGraphRuns\(\);/);
  // The bridge command is admitted by both operation sets.
  const nativeOps = serviceWorkerSource.match(/const nativeFlowOperations = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(nativeOps && nativeOps[1].includes('"flow.queue.workflow"'), 'nativeFlowOperations must admit flow.queue.workflow');
  const queueOps = serviceWorkerSource.match(/const extensionQueueOperations = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(queueOps && queueOps[1].includes('"flow.queue.workflow"'), 'extensionQueueOperations must admit flow.queue.workflow');
  assert.match(serviceWorkerSource, /command\.name === "flow\.queue\.workflow"/);
  assert.match(serviceWorkerSource, /flowWorkflowGraphRuns\.observeSnapshot\(snapshot\)/);
});

// --- MCP surface ----------------------------------------------------------------------------

test('MCP: flow_run_workflow is registered and forwards the graph to the core method', async () => {
  const calls = [];
  const server = createFlowMcpServer({
    run_workflow_graph: async args => { calls.push(args); return { run: { id: 'run-9' }, jobs: [] }; },
  });
  const tool = server._registeredTools.flow_run_workflow;
  assert.ok(tool, 'flow_run_workflow must be registered');
  const args = {
    project: 'Proj',
    graph: { nodes: [{ id: 'g1', type: 'generate', config: { prompt: 'x', type: 'image' } }], edges: [] },
  };
  const parsed = tool.inputSchema.safeParse(args);
  assert.equal(parsed.success, true);
  const result = await tool.handler(args);
  assert.deepEqual(JSON.parse(result.content[0].text), { run: { id: 'run-9' }, jobs: [] });
  assert.deepEqual(calls, [args]);
});

test('MCP: without a core forward, flow_run_workflow answers a clear error instead of vanishing', async () => {
  const server = createFlowMcpServer({});
  const tool = server._registeredTools.flow_run_workflow;
  assert.ok(tool);
  const result = await tool.handler({ project: 'Proj', graph: { nodes: [{ id: 'g1', type: 'generate', config: { prompt: 'x' } }], edges: [] } });
  assert.equal(result.isError, true);
  assert.match(JSON.parse(result.content[0].text).error, /run_workflow_graph/);
});

test('MCP source: the tool shape lives in mcp-tools.ts next to the other MCP-only shapes', () => {
  assert.match(mcpToolsSource, /"flow_run_workflow"/);
  assert.match(mcpToolsSource, /run_workflow_graph/);
});
