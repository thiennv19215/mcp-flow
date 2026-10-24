import {
  exportWorkflowGraph,
  importWorkflowGraph,
} from "./flow-workflow-graph.js";

// FEAT-08 — local workflow templates (study feature #14, local half).
//
// Any workflow in the FEAT-07 graph model can be saved as a named
// template (name + description + category) and later instantiated as a
// new workflow; templates export/import as files. Everything template-
// shaped passes through FEAT-07's export/import pair, so the per-type
// field whitelist lives in exactly one place (flow-workflow-graph.js)
// and a template can never carry runtime state (status, receipts,
// runtime ids) or foreign fields — the stored graph IS the exported
// document, and instantiation IS the import of that document.
//
// The browsable template catalog and creator publishing are vendor
// server features and stay blocked (FEAT-B4) — this store is local
// only, persisted in chrome.storage.local under a versioned key, with
// the same discipline as the sibling stores (batched write chain,
// restore that tolerates corruption, oldest-first eviction at the cap).

export const WORKFLOW_TEMPLATES_STORAGE_KEY = "flowMcpWorkflowTemplatesV1";
export const WORKFLOW_TEMPLATE_DOCUMENT_KIND = "flow.workflow-template";
export const WORKFLOW_TEMPLATE_DOCUMENT_VERSION = 1;
export const MAX_WORKFLOW_TEMPLATES = 100;

export class WorkflowTemplateError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "WorkflowTemplateError";
    this.code = code;
  }
}

const templateError = (message, code) => new WorkflowTemplateError(message, code);

const clone = value => structuredClone(value);
const asObject = value => (value && typeof value === "object" && !Array.isArray(value) ? value : null);
const cleanText = (value, max = 2000) => String(value ?? "").trim().slice(0, max);

// Build the stored record for one workflow graph. The graph is run
// through the FEAT-07 export first, so validation errors surface with
// the graph module's own codes and only whitelisted fields are kept.
export function createWorkflowTemplateRecord(graph, { name, description = "", category = "", id, now = Date.now() } = {}) {
  const document = exportWorkflowGraph(graph);
  const resolvedName = cleanText(name, 200) || cleanText(document.name, 200);
  if (!resolvedName) {
    throw templateError("A workflow template needs a name (the workflow itself is unnamed).", "FLOW_WORKFLOW_TEMPLATE_NAME_REQUIRED");
  }
  const stamp = Number.isFinite(now) ? now : Date.now();
  return {
    id: String(id || crypto.randomUUID()),
    name: resolvedName,
    description: cleanText(description),
    category: cleanText(category, 100),
    graph: document,
    createdAt: stamp,
    updatedAt: stamp,
  };
}

// A template instantiates as a NEW workflow: the stored document goes
// back through the FEAT-07 import (which re-applies the whitelist and
// full validation), so the result is a fresh deep copy whose nodes and
// edges are deep-equal to the stored document's.
export function instantiateWorkflowTemplate(record, { name } = {}) {
  if (!asObject(record) || !asObject(record.graph)) {
    throw templateError("Cannot instantiate a malformed workflow template record.", "FLOW_WORKFLOW_TEMPLATE_INVALID");
  }
  const workflow = importWorkflowGraph(clone(record.graph));
  const resolvedName = cleanText(name, 200) || cleanText(record.name, 200);
  if (resolvedName) workflow.name = resolvedName;
  return workflow;
}

// The file shape for one template. The graph is re-exported on the way
// out so even a hand-edited stored record cannot leak foreign fields
// into an exported file.
export function exportWorkflowTemplate(record) {
  if (!asObject(record) || !asObject(record.graph)) {
    throw templateError("Cannot export a malformed workflow template record.", "FLOW_WORKFLOW_TEMPLATE_INVALID");
  }
  return {
    kind: WORKFLOW_TEMPLATE_DOCUMENT_KIND,
    version: WORKFLOW_TEMPLATE_DOCUMENT_VERSION,
    name: cleanText(record.name, 200),
    ...(cleanText(record.description) ? { description: cleanText(record.description) } : {}),
    ...(cleanText(record.category, 100) ? { category: cleanText(record.category, 100) } : {}),
    graph: exportWorkflowGraph(record.graph),
  };
}

// Parse a template file back into record fields (no id/timestamps —
// the store mints those). The graph round-trips through import AND
// export so smuggled fields are stripped in both directions.
export function importWorkflowTemplate(doc) {
  if (!asObject(doc)) throw templateError("A workflow template import must be a template document object.", "FLOW_WORKFLOW_TEMPLATE_IMPORT_INVALID");
  if (doc.kind !== WORKFLOW_TEMPLATE_DOCUMENT_KIND) {
    throw templateError(`Cannot import a document of kind "${doc.kind || "unknown"}" as a workflow template.`, "FLOW_WORKFLOW_TEMPLATE_IMPORT_KIND");
  }
  if (doc.version !== WORKFLOW_TEMPLATE_DOCUMENT_VERSION) {
    throw templateError(`Unsupported workflow template version ${doc.version}; this build reads version ${WORKFLOW_TEMPLATE_DOCUMENT_VERSION}.`, "FLOW_WORKFLOW_TEMPLATE_IMPORT_VERSION");
  }
  const graph = exportWorkflowGraph(importWorkflowGraph(doc.graph));
  return {
    name: cleanText(doc.name, 200) || cleanText(graph.name, 200),
    description: cleanText(doc.description),
    category: cleanText(doc.category, 100),
    graph,
  };
}

function normalizeStoredRecord(raw) {
  if (!asObject(raw) || typeof raw.id !== "string" || !raw.id || !asObject(raw.graph)) return null;
  return {
    id: raw.id,
    name: cleanText(raw.name, 200),
    description: cleanText(raw.description),
    category: cleanText(raw.category, 100),
    graph: clone(raw.graph),
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : 0,
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : (Number.isFinite(raw.createdAt) ? raw.createdAt : 0),
  };
}

export class FlowWorkflowTemplates {
  constructor({ storage = globalThis.chrome?.storage?.local, storageKey = WORKFLOW_TEMPLATES_STORAGE_KEY, maxTemplates = MAX_WORKFLOW_TEMPLATES } = {}) {
    if (!storage?.get || !storage?.set) throw new TypeError("FlowWorkflowTemplates requires chrome.storage.local or a compatible storage adapter.");
    this.storage = storage;
    this.storageKey = storageKey;
    this.maxTemplates = Math.max(1, Number(maxTemplates) || MAX_WORKFLOW_TEMPLATES);
    this.templates = [];
    this.writeChain = Promise.resolve();
    this.persistQueued = false;
    this.ready = this.#restore();
  }

  async #restore() {
    try {
      const stored = await this.storage.get(this.storageKey);
      const state = stored?.[this.storageKey];
      if (state && state.version === 1 && Array.isArray(state.templates)) {
        this.templates = state.templates
          .map(normalizeStoredRecord)
          .filter(Boolean)
          .slice(0, this.maxTemplates);
      }
    } catch {
      // A corrupt or unavailable store must not wedge the template
      // library behind a rejected ready promise; start empty instead.
      this.templates = [];
    }
    return clone(this.templates);
  }

  // Batched writes, same discipline as the batch-run store: the
  // snapshot is taken when the chained write actually runs, so a burst
  // of saves coalesces into one storage write of the freshest state,
  // and a failed write degrades to in-memory-only.
  #schedulePersist() {
    if (this.persistQueued) return this.writeChain;
    this.persistQueued = true;
    this.writeChain = this.writeChain.catch(() => {}).then(async () => {
      this.persistQueued = false;
      const snapshot = { version: 1, updatedAt: Date.now(), templates: clone(this.templates) };
      await this.storage.set({ [this.storageKey]: snapshot });
    }).catch(() => {});
    return this.writeChain;
  }

  async flush() {
    await this.ready;
    await this.writeChain;
  }

  #find(id) {
    return this.templates.find(template => template.id === String(id)) || null;
  }

  #insert(fields) {
    const record = { ...fields, id: crypto.randomUUID(), createdAt: Date.now(), updatedAt: Date.now() };
    this.templates.push(record);
    while (this.templates.length > this.maxTemplates) this.templates.shift();
    this.#schedulePersist();
    return clone(record);
  }

  async list({ category = "", search = "" } = {}) {
    await this.ready;
    const wantedCategory = cleanText(category, 100).toLowerCase();
    const needle = cleanText(search, 200).toLowerCase();
    return clone(this.templates.filter(template => {
      if (wantedCategory && template.category.toLowerCase() !== wantedCategory) return false;
      if (needle && !`${template.name} ${template.description} ${template.category}`.toLowerCase().includes(needle)) return false;
      return true;
    }));
  }

  async get(id) {
    await this.ready;
    const template = this.#find(id);
    return template ? clone(template) : null;
  }

  async save(graph, meta = {}) {
    await this.ready;
    const record = createWorkflowTemplateRecord(graph, meta);
    this.templates.push(record);
    while (this.templates.length > this.maxTemplates) this.templates.shift();
    this.#schedulePersist();
    return clone(record);
  }

  async remove(id) {
    await this.ready;
    const index = this.templates.findIndex(template => template.id === String(id));
    if (index < 0) return false;
    this.templates.splice(index, 1);
    this.#schedulePersist();
    return true;
  }

  async instantiate(id, options = {}) {
    await this.ready;
    const template = this.#find(id);
    if (!template) throw templateError(`No workflow template with id ${id}.`, "FLOW_WORKFLOW_TEMPLATE_NOT_FOUND");
    return instantiateWorkflowTemplate(template, options);
  }

  async exportTemplate(id) {
    await this.ready;
    const template = this.#find(id);
    if (!template) throw templateError(`No workflow template with id ${id}.`, "FLOW_WORKFLOW_TEMPLATE_NOT_FOUND");
    return exportWorkflowTemplate(template);
  }

  async importTemplate(doc) {
    await this.ready;
    const fields = importWorkflowTemplate(doc);
    if (!fields.name) {
      throw templateError("The imported template document carries no name.", "FLOW_WORKFLOW_TEMPLATE_NAME_REQUIRED");
    }
    return this.#insert(fields);
  }
}
