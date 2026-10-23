// ChatGPT capability registry + ratio normalization for the ChatGPT provider.
//
// Logic (adapted from the reference extension's ChatGPT adapter design, not
// its code): ChatGPT ratio input arrives in many spellings — canonical
// "16:9"-style ratios, separator variants, English semantic words, and
// localized (Vietnamese) labels — and must be normalized early into five
// semantic buckets (widescreen / story / square / landscape / portrait)
// that the composer-side ratio selection and the prompt-suffix channel both
// understand. Unknown input falls back to the default bucket instead of
// throwing, so a garbage ratio can never hang or crash a submission.
//
// The registry itself is a LOCAL static file (chatgpt-model-capabilities.json
// at the repo root, synced into the extension package at build time exactly
// like flow-model-capabilities.json). It carries no server secrets: model
// entries expose maxRefImages and supported ratios, and the defaults mirror
// the Flow registry's conservative discipline — a missing or unreadable
// registry degrades to the built-in defaults below rather than blocking work.

export const CHATGPT_RATIO_SEMANTICS = Object.freeze({
  "16:9": "widescreen",
  "9:16": "story",
  "1:1": "square",
  "4:3": "landscape",
  "3:4": "portrait",
});

export const CHATGPT_SUPPORTED_RATIOS = Object.freeze(["16:9", "9:16", "1:1", "4:3", "3:4"]);

// ChatGPT's image mode falls back to a square render when no ratio is
// requested, so the default bucket is square (1:1).
export const CHATGPT_DEFAULT_RATIO = "1:1";
export const CHATGPT_DEFAULT_RATIO_SEMANTIC = CHATGPT_RATIO_SEMANTICS[CHATGPT_DEFAULT_RATIO];

// Local admission cap, not a claimed platform limit: ChatGPT's composer
// accepts several image attachments per message, and this registry value is
// ours to raise. Kept deliberately modest for v1.
export const CHATGPT_DEFAULT_MAX_REF_IMAGES = 5;

const DEFAULT_CAPABILITIES = Object.freeze({
  supportsRatio: true,
  supportsQuantity: false,
  supportsVideo: false,
  supportsRefImage: true,
  supportsAutoDownload: true,
});

// Localized / descriptive labels -> semantic bucket. Keys are matched after
// lowercasing and diacritic stripping, so Vietnamese labels work with or
// without tone marks ("vuông" and "vuong" both land here as "vuong").
const RATIO_LABELS = Object.freeze({
  widescreen: "widescreen",
  "wide screen": "widescreen",
  wide: "widescreen",
  "man hinh rong": "widescreen",
  "kho rong": "widescreen",
  story: "story",
  stories: "story",
  "cau chuyen": "story",
  square: "square",
  vuong: "square",
  "hinh vuong": "square",
  landscape: "landscape",
  horizontal: "landscape",
  ngang: "landscape",
  "kho ngang": "landscape",
  "nam ngang": "landscape",
  portrait: "portrait",
  vertical: "portrait",
  doc: "portrait",
  "kho doc": "portrait",
  "nam doc": "portrait",
  "chan dung": "portrait",
});

function gcd(a, b) {
  return b === 0 ? a : gcd(b, a % b);
}

function canonicalRatioSpelling(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return null;
  const divisor = gcd(width, height);
  return `${width / divisor}:${height / divisor}`;
}

function stripDiacritics(text) {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D");
}

function normalizeLabelText(value) {
  return stripDiacritics(String(value).normalize("NFKC").trim().toLowerCase()).replace(/\s+/g, " ");
}

/**
 * Normalize any ratio spelling to one of the five semantic buckets.
 * Accepts canonical spellings ("16:9"), separator variants ("16x9", "16/9",
 * "16-9"), reducible spellings ("32:18"), semantic words, and localized
 * labels; a ratio embedded in a longer label wins over the label words.
 * Unknown or garbage input returns CHATGPT_DEFAULT_RATIO_SEMANTIC. Never throws.
 */
export function normalizeChatGptRatio(value, semantics = CHATGPT_RATIO_SEMANTICS) {
  if (typeof value !== "string") return CHATGPT_DEFAULT_RATIO_SEMANTIC;
  const map = semantics && typeof semantics === "object" ? semantics : CHATGPT_RATIO_SEMANTICS;
  const text = value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
  if (!text) return CHATGPT_DEFAULT_RATIO_SEMANTIC;

  const numeric = text.match(/(\d+)\s*[:x\/-]\s*(\d+)/);
  if (numeric) {
    const canonical = canonicalRatioSpelling(Number(numeric[1]), Number(numeric[2]));
    if (canonical) return typeof map[canonical] === "string" ? map[canonical] : CHATGPT_DEFAULT_RATIO_SEMANTIC;
  }

  const label = RATIO_LABELS[normalizeLabelText(text)];
  return label || CHATGPT_DEFAULT_RATIO_SEMANTIC;
}

function normalizeModelKey(value) {
  return String(value || "").normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

// Mirror of the Flow preflight's model lookup: substring alias matching,
// longest alias wins so a generic alias never shadows a specific rule.
function findModelRule(registry, model) {
  const normalized = normalizeModelKey(model);
  if (!normalized || !Array.isArray(registry?.models)) return null;
  let best = null;
  let bestAliasLength = -1;
  for (const rule of registry.models) {
    if (!Array.isArray(rule?.match)) continue;
    for (const alias of rule.match) {
      const normalizedAlias = normalizeModelKey(alias);
      if (!normalizedAlias || !normalized.includes(normalizedAlias)) continue;
      if (normalizedAlias.length > bestAliasLength) {
        best = rule;
        bestAliasLength = normalizedAlias.length;
      }
    }
  }
  return best;
}

function validRatioList(value) {
  if (!Array.isArray(value)) return null;
  const ratios = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const match = entry.trim().match(/^(\d+)\s*:\s*(\d+)$/);
    if (!match) continue;
    const canonical = canonicalRatioSpelling(Number(match[1]), Number(match[2]));
    if (canonical && !ratios.includes(canonical)) ratios.push(canonical);
  }
  return ratios.length ? ratios : null;
}

function validSemantics(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const semantics = {};
  for (const [spelling, bucket] of Object.entries(value)) {
    const match = String(spelling).trim().match(/^(\d+)\s*:\s*(\d+)$/);
    if (!match || typeof bucket !== "string" || !bucket.trim()) continue;
    const canonical = canonicalRatioSpelling(Number(match[1]), Number(match[2]));
    if (canonical) semantics[canonical] = bucket.trim();
  }
  return Object.keys(semantics).length ? semantics : null;
}

function validMaxRefImages(value) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Validate + normalize a parsed chatgpt-model-capabilities.json payload.
 * Returns a normalized registry, or null when the payload cannot carry the
 * contract (defaults with maxRefImages / supportedRatios / ratioSemantics).
 * Never throws.
 */
export function parseChatGptCapabilityRegistry(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const rawDefaults = data.defaults && typeof data.defaults === "object" ? data.defaults : null;
  if (!rawDefaults) return null;
  const maxRefImages = validMaxRefImages(rawDefaults.maxRefImages);
  const supportedRatios = validRatioList(rawDefaults.supportedRatios);
  const ratioSemantics = validSemantics(rawDefaults.ratioSemantics);
  if (maxRefImages === null || !supportedRatios || !ratioSemantics) return null;

  const defaults = {
    maxRefImages,
    supportedRatios,
    defaultRatio: canonicalRatioSpelling(
      ...(String(rawDefaults.defaultRatio || CHATGPT_DEFAULT_RATIO).split(":").map(part => Number(part))),
    ) || CHATGPT_DEFAULT_RATIO,
    ratioSemantics,
  };

  const rawCapabilities = data.capabilities && typeof data.capabilities === "object" ? data.capabilities : {};
  const capabilities = {};
  for (const key of Object.keys(DEFAULT_CAPABILITIES)) {
    capabilities[key] = typeof rawCapabilities[key] === "boolean" ? rawCapabilities[key] : DEFAULT_CAPABILITIES[key];
  }

  const models = [];
  if (Array.isArray(data.models)) {
    for (const raw of data.models) {
      if (!raw || typeof raw !== "object" || !Array.isArray(raw.match)) continue;
      const match = raw.match.filter(alias => typeof alias === "string" && alias.trim()).map(alias => alias.trim());
      if (!match.length) continue;
      models.push({
        match,
        types: Array.isArray(raw.types) ? raw.types.filter(type => typeof type === "string") : ["image"],
        aspectRatios: validRatioList(raw.aspectRatios) || [...defaults.supportedRatios],
        maxRefImages: validMaxRefImages(raw.maxRefImages) ?? defaults.maxRefImages,
      });
    }
  }

  return { version: 1, defaults, capabilities, models };
}

/**
 * Load the packaged registry the same way the service worker loads the Flow
 * registry (fetch chrome.runtime.getURL(<file>) -> json, null on any
 * failure), with fetch/getURL injectable for tests. Never throws.
 */
export async function loadChatGptCapabilityRegistry({ fetchImpl, getURL } = {}) {
  const doFetch = typeof fetchImpl === "function" ? fetchImpl : globalThis.fetch;
  if (typeof doFetch !== "function") return null;
  const resolveUrl = typeof getURL === "function"
    ? getURL
    : path => (typeof globalThis.chrome?.runtime?.getURL === "function" ? globalThis.chrome.runtime.getURL(path) : path);
  try {
    const response = await doFetch(resolveUrl("chatgpt-model-capabilities.json"));
    if (!response?.ok) return null;
    return parseChatGptCapabilityRegistry(await response.json());
  } catch {
    return null;
  }
}

export function maxRefImagesFor(registry, model) {
  const rule = findModelRule(registry, model);
  return rule?.maxRefImages ?? registry?.defaults?.maxRefImages ?? CHATGPT_DEFAULT_MAX_REF_IMAGES;
}

export function supportedRatiosFor(registry, model) {
  const rule = findModelRule(registry, model);
  const ratios = rule?.aspectRatios ?? registry?.defaults?.supportedRatios ?? CHATGPT_SUPPORTED_RATIOS;
  return [...ratios];
}

export function ratioSemanticsFor(registry) {
  const semantics = registry?.defaults?.ratioSemantics;
  return semantics && typeof semantics === "object" ? { ...semantics } : { ...CHATGPT_RATIO_SEMANTICS };
}
