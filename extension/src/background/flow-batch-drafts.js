// Persistent batch drafts for the Flow queue.
//
// Logic (adapted from the reference extension's batch store design, not its
// code): a batch is composed once, saved under a label, and can be run
// later or re-run any number of times. A draft stores the job inputs
// exactly as the panel composed them; running a draft materializes a
// fresh set of queue jobs from those inputs.
//
// Materialization mints a fresh ID for every job that carries one and
// rewrites dependsOnId edges through the same mapping, so chained jobs
// keep their order across runs and a re-run never collides with the job
// IDs of a previous run still sitting in the queue.

const STORAGE_KEY = "flowMcpBatchDraftsV1";
const MAX_DRAFT_JOBS = 100;

const clone = value => structuredClone(value);

export function materializeDraftJobs(draft, makeId = () => crypto.randomUUID()) {
  const jobs = Array.isArray(draft?.jobs) ? draft.jobs : [];
  const idMap = new Map();
  const materialized = jobs.map(job => {
    const copy = clone(job);
    if (typeof copy?.id === "string" && copy.id) {
      const fresh = makeId();
      idMap.set(copy.id, fresh);
      copy.id = fresh;
    }
    return copy;
  });
  for (const job of materialized) {
    const dependsOnId = job?.metadata?.dependsOnId;
    if (typeof dependsOnId === "string" && idMap.has(dependsOnId)) {
      job.metadata = { ...job.metadata, dependsOnId: idMap.get(dependsOnId) };
    }
  }
  return materialized;
}

export class FlowBatchDrafts {
  constructor({ storage = globalThis.chrome?.storage?.local, storageKey = STORAGE_KEY } = {}) {
    if (!storage?.get || !storage?.set) throw new TypeError("FlowBatchDrafts requires chrome.storage.local or a compatible storage adapter.");
    this.storage = storage;
    this.storageKey = storageKey;
    this.drafts = [];
    this.ready = this.#restore();
  }

  async #restore() {
    const stored = await this.storage.get(this.storageKey);
    const state = stored?.[this.storageKey];
    if (state && state.version === 1 && Array.isArray(state.drafts)) {
      this.drafts = state.drafts
        .filter(draft => draft && typeof draft.id === "string" && Array.isArray(draft.jobs))
        .map(draft => clone(draft));
    }
    // Return the array directly: list() awaits this.ready, which is this
    // very promise — calling it here would deadlock the store.
    return clone(this.drafts);
  }

  async #persist() {
    await this.storage.set({ [this.storageKey]: { version: 1, updatedAt: Date.now(), drafts: this.drafts } });
  }

  async list() {
    await this.ready;
    return clone(this.drafts);
  }

  async get(id) {
    await this.ready;
    const draft = this.drafts.find(item => item.id === String(id));
    return draft ? clone(draft) : null;
  }

  async save({ id, label, jobs } = {}) {
    await this.ready;
    if (!Array.isArray(jobs) || jobs.length < 1 || jobs.length > MAX_DRAFT_JOBS) {
      throw Object.assign(new Error(`A batch draft must contain between 1 and ${MAX_DRAFT_JOBS} jobs.`), { code: "FLOW_BATCH_DRAFT_SIZE_INVALID" });
    }
    for (const job of jobs) {
      if (!job || typeof job.operation !== "string" || !job.operation) {
        throw Object.assign(new Error("Every batch draft job needs an operation."), { code: "FLOW_BATCH_DRAFT_JOB_INVALID" });
      }
    }
    const now = Date.now();
    const existing = id ? this.drafts.find(item => item.id === String(id)) : null;
    const draft = {
      id: existing?.id || crypto.randomUUID(),
      label: String(label || "Batch Flow").trim().slice(0, 160) || "Batch Flow",
      jobs: clone(jobs),
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      runCount: existing?.runCount || 0,
      lastRunAt: existing?.lastRunAt || null,
      lastBatchId: existing?.lastBatchId || null,
    };
    if (existing) this.drafts.splice(this.drafts.indexOf(existing), 1, draft);
    else this.drafts.unshift(draft);
    await this.#persist();
    return clone(draft);
  }

  async remove(id) {
    await this.ready;
    const index = this.drafts.findIndex(item => item.id === String(id));
    if (index < 0) return false;
    this.drafts.splice(index, 1);
    await this.#persist();
    return true;
  }

  async recordRun(id, batchId) {
    await this.ready;
    const draft = this.drafts.find(item => item.id === String(id));
    if (!draft) return null;
    draft.runCount = (draft.runCount || 0) + 1;
    draft.lastRunAt = Date.now();
    draft.lastBatchId = batchId || null;
    draft.updatedAt = Date.now();
    await this.#persist();
    return clone(draft);
  }
}
