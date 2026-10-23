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

export function validateFlowJobPayloads(jobs, registry) {
  if (!registry || !Array.isArray(jobs)) return [];
  const problems = [];
  jobs.forEach((job, index) => {
    if (job?.operation !== GENERATION_OPERATION) return;
    const payload = job?.payload && typeof job.payload === "object" ? job.payload : {};
    const nested = payload.video_settings && typeof payload.video_settings === "object" ? payload.video_settings : {};
    const type = payload.type || nested.type || "image";
    const model = payload.model || nested.model;
    const duration = payload.duration ?? nested.duration;
    const resolution = payload.resolution ?? nested.resolution;
    const aspectRatio = payload.aspectRatio ?? payload.aspect_ratio ?? nested.aspectRatio ?? nested.aspect_ratio;
    const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
    const mode = payload.mode || nested.mode;
    const hasFrames = mode === "frames" ||
      Boolean(payload.firstFrame || payload.lastFrame || nested.first_frame || nested.last_frame || nested.firstFrame || nested.lastFrame);

    if (type !== "image" && type !== "video") {
      problems.push(jobProblem(index, "FLOW_QUEUE_PREFLIGHT_TYPE", `Job ${index + 1}: generation type "${type}" is not supported.`));
      return;
    }
    if (hasFrames && attachments.length > 0) {
      problems.push(jobProblem(index, "FLOW_QUEUE_PREFLIGHT_FRAMES_CONFLICT",
        `Job ${index + 1}: frame inputs and ingredient references cannot be combined in one Flow generation.`));
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
    if (duration != null && Array.isArray(rule.durations) && !rule.durations.includes(Number(duration))) {
      problems.push(jobProblem(index, "FLOW_QUEUE_PREFLIGHT_DURATION",
        `Job ${index + 1}: model "${model}" does not offer a ${duration}s duration.`));
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
