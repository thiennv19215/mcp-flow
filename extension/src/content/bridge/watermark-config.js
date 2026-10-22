/* Isolated-world side of the optional watermark configuration bridge. */
(() => {
  "use strict";

  const source = "flow-mcp-watermark-v1";
  const post = options => {
    try { window.postMessage({ source, action: "configure", options: options || {} }, location.origin); } catch (_) {}
  };

  async function load() {
    try {
      const stored = await chrome.storage.local.get(["flowWatermark", "watermark"]);
      const config = stored.flowWatermark || stored.watermark || {};
      post({
        enabled: config.enabled === true,
        alpha_png_b64: typeof config.alpha_png_b64 === "string" ? config.alpha_png_b64 : undefined,
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
