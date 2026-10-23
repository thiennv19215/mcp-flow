/* Isolated-world side of the optional watermark configuration bridge. */
(() => {
  "use strict";

  const source = "flow-mcp-watermark-v1";
  const post = options => {
    try { window.postMessage({ source, action: "configure", options: options || {} }, location.origin); } catch (_) {}
  };

  // Structural gate for a locally supplied mask: the value must be base64
  // (optionally a data: URL) decoding to a PNG whose IHDR carries an alpha
  // channel (color type 4/6) or that declares a tRNS chunk before IDAT.
  // Anything else can never drive the remover, so it is not forwarded to
  // the MAIN world and can never arm cleaning. (The same gate lives in
  // media-menu.js, which resolves per-download arms from the same config.)
  const MASK_MAX_B64_CHARS = 2_800_000;
  function maskHasAlpha(value) {
    if (typeof value !== "string") return false;
    let raw = value.trim();
    const dataUrl = /^data:image\/png;base64,([\s\S]+)$/i.exec(raw);
    if (dataUrl) raw = dataUrl[1].trim();
    if (!raw || raw.length > MASK_MAX_B64_CHARS || raw.length % 4 === 1 || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) return false;
    let binary;
    try { binary = atob(raw); } catch (_) { return false; }
    if (binary.length < 33) return false;
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    for (let index = 0; index < signature.length; index++) {
      if (binary.charCodeAt(index) !== signature[index]) return false;
    }
    let offset = 8;
    let sawIhdr = false;
    for (let chunk = 0; chunk < 64 && offset + 12 <= binary.length; chunk++) {
      const length = binary.charCodeAt(offset) * 0x1000000 +
        (binary.charCodeAt(offset + 1) << 16) + (binary.charCodeAt(offset + 2) << 8) + binary.charCodeAt(offset + 3);
      const type = binary.slice(offset + 4, offset + 8);
      if (type === "IHDR") {
        if (length < 10) return false;
        sawIhdr = true;
        const colorType = binary.charCodeAt(offset + 17);
        if (colorType === 4 || colorType === 6) return true;
      } else if (type === "tRNS") {
        return sawIhdr;
      } else if (type === "IDAT") {
        break;
      }
      if (length < 0 || offset + 12 + length > binary.length) break;
      offset += 12 + length;
    }
    return false;
  }

  async function load() {
    try {
      const stored = await chrome.storage.local.get(["flowWatermark", "watermark"]);
      const config = stored.flowWatermark || stored.watermark || {};
      post({
        enabled: config.enabled === true,
        image: config.image !== false,
        video: config.video !== false,
        alpha_png_b64: maskHasAlpha(config.alpha_png_b64) ? config.alpha_png_b64 : undefined,
        nccThreshold: config.nccThreshold,
        minNccAfter: config.minNccAfter,
      });
    } catch (_) {}
  }

  if (typeof chrome !== "undefined" && chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || (!changes.flowWatermark && !changes.watermark)) return;
      void load();
    });
  }
  if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener(message => {
      if (message?.type === "flow-watermark:configure") post(message.options || {});
    });
  }
  void load();
})();
