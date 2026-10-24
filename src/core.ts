import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { assemble } from "./assemble.js";
import { clearFlowPrompt, createFlowProject, downloadAsset, renameAsset, trashAsset, getCorrelationObserverHealth, getFlowState, listAssets, listCharacters, listFlowProjects, listFlowVoiceOptions, openFlowProject, rememberCharacter, uploadFlowMediaToProject } from "./flow.js";
import type { Job } from "./job-types.js";
import { attachReferences, clearFlowReferences, removeFlowReferenceKind } from "./flow.js";
import { BIN, COMPUTER, IS_MAC, IS_WIN, moveToBin } from "./platform.js";
import { TECHNIQUES, techniqueById } from "./techniques.js";
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

export const CHATGPT_GENERATION_OPERATION = "chatgpt.generation.submit";

// Arguments for the ChatGPT generation surface. The queue payload built
// from these is the one GPT-09's admission preflight validates and the
// content-side submit-payload builder (GPT-02) consumes at drain time:
// prompt/ratio/model pass through, refs travel as payload-carrying
// `attachments` records (uploaded references only — bare library/tile ids
// are rejected by that preflight, never resolved here).
export interface ChatGptGenerateArgs {
  project: string;
  prompt: string;
  file_stem?: string;
  ratio?: string;
  model?: string;
  conversation_id?: string;
  refs?: Array<Record<string, unknown>>;
  timeout_ms?: number;
}

// One implementation runs in whichever process owns the Flow tab; the other process talks to it over HTTP (remote.ts).
export interface Core {
  status(a: Args<"status">): Promise<unknown>;
  observer_health(a: Args<"observer_health">): Promise<unknown>;
  clear_prompt(a: Args<"clear_prompt">): Promise<unknown>;
  generate(a: Args<"generate">): Promise<unknown>;
  // Optional on the interface: the method stays optional so a Core
  // implementation without the ChatGPT surface answers chatgpt_generate
  // with a clear error (handled in mcp-tools.ts) instead of the tool
  // silently missing. RemoteCore forwards it like its other methods.
  chatgpt_generate?(a: ChatGptGenerateArgs): Promise<unknown>;
  // Optional for the same reason as chatgpt_generate above: a Core
  // without the workflow-graph surface answers flow_run_workflow with
  // a clear error (handled in mcp-tools.ts). LocalCore implements it;
  // RemoteCore forwards it like its other methods.
  run_workflow_graph?(a: RunWorkflowGraphArgs): Promise<unknown>;
  wait(a: Args<"wait">): Promise<unknown>;
  cancel(a: Args<"cancel">): Promise<unknown>;
  retry(a: Args<"retry">): Promise<unknown>;
  assets(a: Args<"assets">): Promise<unknown>;
  attach_references(a: Args<"attach_references">): Promise<unknown>;
  clear_references(a: Args<"clear_references">): Promise<unknown>;
  remove_reference_kind(a: Args<"remove_reference_kind">): Promise<unknown>;
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
const BUSY = "A generation is running in the Flow tab. Wait for it to finish (flow_wait), then retry.";

type ExtensionQueueJob = {
  id: string; operation: string; payload?: Record<string, any>; metadata?: Record<string, any>;
  label?: string; status: string; result?: any; progress?: any; error?: string; errorCode?: string;
  outcomeUnknown?: boolean; retrySafe?: boolean; attempts?: number; addedAt?: number; diagnostics?: any;
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

function isChatGptQueueJob(job: ExtensionQueueJob): boolean {
  return typeof job.operation === "string" && job.operation.startsWith("chatgpt.");
}

function extensionJobParams(job: ExtensionQueueJob): any {
  // A ChatGPT submit payload IS the job params (prompt/ratio/model/...),
  // like flow.generation.submit — it is not wrapped in a `params` key.
  return job.operation === "flow.generation.submit" || isChatGptQueueJob(job) ? job.payload || {} : job.payload?.params || job.payload || {};
}

export function extensionJobAsLegacy(job: ExtensionQueueJob): Job {
  const params = extensionJobParams(job);
  const outcome = job.result?.result || job.result || {};
  const chatGpt = isChatGptQueueJob(job);
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
    // ChatGPT jobs have no credit accounting at all: credits stay null even
    // if a job/result record happens to carry a numeric credits field, and
    // no credit quote is ever verified for them.
    credits: chatGpt ? null : typeof job.credits === "number" ? job.credits : typeof outcome.credits === "number" ? outcome.credits : null,
    creditQuoteVerified: chatGpt ? false : typeof job.creditQuoteVerified === "boolean"
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
    requestDiagnostics: job.diagnostics?.requestDiagnostics,
    operationDiagnostics: job.diagnostics?.operationDiagnostics,
  } as unknown as Job;
}

async function queueIsActive(core?: any): Promise<boolean> {
  const snapshot = await extensionQueueSnapshot();
  return snapshot.isRunning === true || snapshot.jobs.some(job => ["pending", "running", "waiting_for_user"].includes(job.status));
}

function chatGptResultImageUrls(result: any): string[] {
  const urls = result?.imageUrls;
  return Array.isArray(urls) ? urls.filter((url): url is string => typeof url === "string" && url.length > 0) : [];
}

const CHATGPT_IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif", "image/avif": ".avif",
};

// ChatGPT results arrive as plain result URLs on the job record (no Flow
// asset id to trigger, no browser download to adopt), so materializing
// fetches the bytes directly. An HTML payload is refused with the same
// DL-07 code the native download paths use — a sign-in page is not media.
async function downloadChatGptImageUrls(imageUrls: string[], outputDir: string, fileStem: string): Promise<string[]> {
  mkdirSync(outputDir, { recursive: true });
  const files: string[] = [];
  for (const [index, url] of imageUrls.entries()) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`ChatGPT image download failed (${response.status}) for ${url}.`);
    const contentType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    const bytes = Buffer.from(await response.arrayBuffer());
    const head = bytes.subarray(0, 512).toString("utf8").trimStart().toLowerCase();
    if (contentType === "text/html" || contentType === "application/xhtml+xml" || head.startsWith("<!doctype") || head.startsWith("<html")) {
      throw Object.assign(new Error(`ChatGPT image download returned an HTML page instead of image bytes for ${url}; the HTML payload is not the generated media.`), {
        code: "FLOW_DOWNLOAD_HTML_RESPONSE", retryable: false, outcome_unknown: false,
      });
    }
    let extension = CHATGPT_IMAGE_EXTENSIONS[contentType] || "";
    if (!extension) {
      try { extension = extname(new URL(url).pathname).toLowerCase(); } catch { extension = ""; }
    }
    if (!/^\.(png|jpe?g|webp|gif|avif)$/.test(extension)) extension = ".png";
    const destination = join(outputDir, `${imageUrls.length > 1 ? `${fileStem}-v${index + 1}` : fileStem}${extension}`);
    writeFileSync(destination, bytes);
    files.push(destination);
  }
  return files;
}

// Arguments for the workflow-graph run surface (FEAT-07). The graph
// document stays permissive here — the extension's graph module
// validates node types, ports and config — and only the envelope the
// bridge command needs is pinned: the graph, the project it runs
// against, and the run controls.
export interface RunWorkflowGraphArgs {
  graph: Record<string, unknown>;
  project: string;
  output_dir?: string;
  auto_start?: boolean;
}

export async function materializeQueueJob(job: ExtensionQueueJob): Promise<ExtensionQueueJob> {
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
  if (isChatGptQueueJob(job)) {
    // ChatGPT branch: the runner records { imageUrls, turnId } on the job
    // result; materialization is what turns those URLs into files[].
    const imageUrls = chatGptResultImageUrls(result);
    if (!outputDir || !fileStem || !imageUrls.length) return job;
    if (job.metadata?.downloadComplete === true && Array.isArray(job.metadata?.files)) return job;
    let files: string[];
    try {
      files = await downloadChatGptImageUrls(imageUrls, outputDir, fileStem);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const updated = await extensionQueueCall<{ job: ExtensionQueueJob }>("flow.queue.metadata", {
        id: job.id, patch: { downloadError: message },
      }, 20_000).catch(() => null);
      return updated?.job || { ...job, metadata: { ...job.metadata, downloadError: message } };
    }
    // Unlike the Flow path below, a failed metadata write must not bury
    // files that are already on disk: fall back to the locally merged job.
    const updated = await extensionQueueCall<{ job: ExtensionQueueJob }>("flow.queue.metadata", {
      id: job.id, patch: { files, downloadComplete: true },
    }, 20_000).catch(() => null);
    return updated?.job || { ...job, metadata: { ...job.metadata, files, downloadComplete: true } };
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
    // Manual submit jobs are deliberately paused after staging the prompt in
    // the Flow tab. Return that state to Studio/MCP so callers can surface the
    // extension action instead of waiting until the request times out.
    if (["completed", "failed", "cancelled", "waiting_for_user"].includes(job.status)) return materializeQueueJob(job);
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

// The generic queue submission for one ChatGPT image generation — the same
// flow.queue.add machinery enqueueWorkflow uses for Flow operations, with
// the chatgpt operation GPT-09's preflight admits and GPT-02's builder
// consumes. Pure: building the job record never touches the bridge.
export function chatGptGenerationQueueJob(args: ChatGptGenerateArgs): {
  operation: string; payload: Record<string, unknown>; metadata: Record<string, unknown>; label: string;
} {
  const payload: Record<string, unknown> = { prompt: args.prompt };
  if (args.ratio) payload.ratio = args.ratio;
  if (args.model) payload.model = args.model;
  if (args.refs?.length) payload.attachments = args.refs;
  if (args.conversation_id) payload.conversationId = args.conversation_id;
  if (args.timeout_ms) payload.timeoutMs = args.timeout_ms;
  const file_stem = args.file_stem || "chatgpt-01";
  return {
    operation: CHATGPT_GENERATION_OPERATION,
    payload,
    metadata: { provider: "chatgpt", source: "mcp", output_dir: projectDir(args.project), file_stem },
    label: `ChatGPT image: ${args.prompt.slice(0, 80)}`,
  };
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
    if (this.mediaUploadActive || await queueIsActive(this)) throw new Error("Flow is processing another operation. Check observer health after it finishes.");
    return getCorrelationObserverHealth();
  }

  async clear_prompt({ expected_prompt }: Args<"clear_prompt">) {
    if (this.mediaUploadActive || await queueIsActive(this)) throw new Error(BUSY);
    this.mediaUploadActive = true;
    try { return await clearFlowPrompt(expected_prompt); }
    finally { this.mediaUploadActive = false; }
  }

  async generate({ project, scenes }: Args<"generate">) {
    if (this.mediaUploadActive) throw new Error("A media upload is using the Flow tab. Retry after it finishes.");
    const invalid = scenes.findIndex((s, i) => s.chain_previous && (i === 0 || s.first_frame || s.type === "image"));
    if (invalid >= 0) {
      throw new Error(`Scene ${invalid + 1}: chain_previous needs a preceding video scene in the same call and cannot be combined with first_frame.`);
    }
    const noPrev = scenes.findIndex((s, i) => s.reference_previous && i === 0);
    if (noPrev >= 0) throw new Error("Scene 1 has no previous scene to reference.");
    const unknown = scenes.find((s) => s.technique && !techniqueById(s.technique));
    if (unknown) throw new Error(`Unknown technique "${unknown.technique}". Call flow_techniques for valid ids.`);
    const videoReferenceScene = scenes.findIndex(scene => scene.video_reference);
    if (videoReferenceScene >= 0) {
      throw Object.assign(new Error(`Scene ${videoReferenceScene + 1}: Toby-style video-reference editing requires Flow's dynamic video_edit_submit RPC configuration, which is not available in the native extension yet. Nothing was submitted.`), {
        code: "FLOW_VIDEO_REFERENCE_CONFIG_UNAVAILABLE",
        category: "unsupported",
        retryable: false,
        outcome_unknown: false,
      });
    }

    const output_dir = projectDir(project);
    const knownAssets = await listAssets();
    const outputAssets = existsSync(output_dir) ? readdirSync(output_dir).map(name => ({ name, project: output_dir })) : [];
    const flowCapabilityRegistry = JSON.parse(readFileSync(new URL("../flow-model-capabilities.json", import.meta.url), "utf8"));
    const result = await extensionQueueCall<{ jobs: ExtensionQueueJob[] }>("flow.queue.generate", {
      project, output_dir, scenes, knownAssets, outputAssets,
      techniques: TECHNIQUES.map(({ id, phrase }) => ({ id, phrase })),
      characterLooks: loadLooks(), capabilityRegistry: flowCapabilityRegistry,
    }, 60_000);
    return { output_dir, jobs: (result.jobs || []).map(job => jobView(extensionJobAsLegacy(job))) };
  }

  async chatgpt_generate(args: ChatGptGenerateArgs) {
    if (!args?.project?.trim()) throw new Error("chatgpt_generate needs a project folder name for the downloaded images.");
    if (!args?.prompt?.trim()) throw new Error("chatgpt_generate needs a non-empty prompt.");
    const queued = chatGptGenerationQueueJob(args);
    const result = await extensionQueueCall<{ job?: ExtensionQueueJob; jobs?: ExtensionQueueJob[] }>("flow.queue.add", {
      job: queued,
    }, 45_000);
    const job = result.job || result.jobs?.[0];
    if (!job) throw new Error("The extension did not return the queued ChatGPT job.");
    return { output_dir: queued.metadata.output_dir as string, jobs: [jobView(extensionJobAsLegacy(job))] };
  }

  // FEAT-07 follow-up: forward one workflow-graph run to the extension
  // bridge command the graph run store serves. The worker validates,
  // levels and compiles the graph, enqueues the first runnable level
  // and returns the run record plus that level's jobs — later levels
  // follow from the worker's own snapshot fold, so this returns as soon
  // as the run is admitted instead of waiting for it to finish. The
  // bridge payload spells the flag autoStart (the worker's reader);
  // output_dir defaults to the project's folder, like the SW handler's
  // own fallback to the project name.
  async run_workflow_graph(args: RunWorkflowGraphArgs) {
    if (!args?.project?.trim()) throw new Error("flow_run_workflow needs a project folder name for the workflow run.");
    if (!args?.graph || typeof args.graph !== "object" || Array.isArray(args.graph)) {
      throw new Error("flow_run_workflow needs a workflow graph document (an object with nodes and edges).");
    }
    const result = await extensionQueueCall<{ run: unknown; jobs?: ExtensionQueueJob[] }>("flow.queue.workflow", {
      graph: args.graph,
      project: args.project,
      output_dir: args.output_dir ?? projectDir(args.project),
      autoStart: args.auto_start,
    }, 45_000);
    return { run: result.run, jobs: (result.jobs || []).map(job => jobView(extensionJobAsLegacy(job))) };
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
      finished: selected.every(job => !["pending", "running", "waiting_for_user"].includes(job.status)),
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
      if (job?.metadata?.downloadError || (job?.result?.result || job?.result)?.downloadError || String(job?.errorCode || "").toUpperCase().includes("DOWNLOAD")) {
        throw new Error(`Job ${id} generated media but could not download it. Do not retry generation; use flow_assets and flow_download for the existing result.`);
      }
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
    if (await queueIsActive(this)) throw new Error(BUSY);
    return (await listAssets()).filter((a) => !kind || a.kind === kind).map(({ name, kind }) => ({ name, kind }));
  }

  async upload_media({ path }: Args<"upload_media">) {
    if (this.mediaUploadActive || await queueIsActive(this)) throw new Error(BUSY);
    this.mediaUploadActive = true;
    try { return await uploadFlowMediaToProject(path); }
    finally { this.mediaUploadActive = false; }
  }

  async attach_references({ references, inspect_only }: Args<"attach_references">) {
    if (this.mediaUploadActive || await queueIsActive(this)) throw new Error(BUSY);
    this.mediaUploadActive = true;
    try { return await attachReferences(references, inspect_only === true); }
    finally { this.mediaUploadActive = false; }
  }

  async clear_references(_args: Args<"clear_references">) {
    if (this.mediaUploadActive || await queueIsActive(this)) throw new Error(BUSY);
    this.mediaUploadActive = true;
    try { return await clearFlowReferences(); }
    finally { this.mediaUploadActive = false; }
  }

  async remove_reference_kind({ kind }: Args<"remove_reference_kind">) {
    if (this.mediaUploadActive || await queueIsActive(this)) throw new Error(BUSY);
    this.mediaUploadActive = true;
    try { return await removeFlowReferenceKind(kind); }
    finally { this.mediaUploadActive = false; }
  }

  async projects() {
    if (this.mediaUploadActive) throw new Error("A media upload is using the Flow tab. Retry after it finishes.");
    return listFlowProjects();
  }

  async voice_options() {
    if (this.mediaUploadActive || await queueIsActive(this)) throw new Error(BUSY);
    this.mediaUploadActive = true;
    try { return await listFlowVoiceOptions(); }
    finally { this.mediaUploadActive = false; }
  }

  async create_project() {
    if (this.mediaUploadActive || await queueIsActive(this)) throw new Error(BUSY);
    return createFlowProject();
  }

  async open_project({ project_id, language }: Args<"open_project">) {
    if (this.mediaUploadActive) throw new Error("A media upload is using the Flow tab. Retry after it finishes.");
    if (await queueIsActive(this)) throw new Error(BUSY);
    return openFlowProject(project_id, language);
  }

  async download({ project, assets, quality }: Args<"download">) {
    if (this.mediaUploadActive) throw new Error("A media upload is using the Flow tab. Retry after it finishes.");
    if (await queueIsActive(this)) throw new Error(BUSY);
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
    if (await queueIsActive(this)) throw new Error(BUSY);
    return trashAsset(name);
  }

  async rename_asset({ name, id, new_name }: Args<"rename_asset">) {
    if (this.mediaUploadActive) throw new Error("A media upload is using the Flow tab. Retry after it finishes.");
    if (await queueIsActive(this)) throw new Error(BUSY);
    return renameAsset(name, new_name, id);
  }

  async character(a: Args<"character">) {
    if (this.mediaUploadActive) throw new Error("A media upload is using the Flow tab. Retry after it finishes.");
    if (await queueIsActive(this)) throw new Error(BUSY);
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
    if (await queueIsActive(this)) throw new Error(BUSY);
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
    if (await queueIsActive(this)) throw new Error(BUSY);
    return (await listCharacters()).map((character) => ({
      ...character,
      use_as: `character:${character.name}`,
    }));
  }

  async techniques({ category }: Args<"techniques">) {
    return TECHNIQUES.filter((t) => !category || t.category === category);
  }

}
