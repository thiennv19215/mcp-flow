(() => {
  "use strict";

  if (window.__flowMcpUploadBridge?.version === 2) return;

  const source = "flow-mcp-upload";
  let armed = null;
  let fired = null;
  let expiryTimer = 0;

  function reply(requestId, result) {
    window.postMessage({ source: `${source}-result`, requestId, ...result }, location.origin);
  }

  function restore() {
    armed = null;
    clearTimeout(expiryTimer);
    expiryTimer = 0;
  }

  function inject(input) {
    if (!armed || !(input instanceof HTMLInputElement) || input.type !== "file") return false;
    const current = armed;
    const transfer = new DataTransfer();
    transfer.items.add(current.file);
    try {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "files")?.set;
      if (setter) setter.call(input, transfer.files);
      else input.files = transfer.files;
    } catch {
      try { input.files = transfer.files; } catch { return false; }
    }
    const selected = input.files?.length === 1 && input.files[0].name === current.file.name &&
      input.files[0].size === current.file.size && input.files[0].type === current.file.type;
    if (!selected) return false;

    fired = { owner: current.owner, method: "input-click", name: current.file.name, at: Date.now() };
    restore();
    setTimeout(() => {
      input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    }, 0);
    return true;
  }

  function assign(input, file, owner) {
    if (!(file instanceof File) || !(input instanceof HTMLInputElement) || input.type !== "file") return false;
    const transfer = new DataTransfer();
    transfer.items.add(file);
    try {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "files")?.set;
      if (setter) setter.call(input, transfer.files);
      else input.files = transfer.files;
    } catch { try { input.files = transfer.files; } catch { return false; } }
    const selected = input.files?.length === 1 && input.files[0].name === file.name && input.files[0].size === file.size;
    if (!selected) return false;
    fired = { owner, method: "input-assign", name: file.name, at: Date.now() };
    setTimeout(() => {
      input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    }, 0);
    return true;
  }

  window.addEventListener("click", event => {
    if (!armed || !(event.target instanceof HTMLInputElement) || event.target.type !== "file") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    event.stopPropagation();
    if (!inject(event.target)) console.warn("[Flow MCP upload] Could not assign the staged file to Flow's picker.");
  }, true);

  window.addEventListener("message", event => {
    if (event.source !== window || event.data?.source !== source) return;
    const { action, requestId } = event.data;
    if (action === "assign") {
      const file = event.data.file;
      const owner = event.data.owner;
      const selector = typeof event.data.selector === "string" ? event.data.selector : "";
      const input = selector ? document.querySelector(selector) : null;
      const success = assign(input, file, owner);
      reply(requestId, success ? { success: true, fired: "input-assign" } : { success: false, error: "Could not assign media to Flow's file input." });
    } else if (action === "drop") {
      const file = event.data.file;
      const owner = event.data.owner;
      if (!(file instanceof File) || typeof owner !== "string") { reply(requestId, { success: false, error: "Invalid media drop payload." }); return; }
      const target = document.querySelector("flow-grid-tile-container") || document.querySelector("main") || document.body;
      const rect = target.getBoundingClientRect?.();
      const init = { bubbles: true, cancelable: true, composed: true, dataTransfer: new DataTransfer(), clientX: rect ? rect.left + rect.width / 2 : innerWidth / 2, clientY: rect ? rect.top + rect.height / 2 : innerHeight / 2 };
      init.dataTransfer.items.add(file);
      for (const type of ["dragenter", "dragover", "drop"]) {
        let drag;
        try { drag = new DragEvent(type, init); } catch { drag = new Event(type, { bubbles: true, cancelable: true, composed: true }); }
        if (!drag.dataTransfer) Object.defineProperty(drag, "dataTransfer", { value: init.dataTransfer });
        target.dispatchEvent(drag);
      }
      fired = { owner, method: "drop", name: file.name, at: Date.now() };
      reply(requestId, { success: true, fired: "drop" });
    } else if (action === "arm") {
      const file = event.data.file;
      const owner = event.data.owner;
      if (!(file instanceof File) || typeof owner !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(owner)) {
        reply(requestId, { success: false, error: "Invalid staged file or upload owner." });
        return;
      }
      restore();
      fired = null;
      armed = { file, owner };
      expiryTimer = setTimeout(() => { if (armed?.owner === owner) restore(); }, 15_000);
      reply(requestId, { success: true, armed: true, expiresAt: Date.now() + 15_000 });
    } else if (action === "status") {
      reply(requestId, { success: true, fired: fired?.owner === event.data.owner ? fired.method : null });
    } else if (action === "cancel") {
      if (armed?.owner === event.data.owner) restore();
      if (fired?.owner === event.data.owner) fired = null;
      reply(requestId, { success: true });
    }
  });

  window.__flowMcpUploadBridge = { version: 2 };
})();
