import { copyFileSync, mkdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import type { FrameAssetInput, Job } from "./job-types.js";
import { executeFlowDom, extensionSupportsCapability } from "./extension.js";
import { nativeDownloadIds, waitForNativeDownload, downloadNativeResults, extensionOf, materializeNativeDownload, unpackTakes } from "./native-downloads.js";
import { uploadFlowMediaToProject, getCachedProjectMedia, cacheProjectMedia } from "./flow-transfer.js";
import type { FlowState, FlowAsset, FlowProject, FlowCharacter, DownloadQuality, MediaKind, NativeMedia, CharacterParams } from "./types.js";
import { validateFlowSceneCapabilities } from "./flow-capabilities.js";

export type { FlowState, FlowAsset, FlowProject, FlowCharacter, DownloadQuality, MediaKind, NativeMedia, CharacterParams };
export { characterLook, rememberCharacter, createCharacter, editCharacter } from "./characters.js";
export { uploadFlowMediaToProject } from "./flow-transfer.js";

export function mapFlowFrameInput(
  value: FrameAssetInput | undefined,
  slot: "start" | "end",
  uploadedAssetByPath: Map<string, string> = new Map(),
): { assetName: string; slot?: "start" | "end"; expectedId?: string } | undefined {
  if (!value) return undefined;
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (typeof value === "object") {
    if (!value.asset.trim() || !uuidPattern.test(value.id)) {
      throw Object.assign(new Error("Frame asset inputs require an exact title and a valid Flow media UUID."), {
        code: "FLOW_FRAME_ID_INVALID", retryable: false, outcome_unknown: false,
      });
    }
    return { assetName: value.asset.trim(), expectedId: value.id.toLowerCase() };
  }
  if (/^asset:/i.test(value)) return { assetName: value.slice(ASSET_PREFIX.length).trim() };
  const assetName = uploadedAssetByPath.get(value);
  if (!assetName) throw new Error(`No staged Flow asset was recorded for local frame input: ${basename(value)}`);
  return { assetName, slot };
}

const IMAGE_TIMEOUT_MS = 3 * 60_000;
const VIDEO_TIMEOUT_MS = 12 * 60_000;
const ASSET_PREFIX = "asset:";
const flowMediaUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Bind named asset references to the exact UUID returned by Flow's library read. */
export function bindFlowReferenceIds(references: string[], assets: FlowAsset[]): Array<string | { assetName: string; expectedId: string }> {
  return references.map(value => {
    if (/^character:/i.test(value) || !/^asset:/i.test(value)) return value;
    const name = value.slice(ASSET_PREFIX.length).trim();
    const matches = assets.filter(asset => asset.kind === "image" && asset.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase());
    if (matches.length !== 1) {
      throw Object.assign(new Error(matches.length
        ? `The exact image asset title "${name}" is duplicated in the Flow library; no reference was selected.`
        : `No exact image asset titled "${name}" was returned by Flow's library read; no reference was selected.`), {
        code: matches.length ? "FLOW_ASSET_AMBIGUOUS" : "FLOW_ASSET_NOT_FOUND", retryable: false, outcome_unknown: false,
      });
    }
    const id = matches[0].id;
    if (!id || !flowMediaUuid.test(id)) {
      throw Object.assign(new Error(`Flow did not return a stable UUID for image asset "${name}"; no reference was selected.`), {
        code: "FLOW_ASSET_ID_UNAVAILABLE", retryable: false, outcome_unknown: false,
      });
    }
    return { assetName: name, expectedId: id.toLowerCase() };
  });
}
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
    op: "flowOperation", name: "flow.state", payload: { detailed, includeProgressDiagnostics: true, progressDiagnosticsPing: detailed }, capability: "flow.native.state", timeoutMs: 8_000,
  }, { timeoutMs: 8_000 });
}

export async function getCorrelationObserverHealth(): Promise<{
  ready: boolean;
  version?: number;
  observerRevision?: number;
  projectId?: string | null;
  activeAttempts?: number;
  xhrHookActive?: boolean;
  fetchHookActive?: boolean;
  extensionBuild?: {
    status: "current" | "mismatch" | "unavailable";
    matchesWatcher: boolean;
    backgroundRevision: string | null;
    contentRevision: string | null;
    watcherRevision: string | null;
  };
}> {
  return executeFlowDom({
    op: "flowOperation",
    name: "flow.generation.observer.health",
    payload: {},
    capability: "flow.native.generation.observer.health",
    timeoutMs: 15_000,
  }, { timeoutMs: 20_000 });
}

export async function listFlowProjects(): Promise<FlowProject[]> {
  return executeFlowDom<FlowProject[]>({
    op: "flowOperation", name: "flow.projects.list", payload: {}, capability: "flow.native.projects.list", timeoutMs: 90_000,
  }, { timeoutMs: 100_000 });
}

export async function createFlowProject(): Promise<FlowProject> {
  const result = await executeFlowDom<{ project: FlowProject; created: boolean }>({
    op: "flowOperation", name: "flow.project.create", payload: {}, capability: "flow.native.project.create", timeoutMs: 35_000,
  }, { timeoutMs: 40_000 });
  if (!result?.created || !result.project?.id) {
    throw Object.assign(new Error("Flow did not confirm the newly created project."), {
      code: "FLOW_CREATE_PROJECT_RESULT_UNKNOWN", retryable: false, outcome_unknown: true,
    });
  }
  return result.project;
}

export async function openFlowProject(projectId: string, language?: string): Promise<{ opened: boolean; id: string; url: string; language: string | null }> {
  return executeFlowDom({
    op: "flowOperation", name: "flow.project.open", payload: { projectId, language }, capability: "flow.native.project.open", timeoutMs: 60_000,
  }, { timeoutMs: 65_000 });
}

export async function listFlowVoiceOptions(): Promise<{ voices: string[]; count: number; source: string; readOnly: true }> {
  return nativeOperation("flow.voices.options", {}, "flow.native.voices.options", undefined, 35_000);
}

export async function runGeneration(job: Job): Promise<string[]> {
  const s = job.params;
  validateFlowSceneCapabilities(s);
  const refs = s.reference_images ?? [];
  const framesMode = s.type === "video" && Boolean(s.first_frame || s.last_frame);
  // Frames and references are mutually exclusive in Flow. When frames are present,
  // keep the frame inputs and ignore references before validating or uploading them.
  const activeRefs = framesMode ? [] : refs;
  const isAssetReference = (value: string) => typeof value === "string" && /^asset:/i.test(value);
  const isCharacterReference = (value: string) => /^character:/i.test(value);
  const localFileSupported = (file?: string) => {
    if (!file || isAssetReference(file) || isCharacterReference(file)) return true;
    try {
      const info = statSync(file);
      return [".png", ".jpg", ".jpeg", ".webp", ".gif", ".heic", ".heif", ".avif"].includes(extname(file).toLowerCase()) && info.isFile() && info.size > 0 && info.size <= 25 * 1024 * 1024;
    } catch { return false; }
  };
  const frameInputSupported = (file?: FrameAssetInput) => !file || (typeof file === "object"
    ? Boolean(file.asset.trim() && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(file.id))
    : !isCharacterReference(file) && localFileSupported(file));
  if ((!framesMode && (refs.length > 3 || !activeRefs.every(localFileSupported))) || !frameInputSupported(s.first_frame) || !frameInputSupported(s.last_frame)) {
    throw Object.assign(new Error("Generation accepts up to three references and PNG/JPG/JPEG/WebP/GIF/HEIC/HEIF/AVIF local inputs up to 25 MiB each."), { code: "NATIVE_CAPABILITY_UNSUPPORTED", retryable: true });
  }
  requireCapabilities(
    "flow.native.generation.submit", "flow.native.generation.observe", "flow.native.asset.download",
  );
  if (activeRefs.length) requireCapabilities("flow.native.references.attach");
  const localInputs = [
    ...(typeof s.first_frame === "string" && !isAssetReference(s.first_frame) ? [{ path: s.first_frame, slot: "start" }] : []),
    ...(typeof s.last_frame === "string" && !isAssetReference(s.last_frame) ? [{ path: s.last_frame, slot: "end" }] : []),
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

  const frame = (value?: FrameAssetInput, slot: "start" | "end" = "start") => mapFlowFrameInput(value, slot, uploadedAssetByPath);

  let boundAssetReferences: Array<string | { assetName: string; expectedId: string }> = activeRefs;
  if (activeRefs.some(isAssetReference)) {
    const assets = await nativeOperation<FlowAsset[]>("flow.assets.list", {}, "flow.native.assets.list", job, 90_000);
    boundAssetReferences = bindFlowReferenceIds(activeRefs, assets);
  }
  const attachments = boundAssetReferences.map((value, index) => typeof value !== "string" ? value : isCharacterReference(value) ? { assetName: value }
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

  const submitted = await nativeOperation<{ submitted: boolean; requestDispatched?: boolean; serverAcceptanceObserved?: boolean; before: string[]; type: MediaKind; expectedCount: number; credits?: number | null; correlationAttemptId?: string }>("flow.generation.submit", {
    prompt: s.prompt, type: s.type, model: s.model, aspectRatio: normalizedRatio, duration: s.duration,
    resolution: s.resolution, variants: s.variants, ...(s.type === "video" ? { maxCredits: s.max_credits } : {}),
    ...(s.voice ? { voice: s.voice } : {}),
    submitOnly: s.submit_only === true,
    firstFrame: frame(s.first_frame, "start"), lastFrame: frame(s.last_frame, "end"), attachments,
  }, "flow.native.generation.submit", job, 120_000);

  // Persist this receipt before checking quote policy or taking any later path.
  // A backend restart after this point can report submit_only work as submitted
  // instead of losing the dispatch evidence with the in-memory Job object.
  job.requestDispatched = submitted.requestDispatched === true;
  job.serverAcceptanceObserved = submitted.serverAcceptanceObserved === true;
  job.persistNow?.();
  if (!submitted.submitted) {
    throw Object.assign(new Error("Native Flow submit did not confirm a submitted request; inspect Flow before retrying."), {
      code: "FLOW_SUBMIT_RECEIPT_INCOMPLETE",
      retryable: false,
      outcome_unknown: submitted.requestDispatched === true,
    });
  }
  if (submitted.requestDispatched !== true) {
    const error = Object.assign(new Error("Flow did not provide correlated evidence that this submit request was dispatched. Inspect Flow before retrying."), {
      code: "FLOW_SUBMIT_DISPATCH_UNCONFIRMED",
      retryable: false,
      outcome_unknown: true,
    });
    throw error;
  }
  if (s.type === "video") {
    const quoteVerified = typeof submitted.credits === "number";
    job.creditQuoteVerified = quoteVerified;
    if (!quoteVerified) {
      throw Object.assign(new Error("Flow dispatched the request but did not return its verified credit quote; inspect Flow before retrying."), {
        code: "FLOW_SUBMIT_RECEIPT_INCOMPLETE",
        retryable: false,
        outcome_unknown: true,
      });
    }
    job.credits = submitted.credits!;
    if (job.credits > s.max_credits) {
      throw Object.assign(new Error(`Flow dispatched a request quoted at ${job.credits} credits, above max_credits=${s.max_credits}; inspect Flow before retrying.`), {
        code: "FLOW_MAX_CREDITS_EXCEEDED",
        retryable: false,
        outcome_unknown: true,
      });
    }
  }
  if (s.submit_only) {
    job.progress = undefined;
    job.note = "Flow submit request was dispatched; rendering and downloads were not awaited.";
    return [];
  }
  const observed = await nativeOperation<{ media: NativeMedia[] }>("flow.generation.observe", {
    before: submitted.before, kind: submitted.type, expectedCount: submitted.expectedCount,
    correlationAttemptId: submitted.correlationAttemptId,
    timeoutMs: s.type === "image" ? IMAGE_TIMEOUT_MS : VIDEO_TIMEOUT_MS, retries: s.retries ?? 2,
  }, "flow.native.generation.observe", job, s.type === "image" ? IMAGE_TIMEOUT_MS : VIDEO_TIMEOUT_MS);
  job.progress = undefined;
  return downloadNativeResults(observed.media, s.output_dir, s.file_stem, s.download_quality ?? "original", job);
}

export async function attachReferences(references: string[], inspectOnly = false): Promise<unknown> {
  requireCapabilities("flow.native.references.attach");
  return nativeOperation("flow.references.attach", { references, ...(inspectOnly ? { inspectOnly: true } : {}) }, "flow.native.references.attach", undefined, 60_000);
}

export async function clearFlowReferences(): Promise<{ cleared: number; remaining: number }> {
  requireCapabilities("flow.native.references.clear");
  return nativeOperation(
    "flow.references.clear",
    {},
    "flow.native.references.clear",
    undefined,
    30_000,
  );
}

export async function removeFlowReferenceKind(kind: "image" | "video" | "character" | "voice"): Promise<{ kind: string; removed: number; remaining: number; confirmed: boolean; prompt_preserved: boolean }> {
  requireCapabilities("flow.native.references.remove");
  return nativeOperation(
    "flow.references.remove",
    { kind },
    "flow.native.references.remove",
    undefined,
    30_000,
  );
}

export async function clearFlowPrompt(expectedPrompt: string): Promise<{ cleared: true; confirmed: true; references_preserved: true; picker_state_preserved: true }> {
  requireCapabilities("flow.native.prompt.clear");
  return nativeOperation(
    "flow.prompt.clear",
    { expectedPrompt },
    "flow.native.prompt.clear",
    undefined,
    30_000,
  );
}

export async function listCharacters(): Promise<FlowCharacter[]> {
  const state = await getFlowState();
  if (!state.signedIn || !state.inProject) throw new Error(state.hint || "Open a signed-in Flow project first.");
  const result = await nativeOperation<unknown>("flow.characters.list", {}, "flow.native.characters.list", undefined, 90_000);
  return normalizeFlowCharacters(result);
}

const flowCharacterUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Normalize extension results from mixed versions without stringifying wrapped objects or exposing arbitrary IDs. */
export function normalizeFlowCharacters(value: unknown): FlowCharacter[] {
  const rows = Array.isArray(value) ? value
    : value && typeof value === "object" && Array.isArray((value as { characters?: unknown }).characters)
      ? (value as { characters: unknown[] }).characters : [];
  const result: FlowCharacter[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    let candidate: unknown = row;
    for (let depth = 0; depth < 4 && candidate && typeof candidate === "object"; depth++) {
      const wrapped = candidate as Record<string, unknown>;
      candidate = typeof wrapped.name === "string" ? wrapped.name
        : wrapped.name && typeof wrapped.name === "object" ? wrapped.name
          : typeof wrapped.character === "string" ? wrapped.character
            : wrapped.character && typeof wrapped.character === "object" ? wrapped.character : undefined;
    }
    const name = typeof candidate === "string" ? candidate.replace(/\s+/g, " ").trim() : "";
    if (!name || seen.has(name.toLocaleLowerCase())) continue;
    seen.add(name.toLocaleLowerCase());
    const record = row && typeof row === "object" ? row as Record<string, unknown> : {};
    const rawId = typeof record.uuid === "string" ? record.uuid : "";
    result.push({ name, ...(flowCharacterUuid.test(rawId) ? { uuid: rawId.toLowerCase() } : {}) });
  }
  return result;
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
  const outputDir = dirname(targetStem);
  mkdirSync(outputDir, { recursive: true });
  const source = await materializeNativeDownload(download, outputDir);
  try {
    if (extname(source).toLowerCase() === ".zip") return unpackTakes(source, targetStem);
    const destination = `${targetStem}${extensionOf(source)}`;
    copyFileSync(source, destination);
    return [destination];
  } finally {
    if (source.startsWith(join(outputDir, "flow-transfer-"))) rmSync(source, { force: true });
  }
}

export async function trashAsset(name: string): Promise<{ trashed: string }> {
  return nativeOperation("flow.asset.trash", { name }, "flow.native.asset.trash", undefined, 30_000);
}

export async function renameAsset(name: string, newName: string, id?: string): Promise<{ renamed: string; name: string }> {
  const exactName = name.replace(/\s+/g, " ").trim();
  const exactNewName = newName.replace(/\s+/g, " ").trim();
  if (!exactName || exactName.length > 120 || !exactNewName || exactName === exactNewName || /[\u0000-\u001f\u007f]/.test(exactNewName) || exactNewName.length > 120 || (id !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))) {
    throw Object.assign(new Error("Provide an exact existing asset title and a different new title of at most 120 characters, without control characters."), { code: "FLOW_INVALID_ARGUMENT", retryable: false, outcome_unknown: false });
  }
  return nativeOperation("flow.asset.rename", { name: exactName, ...(id ? { id } : {}), newName: exactNewName }, "flow.native.asset.rename", undefined, 35_000);
}
