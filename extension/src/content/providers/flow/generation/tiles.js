(function (root) {
  "use strict";

  const FLOW_CORRELATION_ARM_EVENT = "TOBY_FLOW_CORRELATION_ARM";
  const FLOW_CORRELATION_DISARM_EVENT = "TOBY_FLOW_CORRELATION_DISARM";
  const FLOW_CORRELATION_RECEIPT_EVENT = "TOBY_FLOW_CORRELATION_RECEIPT";
  const FLOW_CORRELATION_HEALTH_READ_EVENT = "TOBY_FLOW_CORRELATION_HEALTH_READ";
  const FLOW_CORRELATION_HEALTH_RESPONSE_EVENT = "TOBY_FLOW_CORRELATION_HEALTH_RESPONSE";

  const nativeFlowTileClaims = globalThis.__flowNativeTileClaims instanceof Map
    ? globalThis.__flowNativeTileClaims
    : (globalThis.__flowNativeTileClaims = new Map());

  function nativeFlowCorrelationMap() {
    if (!(globalThis.__flowNativeGenerationCorrelations instanceof Map)) {
      globalThis.__flowNativeGenerationCorrelations = new Map();
    }
    return globalThis.__flowNativeGenerationCorrelations;
  }

  function flowPromptFingerprint(value) {
    const normalized = String(value || "").normalize("NFKC").trim().replace(/\s+/g, " ");
    let hash = 2166136261;
    for (let index = 0; index < normalized.length; index++) {
      hash ^= normalized.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `id-${(hash >>> 0).toString(16).padStart(8, "0")}`;
  }

  function readMainWorldCorrelationHealth(timeoutMs = 500) {
    const nonce = crypto.randomUUID();
    return new Promise(resolve => {
      let settled = false;
      let timer;
      const finish = value => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        window.removeEventListener(FLOW_CORRELATION_HEALTH_RESPONSE_EVENT, onResponse);
        resolve(value);
      };
      const onResponse = event => {
        const detail = event?.detail;
        if (!detail || detail.nonce !== nonce) return;
        const { nonce: _nonce, ...health } = detail;
        finish(health);
      };
      timer = setTimeout(() => finish(null), Math.max(50, timeoutMs));
      window.addEventListener(FLOW_CORRELATION_HEALTH_RESPONSE_EVENT, onResponse);
      window.dispatchEvent(new CustomEvent(FLOW_CORRELATION_HEALTH_READ_EVENT, { detail: { nonce } }));
    });
  }

  // VID-03: correlation expectations are optional at every layer. They are
  // normalised here with exactly the rules the observer applies when storing
  // the attempt (model key charset, ratio enum clamped to 1..16) and are
  // included in the arm detail only when valid, so an arm that carries no
  // expectation produces the historical detail byte-for-byte.
  function correlationModelKey(value) {
    return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value) ? value : undefined;
  }

  function correlationRatioEnum(value) {
    return value != null && Number.isInteger(Number(value))
      ? Math.max(1, Math.min(16, Number(value)))
      : undefined;
  }

  async function armNativeFlowCorrelation({
    projectId,
    mediaType,
    prompt,
    expectedQuantity,
    expectedReferenceIds = [],
    expectedMediaReferenceIds = [],
    expectedCharacterIds = [],
    expectedVoiceCount = 0,
    unverifiedMediaCount = 0,
    expectedVideoModelKey,
    expectedVideoRatioEnum,
    expectedImageModelKey,
  }) {
    if (!projectId || !["image", "video"].includes(mediaType)) return null;
    const videoModelKey = correlationModelKey(expectedVideoModelKey);
    const videoRatioEnum = correlationRatioEnum(expectedVideoRatioEnum);
    const imageModelKey = correlationModelKey(expectedImageModelKey);
    const expectationDetail = {
      ...(videoModelKey !== undefined ? { expectedVideoModelKey: videoModelKey } : {}),
      ...(videoRatioEnum !== undefined ? { expectedVideoRatioEnum: videoRatioEnum } : {}),
      ...(imageModelKey !== undefined ? { expectedImageModelKey: imageModelKey } : {}),
    };
    const attemptId = crypto.randomUUID();
    const nonce = crypto.randomUUID();
    const entry = { attemptId, nonce, projectId, mediaType, receipts: [], listener: null, armed: false, armedAt: Date.now(), requestSeen: false, useTilesFallback: false };
    const armed = new Promise(resolve => {
      const timer = setTimeout(() => resolve(false), 500);
      entry.listener = event => {
        const receipt = event.detail;
        if (
          receipt?.schemaVersion !== 1 ||
          receipt?.nonce !== nonce ||
          receipt?.attemptId !== attemptId
        ) return;
        entry.receipts.push(receipt);
        if (receipt.stage === "request_seen") entry.requestSeen = true;
        if (receipt.stage === "armed") {
          // The service worker may have repaired the observer before this
          // command started, but Flow can replace its global transport hooks
          // while settings and references are being prepared. The MAIN-world
          // receipt captures the hook state at the actual arm boundary; do not
          // deliver the submit click unless both transports are still patched.
          entry.armed = !receipt.reason && receipt.projectId === projectId && receipt.mediaType === mediaType &&
            receipt.xhrHookActive === true && receipt.fetchHookActive === true;
          clearTimeout(timer);
          resolve(entry.armed);
        }
        if (receipt.reason === "trusted_interaction_before_request") entry.interfered = true;
      };
      window.addEventListener(FLOW_CORRELATION_RECEIPT_EVENT, entry.listener);
      // Also listen to legacy event name if needed
      window.addEventListener("TOBY_FLOW_V2_CORRELATION_RECEIPT", entry.listener);
    });
    window.dispatchEvent(new CustomEvent(FLOW_CORRELATION_ARM_EVENT, {
      detail: {
        schemaVersion: 1,
        nonce,
        attemptId,
        projectId,
        mediaType,
        expectedQuantity,
        promptFingerprint: flowPromptFingerprint(prompt),
        expectedReferenceIds,
        expectedMediaReferenceIds,
        expectedCharacterIds,
        expectedVoiceCount: Math.max(0, Math.min(1, Number(expectedVoiceCount) || 0)),
        unverifiedMediaCount: Math.max(0, Number(unverifiedMediaCount) || 0),
        expectedGlobalCharacter: false,
        strictDispatch: true,
        ttlMs: 15 * 60_000,
        ...expectationDetail,
      },
    }));
    if (!(await armed)) {
      root.__flowNativeCorrelationArmDiagnostics = {
        requestedAt: new Date(entry.armedAt).toISOString(),
        result: "not_armed",
        expected: { projectId, mediaType, promptFingerprint: flowPromptFingerprint(prompt), ...expectationDetail },
        receipt: entry.receipts.find(receipt => receipt?.stage === "armed") || null,
        timeoutMs: 500,
      };
      window.removeEventListener(FLOW_CORRELATION_RECEIPT_EVENT, entry.listener);
      window.removeEventListener("TOBY_FLOW_V2_CORRELATION_RECEIPT", entry.listener);
      window.dispatchEvent(new CustomEvent(FLOW_CORRELATION_DISARM_EVENT, {
        detail: { nonce, attemptId, dispatched: false, discardOnStop: true },
      }));
      return null;
    }
    nativeFlowCorrelationMap().set(attemptId, entry);
    root.__flowNativeCorrelationArmDiagnostics = {
      requestedAt: new Date(entry.armedAt).toISOString(),
      result: "armed",
      expected: { projectId, mediaType, promptFingerprint: flowPromptFingerprint(prompt), ...expectationDetail },
      receipt: entry.receipts.find(receipt => receipt?.stage === "armed") || null,
      timeoutMs: 500,
    };
    return attemptId;
  }

  async function inspectNativeFlowCorrelationObserver() {
    const registry = root.ProviderRegistry || root.FlowDriverRegistry;
    const described = registry?.describeUrl?.(location.href) || null;
    const pageProjectId = described?.projectId || null;
    const observer = await readMainWorldCorrelationHealth();
    const diagnostics = {
      pageProjectId,
      descriptor: described ? {
        driverKey: described.driverKey || described.key || null,
        origin: described.origin || null,
        routePrefix: described.routePrefix || "",
      } : null,
      observer,
      projectMatch: Boolean(pageProjectId && observer?.projectId === pageProjectId),
      armPreflight: null,
    };
    if (!observer) {
      diagnostics.armPreflight = { result: "skipped", reason: "observer_health_timeout" };
      return diagnostics;
    }
    if (!observer.ready || !diagnostics.projectMatch) {
      diagnostics.armPreflight = {
        result: "skipped",
        reason: !observer.ready ? "observer_not_ready" : "project_id_mismatch",
      };
      return diagnostics;
    }
    if (Number(observer.activeAttempts) > 0) {
      diagnostics.armPreflight = { result: "skipped", reason: "observer_has_active_attempts" };
      return diagnostics;
    }
    const probePrompt = `Read-only Flow correlation observer preflight ${crypto.randomUUID()}`;
    const attemptId = await armNativeFlowCorrelation({
      projectId: pageProjectId,
      mediaType: "image",
      prompt: probePrompt,
      expectedQuantity: 1,
      expectedReferenceIds: [],
      expectedMediaReferenceIds: [],
      expectedCharacterIds: [],
    });
    const armDiagnostics = root.__flowNativeCorrelationArmDiagnostics || null;
    if (attemptId) disarmNativeFlowCorrelation(attemptId);
    diagnostics.armPreflight = {
      result: attemptId ? "armed_and_disarmed" : armDiagnostics?.result || "not_armed",
      expected: armDiagnostics?.expected || null,
      receipt: armDiagnostics?.receipt || null,
      reason: armDiagnostics?.receipt?.reason || null,
    };
    return diagnostics;
  }

  async function readNativeFlowCorrelationHealth() {
    const health = await readMainWorldCorrelationHealth();
    if (!health || typeof health !== "object") return null;
    const events = Array.isArray(health.requestDiagnostics?.events) ? health.requestDiagnostics.events.slice(-32) : [];
    const safeEvents = events.map(entry => ({
      observedAt: typeof entry.observedAt === "string" ? entry.observedAt.slice(0, 40) : null,
      mediaType: ["image", "video"].includes(entry.mediaType) ? entry.mediaType : "unknown",
      transport: ["xhr", "fetch"].includes(entry.transport) ? entry.transport : "unknown",
      payloadVersion: Number.isFinite(entry.payloadVersion) ? entry.payloadVersion : null,
      payloadShape: typeof entry.payloadShape === "string" ? entry.payloadShape.slice(0, 80).replace(/[^a-zA-Z0-9_.:-]/g, "") : null,
      pathClass: /image/i.test(String(entry.path || "")) ? "image" : /video/i.test(String(entry.path || "")) ? "video" : "other",
      pathRecognized: entry.pathRecognized === true,
      payloadMatched: entry.payloadMatched === true,
      fields: Object.fromEntries(Object.entries(entry.fields || {}).slice(0, 32).map(([key, value]) => [String(key).replace(/[^a-zA-Z0-9_]/g, "").slice(0, 40), Boolean(value)])),
      reasons: Array.isArray(entry.reasons) ? entry.reasons.slice(0, 16).map(reason => String(reason).replace(/[^A-Z0-9_]/gi, "").slice(0, 64)) : [],
    }));
    return {
      ready: health.ready === true,
      xhrHookActive: health.xhrHookActive === true,
      fetchHookActive: health.fetchHookActive === true,
      requestDiagnostics: { version: 1, count: safeEvents.length, events: safeEvents },
    };
  }

  function nativeFlowCorrelationReceipt(attemptId) {
    const entry = nativeFlowCorrelationMap().get(String(attemptId || ""));
    if (!entry) return null;
    return [...entry.receipts].reverse().find(receipt =>
      ["response_seen", "result_seen"].includes(receipt.stage) &&
      ((Array.isArray(receipt.mediaIds) && receipt.mediaIds.length > 0) ||
        (Array.isArray(receipt.children) && receipt.children.some(child => child?.status === "failed")))
    ) || null;
  }

  // VID-06: receipt stages that prove Flow's server accepted a dispatch,
  // in the correlation observer's stage vocabulary — the same pair
  // nativeFlowCorrelationReceipt treats as the accepted/result receipt.
  // "request_seen" only proves the request left the browser, and
  // "acceptance_unknown" explicitly records that acceptance was NOT
  // established, so neither can ever set this flag.
  const FLOW_CORRELATION_ACCEPTANCE_STAGES = ["response_seen", "result_seen"];

  function nativeFlowCorrelationAcceptanceObserved(attemptId) {
    const entry = nativeFlowCorrelationMap().get(String(attemptId || ""));
    if (!entry || !Array.isArray(entry.receipts)) return false;
    return entry.receipts.some(receipt => FLOW_CORRELATION_ACCEPTANCE_STAGES.includes(receipt?.stage));
  }

  function releaseSubmitOnlyCorrelation(attemptId, requestDispatched) {
    if (requestDispatched !== true) return null;
    const entry = nativeFlowCorrelationMap().get(String(attemptId || ""));
    if (!entry?.requestSeen) return null;
    const receipt = [...entry.receipts].reverse().find(item => item?.stage === "request_seen");
    if (!receipt) return null;
    const dispatchReceipt = {
      stage: "request_seen",
      attemptId: entry.attemptId,
      requestOrdinal: Number.isInteger(receipt.requestOrdinal) ? receipt.requestOrdinal : null,
      requestCardinality: Number.isInteger(receipt.requestCardinality) ? receipt.requestCardinality : null,
      matchKind: typeof receipt.matchKind === "string" ? receipt.matchKind : null,
    };
    disarmNativeFlowCorrelation(attemptId, { completedDispatch: true });
    return dispatchReceipt;
  }

  function disarmNativeFlowCorrelation(attemptId, options = {}) {
    const entry = nativeFlowCorrelationMap().get(String(attemptId || ""));
    if (!entry) return;
    window.removeEventListener(FLOW_CORRELATION_RECEIPT_EVENT, entry.listener);
    window.removeEventListener("TOBY_FLOW_V2_CORRELATION_RECEIPT", entry.listener);
    window.dispatchEvent(new CustomEvent(FLOW_CORRELATION_DISARM_EVENT, {
      detail: {
        nonce: entry.nonce,
        attemptId: entry.attemptId,
        dispatched: true,
        ...(options.completedDispatch === true ? { completedDispatch: true } : {}),
      },
    }));
    nativeFlowCorrelationMap().delete(entry.attemptId);
  }

  function emitFlowProgress(command, progress, details = {}) {
    try {
      const requestId = command.requestId || command.request_id || command.id || command.commandId || command.command_id;
      const message = {
        type: "flow-mcp:progress",
        requestId,
        commandId: requestId,
        jobId: command.job_id || command.jobId,
        progress,
        ...(details && typeof details === "object" ? details : {}),
      };
      const pending = chrome.runtime.sendMessage(message);
      return Promise.resolve(pending).then(receipt => {
        root.__flowProgressDiagnostic = {
          requestId: String(requestId ?? ""), progress: String(progress || "").slice(0, 240),
          sentAt: new Date().toISOString(), receipt: receipt || null,
        };
        return receipt;
      }).catch(error => {
        root.__flowProgressDiagnostic = {
          requestId: String(requestId ?? ""), progress: String(progress || "").slice(0, 240),
          sentAt: new Date().toISOString(), sendError: String(error?.message || error).slice(0, 300),
        };
        return { ok: false, error: root.__flowProgressDiagnostic.sendError };
      });
    } catch (error) {
      root.__flowProgressDiagnostic = { sendError: String(error?.message || error).slice(0, 300), sentAt: new Date().toISOString() };
      return Promise.resolve({ ok: false, error: root.__flowProgressDiagnostic.sendError });
    }
  }

  function descriptor(item) {
    return {
      ...(item.id ? { id: item.id } : {}),
      ...(item.persistentMediaId ? { persistentMediaId: item.persistentMediaId } : {}),
      title: item.title,
      displayName: item.displayName || item.title,
      ...(item.fileName ? { fileName: item.fileName, file_name: item.fileName } : {}),
      kind: item.kind,
      type: item.type || item.kind,
      ...(item.thumbnail ? { thumbnail: item.thumbnail, thumbnailUrl: item.thumbnailUrl || item.thumbnail } : {}),
      ...(item.src ? { src: item.src } : {}),
      ...(item.videoUrl ? { videoUrl: item.videoUrl, video_url: item.video_url || item.videoUrl } : {}),
      ...(item.identityDurability ? { identityDurability: item.identityDurability } : {}),
    };
  }

  function hasTileProgressBar(tile) {
    if (typeof root.flowQuery === "function") {
      const found = root.flowQuery("tiles.progressBar", tile, { checkVisible: false });
      if (found) return true;
    }
    return Boolean(tile.querySelector('flow-progress-tile, mat-progress-bar, [role="progressbar"], [class*="progress-bar"], [class*="progressbar"]'));
  }

  function hasTileSpinner(tile) {
    if (typeof root.flowQuery === "function") {
      const found = root.flowQuery("tiles.spinner", tile, { checkVisible: false });
      if (found) return true;
    }
    return Boolean(tile.querySelector('mat-spinner, mat-progress-spinner, [class*="spinner"], [class*="loading"], [class*="loader"], [class*="shimmer"], [class*="skeleton"], svg[class*="spin"]'));
  }

  function getTileProgressText(tile) {
    const text = (tile.innerText || tile.textContent || "").replace(/\s+/g, " ").trim();
    const pctMatch = text.match(/(\d{1,3})\s*%/);
    if (pctMatch) return `${pctMatch[1]}%`;
    return "";
  }

  function hasTileGenerationText(tile) {
    const text = (tile.innerText || tile.textContent || "").toLowerCase();
    return /(?:generating|rendering|processing|creating|queued|pending|starting|in progress|đang tạo|đang kết xuất|đang xử lý|đang chờ|hàng đợi|chuẩn bị)/i.test(text);
  }

  function hasRenderedMedia(tile) {
    // 1. Check for valid, loaded image
    const imgs = (typeof root.flowQueryAll === "function" ? root.flowQueryAll("tiles.image", tile, { checkVisible: false }) : null) ||
      [...tile.querySelectorAll("img")];
    const validImgs = imgs.filter(img => {
      const src = img.currentSrc || img.getAttribute("src") || "";
      if (!src || src.startsWith("data:image/svg") || src.includes("placeholder") || src.includes("loading") || src.includes("spinner")) return false;
      return img.complete && (img.naturalWidth > 1 || img.width > 20);
    });
    if (validImgs.length > 0) return true;

    // 2. Check for canvas with content
    const canvases = [...tile.querySelectorAll("canvas")].filter(c => c.width > 20 && c.height > 20);
    if (canvases.length > 0) return true;

    // 3. Check for valid video element
    const videos = [...tile.querySelectorAll("video")].filter(v => {
      const src = v.currentSrc || v.src || v.querySelector("source")?.src || "";
      return Boolean(src && (v.readyState >= 1 || v.duration > 0 || (v.videoWidth && v.videoWidth > 0)));
    });
    if (videos.length > 0) return true;

    // 4. Video/Scene tile with loaded poster
    const videoTile = (typeof root.flowQuery === "function" ? root.flowQuery("tiles.video", tile, { checkVisible: false }) : null) ||
      tile.querySelector("flow-video-tile, flow-scene-tile");
    if (videoTile) {
      const poster = (typeof root.flowQuery === "function" ? root.flowQuery("tiles.image", videoTile, { checkVisible: false }) : null) ||
        videoTile.querySelector("img");
      if (poster && poster.complete && poster.naturalWidth > 1) return true;
    }

    return false;
  }

  function findTileErrorElement(tile) {
    if (!tile) return null;
    const explicit = (typeof root.flowQuery === "function" ? root.flowQuery("tiles.error", tile, { checkVisible: false }) : null) ||
      tile.querySelector("flow-error-tile, [class*='error-tile'], [class*='error'], [class*='failed'], [class*='warning-tile'], [role='alert']");
    if (explicit) return explicit;

    const errorIcon = [...(typeof root.flowQueryAll === "function" ? root.flowQueryAll("common.icons", tile, { checkVisible: false }) : tile.querySelectorAll("mat-icon, .mat-icon, .google-symbols"))].find(i => {
      const txt = (i.getAttribute?.("fonticon") || i.getAttribute?.("data-mat-icon-name") || i.getAttribute?.("aria-label") || i.textContent || "").trim().toLowerCase();
      return /^(?:error|error_outline|warning|report|report_problem|refresh)$/i.test(txt);
    });
    if (errorIcon) return errorIcon.closest('button, [role="button"], div, p') || errorIcon;

    const retryBtn = (typeof root.flowFindSemantic === "function" ? root.flowFindSemantic("tiles.retryButton", tile, { checkVisible: false }) : null) ||
      [...tile.querySelectorAll('button, [role="button"]')].find(b => {
        const label = (b.getAttribute("aria-label") || b.innerText || b.textContent || "").trim();
        return /^(?:retry|try again|thử lại|tạo lại)$/i.test(label);
      });
    if (retryBtn) return retryBtn;

    // Text fallback: only a DISTINCT descendant element may carry the error
    // text. The tile's whole text includes its title/prompt, so a successful
    // generation whose prompt mentions e.g. "thất bại" or "vi phạm" would
    // otherwise be misclassified as failed. The title/prompt node — and any
    // wrapper around it — is excluded from the haystack; a dedicated in-tile
    // error banner still matches and is returned.
    const tileErrorTextPattern = /(?:failed to generate|generation failed|could not generate|something went wrong|try again|không thể tạo|không tạo được|thất bại|đã xảy ra lỗi|thử lại|bị từ chối|lỗi tạo|không thành công|vi phạm|nội dung không an toàn|chính sách an toàn|bị chặn)/i;
    const normalizeTileText = value => root.normalizeFlowUiText?.(value) || String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
    const tileTitleText = normalizeTileText(tile.getAttribute?.("aria-label") || tile.getAttribute?.("title") || "");
    const descendants = [...(tile.querySelectorAll?.("*") || [])];
    const isTitleElement = element => {
      if (typeof element.matches === "function" && element.matches("[class*='title'], [class*='prompt'], [class*='caption'], [data-testid*='title']")) return true;
      return tileTitleText !== "" && normalizeTileText(element.innerText || element.textContent || "") === tileTitleText;
    };
    const titleElements = descendants.filter(isTitleElement);
    const touchesTitle = element => titleElements.some(titleElement =>
      titleElement === element ||
      (typeof element.contains === "function" && element.contains(titleElement)) ||
      (typeof titleElement.contains === "function" && titleElement.contains(element)));
    const errorCandidates = descendants.filter(element =>
      !touchesTitle(element) && tileErrorTextPattern.test(normalizeTileText(element.innerText || element.textContent || "")));
    // Prefer the deepest matching element so its text (not a wrapper's
    // combined text) becomes the reported failure reason.
    const errorElement = errorCandidates.find(element =>
      !errorCandidates.some(other => other !== element && typeof element.contains === "function" && element.contains(other)));
    if (errorElement) return errorElement;

    return null;
  }

  function isTileBusy(tile) {
    if (!tile) return false;
    const hasError = Boolean(findTileErrorElement(tile));
    if (hasError) return false;

    const pct = getTileProgressText(tile);
    const progressBar = hasTileProgressBar(tile);
    const spinner = hasTileSpinner(tile);
    const genText = hasTileGenerationText(tile);
    const ariaBusy = tile.getAttribute("aria-busy") === "true" || Boolean(tile.querySelector('[aria-busy="true"]'));
    const placeholderTile = (typeof root.flowQuery === "function" && Boolean(root.flowQuery("tiles.placeholder", tile, { checkVisible: false }))) ||
      Boolean(tile.querySelector('flow-progress-tile, flow-rendering-tile, flow-generating-tile, flow-placeholder-tile, [class*="rendering"], [class*="generating"], [class*="placeholder"]'));
    const hasActiveProgress = Boolean(pct || progressBar || spinner || genText || ariaBusy || placeholderTile);
    const rendered = hasRenderedMedia(tile);

    return hasActiveProgress || !rendered;
  }

  function isTileMediaReady(tile) {
    if (!tile) return false;
    if (Boolean(findTileErrorElement(tile))) return false;
    return !isTileBusy(tile) && hasRenderedMedia(tile);
  }

  function collectNativeMedia(options = {}) {
    const tileContainers = (typeof root.flowQueryAll === "function" ? root.flowQueryAll("tiles.container", document, { checkVisible: false }) : null) ||
      [...document.querySelectorAll("flow-grid-tile-container")];
    return tileContainers.map(tile => {
      const error = findTileErrorElement(tile);
      const failed = Boolean(error);
      const busy = !failed && isTileBusy(tile);
      const mediaReady = !failed && isTileMediaReady(tile);
      const hasScene = typeof root.flowQuery === "function" ? root.flowQuery("tiles.scene", tile, { checkVisible: false }) : tile.querySelector("flow-scene-tile");
      const hasVideo = typeof root.flowQuery === "function" ? root.flowQuery("tiles.video", tile, { checkVisible: false }) : tile.querySelector("flow-video-tile");
      const kind = hasScene ? "scene" : hasVideo ? "video" : "image";
      const id = root.mediaId?.(tile);
      const title = (tile.getAttribute("aria-label") || tile.getAttribute("title") || "").trim();
      const failureReason = error ? (error.innerText || error.textContent || (typeof error.getAttribute === "function" ? error.getAttribute("aria-label") : "") || "Flow generation failed").replace(/\s+/g, " ").trim() : undefined;
      const progress = getTileProgressText(tile) || (busy ? (hasTileGenerationText(tile) ? "Đang render..." : "") : "");
      const media = tile.querySelector("img,video");
      const video = tile.querySelector("video");
      const thumbnail = tile.querySelector("img")?.currentSrc || tile.querySelector("img")?.getAttribute("src") || video?.getAttribute("poster") || video?.poster || "";
      const src = media?.currentSrc || media?.getAttribute?.("src") || "";
      const fileName = tile.getAttribute("data-file-name") || tile.getAttribute("data-filename") || media?.getAttribute?.("data-file-name") || "";
      const persistentMediaId = tile.getAttribute("data-persistent-media-id") || tile.getAttribute("data-media-id") || media?.getAttribute?.("data-media-id") || (id && !String(id).startsWith("title:") ? id : undefined);
      const projectId = (root.ProviderRegistry || root.FlowDriverRegistry)?.describeUrl?.(location.href)?.projectId || null;
      return {
        ...(id ? { id } : {}),
        ...(persistentMediaId ? { persistentMediaId } : {}),
        ...(projectId ? { projectId, project_id: projectId } : {}),
        ...(options.operationId ? { operationId: String(options.operationId) } : {}),
        title,
        displayName: title,
        fileName,
        file_name: fileName,
        busy,
        mediaReady,
        failed,
        failureReason,
        kind,
        type: kind,
        ...(thumbnail ? { thumbnail, thumbnailUrl: thumbnail } : {}),
        ...(src ? { src } : {}),
        ...(video ? { videoUrl: video.currentSrc || video.getAttribute("src") || "", video_url: video.currentSrc || video.getAttribute("src") || "" } : {}),
        identityDurability: persistentMediaId ? "persistent" : "title_only",
        progress,
        element: tile,
      };
    });
  }

  // Grid tile lookup is EXACT by default: destructive paths (trash,
  // rename) and id-verified paths must never act on a merely
  // prefix-matching tile ("anh" must not resolve to "anh 2"). Prefix
  // semantics belong to the scan filters (download / workflow source
  // resolution), which resolve to a full title BEFORE calling this.
  // Pass { exact: false } only for a caller that deliberately wants the
  // historical prefix fallback.
  // Canonical title folds (audit cluster E).
  // - foldTileTitleStrict: whitespace/trim/lowercase ONLY, no accent
  // folding. Used by the EXACT-match paths (findFlowTile,
  // countFlowTitleAcrossGrid) where accent folding would be wrong:
  // trash "anh" must not match tile "ánh".
  // - tileSnapshotKey: the single builder for before/after tile-set
  // keys (generation baselines, wait, character flows). Kept RAW on
  // purpose: `before` arrays cross the SW/content boundary as
  // strings, so the producer and every consumer must build
  // byte-identical keys, including against already-persisted
  // observations. (The retry key space in retryIdentity is separate
  // and stays as cluster B left it.)
  function foldTileTitleStrict(value) {
    return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function tileSnapshotKey(item) {
    if (typeof item === "string") return item;
    const id = item?.id;
    if (id) return String(id);
    return `title:${item?.title ?? ""}`;
  }

  async function findFlowTile(title, retries = 100, options = {}) {
    const norm = foldTileTitleStrict;
    const wanted = norm(title);
    const exact = options.exact !== false;
    const scroller = flowMediaGridScrollContainer();
    if (scroller) scroller.scrollTop = 0;
    await root.wait?.(200);

    for (let step = 0; step < retries; step++) {
      const tileContainers = (typeof root.flowQueryAll === "function" ? root.flowQueryAll("tiles.container", document, { checkVisible: false }) : null) ||
        [...document.querySelectorAll("flow-grid-tile-container")];
      const tile = tileContainers.find(el => {
        const tTitle = norm(el.getAttribute("aria-label") || el.getAttribute("title"));
        return tTitle === wanted || (!exact && tTitle.startsWith(wanted));
      });
      if (tile) return tile;
      if (!scroller) break;
      const top = scroller.scrollTop;
      const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      if (top >= max - 2) break;
      scroller.scrollTop = Math.min(max, top + Math.max(200, scroller.clientHeight * 0.78));
      await root.wait?.(250);
    }
    return null;
  }

  function flowMediaGridScrollContainer() {
    const fallback = document.scrollingElement || document.documentElement;
    const canScroll = element => {
      if (!element || element === document.body || element === document.documentElement) return false;
      if (element.scrollHeight - element.clientHeight < 50) return false;
      try {
        const overflowY = getComputedStyle(element).overflowY;
        return overflowY === "auto" || overflowY === "scroll";
      } catch {
        return false;
      }
    };
    const tiles = (typeof root.flowQueryAll === "function" ? root.flowQueryAll("tiles.container", document, { checkVisible: false }) : null) ||
      [...document.querySelectorAll("flow-grid-tile-container")];
    for (const tile of tiles) {
      for (let parent = tile?.parentElement, hop = 0; parent && hop < 30; parent = parent.parentElement, hop++) {
        if (canScroll(parent)) return parent;
      }
    }
    let best = null;
    for (const element of document.querySelectorAll("div,main,section")) {
      if (canScroll(element) && (!best || element.scrollHeight > best.scrollHeight)) best = element;
    }
    if (best) return best;
    return fallback && fallback.scrollHeight - fallback.clientHeight >= 50 ? fallback : null;
  }

  async function stabilizeFlowResultViewport(options = {}) {
    const deadline = Number.isFinite(options.deadline) ? options.deadline : Infinity;
    const signal = options.signal;
    const startedAt = Date.now();
    const scroller = flowMediaGridScrollContainer();
    const before = Number(scroller?.scrollTop || 0);
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : root.flowError("FLOW_OPERATION_CANCELLED", "Flow result viewport stabilization was cancelled before it began.", false, false);
    }
    if (!scroller) return { success: true, moved: false, reason: "no_scroll_container", before: 0, after: 0 };

    let settleReason = "already_at_top";
    if (before > 1) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        root.FlowUiDeadline?.requireTime?.(deadline, "stabilizing the Flow result viewport", false, signal);
        throw root.flowError("FLOW_OPERATION_TIMEOUT", "Timed out before the Flow result viewport could be stabilized.", false, false);
      }
      const settleMs = Math.max(1, Math.min(1_000, remaining));
      await new Promise((resolve, reject) => {
        let settled = false;
        let observer = null;
        let timer;
        const onAbort = () => finish("cancelled", signal.reason instanceof Error ? signal.reason : root.flowError("FLOW_OPERATION_CANCELLED", "Flow result viewport stabilization was cancelled.", false, false));
        const finish = (reason, error) => {
          if (settled) return;
          settled = true;
          settleReason = reason;
          observer?.disconnect();
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          if (error) reject(error);
          else resolve();
        };
        timer = setTimeout(() => finish("timeout"), settleMs);
        if (typeof MutationObserver === "function") {
          observer = new MutationObserver(() => finish("dom_mutation"));
          observer.observe(scroller, { childList: true, subtree: true });
        }
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) return onAbort();
        scroller.scrollTop = 0;
        if (Number(scroller.scrollTop || 0) > 1) finish("scroll_not_reset");
      });
    }

    root.FlowUiDeadline?.requireTime?.(deadline, "stabilizing the Flow result viewport", false, signal);
    const after = Number(scroller.scrollTop || 0);
    return {
      success: after <= 1,
      moved: before > 1,
      before,
      after,
      settleReason,
      elapsedMs: Date.now() - startedAt,
      mountedTiles: collectNativeMedia().length,
    };
  }

  // DL-09: tile identity is an ALIAS SET, not a single string. The forms
  // below are exactly the ones the generation side already accepts for a
  // tile (see mediaId() in dom-utils.js): the primary mediaId() value,
  // the persistent/media id attributes on the tile or a descendant, the
  // media element's own id attributes, and the identities derivable from
  // the media src (a canonical UUID, or an `asb:` identity — kept in both
  // its prefixed and bare forms, since callers carry either). Two values
  // match when they are the same UUID (case-insensitive) or the same asb
  // identity in either form, otherwise only on exact equality.
  function tileIdentityValuesMatch(left, right) {
    const a = String(left || "").trim();
    const b = String(right || "").trim();
    if (!a || !b) return false;
    if (/^[0-9a-f-]{36}$/i.test(a) && /^[0-9a-f-]{36}$/i.test(b)) return a.toLowerCase() === b.toLowerCase();
    const aAsb = /^asb:(.+)$/i.exec(a)?.[1];
    const bAsb = /^asb:(.+)$/i.exec(b)?.[1];
    if (aAsb || bAsb) return (aAsb || a) === (bAsb || b);
    return a === b;
  }

  function tileIdentityAliases(tile) {
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

  function tileMatchesMediaIdentity(tile, wantedValues) {
    const wanted = (Array.isArray(wantedValues) ? wantedValues : [wantedValues])
      .map(value => String(value || "").trim()).filter(Boolean);
    if (!wanted.length) return false;
    const aliases = tileIdentityAliases(tile);
    return aliases.some(alias => wanted.some(value => tileIdentityValuesMatch(alias, value)));
  }

  // DL-09 failure cooldown (reference behavior D4): a sweep that fails
  // to mount its target records the failure per target identity; a
  // repeat sweep for the SAME target inside
  // FLOW_TILE_SWEEP_FAILURE_COOLDOWN_MS (60s, the reference window)
  // fails fast with FLOW_TILE_SWEEP_COOLDOWN instead of scrolling the
  // grid again. At most one real sweep per target per window: attempts
  // inside the window do not extend it, a success clears the record,
  // and other targets are unaffected. Callers opt in via
  // options.failureCooldownMs (the download sweep entry point below
  // always does); the historical findFlowTileByMediaId callers keep
  // their un-cooled behavior unless they pass it.
  const FLOW_TILE_SWEEP_FAILURE_COOLDOWN_MS = 60_000;
  const flowTileSweepFailures = globalThis.__flowTileSweepFailures instanceof Map
    ? globalThis.__flowTileSweepFailures
    : (globalThis.__flowTileSweepFailures = new Map());

  async function findFlowTileByMediaId(mediaId, options = {}) {
    const wantedValues = [mediaId, ...(Array.isArray(options.aliases) ? options.aliases : []),
      ...(Array.isArray(options.identityAliases) ? options.identityAliases : [])]
      .map(value => String(value || "").trim())
      .filter(value => value && !value.startsWith("title:"));
    if (!wantedValues.length) return null;
    const cooldownMs = Number.isFinite(Number(options.failureCooldownMs)) && Number(options.failureCooldownMs) > 0
      ? Number(options.failureCooldownMs)
      : (Number.isFinite(Number(options.cooldownMs)) && Number(options.cooldownMs) > 0 ? Number(options.cooldownMs) : 0);
    const cooldownKey = cooldownMs
      ? wantedValues.map(value => value.toLowerCase()).sort().join("|")
      : null;
    if (cooldownKey) {
      const failedAt = flowTileSweepFailures.get(cooldownKey);
      if (Number.isFinite(failedAt)) {
        if (Date.now() - failedAt < cooldownMs) {
          throw root.flowError("FLOW_TILE_SWEEP_COOLDOWN",
            `The Flow tile sweep for this media failed less than ${Math.round(cooldownMs / 1000)}s ago; refusing to sweep the grid again until the cooldown expires. No tile was clicked.`,
            true, false);
        }
        flowTileSweepFailures.delete(cooldownKey);
      }
    }
    const recordSweepFailure = () => { if (cooldownKey) flowTileSweepFailures.set(cooldownKey, Date.now()); };
    const deadline = Number.isFinite(options.deadline) ? options.deadline : Date.now() + 15_000;
    const maxSteps = Math.max(1, Math.min(100, Number(options.maxSteps) || 60));
    const scroller = flowMediaGridScrollContainer();
    const originalTop = scroller?.scrollTop || 0;
    let found = null;
    try {
      for (let step = 0; step < maxSteps && Date.now() < deadline; step++) {
        if (options.signal?.aborted) throw root.flowError("FLOW_OPERATION_TIMEOUT", "Timed out while locating the exact Flow media tile; no reference was selected.", false, false);
        const tiles = (typeof root.flowQueryAll === "function" ? root.flowQueryAll("tiles.container", document, { checkVisible: false }) : null) ||
          [...document.querySelectorAll("flow-grid-tile-container")];
        const matches = tiles.filter(tile => tileMatchesMediaIdentity(tile, wantedValues));
        if (matches.length === 1) {
          found = matches[0];
          if (cooldownKey) flowTileSweepFailures.delete(cooldownKey);
          found.scrollIntoView?.({ behavior: "instant", block: "center" });
          // On-mounted (D4): fire the moment the target mounts, with
          // ownership already verified by the alias-set match above and
          // BEFORE any scroll restore (a found tile is never restored
          // away), so the caller can act on the mounted tile at once.
          const onMounted = typeof options.onMounted === "function" ? options.onMounted
            : (typeof options.onTileMounted === "function" ? options.onTileMounted : null);
          if (onMounted) await onMounted(found);
          return found;
        }
        if (matches.length > 1) { recordSweepFailure(); return null; }
        if (!scroller) break;
        const top = scroller.scrollTop;
        const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        if (top >= max - 2) break;
        scroller.scrollTop = Math.min(max, top + Math.max(240, scroller.clientHeight * 0.78));
        const pause = Math.min(180, Math.max(0, deadline - Date.now()));
        if (pause <= 0) break;
        if (root.FlowUiDeadline?.boundedWait) await root.FlowUiDeadline.boundedWait(pause, deadline, "scanning Flow media for the requested image", false, options.signal);
        else await root.wait?.(pause);
      }
      recordSweepFailure();
      return null;
    } finally {
      if (!found && scroller) scroller.scrollTop = originalTop;
    }
  }

  // DL-09 reusable sweep entry point for the download path: the
  // generation tile-loading sweep above, with the failure cooldown
  // always armed and the caller's on-mounted callback forwarded.
  async function sweepFlowTileByMediaId(mediaId, options = {}) {
    return findFlowTileByMediaId(mediaId, {
      ...options,
      failureCooldownMs: Number.isFinite(Number(options.failureCooldownMs)) && Number(options.failureCooldownMs) > 0
        ? Number(options.failureCooldownMs)
        : FLOW_TILE_SWEEP_FAILURE_COOLDOWN_MS,
    });
  }

  async function countFlowTitleAcrossGrid(title, options = {}) {
    const norm = foldTileTitleStrict;
    const wanted = norm(title);
    // Exact by default — see findFlowTile: the trash gate counts copies
    // with this, so a prefix-only match must not count as a copy.
    const exact = options.exact !== false;
    const scroller = flowMediaGridScrollContainer();
    const originalTop = scroller?.scrollTop || 0;
    const seen = new Set();

    try {
      if (scroller) scroller.scrollTop = 0;
      await root.wait?.(200);
      for (let step = 0; step < 80; step++) {
        const tileContainers = (typeof root.flowQueryAll === "function" ? root.flowQueryAll("tiles.container", document, { checkVisible: false }) : null) ||
          document.querySelectorAll("flow-grid-tile-container");
        for (const tile of tileContainers) {
          const tTitle = norm(tile.getAttribute("aria-label") || tile.getAttribute("title"));
          if (tTitle === wanted || (!exact && tTitle.startsWith(wanted))) {
            const id = root.mediaId?.(tile) || tTitle;
            seen.add(id);
          }
        }
        if (!scroller) break;
        const top = scroller.scrollTop;
        const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        if (top >= max - 2) break;
        scroller.scrollTop = Math.min(max, top + Math.max(200, scroller.clientHeight * 0.78));
        await root.wait?.(250);
      }
      return seen.size;
    } finally {
      if (scroller) scroller.scrollTop = originalTop;
    }
  }

  const retryIdentityForTile = tile => {
    if (!tile) return null;
    const media = root.mediaId?.(tile);
    if (media && !String(media).startsWith("title:")) return `media:${String(media).toLowerCase()}`;
    const runtimeId = tile.getAttribute?.("data-tile-id") || tile.getAttribute?.("data-runtime-id") || tile.id;
    if (runtimeId) return `tile:${runtimeId}`;
    const title = String(tile.getAttribute?.("aria-label") || tile.getAttribute?.("title") || "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
    if (!title) return "element:unknown";
    // Audit cluster B: a title-only tile used to get a per-element
    // `element:<title>:<n>` key, while retryIdentity for a title-only
    // item returns `title:<title>` — the two sides never matched, so a
    // re-rendered tile (new element object, same title) was silently
    // skipped by retry. The stable title key makes both sides agree.
    // Duplicate titles now collide in the retry baseline set, but
    // targetMatches still requires exactly one match, so a
    // duplicate-title grid fails closed (null) instead of retrying
    // the wrong tile.
    return `title:${title}`;
  };
  const retryIdentity = item => {
    const id = String(item?.id || "");
    if (id && !id.startsWith("title:")) return `media:${id.toLowerCase()}`;
    if (item?.element) return retryIdentityForTile(item.element);
    return `title:${String(item?.title || "").replace(/\s+/g, " ").trim().toLocaleLowerCase()}`;
  };

  async function retryNativeErrorTile(item, options = {}) {
    const attempted = options.attempted instanceof Set ? options.attempted : new Set();
    const retryKey = retryIdentity(item);
    if (!retryKey || attempted.has(retryKey)) return null;
    attempted.add(retryKey);
    const tileContainers = (typeof root.flowQueryAll === "function" ? root.flowQueryAll("tiles.container", document, { checkVisible: false }) : null) ||
      [...document.querySelectorAll("flow-grid-tile-container")];
    const matchesTarget = candidate => item.id && !item.id.startsWith("title:")
      ? String(root.mediaId?.(candidate) || "").toLowerCase() === String(item.id).toLowerCase()
      : candidate === item.element || retryIdentityForTile(candidate) === retryKey;
    const targetMatches = tileContainers.filter(matchesTarget);
    if (targetMatches.length !== 1) return null;
    let tile = targetMatches[0];
    const originalIdentity = retryIdentityForTile(tile);
    const baseline = new Set(tileContainers.map(retryIdentityForTile).filter(Boolean));
    tile.scrollIntoView({ block: "center" });
    const rect = tile.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    tile.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, clientX: x, clientY: y, pointerId: 1, pointerType: "mouse" }));
    tile.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, clientX: x, clientY: y }));
    await root.wait?.(250);
    tile = tile.isConnected ? tile : [...document.querySelectorAll("flow-grid-tile-container")].find(matchesTarget);
    if (!tile || tile !== targetMatches[0]) return null;
    const errorOwner = findTileErrorElement(tile);
    if (!errorOwner) return null;
    const retryBtnConfig = root.FlowSelectors?.tiles?.retryButton;
    const labelRegex = retryBtnConfig?.textRegex || /^(?:retry|try again|thử lại)(?:\s+.*)?$/i;
    const iconRegex = retryBtnConfig?.iconRegex || /refresh|replay|retry/i;
    const ownerNodes = errorOwner.matches?.("button,[role=button]") ? [errorOwner, ...errorOwner.querySelectorAll("button,[role=button]")] : [...errorOwner.querySelectorAll("button,[role=button]")];
    const retryCandidates = [...new Set(ownerNodes)].filter(el => {
        if (!root.visible?.(el) || el.disabled || el.getAttribute("aria-disabled") === "true") return false;
        const label = (root.accessibleName?.(el) || "").replace(/\s+/g, " ").trim().toLowerCase();
        const icon = (root.flowFindIcon ? root.flowFindIcon(el) : el.querySelector("mat-icon,.mat-icon,.google-symbols,.material-symbols-outlined,svg"))?.textContent?.trim() || "";
        const labelMatches = root.matchesFlowUiRegex?.(label, labelRegex) === true || labelRegex.test(label);
        return labelMatches || iconRegex.test(icon);
    });
    if (retryCandidates.length !== 1) return null;
    const retry = retryCandidates[0];
    if (!tile.contains(retry) || !errorOwner.contains(retry)) return null;
    const retryRect = retry.getBoundingClientRect();
    const rx = retryRect.left + retryRect.width / 2;
    const ry = retryRect.top + retryRect.height / 2;
    const point = { bubbles: true, cancelable: true, composed: true, button: 0, clientX: rx, clientY: ry };
    retry.dispatchEvent(new PointerEvent("pointerover", { ...point, pointerId: 1, pointerType: "mouse" }));
    retry.dispatchEvent(new MouseEvent("mouseover", point));
    // One activation only. Dispatching a click and then calling .click() can
    // enqueue two retries against the same Flow tile.
    retry.click();
    const timeoutMs = Math.max(250, Math.min(8_000, Number(options.timeoutMs) || 5_000));
    const deadline = Math.min(Date.now() + timeoutMs, Number.isFinite(options.deadline) ? options.deadline : Infinity);
    const resolveOriginal = () => {
      if (tile.isConnected && retryIdentityForTile(tile) === originalIdentity) return tile;
      const matches = [...document.querySelectorAll("flow-grid-tile-container")].filter(candidate => retryIdentityForTile(candidate) === originalIdentity);
      return matches.length === 1 ? matches[0] : null;
    };
    while (Date.now() < deadline) {
      const original = resolveOriginal();
      if (original && !findTileErrorElement(original) && isTileBusy(original)) {
        if (flowMediaGridScrollContainer?.()) flowMediaGridScrollContainer().scrollTop = 0;
        return { accepted: true, ownerId: originalIdentity, signal: "original_tile_processing" };
      }
      const currentTiles = [...document.querySelectorAll("flow-grid-tile-container")].filter(root.visible);
      const newOwners = currentTiles.filter(candidate => {
        if (baseline.has(retryIdentityForTile(candidate))) return false;
        const kind = candidate.querySelector("flow-scene-tile") ? "scene" : candidate.querySelector("flow-video-tile") ? "video" : "image";
        return !item.kind || kind === item.kind || (item.kind === "video" && kind === "scene");
      });
      if (newOwners.length === 1) {
        if (flowMediaGridScrollContainer?.()) flowMediaGridScrollContainer().scrollTop = 0;
        return { accepted: true, ownerId: retryIdentityForTile(newOwners[0]), signal: "unique_new_tile_owner" };
      }
      if (root.FlowUiDeadline?.boundedWait && Number.isFinite(options.deadline)) {
        await root.FlowUiDeadline.boundedWait(120, deadline, "confirming Flow accepted the failed-tile retry", true, options.signal);
      } else await root.wait?.(120);
    }
    throw root.flowError("FLOW_TILE_RETRY_UNCONFIRMED", `Flow received one retry action for "${item.title || "the failed result"}", but no unique retry owner acknowledged it. Inspect Flow before retrying.`, false, true);
  }

  async function waitForProgressResult(command, before, expected, kind, timeoutMs, selector = "flow-grid-tile-container", allowConfirmedPartial = false, waitOptions = {}) {
    const until = Date.now() + timeoutMs;
    const startedAt = Date.now();
    const beforeIds = new Set((Array.isArray(before) ? before : []).map(tileSnapshotKey));
    const preFileNames = new Set((Array.isArray(waitOptions.preFileNames) ? waitOptions.preFileNames : []).map(value => String(value).trim().toLowerCase()).filter(Boolean));
    const expectedMediaType = waitOptions.expectedMediaType || kind;
    const operationId = waitOptions.operationId ? String(waitOptions.operationId) : null;
    const claimKey = item => String(item?.persistentMediaId || item?.id || item?.fileName || item?.file_name || `title:${item?.title || ""}`);
    const claimable = item => {
      if (!operationId) return true;
      const key = claimKey(item);
      const claim = nativeFlowTileClaims.get(key);
      if (claim && claim.expiresAt <= Date.now()) { nativeFlowTileClaims.delete(key); return true; }
      return !claim || claim.operationId === operationId;
    };
    const isBefore = item => {
      const identity = tileSnapshotKey(item);
      if (beforeIds.has(identity)) return true;
      const fileName = String(item?.fileName || item?.file_name || "").trim().toLowerCase();
      return Boolean(fileName && preFileNames.has(fileName));
    };
    let hadProgress = false, last = "", lastTitleOnlyResult = "", retriesLeft = Math.max(1, Number(command?.retries ?? 2));
    const retriedTiles = new Set();
    let renderObservedInFlight = false;
    while (Date.now() < until) {
      const allMedia = collectNativeMedia({ operationId: waitOptions.operationId });
      const fresh = allMedia.filter(item => !isBefore(item) && claimable(item) && (!expectedMediaType || item.kind === expectedMediaType || (expectedMediaType === "video" && item.kind === "scene")));
      const failed = fresh.filter(item => item.failed);
      const retryCandidates = failed.filter(item => !retriedTiles.has(retryIdentity(item)));
      if (failed.length) {
        const failureReason = (retryCandidates[0] || failed[0])?.failureReason || "";
        const classified = root.classifyFlowError?.(failureReason);
        if (classified?.category === "rate_limit") {
          throw root.flowError(classified.code, classified.message, true, false);
        }
        if (classified && !classified.retryable) {
          throw root.flowError(classified.code, classified.message, false, false);
        }
        if (retriesLeft > 0 && retryCandidates.length && await retryNativeErrorTile(retryCandidates[0], { attempted: retriedTiles, deadline: until, timeoutMs: Math.min(5000, until - Date.now()), signal: command?.signal })) {
          retriesLeft--;
          emitFlowProgress(command, `Flow thất bại render; đang thử lại (${retriesLeft} lần thử còn lại)`);
          continue;
        }
        if (!allowConfirmedPartial || fresh.filter(item => item.mediaReady).length >= expected || retryCandidates.length === 0) {
          const ready = fresh.filter(item => item.mediaReady && !item.failed);
          const failure = failed[0];
          const error = root.flowError("FLOW_GENERATION_FAILED", `Flow gặp lỗi khi xử lý "${failure.title}"${failure.failureReason ? `: ${failure.failureReason}` : ""}. Chưa bị trừ tín dụng cho lượt tạo lỗi này.`, false, false);
          if (allowConfirmedPartial && ready.length + failed.length >= expected) {
            error.partialMedia = ready.map(descriptor);
            error.failedMedia = failed.map(descriptor);
          }
          throw error;
        }
      }

      const busyItems = fresh.filter(item => item.busy);
      if (busyItems.length > 0) renderObservedInFlight = true;

      const ready = fresh.filter(item => item.mediaReady && !item.busy && !item.failed);
      const isEarly = Date.now() - startedAt < 2000 && !renderObservedInFlight;

      if (!isEarly && ready.length >= expected) {
        const picked = ready.slice(0, expected);
        const titleOnly = picked.some(item => !item.id || item.id.startsWith("title:"));
        const signature = picked.map(tileSnapshotKey).join("|");
        if (!titleOnly || signature === lastTitleOnlyResult) {
          emitFlowProgress(command, kind === "video" ? "Tạo video hoàn tất 100%" : "Tạo ảnh hoàn tất 100%");
          if (operationId) {
            for (const item of picked) nativeFlowTileClaims.set(claimKey(item), { operationId, claimedAt: Date.now(), expiresAt: Date.now() + 15 * 60_000 });
          }
          return picked.map(descriptor);
        }
        lastTitleOnlyResult = signature;
        emitFlowProgress(command, "Flow đang cập nhật tiêu đề file...");
        await root.wait?.(1500);
        continue;
      }

      const pctList = [...document.querySelectorAll(selector)].slice(0, 10).map(el => (el.innerText || "").match(/(\d{1,3})\s*%/)?.[0]).filter(Boolean);
      if (pctList.length) hadProgress = true;
      const currentPct = pctList.find(p => /^\d{1,3}%$/.test(p.replace(/\s+/g, "")));
      let text = "";
      if (currentPct) {
        text = `Đang render (${currentPct.replace(/\s+/g, "")})`;
      } else if (busyItems.length > 0) {
        text = kind === "video" ? "Flow đang render video..." : "Flow đang render ảnh...";
      } else if (hadProgress || renderObservedInFlight) {
        text = "Flow đang hoàn tất kết quả...";
      } else {
        text = "Đang chờ Flow bắt đầu render...";
      }

      if (text !== last) { emitFlowProgress(command, text); last = text; }
      if (root.FlowUiDeadline?.boundedWait) await root.FlowUiDeadline.boundedWait(Math.min(2000, Math.max(1, until - Date.now())), until, "waiting for Flow generation tiles", false, command?.signal);
      else await root.wait?.(2000);
    }
    throw root.flowError("FLOW_OPERATION_TIMEOUT", "Hết thời gian chờ Flow. Tác vụ có thể đã được tiếp nhận; vui lòng kiểm tra giao diện Flow trước khi thử lại.", false, true);
  }

  async function waitForNativeEditorCompletion(command, timeoutMs, description) {
    const deadline = Date.now() + timeoutMs;
    let seenProgress = false;
    let previous = "";
    while (Date.now() < deadline) {
      const text = document.querySelector("main")?.innerText || document.body?.innerText || "";
      const alerts = [...(document.body || document).querySelectorAll?.('[role="alert"],mat-error,[aria-live="assertive"],[data-error-code],[data-error],[data-sonner-toast],[data-sonner-toaster] [data-toast]') || []]
        .filter(el => root.visible?.(el));
      const alertFailure = alerts.map(el => {
        const message = String(el.innerText || el.textContent || el.getAttribute?.("aria-label") || "").replace(/\s+/g, " ").trim();
        const classified = root.classifyFlowError?.(message);
        const folded = root.normalizeFlowUiText?.(message) || message.toLowerCase();
        const explicitFailure = /(?:error|failed|failure|could not|unable to|blocked|loi|that bai|khong the|khong thanh cong|bi chan|tu choi)/i.test(folded);
        return message && (classified || explicitFailure) ? { message, classified } : null;
      }).find(Boolean);
      // Lines rendered inside media tiles are tile titles/prompts, not page
      // errors: a successful generation whose prompt mentions e.g. "thất
      // bại" must not fail this wait, so tile-owned lines are excluded from
      // the free-text failure scan below.
      const tileOwnedLines = new Set();
      const tileContainers = (typeof root.flowQueryAll === "function" ? root.flowQueryAll("tiles.container", document, { checkVisible: false }) : null) ||
        [...(document.querySelectorAll?.("flow-grid-tile-container") || [])];
      for (const tileElement of tileContainers || []) {
        const tileTitle = typeof tileElement.getAttribute === "function"
          ? (tileElement.getAttribute("aria-label") || tileElement.getAttribute("title") || "").trim()
          : "";
        if (tileTitle) tileOwnedLines.add(tileTitle);
        for (const line of String(tileElement.innerText || tileElement.textContent || "").split("\n")) {
          const trimmed = line.trim();
          if (trimmed) tileOwnedLines.add(trimmed);
        }
      }
      const failure = alertFailure?.message || text.split("\n").map(line => line.trim()).find(line => {
        if (!line || tileOwnedLines.has(line)) return false;
        const folded = root.normalizeFlowUiText?.(line) || line.toLowerCase();
        return /(?:failed to generate|generation failed|could not generate|something went wrong|try again|khong the tao|tao that bai|da xay ra loi|thu lai)/i.test(folded);
      });
      if (failure) {
        const classified = alertFailure?.classified || root.classifyFlowError?.(failure);
        if (classified) throw root.flowError(classified.code, classified.message, classified.retryable, true);
        throw root.flowError("FLOW_GENERATION_FAILED", `Flow reported a failed ${description}: ${failure.slice(0, 300)}`, false, true);
      }
      const progress = text.match(/\d{1,3}%/)?.[0];
      if (progress) {
        seenProgress = true;
        if (progress !== previous) emitFlowProgress(command, progress);
        previous = progress;
      } else if (seenProgress) {
        return true;
      }
      await root.wait?.(2500);
    }
    throw root.flowError("FLOW_OPERATION_TIMEOUT", `Timed out waiting for Flow to finish the ${description}. Inspect Flow before retrying.`, false, true);
  }

  const FlowTiles = Object.freeze({
    tileSnapshotKey,
    foldTileTitleStrict,
    collectNativeMedia,
    isTileBusy,
    isTileMediaReady,
    hasRenderedMedia,
    findFlowTile,
    findFlowTileByMediaId,
    sweepFlowTileByMediaId,
    tileIdentityAliases,
    tileMatchesMediaIdentity,
    tileIdentityValuesMatch,
    FLOW_TILE_SWEEP_FAILURE_COOLDOWN_MS,
    countFlowTitleAcrossGrid,
    retryIdentity,
    retryNativeErrorTile,
    waitForProgressResult,
    waitForNativeEditorCompletion,
    armNativeFlowCorrelation,
    disarmNativeFlowCorrelation,
    nativeFlowCorrelationReceipt,
    nativeFlowCorrelationAcceptanceObserved,
    releaseSubmitOnlyCorrelation,
    nativeFlowCorrelationMap,
    inspectNativeFlowCorrelationObserver,
    readNativeFlowCorrelationHealth,
    flowPromptFingerprint,
    emitFlowProgress,
    flowMediaGridScrollContainer,
    stabilizeFlowResultViewport,
  });

  root.FlowTiles = FlowTiles;
  root.tileSnapshotKey = tileSnapshotKey;
  root.collectNativeMedia = collectNativeMedia;
  root.isTileBusy = isTileBusy;
  root.isTileMediaReady = isTileMediaReady;
  root.hasRenderedMedia = hasRenderedMedia;
  root.findFlowTile = findFlowTile;
  root.findFlowTileByMediaId = findFlowTileByMediaId;
  root.sweepFlowTileByMediaId = sweepFlowTileByMediaId;
  root.tileIdentityAliases = tileIdentityAliases;
  root.tileMatchesMediaIdentity = tileMatchesMediaIdentity;
  root.countFlowTitleAcrossGrid = countFlowTitleAcrossGrid;
  root.waitForProgressResult = waitForProgressResult;
  root.waitForNativeEditorCompletion = waitForNativeEditorCompletion;
  root.armNativeFlowCorrelation = armNativeFlowCorrelation;
  root.disarmNativeFlowCorrelation = disarmNativeFlowCorrelation;
  root.nativeFlowCorrelationReceipt = nativeFlowCorrelationReceipt;
  root.nativeFlowCorrelationAcceptanceObserved = nativeFlowCorrelationAcceptanceObserved;
  root.nativeFlowCorrelationMap = nativeFlowCorrelationMap;
  root.inspectNativeFlowCorrelationObserver = inspectNativeFlowCorrelationObserver;
  root.retryNativeErrorTile = retryNativeErrorTile;
  root.emitFlowProgress = emitFlowProgress;
  root.flowMediaGridScrollContainer = flowMediaGridScrollContainer;
  root.stabilizeFlowResultViewport = stabilizeFlowResultViewport;
})(globalThis);
