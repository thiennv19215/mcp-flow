import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import type { Job } from "./job-types.js";
import { executeFlowDom, extensionSupportsCapability } from "./extension.js";
import { nativeDownloadIds, waitForNativeDownload, extensionOf, materializeNativeDownload, unpackTakes } from "./native-downloads.js";
import type { FlowState, FlowAsset, FlowProject, FlowCharacter, DownloadQuality, MediaKind, NativeMedia, CharacterParams } from "./types.js";

export type { FlowState, FlowAsset, FlowProject, FlowCharacter, DownloadQuality, MediaKind, NativeMedia, CharacterParams };
export { characterLook, rememberCharacter } from "./characters.js";
export { uploadFlowMediaToProject } from "./flow-transfer.js";

const VIDEO_TIMEOUT_MS = 12 * 60_000;

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
