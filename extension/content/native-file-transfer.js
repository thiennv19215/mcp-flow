(() => {
  "use strict";

  const DEFAULTS = Object.freeze({ maxBytes: 200 * 1024 * 1024, chunkBytes: 256 * 1024, maxChunks: 8192 });
  const digestPattern = /^[a-f0-9]{64}$/i;
  const decodeBase64 = value => {
    if (typeof value !== "string" || value.length === 0) throw new Error("Empty or invalid base64 chunk");
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  };
  const hex = bytes => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  const sha256 = async bytes => hex(await crypto.subtle.digest("SHA-256", bytes));
  const validId = id => typeof id === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(id);

  class UploadAssembler {
    constructor(metadata, limits = {}) {
      this.transferId = metadata.transferId;
      this.name = String(metadata.name || "upload.bin").replace(/[\\/\0]/g, "_").slice(0, 240) || "upload.bin";
      this.type = typeof metadata.type === "string" && metadata.type.length <= 255 ? metadata.type : "application/octet-stream";
      this.size = metadata.size;
      this.sha256 = metadata.sha256;
      this.maxBytes = limits.maxBytes ?? DEFAULTS.maxBytes;
      this.chunkBytes = limits.chunkBytes ?? DEFAULTS.chunkBytes;
      this.maxChunks = limits.maxChunks ?? DEFAULTS.maxChunks;
      if (!validId(this.transferId)) throw new Error("Invalid transfer id");
      if (!Number.isSafeInteger(this.size) || this.size < 0 || this.size > this.maxBytes) throw new Error(`Upload exceeds the ${this.maxBytes}-byte limit`);
      if (!digestPattern.test(this.sha256 || "")) throw new Error("Invalid upload SHA-256");
      if (!Number.isSafeInteger(this.chunkBytes) || this.chunkBytes < 1 || this.chunkBytes > 1024 * 1024) throw new Error("Invalid upload chunk size");
      this.sha256 = this.sha256.toLowerCase();
      this.parts = [];
      this.nextIndex = 0;
      this.offset = 0;
      this.closed = false;
    }

    async accept(chunk) {
      if (this.closed) throw new Error("Upload transfer is closed");
      if (chunk?.transferId !== this.transferId || chunk.index !== this.nextIndex || chunk.offset !== this.offset) return this.fail("Out-of-order or duplicate upload chunk");
      if (this.nextIndex >= this.maxChunks) return this.fail("Upload exceeds chunk limit");
      if (typeof chunk.data !== "string" || chunk.data.length > Math.ceil(this.chunkBytes * 4 / 3) + 4) return this.fail("Upload chunk exceeds chunk limit");
      let bytes;
      try { bytes = decodeBase64(chunk.data); } catch { return this.fail("Invalid upload base64"); }
      if (bytes.byteLength > this.chunkBytes || this.offset + bytes.byteLength > this.size) return this.fail("Upload exceeds declared size");
      if (!digestPattern.test(chunk.chunkSha256 || "") || await sha256(bytes) !== chunk.chunkSha256.toLowerCase()) return this.fail("Upload chunk checksum mismatch");
      this.parts.push(bytes);
      this.offset += bytes.byteLength;
      this.nextIndex++;
      return { nextIndex: this.nextIndex, receivedBytes: this.offset };
    }

    async finish() {
      if (this.closed) throw new Error("Upload transfer is closed");
      if (this.offset !== this.size) return this.fail("Upload is incomplete");
      const blob = new Blob(this.parts, { type: this.type });
      this.parts = [];
      if (await sha256(await blob.arrayBuffer()) !== this.sha256) return this.fail("Upload checksum mismatch");
      this.closed = true;
      return typeof File === "function" ? new File([blob], this.name, { type: this.type, lastModified: Date.now() }) : blob;
    }

    fail(message) {
      this.abort();
      throw new Error(message);
    }

    abort() {
      this.closed = true;
      this.parts = [];
    }
  }

  // This assigns a synthesized File and dispatches normal DOM events. It does not create a trusted user gesture.
  function assignFileToInput(input, file) {
    if (!(input instanceof HTMLInputElement) || input.type !== "file") throw new Error("Target is not a file input");
    if (!(file instanceof Blob)) throw new Error("Upload value must be a Blob or File");
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    return { assigned: input.files?.length === 1, trustedGesture: false };
  }

  function bridgeCall(action, detail = {}, timeoutMs = 3000) {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error(`Flow upload bridge timed out (${action}).`)); }, timeoutMs);
      const onMessage = event => {
        if (event.source !== window || event.data?.source !== "flow-mcp-upload-v4-result" || event.data.requestId !== requestId) return;
        cleanup();
        if (event.data.success) resolve(event.data);
        else reject(new Error(event.data.error || `Flow upload bridge rejected ${action}.`));
      };
      function cleanup() { clearTimeout(timer); window.removeEventListener("message", onMessage); }
      window.addEventListener("message", onMessage);
      window.postMessage({ source: "flow-mcp-upload-v4", action, requestId, ...detail }, location.origin);
    });
  }

  async function selectFileThroughPicker(file, openPicker) {
    if (!(file instanceof Blob)) throw new Error("Upload value must be a Blob or File");
    if (typeof openPicker !== "function") throw new Error("Flow upload picker action is missing.");
    const owner = crypto.randomUUID();
    await bridgeCall("arm", { owner, file, timeoutMs: 10_000 }, 5000);
    try {
      const opened = await openPicker();
      if (opened === false) throw new Error("Flow's Upload menu item was detached before it could be clicked.");
      for (let attempt = 0; attempt < 25; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 200));
        const status = await bridgeCall("status", { owner }, 1500);
        if (status.fired) {
          if (status.fileName !== file.name || status.fileSize !== file.size || status.fileType !== file.type) {
            throw new Error("Flow's picker selected a different file than the staged upload.");
          }
          return { selected: true, method: status.fired, trustedGesture: false };
        }
      }
      throw new Error("Flow did not open its file input after the upload control was clicked.");
    } finally {
      await bridgeCall("cancel", { owner }).catch(() => {});
    }
  }

  async function assignFileToFlowInput(file, input) {
    if (!(file instanceof Blob) || !(input instanceof HTMLInputElement) || input.type !== "file") throw new Error("Invalid media file input.");
    const owner = crypto.randomUUID();
    const attribute = "data-flow-mcp-upload-target";
    input.setAttribute(attribute, owner);
    try {
      const selector = `input[type="file"][${attribute}="${owner}"]`;
      return await bridgeCall("assign", { owner, selector, file }, 5000);
    } finally { input.removeAttribute(attribute); }
  }

  async function dropFileToFlow(file) {
    if (!(file instanceof Blob)) throw new Error("Upload value must be a Blob or File");
    const owner = crypto.randomUUID();
    return bridgeCall("drop", { owner, file }, 5000);
  }

  globalThis.FlowNativeFileTransfer = Object.freeze({ version: 4, UploadAssembler, assignFileToInput, selectFileThroughPicker, assignFileToFlowInput, dropFileToFlow, defaults: DEFAULTS });
})();
