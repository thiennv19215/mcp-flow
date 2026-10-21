import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import type { Job } from "./job-types.js";
import { streamFileChunks, type FileChunk } from "./native-file-transfer.js";
import { nativeOperation, requireCapabilities } from "./flow.js";

const projectUploadedMediaCache = new Map<string, { name: string; kind: "image" | "video" }>();

export function getCachedProjectMedia(projectId: string, filePath: string): { name: string; kind: "image" | "video" } | undefined {
  try {
    const fileBuf = readFileSync(filePath);
    const hash = createHash("sha256").update(fileBuf).digest("hex");
    return projectUploadedMediaCache.get(`${projectId}:${hash}`);
  } catch {
    return undefined;
  }
}

export function cacheProjectMedia(projectId: string, filePath: string, media: { name: string; kind: "image" | "video" }): void {
  try {
    const fileBuf = readFileSync(filePath);
    const hash = createHash("sha256").update(fileBuf).digest("hex");
    projectUploadedMediaCache.set(`${projectId}:${hash}`, media);
  } catch {}
}

export function uploadMimeType(name: string): string {
  const extension = extname(name).toLowerCase();
  const types: Record<string, string> = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
    ".gif": "image/gif", ".heic": "image/heic", ".heif": "image/heif", ".avif": "image/avif",
    ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
    ".avi": "video/x-msvideo", ".mkv": "video/x-matroska", ".3gp": "video/3gpp",
  };
  const type = types[extension];
  if (!type) throw new Error(`Flow cannot upload media with extension ${extension || "(none)"}. Use PNG, JPG, WebP, GIF, HEIC, HEIF, AVIF, MP4, MOV, WebM, AVI, MKV or 3GP.`);
  return type;
}

export function cleanStagedFiles(dirs: string[]): void {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
}

export async function stageNativeMedia(
  filePath: string,
  name: string,
  stagedDirs: string[],
  job?: Job,
): Promise<{ transferId: string; name: string }> {
  const extension = extname(filePath).toLowerCase();
  const type = uploadMimeType(filePath);
  const isVideo = type.startsWith("video/");
  const maxBytes = isVideo ? 200 * 1024 * 1024 : 25 * 1024 * 1024;
  const uploadName = /\.jpe?g$/i.test(name) ? name.replace(/\.jpeg$/i, ".jpg") : name;
  const dir = mkdtempSync(join(tmpdir(), "flow-native-upload-"));
  stagedDirs.push(dir);
  const stagedPath = join(dir, uploadName);
  copyFileSync(filePath, stagedPath);
  const stagedSize = statSync(stagedPath).size;
  if (stagedSize < 1 || stagedSize > maxBytes) throw new Error(`${isVideo ? "Videos" : "Images"} must be non-empty and no larger than ${isVideo ? 200 : 25} MiB.`);
  const transferId = randomUUID();
  requireCapabilities("flow.native.file.upload.begin", "flow.native.file.upload.chunk", "flow.native.file.upload.finish", "flow.native.file.upload.abort");
  let began = false;
  try {
    let first = true;
    let batch: FileChunk[] = [];
    const sendBatch = async () => {
      if (!batch.length) return;
      await nativeOperation("flow.file.upload.chunk", { chunks: batch }, "flow.native.file.upload.chunk", job, 60_000);
      batch = [];
    };
    for await (const chunk of streamFileChunks(stagedPath, transferId, { maxBytes, maxChunks: isVideo ? 800 : 100 })) {
      if (first) {
        await nativeOperation("flow.file.upload.begin", { transfer: {
          transferId, name: uploadName, type, size: chunk.size, sha256: chunk.sha256,
        } }, "flow.native.file.upload.begin", job, 30_000);
        began = true;
        first = false;
      }
      batch.push(chunk);
      if (batch.length === 4) await sendBatch();
    }
    await sendBatch();
    await nativeOperation("flow.file.upload.finish", { transferId }, "flow.native.file.upload.finish", job, 30_000);
    return { transferId, name: uploadName };
  } catch (error) {
    if (began) await nativeOperation("flow.file.upload.abort", { transferId }, "flow.native.file.upload.abort", job, 10_000).catch(() => {});
    throw error;
  }
}

export async function uploadFlowMediaToProject(filePath: string, job?: Job): Promise<{ name: string; kind: "image" | "video" }> {
  const type = uploadMimeType(filePath);
  const kind = type.startsWith("video/") ? "video" : "image";
  const prefix = `fm-${randomUUID().replace(/-/g, "").slice(0, 12)}-upload`;
  const basename = filePath.split(/[\\/]/).pop() || "media";
  const name = `${prefix}${extname(basename).toLowerCase()}`;
  const stagedDirs: string[] = [];
  let staged: { transferId: string; name: string } | undefined;
  const transferContext = job ?? ({} as Job);
  try {
    requireCapabilities("flow.native.generation.upload.preflight", "flow.native.media.upload");
    await nativeOperation("flow.generation.upload.preflight", {}, "flow.native.generation.upload.preflight", transferContext, 10_000);
    staged = await stageNativeMedia(filePath, name, stagedDirs, transferContext);
    return await nativeOperation("flow.media.upload", { ...staged, kind }, "flow.native.media.upload", transferContext, 180_000);
  } finally {
    if (staged) await nativeOperation("flow.file.upload.abort", { transferId: staged.transferId }, "flow.native.file.upload.abort", transferContext, 10_000).catch(() => {});
    cleanStagedFiles(stagedDirs);
  }
}
