// Batch admission preflight for the Flow job queue.
//
// Logic (adapted from the reference extension's batch admission design, not
// its code): validate EVERY generation job in a submission against the
// local model capability registry before any of them is queued, and fail
// the submission atomically. Without this, a multi-prompt batch validates
// one job at a time at run time, so earlier prompts can spend Flow credits
// before a later prompt turns out to be impossible (wrong duration for the
// model, frames combined with ingredient references, too many references,
// a prompt over the configured length maximum).
//
// The checks are deliberately conservative: only fields a job actually
// specifies are validated, unknown models are left to the content-side
// capability check at run time, and a missing/unreadable registry skips
// preflight entirely instead of blocking the queue.
//
// FEAT-03 (per-item overrides + admission completion, adapted from the
// reference's batch admission design): a job may carry `payload.overrides`,
// a whitelisted subset of its own settings snapshot (the payload's fields,
// with `video_settings` as fallback — panel batches stamp one shared
// snapshot into every job, so the snapshot an override merges over is the
// job's own payload). Route-defining fields (media type, frames flag,
// input type) may be restated but never changed — an override that would
// move the item to a different generation route is a route conflict; the
// remaining whitelisted fields (model, ratio, quantity, duration,
// resolution) merge over the snapshot and the MERGED settings are what the
// registry checks below validate. The batch-level rules also live here:
// chain items run at quantity exactly 1; when a batch declares a ref pool
// (`refPool` on any job's payload or metadata) every referenced ref key
// must exist in it; and when a batch declares its pending-upload set
// (`pendingRefs`), that set must match the staged (transferId) references
// exactly. Two admission-adjacent rules are deliberately NOT checks in
// this module: uploading the pending set is an async side effect owned by
// the queue/service-worker admission layer (this module only verifies the
// declared set is exact), and target-project re-verification happens at
// run time in the runner/submit path, not at admission — this module's
// contract ends when the batch is admitted.

const GENERATION_OPERATION = "flow.generation.submit";

function normalizeModel(value) {
  return String(value || "").normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

function findModelRule(registry, model) {
  const normalized = normalizeModel(model);
  if (!normalized || !Array.isArray(registry?.models)) return null;
  // Prefer the rule whose matching alias is longest: matching is substring
  // based, so a generic alias ("veo 3.1") would otherwise shadow the
  // specific rule ("veo 3.1 fast") for every model that contains it if the
  // generic rule ever ends up earlier in the registry. Ties keep the
  // earliest rule, matching the previous first-match behavior.
  let best = null;
  let bestAliasLength = -1;
  for (const rule of registry.models) {
    if (!Array.isArray(rule?.match)) continue;
    for (const alias of rule.match) {
      const normalizedAlias = normalizeModel(alias);
      if (!normalizedAlias || !normalized.includes(normalizedAlias)) continue;
      if (normalizedAlias.length > bestAliasLength) {
        best = rule;
        bestAliasLength = normalizedAlias.length;
      }
    }
  }
  return best;
}

function jobProblem(index, code, message) {
  return { index, code, message };
}

// FEAT-03 override whitelist. Keys are matched after normalizing case and
// underscores, so the camelCase and snake_case spellings of the payload
// dialect name the same field. Route-defining fields may appear in an
// override only to restate the snapshot value; mergeable fields replace
// the snapshot value outright.
const OVERRIDE_FIELDS = new Map([
  ["type", "type"],
  ["model", "model"],
  ["ratio", "aspectRatio"],
  ["aspectratio", "aspectRatio"],
  ["quantity", "quantity"],
  ["duration", "duration"],
  ["resolution", "resolution"],
  ["mode", "mode"],
  ["frames", "frames"],
  ["inputtype", "inputType"],
]);

function normalizeOverrideKey(key) {
  return String(key || "").replace(/_/g, "").toLowerCase();
}

// Ref identity in the payload dialect is the asset name (an "asset:"
// prefix is decorative); staged entries carry a transferId instead and
// belong to the pending-upload set, never to the ref pool.
function cleanRefKey(value) {
  return typeof value === "string" ? value.replace(/^asset:/i, "").trim() : "";
}

function refEntryKey(entry) {
  if (typeof entry === "string") return cleanRefKey(entry);
  if (!entry || typeof entry !== "object") return "";
  if (typeof entry.transferId === "string") return "";
  return cleanRefKey(entry.refKey) || cleanRefKey(entry.key) || cleanRefKey(entry.assetName);
}

function poolEntryKey(entry) {
  if (typeof entry === "string") return cleanRefKey(entry);
  if (!entry || typeof entry !== "object") return "";
  return cleanRefKey(entry.refKey) || cleanRefKey(entry.key) || cleanRefKey(entry.assetName) || cleanRefKey(entry.name);
}

function transferIdOf(entry) {
  return entry && typeof entry === "object" && typeof entry.transferId === "string" && entry.transferId
    ? entry.transferId
    : null;
}

export function validateFlowJobPayloads(jobs, registry) {
  if (!registry || !Array.isArray(jobs)) return [];
  const problems = [];
  // Per-job facts the batch-level FEAT-03 rules need after the per-job
  // pass (chain membership, ref pool coverage, pending-upload set).
  const records = [];
  jobs.forEach((job, index) => {
    const record = { generation: false, quantity: undefined, quantityKnown: false, refKeys: new Set(), stagedIds: [], poolKeys: [], pendingDeclared: [] };
    records.push(record);
    if (job?.operation !== GENERATION_OPERATION) return;
    record.generation = true;
    const payload = job?.payload && typeof job.payload === "object" ? job.payload : {};
    const nested = payload.video_settings && typeof payload.video_settings === "object" ? payload.video_settings : {};
    const type = payload.type || nested.type || "image";
    let model = payload.model || nested.model;
    let duration = payload.duration ?? nested.duration;
    let resolution = payload.resolution ?? nested.resolution;
    let aspectRatio = payload.aspectRatio ?? payload.aspect_ratio ?? nested.aspectRatio ?? nested.aspect_ratio;
    let quantity = payload.quantity ?? nested.quantity;
    record.quantity = quantity;
    record.quantityKnown = true;
    const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
    const mode = payload.mode || nested.mode;
    const frameValues = [payload.firstFrame, payload.lastFrame, nested.firstFrame, nested.lastFrame, nested.first_frame, nested.last_frame];
    const hasFrames = mode === "frames" || frameValues.some(value => Boolean(value));
    const hasFirstFrame = Boolean(payload.firstFrame || nested.firstFrame || nested.first_frame);

    // Batch-rule raw material, read from the payload as submitted: ref
    // keys (attachments + frame inputs), staged transfer ids, and any
    // ref-pool / pending-set declarations this job carries.
    for (const entry of [...attachments, ...frameValues]) {
      const key = refEntryKey(entry);
      if (key) record.refKeys.add(key);
      const transferId = transferIdOf(entry);
      if (transferId) record.stagedIds.push(transferId);
    }
    const poolDeclaration = payload.refPool ?? job?.metadata?.refPool;
    if (Array.isArray(poolDeclaration)) {
      for (const entry of poolDeclaration) {
        const key = poolEntryKey(entry);
        if (key) record.poolKeys.push(key);
      }
    }
    const pendingDeclaration = payload.pendingRefs ?? job?.metadata?.pendingRefs;
    if (Array.isArray(pendingDeclaration)) {
      for (const entry of pendingDeclaration) {
        const transferId = typeof entry === "string" ? entry : transferIdOf(entry);
        if (transferId) record.pendingDeclared.push(transferId);
      }
    }

    // FEAT-03 overrides pass: validate the override block, reject route
    // changes, then merge the mergeable fields over the snapshot locals
    // above so every check below validates the merged settings. A job
    // whose overrides cannot be read is rejected on that problem alone.
    if (payload.overrides !== undefined && payload.overrides !== null) {
      const overrides = payload.overrides;
      if (typeof overrides !== "object" || Array.isArray(overrides)) {
        record.quantityKnown = false;
        problems.push(jobProblem(index, "FLOW_QUEUE_PREFLIGHT_OVERRIDE_KEY",
          `Job ${index + 1}: settings overrides must be an object keyed by the whitelisted setting names.`));
        return;
      }
      const byField = {};
      let unknownKey = null;
      for (const [key, value] of Object.entries(overrides)) {
        const field = OVERRIDE_FIELDS.get(normalizeOverrideKey(key));
        if (!field) { unknownKey = key; break; }
        byField[field] = value;
      }
      if (unknownKey !== null) {
        record.quantityKnown = false;
        problems.push(jobProblem(index, "FLOW_QUEUE_PREFLIGHT_OVERRIDE_KEY",
          `Job ${index + 1}: settings override "${unknownKey}" is not in the per-item override whitelist.`));
        return;
      }
      let routeConflict = null;
      if ("type" in byField &&
          String(byField.type).trim().toLowerCase() !== String(type).trim().toLowerCase()) {
        routeConflict = `media type "${byField.type}" differs from the batch snapshot "${type}"`;
      }
      if (!routeConflict && ("mode" in byField || "frames" in byField)) {
        const mergedMode = "mode" in byField ? byField.mode : mode;
        let mergedFrames = mergedMode === "frames" || frameValues.some(value => Boolean(value));
        if ("frames" in byField && typeof byField.frames === "boolean") {
          mergedFrames = byField.frames || frameValues.some(value => Boolean(value));
        }
        if (mergedFrames !== hasFrames) {
          routeConflict = "the frames flag differs from the batch snapshot";
        }
      }
      if (!routeConflict && "inputType" in byField) {
        const snapshotInputType = payload.inputType ?? payload.input_type ?? nested.inputType ?? nested.input_type ?? null;
        const wanted = byField.inputType == null ? null : String(byField.inputType);
        const snapshot = snapshotInputType == null ? null : String(snapshotInputType);
        if (wanted !== snapshot) {
          routeConflict = `input type "${byField.inputType}" differs from the batch snapshot "${snapshotInputType ?? "(none)"}"`;
        }
      }
      if (routeConflict) {
        record.quantityKnown = false;
        problems.push(jobProblem(index, "FLOW_QUEUE_PREFLIGHT_ROUTE_CONFLICT",
          `Job ${index + 1}: settings override changes the generation route (${routeConflict}); route-defining fields must match the batch settings.`));
        return;
      }
      if ("model" in byField) model = byField.model;
      if ("aspectRatio" in byField) aspectRatio = byField.aspectRatio;
      if ("duration" in byField) duration = byField.duration;
      if ("resolution" in byField) resolution = byField.resolution;
      if ("quantity" in byField) {
        quantity = byField.quantity;
        record.quantity = quantity;
      }
    }

    if (type !== "image" && type !== "video") {
      problems.push(jobProblem(index, "FLOW_QUEUE_PREFLIGHT_TYPE", `Job ${index + 1}: generation type "${type}" is not supported.`));
      return;
    }
    if (hasFrames && attachments.length > 0) {
      problems.push(jobProblem(index, "FLOW_QUEUE_PREFLIGHT_FRAMES_CONFLICT",
        `Job ${index + 1}: frame inputs and ingredient references cannot be combined in one Flow generation.`));
    }
    // FEAT-03: frames mode needs a first frame per item. The one exemption
    // is a chain-from-last-frame item after the first: it inherits its
    // first frame from the previous chain item's last frame, which is
    // exactly the items carrying a dependency link at position > 0.
    if (hasFrames && !hasFirstFrame &&
        !(index > 0 && typeof job?.metadata?.dependsOnId === "string" && job.metadata.dependsOnId)) {
      problems.push(jobProblem(index, "FLOW_QUEUE_PREFLIGHT_FRAMES_FIRST_FRAME",
        `Job ${index + 1}: frames mode requires a first frame for every item (only chain items after the first may inherit one from the previous item's last frame).`));
    }
    const rule = findModelRule(registry, model);
    const maxReferences = rule?.maxReferences ?? registry.defaults?.maxReferences ?? 3;
    if (attachments.length > maxReferences) {
      problems.push(jobProblem(index, "FLOW_QUEUE_PREFLIGHT_REFERENCES",
        `Job ${index + 1}: ${attachments.length} references exceed the Flow limit of ${maxReferences} for this model.`));
    }
    // Prompt-length admission guard (VID-07): the limit is data, not code —
    // an optional `maxPromptLength` on the model rule, falling back to
    // `defaults.maxPromptLength` exactly like maxReferences. Only a positive
    // finite number activates the check; absent/null/invalid means no check,
    // so admission is unchanged until a limit is configured (the exact Flow
    // maximum is server-side knowledge, IMG-B2). Length is the JS string
    // length of the job's final prompt — the exact string the content side
    // submits — and each job in a batch is measured on its own prompt.
    const maxPromptLength = rule?.maxPromptLength ?? registry.defaults?.maxPromptLength;
    if (typeof maxPromptLength === "number" && Number.isFinite(maxPromptLength) && maxPromptLength > 0 &&
        typeof payload.prompt === "string" && payload.prompt.length > maxPromptLength) {
      problems.push(jobProblem(index, "FLOW_QUEUE_PREFLIGHT_PROMPT_LENGTH",
        `Job ${index + 1}: prompt is ${payload.prompt.length} characters, exceeding the configured maximum of ${maxPromptLength} characters.`));
    }
    if (type === "image" && (duration != null || resolution != null)) {
      problems.push(jobProblem(index, "FLOW_QUEUE_PREFLIGHT_VIDEO_SETTINGS",
        `Job ${index + 1}: duration and resolution only apply to video generation.`));
    }
    if (!rule) return;
    if (Array.isArray(rule.types) && !rule.types.includes(type)) {
      problems.push(jobProblem(index, "FLOW_QUEUE_PREFLIGHT_MODEL_TYPE",
        `Job ${index + 1}: model "${model}" does not generate ${type} output.`));
    }
    let durationTierRejected = false;
    if (duration != null && Array.isArray(rule.durations) && !rule.durations.includes(Number(duration))) {
      durationTierRejected = true;
      problems.push(jobProblem(index, "FLOW_QUEUE_PREFLIGHT_DURATION",
        `Job ${index + 1}: model "${model}" does not offer a ${duration}s duration.`));
    }
    // FEAT-03: a model-forced duration (registry `fixedDuration`) must
    // equal the chosen duration even when the tier list itself offers the
    // chosen value. Skipped when the tier check already rejected the same
    // duration, so one bad duration reports one problem.
    if (!durationTierRejected && typeof rule.fixedDuration === "number" &&
        duration != null && Number(duration) !== rule.fixedDuration) {
      problems.push(jobProblem(index, "FLOW_QUEUE_PREFLIGHT_FORCED_DURATION",
        `Job ${index + 1}: model "${model}" forces a ${rule.fixedDuration}s duration when it applies, but ${duration}s was chosen.`));
    }
    // FEAT-03: quantity must stay inside the provider range the registry
    // declares for the model (the chain rule below is stricter still).
    if (quantity != null && Array.isArray(rule.quantities) && !rule.quantities.includes(Number(quantity))) {
      problems.push(jobProblem(index, "FLOW_QUEUE_PREFLIGHT_QUANTITY",
        `Job ${index + 1}: model "${model}" does not offer a quantity of ${quantity}.`));
    }
    if (resolution != null && Array.isArray(rule.resolutions) && !rule.resolutions.includes(String(resolution))) {
      problems.push(jobProblem(index, "FLOW_QUEUE_PREFLIGHT_RESOLUTION",
        `Job ${index + 1}: model "${model}" does not offer ${resolution} resolution.`));
    }
    if (aspectRatio && Array.isArray(rule.aspectRatios) && rule.aspectRatios.length && !rule.aspectRatios.includes(String(aspectRatio))) {
      problems.push(jobProblem(index, "FLOW_QUEUE_PREFLIGHT_ASPECT_RATIO",
        `Job ${index + 1}: model "${model}" does not offer the ${aspectRatio} aspect ratio.`));
    }
    if (hasFrames && rule.supportsFrames === false) {
      problems.push(jobProblem(index, "FLOW_QUEUE_PREFLIGHT_FRAMES_UNSUPPORTED",
        `Job ${index + 1}: model "${model}" does not support first/last frame inputs.`));
    }
  });

  // --- FEAT-03 batch-level admission rules ---
  // Chain quantity: an item participates in a chain when it links to a
  // predecessor (metadata.dependsOnId) or when another item links to it;
  // chained items render one at a time, so quantity must be exactly 1.
  const referencedIds = new Set();
  for (const job of jobs) {
    const dependsOnId = job?.metadata?.dependsOnId;
    if (typeof dependsOnId === "string" && dependsOnId) referencedIds.add(dependsOnId);
  }
  records.forEach((record, index) => {
    if (!record.generation || !record.quantityKnown || record.quantity == null) return;
    const job = jobs[index];
    const dependsOnId = job?.metadata?.dependsOnId;
    const participates = (typeof dependsOnId === "string" && Boolean(dependsOnId)) ||
      (typeof job?.id === "string" && referencedIds.has(job.id));
    if (participates && Number(record.quantity) !== 1) {
      problems.push(jobProblem(index, "FLOW_QUEUE_PREFLIGHT_CHAIN_QUANTITY",
        `Job ${index + 1}: chained generations produce one output per item, so quantity must be exactly 1 (got ${record.quantity}).`));
    }
  });

  // Ref pool: only checked when the batch declares a pool at all — batches
  // that carry their refs inline with no pool keep today's behavior.
  const pool = new Set();
  let poolDeclared = false;
  for (const record of records) {
    if (record.poolKeys.length > 0) poolDeclared = true;
    for (const key of record.poolKeys) pool.add(key);
  }
  if (poolDeclared) {
    records.forEach((record, index) => {
      if (!record.generation) return;
      for (const key of record.refKeys) {
        if (!pool.has(key)) {
          problems.push(jobProblem(index, "FLOW_QUEUE_PREFLIGHT_REF_POOL",
            `Job ${index + 1}: reference "${key}" is not in the batch ref pool.`));
        }
      }
    });
  }

  // Pending uploads: when the batch declares its pending set, the staged
  // references across the batch must match it exactly — an undeclared
  // staged ref would upload outside the admitted set, and a declared ref
  // nothing stages would upload short. (Performing the upload itself is
  // the queue/service-worker admission layer's job; see the header note.)
  const referencedStaged = new Set();
  const declaredPending = new Set();
  let pendingDeclared = false;
  let firstDeclarerIndex = -1;
  records.forEach((record, index) => {
    if (!record.generation) return;
    for (const transferId of record.stagedIds) referencedStaged.add(transferId);
    if (record.pendingDeclared.length > 0) {
      if (!pendingDeclared) firstDeclarerIndex = index;
      pendingDeclared = true;
      for (const transferId of record.pendingDeclared) declaredPending.add(transferId);
    }
  });
  if (pendingDeclared) {
    const undeclared = [...referencedStaged].filter(transferId => !declaredPending.has(transferId));
    const unreferenced = [...declaredPending].filter(transferId => !referencedStaged.has(transferId));
    if (undeclared.length > 0 || unreferenced.length > 0) {
      problems.push(jobProblem(firstDeclarerIndex, "FLOW_QUEUE_PREFLIGHT_PENDING_REFS",
        `Batch pending-upload set must match the staged references exactly (staged but not declared: ${undeclared.join(", ") || "none"}; declared but not staged: ${unreferenced.join(", ") || "none"}).`));
    }
  }

  return problems;
}

export function preflightError(problems) {
  const first = problems[0];
  const error = new Error(problems.length === 1
    ? first.message
    : `Batch preflight failed for ${problems.length} job(s). First: ${first.message}`);
  error.code = problems.length === 1 ? first.code : "FLOW_QUEUE_BATCH_PREFLIGHT_FAILED";
  error.problems = problems;
  return error;
}
