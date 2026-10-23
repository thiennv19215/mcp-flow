/*
 * MAIN-world media interceptor.
 *
 * The Flow page still owns the actual download gesture. This bridge only
 * claims an explicitly armed Flow media download, processes image responses
 * through WatermarkRemover, and returns a clean blob to the browser. Ordinary
 * page fetches and videos are left untouched.
 */
(() => {
  "use strict";

  const source = "flow-mcp-watermark-v1";
  if (window.__flowMcpMediaInterceptor?.version >= 1) return;

  const nativeFetch = window.fetch?.bind(window);
  // The exact function being wrapped (pre-bind), so the wrapper below can
  // identify it: the correlation observer loads before this script and
  // verifies its fetch hook by identity.
  const wrappedFetch = typeof window.fetch === "function" ? window.fetch : null;
  const state = {
    version: 1,
    enabled: false,
    mask: null,
    maskB64: null,
    options: {},
    armed: null,
    processing: false,
  };

  const isFlowMediaUrl = value => {
    try {
      const url = new URL(String(value || ""), location.href);
      return url.origin === location.origin || /(?:googleusercontent|usercontent\.goog|storage\.googleapis)\./i.test(url.hostname);
    } catch (_) { return false; }
  };

  const requestUrl = input => typeof input === "string" ? input : input?.url || "";
  const resultEvent = detail => window.dispatchEvent(new CustomEvent("TOBY_FLOW_WATERMARK_RESULT", { detail }));

  function configure(options = {}) {
    const enabled = options.enabled !== undefined ? options.enabled === true : state.enabled;
    state.enabled = enabled;
    if (options.mask !== undefined) state.mask = options.mask;
    if (options.alpha_png_b64 !== undefined) state.maskB64 = options.alpha_png_b64;
    state.options = { ...state.options, ...options };
    window.__tobyFlowWatermarkState = { enabled: state.enabled, maskConfigured: Boolean(state.mask || state.maskB64), armed: Boolean(state.armed) };
    return { enabled: state.enabled, maskConfigured: Boolean(state.mask || state.maskB64) };
  }

  function arm(meta = {}) {
    state.armed = { ...meta, expiresAt: Date.now() + Math.min(120_000, Math.max(5_000, Number(meta.timeoutMs) || 45_000)) };
    state.enabled = meta.enabled !== false;
    configure({ enabled: state.enabled, ...(meta.mask !== undefined ? { mask: meta.mask } : {}) });
    return { armed: true, expiresAt: state.armed.expiresAt };
  }

  function shouldProcess(input, response, init) {
    if (!nativeFetch || !state.enabled || (!state.mask && !state.maskB64) || state.processing) return false;
    if (state.armed && state.armed.expiresAt <= Date.now()) { state.armed = null; configure({}); return false; }
    const url = requestUrl(input);
    if (!isFlowMediaUrl(url) || !/^image\//i.test(response?.headers?.get?.("content-type") || "")) return false;
    const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
    return Boolean(state.armed || headers.get("x-tobyflow-watermark-removal") === "1" || new URL(url, location.href).searchParams.get("tobyflow_watermark") === "1");
  }

  async function cleanResponse(response, meta = {}) {
    if (!shouldProcess(meta.input, response, meta.init)) return response;
    state.processing = true;
    try {
      const original = await response.blob();
      if (!state.mask && state.maskB64) state.mask = await window.WatermarkRemover.maskFromAlphaPng(state.maskB64);
      if (!state.mask) return response;
      const remover = new window.WatermarkRemover({ mask: state.mask, ...state.options });
      const result = await remover.processBlob(original);
      if (!result.changed) return new Response(result.blob, { status: response.status, statusText: response.statusText, headers: response.headers });
      resultEvent({ ok: true, changed: true, kind: meta.kind || "image", nccBefore: result.nccBefore, nccAfter: result.nccAfter });
      return new Response(result.blob, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) {
      resultEvent({ ok: false, error: String(error?.message || error) });
      return response;
    } finally {
      state.processing = false;
      if (state.armed) { state.armed = null; configure({}); }
    }
  }

  if (nativeFetch) {
    const watermarkFetch = async function flowMcpWatermarkFetch(input, init) {
      const response = await nativeFetch(input, init);
      return cleanResponse(response, { input, init, kind: state.armed?.kind });
    };
    // Tag the wrapper with the function it wrapped. The correlation
    // observer's identity check would otherwise report its fetch hook as
    // dead forever (this script loads after it), which blocks every strict
    // generation from arming on a fresh page load.
    watermarkFetch.__flowMcpWrappedFetch = wrappedFetch;
    window.fetch = watermarkFetch;
  }

  document.addEventListener("click", event => {
    const anchor = event.target?.closest?.("a[download]");
    if (!anchor || !state.enabled || (!state.mask && !state.maskB64) || !isFlowMediaUrl(anchor.href)) return;
    if (state.armed?.expiresAt <= Date.now()) { state.armed = null; configure({}); return; }
    if (!state.armed && anchor.dataset.tobyflowWatermark !== "1") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const href = anchor.href;
    const name = anchor.download || "flow-media";
    void (async () => {
      try {
        const response = await nativeFetch(href, { headers: { "x-tobyflow-watermark-removal": "1" } });
        const cleaned = await cleanResponse(response, { input: href, init: { headers: { "x-tobyflow-watermark-removal": "1" } }, kind: state.armed?.kind });
        const blobUrl = URL.createObjectURL(await cleaned.blob());
        const link = document.createElement("a");
        link.href = blobUrl;
        link.download = name;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(blobUrl), 10_000);
      } catch (error) {
        resultEvent({ ok: false, error: String(error?.message || error) });
        anchor.click();
      }
    })();
  }, true);

  window.addEventListener("message", event => {
    if (event.source !== window || event.data?.source !== source) return;
    const action = event.data.action;
    if (action === "configure") {
      window.postMessage({ source: `${source}-result`, requestId: event.data.requestId, ok: true, ...configure(event.data.options || {}) }, location.origin);
    } else if (action === "arm") {
      window.postMessage({ source: `${source}-result`, requestId: event.data.requestId, ok: true, ...arm(event.data.options || {}) }, location.origin);
    }
  });

  window.__flowMcpMediaInterceptor = Object.freeze({ version: 1, configure, arm, state });
  configure({});
})();
