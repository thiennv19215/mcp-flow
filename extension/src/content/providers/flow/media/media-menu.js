(function (root) {
  "use strict";

  // The interceptor reports each cleaning attempt on this window event.
  // DL-01 kept only the latest event and a download guessed that an event
  // seen during the op was its own. DL-03: events carry the operation id
  // of the per-download interceptor context, so outcomes are attributed
  // exactly — recorded per operation id below. An event WITHOUT an
  // operation id (a legacy/explicit-marker clean) may be claimed only by
  // the one download currently awaiting an outcome, and only when the
  // kind matches. `lastWatermarkResult` is retained for diagnostics.
  let lastWatermarkResult = null;
  const watermarkOutcomes = new Map();
  let pendingWatermarkClaim = null;
  function recordWatermarkOutcome(detail) {
    const at = Date.now();
    const outcome = {
      at,
      ok: detail.ok === true,
      changed: detail.changed === true,
      kind: typeof detail.kind === "string" ? detail.kind : undefined,
      status: typeof detail.status === "string" ? detail.status : null,
      reason: typeof detail.reason === "string" ? detail.reason : null,
    };
    lastWatermarkResult = outcome;
    let operationId = typeof detail.operationId === "string" && detail.operationId ? detail.operationId : null;
    if (!operationId && pendingWatermarkClaim && at >= pendingWatermarkClaim.armedAt &&
        (!outcome.kind || !pendingWatermarkClaim.kind || outcome.kind === pendingWatermarkClaim.kind)) {
      operationId = pendingWatermarkClaim.operationId;
    }
    if (!operationId) return;
    watermarkOutcomes.set(operationId, outcome);
    for (const [key, value] of watermarkOutcomes) {
      if (at - value.at > 5 * 60_000 || watermarkOutcomes.size > 20) watermarkOutcomes.delete(key);
    }
  }
  try {
    root.addEventListener?.("TOBY_FLOW_WATERMARK_RESULT", event => {
      const detail = event?.detail;
      if (!detail || typeof detail !== "object") return;
      recordWatermarkOutcome(detail);
    });
  } catch (_) {}

  // Structural gate for a locally supplied mask: the value must be base64
  // (optionally a data: URL) decoding to a PNG whose IHDR carries an alpha
  // channel (color type 4/6) or that declares a tRNS chunk before IDAT.
  // Anything else can never drive the remover, so it must not arm
  // cleaning. (The same gate lives in bridge/watermark-config.js, which
  // forwards the config to the MAIN world.)
  const WATERMARK_MASK_MAX_B64_CHARS = 2_800_000;
  function watermarkMaskHasAlpha(value) {
    if (typeof value !== "string") return false;
    let raw = value.trim();
    const dataUrl = /^data:image\/png;base64,([\s\S]+)$/i.exec(raw);
    if (dataUrl) raw = dataUrl[1].trim();
    if (!raw || raw.length > WATERMARK_MASK_MAX_B64_CHARS || raw.length % 4 === 1 || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) return false;
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

  function normalizeWatermarkMode(value) {
    const mode = String(value || "").trim().toLowerCase();
    return mode === "clean" || mode === "original" || mode === "inherit" ? mode : "inherit";
  }

  async function loadWatermarkConfig() {
    try {
      if (typeof chrome === "undefined" || !chrome.storage?.local?.get) return {};
      const stored = await chrome.storage.local.get(["flowWatermark", "watermark"]);
      const config = stored?.flowWatermark || stored?.watermark;
      return config && typeof config === "object" ? config : {};
    } catch (_) { return {}; }
  }

  // Resolve the per-download watermark mode from the job's requested mode
  // plus the persisted flowWatermark config. Explicit modes act as
  // one-shot tickets: "original" always posts a suppressing arm (the
  // interceptor honors it for this download regardless of the global
  // setting) and "clean" arms whenever a valid mask is configured.
  // "inherit" follows the config: master toggle off or the per-kind flag
  // off → no arm at all, and an enabled config without a valid alpha-PNG
  // mask never arms cleaning either.
  async function resolveWatermarkArm(meta = {}) {
    const requested = normalizeWatermarkMode(meta.mode);
    const kindKey = meta.kind === "image" ? "image" : "video";
    const config = await loadWatermarkConfig();
    const maskValid = watermarkMaskHasAlpha(config.alpha_png_b64);
    if (requested === "original") return { post: true, mode: "original", reason: "explicit_original" };
    if (requested === "clean") {
      return maskValid
        ? { post: true, mode: "clean", reason: "explicit_clean" }
        : { post: false, mode: "clean", reason: "mask_missing_or_invalid" };
    }
    if (config.enabled !== true) return { post: false, mode: "original", reason: "disabled" };
    if (config[kindKey] === false) return { post: false, mode: "original", reason: "kind_disabled" };
    if (!maskValid) return { post: false, mode: "original", reason: "mask_missing_or_invalid" };
    return { post: true, mode: "clean", reason: "inherit_clean" };
  }

  // Normalize one attributed interceptor outcome into the op-level
  // watermark fields. Events from DL-03 contexts carry an explicit
  // status; legacy events only carry ok/changed, from which the status
  // is derived (an unchanged-but-ok clean means no watermark was found).
  function watermarkAttributionFromEvent(event) {
    if (!event) return null;
    let status = event.status;
    if (status !== "cleaned" && status !== "original" && status !== "failed") {
      status = event.ok ? (event.changed ? "cleaned" : "original") : "failed";
    }
    return {
      cleaned: status === "cleaned",
      status,
      outcomeReason: status === "original" && !event.reason
        ? "not_found"
        : (typeof event.reason === "string" && event.reason ? event.reason : null),
    };
  }

  // Resolve the watermark outcome for one armed download. Only an event
  // attributed to THIS download's operation id counts; a foreign outcome
  // is never claimed. The click initiates the download synchronously, but
  // cleaning finishes asynchronously, so a clean image arm waits a
  // bounded grace for its outcome event; when none arrives the result
  // stays honestly unknown (cleaned: null, status: "unknown") instead of
  // DL-01's any-event-during-the-op guess.
  async function settleWatermarkOutcome(outcome, helpers) {
    if (!outcome?.armed) return { cleaned: false, status: null, outcomeReason: null };
    if (outcome.mode !== "clean") return { cleaned: false, status: "original", outcomeReason: null };
    if (outcome.kind !== "image") return { cleaned: null, status: null, outcomeReason: null };
    const attributed = () => outcome.operationId ? watermarkOutcomes.get(outcome.operationId) || null : null;
    let event = attributed();
    for (let round = 0; !event && round < 50; round++) {
      try { await helpers.wait(100, "confirming the watermark cleanup outcome"); }
      catch (_) { break; }
      event = attributed();
    }
    if (pendingWatermarkClaim?.operationId === outcome.operationId) pendingWatermarkClaim = null;
    if (!event) return { cleaned: null, status: "unknown", outcomeReason: null };
    return watermarkAttributionFromEvent(event);
  }

  async function armWatermarkDownload(meta = {}) {
    const resolution = await resolveWatermarkArm(meta);
    const outcome = { mode: resolution.mode, armed: false, reason: resolution.reason, kind: meta.kind, armedAt: null, operationId: null };
    if (!resolution.post) return outcome;
    const operationId = `wm-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 10)}`;
    try {
      window.postMessage({
        source: "flow-mcp-watermark-v1",
        action: "arm",
        requestId: `watermark-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        options: {
          title: meta.title,
          kind: meta.kind,
          quality: meta.quality,
          mode: resolution.mode,
          enabled: resolution.mode === "clean",
          operationId,
          ...(meta.url ? { url: meta.url } : {}),
          timeoutMs: Math.min(120_000, Math.max(5_000, Number(meta.timeoutMs) || 45_000)),
        },
      }, location.origin);
      outcome.armed = true;
      outcome.armedAt = Date.now();
      outcome.operationId = operationId;
      if (resolution.mode === "clean") {
        pendingWatermarkClaim = { operationId, kind: meta.kind, armedAt: outcome.armedAt };
      }
    } catch (_) {}
    return outcome;
  }

  function flowTileOptionsButton(tile) {
    const candidates = (typeof root.flowQueryAll === "function" ? root.flowQueryAll("mediaMenu.triggerButton", tile, { checkVisible: false }) : null) ||
      [...tile.querySelectorAll('button,[role="button"]')];
    return candidates.find(el => {
      const label = (root.accessibleName?.(el) || "").replace(/\s+/g, " ").trim().toLowerCase();
      const icon = (root.flowFindIcon ? root.flowFindIcon(el) : el.querySelector?.("mat-icon, .mat-icon, .google-symbols"))?.textContent?.trim().toLowerCase();
      return !el.disabled && el.getAttribute("aria-disabled") !== "true" &&
        (label === "more options" || label.startsWith("more options ") ||
         label === "tùy chọn khác" || label.startsWith("tùy chọn khác") ||
         label === "tác vụ khác" || label === "thêm tùy chọn" ||
         icon === "more_vert" || icon === "more_horiz");
    });
  }

  function flowMenuLabel(el) {
    const label = (typeof root.flowQuery === "function" ? root.flowQuery("mediaMenu.menuItemLabel", el, { checkVisible: false }) : null) ||
      el.querySelector(".label,.item-text");
    if (label) return (label.innerText || label.textContent || "").replace(/\s+/g, " ").trim();
    const clone = el.cloneNode(true);
    const removeIcons = root.FlowSelectors?.mediaMenu?.removeIcons?.selectors?.join(",") || root.FlowSelectors?.common?.icons?.selectors?.join(",") || "mat-icon,.mat-icon,.google-symbols,svg,[aria-hidden='true']";
    clone.querySelectorAll(removeIcons).forEach(icon => icon.remove());
    return (clone.innerText || clone.textContent || root.accessibleName?.(el) || "").replace(/\s+/g, " ").trim();
  }

  function flowMenuItems(container = document) {
    const items = (typeof root.flowQueryAll === "function" ? root.flowQueryAll("mediaMenu.menuItems", container) : null) ||
      [...container.querySelectorAll('[role="menuitem"],button')];
    return items.filter(el => root.visible?.(el));
  }

  function flowDownloadChoice(items, quality, kind) {
    const wanted = kind === "video"
      ? quality === "upscaled" ? /1080p|upscaled|chất lượng cao|đã nâng cấp/i : /720p|original|gốc|chất lượng gốc/i
      : quality === "upscaled" ? /upscaled|2x|4x|2k|chất lượng cao|đã nâng cấp/i : /original|1k|gốc|chất lượng gốc/i;
    return items.find(item => !item.disabled && item.getAttribute("aria-disabled") !== "true" && wanted.test(flowMenuLabel(item)));
  }

  async function revealFlowSubmenu(trigger, parentMenu, quality, kind, options = {}) {
    const rect = trigger.getBoundingClientRect();
    const point = { bubbles: true, cancelable: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
    const pointer = { ...point, pointerId: 1, pointerType: "mouse", relatedTarget: parentMenu };
    const mouse = { ...point, relatedTarget: parentMenu };
    const knownMenus = new Set((typeof root.flowQueryAll === "function" ? root.flowQueryAll("mediaMenu.menuPanel", document, { checkVisible: false }) : null) || document.querySelectorAll('[role="menu"],mat-menu-panel'));
    const find = () => {
      for (const id of [trigger.getAttribute("aria-controls"), trigger.getAttribute("aria-owns")].filter(Boolean)) {
        const target = document.getElementById(id);
        if (target && target !== parentMenu && root.visible?.(target)) return target;
      }
      const menuCandidates = (typeof root.flowQueryAll === "function" ? root.flowQueryAll("mediaMenu.menuPanel", document, { checkVisible: false }) : null) ||
        [...document.querySelectorAll('[role="menu"],mat-menu-panel')];
      const candidates = menuCandidates.filter(menu => menu !== parentMenu && root.visible?.(menu));
      return candidates.find(menu => flowDownloadChoice(flowMenuItems(menu), quality, kind)) || candidates.find(menu => !knownMenus.has(menu));
    };
    for (const event of ["pointerover", "pointerenter", "pointermove", "pointerdown", "pointerup"]) {
      trigger.dispatchEvent(new PointerEvent(event, { ...pointer, ...(event.endsWith("down") || event.endsWith("up") ? { button: 0 } : {}) }));
    }
    for (const event of ["mouseover", "mouseenter", "mousemove"]) trigger.dispatchEvent(new MouseEvent(event, mouse));
    trigger.focus();
    for (let attempt = 0; attempt < 6; attempt++) {
      await options.wait?.(150, "opening Flow's download quality menu");
      const submenu = find();
      if (submenu) return submenu;
      if (attempt === 2) {
        trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      }
    }
    trigger.click();
    for (let attempt = 0; attempt < 6; attempt++) {
      await options.wait?.(150, "opening Flow's download quality menu");
      const submenu = find();
      if (submenu) return submenu;
    }
    return null;
  }

  async function revealFlowTileOptions(tile, options = {}) {
    tile.scrollIntoView({ behavior: "instant", block: "center" });
    const target = tile.querySelector("img,video,[role=img]") || tile;
    const rect = target.getBoundingClientRect();
    const point = { bubbles: true, cancelable: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
    for (const event of ["pointerover", "pointerenter", "pointermove", "mouseover", "mouseenter", "mousemove"]) {
      const Ctor = event.startsWith("pointer") ? PointerEvent : MouseEvent;
      target.dispatchEvent(new Ctor(event, { ...point, pointerId: 1, pointerType: "mouse" }));
    }
    const button = flowTileOptionsButton(tile);
    if (button) return button;
    const deadline = Date.now() + 1800;
    while (Date.now() < deadline) {
      options.checkActive?.("opening the Flow media menu");
      const revealed = flowTileOptionsButton(tile);
      if (revealed) return revealed;
      await options.wait?.(100, "opening the Flow media menu");
    }
    return null;
  }

  async function waitForFlowTileMedia(tile, title, timeoutMs = 20000, options = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastState = "media element missing";
    while (Date.now() < deadline) {
      options.checkActive?.(`waiting for Flow media "${title}"`);
      if (!tile.isConnected) throw root.flowError("FLOW_ASSET_CHANGED", `The tile for "${title}" changed while preparing its download.`, true);
      const errorTile = (typeof root.flowQuery === "function" ? root.flowQuery("tiles.error", tile, { checkVisible: false }) : null) ||
        tile.querySelector("flow-error-tile");
      const retryControl = (typeof root.flowFindSemantic === "function" ? root.flowFindSemantic("tiles.retryButton", tile, { checkVisible: false }) : null) ||
        [...tile.querySelectorAll('button,[role="button"]')].find(el =>
          /^(?:retry|try again|thử lại)(?:\s+.*)?$/i.test(flowMenuLabel(el) || (root.accessibleName?.(el) || "").replace(/\s+/g, " ").trim()) ||
          /^(?:refresh|replay|retry)$/i.test((root.flowFindIcon ? root.flowFindIcon(el) : el.querySelector?.("mat-icon, .mat-icon, .google-symbols"))?.textContent?.trim() || ""));
      if (errorTile || retryControl) {
        const reason = (errorTile?.innerText || errorTile?.textContent || flowMenuLabel(retryControl) || "").replace(/\s+/g, " ").trim();
        throw root.flowError("FLOW_GENERATION_FAILED", `Flow marked "${title}" as failed${reason ? `: ${reason}` : ""}.`, false, true);
      }

      const isBusy = Boolean(root.isTileBusy?.(tile) ?? ((typeof root.flowQuery === "function" ? root.flowQuery("tiles.progressBar", tile, { checkVisible: false }) : null) || tile.querySelector('flow-progress-tile,mat-progress-bar,[role="progressbar"]')));
      const optionsBtn = flowTileOptionsButton(tile);

      // Search for media elements in light DOM and shadow roots
      const media = [
        ...((typeof root.flowQueryAll === "function" ? root.flowQueryAll("tiles.mediaElements", tile, { checkVisible: false }) : null) || tile.querySelectorAll("video,img,canvas,[role='img'],flow-video-tile,flow-image-tile")),
        ...(tile.shadowRoot ? [...tile.shadowRoot.querySelectorAll("video,img,canvas")] : []),
        ...([...tile.querySelectorAll("*")].flatMap(el => el.shadowRoot ? [...el.shadowRoot.querySelectorAll("video,img,canvas")] : []))
      ];

      for (const element of media) {
        if (element instanceof HTMLVideoElement) {
          const src = element.currentSrc || element.getAttribute("src") || "";
          const placeholder = !src || src.includes("media.html") || src.endsWith(".html") || src.startsWith("chrome-extension://");
          const validSource = !placeholder && (root.isFlowMediaSource?.(src) || element.getAttribute("src")?.startsWith("/fx/") || src.startsWith("blob:"));
          lastState = `video found (src: ${src ? 'yes' : 'no'}, valid: ${validSource})`;
          if (validSource || (!isBusy && (src || element.readyState >= 1))) return element;
        } else if (element instanceof HTMLImageElement) {
          const src = element.currentSrc || element.getAttribute("src") || "";
          const placeholder = !src || src.includes("media.html") || src.endsWith(".html") || src.startsWith("chrome-extension://");
          const validSource = !placeholder && (root.isFlowMediaSource?.(src) || element.getAttribute("src")?.startsWith("/fx/") || src.startsWith("blob:") || src.startsWith("data:"));
          const ready = validSource && (element.complete && element.naturalWidth > 0 || root.mediaId?.(tile)?.startsWith("asb:"));
          lastState = `image found (valid source: ${validSource}, ready: ${ready})`;
          if (ready) return element;
        } else if (!isBusy && optionsBtn) {
          lastState = `custom media element (${element.tagName.toLowerCase()}) ready with options menu`;
          return element;
        }
      }

      // If no explicit img/video is matched, but the tile is rendered (not busy) and has options button
      if (!isBusy && optionsBtn) {
        lastState = "tile options ready";
        return tile;
      }

      await options.wait?.(200, `waiting for Flow media "${title}"`);
    }

    // Graceful fallback: If tile is connected and finished rendering (not failed, not busy), allow download
    const finalError = (typeof root.flowQuery === "function" ? root.flowQuery("tiles.error", tile, { checkVisible: false }) : null) ||
      tile.querySelector("flow-error-tile");
    const finalBusy = Boolean(root.isTileBusy?.(tile) ?? ((typeof root.flowQuery === "function" ? root.flowQuery("tiles.progressBar", tile, { checkVisible: false }) : null) || tile.querySelector('flow-progress-tile,mat-progress-bar,[role="progressbar"]')));
    if (tile.isConnected && !finalError && !finalBusy) {
      return tile;
    }

    throw root.flowError("FLOW_MEDIA_NOT_READY", `Flow has not finished loading media for "${title}" (${lastState}).`, true);
  }

  // DL-08 — direct-bytes fallback route. The Flow menu is the web route's
  // only download mechanism; when it breaks before any download started
  // (menu never opens, submenu or quality choice missing), the fallback
  // fetches verified bytes directly from the tile media element's URL,
  // canonicalized to full size (Google size suffix stripped) or rewritten
  // to the requested size, and saves them through a blob anchor under the
  // planned filename. Only these pre-click menu failures engage it: a
  // click may already have started a browser download, and re-saving
  // after that would double-save.
  const DIRECT_FALLBACK_MENU_CODES = new Set([
    "FLOW_TILE_MENU_MISSING",
    "FLOW_DOWNLOAD_SUBMENU_MISSING",
    "FLOW_DOWNLOAD_QUALITY_MISSING",
  ]);

  // Magic-byte sniffing decides the real mime (the reference rule: the
  // bytes, never the header, are authoritative). HTML/JSON/text bodies
  // are not media and are rejected by the caller with a distinct error.
  function sniffMediaBytes(bytes) {
    if (!bytes || bytes.length === 0) return null;
    const startsWith = (signature, offset = 0) =>
      bytes.length >= offset + signature.length && signature.every((value, index) => bytes[offset + index] === value);
    const asciiAt = (text, offset = 0) =>
      bytes.length >= offset + text.length && [...text].every((char, index) => bytes[offset + index] === char.charCodeAt(0));
    if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { mime: "image/png", extension: ".png", kind: "image" };
    if (startsWith([0xff, 0xd8, 0xff])) return { mime: "image/jpeg", extension: ".jpg", kind: "image" };
    if (asciiAt("GIF8")) return { mime: "image/gif", extension: ".gif", kind: "image" };
    if (asciiAt("RIFF") && asciiAt("WEBP", 8)) return { mime: "image/webp", extension: ".webp", kind: "image" };
    if (asciiAt("ftyp", 4)) return { mime: "video/mp4", extension: ".mp4", kind: "video" };
    if (startsWith([0x1a, 0x45, 0xdf, 0xa3])) return { mime: "video/webm", extension: ".webm", kind: "video" };
    let first = 0;
    while (first < bytes.length && (bytes[first] === 0x20 || bytes[first] === 0x09 || bytes[first] === 0x0d || bytes[first] === 0x0a)) first++;
    if (bytes[first] === 0x3c) return { html: true }; // '<' — a markup body, never media
    return null;
  }

  // Full-size URL canonicalization for the fallback fetch: the Google
  // media size suffix ("=s512", "=w1280-h720") is a display detail —
  // stripping it yields the original-resolution bytes; a numeric
  // requested size ("720", "720p") rewrites it to "=s720". The ASB
  // poster transform (the other half of reference behavior D9) is
  // blocked on a server-delivered pattern (DL-B4) and is NOT attempted.
  // Placeholder and media.html URLs are rejected up front (returns null),
  // as are non-https URLs, which can never be rewritten safely.
  function directBytesTargetUrl(rawUrl, quality) {
    let url;
    try { url = new URL(String(rawUrl || ""), location.href); } catch (_) { return null; }
    if (url.protocol !== "https:") return null;
    const path = url.pathname.toLowerCase();
    if (path.includes("media.html") || path.endsWith(".html")) return null;
    if (/(?:placeholder|spinner|loading|skeleton)/i.test(url.pathname)) return null;
    const sizeMatch = /^(\d{3,4})(?:p)?$/i.exec(String(quality || "").trim());
    url.pathname = url.pathname.replace(/=[^/]*$/, sizeMatch ? `=s${sizeMatch[1]}` : "");
    url.hash = "";
    return url.toString();
  }

  // The planned filename: an explicit caller-supplied name first, then
  // the tile's own data-file-name (the name Flow planned for the menu
  // download — the same source collectAssets reports), then the asset
  // title. Never a name derived from the media URL. The extension is
  // always the sniffed one (the queue ticket applies the same rule when
  // it assigns the final filename).
  function plannedFallbackFilename({ operationOptions, tile, mediaElement, title, sniffed }) {
    const explicit = [operationOptions?.filename, operationOptions?.fileName]
      .find(value => typeof value === "string" && value.trim());
    const tileName = tile?.getAttribute?.("data-file-name") || tile?.getAttribute?.("data-filename") ||
      mediaElement?.getAttribute?.("data-file-name") || mediaElement?.getAttribute?.("data-filename") || "";
    const raw = String(explicit || tileName || title || "flow-media");
    let base = raw.replace(/[<>:\"/\\|?*\u0000-\u001f]/g, "-").replace(/\s+/g, "-").replace(/-+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "").slice(0, 120).replace(/\.[a-z0-9]{1,10}$/i, "");
    if (!base) base = "flow-media";
    return `${base}${sniffed.extension}`;
  }

  // Save verified bytes through a blob anchor — the same trigger the
  // interceptor itself uses to deliver cleaned bytes. A blob: href is
  // not a Flow media URL, so the interceptor's anchor claim ignores it:
  // no double processing, no context consumption.
  function saveVerifiedBytes(blob, filename) {
    const objectUrl = URL.createObjectURL(blob);
    try {
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = filename;
      (document.body || document.documentElement)?.appendChild?.(anchor);
      anchor.click();
      anchor.remove?.();
    } finally {
      setTimeout(() => { try { URL.revokeObjectURL(objectUrl); } catch (_) {} }, 10_000);
    }
  }

  // The fallback proper. Returns the op result on success, null when the
  // fallback cannot engage at all (no fetch in this world, or no usable
  // media URL — the caller then rethrows the original menu failure), and
  // throws its own distinct errors when the fetched bytes fail
  // verification.
  //
  // Watermark contract: media-menu runs in the ISOLATED world while the
  // interceptor wraps the MAIN world's fetch, so this fetch can never
  // pass through cleaning. The fallback therefore posts NO arm (an
  // unconsumed context would linger and could claim a later page fetch),
  // and its result reports the saved bytes honestly: when the resolved
  // mode was "clean", the outcome is status "original" with reason
  // "direct_bytes_fallback" and cleaned:false — the bytes are the
  // original bytes, never claimed as cleaned.
  async function directBytesDownloadFallback({ tile, title, kind, quality, operationOptions, helpers, menuError }) {
    if (typeof fetch !== "function") return null;
    const mediaElement = tile?.querySelector?.("img,video") || null;
    const rawUrl = mediaElement?.currentSrc || mediaElement?.src || mediaElement?.getAttribute?.("src") || "";
    const targetUrl = directBytesTargetUrl(rawUrl, quality);
    if (!targetUrl) return null;
    helpers.checkActive("fetching the Flow media bytes directly");
    // Resolve (never arm) the job's requested mode for honest reporting.
    const { watermarkMode } = operationOptions;
    const arm = await resolveWatermarkArm({ mode: watermarkMode, kind });
    let response = null;
    let fetchFailure = null;
    for (const credentials of ["include", "omit"]) {
      try {
        const attempt = await fetch(targetUrl, {
          credentials,
          ...(operationOptions.signal ? { signal: operationOptions.signal } : {}),
        });
        if (attempt?.ok) { response = attempt; break; }
        fetchFailure = new Error(`HTTP ${attempt?.status || "unknown"}`);
      } catch (error) {
        if (operationOptions.signal?.aborted) helpers.checkActive("fetching the Flow media bytes directly");
        fetchFailure = error;
      }
    }
    if (!response) {
      throw root.flowError("FLOW_DOWNLOAD_FALLBACK_FETCH_FAILED",
        `Flow's download menu failed (${menuError?.code || "unknown"}) and the direct fetch of "${title}" also failed: ${String(fetchFailure?.message || fetchFailure || "no response")}.`,
        true, false);
    }
    const blob = await response.blob();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const sniffed = sniffMediaBytes(bytes);
    const contentType = response.headers?.get?.("content-type") || "";
    if (sniffed?.html || (!sniffed && /text\/html/i.test(contentType))) {
      throw root.flowError("FLOW_DOWNLOAD_HTML_RESPONSE",
        `Flow's download menu failed (${menuError?.code || "unknown"}) and the direct route for "${title}" returned an HTML page instead of media; nothing was saved.`,
        false, false);
    }
    if (!sniffed) {
      throw root.flowError("FLOW_DOWNLOAD_BYTES_INVALID",
        `Flow's download menu failed (${menuError?.code || "unknown"}) and the direct route for "${title}" returned ${bytes.length} byte(s) that are not recognizable media; nothing was saved.`,
        false, false);
    }
    if (sniffed.kind !== kind) {
      throw root.flowError("FLOW_DOWNLOAD_BYTES_INVALID",
        `Flow's download menu failed (${menuError?.code || "unknown"}) and the direct route for "${title}" returned ${sniffed.mime} bytes for a ${kind} download; nothing was saved.`,
        false, false);
    }
    helpers.checkActive("saving the directly fetched Flow media");
    const filename = plannedFallbackFilename({ operationOptions, tile, mediaElement, title, sniffed });
    const verifiedBlob = blob.type === sniffed.mime ? blob : new Blob([bytes], { type: sniffed.mime });
    try {
      saveVerifiedBytes(verifiedBlob, filename);
    } catch (error) {
      throw root.flowError("FLOW_DOWNLOAD_FALLBACK_SAVE_FAILED",
        `The direct route fetched verified ${sniffed.mime} bytes for "${title}" but could not start the browser download: ${String(error?.message || error)}.`,
        true, false);
    }
    return {
      title,
      kind,
      downloadTriggered: true,
      trustedGesture: false,
      route: "direct-bytes",
      fallback: {
        menuError: menuError?.code || null,
        url: targetUrl,
        mime: sniffed.mime,
        bytes: bytes.length,
        filename,
      },
      watermark: {
        mode: arm.mode,
        armed: false,
        cleaned: false,
        status: "original",
        outcomeReason: "direct_bytes_fallback",
        reason: arm.reason,
      },
    };
  }

  // DL-09 — download-path tile robustness (study D3/D4/D5/D6, gap G9).
  // The download op now:
  //  (1) checks the page's current project against the media's project
  //      BEFORE any sweep or click (FLOW_PROJECT_MISMATCH);
  //  (2) locates a media-id target by REUSING the generation side's
  //      tile-loading sweep (FlowTiles.sweepFlowTileByMediaId) with an
  //      on-mounted callback and the sweep's failure cooldown
  //      (DOWNLOAD_TILE_SWEEP_COOLDOWN_MS = 60_000, the reference
  //      window: at most one real sweep per target per window, a repeat
  //      inside the window fails fast with FLOW_TILE_SWEEP_COOLDOWN);
  //  (3) verifies the tile against the identity ALIAS SET the
  //      generation side already accepts (media id / persistent id /
  //      UUID / asb forms) — a tile mounting with a different identity
  //      is never clicked;
  //  (4) recovers or withholds broken (load-error) tiles: recovery is
  //      attempted through the generation side's retry machinery plus
  //      an in-place refresh, and if the tile is still broken the op
  //      fails with FLOW_DOWNLOAD_BROKEN_TILE and NO download click
  //      (and no DL-08 fallback) happens.
  const DOWNLOAD_TILE_SWEEP_COOLDOWN_MS = 60_000;
  const DOWNLOAD_TILE_RECOVERY_TIMEOUT_MS = 2_000;

  function downloadExpectedProjectId(operationOptions = {}) {
    const value = [operationOptions.projectId, operationOptions.expectedProjectId,
      operationOptions.mediaProjectId, operationOptions.project_id, operationOptions.expected_project_id]
      .find(candidate => typeof candidate === "string" && candidate.trim());
    return value ? value.trim() : null;
  }

  function currentDownloadProjectId() {
    try {
      const described = (root.ProviderRegistry || root.FlowDriverRegistry)?.describeUrl?.(location.href);
      if (described?.projectId) return String(described.projectId);
    } catch (_) {}
    const match = /\/project\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
      .exec(String(location.href || location.pathname || ""));
    return match ? match[1] : null;
  }

  function assertDownloadProject(operationOptions = {}) {
    const expected = downloadExpectedProjectId(operationOptions);
    if (!expected) return;
    const current = currentDownloadProjectId();
    if (!current || current.toLowerCase() !== expected.toLowerCase()) {
      throw root.flowError("FLOW_PROJECT_MISMATCH",
        `The Flow page is in project "${current || "unknown"}", but the requested media belongs to project "${expected}"; no download was started.`,
        false, false);
    }
  }

  function assertTileProject(tile) {
    let tileProject = null;
    try { tileProject = tile?.getAttribute?.("data-project-id") || tile?.getAttribute?.("data-project") || null; } catch (_) {}
    if (!tileProject) return;
    const current = currentDownloadProjectId();
    if (current && String(current).toLowerCase() !== String(tileProject).toLowerCase()) {
      throw root.flowError("FLOW_PROJECT_MISMATCH",
        `The tile for this download belongs to project "${tileProject}", but the Flow page is in project "${current}"; no download was started.`,
        false, false);
    }
  }

  function downloadIdentityValuesMatch(left, right) {
    const fromTiles = root.FlowTiles?.tileIdentityValuesMatch;
    if (typeof fromTiles === "function") return fromTiles(left, right);
    const a = String(left || "").trim();
    const b = String(right || "").trim();
    if (!a || !b) return false;
    if (/^[0-9a-f-]{36}$/i.test(a) && /^[0-9a-f-]{36}$/i.test(b)) return a.toLowerCase() === b.toLowerCase();
    const aAsb = /^asb:(.+)$/i.exec(a)?.[1];
    const bAsb = /^asb:(.+)$/i.exec(b)?.[1];
    if (aAsb || bAsb) return (aAsb || a) === (bAsb || b);
    return a === b;
  }

  // The tile's identity alias set. The generation side's extractor
  // (FlowTiles.tileIdentityAliases, tiles.js) is authoritative when it
  // is loaded — in the shipped content script it always is (manifest
  // order) — and the local mirror below only covers harnesses that load
  // media-menu alone; both collect the same alias forms.
  function downloadTileIdentityAliases(tile) {
    const fromTiles = root.FlowTiles?.tileIdentityAliases;
    if (typeof fromTiles === "function") {
      try { return fromTiles(tile); } catch (_) {}
    }
    const aliases = [];
    const add = value => {
      const text = typeof value === "string" ? value.trim() : "";
      if (text && !aliases.includes(text)) aliases.push(text);
    };
    if (!tile) return aliases;
    try { add(root.mediaId?.(tile)); } catch (_) {}
    const identityAttributes = ["data-persistent-media-id", "data-media-id", "data-media-uuid", "data-uuid"];
    for (const attribute of identityAttributes) {
      try { add(tile.getAttribute?.(attribute)); } catch (_) {}
    }
    try {
      const descendants = tile.querySelectorAll?.("[data-persistent-media-id],[data-media-id],[data-media-uuid],[data-uuid]") || [];
      for (const node of descendants) {
        for (const attribute of identityAttributes) {
          try { add(node.getAttribute?.(attribute)); } catch (_) {}
        }
      }
    } catch (_) {}
    try {
      const mediaNodes = tile.querySelectorAll?.("img,video") || [];
      for (const node of mediaNodes) {
        for (const attribute of identityAttributes) {
          try { add(node.getAttribute?.(attribute)); } catch (_) {}
        }
        const src = String(node.currentSrc || node.src || node.getAttribute?.("src") || "");
        if (!src) continue;
        add(src.match(/[0-9a-f]{8}-[0-9a-f-]{27}/i)?.[0]);
        try {
          const url = new URL(src, location.href);
          if (url.pathname.startsWith("/asb/")) {
            const rest = url.pathname.slice("/asb/".length).replace(/=(?:s\d+(?:-[a-z]+)*|mm,\d+,\d+)$/i, "");
            if (rest) { add(`asb:${rest}`); add(rest); }
          }
        } catch (_) {}
      }
    } catch (_) {}
    return aliases;
  }

  function downloadRequestedAliases(operationOptions = {}) {
    const values = [];
    for (const key of ["mediaAliases", "identityAliases", "aliases", "mediaAlias", "identityAlias"]) {
      const raw = operationOptions[key];
      if (Array.isArray(raw)) values.push(...raw);
      else if (typeof raw === "string" && raw.trim()) values.push(raw);
    }
    return values;
  }

  function downloadTileMatchesIdentity(tile, mediaHandle, extraAliases = []) {
    const requested = [mediaHandle, ...extraAliases]
      .map(value => String(value || "").trim())
      .filter(value => value && !value.startsWith("title:"));
    if (!requested.length) return true;
    const aliases = downloadTileIdentityAliases(tile);
    if (!aliases.length) return false;
    return aliases.some(alias => requested.some(value => downloadIdentityValuesMatch(alias, value)));
  }

  // Locate the target tile through the generation side's sweep. The
  // sweep fires onMounted the moment a tile whose alias set contains
  // the requested identity mounts; identity is re-verified at that
  // moment here, and the caller's own onTileMounted hook runs after
  // the verification (its errors are ignored — it is an observer, the
  // verification above is the gate). Without the generation module
  // (isolated test harnesses only) the fallback is a mounted-tiles-only
  // alias match — it never scrolls on its own.
  async function locateDownloadTile(mediaHandle, { title, operationOptions = {}, deadline } = {}) {
    const requestedAliases = downloadRequestedAliases(operationOptions);
    const sweep = root.FlowTiles?.sweepFlowTileByMediaId || root.sweepFlowTileByMediaId ||
      root.FlowTiles?.findFlowTileByMediaId || root.findFlowTileByMediaId;
    if (typeof sweep === "function") {
      const owner = typeof root.FlowTiles?.sweepFlowTileByMediaId === "function" ? root.FlowTiles
        : (typeof root.sweepFlowTileByMediaId === "function" ? root : root.FlowTiles);
      return sweep.call(owner, mediaHandle, {
        aliases: requestedAliases,
        deadline,
        signal: operationOptions.signal,
        failureCooldownMs: DOWNLOAD_TILE_SWEEP_COOLDOWN_MS,
        onMounted: async mounted => {
          if (!downloadTileMatchesIdentity(mounted, mediaHandle, requestedAliases)) {
            throw root.flowError("FLOW_ASSET_CHANGED",
              `A tile mounted while locating "${title}", but its identity does not match "${mediaHandle}"; it was not clicked.`,
              false, false);
          }
          const external = operationOptions.onTileMounted || operationOptions.onMounted;
          if (typeof external === "function") {
            try { await external(mounted); } catch (_) {}
          }
        },
      });
    }
    const candidates = (typeof root.flowQueryAll === "function" ? root.flowQueryAll("tiles.container", document, { checkVisible: false }) : null) ||
      [...document.querySelectorAll("flow-grid-tile-container")];
    return candidates.find(candidate => downloadTileMatchesIdentity(candidate, mediaHandle, requestedAliases)) || null;
  }

  function findDownloadRetryControl(tile) {
    const buttons = [...(tile?.querySelectorAll?.('button,[role="button"]') || [])];
    return buttons.find(el => {
      let label = "";
      try { label = flowMenuLabel(el); } catch (_) {}
      const accessible = (root.accessibleName?.(el) || "").replace(/\s+/g, " ").trim();
      const icon = (root.flowFindIcon ? root.flowFindIcon(el) : el.querySelector?.("mat-icon, .mat-icon, .google-symbols"))?.textContent?.trim() || "";
      return /^(?:retry|try again|thử lại)(?:\s+.*)?$/i.test(label || accessible) ||
        /^(?:refresh|replay|retry)$/i.test(icon);
    }) || null;
  }

  // A tile is broken for download purposes when Flow shows its load
  // error surface (error tile or a retry/refresh control), when its
  // image element finished loading with no pixels, or when its video
  // element is in a network/codec error state. A merely still-loading
  // tile (incomplete image, no error surface) is NOT broken — the
  // existing waitForFlowTileMedia wait handles that case.
  function downloadTileLoadError(tile) {
    if (!tile) return null;
    const errorTile = (typeof root.flowQuery === "function" ? root.flowQuery("tiles.error", tile, { checkVisible: false }) : null) ||
      tile.querySelector?.("flow-error-tile");
    const retryControl = findDownloadRetryControl(tile);
    if (errorTile || retryControl) {
      const reason = (errorTile?.innerText || errorTile?.textContent || "").replace(/\s+/g, " ").trim();
      return { kind: "error-tile", reason, retryControl };
    }
    let media = [];
    try {
      media = [
        ...((typeof root.flowQueryAll === "function" ? root.flowQueryAll("tiles.mediaElements", tile, { checkVisible: false }) : null) || tile.querySelectorAll("video,img,canvas,[role='img'],flow-video-tile,flow-image-tile")),
      ];
    } catch (_) { media = []; }
    // Only flag the tile when NO media element on it is healthy: a
    // video tile whose poster image failed but whose video element is
    // fine (and vice versa) can still download normally.
    let brokenCandidate = null;
    for (const element of media) {
      const tag = String(element?.tagName || "").toLowerCase();
      const isImage = (typeof HTMLImageElement !== "undefined" && element instanceof HTMLImageElement) || tag === "img";
      const isVideo = (typeof HTMLVideoElement !== "undefined" && element instanceof HTMLVideoElement) || tag === "video";
      if (isImage) {
        const src = element.currentSrc || element.getAttribute?.("src") || "";
        if (src && element.complete === true && element.naturalWidth > 0) return null;
        if (!brokenCandidate && src && element.complete === true && element.naturalWidth === 0) {
          brokenCandidate = { kind: "broken-image", reason: "image failed to load", media: element };
        }
      } else if (isVideo) {
        const src = element.currentSrc || element.getAttribute?.("src") || "";
        if (src && !element.error && element.networkState !== 3) return null;
        if (!brokenCandidate && (element.error || element.networkState === 3)) {
          brokenCandidate = { kind: "broken-video", reason: "video failed to load", media: element };
        }
      }
    }
    return brokenCandidate;
  }

  async function recoverDownloadTile(tile, { title, kind, mediaHandle, helpers, operationOptions = {}, deadline }) {
    const broken = downloadTileLoadError(tile);
    if (!broken) return tile;
    // Recovery attempt 1: the generation side's error-tile retry
    // machinery (the same helper upload/generation recovery uses).
    let accepted = false;
    const retry = root.FlowTiles?.retryNativeErrorTile || root.retryNativeErrorTile;
    if (typeof retry === "function") {
      try {
        const result = await retry(
          { id: mediaHandle || (() => { try { return root.mediaId?.(tile); } catch (_) { return undefined; } })(), title, kind, element: tile },
          { attempted: new Set(), deadline, timeoutMs: DOWNLOAD_TILE_RECOVERY_TIMEOUT_MS, signal: operationOptions.signal });
        accepted = Boolean(result?.accepted ?? result);
      } catch (_) { accepted = false; }
    }
    // Recovery attempt 2: an in-place refresh — activate the tile's own
    // retry/refresh control, or reload a broken media element's src so
    // the browser fetches the preview again.
    if (!accepted) {
      const control = broken.retryControl || findDownloadRetryControl(tile);
      if (control && typeof control.click === "function") {
        try { control.click(); } catch (_) {}
        await helpers.wait(200, "recovering the broken Flow tile");
      } else if (broken.media) {
        const src = broken.media.currentSrc || broken.media.getAttribute?.("src") || broken.media.src || "";
        if (src) {
          try { broken.media.src = ""; broken.media.src = src; } catch (_) {}
          await helpers.wait(200, "recovering the broken Flow tile");
        }
      }
    }
    let current = tile?.isConnected ? tile : null;
    if (!current && mediaHandle) {
      const candidates = (typeof root.flowQueryAll === "function" ? root.flowQueryAll("tiles.container", document, { checkVisible: false }) : null) ||
        [...document.querySelectorAll("flow-grid-tile-container")];
      current = candidates.find(candidate => downloadTileMatchesIdentity(candidate, mediaHandle, downloadRequestedAliases(operationOptions))) || null;
    }
    if (!current || downloadTileLoadError(current)) {
      throw root.flowError("FLOW_DOWNLOAD_BROKEN_TILE",
        `The tile for "${title}" failed to load${broken.reason ? `: ${broken.reason}` : ""}; recovery was attempted but the tile is still broken, so no download was started rather than risk saving a placeholder or the wrong asset.`,
        true, false);
    }
    return current;
  }

  function triggerFlowDownload(title, quality = "original", mediaHandle, operationOptions = {}) {
    return (async () => {
      const deadline = Date.now() + Math.max(5000, Math.min(90_000, Number(operationOptions.timeoutMs) || 45_000));
      let downloadMayHaveStarted = false;
      let watermarkOutcome = null;
      const checkActive = operation => {
        if (operationOptions.signal?.aborted) {
          throw root.flowError("FLOW_OPERATION_CANCELLED", `The Flow queue stopped while ${operation}.${downloadMayHaveStarted ? " The download may already have started; check the browser downloads before retrying." : " No download was started."}`, false, downloadMayHaveStarted);
        }
        if (Date.now() >= deadline) throw root.flowError("FLOW_OPERATION_TIMEOUT", `Timed out while ${operation}.${downloadMayHaveStarted ? " The download may already have started; check the browser downloads before retrying." : " No download was started."}`, false, downloadMayHaveStarted);
      };
      const wait = async (ms, operation) => {
        checkActive(operation);
        const duration = Math.min(ms, Math.max(1, deadline - Date.now()));
        if (root.FlowUiDeadline?.boundedWait) await root.FlowUiDeadline.boundedWait(duration, deadline, operation, downloadMayHaveStarted, operationOptions.signal);
        else await root.wait?.(duration);
        checkActive(operation);
      };
      const helpers = { checkActive, wait };
      checkActive("preparing the Flow download");
      // DL-09: the project check is FIRST — before tab activation, any
      // sweep, or any click (study D3).
      assertDownloadProject(operationOptions);
      if (document.visibilityState === "hidden") {
        const activated = await chrome.runtime.sendMessage({ type: "flow-mcp:ensure-active-tab" });
        if (!activated?.ok) throw root.flowError("FLOW_TAB_ACTIVATION_FAILED", activated?.error || "Flow tab could not be activated for its download menu.", true);
        await wait(300, "activating the Flow tab");
      }
      let tile;
      if (mediaHandle) {
        // DL-09: locate through the generation side's tile-loading
        // sweep (with on-mounted callback + failure cooldown), which
        // mounts a target scrolled out of the virtualized grid and
        // only ever returns a tile whose identity alias set contains
        // the requested media id.
        checkActive("locating the selected Flow media");
        tile = await locateDownloadTile(mediaHandle, { title, operationOptions, deadline });
        if (!tile) throw root.flowError("FLOW_ASSET_NOT_FOUND", `Could not find media id "${mediaHandle}" in the project library; refusing to substitute another tile named "${title}".`, true);
      }
      if (!tile) tile = await root.findFlowTile?.(title);
      if (!tile) throw root.flowError("FLOW_ASSET_NOT_FOUND", `Could not find "${title}" in the project library.`, true);
      const scene = Boolean(typeof root.flowQuery === "function" ? root.flowQuery("tiles.scene", tile, { checkVisible: false }) : tile.querySelector("flow-scene-tile"));
      const kind = (typeof root.flowQuery === "function" ? root.flowQuery("tiles.video", tile, { checkVisible: false }) : tile.querySelector("flow-video-tile")) ? "video" : "image";
      // DL-03: the tile's media URL lets the arm bind its interceptor
      // context to exactly this download (canonicalized on both sides).
      let watermarkUrl;
      try {
        const mediaElement = tile.querySelector("img,video");
        watermarkUrl = mediaElement?.currentSrc || mediaElement?.src || mediaElement?.getAttribute?.("src") || undefined;
      } catch (_) {}
      assertTileProject(tile);
      if (!scene) {
        // DL-09: a broken (load-error) tile is recovered first; if it
        // cannot recover, recoverDownloadTile throws and no download
        // click (or DL-08 fallback) ever happens.
        tile = await recoverDownloadTile(tile, { title, kind, mediaHandle, helpers, operationOptions, deadline });
        await waitForFlowTileMedia(tile, title, 20_000, helpers);
      }
      if (!tile.isConnected || (mediaHandle && !downloadTileMatchesIdentity(tile, mediaHandle, downloadRequestedAliases(operationOptions)))) {
        tile = mediaHandle
          ? await locateDownloadTile(mediaHandle, { title, operationOptions, deadline })
          : await root.findFlowTile?.(title);
        if (!tile) throw root.flowError("FLOW_ASSET_CHANGED", `The selected Flow tile for "${title}" changed before its menu opened.`, true);
        tile.scrollIntoView({ behavior: "instant", block: "center" });
        assertTileProject(tile);
        if (!scene) {
          tile = await recoverDownloadTile(tile, { title, kind, mediaHandle, helpers, operationOptions, deadline });
          await waitForFlowTileMedia(tile, title, 20_000, helpers);
        }
      }
      // DL-08: a pre-click menu failure gets one direct-bytes fallback
      // attempt (see directBytesDownloadFallback); anything else rethrows.
      let menuFailure = null;
      try {
      if (scene) {
        tile.click();
        await wait(1200, "opening the Flow scene");
        const download = root.flowButton?.("Download scene") || root.flowButton?.("Tải xuống cảnh") || root.flowButton?.("Tải cảnh");
        if (!download) throw root.flowError("FLOW_SCENE_DOWNLOAD_MISSING", "Scene view opened but Download scene is unavailable.", true);
        checkActive("starting the Flow scene download");
        watermarkOutcome = await armWatermarkDownload({ title, kind: "video", quality, mode: operationOptions.watermarkMode, url: watermarkUrl });
        download.click();
        downloadMayHaveStarted = true;
      } else {
        const isDownloadItem = el => {
          const lbl = flowMenuLabel(el);
          const icon = (root.flowFindIcon ? root.flowFindIcon(el) : el.querySelector?.("mat-icon, .mat-icon, .google-symbols"))?.textContent?.trim().toLowerCase();
          return /^(?:Download|Tải xuống|Tải)(?:\s+(?:image|video|hình ảnh|ảnh|tệp|original|gốc))?$/i.test(lbl) ||
            icon === "download" || icon === "file_download";
        };

        const more = await revealFlowTileOptions(tile, helpers);
        let entries;
        if (more) {
          checkActive("opening the Flow media menu");
          more.click();
          await wait(400, "opening the Flow media menu");
          entries = flowMenuItems();
        } else {
          const media = tile.querySelector("img,video") || tile;
          const rect = media.getBoundingClientRect();
          media.dispatchEvent(new MouseEvent("contextmenu", {
            bubbles: true, cancelable: true, clientX: rect.left + rect.width / 2,
            clientY: rect.top + rect.height / 2, button: 2,
          }));
          const menuDeadline = Date.now() + 1800;
          do {
            checkActive("opening the Flow media menu");
            entries = flowMenuItems();
            if (entries.some(isDownloadItem)) break;
            await wait(100, "opening the Flow media menu");
          } while (Date.now() < menuDeadline);
        }
        const download = entries.find(isDownloadItem);
        if (download) {
          if (download.getAttribute("aria-haspopup") === "menu") {
            const parentMenu = download.closest('[role="menu"],mat-menu-panel') || download.parentElement;
            const submenu = await revealFlowSubmenu(download, parentMenu, quality, kind, helpers);
            if (!submenu) throw root.flowError("FLOW_DOWNLOAD_SUBMENU_MISSING", `Flow opened the media menu but did not reveal download choices for "${title}".`, true);
            const choice = flowDownloadChoice(flowMenuItems(submenu), quality, kind);
            if (!choice) {
              const available = flowMenuItems(submenu).map(flowMenuLabel).filter(Boolean).join(", ") || "none";
              throw root.flowError("FLOW_DOWNLOAD_QUALITY_MISSING", `Flow's download menu for "${title}" has no ${quality} option. Available: ${available}.`, true);
            }
            checkActive("starting the Flow media download");
            watermarkOutcome = await armWatermarkDownload({ title, kind, quality, mode: operationOptions.watermarkMode, url: watermarkUrl });
            choice.click();
            downloadMayHaveStarted = true;
          } else {
            checkActive("starting the Flow media download");
            watermarkOutcome = await armWatermarkDownload({ title, kind, quality, mode: operationOptions.watermarkMode, url: watermarkUrl });
            download.click();
            downloadMayHaveStarted = true;
          }
        } else throw root.flowError("FLOW_TILE_MENU_MISSING", `Could not open options for "${title}".`, true);
      }
      } catch (error) {
        menuFailure = error;
      }
      if (menuFailure) {
        if (!scene && !downloadMayHaveStarted && DIRECT_FALLBACK_MENU_CODES.has(menuFailure?.code) && !operationOptions.signal?.aborted) {
          const fallbackResult = await directBytesDownloadFallback({ tile, title, kind, quality, operationOptions, helpers, menuError: menuFailure });
          if (fallbackResult) return fallbackResult;
        }
        throw menuFailure;
      }
      const watermarkAttribution = await settleWatermarkOutcome(watermarkOutcome, helpers);
      return {
        title,
        kind: scene ? "scene" : tile.querySelector("flow-video-tile") ? "video" : "image",
        downloadTriggered: true,
        trustedGesture: false,
        watermark: {
          mode: watermarkOutcome?.mode || "original",
          armed: watermarkOutcome?.armed === true,
          cleaned: watermarkAttribution.cleaned,
          ...(watermarkOutcome?.reason ? { reason: watermarkOutcome.reason } : {}),
          ...(watermarkOutcome?.operationId ? { operationId: watermarkOutcome.operationId } : {}),
          ...(watermarkAttribution.status ? { status: watermarkAttribution.status } : {}),
          ...(watermarkAttribution.outcomeReason ? { outcomeReason: watermarkAttribution.outcomeReason } : {}),
        },
      };
    })();
  }

  function collectAssets(options = {}) {
    const includeIncomplete = options.includeIncomplete === true;
    const tileContainers = (typeof root.flowQueryAll === "function" ? root.flowQueryAll("tiles.container", document, { checkVisible: false }) : null) ||
      [...document.querySelectorAll("flow-grid-tile-container")];
    return tileContainers.map(tile => {
      const scene = Boolean(typeof root.flowQuery === "function" ? root.flowQuery("tiles.scene", tile, { checkVisible: false }) : tile.querySelector("flow-scene-tile"));
      const video = (typeof root.flowQuery === "function" ? root.flowQuery("tiles.video", tile, { checkVisible: false }) : tile.querySelector("flow-video-tile"));
      const image = (typeof root.flowQuery === "function" ? root.flowQuery("tiles.image", tile, { checkVisible: false }) : tile.querySelector("flow-image-tile"));
      const kind = scene ? "scene" : video ? "video" : image ? "image" : null;
      const name = (tile.getAttribute("aria-label") || tile.getAttribute("title") || tile.getAttribute("data-tile-name") ||
        tile.querySelector("img")?.getAttribute("alt") || tile.querySelector("img")?.getAttribute("aria-label") || "").trim();
      const queriedMedia = (typeof root.flowQueryAll === "function" ? root.flowQueryAll("tiles.mediaElements", tile, { checkVisible: false }) : null) || [];
      const mediaElements = [...new Set([...queriedMedia, ...tile.querySelectorAll("img,video")])];
      const imageCandidates = mediaElements.flatMap(element => {
        if (String(element.tagName || "").toLowerCase() === "img") return [element];
        if (typeof element.querySelectorAll !== "function") return [];
        return [...element.querySelectorAll("img")];
      });
      const videoCandidates = mediaElements.flatMap(element => {
        if (String(element.tagName || "").toLowerCase() === "video") return [element];
        if (typeof element.querySelectorAll !== "function") return [];
        return [...element.querySelectorAll("video")];
      });
      const readImageUrl = element => element?.currentSrc || element?.getAttribute?.("src") || "";
      const usableImageCandidates = [...new Set(imageCandidates)].map(element => ({ element, src: readImageUrl(element) }))
        .filter(item => item.src && !/^(?:data:|blob:|chrome-extension:)/i.test(item.src) && !/(?:placeholder|spinner|loading|skeleton)/i.test(item.src));
      const imageElement = usableImageCandidates.sort((a, b) => {
        const score = item => (item.element.naturalWidth > 1 ? 2 : 0) + (/googleusercontent\.com|googleapis\.com|usercontent\.goog|\/media\//i.test(item.src) ? 1 : 0);
        return score(b) - score(a);
      })[0]?.element || null;
      const videoElement = [...new Set(videoCandidates)].find(element => element.currentSrc || element.getAttribute("src") || element.getAttribute("poster")) || null;
      const mediaElement = imageElement || videoElement;
      let thumbnailUrl = usableImageCandidates.find(item => item.element === imageElement)?.src ||
        videoElement?.getAttribute("poster") || videoElement?.poster || "";
      try {
        const parsedThumbnail = new URL(thumbnailUrl, location.href);
        thumbnailUrl = parsedThumbnail.protocol === "https:" ? parsedThumbnail.href : "";
      } catch { thumbnailUrl = ""; }
      let mediaSrc = mediaElement?.currentSrc || mediaElement?.getAttribute?.("src") || "";
      try {
        const parsed = new URL(mediaSrc, location.href);
        mediaSrc = parsed.protocol === "https:" || parsed.protocol === "blob:" ? parsed.href : "";
      } catch { mediaSrc = ""; }
      const videoUrl = videoElement ? (videoElement.currentSrc || videoElement.getAttribute("src") || "") : "";
      const fileName = tile.getAttribute("data-file-name") || tile.getAttribute("data-filename") ||
        mediaElement?.getAttribute?.("data-file-name") || mediaElement?.getAttribute?.("data-filename") || "";
      const displayName = tile.getAttribute("data-display-name") || tile.getAttribute("data-title") || name;
      const persistentMediaId = tile.getAttribute("data-persistent-media-id") || tile.getAttribute("data-media-id") ||
        mediaElement?.getAttribute?.("data-media-id") || undefined;
      const rawId = root.mediaId?.(tile);
      // persistentMediaId was already resolved from the tile's own identity
      // attributes above; use it when mediaId() could only derive a title
      // fallback, otherwise the asset is dropped from baseline/confirmation
      // scans even though Flow exposed a stable ID for it.
      const id = rawId && !rawId.startsWith("title:") ? rawId : persistentMediaId;
      if ((!kind || !name) && (!includeIncomplete || !id)) return null;
      const busy = Boolean(root.FlowTiles?.isTileBusy?.(tile) ?? root.isTileBusy?.(tile));
      const ready = Boolean(root.FlowTiles?.isTileMediaReady?.(tile) ?? (!busy && root.isTileMediaReady?.(tile)));
      const hasError = Boolean(typeof root.flowQuery === "function" ? root.flowQuery("tiles.error", tile, { checkVisible: false }) : tile.querySelector("flow-error-tile"));
      return {
        ...(id ? { id } : {}),
        ...(persistentMediaId ? { persistentMediaId } : {}),
        name,
        displayName,
        fileName: fileName || undefined,
        kind,
        type: kind,
        ...(thumbnailUrl ? { thumbnailUrl, thumbnail: thumbnailUrl } : {}),
        ...(mediaSrc ? { src: mediaSrc } : {}),
        ...(videoUrl ? { videoUrl, video_url: videoUrl } : {}),
        projectId: (root.ProviderRegistry || root.FlowDriverRegistry)?.describeUrl?.(location.href)?.projectId || undefined,
        identityDurability: id ? "persistent" : "title_only",
        fileId: id || undefined,
        busy,
        ...(includeIncomplete ? { ready, error: hasError } : {}),
      };
    }).filter(Boolean);
  }

  async function scanNativeAssets(options = {}) {
    const maxDurationMs = Math.max(1000, Math.min(25_000, Number(options.maxDurationMs) || 25_000));
    const maxItems = !options.exactName && !options.requireComplete && Number.isFinite(Number(options.maxItems))
      ? Math.max(1, Math.min(5_000, Math.floor(Number(options.maxItems))))
      : Infinity;
    const deadline = Math.min(Number(options.deadline) || Infinity, Date.now() + maxDurationMs);
    const controller = new AbortController();
    const remainingMs = Math.max(0, deadline - Date.now());
    const timeout = setTimeout(() => controller.abort(), remainingMs);
    const externalSignal = options.signal;
    const onExternalAbort = () => controller.abort(externalSignal?.reason);
    if (externalSignal?.aborted) onExternalAbort();
    else externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
    const signal = controller.signal;
    const checkActive = () => {
      if (externalSignal?.aborted) {
        controller.abort(externalSignal.reason);
        throw root.flowError?.("FLOW_OPERATION_CANCELLED", "The Flow queue stopped while scanning the media library.", false, false) || new Error("Flow media library scan was cancelled.");
      }
      if (Date.now() >= deadline) {
        controller.abort();
        throw root.flowError?.("FLOW_ASSET_SCAN_TIMEOUT", "Flow media library scan reached its time limit and was cancelled. No further assets were scanned.", true, false) || new Error("Flow media library scan timed out.");
      }
      if (signal.aborted) throw root.flowError?.("FLOW_ASSET_SCAN_TIMEOUT", "Flow media library scan reached its time limit and was cancelled. No further assets were scanned.", true, false) || new Error("Flow media library scan timed out.");
    };
    const boundedWait = async ms => {
      checkActive();
      await root.wait?.(Math.min(ms, Math.max(1, deadline - Date.now())));
      checkActive();
    };
    const matchesTarget = asset => {
      if (!options.exactName) return false;
      const normalize = value => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
      const full = normalize(options.exactName);
      const stem = normalize(String(options.exactName).replace(/\.(?:png|jpe?g|webp|gif|heic|heif|avif|mp4|m4v|mov|webm|avi|mkv|3gp)$/i, ""));
      const name = normalize(asset?.name).replace(/\s+(?:image|video|character|avatar|ảnh|nhân vật)$/i, "").trim();
      const kindMatches = !options.kind || (!asset?.kind && options.includeIncomplete) || (options.kind === "video" ? asset?.kind === "video" || asset?.kind === "scene" : asset?.kind === options.kind);
      return kindMatches && (name === full || name === stem);
    };
    const gridScroller = () => root.FlowTiles?.flowMediaGridScrollContainer?.() || root.flowMediaGridScrollContainer?.();
    const originalContainer = gridScroller();
    const originalTop = originalContainer?.scrollTop ?? 0;
    const byIdentity = new Map();
    let targetFound = false;
    let targetScrollTop = null;
    let scanSteps = 0;
    const hasBaselineIds = Array.isArray(options.baselineIds);
    const baselineIds = new Set((options.baselineIds || []).map(String));
    const ownerKindMatches = asset => !options.ownerKind || !asset.kind ||
      (options.ownerKind === "video" ? asset.kind === "video" || asset.kind === "scene" : asset.kind === options.ownerKind);
    const rememberVisible = () => {
      const currentTop = gridScroller()?.scrollTop ?? 0;
      for (const asset of collectAssets({ includeIncomplete: options.includeIncomplete })) {
        const key = asset.id ? `id:${asset.id}` : `name:${asset.kind}:${asset.name.toLowerCase()}`;
        const prior = byIdentity.get(key);
        if (!prior && byIdentity.size >= maxItems) continue;
        byIdentity.set(key, {
          ...prior,
          ...asset,
          name: asset.name || prior?.name || "",
          kind: asset.kind || prior?.kind,
          busy: asset.busy ?? prior?.busy ?? true,
          ready: asset.ready ?? prior?.ready ?? false,
          _scrollTop: prior?._scrollTop ?? currentTop,
        });
      }
      const matches = [...byIdentity.values()].filter(matchesTarget);
      if (matches.length > 1) throw root.flowError?.("FLOW_ASSET_AMBIGUOUS", `More than one Flow library tile exactly matches "${options.exactName}".`, false, true) || new Error("Ambiguous Flow asset title.");
      if (matches.length === 1) { targetFound = true; targetScrollTop = matches[0]._scrollTop; }
      return matches;
    };
    try {
      checkActive();
      const hasGrid = (typeof root.flowQuery === "function" && root.flowQuery("tiles.container", document, { checkVisible: false })) ||
        document.querySelector("flow-grid-tile-container");
      if (!hasGrid) {
        const navigation = root.ensureFlowLibrarySection?.("All media", { deadline, signal });
        if (navigation) {
          await Promise.race([
            navigation,
            new Promise((_, reject) => signal.addEventListener("abort", () => reject(root.flowError?.("FLOW_ASSET_SCAN_TIMEOUT", "Flow media library scan reached its time limit and was cancelled.", true, false) || new Error("Flow media library scan timed out.")), { once: true })),
          ]);
        }
      }
      checkActive();
      const gridAfter = (typeof root.flowQuery === "function" && root.flowQuery("tiles.container", document, { checkVisible: false })) ||
        document.querySelector("flow-grid-tile-container");
      if (!gridAfter) {
        throw new Error("Flow's All media grid is not visible. Open the project and try again.");
      }
      const container = gridScroller();
      if (!container) {
        if (options.requireComplete) {
          throw root.flowError?.("FLOW_ASSET_SCAN_INCOMPLETE", "Flow's media library has no scroll container, so a complete upload baseline cannot be proven; no upload was started.", true, false) || new Error("Flow media library scan was incomplete.");
        }
        const matches = rememberVisible();
        if (options.exactName && matches.length !== 1) {
          options.onDiagnostics?.({ steps: scanSteps, uniqueTiles: byIdentity.size, reachedEnd: false, exactMatchCount: matches.length });
          throw root.flowError?.("FLOW_ASSET_NOT_FOUND", `No exact Flow asset titled "${options.exactName}" was found.`, true, true) || new Error("Flow asset was not found.");
        }
        const output = [...byIdentity.values()];
        const owners = output.filter(asset => asset.id && hasBaselineIds && !baselineIds.has(String(asset.id)) && ownerKindMatches(asset));
        if (owners.length > 1) throw root.flowError?.("FLOW_UPLOAD_TILE_AMBIGUOUS", "More than one new Flow media tile appeared during upload confirmation.", false, true) || new Error("Ambiguous new Flow media tiles.");
        if (owners.length === 1 && owners[0].kind && owners[0].ready) { targetFound = true; targetScrollTop = owners[0]._scrollTop; }
        const result = output.map(({ busy, ready, error, _scrollTop, ...asset }) => ({
          ...asset,
          ...(options.exactName || options.includeIncomplete ? { busy } : {}),
          ...(options.includeIncomplete ? { ready, error } : {}),
          ...(hasBaselineIds && asset.id ? { newSinceBaseline: !baselineIds.has(String(asset.id)) } : {}),
        }));
        options.onDiagnostics?.({ steps: scanSteps, uniqueTiles: output.length, reachedEnd: false });
        return result;
      }
      container.scrollTop = 0;
      await boundedWait(350);
      let unchanged = 0;
      let reachedEnd = false;
      for (let step = 0; step < 80; step++) {
        scanSteps++;
        checkActive();
        const matches = rememberVisible();
        if (options.exactName && matches.length === 1) break;
        if (byIdentity.size >= maxItems) break;
        const before = container.scrollTop;
        const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
        if (before >= maxTop - 2) { reachedEnd = true; break; }
        container.scrollTop = Math.min(maxTop, before + Math.max(200, container.clientHeight * 0.78));
        await boundedWait(300);
        if (container.scrollTop <= before) {
          unchanged++;
          if (unchanged >= 3) { reachedEnd = container.scrollTop >= maxTop - 2; break; }
        } else unchanged = 0;
      }
      const matches = rememberVisible();
      if (options.exactName && matches.length !== 1) {
        options.onDiagnostics?.({ steps: scanSteps, uniqueTiles: byIdentity.size, reachedEnd, exactMatchCount: matches.length });
        throw root.flowError?.("FLOW_ASSET_NOT_FOUND", `No exact Flow asset titled "${options.exactName}" was found before the scan deadline.`, true, true) || new Error("Flow asset was not found.");
      }
      if (options.requireComplete && !reachedEnd && !options.exactName) {
        throw root.flowError?.("FLOW_ASSET_SCAN_INCOMPLETE", "Flow's media library could not be fully scanned before the upload baseline deadline; no upload was started.", true, false) || new Error("Flow media library scan was incomplete.");
      }
      const output = [...byIdentity.values()];
      const owners = output.filter(asset => asset.id && hasBaselineIds && !baselineIds.has(String(asset.id)) && ownerKindMatches(asset));
      if (owners.length > 1) throw root.flowError?.("FLOW_UPLOAD_TILE_AMBIGUOUS", "More than one new Flow media tile appeared during upload confirmation.", false, true) || new Error("Ambiguous new Flow media tiles.");
      if (owners.length === 1 && owners[0].kind && owners[0].ready) { targetFound = true; targetScrollTop = owners[0]._scrollTop; }
      const result = output.map(({ busy, ready, error, _scrollTop, ...asset }) => ({
        ...asset,
        ...(options.exactName || options.includeIncomplete ? { busy } : {}),
        ...(options.includeIncomplete ? { ready, error } : {}),
        ...(hasBaselineIds && asset.id ? { newSinceBaseline: !baselineIds.has(String(asset.id)) } : {}),
      }));
      options.onDiagnostics?.({ steps: scanSteps, uniqueTiles: output.length, reachedEnd, truncated: !reachedEnd && output.length >= maxItems });
      return result;
    } finally {
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", onExternalAbort);
      const current = gridScroller();
      if (current && originalContainer === current) {
        if (options.keepPositionOnMatch && targetFound && Number.isFinite(targetScrollTop)) current.scrollTop = targetScrollTop;
        else if (!(options.keepPositionOnMatch && targetFound)) current.scrollTop = originalTop;
      }
    }
  }

  // Toby's gallery scanner returns a stable, rich record instead of exposing
  // only the currently mounted tile nodes.  Keep the existing array API for
  // library workflows and expose this explicit DOM scanner for callers that
  // need thumbnails, video URLs, and a completeness signal.
  async function scanGalleryTiles(options = {}) {
    const startedAt = Date.now();
    const deep = options.deep === true || options.requireComplete === true;
    const maxDurationMs = Math.max(1000, Math.min(30_000, Number(options.maxDurationMs) || (deep ? 25_000 : 12_000)));
    const tiles = await scanNativeAssets({
      ...options,
      includeIncomplete: true,
      requireComplete: deep,
      maxDurationMs,
    });
    const normalized = (Array.isArray(tiles) ? tiles : []).map(tile => ({
      ...tile,
      fileId: tile.fileId || tile.id || null,
      file_id: tile.fileId || tile.id || null,
      persistentMediaId: tile.persistentMediaId || tile.id || null,
      persistent_media_id: tile.persistentMediaId || tile.id || null,
      identityDurability: tile.identityDurability || (tile.id ? "persistent" : "title_only"),
      identity_durability: tile.identityDurability || (tile.id ? "persistent" : "title_only"),
      type: tile.type || tile.kind || "image",
      thumbnail: tile.thumbnail || tile.thumbnailUrl || null,
      video_url: tile.video_url || tile.videoUrl || null,
      src: tile.src || null,
      display_name: tile.displayName || tile.name || "",
      file_name: tile.fileName || tile.name || "",
      project_id: tile.projectId || (root.ProviderRegistry || root.FlowDriverRegistry)?.describeUrl?.(location.href)?.projectId || null,
    }));
    return {
      tiles: normalized,
      images: normalized,
      count: normalized.length,
      deepScan: deep,
      deepRequested: deep,
      deepScanComplete: true,
      timing: {
        startedAt,
        durationMs: Date.now() - startedAt,
        totalMs: Date.now() - startedAt,
        configMs: 0,
        initialDomMs: 0,
      },
      mountedTileCount: ((typeof root.flowQueryAll === "function" ? root.flowQueryAll("tiles.container", document, { checkVisible: false }) : null) || [...document.querySelectorAll("flow-grid-tile-container")]).length,
      source: "flow_dom_gallery",
    };
  }

  let lastCharacterScanDiagnostics = null;

  function characterLibrarySnapshot(container = root.FlowCharacterActions?.characterLibraryScrollContainer?.()) {
    const pathname = location.pathname || "";
    const project = (root.ProviderRegistry || root.FlowDriverRegistry)?.describeUrl?.(location.href) || null;
    const tiles = (typeof root.flowQueryAll === "function" ? root.flowQueryAll("components.characterTile", document, { checkVisible: false }) : null) ||
      [...document.querySelectorAll("flow-character-tile")];
    const visibleTiles = tiles.filter(tile => root.visible?.(tile) !== false);
    const loadingCount = [...document.querySelectorAll('[role="progressbar"],[aria-busy="true"]')]
      .filter(el => root.visible?.(el) !== false).length;
    const nav = root.FlowNavigation?.flowNavigationItem?.("Characters") || root.flowNavigationItem?.("Characters") || null;
    const navText = String(nav?.innerText || nav?.textContent || root.accessibleName?.(nav) || "").replace(/\s+/g, " ").trim();
    const navClass = String(nav?.className?.baseVal || nav?.className || "");
    const navActive = Boolean(nav && (
      /^(?:page|true)$/i.test(nav.getAttribute?.("aria-current") || "") ||
      nav.getAttribute?.("aria-selected") === "true" ||
      nav.getAttribute?.("aria-pressed") === "true" ||
      /^(?:active|selected)$/i.test(nav.getAttribute?.("data-state") || "") ||
      /(?:^|\s)(?:active|selected|current|is-active|mat-mdc-nav-list-item-active)(?:\s|$)/i.test(navClass)
    ));
    const createAction = [...document.querySelectorAll("flow-custom-tile")].some(tile => {
      if (root.visible?.(tile) === false) return false;
      const hasAddIcon = [...(tile.querySelectorAll?.("mat-icon") || [])]
        .some(icon => /^(?:add|add_circle)$/i.test(String(icon.innerText || icon.textContent || "").trim()));
      const text = String(tile.innerText || tile.textContent || "").replace(/\s+/g, " ").trim();
      return hasAddIcon && /(?:new character|create character|nhân vật mới|tạo nhân vật)/i.test(text);
    });
    const explicitEmpty = [...document.querySelectorAll('[role="status"],[role="alert"],[aria-live]')]
      .filter(el => root.visible?.(el) !== false)
      .some(el => /(?:no characters(?: found)?|you have no characters|không có nhân vật|chưa có nhân vật)/i.test(el.innerText || el.textContent || ""));
    const routeIsCharacterForm = /\/character(?:\/|$)/i.test(pathname);
    const activeEvidence = [];
    if (navActive) activeEvidence.push("characters_navigation_active");
    if (createAction) activeEvidence.push("new_character_action");
    if (visibleTiles.length && !routeIsCharacterForm) activeEvidence.push("character_tiles_visible");
    if (explicitEmpty && navActive) activeEvidence.push("explicit_empty_state_in_active_section");
    return {
      url: location.href,
      route: pathname,
      projectId: project?.projectId || null,
      currentSection: activeEvidence.length ? "Characters" : null,
      sectionActive: activeEvidence.length > 0,
      activeEvidence,
      routeIsCharacterForm,
      navigation: nav ? {
        text: navText.slice(0, 100),
        ariaCurrent: nav.getAttribute?.("aria-current") || null,
        ariaSelected: nav.getAttribute?.("aria-selected") || null,
        ariaPressed: nav.getAttribute?.("aria-pressed") || null,
        dataState: nav.getAttribute?.("data-state") || null,
        className: navClass.slice(0, 120),
      } : null,
      createActionVisible: createAction,
      explicitEmptyState: explicitEmpty,
      visibleTileCount: visibleTiles.length,
      totalTileCount: tiles.length,
      loadingCount,
      scrollContainer: container ? {
        tag: container.tagName?.toLowerCase() || null,
        className: String(container.className?.baseVal || container.className || "").slice(0, 120),
        scrollTop: Number(container.scrollTop) || 0,
        clientHeight: Number(container.clientHeight) || 0,
        scrollHeight: Number(container.scrollHeight) || 0,
        connected: container.isConnected !== false,
      } : null,
    };
  }

  function characterScanError(code, message, snapshot) {
    lastCharacterScanDiagnostics = { ...snapshot, result: "incomplete", scanComplete: false, errorCode: code, checkedAt: new Date().toISOString() };
    const error = root.flowError?.(code, message, true, false) || new Error(message);
    error.diagnostics = JSON.parse(JSON.stringify(lastCharacterScanDiagnostics));
    throw error;
  }

  async function scanNativeCharacters(options = {}) {
    const deadline = Math.min(Number(options.deadline) || Infinity, Date.now() + 45_000);
    const requireTime = (operation = "scanning Flow characters") => {
      if (Date.now() >= deadline) {
        const snapshot = characterLibrarySnapshot(container);
        characterScanError("FLOW_CHARACTER_SCAN_INCOMPLETE", `Flow character library scan did not complete while ${operation}; no empty or partial list was returned. Diagnostics: ${JSON.stringify(snapshot).slice(0, 1200)}`, snapshot);
      }
    };
    const boundedWait = async (ms, operation) => {
      requireTime(operation);
      const remaining = deadline - Date.now();
      await root.wait?.(Math.max(1, Math.min(ms, remaining)));
      requireTime(operation);
    };
    requireTime("opening the Characters library");
    const charactersByIdentity = new Map();
    let container = null;
    let originalTop = 0;
    try {
      await root.ensureFlowLibrarySection?.("Characters", { deadline, signal: options.signal });
      requireTime("opening the Characters library");
      // Resolve the scroller only after navigation. The project editor's old
      // scroll element can be detached when the Characters surface mounts.
      container = root.FlowCharacterActions?.characterLibraryScrollContainer?.() || null;
      originalTop = container?.scrollTop ?? 0;
      if (container) container.scrollTop = 0;
      const readyDeadline = Math.min(deadline, Date.now() + 10_000);
      let stableSince = null;
      let stableSignature = "";
      let librarySettled = false;
      let settledEmpty = false;
      let latest = characterLibrarySnapshot(container);
      while (Date.now() < readyDeadline) {
        latest = characterLibrarySnapshot(container);
        if (!latest.sectionActive || latest.routeIsCharacterForm) {
          stableSince = null;
          stableSignature = "";
          await boundedWait(200, "confirming the active Characters library");
          continue;
        }
        if (latest.loadingCount > 0) {
          stableSince = null;
          stableSignature = "";
          await boundedWait(200, "waiting for the Characters library to finish loading");
          continue;
        }
        if (latest.visibleTileCount > 0) {
          const signature = `${latest.projectId}|${latest.route}|${latest.visibleTileCount}|${latest.activeEvidence.join(",")}`;
          if (signature !== stableSignature) { stableSignature = signature; stableSince = Date.now(); }
          if (stableSince !== null && Date.now() - stableSince >= 500) { librarySettled = true; break; }
        } else {
          // An empty result is valid only in a verified Characters surface,
          // after its controls/state remain stable for a full load window.
          // Without an explicit empty-state message, require the section's
          // New character action as the empty-library marker.
          const canProveEmpty = latest.explicitEmptyState || latest.createActionVisible;
          const signature = `${latest.projectId}|${latest.route}|${latest.activeEvidence.join(",")}|${latest.explicitEmptyState}|${latest.createActionVisible}`;
          if (signature !== stableSignature) { stableSignature = signature; stableSince = Date.now(); }
          const stableMs = stableSince === null ? 0 : Date.now() - stableSince;
          if (canProveEmpty && stableMs >= 3000) { librarySettled = true; settledEmpty = true; break; }
        }
        await boundedWait(150, "waiting for the Characters library to settle");
      }
      if (!librarySettled) {
        latest = characterLibrarySnapshot(container);
        characterScanError("FLOW_CHARACTER_SCAN_INCOMPLETE", `Flow's Characters section could not be verified as active and settled; no empty or partial list was returned. Diagnostics: ${JSON.stringify(latest).slice(0, 1200)}`, latest);
      }
      latest = characterLibrarySnapshot(container);
      if (!latest.sectionActive || latest.routeIsCharacterForm || latest.loadingCount > 0) {
        characterScanError("FLOW_CHARACTER_SCAN_INCOMPLETE", `Flow's Characters section changed before scanning began; no list was returned. Diagnostics: ${JSON.stringify(latest).slice(0, 1200)}`, latest);
      }
      lastCharacterScanDiagnostics = { ...latest, result: settledEmpty ? "confirmed_empty" : "scanning", scanComplete: false, checkedAt: new Date().toISOString() };
      options.onDiagnostics?.(JSON.parse(JSON.stringify(lastCharacterScanDiagnostics)));

      const documentScroller = document.scrollingElement || document.documentElement;
      let reachedEnd = Boolean(container) || Boolean(documentScroller && Number.isFinite(documentScroller.scrollHeight) && Number.isFinite(documentScroller.clientHeight) && documentScroller.scrollHeight <= documentScroller.clientHeight + 2);
      if (!reachedEnd) {
        characterScanError("FLOW_CHARACTER_SCAN_INCOMPLETE", "Flow's Characters library has no verified scroll container or settled non-scrollable document; no complete list was returned.", characterLibrarySnapshot(container));
      }
      let step = 0;
      while (container && step < 100 && Date.now() < deadline) {
        step++;
        requireTime("scanning the Characters library");
        const charTiles = (typeof root.flowQueryAll === "function" ? root.flowQueryAll("components.characterTile", document, { checkVisible: false }) : null) ||
          document.querySelectorAll("flow-character-tile");
        collectVisibleCharacterTiles(charTiles, charactersByIdentity, container);
        const before = container.scrollTop;
        const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
        if (before >= maxTop - 2) { reachedEnd = true; break; }
        container.scrollTop = Math.min(maxTop, before + Math.max(200, container.clientHeight * 0.78));
        await boundedWait(400, "scanning the Characters library");
        if (container.scrollTop <= before) {
          characterScanError("FLOW_CHARACTER_SCAN_INCOMPLETE", "Flow's character library stopped scrolling before its end; no complete list was returned.", characterLibrarySnapshot(container));
        }
      }
      requireTime("scanning the Characters library");
      if (!reachedEnd) {
        characterScanError("FLOW_CHARACTER_SCAN_LIMIT", "Flow's Characters library exceeded the scan page limit; no partial list was returned.", characterLibrarySnapshot(container));
      }
      const finalCharTiles = (typeof root.flowQueryAll === "function" ? root.flowQueryAll("components.characterTile", document, { checkVisible: false }) : null) ||
        document.querySelectorAll("flow-character-tile");
      collectVisibleCharacterTiles(finalCharTiles, charactersByIdentity, container);
      const finalSnapshot = characterLibrarySnapshot(container);
      if (!finalSnapshot.sectionActive || finalSnapshot.routeIsCharacterForm || finalSnapshot.loadingCount > 0) {
        characterScanError("FLOW_CHARACTER_SCAN_INCOMPLETE", `Flow's Characters section changed during the scan; no list was returned. Diagnostics: ${JSON.stringify(finalSnapshot).slice(0, 1200)}`, finalSnapshot);
      }
      const characters = [...charactersByIdentity.values()];
      const result = characters.length ? "complete" : "confirmed_empty";
      lastCharacterScanDiagnostics = {
        ...finalSnapshot,
        result,
        scanComplete: true,
        nameCount: characters.length,
        stableUuidCount: characters.filter(character => character.uuid).length,
        checkedAt: new Date().toISOString(),
      };
      options.onDiagnostics?.(JSON.parse(JSON.stringify(lastCharacterScanDiagnostics)));
      return characters;
    } finally {
      if (container) container.scrollTop = originalTop;
      if (/\/character\/?$/i.test(location.pathname)) {
        const back = root.flowButton?.("Go back");
        if (back) {
          back.click();
          const cleanupTimeout = Math.max(1, Math.min(3000, deadline - Date.now()));
          await root.waitForFlowRoute?.(path => !/\/character\/?$/i.test(path), cleanupTimeout, "Flow did not leave the empty character chooser.").catch(() => {});
        }
      }
      if (root.clickFlowNavigation?.("All media") && Date.now() < deadline) await boundedWait(300, "returning to All media");
    }
  }

  function cleanCharacterName(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\b(accessibility_new|person|movie|image|videocam|mic)\b/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function readCharacterIdentity(tile) {
    const name = cleanCharacterName(tile?.innerText || tile?.textContent || "");
    if (!name) return null;
    // The portrait's media UUID identifies its image, not the saved character.
    // data-id is accepted only here because this scanner receives the actual
    // flow-character-tile element, where it identifies the character entity.
    const candidates = [
      String(tile?.tagName || "").toLowerCase() === "flow-character-tile" ? tile.getAttribute?.("data-id") : null,
      tile.getAttribute?.("data-character-id"),
      tile.getAttribute?.("data-character-uuid"),
      tile.querySelector?.("[data-character-id]")?.getAttribute?.("data-character-id"),
      tile.querySelector?.("[data-character-uuid]")?.getAttribute?.("data-character-uuid"),
    ];
    const uuid = candidates.find(value => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))?.toLowerCase();
    const imageRoots = [tile];
    const visitedRoots = new Set();
    const images = [];
    while (imageRoots.length) {
      const current = imageRoots.shift();
      if (!current?.querySelectorAll || visitedRoots.has(current)) continue;
      visitedRoots.add(current);
      images.push(...current.querySelectorAll("img"));
      for (const element of current.querySelectorAll("*")) if (element.shadowRoot) imageRoots.push(element.shadowRoot);
    }
    let thumbnailUrl = images.map(image => image.currentSrc || image.getAttribute("src") || "")
      .find(value => value && !/^(?:data:|blob:|chrome-extension:)/i.test(value) && !/(?:placeholder|spinner|loading|skeleton)/i.test(value)) || "";
    if (thumbnailUrl) {
      try {
        const parsed = new URL(thumbnailUrl, location.href);
        thumbnailUrl = parsed.protocol === "https:" ? parsed.href : "";
      } catch { thumbnailUrl = ""; }
    }
    // A portrait URL is returned only as display data and is never treated as
    // the character entity's UUID.
    return { name, ...(uuid ? { uuid } : {}), ...(thumbnailUrl ? { thumbnailUrl } : {}) };
  }

  function collectVisibleCharacterTiles(tiles, target, container) {
    for (const tile of tiles) {
      if (root.visible?.(tile) === false) continue;
      const character = readCharacterIdentity(tile);
      if (!character) {
        characterScanError("FLOW_CHARACTER_SCAN_INVALID_RESULT", "A visible Flow character tile did not expose a usable name; the library scan is incomplete.", characterLibrarySnapshot(container));
      }
      target.set(character.uuid || `name:${character.name.toLocaleLowerCase()}`, character);
    }
  }

  function nativeRead(name) {
    if (name === "flowState") {
      const url = location.href;
      const desc = root.ProviderRegistry?.describeUrl?.(url) || root.FlowDriverRegistry?.describeUrl?.(url) || null;
      const screen = root.FlowScreenState?.inspect?.() || null;
      const signedIn = screen?.state === "signed_out" ? false : !/accounts\.google\.com/.test(url);
      const inProject = Boolean(desc?.projectId);
      const isProjectEditor = Boolean(desc?.isProjectEditor);
      const state = { url, signedIn, inProject, isProjectEditor, projectId: desc?.projectId || null };
      if (screen) state.screen = screen;
      // Read-only audit data helps distinguish a stale content-script bundle,
      // an unrecognized V2 trigger, and a disabled control before upload code
      // is allowed to open the picker or select a file.
      state.uploadControlDiagnostics = root.FlowComponents?.inspectUploadTrigger?.() || null;
      state.framePickerDiagnostics = root.FlowComponents?.inspectFramePickerDiagnostics?.() || null;
      state.referenceClearDiagnostics = root.inspectFlowReferenceClearDiagnostics?.() || null;
      state.referenceActionDiagnostics = root.FlowReferenceActions?.inspectDiagnostics?.() || null;
      state.characterNameDiagnostics = root.FlowCharacterActions?.inspectNameDiagnostics?.() || null;
      state.characterListDiagnostics = lastCharacterScanDiagnostics ? JSON.parse(JSON.stringify(lastCharacterScanDiagnostics)) : null;
      state.imageSettingsDiagnostics = root.FlowSettings?.inspectImagePreparationDiagnostics?.() || null;
      state.videoSettingsDiagnostics = root.FlowSettings?.inspectVideoPreparationDiagnostics?.() || null;
      const visibleSubmitWarnings = root.FlowEditor?.currentFlowSubmitErrors?.() || [];
      if (visibleSubmitWarnings.length) state.submitWarnings = visibleSubmitWarnings;
      if (!signedIn) state.hint = "Not signed in. Sign in to Google in the Flow Chrome tab.";
      else if (!inProject) state.hint = "Signed in, but no project is open. Open or create a Flow project.";
      else if (!isProjectEditor) state.hint = "Flow is not in project editor view. Recovering to project root...";
      return state;
    }
    if (name === "assets") return scanNativeAssets();
    if (name === "characters") return scanNativeCharacters();
    throw new Error(`Unsupported native read: ${name}`);
  }

  async function scanNativeProjects() {
    const homeUrl = location.href;
    const projectLinks = () => [...((typeof root.flowQueryAll === "function" ? root.flowQueryAll("navigation.projectLinks", document, { checkVisible: false }) : null) || document.querySelectorAll('a[href*="/project/"]'))]
      .filter(link => {
        try { return new URL(link.href).origin === location.origin && /\/project\/[0-9a-f-]{36}(?:[/?#]|$)/i.test(new URL(link.href).pathname + new URL(link.href).search); }
        catch { return false; }
      });
    const cardsDeadline = Date.now() + 15000;
    while (!projectLinks().length && Date.now() < cardsDeadline) {
      if (location.href !== homeUrl) throw root.flowError("FLOW_EXECUTION_TARGET_CHANGED", "Flow navigated while project cards were loading.", true);
      await root.wait?.(250);
    }
    const first = projectLinks()[0];
    let scroller = null;
    for (let parent = first?.parentElement, depth = 0; parent && parent !== document.body && depth < 12; parent = parent.parentElement, depth++) {
      const style = getComputedStyle(parent);
      if ((style.overflowY === "auto" || style.overflowY === "scroll") && parent.scrollHeight > parent.clientHeight + 4) { scroller = parent; break; }
    }
    const scrolling = document.scrollingElement || document.documentElement;
    const top = () => scroller ? scroller.scrollTop : window.scrollY || scrolling.scrollTop || 0;
    const max = () => scroller ? scroller.scrollHeight - scroller.clientHeight : scrolling.scrollHeight - window.innerHeight;
    const scrollTo = value => scroller ? (scroller.scrollTop = value) : window.scrollTo(0, value);
    const originalTop = top();
    let lastCount = projectLinks().length, stable = 0;
    for (let step = 0; step < 20; step++) {
      if (location.href !== homeUrl) throw root.flowError("FLOW_EXECUTION_TARGET_CHANGED", "Flow navigated while project cards were loading.", true);
      const before = top();
      scrollTo(max() + 1000);
      await root.wait?.(400);
      const count = projectLinks().length;
      const moved = top() > before + 2;
      if (count <= lastCount && !moved) { if (++stable >= 2) break; } else stable = 0;
      lastCount = count;
    }
    scrollTo(originalTop);
    await root.wait?.(120);
    const seen = new Set();
    const projects = [];
    for (const link of projectLinks()) {
      const url = new URL(link.href);
      const match = url.pathname.match(/\/project\/([0-9a-f-]{36})(?:\/|$)/i);
      const id = match?.[1];
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const name = (link.innerText || link.textContent || root.accessibleName?.(link) || "").replace(/\s+/g, " ").trim();
      projects.push({ id, name });
    }
    return projects;
  }

  const FlowMediaMenu = Object.freeze({
    triggerFlowDownload,
    downloadTileIdentityAliases,
    downloadTileMatchesIdentity,
    downloadTileLoadError,
    currentDownloadProjectId,
    DOWNLOAD_TILE_SWEEP_COOLDOWN_MS,
    DOWNLOAD_TILE_RECOVERY_TIMEOUT_MS,
    resolveWatermarkArm,
    watermarkMaskHasAlpha,
    sniffMediaBytes,
    directBytesTargetUrl,
    scanNativeAssets,
    scanGalleryTiles,
    scanNativeProjects,
    scanNativeCharacters,
    collectAssets,
    nativeRead,
    inspectCharacterScanDiagnostics: () => lastCharacterScanDiagnostics ? JSON.parse(JSON.stringify(lastCharacterScanDiagnostics)) : null,
  });

  root.FlowMediaMenu = FlowMediaMenu;
  root.triggerFlowDownload = triggerFlowDownload;
  root.scanNativeAssets = scanNativeAssets;
  root.scanGalleryTiles = scanGalleryTiles;
  root.scanNativeProjects = scanNativeProjects;
  root.scanNativeCharacters = scanNativeCharacters;
  root.nativeRead = nativeRead;
  root.collectAssets = collectAssets;
})(globalThis);
