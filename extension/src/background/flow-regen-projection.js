// FEAT-12 — Regenerate-in-place: slot lineage + projection.
//
// Logic (implemented fresh from the reference's TrackerRegenProjection
// design, not its code): regenerating one item does NOT create an
// unrelated new job. The new attempt carries a lineage pointer to the
// original item — the root — and every surface that displays queue work
// folds all attempts of a slot into ONE display slot:
//
//   - the newest attempt (by creation time) wins the slot;
//   - the owning scope's status/counts are recomputed from slot winners
//     only: any active winner -> running (paused when the queue is
//     paused); otherwise stopped > failed > completed precedence;
//   - a regen attempt whose live snapshot disappears (it was active in
//     the previous projection and is simply gone from the next one)
//     projects as failed with recovery exhausted — it never stays
//     "running" forever and the slot never silently reverts to the
//     stale result of an older attempt.
//
// The same module folds regen receipts back into a FEAT-02 batch run
// record: matched by tracker session (batch id) + owner job id + root
// item id, guarded by a seen-receipt set on the record, so folding the
// same receipt twice is a no-op and a partial item healed by a clean
// regen can complete its run.
//
// Everything here is pure: inputs are never mutated.

import { receiptFromJob, computeResumeIndexes } from "./flow-batch-runs.js";

const ACTIVE_STATUSES = new Set(["pending", "running", "waiting_for_user"]);
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

const clone = value => structuredClone(value);
const asObject = value => (value && typeof value === "object" && !Array.isArray(value) ? value : null);

export const REGEN_VANISHED_ERROR = "The regeneration attempt disappeared before it finished; recovery is exhausted.";

function toJobMap(jobs) {
  if (jobs instanceof Map) return jobs;
  const map = new Map();
  if (Array.isArray(jobs)) {
    for (const job of jobs) if (job && typeof job.id === "string") map.set(job.id, job);
  } else if (asObject(jobs)) {
    for (const [id, job] of Object.entries(jobs)) if (job && typeof job === "object") map.set(id, job);
  }
  return map;
}

const lineageOf = job => {
  const regen = asObject(job?.metadata?.regen);
  if (regen && typeof regen.rootJobId === "string" && regen.rootJobId) return regen;
  return null;
};

// The root job id of a job's slot: the job itself when it carries no
// lineage, otherwise the root recorded in its regen stamp — resolved
// through the chain when only the raw regenOf pointer is present.
export function regenRootJobId(job, jobs) {
  if (!job || typeof job.id !== "string") return null;
  const byId = toJobMap(jobs);
  const stamped = lineageOf(job);
  if (stamped) return stamped.rootJobId;
  let current = job;
  const seen = new Set([current.id]);
  while (typeof current?.metadata?.regenOf === "string" && current.metadata.regenOf) {
    const parent = byId.get(current.metadata.regenOf);
    if (!parent || seen.has(parent.id)) break;
    const parentStamp = lineageOf(parent);
    if (parentStamp) return parentStamp.rootJobId;
    seen.add(parent.id);
    current = parent;
  }
  return current?.id || job.id;
}

// A slot is one logical item. Batch items are identified by the batch
// session + index (the root attempt's coordinates); a standalone job is
// its own slot, keyed by the root job id.
export function regenSlotKey(job, jobs) {
  if (!job || typeof job.id !== "string") return null;
  const stamped = lineageOf(job);
  if (stamped && typeof stamped.slotKey === "string" && stamped.slotKey) return stamped.slotKey;
  const byId = toJobMap(jobs);
  const rootId = regenRootJobId(job, jobs);
  const root = byId.get(rootId) || job;
  const batchId = typeof root?.batch?.batchId === "string" ? root.batch.batchId : null;
  const batchIndex = Number.isInteger(root?.batch?.batchIndex) ? root.batch.batchIndex : null;
  if (batchId && batchIndex !== null) return `batch:${batchId}:${batchIndex}`;
  return `job:${rootId}`;
}

// Build the canonical lineage metadata for a new attempt of `targetJob`.
// Returns a NEW metadata object (the input is not mutated) carrying both
// the raw pointer (regenOf = the attempt the user acted on) and the
// resolved stamp (regen = { rootJobId, slotKey, attempt }), or null when
// there is no target to regenerate.
export function stampRegenLineage(metadata, targetJob, jobs) {
  if (!targetJob || typeof targetJob.id !== "string" || !targetJob.id) return null;
  const pool = Array.isArray(jobs) ? [...jobs] : [];
  if (!pool.some(job => job?.id === targetJob.id)) pool.push(targetJob);
  const rootJobId = regenRootJobId(targetJob, pool);
  const byId = toJobMap(pool);
  const root = byId.get(rootJobId) || targetJob;
  const batchId = typeof root?.batch?.batchId === "string" ? root.batch.batchId : null;
  const batchIndex = Number.isInteger(root?.batch?.batchIndex) ? root.batch.batchIndex : null;
  const slotKey = batchId && batchIndex !== null ? `batch:${batchId}:${batchIndex}` : `job:${rootJobId}`;
  const attempt = pool.filter(job => regenSlotKey(job, pool) === slotKey).length + 1;
  return {
    ...(asObject(metadata) ? clone(metadata) : {}),
    regenOf: targetJob.id,
    regen: { rootJobId, slotKey, attempt },
  };
}

const isActiveStatus = status => ACTIVE_STATUSES.has(String(status || ""));
const isRegenAttempt = job => Boolean(lineageOf(job)) || (typeof job?.metadata?.regenOf === "string" && Boolean(job.metadata.regenOf));

// Fold a queue job list into display slots. `previousSlots` (the prior
// projection, when the caller keeps one) is what makes a disappeared
// regen attempt visible: an active regen winner that is simply absent
// from the current list — and not superseded by a newer attempt of the
// same slot — projects as a failed ghost with recovery exhausted.
export function projectRegenSlots(jobs, previousSlots = []) {
  const list = (Array.isArray(jobs) ? jobs : []).filter(job => job && typeof job.id === "string");
  const byId = toJobMap(list);
  const groups = new Map();
  list.forEach((job, index) => {
    const slotKey = regenSlotKey(job, byId);
    if (!slotKey) return;
    if (!groups.has(slotKey)) groups.set(slotKey, []);
    groups.get(slotKey).push({ job, index });
  });
  const slots = [];
  for (const [slotKey, entries] of groups) {
    const attempts = [...entries].sort((a, b) =>
      (Number(a.job.addedAt) || 0) - (Number(b.job.addedAt) || 0) || a.index - b.index);
    const winnerEntry = attempts[attempts.length - 1];
    const winner = winnerEntry.job;
    const rootJobId = regenRootJobId(winner, byId);
    slots.push({
      slotKey,
      rootJobId,
      batchId: typeof winner.batch?.batchId === "string" ? winner.batch.batchId : null,
      batchIndex: Number.isInteger(winner.batch?.batchIndex) ? winner.batch.batchIndex : null,
      attemptCount: attempts.length,
      attemptIds: attempts.map(entry => entry.job.id),
      winner: clone(winner),
      status: String(winner.status || "pending"),
      recoveryExhausted: false,
      _winnerIndex: winnerEntry.index,
    });
  }
  slots.sort((a, b) => a._winnerIndex - b._winnerIndex);

  // Ghost pass: a previously-active regen winner that vanished.
  const currentIds = new Set(list.map(job => job.id));
  for (const previous of Array.isArray(previousSlots) ? previousSlots : []) {
    const prevWinner = previous?.winner;
    if (!prevWinner || typeof prevWinner.id !== "string") continue;
    if (!isRegenAttempt(prevWinner) || !isActiveStatus(prevWinner.status)) continue;
    if (currentIds.has(prevWinner.id)) continue;
    const existing = slots.find(slot => slot.slotKey === previous.slotKey);
    if (existing && (Number(existing.winner.addedAt) || 0) >= (Number(prevWinner.addedAt) || 0)) continue;
    const ghostWinner = clone(prevWinner);
    ghostWinner.status = "failed";
    ghostWinner.error = typeof ghostWinner.error === "string" && ghostWinner.error ? ghostWinner.error : REGEN_VANISHED_ERROR;
    ghostWinner.errorCode = typeof ghostWinner.errorCode === "string" && ghostWinner.errorCode
      ? ghostWinner.errorCode
      : "FLOW_REGEN_RECOVERY_EXHAUSTED";
    const ghost = {
      slotKey: previous.slotKey,
      rootJobId: previous.rootJobId || regenRootJobId(prevWinner, byId),
      batchId: typeof prevWinner.batch?.batchId === "string" ? prevWinner.batch.batchId : null,
      batchIndex: Number.isInteger(prevWinner.batch?.batchIndex) ? prevWinner.batch.batchIndex : null,
      attemptCount: Math.max(existing?.attemptCount || 0, previous.attemptCount || 0),
      attemptIds: [...new Set([...(existing?.attemptIds || []), ...(previous.attemptIds || [prevWinner.id])])],
      winner: ghostWinner,
      status: "failed",
      recoveryExhausted: true,
      _winnerIndex: existing?._winnerIndex ?? Number.MAX_SAFE_INTEGER,
    };
    if (existing) slots[slots.indexOf(existing)] = ghost;
    else slots.push(ghost);
  }
  for (const slot of slots) delete slot._winnerIndex;
  return slots;
}

// Recompute the owning scope's status/counts from slot winners only.
// Precedence: any active winner -> running (paused when the caller says
// the queue is paused); otherwise stopped > failed > completed.
export function computeSlotAggregate(slots, { paused = false } = {}) {
  const list = Array.isArray(slots) ? slots : [];
  const counts = { total: list.length, completed: 0, failed: 0, cancelled: 0, active: 0 };
  for (const slot of list) {
    const status = String(slot?.status || slot?.winner?.status || "");
    if (status === "completed") counts.completed += 1;
    else if (status === "failed") counts.failed += 1;
    else if (status === "cancelled") counts.cancelled += 1;
    else if (isActiveStatus(status)) counts.active += 1;
  }
  let status;
  if (counts.active > 0) status = paused ? "paused" : "running";
  else if (counts.cancelled > 0) status = "stopped";
  else if (counts.failed > 0) status = "failed";
  else if (counts.total > 0) status = "completed";
  else status = "idle";
  return { status, ...counts };
}

// The durable identity of one terminal attempt's receipt. Folding is
// idempotent because the batch record keeps the set of these ids.
export function regenReceiptId(job) {
  const receipt = receiptFromJob(job);
  if (!receipt || !Number.isFinite(receipt.finishedAt)) return null;
  return `${job.id}:${receipt.finishedAt}`;
}

// Fold one finished regen attempt's receipt into a FEAT-02 batch run
// record. Match discipline (all three must agree): the tracker session
// (the job's batch id is the run's batch id), the owner job id (the run
// item admitted under a runtime job id) and the root item id (the
// attempt's lineage root IS that runtime job id). Pure: returns a new
// record; a duplicate receipt changes nothing.
export function foldRegenReceiptIntoRun(run, job) {
  const unchanged = { run, changed: false, receiptId: null };
  if (!asObject(run) || !job || typeof job !== "object") return unchanged;
  const receiptId = regenReceiptId(job);
  if (!receiptId) return unchanged;
  const rootJobId = lineageOf(job)?.rootJobId || (typeof job.metadata?.regenOf === "string" ? regenRootJobId(job, [job]) : null);
  if (!rootJobId) return unchanged;
  const sessionId = typeof job.batch?.batchId === "string" ? job.batch.batchId : null;
  if (!sessionId || !run.batchId || sessionId !== run.batchId) return unchanged;
  const seen = Array.isArray(run.regenReceiptIds) ? run.regenReceiptIds : [];
  if (seen.includes(receiptId)) return { run, changed: false, receiptId };
  const item = (Array.isArray(run.items) ? run.items : []).find(candidate =>
    candidate && !candidate.hidden && candidate.runtimeJobId === rootJobId);
  if (!item) return unchanged;
  const receipt = receiptFromJob(job);
  if (!receipt) return unchanged;
  const next = clone(run);
  const nextItem = next.items.find(candidate => candidate.index === item.index);
  nextItem.receipt = receipt;
  next.regenReceiptIds = [...seen, receiptId];
  next.resumeIndexes = computeResumeIndexes(next);
  return { run: next, changed: true, receiptId };
}

export { ACTIVE_STATUSES as REGEN_ACTIVE_STATUSES, TERMINAL_STATUSES as REGEN_TERMINAL_STATUSES };
