// Pre-generation reference revalidation for queued Flow jobs (IMG-04).
//
// Logic (adapted from the reference extension's behavior 22, not its
// code): references are resolved when a job is created, but a queued job
// may run much later — a referenced library tile can have been deleted in
// the meantime, or an uploaded asset can have vanished when the project
// changed. At job start this pass revalidates every reference: the IMG-03
// media catalog is consulted first, then a targeted existence check for
// that specific asset. A missing LIBRARY ref fails fast with
// FLOW_QUEUE_PREFLIGHT_REFERENCE_MISSING before any settings/prompt work.
// An UPLOADED ref (the catalog carries upload provenance for it) whose
// bytes are still retained is re-uploaded instead, and the attachment's
// expectedId is rewritten to the new asset so the submit path uses it.
//
// The failure is deliberately not retryable: a missing library ref is a
// user-action problem, and replaying the job would hit the same missing
// ref. If an uploaded ref's bytes are no longer retained it is treated
// exactly like a missing library ref — never guessed, never substituted.
//
// The pass is dependency-injected (catalog lookup, existence check,
// re-upload) so it is unit-testable without a browser. The queue wiring
// (flow-job-queue.js) runs it at job start when a pass is configured, and
// the content-side submit stage runs the same contract against the live
// page (generation-operations.js), where the real dependencies live.

export const FLOW_REF_PREFLIGHT_MISSING_CODE = "FLOW_QUEUE_PREFLIGHT_REFERENCE_MISSING";

const clone = value => structuredClone(value);

const cleanAssetName = value => typeof value === "string" ? value.replace(/^asset:/i, "").trim() : "";

// Collect the references a generation payload will attach. Each ref
// carries a rewrite target: the payload object the submit path reads, so
// a re-upload can replace its expectedId in place. Staged local
// attachments (transferId) are skipped — they carry their own bytes into
// the submit and are uploaded there; there is no library asset to
// revalidate. String entries are name-only refs: they can fail the pass
// but have nothing to rewrite.
function collectReferences(payload) {
  const refs = [];
  const pushValue = (value, slot) => {
    if (typeof value === "string") {
      const assetName = cleanAssetName(value);
      if (assetName) refs.push({ slot, target: null, assetName, expectedId: undefined, kind: undefined });
      return;
    }
    if (!value || typeof value !== "object") return;
    if (typeof value.transferId === "string") return;
    const assetName = cleanAssetName(value.assetName);
    if (!assetName) return;
    refs.push({
      slot,
      target: value,
      assetName,
      expectedId: typeof value.expectedId === "string" && value.expectedId ? value.expectedId : undefined,
      kind: typeof value.kind === "string" && value.kind ? value.kind : undefined,
    });
  };
  const attachments = Array.isArray(payload?.attachments) ? payload.attachments : [];
  attachments.forEach((item, index) => pushValue(item, `attachments[${index}]`));
  pushValue(payload?.firstFrame, "firstFrame");
  pushValue(payload?.lastFrame, "lastFrame");
  return refs;
}

export function refPreflightError(missing) {
  const names = missing.map(item => item.assetName).join(", ");
  const error = new Error(
    `Flow reference${missing.length === 1 ? "" : "s"} missing before generation: ${names}. ` +
    "The referenced asset is no longer in the Flow project library, and no retained upload bytes are available to restore it. " +
    "Re-attach the reference or remove it from the job; nothing was submitted.",
  );
  error.code = FLOW_REF_PREFLIGHT_MISSING_CODE;
  error.retryable = false;
  error.outcomeUnknown = false;
  error.diagnostics = {
    missingReferences: missing.map(item => ({
      slot: item.slot,
      assetName: item.assetName,
      expectedId: item.expectedId ?? null,
      kind: item.kind ?? null,
      uploaded: item.uploaded === true,
    })),
  };
  return error;
}

// Revalidate one generation job's references. Returns { job, reuploaded }
// with a cloned job whose payload carries any rewritten expectedIds.
// Throws refPreflightError when a ref is missing and cannot be restored.
// Non-generation operations and jobs without references pass through
// untouched (the dependencies are never consulted for them).
// Contract note (review round 2 S4 / round 3 S4): assetExists is the
// authority — the catalog lookup only supplies provenance. A caller that
// cannot prove absence (the service worker has no DOM to scan, and the
// catalog never records library picks) must pass assetExists through as
// true and let the content-side revalidation at submit decide; failing
// on a catalog miss would false-fail legitimate library-picked jobs.
export async function revalidateJobReferences(job, deps = {}) {
  const { catalogLookup, assetExists, reupload } = deps || {};
  if (typeof catalogLookup !== "function" || typeof assetExists !== "function" || typeof reupload !== "function") {
    throw new TypeError("revalidateJobReferences requires catalogLookup, assetExists, and reupload dependency functions.");
  }
  const updated = clone(job ?? {});
  if (updated.operation !== "flow.generation.submit") return { job: updated, reuploaded: [] };
  const payload = updated.payload && typeof updated.payload === "object" ? updated.payload : {};
  updated.payload = payload;
  const refs = collectReferences(payload);
  if (!refs.length) return { job: updated, reuploaded: [] };
  const reuploaded = [];
  const missing = [];
  for (const ref of refs) {
    const descriptor = { slot: ref.slot, assetName: ref.assetName, expectedId: ref.expectedId, kind: ref.kind };
    // Catalog first: it answers from storage, before any DOM existence
    // scan, and its upload provenance decides whether recovery is even
    // possible for a missing asset.
    const entry = await catalogLookup(descriptor);
    const exists = await assetExists({ ...descriptor, entry: entry ?? null });
    if (exists) continue;
    const uploaded = typeof entry?.uploadName === "string" && entry.uploadName.length > 0;
    if (uploaded) {
      const receipt = await reupload({ ...descriptor, entry });
      const newId = typeof receipt?.id === "string" && receipt.id ? receipt.id : null;
      if (newId) {
        if (ref.target) ref.target.expectedId = newId;
        reuploaded.push({ slot: ref.slot, assetName: ref.assetName, previousExpectedId: ref.expectedId ?? null, expectedId: newId });
        continue;
      }
    }
    missing.push({ ...descriptor, uploaded });
  }
  if (missing.length) throw refPreflightError(missing);
  return { job: updated, reuploaded };
}
