// FEAT-09 — local generation-config template library (study feature
// #15, local half).
//
// A template packages a reusable generation setup: the composer state
// (prompt + settings + refs) saved under a name, listed / applied /
// deleted locally. Applying a template reproduces prompt + settings +
// refs into a NEW queue job payload in exactly the shape the sidebar's
// executeGenerationTask builds for flow.generation.submit — the stored
// state is normalized once at save time into that payload's source
// fields, and the payload builder mirrors the submit path's own
// derivations (aspect-ratio alias, variant count, refMediaTypeMap,
// video-settings spread), so an applied template submits identically
// to having typed the same composer state by hand.
//
// The template content the reference serves (categories, search,
// ratings) is a vendor API — the server catalog stays blocked
// (FEAT-B5). This store is local only, persisted in chrome.storage.local
// under its own versioned key with the same discipline as the sibling
// stores (batched write chain, restore that tolerates corruption,
// oldest-first eviction at the cap). It never reads or writes the
// saved-prompts/snippets key (FEAT-04): pre-existing saved prompts keep
// loading exactly as before.

export const GEN_TEMPLATES_STORAGE_KEY = "flowMcpGenTemplatesV1";
export const MAX_GEN_TEMPLATES = 100;

export class GenTemplateError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "GenTemplateError";
    this.code = code;
  }
}

const templateError = (message, code) => new GenTemplateError(message, code);

const clone = value => structuredClone(value);
const asObject = value => (value && typeof value === "object" && !Array.isArray(value) ? value : null);
const cleanText = (value, max = 2000) => String(value ?? "").trim().slice(0, max);

// Frames ride the payload as objects; the submit path accepts a bare
// string as shorthand for { assetName } — normalize to the object form.
function normalizeFrameRef(value) {
  if (typeof value === "string") {
    const assetName = value.trim();
    return assetName ? { assetName } : null;
  }
  if (asObject(value)) return clone(value);
  return null;
}

// The one normalization every composer state passes through, at save
// time and again on restore. Only the fields the generation payload is
// built from survive — foreign fields (runtime ids, server data) are
// dropped here, never stored.
export function normalizeGenTemplateState(state) {
  if (!asObject(state)) {
    throw templateError("A generation template needs a composer state object.", "FLOW_GEN_TEMPLATE_STATE_INVALID");
  }
  const prompt = cleanText(state.prompt, 20000);
  if (!prompt) {
    throw templateError("A generation template needs the composer's prompt text.", "FLOW_GEN_TEMPLATE_PROMPT_REQUIRED");
  }
  const count = Math.max(1, Math.min(20, Math.trunc(Number(state.count) || 1)));
  const model = cleanText(state.model, 200);
  return {
    prompt,
    type: state.type === "video" ? "video" : "image",
    ...(model ? { model } : {}),
    aspectRatio: cleanText(state.aspectRatio ?? state.aspect_ratio, 50),
    count,
    autoDownload: state.autoDownload === true,
    settings: asObject(state.settings) ? clone(state.settings) : {},
    attachments: (Array.isArray(state.attachments) ? state.attachments : [])
      .filter(entry => asObject(entry))
      .map(entry => clone(entry)),
    firstFrame: normalizeFrameRef(state.firstFrame),
    lastFrame: normalizeFrameRef(state.lastFrame),
  };
}

export function createGenTemplateRecord(state, { name, id, now = Date.now() } = {}) {
  const resolvedName = cleanText(name, 200);
  if (!resolvedName) {
    throw templateError("A generation template needs a name.", "FLOW_GEN_TEMPLATE_NAME_REQUIRED");
  }
  const stamp = Number.isFinite(now) ? now : Date.now();
  return {
    id: String(id || crypto.randomUUID()),
    name: resolvedName,
    state: normalizeGenTemplateState(state),
    createdAt: stamp,
    updatedAt: stamp,
  };
}

// Rebuild the queue job for one template. This mirrors the sidebar
// submit path's payload construction field for field, including the
// refMediaTypeMap derivation and the trailing video-settings spread
// (settings keys win, exactly as video_settings does at submit).
export function buildJobPayloadFromGenTemplate(record) {
  if (!asObject(record) || !asObject(record.state) || !cleanText(record.state.prompt)) {
    throw templateError("Cannot apply a malformed generation template record.", "FLOW_GEN_TEMPLATE_INVALID");
  }
  const state = record.state;
  const attachments = clone(Array.isArray(state.attachments) ? state.attachments : []);
  const refMediaTypeMap = {};
  for (const att of attachments) {
    if (att && typeof att === "object") {
      const key = att.assetName || att.id || att.expectedId;
      if (key && att.kind) {
        refMediaTypeMap[key] = att.kind;
        if (att.expectedId) refMediaTypeMap[att.expectedId] = att.kind;
        if (att.assetName) refMediaTypeMap[att.assetName.replace(/^(?:asset|character):/i, "")] = att.kind;
      }
    }
  }
  const count = Math.max(1, Math.min(20, Math.trunc(Number(state.count) || 1)));
  const type = state.type === "video" ? "video" : "image";
  const prompt = String(state.prompt);
  const payload = {
    type,
    autoDownload: state.autoDownload === true,
    prompt,
    ...(cleanText(state.model, 200) ? { model: cleanText(state.model, 200) } : {}),
    aspectRatio: cleanText(state.aspectRatio, 50),
    aspect_ratio: cleanText(state.aspectRatio, 50),
    variants: count,
    count,
    attachments,
    ...(Object.keys(refMediaTypeMap).length > 0 ? { refMediaTypeMap } : {}),
    ...(asObject(state.firstFrame) ? { firstFrame: clone(state.firstFrame) } : {}),
    ...(asObject(state.lastFrame) ? { lastFrame: clone(state.lastFrame) } : {}),
    ...(asObject(state.settings) ? clone(state.settings) : {}),
  };
  return {
    operation: "flow.generation.submit",
    payload,
    label: `[${type.toUpperCase()}] ${prompt.slice(0, 96)}`,
  };
}

function normalizeStoredRecord(raw) {
  if (!asObject(raw) || typeof raw.id !== "string" || !raw.id || !asObject(raw.state)) return null;
  try {
    return {
      id: raw.id,
      name: cleanText(raw.name, 200),
      state: normalizeGenTemplateState(raw.state),
      createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : 0,
      updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : (Number.isFinite(raw.createdAt) ? raw.createdAt : 0),
    };
  } catch {
    return null;
  }
}

export class FlowGenTemplates {
  constructor({ storage = globalThis.chrome?.storage?.local, storageKey = GEN_TEMPLATES_STORAGE_KEY, maxTemplates = MAX_GEN_TEMPLATES } = {}) {
    if (!storage?.get || !storage?.set) throw new TypeError("FlowGenTemplates requires chrome.storage.local or a compatible storage adapter.");
    this.storage = storage;
    this.storageKey = storageKey;
    this.maxTemplates = Math.max(1, Number(maxTemplates) || MAX_GEN_TEMPLATES);
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

  // Batched writes, same discipline as the sibling stores: the
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

  async list({ search = "" } = {}) {
    await this.ready;
    const needle = cleanText(search, 200).toLowerCase();
    return clone(this.templates.filter(template => {
      if (needle && !`${template.name} ${template.state.prompt}`.toLowerCase().includes(needle)) return false;
      return true;
    }));
  }

  async get(id) {
    await this.ready;
    const template = this.#find(id);
    return template ? clone(template) : null;
  }

  async save(state, meta = {}) {
    await this.ready;
    const record = createGenTemplateRecord(state, meta);
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

  // Apply = build the fresh queue job payload for this template. The
  // record itself is never handed out, so a caller mutating the job
  // cannot corrupt the stored template.
  async apply(id) {
    await this.ready;
    const template = this.#find(id);
    if (!template) throw templateError(`No generation template with id ${id}.`, "FLOW_GEN_TEMPLATE_NOT_FOUND");
    return buildJobPayloadFromGenTemplate(template);
  }
}
