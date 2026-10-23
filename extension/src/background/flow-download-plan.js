// flow-download-plan.js
// DL-06 — Filename/folder planning for queue downloads (study D12/D13/
// D22, gap G6). Logic adapted from the reference extension's download
// planning design, implemented fresh:
//
//  - buildFlowDownloadPlan: one plan per batch with ONE shared
//    timestamp; filenames are built from a template with
//    date/time/project/prompt/index/kind tokens; files land in a
//    configured root folder plus an optional per-task subfolder.
//  - serializeFilenameTicket / restoreFilenameTicket: the (de)seriali-
//    zation pair that lets armed rename tickets persist to
//    chrome.storage.session and survive a service-worker restart.
//  - FlowDownloadFilenameRecords: a durable per-project store mapping
//    media id -> the filename planned when the result was first
//    produced, so a later re-download reuses the exact same name.
//
// Sanitization rules (exact):
//  - Segments (project/prompt/kind): the value is ASCII-folded —
//    Unicode NFKD decomposition, combining marks (U+0300–U+036F)
//    stripped, and đ/Đ mapped to d/D (they do not decompose under
//    NFKD). Then a character whitelist applies: only [A-Za-z0-9] are
//    kept; every other character becomes a "-" separator; separator
//    runs collapse to one "-"; leading/trailing "-" are trimmed.
//    Project segments truncate to 30 chars, prompt segments to 40
//    (truncation never leaves a trailing "-").
//  - Assembled stems additionally pass a filename-safety pass that
//    mirrors safeQueueFilenameStem in flow-queue-downloads.js:
//    [<>:"/\\|?* and control chars] become "_", trailing dots/spaces
//    are stripped, Windows reserved device names get a "_" prefix,
//    and the stem is capped at 120 chars.
//  - Folders: the input is split on "/" and "\\". An absolute path
//    (leading separator, drive letter, or scheme), or any "." or ".."
//    segment, rejects the WHOLE path and the caller's fallback is
//    used instead — a planned folder can never escape the browser
//    download root. Surviving segments keep their Unicode letters;
//    control/illegal characters [<>:"|?*] become "-", whitespace runs
//    collapse to one space, and trailing dots/spaces are stripped
//    per segment. Empty segments drop out.

export const FLOW_DOWNLOAD_PLAN_VERSION = 1;
export const DEFAULT_FLOW_DOWNLOAD_ROOT = "Flow";
export const DEFAULT_FLOW_FILENAME_TEMPLATE = "{project}-{prompt}-{index}";
export const FLOW_PROJECT_SEGMENT_MAX = 30;
export const FLOW_PROMPT_SEGMENT_MAX = 40;
export const FLOW_PLAN_STEM_MAX = 120;

// Versioned persistence keys, following the repo's V1 key convention
// (cf. flowMcpMediaCatalogV1). Tickets are session-scoped: an armed
// rename is only meaningful for downloads of the current browser
// session, and chrome.storage.session is exactly the store that
// survives a service-worker restart but not a browser restart.
// Records are local-scoped: D22's "re-download the same media later"
// can happen in a later browser session, so they must outlive the
// session — chrome.storage.local.
export const FLOW_FILENAME_TICKETS_STORAGE_KEY = "flowMcpFilenameTicketsV1";
export const FLOW_FILENAME_RECORDS_STORAGE_KEY = "flowMcpFilenameRecordsV1";
export const FLOW_DOWNLOAD_RECORDS_MAX_ENTRIES = 500;

const pad = (value, width) => String(value).padStart(width, "0");

export function foldAsciiText(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .replace(/[\u0300-\u036f]/g, "");
}

export function sanitizePlanSegment(value, maxLength = 0) {
  let segment = foldAsciiText(value)
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const cap = Math.floor(Number(maxLength)) || 0;
  if (cap > 0 && segment.length > cap) segment = segment.slice(0, cap).replace(/-+$/g, "");
  return segment;
}

// Filename-safety pass for assembled stems and planned filenames.
// Mirrors safeQueueFilenameStem (flow-queue-downloads.js) so a planned
// name is exactly as safe as a queue-derived one; kept local to avoid
// a circular import (flow-queue-downloads imports this module).
export function sanitizePlanFilenameStem(value) {
  let stem = String(value ?? "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/g, "");
  if (!stem || stem === "." || stem === "..") return "";
  if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(stem)) stem = `_${stem}`;
  return stem.slice(0, FLOW_PLAN_STEM_MAX);
}

function cleanFolderSegment(segment) {
  return segment
    .replace(/[<>:"|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();
}

// Traversal-proof folder normalization. Returns the normalized
// relative path ("a/b"), or `fallback` when the input is empty,
// absolute, or contains a "." / ".." segment.
export function normalizePlanFolderPath(value, fallback = "") {
  const raw = String(value ?? "");
  if (!raw.trim()) return fallback;
  if (/^\s*(?:[\\/]|[a-zA-Z][a-zA-Z0-9+.-]*:)/.test(raw)) return fallback;
  const segments = [];
  for (const part of raw.split(/[\\/]+/)) {
    const segment = part.trim();
    if (segment === "." || segment === "..") return fallback;
    if (!segment) continue;
    const cleaned = cleanFolderSegment(segment);
    if (cleaned) segments.push(cleaned);
  }
  return segments.length ? segments.join("/") : fallback;
}

// Validate a full planned relative path ("folder/name.ext") for reuse
// as a rename suggestion. Any traversal or absolute form is refused
// (returns ""); the folder part goes through the same normalization
// as planned folders and the filename through the stem-safety rules
// (extension preserved).
export function normalizePlannedDownloadPath(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (/^\s*(?:[\\/]|[a-zA-Z][a-zA-Z0-9+.-]*:)/.test(raw)) return "";
  const parts = raw.split(/[\\/]+/).map(part => part.trim()).filter(Boolean);
  if (!parts.length || parts.some(part => part === "." || part === "..")) return "";
  const filename = parts[parts.length - 1];
  const extensionMatch = filename.match(/(\.[a-z0-9]{1,10})$/i);
  const extension = extensionMatch && !/\.html?$/i.test(extensionMatch[1]) ? extensionMatch[1].toLowerCase() : "";
  const stem = sanitizePlanFilenameStem(extension ? filename.slice(0, -extensionMatch[1].length) : filename);
  if (!stem) return "";
  const folder = parts.length > 1 ? normalizePlanFolderPath(parts.slice(0, -1).join("/"), "") : "";
  if (parts.length > 1 && !folder) return "";
  return folder ? `${folder}/${stem}${extension}` : `${stem}${extension}`;
}

export function planTimestampParts(now = Date.now()) {
  const date = new Date(Number.isFinite(Number(now)) ? Number(now) : Date.now());
  const datePart = `${date.getFullYear()}${pad(date.getMonth() + 1, 2)}${pad(date.getDate(), 2)}`;
  const timePart = `${pad(date.getHours(), 2)}${pad(date.getMinutes(), 2)}${pad(date.getSeconds(), 2)}`;
  return { date: datePart, time: timePart, datetime: `${datePart}-${timePart}` };
}

const TEMPLATE_TOKEN_PATTERN = /\{(date|time|datetime|project|prompt|index|kind)\}/gi;

function assemblePlanStem(template, values) {
  const substituted = String(template || DEFAULT_FLOW_FILENAME_TEMPLATE)
    .replace(TEMPLATE_TOKEN_PATTERN, (match, token) => values[token.toLowerCase()] ?? "")
    .replace(/\{[^{}]*\}/g, "");
  const collapsed = substituted.replace(/-{2,}/g, "-").replace(/^[-. ]+|[-. ]+$/g, "");
  return sanitizePlanFilenameStem(collapsed) || "flow";
}

// Build the filename/folder plan for one batch of downloads. All items
// share the plan's single timestamp. Each item input:
// { project, prompt (or title), kind, resolution } — `resolution`
// (e.g. "1080p") marks an upscale download and earns the stem a
// `_<resolution>` suffix (D12). Returns
// { version, createdAt, timestamp, template, rootFolder, subfolder,
//   folder, items: [{ index, project, prompt, fileStem, folder }] }.
export function buildFlowDownloadPlan(items, options = {}) {
  const createdAt = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const timestamp = planTimestampParts(createdAt);
  const template = typeof options.template === "string" && options.template.trim()
    ? options.template.trim()
    : DEFAULT_FLOW_FILENAME_TEMPLATE;
  const rootFolder = normalizePlanFolderPath(options.rootFolder, DEFAULT_FLOW_DOWNLOAD_ROOT);
  let subfolder = normalizePlanFolderPath(options.subfolder, "");
  // The D12 collapse: a subfolder identical to the root adds nothing.
  if (subfolder && subfolder === rootFolder) subfolder = "";
  const folder = subfolder ? `${rootFolder}/${subfolder}` : rootFolder;
  const list = Array.isArray(items) ? items : [];
  const plannedItems = list.map((item, position) => {
    const index = position + 1;
    const project = sanitizePlanSegment(item?.project, FLOW_PROJECT_SEGMENT_MAX);
    const prompt = sanitizePlanSegment(item?.prompt ?? item?.title, FLOW_PROMPT_SEGMENT_MAX);
    const kind = sanitizePlanSegment(item?.kind, 16).toLowerCase();
    let fileStem = assemblePlanStem(template, {
      date: timestamp.date,
      time: timestamp.time,
      datetime: timestamp.datetime,
      project,
      prompt,
      index: pad(index, 3),
      kind,
    });
    const resolution = sanitizePlanSegment(item?.resolution, 16);
    if (resolution) fileStem = sanitizePlanFilenameStem(`${fileStem}_${resolution}`);
    return { index, project, prompt, fileStem, folder };
  });
  return {
    version: FLOW_DOWNLOAD_PLAN_VERSION,
    createdAt,
    timestamp,
    template,
    rootFolder,
    subfolder,
    folder,
    items: plannedItems,
  };
}

// ---------------------------------------------------------------------
// Armed-ticket (de)serialization for chrome.storage.session (D13).
// Only the fields needed to keep matching + suggesting after a worker
// restart are persisted; functions/runtime handles are not.
// ---------------------------------------------------------------------
export function serializeFilenameTicket(ticket) {
  if (!ticket || typeof ticket !== "object") return null;
  return {
    version: FLOW_DOWNLOAD_PLAN_VERSION,
    jobId: String(ticket.jobId || ""),
    flowMediaId: String(ticket.flowMediaId || ""),
    fileStem: String(ticket.fileStem || ""),
    folder: String(ticket.folder || ""),
    plannedFilename: String(ticket.plannedFilename || ""),
    flowTabId: Number.isInteger(ticket.flowTabId) ? ticket.flowTabId : null,
    flowProjectId: String(ticket.flowProjectId || ""),
    mediaKind: String(ticket.mediaKind || ""),
    title: String(ticket.title || ""),
    armedAt: Number(ticket.armedAt) || null,
    baselineAt: Number(ticket.baselineAt) || null,
    triggerStartedAt: Number(ticket.triggerStartedAt) || null,
    triggerConfirmedAt: Number(ticket.triggerConfirmedAt) || null,
    expiresAt: Number(ticket.expiresAt) || null,
    downloadId: Number.isInteger(ticket.downloadId) ? ticket.downloadId : null,
    assignedFilename: String(ticket.assignedFilename || "") || null,
  };
}

// Rebuild a live ticket from its persisted form. Returns null for
// anything malformed or already expired — a restored ticket must
// satisfy the same identity requirements as a freshly armed one.
export function restoreFilenameTicket(raw, now = Date.now()) {
  if (!raw || typeof raw !== "object") return null;
  const flowMediaId = String(raw.flowMediaId || "");
  const fileStem = String(raw.fileStem || "");
  const expiresAt = Number(raw.expiresAt) || 0;
  if (!flowMediaId || !fileStem || !Number.isInteger(raw.flowTabId)) return null;
  if (!expiresAt || expiresAt <= now) return null;
  const plannedFilename = raw.plannedFilename ? normalizePlannedDownloadPath(raw.plannedFilename) : "";
  if (raw.plannedFilename && !plannedFilename) return null;
  return {
    jobId: String(raw.jobId || ""),
    flowMediaId,
    fileStem,
    folder: raw.folder ? normalizePlanFolderPath(raw.folder, "") : "",
    plannedFilename: plannedFilename || null,
    flowTabId: raw.flowTabId,
    flowProjectId: String(raw.flowProjectId || ""),
    mediaKind: String(raw.mediaKind || ""),
    title: String(raw.title || ""),
    armedAt: Number(raw.armedAt) || now,
    baselineAt: Number(raw.baselineAt) || Number(raw.armedAt) || now,
    triggerStartedAt: Number(raw.triggerStartedAt) || null,
    triggerConfirmedAt: Number(raw.triggerConfirmedAt) || null,
    expiresAt,
    downloadId: Number.isInteger(raw.downloadId) ? raw.downloadId : null,
    assignedFilename: String(raw.assignedFilename || "") || null,
  };
}

// ---------------------------------------------------------------------
// FlowDownloadFilenameRecords — the durable D22 store. Persistence
// discipline mirrors FlowMediaCatalog: a synchronous snapshot chained
// onto a rejection-guarded write chain, and a restore that degrades
// to an empty store instead of wedging downloads behind a rejected
// promise. The store is advisory: a missing record only costs a
// freshly derived name, never a wrong one (the queue re-verifies the
// download identity through the ticket matchers regardless).
// ---------------------------------------------------------------------
const clone = value => structuredClone(value);

const cleanRecordString = (value, max = 2048) => {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text ? text.slice(0, max) : null;
};

function normalizeRecordEntry(input) {
  if (!input || typeof input !== "object") return null;
  const projectId = cleanRecordString(input.projectId, 256);
  const mediaId = cleanRecordString(input.mediaId, 1100);
  const filename = cleanRecordString(input.filename, 1024);
  if (!projectId || !mediaId || !filename) return null;
  // A stored name is re-validated on the way in AND on the way out:
  // nothing traversal-shaped may ever come back as a planned name.
  const safeFilename = normalizePlannedDownloadPath(filename);
  if (!safeFilename) return null;
  return {
    projectId,
    mediaId,
    folder: cleanRecordString(input.folder, 512) || "",
    filename: safeFilename,
    recordedAt: Number(input.recordedAt) || 0,
  };
}

const sameRecord = (a, b) =>
  a.projectId === b.projectId && a.mediaId.toLowerCase() === b.mediaId.toLowerCase();

export class FlowDownloadFilenameRecords {
  constructor({ storage = globalThis.chrome?.storage?.local, storageKey = FLOW_FILENAME_RECORDS_STORAGE_KEY, maxEntries = FLOW_DOWNLOAD_RECORDS_MAX_ENTRIES } = {}) {
    if (!storage?.get || !storage?.set) throw new TypeError("FlowDownloadFilenameRecords requires chrome.storage.local or a compatible storage adapter.");
    this.storage = storage;
    this.storageKey = storageKey;
    this.maxEntries = Math.max(1, Math.floor(Number(maxEntries)) || FLOW_DOWNLOAD_RECORDS_MAX_ENTRIES);
    this.entries = [];
    this.writeChain = Promise.resolve();
    this.ready = this.#restore();
  }

  async #restore() {
    try {
      const stored = await this.storage.get(this.storageKey);
      const state = stored?.[this.storageKey];
      if (state && state.version === 1 && Array.isArray(state.entries)) {
        this.entries = state.entries.map(entry => normalizeRecordEntry(entry)).filter(Boolean);
      }
    } catch {
      // A corrupt or unavailable store must not wedge downloads;
      // start empty — lookups simply miss and names are re-derived.
      this.entries = [];
    }
    return clone(this.entries);
  }

  async #persist() {
    const snapshot = { version: 1, updatedAt: Date.now(), entries: clone(this.entries) };
    this.writeChain = this.writeChain.catch(() => {}).then(() => this.storage.set({ [this.storageKey]: snapshot }));
    return this.writeChain;
  }

  async record(input) {
    await this.ready;
    const entry = normalizeRecordEntry(input);
    if (!entry) return null;
    const existingIndex = this.entries.findIndex(candidate => sameRecord(candidate, entry));
    if (existingIndex >= 0) this.entries.splice(existingIndex, 1);
    entry.recordedAt = Date.now();
    this.entries.push(entry);
    while (this.entries.length > this.maxEntries) this.entries.shift();
    await this.#persist();
    return clone(entry);
  }

  async lookup(projectId, mediaId) {
    await this.ready;
    const project = cleanRecordString(projectId, 256);
    const media = cleanRecordString(mediaId, 1100);
    if (!project || !media) return null;
    const found = this.entries.find(candidate => sameRecord(candidate, { projectId: project, mediaId: media }));
    return found ? clone(found) : null;
  }
}
