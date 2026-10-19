import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readSync, renameSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { extensionDownloads } from "./extension.js";
import { extractZip } from "./platform.js";
import type { DownloadQuality, NativeMedia } from "./types.js";
import type { Job } from "./queue.js";
import { nativeOperation } from "./flow.js";

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
    const complete = items.find(item => item.state === "complete" && item.filename && existsSync(item.filename) && statSync(item.filename).size > 0);
    if (complete) return complete;

    const failed = items.find(item => item.state === "interrupted");
    if (failed) throw new Error(`Chrome download failed: ${failed.error ?? "unknown error"} (${failed.bytesReceived}/${failed.totalBytes} bytes). The media remains in Flow.`);

    const active = items.find(item => item.state === "in_progress");
    const progress = active && active.totalBytes > 0
      ? `Downloading ${Math.min(100, Math.floor(active.bytesReceived * 100 / active.totalBytes))}%`
      : "Waiting for Chrome download";
    if (progress !== lastProgress) { onProgress?.(progress); lastProgress = progress; }
    await new Promise(resolve => setTimeout(resolve, 750));
  }
  throw new Error("Flow started the download but Chrome did not finish it in time. The media remains in Flow.");
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
    if (!triggered?.downloadTriggered) throw new Error(`Flow did not confirm the download for "${item.title}".`);
    const download = await waitForNativeDownload(before, quality === "upscaled" ? 12 * 60_000 : 3 * 60_000, progress => {
      if (job) job.progress = progress;
    });
    if (extname(download.filename).toLowerCase() === ".zip") files.push(...unpackTakes(download.filename, stem));
    else {
      const destination = `${stem}${extensionOf(download.filename)}`;
      copyFileSync(download.filename, destination);
      files.push(destination);
    }
  }
  return files;
}
