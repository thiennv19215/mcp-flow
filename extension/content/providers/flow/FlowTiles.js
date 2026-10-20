(function (root) {
  "use strict";

  const FLOW_CORRELATION_ARM_EVENT = "TOBY_FLOW_CORRELATION_ARM";
  const FLOW_CORRELATION_DISARM_EVENT = "TOBY_FLOW_CORRELATION_DISARM";
  const FLOW_CORRELATION_RECEIPT_EVENT = "TOBY_FLOW_CORRELATION_RECEIPT";

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

  async function armNativeFlowCorrelation({ projectId, mediaType, prompt, expectedQuantity }) {
    if (!projectId || !["image", "video"].includes(mediaType)) return null;
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
          receipt?.attemptId !== attemptId ||
          receipt?.projectId !== projectId ||
          receipt?.mediaType !== mediaType
        ) return;
        entry.receipts.push(receipt);
        if (receipt.stage === "request_seen") entry.requestSeen = true;
        if (receipt.stage === "armed") {
          entry.armed = !receipt.reason;
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
        expectedReferenceIds: [],
        expectedMediaReferenceIds: [],
        expectedCharacterIds: [],
        expectedGlobalCharacter: false,
        strictDispatch: true,
        ttlMs: 15 * 60_000,
      },
    }));
    if (!(await armed)) {
      window.removeEventListener(FLOW_CORRELATION_RECEIPT_EVENT, entry.listener);
      window.removeEventListener("TOBY_FLOW_V2_CORRELATION_RECEIPT", entry.listener);
      window.dispatchEvent(new CustomEvent(FLOW_CORRELATION_DISARM_EVENT, {
        detail: { nonce, attemptId, dispatched: false, discardOnStop: true },
      }));
      return null;
    }
    nativeFlowCorrelationMap().set(attemptId, entry);
    return attemptId;
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

  function disarmNativeFlowCorrelation(attemptId) {
    const entry = nativeFlowCorrelationMap().get(String(attemptId || ""));
    if (!entry) return;
    window.removeEventListener(FLOW_CORRELATION_RECEIPT_EVENT, entry.listener);
    window.removeEventListener("TOBY_FLOW_V2_CORRELATION_RECEIPT", entry.listener);
    window.dispatchEvent(new CustomEvent(FLOW_CORRELATION_DISARM_EVENT, {
      detail: { nonce: entry.nonce, attemptId: entry.attemptId, dispatched: true },
    }));
    nativeFlowCorrelationMap().delete(entry.attemptId);
  }

  function emitFlowProgress(command, progress) {
    try {
      chrome.runtime.sendMessage({
        type: "flow-mcp:progress",
        commandId: command.id || command.commandId,
        jobId: command.job_id || command.jobId,
        progress,
      }).catch(() => {});
    } catch {}
  }

  function descriptor(item) {
    return { id: item.id, title: item.title, kind: item.kind };
  }

  function hasTileProgressBar(tile) {
    if (typeof root.flowQuery === "function" && root.flowQuery("tiles.progressBar", tile, { checkVisible: false })) return true;
    return Boolean(tile.querySelector('flow-progress-tile, mat-progress-bar, [role="progressbar"], [class*="progress-bar"], [class*="progressbar"]'));
  }

  function hasTileSpinner(tile) {
    if (typeof root.flowQuery === "function" && root.flowQuery("tiles.spinner", tile, { checkVisible: false })) return true;
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
    const imgs = [...tile.querySelectorAll("img")].filter(img => {
      const src = img.currentSrc || img.getAttribute("src") || "";
      if (!src || src.startsWith("data:image/svg") || src.includes("placeholder") || src.includes("loading") || src.includes("spinner")) return false;
      return img.complete && (img.naturalWidth > 1 || img.width > 20);
    });
    if (imgs.length > 0) return true;

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
      const poster = videoTile.querySelector("img");
      if (poster && poster.complete && poster.naturalWidth > 1) return true;
    }

    return false;
  }

  function isTileBusy(tile) {
    if (!tile) return false;
    const pct = getTileProgressText(tile);
    const progressBar = hasTileProgressBar(tile);
    const spinner = hasTileSpinner(tile);
    const genText = hasTileGenerationText(tile);
    const ariaBusy = tile.getAttribute("aria-busy") === "true" || Boolean(tile.querySelector('[aria-busy="true"]'));
    const placeholderTile = (typeof root.flowQuery === "function" && Boolean(root.flowQuery("tiles.placeholder", tile, { checkVisible: false }))) ||
      Boolean(tile.querySelector('flow-progress-tile, flow-rendering-tile, flow-generating-tile, flow-placeholder-tile, [class*="rendering"], [class*="generating"], [class*="placeholder"]'));
    const hasActiveProgress = Boolean(pct || progressBar || spinner || genText || ariaBusy || placeholderTile);
    const rendered = hasRenderedMedia(tile);
    const hasError = (typeof root.flowQuery === "function" && Boolean(root.flowQuery("tiles.error", tile, { checkVisible: false }))) ||
      Boolean(tile.querySelector("flow-error-tile, [class*='error-tile']"));

    return hasActiveProgress || (!rendered && !hasError);
  }

  function isTileMediaReady(tile) {
    if (!tile) return false;
    const hasError = (typeof root.flowQuery === "function" && Boolean(root.flowQuery("tiles.error", tile, { checkVisible: false }))) ||
      Boolean(tile.querySelector("flow-error-tile, [class*='error-tile']"));
    if (hasError) return false;
    return !isTileBusy(tile) && hasRenderedMedia(tile);
  }

  function collectNativeMedia() {
    const tileContainers = (typeof root.flowQueryAll === "function" ? root.flowQueryAll("tiles.container", document, { checkVisible: false }) : null) ||
      [...document.querySelectorAll("flow-grid-tile-container")];
    return tileContainers.map(tile => {
      const busy = isTileBusy(tile);
      const mediaReady = isTileMediaReady(tile);
      const error = (typeof root.flowQuery === "function" ? root.flowQuery("tiles.error", tile, { checkVisible: false }) : null) ||
        tile.querySelector("flow-error-tile, [class*='error-tile']");
      const kind = (typeof root.flowQuery === "function" && root.flowQuery("tiles.video", tile, { checkVisible: false }))
        ? (tile.querySelector("flow-scene-tile") ? "scene" : "video")
        : (tile.querySelector("flow-scene-tile") ? "scene" : tile.querySelector("flow-video-tile") ? "video" : "image");
      const id = root.mediaId?.(tile);
      const title = (tile.getAttribute("aria-label") || tile.getAttribute("title") || "").trim();
      const failureReason = error ? (error.innerText || error.textContent || "").replace(/\s+/g, " ").trim() : undefined;
      const progress = getTileProgressText(tile) || (busy ? (hasTileGenerationText(tile) ? "Đang render..." : "") : "");
      return { ...(id ? { id } : {}), title, busy, mediaReady, failed: Boolean(error), failureReason, kind, progress, element: tile };
    });
  }

  async function findFlowTile(title, retries = 100) {
    const norm = s => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
    const wanted = norm(title);
    const scroller = root.scrollContainer?.();
    if (scroller) scroller.scrollTop = 0;
    await root.wait?.(200);

    for (let step = 0; step < retries; step++) {
      const tileContainers = (typeof root.flowQueryAll === "function" ? root.flowQueryAll("tiles.container", document, { checkVisible: false }) : null) ||
        [...document.querySelectorAll("flow-grid-tile-container")];
      const tile = tileContainers.find(el => {
        const tTitle = norm(el.getAttribute("aria-label") || el.getAttribute("title"));
        return tTitle === wanted || tTitle.startsWith(wanted);
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

  async function countFlowTitleAcrossGrid(title) {
    const norm = s => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
    const wanted = norm(title);
    const scroller = root.scrollContainer?.();
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
          if (tTitle === wanted || tTitle.startsWith(wanted)) {
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

  async function retryNativeErrorTile(item) {
    const tileContainers = (typeof root.flowQueryAll === "function" ? root.flowQueryAll("tiles.container", document, { checkVisible: false }) : null) ||
      [...document.querySelectorAll("flow-grid-tile-container")];
    let tile = tileContainers.find(candidate =>
      item.id && !item.id.startsWith("title:") ? root.mediaId?.(candidate) === item.id : candidate.getAttribute("aria-label") === item.title);
    if (!tile) return false;
    tile.scrollIntoView({ block: "center" });
    const rect = tile.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    tile.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, clientX: x, clientY: y, pointerId: 1, pointerType: "mouse" }));
    tile.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, clientX: x, clientY: y }));
    await root.wait?.(250);
    const retryBtnConfig = root.FlowSelectors?.tiles?.retryButton;
    const labelRegex = retryBtnConfig?.textRegex || /^(?:retry|try again|thử lại)(?:\s+.*)?$/i;
    const iconRegex = retryBtnConfig?.iconRegex || /refresh|replay|retry/i;
    const retry = [...tile.querySelectorAll("button,[role=button]")].find(el => {
      if (!root.visible?.(el) || el.disabled || el.getAttribute("aria-disabled") === "true") return false;
      const label = (root.accessibleName?.(el) || "").replace(/\s+/g, " ").trim().toLowerCase();
      const icon = (root.flowFindIcon ? root.flowFindIcon(el) : el.querySelector("mat-icon,.mat-icon,.google-symbols,.material-symbols-outlined,svg"))?.textContent?.trim() || "";
      return root.matchesFlowUiRegex?.(label, labelRegex) || labelRegex.test(label) || iconRegex.test(icon);
    });
    if (!retry) return false;
    const retryRect = retry.getBoundingClientRect();
    const rx = retryRect.left + retryRect.width / 2;
    const ry = retryRect.top + retryRect.height / 2;
    const point = { bubbles: true, cancelable: true, composed: true, button: 0, clientX: rx, clientY: ry };
    retry.dispatchEvent(new PointerEvent("pointerover", { ...point, pointerId: 1, pointerType: "mouse" }));
    retry.dispatchEvent(new MouseEvent("mouseover", point));
    retry.dispatchEvent(new PointerEvent("pointerdown", { ...point, pointerId: 1, pointerType: "mouse" }));
    retry.dispatchEvent(new MouseEvent("mousedown", point));
    retry.dispatchEvent(new PointerEvent("pointerup", { ...point, pointerId: 1, pointerType: "mouse" }));
    retry.dispatchEvent(new MouseEvent("mouseup", point));
    retry.dispatchEvent(new MouseEvent("click", point));
    retry.click();
    await root.wait?.(2000);
    if (root.scrollContainer?.()) root.scrollContainer().scrollTop = 0;
    return true;
  }

  async function waitForProgressResult(command, before, expected, kind, timeoutMs, selector = "flow-grid-tile-container", allowConfirmedPartial = false) {
    const until = Date.now() + timeoutMs;
    const startedAt = Date.now();
    let hadProgress = false, last = "", lastTitleOnlyResult = "", retriesLeft = Math.max(1, Number(command?.retries ?? 2));
    let renderObservedInFlight = false;
    while (Date.now() < until) {
      const allMedia = collectNativeMedia();
      const fresh = allMedia.filter(item => !before.includes(item.id || `title:${item.title}`) && (!kind || item.kind === kind));
      const failed = fresh.filter(item => item.failed);
      if (failed.length) {
        const failureReason = failed[0]?.failureReason || "";
        const classified = root.classifyFlowError?.(failureReason);
        if (classified?.category === "rate_limit") {
          throw root.flowError(classified.code, classified.message, true, false);
        }
        if (classified && !classified.retryable) {
          throw root.flowError(classified.code, classified.message, false, false);
        }
        if (retriesLeft > 0 && await retryNativeErrorTile(failed[0])) {
          retriesLeft--;
          emitFlowProgress(command, `Flow thất bại render; đang thử lại (${retriesLeft} lần thử còn lại)`);
          continue;
        }
        if (!allowConfirmedPartial || fresh.filter(item => item.mediaReady).length >= expected) {
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
        const signature = picked.map(item => item.id || `title:${item.title}`).join("|");
        if (!titleOnly || signature === lastTitleOnlyResult) {
          emitFlowProgress(command, kind === "video" ? "Tạo video hoàn tất 100%" : "Tạo ảnh hoàn tất 100%");
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
      await root.wait?.(2000);
    }
    throw root.flowError("FLOW_OPERATION_TIMEOUT", "Hết thời gian chờ Flow. Tác vụ có thể đã được tiếp nhận; vui lòng kiểm tra giao diện Flow trước khi thử lại.", false, true);
  }

  async function waitForNativeEditorCompletion(command, timeoutMs, description) {
    const deadline = Date.now() + timeoutMs;
    let seenProgress = false;
    let previous = "";
    while (Date.now() < deadline) {
      const text = document.querySelector("main")?.innerText || document.body?.innerText || "";
      const progress = text.match(/\d{1,3}%/)?.[0];
      if (progress) {
        seenProgress = true;
        if (progress !== previous) emitFlowProgress(command, progress);
        previous = progress;
      } else if (seenProgress) {
        return true;
      }
      const failure = text.split("\n").map(line => line.trim()).find(line =>
        /(?:failed to generate|generation failed|could not generate|something went wrong|try again)/i.test(line));
      if (failure) throw root.flowError("FLOW_GENERATION_FAILED", `Flow reported a failed ${description}: ${failure.slice(0, 300)}`, false, true);
      await root.wait?.(2500);
    }
    throw root.flowError("FLOW_OPERATION_TIMEOUT", `Timed out waiting for Flow to finish the ${description}. Inspect Flow before retrying.`, false, true);
  }

  const FlowTiles = Object.freeze({
    collectNativeMedia,
    isTileBusy,
    isTileMediaReady,
    hasRenderedMedia,
    findFlowTile,
    countFlowTitleAcrossGrid,
    retryNativeErrorTile,
    waitForProgressResult,
    waitForNativeEditorCompletion,
    armNativeFlowCorrelation,
    disarmNativeFlowCorrelation,
    nativeFlowCorrelationReceipt,
    nativeFlowCorrelationMap,
    flowPromptFingerprint,
    emitFlowProgress,
  });

  root.FlowTiles = FlowTiles;
  root.collectNativeMedia = collectNativeMedia;
  root.isTileBusy = isTileBusy;
  root.isTileMediaReady = isTileMediaReady;
  root.hasRenderedMedia = hasRenderedMedia;
  root.findFlowTile = findFlowTile;
  root.countFlowTitleAcrossGrid = countFlowTitleAcrossGrid;
  root.waitForProgressResult = waitForProgressResult;
  root.waitForNativeEditorCompletion = waitForNativeEditorCompletion;
  root.armNativeFlowCorrelation = armNativeFlowCorrelation;
  root.disarmNativeFlowCorrelation = disarmNativeFlowCorrelation;
  root.nativeFlowCorrelationReceipt = nativeFlowCorrelationReceipt;
  root.nativeFlowCorrelationMap = nativeFlowCorrelationMap;
  root.retryNativeErrorTile = retryNativeErrorTile;
  root.emitFlowProgress = emitFlowProgress;
})(globalThis);
