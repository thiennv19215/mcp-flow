// Persistent batch run records + per-item resume (FEAT-02).
//
// Logic (adapted from the reference extension's batch-run design, not
// its code): a draft is the reusable template; a RUN is one execution of
// it. Where the drafts store keeps the inputs, the run store keeps the
// execution truth — the ordered items with their settings inputs, the
// batch ref pool, a revision counter, the runtime job id each item was
// admitted under (index-aligned), the terminal receipt each runtime job
// produced, the execution segments (the initial admission plus one per
// resume), and the list of indexes still unfinished.
//
// A serialized scheduler folds queue snapshots into receipts: the queue
// already emits a snapshot on every transition, and the fold matches
// jobs to items by runtime job id — never by position, because a resume
// segment's batch indexes restart at zero while the run indexes do not.
// When every admitted item carries a terminal receipt the run finalizes:
//
//   completed     — every receipt is a clean completion
//   failed        — no receipt completed at all
//   needs_review  — anything in between, including a VID-01 partial (a
//                   job that completed with failed outputs): some of the
//                   work product is missing, so a human decides whether
//                   to resume instead of the run claiming success.
//
// Resume re-admits only the unfinished indexes. The receipts of the
// finished indexes are kept verbatim and the finalize after the resume
// segment merges old and new receipts into one state. A superseded
// receipt moves onto its segment record, so the audit trail survives.
//
// The receipt fold is a pure, exported helper on purpose: FEAT-05 task
// lists write their results back through the very same fold.

import { foldRegenReceiptIntoRun } from "./flow-regen-projection.js";
//
// Concurrency discipline mirrors the sibling stores: mutations are
// guarded by the revision counter (a claim must name the revision it
// read), at most one run may be active at a time (the scheduler
// invariant the queue's serial drain relies on), snapshot folds are
// serialized through a promise chain, and persistence is a batched
// write chain whose failures degrade to in-memory state rather than
// breaking the queue path that feeds it.

const STORAGE_KEY = "flowMcpBatchRunsV1";
const MAX_RUN_ITEMS = 100;
const MAX_RUNS = 50;
const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "cancelled"]);

const clone = value => structuredClone(value);
const asObject = value => (value && typeof value === "object" && !Array.isArray(value) ? value : null);

const runError = (message, code) => Object.assign(new Error(message), { code });

// --- receipts ---------------------------------------------------------------

function mediaListFromResult(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 4) return [];
  if (Array.isArray(value.media)) return value.media;
  if (value.portraitMedia && typeof value.portraitMedia === "object") return [value.portraitMedia];
  if (value.result && typeof value.result === "object") return mediaListFromResult(value.result, depth + 1);
  return [];
}

// Same discipline as the history module's normalization: checkpoint media
// wins over the runner result, and only id / title / kind are kept.
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

// Derive the terminal receipt for one finished queue job, or null when
// the job is not terminal. A receipt is the run's durable proof of what
// one admitted item actually did.
export function receiptFromJob(job) {
  if (!job || typeof job !== "object" || typeof job.id !== "string" || !job.id) return null;
  if (!TERMINAL_JOB_STATUSES.has(job.status)) return null;
  const checkpoint = asObject(job.metadata?.generationResultCheckpoint);
  const results = normalizeMedia(checkpoint?.media?.length ? checkpoint.media : mediaListFromResult(job.result));
  const failedOutputs = normalizeFailedOutputs(
    checkpoint?.failedOutputs ?? job.failedOutputs ?? job.result?.result?.failedOutputs ?? job.result?.failedOutputs,
  );
  return {
    status: job.status,
    jobId: job.id,
    finishedAt: Number.isFinite(job.finishedAt) ? job.finishedAt : null,
    results,
    failedOutputs,
    partial: job.status === "completed" && (job.partial === true || failedOutputs.length > 0),
    error: job.error ? String(job.error).slice(0, 2000) : null,
    errorCode: job.errorCode ? String(job.errorCode) : null,
  };
}

const isCleanCompletion = receipt => Boolean(receipt) && receipt.status === "completed" && receipt.partial !== true;

// Indexes that still need work: admitted items without a clean
// completion, excluding the ones currently in flight in the latest
// segment of an active run (they are being worked on, not waiting to be
// resumed).
export function computeResumeIndexes(run) {
  const items = Array.isArray(run?.items) ? run.items : [];
  const inFlight = new Set(
    run?.state === "active" && Array.isArray(run.segments) && run.segments.length
      ? run.segments[run.segments.length - 1].indexes || []
      : [],
  );
  const indexes = [];
  for (const item of items) {
    if (!item || item.hidden) continue;
    if (inFlight.has(item.index)) continue;
    if (!isCleanCompletion(item.receipt)) indexes.push(item.index);
  }
  return indexes;
}

// The finalize state for a run, or null while any admitted item is still
// unfinished. Hidden items never ran and never block finalizing.
export function computeFinalizeState(run) {
  const items = (Array.isArray(run?.items) ? run.items : []).filter(item => item && !item.hidden);
  if (!items.length) return null;
  if (items.some(item => !item.receipt)) return null;
  if (items.every(item => isCleanCompletion(item.receipt))) return "completed";
  if (!items.some(item => item.receipt.status === "completed")) return "failed";
  return "needs_review";
}

// Fold one queue snapshot into a run record. Pure: the input run is not
// mutated. Jobs match items by runtime job id (the index-aligned
// admission mapping); when the job carries batch info and the run has a
// current segment batch, the batch ids must also agree — a job from a
// different execution can never write a receipt here.
export function foldQueueSnapshotIntoRun(run, snapshot) {
  const next = clone(run);
  const jobs = Array.isArray(snapshot?.jobs) ? snapshot.jobs : [];
  const byId = new Map();
  for (const job of jobs) {
    if (job && typeof job.id === "string" && !byId.has(job.id)) byId.set(job.id, job);
  }
  const updatedIndexes = [];
  for (const item of Array.isArray(next?.items) ? next.items : []) {
    if (!item || item.hidden || !item.runtimeJobId) continue;
    const job = byId.get(item.runtimeJobId);
    if (!job) continue;
    const jobBatchId = typeof job.batch?.batchId === "string" ? job.batch.batchId : null;
    if (jobBatchId && next.batchId && jobBatchId !== next.batchId) continue;
    const receipt = receiptFromJob(job);
    if (!receipt) continue;
    if (JSON.stringify(item.receipt) !== JSON.stringify(receipt)) {
      item.receipt = receipt;
      updatedIndexes.push(item.index);
    }
  }
  if (updatedIndexes.length) next.resumeIndexes = computeResumeIndexes(next);
  return {
    run: next,
    changed: updatedIndexes.length > 0,
    updatedIndexes,
    allTerminal: computeFinalizeState(next) !== null,
  };
}

// --- store ------------------------------------------------------------------

export class FlowBatchRuns {
  constructor({ storage = globalThis.chrome?.storage?.local, storageKey = STORAGE_KEY, maxRuns = MAX_RUNS } = {}) {
    if (!storage?.get || !storage?.set) throw new TypeError("FlowBatchRuns requires chrome.storage.local or a compatible storage adapter.");
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
          .filter(run => run && typeof run.id === "string" && Array.isArray(run.items))
          .slice(0, this.maxRuns)
          .map(run => clone(run));
      }
    } catch {
      // A corrupt or unavailable store must not wedge run tracking
      // behind a rejected ready promise; start empty instead.
      this.runs = [];
    }
    return clone(this.runs);
  }

  // Batched writes, same discipline as the history store: the snapshot
  // is taken when the chained write actually runs, so a burst of folds
  // coalesces into one storage write of the freshest state, and a failed
  // write degrades to in-memory-only rather than failing the queue path.
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

  #activeRun() {
    return this.runs.find(run => run.state === "active") || null;
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

  // A draft run becomes a persistent record. Items carry the job inputs
  // exactly as composed (the settings snapshot, one per item); the batch
  // ref pool and any batch-level settings ride along verbatim.
  async create({ draftId = null, label, items, refPool = [], settings = null } = {}) {
    await this.ready;
    if (!Array.isArray(items) || items.length < 1 || items.length > MAX_RUN_ITEMS) {
      throw runError(`A batch run must contain between 1 and ${MAX_RUN_ITEMS} items.`, "FLOW_BATCH_RUN_SIZE_INVALID");
    }
    for (const item of items) {
      if (!item || typeof item.operation !== "string" || !item.operation) {
        throw runError("Every batch run item needs an operation.", "FLOW_BATCH_RUN_ITEM_INVALID");
      }
    }
    const now = Date.now();
    const run = {
      id: crypto.randomUUID(),
      version: 1,
      draftId: typeof draftId === "string" && draftId ? draftId : null,
      label: String(label || "Batch Flow").trim().slice(0, 160) || "Batch Flow",
      settings: asObject(settings) ? clone(settings) : null,
      refPool: Array.isArray(refPool) ? clone(refPool) : [],
      items: items.map((item, index) => {
        const { hidden, ...input } = item;
        return { index, input: clone(input), hidden: hidden === true, runtimeJobId: null, receipt: null };
      }),
      revision: 0,
      state: "created",
      finalizeState: null,
      batchId: null,
      segments: [],
      resumeIndexes: [],
      createdAt: now,
      updatedAt: now,
      claimedAt: null,
      finalizedAt: null,
      pendingClaim: null,
    };
    this.runs.unshift(run);
    // Cap the store, evicting the oldest finished runs first — the
    // active run and fresh records are never evicted from under the
    // scheduler.
    while (this.runs.length > this.maxRuns) {
      const evictAt = this.runs.findLastIndex(candidate => candidate.id !== run.id && candidate.state !== "active");
      if (evictAt < 0) break;
      this.runs.splice(evictAt, 1);
    }
    this.#schedulePersist();
    return clone(run);
  }

  // The scheduler claim: exactly one run may be active at a time, and the
  // caller must name the revision it read, so two panels racing to start
  // batches cannot both win. Returns the indexes to admit, in order.
  async claim(id, expectedRevision) {
    await this.ready;
    const run = this.#find(id);
    if (!run) throw runError(`No batch run with id ${id}.`, "FLOW_BATCH_RUN_NOT_FOUND");
    if (expectedRevision !== undefined && expectedRevision !== null && Number(expectedRevision) !== run.revision) {
      throw runError(`Batch run ${run.id} is at revision ${run.revision}, not ${expectedRevision}.`, "FLOW_BATCH_RUN_REVISION_MISMATCH");
    }
    if (run.state !== "created") {
      throw runError(`Batch run ${run.id} cannot be claimed from state ${run.state}.`, "FLOW_BATCH_RUN_NOT_CLAIMABLE");
    }
    const active = this.#activeRun();
    if (active && active.id !== run.id) {
      throw runError(`Batch run ${active.id} is already active.`, "FLOW_BATCH_RUN_CLAIM_CONFLICT");
    }
    run.state = "active";
    run.claimedAt = Date.now();
    run.updatedAt = Date.now();
    run.revision += 1;
    run.pendingClaim = { kind: "initial", segmentCount: run.segments.length };
    this.#schedulePersist();
    return { run: clone(run), indexes: run.items.filter(item => !item.hidden).map(item => item.index) };
  }

  // Write the index-aligned admission mapping for one execution segment:
  // which runtime job id now owns each item index. A resume segment
  // supersedes the receipts of the indexes it re-admits — the old
  // receipts move onto the segment so finalize can merge the kept
  // receipts with the new ones and the audit trail survives.
  async recordAdmission(id, { batchId = null, kind, mapping } = {}) {
    await this.ready;
    const run = this.#find(id);
    if (!run) throw runError(`No batch run with id ${id}.`, "FLOW_BATCH_RUN_NOT_FOUND");
    if (run.state !== "active") {
      throw runError(`Batch run ${run.id} is not active.`, "FLOW_BATCH_RUN_NOT_ACTIVE");
    }
    if (!Array.isArray(mapping) || mapping.length < 1) {
      throw runError("An admission mapping must name at least one item.", "FLOW_BATCH_RUN_ADMISSION_INVALID");
    }
    const seenIndexes = new Set();
    const seenJobIds = new Set();
    for (const entry of mapping) {
      const index = Number(entry?.index);
      const jobId = typeof entry?.jobId === "string" ? entry.jobId : "";
      const item = Number.isInteger(index) ? run.items[index] : null;
      if (!item || item.index !== index || item.hidden || !jobId || seenIndexes.has(index) || seenJobIds.has(jobId)) {
        throw runError("The admission mapping is not index-aligned with the run items.", "FLOW_BATCH_RUN_ADMISSION_INVALID");
      }
      seenIndexes.add(index);
      seenJobIds.add(jobId);
    }
    const segmentKind = kind === "resume" ? "resume" : "initial";
    const segment = {
      batchId: typeof batchId === "string" && batchId ? batchId : null,
      kind: segmentKind,
      indexes: [...seenIndexes].sort((a, b) => a - b),
      admittedAt: Date.now(),
    };
    if (segmentKind === "resume") {
      const superseded = {};
      for (const index of segment.indexes) {
        const item = run.items[index];
        if (item.receipt) superseded[index] = item.receipt;
        item.receipt = null;
      }
      if (Object.keys(superseded).length) segment.supersededReceipts = superseded;
    }
    for (const entry of mapping) run.items[Number(entry.index)].runtimeJobId = entry.jobId;
    run.segments.push(segment);
    run.batchId = segment.batchId;
    run.pendingClaim = null;
    run.updatedAt = Date.now();
    run.revision += 1;
    run.resumeIndexes = computeResumeIndexes(run);
    this.#schedulePersist();
    return clone(run);
  }

  // Scheduler entry point: fold one queue snapshot into the active run.
  // Folds are serialized — queue snapshots arrive on every transition
  // and must never interleave mutations of the same record. When the
  // fold completes the run, the finalize state is computed in the same
  // step. Returns null when no run is active.
  observeSnapshot(snapshot) {
    const task = this.foldChain.catch(() => {}).then(() => this.#foldSnapshot(snapshot));
    this.foldChain = task.catch(() => {});
    return task;
  }

  async #foldSnapshot(snapshot) {
    await this.ready;
    const run = this.#activeRun();
    if (!run) return null;
    const folded = foldQueueSnapshotIntoRun(run, snapshot);
    if (folded.changed) {
      run.items = folded.run.items;
      run.resumeIndexes = folded.run.resumeIndexes;
      run.updatedAt = Date.now();
    }
    let finalizeState = null;
    if (folded.allTerminal) {
      finalizeState = computeFinalizeState(run);
      run.state = "finalized";
      run.finalizeState = finalizeState;
      run.finalizedAt = Date.now();
      run.updatedAt = Date.now();
      run.revision += 1;
      run.resumeIndexes = computeResumeIndexes(run);
    }
    if (folded.changed || finalizeState) this.#schedulePersist();
    return { run: clone(run), changed: folded.changed, updatedIndexes: folded.updatedIndexes, finalizeState };
  }

  // FEAT-12b: fold regen receipts into runs that already finalized.
  // Regenerating an item happens after its run closed, so the snapshot
  // fold above (which owns the ACTIVE run, whose root jobs still ride
  // the snapshot) can never land a regen receipt: the attempt is a new
  // queue job whose id matches no run item. This pass runs over the
  // same snapshot stream, serialized through the same fold chain, and
  // applies the pure FEAT-12 fold to every non-active run; the helper
  // itself enforces the match discipline (tracker session = the run's
  // batch id, owner job id, root item id) and the seen-receipt set, so
  // re-folding a snapshot is a no-op. A folded receipt rewrites the
  // finalize verdict from the receipts as they now stand — a partial
  // item healed by a clean regen completes its run. Returns one entry
  // per run that changed.
  foldRegenReceipts(snapshot) {
    const task = this.foldChain.catch(() => {}).then(() => this.#foldRegenReceipts(snapshot));
    this.foldChain = task.catch(() => {});
    return task;
  }

  async #foldRegenReceipts(snapshot) {
    await this.ready;
    const jobs = Array.isArray(snapshot?.jobs) ? snapshot.jobs : [];
    if (!jobs.length) return [];
    const results = [];
    for (const run of this.runs) {
      if (run.state === "active" || !run.batchId) continue;
      let current = run;
      let changed = false;
      for (const job of jobs) {
        const folded = foldRegenReceiptIntoRun(current, job);
        if (folded.changed) {
          current = folded.run;
          changed = true;
        }
      }
      if (!changed) continue;
      run.items = current.items;
      run.regenReceiptIds = current.regenReceiptIds;
      run.resumeIndexes = current.resumeIndexes;
      run.updatedAt = Date.now();
      const finalizeState = computeFinalizeState(run);
      if (finalizeState && finalizeState !== run.finalizeState) {
        run.finalizeState = finalizeState;
        run.finalizedAt = Date.now();
        run.revision += 1;
      }
      this.#schedulePersist();
      results.push({ runId: run.id, finalizeState: run.finalizeState });
    }
    return results;
  }

  // Explicit finalize for a run whose receipts are all terminal (the
  // fold path finalizes automatically; this is the same computation for
  // callers holding a run the queue no longer reports on).
  async finalize(id) {
    await this.ready;
    const run = this.#find(id);
    if (!run) throw runError(`No batch run with id ${id}.`, "FLOW_BATCH_RUN_NOT_FOUND");
    if (run.state === "finalized") return clone(run);
    const finalizeState = computeFinalizeState(run);
    if (!finalizeState) {
      throw runError(`Batch run ${run.id} still has unfinished items.`, "FLOW_BATCH_RUN_NOT_FINISHED");
    }
    run.state = "finalized";
    run.finalizeState = finalizeState;
    run.finalizedAt = Date.now();
    run.updatedAt = Date.now();
    run.revision += 1;
    run.resumeIndexes = computeResumeIndexes(run);
    this.#schedulePersist();
    return clone(run);
  }

  // Claim a finalized run for a resume segment. Only unfinished indexes
  // may be named (or the stored resume list is used); the returned jobs
  // are the stored item inputs for exactly those indexes, in order — the
  // caller materializes fresh runtime ids from them.
  async resume(id, { indexes, expectedRevision } = {}) {
    await this.ready;
    const run = this.#find(id);
    if (!run) throw runError(`No batch run with id ${id}.`, "FLOW_BATCH_RUN_NOT_FOUND");
    if (expectedRevision !== undefined && expectedRevision !== null && Number(expectedRevision) !== run.revision) {
      throw runError(`Batch run ${run.id} is at revision ${run.revision}, not ${expectedRevision}.`, "FLOW_BATCH_RUN_REVISION_MISMATCH");
    }
    if (run.state !== "finalized") {
      throw runError(`Batch run ${run.id} cannot be resumed from state ${run.state}.`, "FLOW_BATCH_RUN_NOT_RESUMABLE");
    }
    const active = this.#activeRun();
    if (active && active.id !== run.id) {
      throw runError(`Batch run ${active.id} is already active.`, "FLOW_BATCH_RUN_CLAIM_CONFLICT");
    }
    const targets = indexes === undefined ? [...run.resumeIndexes] : [...indexes];
    if (!targets.length) {
      throw runError(`Batch run ${run.id} has no unfinished items to resume.`, "FLOW_BATCH_RUN_RESUME_INDEX_INVALID");
    }
    const seen = new Set();
    for (const index of targets) {
      const item = Number.isInteger(index) ? run.items[index] : null;
      if (!item || item.index !== index || item.hidden || seen.has(index) || isCleanCompletion(item.receipt)) {
        throw runError(`Index ${index} is not a resumable item of batch run ${run.id}.`, "FLOW_BATCH_RUN_RESUME_INDEX_INVALID");
      }
      seen.add(index);
    }
    targets.sort((a, b) => a - b);
    run.state = "active";
    run.finalizeState = null;
    run.finalizedAt = null;
    run.claimedAt = Date.now();
    run.updatedAt = Date.now();
    run.revision += 1;
    run.pendingClaim = { kind: "resume", segmentCount: run.segments.length };
    run.resumeIndexes = computeResumeIndexes(run);
    this.#schedulePersist();
    return { run: clone(run), indexes: targets, jobs: targets.map(index => clone(run.items[index].input)) };
  }

  // Undo a claim (initial or resume) that never recorded an admission —
  // the failure path for an enqueue that threw after the claim, so the
  // run returns to exactly the state the claim found it in instead of
  // wedging the scheduler behind a phantom active batch.
  async releaseClaim(id) {
    await this.ready;
    const run = this.#find(id);
    if (!run) throw runError(`No batch run with id ${id}.`, "FLOW_BATCH_RUN_NOT_FOUND");
    if (run.state !== "active" || !run.pendingClaim || run.segments.length !== run.pendingClaim.segmentCount) {
      throw runError(`Batch run ${run.id} has no unadmitted claim to release.`, "FLOW_BATCH_RUN_NOT_RELEASABLE");
    }
    const wasResume = run.pendingClaim.kind === "resume";
    run.pendingClaim = null;
    run.claimedAt = null;
    run.updatedAt = Date.now();
    run.revision += 1;
    if (wasResume) {
      run.state = "finalized";
      run.finalizeState = computeFinalizeState(run);
      run.finalizedAt = Date.now();
    } else {
      run.state = "created";
    }
    run.resumeIndexes = computeResumeIndexes(run);
    this.#schedulePersist();
    return clone(run);
  }
}
