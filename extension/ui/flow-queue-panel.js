(function attachFlowQueuePanel(root) {
  "use strict";

  const MESSAGE = Object.freeze({
    get: "flow-queue:get",
    add: "flow-queue:add",
    pause: "flow-queue:pause",
    resume: "flow-queue:resume",
    stop: "flow-queue:stop",
    clear: "flow-queue:clear",
    remove: "flow-queue:remove",
    reorder: "flow-queue:reorder",
    retry: "flow-queue:retry",
  });

  const RETRYABLE_OPERATIONS = new Set([
    "flow.generation.submit",
    "flow.edit.run",
    "flow.continue.run",
    "flow.agent.batch",
    "flow.character.create",
    "flow.character.edit",
  ]);

  const STYLE_TEXT = `
    .flow-queue-panel{font:13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--text-primary,#f8fafc);display:flex;flex-direction:column;gap:10px;min-width:0}
    .flow-queue-panel *{box-sizing:border-box}
    .flow-queue-panel__heading,.flow-queue-panel__toolbar,.flow-queue-panel__item-head,.flow-queue-panel__item-actions{display:flex;align-items:center;gap:8px}
    .flow-queue-panel__heading,.flow-queue-panel__item-head{justify-content:space-between}
    .flow-queue-panel__title{font-weight:700;font-size:14px}
    .flow-queue-panel__summary,.flow-queue-panel__muted{color:var(--text-muted,#8b8b92);font-size:12px}
    .flow-queue-panel__toolbar{flex-wrap:wrap}
    .flow-queue-panel button{font:inherit;color:inherit;background:var(--card,#292929);border:1px solid var(--border,rgba(255,255,255,.12));border-radius:6px;padding:5px 9px;cursor:pointer}
    .flow-queue-panel button:hover:not(:disabled){border-color:var(--primary,#ccff00)}
    .flow-queue-panel button:disabled{opacity:.45;cursor:default}
    .flow-queue-panel__add{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px}
    .flow-queue-panel__input{min-width:0;min-height:62px;resize:vertical;padding:8px;border:1px solid var(--border,rgba(255,255,255,.12));border-radius:6px;background:var(--card,#292929);color:inherit;font:inherit}
    .flow-queue-panel__items{display:flex;flex-direction:column;gap:7px;max-height:42vh;overflow:auto}
    .flow-queue-panel__item{padding:9px;border:1px solid var(--border,rgba(255,255,255,.1));border-radius:7px;background:var(--card,#292929);min-width:0}
    .flow-queue-panel__label{font-weight:600;overflow-wrap:anywhere}
    .flow-queue-panel__status{white-space:nowrap;color:var(--text-muted,#8b8b92);font-size:11px}
    .flow-queue-panel__detail{margin-top:4px;color:var(--text-muted,#8b8b92);white-space:pre-wrap;overflow-wrap:anywhere}
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
      const panel = makeElement("section", "flow-queue-panel");
      panel.setAttribute("aria-label", "Hàng đợi tác vụ Flow");

      const heading = makeElement("div", "flow-queue-panel__heading");
      heading.append(makeElement("span", "flow-queue-panel__title", "Hàng đợi Flow"));
      this.summary = makeElement("span", "flow-queue-panel__summary", "Đang tải…");
      heading.append(this.summary);

      const toolbar = makeElement("div", "flow-queue-panel__toolbar");
      toolbar.append(
        this._button("Tạm dừng", "pause"),
        this._button("Chạy tiếp", "resume"),
        this._button("Dừng", "stop"),
        this._button("Xóa", "clear"),
        this._button("Làm mới", "refresh"),
      );

      const form = makeElement("form", "flow-queue-panel__add");
      const input = makeElement("textarea", "flow-queue-panel__input");
      input.name = "prompt";
      input.required = true;
      input.maxLength = 12000;
      input.setAttribute("aria-label", "Prompt thêm vào hàng đợi Flow");
      input.placeholder = "Nhập prompt để thêm vào hàng đợi Flow…";
      const type = makeElement("select", "flow-queue-panel__input");
      type.name = "type";
      type.setAttribute("aria-label", "Loại nội dung Flow");
      for (const [value, label] of [
        ["image", "Tạo ảnh"], ["video", "Tạo video"], ["edit", "Chỉnh sửa video"],
        ["continue", "Nối tiếp video"], ["agent", "Flow Agent batch"],
      ]) {
        const option = makeElement("option", "", label);
        option.value = value;
        type.append(option);
      }
      this.typeInput = type;
      this.assetInput = makeElement("input", "flow-queue-panel__input");
      this.assetInput.name = "asset";
      this.assetInput.type = "text";
      this.assetInput.placeholder = "Tên video có sẵn trong project (cho edit/continue)";
      this.assetInput.setAttribute("aria-label", "Tên video trong Flow");
      const ratio = makeElement("select", "flow-queue-panel__input");
      ratio.name = "aspect_ratio";
      ratio.setAttribute("aria-label", "Tỷ lệ khung hình");
      for (const [value, label] of [["", "Tự động"], ["16:9", "16:9"], ["9:16", "9:16"], ["1:1", "1:1"]]) {
        const option = makeElement("option", "", label);
        option.value = value;
        ratio.append(option);
      }
      const submit = makeElement("button", "", "Thêm tác vụ");
      submit.type = "submit";
      form.append(input, type, this.assetInput, ratio, submit);

      this.error = makeElement("div", "flow-queue-panel__error");
      this.error.setAttribute("role", "alert");
      this.error.hidden = true;
      this.itemsElement = makeElement("div", "flow-queue-panel__items");
      this.itemsElement.setAttribute("aria-live", "polite");

      panel.append(heading, toolbar, form, this.error, this.itemsElement);
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

    async _send(type, payload = {}) {
      if (!this.runtime?.sendMessage) {
        this._showError("Không thể kết nối với tiện ích Flow.");
        return { ok: false, error: "RUNTIME_UNAVAILABLE" };
      }
      this._setBusy(true);
      this._clearError();
      try {
        const response = await this.runtime.sendMessage({ type, ...payload });
        if (response?.ok === false || response?.error) {
          throw new Error(String(response.error?.message || response.error || response.message || "Không thể cập nhật hàng đợi Flow."));
        }
        if (type === MESSAGE.get) this._acceptSnapshot(response);
        else if (response?.items || response?.queue || response?.tasks || response?.snapshot) this._acceptSnapshot(response.snapshot || response);
        else void this.refresh();
        return response;
      } catch (error) {
        this._showError(error?.message || "Không thể cập nhật hàng đợi Flow.");
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
      const active = Number(this.snapshot.activeCount ?? this.snapshot.active ?? this.snapshot.state?.activeCount ?? 0);
      const counts = this.snapshot.counts || {};
      const completed = Number(counts.completed ?? this.snapshot.completed ?? items.filter(item => this._status(item) === "completed").length);
      this.summary.textContent = `${items.length} tác vụ · ${completed} hoàn tất${running ? (paused ? " · đã tạm dừng" : ` · đang chạy${active ? ` (${active})` : ""}`) : ""}`;
      this.itemsElement.replaceChildren();
      if (!items.length) {
        this.itemsElement.append(makeElement("div", "flow-queue-panel__empty", "Hàng đợi đang trống."));
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
      const sourceBadge = makeElement("span", "flow-queue-panel__badge", source === "mcp" ? "🤖 AI / MCP" : "👤 Thủ công");
      sourceBadge.style.cssText = source === "mcp"
        ? "font-size:10px;padding:2px 6px;border-radius:4px;background:rgba(204,255,0,0.15);color:var(--primary,#ccff00);margin-right:6px;border:1px solid rgba(204,255,0,0.3);font-weight:600"
        : "font-size:10px;padding:2px 6px;border-radius:4px;background:rgba(255,255,255,0.08);color:var(--text-muted,#8b8b92);margin-right:6px;border:1px solid rgba(255,255,255,0.15);font-weight:600";
      const labelContainer = makeElement("span", "flow-queue-panel__label-container");
      labelContainer.style.cssText = "display:flex;align-items:center;min-width:0;overflow:hidden";
      labelContainer.append(sourceBadge, makeElement("span", "flow-queue-panel__label", label));
      head.append(labelContainer, makeElement("span", "flow-queue-panel__status", this._status(task)));
      item.append(head);
      const detail = task?.progress?.message ?? task?.progressText ?? task?.message ?? task?.error ?? "";
      if (detail) item.append(makeElement("div", "flow-queue-panel__detail", detail));
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
      up.setAttribute("aria-label", `Move task ${index + 1} up`); up.dataset.stateDisabled = String(index === 0); up.disabled = index === 0;
      const down = this._button("↓", "reorder");
      down.dataset.itemId = id; down.dataset.fromIndex = String(index); down.dataset.toIndex = String(Math.min(count - 1, index + 1));
      down.setAttribute("aria-label", `Move task ${index + 1} down`); down.dataset.stateDisabled = String(index === count - 1); down.disabled = index === count - 1;
      actions.append(up, down);
      if (this._isKnownSafeRetry(task)) {
        const retry = this._button("Retry", "retry");
        retry.dataset.itemId = id;
        retry.dataset.index = String(index);
        actions.append(retry);
      }
      const remove = this._button("Xóa", "remove");
      remove.dataset.itemId = id;
      actions.append(remove);
      item.append(actions);
      return item;
    }

    _status(task) {
      const status = String(task?.status ?? task?.state ?? task?.phase ?? "pending").toLowerCase();
      return ({ pending: "Đang chờ", running: "Đang chạy", completed: "Hoàn tất", failed: "Thất bại", cancelled: "Đã hủy" })[status] || status.replaceAll("_", " ");
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
      const aspectRatio = String(form.elements.namedItem("aspect_ratio")?.value || "");
      const asset = String(form.elements.namedItem("asset")?.value || "").trim();
      let operation = "flow.generation.submit";
      let payload = { type, prompt, aspect_ratio: aspectRatio, variants: 1, attachments: [], video_settings: {} };
      let label = prompt.slice(0, 96);
      if (type === "edit" || type === "continue") {
        if (!asset) { this._showError("Nhập tên video cần chỉnh sửa hoặc nối tiếp."); return; }
        operation = type === "edit" ? "flow.edit.run" : "flow.continue.run";
        payload = { params: type === "edit" ? { edit_asset: asset, prompt } : { continue_from: asset, prompt, continue_mode: "exact", aspect_ratio: aspectRatio || "16:9" } };
        label = `${type === "edit" ? "Sửa" : "Nối tiếp"}: ${asset}`;
      } else if (type === "agent") {
        const scenes = prompt.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        if (!scenes.length) { this._showError("Nhập ít nhất một cảnh, mỗi cảnh trên một dòng."); return; }
        operation = "flow.agent.batch";
        payload = { params: { agent_scenes: scenes, aspect_ratio: aspectRatio || "16:9" } };
        label = `Agent: ${scenes.length} cảnh`;
      } else {
        payload.type = type;
      }
      const response = await this.add({ operation, payload, label });
      if (response?.ok !== false && !response?.error && input) input.value = "";
    }

    _handleChange(event) {
      if (event.target === this.typeInput) this._syncFields();
    }

    _syncFields() {
      if (!this.typeInput || !this.assetInput) return;
      const needsAsset = ["edit", "continue"].includes(this.typeInput.value);
      this.assetInput.hidden = !needsAsset;
      this.assetInput.required = needsAsset;
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
