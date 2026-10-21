// Legacy local-MCP queue retained for compatibility with existing persisted jobs and older integrations.
// LocalCore no longer instantiates it; active Flow jobs are owned by extension/background/flow-job-queue.js.
import { randomUUID } from "node:crypto";
const memJobs = new Map<string, Job[]>();
const loadJobs = (scope = "default"): Job[] => memJobs.get(scope) || [];
const saveJob = (scope = "default", job: Job): void => {
  const list = memJobs.get(scope) || [];
  const idx = list.findIndex(j => j.id === job.id);
  if (idx >= 0) list[idx] = job; else list.push(job);
  memJobs.set(scope, list);
};
import { classifyFlowFailure, type FlowErrorCategory } from "./flow-error-policy.js";
import { sanitizeFlowOperationDiagnostics, sanitizeUnknownSubmitDiagnostics, type SafeFlowOperationDiagnostics, type SafeUnknownSubmitDiagnostics } from "./flow-request-diagnostics.js";

export type JobStatus = "queued" | "running" | "submitted" | "done" | "failed" | "cancelled";

export type FrameAssetInput = string | { asset: string; id: string };

export interface SceneParams {
  prompt: string;
  type: "video" | "image";
  max_credits: number;
  submit_only?: boolean;
  duration?: 4 | 6 | 8 | 10;
  resolution?: "360p" | "720p";
  model?: string;
  aspect_ratio?: "16:9" | "9:16" | "1:1" | "4:3" | "3:4";
  variants?: number;
  first_frame?: FrameAssetInput;
  last_frame?: FrameAssetInput;
  voice?: string;
  reference_images?: string[];
  video_reference?: { asset: string; start_frame_index: number; end_frame_index: number };
  chain_from?: string;
  reference_from?: string;
  edit_asset?: string;
  agent_scenes?: string[];
  // The scene number each agent scene is saved as. A retry of scenes 7 and 12 keeps scene-07 and scene-12; without it
  // the numbers run on from file_stem.
  agent_numbers?: number[];
  continue_from?: string;
  attach?: string[];
  continue_mode?: "exact" | "likeness";
  retries?: number;
  download_quality?: "original" | "upscaled";
  output_dir: string;
  file_stem: string;
}

export interface Job {
  id: string;
  status: JobStatus;
  params: SceneParams;
  files: string[];
  attempts: number;
  credits?: number;
  progress?: string;
  note?: string;
  error?: string;
  errorCategory?: FlowErrorCategory;
  retryAfterAt?: string;
  // True when Flow may have accepted a submit but the backend could not confirm its result.
  // Such a job must not be retried automatically or from the Retry button.
  outcomeUnknown?: boolean;
  requestDispatched?: boolean;
  serverAcceptanceObserved?: boolean;
  creditQuoteVerified?: boolean;
  requestDiagnostics?: SafeUnknownSubmitDiagnostics;
  operationDiagnostics?: SafeFlowOperationDiagnostics;
  // Queue-owned synchronous durability hook. Functions are omitted by JSON.stringify.
  persistNow?: () => void;
  // Scene numbers a batch still could not make after all its own retries; flow_retry redoes just these.
  failed_scenes?: number[];
  createdAt: string;
  finishedAt?: string;
}

export type JobRunner = (job: Job) => Promise<string[]>;

// Flow is driven one generation at a time, with a short randomized pause between jobs.
const PAUSE_MIN_MS = Number(process.env.FLOW_MCP_PAUSE_MIN_S ?? 5) * 1000;
const PAUSE_MAX_MS = Number(process.env.FLOW_MCP_PAUSE_MAX_S ?? 10) * 1000;

export class JobQueue {
  private jobs = new Map<string, Job>();
  private working = false;
  private lastFinished = 0;
  pausedReason: string | null = null;

  constructor(private runner: JobRunner, private scopeId = "local") {
    for (const job of loadJobs(scopeId)) {
      job.persistNow = () => this.persist(job);
      // The SQLite status column predates the `submitted` state. Recover submit-only
      // receipts from the durable job data, whose dispatched flag is written first.
      if (job.status === "done" && job.params.submit_only && job.requestDispatched) {
        job.status = "submitted";
      }
      if (job.status === "running") {
        job.finishedAt = new Date().toISOString();
        job.progress = undefined;
        if (job.params.submit_only && job.requestDispatched === true) {
          job.status = "submitted";
          job.outcomeUnknown = false;
          job.error = undefined;
          job.errorCategory = undefined;
          job.note = job.serverAcceptanceObserved
            ? "Flow accepted the dispatched request; rendering was not awaited."
            : "Flow request dispatch was confirmed before backend restart; server acceptance is unknown and rendering was not awaited.";
        } else {
          // A restart cannot tell whether an interrupted operation reached submit.
          // Keep it visible and block retry rather than risk a duplicate generation.
          job.status = "failed";
          job.outcomeUnknown = true;
          job.errorCategory = "extension";
          job.error = "Backend restarted while this job was running. Check the Flow project before retrying; its outcome is unknown.";
        }
        this.persist(job);
      }
      if (job.error && !job.errorCategory) {
        job.errorCategory = classifyFlowFailure({ message: job.error, outcome_unknown: job.outcomeUnknown }).category;
        this.persist(job);
      }
      this.jobs.set(job.id, job);
    }
  }

  resume(): void { void this.work(); }

  add(params: SceneParams): Job {
    const job: Job = {
      id: randomUUID().slice(0, 8),
      status: "queued",
      params,
      files: [],
      attempts: 0,
      createdAt: new Date().toISOString(),
    };
    job.persistNow = () => this.persist(job);
    this.jobs.set(job.id, job);
    this.persist(job);
    void this.work();
    return job;
  }

  get busy(): boolean {
    return this.list().some((j) => j.status === "running");
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  persist(job: Job): void {
    // The legacy SQLite status CHECK accepts `done` but not `submitted`. The JSON
    // payload is authoritative on load; normalize that column value and reconstruct
    // `submitted` from submit_only + requestDispatched during recovery.
    const durable = job.status === "submitted" ? { ...job, status: "done" as const } : job;
    saveJob(this.scopeId, durable);
  }

  list(): Job[] {
    return [...this.jobs.values()];
  }

  // Puts a failed or cancelled job back in line with the same settings and file name.
  retry(id: string): Job | undefined {
    const job = this.jobs.get(id);
    if (job && !job.outcomeUnknown && (job.status === "failed" || job.status === "cancelled")) {
      job.status = "queued";
      job.error = undefined;
      job.errorCategory = undefined;
      job.retryAfterAt = undefined;
      job.operationDiagnostics = undefined;
      job.finishedAt = undefined;
      this.persist(job);
      void this.work();
    }
    return job;
  }

  cancel(id: string): Job | undefined {
    const job = this.jobs.get(id);
    if (job && job.status === "queued") {
      job.status = "cancelled";
      job.finishedAt = new Date().toISOString();
      this.persist(job);
    }
    return job;
  }

  cancelQueued(): void {
    for (const job of this.jobs.values()) {
      if (job.status !== "queued") continue;
      job.status = "cancelled";
      job.finishedAt = new Date().toISOString();
      this.persist(job);
    }
  }

  private async work(): Promise<void> {
    if (this.working) return;
    this.working = true;
    try {
      for (;;) {
        const job = this.list().find((j) => j.status === "queued");
        if (!job) return;
        if (this.lastFinished || job.retryAfterAt) {
          const pause = this.lastFinished ? PAUSE_MIN_MS + Math.random() * (PAUSE_MAX_MS - PAUSE_MIN_MS) : 0;
          const retryAt = job.retryAfterAt ? Date.parse(job.retryAfterAt) : 0;
          const remaining = Math.max(this.lastFinished + pause, Number.isFinite(retryAt) ? retryAt : 0) - Date.now();
          if (remaining > 0) {
            this.pausedReason = retryAt > Date.now()
              ? `Flow ${job.errorCategory ?? "transient"}; retrying in ${Math.ceil(remaining / 1000)}s`
              : `pacing: next generation in ${Math.ceil(remaining / 1000)}s`;
            await new Promise((r) => setTimeout(r, remaining));
            this.pausedReason = null;
          }
        }
        if (job.status !== "queued") continue;
        job.retryAfterAt = undefined;
        job.status = "running";
        job.operationDiagnostics = undefined;
        job.attempts++;
        this.persist(job);
        try {
          job.files = await this.runner(job);
          job.status = job.params.submit_only && job.requestDispatched ? "submitted" : "done";
          job.error = undefined;
          job.errorCategory = undefined;
          job.retryAfterAt = undefined;
          job.outcomeUnknown = false;
        } catch (err) {
          job.error = err instanceof Error ? err.message : String(err);
          const policy = classifyFlowFailure(err);
          // Once the correlated submit receipt says the request was dispatched,
          // any later failure must remain ineligible for automatic replay.
          job.outcomeUnknown = policy.outcomeUnknown || job.requestDispatched === true;
          job.requestDiagnostics = job.outcomeUnknown
            ? sanitizeUnknownSubmitDiagnostics((err as { diagnostics?: unknown } | null)?.diagnostics)
            : undefined;
          job.operationDiagnostics = !job.outcomeUnknown && job.requestDispatched !== true
            ? sanitizeFlowOperationDiagnostics((err as { diagnostics?: unknown } | null)?.diagnostics)
            : undefined;
          job.errorCategory = policy.category;
          const canAutoRetry = policy.autoRetry && policy.retryable && !job.outcomeUnknown && job.attempts <= (job.params.retries ?? 1);
          if (canAutoRetry && policy.cooldownMs > 0) job.retryAfterAt = new Date(Date.now() + policy.cooldownMs).toISOString();
          job.status = canAutoRetry ? "queued" : "failed";
          if (canAutoRetry) job.finishedAt = undefined;
        }
        if (job.status === "queued") job.finishedAt = undefined;
        else job.finishedAt = new Date().toISOString();
        this.persist(job);
        this.lastFinished = Date.now();
      }
    } finally {
      this.working = false;
    }
  }
}
