import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  FlowWorkflowTemplates,
  WorkflowTemplateError,
  createWorkflowTemplateRecord,
  exportWorkflowTemplate,
  importWorkflowTemplate,
  instantiateWorkflowTemplate,
} from '../extension/src/background/flow-workflow-templates.js';
import {
  exportWorkflowGraph,
} from '../extension/src/background/flow-workflow-graph.js';

const sidebarSource = readFileSync(new URL('../extension/src/ui/sidebar.js', import.meta.url), 'utf8');
const sidebarHtml = readFileSync(new URL('../extension/src/ui/sidebar.html', import.meta.url), 'utf8');

// ---------------------------------------------------------------------------
// FEAT-08: local workflow templates (study feature #14, local half). Any
// workflow (FEAT-07 graph model) can be saved as a named template with
// description/category and later instantiated as a new workflow; templates
// export/import as files under the SAME per-type field whitelist FEAT-07
// applies — this module never defines its own whitelist. The browsable
// catalog + creator publishing stay blocked (FEAT-B4, vendor backend).
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

// A graph carrying runtime state and foreign fields at every level: node
// status/results, runtime ids, non-whitelisted config keys, edge extras.
// None of it may survive into a template or an instantiated workflow.
const richGraph = () => ({
  name: 'Drama pipeline',
  nodes: [
    {
      id: 'src', type: 'text', name: 'Idea', x: 10, y: 20,
      status: 'completed', result: { media: [{ id: 'm1' }] },
      config: { text: 'A mother waits at the gate', foreign_note: 'drop me' },
    },
    {
      id: 'gen', type: 'generate', name: 'Scene 1',
      runtimeJobId: 'job-123', receipt: { status: 'completed' },
      config: {
        prompt: 'scene one', type: 'image', model: 'nano', aspect_ratio: '16:9', quantity: 1,
        status: 'done', runtime_secret: 'drop me',
      },
    },
    {
      id: 'dl', type: 'download',
      config: { auto_download: true, download_quality: 'original', last_error: 'drop me' },
    },
  ],
  edges: [
    { id: 'e1', source: 'src', sourcePort: 'text', target: 'gen', targetPort: 'text', weight: 3 },
    { id: 'e2', source: 'gen', sourcePort: 'media', target: 'dl', targetPort: 'media_in' },
  ],
});

function collectKeys(value, into = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, into);
  } else if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      into.add(key);
      collectKeys(nested, into);
    }
  }
  return into;
}

// --- save → instantiate --------------------------------------------------------

test('a saved template instantiates a workflow deep-equal in nodes/edges with runtime state stripped', async () => {
  const store = new FlowWorkflowTemplates({ storage: memoryStorage() });
  const graph = richGraph();
  const template = await store.save(graph, { description: 'Family drama scenes', category: 'drama' });

  assert.equal(template.name, 'Drama pipeline', 'name falls back to the graph name');
  assert.equal(template.description, 'Family drama scenes');
  assert.equal(template.category, 'drama');
  assert.ok(template.id && template.createdAt > 0 && template.updatedAt >= template.createdAt);

  const expected = exportWorkflowGraph(graph);
  assert.deepEqual(template.graph, expected, 'the store keeps only the whitelisted export document');

  const workflow = await store.instantiate(template.id);
  assert.deepEqual(workflow.nodes, expected.nodes);
  assert.deepEqual(workflow.edges, expected.edges);
  assert.equal(workflow.name, 'Drama pipeline');

  const keys = collectKeys(workflow);
  for (const banned of ['status', 'result', 'receipt', 'runtimeJobId', 'runtime_secret', 'foreign_note', 'last_error', 'weight']) {
    assert.ok(!keys.has(banned), `runtime/foreign key "${banned}" must not survive instantiation`);
  }
});

test('instantiation is a fresh deep copy: mutating it never touches the stored template', async () => {
  const store = new FlowWorkflowTemplates({ storage: memoryStorage() });
  const template = await store.save(richGraph(), {});
  const first = await store.instantiate(template.id);
  first.nodes[1].config.prompt = 'MUTATED';
  first.nodes.push({ id: 'extra', type: 'delay', config: { seconds: 1 } });

  const second = await store.instantiate(template.id);
  assert.equal(second.nodes.length, 3);
  assert.equal(second.nodes[1].config.prompt, 'scene one');
  const stored = await store.get(template.id);
  assert.deepEqual(stored.graph, exportWorkflowGraph(richGraph()));
});

test('instantiate accepts a name override and the pure helper mirrors the store path', async () => {
  const record = createWorkflowTemplateRecord(richGraph(), { name: 'Base', category: 'drama' });
  const workflow = instantiateWorkflowTemplate(record, { name: 'Episode 12' });
  assert.equal(workflow.name, 'Episode 12');
  assert.deepEqual(workflow.nodes, record.graph.nodes);
  assert.deepEqual(workflow.edges, record.graph.edges);
});

test('saving a template requires a resolvable name', async () => {
  const store = new FlowWorkflowTemplates({ storage: memoryStorage() });
  const anonymous = richGraph();
  delete anonymous.name;
  await assert.rejects(store.save(anonymous, {}), hasCode('FLOW_WORKFLOW_TEMPLATE_NAME_REQUIRED'));
  const named = await store.save(anonymous, { name: 'Named at save time' });
  assert.equal(named.name, 'Named at save time');
});

test('an invalid graph is rejected at save time by the FEAT-07 validation', async () => {
  const store = new FlowWorkflowTemplates({ storage: memoryStorage() });
  await assert.rejects(
    store.save({ name: 'Broken', nodes: [{ id: 'x', type: 'generate', config: {} }], edges: [{ source: 'x', target: 'ghost' }] }, {}),
    error => typeof error?.code === 'string' && error.code.startsWith('FLOW_WORKFLOW'),
  );
});

// --- export / import -----------------------------------------------------------

test('export/import round-trip preserves only whitelisted fields', async () => {
  const store = new FlowWorkflowTemplates({ storage: memoryStorage() });
  const template = await store.save(richGraph(), { description: 'desc', category: 'drama' });

  const doc = exportWorkflowTemplate(template);
  assert.deepEqual(Object.keys(doc).sort(), ['category', 'description', 'graph', 'kind', 'name', 'version']);
  assert.equal(doc.kind, 'flow.workflow-template');
  assert.equal(doc.version, 1);

  // Through a real file boundary: serialize + parse before importing.
  const revived = importWorkflowTemplate(JSON.parse(JSON.stringify(doc)));
  assert.equal(revived.name, 'Drama pipeline');
  assert.equal(revived.description, 'desc');
  assert.equal(revived.category, 'drama');
  assert.deepEqual(revived.graph, exportWorkflowGraph(richGraph()));

  const other = new FlowWorkflowTemplates({ storage: memoryStorage() });
  const imported = await other.importTemplate(JSON.parse(JSON.stringify(doc)));
  assert.notEqual(imported.id, template.id, 'import mints a fresh template id');
  const workflow = await other.instantiate(imported.id);
  assert.deepEqual(workflow.nodes, template.graph.nodes);
  assert.deepEqual(workflow.edges, template.graph.edges);
});

test('import strips foreign fields smuggled at the template-document level', () => {
  const record = createWorkflowTemplateRecord(richGraph(), { name: 'Clean' });
  const doc = exportWorkflowTemplate(record);
  const smuggled = {
    ...doc,
    author: 'someone else',
    rating: 5,
    graph: {
      ...doc.graph,
      server_id: 'srv-1',
      nodes: doc.graph.nodes.map((node, i) => (i === 0 ? { ...node, status: 'completed', config: { ...node.config, hacked: true } } : node)),
    },
  };
  const revived = importWorkflowTemplate(smuggled);
  assert.deepEqual(Object.keys(revived).sort(), ['category', 'description', 'graph', 'name']);
  const keys = collectKeys(revived.graph);
  for (const banned of ['server_id', 'status', 'hacked']) {
    assert.ok(!keys.has(banned), `smuggled key "${banned}" must be stripped on import`);
  }
});

test('import rejects a foreign document kind and an unsupported version', () => {
  const record = createWorkflowTemplateRecord(richGraph(), { name: 'Doc' });
  const doc = exportWorkflowTemplate(record);
  assert.throws(() => importWorkflowTemplate({ ...doc, kind: 'flow.workflow-graph' }), hasCode('FLOW_WORKFLOW_TEMPLATE_IMPORT_KIND'));
  assert.throws(() => importWorkflowTemplate({ ...doc, version: 99 }), hasCode('FLOW_WORKFLOW_TEMPLATE_IMPORT_VERSION'));
  assert.throws(() => importWorkflowTemplate(null), hasCode('FLOW_WORKFLOW_TEMPLATE_IMPORT_INVALID'));
  assert.throws(() => importWorkflowTemplate('a string'), hasCode('FLOW_WORKFLOW_TEMPLATE_IMPORT_INVALID'));
});

// --- store behavior --------------------------------------------------------------

test('templates persist across store instances and can be removed', async () => {
  const storage = memoryStorage();
  const first = new FlowWorkflowTemplates({ storage });
  const template = await first.save(richGraph(), { category: 'drama' });
  await first.flush();

  const second = new FlowWorkflowTemplates({ storage });
  const listed = await second.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, template.id);
  assert.deepEqual(listed[0].graph, template.graph);

  assert.equal(await second.remove(template.id), true);
  assert.equal(await second.remove(template.id), false, 'removing twice reports false');
  assert.equal(await second.get(template.id), null);
  await assert.rejects(second.instantiate(template.id), hasCode('FLOW_WORKFLOW_TEMPLATE_NOT_FOUND'));
});

test('the store caps retained templates, evicting the oldest first', async () => {
  const store = new FlowWorkflowTemplates({ storage: memoryStorage(), maxTemplates: 2 });
  const a = await store.save(richGraph(), { name: 'A' });
  await store.save(richGraph(), { name: 'B' });
  await store.save(richGraph(), { name: 'C' });
  const listed = await store.list();
  assert.deepEqual(listed.map(item => item.name), ['B', 'C']);
  assert.equal(await store.get(a.id), null, 'the oldest template was evicted');
});

test('list filters by category and by search text', async () => {
  const store = new FlowWorkflowTemplates({ storage: memoryStorage() });
  await store.save(richGraph(), { name: 'Wedding promo', category: 'ads' });
  await store.save(richGraph(), { name: 'Drama pipeline', category: 'drama' });
  assert.deepEqual((await store.list({ category: 'drama' })).map(item => item.name), ['Drama pipeline']);
  assert.deepEqual((await store.list({ search: 'wedding' })).map(item => item.name), ['Wedding promo']);
  assert.equal((await store.list()).length, 2);
});

test('template errors are typed WorkflowTemplateError instances', async () => {
  const store = new FlowWorkflowTemplates({ storage: memoryStorage() });
  const error = await store.instantiate('missing-id').catch(err => err);
  assert.ok(error instanceof WorkflowTemplateError);
  assert.equal(error.code, 'FLOW_WORKFLOW_TEMPLATE_NOT_FOUND');
});

// --- sidebar surface contracts -----------------------------------------------------

test('the sidebar carries the workflow-templates surface and message contract', () => {
  for (const id of ['workflowTemplatesSection', 'workflowTemplateList', 'workflowTemplateEmpty', 'wfTemplateName', 'wfTemplateCategory', 'wfTemplateDescription', 'wfTemplateGraph', 'saveWorkflowTemplateBtn', 'wfTemplateImportFile', 'importWorkflowTemplateBtn']) {
    assert.ok(sidebarHtml.includes(`id="${id}"`), `sidebar.html is missing #${id}`);
  }
  for (const type of ['flow-workflow-templates:list', 'flow-workflow-templates:save', 'flow-workflow-templates:instantiate', 'flow-workflow-templates:export', 'flow-workflow-templates:import', 'flow-workflow-templates:remove']) {
    assert.ok(sidebarSource.includes(type), `sidebar.js never sends ${type}`);
  }
  assert.ok(sidebarSource.includes('loadWorkflowTemplates'), 'sidebar loads workflow templates');
});
