/*
 * MAIN-world media interceptor.
 *
 * The Flow page still owns the actual download gesture. This bridge only
 * claims downloads that were explicitly armed from the isolated world,
 * processes image responses through WatermarkRemover, and returns a clean
 * blob to the browser. Ordinary page fetches and videos are left untouched.
 *
 * DL-03: the arm is no longer a one-shot global slot (any unrelated image
 * fetch could consume it). Each arm registers a per-download CONTEXT keyed
 * by an operation id: {operationId, mode: "clean"|"original", kind,
 * canonical URL (when known), expiry}. A fetch is cleaned only when its
 * canonical URL matches an armed clean context; an original context
 * guarantees its own download is never cleaned, even while another clean
 * context is armed. Contexts are single-use and expire. Every engaged
 * context reports its outcome (cleaned / original + reason / failed) on
 * the result event, attributed by operation id.
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
  const MAX_CONTEXTS = 12;
  const state = {
    version: 1,
    enabled: false,
    mask: null,
    maskB64: null,
    options: {},
    contexts: [],
    processing: false,
  };

  const isFlowMediaUrl = value => {
    try {
      const url = new URL(String(value || ""), location.href);
      return url.origin === location.origin || /(?:googleusercontent|usercontent\.goog|storage\.googleapis)\./i.test(url.hostname);
    } catch (_) { return false; }
  };

  // Canonical media identity: size suffixes ("=s2048", "=w1280-h720") and
  // signature query params are display/delivery details, not identity —
  // the arm (taken from the tile) and the actual download fetch routinely
  // differ in both while naming the same media.
  const SIGNATURE_PARAMS = new Set(["sig", "signature", "x-goog-signature"]);
  const canonicalMediaUrl = value => {
    try {
      const url = new URL(String(value || ""), location.href);
      url.pathname = url.pathname.replace(/=[^/]*$/, "");
      for (const key of [...url.searchParams.keys()]) {
        if (SIGNATURE_PARAMS.has(key.toLowerCase())) url.searchParams.delete(key);
      }
      url.searchParams.sort();
      url.hash = "";
      return url.toString();
    } catch (_) { return ""; }
  };

  const requestUrl = input => typeof input === "string" ? input : input?.url || "";
  const resultEvent = detail => window.dispatchEvent(new CustomEvent("TOBY_FLOW_WATERMARK_RESULT", { detail }));

  function syncPublicState() {
    window.__tobyFlowWatermarkState = {
      enabled: state.enabled,
      maskConfigured: Boolean(state.mask || state.maskB64),
      armed: state.contexts.length > 0,
    };
  }

  function configure(options = {}) {
    const enabled = options.enabled !== undefined ? options.enabled === true : state.enabled;
    state.enabled = enabled;
    if (options.mask !== undefined) state.mask = options.mask;
    if (options.alpha_png_b64 !== undefined) state.maskB64 = options.alpha_png_b64;
    state.options = { ...state.options, ...options };
    syncPublicState();
    return { enabled: state.enabled, maskConfigured: Boolean(state.mask || state.maskB64) };
  }

  function pruneContexts(now = Date.now()) {
    state.contexts = state.contexts.filter(context => context.expiresAt > now);
    while (state.contexts.length > MAX_CONTEXTS) state.contexts.shift();
  }

  function consumeContext(context) {
    if (!context) return;
    state.contexts = state.contexts.filter(candidate => candidate !== context);
    syncPublicState();
  }

  function arm(meta = {}) {
    const now = Date.now();
    pruneContexts(now);
    const context = {
      operationId: typeof meta.operationId === "string" && meta.operationId
        ? meta.operationId
        : `op-${now.toString(36)}-${Math.random().toString(16).slice(2, 10)}`,
      mode: meta.mode === "original" || meta.enabled === false ? "original" : "clean",
      kind: typeof meta.kind === "string" ? meta.kind : undefined,
      url: meta.url ? canonicalMediaUrl(meta.url) || null : null,
      createdAt: now,
      expiresAt: now + Math.min(120_000, Math.max(5_000, Number(meta.timeoutMs) || 45_000)),
    };
    state.contexts = state.contexts.filter(candidate => candidate.operationId !== context.operationId);
    state.contexts.push(context);
    pruneContexts(now);
    if (meta.mask !== undefined) state.mask = meta.mask;
    syncPublicState();
    return { armed: true, operationId: context.operationId, expiresAt: context.expiresAt };
  }

  // The context governing a fetch: only a canonical-URL match governs.
  // Unbound contexts never claim fetches (that was the one-shot bug).
  function matchFetchContext(input) {
    const canonical = canonicalMediaUrl(requestUrl(input));
    if (!canonical) return null;
    pruneContexts();
    return state.contexts.find(context => context.url && context.url === canonical) || null;
  }

  // The context governing an anchor download: a URL-bound match first,
  // otherwise the oldest unbound context (the arm immediately precedes
  // the menu click that produces this anchor, so the anchor IS the armed
  // download). Claiming binds the context to the anchor's canonical URL.
  function claimAnchorContext(anchor) {
    pruneContexts();
    const canonical = canonicalMediaUrl(anchor.href);
    let context = canonical
      ? state.contexts.find(candidate => candidate.url && candidate.url === canonical)
      : null;
    if (!context) context = state.contexts.find(candidate => !candidate.url) || null;
    if (context && !context.url && canonical) context.url = canonical;
    return context || null;
  }

  function outcomeEvent(context, fields) {
    resultEvent({
      kind: context?.kind || fields.kind || "image",
      ...(context ? { operationId: context.operationId, url: context.url || fields.url || null } : { operationId: null, url: fields.url || null }),
      ...fields.event,
    });
  }

  // Remover reasons that mean "no watermark present" are a success with
  // the original bytes; anything else that left the bytes unchanged is a
  // cleaning failure and is reported as such, never as a clean success.
  const NOT_FOUND_REASONS = new Set(["watermark_not_found", "not_found", "below_threshold", "already_clean_output"]);
  function classifyUnchanged(result) {
    const reason = typeof result?.reason === "string" ? result.reason : "";
    if (NOT_FOUND_REASONS.has(reason)) return { status: "original", reason: "not_found", ok: true };
    return { status: "failed", reason: reason || "unchanged", ok: false };
  }

  async function cleanResponse(response, meta = {}) {
    const context = meta.context || null;
    let engaged = context;
    let explicitMarker = false;
    if (!engaged) {
      engaged = matchFetchContext(meta.input);
      if (!engaged) {
        const headers = new Headers(meta.init?.headers || (meta.input instanceof Request ? meta.input.headers : undefined));
        explicitMarker = headers.get("x-tobyflow-watermark-removal") === "1" ||
          new URL(requestUrl(meta.input), location.href).searchParams.get("tobyflow_watermark") === "1";
        if (!explicitMarker || !state.enabled || (!state.mask && !state.maskB64)) return response;
      }
    }
    const url = requestUrl(meta.input);
    if (!isFlowMediaUrl(url)) return response;
    const canonical = canonicalMediaUrl(url);
    const kind = engaged?.kind || meta.kind || "image";

    // An original context guarantees its download keeps the original
    // bytes, whatever else is armed. It governs its own URL regardless
    // of content type (it exists purely to suppress cleaning).
    if (engaged && engaged.mode === "original") {
      consumeContext(engaged);
      outcomeEvent(engaged, { kind, url: canonical, event: { ok: true, changed: false, status: "original", reason: "mode_original" } });
      return response;
    }
    // Cleaning engages only for image responses — the same gate the
    // one-shot arm used. A non-image response neither consumes a clean
    // context nor reports an outcome.
    if (!/^image\//i.test(response?.headers?.get?.("content-type") || "")) return response;
    if (state.processing) return response;
    state.processing = true;
    try {
      const original = await response.blob();
      if (!state.mask && state.maskB64) state.mask = await window.WatermarkRemover.maskFromAlphaPng(state.maskB64);
      if (!state.mask) {
        if (engaged) {
          outcomeEvent(engaged, { kind, url: canonical, event: { ok: false, changed: false, status: "failed", reason: "mask_not_configured" } });
          consumeContext(engaged);
        }
        return response;
      }
      const remover = new window.WatermarkRemover({ mask: state.mask, ...state.options });
      const result = await remover.processBlob(original);
      if (!result.changed) {
        const outcome = classifyUnchanged(result);
        if (engaged || explicitMarker) {
          outcomeEvent(engaged, { kind, url: canonical, event: { ok: outcome.ok, changed: false, status: outcome.status, reason: outcome.reason, ...(result.nccBefore !== undefined ? { nccBefore: result.nccBefore } : {}), ...(result.nccAfter !== undefined ? { nccAfter: result.nccAfter } : {}) } });
          consumeContext(engaged);
        }
        return new Response(result.blob, { status: response.status, statusText: response.statusText, headers: response.headers });
      }
      if (engaged || explicitMarker) {
        outcomeEvent(engaged, { kind, url: canonical, event: { ok: true, changed: true, status: "cleaned", nccBefore: result.nccBefore, nccAfter: result.nccAfter } });
        consumeContext(engaged);
      }
      return new Response(result.blob, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) {
      if (engaged || explicitMarker) {
        outcomeEvent(engaged, { kind, url: canonical, event: { ok: false, changed: false, status: "failed", reason: "error", error: String(error?.message || error) } });
        consumeContext(engaged);
      }
      return response;
    } finally {
      state.processing = false;
    }
  }

  if (nativeFetch) {
    const watermarkFetch = async function flowMcpWatermarkFetch(input, init) {
      const response = await nativeFetch(input, init);
      return cleanResponse(response, { input, init });
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
    if (!anchor || !isFlowMediaUrl(anchor.href)) return;
    if (anchor.dataset.flowMcpWatermarkPassthrough === "1") return;
    const context = claimAnchorContext(anchor);
    const marked = anchor.dataset.tobyflowWatermark === "1";
    if (!context && !marked) return;
    const canonical = canonicalMediaUrl(anchor.href);
    if (context && context.mode === "original") {
      // Guarantee the original: never intercept; the native click
      // proceeds with the untouched bytes. Report and consume.
      consumeContext(context);
      outcomeEvent(context, { kind: context.kind, url: canonical, event: { ok: true, changed: false, status: "original", reason: "mode_original" } });
      return;
    }
    if (!state.mask && !state.maskB64) {
      if (context) {
        // A clean context was armed but no mask is available in this
        // world: cleaning cannot run. Say so against the operation and
        // let the native download proceed with the original bytes.
        consumeContext(context);
        outcomeEvent(context, { kind: context.kind, url: canonical, event: { ok: false, changed: false, status: "failed", reason: "mask_not_configured" } });
      }
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    const href = anchor.href;
    const name = anchor.download || "flow-media";
    void (async () => {
      try {
        const response = await nativeFetch(href, { headers: { "x-tobyflow-watermark-removal": "1" } });
        const cleaned = await cleanResponse(response, { input: href, init: { headers: { "x-tobyflow-watermark-removal": "1" } }, kind: context?.kind, context });
        const blobUrl = URL.createObjectURL(await cleaned.blob());
        const link = document.createElement("a");
        link.href = blobUrl;
        link.download = name;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(blobUrl), 10_000);
      } catch (error) {
        if (context) {
          outcomeEvent(context, { kind: context.kind, url: canonical, event: { ok: false, changed: false, status: "failed", reason: "error", error: String(error?.message || error) } });
          consumeContext(context);
        } else {
          resultEvent({ ok: false, changed: false, status: "failed", reason: "error", operationId: null, error: String(error?.message || error) });
        }
        // Replay the native click exactly once; the context is consumed
        // and the passthrough mark prevents any re-interception loop.
        anchor.dataset.flowMcpWatermarkPassthrough = "1";
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
