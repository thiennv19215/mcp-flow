import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { assemble } from "./assemble.js";
import { clearFlowPrompt, createFlowProject, downloadAsset, renameAsset, trashAsset, getCorrelationObserverHealth, getFlowState, listAssets, listCharacters, listFlowProjects, listFlowVoiceOptions, openFlowProject, rememberCharacter, uploadFlowMediaToProject } from "./flow.js";
import type { Job } from "./job-types.js";
import { attachReferences, clearFlowReferences } from "./flow.js";
import { BIN, COMPUTER, IS_MAC, IS_WIN, moveToBin } from "./platform.js";
import { TECHNIQUES } from "./techniques.js";
import { OUTPUT_ROOT, castDirForContext, outputRootForContext, projectDir } from "./paths.js";
import { shapes, type Args } from "./schemas.js";
import { executeFlowDom } from "./extension.js";
import { sanitizeFlowOperationDiagnostics, sanitizeUnknownSubmitDiagnostics } from "./flow-request-diagnostics.js";
import { downloadNativeResults, extensionOf, materializeQueuedNativeDownloads, nativeDownloadIds, waitForNativeDownload } from "./native-downloads.js";
import { characterLook, loadLooks } from "./characters.js";

export { OUTPUT_ROOT, projectDir };
export { shapes, type Args };

export const jobView = ({ id, status, params, files, attempts, credits, progress, note, error, errorCategory, retryAfterAt, failed_scenes, outcomeUnknown, requestDispatched, serverAcceptanceObserved, creditQuoteVerified, requestDiagnostics, operationDiagnostics }: Job) => ({
  id,
  status,
  project: params.output_dir,
  scene: params.file_stem,
  prompt: params.prompt,
  attempts,
  credits,
  credit_quote_verified: creditQuoteVerified ?? null,
  progress,
  files,
  note,
  error,
  error_category: errorCategory,
  retry_after: retryAfterAt,
  failed_scenes,
  outcome_unknown: outcomeUnknown ?? false,
  request_dispatched: requestDispatched ?? false,
  server_acceptance_observed: serverAcceptanceObserved ?? false,
  request_diagnostics: outcomeUnknown ? sanitizeUnknownSubmitDiagnostics(requestDiagnostics) ?? null : null,
  operation_diagnostics: !outcomeUnknown && !requestDispatched ? sanitizeFlowOperationDiagnostics(operationDiagnostics) ?? null : null,
});

// One implementation runs in whichever process owns the Flow tab; the other process talks to it over HTTP (remote.ts).
export interface Core {
  status(a: Args<"status">): Promise<unknown>;
  observer_health(a: Args<"observer_health">): Promise<unknown>;
  clear_prompt(a: Args<"clear_prompt">): Promise<unknown>;
  generate(a: Args<"generate">): Promise<unknown>;
  wait(a: Args<"wait">): Promise<unknown>;
  cancel(a: Args<"cancel">): Promise<unknown>;
  retry(a: Args<"retry">): Promise<unknown>;
  assets(a: Args<"assets">): Promise<unknown>;
  attach_references(a: Args<"attach_references">): Promise<unknown>;
  clear_references(a: Args<"clear_references">): Promise<unknown>;
  upload_media(a: Args<"upload_media">): Promise<unknown>;
  projects(): Promise<unknown>;
  voice_options(): Promise<unknown>;
  create_project(): Promise<unknown>;
  open_project(a: Args<"open_project">): Promise<unknown>;
  download(a: Args<"download">): Promise<unknown>;
  assemble(a: Args<"assemble">): Promise<unknown>;
  techniques(a: Args<"techniques">): Promise<unknown>;
  character(a: Args<"character">): Promise<unknown>;
  characters(): Promise<unknown>;
  character_edit(a: Args<"character_edit">): Promise<unknown>;
  edit(a: Args<"edit">): Promise<unknown>;
  trash(a: Args<"trash">): Promise<unknown>;
  rename_asset(a: Args<"rename_asset">): Promise<unknown>;
  discard(a: Args<"discard">): Promise<unknown>;
  continue_shot(a: Args<"continue_shot">): Promise<unknown>;
  agent(a: Args<"agent">): Promise<unknown>;
  outputs(): Promise<unknown>;
}

// Flow's own voices: still offered when giving a character a voice, but narration no longer goes through Flow.
export const VOICES = [
  { name: "Achernar", description: "female, soft, high pitch" },
  { name: "Achird", description: "male, friendly, mid pitch" },
  { name: "Algenib", description: "male, gravelly, low pitch" },
  { name: "Algieba", description: "male, easy-going, mid-low pitch" },
  { name: "Alnilam", description: "male, firm, mid-low pitch" },
  { name: "Aoede", description: "female, breezy, mid pitch" },
  { name: "Autonoe", description: "female, bright, mid pitch" },
  { name: "Callirrhoe", description: "female, easy-going, mid pitch" },
  { name: "Charon", description: "male, informative, lower pitch" },
  { name: "Despina", description: "female, smooth, mid pitch" },
  { name: "Enceladus", description: "male, breathy, lower pitch" },
  { name: "Erinome", description: "female, clear, mid pitch" },
  { name: "Fenrir", description: "male, excitable, younger pitch" },
  { name: "Gacrux", description: "female, mature, mid pitch" },
  { name: "Iapetus", description: "male, clear, mid-low pitch" },
];

const BUSY = "A generation is running in the Flow tab. Wait for it to finish (flow_wait), then retry.";

type ExtensionQueueJob = {
  id: string; operation: string; payload?: Record<string, any>; metadata?: Record<string, any>;
  label?: string; status: string; result?: any; progress?: any; error?: string; errorCode?: string;
  outcomeUnknown?: boolean; retrySafe?: boolean; attempts?: number; addedAt?: number;
  requestDispatched?: boolean; serverAcceptanceObserved?: boolean; creditQuoteVerified?: boolean; credits?: number;
};
type ExtensionQueueSnapshot = { jobs: ExtensionQueueJob[]; items?: ExtensionQueueJob[]; isRunning?: boolean; isPaused?: boolean; isStopped?: boolean };

async function extensionQueueCall<T = any>(name: string, payload: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
  const capability = `flow.native.${name.slice("flow.".length)}`;
  return executeFlowDom<T>({ op: "flowOperation", name, payload, capability, timeoutMs }, { timeoutMs: timeoutMs + 10_000 });
}

async function extensionQueueSnapshot(): Promise<ExtensionQueueSnapshot> {
  try {
    const result = await extensionQueueCall<ExtensionQueueSnapshot>("flow.queue.get", {}, 20_000);
    return { ...result, jobs: Array.isArray(result?.jobs) ? result.jobs : Array.isArray(result?.items) ? result.items : [] };
  } catch {
    return { jobs: [], isRunning: false, isPaused: false, isStopped: true };
  }
}

function extensionJobParams(job: ExtensionQueueJob): any {
  return job.operation === "flow.generation.submit" ? job.payload || {} : job.payload?.params || job.payload || {};
}

function extensionJobAsLegacy(job: ExtensionQueueJob): Job {
  const params = extensionJobParams(job);
  const outcome = job.result?.result || job.result || {};
  const workflow = job.metadata?.workflow || job.payload?.workflow || params.workflow || {};
  const outputDir = job.metadata?.output_dir || params.output_dir || workflow.output_dir || "";
  const fileStem = job.metadata?.file_stem || params.file_stem || (workflow.sceneNumber ? `scene-${String(workflow.sceneNumber).padStart(2, "0")}` : "");
  const status = ({ pending: "queued", completed: "done", cancelled: "cancelled" } as Record<string, string>)[job.status] || job.status;
  return {
    id: job.id,
    status,
    params: { ...params, output_dir: outputDir, file_stem: fileStem },
    files: job.metadata?.files || [],
    attempts: job.attempts || 0,
    credits: typeof job.credits === "number" ? job.credits : typeof outcome.credits === "number" ? outcome.credits : null,
    creditQuoteVerified: typeof job.creditQuoteVerified === "boolean"
      ? job.creditQuoteVerified
      : typeof outcome.creditQuoteVerified === "boolean" ? outcome.creditQuoteVerified
        : job.operation === "flow.generation.submit" && params.type === "video" && typeof outcome.credits === "number",
    progress: typeof job.progress === "string" ? job.progress : job.progress?.message,
    note: outcome.downloadError || (Array.isArray(outcome.failedScenes) && outcome.failedScenes.length
      ? `Still failed: ${outcome.failedScenes.map((number: number) => `scene ${number}`).join(", ")}`
      : undefined),
    failed_scenes: Array.isArray(outcome.failedScenes) ? outcome.failedScenes : undefined,
    error: job.error || job.metadata?.downloadError,
    errorCategory: job.errorCode?.includes("DOWNLOAD") || job.metadata?.downloadError ? "download" : undefined,
    outcomeUnknown: job.outcomeUnknown === true,
    requestDispatched: job.requestDispatched === true || job.result?.requestDispatched === true,
    serverAcceptanceObserved: job.serverAcceptanceObserved === true || job.result?.result?.serverAcceptanceObserved === true,
    requestDiagnostics: undefined,
    operationDiagnostics: undefined,
  } as unknown as Job;
}

async function queueIsActive(): Promise<boolean> {
  const snapshot = await extensionQueueSnapshot();
  return snapshot.isRunning === true || snapshot.jobs.some(job => ["pending", "running"].includes(job.status));
}

async function materializeQueueJob(job: ExtensionQueueJob): Promise<ExtensionQueueJob> {
  if (job.status !== "completed" || job.metadata?.submit_only === true) return job;
  const params = extensionJobParams(job);
  if (params.submit_only === true || params.submitOnly === true) return job;
  const outputDir = job.metadata?.output_dir || params.output_dir;
  const fileStem = job.metadata?.file_stem || params.file_stem;
  const result = job.result?.result || job.result || {};
  const media = result.media || result.result?.media || (result.portraitMedia ? [result.portraitMedia] : undefined);
  const browserDownloads = result.browserDownloads || result.result?.browserDownloads;
  const downloadError = result.downloadError ? String(result.downloadError) : undefined;
  if (downloadError && (!Array.isArray(browserDownloads) || !browserDownloads.length)) {
    const updated = await extensionQueueCall<{ job: ExtensionQueueJob }>("flow.queue.metadata", {
      id: job.id, patch: { downloadError },
    }, 20_000).catch(() => null);
    return updated?.job || { ...job, metadata: { ...job.metadata, downloadError } };
  }
  if (!outputDir || !fileStem || ((!Array.isArray(media) || !media.length) && (!Array.isArray(browserDownloads) || !browserDownloads.length))) return job;
  const current = job.metadata?.files;
  if (job.metadata?.downloadComplete === true && Array.isArray(current)) return job;
  const legacy = extensionJobAsLegacy(job);
  let files: string[];
  try {
    files = Array.isArray(browserDownloads) && browserDownloads.length
      ? await materializeQueuedNativeDownloads(browserDownloads, outputDir, fileStem, legacy)
      : await downloadNativeResults(media, outputDir, fileStem, params.download_quality || "original", legacy);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const updated = await extensionQueueCall<{ job: ExtensionQueueJob }>("flow.queue.metadata", {
      id: job.id, patch: { downloadError: message },
    }, 20_000).catch(() => null);
    return updated?.job || { ...job, metadata: { ...job.metadata, downloadError: message } };
  }
  const updated = await extensionQueueCall<{ job: ExtensionQueueJob }>("flow.queue.metadata", {
    id: job.id, patch: { files, downloadComplete: true, ...(downloadError ? { downloadError } : {}) },
  }, 20_000);
  return updated.job || { ...job, metadata: { ...job.metadata, files, downloadComplete: true, ...(downloadError ? { downloadError } : {}) } };
}

async function waitExtensionJob(id: string, timeoutMs: number): Promise<ExtensionQueueJob> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const result = await extensionQueueCall<{ job: ExtensionQueueJob | null }>("flow.queue.get", { id }, 20_000);
    const job = result.job;
    if (!job) throw new Error(`No Flow queue job with id ${id}.`);
    if (["completed", "failed", "cancelled"].includes(job.status)) return materializeQueueJob(job);
    await new Promise(resolve => setTimeout(resolve, 1_500));
  }
  throw Object.assign(new Error(`Timed out waiting for Flow queue job ${id}; check flow_status before retrying.`), { code: "FLOW_QUEUE_WAIT_TIMEOUT", outcome_unknown: true });
}

async function enqueueWorkflow(operation: string, payload: Record<string, unknown>, metadata: Record<string, unknown> = {}, timeoutMs = 45_000): Promise<ExtensionQueueJob> {
  const result = await extensionQueueCall<{ job?: ExtensionQueueJob; jobs?: ExtensionQueueJob[] }>("flow.queue.add", {
    job: { operation, payload, metadata, label: String(metadata.label || operation) },
  }, timeoutMs);
  const job = result.job || result.jobs?.[0];
  if (!job) throw new Error("The extension did not return the queued Flow job.");
  return waitExtensionJob(job.id, 12 * 60_000);
}

const castOutputDir = () => castDirForContext();

export class LocalCore implements Core {
  private detailedState: ReturnType<typeof getFlowState> | undefined;
  private mediaUploadActive = false;
  constructor(_scopeId = "local") {}

  async status({ detailed }: Args<"status">) {
    if (this.mediaUploadActive) throw new Error("A media upload is using the Flow tab. Retry after it finishes.");
    const queue = await extensionQueueSnapshot();
    // Studio and MCP can poll at once. Share the account-panel read so one
    // request cannot release focus/close a panel another request is using.
    let flow;
    try {
      flow = detailed && !queue.isRunning
        ? await (this.detailedState ??= getFlowState(true).finally(() => { this.detailedState = undefined; }))
        : await getFlowState(false);
    } catch (error) {
      flow = { url: "", signedIn: false, inProject: false, available: false, hint: `Flow extension did not return its status: ${error instanceof Error ? error.message : String(error)}` };
    }
    return { flow, pacing: queue.isPaused ? "paused" : undefined, output_root: outputRootForContext(), jobs: queue.jobs.map(job => jobView(extensionJobAsLegacy(job))) };
  }

  async observer_health(_args: Args<"observer_health">) {
    if (this.mediaUploadActive || await queueIsActive()) throw new Error("Flow is processing another operation. Check observer health after it finishes.");
    return getCorrelationObserverHealth();
  }

  async clear_prompt({ expected_prompt }: Args<"clear_prompt">) {
    if (this.mediaUploadActive || await queueIsActive()) throw new Error(BUSY);
    this.mediaUploadActive = true;
    try { return await clearFlowPrompt(expected_prompt); }
    finally { this.mediaUploadActive = false; }
  }

  suspendDevice(): void {
    void extensionQueueSnapshot().then(snapshot => Promise.all(snapshot.jobs.filter(job => job.status === "pending").map(job =>
      extensionQueueCall("flow.queue.cancel", { id: job.id }, 10_000),
    ))).catch(() => {});
  }

  async generate({ project, scenes }: Args<"generate">) {
    if (this.mediaUploadActive) throw new Error("A media upload is using the Flow tab. Retry after it finishes.");
    const output_dir = projectDir(project);
    const knownAssets = await listAssets();
    const outputAssets = existsSync(output_dir) ? readdirSync(output_dir).map(name => ({ name, project: output_dir })) : [];
    const { flowCapabilityRegistry } = await import("./flow-capabilities.js");
    const result = await extensionQueueCall<{ jobs: ExtensionQueueJob[] }>("flow.queue.generate", {
      project, output_dir, scenes, knownAssets, outputAssets,
      techniques: TECHNIQUES.map(({ id, phrase }) => ({ id, phrase })),
      characterLooks: loadLooks(), capabilityRegistry: flowCapabilityRegistry,
    }, 60_000);
    return { output_dir, jobs: (result.jobs || []).map(job => jobView(extensionJobAsLegacy(job))) };
  }
  async wait({ job_ids, timeout_seconds }: Args<"wait">) {
    const deadline = Date.now() + timeout_seconds * 1000;
    let queue = await extensionQueueSnapshot();
    let selected = job_ids ? queue.jobs.filter(job => job_ids.includes(job.id)) : queue.jobs;
    while (Date.now() < deadline && selected.some(job => ["pending", "running"].includes(job.status))) {
      await new Promise(resolve => setTimeout(resolve, 2_000));
      queue = await extensionQueueSnapshot();
      selected = job_ids ? queue.jobs.filter(job => job_ids.includes(job.id)) : queue.jobs;
    }
    const jobs: Job[] = [];
    for (const original of selected) {
      const job = await materializeQueueJob(original);
      jobs.push(jobView(extensionJobAsLegacy(job)) as unknown as Job);
    }
    return {
      finished: selected.every(job => !["pending", "running"].includes(job.status)),
      pacing: queue.isPaused ? "paused" : undefined,
      jobs,
    };
  }

  async cancel({ job_id }: Args<"cancel">) {
    const result = await extensionQueueCall<any>("flow.queue.cancel", { id: job_id }, 20_000);
    if (!result?.job) throw new Error(`No job with id ${job_id}. Use flow_status to list jobs.`);
    return jobView(extensionJobAsLegacy(result.job));
  }

  async retry({ job_ids }: Args<"retry">) {
    const queue = await extensionQueueSnapshot();
    for (const id of job_ids || []) {
      const job = queue.jobs.find(item => item.id === id);
      if (job?.outcomeUnknown) throw new Error(`Job ${id} may already have been submitted to Flow. Check the project before retrying to avoid duplicate generation or charges.`);
      if (job?.metadata?.downloadError || (job?.result?.result || job?.result)?.downloadError) throw new Error(`Job ${id} generated media but could not download it. Do not retry generation; use flow_assets and flow_download for the existing result.`);
    }
    const ids = job_ids ?? queue.jobs.filter(job =>
      (job.status === "failed" && job.retrySafe === true) ||
      (job.operation === "flow.agent.batch" && job.status === "completed" && Array.isArray((job.result?.result || job.result)?.failedScenes) && (job.result?.result || job.result).failedScenes.length > 0),
    ).map(job => job.id);
    const jobs: Job[] = [];
    for (const id of ids) {
      const result = await extensionQueueCall<any>("flow.queue.retry", { id }, 30_000);
      if (result?.job) jobs.push(jobView(extensionJobAsLegacy(result.job)) as unknown as Job);
    }
    if (!jobs.length) throw new Error("Nothing to retry: the extension queue has no explicitly safe failed jobs.");
    return { jobs };
  }
  async assets({ kind }: Args<"assets">) {
    if (this.mediaUploadActive) throw new Error("A media upload is using the Flow tab. Retry after it finishes.");
    if (await queueIsActive()) throw new Error(BUSY);
    return (await listAssets()).filter((a) => !kind || a.kind === kind).map(({ name, kind }) => ({ name, kind }));
  }

  async upload_media({ path }: Args<"upload_media">) {
    if (this.mediaUploadActive || await queueIsActive()) throw new Error(BUSY);
    this.mediaUploadActive = true;
    try { return await uploadFlowMediaToProject(path); }
    finally { this.mediaUploadActive = false; }
  }

  async attach_references({ references, inspect_only }: Args<"attach_references">) {
    if (this.mediaUploadActive || await queueIsActive()) throw new Error(BUSY);
    this.mediaUploadActive = true;
    try { return await attachReferences(references, inspect_only === true); }
    finally { this.mediaUploadActive = false; }
  }

  async clear_references(_args: Args<"clear_references">) {
    if (this.mediaUploadActive || await queueIsActive()) throw new Error(BUSY);
    this.mediaUploadActive = true;
    try { return await clearFlowReferences(); }
    finally { this.mediaUploadActive = false; }
  }

  async projects() {
    if (this.mediaUploadActive) throw new Error("A media upload is using the Flow tab. Retry after it finishes.");
    return listFlowProjects();
  }

  async voice_options() {
    if (this.mediaUploadActive || await queueIsActive()) throw new Error(BUSY);
    this.mediaUploadActive = true;
    try { return await listFlowVoiceOptions(); }
    finally { this.mediaUploadActive = false; }
  }

  async create_project() {
    if (this.mediaUploadActive || await queueIsActive()) throw new Error(BUSY);
    return createFlowProject();
  }

  async open_project({ project_id, language = "en" }: Args<"open_project">) {
    if (this.mediaUploadActive) throw new Error("A media upload is using the Flow tab. Retry after it finishes.");
    if (await queueIsActive()) throw new Error(BUSY);
    return openFlowProject(project_id, language);
  }

  async download({ project, assets, quality }: Args<"download">) {
    if (this.mediaUploadActive) throw new Error("A media upload is using the Flow tab. Retry after it finishes.");
    if (await queueIsActive()) throw new Error(BUSY);
    const dir = projectDir(project);
    mkdirSync(dir, { recursive: true });
    const files: string[] = [];
    // Numbering from 1 every call overwrote clips fetched earlier - it destroyed a finished shot once. Carry on from
    // the highest clip-NN already on disk instead.
    let next = Math.max(0, ...readdirSync(dir).map((f) => Number(f.match(/^clip-(\d+)/)?.[1] ?? 0))) + 1;
    for (const name of assets) {
      try {
        files.push(...(await downloadAsset(name, join(dir, `clip-${String(next++).padStart(2, "0")}`), quality)));
      } catch (err) {
        throw new Error(`${err instanceof Error ? err.message : err} (downloaded so far: ${files.length})`);
      }
    }
    return { dir, files };
  }

  async assemble({ project, ...rest }: Args<"assemble">) {
    return assemble({ dir: projectDir(project), ...rest });
  }

  // Everything already downloaded, newest project first, so the panel can show past work after a restart.
  async outputs() {
    const root = outputRootForContext();
    if (!existsSync(root)) return { root, projects: [] };
    const media = /\.(mp4|webm|mov|gif|jpe?g|png|webp|m4a|mp3|wav|aiff?)$/i;
    const projects = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const dir = join(root, d.name);
        const files = readdirSync(dir)
          .filter((f) => media.test(f) && !f.endsWith("-lastframe.jpg"))
          .map((f) => ({ name: f, path: join(dir, f), kind: /\.(mp4|webm|mov)$/i.test(f) ? "video" : /\.(m4a|mp3|wav|aiff?)$/i.test(f) ? "audio" : "image", mtime: statSync(join(dir, f)).mtimeMs }))
          .sort((a, b) => a.name.localeCompare(b.name));
        return { name: d.name, dir, files, mtime: Math.max(0, ...files.map((f) => f.mtime)) };
      })
      .filter((p) => p.files.length)
      .sort((a, b) => b.mtime - a.mtime);
    return { root, projects };
  }

  private localAssets(output_dir: string): string[] {
    return existsSync(output_dir) ? readdirSync(output_dir) : [];
  }
  async agent({ project, scenes, aspect_ratio, download_quality, submit_only }: Args<"agent">) {
    if (this.mediaUploadActive) throw new Error("A media upload is using the Flow tab. Retry after it finishes.");
    const output_dir = projectDir(project);
    const result = await extensionQueueCall<any>("flow.queue.agent", {
      project, output_dir, scenes, aspect_ratio, download_quality, submit_only,
      outputAssets: this.localAssets(output_dir).map(name => ({ name, project: output_dir })),
    }, 45_000);
    return { output_dir, jobs: (result.jobs || []).map((job: ExtensionQueueJob) => jobView(extensionJobAsLegacy(job))) };
  }
  async edit({ project, asset, prompt, download_quality, submit_only }: Args<"edit">) {
    if (this.mediaUploadActive) throw new Error("A media upload is using the Flow tab. Retry after it finishes.");
    const output_dir = projectDir(project);
    const result = await extensionQueueCall<any>("flow.queue.edit", {
      project, output_dir, asset, prompt, download_quality, submit_only,
      outputAssets: this.localAssets(output_dir).map(name => ({ name, project: output_dir })),
    }, 45_000);
    return { output_dir, jobs: (result.jobs || []).map((job: ExtensionQueueJob) => jobView(extensionJobAsLegacy(job))) };
  }
  // Flow's composer takes a start frame OR a character, never both; agent mode takes both, so this goes that way.
  async continue_shot({ project, from_asset, prompt, attach, aspect_ratio, mode, download_quality, force, submit_only }: Args<"continue_shot">) {
    if (this.mediaUploadActive) throw new Error("A media upload is using the Flow tab. Retry after it finishes.");
    const output_dir = projectDir(project);
    const knownAssets = await listAssets();
    const result = await extensionQueueCall<any>("flow.queue.continue", {
      project, output_dir, from_asset, prompt, attach, aspect_ratio, mode, download_quality, force, submit_only,
      knownAssets,
      outputAssets: this.localAssets(output_dir).map(name => ({ name, project: output_dir })),
    }, 45_000);
    return { output_dir, jobs: (result.jobs || []).map((job: ExtensionQueueJob) => jobView(extensionJobAsLegacy(job))) };
  }
  // Moves a file or a project folder from the films folder to the system's bin - recoverable from there, never
  // erased. Anything outside the films folder is refused, so a bad path can never reach the rest of the Mac.
  async discard({ path }: Args<"discard">) {
    const target = resolve(path);
    // relative() works with either separator; a path that climbs out ("..") or lands on another drive is refused.
    const rel = relative(outputRootForContext(), target);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Only things inside your films folder can be moved to the bin from here.");
    if (!existsSync(target)) throw new Error("That file is already gone.");
    return { trashed: target, to: moveToBin(target), bin: BIN };
  }

  async trash({ name }: Args<"trash">) {
    if (this.mediaUploadActive) throw new Error("A media upload is using the Flow tab. Retry after it finishes.");
    if (await queueIsActive()) throw new Error(BUSY);
    return trashAsset(name);
  }

  async rename_asset({ name, id, new_name }: Args<"rename_asset">) {
    if (this.mediaUploadActive) throw new Error("A media upload is using the Flow tab. Retry after it finishes.");
    if (await queueIsActive()) throw new Error(BUSY);
    return renameAsset(name, new_name, id);
  }

  async character(a: Args<"character">) {
    if (this.mediaUploadActive) throw new Error("A media upload is using the Flow tab. Retry after it finishes.");
    if (await queueIsActive()) throw new Error(BUSY);
    if (!a.image && !a.describe) throw new Error("Pass either `describe` (Flow draws the portrait) or `image`.");
    let characterInput = { ...a };
    if (a.image && !/^asset:/i.test(a.image)) {
      const uploaded = await uploadFlowMediaToProject(a.image);
      characterInput = { ...characterInput, image: `asset:${uploaded.name}` };
    }
    const output_dir = castOutputDir();
    const file_stem = a.name.replace(/[^\w.-]+/g, "_");
    const job = await enqueueWorkflow("flow.character.create", { character: characterInput }, {
      output_dir, file_stem, character: true, label: `Create character ${a.name}`,
    }, 30_000);
    if (job.status !== "completed") throw new Error(job.error || `Character creation did not complete (${job.status}).`);
    const result = job.result?.result || job.result || {};
    const portrait = job.metadata?.files?.[0];
    if (a.describe) rememberCharacter(a.name, a.describe);
    return { name: result.name || a.name, url: result.url, portrait, ...(result.cleanupWarning ? { cleanupWarning: result.cleanupWarning } : {}), use_as: `character:${a.name}` };
  }

  async character_edit({ name, rename, change, look }: Args<"character_edit">) {
    if (this.mediaUploadActive) throw new Error("A media upload is using the Flow tab. Retry after it finishes.");
    if (await queueIsActive()) throw new Error(BUSY);
    const output_dir = castOutputDir();
    const targetName = rename || name;
    const before = await nativeDownloadIds();
    const job = await enqueueWorkflow("flow.character.edit", { name, change, rename, timeoutMs: 4 * 60_000 }, {
      output_dir, file_stem: targetName.replace(/[^\w.-]+/g, "_"), character: true, label: `Edit character ${name}`,
    }, 30_000);
    if (job.status !== "completed") throw new Error(job.error || `Character edit did not complete (${job.status}).`);
    const result = job.result?.result || job.result || {};
    let portrait: string | undefined;
    let note = result.note;
    if (result.downloadTriggered) {
      try {
        const downloaded = await waitForNativeDownload(before, 90_000);
        mkdirSync(output_dir, { recursive: true });
        portrait = join(output_dir, `${targetName.replace(/[^\w.-]+/g, "_")}${extensionOf(downloaded.filename)}`);
        copyFileSync(downloaded.filename, portrait);
      } catch (error) {
        note = `${change ? `${name} was changed in Flow, but the new` : "The"} portrait could not be saved (${error instanceof Error ? error.message : String(error)}). Call flow_character_edit with just the name to save it.`;
      }
    }
    // Every scene that references the character quotes this description in its character lock, so it has to describe
    // the NEW look - "deep navy coat" left in it would argue with a portrait whose coat is now red.
    if (look) rememberCharacter(targetName, look);
    else if (change) rememberCharacter(targetName, `${characterLook(name) ?? ""} Changed since, and this wins over anything above: ${change.replace(/[.\s]+$/, "")}`.trim());
    return { name: result.name || targetName, portrait: portrait || job.metadata?.files?.[0], note, ...(result.cleanupWarning ? { cleanupWarning: result.cleanupWarning } : {}), use_as: `character:${targetName}` };
  }

  async characters() {
    if (this.mediaUploadActive) throw new Error("A media upload is using the Flow tab. Retry after it finishes.");
    if (await queueIsActive()) throw new Error(BUSY);
    return (await listCharacters()).map((character) => ({
      ...character,
      use_as: `character:${character.name}`,
    }));
  }

  async techniques({ category }: Args<"techniques">) {
    return TECHNIQUES.filter((t) => !category || t.category === category);
  }

}
