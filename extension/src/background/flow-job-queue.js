import { validateFlowJobPayloads, preflightError } from "./flow-queue-preflight.js";

const STORAGE_KEY = "flowMcpJobQueueV1";
const AUTO_RETRY_MAX = 2;
const PAGE_BLOCKER_ERROR_CODES = new Set([
  "FLOW_UNKNOWN_OVERLAY_BLOCKING",
  "FLOW_DIALOG_DISMISS_UNCONFIRMED",
  "FLOW_BLOCKING_OVERLAY_UNRESOLVED",
  "FLOW_OPERATION_PREFLIGHT_FAILED",
  "FLOW_OPERATION_PREFLIGHT_UNAVAILABLE",
  "FLOW_AGENT_PREFLIGHT_UNAVAILABLE",
  "FLOW_SCREEN_PREFLIGHT_UNAVAILABLE",
  "FLOW_SESSION_REQUIRED",
  "FLOW_PROJECT_NAVIGATING",
  "FLOW_PROJECT_LOAD_FAILED",
  "FLOW_PROJECT_REQUIRED",
  "FLOW_EXECUTION_TARGET_CHANGED",
  "FLOW_MEDIA_VIEWER_OPEN",
  "FLOW_SCREEN_NOT_READY",
  "FLOW_NOT_READY",
  "FLOW_AGENT_PANEL_AMBIGUOUS",
  "FLOW_AGENT_PANEL_CLOSE_AMBIGUOUS",
  "FLOW_AGENT_PANEL_CLOSE_UNAVAILABLE",
  "FLOW_AGENT_SESSION_CLOSE_UNAVAILABLE",
  "FLOW_AGENT_SESSION_CLOSE_UNCONFIRMED",
  "FLOW_AGENT_INSTRUCTION_AMBIGUOUS",
  "FLOW_AGENT_INSTRUCTION_DISMISS_UNAVAILABLE",
  "FLOW_AGENT_INSTRUCTION_DISMISS_UNCONFIRMED",
  "FLOW_AGENT_MODE_AMBIGUOUS",
  "FLOW_AGENT_PREFLIGHT_UNCONFIRMED",
  "FLOW_AGENT_CONFIRMATION_UNVERIFIED",
  "FLOW_TRASH_CONFIRM_UNVERIFIED",
  "FLOW_TRASH_CONFIRM_AMBIGUOUS",
]);
const PAGE_BLOCKER_NO_AUTO_RETRY_ERROR_CODES = new Set([
  // A user may resolve these prompts directly in Flow while the queue is
  // paused. Keep the job retryable by explicit choice, but never submit or
  // confirm the destructive action a second time automatically on Resume.
  "FLOW_AGENT_CONFIRMATION_UNVERIFIED",
  "FLOW_TRASH_CONFIRM_UNVERIFIED",
  "FLOW_TRASH_CONFIRM_AMBIGUOUS",
]);

const clone = value => structuredClone(value);
const asError = value => {
  if (value instanceof Error) return value;
  const error = new Error(String(value?.message || value || "Flow queue operation failed."));
  if (value && typeof value === "object") {
    for (const key of ["name", "code", "retryable", "outcomeUnknown", "outcome_unknown", "requestDispatched", "request_dispatched", "possiblyDispatched", "possibly_dispatched", "mayHaveSubmitted", "noRetry", "noReplay", "downloadError", "diagnostics"]) {
      if (value[key] !== undefined) error[key] = value[key];
    }
  }
  return error;
};
const mayHaveDispatched = value => value?.outcomeUnknown === true || value?.outcome_unknown === true ||
  value?.requestDispatched === true || value?.request_dispatched === true ||
  value?.possiblyDispatched === true || value?.possibly_dispatched === true ||
  value?.mayHaveSubmitted === true;

/**
 * A persistent, sequential queue for Flow work in the MV3 service worker.
 * add() only stages work. The extension UI bridge starts the queue after a
 * normal add; callers that intentionally pause the queue can resume it later.
 */
export class FlowJobQueue {
  constructor(runner, { storageKey = STORAGE_KEY, storage = globalThis.chrome?.storage?.local, minDelayMs = 5_000, maxDelayMs = 10_000, loadCapabilityRegistry = null } = {}) {
    if (typeof runner !== "function") throw new TypeError("FlowJobQueue requires a runner(job, hooks).");
    if (!storage?.get || !storage?.set) throw new TypeError("FlowJobQueue requires chrome.storage.local or a compatible storage adapter.");
    this.runner = runner;
    this.loadCapabilityRegistry = typeof loadCapabilityRegistry === "function" ? loadCapabilityRegistry : null;
    this.capabilityRegistryPromise = null;
    this.storage = storage;
    this.storageKey = storageKey;
    this.minDelayMs = Math.max(0, Number(minDelayMs) || 0);
    this.maxDelayMs = Math.max(this.minDelayMs, Number(maxDelayMs) || this.minDelayMs);
    this.jobs = [];
    this.paused = false;
    this.attention = null;
    this.running = false;
    this.stopped = true;
    this.currentJobId = null;
    this.controller = null;
    this.stopRequested = false;
    this.restartRequested = false;
    this.recoveryResumeRequested = false;
    this.listeners = new Set();
    this.writeChain = Promise.resolve();
    this.ready = this.#restore();
  }

  async #restore() {
    const stored = await this.storage.get(this.storageKey);
    const state = stored?.[this.storageKey];
    if (!state || state.version !== 1 || !Array.isArray(state.jobs)) return this.#snapshot();
    this.jobs = state.jobs.filter(job => job && typeof job.id === "string" && typeof job.status === "string").map(job => clone(job));
    const interrupted = this.jobs.filter(job => job.status === "running");
    const unresolved = [];
    let recovered = false;
    for (const job of interrupted) {
      const generationCheckpoint = job.metadata?.generationResultCheckpoint;
      const observationCheckpoint = job.metadata?.generationObservation;
      if (Array.isArray(generationCheckpoint?.media) && generationCheckpoint.media.length > 0) {
        job.status = "pending";
        job.outcomeUnknown = false;
        job.retrySafe = false;
        job.error = undefined;
        job.errorCode = undefined;
        job.finishedAt = undefined;
        job.progress = {
          ...(job.progress && typeof job.progress === "object" ? job.progress : {}),
          phase: "recovering_generation_result",
          message: "Flow already confirmed the generated result. Resuming the remaining queue steps…",
          generation: { state: "completed", count: generationCheckpoint.media.length, media: clone(generationCheckpoint.media) },
        };
        recovered = true;
      } else if (observationCheckpoint?.correlationAttemptId && !observationCheckpoint.submitOnly) {
        job.status = "pending";
        job.outcomeUnknown = false;
        job.retrySafe = false;
        job.error = undefined;
        job.errorCode = undefined;
        job.finishedAt = undefined;
        job.progress = {
          ...(job.progress && typeof job.progress === "object" ? job.progress : {}),
          phase: "recovering_generation_observation",
          message: "Resuming the Flow result check without submitting the prompt again…",
        };
        recovered = true;
      } else if (observationCheckpoint?.submitOnly && job.operation === "flow.generation.submit") {
        job.status = "completed";
        job.outcomeUnknown = false;
        job.retrySafe = false;
        job.result = { completed: true, requestDispatched: true, result: { submitted: true, recoveredAfterWorkerRestart: true } };
        job.progress = { phase: "submitted", message: "Flow accepted the request before the worker restarted.", percent: 100 };
        job.finishedAt = Date.now();
        recovered = true;
      } else {
        job.status = "failed";
        job.outcomeUnknown = true;
        job.retrySafe = false;
        job.error = "The extension worker restarted before Flow confirmed this operation. Check Flow before retrying.";
        job.errorCode = "FLOW_QUEUE_INTERRUPTED_UNKNOWN";
        job.finishedAt = Date.now();
        unresolved.push(job);
      }
    }
    // Resume a queue after restart only when its active task has a durable Flow
    // receipt. Ambiguous submissions still stop the queue for user inspection.
    this.paused = state.paused === true || unresolved.length > 0;
    this.attention = state.attention && typeof state.attention === "object" ? clone(state.attention) : null;
    if (unresolved.length > 0) {
      const job = unresolved[0];
      this.attention = {
        type: "flow-outcome-unknown",
        jobId: job.id,
        code: job.errorCode,
        message: job.error,
        occurredAt: Date.now(),
        retryOnResume: false,
      };
    } else if (recovered) {
      this.attention = null;
    }
    this.running = false;
    this.stopRequested = state.stopRequested === true;
    this.stopped = this.stopRequested || (state.stopped === true && interrupted.length === 0);
    this.currentJobId = null;
    this.recoveryResumeRequested = state.running === true && state.paused !== true && !this.stopRequested && unresolved.length === 0;
    if (interrupted.length > 0) await this.#persist();
    return this.#snapshot();
  }

  async resumeRecovered() {
    await this.ready;
    if (!this.recoveryResumeRequested || this.paused || this.stopRequested || this.running) return this.#snapshot();
    this.recoveryResumeRequested = false;
    return this.start();
  }

  #snapshot() {
    const jobs = this.jobs.map(job => clone(job));
    return {
      jobs,
      total: jobs.length,
      pending: jobs.filter(job => job.status === "pending").length,
      waitingForUser: jobs.filter(job => job.status === "waiting_for_user").length,
      completed: jobs.filter(job => job.status === "completed").length,
      failed: jobs.filter(job => job.status === "failed").length,
      cancelled: jobs.filter(job => job.status === "cancelled").length,
      isRunning: this.running,
      isPaused: this.paused,
      attention: this.attention ? clone(this.attention) : null,
      isStopped: this.stopped,
      currentJobId: this.currentJobId,
    };
  }

  #emit(reason) {
    const snapshot = this.#snapshot();
    for (const listener of this.listeners) {
      try { listener(snapshot, reason); } catch (error) { console.error("[FlowJobQueue] change listener failed", error); }
    }
  }

  async #persist() {
    const value = {
      version: 1,
      jobs: this.jobs.map(job => clone(job)),
      paused: this.paused,
      attention: this.attention ? clone(this.attention) : null,
      running: this.running,
      stopped: this.stopped,
      stopRequested: this.stopRequested,
      currentJobId: this.currentJobId,
      updatedAt: Date.now(),
    };
    this.writeChain = this.writeChain.catch(() => {}).then(() => this.storage.set({ [this.storageKey]: value }));
    await this.writeChain;
  }

  subscribe(listener) {
    if (typeof listener !== "function") throw new TypeError("Queue listener must be a function.");
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // Admission preflight: validate every generation job against the local
  // model capability registry before any of them enters the queue, so an
  // impossible job fails the whole submission up front instead of failing
  // at run time after earlier jobs already spent credits. Skipped when no
  // registry loader is configured or the registry cannot be read; the
  // content-side capability check at run time remains the backstop.
  async #preflight(jobs) {
    if (!this.loadCapabilityRegistry) return;
    if (!this.capabilityRegistryPromise) {
      this.capabilityRegistryPromise = Promise.resolve()
        .then(() => this.loadCapabilityRegistry())
        .catch(() => null);
    }
    const registry = await this.capabilityRegistryPromise;
    if (!registry) return;
    const problems = validateFlowJobPayloads(jobs, registry);
    if (problems.length > 0) throw preflightError(problems);
  }

  async add(input) {
    await this.ready;
    const job = this.#makeJob(input);
    if (this.jobs.some(existing => existing.id === job.id)) throw new Error(`Flow job already exists: ${job.id}`);
    await this.#preflight([job]);
    this.jobs.push(job);
    await this.#persist();
    this.#emit("added");
    return clone(job);
  }

  async addBatch(inputs, { batchId = crypto.randomUUID(), batchLabel = "Flow batch" } = {}) {
    await this.ready;
    if (!Array.isArray(inputs) || inputs.length < 2 || inputs.length > 100) {
      throw Object.assign(new Error("A Flow batch must contain between 2 and 100 jobs."), { code: "FLOW_QUEUE_BATCH_SIZE_INVALID" });
    }
    const id = String(batchId || "").trim();
    if (!id || id.length > 120) throw Object.assign(new Error("The Flow batch id is invalid."), { code: "FLOW_QUEUE_BATCH_ID_INVALID" });
    if (this.jobs.some(job => job.batch?.batchId === id)) throw Object.assign(new Error(`Flow batch already exists: ${id}`), { code: "FLOW_QUEUE_BATCH_EXISTS" });
    const label = String(batchLabel || "Flow batch").trim().slice(0, 160) || "Flow batch";
    const addedAt = Date.now();
    const jobs = inputs.map((input, index) => this.#makeJob(input, {
      batchId: id,
      batchLabel: label,
      batchIndex: index,
      batchCount: inputs.length,
    }, addedAt));
    const ids = new Set(this.jobs.map(job => job.id));
    for (const job of jobs) {
      if (ids.has(job.id)) throw new Error(`Flow job already exists: ${job.id}`);
      ids.add(job.id);
    }
    await this.#preflight(jobs);
    this.jobs.push(...jobs);
    try {
      await this.#persist();
    } catch (error) {
      this.jobs.splice(this.jobs.length - jobs.length, jobs.length);
      throw error;
    }
    this.#emit("batch-added");
    return jobs.map(job => clone(job));
  }

  #makeJob(input, batch = null, addedAt = Date.now()) {
    const operation = String(input?.operation || input?.data?.operation || "flow.generation.submit");
    const payload = clone(input?.payload ?? input?.data?.payload ?? {});
    const metadata = input?.metadata ?? input?.data?.metadata;
    const label = String(input?.label || input?.name || payload?.prompt || input?.data?.prompt || "Flow job").slice(0, 160);
    return {
      id: input?.id || crypto.randomUUID(),
      type: "flow",
      operation,
      payload,
      label,
      name: label,
      data: { operation, payload },
      ...(metadata === undefined ? {} : { metadata: clone(metadata) }),
      ...(batch ? { batch: clone(batch) } : {}),
      status: "pending",
      outcomeUnknown: false,
      addedAt,
      attempts: 0,
      autoRetryCount: 0,
    };
  }

  #restoreDependencyDescendants(parentIds) {
    const readyParents = new Set(parentIds);
    let restored = true;
    while (restored) {
      restored = false;
      for (const job of this.jobs) {
        if (job.status !== "cancelled" || job.errorCode !== "FLOW_SCENE_DEPENDENCY_SKIPPED" ||
            !readyParents.has(job.metadata?.dependsOnId)) continue;
        job.status = "pending";
        job.error = undefined;
        job.errorCode = undefined;
        job.finishedAt = undefined;
        job.retrySafe = false;
        job.progress = undefined;
        job.result = undefined;
        readyParents.add(job.id);
        restored = true;
      }
    }
  }

  async list() {
    await this.ready;
    return this.jobs.map(job => clone(job));
  }

  async get(id) {
    await this.ready;
    const job = this.jobs.find(item => item.id === String(id));
    return job ? clone(job) : null;
  }

  async snapshot() {
    await this.ready;
    return this.#snapshot();
  }

  async snapshotById(id) {
    await this.ready;
    const job = this.jobs.find(item => item.id === String(id));
    return { job: job ? clone(job) : null, queue: this.#snapshot() };
  }

  async updateMetadata(id, patch) {
    await this.ready;
    const job = this.jobs.find(item => item.id === String(id));
    if (!job) return null;
    job.metadata = { ...(job.metadata || {}), ...(patch && typeof patch === "object" ? clone(patch) : {}) };
    await this.#persist();
    this.#emit("metadata-updated");
    return clone(job);
  }

  async checkpointGenerationObservation(id, checkpoint) {
    await this.ready;
    const job = this.jobs.find(item => item.id === String(id));
    if (!job || job.status !== "running") return null;
    const correlationAttemptId = String(checkpoint?.correlationAttemptId || "").trim();
    if (!correlationAttemptId || correlationAttemptId.length > 160) {
      throw Object.assign(new Error("Flow did not provide a valid generation correlation receipt."), { code: "FLOW_GENERATION_CORRELATION_UNAVAILABLE" });
    }
    const before = Array.isArray(checkpoint?.before)
      ? checkpoint.before.filter(value => typeof value === "string").slice(-2000)
      : [];
    job.metadata = {
      ...(job.metadata || {}),
      generationObservation: {
        correlationAttemptId,
        before,
        kind: checkpoint?.kind === "video" ? "video" : "image",
        expectedCount: Math.max(1, Math.min(20, Number(checkpoint?.expectedCount) || 1)),
        timeoutMs: Math.max(1000, Math.min(15 * 60_000, Number(checkpoint?.timeoutMs) || 5 * 60_000)),
        ...(typeof checkpoint?.credits === "number" && Number.isFinite(checkpoint.credits) ? { credits: checkpoint.credits } : {}),
        submitOnly: checkpoint?.submitOnly === true,
        recordedAt: Date.now(),
      },
    };
    await this.#persist();
    this.#emit("generation-observation-checkpoint");
    return clone(job);
  }

  async checkpointGenerationResult(id, media) {
    await this.ready;
    const job = this.jobs.find(item => item.id === String(id));
    if (!job || job.status !== "running") return null;
    if (!Array.isArray(media) || media.length < 1 || media.length > 20) {
      throw Object.assign(new Error("Flow returned an invalid generated-media result checkpoint."), { code: "FLOW_GENERATION_RESULT_INVALID" });
    }
    const normalizedMedia = media.map(item => ({
      id: String(item?.id || "").trim(),
      title: String(item?.title || item?.name || "").trim(),
      kind: String(item?.kind || item?.type || "").toLowerCase(),
    }));
    if (normalizedMedia.some(item => !item.id || !item.title || !["image", "video"].includes(item.kind))) {
      throw Object.assign(new Error("Flow returned generated media without a verified ID, title, and type."), { code: "FLOW_GENERATION_RESULT_INVALID" });
    }
    const quoteFields = job.metadata?.generationQuoteFields && typeof job.metadata.generationQuoteFields === "object"
      ? clone(job.metadata.generationQuoteFields)
      : {};
    job.metadata = {
      ...(job.metadata || {}),
      generationResultCheckpoint: { media: normalizedMedia, quoteFields, recordedAt: Date.now() },
    };
    delete job.metadata.generationObservation;
    const previousProgress = job.progress && typeof job.progress === "object" ? job.progress : {};
    const downloadEnabled = job.payload?.autoDownload !== false && job.payload?.auto_download !== false &&
      job.payload?.params?.autoDownload !== false && job.payload?.params?.auto_download !== false;
    job.progress = {
      ...previousProgress,
      phase: "generation_complete",
      message: `Flow confirmed ${normalizedMedia.length} generated result${normalizedMedia.length === 1 ? "" : "s"}.`,
      percent: 89,
      generation: { state: "completed", count: normalizedMedia.length, media: normalizedMedia },
      download: downloadEnabled
        ? (previousProgress.download || { state: "queued", completed: 0, total: normalizedMedia.length })
        : { state: "skipped", completed: 0, total: normalizedMedia.length },
    };
    await this.#persist();
    this.#emit("generation-result-checkpoint");
    return clone(job);
  }

  async updateProgress(id, progress) {
    await this.ready;
    const job = this.jobs.find(item => item.id === String(id));
    if (!job || job.status !== "running") return null;
    const requested = progress && typeof progress === "object"
      ? clone(progress)
      : { phase: "render", message: String(progress || "") };
    const previous = job.progress && typeof job.progress === "object" ? job.progress : {};
    const next = { ...previous, ...requested };
    if (JSON.stringify(previous) === JSON.stringify(next)) return clone(job);
    job.progress = next;
    await this.#persist();
    this.#emit("job-progress");
    return clone(job);
  }

  async updateGeneratedMediaDownload(id, download, message = "") {
    await this.ready;
    const job = this.jobs.find(item => item.id === String(id));
    if (!job || !["completed", "failed"].includes(job.status)) return null;
    const state = String(download?.state || "");
    if (!["queued", "downloading", "completed", "failed", "skipped"].includes(state)) {
      throw Object.assign(new Error("Invalid generated-media download state."), { code: "FLOW_QUEUE_DOWNLOAD_STATE_INVALID" });
    }
    const previous = job.progress && typeof job.progress === "object" ? job.progress : {};
    const nextDownload = {
      state,
      completed: Math.max(0, Number(download?.completed) || 0),
      total: Math.max(1, Number(download?.total) || Number(previous.generation?.count) || 1),
      ...(download?.current && typeof download.current === "object" ? { current: clone(download.current) } : {}),
    };
    job.progress = {
      ...previous,
      phase: `download_${state}`,
      ...(message ? { message: String(message).slice(0, 1000) } : {}),
      download: nextDownload,
    };
    await this.#persist();
    this.#emit("generated-media-download-progress");
    return clone(job);
  }

  async wait(id, timeoutMs = 30_000) {
    await this.ready;
    const jobId = String(id);
    const isTerminal = job => job && ["completed", "failed", "cancelled"].includes(job.status);
    const initial = this.jobs.find(item => item.id === jobId);
    if (!initial) throw Object.assign(new Error(`No Flow queue job with id ${jobId}.`), { code: "FLOW_QUEUE_JOB_NOT_FOUND" });
    if (isTerminal(initial)) return { finished: true, job: clone(initial), snapshot: this.#snapshot() };

    const boundedTimeout = Math.min(600_000, Math.max(0, Number(timeoutMs) || 0));
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      const cleanup = () => {
        unsubscribe();
        if (timer !== undefined) clearTimeout(timer);
      };
      const finish = result => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };
      const unsubscribe = this.subscribe(snapshot => {
        const current = snapshot.jobs.find(item => item.id === jobId);
        if (!current) {
          settled = true;
          cleanup();
          reject(Object.assign(new Error(`Flow queue job ${jobId} was removed while waiting.`), { code: "FLOW_QUEUE_JOB_REMOVED" }));
          return;
        }
        if (isTerminal(current)) finish({ finished: true, job: current, snapshot });
      });
      if (boundedTimeout === 0) {
        const current = this.jobs.find(item => item.id === jobId);
        finish({ finished: isTerminal(current), job: current ? clone(current) : null, snapshot: this.#snapshot() });
        return;
      }
      timer = setTimeout(() => {
        const current = this.jobs.find(item => item.id === jobId);
        finish({ finished: isTerminal(current), job: current ? clone(current) : null, snapshot: this.#snapshot() });
      }, boundedTimeout);
      const current = this.jobs.find(item => item.id === jobId);
      if (isTerminal(current)) finish({ finished: true, job: clone(current), snapshot: this.#snapshot() });
    });
  }

  async start() {
    await this.ready;
    this.recoveryResumeRequested = false;
    if (this.running) {
      // A new item may arrive after #drain has checked for pending work but
      // before its finally block marks the queue idle. Remember that start
      // request so the finalizer can launch another drain instead of stranding it.
      if (!this.stopRequested) {
        if (this.paused) {
          this.paused = false;
          this.stopped = false;
          this.attention = null;
          this.restartRequested = true;
          await this.#persist();
          this.#emit("resumed");
        } else {
          this.restartRequested = true;
        }
      }
      return this.#snapshot();
    }
    this.paused = false;
    this.stopped = false;
    this.stopRequested = false;
    this.restartRequested = false;
    this.attention = null;
    this.running = true;
    await this.#persist();
    this.#emit("started");
    this.drainPromise = this.#drain();
    return this.#snapshot();
  }

  async pause() {
    await this.ready;
    if (!this.running || this.paused) return false;
    this.paused = true;
    await this.#persist();
    this.#emit("paused");
    return true;
  }

  async resume() {
    await this.ready;
    if (this.paused && this.attention?.type === "flow-page-blocked") {
      const blockedJob = this.jobs.find(job => job.id === this.attention.jobId);
      if (blockedJob?.status === "failed" && this.attention.retryOnResume !== false && blockedJob.retrySafe === true && blockedJob.outcomeUnknown !== true) {
        blockedJob.status = "pending";
        blockedJob.error = undefined;
        blockedJob.errorCode = undefined;
        blockedJob.finishedAt = undefined;
        blockedJob.retrySafe = false;
        blockedJob.autoRetryCount = 0;
        blockedJob.overlayRecheckCount = 0;
        blockedJob.progress = undefined;
        blockedJob.result = undefined;
      }
      if (blockedJob?.status === "pending") {
        const currentIndex = this.jobs.indexOf(blockedJob);
        const firstPendingIndex = this.jobs.findIndex(job => job.status === "pending");
        if (currentIndex >= 0 && firstPendingIndex >= 0 && currentIndex !== firstPendingIndex) {
          this.jobs.splice(currentIndex, 1);
          const nextPendingIndex = this.jobs.findIndex(job => job.status === "pending");
          this.jobs.splice(nextPendingIndex < 0 ? this.jobs.length : nextPendingIndex, 0, blockedJob);
        }
      }
      // Resume is the user's confirmation that the shared Flow page has been
      // repaired. Retry this known pre-submit failure before later jobs.
      this.attention = null;
    } else if (this.paused && this.attention?.type === "flow-outcome-unknown") {
      // Resume acknowledges that the user inspected Flow. Keep the uncertain
      // job failed and continue only with later independent pending jobs.
      this.attention = null;
    }
    if (!this.paused && this.running) {
      if (!this.stopRequested) this.restartRequested = true;
      return this.#snapshot();
    }
    return this.start();
  }

  async stop() {
    await this.ready;
    this.stopRequested = true;
    this.restartRequested = false;
    this.paused = false;
    this.stopped = true;
    this.attention = null;
    if (this.controller) this.controller.abort(new Error("Queue stopped by user."));
    if (!this.controller) this.running = false;
    await this.#persist();
    this.#emit("stopped");
    return this.#snapshot();
  }

  async retry(id) {
    await this.ready;
    const job = this.jobs.find(item => item.id === id);
    if (!job || job.status !== "failed") return false;
    if (job.outcomeUnknown === true) throw new Error("This Flow job may already have been submitted. Inspect Flow; it cannot be retried from the queue.");
    if (job.retrySafe !== true) throw Object.assign(new Error("This Flow job is not marked safe to retry."), { code: "FLOW_QUEUE_RETRY_UNSAFE" });
    job.status = "pending";
    job.error = undefined;
    job.errorCode = undefined;
    job.finishedAt = undefined;
    job.retrySafe = false;
    job.autoRetryCount = 0;
    job.overlayRecheckCount = 0;
    job.progress = undefined;
    job.result = undefined;
    if (job.metadata) {
      delete job.metadata.generationObservation;
      delete job.metadata.generationResultCheckpoint;
      delete job.metadata.generationQuoteFields;
    }
    this.#restoreDependencyDescendants([job.id]);
    await this.#persist();
    this.#emit("retried");
    return clone(job);
  }

  async retryBatch(batchId) {
    await this.ready;
    const id = String(batchId || "");
    const jobs = this.jobs.filter(item => item.batch?.batchId === id);
    if (!jobs.length) return { retried: [], skipped: 0 };
    const retryable = jobs.filter(job => job.status === "failed" && job.retrySafe === true && job.outcomeUnknown !== true);
    for (const job of retryable) {
      job.status = "pending";
      job.error = undefined;
      job.errorCode = undefined;
      job.finishedAt = undefined;
      job.retrySafe = false;
      job.autoRetryCount = 0;
      job.overlayRecheckCount = 0;
      job.progress = undefined;
      job.result = undefined;
      if (job.metadata) {
        delete job.metadata.generationObservation;
        delete job.metadata.generationResultCheckpoint;
        delete job.metadata.generationQuoteFields;
      }
    }
    if (retryable.length) {
      this.#restoreDependencyDescendants(retryable.map(job => job.id));
      await this.#persist();
      this.#emit("batch-retried");
    }
    return { retried: retryable.map(job => clone(job)), skipped: jobs.filter(job => job.status === "failed" && !retryable.includes(job)).length };
  }

  async cancel(id) {
    await this.ready;
    const job = this.jobs.find(item => item.id === String(id));
    if (!job) return null;
    if (job.status === "pending") {
      job.status = "cancelled";
      job.outcomeUnknown = false;
      job.retrySafe = false;
      job.finishedAt = Date.now();
      await this.#persist();
      this.#emit("job-cancelled");
      return { cancelled: true, active: false, job: clone(job) };
    }
    if (job.status === "waiting_for_user") {
      job.status = "cancelled";
      job.outcomeUnknown = false;
      job.retrySafe = false;
      job.finishedAt = Date.now();
      await this.#persist();
      this.#emit("manual-job-cancelled");
      return { cancelled: true, active: false, job: clone(job) };
    }
    if (job.status === "running") {
      // Flow page actions do not support reliable cancellation after dispatch.
      // Stop later jobs, but let the active task report its actual outcome.
      this.stopRequested = true;
      this.paused = false;
      this.stopped = true;
      this.controller?.abort(new Error("Queue cancellation requested; active Flow action may continue."));
      await this.#persist();
      this.#emit("cancel-requested");
      return { cancelled: false, active: true, message: "The active Flow action may continue; remaining queued work will stop after it reports its outcome.", job: clone(job) };
    }
    return { cancelled: false, active: false, job: clone(job) };
  }

  async continueManual(id) {
    await this.ready;
    if (this.running) await this.drainPromise?.catch(() => {});
    const job = this.jobs.find(item => item.id === String(id));
    if (!job || job.status !== "waiting_for_user") return null;
    job.status = "pending";
    job.finishedAt = undefined;
    job.metadata = { ...(job.metadata || {}), manualSubmitPhase: "confirm" };
    job.progress = { phase: "checking_user_submit", message: "Checking whether Flow accepted the manual submit…" };
    await this.#persist();
    this.#emit("manual-submit-continued");
    return this.resume();
  }

  async failManual(id, error) {
    await this.ready;
    const job = this.jobs.find(item => item.id === String(id));
    if (!job || job.status !== "waiting_for_user") return null;
    job.status = "failed";
    job.outcomeUnknown = true;
    job.retrySafe = false;
    job.error = String(error?.message || error || "The manual Flow submit session was lost; inspect Flow before retrying.").slice(0, 2000);
    job.errorCode = String(error?.code || "FLOW_MANUAL_SUBMIT_OUTCOME_UNKNOWN");
    job.finishedAt = Date.now();
    this.paused = true;
    this.stopped = false;
    this.attention = {
      type: "flow-outcome-unknown",
      jobId: job.id,
      code: job.errorCode,
      message: job.error,
      occurredAt: Date.now(),
      retryOnResume: false,
    };
    await this.#persist();
    this.#emit("manual-submit-outcome-unknown");
    return this.#snapshot();
  }

  async remove(id) {
    await this.ready;
    const index = this.jobs.findIndex(job => job.id === id);
    if (index < 0) return false;
    if (this.jobs.some(job => job.metadata?.dependsOnId === id && ["pending", "running", "waiting_for_user"].includes(job.status))) return false;
    const job = this.jobs[index];
    if (job.status === "running") {
      job.metadata = { ...(job.metadata || {}), removeAfterRun: true };
      this.controller?.abort(new Error("Queue job removed by user."));
      await this.#persist();
      this.#emit("job-remove-requested");
      return true;
    }
    if (job.status === "waiting_for_user") return false;
    this.jobs.splice(index, 1);
    await this.#persist();
    this.#emit("removed");
    return true;
  }

  async clear() {
    await this.ready;
    if (this.running || this.controller || this.jobs.some(job => job.status === "waiting_for_user")) throw new Error("Cancel the active or waiting Flow operation before clearing the queue.");
    this.jobs = [];
    this.paused = false;
    this.attention = null;
    this.stopped = true;
    this.currentJobId = null;
    await this.#persist();
    this.#emit("cleared");
    return this.#snapshot();
  }

  async reorder(jobId, toIndex) {
    await this.ready;
    const fromIndex = this.jobs.findIndex(job => job.id === jobId);
    if (fromIndex < 0 || this.jobs[fromIndex].status === "running" || !Number.isInteger(toIndex) || toIndex < 0 || toIndex >= this.jobs.length) return false;
    if (this.jobs[toIndex]?.status === "running") return false;
    const [job] = this.jobs.splice(fromIndex, 1);
    this.jobs.splice(toIndex, 0, job);
    const positions = new Map(this.jobs.map((item, index) => [item.id, index]));
    const invalidDependencyOrder = this.jobs.some((item, index) => {
      const dependencyIndex = positions.get(item.metadata?.dependsOnId);
      return dependencyIndex !== undefined && dependencyIndex >= index;
    });
    if (invalidDependencyOrder) {
      this.jobs.splice(toIndex, 1);
      this.jobs.splice(fromIndex, 0, job);
      return false;
    }
    await this.#persist();
    this.#emit("reordered");
    return this.#snapshot();
  }

  async #drain() {
    let completedOne = false;
    let bypassNextInterJobDelay = false;
    try {
      while (this.running && !this.paused && !this.stopRequested) {
        const job = this.jobs.find(item => item.status === "pending");
        if (!job) break;
        if (job.metadata?.dependsOnId) {
          const dependency = this.jobs.find(item => item.id === job.metadata.dependsOnId);
          if (!dependency || ["failed", "cancelled"].includes(dependency.status)) {
            job.status = "cancelled";
            job.outcomeUnknown = false;
            job.retrySafe = false;
            job.errorCode = "FLOW_SCENE_DEPENDENCY_SKIPPED";
            job.error = `Skipped because previous task ${job.metadata.dependsOnId} did not complete.`;
            job.progress = { phase: "dependency_skipped", message: "Skipped because the required previous Flow task did not complete." };
            job.finishedAt = Date.now();
            await this.#persist();
            this.#emit("dependency-skipped");
            completedOne = true;
            continue;
          }
          if (dependency.status === "pending") {
            const dependencyIndex = this.jobs.indexOf(dependency);
            const jobIndex = this.jobs.indexOf(job);
            if (dependencyIndex > jobIndex) {
              this.jobs.splice(dependencyIndex, 1);
              this.jobs.splice(jobIndex, 0, dependency);
              continue;
            }
          } else if (dependency.status !== "completed") {
            this.paused = true;
            this.stopped = false;
            this.attention = {
              type: "flow-dependency-blocked",
              jobId: dependency.id,
              code: "FLOW_SCENE_DEPENDENCY_WAITING",
              message: "A dependent Flow task is waiting for its previous task.",
              occurredAt: Date.now(),
              retryOnResume: false,
            };
            await this.#persist();
            this.#emit("attention-required");
            break;
          }
        }
        const skipInterJobDelay = bypassNextInterJobDelay;
        bypassNextInterJobDelay = false;
        if (completedOne && this.maxDelayMs > 0 && !skipInterJobDelay) {
          const delay = this.minDelayMs + Math.random() * (this.maxDelayMs - this.minDelayMs);
          await new Promise(resolve => setTimeout(resolve, delay));
          if (!this.running || this.paused || this.stopRequested) break;
        }
        this.currentJobId = job.id;
        this.controller = new AbortController();
        job.status = "running";
        job.attempts = (job.attempts || 0) + 1;
        if (job.progress?.phase === "auto_retry") job.progress = undefined;
        job.startedAt = Date.now();
        await this.#persist();
        this.#emit("job-started");
        const hooks = {
          signal: this.controller.signal,
          progress: async progress => {
            const next = clone(progress);
            const previous = job.progress && typeof job.progress === "object" ? job.progress : {};
            for (const key of ["generation", "download"]) {
              if (next[key] === undefined && previous[key] !== undefined) next[key] = previous[key];
            }
            job.progress = next;
            await this.#persist();
            this.#emit("job-progress");
          },
        };
        let waitingForUser = false;
        let pageBlocked = false;
        let outcomeBlocked = false;
        let autoRetryQueued = false;
        try {
          const result = await this.runner(clone(job), hooks);
          if (result?.waitingForUser === true) {
            waitingForUser = true;
            job.status = "waiting_for_user";
            job.result = clone(result);
            job.outcomeUnknown = false;
            job.requestDispatched = false;
            job.progress = result.progress || { phase: "waiting_for_user", message: "Prompt is ready. Submit it in Flow, then continue this job from the extension." };
            job.metadata = { ...(job.metadata || {}), manualSubmitPhase: result.phase === "confirm" ? "confirm" : "prepared", ...(Number.isInteger(result.flowTabId) ? { flowTabId: result.flowTabId } : {}) };
            this.paused = true;
            this.stopped = false;
          } else if (mayHaveDispatched(result) && result?.completed !== true) {
            job.status = "failed";
            job.outcomeUnknown = true;
            job.retrySafe = false;
            job.error = String(result?.error || "Flow may have accepted this operation; inspect the project before retrying.");
            job.errorCode = result?.errorCode || "FLOW_SUBMIT_OUTCOME_UNKNOWN";
            this.paused = true;
            this.stopped = false;
            outcomeBlocked = true;
            this.attention = {
              type: "flow-outcome-unknown",
              jobId: job.id,
              code: job.errorCode,
              message: job.error,
              occurredAt: Date.now(),
              retryOnResume: false,
            };
          } else {
            job.status = "completed";
            job.result = clone(result);
            job.outcomeUnknown = false;
          }
        } catch (thrown) {
          const error = asError(thrown);
          const explicitlySafe = error?.outcomeUnknown === false || error?.outcome_unknown === false;
          const unknown = mayHaveDispatched(error) || (!explicitlySafe && this.stopRequested && this.controller?.signal.aborted);
          const downloadFailure = Boolean(error?.downloadError) || String(error?.code || "").toUpperCase().includes("DOWNLOAD");
          pageBlocked = !unknown && PAGE_BLOCKER_ERROR_CODES.has(String(error?.code || ""));
          job.status = "failed";
          job.outcomeUnknown = unknown;
          const explicitlyRetryable = error.retryable === true && error.noRetry !== true && error.noReplay !== true;
          job.retrySafe = pageBlocked || (!unknown && !downloadFailure && explicitlyRetryable);
          if (error?.requestDispatched === true || error?.request_dispatched === true) job.requestDispatched = true;
          if (error?.serverAcceptanceObserved === true) job.serverAcceptanceObserved = true;
          if (typeof error?.credits === "number") job.credits = error.credits;
          if (typeof error?.creditQuoteVerified === "boolean") job.creditQuoteVerified = error.creditQuoteVerified;
          job.error = String(error.message || error).slice(0, 2000);
          job.errorCode = error.code || (unknown ? "FLOW_SUBMIT_OUTCOME_UNKNOWN" : "FLOW_JOB_FAILED");
          const canAutoRetry = explicitlyRetryable &&
            !downloadFailure && !unknown && !this.stopRequested && !this.controller?.signal.aborted &&
            (job.autoRetryCount || 0) < AUTO_RETRY_MAX;
          const canRecheckUnknownOverlay = error.code === "FLOW_UNKNOWN_OVERLAY_BLOCKING" && explicitlySafe &&
            !unknown && !downloadFailure && !this.stopRequested && !this.controller?.signal.aborted &&
            error.noRetry !== true && error.noReplay !== true && !mayHaveDispatched(job) &&
            (job.overlayRecheckCount || 0) < 1;
          if (unknown) {
            // A timed-out page action can still finish after the service worker
            // stops waiting. Do not let the next queued task touch Flow until
            // the user has checked whether the current request was accepted.
            this.paused = true;
            this.stopped = false;
            outcomeBlocked = true;
            this.attention = {
              type: "flow-outcome-unknown",
              jobId: job.id,
              code: job.errorCode,
              message: job.error,
              occurredAt: Date.now(),
              retryOnResume: false,
            };
          } else if (canRecheckUnknownOverlay) {
            // The unknown overlay is a confirmed pre-submit blocker. Recheck
            // this same job once immediately so a closing Flow dialog can
            // settle, but never let later jobs enter the shared page if it
            // remains blocked.
            job.overlayRecheckCount = (job.overlayRecheckCount || 0) + 1;
            job.status = "pending";
            job.outcomeUnknown = false;
            job.retrySafe = false;
            job.error = undefined;
            job.errorCode = undefined;
            job.finishedAt = undefined;
            job.result = undefined;
            job.progress = {
              phase: "auto_retry",
              attempt: job.overlayRecheckCount,
              maxAttempts: 1,
              errorCode: error.code,
              reason: String(error.message || error).slice(0, 500),
              message: "Rechecking the Flow page once before submit.",
            };
            bypassNextInterJobDelay = true;
            autoRetryQueued = true;
          } else if (pageBlocked && !canAutoRetry) {
            // The Flow page is shared by every pending job. Stop on this
            // pre-submit blocker after bounded recovery attempts so the same
            // broken page state cannot fail the rest of the batch one item at
            // a time.
            this.paused = true;
            this.stopped = false;
            this.attention = {
              type: "flow-page-blocked",
              jobId: job.id,
              code: job.errorCode,
              message: job.error,
              occurredAt: Date.now(),
              retryOnResume: !PAGE_BLOCKER_NO_AUTO_RETRY_ERROR_CODES.has(String(job.errorCode || "")),
            };
          } else if (canAutoRetry) {
            // Retry explicitly transient, pre-submit errors within a bounded
            // budget. Never replay an ambiguous submit, a download, or a
            // deterministic failure. A shared-page blocker stays in place so
            // this task is repaired before later tasks touch the same tab.
            job.autoRetryCount = (job.autoRetryCount || 0) + 1;
            job.status = "pending";
            job.outcomeUnknown = false;
            job.retrySafe = false;
            job.error = undefined;
            job.errorCode = undefined;
            job.finishedAt = undefined;
            job.result = undefined;
            job.progress = {
              phase: "auto_retry",
              attempt: job.autoRetryCount,
              maxAttempts: AUTO_RETRY_MAX,
              errorCode: error.code || "FLOW_JOB_RETRYABLE_ERROR",
              reason: String(error.message || error).slice(0, 500),
            };
            const failedIndex = this.jobs.indexOf(job);
            if (!pageBlocked && failedIndex >= 0) {
              this.jobs.splice(failedIndex, 1);
              this.jobs.push(job);
            }
            autoRetryQueued = true;
          }
        }
        if (job.metadata?.removeAfterRun === true) {
          const removeIndex = this.jobs.indexOf(job);
          if (removeIndex >= 0) this.jobs.splice(removeIndex, 1);
        }
        if (!waitingForUser && !autoRetryQueued) job.finishedAt = Date.now();
        this.controller = null;
        this.currentJobId = null;
        await this.#persist();
        this.#emit(waitingForUser ? "waiting-for-user" : autoRetryQueued ? "auto-retry-queued" : pageBlocked || outcomeBlocked ? "attention-required" : this.paused ? "paused" : "job-finished");
        if (waitingForUser || this.paused) break;
        completedOne = !pageBlocked || autoRetryQueued;
      }
    } finally {
      const restartRequested = this.restartRequested && !this.stopRequested;
      this.restartRequested = false;
      this.controller = null;
      this.currentJobId = null;
      this.running = false;
      this.stopRequested = false;
      this.stopped = !this.paused;
      await this.#persist();
      this.#emit(this.paused ? "paused" : "drained");
      if (restartRequested && !this.paused && this.jobs.some(job => job.status === "pending")) {
        void this.start().catch(error => console.error("[FlowJobQueue] requested restart failed", error));
      }
    }
  }
}
