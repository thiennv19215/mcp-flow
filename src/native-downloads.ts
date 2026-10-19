import { existsSync, statSync } from "node:fs";
import { extensionDownloads } from "./extension.js";

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
