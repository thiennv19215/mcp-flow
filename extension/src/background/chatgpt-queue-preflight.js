// ChatGPT queue admission preflight (GPT-09).
//
// Logic (adapted from the reference provider design, not its code): ChatGPT
// jobs are admitted by their OWN validator, dispatched by operation prefix
// alongside the Flow validator in FlowJobQueue. The Flow validator only
// understands Flow capability rules, so a ChatGPT job checked against them
// (or not checked at all) would only fail at run time — after earlier jobs
// in the same submission already spent work. Validating the whole
// submission up front keeps batch rejection atomic (inherited from
// FlowJobQueue.addBatch / #preflight).
//
// The rules mirror the ChatGPT capability registry (GPT-01) and read every
// limit from it through the loader's accessors — nothing is hard-coded
// here: the prompt is required, the requested ratio must be in the
// capability enum for the job's model, and reference attachments are
// capped at the registry's maxRefImages and must be image payloads.
//
// Problem codes follow the Flow family shape with the provider prefix:
//   CHATGPT_QUEUE_PREFLIGHT_PROMPT             prompt missing or blank
//   CHATGPT_QUEUE_PREFLIGHT_RATIO              ratio outside the enum
//   CHATGPT_QUEUE_PREFLIGHT_REFERENCES         more refs than the cap
//   CHATGPT_QUEUE_PREFLIGHT_REFERENCE_PAYLOAD  a ref carries no payload
//   CHATGPT_QUEUE_PREFLIGHT_REFERENCE_TYPE     a ref payload is not an image
//
// Reference attachments are the staged-file records GPT-03's contract
// consumes (and the resolved refs it produces): a ref only counts when it
// CARRIES its bytes — a base64 string, a base64 data URL, or a byte
// payload. A bare library/tile ID carries no payload and is rejected here
// at admission: for ChatGPT, uploaded refs are uploaded and the library is
// a separate source, so an ID-only ref can never become a valid reference
// downstream — it is GPT-03's drop case, surfaced early with a code.
//
// Like the Flow validator, the checks are conservative: only fields a job
// actually specifies are validated (an absent ratio falls back to the
// GPT-01 default bucket at submit time), and a missing/unreadable
// registry skips preflight entirely instead of blocking the queue.

import {
  maxRefImagesFor,
  normalizeChatGptRatio,
  ratioSemanticsFor,
  supportedRatiosFor,
} from "./chatgpt-capabilities.js";

export const CHATGPT_GENERATION_OPERATION = "chatgpt.generation.submit";
const CHATGPT_OPERATION_PREFIX = "chatgpt.";

export function isChatGptOperation(operation) {
  return typeof operation === "string" && operation.startsWith(CHATGPT_OPERATION_PREFIX);
}

function jobProblem(index, code, message) {
  return { index, code, message };
}

function gcd(a, b) {
  return b === 0 ? a : gcd(b, a % b);
}

// Canonical "w:h" spelling (reduced), mirroring chatgpt-capabilities.js.
function canonicalRatioSpelling(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return null;
  const divisor = gcd(width, height);
  return `${width / divisor}:${height / divisor}`;
}

function ratioIsSupported(value, registry, model) {
  if (typeof value !== "string") return false;
  const supported = supportedRatiosFor(registry, model);
  const semantics = ratioSemanticsFor(registry);
  const text = value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
  if (!text) return false;
  const numeric = text.match(/(\d+)\s*[:x\/-]\s*(\d+)/);
  if (numeric) {
    const canonical = canonicalRatioSpelling(Number(numeric[1]), Number(numeric[2]));
    return canonical !== null && supported.includes(canonical);
  }
  // Label / semantic-word input ("widescreen", "vuông", …): the GPT-01
  // normalizer is the semantic oracle. A label is admissible when its
  // bucket is backed by at least one ratio in the enum for this model;
  // unrecognized text lands in the default bucket, which the enum backs
  // (1:1), matching GPT-01's rule that a garbage ratio degrades to the
  // default bucket instead of failing the submission — only spellings
  // that name a concrete unsupported ratio are rejected above.
  const bucket = normalizeChatGptRatio(text, semantics);
  return supported.some(spelling => semantics[spelling] === bucket);
}

const DATA_URL_PATTERN = /^data:([^;,]*?)?(;base64)?,([\s\S]*)$/i;

// The MIME type a base64 data URL declares: a string when the URL declares
// one, null when it declares none, undefined when the value is not a
// non-empty base64 data URL at all.
function dataUrlMime(value) {
  const match = DATA_URL_PATTERN.exec(value.trim());
  if (!match || !match[2] || !match[3].trim()) return undefined;
  return typeof match[1] === "string" && match[1].trim() ? match[1].trim().toLowerCase() : null;
}

function hasBytePayload(value) {
  if (ArrayBuffer.isView(value)) return value.byteLength > 0;
  if (Object.prototype.toString.call(value) === "[object ArrayBuffer]") return value.byteLength > 0;
  if (Array.isArray(value)) return value.length > 0;
  return false;
}

// Classifies one attachment: null when it is an admissible image
// reference, otherwise the problem code for the first rule it breaks.
// Payload presence is checked before type: a ref without bytes can never
// be an image reference, whatever type it declares.
function refProblemCode(ref) {
  if (!ref || typeof ref !== "object" || Array.isArray(ref)) {
    return "CHATGPT_QUEUE_PREFLIGHT_REFERENCE_PAYLOAD";
  }
  let hasPayload = false;
  let dataMime = null;
  if (typeof ref.base64 === "string" && ref.base64.trim()) {
    hasPayload = true;
    if (/^data:/i.test(ref.base64.trim())) {
      const mime = dataUrlMime(ref.base64);
      if (mime === undefined) hasPayload = false;
      else dataMime = mime;
    }
  }
  if (!hasPayload) {
    const dataUrl = typeof ref.dataUrl === "string" ? ref.dataUrl
      : typeof ref.data_url === "string" ? ref.data_url
      : null;
    if (dataUrl !== null) {
      const mime = dataUrlMime(dataUrl);
      if (mime !== undefined) {
        hasPayload = true;
        dataMime = mime;
      }
    }
  }
  if (!hasPayload && ref.bytes !== undefined && ref.bytes !== null) {
    hasPayload = hasBytePayload(ref.bytes);
  }
  if (!hasPayload) return "CHATGPT_QUEUE_PREFLIGHT_REFERENCE_PAYLOAD";

  const declared = [ref.type, ref.mimeType].find(value => typeof value === "string" && value.trim());
  const mime = (declared ? declared.trim().toLowerCase() : null) || dataMime;
  // "application/octet-stream" is GPT-03's placeholder type for a payload
  // whose type is unknown, not a claim that the payload is not an image;
  // only a concrete non-image type breaks the image-only rule.
  if (mime && mime !== "application/octet-stream" && !mime.startsWith("image/")) {
    return "CHATGPT_QUEUE_PREFLIGHT_REFERENCE_TYPE";
  }
  return null;
}

export function validateChatGptJobPayloads(jobs, registry) {
  if (!registry || !Array.isArray(jobs)) return [];
  const problems = [];
  jobs.forEach((job, index) => {
    if (job?.operation !== CHATGPT_GENERATION_OPERATION) return;
    const payload = job?.payload && typeof job.payload === "object" ? job.payload : {};
    const model = payload.model;

    if (typeof payload.prompt !== "string" || !payload.prompt.trim()) {
      problems.push(jobProblem(index, "CHATGPT_QUEUE_PREFLIGHT_PROMPT",
        `Job ${index + 1}: a ChatGPT generation requires a prompt.`));
    }

    const ratio = payload.ratio ?? payload.aspectRatio ?? payload.aspect_ratio;
    const ratioAbsent = ratio === undefined || ratio === null || (typeof ratio === "string" && !ratio.trim());
    if (!ratioAbsent && !ratioIsSupported(ratio, registry, model)) {
      problems.push(jobProblem(index, "CHATGPT_QUEUE_PREFLIGHT_RATIO",
        `Job ${index + 1}: ratio "${ratio}" is not offered for ChatGPT image generation with this model.`));
    }

    const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
    const maxRefImages = maxRefImagesFor(registry, model);
    if (attachments.length > maxRefImages) {
      problems.push(jobProblem(index, "CHATGPT_QUEUE_PREFLIGHT_REFERENCES",
        `Job ${index + 1}: ${attachments.length} references exceed the ChatGPT limit of ${maxRefImages} for this model.`));
    }
    attachments.forEach((ref, refIndex) => {
      const code = refProblemCode(ref);
      if (!code) return;
      problems.push(jobProblem(index, code, code === "CHATGPT_QUEUE_PREFLIGHT_REFERENCE_TYPE"
        ? `Job ${index + 1}: reference ${refIndex + 1} is not an image; ChatGPT references must be images.`
        : `Job ${index + 1}: reference ${refIndex + 1} carries no image payload; upload the file instead of referencing the library.`));
    });
  });
  return problems;
}
