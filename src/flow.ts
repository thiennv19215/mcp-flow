import { copyFileSync, mkdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import type { Job } from "./queue.js";
import { executeFlowDom, extensionSupportsCapability } from "./extension.js";
import { nativeDownloadIds, waitForNativeDownload, downloadNativeResults, extensionOf, unpackTakes } from "./native-downloads.js";
import { uploadFlowMediaToProject, getCachedProjectMedia, cacheProjectMedia } from "./flow-transfer.js";
import type { FlowState, FlowAsset, FlowProject, DownloadQuality, MediaKind, NativeMedia, CharacterParams } from "./types.js";

export type { FlowState, FlowAsset, FlowProject, DownloadQuality, MediaKind, NativeMedia, CharacterParams };
export { characterLook, rememberCharacter, createCharacter, editCharacter } from "./characters.js";
export { uploadFlowMediaToProject } from "./flow-transfer.js";

const IMAGE_TIMEOUT_MS = 3 * 60_000;
const VIDEO_TIMEOUT_MS = 12 * 60_000;
const ASSET_PREFIX = "asset:";
const nativeJobTargets = new WeakMap<object, NativeFlowTarget>();
type NativeFlowTarget = { driverKey: string; origin: string; projectId: string | null; routePrefix: string; isProjectEditor: boolean; tabId: number };

async function nativeTarget(job?: Job): Promise<NativeFlowTarget> {
  if (job && nativeJobTargets.has(job)) return nativeJobTargets.get(job)!;
  const target = await executeFlowDom<NativeFlowTarget>({ op: "flowOperation", name: "flow.context", capability: "flow.native.context" }, { timeoutMs: 8_000 });
  if (!Number.isInteger(target.tabId)) {
    throw Object.assign(new Error("Reload this repository's Flow extension to version 0.2.8 to enable native tab pinning."), {
      code: "NATIVE_CAPABILITY_UNSUPPORTED", retryable: true, outcome_unknown: false,
    });
  }
  if (!target.isProjectEditor || !target.projectId) {
    throw Object.assign(new Error("Open a Flow project before running this operation."), { code: "FLOW_PROJECT_REQUIRED", retryable: true, outcome_unknown: false });
  }
  if (job) nativeJobTargets.set(job, target);
  return target;
}

export async function nativeOperation<T>(
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

export function requireCapabilities(...capabilities: string[]): void {
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

export async function runGeneration(job: Job): Promise<string[]> {
  const s = job.params;
  const refs = s.reference_images ?? [];
  const framesMode = s.type === "video" && Boolean(s.first_frame || s.last_frame);
  // Frames and references are mutually exclusive in Flow. When frames are present,
  // keep the frame inputs and ignore references before validating or uploading them.
  const activeRefs = framesMode ? [] : refs;
  const isAssetReference = (value: string) => /^asset:/i.test(value);
  const isCharacterReference = (value: string) => /^character:/i.test(value);
  const localFileSupported = (file?: string) => {
    if (!file || isAssetReference(file) || isCharacterReference(file)) return true;
    try {
      const info = statSync(file);
      return [".png", ".jpg", ".jpeg", ".webp", ".gif", ".heic", ".heif", ".avif"].includes(extname(file).toLowerCase()) && info.isFile() && info.size > 0 && info.size <= 25 * 1024 * 1024;
    } catch { return false; }
  };
  const frameInputSupported = (file?: string) => !file || (!isCharacterReference(file) && localFileSupported(file));
  if ((!framesMode && (refs.length > 3 || !activeRefs.every(localFileSupported))) || !frameInputSupported(s.first_frame) || !frameInputSupported(s.last_frame)) {
    throw Object.assign(new Error("Generation accepts up to three references and PNG/JPG/JPEG/WebP/GIF/HEIC/HEIF/AVIF local inputs up to 25 MiB each."), { code: "NATIVE_CAPABILITY_UNSUPPORTED", retryable: true });
  }
  requireCapabilities(
    "flow.native.generation.submit", "flow.native.generation.observe", "flow.native.asset.download",
  );
  if (activeRefs.length) requireCapabilities("flow.native.references.attach");
  const localInputs = [
    ...(s.first_frame && !isAssetReference(s.first_frame) ? [{ path: s.first_frame, slot: "start" }] : []),
    ...(s.last_frame && !isAssetReference(s.last_frame) ? [{ path: s.last_frame, slot: "end" }] : []),
    ...activeRefs.flatMap((file, index) => isAssetReference(file) || isCharacterReference(file) ? [] : [{ path: file, slot: `ref${index + 1}` }]),
  ];
  if (localInputs.length) requireCapabilities("flow.native.generation.upload.preflight");

  // Pre-upload all local reference/frame files so they become project assets on Flow FIRST
  const uploadedAssetByPath = new Map<string, string>();
  if (localInputs.length) {
    const target = await nativeTarget(job);
    const projectId = target.projectId || "default";
    for (const { path: filePath } of localInputs) {
      if (!uploadedAssetByPath.has(filePath)) {
        const cached = getCachedProjectMedia(projectId, filePath);
        if (cached) {
          uploadedAssetByPath.set(filePath, cached.name);
          continue;
        }
        job.note = `Uploading reference "${basename(filePath)}" to Flow project...`;
        const uploaded = await uploadFlowMediaToProject(filePath, job);
        cacheProjectMedia(projectId, filePath, uploaded);
        uploadedAssetByPath.set(filePath, uploaded.name);
      }
    }
  }

  const frame = (value?: string, slot?: string) => !value ? undefined : isAssetReference(value)
    ? { assetName: value.slice(ASSET_PREFIX.length).trim() }
    : { assetName: uploadedAssetByPath.get(value)!, slot };

  const attachments = activeRefs.map((value, index) => isCharacterReference(value) ? { assetName: value }
    : isAssetReference(value)
    ? { assetName: value.slice(ASSET_PREFIX.length).trim() }
    : { assetName: uploadedAssetByPath.get(value)!, slot: `ref${index + 1}` });

  if (framesMode && refs.length) {
    job.note = [job.note, `first/last frames were set, so ${refs.length} reference image(s) were skipped — Flow allows one or the other.`].filter(Boolean).join(" · ");
  }

  function normalizeAspectRatio(input?: string): string | undefined {
    if (!input) return undefined;
    const lower = String(input).trim().toLowerCase();
    const map: Record<string, string> = {
      "9:16": "9:16", "dọc": "9:16", "doc": "9:16", "story": "9:16", "portrait": "9:16", "vertical": "9:16",
      "16:9": "16:9", "ngang": "16:9", "widescreen": "16:9", "landscape": "16:9", "horizontal": "16:9",
      "1:1": "1:1", "vuông": "1:1", "vuong": "1:1", "square": "1:1",
      "4:3": "4:3", "3:4": "3:4", "21:9": "21:9"
    };
    return map[lower] || input;
  }
  const normalizedRatio = normalizeAspectRatio(s.aspect_ratio);

  const submitted = await nativeOperation<{ submitted: boolean; before: string[]; type: MediaKind; expectedCount: number; credits?: number }>("flow.generation.submit", {
    prompt: s.prompt, type: s.type, model: s.model, aspectRatio: normalizedRatio, duration: s.duration,
    resolution: s.resolution, variants: s.variants, maxCredits: s.max_credits,
    firstFrame: frame(s.first_frame, "start"), lastFrame: frame(s.last_frame, "end"), attachments,
  }, "flow.native.generation.submit", job, 120_000);

  if (typeof submitted.credits !== "number") throw new Error("Native generation did not return its credit quote after submission. The outcome may be unknown; inspect Flow before retrying.");
  job.credits = submitted.credits;
  if (job.credits > s.max_credits) throw new Error(`Flow quoted ${job.credits} credits, above max_credits=${s.max_credits}. Nothing should have been generated.`);
  if (!submitted.submitted) throw new Error("Native Flow submit did not confirm that generation started.");
  const observed = await nativeOperation<{ media: NativeMedia[] }>("flow.generation.observe", {
    before: submitted.before, kind: submitted.type, expectedCount: submitted.expectedCount,
    timeoutMs: s.type === "image" ? IMAGE_TIMEOUT_MS : VIDEO_TIMEOUT_MS, retries: s.retries ?? 2,
  }, "flow.native.generation.observe", job, s.type === "image" ? IMAGE_TIMEOUT_MS : VIDEO_TIMEOUT_MS);
  job.progress = undefined;
  return downloadNativeResults(observed.media, s.output_dir, s.file_stem, s.download_quality ?? "original", job);
}

export async function attachReferences(references: string[]): Promise<unknown> {
  requireCapabilities("flow.native.references.attach");
  return nativeOperation("flow.references.attach", { references }, "flow.native.references.attach", undefined, 60_000);
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
  job.failed_scenes = undefined;
  const state = await getFlowState(true);
  if (!state.signedIn || !state.inProject) throw new Error(state.hint || "Open a signed-in Flow project first.");
  const balance = state.credits_remaining;
  const base = Number(job.params.file_stem.match(/\d+/)?.[0] ?? 1);
  const sceneNumbers = scenes.map((_, index) => job.params.agent_numbers?.[index] ?? base + index);
  const sceneMedia = new Map<number, NativeMedia>();
  const confirmedGenerationFailure = (error: unknown): boolean => {
    const value = error as { code?: unknown; outcome_unknown?: unknown } | null;
    return value?.code === "FLOW_GENERATION_FAILED" && value.outcome_unknown === false;
  };
  const collectAgentPass = (requested: number[], result: { media: NativeMedia[]; prompts?: string[]; partial?: boolean; failedMedia?: unknown[] }) => {
    if (!Array.isArray(result?.media) || result.media.some(item => item.kind !== "image") || result.media.length > requested.length) {
      throw Object.assign(new Error("Flow Agent returned an invalid image result. Check the project before retrying."), { code: "FLOW_AGENT_RESULT_INVALID", retryable: false, outcome_unknown: true });
    }
    if (result.media.length < requested.length && (result.partial !== true || !Array.isArray(result.failedMedia)
      || result.failedMedia.length < requested.length - result.media.length)) {
      throw Object.assign(new Error("Flow Agent returned an incomplete result without a confirmed failure. Check the project before retrying."), { code: "FLOW_AGENT_RESULT_INVALID", retryable: false, outcome_unknown: true });
    }
    const passScenes = requested.map(index => scenes[index]);
    const matched = Array.isArray(result.prompts) && result.prompts.length === result.media.length ? matchScenes(passScenes, result.prompts) : [];
    const sceneForMedia = new Map<number, number>();
    const usedScenes = new Set<number>();
    matched.forEach((mediaIndexes, localSceneIndex) => {
      const mediaIndex = mediaIndexes.find(index => !sceneForMedia.has(index));
      if (mediaIndex !== undefined) { sceneForMedia.set(mediaIndex, localSceneIndex); usedScenes.add(localSceneIndex); }
    });
    for (let mediaIndex = 0; mediaIndex < result.media.length; mediaIndex++) {
      if (sceneForMedia.has(mediaIndex)) continue;
      const localSceneIndex = passScenes.findIndex((_, index) => !usedScenes.has(index));
      if (localSceneIndex >= 0) { sceneForMedia.set(mediaIndex, localSceneIndex); usedScenes.add(localSceneIndex); }
    }
    for (const [mediaIndex, localSceneIndex] of sceneForMedia) {
      const sceneIndex = requested[localSceneIndex];
      if (sceneIndex !== undefined && !sceneMedia.has(sceneIndex)) sceneMedia.set(sceneIndex, result.media[mediaIndex]);
    }
  };

  // Flow explicitly marks partial Agent batches as safe to continue. Limit Agent work to
  // three total passes, and submit only scene prompts that still lack a confirmed image.
  for (let pass = 0; pass < 3; pass++) {
    const missing = scenes.map((_, index) => index).filter(index => !sceneMedia.has(index));
    if (!missing.length) break;
    step(job, `Flow Agent pass ${pass + 1}/3 for ${missing.length} remaining scene(s)`);
    const passParams = {
      ...job.params,
      agent_scenes: missing.map(index => scenes[index]),
      agent_numbers: missing.map(index => sceneNumbers[index]),
    };
    try {
      const result = await nativeOperation<{ media: NativeMedia[]; prompts?: string[]; partial?: boolean; failedMedia?: unknown[] }>(
        "flow.agent.batch", { job: { id: job.id, params: passParams } }, "flow.native.agent.batch", job, 30 * 60_000,
      );
      collectAgentPass(missing, result);
    } catch (error) {
      if (error && (error as { outcome_unknown?: unknown }).outcome_unknown === true) throw error;
      if (!confirmedGenerationFailure(error)) throw error;
      // Flow confirmed the render failed and nothing was charged; the next bounded pass
      // may safely try the scenes that remain unmatched.
    }
  }

  mkdirSync(job.params.output_dir, { recursive: true });
  const files: string[] = [];
  let downloadError: unknown;
  for (const [sceneIndex, media] of sceneMedia) {
    const sceneNumber = sceneNumbers[sceneIndex];
    try {
      files.push(...await downloadNativeResults([media], job.params.output_dir, `scene-${String(sceneNumber).padStart(2, "0")}`, job.params.download_quality ?? "original", job));
      job.files = [...files];
    } catch (error) { downloadError = error; break; }
  }
  if (!files.length && downloadError) throw Object.assign(new Error(`Flow generated images but they could not be downloaded. Inspect Flow before retrying. ${String((downloadError as Error).message || downloadError)}`), { code: "FLOW_AGENT_DOWNLOAD_FAILED", retryable: false, outcome_unknown: true });

  const remaining = scenes.map((_, index) => index).filter(index => !sceneMedia.has(index));
  const originalParams = job.params;
  const failedSceneIndexes = new Set<number>();
  for (const sceneIndex of remaining) {
    const sceneNumber = sceneNumbers[sceneIndex];
    let generated = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      job.params = {
        ...originalParams,
        type: "image",
        prompt: scenes[sceneIndex],
        variants: 1,
        max_credits: 0,
        agent_scenes: undefined,
        agent_numbers: undefined,
        file_stem: `scene-${String(sceneNumber).padStart(2, "0")}`,
      };
      try {
        files.push(...await runGeneration(job));
        job.files = [...files];
        generated = true;
        break;
      } catch (error) {
        if (!confirmedGenerationFailure(error)) throw error;
        if (attempt === 1) break;
        step(job, `Flow confirmed scene ${sceneNumber} failed; retrying once`);
      } finally {
        job.params = originalParams;
      }
    }
    if (!generated) {
      // Persist failed scene numbers so flow_retry can enqueue only the missing scenes.
      failedSceneIndexes.add(sceneIndex);
    }
  }
  job.params = originalParams;
  const failedNumbers = [...failedSceneIndexes].map(index => sceneNumbers[index]);
  job.failed_scenes = failedNumbers.length ? failedNumbers : undefined;
  if (downloadError) job.note = `Downloaded ${files.length} result(s); additional Agent media remains in Flow and could not be downloaded.`;
  else if (job.failed_scenes?.length) job.note = `${scenes.length - job.failed_scenes.length} of ${scenes.length} scenes generated; still failed: ${job.failed_scenes.map(number => `scene ${number}`).join(", ")}`;
  else job.note = `${scenes.length} of ${scenes.length} scenes generated`;
  const after = await getFlowState(true).then(value => value.credits_remaining).catch(() => undefined);
  if (balance !== undefined && after !== undefined) job.credits = balance - after;
  step(job, undefined);
  return files;
}
