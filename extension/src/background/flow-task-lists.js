// Saved multi-task lists (FEAT-05).
//
// Logic (adapted from the reference extension's multi-task design, not
// its code): a batch draft is ONE settings snapshot shared by all its
// jobs; a TASK is a named generation config of its own — its own prompt
// list, ratio, model, references (with a refs-per-prompt count and a
// mention mode), video frame slots, download settings and project
// scope. Tasks persist locally, can be searched and filtered, and run
// one at a time, as a selection, or all at once.
//
// A run expands each task into the queue's standard generation jobs —
// one per prompt, each carrying that task's own settings and tagged
// with the task id — through the same enqueue path drafts use. Results
// then write back onto the originating task: the queue snapshot fold is
// FEAT-02's shared `foldQueueSnapshotIntoRun`, reused as-is. A task's
// active run is the fold target (index-aligned items keyed by the
// runtime job id each prompt was admitted under), so a receipt can only
// ever land on the task whose recorded run admitted that job — never on
// a task that merely resembles it.
//
// Sequential execution is FORCED for some selections (one tab / one
// editor constraint in the reference): any multi-prompt task, any chat
// provider task, or a selection mixing providers. The rule is the pure
// exported predicate `requiresSequential`, so the panel can surface the
// reason before the run starts and the worker reports the same verdict.
//
// Store discipline mirrors the sibling stores (drafts, runs, history):
// versioned storage envelope, write chain with snapshots taken at write
// time, storage failures degrading to in-memory state, and a per-task
// run lock checked synchronously so two panels cannot enqueue the same
// task twice.

import { foldQueueSnapshotIntoRun } from "./flow-batch-runs.js";

const STORAGE_KEY = "flowMcpTaskListsV1";
const MAX_TASKS = 100;
const MAX_PROMPTS_PER_TASK = 50;
const MAX_REFS_PER_TASK = 20;
const MAX_TASK_RESULTS = 200;

const clone = value => structuredClone(value);
const asObject = value => (value && typeof value === "object" && !Array.isArray(value) ? value : null);

const taskError = (message, code) => Object.assign(new Error(message), { code });

// --- config normalization -----------------------------------------------------

function normalizePrompts(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map(prompt => String(prompt ?? "").trim())
    .filter(Boolean)
    .slice(0, MAX_PROMPTS_PER_TASK);
}

function normalizeFrameSlot(value) {
  if (typeof value === "string") return value.trim() ? value : null;
  if (asObject(value)) return clone(value);
  return null;
}

// Bring any caller-supplied config into the stored shape. Prompts are
// the one hard requirement: a task that cannot produce a single job is
// rejected here, at save time, instead of at run time.
export function normalizeTaskConfig(input) {
  const source = asObject(input) || {};
  const prompts = normalizePrompts(source.prompts);
  if (!prompts.length) {
    throw taskError("A saved task needs at least one non-empty prompt.", "FLOW_TASK_CONFIG_INVALID");
  }
  const provider = source.provider === "chatgpt" ? "chatgpt" : "flow";
  const mediaType = provider === "chatgpt" ? "image" : (source.mediaType === "video" ? "video" : "image");
  const frames = asObject(source.frames) || {};
  const download = asObject(source.download) || {};
  const ratio = String(source.ratio ?? source.aspectRatio ?? source.aspect_ratio ?? "").trim() || null;
  const model = String(source.model ?? "").trim() || null;
  const quantityRaw = Number(source.quantity ?? source.count);
  return {
    provider,
    mediaType,
    prompts,
    ratio,
    model,
    quantity: Number.isFinite(quantityRaw) ? Math.max(1, Math.min(20, Math.floor(quantityRaw))) : 1,
    refs: Array.isArray(source.refs) ? clone(source.refs.slice(0, MAX_REFS_PER_TASK)) : [],
    refsPerPrompt: Number.isFinite(Number(source.refsPerPrompt)) && Number(source.refsPerPrompt) > 0
      ? Math.floor(Number(source.refsPerPrompt))
      : null,
    mentionMode: source.mentionMode === true,
    frames: {
      firstFrame: normalizeFrameSlot(frames.firstFrame),
      lastFrame: normalizeFrameSlot(frames.lastFrame),
    },
    download: {
      autoDownload: download.autoDownload === true,
      imageResolution: String(download.imageResolution ?? "").trim() || null,
      videoResolution: String(download.videoResolution ?? "").trim() || null,
    },
    projectId: typeof source.projectId === "string" && source.projectId ? source.projectId : null,
  };
}

function normalizeTaskName(value, config) {
  const name = String(value ?? "").trim().slice(0, 160);
  if (name) return name;
  return String(config?.prompts?.[0] || "Saved task").slice(0, 160);
}

// The first free name for a duplicate: the name itself, then " (2)",
// " (3)", ... compared case-sensitively against the names in use.
export function uniquifyTaskName(name, existingNames) {
  const taken = new Set(Array.isArray(existingNames) ? existingNames : []);
  const base = String(name || "Saved task");
  if (!taken.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base} (${suffix})`;
    if (!taken.has(candidate)) return candidate;
  }
}

// --- run expansion --------------------------------------------------------------

function refsForPrompt(config, promptIndex) {
  const refs = Array.isArray(config.refs) ? config.refs : [];
  // Mention mode resolves references from the prompt text itself, so
  // every job keeps the full ref set; a refs-per-prompt count slices
  // the pool into consecutive per-prompt groups instead.
  if (config.mentionMode || !config.refsPerPrompt) return clone(refs);
  const start = promptIndex * config.refsPerPrompt;
  return clone(refs.slice(start, start + config.refsPerPrompt));
}

function refMediaTypeMap(attachments) {
  const map = {};
  for (const att of attachments) {
    if (!att || typeof att !== "object" || !att.kind) continue;
    const key = att.assetName || att.id || att.expectedId;
    if (!key) continue;
    map[key] = att.kind;
    if (att.expectedId) map[att.expectedId] = att.kind;
    if (att.assetName) map[att.assetName.replace(/^(?:asset|character):/i, "")] = att.kind;
  }
  return map;
}

function framePayloadValue(slot) {
  if (slot === null || slot === undefined) return null;
  return typeof slot === "string" ? { assetName: slot } : clone(slot);
}

// One queue job per prompt, in prompt order, each carrying the task's
// own settings — the payload shapes are exactly the ones the sidebar's
// Flow and ChatGPT submits enqueue (GPT-14's pinned shapes), plus the
// task id tag the write-back and the queue panel key on.
export function expandTaskToJobs(task) {
  const config = normalizeTaskConfig(task?.config);
  const taskId = typeof task?.id === "string" ? task.id : null;
  return config.prompts.map((prompt, index) => {
    const attachments = refsForPrompt(config, index);
    if (config.provider === "chatgpt") {
      return {
        operation: "chatgpt.generation.submit",
        payload: {
          prompt,
          ...(config.ratio ? { ratio: config.ratio } : {}),
          attachments,
          autoDownload: config.download.autoDownload === true,
        },
        metadata: { provider: "chatgpt", ...(taskId ? { taskId } : {}) },
        label: `ChatGPT image: ${prompt.slice(0, 80)}`,
      };
    }
    const type = config.mediaType;
    const resolution = type === "video" ? config.download.videoResolution : config.download.imageResolution;
    const refMap = refMediaTypeMap(attachments);
    const firstFrame = framePayloadValue(config.frames.firstFrame);
    const lastFrame = framePayloadValue(config.frames.lastFrame);
    return {
      operation: "flow.generation.submit",
      payload: {
        type,
        autoDownload: config.download.autoDownload === true,
        prompt,
        ...(config.model ? { model: config.model } : {}),
        ...(config.ratio ? { aspectRatio: config.ratio, aspect_ratio: config.ratio } : {}),
        variants: config.quantity,
        count: config.quantity,
        attachments,
        ...(Object.keys(refMap).length ? { refMediaTypeMap: refMap } : {}),
        ...(firstFrame ? { firstFrame } : {}),
        ...(lastFrame ? { lastFrame } : {}),
        ...(resolution ? { download_resolution: resolution } : {}),
      },
      ...(taskId ? { metadata: { taskId } } : {}),
      label: `[${type.toUpperCase()}] ${prompt.slice(0, 96)}`,
    };
  });
}

// Expand a selection of tasks, preserving task order and, within each
// task, prompt order. Segments record how many consecutive jobs each
// task contributed, so the caller can attribute the admitted jobs back
// to their tasks positionally after one shared enqueue.
export function expandTasksToJobs(tasks) {
  const jobs = [];
  const segments = [];
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const expanded = expandTaskToJobs(task);
    segments.push({ taskId: typeof task?.id === "string" ? task.id : null, jobCount: expanded.length });
    jobs.push(...expanded);
  }
  return { jobs, segments };
}

// --- forced-sequential predicate --------------------------------------------------

// Sequential execution is forced when any selected task is multi-prompt
// (its prompts must not interleave with another task's), uses a chat
// provider (a single chat tab/editor), or when the selection mixes
// providers (one editor constraint). Pure: same input, same verdict,
// with every reason surfaced for the UI.
export function requiresSequential(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  const reasons = [];
  const providers = new Set();
  for (const task of list) {
    const config = asObject(task?.config) || {};
    const taskId = typeof task?.id === "string" ? task.id : null;
    const prompts = Array.isArray(config.prompts) ? config.prompts : [];
    if (prompts.length > 1) reasons.push({ taskId, reason: "multi_prompt" });
    const provider = config.provider === "chatgpt" ? "chatgpt" : "flow";
    providers.add(provider);
    if (provider === "chatgpt") reasons.push({ taskId, reason: "chat_provider" });
  }
  if (providers.size > 1) reasons.push({ taskId: null, reason: "mixed_providers" });
  return { sequential: reasons.length > 0, reasons };
}

// --- store -------------------------------------------------------------------------

export class FlowTaskLists {
  constructor({ storage = globalThis.chrome?.storage?.local, storageKey = STORAGE_KEY, maxTasks = MAX_TASKS } = {}) {
    if (!storage?.get || !storage?.set) throw new TypeError("FlowTaskLists requires chrome.storage.local or a compatible storage adapter.");
    this.storage = storage;
    this.storageKey = storageKey;
    this.maxTasks = Math.max(1, Number(maxTasks) || MAX_TASKS);
    this.tasks = [];
    this.writeChain = Promise.resolve();
    this.persistQueued = false;
    this.foldChain = Promise.resolve();
    this.runsInFlight = new Set();
    this.ready = this.#restore();
  }

  async #restore() {
    try {
      const stored = await this.storage.get(this.storageKey);
      const state = stored?.[this.storageKey];
      if (state && state.version === 1 && Array.isArray(state.tasks)) {
        this.tasks = state.tasks
          .filter(entry => entry && typeof entry.id === "string" && asObject(entry.config))
          .slice(0, this.maxTasks)
          .map(entry => clone(entry));
      }
    } catch {
      // A corrupt or unavailable store must not wedge every task
      // operation behind a rejected ready promise; start empty instead.
      this.tasks = [];
    }
    return clone(this.tasks);
  }

  // Batched writes, same discipline as the runs/history stores: the
  // snapshot is taken when the chained write actually runs.
  #schedulePersist() {
    if (this.persistQueued) return this.writeChain;
    this.persistQueued = true;
    this.writeChain = this.writeChain.catch(() => {}).then(async () => {
      this.persistQueued = false;
      const snapshot = { version: 1, updatedAt: Date.now(), tasks: clone(this.tasks) };
      await this.storage.set({ [this.storageKey]: snapshot });
    }).catch(() => {});
    return this.writeChain;
  }

  async flush() {
    await this.ready;
    await this.writeChain;
  }

  #find(id) {
    return this.tasks.find(entry => entry.id === String(id)) || null;
  }

  // Per-task run lock, mirroring the drafts store: checked and taken
  // synchronously, so the same task triggered from two panels at the
  // same moment cannot enqueue (and spend credits) twice.
  beginRun(id) {
    const key = String(id);
    if (this.runsInFlight.has(key)) return false;
    this.runsInFlight.add(key);
    return true;
  }

  endRun(id) {
    this.runsInFlight.delete(String(id));
  }

  async list() {
    await this.ready;
    return clone(this.tasks);
  }

  async get(id) {
    await this.ready;
    const task = this.#find(id);
    return task ? clone(task) : null;
  }

  // Search + project/provider filter. The query matches the task name
  // and any of its prompts, case-insensitively. A project filter keeps
  // tasks scoped to that project plus unscoped (global) tasks — an
  // unscoped task is not tied to one project, so hiding it from a
  // project view would lose it everywhere except "all".
  async search({ query = "", projectId = null, provider = null } = {}) {
    await this.ready;
    const needle = String(query || "").trim().toLowerCase();
    return clone(this.tasks.filter(task => {
      if (projectId && task.config.projectId && task.config.projectId !== projectId) return false;
      if (provider && task.config.provider !== provider) return false;
      if (!needle) return true;
      if (String(task.name || "").toLowerCase().includes(needle)) return true;
      return task.config.prompts.some(prompt => prompt.toLowerCase().includes(needle));
    }));
  }

  async create({ name, config } = {}) {
    await this.ready;
    const normalized = normalizeTaskConfig(config);
    const now = Date.now();
    const task = {
      id: crypto.randomUUID(),
      version: 1,
      name: normalizeTaskName(name, normalized),
      config: normalized,
      status: "pending",
      partial: false,
      results: [],
      error: null,
      runCount: 0,
      lastRunAt: null,
      activeRun: null,
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.unshift(task);
    while (this.tasks.length > this.maxTasks) this.tasks.pop();
    this.#schedulePersist();
    return clone(task);
  }

  async update(id, { name, config } = {}) {
    await this.ready;
    const task = this.#find(id);
    if (!task) throw taskError(`No saved task with id ${id}.`, "FLOW_TASK_NOT_FOUND");
    if (config !== undefined) task.config = normalizeTaskConfig(config);
    if (name !== undefined) task.name = normalizeTaskName(name, task.config);
    task.updatedAt = Date.now();
    this.#schedulePersist();
    return clone(task);
  }

  async remove(id) {
    await this.ready;
    const index = this.tasks.findIndex(entry => entry.id === String(id));
    if (index < 0) return false;
    this.tasks.splice(index, 1);
    this.#schedulePersist();
    return true;
  }

  // Duplicate clones the config under a uniquified name. Run state is
  // NOT cloned: the copy has never run, so it starts pending with no
  // results — claiming the original's outputs would be a false record.
  async duplicate(id) {
    await this.ready;
    const source = this.#find(id);
    if (!source) throw taskError(`No saved task with id ${id}.`, "FLOW_TASK_NOT_FOUND");
    const now = Date.now();
    const copy = {
      id: crypto.randomUUID(),
      version: 1,
      name: uniquifyTaskName(source.name, this.tasks.map(entry => entry.name)),
      config: clone(source.config),
      status: "pending",
      partial: false,
      results: [],
      error: null,
      runCount: 0,
      lastRunAt: null,
      activeRun: null,
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.splice(this.tasks.indexOf(source) + 1, 0, copy);
    this.#schedulePersist();
    return clone(copy);
  }

  // Record that a run of this task was admitted to the queue. `jobs`
  // are the queue jobs the enqueue actually accepted (their ids are the
  // runtime ids the fold will match receipts by), positionally aligned
  // with the task's prompts. The active run record IS the fold target
  // for FEAT-02's foldQueueSnapshotIntoRun.
  async recordTaskRun(id, { jobs, batchId = null } = {}) {
    await this.ready;
    const task = this.#find(id);
    if (!task) throw taskError(`No saved task with id ${id}.`, "FLOW_TASK_NOT_FOUND");
    if (task.activeRun) throw taskError("This task already has a run in flight.", "FLOW_TASK_RUN_IN_PROGRESS");
    const admitted = Array.isArray(jobs) ? jobs : [];
    const now = Date.now();
    task.activeRun = {
      batchId: typeof batchId === "string" && batchId ? batchId : null,
      startedAt: now,
      state: "active",
      segments: [{ indexes: admitted.map((_, index) => index) }],
      items: admitted.map((job, index) => ({
        index,
        hidden: false,
        runtimeJobId: typeof job?.id === "string" ? job.id : null,
        receipt: null,
      })),
    };
    task.status = "running";
    task.partial = false;
    task.error = null;
    task.runCount = (task.runCount || 0) + 1;
    task.lastRunAt = now;
    task.updatedAt = now;
    this.#schedulePersist();
    return clone(task);
  }

  // Fold one queue snapshot into every task with an active run. The
  // fold itself is FEAT-02's shared helper — this method only moves
  // folded receipts onto the owning task (result identities appended,
  // deduped by job + media id) and derives the task's status when the
  // run finalizes. Serialized through a promise chain, like the runs
  // store, and failure-isolated per task.
  observeSnapshot(snapshot) {
    const task = this.foldChain.then(() => this.#foldSnapshot(snapshot));
    this.foldChain = task.catch(() => {});
    return task;
  }

  async #foldSnapshot(snapshot) {
    await this.ready;
    let dirty = false;
    for (const task of this.tasks) {
      if (!task.activeRun) continue;
      try {
        const { run, changed, allTerminal } = foldQueueSnapshotIntoRun(task.activeRun, snapshot);
        if (!changed && !allTerminal) continue;
        task.activeRun = run;
        if (changed) {
          dirty = true;
          const seen = new Set(task.results.map(entry => `${entry.jobId}:${entry.id}`));
          for (const item of run.items) {
            if (!item?.receipt) continue;
            for (const media of item.receipt.results || []) {
              const key = `${item.receipt.jobId}:${media.id}`;
              if (seen.has(key)) continue;
              seen.add(key);
              task.results.push({
                id: media.id,
                title: media.title,
                kind: media.kind,
                jobId: item.receipt.jobId,
                promptIndex: item.index,
                finishedAt: item.receipt.finishedAt,
              });
            }
          }
          if (task.results.length > MAX_TASK_RESULTS) {
            task.results = task.results.slice(task.results.length - MAX_TASK_RESULTS);
          }
        }
        if (allTerminal) {
          dirty = true;
          const receipts = run.items.filter(item => item && !item.hidden).map(item => item.receipt).filter(Boolean);
          const clean = receipt => receipt && receipt.status === "completed" && receipt.partial !== true;
          if (receipts.length && receipts.every(clean)) {
            task.status = "completed";
            task.partial = false;
            task.error = null;
          } else if (!receipts.some(receipt => receipt.status === "completed")) {
            const firstFailure = receipts.find(receipt => receipt.error) || receipts[0];
            task.status = "failed";
            task.partial = false;
            task.error = firstFailure?.error || "The task run failed.";
          } else {
            task.status = "completed";
            task.partial = true;
            task.error = null;
          }
          task.activeRun = null;
          task.updatedAt = Date.now();
        }
      } catch {
        // One task's fold must never break the others or the queue path
        // feeding the snapshot; the worker logs at its own boundary.
      }
    }
    if (dirty) this.#schedulePersist();
  }
}
