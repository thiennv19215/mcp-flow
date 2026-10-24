// Visual workflow editor — state/logic half (FEAT-13).
//
// Logic (adapted from the reference extension's workflow editor design,
// not its code): the Workflow tab edits a node graph on a canvas — nodes
// carry a position, edges connect typed ports, and an undo/redo history
// of graph snapshots (thumbnails stripped, capped at 40) backs every
// mutation. This module is that state machine, deliberately free of DOM
// rendering: the sidebar mounts it and draws from getState().
//
// The editor's document IS the FEAT-07 graph document. Opening a
// workflow file goes through importWorkflowGraph and exporting goes
// through exportWorkflowGraph (both from
// ../background/flow-workflow-graph.js), so the per-type field
// whitelist, port rules and validation live in exactly one place — an
// editor export is the very document the pure FEAT-07 path produces for
// the equivalent graph. No second format is defined here; the only
// extra shape is the editor's own serialized state (kind
// "flow.workflow-editor-state"), an autosave envelope around the same
// { name?, nodes, edges } state.
//
// The live state is a work in progress: it may hold nodes the executor
// would reject (a generate node with no prompt yet, a download sink
// with nothing wired in). Structural sanity is enforced per operation
// (known types, existing nodes/ports, port compatibility, one edge per
// single-connection port), and full validation only happens at export
// time, through FEAT-07. Editor-only extras on a node (a thumbnail
// preview, runtime annotations) live in the state but never in an
// export: the whitelist drops them, and history snapshots strip
// thumbnails so 40 snapshots cannot blow the storage budget.

import {
  WORKFLOW_NODE_TYPES,
  exportWorkflowGraph,
  importWorkflowGraph,
  normalizeWorkflowGraph,
  workflowPortsCompatible,
} from "../background/flow-workflow-graph.js";

export const WORKFLOW_EDITOR_HISTORY_LIMIT = 40;
export const WORKFLOW_EDITOR_STATE_KIND = "flow.workflow-editor-state";

const clone = value => structuredClone(value);

export class WorkflowEditorError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "WorkflowEditorError";
    this.code = code;
  }
}

const editorError = (message, code) => new WorkflowEditorError(message, code);

// The palette the sidebar offers: the FEAT-07 registry, nothing else.
export function workflowEditorNodeTypes() {
  return Object.entries(WORKFLOW_NODE_TYPES).map(([type, def]) => ({
    type,
    label: def.label,
    disposition: def.disposition,
  }));
}

// Remove every "thumbnail" key, at any depth: history snapshots (and
// only they) are stored this way, mirroring the reference editor whose
// undo snapshots are taken from the exported graph, thumbnails gone.
function stripThumbnails(value) {
  if (Array.isArray(value)) return value.map(stripThumbnails);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, inner] of Object.entries(value)) {
      if (key === "thumbnail") continue;
      out[key] = stripThumbnails(inner);
    }
    return out;
  }
  return value;
}

// The one dynamic port rule of the registry, read off the exported port
// definitions: a generate node's "media" output is a video port when
// the node generates video, an image port otherwise.
function effectivePortType(node, portDef) {
  if (portDef.dynamic === "mediaType" && node.type === "generate") {
    return node.config?.type === "video" ? "video" : "image";
  }
  return portDef.type;
}

function portDefFor(node, side, portName) {
  const defs = WORKFLOW_NODE_TYPES[node.type]?.[side] || [];
  return defs.find(def => def.name === portName) || null;
}

// Mirror of the graph normalizer's defaulting: an omitted port resolves
// only when the type has exactly one port on that side.
function resolvePortName(node, side, portName) {
  const defs = WORKFLOW_NODE_TYPES[node.type]?.[side] || [];
  if (portName) return portName;
  return defs.length === 1 ? defs[0].name : "";
}

export function createWorkflowEditor() {
  let state = { nodes: [], edges: [] };
  let undoStack = [];
  let redoStack = [];
  let nodeCounter = 0;
  let edgeCounter = 0;

  const snapshot = () => stripThumbnails(clone(state));

  function recordHistory() {
    undoStack.push(snapshot());
    if (undoStack.length > WORKFLOW_EDITOR_HISTORY_LIMIT) {
      undoStack.splice(0, undoStack.length - WORKFLOW_EDITOR_HISTORY_LIMIT);
    }
    redoStack = [];
  }

  function adoptState(next) {
    state = {
      ...(next.name ? { name: next.name } : {}),
      nodes: clone(next.nodes || []),
      edges: clone(next.edges || []),
    };
    undoStack = [];
    redoStack = [];
  }

  function nodeById(id) {
    return state.nodes.find(node => node.id === id) || null;
  }

  function requireNode(id) {
    const node = nodeById(id);
    if (!node) throw editorError(`Workflow node "${id}" does not exist in the editor.`, "FLOW_WORKFLOW_EDITOR_NODE_NOT_FOUND");
    return node;
  }

  function uniqueNodeId() {
    let id;
    do { id = `node-${++nodeCounter}`; } while (nodeById(id));
    return id;
  }

  function uniqueEdgeId() {
    let id;
    do { id = `edge-${++edgeCounter}`; } while (state.edges.some(edge => edge.id === id));
    return id;
  }

  const editor = {
    // --- opening / persistence -------------------------------------------

    // A FEAT-07 workflow document ({ kind: "flow.workflow-graph" }):
    // rebuilt through the import whitelist, so foreign fields and
    // runtime state in the file never enter the editor.
    openDocument(doc) {
      adoptState(importWorkflowGraph(doc));
      return editor;
    },

    // A plain graph object ({ name?, nodes, edges }), normalized the
    // FEAT-07 way (ids/types resolved, sole ports defaulted).
    openGraph(graph) {
      adoptState(normalizeWorkflowGraph(graph));
      return editor;
    },

    // The autosave envelope: the live state verbatim (thumbnails and
    // work-in-progress fields included), so a save/load round-trip is
    // lossless. History is NOT part of it.
    serialize() {
      return JSON.stringify({
        kind: WORKFLOW_EDITOR_STATE_KIND,
        version: 1,
        ...(state.name ? { name: state.name } : {}),
        nodes: state.nodes,
        edges: state.edges,
      });
    },

    restore(json) {
      let parsed;
      try {
        parsed = typeof json === "string" ? JSON.parse(json) : json;
      } catch {
        throw editorError("Saved editor state is not valid JSON.", "FLOW_WORKFLOW_EDITOR_STATE_INVALID");
      }
      if (!parsed || typeof parsed !== "object" || parsed.kind !== WORKFLOW_EDITOR_STATE_KIND || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
        throw editorError("Saved editor state is not a workflow editor state document.", "FLOW_WORKFLOW_EDITOR_STATE_INVALID");
      }
      for (const node of parsed.nodes) {
        if (!node || typeof node !== "object" || !String(node.id || "").trim() || !String(node.type || "").trim()) {
          throw editorError("Saved editor state contains a node without an id or type.", "FLOW_WORKFLOW_EDITOR_STATE_INVALID");
        }
      }
      adoptState(parsed);
      return editor;
    },

    // The portable document: FEAT-07 export of the current state —
    // whitelist applied, runtime state stripped, fully validated.
    exportDocument() {
      return exportWorkflowGraph(clone(state));
    },

    getState() {
      return clone(state);
    },

    // --- mutations (each records history) ---------------------------------

    addNode(type, options = {}) {
      if (!WORKFLOW_NODE_TYPES[type]) {
        throw editorError(`Unknown workflow node type "${type}".`, "FLOW_WORKFLOW_NODE_TYPE_UNKNOWN");
      }
      const id = options.id !== undefined ? String(options.id).trim() : uniqueNodeId();
      if (!id) throw editorError("A workflow node needs a non-empty id.", "FLOW_WORKFLOW_EDITOR_NODE_ID_INVALID");
      if (nodeById(id)) throw editorError(`Duplicate workflow node id "${id}".`, "FLOW_WORKFLOW_EDITOR_NODE_ID_DUPLICATE");
      const index = state.nodes.length;
      const { id: _id, type: _type, name, x, y, config, ...extras } = options;
      const node = {
        id,
        type,
        ...(name !== undefined ? { name: String(name) } : {}),
        x: Number.isFinite(x) ? x : 24 + (index % 4) * 180,
        y: Number.isFinite(y) ? y : 24 + Math.floor(index / 4) * 120,
        config: clone(config ?? {}),
        ...clone(extras),
      };
      recordHistory();
      state.nodes.push(node);
      return clone(node);
    },

    moveNode(id, x, y) {
      const node = requireNode(id);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw editorError(`Node "${id}" position must be finite numbers.`, "FLOW_WORKFLOW_EDITOR_POSITION_INVALID");
      }
      recordHistory();
      node.x = x;
      node.y = y;
      return clone(node);
    },

    // patch: { name?, config? (shallow-merged), thumbnail?, ...extras }.
    // Identity is immutable here — id/type changes need remove + add.
    editNode(id, patch = {}) {
      const node = requireNode(id);
      const { id: _id, type: _type, config, ...rest } = patch;
      recordHistory();
      if (config !== undefined) node.config = { ...(node.config || {}), ...clone(config) };
      for (const [key, value] of Object.entries(rest)) {
        if (value === undefined) delete node[key];
        else node[key] = clone(value);
      }
      return clone(node);
    },

    removeNode(id) {
      requireNode(id);
      recordHistory();
      state.nodes = state.nodes.filter(node => node.id !== id);
      state.edges = state.edges.filter(edge => edge.source !== id && edge.target !== id);
    },

    connect(sourceId, sourcePort, targetId, targetPort, options = {}) {
      const source = requireNode(sourceId);
      const target = requireNode(targetId);
      if (sourceId === targetId) {
        throw editorError(`Node "${sourceId}" cannot connect to itself.`, "FLOW_WORKFLOW_EDITOR_EDGE_SELF");
      }
      const sourcePortName = resolvePortName(source, "outputs", sourcePort ? String(sourcePort).trim() : "");
      const targetPortName = resolvePortName(target, "inputs", targetPort ? String(targetPort).trim() : "");
      const sourceDef = sourcePortName ? portDefFor(source, "outputs", sourcePortName) : null;
      const targetDef = targetPortName ? portDefFor(target, "inputs", targetPortName) : null;
      if (!sourceDef) throw editorError(`Node "${source.id}" (${source.type}) has no output port "${sourcePortName || sourcePort || ""}".`, "FLOW_WORKFLOW_PORT_UNKNOWN");
      if (!targetDef) throw editorError(`Node "${target.id}" (${target.type}) has no input port "${targetPortName || targetPort || ""}".`, "FLOW_WORKFLOW_PORT_UNKNOWN");
      const sourceType = effectivePortType(source, sourceDef);
      const targetType = effectivePortType(target, targetDef);
      if (!workflowPortsCompatible(sourceType, targetType)) {
        throw editorError(
          `Cannot connect a ${sourceType} output ("${source.id}.${sourceDef.name}") to a ${targetType} input ("${target.id}.${targetDef.name}").`,
          "FLOW_WORKFLOW_PORT_INCOMPATIBLE",
        );
      }
      if (target.type === "chatgpt" && targetDef.name === "image_ref") {
        throw editorError(
          `Node "${target.id}" is a ChatGPT node: its reference images must be payload records in its config, so an edge into "image_ref" can never be satisfied.`,
          "FLOW_WORKFLOW_CHATGPT_REFS_PAYLOAD_ONLY",
        );
      }
      if (state.edges.some(edge => edge.source === sourceId && edge.sourcePort === sourceDef.name && edge.target === targetId && edge.targetPort === targetDef.name)) {
        throw editorError(`An edge from "${sourceId}.${sourceDef.name}" to "${targetId}.${targetDef.name}" already exists.`, "FLOW_WORKFLOW_EDITOR_EDGE_DUPLICATE");
      }
      if (!targetDef.multiple && state.edges.some(edge => edge.target === targetId && edge.targetPort === targetDef.name)) {
        throw editorError(`Input port "${target.id}.${targetDef.name}" accepts one edge, but one is already connected.`, "FLOW_WORKFLOW_PORT_MULTIPLE");
      }
      const edge = {
        id: options.id !== undefined ? String(options.id) : uniqueEdgeId(),
        source: sourceId,
        sourcePort: sourceDef.name,
        target: targetId,
        targetPort: targetDef.name,
      };
      if (state.edges.some(existing => existing.id === edge.id)) {
        throw editorError(`Duplicate workflow edge id "${edge.id}".`, "FLOW_WORKFLOW_EDITOR_EDGE_ID_DUPLICATE");
      }
      recordHistory();
      state.edges.push(edge);
      return clone(edge);
    },

    removeEdge(edgeId) {
      if (!state.edges.some(edge => edge.id === edgeId)) {
        throw editorError(`Workflow edge "${edgeId}" does not exist in the editor.`, "FLOW_WORKFLOW_EDITOR_EDGE_NOT_FOUND");
      }
      recordHistory();
      state.edges = state.edges.filter(edge => edge.id !== edgeId);
    },

    setName(name) {
      recordHistory();
      const trimmed = String(name ?? "").trim();
      if (trimmed) state.name = trimmed;
      else delete state.name;
    },

    // --- history ------------------------------------------------------------

    undo() {
      if (!undoStack.length) return false;
      redoStack.push(snapshot());
      if (redoStack.length > WORKFLOW_EDITOR_HISTORY_LIMIT) {
        redoStack.splice(0, redoStack.length - WORKFLOW_EDITOR_HISTORY_LIMIT);
      }
      const restored = undoStack.pop();
      state = {
        ...(restored.name ? { name: restored.name } : {}),
        nodes: restored.nodes,
        edges: restored.edges,
      };
      return true;
    },

    redo() {
      if (!redoStack.length) return false;
      undoStack.push(snapshot());
      if (undoStack.length > WORKFLOW_EDITOR_HISTORY_LIMIT) {
        undoStack.splice(0, undoStack.length - WORKFLOW_EDITOR_HISTORY_LIMIT);
      }
      const restored = redoStack.pop();
      state = {
        ...(restored.name ? { name: restored.name } : {}),
        nodes: restored.nodes,
        edges: restored.edges,
      };
      return true;
    },

    canUndo() {
      return undoStack.length > 0;
    },

    canRedo() {
      return redoStack.length > 0;
    },

    historySize() {
      return undoStack.length;
    },
  };

  return editor;
}

// The sidebar page loads this file as a module script and talks to the
// editor through the global root (its own script is a classic script);
// Node tests import the exports above directly. Same API either way.
const workflowEditorApi = {
  WORKFLOW_EDITOR_HISTORY_LIMIT,
  WORKFLOW_EDITOR_STATE_KIND,
  WorkflowEditorError,
  createWorkflowEditor,
  workflowEditorNodeTypes,
};
globalThis.FlowWorkflowEditor = workflowEditorApi;
export default workflowEditorApi;
