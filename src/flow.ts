import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import type { Job } from "./queue.js";
import { extractZip } from "./platform.js";
import { executeFlowDom, extensionSupportsCapability } from "./extension.js";
import { streamFileChunks, type FileChunk } from "./native-file-transfer.js";
import { HOME_DIR } from "./paths.js";
import { nativeDownloadIds, waitForNativeDownload } from "./native-downloads.js";

export interface FlowState {
  url: string;
  signedIn: boolean;
  inProject: boolean;
  plan?: string;
  credits_remaining?: number;
  composer?: string;
  hint?: string;
}

export interface FlowAsset {
  name: string;
  kind: "image" | "video" | "scene";
  id?: string;
}

export interface FlowProject { id: string; name: string; url: string; active?: boolean; }

export type DownloadQuality = "original" | "upscaled";
type MediaKind = "image" | "video";
type NativeMedia = { id?: string; title: string; kind: MediaKind };

const IMAGE_TIMEOUT_MS = 3 * 60_000;
const VIDEO_TIMEOUT_MS = 12 * 60_000;
const ASSET_PREFIX = "asset:";
const nativeJobTargets = new WeakMap<object, NativeFlowTarget>();
type NativeFlowTarget = { driverKey: string; origin: string; projectId: string | null; routePrefix: string; isProjectEditor: boolean };

async function nativeTarget(job?: Job): Promise<NativeFlowTarget> {
  if (job && nativeJobTargets.has(job)) return nativeJobTargets.get(job)!;
  const target = await executeFlowDom<NativeFlowTarget>({ op: "flowOperation", name: "flow.context", capability: "flow.native.context" }, { timeoutMs: 8_000 });
  if (!target.isProjectEditor || !target.projectId) {
    throw Object.assign(new Error("Open a Flow project before running this operation."), { code: "FLOW_PROJECT_REQUIRED", retryable: true, outcome_unknown: false });
  }
  if (job) nativeJobTargets.set(job, target);
  return target;
}

async function nativeOperation<T>(
  op: string,
  payload: Record<string, unknown>,
  capability: string,
  job?: Job,
  timeoutMs = VIDEO_TIMEOUT_MS,
): Promise<T> {
  const target = await nativeTarget(job);
  return executeFlowDom<T>({ op: "flowOperation", name: op, payload, _flowTarget: target, capability, timeoutMs }, {
    // Give the extension time to return its explicit timeout/error after the page-side deadline.
    timeoutMs: timeoutMs + 10_000,
    onProgress: value => {
      if (!job) return;
      if (typeof value === "string") job.progress = value;
      else if (value && typeof value === "object") {
        const progress = value as { progress?: unknown; credits?: unknown; note?: unknown };
        if (typeof progress.progress === "string") job.progress = progress.progress;
        if (typeof progress.credits === "number") job.credits = progress.credits;
        if (typeof progress.note === "string") job.note = progress.note;
      }
    },
  });
}

function requireCapabilities(...capabilities: string[]): void {
  const missing = capabilities.filter(capability => !extensionSupportsCapability(capability));
  if (missing.length) throw Object.assign(new Error(`The connected Flow extension is missing ${missing.join(", ")}. Reload the repository's extension.`), {
    code: "NATIVE_CAPABILITY_UNSUPPORTED", retryable: true, outcome_unknown: false,
  });
}

export async function getFlowState(detailed = false): Promise<FlowState> {
  return executeFlowDom<FlowState>({
    op: "flowOperation", name: "flow.state", payload: { detailed }, capability: "flow.native.state", timeoutMs: 8_000,
  }, { timeoutMs: 8_000 });
}

export async function listFlowProjects(): Promise<FlowProject[]> {
  return executeFlowDom<FlowProject[]>({
    op: "flowOperation", name: "flow.projects.list", payload: {}, capability: "flow.native.projects.list", timeoutMs: 90_000,
  }, { timeoutMs: 100_000 });
}

export async function openFlowProject(projectId: string): Promise<{ opened: boolean; id: string; url: string }> {
  return executeFlowDom({
    op: "flowOperation", name: "flow.project.open", payload: { projectId }, capability: "flow.native.project.open", timeoutMs: 60_000,
  }, { timeoutMs: 65_000 });
}

function uploadMimeType(name: string): string {
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

async function stageNativeMedia(
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

function cleanStagedFiles(dirs: string[]): void {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
}

function extensionOf(file: string): string {
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

function unpackTakes(zip: string, targetStem: string): string[] {
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

async function downloadNativeResults(
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

export async function runGeneration(job: Job): Promise<string[]> {
  const s = job.params;
  const refs = s.reference_images ?? [];
  const localFileSupported = (file?: string) => {
    if (!file || file.startsWith(ASSET_PREFIX)) return true;
    try {
      const info = statSync(file);
      return [".png", ".jpg", ".jpeg", ".webp"].includes(extname(file).toLowerCase()) && info.isFile() && info.size > 0 && info.size <= 25 * 1024 * 1024;
    } catch { return false; }
  };
  if (refs.length > 3 || !refs.every(localFileSupported) || !localFileSupported(s.first_frame) || !localFileSupported(s.last_frame)) {
    throw Object.assign(new Error("Generation accepts up to three references and PNG/JPG/JPEG/WebP local inputs up to 25 MiB each."), { code: "NATIVE_CAPABILITY_UNSUPPORTED", retryable: true });
  }
  requireCapabilities(
    "flow.native.generation.submit", "flow.native.generation.observe", "flow.native.asset.download",
  );
  const localInputs = [
    ...(s.first_frame && !s.first_frame.startsWith(ASSET_PREFIX) ? [{ path: s.first_frame, slot: "start" }] : []),
    ...(s.last_frame && !s.last_frame.startsWith(ASSET_PREFIX) ? [{ path: s.last_frame, slot: "end" }] : []),
    ...refs.flatMap((file, index) => file.startsWith(ASSET_PREFIX) ? [] : [{ path: file, slot: `ref${index + 1}` }]),
  ];
  if (localInputs.length) requireCapabilities("flow.native.generation.upload.preflight");

  // Pre-upload all local reference/frame files so they become project assets on Flow FIRST
  const uploadedAssetByPath = new Map<string, string>();
  if (localInputs.length) {
    for (const { path: filePath } of localInputs) {
      if (!uploadedAssetByPath.has(filePath)) {
        job.note = `Uploading reference "${basename(filePath)}" to Flow project...`;
        const uploaded = await uploadFlowMediaToProject(filePath, job);
        uploadedAssetByPath.set(filePath, uploaded.name);
      }
    }
  }

  const frame = (value?: string, slot?: string) => !value ? undefined : value.startsWith(ASSET_PREFIX)
    ? { assetName: value.slice(ASSET_PREFIX.length).trim() }
    : { assetName: uploadedAssetByPath.get(value)!, slot };

  const attachments = refs.map((value, index) => value.startsWith(ASSET_PREFIX)
    ? { assetName: value.slice(ASSET_PREFIX.length).trim() }
    : { assetName: uploadedAssetByPath.get(value)!, slot: `ref${index + 1}` });

  const framesMode = s.type === "video" && Boolean(s.first_frame || s.last_frame);
  if (framesMode && refs.length) {
    job.note = [job.note, `first/last frames were set, so ${refs.length} reference image(s) were skipped — Flow allows one or the other.`].filter(Boolean).join(" · ");
  }
  const submitted = await nativeOperation<{ submitted: boolean; before: string[]; type: MediaKind; expectedCount: number; credits?: number }>("flow.generation.submit", {
    prompt: s.prompt, type: s.type, model: s.model, aspectRatio: s.aspect_ratio, duration: s.duration,
    resolution: s.resolution, variants: s.variants, maxCredits: s.max_credits,
    firstFrame: frame(s.first_frame, "start"), lastFrame: frame(s.last_frame, "end"), attachments,
  }, "flow.native.generation.submit", job, 120_000);

  if (typeof submitted.credits !== "number") throw new Error("Native generation did not return its credit quote after submission. The outcome may be unknown; inspect Flow before retrying.");
  job.credits = submitted.credits;
  if (job.credits > s.max_credits) throw new Error(`Flow quoted ${job.credits} credits, above max_credits=${s.max_credits}. Nothing should have been generated.`);
  if (!submitted.submitted) throw new Error("Native Flow submit did not confirm that generation started.");
  const observed = await nativeOperation<{ media: NativeMedia[] }>("flow.generation.observe", {
    before: submitted.before, kind: submitted.type, expectedCount: submitted.expectedCount,
    timeoutMs: s.type === "image" ? IMAGE_TIMEOUT_MS : VIDEO_TIMEOUT_MS, retries: s.retries ?? 1,
  }, "flow.native.generation.observe", job, s.type === "image" ? IMAGE_TIMEOUT_MS : VIDEO_TIMEOUT_MS);
  job.progress = undefined;
  return downloadNativeResults(observed.media, s.output_dir, s.file_stem, s.download_quality ?? "original", job);
}

export async function listCharacters(): Promise<string[]> {
  const state = await getFlowState();
  if (!state.signedIn || !state.inProject) throw new Error(state.hint || "Open a signed-in Flow project first.");
  return nativeOperation("flow.characters.list", {}, "flow.native.characters.list", undefined, 90_000);
}

export async function listAssets(): Promise<FlowAsset[]> {
  const state = await getFlowState();
  if (!state.signedIn || !state.inProject) throw new Error(state.hint || "Open a signed-in Flow project first.");
  return nativeOperation("flow.assets.list", {}, "flow.native.assets.list", undefined, 90_000);
}

export async function downloadAsset(name: string, targetStem: string, quality: DownloadQuality): Promise<string[]> {
  const before = await nativeDownloadIds();
  const triggered = await nativeOperation<{ downloadTriggered: boolean }>("flow.asset.download", { name, quality }, "flow.native.asset.download", undefined, 30_000);
  if (!triggered?.downloadTriggered) throw new Error(`Flow did not confirm the download for "${name}".`);
  const download = await waitForNativeDownload(before, quality === "upscaled" ? 12 * 60_000 : 3 * 60_000);
  mkdirSync(dirname(targetStem), { recursive: true });
  if (extname(download.filename).toLowerCase() === ".zip") return unpackTakes(download.filename, targetStem);
  const destination = `${targetStem}${extensionOf(download.filename)}`;
  copyFileSync(download.filename, destination);
  return [destination];
}

export async function trashAsset(name: string): Promise<{ trashed: string }> {
  return nativeOperation("flow.asset.trash", { name }, "flow.native.asset.trash", undefined, 30_000);
}

export interface CharacterParams {
  name: string;
  image?: string;
  describe?: string;
  variants?: number;
  aspect_ratio?: string;
  personality?: string;
  voice?: string;
}

const LOOKS_FILE = join(HOME_DIR, "characters.json");
const loadLooks = (): Record<string, string> => {
  try { return JSON.parse(readFileSync(LOOKS_FILE, "utf8")) as Record<string, string>; } catch { return {}; }
};
export const characterLook = (name: string): string | undefined => loadLooks()[name.toLowerCase()];
export function rememberCharacter(name: string, look: string): void {
  mkdirSync(HOME_DIR, { recursive: true });
  writeFileSync(LOOKS_FILE, JSON.stringify({ ...loadLooks(), [name.toLowerCase()]: look.trim() }, null, 2));
}

export async function createCharacter(c: CharacterParams, job?: Job): Promise<{ name: string; url: string; portrait?: string }> {
  if (!c.image && !c.describe) throw new Error("Pass either an image or a description for the character.");
  const localImage = Boolean(c.image && !c.image.startsWith(ASSET_PREFIX));
  if (localImage) {
    try {
      const info = statSync(c.image!);
      if (!info.isFile() || info.size < 1 || info.size > 25 * 1024 * 1024 || ![".png", ".jpg", ".jpeg", ".webp"].includes(extname(c.image!).toLowerCase())) {
        throw new Error("Character images must be PNG, JPG, JPEG or WebP files up to 25 MiB.");
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Character images")) throw error;
      throw new Error(`Character image file not found or unreadable: ${c.image}`);
    }
  }
  requireCapabilities("flow.native.character.create");
  const stagedDirs: string[] = [];
  let stagedTransferId: string | undefined;
  try {
    let character = c;
    if (localImage) {
      requireCapabilities("flow.native.generation.upload.preflight");
      await nativeOperation("flow.generation.upload.preflight", {}, "flow.native.generation.upload.preflight", job, 10_000);
      const staged = await stageNativeMedia(c.image!, `fm-${randomUUID().replace(/-/g, "").slice(0, 12)}-character${extname(c.image!).toLowerCase()}`, stagedDirs, job);
      stagedTransferId = staged.transferId;
      character = { ...c, image: staged } as unknown as CharacterParams;
    }
    const result = await nativeOperation<{ name: string; url: string; portraitMedia?: NativeMedia }>("flow.character.create", { character }, "flow.native.character.create", job, 10 * 60_000);
    let portrait: string | undefined;
    if (result.portraitMedia) {
      const dir = join(process.env.FLOW_MCP_OUTPUT ?? join(homedir(), "flow-mcp-out"), "_cast");
      try { portrait = (await downloadNativeResults([result.portraitMedia], dir, c.name.replace(/[^\w.-]+/g, "_"), "original", job))[0]; }
      catch { /* The character is saved in Flow; its portrait can be fetched with the edit tool. */ }
    } else if (localImage) {
      const dir = join(process.env.FLOW_MCP_OUTPUT ?? join(homedir(), "flow-mcp-out"), "_cast");
      mkdirSync(dir, { recursive: true });
      portrait = join(dir, `${c.name.replace(/[^\w.-]+/g, "_")}${extname(c.image!).toLowerCase()}`);
      copyFileSync(c.image!, portrait);
    }
    if (c.describe) rememberCharacter(c.name, c.describe);
    if (job) job.progress = undefined;
    return { name: result.name, url: result.url, portrait };
  } finally {
    if (stagedTransferId) await nativeOperation("flow.file.upload.abort", { transferId: stagedTransferId }, "flow.native.file.upload.abort", job, 10_000).catch(() => {});
    cleanStagedFiles(stagedDirs);
  }
}

export async function editCharacter(name: string, change?: string, job?: Job): Promise<{ name: string; portrait?: string; note?: string }> {
  requireCapabilities("flow.native.character.edit");
  const before = await nativeDownloadIds();
  const result = await nativeOperation<{ name: string; downloadTriggered?: boolean; note?: string }>(
    "flow.character.edit", { name, change, timeoutMs: 4 * 60_000 }, "flow.native.character.edit", job, 5 * 60_000,
  );
  let portrait: string | undefined;
  let note = result.note;
  if (result.downloadTriggered) {
    try {
      const file = await waitForNativeDownload(before, 90_000, progress => { if (job) job.progress = progress; });
      const dir = join(process.env.FLOW_MCP_OUTPUT ?? join(homedir(), "flow-mcp-out"), "_cast");
      mkdirSync(dir, { recursive: true });
      portrait = join(dir, `${name.replace(/[^\w.-]+/g, "_")}${extensionOf(file.filename)}`);
      copyFileSync(file.filename, portrait);
    } catch (error) {
      note = `${change ? `${name} was changed in Flow, but the new` : "The"} portrait could not be saved (${error instanceof Error ? error.message : String(error)}). Call flow_character_edit with just the name to save it.`;
    }
  }
  if (job) job.progress = undefined;
  return { name, portrait, note };
}

const EDIT_TIMEOUT_MS = 10 * 60_000;
export async function runEdit(job: Job): Promise<string[]> {
  requireCapabilities("flow.native.edit.run", "flow.native.asset.download");
  const result = await nativeOperation<{ media: NativeMedia[] }>(
    "flow.edit.run", { job: { id: job.id, params: job.params } }, "flow.native.edit.run", job, EDIT_TIMEOUT_MS + 2 * 60_000,
  );
  const files = await downloadNativeResults(result.media, job.params.output_dir, job.params.file_stem, job.params.download_quality ?? "original", job);
  job.progress = undefined;
  return files;
}

const STOP_WORDS = new Set("the and with from into over under that this then than are was for her his its their onto next near across wide shot close scene image".split(" "));
const words = (text: string) => new Set(text.toLowerCase().match(/[a-z0-9']{3,}/g)?.filter(word => !STOP_WORDS.has(word)) ?? []);
export function matchScenes(scenes: string[], prompts: string[]): number[][] {
  const sceneWords = scenes.map(words);
  const pairs: { scene: number; tile: number; score: number }[] = [];
  prompts.forEach((prompt, tile) => {
    const have = words(prompt);
    sceneWords.forEach((want, scene) => {
      const hit = [...want].filter(word => have.has(word)).length;
      pairs.push({ scene, tile, score: want.size ? hit / want.size : 0 });
    });
  });
  pairs.sort((a, b) => b.score - a.score);
  const result: number[][] = scenes.map(() => []);
  const usedTiles = new Set<number>();
  for (const firstPass of [true, false]) for (const { scene, tile, score } of pairs) {
    if (score < 0.5 || usedTiles.has(tile) || (firstPass && result[scene].length)) continue;
    result[scene].push(tile);
    usedTiles.add(tile);
  }
  return result;
}

const stepStarted = new WeakMap<Job, number>();
function step(job: Job, text: string | undefined): void {
  job.progress = text;
  if (!process.env.FLOW_MCP_DEBUG || !text) return;
  if (!stepStarted.has(job)) stepStarted.set(job, Date.now());
  console.error(`[flow-mcp ${job.id}] ${((Date.now() - stepStarted.get(job)!) / 1000).toFixed(1)}s ${text}`);
}

export async function runContinue(job: Job): Promise<string[]> {
  requireCapabilities("flow.native.continue.run", "flow.native.asset.download");
  const result = await nativeOperation<{ media: NativeMedia[] }>(
    "flow.continue.run", { job: { id: job.id, params: job.params } }, "flow.native.continue.run", job, VIDEO_TIMEOUT_MS + 5 * 60_000,
  );
  job.progress = undefined;
  return downloadNativeResults(result.media, job.params.output_dir, job.params.file_stem, job.params.download_quality ?? "original", job);
}

export async function runAgentBatch(job: Job): Promise<string[]> {
  const scenes = job.params.agent_scenes ?? [];
  requireCapabilities("flow.native.agent.batch", "flow.native.asset.download");
  if (!scenes.length) return [];
  const state = await getFlowState(true);
  if (!state.signedIn || !state.inProject) throw new Error(state.hint || "Open a signed-in Flow project first.");
  const balance = state.credits_remaining;
  step(job, `generating ${scenes.length} scene(s) with Flow Agent`);
  const result = await nativeOperation<{ media: NativeMedia[]; prompts?: string[] }>(
    "flow.agent.batch", { job: { id: job.id, params: job.params } }, "flow.native.agent.batch", job, 30 * 60_000,
  );
  if (!Array.isArray(result?.media) || result.media.length !== scenes.length || result.media.some(item => item.kind !== "image")) {
    throw Object.assign(new Error("Flow Agent returned no usable image result. Check the project before retrying."), { code: "FLOW_AGENT_RESULT_INVALID", retryable: false, outcome_unknown: true });
  }
  const base = Number(job.params.file_stem.match(/\d+/)?.[0] ?? 1);
  const matched = Array.isArray(result.prompts) && result.prompts.length === result.media.length ? matchScenes(scenes, result.prompts) : [];
  const sceneForMedia = new Map<number, number>();
  const usedScenes = new Set<number>();
  matched.forEach((mediaIndexes, sceneIndex) => {
    const mediaIndex = mediaIndexes.find(index => !sceneForMedia.has(index));
    if (mediaIndex !== undefined) { sceneForMedia.set(mediaIndex, sceneIndex); usedScenes.add(sceneIndex); }
  });
  for (let mediaIndex = 0; mediaIndex < result.media.length; mediaIndex++) {
    if (sceneForMedia.has(mediaIndex)) continue;
    const sceneIndex = scenes.findIndex((_, index) => !usedScenes.has(index));
    if (sceneIndex >= 0) { sceneForMedia.set(mediaIndex, sceneIndex); usedScenes.add(sceneIndex); }
  }
  mkdirSync(job.params.output_dir, { recursive: true });
  const files: string[] = [];
  let downloadError: unknown;
  for (const [index, media] of result.media.entries()) {
    const sceneIndex = sceneForMedia.get(index) ?? index;
    const sceneNumber = job.params.agent_numbers?.[sceneIndex] ?? base + sceneIndex;
    try {
      files.push(...await downloadNativeResults([media], job.params.output_dir, `scene-${String(sceneNumber).padStart(2, "0")}`, job.params.download_quality ?? "original", job));
    } catch (error) { downloadError = error; break; }
  }
  if (!files.length && downloadError) throw Object.assign(new Error(`Flow generated images but they could not be downloaded. Inspect Flow before retrying. ${String((downloadError as Error).message || downloadError)}`), { code: "FLOW_AGENT_DOWNLOAD_FAILED", retryable: false, outcome_unknown: true });
  if (downloadError) job.note = `Downloaded ${files.length} of ${result.media.length} Agent results; the remaining media is still in Flow.`;
  else job.note = `${new Set(sceneForMedia.values()).size} of ${scenes.length} scenes came from the agent`;
  const after = await getFlowState(true).then(value => value.credits_remaining).catch(() => undefined);
  if (balance !== undefined && after !== undefined) job.credits = balance - after;
  step(job, undefined);
  return files;
}
