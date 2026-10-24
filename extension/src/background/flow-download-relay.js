// DL-10: background half of the already-clean fingerprint registry
// (study W6 keeps the set in two places: a fingerprint map in the
// network interceptor and a recent-cleaned hash set in the background).
// This module already owns SHA-256 on the background side (per-chunk
// digests below), so it hosts the background registry primitives with
// semantics identical to the interceptor's: fingerprint =
// SHA-256(bytes ‖ mime), bounded set, oldest-first eviction, explicit
// record only. Nothing in the relay read path records on its own — the
// relay re-reads server bytes from the download's final URL and cannot
// know they were cleaned, so recording there would poison the set;
// only verified cleaned outputs may be recorded, by the layer that
// knows the cleaning outcome.
export const MAX_CLEANED_FINGERPRINTS = 64;

export async function fingerprintMediaBytes(bytes, mime, cryptoApi = crypto) {
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  const mimeBytes = new TextEncoder().encode(typeof mime === "string" ? mime : "");
  const data = new Uint8Array(input.length + mimeBytes.length);
  data.set(input, 0);
  data.set(mimeBytes, input.length);
  const digest = new Uint8Array(await cryptoApi.subtle.digest("SHA-256", data));
  return [...digest].map(value => value.toString(16).padStart(2, "0")).join("");
}

export function createCleanedFingerprintRegistry(limit = MAX_CLEANED_FINGERPRINTS) {
  const cap = Number.isSafeInteger(limit) && limit > 0 ? limit : MAX_CLEANED_FINGERPRINTS;
  const fingerprints = [];
  return {
    record(fingerprint) {
      if (typeof fingerprint !== "string" || !fingerprint) return false;
      if (fingerprints.includes(fingerprint)) return false;
      fingerprints.push(fingerprint);
      while (fingerprints.length > cap) fingerprints.shift();
      return true;
    },
    has(fingerprint) {
      return fingerprints.includes(fingerprint);
    },
    clear() {
      fingerprints.length = 0;
    },
    get size() {
      return fingerprints.length;
    },
  };
}

const flowUrl = url => /^https:\/\/flow\.google\.com\//.test(url || "");

const allowedMediaHost = hostname => {
  const host = hostname.toLowerCase();
  return host === "storage.googleapis.com" || host === "googleusercontent.com" || host.endsWith(".googleusercontent.com") ||
    host.endsWith(".googleapis.com") || host.endsWith(".usercontent.goog");
};

// GPT-15: provider tab-fetch relay (study (E)15, §D.3.5, behavior
// B24). A provider result image is fetched with a credentialed fetch
// executed in the provider tab's context (the tab's own logged-in
// session rides the request) and the bytes come back base64 — the
// same out-contract readFlowDownloadChunk below already uses
// ({ data: base64, sha256 digest, totalBytes }). This is ONE relay
// generalized by a provider/host table, not a second implementation:
// the "flow" provider delegates its host check to the legacy
// allowedMediaHost above (its verdicts are unchanged), while
// "chatgpt" accepts only its result hosts — the chat host and the
// file-CDN host family the GPT-04 extraction tiers produce.
//
// Validation discipline mirrors the chunk relay: everything checkable
// is refused BEFORE the fetch is issued — a non-https URL, embedded
// URL credentials, an unknown provider, a host that is not an exact
// host or proper subdomain (dot boundary, never substring) of the
// provider's bases, or a declared size over the cap. After the
// response headers arrive but BEFORE the body is read, an oversized
// Content-Length or a non-image Content-Type refuses (body cancelled,
// never consumed). After the read, an actual byte count over the cap
// or one disagreeing with the declared size refuses instead of
// returning bytes.
//
// The cap is a named constant: 25 MiB, the image cap the repo's
// transfer layer already applies to images (src/flow-transfer.ts).
// The accepted content types are the image types the queue download
// pipeline already maps to extensions in flow-queue-downloads.js
// (png / jpeg / webp / gif). The fetch timeout mirrors the chunk
// relay's 45 s AbortSignal.timeout.
export const TAB_FETCH_IMAGE_MAX_BYTES = 25 * 1024 * 1024;
export const TAB_FETCH_IMAGE_CONTENT_TYPES = Object.freeze(["image/png", "image/jpeg", "image/webp", "image/gif"]);
export const TAB_FETCH_TIMEOUT_MS = 45_000;
export const TAB_FETCH_PROVIDER_HOSTS = Object.freeze({
  chatgpt: Object.freeze(["chatgpt.com", "oaiusercontent.com"]),
});

const tabFetchHostMatchesBase = (hostname, base) => {
  const host = String(hostname || "").toLowerCase();
  return host === base || host.endsWith(`.${base}`);
};

export function isTabFetchHostAllowed(hostname, provider = "chatgpt") {
  if (provider === "flow") return allowedMediaHost(hostname);
  const bases = TAB_FETCH_PROVIDER_HOSTS[provider];
  if (!bases) return false;
  return bases.some(base => tabFetchHostMatchesBase(hostname, base));
}

const tabFetchRefusal = (code, message) => Object.assign(new Error(message), {
  code, retryable: false, outcomeUnknown: false, outcome_unknown: false,
});

export function validateTabFetchImageRequest(input) {
  const provider = typeof input?.provider === "string" && input.provider ? input.provider : "chatgpt";
  const maxBytes = input?.maxBytes === undefined ? TAB_FETCH_IMAGE_MAX_BYTES : input.maxBytes;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > TAB_FETCH_IMAGE_MAX_BYTES) {
    throw tabFetchRefusal("TAB_FETCH_SIZE_REJECTED", "The tab-fetch image size cap is invalid.");
  }
  let parsed;
  try { parsed = new URL(String(input?.url || "")); } catch {
    throw tabFetchRefusal("TAB_FETCH_URL_REJECTED", "The provider result URL is not a readable URL.");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || !isTabFetchHostAllowed(parsed.hostname, provider)) {
    throw tabFetchRefusal("TAB_FETCH_URL_REJECTED", "The provider result URL is not on an approved provider host.");
  }
  const declaredBytes = input?.declaredBytes === undefined || input?.declaredBytes === null ? null : Number(input.declaredBytes);
  if (declaredBytes !== null && (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0)) {
    throw tabFetchRefusal("TAB_FETCH_SIZE_REJECTED", "The declared provider image size is invalid.");
  }
  if (declaredBytes !== null && declaredBytes > maxBytes) {
    throw tabFetchRefusal("TAB_FETCH_SIZE_REJECTED", `The declared provider image size exceeds the ${maxBytes}-byte tab-fetch cap.`);
  }
  return { url: parsed.href, provider, host: parsed.hostname.toLowerCase(), declaredBytes, maxBytes };
}

export async function relayTabFetchImage(input, {
  fetchImpl = fetch,
  cryptoApi = crypto,
} = {}) {
  // Pre-fetch refusals: host / scheme / credentials / declared size
  // are all settled here, before fetchImpl is ever called.
  const request = validateTabFetchImageRequest(input);
  let response;
  try {
    response = await fetchImpl(request.url, {
      credentials: "include",
      cache: "no-store",
      redirect: "follow",
      signal: AbortSignal.timeout(TAB_FETCH_TIMEOUT_MS),
    });
  } catch {
    throw tabFetchRefusal("TAB_FETCH_FAILED", "Could not fetch the provider image in the provider tab. The signed link may have expired.");
  }
  const status = Number(response?.status);
  if (!Number.isSafeInteger(status) || status < 200 || status >= 300) {
    await response?.body?.cancel().catch(() => {});
    throw tabFetchRefusal("TAB_FETCH_FAILED", `The provider image fetch failed (HTTP ${Number.isSafeInteger(status) ? status : "unknown"}).`);
  }
  // Header-stage refusals: the body is cancelled, never read.
  const mime = String(response.headers?.get?.("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!TAB_FETCH_IMAGE_CONTENT_TYPES.includes(mime)) {
    await response.body?.cancel().catch(() => {});
    throw tabFetchRefusal("TAB_FETCH_CONTENT_REJECTED", `The provider URL returned ${mime || "an unknown content type"} instead of an image; nothing was saved.`);
  }
  const declaredLength = Number(response.headers?.get?.("content-length"));
  if (Number.isSafeInteger(declaredLength) && declaredLength > request.maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw tabFetchRefusal("TAB_FETCH_SIZE_REJECTED", `The provider image is ${declaredLength} bytes, over the ${request.maxBytes}-byte tab-fetch cap; nothing was saved.`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > request.maxBytes) {
    throw tabFetchRefusal("TAB_FETCH_SIZE_REJECTED", `The provider image is ${bytes.length} bytes, over the ${request.maxBytes}-byte tab-fetch cap; nothing was saved.`);
  }
  if (bytes.length < 1) {
    throw tabFetchRefusal("TAB_FETCH_CONTENT_REJECTED", "The provider URL returned no image bytes; nothing was saved.");
  }
  if (request.declaredBytes !== null && bytes.length !== request.declaredBytes) {
    throw tabFetchRefusal("TAB_FETCH_SIZE_REJECTED", `The provider image size did not match the declared size (${bytes.length} !== ${request.declaredBytes}); nothing was saved.`);
  }
  const digest = new Uint8Array(await cryptoApi.subtle.digest("SHA-256", bytes));
  const sha256 = [...digest].map(value => value.toString(16).padStart(2, "0")).join("");
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { provider: request.provider, data: btoa(binary), mime, size: bytes.length, totalBytes: bytes.length, sha256 };
}

export async function readFlowDownloadChunk(input, {
  downloads = chrome.downloads,
  fetchImpl = fetch,
  cryptoApi = crypto,
} = {}) {
  const id = Number(input?.id);
  const index = Number(input?.index);
  const offset = Number(input?.offset);
  const length = Number(input?.length);
  if (![id, index, offset, length].every(Number.isSafeInteger) || id < 0 || index < 0 || offset < 0 || length < 1 || length > 1024 * 1024) {
    throw new Error("Invalid Flow download range request.");
  }
  const [item] = await downloads.search({ id });
  if (!item || item.id !== id || item.state !== "complete" || !(flowUrl(item.referrer) || flowUrl(item.url))) {
    throw new Error("The selected item is not a completed Flow download.");
  }
  const mediaUrl = item.finalUrl || item.url;
  let parsed;
  try { parsed = new URL(mediaUrl); } catch { throw new Error("Flow did not provide a readable media URL for this download."); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || !allowedMediaHost(parsed.hostname)) {
    throw new Error("The Flow download URL is not on an approved Google media host.");
  }
  const requestedTotal = Number(item.totalBytes);
  if (requestedTotal > 0 && offset >= requestedTotal) throw new Error("Flow download range is beyond the file size.");
  const end = offset + length - 1;
  let response;
  try {
    response = await fetchImpl(mediaUrl, {
      headers: { Range: `bytes=${offset}-${end}` },
      credentials: "omit",
      cache: "no-store",
      redirect: "follow",
      signal: AbortSignal.timeout(45_000),
    });
  } catch {
    throw new Error("Could not read the completed Flow media URL. The signed link may have expired.");
  }
  if (response.status !== 206) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Flow media server did not honor the requested byte range (HTTP ${response.status}).`);
  }
  const range = response.headers.get("content-range")?.match(/^bytes (\d+)-(\d+)\/(\d+)$/i);
  if (!range || Number(range[1]) !== offset || Number(range[2]) > end) {
    await response.body?.cancel().catch(() => {});
    throw new Error("Flow media server returned an invalid byte range.");
  }
  const totalBytes = Number(range[3]);
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 1 || (requestedTotal > 0 && totalBytes !== requestedTotal)) {
    await response.body?.cancel().catch(() => {});
    throw new Error("Flow download size did not match Chrome's completed download record.");
  }
  const expectedLength = Math.min(length, totalBytes - offset);
  if (expectedLength < 1 || Number(range[2]) - offset + 1 !== expectedLength) {
    await response.body?.cancel().catch(() => {});
    throw new Error("Flow media server returned an incomplete byte range.");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length !== expectedLength) throw new Error("Flow media server returned a truncated or oversized byte range.");
  const digest = new Uint8Array(await cryptoApi.subtle.digest("SHA-256", bytes));
  const chunkSha256 = [...digest].map(value => value.toString(16).padStart(2, "0")).join("");
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { index, offset, data: btoa(binary), chunkSha256, totalBytes };
}
