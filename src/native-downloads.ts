import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readSync, renameSync, rmSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { extensionDownloadChunk, extensionDownloads } from "./extension.js";
import { extractZip } from "./platform.js";
import type { DownloadQuality, NativeMedia } from "./types.js";
import type { Job } from "./job-types.js";
import { nativeOperation } from "./flow.js";
import { DEFAULT_TRANSFER_LIMITS, DownloadChunkCollector } from "./native-file-transfer.js";

export type NativeDownload = Awaited<ReturnType<typeof extensionDownloads>>[number];

/** Snapshot download IDs before asking Flow to start a browser-owned download. */
export async function nativeDownloadIds(): Promise<Set<number>> {
  return new Set((await extensionDownloads()).map(item => item.id));
}

// Provenance rules mirroring the extension queue's own download matching
// (flow-queue-downloads.js isFlowMediaHost/flowUrl): a download only counts
// as Flow output when its URL chain points at Flow or Google media hosts.
export function isFlowMediaHost(hostname: string): boolean {
  const host = String(hostname || "").toLowerCase();
  return host === "flow.google.com" || host.endsWith(".flow.google.com") ||
    host === "labs.google" || host.endsWith(".labs.google") ||
    host === "storage.googleapis.com" || host.endsWith(".storage.googleapis.com") ||
    host === "googleusercontent.com" || host.endsWith(".googleusercontent.com") ||
    host === "googleapis.com" || host.endsWith(".googleapis.com") ||
    host === "usercontent.goog" || host.endsWith(".usercontent.goog");
}

export function isFlowUrl(value?: string): boolean {
  try {
    const raw = String(value || "");
    if (!raw) return false;
    if (raw.startsWith("blob:")) return raw.includes("flow.google.com") || raw.includes("labs.google");
    return isFlowMediaHost(new URL(raw).hostname);
  } catch { return false; }
}

export function hasFlowDownloadProvenance(item: { url?: string; finalUrl?: string; referrer?: string }): boolean {
  return isFlowUrl(item.url) || isFlowUrl(item.finalUrl) || isFlowUrl(item.referrer);
}

// DL-05: interrupted-download classification, mirrored from the extension
// queue's download module (flow-queue-downloads.js) so both waiters speak
// the same vocabulary. Only transient network/transport-class reasons may
// resume, and only when Chrome says the download can resume; identity/
// provenance, auth/policy and integrity reasons never resume, and unknown
// reasons fail closed as fatal. The resume itself (chrome.downloads.resume
// under FLOW_DOWNLOAD_RESUME_BUDGET per wait) lives in the extension
// background, the only side with direct chrome.downloads access — the
// connector bridge exposes no resume method and does not forward
// canResume — so the native waiters attach this classification to the
// interruption errors they throw instead of resuming from here.
export const FLOW_DOWNLOAD_RESUME_BUDGET = 3;

const TRANSIENT_DOWNLOAD_INTERRUPTIONS = new Set([
  "NETWORK_FAILED", "NETWORK_TIMEOUT", "NETWORK_DISCONNECTED", "NETWORK_SERVER_DOWN",
  "SERVER_FAILED", "SERVER_UNREACHABLE", "SERVER_NO_RANGE", "SERVER_CONTENT_LENGTH_MISMATCH",
  "FILE_TRANSIENT_ERROR", "CRASH",
]);

export function classifyDownloadInterruption(error?: string, canResume?: boolean): { category: "transient" | "fatal"; reason: string; resumable: boolean } {
  const reason = String(error || "").trim().toUpperCase() || "UNKNOWN";
  const transient = TRANSIENT_DOWNLOAD_INTERRUPTIONS.has(reason);
  return {
    category: transient ? "transient" : "fatal",
    reason,
    resumable: transient && canResume === true,
  };
}

// DL-07: explicit HTML-response rejection, mirrored from the extension
// queue's download module so both waiters speak the same vocabulary.
// Detection is mime OR filename (mime `text/html`, parameters/case
// tolerated, or a filename ending .html/.htm) — the OR is pinned: a
// .html filename rejects even when the item also carries a real media
// mime. Ordering mirrors the queue side: the check runs on a completed
// or interrupted sighting BEFORE the item can be selected/returned as
// media and BEFORE the interruption handling — an interrupted HTML-ish
// item is not a media download at all. Removal limits differ by side:
// the queue (extension background) removes the file through
// chrome.downloads.removeFile, but the connector bridge this backend
// talks to exposes only flow.downloads.recent and flow.downloads.read
// — no removal method — so the native waiters cannot remove the file
// from here; their errors record fileRemoved: false /
// removalAvailable: false honestly instead of pretending otherwise.
// (The ExtensionDownload shape carries no mime field today; when the
// bridge does not supply one, detection rests on the filename signal,
// which the bridge does expose.)
export function detectFlowDownloadHtmlResponse(item: { filename?: string | null; mime?: string | null }): { via: "mime" | "filename"; mime: string; filename: string } | null {
  if (!item || typeof item !== "object") return null;
  const mime = String(item.mime || "").split(";")[0].trim().toLowerCase();
  const filename = String(item.filename || "").split(/[\\/]/).pop()?.trim() || "";
  if (mime === "text/html") return { via: "mime", mime, filename };
  if (/\.html?$/i.test(filename)) return { via: "filename", mime, filename };
  return null;
}

function throwIfHtmlNativeDownload(item: NativeDownload): void {
  if (!item || (item.state !== "complete" && item.state !== "interrupted")) return;
  const signal = detectFlowDownloadHtmlResponse(item as { filename?: string; mime?: string });
  if (!signal) return;
  throw Object.assign(new Error(`Chrome download for a Flow result arrived as an HTML page instead of media (detected via ${signal.via === "mime" ? `mime "${signal.mime}"` : `filename "${signal.filename}"`}); the HTML payload is not the generated media. The media remains in Flow.`), {
    code: "FLOW_DOWNLOAD_HTML_RESPONSE", retryable: false, outcome_unknown: false,
    downloadHtmlResponse: {
      downloadId: item.id,
      via: signal.via,
      mime: signal.mime || null,
      filename: signal.filename || null,
      fileRemoved: false,
      removalAvailable: false,
    },
  });
}

function downloadInterruptionDiagnostics(item: { error?: string; canResume?: boolean }): { reason: string; category: "transient" | "fatal"; canResume: boolean; resumable: boolean } {
  const classification = classifyDownloadInterruption(item.error, item.canResume);
  return {
    reason: classification.reason,
    category: classification.category,
    canResume: item.canResume === true,
    resumable: classification.resumable,
  };
}

/** Pick the completed Flow download out of a poll of Chrome downloads. The
 * user's own unrelated download finishing in the same window must never be
 * materialized as the scene's output file. */
export function selectCompletedFlowDownload(items: NativeDownload[], before: ReadonlySet<number>): NativeDownload | undefined {
  return items.find(item => !before.has(item.id) && hasFlowDownloadProvenance(item) &&
    item.state === "complete" && item.filename && (item.totalBytes > 0 || item.bytesReceived > 0) &&
    // DL-07: an HTML payload is never selected as a media result.
    !detectFlowDownloadHtmlResponse(item as { filename?: string; mime?: string }) &&
    (!existsSync(item.filename) || statSync(item.filename).size > 0));
}

/** Wait for a Chrome download initiated by the content script. */
export async function waitForNativeDownload(
  before: ReadonlySet<number>,
  timeoutMs: number,
  onProgress?: (message: string) => void,
): Promise<NativeDownload> {
  const deadline = Date.now() + timeoutMs;
  let lastProgress = "";
  while (Date.now() < deadline) {
    const items = (await extensionDownloads()).filter(item => !before.has(item.id) && hasFlowDownloadProvenance(item));
    // DL-07: HTML check on every poll sighting — before selection/return
    // and before the interruption failure below.
    for (const item of items) throwIfHtmlNativeDownload(item);
    const complete = selectCompletedFlowDownload(items, before);
    if (complete) return complete;

    const failed = items.find(item => item.state === "interrupted");
    if (failed) throw Object.assign(new Error(`Chrome download failed: ${failed.error ?? "unknown error"} (${failed.bytesReceived}/${failed.totalBytes} bytes). The media remains in Flow.`), {
      code: "FLOW_DOWNLOAD_FAILED", retryable: false, outcome_unknown: false,
      downloadInterruption: downloadInterruptionDiagnostics(failed as { error?: string; canResume?: boolean }),
    });

    const active = items.find(item => item.state === "in_progress");
    const progress = active && active.totalBytes > 0
      ? `Downloading ${Math.min(100, Math.floor(active.bytesReceived * 100 / active.totalBytes))}%`
      : "Waiting for Chrome download";
    if (progress !== lastProgress) { onProgress?.(progress); lastProgress = progress; }
    await new Promise(resolve => setTimeout(resolve, 750));
  }
  throw Object.assign(new Error("Flow started the download but Chrome did not finish it in time. The media remains in Flow."), {
    code: "FLOW_DOWNLOAD_FAILED", retryable: false, outcome_unknown: false,
  });
}

/** Relay a browser-owned completed download to the backend when Chrome and the backend run on different machines. */
export async function materializeNativeDownload(
  download: NativeDownload,
  outputDir: string,
  onProgress?: (message: string) => void,
): Promise<string> {
  if (existsSync(download.filename) && statSync(download.filename).size > 0) return download.filename;
  const size = download.totalBytes > 0 ? download.totalBytes : download.bytesReceived;
  if (!Number.isSafeInteger(size) || size < 1 || size > DEFAULT_TRANSFER_LIMITS.maxBytes) {
    throw Object.assign(new Error(`The browser download size is unavailable or exceeds ${DEFAULT_TRANSFER_LIMITS.maxBytes / 1024 / 1024} MiB; the file remains in Flow.`), {
      code: "FLOW_DOWNLOAD_TRANSFER_LIMIT", retryable: false, outcome_unknown: false,
    });
  }
  const transferId = randomUUID();
  const extension = extname(download.filename).toLowerCase().replace(/[^.a-z0-9]/g, "") || ".bin";
  const temporaryName = `flow-transfer-${transferId}${extension}`;
  const collector = new DownloadChunkCollector(outputDir);
  await collector.begin({ transferId, filename: temporaryName, size });
  try {
    let offset = 0;
    let index = 0;
    while (offset < size) {
      const length = Math.min(DEFAULT_TRANSFER_LIMITS.chunkBytes, size - offset);
      const chunk = await extensionDownloadChunk(download.id, index, offset, length);
      if (chunk.index !== index || chunk.offset !== offset || chunk.totalBytes !== size) throw new Error("The Flow connector returned a mismatched download range.");
      await collector.accept({ transferId, index, offset, data: chunk.data, chunkSha256: chunk.chunkSha256 });
      offset += length;
      index++;
      onProgress?.(`Transferring browser download ${Math.min(100, Math.floor(offset * 100 / size))}%`);
    }
    return await collector.finish(transferId);
  } catch (error) {
    await collector.abort(transferId);
    throw Object.assign(new Error(`Could not transfer the completed browser download to the backend. ${error instanceof Error ? error.message : String(error)}`), {
      code: "FLOW_DOWNLOAD_TRANSFER_FAILED", retryable: false, outcome_unknown: false,
    });
  }
}

export function extensionOf(file: string): string {
  const head = Buffer.alloc(12);
  const fd = openSync(file, "r");
  try { readSync(fd, head, 0, 12, 0); } finally { closeSync(fd); }
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return ".jpeg";
  if (head[0] === 0x89 && head.subarray(1, 4).toString("latin1") === "PNG") return ".png";
  if (head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP") return ".webp";
  if (head.subarray(4, 8).toString("latin1") === "ftyp") return ".mp4";
  if (head.subarray(0, 4).toString("latin1") === "GIF8") return ".gif";
  if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) return ".zip";
  return ".bin";
}

export function unpackTakes(zip: string, targetStem: string): string[] {
  const work = mkdtempSync(join(tmpdir(), "flow-takes-"));
  const takes = extractZip(zip, work).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const out: string[] = [];
  for (const [i, path] of takes.entries()) {
    const destination = `${targetStem}${i ? `-v${i + 1}` : ""}${extensionOf(path)}`;
    renameSync(path, destination);
    out.push(destination);
  }
  renameSync(zip, `${targetStem}-takes.zip`);
  if (!out.length) throw new Error("Flow sent a ZIP with nothing usable inside it.");
  return out;
}

export async function downloadNativeResults(
  media: NativeMedia[],
  outputDir: string,
  fileStem: string,
  quality: DownloadQuality,
  job?: Job,
): Promise<string[]> {
  mkdirSync(outputDir, { recursive: true });
  const files: string[] = [];
  for (const [index, item] of media.entries()) {
    const stem = join(outputDir, media.length > 1 ? `${fileStem}-v${index + 1}` : fileStem);
    const before = await nativeDownloadIds();
    const triggered = await nativeOperation<{ downloadTriggered: boolean }>("flow.asset.download", {
      id: item.id, name: item.title, quality,
    }, "flow.native.asset.download", job, 30_000);
    if (!triggered?.downloadTriggered) throw Object.assign(new Error(`Flow did not confirm the download for "${item.title}".`), {
      code: "FLOW_DOWNLOAD_FAILED", retryable: false, outcome_unknown: false,
    });
    const download = await waitForNativeDownload(before, quality === "upscaled" ? 12 * 60_000 : 3 * 60_000, progress => {
      if (job) job.progress = progress;
    });
    const source = await materializeNativeDownload(download, outputDir, progress => { if (job) job.progress = progress; });
    try {
      if (extname(source).toLowerCase() === ".zip") files.push(...unpackTakes(source, stem));
      else {
        const destination = `${stem}${extensionOf(source)}`;
        copyFileSync(source, destination);
        files.push(destination);
      }
    } finally {
      if (source.startsWith(join(outputDir, `flow-transfer-`))) rmSync(source, { force: true });
    }
  }
  return files;
}

/** Materialize browser downloads that the extension already completed inside its queue runner. */
export async function materializeQueuedNativeDownloads(
  downloads: Array<{ id: number; fileStem?: string }>,
  outputDir: string,
  fileStem: string,
  job?: Job,
): Promise<string[]> {
  mkdirSync(outputDir, { recursive: true });
  const files: string[] = [];
  for (const [index, queued] of downloads.entries()) {
    const stem = join(outputDir, queued.fileStem || (downloads.length > 1 ? `${fileStem}-v${index + 1}` : fileStem));
    let download: NativeDownload | undefined;
    const deadline = Date.now() + 12 * 60_000;
    while (Date.now() < deadline) {
      download = (await extensionDownloads()).find(item => item.id === queued.id);
      if (!download) {
        await new Promise(resolve => setTimeout(resolve, 750));
        continue;
      }
      // DL-07: HTML check on every poll sighting — before the completion
      // break and before the interruption failure below.
      throwIfHtmlNativeDownload(download);
      if (download.state === "complete" && download.filename && (download.totalBytes > 0 || download.bytesReceived > 0)) break;
      if (download.state === "interrupted") {
        throw Object.assign(new Error(`Chrome download failed: ${download.error ?? "unknown error"} (${download.bytesReceived}/${download.totalBytes} bytes). The media remains in Flow.`), {
          code: "FLOW_DOWNLOAD_FAILED", retryable: false, outcome_unknown: false,
          downloadInterruption: downloadInterruptionDiagnostics(download as { error?: string; canResume?: boolean }),
        });
      }
      job && (job.progress = download.totalBytes > 0
        ? `Downloading ${Math.min(100, Math.floor(download.bytesReceived * 100 / download.totalBytes))}%`
        : "Waiting for Chrome download");
      await new Promise(resolve => setTimeout(resolve, 750));
    }
    if (!download || download.state !== "complete" || !download.filename) {
      throw Object.assign(new Error("The extension queue's Flow download did not finish in time. The media remains in Flow."), {
        code: "FLOW_DOWNLOAD_FAILED", retryable: false, outcome_unknown: false,
      });
    }
    const source = await materializeNativeDownload(download, outputDir, progress => { if (job) job.progress = progress; });
    try {
      if (extname(source).toLowerCase() === ".zip") files.push(...unpackTakes(source, stem));
      else {
        const destination = `${stem}${extensionOf(source)}`;
        copyFileSync(source, destination);
        files.push(destination);
      }
    } finally {
      if (source.startsWith(join(outputDir, "flow-transfer-"))) rmSync(source, { force: true });
    }
  }
  return files;
}
