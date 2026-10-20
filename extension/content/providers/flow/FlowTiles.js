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

  function collectNativeMedia() {
    return [...document.querySelectorAll("flow-grid-tile-container")].map(tile => {
      const busy = Boolean(tile.querySelector('flow-progress-tile,mat-progress-bar,[role="progressbar"]'));
      const error = tile.querySelector("flow-error-tile");
      const kind = tile.querySelector("flow-scene-tile") ? "scene" : tile.querySelector("flow-video-tile") ? "video" : "image";
      const id = root.mediaId?.(tile);
      const title = (tile.getAttribute("aria-label") || tile.getAttribute("title") || "").trim();
      const failureReason = error ? (error.innerText || error.textContent || "").replace(/\s+/g, " ").trim() : undefined;
      return { ...(id ? { id } : {}), title, busy, failed: Boolean(error), failureReason, kind };
    });
  }

  async function findFlowTile(title, retries = 100) {
    const norm = s => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
    const wanted = norm(title);
    const scroller = root.scrollContainer?.();
    if (scroller) scroller.scrollTop = 0;
    await root.wait?.(200);

    for (let step = 0; step < retries; step++) {
      const tile = [...document.querySelectorAll("flow-grid-tile-container")].find(el => {
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
        for (const tile of document.querySelectorAll("flow-grid-tile-container")) {
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
    let tile = [...document.querySelectorAll("flow-grid-tile-container")].find(candidate =>
      item.id && !item.id.startsWith("title:") ? root.mediaId?.(candidate) === item.id : candidate.getAttribute("aria-label") === item.title);
    if (!tile) return false;
    tile.scrollIntoView({ block: "center" });
    const rect = tile.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    tile.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, clientX: x, clientY: y, pointerId: 1, pointerType: "mouse" }));
    tile.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, clientX: x, clientY: y }));
    await root.wait?.(250);
    const retry = [...tile.querySelectorAll("button,[role=button]")].find(el => {
      if (!root.visible?.(el) || el.disabled || el.getAttribute("aria-disabled") === "true") return false;
      const label = (root.accessibleName?.(el) || "").replace(/\s+/g, " ").trim().toLowerCase();
      const icon = el.querySelector("mat-icon,.mat-icon,.google-symbols,.material-symbols-outlined,svg")?.textContent?.trim() || "";
      return /^(retry|try again|thử lại)$/i.test(label) || /refresh|replay|retry/i.test(icon);
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
    let hadProgress = false, last = "", lastTitleOnlyResult = "", retriesLeft = Math.max(1, Number(command?.retries ?? 2));
    while (Date.now() < until) {
      const fresh = collectNativeMedia().filter(item => !before.includes(item.id || `title:${item.title}`) && (!kind || item.kind === kind));
      const failed = fresh.filter(item => item.failed);
      if (failed.length) {
        const failureReason = failed[0]?.failureReason || "";
        const classified = root.classifyFlowError?.(failureReason);
        if (classified && !classified.retryable) {
          throw root.flowError(classified.code, classified.message, false, false);
        }
        if (retriesLeft > 0 && await retryNativeErrorTile(failed[0])) {
          retriesLeft--;
          emitFlowProgress(command, `Flow failed this render; retrying its failed tile (${retriesLeft} retries remaining)`);
          continue;
        }
        if (!allowConfirmedPartial || fresh.filter(item => !item.busy).length >= expected) {
          const ready = fresh.filter(item => !item.busy && !item.failed);
          const failure = failed[0];
          const error = root.flowError("FLOW_GENERATION_FAILED", `Flow failed while processing "${failure.title}"${failure.failureReason ? `: ${failure.failureReason}` : ""}. Nothing was charged for the failed render.`, false, false);
          if (allowConfirmedPartial && ready.length + failed.length >= expected) {
            error.partialMedia = ready.map(descriptor);
            error.failedMedia = failed.map(descriptor);
          }
          throw error;
        }
      }
      const ready = fresh.filter(item => !item.busy && !item.failed);
      if (ready.length >= expected) {
        const picked = ready.slice(0, expected);
        const titleOnly = picked.some(item => !item.id || item.id.startsWith("title:"));
        const signature = picked.map(item => item.id || `title:${item.title}`).join("|");
        if (!titleOnly || signature === lastTitleOnlyResult) return picked.map(descriptor);
        lastTitleOnlyResult = signature;
        emitFlowProgress(command, "Flow is finishing the video title");
        await root.wait?.(1500);
        continue;
      }
      const pct = [...document.querySelectorAll(selector)].slice(0, 10).map(el => (el.innerText || "").match(/\d+%/)?.[0]).filter(Boolean);
      if (pct.length) hadProgress = true;
      const text = pct.join(", ") || (hadProgress ? "Flow is finishing the result" : "Waiting for Flow");
      if (text !== last) { emitFlowProgress(command, text); last = text; }
      await root.wait?.(2500);
    }
    throw root.flowError("FLOW_OPERATION_TIMEOUT", "Timed out waiting for Flow. The operation may have completed; inspect Flow before retrying.", false, true);
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
