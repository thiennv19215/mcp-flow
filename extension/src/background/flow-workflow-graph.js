// Node-graph workflow executor on the queue (FEAT-07).
//
// Logic (adapted from the reference extension's workflow design, not its
// code): a workflow is a document of typed nodes and typed edges. Every
// port carries one of five media types (text / image / video / frame /
// any) and an edge may only join ports the compatibility matrix allows —
// image and frame interoperate, any accepts everything, and a frame port
// flatly rejects a text edge. Execution is topological: nodes level by
// longest path from the sources, a level's jobs are enqueued together,
// and the queue's serial drain is what actually runs them.
//
// This module is the executor half. It holds:
//   - the pure graph core: normalization, validation (structure, ports,
//     required inputs, cycles), leveling, and compilation of generation
//     nodes into queue jobs whose payloads follow the existing workflow
//     planners' shapes field-for-field;
//   - the runner: a persistent run store whose records fold queue
//     snapshots into per-node receipts exactly like FEAT-02's batch runs
//     (the very same receipt helper is reused), admit the next level's
//     jobs as their dependencies complete, resolve dynamic inputs
//     (an upstream node's produced media feeding a reference or frame
//     port) from those receipts at admission time, skip any node whose
//     dependency failed — transitively — with the reason recorded, and
//     finalize with FEAT-02's completed / failed / needs_review states;
//   - export / import of the graph document under a per-type field
//     whitelist, so a workflow file never carries runtime state or
//     foreign fields (the local half of the template feature rides the
//     same whitelist).
//
// Deliberate boundaries of this half: character-look and technique
// enrichment stay with the planners (graph nodes carry plain prompts);
// ChatGPT nodes refuse wired image references, because the ChatGPT ref
// contract only accepts payload-carrying records, never library or
// upstream identities; a partial (VID-01) upstream receipt still feeds
// its dependents — it produced media — but the run then finalizes as
// needs_review, never as a clean completion.

import { receiptFromJob } from "./flow-batch-runs.js";

const STORAGE_KEY = "flowMcpWorkflowGraphRunsV1";
const MAX_GRAPH_NODES = 100;
const MAX_GRAPH_EDGES = 400;
const MAX_RUNS = 50;
const TERMINAL_NODE_STATES = new Set(["completed", "failed", "skipped"]);

const clone = value => structuredClone(value);
const asObject = value => (value && typeof value === "object" && !Array.isArray(value) ? value : null);

export class WorkflowGraphError extends Error {
  constructor(message, code = "FLOW_WORKFLOW_INVALID") {
    super(message);
    this.name = "WorkflowGraphError";
    this.code = code;
    this.category = "invalid_argument";
    this.retryable = false;
    this.outcome_unknown = false;
  }
}

const graphError = (message, code) => new WorkflowGraphError(message, code);

// --- ports --------------------------------------------------------------------

export const WORKFLOW_PORT_TYPES = ["text", "image", "video", "frame", "any"];

// The compatibility matrix, symmetric by construction: an edge between
// two ports is allowed when each side's list names the other type. The
// reference logic: image and frame interoperate (a frame is an image
// with a role), video only meets video, text only meets text, and "any"
// meets everything.
export const WORKFLOW_PORT_COMPAT = {
  text: ["text", "any"],
  image: ["image", "frame", "any"],
  video: ["video", "any"],
  frame: ["frame", "image", "any"],
  any: ["text", "image", "video", "frame", "any"],
};

export function workflowPortsCompatible(sourceType, targetType) {
  return (WORKFLOW_PORT_COMPAT[sourceType] || []).includes(targetType)
    && (WORKFLOW_PORT_COMPAT[targetType] || []).includes(sourceType);
}

const port = (name, type, extra = {}) => ({ name, type, required: false, multiple: false, ...extra });

// The node-type registry. Generation nodes compile to queue jobs; text
// and image nodes are static inputs consumed through edges; download is
// a sink (its effect is the queue's own download path); delay only
// orders its neighbours. The generate node's media output is dynamic:
// its type follows the node's media type, like the reference registry.
export const WORKFLOW_NODE_TYPES = {
  text: {
    label: "Text",
    disposition: "source",
    inputs: [],
    outputs: [port("text", "text")],
  },
  image: {
    label: "Image",
    disposition: "source",
    inputs: [],
    outputs: [port("media", "image")],
  },
  generate: {
    label: "Generate Image/Video",
    disposition: "job",
    inputs: [
      port("image_ref", "image", { multiple: true }),
      port("text", "text", { multiple: true }),
      port("frame_1", "frame"),
      port("frame_2", "frame"),
      port("video_ref", "video"),
    ],
    outputs: [port("media", "image", { dynamic: "mediaType" }), port("frame", "frame")],
  },
  chatgpt: {
    label: "ChatGPT",
    disposition: "job",
    inputs: [
      port("image_ref", "image", { multiple: true }),
      port("text", "text", { multiple: true }),
    ],
    outputs: [port("media", "image")],
  },
  download: {
    label: "Download",
    disposition: "sink",
    inputs: [port("media_in", "any", { required: true, multiple: true })],
    outputs: [],
  },
  delay: {
    label: "Wait",
    disposition: "passthrough",
    inputs: [port("any_in", "any")],
    outputs: [port("any_out", "any")],
  },
};

// The effective type of one port on one node instance: only the
// generate node's media output varies (video when the node generates
// video), everything else is the registry type.
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

// --- normalization --------------------------------------------------------------

function normalizeNode(raw, index) {
  if (!asObject(raw)) throw graphError(`Workflow node ${index + 1} is not an object.`, "FLOW_WORKFLOW_GRAPH_INVALID");
  const id = String(raw.id ?? raw.node_id ?? "").trim();
  if (!id) throw graphError(`Workflow node ${index + 1} has no id.`, "FLOW_WORKFLOW_NODE_ID_MISSING");
  const type = String(raw.type ?? raw.node_type ?? "").trim();
  const config = asObject(raw.config) ?? asObject(raw.data) ?? {};
  const name = String(raw.name ?? raw.node_name ?? "").trim();
  const node = { id, type, config: clone(config) };
  if (name) node.name = name;
  if (Number.isFinite(raw.x)) node.x = raw.x;
  if (Number.isFinite(raw.y)) node.y = raw.y;
  return node;
}

function normalizeEdge(raw, index) {
  if (!asObject(raw)) throw graphError(`Workflow edge ${index + 1} is not an object.`, "FLOW_WORKFLOW_GRAPH_INVALID");
  const source = String(raw.source ?? raw.from ?? raw.fromNode ?? "").trim();
  const target = String(raw.target ?? raw.to ?? raw.toNode ?? "").trim();
  if (!source || !target) throw graphError(`Workflow edge ${index + 1} must name a source and a target node.`, "FLOW_WORKFLOW_EDGE_NODE_MISSING");
  return {
    id: String(raw.id ?? `edge-${index + 1}`),
    source,
    sourcePort: String(raw.sourcePort ?? raw.fromPort ?? "").trim(),
    target,
    targetPort: String(raw.targetPort ?? raw.toPort ?? "").trim(),
  };
}

// Canonicalize a graph document: { name?, nodes, edges } with node and
// edge ids/types resolved and omitted ports defaulted to a type's sole
// port when unambiguous. Structural checks only — validateWorkflowGraph
// adds the semantic ones.
export function normalizeWorkflowGraph(graph) {
  if (!asObject(graph)) throw graphError("A workflow graph must be an object with nodes and edges.", "FLOW_WORKFLOW_GRAPH_INVALID");
  if (!Array.isArray(graph.nodes) || graph.nodes.length < 1 || graph.nodes.length > MAX_GRAPH_NODES) {
    throw graphError(`A workflow graph must contain between 1 and ${MAX_GRAPH_NODES} nodes.`, "FLOW_WORKFLOW_GRAPH_INVALID");
  }
  if (graph.edges !== undefined && (!Array.isArray(graph.edges) || graph.edges.length > MAX_GRAPH_EDGES)) {
    throw graphError(`A workflow graph may contain at most ${MAX_GRAPH_EDGES} edges.`, "FLOW_WORKFLOW_GRAPH_INVALID");
  }
  const nodes = graph.nodes.map((raw, index) => normalizeNode(raw, index));
  const byId = new Map(nodes.map(node => [node.id, node]));
  const edges = (graph.edges || []).map((raw, index) => {
    const edge = normalizeEdge(raw, index);
    const sourceNode = byId.get(edge.source);
    const targetNode = byId.get(edge.target);
    if (!edge.sourcePort && sourceNode && WORKFLOW_NODE_TYPES[sourceNode.type]?.outputs.length === 1) {
      edge.sourcePort = WORKFLOW_NODE_TYPES[sourceNode.type].outputs[0].name;
    }
    if (!edge.targetPort && targetNode && WORKFLOW_NODE_TYPES[targetNode.type]?.inputs.length === 1) {
      edge.targetPort = WORKFLOW_NODE_TYPES[targetNode.type].inputs[0].name;
    }
    return edge;
  });
  const name = String(graph.name ?? "").trim();
  return { ...(name ? { name } : {}), nodes, edges };
}

// --- validation -------------------------------------------------------------------

export function validateWorkflowGraph(graph) {
  const normalized = normalizeWorkflowGraph(graph);
  const byId = new Map();
  for (const node of normalized.nodes) {
    if (byId.has(node.id)) throw graphError(`Duplicate workflow node id "${node.id}".`, "FLOW_WORKFLOW_NODE_ID_DUPLICATE");
    byId.set(node.id, node);
    if (!WORKFLOW_NODE_TYPES[node.type]) {
      throw graphError(`Unknown workflow node type "${node.type}" on node "${node.id}".`, "FLOW_WORKFLOW_NODE_TYPE_UNKNOWN");
    }
  }
  const inbound = new Map(); // `${nodeId}:${port}` -> edges
  for (const edge of normalized.edges) {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source || !target) {
      throw graphError(`Workflow edge "${edge.id}" references a node that does not exist.`, "FLOW_WORKFLOW_EDGE_NODE_MISSING");
    }
    const sourcePort = portDefFor(source, "outputs", edge.sourcePort);
    const targetPort = portDefFor(target, "inputs", edge.targetPort);
    if (!sourcePort) throw graphError(`Node "${source.id}" (${source.type}) has no output port "${edge.sourcePort}".`, "FLOW_WORKFLOW_PORT_UNKNOWN");
    if (!targetPort) throw graphError(`Node "${target.id}" (${target.type}) has no input port "${edge.targetPort}".`, "FLOW_WORKFLOW_PORT_UNKNOWN");
    const sourceType = effectivePortType(source, sourcePort);
    const targetType = effectivePortType(target, targetPort);
    if (!workflowPortsCompatible(sourceType, targetType)) {
      throw graphError(
        `Workflow edge "${edge.id}" cannot connect a ${sourceType} output ("${source.id}.${edge.sourcePort}") to a ${targetType} input ("${target.id}.${edge.targetPort}").`,
        "FLOW_WORKFLOW_PORT_INCOMPATIBLE",
      );
    }
    const key = `${target.id}:${targetPort.name}`;
    const existing = inbound.get(key) || [];
    existing.push(edge);
    inbound.set(key, existing);
    if (!targetPort.multiple && existing.length > 1) {
      throw graphError(`Input port "${target.id}.${targetPort.name}" accepts one edge, but ${existing.length} are connected.`, "FLOW_WORKFLOW_PORT_MULTIPLE");
    }
    if (target.type === "chatgpt" && targetPort.name === "image_ref") {
      throw graphError(
        `Node "${target.id}" is a ChatGPT node: its reference images must be payload records in its config, so an edge into "image_ref" can never be satisfied.`,
        "FLOW_WORKFLOW_CHATGPT_REFS_PAYLOAD_ONLY",
      );
    }
  }
  for (const node of normalized.nodes) {
    for (const def of WORKFLOW_NODE_TYPES[node.type].inputs) {
      if (def.required && !(inbound.get(`${node.id}:${def.name}`) || []).length) {
        throw graphError(`Node "${node.id}" (${node.type}) requires an input on port "${def.name}", but nothing is connected to it.`, "FLOW_WORKFLOW_PORT_REQUIRED");
      }
    }
    if (node.type === "generate") {
      const hasTextInput = (inbound.get(`${node.id}:text`) || []).length > 0;
      if (!String(node.config?.prompt || "").trim() && !hasTextInput) {
        throw graphError(`Generate node "${node.id}" has no prompt: set config.prompt or connect a text input.`, "FLOW_WORKFLOW_PROMPT_MISSING");
      }
      if (node.config?.first_frame !== undefined && (inbound.get(`${node.id}:frame_1`) || []).length) {
        throw graphError(`Generate node "${node.id}" sets both config.first_frame and a frame_1 edge; use one source for the first frame.`, "FLOW_WORKFLOW_INPUT_CONFLICT");
      }
      if (node.config?.last_frame !== undefined && (inbound.get(`${node.id}:frame_2`) || []).length) {
        throw graphError(`Generate node "${node.id}" sets both config.last_frame and a frame_2 edge; use one source for the last frame.`, "FLOW_WORKFLOW_INPUT_CONFLICT");
      }
    }
  }
  levelWorkflowGraph(normalized); // a cyclic graph is not a valid workflow
  return normalized;
}

// --- leveling ---------------------------------------------------------------------

export function levelWorkflowGraph(graph) {
  const normalized = graph?.nodes && graph?.edges && graph.nodes.every(node => node.config !== undefined)
    ? graph
    : normalizeWorkflowGraph(graph);
  const ids = normalized.nodes.map(node => node.id);
  const indegree = new Map(ids.map(id => [id, 0]));
  const downstream = new Map(ids.map(id => [id, []]));
  for (const edge of normalized.edges) {
    if (!indegree.has(edge.source) || !indegree.has(edge.target)) {
      throw graphError(`Workflow edge "${edge.id}" references a node that does not exist.`, "FLOW_WORKFLOW_EDGE_NODE_MISSING");
    }
    indegree.set(edge.target, indegree.get(edge.target) + 1);
    downstream.get(edge.source).push(edge.target);
  }
  const levelOf = new Map();
  const levels = [];
  let frontier = ids.filter(id => indegree.get(id) === 0);
  let placed = 0;
  while (frontier.length) {
    const level = levels.length;
    for (const id of frontier) levelOf.set(id, level);
    levels.push([...frontier]);
    placed += frontier.length;
    const next = [];
    for (const id of frontier) {
      for (const target of downstream.get(id)) {
        indegree.set(target, indegree.get(target) - 1);
        if (indegree.get(target) === 0) next.push(target);
      }
    }
    frontier = next;
  }
  if (placed < ids.length) {
    const trapped = ids.filter(id => !levelOf.has(id));
    throw graphError(`Workflow graph has a cycle: nodes ${trapped.map(id => `"${id}"`).join(", ")} can never be scheduled.`, "FLOW_WORKFLOW_GRAPH_CYCLE");
  }
  return { levels, levelOf };
}

// --- compilation --------------------------------------------------------------------

function sanitizeStem(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "node";
}

// The planners' frame-input convention: a string is an exact Flow asset
// title (an "asset:" prefix is stripped); an object pairs a title with
// the media id it must match. Local paths are refused — media must be
// staged by the extension first.
function frameInput(value, label) {
  if (typeof value === "string") {
    const assetName = value.replace(/^asset:/i, "").trim();
    if (!assetName || /^[a-z]:[\\/]/i.test(value) || value.startsWith("/")) {
      throw graphError(`${label} must be an exact Flow asset title; local file paths need to be staged by the extension first.`, "FLOW_FRAME_INPUT_UNAVAILABLE");
    }
    return { assetName };
  }
  if (value && typeof value === "object" && typeof value.asset === "string" && value.asset.trim()) {
    return { assetName: value.asset.trim(), ...(value.id ? { expectedId: value.id } : {}) };
  }
  throw graphError(`${label} must be an asset title or an asset/id pair.`, "FLOW_WORKFLOW_INVALID");
}

// The planners' reference convention: "asset:<exact title>" and
// "character:<name>" strings, or { asset, id } records. Without a known
// -assets context there is no id resolution — titles ride verbatim.
function attachmentFromReference(reference) {
  if (reference && typeof reference === "object") {
    if (typeof reference.asset === "string" && reference.asset.trim()) {
      return { assetName: reference.asset.trim(), ...(reference.id ? { expectedId: reference.id } : {}) };
    }
    throw graphError("Reference records must carry an asset title.", "FLOW_WORKFLOW_INVALID");
  }
  if (typeof reference !== "string" || !reference.trim()) {
    throw graphError("Reference images must be non-empty strings or asset records.", "FLOW_WORKFLOW_INVALID");
  }
  const value = reference.trim();
  if (/^character:/i.test(value)) return { assetName: value };
  if (/^asset:/i.test(value)) {
    const title = value.slice(6).trim();
    if (!title) throw graphError("Asset references must include an exact title.", "FLOW_WORKFLOW_INVALID");
    return { assetName: title };
  }
  if (/^(?:[a-z]:[\\/]|\\\\|\/)/i.test(value)) {
    throw graphError("Local reference image paths must be staged by the extension before generation.", "FLOW_REFERENCE_UPLOAD_UNAVAILABLE");
  }
  throw graphError(`Reference "${value}" must use character:<name> or asset:<exact title>.`, "FLOW_WORKFLOW_INVALID");
}

const byIdOf = graph => new Map(graph.nodes.map(node => [node.id, node]));
const inboundEdgesOf = (graph, nodeId) => graph.edges.filter(edge => edge.target === nodeId);

// The static prompt parts a node's text inputs contribute, in edge order.
function textInputParts(graph, node) {
  const byId = byIdOf(graph);
  return inboundEdgesOf(graph, node.id)
    .filter(edge => edge.targetPort === "text")
    .map(edge => byId.get(edge.source))
    .filter(source => source?.type === "text")
    .map(source => String(source.config?.text || "").trim())
    .filter(Boolean);
}

function composePrompt(config, textParts) {
  const own = String(config?.prompt || "").trim();
  if (own) {
    const base = own.replace(/\.?$/, ".");
    return textParts.length ? `${base} ${textParts.join(" ")}` : base;
  }
  return textParts.join(" ").replace(/\.?$/, ".");
}

// Trace one incoming edge back through non-job nodes (sources,
// passthroughs, sinks) to the job node whose output actually feeds it.
// Returns { node, port } of the feeding job node, or null when the chain
// starts at a static source.
function feedingJobNode(graph, edge) {
  const byId = byIdOf(graph);
  let current = byId.get(edge.source);
  let currentPort = edge.sourcePort;
  const seen = new Set();
  while (current && WORKFLOW_NODE_TYPES[current.type]?.disposition !== "job") {
    if (seen.has(current.id)) return null;
    seen.add(current.id);
    const next = inboundEdgesOf(graph, current.id)[0];
    if (!next) return null;
    currentPort = next.sourcePort;
    current = byId.get(next.source);
  }
  return current ? { node: current, port: currentPort } : null;
}

// The job nodes a node's output depends on, through any chain of
// non-job nodes, in first-seen order.
function jobDependenciesOf(graph, node) {
  const dependencies = [];
  const seen = new Set();
  for (const edge of inboundEdgesOf(graph, node.id)) {
    const feeder = feedingJobNode(graph, edge);
    if (feeder && feeder.node.id !== node.id && !seen.has(feeder.node.id)) {
      seen.add(feeder.node.id);
      dependencies.push(feeder.node.id);
    }
  }
  return dependencies;
}

// The dynamic inputs of a job node: incoming edges fed by another job
// node's output. Static inputs (text and image nodes) are baked into
// the compiled payload instead; dynamic ones resolve from the upstream
// receipt when the runner admits the job.
function upstreamInputsOf(graph, node) {
  const inputs = [];
  for (const edge of inboundEdgesOf(graph, node.id)) {
    const feeder = feedingJobNode(graph, edge);
    if (!feeder || feeder.node.id === node.id) continue;
    inputs.push({ fromNodeId: feeder.node.id, fromPort: feeder.port, intoPort: edge.targetPort });
  }
  return inputs;
}

function compileGenerateJob(graph, node, context) {
  const config = node.config || {};
  const {
    chain_previous, reference_previous, technique, reference_images, first_frame, last_frame,
    aspect_ratio, max_credits, submit_only, manual_submit, model, duration, resolution, file_stem,
    ...rest
  } = config;
  void chain_previous; void reference_previous; void technique;
  const prompt = composePrompt(config, textInputParts(graph, node));
  const attachments = [];
  for (const reference of reference_images || []) attachments.push(attachmentFromReference(reference));
  const byId = byIdOf(graph);
  for (const edge of inboundEdgesOf(graph, node.id)) {
    if (edge.targetPort !== "image_ref") continue;
    const source = byId.get(edge.source);
    if (source?.type === "image") {
      attachments.push({
        assetName: String(source.config?.asset || "").trim(),
        ...(source.config?.expected_id ? { expectedId: source.config.expected_id } : {}),
      });
    }
  }
  const type = config.type || "video";
  const aspectRatio = aspect_ratio;
  const videoSettings = type === "video" && (model !== undefined || aspectRatio !== undefined || duration !== undefined || resolution !== undefined)
    ? {
      ...(model !== undefined ? { model } : {}),
      ...(aspectRatio !== undefined ? { aspectRatio } : {}),
      ...(duration !== undefined ? { duration } : {}),
      ...(resolution !== undefined ? { resolution } : {}),
    }
    : undefined;
  const upstreamInputs = upstreamInputsOf(graph, node);
  const workflow = {
    project: context.project,
    sequence: context.sequence,
    workflowGraph: { runId: context.runId, nodeId: node.id, level: context.level },
    ...(upstreamInputs.length ? { upstreamInputs } : {}),
  };
  const payload = {
    ...rest,
    type,
    prompt,
    ...(first_frame ? { firstFrame: frameInput(first_frame, `Node "${node.id}" first_frame`) } : {}),
    ...(last_frame ? { lastFrame: frameInput(last_frame, `Node "${node.id}" last_frame`) } : {}),
    ...(attachments.length ? { attachments } : {}),
    ...(aspectRatio !== undefined ? { aspectRatio } : {}),
    ...(max_credits !== undefined ? { maxCredits: max_credits } : {}),
    ...(submit_only !== undefined ? { submitOnly: submit_only } : {}),
    ...(manual_submit === true ? { manualSubmit: true } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(duration !== undefined ? { duration } : {}),
    ...(resolution !== undefined ? { resolution } : {}),
    ...(videoSettings ? { video_settings: videoSettings } : {}),
    output_dir: context.outputDir,
    file_stem: file_stem || `wf-${sanitizeStem(node.id)}`,
    workflow,
  };
  return {
    operation: "flow.generation.submit",
    label: `Workflow ${node.name || node.id}: ${prompt.slice(0, 120)}`,
    payload,
    metadata: {
      workflowGraphRunId: context.runId,
      workflowNodeId: node.id,
      ...(context.dependsOnNodeIds.length ? { dependsOnNodeIds: context.dependsOnNodeIds } : {}),
    },
  };
}

function compileChatGptJob(graph, node, context) {
  const config = node.config || {};
  const prompt = composePrompt(config, textInputParts(graph, node));
  const payload = { prompt };
  if (config.ratio !== undefined) payload.ratio = config.ratio;
  if (config.model !== undefined) payload.model = config.model;
  if (Array.isArray(config.refs) && config.refs.length) payload.attachments = clone(config.refs);
  if (config.conversation_id !== undefined) payload.conversationId = config.conversation_id;
  return {
    operation: "chatgpt.generation.submit",
    label: `Workflow ${node.name || node.id}: ${prompt.slice(0, 120)}`,
    payload,
    metadata: {
      provider: "chatgpt",
      workflowGraphRunId: context.runId,
      workflowNodeId: node.id,
      ...(context.dependsOnNodeIds.length ? { dependsOnNodeIds: context.dependsOnNodeIds } : {}),
    },
  };
}

// Compile a validated graph: every node gets a disposition and, for
// generation nodes, the queue job it will run as. Levels come from the
// topological leveling; jobs within a level are enqueued together.
export function compileWorkflowGraph(graph, { project, outputDir = project, runId = null } = {}) {
  if (typeof project !== "string" || !project.trim()) {
    throw graphError("A workflow run needs a project.", "FLOW_WORKFLOW_PROJECT_REQUIRED");
  }
  const normalized = validateWorkflowGraph(graph);
  const { levels, levelOf } = levelWorkflowGraph(normalized);
  const sequenceOf = new Map();
  levels.flat().forEach((id, index) => sequenceOf.set(id, index));
  const nodes = normalized.nodes.map(node => {
    const disposition = WORKFLOW_NODE_TYPES[node.type].disposition;
    const dependsOnNodeIds = jobDependenciesOf(normalized, node);
    const context = {
      project, outputDir, runId, level: levelOf.get(node.id), sequence: sequenceOf.get(node.id), dependsOnNodeIds,
    };
    let job = null;
    if (node.type === "generate") job = compileGenerateJob(normalized, node, context);
    else if (node.type === "chatgpt") job = compileChatGptJob(normalized, node, context);
    return {
      nodeId: node.id,
      type: node.type,
      ...(node.name ? { name: node.name } : {}),
      level: levelOf.get(node.id),
      disposition,
      dependsOnNodeIds,
      job,
    };
  });
  return { graph: normalized, levels, nodes };
}

// --- export / import ---------------------------------------------------------------

// The per-type field whitelist: the only config fields a workflow
// document may carry across export/import, per node type. Runtime state
// (status, receipts, results, runtime ids) is never part of the graph
// document, and foreign fields are dropped, not carried.
export const WORKFLOW_EXPORT_FIELDS = {
  generate: ["prompt", "type", "model", "aspect_ratio", "duration", "resolution", "quantity", "reference_images", "first_frame", "last_frame", "voice", "character", "characters", "max_credits", "submit_only", "manual_submit", "file_stem"],
  chatgpt: ["prompt", "ratio", "model", "refs", "conversation_id"],
  text: ["text"],
  image: ["asset", "expected_id"],
  download: ["download_quality", "auto_download"],
  delay: ["seconds"],
};

function whitelistedNode(node) {
  const fields = WORKFLOW_EXPORT_FIELDS[node.type] || [];
  const config = {};
  for (const field of fields) {
    if (node.config?.[field] !== undefined) config[field] = clone(node.config[field]);
  }
  return {
    id: node.id,
    type: node.type,
    ...(node.name ? { name: node.name } : {}),
    ...(Number.isFinite(node.x) ? { x: node.x } : {}),
    ...(Number.isFinite(node.y) ? { y: node.y } : {}),
    config,
  };
}

export function exportWorkflowGraph(graph) {
  const normalized = validateWorkflowGraph(graph);
  return {
    kind: "flow.workflow-graph",
    version: 1,
    ...(normalized.name ? { name: normalized.name } : {}),
    nodes: normalized.nodes.map(whitelistedNode),
    edges: normalized.edges.map(edge => ({
      id: edge.id, source: edge.source, sourcePort: edge.sourcePort, target: edge.target, targetPort: edge.targetPort,
    })),
  };
}

export function importWorkflowGraph(doc) {
  if (!asObject(doc)) throw graphError("A workflow import must be a workflow document object.", "FLOW_WORKFLOW_IMPORT_INVALID");
  if (doc.kind !== "flow.workflow-graph") {
    throw graphError(`Cannot import a document of kind "${doc.kind || "unknown"}" as a workflow graph.`, "FLOW_WORKFLOW_IMPORT_KIND");
  }
  if (doc.version !== 1) {
    throw graphError(`Unsupported workflow graph version ${doc.version}; this build reads version 1.`, "FLOW_WORKFLOW_IMPORT_VERSION");
  }
  // Rebuild through the same whitelist export applies, so an imported
  // document can never smuggle foreign fields past validation.
  const rebuilt = {
    ...(doc.name ? { name: doc.name } : {}),
    nodes: (Array.isArray(doc.nodes) ? doc.nodes : []).map(raw => {
      const probe = normalizeNode(raw ?? {}, 0);
      return whitelistedNode(probe);
    }),
    edges: Array.isArray(doc.edges) ? doc.edges : [],
  };
  return validateWorkflowGraph(rebuilt);
}

// --- run records + receipt fold -------------------------------------------------------

export function createWorkflowGraphRun(graph, { project, outputDir = project, id } = {}) {
  const compiled = compileWorkflowGraph(graph, { project, outputDir, runId: id || null });
  const runId = id || crypto.randomUUID();
  if (!id) {
    // Jobs were compiled before the id existed; restamp the run ids.
    for (const node of compiled.nodes) {
      if (!node.job) continue;
      node.job.payload.workflow.workflowGraph.runId = runId;
      node.job.metadata.workflowGraphRunId = runId;
    }
  }
  const now = Date.now();
  const nodes = compiled.nodes.map(node => ({
    nodeId: node.nodeId,
    type: node.type,
    ...(node.name ? { name: node.name } : {}),
    level: node.level,
    disposition: node.disposition,
    dependsOnNodeIds: node.dependsOnNodeIds,
    jobInput: node.job ? clone(node.job) : null,
    runtimeJobId: null,
    receipt: null,
    state: node.disposition === "job" ? "pending" : "ready",
    skipReason: null,
    handedOut: false,
  }));
  const run = {
    id: runId,
    version: 1,
    name: compiled.graph.name || "Workflow graph",
    graph: compiled.graph,
    project,
    outputDir,
    state: "active",
    finalizeState: null,
    revision: 0,
    nodes,
    createdAt: now,
    updatedAt: now,
    finalizedAt: null,
  };
  if (!nodes.some(node => node.disposition === "job")) {
    run.state = "finalized";
    run.finalizeState = "completed";
    run.finalizedAt = now;
  }
  return run;
}

const jobNodesOf = run => (Array.isArray(run?.nodes) ? run.nodes : []).filter(node => node.disposition === "job");
const nodeById = (run, nodeId) => (Array.isArray(run?.nodes) ? run.nodes : []).find(node => node.nodeId === nodeId) || null;

// FEAT-02 finalize semantics over graph nodes: completed when every
// generation node produced a clean completion, failed when none
// completed at all, needs_review for anything in between (a partial, a
// failure beside successes, a skip). Null while work remains.
export function computeWorkflowFinalizeState(run) {
  const jobNodes = jobNodesOf(run);
  if (!jobNodes.length) return "completed";
  if (jobNodes.some(node => !node.receipt && node.state !== "skipped")) return null;
  const receipts = jobNodes.map(node => node.receipt).filter(Boolean);
  if (jobNodes.every(node => node.receipt?.status === "completed" && node.receipt.partial !== true)) return "completed";
  if (!receipts.some(receipt => receipt.status === "completed")) return "failed";
  return "needs_review";
}

// Mark every pending job node whose dependency failed (or was itself
// skipped) as skipped, transitively, recording the dependency that
// doomed it. Mutates the given run; returns the newly skipped node ids.
function propagateSkipsInPlace(run) {
  const skipped = [];
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const node of jobNodesOf(run)) {
      if (node.state !== "pending" || node.receipt) continue;
      const doomed = (node.dependsOnNodeIds || []).map(id => nodeById(run, id)).find(dep => dep
        && (dep.state === "skipped" || (dep.receipt && dep.receipt.status !== "completed")));
      if (!doomed) continue;
      node.state = "skipped";
      node.skipReason = {
        code: "FLOW_WORKFLOW_DEPENDENCY_FAILED",
        dependency: doomed.nodeId,
        message: doomed.state === "skipped"
          ? `Upstream node "${doomed.nodeId}" was skipped, so this node was skipped too.`
          : `Upstream node "${doomed.nodeId}" ${doomed.receipt?.status || "failed"}, so this node was skipped.`,
      };
      skipped.push(node.nodeId);
      progressed = true;
    }
  }
  return skipped;
}

// Fold one queue snapshot into a run record. Pure: the input run is not
// mutated. Jobs match nodes by runtime job id, receipts derive through
// FEAT-02's shared helper, and skip propagation runs in the same step.
export function foldWorkflowSnapshotIntoRun(run, snapshot) {
  const next = clone(run);
  const jobs = Array.isArray(snapshot?.jobs) ? snapshot.jobs : [];
  const byId = new Map();
  for (const job of jobs) {
    if (job && typeof job.id === "string" && !byId.has(job.id)) byId.set(job.id, job);
  }
  const updatedNodeIds = [];
  for (const node of jobNodesOf(next)) {
    if (!node.runtimeJobId) continue;
    const receipt = receiptFromJob(byId.get(node.runtimeJobId));
    if (!receipt) continue;
    if (JSON.stringify(node.receipt) !== JSON.stringify(receipt)) {
      node.receipt = receipt;
      node.state = receipt.status === "completed" ? "completed" : "failed";
      updatedNodeIds.push(node.nodeId);
    }
  }
  const skipped = propagateSkipsInPlace(next);
  return {
    run: next,
    changed: updatedNodeIds.length > 0 || skipped.length > 0,
    updatedNodeIds,
    skippedNodeIds: skipped,
    allTerminal: computeWorkflowFinalizeState(next) !== null,
  };
}

// Every job node that may be handed to the queue right now: pending,
// not yet handed out, and every job dependency holding a completed
// receipt (a partial receipt still satisfies — it produced media; the
// run's finalize state is where the partial is accounted).
function enqueueableNodes(run) {
  return jobNodesOf(run).filter(node => {
    if (node.state !== "pending" || node.handedOut || node.receipt) return false;
    return (node.dependsOnNodeIds || []).every(id => {
      const dep = nodeById(run, id);
      return dep?.receipt?.status === "completed";
    });
  });
}

// Resolve one node's dynamic upstream inputs from the receipts of the
// nodes feeding it, producing the job input to enqueue. Returns null
// when an input cannot be satisfied (the upstream job produced no
// usable media) — the caller skips the node instead of enqueueing a
// broken job.
function resolveJobInput(run, node) {
  const job = clone(node.jobInput);
  const upstreamInputs = job?.payload?.workflow?.upstreamInputs || [];
  for (const input of upstreamInputs) {
    const dep = nodeById(run, input.fromNodeId);
    const media = dep?.receipt?.results?.[0];
    if (!media?.id || !media?.title) return null;
    const attachment = { assetName: media.title, expectedId: media.id };
    if (input.intoPort === "image_ref") {
      job.payload.attachments = [...(job.payload.attachments || []), attachment];
    } else if (input.intoPort === "frame_1") {
      job.payload.firstFrame = attachment;
    } else if (input.intoPort === "frame_2") {
      job.payload.lastFrame = attachment;
    }
  }
  return job;
}

// --- run store -------------------------------------------------------------------------

export class FlowWorkflowGraphRuns {
  constructor({ storage = globalThis.chrome?.storage?.local, storageKey = STORAGE_KEY, maxRuns = MAX_RUNS } = {}) {
    if (!storage?.get || !storage?.set) throw new TypeError("FlowWorkflowGraphRuns requires chrome.storage.local or a compatible storage adapter.");
    this.storage = storage;
    this.storageKey = storageKey;
    this.maxRuns = Math.max(1, Number(maxRuns) || MAX_RUNS);
    this.runs = [];
    this.writeChain = Promise.resolve();
    this.persistQueued = false;
    this.foldChain = Promise.resolve();
    this.ready = this.#restore();
  }

  async #restore() {
    try {
      const stored = await this.storage.get(this.storageKey);
      const state = stored?.[this.storageKey];
      if (state && state.version === 1 && Array.isArray(state.runs)) {
        this.runs = state.runs
          .filter(run => run && typeof run.id === "string" && Array.isArray(run.nodes))
          .slice(0, this.maxRuns)
          .map(run => clone(run));
      }
    } catch {
      // A corrupt or unavailable store must not wedge workflow tracking
      // behind a rejected ready promise; start empty instead.
      this.runs = [];
    }
    return clone(this.runs);
  }

  // Batched writes, same discipline as the sibling stores: the snapshot
  // is taken when the chained write actually runs, and a failed write
  // degrades to in-memory-only rather than failing the queue path.
  #schedulePersist() {
    if (this.persistQueued) return this.writeChain;
    this.persistQueued = true;
    this.writeChain = this.writeChain.catch(() => {}).then(async () => {
      this.persistQueued = false;
      const snapshot = { version: 1, updatedAt: Date.now(), runs: clone(this.runs) };
      await this.storage.set({ [this.storageKey]: snapshot });
    }).catch(() => {});
    return this.writeChain;
  }

  async flush() {
    await this.ready;
    await this.writeChain;
  }

  #find(id) {
    return this.runs.find(run => run.id === String(id)) || null;
  }

  async list() {
    await this.ready;
    return clone(this.runs);
  }

  async get(id) {
    await this.ready;
    const run = this.#find(id);
    return run ? clone(run) : null;
  }

  async remove(id) {
    await this.ready;
    const index = this.runs.findIndex(run => run.id === String(id));
    if (index < 0) return false;
    this.runs.splice(index, 1);
    this.#schedulePersist();
    return true;
  }

  // Hand out every currently-runnable node of a run: resolve its
  // dynamic inputs from upstream receipts, mark it handed out (so it is
  // handed out exactly once), and skip it — with propagation — when an
  // upstream input can no longer be satisfied. Mutates the run.
  #takeHandouts(run) {
    const ready = [];
    let progressed = true;
    while (progressed) {
      progressed = false;
      propagateSkipsInPlace(run);
      for (const node of enqueueableNodes(run)) {
        const job = resolveJobInput(run, node);
        if (!job) {
          node.state = "skipped";
          node.skipReason = {
            code: "FLOW_WORKFLOW_UPSTREAM_MEDIA_MISSING",
            dependency: (node.dependsOnNodeIds || [])[0] || null,
            message: `Upstream node produced no usable media for node "${node.nodeId}", so it was skipped.`,
          };
          progressed = true;
          continue;
        }
        node.handedOut = true;
        ready.push({ nodeId: node.nodeId, job });
      }
    }
    return ready;
  }

  #finalizeIfDone(run) {
    const finalizeState = computeWorkflowFinalizeState(run);
    if (!finalizeState || run.state !== "active") return null;
    run.state = "finalized";
    run.finalizeState = finalizeState;
    run.finalizedAt = Date.now();
    run.revision += 1;
    return finalizeState;
  }

  // Validate + compile a graph into a persistent run record and hand
  // out the first runnable level. Returns the record plus the job
  // inputs the caller must enqueue (and then bind via recordAdmission).
  async create({ graph, project, outputDir } = {}) {
    await this.ready;
    const run = createWorkflowGraphRun(graph, { project, outputDir });
    this.runs.unshift(run);
    while (this.runs.length > this.maxRuns) {
      const evictAt = this.runs.findLastIndex(candidate => candidate.id !== run.id && candidate.state !== "active");
      if (evictAt < 0) break;
      this.runs.splice(evictAt, 1);
    }
    const toEnqueue = run.state === "active" ? this.#takeHandouts(run) : [];
    this.#schedulePersist();
    return { run: clone(run), toEnqueue };
  }

  // Bind the runtime job ids an enqueue produced to their nodes.
  async recordAdmission(id, { batchId = null, mapping } = {}) {
    await this.ready;
    const run = this.#find(id);
    if (!run) throw graphError(`No workflow graph run with id ${id}.`, "FLOW_WORKFLOW_RUN_NOT_FOUND");
    if (run.state !== "active") throw graphError(`Workflow graph run ${run.id} is not active.`, "FLOW_WORKFLOW_RUN_NOT_ACTIVE");
    if (!Array.isArray(mapping) || mapping.length < 1) {
      throw graphError("An admission mapping must name at least one node.", "FLOW_WORKFLOW_ADMISSION_INVALID");
    }
    const seenNodes = new Set();
    const seenJobs = new Set();
    for (const entry of mapping) {
      const node = nodeById(run, String(entry?.nodeId || ""));
      const jobId = typeof entry?.jobId === "string" ? entry.jobId : "";
      if (!node || node.disposition !== "job" || !node.handedOut || node.runtimeJobId || !jobId || seenNodes.has(node.nodeId) || seenJobs.has(jobId)) {
        throw graphError("The admission mapping does not match the handed-out nodes of this run.", "FLOW_WORKFLOW_ADMISSION_INVALID");
      }
      seenNodes.add(node.nodeId);
      seenJobs.add(jobId);
    }
    for (const entry of mapping) {
      const node = nodeById(run, String(entry.nodeId));
      node.runtimeJobId = entry.jobId;
      node.state = "admitted";
    }
    if (batchId) run.batchId = String(batchId);
    run.updatedAt = Date.now();
    run.revision += 1;
    this.#schedulePersist();
    return clone(run);
  }

  // Undo a handout whose enqueue failed, so the nodes become runnable
  // again on the next fold instead of wedging the run.
  async releaseEnqueue(id, nodeIds) {
    await this.ready;
    const run = this.#find(id);
    if (!run) throw graphError(`No workflow graph run with id ${id}.`, "FLOW_WORKFLOW_RUN_NOT_FOUND");
    let changed = false;
    for (const nodeId of Array.isArray(nodeIds) ? nodeIds : []) {
      const node = nodeById(run, String(nodeId));
      if (node && node.handedOut && !node.runtimeJobId) {
        node.handedOut = false;
        changed = true;
      }
    }
    if (changed) {
      run.updatedAt = Date.now();
      run.revision += 1;
      this.#schedulePersist();
    }
    return clone(run);
  }

  // Scheduler entry point: fold one queue snapshot into every active
  // run. Serialized like the sibling stores — snapshots arrive on every
  // queue transition and must never interleave mutations. Returns one
  // result per run that changed, finalized, or has jobs to enqueue.
  observeSnapshot(snapshot) {
    const task = this.foldChain.catch(() => {}).then(() => this.#foldAll(snapshot));
    this.foldChain = task.catch(() => {});
    return task;
  }

  async #foldAll(snapshot) {
    await this.ready;
    const results = [];
    for (const run of this.runs) {
      if (run.state !== "active") continue;
      const folded = foldWorkflowSnapshotIntoRun(run, snapshot);
      let changed = folded.changed;
      if (folded.changed) {
        run.nodes = folded.run.nodes;
      }
      // Handouts are computed on every fold, not only on changes: a
      // released handout must go out again on the next snapshot even
      // when that snapshot itself changed nothing here.
      const toEnqueue = this.#takeHandouts(run);
      if (toEnqueue.length) changed = true;
      const finalizeState = this.#finalizeIfDone(run);
      if (finalizeState) changed = true;
      if (changed) {
        run.updatedAt = Date.now();
        this.#schedulePersist();
      }
      if (folded.changed || toEnqueue.length || finalizeState) {
        results.push({ run: clone(run), changed: folded.changed, toEnqueue, finalizeState });
      }
    }
    return results;
  }
}
