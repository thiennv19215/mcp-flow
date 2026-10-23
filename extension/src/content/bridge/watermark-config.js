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

  // DL-04: logo variants ride alongside the legacy single mask. Each entry
  // is validated on its own — its mask must pass the same structural alpha
  // gate — and normalized (baseWidth/baseHeight collapse to the short side)
  // before forwarding; an invalid entry is dropped without affecting the
  // others or the legacy fields.
  const MAX_VARIANTS = 8;
  function forwardVariant(entry) {
    if (!entry || typeof entry !== "object") return undefined;
    if (!maskHasAlpha(entry.alpha_png_b64)) return undefined;
    const variant = { alpha_png_b64: entry.alpha_png_b64 };
    const id = typeof entry.id === "string" ? entry.id.trim()
      : (typeof entry.name === "string" ? entry.name.trim() : "");
    if (id) variant.id = id.slice(0, 64);
    let baseShortSide = Number(entry.baseShortSide);
    if (!Number.isFinite(baseShortSide) || baseShortSide <= 0) {
      const baseWidth = Number(entry.baseWidth);
      const baseHeight = Number(entry.baseHeight);
      baseShortSide = baseWidth > 0 && baseHeight > 0 ? Math.min(baseWidth, baseHeight) : NaN;
    }
    if (Number.isFinite(baseShortSide) && baseShortSide > 0) variant.baseShortSide = baseShortSide;
    const priority = Number(entry.priority);
    if (Number.isFinite(priority)) variant.priority = priority;
    return variant;
  }
  function forwardVariants(value) {
    if (!Array.isArray(value)) return undefined;
    const variants = [];
    for (const entry of value) {
      const variant = forwardVariant(entry);
      if (variant) variants.push(variant);
      if (variants.length >= MAX_VARIANTS) break;
    }
    return variants.length ? variants : undefined;
  }

  // DL-02: the video frame pipeline rides the same flowWatermark config
  // family. Its settings are validated per field before forwarding, like
  // the mask: a bad value forwards nothing for that field (the cleaner
  // falls back to its defaults) and never poisons the rest of the
  // config. The input cap can only ever be LOWERED locally — the
  // cleaner's 300 MB ceiling is hard, so a config value above it is
  // invalid here too. (Mask/threshold VALUE parity stays blocked, DL-B1;
  // this is mechanism only.)
  const VIDEO_MAX_INPUT_BYTES = 300 * 1024 * 1024;
  function forwardVideoSampleFrames(value) {
    const count = Number(value);
    return Number.isInteger(count) && count >= 1 && count <= 32 ? count : undefined;
  }
  function forwardVideoMaxInputBytes(value) {
    const bytes = Number(value);
    return Number.isFinite(bytes) && bytes > 0 && bytes <= VIDEO_MAX_INPUT_BYTES ? Math.floor(bytes) : undefined;
  }
  function forwardVideoBitrateRatio(value) {
    const ratio = Number(value);
    return Number.isFinite(ratio) && ratio >= 0.1 && ratio <= 2 ? ratio : undefined;
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
        variants: forwardVariants(config.variants),
        nccThreshold: config.nccThreshold,
        minNccAfter: config.minNccAfter,
        videoSampleFrames: forwardVideoSampleFrames(config.videoSampleFrames),
        videoMaxInputBytes: forwardVideoMaxInputBytes(config.videoMaxInputBytes),
        videoBitrateRatio: forwardVideoBitrateRatio(config.videoBitrateRatio),
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
