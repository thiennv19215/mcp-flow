const STORAGE_KEY = "flowMcpJobQueueV1";

const clone = value => structuredClone(value);
const asError = value => value instanceof Error ? value : new Error(String(value));
const mayHaveDispatched = value => value?.outcomeUnknown === true ||
  value?.requestDispatched === true || value?.possiblyDispatched === true ||
  value?.mayHaveSubmitted === true;

/**
 * A persistent, sequential queue for Flow work in the MV3 service worker.
 * add() only stages work. The extension UI must call start() or resume().
 */
export class FlowJobQueue {
  constructor(runner, { storageKey = STORAGE_KEY, storage = globalThis.chrome?.storage?.local, minDelayMs = 5_000, maxDelayMs = 10_000 } = {}) {
    if (typeof runner !== "function") throw new TypeError("FlowJobQueue requires a runner(job, hooks).");
    if (!storage?.get || !storage?.set) throw new TypeError("FlowJobQueue requires chrome.storage.local or a compatible storage adapter.");
    this.runner = runner;
    this.storage = storage;
    this.storageKey = storageKey;
    this.minDelayMs = Math.max(0, Number(minDelayMs) || 0);
    this.maxDelayMs = Math.max(this.minDelayMs, Number(maxDelayMs) || this.minDelayMs);
    this.jobs = [];
    this.paused = false;
    this.running = false;
    this.stopped = true;
    this.currentJobId = null;
    this.controller = null;
    this.stopRequested = false;
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
    for (const job of interrupted) {
      job.status = "failed";
      job.outcomeUnknown = true;
      job.retrySafe = false;
      job.error = "The extension worker restarted while this operation was running. Check Flow before retrying.";
      job.errorCode = "FLOW_QUEUE_INTERRUPTED_UNKNOWN";
      job.finishedAt = Date.now();
    }
    // A worker restart is a pause boundary. Never resume queued operations in the
    // background; require an explicit user action after recovering the active item.
    this.paused = state.paused === true || state.running === true || interrupted.length > 0;
    this.running = false;
    this.stopped = state.stopRequested === true || (state.stopped === true && interrupted.length === 0);
    this.currentJobId = null;
    if (interrupted.length > 0) await this.#persist();
    return this.#snapshot();
  }

  #snapshot() {
    const jobs = this.jobs.map(job => clone(job));
    return {
      jobs,
      total: jobs.length,
      pending: jobs.filter(job => job.status === "pending").length,
      completed: jobs.filter(job => job.status === "completed").length,
      failed: jobs.filter(job => job.status === "failed").length,
      cancelled: jobs.filter(job => job.status === "cancelled").length,
      isRunning: this.running,
      isPaused: this.paused,
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
      running: this.running,
      stopped: this.stopped,
      stopRequested: this.stopRequested,
      currentJobId: this.currentJobId,
      updatedAt: Date.now(),
    };
    this.writeChain = this.writeChain.then(() => this.storage.set({ [this.storageKey]: value }));
    await this.writeChain;
  }

  subscribe(listener) {
    if (typeof listener !== "function") throw new TypeError("Queue listener must be a function.");
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async add(input) {
    await this.ready;
    const operation = String(input?.operation || input?.data?.operation || "flow.generation.submit");
    const payload = clone(input?.payload ?? input?.data?.payload ?? {});
    const metadata = input?.metadata ?? input?.data?.metadata;
    const label = String(input?.label || input?.name || payload?.prompt || input?.data?.prompt || "Flow job").slice(0, 160);
    const job = {
      id: input?.id || crypto.randomUUID(),
      type: "flow",
      operation,
      payload,
      label,
      name: label,
      data: { operation, payload },
      ...(metadata === undefined ? {} : { metadata: clone(metadata) }),
      status: "pending",
      outcomeUnknown: false,
      addedAt: Date.now(),
      attempts: 0,
    };
    if (this.jobs.some(existing => existing.id === job.id)) throw new Error(`Flow job already exists: ${job.id}`);
    this.jobs.push(job);
    await this.#persist();
    this.#emit("added");
    return clone(job);
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
    if (this.running) return this.#snapshot();
    this.paused = false;
    this.stopped = false;
    this.stopRequested = false;
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
    if (!this.paused && this.running) return this.#snapshot();
    return this.start();
  }

  async stop() {
    await this.ready;
    this.stopRequested = true;
    this.paused = false;
    this.stopped = true;
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
    await this.#persist();
    this.#emit("retried");
    return clone(job);
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

  async remove(id) {
    await this.ready;
    const index = this.jobs.findIndex(job => job.id === id);
    if (index < 0 || this.jobs[index].status === "running") return false;
    if (this.jobs.some(job => job.metadata?.dependsOnId === id && ["pending", "running"].includes(job.status))) return false;
    this.jobs.splice(index, 1);
    await this.#persist();
    this.#emit("removed");
    return true;
  }

  async clear() {
    await this.ready;
    if (this.running || this.controller) throw new Error("Stop the active Flow operation before clearing the queue.");
    this.jobs = [];
    this.paused = false;
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
    try {
      while (this.running && !this.paused && !this.stopRequested) {
        const job = this.jobs.find(item => item.status === "pending");
        if (!job) break;
        if (completedOne && this.maxDelayMs > 0) {
          const delay = this.minDelayMs + Math.random() * (this.maxDelayMs - this.minDelayMs);
          await new Promise(resolve => setTimeout(resolve, delay));
          if (!this.running || this.paused || this.stopRequested) break;
        }
        this.currentJobId = job.id;
        this.controller = new AbortController();
        job.status = "running";
        job.attempts = (job.attempts || 0) + 1;
        job.startedAt = Date.now();
        await this.#persist();
        this.#emit("job-started");
        const hooks = {
          signal: this.controller.signal,
          progress: async progress => {
            job.progress = clone(progress);
            await this.#persist();
            this.#emit("job-progress");
          },
        };
        try {
          const result = await this.runner(clone(job), hooks);
          if (mayHaveDispatched(result) && result?.completed !== true) {
            job.status = "failed";
            job.outcomeUnknown = true;
            job.error = String(result?.error || "Flow may have accepted this operation; inspect the project before retrying.");
            job.errorCode = result?.errorCode || "FLOW_SUBMIT_OUTCOME_UNKNOWN";
          } else {
            job.status = "completed";
            job.result = clone(result);
            job.outcomeUnknown = false;
          }
        } catch (thrown) {
          const error = asError(thrown);
          const explicitlySafe = error?.outcomeUnknown === false || error?.outcome_unknown === false;
          const unknown = mayHaveDispatched(error) || (!explicitlySafe && this.stopRequested && this.controller?.signal.aborted);
          job.status = "failed";
          job.outcomeUnknown = unknown;
          job.retrySafe = !unknown;
          if (error?.requestDispatched === true || error?.request_dispatched === true) job.requestDispatched = true;
          if (error?.serverAcceptanceObserved === true) job.serverAcceptanceObserved = true;
          if (typeof error?.credits === "number") job.credits = error.credits;
          if (typeof error?.creditQuoteVerified === "boolean") job.creditQuoteVerified = error.creditQuoteVerified;
          job.error = error.message.slice(0, 2000);
          job.errorCode = error.code || (unknown ? "FLOW_SUBMIT_OUTCOME_UNKNOWN" : "FLOW_JOB_FAILED");
        }
        job.finishedAt = Date.now();
        this.controller = null;
        this.currentJobId = null;
        await this.#persist();
        this.#emit("job-finished");
        completedOne = true;
      }
    } finally {
      this.controller = null;
      this.currentJobId = null;
      this.running = false;
      this.stopRequested = false;
      this.stopped = !this.paused;
      await this.#persist();
      this.#emit(this.paused ? "paused" : "drained");
    }
  }
}
