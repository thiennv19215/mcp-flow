import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readSync, renameSync, rmSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { extensionDownloadChunk, extensionDownloads } from "./extension.js";
import { extractZip } from "./platform.js";
import type { DownloadQuality, NativeMedia } from "./types.js";
import type { Job } from "./queue.js";
import { nativeOperation } from "./flow.js";
import { DEFAULT_TRANSFER_LIMITS, DownloadChunkCollector } from "./native-file-transfer.js";

export type NativeDownload = Awaited<ReturnType<typeof extensionDownloads>>[number];

/** Snapshot download IDs before asking Flow to start a browser-owned download. */
export async function nativeDownloadIds(): Promise<Set<number>> {
  return new Set((await extensionDownloads()).map(item => item.id));
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
    const items = (await extensionDownloads()).filter(item => !before.has(item.id));
    const complete = items.find(item => item.state === "complete" && item.filename && (item.totalBytes > 0 || item.bytesReceived > 0) && (!existsSync(item.filename) || statSync(item.filename).size > 0));
    if (complete) return complete;

    const failed = items.find(item => item.state === "interrupted");
    if (failed) throw Object.assign(new Error(`Chrome download failed: ${failed.error ?? "unknown error"} (${failed.bytesReceived}/${failed.totalBytes} bytes). The media remains in Flow.`), {
      code: "FLOW_DOWNLOAD_FAILED", retryable: false, outcome_unknown: false,
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
