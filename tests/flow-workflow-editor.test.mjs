import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  WORKFLOW_EDITOR_HISTORY_LIMIT,
  WorkflowEditorError,
  createWorkflowEditor,
  workflowEditorNodeTypes,
} from '../extension/src/ui/workflow-editor.js';
import {
  WORKFLOW_NODE_TYPES,
  exportWorkflowGraph,
  importWorkflowGraph,
} from '../extension/src/background/flow-workflow-graph.js';

// FEAT-13 — Visual workflow editor, state/logic half (study #13 editor
// half). The editor holds a work-in-progress graph (nodes with canvas
// positions + edges) over EXACTLY the FEAT-07 graph document: opening a
// document goes through importWorkflowGraph, exporting goes through
// exportWorkflowGraph, so the per-type field whitelist lives in one
// place and an editor export is byte-for-byte the document the pure
// FEAT-07 path produces for the equivalent graph. Undo/redo history is
// snapshots of the editor state with thumbnails stripped, capped at 40.
// No second document format is defined here.

const sidebarSource = readFileSync(new URL('../extension/src/ui/sidebar.js', import.meta.url), 'utf8');
const sidebarHtml = readFileSync(new URL('../extension/src/ui/sidebar.html', import.meta.url), 'utf8');
const editorSource = readFileSync(new URL('../extension/src/ui/workflow-editor.js', import.meta.url), 'utf8');

// A valid, fully wired workflow used by several tests: a text source
// feeding a generate node, an image source feeding its reference port,
// and the generate output passing a delay into a download sink.
function fixtureGraph() {
  return {
    name: 'Demo',
    nodes: [
      { id: 't1', type: 'text', x: 10, y: 10, config: { text: 'Một con mèo' } },
      { id: 'im1', type: 'image', x: 10, y: 160, config: { asset: 'ref.png' } },
      { id: 'g1', type: 'generate', x: 260, y: 60, config: { prompt: '', type: 'image', aspect_ratio: '1:1', quantity: 1 } },
      { id: 'w1', type: 'delay', x: 480, y: 60, config: { seconds: 2 } },
      { id: 'd1', type: 'download', x: 660, y: 60, config: { auto_download: true } },
    ],
    edges: [
      { id: 'e1', source: 't1', sourcePort: 'text', target: 'g1', targetPort: 'text' },
      { id: 'e2', source: 'im1', sourcePort: 'media', target: 'g1', targetPort: 'image_ref' },
      { id: 'e3', source: 'g1', sourcePort: 'media', target: 'w1', targetPort: 'any_in' },
      { id: 'e4', source: 'w1', sourcePort: 'any_out', target: 'd1', targetPort: 'media_in' },
    ],
  };
}

test('the editor palette covers exactly the FEAT-07 node-type registry', () => {
  const types = workflowEditorNodeTypes();
  assert.deepEqual(types.map(entry => entry.type).sort(), Object.keys(WORKFLOW_NODE_TYPES).sort());
  for (const entry of types) {
    assert.equal(entry.label, WORKFLOW_NODE_TYPES[entry.type].label);
  }
});

test('editor state round-trips through serialize/restore unchanged', () => {
  const editor = createWorkflowEditor();
  editor.openGraph(fixtureGraph());
  editor.editNode('im1', { thumbnail: 'data:image/png;base64,AAAA' });
  const stateBefore = editor.getState();
  const json = editor.serialize();
  const parsed = JSON.parse(json);
  assert.equal(parsed.kind, 'flow.workflow-editor-state');
  const restored = createWorkflowEditor();
  restored.restore(json);
  assert.deepEqual(restored.getState(), stateBefore);
  assert.equal(restored.serialize(), json, 'serialize → restore → serialize is a fixed point');
});

test('opening a FEAT-07 document and re-exporting returns the identical document', () => {
  const doc = exportWorkflowGraph(fixtureGraph());
  const editor = createWorkflowEditor();
  editor.openDocument(doc);
  assert.deepEqual(editor.exportDocument(), doc);
  // And the opened state validates through the pure FEAT-07 import path.
  assert.deepEqual(importWorkflowGraph(editor.exportDocument()), importWorkflowGraph(doc));
});

test('open → add node → connect → export equals the pure FEAT-07 document for the equivalent graph', () => {
  const baseDoc = exportWorkflowGraph({
    name: 'Demo',
    nodes: [{ id: 't1', type: 'text', x: 10, y: 10, config: { text: 'Xin chào' } }],
    edges: [],
  });
  const editor = createWorkflowEditor();
  editor.openDocument(baseDoc);
  editor.addNode('generate', {
    id: 'g1', x: 260, y: 40,
    config: { prompt: '', type: 'image', aspect_ratio: '16:9', quantity: 1 },
  });
  editor.connect('t1', 'text', 'g1', 'text', { id: 'e1' });

  const purePath = exportWorkflowGraph({
    name: 'Demo',
    nodes: [
      { id: 't1', type: 'text', x: 10, y: 10, config: { text: 'Xin chào' } },
      { id: 'g1', type: 'generate', x: 260, y: 40, config: { prompt: '', type: 'image', aspect_ratio: '16:9', quantity: 1 } },
    ],
    edges: [{ id: 'e1', source: 't1', sourcePort: 'text', target: 'g1', targetPort: 'text' }],
  });
  assert.deepEqual(editor.exportDocument(), purePath);
});

test('export strips runtime state, foreign config fields and thumbnails via the FEAT-07 whitelist', () => {
  const editor = createWorkflowEditor();
  editor.addNode('image', {
    id: 'im1', x: 5, y: 5,
    thumbnail: 'data:image/png;base64,BBBB',
    config: { asset: 'a.png', thumbnail: 'nested', status: 'running', foreign: 1 },
  });
  editor.editNode('im1', { status: 'completed', runtimeJobId: 'job-9' });
  const exported = editor.exportDocument();
  assert.equal(JSON.stringify(exported).includes('thumbnail'), false, 'no thumbnail survives export');
  assert.equal(JSON.stringify(exported).includes('foreign'), false);
  assert.equal(JSON.stringify(exported).includes('runtimeJobId'), false);
  assert.deepEqual(exported.nodes[0].config, { asset: 'a.png' });
  assert.equal('status' in exported.nodes[0], false);
});

test('undo restores the exact prior state step by step, redo reapplies it', () => {
  const editor = createWorkflowEditor();
  const snapshots = [editor.getState()];
  editor.addNode('text', { id: 't1', x: 0, y: 0, config: { text: 'A' } });
  snapshots.push(editor.getState());
  editor.addNode('generate', { id: 'g1', x: 100, y: 0, config: { prompt: 'B', type: 'image' } });
  snapshots.push(editor.getState());
  editor.connect('t1', 'text', 'g1', 'text', { id: 'e1' });
  snapshots.push(editor.getState());
  editor.moveNode('g1', 333, 222);
  snapshots.push(editor.getState());

  for (let i = snapshots.length - 1; i > 0; i--) {
    assert.equal(editor.undo(), true);
    assert.deepEqual(editor.getState(), snapshots[i - 1], `undo to step ${i - 1}`);
  }
  assert.equal(editor.undo(), false, 'nothing left to undo');
  for (let i = 1; i < snapshots.length; i++) {
    assert.equal(editor.redo(), true);
    assert.deepEqual(editor.getState(), snapshots[i], `redo to step ${i}`);
  }
  assert.equal(editor.redo(), false, 'nothing left to redo');
});

test('a new mutation clears the redo stack', () => {
  const editor = createWorkflowEditor();
  editor.addNode('text', { id: 't1', config: { text: 'A' } });
  editor.undo();
  assert.equal(editor.canRedo(), true);
  editor.addNode('delay', { id: 'w1', config: { seconds: 1 } });
  assert.equal(editor.canRedo(), false);
  assert.equal(editor.redo(), false);
});

test('history is capped at 40 snapshots and the oldest are dropped', () => {
  assert.equal(WORKFLOW_EDITOR_HISTORY_LIMIT, 40);
  const editor = createWorkflowEditor();
  for (let i = 1; i <= 45; i++) editor.addNode('text', { id: `n${i}`, config: { text: `${i}` } });
  assert.equal(editor.historySize(), 40);
  for (let i = 0; i < 40; i++) assert.equal(editor.undo(), true);
  assert.equal(editor.undo(), false, 'the five oldest snapshots were evicted by the cap');
  assert.equal(editor.getState().nodes.length, 5, 'undo stops at the oldest retained snapshot');
  for (let i = 0; i < 40; i++) assert.equal(editor.redo(), true);
  assert.equal(editor.getState().nodes.length, 45);
});

test('history snapshots strip thumbnails while the live state keeps them', () => {
  const editor = createWorkflowEditor();
  editor.addNode('image', { id: 'im1', config: { asset: 'a.png' }, thumbnail: 'data:image/png;base64,CCCC' });
  editor.editNode('im1', { name: 'Ảnh bìa' });
  assert.equal(editor.getState().nodes[0].thumbnail, 'data:image/png;base64,CCCC', 'live state keeps the thumbnail');
  assert.equal(editor.undo(), true);
  const restored = editor.getState().nodes[0];
  assert.equal(restored.id, 'im1');
  assert.equal(restored.thumbnail, undefined, 'the snapshot that undo restored had its thumbnail stripped');
});

test('connect validates ports with the FEAT-07 rules', () => {
  const editor = createWorkflowEditor();
  editor.addNode('text', { id: 't1', config: { text: 'A' } });
  editor.addNode('image', { id: 'im1', config: { asset: 'a.png' } });
  editor.addNode('image', { id: 'im2', config: { asset: 'b.png' } });
  editor.addNode('generate', { id: 'g1', config: { prompt: 'x', type: 'image' } });
  editor.addNode('chatgpt', { id: 'c1', config: { prompt: 'y' } });

  // A frame port flatly rejects a text edge.
  assert.throws(
    () => editor.connect('t1', 'text', 'g1', 'frame_1'),
    error => error instanceof WorkflowEditorError && error.code === 'FLOW_WORKFLOW_PORT_INCOMPATIBLE',
  );
  // Unknown node / unknown port.
  assert.throws(() => editor.connect('ghost', 'text', 'g1', 'text'), error => error.code === 'FLOW_WORKFLOW_EDITOR_NODE_NOT_FOUND');
  assert.throws(() => editor.connect('t1', 'nope', 'g1', 'text'), error => error.code === 'FLOW_WORKFLOW_PORT_UNKNOWN');
  // ChatGPT reference images are payload-only; an edge can never feed them.
  assert.throws(
    () => editor.connect('im1', 'media', 'c1', 'image_ref'),
    error => error.code === 'FLOW_WORKFLOW_CHATGPT_REFS_PAYLOAD_ONLY',
  );
  // A single-connection port takes exactly one edge.
  editor.connect('im1', 'media', 'g1', 'frame_1', { id: 'e1' });
  assert.throws(
    () => editor.connect('im2', 'media', 'g1', 'frame_1'),
    error => error.code === 'FLOW_WORKFLOW_PORT_MULTIPLE',
  );
  // The same edge twice is a duplicate, not a second edge.
  editor.connect('t1', 'text', 'g1', 'text', { id: 'e2' });
  assert.throws(
    () => editor.connect('t1', 'text', 'g1', 'text'),
    error => error.code === 'FLOW_WORKFLOW_EDITOR_EDGE_DUPLICATE',
  );
  // A self-loop is a cycle the executor would reject; refuse it here too.
  assert.throws(
    () => editor.connect('g1', 'media', 'g1', 'image_ref'),
    error => error.code === 'FLOW_WORKFLOW_EDITOR_EDGE_SELF',
  );
});

test('connect defaults an omitted port to the type\'s sole port on that side', () => {
  const editor = createWorkflowEditor();
  editor.addNode('image', { id: 'im1', config: { asset: 'a.png' } });
  editor.addNode('download', { id: 'd1', config: {} });
  const edge = editor.connect('im1', undefined, 'd1', undefined, { id: 'e1' });
  assert.equal(edge.sourcePort, 'media');
  assert.equal(edge.targetPort, 'media_in');
  // An ambiguous side (generate has five inputs) must be named explicitly.
  editor.addNode('generate', { id: 'g1', config: { prompt: 'x' } });
  assert.throws(() => editor.connect('im1', 'media', 'g1', undefined), error => error.code === 'FLOW_WORKFLOW_PORT_UNKNOWN');
});

test('removeNode drops every edge that touched it', () => {
  const editor = createWorkflowEditor();
  editor.openGraph(fixtureGraph());
  editor.removeNode('g1');
  const state = editor.getState();
  assert.deepEqual(state.nodes.map(node => node.id), ['t1', 'im1', 'w1', 'd1']);
  assert.deepEqual(state.edges.map(edge => edge.id), ['e4'], 'e1, e2 and e3 touched g1 and were dropped; e4 (w1 → d1) never touched it');
  assert.throws(() => editor.removeNode('g1'), error => error.code === 'FLOW_WORKFLOW_EDITOR_NODE_NOT_FOUND');
});

test('removeEdge disconnects exactly one edge and is undoable', () => {
  const editor = createWorkflowEditor();
  editor.openGraph(fixtureGraph());
  editor.removeEdge('e2');
  assert.deepEqual(editor.getState().edges.map(edge => edge.id), ['e1', 'e3', 'e4']);
  editor.undo();
  assert.deepEqual(editor.getState().edges.map(edge => edge.id), ['e1', 'e2', 'e3', 'e4']);
  assert.throws(() => editor.removeEdge('e2-missing'), error => error.code === 'FLOW_WORKFLOW_EDITOR_EDGE_NOT_FOUND');
});

test('moveNode and editNode update state, and export carries positions but only whitelisted config', () => {
  const editor = createWorkflowEditor();
  editor.addNode('generate', { id: 'g1', x: 0, y: 0, config: { prompt: 'a', quantity: 1 } });
  editor.moveNode('g1', 300, 200);
  editor.editNode('g1', { name: 'Node chính', config: { quantity: 3, bogus: 'x' } });
  const stateNode = editor.getState().nodes[0];
  assert.equal(stateNode.x, 300);
  assert.equal(stateNode.y, 200);
  assert.equal(stateNode.name, 'Node chính');
  assert.deepEqual(stateNode.config, { prompt: 'a', quantity: 3, bogus: 'x' }, 'the live state keeps the patch verbatim');
  const exported = editor.exportDocument().nodes[0];
  assert.equal(exported.x, 300);
  assert.equal(exported.y, 200);
  assert.deepEqual(exported.config, { prompt: 'a', quantity: 3 }, 'export drops the non-whitelisted field');
  assert.throws(() => editor.moveNode('g1', Number.NaN, 0), error => error.code === 'FLOW_WORKFLOW_EDITOR_POSITION_INVALID');
  assert.throws(() => editor.editNode('ghost', { name: 'x' }), error => error.code === 'FLOW_WORKFLOW_EDITOR_NODE_NOT_FOUND');
});

test('addNode validates the type and id, generates unique ids and a finite default position', () => {
  const editor = createWorkflowEditor();
  assert.throws(() => editor.addNode('telegram', {}), error => error.code === 'FLOW_WORKFLOW_NODE_TYPE_UNKNOWN');
  editor.addNode('text', { id: 't1', config: { text: 'A' } });
  assert.throws(() => editor.addNode('text', { id: 't1' }), error => error.code === 'FLOW_WORKFLOW_EDITOR_NODE_ID_DUPLICATE');
  const ids = new Set(['t1']);
  for (let i = 0; i < 12; i++) {
    const node = editor.addNode('delay', { config: { seconds: 1 } });
    assert.ok(node.id && !ids.has(node.id), `generated id ${node.id} is unique`);
    ids.add(node.id);
    assert.ok(Number.isFinite(node.x) && Number.isFinite(node.y), 'default position is finite');
  }
});

test('setName renames the workflow and the rename is undoable', () => {
  const editor = createWorkflowEditor();
  editor.addNode('text', { id: 't1', config: { text: 'A' } });
  editor.setName('Kịch bản 1');
  assert.equal(editor.exportDocument().name, 'Kịch bản 1');
  editor.undo();
  assert.equal(editor.getState().name, undefined);
});

test('exporting an empty editor surfaces the FEAT-07 structural error', () => {
  const editor = createWorkflowEditor();
  assert.throws(() => editor.exportDocument(), error => error.code === 'FLOW_WORKFLOW_GRAPH_INVALID');
});

test('getState returns a deep copy that cannot mutate the editor', () => {
  const editor = createWorkflowEditor();
  editor.addNode('text', { id: 't1', config: { text: 'A' } });
  const leaked = editor.getState();
  leaked.nodes[0].config.text = 'HACKED';
  leaked.nodes.push({ id: 'ghost', type: 'text', config: {} });
  assert.equal(editor.getState().nodes.length, 1);
  assert.equal(editor.getState().nodes[0].config.text, 'A');
});

test('the module bridges its API onto the global root for the sidebar page', () => {
  assert.equal(typeof globalThis.FlowWorkflowEditor?.createWorkflowEditor, 'function');
  assert.equal(globalThis.FlowWorkflowEditor.createWorkflowEditor, createWorkflowEditor);
  assert.ok(editorSource.includes("from \"../background/flow-workflow-graph.js\""), 'the editor reuses the FEAT-07 module instead of re-declaring the whitelist');
  assert.equal(editorSource.includes('WORKFLOW_EXPORT_FIELDS ='), false, 'no second whitelist is defined here');
});

test('sidebar mounts the editor in the Workflow tab (contract)', () => {
  assert.ok(sidebarHtml.includes('<script type="module" src="workflow-editor.js"></script>'), 'sidebar.html loads workflow-editor.js as a module');
  assert.ok(sidebarHtml.includes('id="workflowEditorSection"'), 'editor section exists in the Workflow tab');
  for (const id of ['wfEditorName', 'wfEditorNodeType', 'wfEditorAddNodeBtn', 'wfEditorUndoBtn', 'wfEditorRedoBtn', 'wfEditorOpenBtn', 'wfEditorExportBtn', 'wfEditorJson', 'wfEditorSummary']) {
    assert.ok(sidebarHtml.includes(`id="${id}"`), `sidebar.html has #${id}`);
  }
  assert.ok(sidebarSource.includes('FlowWorkflowEditor'), 'sidebar.js talks to the editor API');
  assert.ok(sidebarSource.includes('wfEditorSummary'), 'sidebar.js renders the editor summary');
});
