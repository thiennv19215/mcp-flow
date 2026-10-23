(function attachFlowQueuePanel(root) {
  "use strict";

  const MESSAGE = Object.freeze({
    get: "flow-queue:get",
    add: "flow-queue:add",
    addBatch: "flow-queue:add-batch",
    pause: "flow-queue:pause",
    resume: "flow-queue:resume",
    manualContinue: "flow-queue:manual-continue",
    cancel: "flow-queue:cancel",
    stop: "flow-queue:stop",
    clear: "flow-queue:clear",
    remove: "flow-queue:remove",
    reorder: "flow-queue:reorder",
    retry: "flow-queue:retry",
    retryBatch: "flow-queue:retry-batch",
  });

  const RETRYABLE_OPERATIONS = new Set([
    "flow.generation.submit",
    "flow.edit.run",
    "flow.continue.run",
    "flow.agent.batch",
    "flow.character.create",
    "flow.character.edit",
    "flow.asset.trash",
  ]);

  const TEXT = Object.freeze({
    vi: {
      aria: "Hàng đợi tác vụ Flow", title: "Hàng đợi Flow", loading: "Đang tải…",
      pause: "Tạm dừng", resume: "Chạy tiếp", stop: "Dừng", clear: "Xóa", refresh: "Làm mới",
      promptAria: "Prompt thêm vào hàng đợi Flow", promptPlaceholder: "Nhập prompt để thêm vào hàng đợi Flow…",
      typeAria: "Loại nội dung Flow", image: "Tạo ảnh", video: "Tạo video", edit: "Chỉnh sửa video", continue: "Nối tiếp video", agent: "Flow Agent batch",
      assetPlaceholder: "Tên video có sẵn trong project (cho edit/continue)", assetAria: "Tên video trong Flow",
      ratioAria: "Tỷ lệ khung hình", auto: "Tự động", submit: "Thêm vào hàng đợi",
      batchLabel: "Mỗi đoạn cách nhau một dòng trống là một tác vụ trong batch",
      batchName: "Batch Flow", batchItem: "Tác vụ {n}/{total}", batchLimit: "Batch tối đa 100 prompt.",
      batchComplete: "{n}/{total} hoàn tất",
      referenceNames: "Tên ảnh/video tham chiếu trong project, mỗi dòng một mục",
      referenceModeAria: "Cách gán tham chiếu cho prompt",
      referenceNone: "Không dùng tham chiếu", referenceAll: "Dùng tất cả cho mỗi prompt", referenceSequential: "Chia lần lượt theo prompt",
      referenceCountAria: "Số tham chiếu cho mỗi prompt", referenceCountLabel: "tham chiếu/prompt",
      referenceTooMany: "Flow chỉ nhận tối đa 3 tham chiếu cho mỗi prompt.", referencePoolShort: "Không đủ tham chiếu cho cách chia lần lượt đã chọn.",
      firstFrameNames: "Frame đầu video (mỗi dòng một prompt; một dòng dùng chung)", lastFrameNames: "Frame cuối video (mỗi dòng một prompt; một dòng dùng chung)",
      frameCountMismatch: "Frame cần có một mục dùng chung hoặc một mục cho mỗi prompt.", frameReferenceConflict: "Flow Frames không dùng kèm tham chiếu ingredients.",
      autoRetrying: "Tự thử lại lần {n}/{max} sau lỗi {code}: {error}",
      tasks: "tác vụ", completed: "hoàn tất", paused: "đã tạm dừng", running: "đang chạy", empty: "Hàng đợi đang trống.",
      pageBlockedAttentionRetry: "Flow đang có trạng thái cản trở thao tác. Hàng đợi đã tự tạm dừng và giữ nguyên các tác vụ sau. Khắc phục trạng thái Flow rồi bấm Chạy tiếp; tác vụ chưa gửi sẽ được thử lại trước.",
      pageBlockedAttentionContinue: "Flow vẫn có trạng thái cần xử lý. Hàng đợi đã tạm dừng và giữ nguyên các tác vụ sau. Xử lý trạng thái đó rồi bấm Chạy tiếp để chạy các tác vụ sau. Tác vụ hiện tại vẫn báo lỗi để tránh gửi hoặc xác nhận trùng.",
      outcomeUnknownAttention: "Flow chưa xác nhận task hiện tại đã gửi hay chưa. Hàng đợi đã tạm dừng và giữ các task sau ở trạng thái chờ. Kiểm tra Flow trước; nếu lệnh đã chạy, đừng gửi lại. Sau khi xác định trạng thái, bấm Chạy tiếp để chạy task sau. Task hiện tại sẽ không tự gửi lại.",
      dependencyBlockedAttention: "Tác vụ này đang chờ một tác vụ Flow trước đó. Xử lý hoặc thử lại tác vụ trước, rồi bấm Chạy tiếp để nối lại chuỗi.",
      mcp: "AI · MCP", manual: "THỦ CÔNG", moveUp: "Chuyển tác vụ {n} lên", moveDown: "Chuyển tác vụ {n} xuống", retry: "Thử lại", remove: "Xóa",
      pending: "Đang chờ", runningStatus: "Đang chạy", completedStatus: "Hoàn tất", failed: "Thất bại", cancelled: "Đã hủy",
      needsAttention: "Cần xử lý",
      generationComplete: "Flow đã tạo {count} kết quả", downloadQueued: "Chờ tải {done}/{total}", downloadingCount: "Đang tải {done}/{total}", downloadedCount: "Đã tải {done}/{total}", downloadFailedCount: "Tải lỗi {done}/{total}", downloadSkipped: "Đã bỏ qua tải",
      waitingForUser: "Chờ bạn bấm Tạo", continueManual: "Đã bấm Tạo · tiếp tục", cancelManual: "Bỏ qua", manualSubmitLabel: "Tôi sẽ tự bấm Tạo trên Flow",
      noConnection: "Không thể kết nối với tiện ích Flow.", updateFailed: "Không thể cập nhật hàng đợi Flow.",
      assetRequired: "Nhập tên video cần chỉnh sửa hoặc nối tiếp.", scenesRequired: "Nhập ít nhất một cảnh, mỗi cảnh trên một dòng.",
      autoDownloadLabel: "Tự động tải kết quả về máy",
      editLabel: "Sửa", continueLabel: "Nối tiếp", agentLabel: "Agent", scenes: "cảnh",
      retryBatch: "Thử lại {n} tác vụ lỗi an toàn",
    },
    en: {
      aria: "Flow task queue", title: "Flow queue", loading: "Loading…",
      pause: "Pause", resume: "Resume", stop: "Stop", clear: "Clear", refresh: "Refresh",
      promptAria: "Prompt to add to the Flow queue", promptPlaceholder: "Enter a prompt to add to the Flow queue…",
      typeAria: "Flow content type", image: "Generate image", video: "Generate video", edit: "Edit video", continue: "Continue video", agent: "Flow Agent batch",
      assetPlaceholder: "Existing video name in the project (for edit/continue)", assetAria: "Video name in Flow",
      ratioAria: "Aspect ratio", auto: "Auto", submit: "Add to queue",
      batchLabel: "Each paragraph separated by a blank line is one batch task",
      batchName: "Flow batch", batchItem: "Task {n}/{total}", batchLimit: "A batch can contain at most 100 prompts.",
      batchComplete: "{n}/{total} complete",
      referenceNames: "Flow project reference image/video names, one per line",
      referenceModeAria: "How references are assigned to prompts",
      referenceNone: "No references", referenceAll: "Use all for every prompt", referenceSequential: "Assign in order per prompt",
      referenceCountAria: "References per prompt", referenceCountLabel: "refs/prompt",
      referenceTooMany: "Flow accepts at most 3 references per prompt.", referencePoolShort: "There are not enough references for this sequential assignment.",
      firstFrameNames: "Video first frame (one line per prompt; one line applies to all)", lastFrameNames: "Video last frame (one line per prompt; one line applies to all)",
      frameCountMismatch: "Frames need one shared entry or one entry per prompt.", frameReferenceConflict: "Flow Frames cannot be combined with ingredient references.",
      autoRetrying: "Automatically retrying {n}/{max} after {code}: {error}",
      tasks: "tasks", completed: "completed", paused: "paused", running: "running", empty: "The queue is empty.",
      pageBlockedAttentionRetry: "Flow has a page state that is blocking work. The queue paused automatically and kept later tasks pending. Resolve the Flow state, then select Resume; the task that was not submitted will be retried first.",
      pageBlockedAttentionContinue: "Flow still has a state that needs attention. The queue paused automatically and kept later tasks pending. Resolve it, then select Resume to continue with later tasks. The current task remains failed to prevent a duplicate confirmation or submission.",
      outcomeUnknownAttention: "Flow did not confirm whether the current task was submitted. The queue paused and kept later tasks pending. Check Flow first; if the request is running, do not submit it again. After you confirm its state, select Resume to run the next task. The current task will not be retried automatically.",
      dependencyBlockedAttention: "This task is waiting for an earlier Flow task. Resolve or retry that task, then select Resume to continue the chain.",
      mcp: "AI · MCP", manual: "MANUAL", moveUp: "Move task {n} up", moveDown: "Move task {n} down", retry: "Retry", remove: "Remove",
      pending: "Pending", runningStatus: "Running", completedStatus: "Completed", failed: "Failed", cancelled: "Cancelled",
      needsAttention: "Needs attention",
      generationComplete: "Flow created {count} result(s)", downloadQueued: "Download queued {done}/{total}", downloadingCount: "Downloading {done}/{total}", downloadedCount: "Downloaded {done}/{total}", downloadFailedCount: "Download failed {done}/{total}", downloadSkipped: "Download skipped",
      waitingForUser: "Waiting for your submit", continueManual: "I clicked Create · continue", cancelManual: "Skip", manualSubmitLabel: "I will click Create in Flow",
      noConnection: "Cannot connect to the Flow extension.", updateFailed: "Could not update the Flow queue.",
      assetRequired: "Enter the video name to edit or continue.", scenesRequired: "Enter at least one scene, one per line.",
      autoDownloadLabel: "Automatically download results",
      editLabel: "Edit", continueLabel: "Continue", agentLabel: "Agent", scenes: "scenes",
      retryBatch: "Retry {n} safe failed tasks",
    },
  });

  const STYLE_TEXT = `
    .flow-queue-panel{font:13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--text-primary,#f8fafc);display:flex;flex-direction:column;gap:10px;min-width:0}
    .flow-queue-panel *{box-sizing:border-box}
    .flow-queue-panel__heading,.flow-queue-panel__toolbar,.flow-queue-panel__item-head,.flow-queue-panel__item-actions{display:flex;align-items:center;gap:8px}
    .flow-queue-panel__heading,.flow-queue-panel__item-head{justify-content:space-between}
    .flow-queue-panel__title{font-weight:700;font-size:14px}
    .flow-queue-panel__summary,.flow-queue-panel__muted{color:var(--text-muted,#8b8b92);font-size:12px}
    .flow-queue-panel__status--attention{color:#fbbf24}
    .flow-queue-panel__attention{padding:8px 10px;border:1px solid rgba(245,158,11,.35);border-radius:6px;background:rgba(245,158,11,.08);color:#fbbf24;font-size:12px}
    .flow-queue-panel__toolbar{flex-wrap:wrap}
    .flow-queue-panel button{font:inherit;color:inherit;background:var(--card,#292929);border:1px solid var(--border,rgba(255,255,255,.12));border-radius:6px;padding:5px 9px;cursor:pointer}
    .flow-queue-panel button:hover:not(:disabled){border-color:var(--primary,#ccff00)}
    .flow-queue-panel button:disabled{opacity:.45;cursor:default}
    .flow-queue-panel__add button[type="submit"]{background:var(--primary,#ccff00);border-color:var(--primary,#ccff00);color:var(--primary-fg,#1e1e1e);font-weight:650}
    .flow-queue-panel__add button[type="submit"]:hover:not(:disabled){background:var(--primary-hover,#b8e600);border-color:var(--primary-hover,#b8e600)}
    .flow-queue-panel button:focus-visible,.flow-queue-panel__input:focus-visible{outline:2px solid var(--primary,#ccff00);outline-offset:2px}
    .flow-queue-panel__add{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px}
    .flow-queue-panel__input{min-width:0;min-height:62px;resize:vertical;padding:8px;border:1px solid var(--border,rgba(255,255,255,.12));border-radius:6px;background:var(--card,#292929);color:inherit;font:inherit}
    .flow-queue-panel__manual{grid-column:1/-1;display:flex;align-items:center;gap:7px;color:var(--text-muted,#aaa);font-size:12px}
    .flow-queue-panel__items{display:flex;flex-direction:column;gap:7px;max-height:42vh;overflow:auto}
    .flow-queue-panel__item{padding:9px;border:1px solid var(--border,rgba(255,255,255,.1));border-radius:7px;background:var(--card,#292929);min-width:0}
    .flow-queue-panel__label{font-weight:600;overflow-wrap:anywhere}
    .flow-queue-panel__status{white-space:nowrap;color:var(--text-muted,#8b8b92);font-size:11px}
    .flow-queue-panel__detail{margin-top:4px;color:var(--text-muted,#8b8b92);white-space:pre-wrap;overflow-wrap:anywhere}
    .flow-queue-panel__milestones{margin-top:5px;color:#a3e635;font-size:11px;overflow-wrap:anywhere}
    .flow-queue-panel__milestones--failed{color:#f87171}
    .flow-queue-panel__progress{height:4px;margin-top:7px;border-radius:4px;background:rgba(255,255,255,.1);overflow:hidden}
    .flow-queue-panel__progress>span{display:block;height:100%;background:var(--primary,#ccff00);transition:width .15s ease}
    .flow-queue-panel__item-actions{justify-content:flex-end;margin-top:7px;flex-wrap:wrap}
    .flow-queue-panel__error{color:var(--danger,#ef4444);font-size:12px;overflow-wrap:anywhere}
    .flow-queue-panel__empty{padding:14px;text-align:center;color:var(--text-muted,#8b8b92)}
  `;

  function makeElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = String(text);
    return element;
  }

  function normalizeItems(snapshot) {
    if (Array.isArray(snapshot)) return snapshot;
    if (Array.isArray(snapshot?.items)) return snapshot.items;
    if (Array.isArray(snapshot?.queue)) return snapshot.queue;
    if (Array.isArray(snapshot?.tasks)) return snapshot.tasks;
    if (Array.isArray(snapshot?.state?.items)) return snapshot.state.items;
    if (Array.isArray(snapshot?.snapshot?.items)) return snapshot.snapshot.items;
    return [];
  }

  function taskIdentity(task, index) {
    return String(task?.id ?? task?.taskId ?? task?.task_id ?? task?.requestId ?? `queue-item-${index}`);
  }

  function progressPercent(task) {
    const value = task?.progress?.percent ?? task?.progressPercent ?? task?.progress_percent ?? task?.percent;
    const number = Number(value);
    if (Number.isFinite(number)) return Math.max(0, Math.min(100, number));
    const total = Number(task?.total ?? task?.progress?.total);
    const current = Number(task?.completed ?? task?.progress?.completed ?? task?.current);
    if (Number.isFinite(total) && total > 0 && Number.isFinite(current)) return Math.max(0, Math.min(100, current / total * 100));
    return null;
  }

  class FlowQueuePanel {
    constructor(container, options = {}) {
      if (!container || typeof container.appendChild !== "function") throw new TypeError("FlowQueuePanel needs a DOM container.");
      this.container = container;
      this.runtime = options.runtime || root.chrome?.runtime;
      this.onError = typeof options.onError === "function" ? options.onError : () => {};
      this.snapshot = { items: [] };
      this.locale = root.I18n?.getLocale?.() === "en" ? "en" : "vi";
      this.busy = false;
      this.mounted = false;
      this._messageListener = message => this._onRuntimeMessage(message);
      this._onClick = event => this._handleClick(event);
      this._onSubmit = event => this._handleSubmit(event);
      this._onChange = event => this._handleChange(event);
    }

    static mount(container, options) {
      const panel = new FlowQueuePanel(container, options);
      panel.mount();
      return panel;
    }

    mount() {
      if (this.mounted) return this;
      this.mounted = true;
      this._ensureStyles();
      this._buildShell();
      this.container.addEventListener("click", this._onClick);
      this.container.addEventListener("submit", this._onSubmit);
      this.container.addEventListener("change", this._onChange);
      this.runtime?.onMessage?.addListener?.(this._messageListener);
      this._storageListener = changes => {
        if (!changes?.af_locale && !changes?.lang && !changes?.language && !changes?.locale) return;
        const next = root.I18n?.getLocale?.() === "en" ? "en" : "vi";
        if (next !== this.locale) this.setLocale(next);
      };
      root.chrome?.storage?.onChanged?.addListener?.(this._storageListener);
      void this.refresh();
      return this;
    }

    async refresh() {
      return this._send(MESSAGE.get);
    }

    async add(job) {
      if (!job || typeof job !== "object" || Array.isArray(job)) throw new TypeError("A queue job object is required.");
      return this._send(MESSAGE.add, { job });
    }

    pause() { return this._send(MESSAGE.pause); }
    resume() { return this._send(MESSAGE.resume); }
    stop() { return this._send(MESSAGE.stop); }
    clear() { return this._send(MESSAGE.clear); }

    unmount() {
      if (!this.mounted) return;
      this.mounted = false;
      this.container.removeEventListener("click", this._onClick);
      this.container.removeEventListener("submit", this._onSubmit);
      this.container.removeEventListener("change", this._onChange);
      this.runtime?.onMessage?.removeListener?.(this._messageListener);
      root.chrome?.storage?.onChanged?.removeListener?.(this._storageListener);
      this.container.replaceChildren();
    }

    _ensureStyles() {
      const doc = this.container.ownerDocument || document;
      if (doc.getElementById("flow-queue-panel-styles")) return;
      const style = doc.createElement("style");
      style.id = "flow-queue-panel-styles";
      style.textContent = STYLE_TEXT;
      (doc.head || doc.documentElement).appendChild(style);
    }

    _buildShell() {
      const text = TEXT[this.locale] || TEXT.vi;
      const panel = makeElement("section", "flow-queue-panel");
      panel.setAttribute("aria-label", text.aria);

      const heading = makeElement("div", "flow-queue-panel__heading");
      heading.append(makeElement("span", "flow-queue-panel__title", text.title));
      this.summary = makeElement("span", "flow-queue-panel__summary", text.loading);
      heading.append(this.summary);
      this.attentionBanner = makeElement("div", "flow-queue-panel__attention");
      this.attentionBanner.setAttribute("role", "status");
      this.attentionBanner.setAttribute("aria-live", "polite");
      this.attentionBanner.hidden = true;

      const toolbar = makeElement("div", "flow-queue-panel__toolbar");
      toolbar.append(
        this._button(text.pause, "pause"),
        this._button(text.resume, "resume"),
        this._button(text.stop, "stop"),
        this._button(text.clear, "clear"),
        this._button(text.refresh, "refresh"),
      );

      const form = makeElement("form", "flow-queue-panel__add");
      const input = makeElement("textarea", "flow-queue-panel__input");
      input.name = "prompt";
      input.required = true;
      input.maxLength = 12000;
      input.setAttribute("aria-label", text.promptAria);
      input.placeholder = text.promptPlaceholder;
      const type = makeElement("select", "flow-queue-panel__input");
      type.name = "type";
      type.setAttribute("aria-label", text.typeAria);
      for (const [value, label] of [
        ["image", text.image], ["video", text.video], ["edit", text.edit],
        ["continue", text.continue], ["agent", text.agent],
      ]) {
        const option = makeElement("option", "", label);
        option.value = value;
        type.append(option);
      }
      this.typeInput = type;
      const refsInput = makeElement("textarea", "flow-queue-panel__input");
      refsInput.name = "references";
      refsInput.maxLength = 3000;
      refsInput.rows = 2;
      refsInput.setAttribute("aria-label", text.referenceNames);
      refsInput.placeholder = text.referenceNames;
      this.referencesInput = refsInput;
      const refMode = makeElement("select", "flow-queue-panel__input");
      refMode.name = "reference_mode";
      refMode.setAttribute("aria-label", text.referenceModeAria);
      for (const [value, label] of [["none", text.referenceNone], ["all", text.referenceAll], ["sequential", text.referenceSequential]]) {
        const option = makeElement("option", "", label);
        option.value = value;
        refMode.append(option);
      }
      this.referenceModeInput = refMode;
      const refCountWrap = makeElement("label", "flow-queue-panel__manual");
      const refCount = makeElement("select", "flow-queue-panel__input");
      refCount.name = "reference_count";
      refCount.setAttribute("aria-label", text.referenceCountAria);
      for (const value of ["1", "2", "3"]) {
        const option = makeElement("option", "", value);
        option.value = value;
        refCount.append(option);
      }
      refCountWrap.append(refCount, makeElement("span", "", text.referenceCountLabel));
      this.referenceCountInput = refCount;
      const firstFramesInput = makeElement("textarea", "flow-queue-panel__input");
      firstFramesInput.name = "first_frames";
      firstFramesInput.rows = 2;
      firstFramesInput.maxLength = 3000;
      firstFramesInput.placeholder = text.firstFrameNames;
      firstFramesInput.setAttribute("aria-label", text.firstFrameNames);
      this.firstFramesInput = firstFramesInput;
      const lastFramesInput = makeElement("textarea", "flow-queue-panel__input");
      lastFramesInput.name = "last_frames";
      lastFramesInput.rows = 2;
      lastFramesInput.maxLength = 3000;
      lastFramesInput.placeholder = text.lastFrameNames;
      lastFramesInput.setAttribute("aria-label", text.lastFrameNames);
      this.lastFramesInput = lastFramesInput;
      this.assetInput = makeElement("input", "flow-queue-panel__input");
      this.assetInput.name = "asset";
      this.assetInput.type = "text";
      this.assetInput.placeholder = text.assetPlaceholder;
      this.assetInput.setAttribute("aria-label", text.assetAria);
      const ratio = makeElement("select", "flow-queue-panel__input");
      ratio.name = "aspect_ratio";
      ratio.setAttribute("aria-label", text.ratioAria);
      for (const [value, label] of [["", text.auto], ["16:9", "16:9"], ["9:16", "9:16"], ["1:1", "1:1"]]) {
        const option = makeElement("option", "", label);
        option.value = value;
        ratio.append(option);
      }
      const submit = makeElement("button", "", text.submit);
      submit.type = "submit";
      const autoDownloadLabel = makeElement("label", "flow-queue-panel__manual");
      const autoDownloadCheckbox = makeElement("input");
      autoDownloadCheckbox.type = "checkbox";
      autoDownloadCheckbox.name = "auto_download";
      autoDownloadCheckbox.checked = true;
      autoDownloadLabel.append(autoDownloadCheckbox, makeElement("span", "", text.autoDownloadLabel));
      const manualLabel = makeElement("label", "flow-queue-panel__manual");
      const manualCheckbox = makeElement("input");
      manualCheckbox.type = "checkbox";
      manualCheckbox.name = "manual_submit";
      manualLabel.append(manualCheckbox, makeElement("span", "", text.manualSubmitLabel));
      const batchLabel = makeElement("label", "flow-queue-panel__manual");
      const batchCheckbox = makeElement("input");
      batchCheckbox.type = "checkbox";
      batchCheckbox.name = "batch_mode";
      batchLabel.append(batchCheckbox, makeElement("span", "", text.batchLabel));
      form.append(input, type, this.assetInput, ratio, refsInput, refMode, refCountWrap, firstFramesInput, lastFramesInput, submit, autoDownloadLabel, manualLabel, batchLabel);

      this.error = makeElement("div", "flow-queue-panel__error");
      this.error.setAttribute("role", "alert");
      this.error.hidden = true;
      this.itemsElement = makeElement("div", "flow-queue-panel__items");
      this.itemsElement.setAttribute("aria-live", "polite");

      panel.append(heading, toolbar, this.attentionBanner, form, this.error, this.itemsElement);
      this.container.replaceChildren(panel);
      this.panel = panel;
      this._syncFields();
    }

    _button(label, action) {
      const button = makeElement("button", "", label);
      button.type = "button";
      button.dataset.flowQueueAction = action;
      return button;
    }

    setLocale(locale) {
      const next = locale === "en" ? "en" : "vi";
      if (next === this.locale) return;
      const previous = {
        prompt: this.panel?.querySelector('[name="prompt"]')?.value || "",
        type: this.typeInput?.value || "image",
        asset: this.assetInput?.value || "",
        ratio: this.panel?.querySelector('[name="aspect_ratio"]')?.value || "",
        manualSubmit: this.panel?.querySelector('[name="manual_submit"]')?.checked === true,
        autoDownload: this.panel?.querySelector('[name="auto_download"]')?.checked !== false,
        batchMode: this.panel?.querySelector('[name="batch_mode"]')?.checked === true,
        references: this.referencesInput?.value || "",
        referenceMode: this.referenceModeInput?.value || "none",
        referenceCount: this.referenceCountInput?.value || "1",
        firstFrames: this.firstFramesInput?.value || "",
        lastFrames: this.lastFramesInput?.value || "",
      };
      this.locale = next;
      this._buildShell();
      this.panel.querySelector('[name="prompt"]').value = previous.prompt;
      this.typeInput.value = previous.type;
      this.assetInput.value = previous.asset;
      this.panel.querySelector('[name="aspect_ratio"]').value = previous.ratio;
      this.panel.querySelector('[name="manual_submit"]').checked = previous.manualSubmit;
      this.panel.querySelector('[name="auto_download"]').checked = previous.autoDownload;
      this.panel.querySelector('[name="batch_mode"]').checked = previous.batchMode;
      this.referencesInput.value = previous.references;
      this.referenceModeInput.value = previous.referenceMode;
      this.referenceCountInput.value = previous.referenceCount;
      this.firstFramesInput.value = previous.firstFrames;
      this.lastFramesInput.value = previous.lastFrames;
      this._syncFields();
      this.render();
    }

    _text(key, params = {}) {
      let value = (TEXT[this.locale] || TEXT.vi)[key] || key;
      for (const [name, replacement] of Object.entries(params)) value = value.replaceAll(`{${name}}`, String(replacement));
      return value;
    }

    async _send(type, payload = {}) {
      if (!this.runtime?.sendMessage) {
        this._showError(this._text("noConnection"));
        return { ok: false, error: "RUNTIME_UNAVAILABLE" };
      }
      this._setBusy(true);
      this._clearError();
      try {
        const response = await this.runtime.sendMessage({ type, ...payload });
        if (response?.ok === false || response?.error) {
          throw new Error(String(response.error?.message || response.error || response.message || this._text("updateFailed")));
        }
        if (type === MESSAGE.get) this._acceptSnapshot(response);
        else if (response?.items || response?.queue || response?.tasks || response?.snapshot) this._acceptSnapshot(response.snapshot || response);
        else void this.refresh();
        return response;
      } catch (error) {
        this._showError(error?.message || this._text("updateFailed"));
        this.onError(error);
        return { ok: false, error: String(error?.message || error) };
      } finally {
        this._setBusy(false);
      }
    }

    _onRuntimeMessage(message) {
      if (!message || !["flow-queue:changed", "flow-queue:state", "flow-queue:update"].includes(message.type)) return;
      this._acceptSnapshot(message.snapshot || message.state || message);
    }

    _acceptSnapshot(snapshot) {
      if (!snapshot || typeof snapshot !== "object") return;
      this.snapshot = snapshot;
      this.render();
    }

    render() {
      if (!this.itemsElement) return;
      const items = normalizeItems(this.snapshot);
      const running = Boolean(this.snapshot.running ?? this.snapshot.isRunning ?? this.snapshot.state?.running);
      const paused = Boolean(this.snapshot.paused ?? this.snapshot.isPaused ?? this.snapshot.state?.paused);
      const attention = this.snapshot.attention ?? this.snapshot.state?.attention;
      const active = Number(this.snapshot.activeCount ?? this.snapshot.active ?? this.snapshot.state?.activeCount ?? 0);
      const counts = this.snapshot.counts || {};
      const completed = Number(counts.completed ?? this.snapshot.completed ?? items.filter(item => this._status(item) === "completed").length);
      this.summary.textContent = `${items.length} ${this._text("tasks")} · ${completed} ${this._text("completed")}${paused ? ` · ${this._text("paused")}` : running ? ` · ${this._text("running")}${active ? ` (${active})` : ""}` : ""}`;
      this.attentionBanner.hidden = !["flow-page-blocked", "flow-outcome-unknown", "flow-dependency-blocked"].includes(attention?.type);
      this.attentionBanner.textContent = this.attentionBanner.hidden ? "" : attention?.type === "flow-dependency-blocked"
        ? this._text("dependencyBlockedAttention")
        : attention?.type === "flow-outcome-unknown"
          ? this._text("outcomeUnknownAttention")
          : this._text(attention?.retryOnResume === false ? "pageBlockedAttentionContinue" : "pageBlockedAttentionRetry");
      this.itemsElement.replaceChildren();
      if (!items.length) {
        this.itemsElement.append(makeElement("div", "flow-queue-panel__empty", this._text("empty")));
        return;
      }
      const fragment = document.createDocumentFragment();
      items.forEach((task, index) => fragment.append(this._renderItem(task, index, items.length)));
      this.itemsElement.append(fragment);
    }

    _renderItem(task, index, count) {
      const item = makeElement("article", "flow-queue-panel__item");
      const id = taskIdentity(task, index);
      item.dataset.flowQueueItem = id;
      const head = makeElement("div", "flow-queue-panel__item-head");
      const label = task?.label ?? task?.title ?? task?.name ?? task?.prompt ?? task?.payload?.prompt ?? task?.job?.label ?? task?.job?.payload?.prompt ?? task?.task?.prompt ?? `Task ${index + 1}`;
      const source = task?.metadata?.source || (String(label).toLowerCase().includes("ai") || String(label).toLowerCase().includes("mcp") ? "mcp" : "manual");
      const sourceBadge = makeElement("span", "flow-queue-panel__badge", source === "mcp" ? this._text("mcp") : this._text("manual"));
      sourceBadge.style.cssText = source === "mcp"
        ? "font-size:10px;padding:2px 6px;border-radius:4px;background:rgba(204,255,0,0.15);color:var(--primary,#ccff00);margin-right:6px;border:1px solid rgba(204,255,0,0.3);font-weight:600"
        : "font-size:10px;padding:2px 6px;border-radius:4px;background:rgba(255,255,255,0.08);color:var(--text-muted,#8b8b92);margin-right:6px;border:1px solid rgba(255,255,255,0.15);font-weight:600";
      const labelContainer = makeElement("span", "flow-queue-panel__label-container");
      labelContainer.style.cssText = "display:flex;align-items:center;min-width:0;overflow:hidden";
      labelContainer.append(sourceBadge, makeElement("span", "flow-queue-panel__label", label));
      const attention = this.snapshot?.attention ?? this.snapshot?.state?.attention;
      const isBlockedTask = ["flow-page-blocked", "flow-outcome-unknown", "flow-dependency-blocked"].includes(attention?.type) && String(attention.jobId || "") === id && String(task?.status || "").toLowerCase() === "failed";
      const status = makeElement("span", `flow-queue-panel__status${isBlockedTask ? " flow-queue-panel__status--attention" : ""}`, isBlockedTask ? this._text("needsAttention") : this._status(task));
      head.append(labelContainer, status);
      item.append(head);
      if (task?.batch && Number.isInteger(task.batch.batchIndex) && Number.isInteger(task.batch.batchCount)) {
        const siblings = normalizeItems(this.snapshot).filter(candidate => candidate?.batch?.batchId === task.batch.batchId);
        const completedCount = siblings.filter(candidate => ["completed", "done"].includes(String(candidate.status || "").toLowerCase())).length;
        const batchText = `${task.batch.batchLabel || this._text("batchName")} · ${this._text("batchItem", { n: task.batch.batchIndex + 1, total: task.batch.batchCount })} · ${this._text("batchComplete", { n: completedCount, total: task.batch.batchCount })}`;
        item.append(makeElement("div", "flow-queue-panel__detail", batchText));
      }
      const failed = ["failed", "error", "rejected"].includes(String(task?.status ?? task?.state ?? "").toLowerCase());
      const autoRetry = String(task?.status || "").toLowerCase() === "pending" && task?.progress?.phase === "auto_retry";
      const detail = autoRetry
        ? this._text("autoRetrying", {
          n: Number(task.progress.attempt) || 1,
          max: Number(task.progress.maxAttempts) || 2,
          code: String(task.progress.errorCode || "FLOW_RETRYABLE_ERROR"),
          error: String(task.progress.reason || "").slice(0, 240),
        })
        : failed
        ? [task?.errorCode, task?.error].filter(Boolean).join(": ")
        : task?.progress?.message ?? task?.progressText ?? task?.message ?? task?.error ?? "";
      if (detail) item.append(makeElement("div", "flow-queue-panel__detail", detail));
      const generation = task?.progress?.generation;
      const download = task?.progress?.download;
      if (generation?.state === "completed") {
        const count = Math.max(0, Number(generation.count) || 0);
        const total = Math.max(1, Number(download?.total) || count || 1);
        const done = Math.max(0, Math.min(total, Number(download?.completed) || 0));
        const state = String(download?.state || "queued");
        const downloadKey = state === "completed" ? "downloadedCount"
          : state === "failed" ? "downloadFailedCount"
          : state === "downloading" ? "downloadingCount"
          : state === "skipped" ? "downloadSkipped"
          : "downloadQueued";
        const milestone = makeElement(
          "div",
          `flow-queue-panel__milestones${state === "failed" ? " flow-queue-panel__milestones--failed" : ""}`,
          `${this._text("generationComplete", { count })} · ${this._text(downloadKey, { done, total })}`,
        );
        item.append(milestone);
      }
      const percent = progressPercent(task);
      if (percent !== null) {
        const bar = makeElement("div", "flow-queue-panel__progress");
        bar.setAttribute("role", "progressbar");
        bar.setAttribute("aria-valuemin", "0");
        bar.setAttribute("aria-valuemax", "100");
        bar.setAttribute("aria-valuenow", String(Math.round(percent)));
        const fill = makeElement("span");
        fill.style.width = `${percent}%`;
        bar.append(fill);
        item.append(bar);
      }
      const actions = makeElement("div", "flow-queue-panel__item-actions");
      const up = this._button("↑", "reorder");
      up.dataset.itemId = id; up.dataset.fromIndex = String(index); up.dataset.toIndex = String(Math.max(0, index - 1));
      up.setAttribute("aria-label", this._text("moveUp", { n: index + 1 })); up.dataset.stateDisabled = String(index === 0); up.disabled = index === 0;
      const down = this._button("↓", "reorder");
      down.dataset.itemId = id; down.dataset.fromIndex = String(index); down.dataset.toIndex = String(Math.min(count - 1, index + 1));
      down.setAttribute("aria-label", this._text("moveDown", { n: index + 1 })); down.dataset.stateDisabled = String(index === count - 1); down.disabled = index === count - 1;
      actions.append(up, down);
      if (String(task?.status || "").toLowerCase() === "waiting_for_user") {
        const continueButton = this._button(this._text("continueManual"), "manual-continue");
        continueButton.dataset.itemId = id;
        const cancelButton = this._button(this._text("cancelManual"), "manual-cancel");
        cancelButton.dataset.itemId = id;
        actions.replaceChildren(continueButton, cancelButton);
        item.append(actions);
        return item;
      }
      if (this._isKnownSafeRetry(task)) {
        const retry = this._button(this._text("retry"), "retry");
        retry.dataset.itemId = id;
        retry.dataset.index = String(index);
        actions.append(retry);
      }
      const batchId = task?.batch?.batchId;
      if (batchId) {
        const siblings = normalizeItems(this.snapshot).filter(candidate => candidate?.batch?.batchId === batchId);
        const firstVisibleIndex = normalizeItems(this.snapshot).findIndex(candidate => candidate?.batch?.batchId === batchId);
        const retryableCount = siblings.filter(candidate => this._isKnownSafeRetry(candidate) && String(candidate.status).toLowerCase() === "failed").length;
        if (index === firstVisibleIndex && retryableCount > 0) {
          const retryBatch = this._button(this._text("retryBatch", { n: retryableCount }), "retry-batch");
          retryBatch.dataset.batchId = String(batchId);
          actions.append(retryBatch);
        }
      }
      const remove = this._button(this._text("remove"), "remove");
      remove.dataset.itemId = id;
      actions.append(remove);
      item.append(actions);
      return item;
    }

    _status(task) {
      const status = String(task?.status ?? task?.state ?? task?.phase ?? "pending").toLowerCase();
      return ({ pending: this._text("pending"), running: this._text("runningStatus"), completed: this._text("completedStatus"), failed: this._text("failed"), cancelled: this._text("cancelled"), waiting_for_user: this._text("waitingForUser") })[status] || status.replaceAll("_", " ");
    }

    _isKnownSafeRetry(task) {
      const status = String(task?.status ?? task?.state ?? "").toLowerCase();
      const failed = ["failed", "error", "rejected"].includes(status);
      const safe = task?.retrySafe === true || task?.safeToRetry === true || task?.safe_to_retry === true;
      const operation = String(task?.operation ?? task?.job?.operation ?? task?.task?.operation ?? task?.kind ?? task?.task?.kind ?? "");
      const result = task?.result?.result ?? task?.result ?? task?.job?.result?.result ?? task?.job?.result;
      const partialAgent = status === "completed" && operation === "flow.agent.batch"
        && Array.isArray(result?.failedScenes) && result.failedScenes.length > 0 && !result?.downloadError;
      return RETRYABLE_OPERATIONS.has(operation) && ((failed && safe) || partialAgent);
    }

    async _handleSubmit(event) {
      const form = event.target;
      if (!form?.matches?.(".flow-queue-panel__add")) return;
      event.preventDefault();
      const input = form.elements.namedItem("prompt");
      const prompt = String(input?.value || "").trim();
      if (!prompt) return;
      const type = String(form.elements.namedItem("type")?.value || "image");
      const batchMode = form.elements.namedItem("batch_mode")?.checked === true && type !== "agent";
      const prompts = batchMode ? prompt.split(/\n\s*\n/).map(value => value.trim()).filter(Boolean) : [prompt];
      if (prompts.length > 100) { this._showError(this._text("batchLimit")); return; }
      const aspectRatio = String(form.elements.namedItem("aspect_ratio")?.value || "");
      const asset = String(form.elements.namedItem("asset")?.value || "").trim();
      let operation = "flow.generation.submit";
      const referenceNames = String(form.elements.namedItem("references")?.value || "").split(/[\r\n,]+/).map(value => value.trim()).filter(Boolean);
      const referenceMode = String(form.elements.namedItem("reference_mode")?.value || "none");
      const referenceCount = Math.max(1, Math.min(3, Number(form.elements.namedItem("reference_count")?.value) || 1));
      const readFrames = name => String(form.elements.namedItem(name)?.value || "").trimEnd().split(/\r?\n/).map(value => value.trim());
      const firstFrames = readFrames("first_frames");
      const lastFrames = readFrames("last_frames");
      const hasFrames = firstFrames.some(Boolean) || lastFrames.some(Boolean);
      if (hasFrames && type !== "video") { this._showError(this._text("frameCountMismatch")); return; }
      if (hasFrames && [firstFrames, lastFrames].some(values => values.some(Boolean) && values.length !== 1 && values.length !== prompts.length)) {
        this._showError(this._text("frameCountMismatch")); return;
      }
      if (hasFrames && referenceMode !== "none") { this._showError(this._text("frameReferenceConflict")); return; }
      if (type === "image" || type === "video") {
        const neededReferences = referenceMode === "all" ? referenceNames.length : prompts.length * referenceCount;
        if (referenceMode === "all" && referenceNames.length > 3) { this._showError(this._text("referenceTooMany")); return; }
        if (referenceMode === "sequential" && referenceNames.length < neededReferences) { this._showError(this._text("referencePoolShort")); return; }
      }
      const attachmentsForPrompt = itemIndex => {
        const names = referenceMode === "all" ? referenceNames
          : referenceMode === "sequential" ? referenceNames.slice(itemIndex * referenceCount, (itemIndex + 1) * referenceCount)
          : [];
        return names.map(assetName => ({ assetName }));
      };
      let makePayload = (itemPrompt, itemIndex) => ({
        type, prompt: itemPrompt, aspect_ratio: aspectRatio, variants: 1,
        attachments: hasFrames ? [] : attachmentsForPrompt(itemIndex),
        ...(hasFrames ? {
          ...(firstFrames[itemIndex] ? { firstFrame: { assetName: firstFrames.length === 1 ? firstFrames[0] : firstFrames[itemIndex] } } : {}),
          ...(lastFrames[itemIndex] ? { lastFrame: { assetName: lastFrames.length === 1 ? lastFrames[0] : lastFrames[itemIndex] } } : {}),
        } : {}),
        video_settings: {},
      });
      let makeLabel = itemPrompt => itemPrompt.slice(0, 96);
      if (type === "edit" || type === "continue") {
        if (!asset) { this._showError(this._text("assetRequired")); return; }
        operation = type === "edit" ? "flow.edit.run" : "flow.continue.run";
        makePayload = itemPrompt => ({ params: type === "edit" ? { edit_asset: asset, prompt: itemPrompt } : { continue_from: asset, prompt: itemPrompt, continue_mode: "exact", aspect_ratio: aspectRatio || "16:9" } });
        makeLabel = () => `${type === "edit" ? this._text("editLabel") : this._text("continueLabel")}: ${asset}`;
      } else if (type === "agent") {
        const scenes = prompt.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        if (!scenes.length) { this._showError(this._text("scenesRequired")); return; }
        operation = "flow.agent.batch";
        makePayload = () => ({ params: { agent_scenes: scenes, aspect_ratio: aspectRatio || "16:9" } });
        makeLabel = () => `${this._text("agentLabel")}: ${scenes.length} ${this._text("scenes")}`;
      } else {
        const manualSubmit = form.elements.namedItem("manual_submit")?.checked === true;
        const original = makePayload;
        makePayload = itemPrompt => ({ ...original(itemPrompt), manualSubmit });
      }
      const autoDownload = form.elements.namedItem("auto_download")?.checked !== false;
      const downloadAwareMakePayload = makePayload;
      makePayload = (...args) => ({ ...downloadAwareMakePayload(...args), autoDownload });
      if (batchMode && prompts.length > 1) {
        const jobs = prompts.map((itemPrompt, index) => ({ operation, payload: makePayload(itemPrompt, index), label: makeLabel(itemPrompt) }));
        const response = await this._send(MESSAGE.addBatch, { jobs, batchLabel: this._text("batchName") });
        if (response?.ok !== false && !response?.error && input) input.value = "";
        return;
      }
      const response = await this.add({ operation, payload: makePayload(prompts[0], 0), label: makeLabel(prompts[0]) });
      if (response?.ok !== false && !response?.error && input) input.value = "";
    }

    _handleChange(event) {
      if (event.target === this.typeInput || event.target === this.referenceModeInput) this._syncFields();
    }

    _syncFields() {
      if (!this.typeInput || !this.assetInput) return;
      const needsAsset = ["edit", "continue"].includes(this.typeInput.value);
      this.assetInput.hidden = !needsAsset;
      this.assetInput.required = needsAsset;
      const manualLabel = this.panel?.querySelector('[name="manual_submit"]')?.closest("label");
      if (manualLabel) manualLabel.hidden = needsAsset || this.typeInput.value === "agent";
      const batchLabel = this.panel?.querySelector('[name="batch_mode"]')?.closest("label");
      if (batchLabel) batchLabel.hidden = this.typeInput.value === "agent";
      const referenceControls = [this.referencesInput, this.referenceModeInput, this.referenceCountInput?.closest("label")];
      referenceControls.forEach(control => { if (control) control.hidden = !["image", "video"].includes(this.typeInput.value); });
      [this.firstFramesInput, this.lastFramesInput].forEach(control => { if (control) control.hidden = this.typeInput.value !== "video"; });
      if (this.referenceCountInput) this.referenceCountInput.disabled = this.referenceModeInput?.value !== "sequential";
    }

    async _handleClick(event) {
      const button = event.target?.closest?.("button[data-flow-queue-action]");
      if (!button || !this.container.contains(button)) return;
      const action = button.dataset.flowQueueAction;
      if (action === "pause") return this.pause();
      if (action === "resume") return this.resume();
      if (action === "stop") return this.stop();
      if (action === "clear") return this.clear();
      if (action === "refresh") return this.refresh();
      if (action === "remove") return this._send(MESSAGE.remove, { id: button.dataset.itemId, taskId: button.dataset.itemId });
      if (action === "manual-continue") return this._send(MESSAGE.manualContinue, { id: button.dataset.itemId, taskId: button.dataset.itemId });
      if (action === "manual-cancel") return this._send(MESSAGE.cancel, { id: button.dataset.itemId, taskId: button.dataset.itemId });
      if (action === "reorder") return this._send(MESSAGE.reorder, {
        id: button.dataset.itemId,
        taskId: button.dataset.itemId,
        fromIndex: Number(button.dataset.fromIndex),
        toIndex: Number(button.dataset.toIndex),
      });
      if (action === "retry") {
        const index = Number(button.dataset.index);
        const task = normalizeItems(this.snapshot)[index];
        if (!this._isKnownSafeRetry(task)) return;
        return this._send(MESSAGE.retry, { id: taskIdentity(task, index), taskId: taskIdentity(task, index) });
      }
      if (action === "retry-batch") return this._send(MESSAGE.retryBatch, { batchId: button.dataset.batchId });
    }

    _setBusy(value) {
      this.busy = value;
      this.panel?.querySelectorAll("button").forEach(button => { button.disabled = value || button.dataset.stateDisabled === "true"; });
      if (!value) this.render();
    }

    _showError(message) {
      if (!this.error) return;
      this.error.textContent = String(message || "Queue request failed.");
      this.error.hidden = false;
    }

    _clearError() {
      if (!this.error) return;
      this.error.textContent = "";
      this.error.hidden = true;
    }
  }

  root.FlowQueuePanel = FlowQueuePanel;
})(typeof globalThis !== "undefined" ? globalThis : self);
