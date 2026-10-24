// Structured generation-history records + re-run (FEAT-01).
//
// Logic (adapted from the reference extension's history design, not its
// code): every finished generation becomes a durable record carrying the
// FULL settings snapshot — prompt, model, ratio, refs, results, a status
// derived as success / partial / failed / stopped, duration, project and
// provider — instead of the sidebar's plain text activity log. Because a
// record is a complete snapshot, re-run is "rebuild the queue job from
// the record and enqueue it": refs ride the stored payload verbatim and
// are never re-resolved against the media library.
//
// Recording is fed by queue snapshot changes (the queue already emits
// them on every transition). A job is recorded once per finished attempt:
// the record id is derived from the job id + finishedAt, and the ids of
// recorded attempts are remembered in the stored envelope, so repeated
// snapshots, worker restarts, and even cap eviction can never resurrect
// or duplicate a record. Persistence failures degrade to in-memory-only
// history — recording must never break the generation path.

const STORAGE_KEY = "flowMcpHistoryV1";
const MAX_RECORDS = 200;
const MAX_REMEMBERED_IDS = 1000;
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
// Metadata keys that are runtime receipts, not settings: they land on a
// job while it runs and must not leak into a re-run.
const VOLATILE_METADATA_KEYS = new Set([
  "generationResultCheckpoint",
  "generationObservation",
  "manualSubmitPhase",
]);

const clone = value => structuredClone(value);

const asObject = value => (value && typeof value === "object" && !Array.isArray(value) ? value : null);

function mediaListFromResult(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 4) return [];
  if (Array.isArray(value.media)) return value.media;
  if (value.portraitMedia && typeof value.portraitMedia === "object") return [value.portraitMedia];
  if (value.result && typeof value.result === "object") return mediaListFromResult(value.result, depth + 1);
  return [];
}

function normalizeMedia(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).map(item => ({
    id: String(item?.id || "").trim(),
    title: String(item?.title || item?.name || "").trim(),
    kind: String(item?.kind || item?.type || "").toLowerCase() === "scene"
      ? "video"
      : String(item?.kind || item?.type || "").toLowerCase(),
  })).filter(item => item.id && ["image", "video"].includes(item.kind));
}

// Same discipline as the queue's VID-01 normalization: only the tile
// title and the classified failure code are kept.
function normalizeFailedOutputs(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).map(item => ({
    title: String(item?.title || item?.name || "").trim().slice(0, 300),
    code: String(item?.code || item?.errorCode || "FLOW_GENERATION_FAILED").trim() || "FLOW_GENERATION_FAILED",
  }));
}

function resultsForJob(job) {
  const checkpointMedia = job?.metadata?.generationResultCheckpoint?.media;
  if (Array.isArray(checkpointMedia) && checkpointMedia.length) return normalizeMedia(checkpointMedia);
  return normalizeMedia(mediaListFromResult(job?.result));
}

function failedOutputsForJob(job) {
  const fromJob = normalizeFailedOutputs(job?.failedOutputs);
  if (fromJob.length) return fromJob;
  return normalizeFailedOutputs(job?.result?.result?.failedOutputs ?? job?.result?.failedOutputs);
}

function sanitizedMetadata(metadata) {
  const source = asObject(metadata);
  if (!source) return undefined;
  const kept = {};
  for (const [key, value] of Object.entries(source)) {
    if (!VOLATILE_METADATA_KEYS.has(key)) kept[key] = value;
  }
  return Object.keys(kept).length ? kept : undefined;
}

// Derive a history record from a finished queue job, or return null when
// the job is not recordable: still in flight, or a finished bookkeeping
// operation with neither a prompt nor generated results (the reference
// skips exactly those).
export function recordFromJob(job, now = Date.now()) {
  if (!job || typeof job !== "object" || typeof job.id !== "string" || !job.id) return null;
  if (!TERMINAL_STATUSES.has(job.status)) return null;
  const payload = asObject(job.payload) || {};
  const params = asObject(payload.params) || {};
  const results = resultsForJob(job);
  const prompt = String(payload.prompt ?? params.prompt ?? "").trim();
  if (!prompt && results.length === 0) return null;

  const failedOutputs = failedOutputsForJob(job);
  const status = job.status === "cancelled"
    ? "stopped"
    : job.status === "failed"
      ? "failed"
      : (job.partial === true || failedOutputs.length > 0 ? "partial" : "success");
  const metadata = asObject(job.metadata);
  const operation = String(job.operation || "flow.generation.submit");
  const provider = String(metadata?.provider || (operation.startsWith("chatgpt.") ? "chatgpt" : "flow"));
  const startedAt = Number.isFinite(job.startedAt) ? job.startedAt : null;
  const finishedAt = Number.isFinite(job.finishedAt) ? job.finishedAt : now;
  const mediaType = String(payload.type ?? params.type ?? "").toLowerCase()
    || (operation === "chatgpt.generation.submit" ? "image" : (results[0]?.kind || null));
  const quantity = Math.max(1, Number(payload.count ?? payload.variants ?? params.count) || 1);
  const jobInput = {
    operation,
    payload: clone(payload),
    label: String(job.label || prompt || "Flow job").slice(0, 160),
    ...(sanitizedMetadata(job.metadata) ? { metadata: clone(sanitizedMetadata(job.metadata)) } : {}),
  };
  return {
    id: `hist-${job.id}-${finishedAt}`,
    version: 1,
    jobId: job.id,
    operation,
    provider,
    status,
    jobStatus: job.status,
    label: jobInput.label,
    prompt: prompt || null,
    mediaType: mediaType || null,
    model: payload.model ?? params.model ?? null,
    ratio: payload.aspectRatio ?? payload.aspect_ratio ?? payload.ratio ?? params.aspectRatio ?? params.aspect_ratio ?? null,
    quantity,
    refs: Array.isArray(payload.attachments) ? clone(payload.attachments) : [],
    results,
    failedOutputs,
    error: job.error ? String(job.error).slice(0, 2000) : null,
    errorCode: job.errorCode ? String(job.errorCode) : null,
    autoDownload: payload.autoDownload === true || payload.auto_download === true || params.autoDownload === true,
    projectId: typeof metadata?.flowProjectId === "string" && metadata.flowProjectId ? metadata.flowProjectId : null,
    batchId: typeof job.batch?.batchId === "string" ? job.batch.batchId : null,
    batchLabel: typeof job.batch?.batchLabel === "string" ? job.batch.batchLabel : null,
    startedAt,
    finishedAt,
    durationMs: startedAt !== null && finishedAt >= startedAt ? finishedAt - startedAt : null,
    recordedAt: now,
    jobInput,
  };
}

// Rebuild the queue job input a record originally ran with. The payload
// (settings + refs) comes from the stored snapshot verbatim; the queue
// mints a fresh id on enqueue, so a re-run never collides with the
// finished job it came from.
export function buildJobFromRecord(record) {
  const jobInput = asObject(record?.jobInput);
  if (!record || typeof record.id !== "string" || !jobInput || typeof jobInput.operation !== "string" || !asObject(jobInput.payload)) {
    throw Object.assign(new Error("History record does not carry a rebuildable job."), { code: "FLOW_HISTORY_RECORD_INVALID" });
  }
  return clone(jobInput);
}

export class FlowHistory {
  constructor({ storage = globalThis.chrome?.storage?.local, storageKey = STORAGE_KEY, maxRecords = MAX_RECORDS } = {}) {
    if (!storage?.get || !storage?.set) throw new TypeError("FlowHistory requires chrome.storage.local or a compatible storage adapter.");
    this.storage = storage;
    this.storageKey = storageKey;
    this.maxRecords = Math.max(1, Number(maxRecords) || MAX_RECORDS);
    this.records = [];
    this.recordedIds = new Set();
    this.writeChain = Promise.resolve();
    this.persistQueued = false;
    this.ready = this.#restore();
  }

  async #restore() {
    try {
      const stored = await this.storage.get(this.storageKey);
      const state = stored?.[this.storageKey];
      if (state && state.version === 1 && Array.isArray(state.records)) {
        this.records = state.records
          .filter(record => record && typeof record.id === "string" && typeof record.status === "string" && asObject(record.jobInput))
          .slice(0, this.maxRecords)
          .map(record => clone(record));
        const remembered = Array.isArray(state.recordedIds) ? state.recordedIds.filter(id => typeof id === "string") : [];
        this.recordedIds = new Set([...this.records.map(record => record.id), ...remembered].slice(-MAX_REMEMBERED_IDS));
      }
    } catch {
      // A corrupt or unavailable store must not wedge history behind a
      // rejected ready promise; start empty instead.
      this.records = [];
      this.recordedIds = new Set();
    }
    return clone(this.records);
  }

  // Batched writes: the snapshot is taken when the chained write actually
  // runs, so a burst of records (a whole batch finishing) coalesces into
  // a single storage write of the freshest state. A failed write is
  // swallowed — history degrades to in-memory rather than failing the
  // generation path that fed it.
  #schedulePersist() {
    if (this.persistQueued) return this.writeChain;
    this.persistQueued = true;
    this.writeChain = this.writeChain.catch(() => {}).then(async () => {
      this.persistQueued = false;
      const snapshot = {
        version: 1,
        updatedAt: Date.now(),
        records: clone(this.records),
        recordedIds: [...this.recordedIds].slice(-MAX_REMEMBERED_IDS),
      };
      await this.storage.set({ [this.storageKey]: snapshot });
    }).catch(() => {});
    return this.writeChain;
  }

  async flush() {
    await this.ready;
    await this.writeChain;
  }

  // Record one finished job. Returns the stored record, or null when the
  // job is not recordable or this finished attempt was already recorded.
  async recordJob(job) {
    await this.ready;
    const record = recordFromJob(job);
    if (!record || this.recordedIds.has(record.id)) return null;
    this.recordedIds.add(record.id);
    this.records.unshift(record);
    if (this.records.length > this.maxRecords) this.records.length = this.maxRecords;
    this.#schedulePersist();
    return clone(record);
  }

  // Feed a queue snapshot: every terminal job in it is recorded exactly
  // once. Returns the records this snapshot added.
  async observeSnapshot(snapshot) {
    await this.ready;
    const added = [];
    for (const job of Array.isArray(snapshot?.jobs) ? snapshot.jobs : []) {
      const record = await this.recordJob(job);
      if (record) added.push(record);
    }
    return added;
  }

  async list(filter = {}) {
    await this.ready;
    const { status, provider, mediaType, search } = filter || {};
    const needle = typeof search === "string" && search ? search.toLowerCase() : null;
    return clone(this.records.filter(record => {
      if (status && record.status !== status) return false;
      if (provider && record.provider !== provider) return false;
      if (mediaType && record.mediaType !== mediaType) return false;
      if (needle && !`${record.prompt || ""}\n${record.label || ""}`.toLowerCase().includes(needle)) return false;
      return true;
    }));
  }

  async get(id) {
    await this.ready;
    const record = this.records.find(item => item.id === String(id));
    return record ? clone(record) : null;
  }

  async remove(id) {
    await this.ready;
    const index = this.records.findIndex(item => item.id === String(id));
    if (index < 0) return false;
    this.records.splice(index, 1);
    this.#schedulePersist();
    return true;
  }

  async clear() {
    await this.ready;
    this.records = [];
    this.#schedulePersist();
  }
}
