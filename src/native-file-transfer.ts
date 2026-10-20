import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, mkdir, open, rm, stat } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";

export const DEFAULT_TRANSFER_LIMITS = Object.freeze({
  maxBytes: 200 * 1024 * 1024,
  chunkBytes: 256 * 1024,
  maxChunks: 8192,
});

export type FileChunk = {
  transferId: string;
  index: number;
  offset: number;
  data: string;
  chunkSha256: string;
};

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const validDigest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
const inside = (file: string, dir: string) => resolve(file).startsWith(resolve(dir) + sep);

/** Read a local file as bounded, ordered base64 chunks for an extension upload. */
export async function* streamFileChunks(
  filePath: string,
  transferId: string,
  options: { chunkBytes?: number; maxBytes?: number; maxChunks?: number } = {},
): AsyncGenerator<FileChunk & { size: number; sha256: string }> {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(transferId)) throw new Error("Invalid transfer id");
  const chunkBytes = options.chunkBytes ?? DEFAULT_TRANSFER_LIMITS.chunkBytes;
  const maxBytes = options.maxBytes ?? DEFAULT_TRANSFER_LIMITS.maxBytes;
  const maxChunks = options.maxChunks ?? DEFAULT_TRANSFER_LIMITS.maxChunks;
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > 1024 * 1024) throw new Error("chunkBytes must be between 1 byte and 1 MiB");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(maxChunks) || maxChunks < 1) throw new Error("Invalid transfer limits");
  const info = await stat(filePath);
  if (!info.isFile()) throw new Error("Upload source is not a regular file");
  if (info.size > maxBytes) throw new Error(`Upload exceeds the ${maxBytes}-byte limit`);
  const overall = createHash("sha256");
  for await (const value of createReadStream(filePath, { highWaterMark: chunkBytes })) overall.update(value);
  const digest = overall.digest("hex");
  const streamed = createHash("sha256");
  let index = 0;
  let offset = 0;
  for await (const value of createReadStream(filePath, { highWaterMark: chunkBytes })) {
    if (index >= maxChunks) throw new Error(`Upload exceeds the ${maxChunks}-chunk limit`);
    const bytes = new Uint8Array(value);
    streamed.update(bytes);
    yield {
      transferId, index, offset, data: Buffer.from(bytes).toString("base64"), chunkSha256: sha256(bytes),
      size: info.size, sha256: digest,
    };
    offset += bytes.byteLength;
    index++;
  }
  if (offset !== info.size || streamed.digest("hex") !== digest) throw new Error("Upload source changed while it was being read");
}

type ActiveDownload = {
  path: string;
  tempPath: string;
  handle: Awaited<ReturnType<typeof open>>;
  expectedSize: number;
  expectedSha256?: string;
  nextIndex: number;
  offset: number;
  hash: ReturnType<typeof createHash>;
};

/** Collect extension download chunks into a verified file, then atomically publish it. */
export class DownloadChunkCollector {
  private readonly transfers = new Map<string, ActiveDownload>();
  private readonly outputDir: string;
  private readonly maxBytes: number;
  private readonly chunkBytes: number;
  private readonly maxChunks: number;

  constructor(outputDir: string, limits: { maxBytes?: number; chunkBytes?: number; maxChunks?: number } = {}) {
    this.outputDir = resolve(outputDir);
    this.maxBytes = limits.maxBytes ?? DEFAULT_TRANSFER_LIMITS.maxBytes;
    this.chunkBytes = limits.chunkBytes ?? DEFAULT_TRANSFER_LIMITS.chunkBytes;
    this.maxChunks = limits.maxChunks ?? DEFAULT_TRANSFER_LIMITS.maxChunks;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 0) throw new Error("maxBytes must be a non-negative safe integer");
    if (!Number.isSafeInteger(this.chunkBytes) || this.chunkBytes < 1 || this.chunkBytes > 1024 * 1024) throw new Error("chunkBytes must be between 1 byte and 1 MiB");
    if (!Number.isSafeInteger(this.maxChunks) || this.maxChunks < 1) throw new Error("maxChunks must be a positive safe integer");
  }

  async begin(input: { transferId: string; filename: string; size: number; sha256?: string }): Promise<void> {
    const { transferId, size } = input;
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(transferId) || this.transfers.has(transferId)) throw new Error("Invalid or duplicate transfer id");
    if (!Number.isSafeInteger(size) || size < 0 || size > this.maxBytes) throw new Error(`Download size exceeds the ${this.maxBytes}-byte limit`);
    if (input.sha256 !== undefined && !validDigest(input.sha256)) throw new Error("Invalid download SHA-256");
    const name = basename(input.filename);
    if (!name || name === "." || name === ".." || name !== input.filename || /[\\/\0]/.test(name)) throw new Error("Invalid download filename");
    await mkdir(this.outputDir, { recursive: true });
    const path = resolve(join(this.outputDir, name));
    if (!inside(path, this.outputDir)) throw new Error("Download path escapes output directory");
    const tempPath = join(this.outputDir, `.${transferId}.part`);
    const handle = await open(tempPath, "wx");
    this.transfers.set(transferId, { path, tempPath, handle, expectedSize: size, expectedSha256: input.sha256?.toLowerCase(), nextIndex: 0, offset: 0, hash: createHash("sha256") });
  }

  async accept(chunk: FileChunk): Promise<{ nextIndex: number; receivedBytes: number }> {
    const active = this.transfers.get(chunk.transferId);
    if (!active) throw new Error("Unknown download transfer");
    try {
      if (chunk.index !== active.nextIndex || chunk.offset !== active.offset) throw new Error("Out-of-order or duplicate download chunk");
      if (chunk.index >= this.maxChunks) throw new Error("Download exceeds chunk limit");
      if (typeof chunk.data !== "string" || chunk.data.length > Math.ceil(this.chunkBytes * 4 / 3) + 4) throw new Error("Download chunk exceeds chunk limit");
      const bytes = Buffer.from(chunk.data, "base64");
      if (bytes.length === 0 || bytes.length > this.chunkBytes || bytes.toString("base64").replace(/=+$/, "") !== chunk.data.replace(/=+$/, "")) throw new Error("Invalid base64 download chunk");
      if (active.offset + bytes.length > active.expectedSize) throw new Error("Download exceeds declared size");
      if (!validDigest(chunk.chunkSha256) || sha256(bytes) !== chunk.chunkSha256.toLowerCase()) throw new Error("Download chunk checksum mismatch");
      const result = await active.handle.write(bytes, 0, bytes.length, active.offset);
      if (result.bytesWritten !== bytes.length) throw new Error("Short write while collecting download");
      active.hash.update(bytes);
      active.offset += bytes.length;
      active.nextIndex++;
      return { nextIndex: active.nextIndex, receivedBytes: active.offset };
    } catch (error) {
      await this.abort(chunk.transferId);
      throw error;
    }
  }

  async finish(transferId: string): Promise<string> {
    const active = this.transfers.get(transferId);
    if (!active) throw new Error("Unknown download transfer");
    try {
      const actualSha256 = active.hash.digest("hex");
      if (active.offset !== active.expectedSize || (active.expectedSha256 && actualSha256 !== active.expectedSha256)) throw new Error("Download size or checksum mismatch");
      await active.handle.sync();
      await active.handle.close();
      // A hard link publishes the verified file atomically and fails if the destination already exists.
      await link(active.tempPath, active.path);
      await rm(active.tempPath, { force: true });
      this.transfers.delete(transferId);
      return active.path;
    } catch (error) {
      await this.abort(transferId);
      throw error;
    }
  }

  async abort(transferId: string): Promise<void> {
    const active = this.transfers.get(transferId);
    if (!active) return;
    this.transfers.delete(transferId);
    await active.handle.close().catch(() => {});
    await rm(active.tempPath, { force: true }).catch(() => {});
  }

  async abortAll(): Promise<void> {
    await Promise.all([...this.transfers.keys()].map(id => this.abort(id)));
  }
}
