(() => {
  "use strict";

  if (window.__flowMcpUploadBridge?.version === 8) return;

  // Keep this protocol separate from prior versions: already-open Flow tabs may still have
  // the old listener installed, and both versions must not answer one request.
  const source = "flow-mcp-upload-v8";
  let activeTrap = null;
  let fired = null;

  function reply(requestId, result) {
    window.postMessage({ source: `${source}-result`, requestId, ...result }, location.origin);
  }

  function restore(trap = activeTrap) {
    if (!trap) return;
    if (HTMLInputElement.prototype.click === trap.patchedInputClick) HTMLInputElement.prototype.click = trap.originalInputClick;
    if (trap.originalPicker && window.showOpenFilePicker === trap.patchedPicker) window.showOpenFilePicker = trap.originalPicker;
    document.removeEventListener("click", trap.captureFileInputClick, true);
    clearTimeout(trap.expiryTimer);
    if (activeTrap === trap) activeTrap = null;
  }

  function inject(input, file, owner, method) {
    if (!(input instanceof HTMLInputElement) || input.type !== "file" || !(file instanceof File)) return false;
    const transfer = new DataTransfer();
    transfer.items.add(file);
    try {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "files")?.set;
      if (setter) setter.call(input, transfer.files);
      else input.files = transfer.files;
    } catch {
      try { input.files = transfer.files; } catch { return false; }
    }
    const selected = input.files?.length === 1 && input.files[0].name === file.name &&
      input.files[0].size === file.size;
    if (!selected) return false;
    fired = { owner, method, name: file.name, size: file.size, type: file.type, at: Date.now() };
    const trap = activeTrap;
    restore(trap);
    setTimeout(() => {
      input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    }, 0);
    return true;
  }

  function arm(file, owner, timeoutMs) {
    if (!(file instanceof File) || typeof owner !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(owner)) {
      throw new Error("Invalid staged file or upload owner.");
    }
    restore();
    fired = null;
    const trap = {
      owner,
      file,
      originalInputClick: HTMLInputElement.prototype.click,
      originalPicker: typeof window.showOpenFilePicker === "function" ? window.showOpenFilePicker : null,
      expiryTimer: 0,
      patchedInputClick: null,
      patchedPicker: null,
      captureFileInputClick: null,
    };

    trap.captureFileInputClick = event => {
      const path = typeof event.composedPath === "function" ? event.composedPath() : [];
      let input = path.find(node => node instanceof HTMLInputElement && node.type === "file") || null;
      if (!input && event.target instanceof HTMLLabelElement) {
        const control = event.target.control;
        if (control instanceof HTMLInputElement && control.type === "file") input = control;
      }
      if (!input || fired?.owner === owner) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      event.stopPropagation();
      if (!inject(input, file, owner, "input-capture")) {
        console.warn("[Flow MCP upload] Could not assign staged media from the file-picker click.");
      }
    };
    document.addEventListener("click", trap.captureFileInputClick, true);

    // Flow often opens its picker by calling input.click() in a React handler.
    // A click-event-only trap misses that path, so intercept the method as TobyFlow does.
    trap.patchedInputClick = function flowMcpTrappedFilePickerClick() {
      if (this instanceof HTMLInputElement && this.type === "file" && activeTrap === trap) {
        if (!inject(this, file, owner, "input.click")) console.warn("[Flow MCP upload] Could not assign staged media from input.click().");
        return;
      }
      return trap.originalInputClick.apply(this, arguments);
    };
    HTMLInputElement.prototype.click = trap.patchedInputClick;

    if (trap.originalPicker) {
      const fakeHandle = {
        kind: "file",
        name: file.name,
        getFile: () => Promise.resolve(file),
        isSameEntry: () => Promise.resolve(false),
        queryPermission: () => Promise.resolve("granted"),
        requestPermission: () => Promise.resolve("granted"),
      };
      trap.patchedPicker = function flowMcpTrappedOpenFilePicker() {
        if (activeTrap === trap) {
          fired = { owner, method: "showOpenFilePicker", name: file.name, size: file.size, type: file.type, at: Date.now() };
          restore(trap);
          return Promise.resolve([fakeHandle]);
        }
        return trap.originalPicker.apply(this, arguments);
      };
      window.showOpenFilePicker = trap.patchedPicker;
    }

    activeTrap = trap;
    trap.expiryTimer = setTimeout(() => restore(trap), timeoutMs);
    return { armed: true, expiresAt: Date.now() + timeoutMs, hasFileSystemPicker: Boolean(trap.originalPicker) };
  }

  window.addEventListener("message", event => {
    if (event.source !== window || event.data?.source !== source) return;
    const { action, requestId } = event.data;
    if (action === "arm") {
      try {
        reply(requestId, { success: true, ...arm(event.data.file, event.data.owner, Math.min(30_000, Math.max(1000, Number(event.data.timeoutMs) || 10_000))) });
      } catch (error) {
        reply(requestId, { success: false, error: String(error?.message || error) });
      }
    } else if (action === "assign") {
      const owner = event.data.owner;
      const selector = typeof event.data.selector === "string" ? event.data.selector : "";
      const input = selector ? document.querySelector(selector) : null;
      const success = inject(input, event.data.file, owner, "input-assign");
      reply(requestId, success ? { success: true, fired: "input-assign" } : { success: false, error: "Could not assign media to Flow's file input." });
    } else if (action === "drop") {
      const file = event.data.file;
      const owner = event.data.owner;
      if (!(file instanceof File) || typeof owner !== "string") { reply(requestId, { success: false, error: "Invalid media drop payload." }); return; }
      const gridTile = document.querySelector("flow-grid-tile-container");
      const target = gridTile?.parentElement ||
        document.querySelector("flow-view, flow-scroller, [data-testid='virtuoso-item-list'], [data-testid='virtuoso-scroller'], main") ||
        document.body;
      const rect = target.getBoundingClientRect?.();
      const init = { bubbles: true, cancelable: true, composed: true, dataTransfer: new DataTransfer(), clientX: rect ? rect.left + rect.width / 2 : innerWidth / 2, clientY: rect ? rect.top + rect.height / 2 : innerHeight / 2 };
      init.dataTransfer.items.add(file);
      for (const type of ["dragenter", "dragover", "drop"]) {
        let drag;
        try { drag = new DragEvent(type, init); } catch { drag = new Event(type, { bubbles: true, cancelable: true, composed: true }); }
        if (!drag.dataTransfer) Object.defineProperty(drag, "dataTransfer", { value: init.dataTransfer });
        target.dispatchEvent(drag);
      }
      fired = { owner, method: "drop", name: file.name, size: file.size, type: file.type, at: Date.now() };
      reply(requestId, { success: true, fired: "drop" });
    } else if (action === "activateSubmit") {
      const token = String(event.data.submitToken || "");
      const target = token ? document.querySelector(`[data-flow-submit-token="${token}"]`) : null;
      if (!target) {
        reply(requestId, { success: false, error: "TARGET_NOT_FOUND" });
        return;
      }
      let invoked = 0;
      let ngFound = false;
      try {
        if (window.ng && typeof window.ng.getListeners === "function") {
          ngFound = true;
          for (const entry of window.ng.getListeners(target) || []) {
            if ((entry.name || entry.eventName) === "click" && typeof entry.callback === "function") {
              const nativeEvent = new MouseEvent("click", { bubbles: true, cancelable: true, composed: true, view: window, button: 0 });
              const proxyEvent = new Proxy(nativeEvent, {
                get: (source, key) => {
                  if (key === "isTrusted") return true;
                  if (key === "target") return target;
                  if (key === "currentTarget") return target;
                  if (key === "composedPath") return () => [target, target.parentElement].filter(Boolean);
                  const val = Reflect.get(source, key, source);
                  return typeof val === "function" ? val.bind(source) : val;
                }
              });
              entry.callback.call(target, proxyEvent);
              invoked++;
            }
          }
        }
      } catch (err) {
        console.warn("[FlowMainBridge] ng listener invocation error:", err);
      }
      target.click();
      reply(requestId, { success: true, invoked, ngFound });
    } else if (action === "status") {
      const state = fired?.owner === event.data.owner ? fired : null;
      reply(requestId, { success: true, fired: state?.method || null, fileName: state?.name || null, fileSize: state?.size || null, fileType: state?.type || null });
    } else if (action === "cancel") {
      if (activeTrap?.owner === event.data.owner) restore(activeTrap);
      if (fired?.owner === event.data.owner) fired = null;
      reply(requestId, { success: true });
    }
  });

  window.__flowMcpUploadBridge = { version: 8 };
})();
