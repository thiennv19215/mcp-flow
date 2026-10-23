// flow-queue-downloads.js
// Dedicated module for managing Flow media downloads, filename overrides,
// Chrome downloads event listening, and download completion tracking for queue jobs.

import {
  buildFlowDownloadPlan,
  normalizePlanFolderPath,
  normalizePlannedDownloadPath,
  serializeFilenameTicket,
  restoreFilenameTicket,
  FlowDownloadFilenameRecords,
  FLOW_FILENAME_TICKETS_STORAGE_KEY,
} from "./flow-download-plan.js";

const isFlowMediaHost = hostname => {
  const host = String(hostname || "").toLowerCase();
  return host === "flow.google.com" || host.endsWith(".flow.google.com") ||
    host === "labs.google" || host.endsWith(".labs.google") ||
    host === "storage.googleapis.com" || host.endsWith(".storage.googleapis.com") ||
    host === "googleusercontent.com" || host.endsWith(".googleusercontent.com") ||
    host === "googleapis.com" || host.endsWith(".googleapis.com") ||
    host === "usercontent.goog" || host.endsWith(".usercontent.goog");
};

const flowUrl = url => {
  try {
    const raw = String(url || "");
    if (!raw) return false;
    if (raw.startsWith("blob:")) return raw.includes("flow.google.com") || raw.includes("labs.google");
    return isFlowMediaHost(new URL(raw).hostname);
  } catch { return false; }
};

export function flowResultMedia(value) {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value.media)) return value.media;
  if (value.portraitMedia && typeof value.portraitMedia === "object") return [value.portraitMedia];
  if (value.result && typeof value.result === "object") return flowResultMedia(value.result);
  return [];
}

export const cleanFlowTitle = value => String(value || "")
  .replace(/^(?:hình\s*ảnh|ảnh|image|video|tệp|file|cảnh|scene|kết\s*quả(?:\s*flow)?(?:\s*đã\s*tạo)?)\s*[:：\-–—]\s*/i, "")
  .replace(/\s+/g, " ")
  .trim();

export const flowDownloadTitleKey = value => {
  const cleaned = cleanFlowTitle(value);
  return String(cleaned || value || "")
    .split(/[\\/]/).pop()
    .replace(/\.(?:png|jpe?g|webp|gif|mp4|webm|mov|zip)$/i, "")
    .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
};

const pendingQueueFilenameOverrides = [];

export function flowDownloadBasename(value) {
  return String(value || "").split(/[\\/]/).pop().trim();
}

export function safeQueueFilenameStem(value) {
  let stem = flowDownloadBasename(value)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/g, "");
  if (!stem || stem === "." || stem === "..") return "";
  if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(stem)) stem = `_${stem}`;
  return stem;
}

export function queueDownloadExtension(downloadItem) {
  const nameExtension = flowDownloadBasename(downloadItem?.filename).match(/\.([a-z0-9]{1,10})$/i)?.[0];
  if (nameExtension && !/\.html?$/i.test(nameExtension)) return nameExtension.toLowerCase();
  const mime = String(downloadItem?.mime || "").split(";")[0].trim().toLowerCase();
  const byMime = new Map([
    ["image/jpeg", ".jpg"], ["image/png", ".png"], ["image/webp", ".webp"], ["image/gif", ".gif"],
    ["video/mp4", ".mp4"], ["video/webm", ".webm"], ["video/quicktime", ".mov"],
  ]);
  if (/\.html?$/i.test(nameExtension || "") && !byMime.has(mime)) return "";
  return byMime.get(mime) || nameExtension?.toLowerCase() || "";
}

// DL-06 (D13): armed tickets persist to chrome.storage.session on every
// arm/disarm/assignment, so a service-worker restart mid-download no
// longer loses the intended filename; initQueueDownloadListeners
// restores them (expired or malformed entries are dropped by
// restoreFilenameTicket). Session scope is deliberate: an armed rename
// is meaningful only for downloads of the current browser session.
// The write chain mirrors FlowMediaCatalog's discipline: snapshot
// synchronously, chain onto a rejection-guarded promise, so one failed
// write can neither wedge nor reorder later writes. All storage access
// is guarded — without chrome.storage the tickets simply stay
// memory-only, exactly the pre-DL-06 behavior.
let queueTicketPersistChain = Promise.resolve();

export function persistQueueFilenameOverrides() {
  const storage = globalThis.chrome?.storage?.session;
  if (!storage?.set) return Promise.resolve();
  const snapshot = {
    version: 1,
    updatedAt: Date.now(),
    tickets: pendingQueueFilenameOverrides.map(serializeFilenameTicket).filter(Boolean),
  };
  queueTicketPersistChain = queueTicketPersistChain
    .catch(() => {})
    .then(() => storage.set({ [FLOW_FILENAME_TICKETS_STORAGE_KEY]: snapshot }))
    .catch(() => {});
  return queueTicketPersistChain;
}

let queueTicketRestorePromise = null;

// Restore persisted tickets into the live array. Memoized per worker
// lifetime: the restore runs once, when the background initializes;
// repeat calls return the same promise (and the same restored count).
export function restoreQueueFilenameOverrides() {
  if (!queueTicketRestorePromise) queueTicketRestorePromise = (async () => {
    const storage = globalThis.chrome?.storage?.session;
    if (!storage?.get) return 0;
    try {
      const stored = await storage.get(FLOW_FILENAME_TICKETS_STORAGE_KEY);
      const state = stored?.[FLOW_FILENAME_TICKETS_STORAGE_KEY];
      if (!state || state.version !== 1 || !Array.isArray(state.tickets)) return 0;
      const now = Date.now();
      let restored = 0;
      for (const raw of state.tickets) {
        const ticket = restoreFilenameTicket(raw, now);
        if (!ticket) continue;
        const duplicate = pendingQueueFilenameOverrides.some(candidate =>
          candidate.jobId === ticket.jobId && candidate.flowMediaId === ticket.flowMediaId && candidate.armedAt === ticket.armedAt);
        if (duplicate) continue;
        pendingQueueFilenameOverrides.push(ticket);
        restored += 1;
      }
      return restored;
    } catch {
      return 0;
    }
  })();
  return queueTicketRestorePromise;
}

// DL-06 (D22): the durable per-project media id -> planned filename
// records. Lazily built singleton; null when chrome.storage.local is
// unavailable, in which case downloads simply derive names as before.
let filenameRecordsStore;
function getFilenameRecords() {
  if (filenameRecordsStore !== undefined) return filenameRecordsStore;
  try {
    const storage = globalThis.chrome?.storage?.local;
    if (!storage?.get || !storage?.set) {
      filenameRecordsStore = null;
      return null;
    }
    filenameRecordsStore = new FlowDownloadFilenameRecords({ storage });
  } catch {
    filenameRecordsStore = null;
  }
  return filenameRecordsStore;
}

// The relative path a ticket will suggest for its download: an exact
// planned filename (D22 record reuse) wins; otherwise the armed
// folder, when any, prefixes the assigned filename.
export function ticketSuggestedFilename(ticket) {
  if (!ticket) return "";
  if (ticket.plannedFilename) return ticket.plannedFilename;
  if (!ticket.assignedFilename) return "";
  return ticket.folder ? `${ticket.folder}/${ticket.assignedFilename}` : ticket.assignedFilename;
}

// Record a ticket's assigned name in the D22 store. Advisory only —
// failures are swallowed so the name store can never fail a download.
// Only names this extension actually imposed are recorded (an
// unassigned ticket has no planned name worth remembering).
function noteTicketFilenameAssigned(ticket) {
  if (!ticket?.flowProjectId || !ticket?.flowMediaId || !ticket?.assignedFilename) return;
  const records = getFilenameRecords();
  if (!records) return;
  const filename = ticketSuggestedFilename(ticket);
  if (!filename) return;
  void records.record({
    projectId: ticket.flowProjectId,
    mediaId: ticket.flowMediaId,
    folder: ticket.folder || "",
    filename,
  }).catch(() => {});
}

export function armQueueFilenameOverride({ jobId, flowMediaId, fileStem, flowTabId, flowProjectId, mediaKind, title, folder = "", plannedFilename = "" }) {
  const stem = safeQueueFilenameStem(fileStem);
  if (!stem || !String(jobId || "").trim() || !Number.isInteger(flowTabId) || !flowMediaId) return null;
  const cleanPlannedFilename = plannedFilename ? normalizePlannedDownloadPath(plannedFilename) : "";
  if (plannedFilename && !cleanPlannedFilename) return null;
  const ticket = {
    jobId: String(jobId || ""),
    flowMediaId: String(flowMediaId),
    fileStem: stem,
    folder: cleanPlannedFilename
      ? (cleanPlannedFilename.includes("/") ? cleanPlannedFilename.slice(0, cleanPlannedFilename.lastIndexOf("/")) : "")
      : (folder ? normalizePlanFolderPath(folder, "") : ""),
    plannedFilename: cleanPlannedFilename || null,
    flowTabId,
    flowProjectId: String(flowProjectId || ""),
    mediaKind: String(mediaKind || "").toLowerCase() === "scene" ? "video" : String(mediaKind || "").toLowerCase(),
    title: String(title || "").trim(),
    armedAt: Date.now(),
    baselineAt: Date.now(),
    triggerStartedAt: null,
    triggerConfirmedAt: null,
    expiresAt: Date.now() + 5 * 60_000,
    downloadId: null,
    assignedFilename: null,
  };
  pendingQueueFilenameOverrides.push(ticket);
  void persistQueueFilenameOverrides();
  return ticket;
}

export function disarmQueueFilenameOverride(ticket) {
  const index = pendingQueueFilenameOverrides.indexOf(ticket);
  if (index >= 0) {
    pendingQueueFilenameOverrides.splice(index, 1);
    void persistQueueFilenameOverrides();
  }
}

export function queueDownloadProjectId(downloadItem) {
  const sourceUrl = `${downloadItem?.url || ""} ${downloadItem?.finalUrl || ""} ${downloadItem?.referrer || ""}`;
  return sourceUrl.match(/\/project\/([0-9a-f-]{36})(?:[/?#\s]|$)/i)?.[1]?.toLowerCase() || "";
}

export function queueDownloadIsFlowPageUrl(value) {
  try {
    const raw = String(value || "");
    if (!raw) return false;
    if (raw.startsWith("blob:")) {
      return raw.includes("flow.google.com") || raw.includes("labs.google");
    }
    const url = new URL(raw);
    return (url.protocol === "https:" || url.protocol === "http:") && isFlowMediaHost(url.hostname);
  } catch { return false; }
}

export function queueDownloadMatchesTicket(downloadItem, ticket, allowTabTimeMatch = false, allowProjectTimeMatch = false) {
  if (!downloadItem || !ticket) return false;
  const sourceUrl = `${downloadItem.url || ""} ${downloadItem.finalUrl || ""} ${downloadItem.referrer || ""}`.toLowerCase();
  const mediaIdMatch = sourceUrl.includes(ticket.flowMediaId.toLowerCase());
  const sameTab = Number.isInteger(downloadItem.tabId) && Number.isInteger(ticket.flowTabId) && downloadItem.tabId === ticket.flowTabId;
  const projectId = queueDownloadProjectId(downloadItem);
  if (projectId && ticket.flowProjectId && projectId !== ticket.flowProjectId.toLowerCase()) return false;
  if (!sameTab && !(mediaIdMatch && (downloadItem.tabId === -1 || downloadItem.tabId === undefined))) {
    if (!allowProjectTimeMatch || (ticket.flowProjectId && projectId && projectId !== ticket.flowProjectId.toLowerCase())) return false;
    const startedAt = Date.parse(downloadItem.startTime || "");
    return Number.isFinite(startedAt) && startedAt >= ticket.baselineAt - 1_000;
  }
  if (mediaIdMatch) return true;
  if (!allowTabTimeMatch || !sameTab) return false;
  const startedAt = Date.parse(downloadItem.startTime || "");
  return Number.isFinite(startedAt) && startedAt >= ticket.baselineAt - 1_000;
}

export function queueDownloadMatchesTriggeredFlowItem(downloadItem, ticket, title) {
  if (!downloadItem || !ticket || (downloadItem.byExtensionId && downloadItem.byExtensionId !== chrome.runtime.id)) return false;
  const projectId = queueDownloadProjectId(downloadItem);
  if (projectId && ticket.flowProjectId && projectId !== ticket.flowProjectId.toLowerCase()) return false;
  const sameFlowTab = Number.isInteger(downloadItem.tabId) && Number.isInteger(ticket.flowTabId) && downloadItem.tabId === ticket.flowTabId;
  const flowReferrer = queueDownloadIsFlowPageUrl(downloadItem.referrer) || queueDownloadIsFlowPageUrl(downloadItem.url) || queueDownloadIsFlowPageUrl(downloadItem.finalUrl);
  const sameProject = Boolean(ticket.flowProjectId && projectId && projectId === ticket.flowProjectId.toLowerCase());
  const parsedStartedAt = Date.parse(downloadItem.startTime || "");
  const startedAt = Number.isFinite(parsedStartedAt) ? parsedStartedAt : Date.now();
  const lowerBound = Number(ticket.triggerStartedAt) || Number(ticket.baselineAt);
  const upperBound = Math.max(Number(ticket.expiresAt) || 0, (Number(ticket.triggerConfirmedAt) || Date.now()) + 5 * 60_000);
  if (!Number.isFinite(startedAt) || startedAt < lowerBound - 1_500 || startedAt > upperBound) return false;
  const extension = queueDownloadExtension(downloadItem);
  const compatibleExtension = ticket.mediaKind === "video"
    ? [".mp4", ".webm", ".mov"].includes(extension)
    : ticket.mediaKind === "image" && [".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(extension);
  if (extension && !compatibleExtension) return false;
  const titleKey = flowDownloadTitleKey(title);
  const rawTitleKey = String(title || "").split(/[\\/]/).pop().replace(/\.(?:png|jpe?g|webp|gif|mp4|webm|mov|zip)$/i, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const filenameKey = flowDownloadTitleKey(downloadItem.filename);
  const titleMatches = Boolean(
    (titleKey && filenameKey.startsWith(titleKey)) ||
    (rawTitleKey && filenameKey.startsWith(rawTitleKey)) ||
    (titleKey && filenameKey.includes(titleKey)) ||
    (filenameKey && titleKey.startsWith(filenameKey))
  );
  const hasFlowProvenance = sameFlowTab || flowReferrer || sameProject;
  return titleMatches || hasFlowProvenance;
}

export function claimQueueDownloadTicket(downloadItem) {
  if (!Number.isInteger(downloadItem?.id)) return null;
  const candidates = pendingQueueFilenameOverrides.filter(ticket => (!ticket.downloadId || ticket.downloadId === downloadItem.id) &&
    queueDownloadMatchesTriggeredFlowItem(downloadItem, ticket, ticket.title));
  if (candidates.length !== 1) return null;
  const ticket = candidates[0];
  const extension = queueDownloadExtension(downloadItem) || (ticket.mediaKind === "video" ? ".mp4" : ".jpg");
  ticket.downloadId = downloadItem.id;
  // A ticket carrying an exact planned filename (D22 record reuse)
  // keeps it as its assigned name; the suggestion is that path verbatim.
  ticket.assignedFilename = ticket.plannedFilename || `${ticket.fileStem}${extension}`;
  void persistQueueFilenameOverrides();
  noteTicketFilenameAssigned(ticket);
  return ticket;
}

export function initQueueDownloadListeners() {
  // DL-06: bring back any tickets persisted before a worker restart.
  void restoreQueueFilenameOverrides();
  chrome.downloads?.onCreated?.addListener(downloadItem => {
    claimQueueDownloadTicket(downloadItem);
  });
  chrome.downloads?.onDeterminingFilename?.addListener((downloadItem, suggest) => {
    const now = Date.now();
    let swept = false;
    for (let i = pendingQueueFilenameOverrides.length - 1; i >= 0; i--) {
      if (pendingQueueFilenameOverrides[i].expiresAt < now) {
        pendingQueueFilenameOverrides.splice(i, 1);
        swept = true;
      }
    }
    if (swept) void persistQueueFilenameOverrides();
    if (downloadItem?.byExtensionId && downloadItem.byExtensionId !== chrome.runtime.id) return;
    if (!Number.isInteger(downloadItem?.id)) return;
    const sourceUrl = `${downloadItem.url || ""} ${downloadItem.finalUrl || ""} ${downloadItem.referrer || ""}`;
    const mediaIdCandidates = pendingQueueFilenameOverrides.filter(ticket =>
      sourceUrl.toLowerCase().includes(ticket.flowMediaId.toLowerCase())
    );
    const exactCandidates = mediaIdCandidates.length
      ? mediaIdCandidates.filter(ticket => queueDownloadMatchesTicket(downloadItem, ticket))
      : [];
    if (exactCandidates.length > 1) return;
    const candidates = exactCandidates.length === 1
      ? exactCandidates
      : pendingQueueFilenameOverrides.filter(ticket => (!ticket.downloadId || ticket.downloadId === downloadItem.id) &&
        queueDownloadMatchesTriggeredFlowItem(downloadItem, ticket, ticket.title));
    if (candidates.length !== 1) return;
    const ticket = candidates[0];
    const extension = queueDownloadExtension(downloadItem) || (ticket.mediaKind === "video" ? ".mp4" : ".jpg");
    if (!extension) return;
    if (!ticket.downloadId) {
      ticket.downloadId = downloadItem.id;
      ticket.assignedFilename = ticket.plannedFilename || `${ticket.fileStem}${extension}`;
      noteTicketFilenameAssigned(ticket);
    } else if (ticket.downloadId !== downloadItem.id) {
      return;
    }
    const suggestedFilename = ticketSuggestedFilename(ticket);
    if (!suggestedFilename) return;
    disarmQueueFilenameOverride(ticket);
    suggest({ filename: suggestedFilename, conflictAction: "uniquify" });
  });
}

// DL-05: interrupted-download classification + in-place resume (study
// D16/D17). Chrome reports an interruption reason on the download item;
// only transient network/transport-class reasons may resume, and only
// when Chrome itself says the download can resume. Identity/provenance,
// auth/policy and integrity reasons never resume; unknown reasons fail
// closed as fatal. (The reference reads its retry budget from server
// execution config — blocked, DL-B5 — so ours is a small local constant,
// mirrored in src/native-downloads.ts.)
export const FLOW_DOWNLOAD_RESUME_BUDGET = 3;

const TRANSIENT_DOWNLOAD_INTERRUPTIONS = new Set([
  "NETWORK_FAILED", "NETWORK_TIMEOUT", "NETWORK_DISCONNECTED", "NETWORK_SERVER_DOWN",
  "SERVER_FAILED", "SERVER_UNREACHABLE", "SERVER_NO_RANGE", "SERVER_CONTENT_LENGTH_MISMATCH",
  "FILE_TRANSIENT_ERROR", "CRASH",
]);

export function classifyDownloadInterruption(error, canResume) {
  const reason = String(error || "").trim().toUpperCase() || "UNKNOWN";
  const transient = TRANSIENT_DOWNLOAD_INTERRUPTIONS.has(reason);
  return {
    category: transient ? "transient" : "fatal",
    reason,
    resumable: transient && canResume === true,
  };
}

function queueDownloadFailure(title, item, classification, resumeAttempts) {
  return Object.assign(new Error(`Chrome download failed for "${title}": ${item?.error || "unknown error"}. The media remains in Flow.`), {
    code: "FLOW_DOWNLOAD_FAILED", outcomeUnknown: false, outcome_unknown: false,
    downloadInterruption: {
      reason: classification.reason,
      category: classification.category,
      canResume: item?.canResume === true,
      resumable: classification.resumable,
      resumeAttempts,
      resumeBudget: FLOW_DOWNLOAD_RESUME_BUDGET,
    },
  });
}

// Resume one interrupted download in place, or throw the standard
// FLOW_DOWNLOAD_FAILED carrying the last error. The caller has already
// matched the item to its ticket on this poll, and its loop re-runs the
// same matching after the resume — ticket identity is re-verified before
// the download can complete. A resume re-arms nothing watermark-related:
// DL-03 contexts are single-use and belong to the original attempt, and
// the recorded watermark outcome stays the original trigger's.
async function resumeInterruptedQueueDownload(resumeState, item, title) {
  const classification = classifyDownloadInterruption(item?.error, item?.canResume);
  if (!classification.resumable || resumeState.attempts >= FLOW_DOWNLOAD_RESUME_BUDGET ||
      !Number.isInteger(item?.id) || typeof chrome.downloads?.resume !== "function") {
    throw queueDownloadFailure(title, item, classification, resumeState.attempts);
  }
  resumeState.attempts += 1;
  let resumeRefused = false;
  try { await chrome.downloads.resume(item.id); } catch { resumeRefused = true; }
  if (!resumeRefused) return;
  // Chrome refused the resume call itself. Believe that only when the
  // item is still interrupted — a lagging snapshot can show the
  // pre-resume state for an item that is already moving again.
  let current = null;
  try { [current] = await chrome.downloads.search({ id: item.id }); } catch {}
  if (current?.state === "interrupted") {
    throw queueDownloadFailure(title, current, classifyDownloadInterruption(current.error, current.canResume), resumeState.attempts);
  }
  if (!current) throw queueDownloadFailure(title, item, classification, resumeState.attempts);
}

export async function throwIfQueueDownloadAborted(signal, title, downloadId = null) {
  if (!signal?.aborted) return;
  if (Number.isInteger(downloadId)) {
    try { await chrome.downloads?.cancel?.(downloadId); } catch {}
  }
  throw Object.assign(new Error(`Queue stopped waiting for the browser download of "${title}". The generated media remains in Flow.`), {
    code: "FLOW_QUEUE_CANCELLED", outcomeUnknown: false, outcome_unknown: false,
  });
}

export async function waitForQueueFlowDownload(beforeIds, title, timeoutMs = 12 * 60_000, filenameTicket = null, signal = null) {
  if (!chrome.downloads?.search) throw Object.assign(new Error("Chrome download tracking is unavailable; the generated media remains in Flow."), {
    code: "FLOW_DOWNLOAD_TRACKING_UNAVAILABLE", outcomeUnknown: false, outcome_unknown: false,
  });
  const deadline = Date.now() + timeoutMs;
  const titleKey = flowDownloadTitleKey(title);
  let lastNew = [];
  const resumeState = { attempts: 0 };
  while (Date.now() < deadline) {
    await throwIfQueueDownloadAborted(signal, title, filenameTicket?.downloadId);
    if (Number.isInteger(filenameTicket?.downloadId)) {
      const [claimed] = await chrome.downloads.search({ id: filenameTicket.downloadId });
      if (claimed?.state === "interrupted") await resumeInterruptedQueueDownload(resumeState, claimed, title);
      if (claimed?.state === "complete" && claimed.filename) return {
        id: claimed.id,
        filename: claimed.filename,
        matchedByQueueTicket: true,
        matchedBy: "download_id",
      };
    }
    const items = await chrome.downloads.search({ orderBy: ["-startTime"], limit: 100 });
    const newItems = items.filter(item => !beforeIds.has(item.id));
    if (filenameTicket) {
      let matching = newItems.filter(item => item.id === filenameTicket.downloadId || queueDownloadMatchesTicket(item, filenameTicket, true, true));
      let matchedByTriggeredFilename = false;
      if (!matching.length) {
        const triggeredMatches = newItems.filter(item => queueDownloadMatchesTriggeredFlowItem(item, filenameTicket, title));
        if (triggeredMatches.length === 1) {
          matching = triggeredMatches;
          matchedByTriggeredFilename = true;
        } else if (triggeredMatches.length > 1) {
          throw Object.assign(new Error(`Chrome reported multiple new ${filenameTicket.mediaKind || "Flow"} downloads matching "${title}" after the Flow download action; refusing to attach an ambiguous file to this job.`), {
            code: "FLOW_DOWNLOAD_AMBIGUOUS", outcomeUnknown: false, outcome_unknown: false,
          });
        }
      }
      if (!matching.length) {
        const flowNewMatches = newItems.filter(item => {
          const isFlow = queueDownloadIsFlowPageUrl(item.referrer) || queueDownloadIsFlowPageUrl(item.url) || queueDownloadIsFlowPageUrl(item.finalUrl);
          const ext = queueDownloadExtension(item);
          const compExt = !ext || (filenameTicket.mediaKind === "video"
            ? [".mp4", ".webm", ".mov"].includes(ext)
            : [".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext));
          return isFlow && compExt;
        });
        if (flowNewMatches.length === 1) {
          matching = flowNewMatches;
          matchedByTriggeredFilename = true;
        }
      }
      lastNew = matching;
      if (matching.length > 1) {
        throw Object.assign(new Error(`Chrome reported multiple new downloads from the Flow queue tab for "${title}"; refusing to attach an ambiguous file to this job. The media remains in Flow.`), {
          code: "FLOW_DOWNLOAD_AMBIGUOUS", outcomeUnknown: false, outcome_unknown: false,
        });
      }
      const candidate = matching[0];
      if (candidate?.state === "interrupted") await resumeInterruptedQueueDownload(resumeState, candidate, title);
      if (candidate?.state === "complete" && candidate.filename) {
        if (!filenameTicket.downloadId) filenameTicket.downloadId = candidate.id;
        return { id: candidate.id, filename: candidate.filename, matchedByQueueTicket: true, ...(matchedByTriggeredFilename ? { matchedBy: "triggered_flow_filename" } : {}) };
      }
      await new Promise(resolve => setTimeout(resolve, 250));
      continue;
    }
    const flowItems = newItems.filter(item => flowUrl(item.referrer) || flowUrl(item.url) || flowUrl(item.finalUrl));
    lastNew = flowItems;
    const matching = titleKey
      ? flowItems.filter(item => flowDownloadTitleKey(item.filename) === titleKey)
      : [];
    if (flowItems.length > 1 || matching.length > 1) {
      throw Object.assign(new Error(`Chrome reported multiple possible Flow downloads for "${title}"; refusing to attach an ambiguous file to this queue job. The media remains in Flow.`), {
        code: "FLOW_DOWNLOAD_AMBIGUOUS", outcomeUnknown: false, outcome_unknown: false,
      });
    }
    if (Number.isInteger(filenameTicket?.downloadId)) {
      const exact = newItems.find(item => item.id === filenameTicket.downloadId);
      if (exact?.state === "interrupted") await resumeInterruptedQueueDownload(resumeState, exact, title);
      if (exact?.state === "complete" && exact.filename) return { id: exact.id, filename: exact.filename };
      await new Promise(resolve => setTimeout(resolve, 750));
      continue;
    }
    const candidates = flowItems.length === 1 && matching.length === 1 ? matching : [];
    const interrupted = candidates.find(item => item.state === "interrupted");
    if (interrupted) await resumeInterruptedQueueDownload(resumeState, interrupted, title);
    const complete = candidates.find(item => item.state === "complete" && item.filename);
    if (complete) return { id: complete.id, filename: complete.filename };
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  const active = lastNew.find(item => item.state === "in_progress");
  const detail = active ? `Chrome download ${active.bytesReceived || 0}/${active.totalBytes || "?"} bytes` : "Chrome did not report a new Flow download";
  throw Object.assign(new Error(`Flow media "${title}" was generated, but its browser download did not complete before the timeout (${detail}). The media remains in Flow.`), {
    code: "FLOW_DOWNLOAD_FAILED", outcomeUnknown: false, outcome_unknown: false,
  });
}

export async function findExistingQueueFlowDownload(flowMediaId, flowTabId, flowProjectId) {
  if (!chrome.downloads?.search || !flowMediaId || !Number.isInteger(flowTabId)) return null;
  const ticket = {
    flowMediaId: String(flowMediaId),
    flowTabId,
    flowProjectId: String(flowProjectId || ""),
  };
  const items = await chrome.downloads.search({ query: [String(flowMediaId)], orderBy: ["-startTime"], limit: 100 });
  const matching = items.filter(item => queueDownloadMatchesTicket(item, ticket));
  return matching.find(item => item.state === "complete") ||
    matching.find(item => item.state === "in_progress") ||
    matching.find(item => item.state === "interrupted") || null;
}

export async function waitForExistingQueueFlowDownload(downloadId, flowMediaId, flowTabId, flowProjectId, title, timeoutMs = 3 * 60_000, signal = null) {
  const ticket = { flowMediaId: String(flowMediaId), flowTabId, flowProjectId: String(flowProjectId || "") };
  const deadline = Date.now() + timeoutMs;
  const resumeState = { attempts: 0 };
  while (Date.now() < deadline) {
    await throwIfQueueDownloadAborted(signal, title, downloadId);
    const items = await chrome.downloads.search({ id: downloadId });
    const item = items.find(candidate => candidate.id === downloadId);
    if (!item) throw Object.assign(new Error(`Chrome no longer reports the in-progress download for "${title}". The generated media remains in Flow.`), {
      code: "FLOW_DOWNLOAD_TRACKING_UNAVAILABLE", outcomeUnknown: false, outcome_unknown: false,
    });
    if (!queueDownloadMatchesTicket(item, ticket)) throw Object.assign(new Error(`Chrome download identity changed while resuming "${title}"; refusing to attach an unrelated file. The generated media remains in Flow.`), {
      code: "FLOW_DOWNLOAD_IDENTITY_MISMATCH", outcomeUnknown: false, outcome_unknown: false,
    });
    // Identity was verified for this sighting above; after a resume the
    // loop re-verifies it before the item can complete (DL-05).
    if (item.state === "interrupted") await resumeInterruptedQueueDownload(resumeState, item, title);
    if (item.state === "complete" && item.filename) return { id: item.id, filename: item.filename, matchedByQueueTicket: true };
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw Object.assign(new Error(`Chrome download for "${title}" was still in progress after the resume timeout. The generated media remains in Flow.`), {
    code: "FLOW_DOWNLOAD_FAILED", outcomeUnknown: false, outcome_unknown: false,
  });
}

// DL-03: map the download op's watermark fields (DL-01: mode / armed /
// cleaned, plus the per-download attribution status / outcomeReason when
// the interceptor reported one) into the job-result status shape. The
// status describes the SAVED file: "cleaned" when cleaning changed the
// bytes, "original" when the saved bytes are the untouched original
// (by mode, by config, or because no watermark was found), "failed" when
// a cleaning attempt ran and failed, and "unknown" when an armed clean
// produced no attributable outcome — never an invented success.
// DL-02 (W11): video watermark cleaning NEVER runs in this service
// worker. The frame pipeline lives in a page context
// (content/bridge/video-watermark-cleaner.js); the background's job is
// only to route the request there and record the outcome the page
// reports (queueWatermarkResult below). Callers treat the delegation
// as a routing signal, not as a failure of the media.
export const FLOW_VIDEO_WATERMARK_MAX_INPUT_BYTES = 300 * 1024 * 1024;

export function queueVideoWatermarkRoute({ kind, mode } = {}) {
  const normalizedKind = String(kind || "").toLowerCase() === "scene" ? "video" : String(kind || "").toLowerCase();
  const normalizedMode = typeof mode === "string" && mode ? mode : "original";
  if (normalizedMode !== "clean") {
    return { route: "none", context: "page", serviceWorker: false, delegated: false, kind: normalizedKind || null, mode: normalizedMode, reason: "clean_not_requested" };
  }
  if (normalizedKind === "video") {
    return { route: "video-frame-pipeline", context: "page", serviceWorker: false, delegated: true, kind: "video", mode: "clean", reason: "video_cleaning_page_context_only", maxInputBytes: FLOW_VIDEO_WATERMARK_MAX_INPUT_BYTES };
  }
  return { route: "media-interceptor", context: "page", serviceWorker: false, delegated: true, kind: normalizedKind || null, mode: "clean", reason: "image_cleaning_page_context_only" };
}

// DL-02: the video fields that may ride an op watermark outcome into
// the recorded job result — the page cleaner's output bookkeeping
// (frames, re-detections, untouched audio packets, source duration).
// Only finite numbers (and the warning string) are recorded; anything
// else the page sent is dropped rather than persisted verbatim.
const QUEUE_VIDEO_WATERMARK_FIELDS = ["framesProcessed", "framesCleaned", "framesWithoutWatermark", "verificationFailures", "redetections", "redetectionRatio", "audioPacketsCopied", "durationMs", "sampleCount"];

export function queueWatermarkResult(opWatermark) {
  if (!opWatermark || typeof opWatermark !== "object") return undefined;
  const mode = typeof opWatermark.mode === "string" ? opWatermark.mode : "original";
  const armed = opWatermark.armed === true;
  const cleaned = opWatermark.cleaned === true ? true : opWatermark.cleaned === false ? false : null;
  let status = typeof opWatermark.status === "string" && opWatermark.status ? opWatermark.status : null;
  if (!status) {
    if (cleaned === true) status = "cleaned";
    else if (armed && mode === "clean") status = cleaned === false ? "original" : "unknown";
    else status = "original";
  }
  const outcomeReason = typeof opWatermark.outcomeReason === "string" && opWatermark.outcomeReason ? opWatermark.outcomeReason : null;
  const armReason = typeof opWatermark.reason === "string" && opWatermark.reason ? opWatermark.reason : null;
  const reason = status === "cleaned" ? outcomeReason : (outcomeReason || armReason);
  const recorded = {
    mode,
    armed,
    cleaned,
    status,
    ...(reason ? { reason } : {}),
    ...(typeof opWatermark.operationId === "string" && opWatermark.operationId ? { operationId: opWatermark.operationId } : {}),
  };
  // DL-02: kind + video bookkeeping are recorded only when the op
  // outcome actually carried them — the DL-01/DL-03 image shape above
  // is byte-identical for image downloads.
  if (typeof opWatermark.kind === "string" && opWatermark.kind) recorded.kind = opWatermark.kind;
  if (opWatermark.video && typeof opWatermark.video === "object") {
    const video = {};
    for (const field of QUEUE_VIDEO_WATERMARK_FIELDS) {
      if (Number.isFinite(opWatermark.video[field])) video[field] = opWatermark.video[field];
    }
    if (typeof opWatermark.video.warning === "string" && opWatermark.video.warning) video.warning = opWatermark.video.warning;
    if (Object.keys(video).length) recorded.video = video;
  }
  return recorded;
}

// DL-06: extract the optional filename-plan settings (template, root
// folder, per-task subfolder) from a job's payload/params/metadata.
// Returns null when nothing plan-shaped is configured — downloads then
// derive stems and folders exactly as they did before DL-06.
export function queueDownloadPlanOptions({ payload = {}, params = {}, metadata = {} } = {}) {
  const pick = (...values) => values.find(value => typeof value === "string" && value.trim())?.trim();
  const template = pick(params.filename_template, payload.filename_template, metadata.filename_template,
    params.download_filename_template, payload.download_filename_template, metadata.download_filename_template);
  const rootFolder = pick(params.download_root_folder, params.download_folder,
    payload.download_root_folder, payload.download_folder, metadata.download_root_folder, metadata.download_folder);
  const subfolder = pick(params.download_subfolder, params.task_folder,
    payload.download_subfolder, payload.task_folder, metadata.download_subfolder, metadata.task_folder);
  const projectName = pick(params.project_name, payload.project_name, metadata.project_name);
  if (!template && !rootFolder && !subfolder) return null;
  const resolution = pick(params.download_resolution, payload.download_resolution, metadata.download_resolution);
  return {
    ...(template ? { template } : {}),
    ...(rootFolder ? { rootFolder } : {}),
    ...(subfolder ? { subfolder } : {}),
    ...(projectName ? { projectName } : {}),
    ...(resolution ? { resolution } : {}),
  };
}

export async function downloadQueueMedia(media, outputDir, fileStem, quality, invoke, hooks, sceneNumbers = [], jobId = "", flowTabId, flowProjectId = "", generationState = null, watermarkMode = undefined, planOptions = null) {
  if (!chrome.downloads?.search) throw Object.assign(new Error("Chrome download tracking is unavailable; the generated media remains in Flow."), {
    code: "FLOW_DOWNLOAD_TRACKING_UNAVAILABLE", outcomeUnknown: false, outcome_unknown: false,
  });
  // DL-06 (D12): one plan per batch — a single shared timestamp, the
  // template applied per item, and the planned root/task folder. The
  // plan only supplies stems + folder; the existing stem derivation
  // stays the fallback whenever no plan is configured.
  const downloadPlan = planOptions
    ? buildFlowDownloadPlan(media.map(item => ({
      project: planOptions.projectName || flowProjectId,
      prompt: String(item?.title || item?.name || ""),
      kind: String(item?.kind || item?.type || ""),
      resolution: planOptions.resolution,
    })), planOptions)
    : null;
  const filenameRecords = getFilenameRecords();
  const browserDownloads = [];
  try {
    for (const [index, item] of media.entries()) {
      const title = String(item?.title || item?.name || "").trim();
      const flowMediaId = String(item?.id || "").trim();
      if (!title || !flowMediaId || flowMediaId.startsWith("title:")) throw Object.assign(new Error("Flow generated media without a verified task-owned media ID and title, so its download could not be matched safely. The media remains in Flow."), {
        code: "FLOW_DOWNLOAD_ASSET_TITLE_MISSING", outcomeUnknown: false, outcome_unknown: false,
      });
      if (media.slice(0, index).some(previous => String(previous?.id || "").toLowerCase() === flowMediaId.toLowerCase())) throw Object.assign(new Error(`Flow returned duplicate task media identity "${flowMediaId}"; refusing to download the same or ambiguous result twice. The media remains in Flow.`), {
        code: "FLOW_DOWNLOAD_MEDIA_ID_DUPLICATE", outcomeUnknown: false, outcome_unknown: false,
      });
      const sceneNumber = Number(sceneNumbers[index]);
      let outputStem = Number.isSafeInteger(sceneNumber) && sceneNumber > 0
        ? `scene-${String(sceneNumber).padStart(2, "0")}`
        : media.length > 1 ? `${fileStem}-v${index + 1}` : fileStem;
      // DL-06: the batch plan (when configured) supplies this item's
      // stem + folder; a D22 record for this exact media then overrides
      // both with the name the media was first downloaded under, so a
      // re-download lands under the identical folder+filename.
      let ticketFolder = "";
      let plannedFilename = "";
      if (downloadPlan) {
        const planItem = downloadPlan.items[index];
        if (planItem) {
          outputStem = planItem.fileStem;
          ticketFolder = planItem.folder;
        }
      }
      if (filenameRecords && flowProjectId) {
        const record = await filenameRecords.lookup(flowProjectId, flowMediaId).catch(() => null);
        if (record?.filename) {
          plannedFilename = record.filename;
          ticketFolder = record.folder || ticketFolder;
        }
      }
      const existing = await findExistingQueueFlowDownload(flowMediaId, flowTabId, flowProjectId);
      if (existing) {
        const resumed = existing.state === "in_progress"
          ? await waitForExistingQueueFlowDownload(existing.id, flowMediaId, flowTabId, flowProjectId, title, quality === "upscaled" ? 12 * 60_000 : 3 * 60_000, hooks.signal)
          : existing.state === "complete" && existing.filename
            ? { id: existing.id, filename: existing.filename, matchedByQueueTicket: true }
            : null;
        if (resumed) {
          browserDownloads.push({
            ...resumed,
            downloadId: resumed.id,
            flowMediaId,
            taskId: String(jobId || "").trim() || undefined,
            title,
            filenameOverrideApplied: false,
            fileStem: outputStem,
          });
          continue;
        }
      }
      const before = await chrome.downloads.search({ orderBy: ["-startTime"], limit: 100 });
      const beforeIds = new Set(before.map(download => download.id));
      let filenameTicket = null;
      try {
        const itemKind = String(item?.kind || item?.type || "").toLowerCase();
        const mediaLabel = itemKind === "video" || itemKind === "scene" ? "video" : itemKind === "image" ? "image" : "media";
        await hooks.progress({
          phase: "download",
          message: `Downloading ${mediaLabel} ${index + 1}/${media.length} from Flow…`,
          percent: 90 + Math.floor(index * 9 / Math.max(1, media.length)),
          generation: generationState,
          download: { state: "downloading", completed: index, total: media.length, current: { id: flowMediaId, title } },
        });
        filenameTicket = armQueueFilenameOverride({
          jobId, flowMediaId, fileStem: outputStem, flowTabId, flowProjectId, mediaKind: itemKind, title,
          folder: ticketFolder, plannedFilename,
        });
        if (!filenameTicket) throw Object.assign(new Error(`Could not safely arm the requested filename for task ${jobId || "(unknown)"} and Flow media ${flowMediaId}; no download was started.`), {
          code: "FLOW_DOWNLOAD_FILENAME_ARM_FAILED", outcomeUnknown: false, outcome_unknown: false,
        });
        let triggered;
        try {
          filenameTicket.triggerStartedAt = Date.now();
          triggered = await invoke("flow.asset.download", { id: item.id, name: title, quality, ...(watermarkMode ? { watermarkMode } : {}) });
          filenameTicket.triggerConfirmedAt = Date.now();
        } catch (cause) {
          throw Object.assign(new Error(`Flow generated "${title}", but did not start its download: ${String(cause?.message || cause)}. The media remains in Flow.`), {
            code: cause?.code || "FLOW_DOWNLOAD_TRIGGER_FAILED", outcomeUnknown: false, outcome_unknown: false,
          });
        }
        if (!triggered?.downloadTriggered) throw Object.assign(new Error(`Flow generated "${title}", but did not confirm that its download started. The media remains in Flow.`), {
          code: "FLOW_DOWNLOAD_TRIGGER_FAILED", outcomeUnknown: false, outcome_unknown: false,
        });
        let download;
        try {
          download = await waitForQueueFlowDownload(beforeIds, title, quality === "upscaled" ? 12 * 60_000 : 3 * 60_000, filenameTicket, hooks.signal);
        } catch (cause) {
          throw Object.assign(new Error(String(cause?.message || cause)), {
            code: cause?.code || "FLOW_DOWNLOAD_FAILED", outcomeUnknown: false, outcome_unknown: false,
          });
        }
        if (filenameTicket.downloadId && filenameTicket.downloadId !== download.id) throw Object.assign(new Error(`Chrome returned a different download ID than the Flow queue ticket for "${title}"; refusing to attach an unrelated file to this job. The media remains in Flow.`), {
          code: "FLOW_DOWNLOAD_FILENAME_UNCONFIRMED", outcomeUnknown: false, outcome_unknown: false,
        });
        if (download.matchedByQueueTicket !== true && filenameTicket.downloadId !== download.id) throw Object.assign(new Error(`Chrome downloaded Flow media "${title}" but its exact queue download could not be confirmed; the original browser filename was preserved. The generated media remains in Flow.`), {
          code: "FLOW_DOWNLOAD_FILENAME_UNCONFIRMED", outcomeUnknown: false, outcome_unknown: false,
        });
        if (!filenameTicket.downloadId) filenameTicket.downloadId = download.id;
        const filenameOverrideApplied = Boolean(filenameTicket.assignedFilename && filenameTicket.downloadId === download.id);
        browserDownloads.push({
          ...download,
          downloadId: download.id,
          flowMediaId,
          taskId: String(jobId || "").trim() || undefined,
          title,
          filenameOverrideApplied,
          fileStem: outputStem,
          ...(triggered?.watermark ? { watermark: queueWatermarkResult(triggered.watermark) } : {}),
        });
      } finally {
        if (filenameTicket) disarmQueueFilenameOverride(filenameTicket);
      }
    }
  } catch (error) {
    error.browserDownloads = browserDownloads;
    throw error;
  }
  return browserDownloads;
}

export async function withQueueDownloads(job, payload, operationResult, invoke, hooks) {
  const params = payload?.params && typeof payload.params === "object" ? payload.params : {};
  const outputDir = job.metadata?.output_dir || payload.output_dir || params.output_dir;
  const requestedFileStem = job.metadata?.file_stem || payload.file_stem || params.file_stem;
  const submitOnly = payload.submitOnly === true || payload.submit_only === true || params.submit_only === true;
  if (submitOnly) return operationResult;
  const media = flowResultMedia(operationResult);
  if (!media.length) return operationResult;
  const kind = payload.type === "video" || params.type === "video" ? "video" : "image";
  const fallbackLabel = job.label || payload.prompt || params.prompt || `flow-${kind}`;
  const fallbackStem = String(fallbackLabel)
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001F]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 96);
  const fileStem = typeof requestedFileStem === "string" && requestedFileStem.trim()
    ? requestedFileStem.trim()
    : (fallbackStem || `flow-${kind}-${String(job.id || crypto.randomUUID()).slice(0, 8)}`);
  const generationState = {
    state: "completed",
    count: media.length,
    media: media.map(item => ({
      id: String(item?.id || ""),
      title: String(item?.title || item?.name || "").trim(),
      kind: String(item?.kind || item?.type || kind).toLowerCase(),
    })),
  };
  const autoDownloadValues = [payload.autoDownload, payload.auto_download, params.autoDownload, params.auto_download];
  const autoDownload = autoDownloadValues.some(value => value === false)
    ? false
    : autoDownloadValues.some(value => value === true) ? true : undefined;
  if (autoDownload === false) {
    await hooks.progress({
      phase: "generation_complete",
      message: `Flow generated ${media.length} result${media.length === 1 ? "" : "s"}. Automatic download is off.`,
      percent: 100,
      generation: generationState,
      download: { state: "skipped", completed: 0, total: media.length },
    });
    return { ...operationResult, autoDownload: false };
  }
  await hooks.progress({
    phase: "generation_complete",
    message: `Flow generation completed: ${media.length} result${media.length === 1 ? "" : "s"}. Starting download…`,
    percent: 89,
    generation: generationState,
    download: { state: "queued", completed: 0, total: media.length },
  });
  try {
    const sceneNumbers = Array.isArray(operationResult?.sceneNumbers) && operationResult.sceneNumbers.length === media.length
      ? operationResult.sceneNumbers
      : [];
    const browserDownloads = await downloadQueueMedia(media, outputDir || "", fileStem, params.download_quality || payload.download_quality || "original", invoke, hooks, sceneNumbers, job.id, job.metadata?.flowTabId, job.metadata?.flowProjectId, generationState, params.watermark_mode || payload.watermark_mode || params.watermarkMode || payload.watermarkMode || undefined, queueDownloadPlanOptions({ payload, params, metadata: job.metadata || {} }));
    await hooks.progress({
      phase: "download_complete",
      message: `Flow generated and downloaded ${media.length} result${media.length === 1 ? "" : "s"}.`,
      percent: 99,
      generation: generationState,
      download: { state: "completed", completed: media.length, total: media.length },
    });
    return { ...operationResult, browserDownloads };
  } catch (error) {
    const downloadedCount = Array.isArray(error?.browserDownloads) ? error.browserDownloads.length : 0;
    try {
      await hooks.progress({
        phase: "download_failed",
        message: `Flow created ${media.length} result${media.length === 1 ? "" : "s"}, but download stopped at ${downloadedCount}/${media.length}: ${String(error?.message || error).slice(0, 700)}`,
        percent: 90 + Math.floor(downloadedCount * 9 / Math.max(1, media.length)),
        generation: generationState,
        download: { state: "failed", completed: downloadedCount, total: media.length, error: String(error?.message || error).slice(0, 700) },
      });
    } catch (progressError) {
      console.warn("[FlowQueue] Could not persist generated/download stage details:", progressError?.message || progressError);
    }
    return {
      ...operationResult,
      browserDownloads: Array.isArray(error?.browserDownloads) ? error.browserDownloads : [],
      downloadError: String(error?.message || error).slice(0, 700),
      downloadErrorCode: String(error?.code || "FLOW_DOWNLOAD_FAILED"),
    };
  }
}

export function queueCompletionProgress(result, message) {
  if (result?.downloadError) {
    return {
      phase: "download_failed",
      message: `${message} Automatic download failed; the generated media is still available in Flow.`,
      percent: 100,
    };
  }
  if (result?.autoDownload === false) {
    return { phase: "complete", message: `${message} Automatic download is off.`, percent: 100 };
  }
  return { phase: "complete", message, percent: 100 };
}

export function generatedMediaForQueueJob(job) {
  const checkpointMedia = job?.metadata?.generationResultCheckpoint?.media;
  const result = job?.result?.result || job?.result || {};
  const media = Array.isArray(checkpointMedia) && checkpointMedia.length ? checkpointMedia : flowResultMedia(result);
  return media.map(item => ({
    id: String(item?.id || "").trim(),
    title: String(item?.title || item?.name || "").trim(),
    kind: String(item?.kind || item?.type || "").toLowerCase() === "scene" ? "video" : String(item?.kind || item?.type || "").toLowerCase(),
  })).filter(item => item.id && item.title && ["image", "video"].includes(item.kind));
}

export async function downloadGeneratedQueueJob(job, payload, invoke, hooks, flowJobQueue) {
  const sourceId = String(payload?.sourceJobId || "").trim();
  const sourceJob = sourceId ? await flowJobQueue.get(sourceId) : null;
  if (!sourceJob || !["completed", "failed"].includes(sourceJob.status)) {
    throw Object.assign(new Error("The original Flow task is missing or has not finished yet."), { code: "FLOW_QUEUE_DOWNLOAD_SOURCE_UNAVAILABLE", outcomeUnknown: false });
  }
  const media = generatedMediaForQueueJob(sourceJob);
  if (!media.length) {
    throw Object.assign(new Error("This Flow task has no verified generated media to download."), { code: "FLOW_QUEUE_DOWNLOAD_MEDIA_UNAVAILABLE", outcomeUnknown: false });
  }
  const params = sourceJob.payload?.params && typeof sourceJob.payload.params === "object" ? sourceJob.payload.params : {};
  const requestedFileStem = sourceJob.metadata?.file_stem || sourceJob.payload?.file_stem || params.file_stem;
  const kind = media[0].kind;
  const fallbackLabel = sourceJob.label || sourceJob.payload?.prompt || `flow-${kind}`;
  const fallbackStem = String(fallbackLabel)
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001F]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 96);
  const fileStem = typeof requestedFileStem === "string" && requestedFileStem.trim()
    ? requestedFileStem.trim()
    : (fallbackStem || `flow-${kind}-${String(sourceJob.id).slice(0, 8)}`);
  const generation = { state: "completed", count: media.length, media };
  const setSourceDownload = (state, completed, message, current) => flowJobQueue.updateGeneratedMediaDownload(sourceJob.id, {
    state, completed, total: media.length, ...(current ? { current } : {}),
  }, message);
  await setSourceDownload("downloading", 0, `Downloading ${media.length} existing Flow result${media.length === 1 ? "" : "s"}…`);
  const progressHooks = {
    signal: hooks.signal,
    progress: async progress => {
      await hooks.progress(progress);
      if (progress?.download) {
        const state = progress.download.state;
        const completed = Number(progress.download.completed) || 0;
        const current = progress.download.current;
        await setSourceDownload(state, completed, progress.message || "Downloading existing Flow results…", current);
      }
    },
  };
  const operationResult = sourceJob.result?.result || sourceJob.result || {};
  const sceneNumbers = Array.isArray(operationResult?.sceneNumbers) && operationResult.sceneNumbers.length === media.length
    ? operationResult.sceneNumbers
    : [];
  try {
    const browserDownloads = await downloadQueueMedia(
      media,
      sourceJob.metadata?.output_dir || sourceJob.payload?.output_dir || params.output_dir || "",
      fileStem,
      params.download_quality || sourceJob.payload?.download_quality || "original",
      invoke,
      progressHooks,
      sceneNumbers,
      sourceJob.id,
      job.metadata?.flowTabId,
      job.metadata?.flowProjectId,
      generation,
      params.watermark_mode || sourceJob.payload?.watermark_mode || params.watermarkMode || sourceJob.payload?.watermarkMode || undefined,
      queueDownloadPlanOptions({ payload: sourceJob.payload || {}, params, metadata: sourceJob.metadata || {} }),
    );
    await setSourceDownload("completed", media.length, `Downloaded ${media.length} existing Flow result${media.length === 1 ? "" : "s"}.`);
    return { completed: true, downloadOnly: true, sourceJobId: sourceJob.id, browserDownloads };
  } catch (error) {
    const completed = Array.isArray(error?.browserDownloads) ? error.browserDownloads.length : 0;
    await setSourceDownload("failed", completed, `Download failed at ${completed}/${media.length}: ${String(error?.message || error).slice(0, 700)}.`);
    throw Object.assign(error, { outcomeUnknown: false, requestDispatched: false, retryable: false });
  }
}
