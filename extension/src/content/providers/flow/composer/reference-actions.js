// Flow reference attachment, chip inspection, and native voice selection.
(() => {
  "use strict";
  const root = typeof globalThis !== "undefined" ? globalThis : (typeof window !== "undefined" ? window : self);
  const normalize = value => String(value || "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
  const throwIfAborted = (signal, operation, outcomeUnknown = false) => {
    if (!signal?.aborted) return;
    throw root.flowError("FLOW_OPERATION_TIMEOUT", `Timed out while ${operation}; the Flow operation was cancelled and no later actions will start.`, false, outcomeUnknown);
  };
  const boundedWait = async (ms, deadline, operation, outcomeUnknown = false, signal) => {
    throwIfAborted(signal, operation, outcomeUnknown);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw root.flowError("FLOW_OPERATION_TIMEOUT", `Timed out while ${operation}; no further Flow actions were started.`, true, outcomeUnknown);
    const duration = Math.min(ms, remaining);
    if (!signal) await wait(duration);
    else await new Promise((resolve, reject) => {
      const timer = setTimeout(done, duration);
      function cleanup() { signal.removeEventListener("abort", abort); }
      function done() { cleanup(); resolve(); }
      function abort() { clearTimeout(timer); cleanup(); reject(root.flowError("FLOW_OPERATION_TIMEOUT", `Timed out while ${operation}; the Flow operation was cancelled and no later actions will start.`, false, outcomeUnknown)); }
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
    throwIfAborted(signal, operation, outcomeUnknown);
    if (Date.now() >= deadline) throw root.flowError("FLOW_OPERATION_TIMEOUT", `Timed out while ${operation}; no further Flow actions were started.`, true, outcomeUnknown);
  };
  const requireTime = (deadline, operation, outcomeUnknown = false, signal) => {
    throwIfAborted(signal, operation, outcomeUnknown);
    if (Date.now() >= deadline) throw root.flowError("FLOW_OPERATION_TIMEOUT", `Timed out while ${operation}; no further Flow actions were started.`, true, outcomeUnknown);
  };
  const makeDeadline = (command, fallbackMs = 60_000, reserveMs = 10_000) => {
    const callerTimeout = Number(command?.timeoutMs ?? command?.timeout_ms);
    const callerBudget = Number.isFinite(callerTimeout) && callerTimeout > 0 ? Math.max(250, callerTimeout - reserveMs) : fallbackMs;
    return Date.now() + Math.min(fallbackMs, callerBudget);
  };
  async function resolveNativeMediaUuid(id, expectedType = "image") {
    const value = String(id || "");
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (uuidPattern.test(value)) return value.toLowerCase();
    const asb = value.match(/^asb:([A-Za-z0-9_-]{32,1024})$/)?.[1];
    if (!asb || !["image", "video"].includes(expectedType)) return undefined;
    const projectId = location.pathname.match(/\/project\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i)?.[1]?.toLowerCase();
    if (!projectId) return undefined;
    const identitiesEvent = "TOBY_FLOW_MEDIA_IDENTITIES";
    const identitiesV2Event = "TOBY_FLOW_V2_MEDIA_IDENTITIES";
    const readEvent = "TOBY_FLOW_MEDIA_IDENTITIES_READ";
    const readV2Event = "TOBY_FLOW_V2_MEDIA_IDENTITIES_READ";
    return new Promise(resolve => {
      let settled = false;
      const finish = idValue => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        window.removeEventListener(identitiesEvent, onIdentities);
        window.removeEventListener(identitiesV2Event, onIdentities);
        resolve(idValue);
      };
      const onIdentities = event => {
        const detail = event?.detail;
        if (String(detail?.projectId || "").toLowerCase() !== projectId || !Array.isArray(detail?.entries)) return;
        const matches = detail.entries.filter(entry => entry?.asb === asb && entry?.mediaType === expectedType && uuidPattern.test(String(entry?.mediaUuid || "")));
        finish(matches.length === 1 ? String(matches[0].mediaUuid).toLowerCase() : undefined);
      };
      const timer = setTimeout(() => finish(undefined), 500);
      window.addEventListener(identitiesEvent, onIdentities);
      window.addEventListener(identitiesV2Event, onIdentities);
      window.dispatchEvent(new CustomEvent(readEvent));
      window.dispatchEvent(new CustomEvent(readV2Event));
    });
  }
  root.resolveNativeMediaUuid = resolveNativeMediaUuid;
  root.FlowUiDeadline = Object.freeze({ makeDeadline, requireTime, boundedWait });
  const undecorate = value => normalize(value).replace(/\s+(?:image|video|character|avatar|ảnh|nhân vật)$/i, "");
  const identity = value => String(value || "").replace(/=(?:s\d+(?:-[a-z]+)*|mm,\d+,\d+)$/, "");
  const isCharacterRoute = path => /\/character(?:\/|$)/i.test(path || "");
  const isNewCharacterRoute = path => /\/character\/?$/i.test(path || "");
  const isCharacterEditorRoute = path => /\/character\/[0-9a-f-]{36}(?:\/|$)/i.test(path || "");
  const metadata = new WeakMap();
  let referenceContextMenuTail = Promise.resolve();
  let lastReferenceActionDiagnostics = { action: "idle", phase: "idle", step: "idle", error: null, cleanupError: null, updatedAt: null };
  function parse(value) {
    const text = typeof value === "string" ? value : value?.assetName;
    const explicitCharacter = /^character:/i.test(text || "");
    const name = String(text || "").replace(/^(?:asset|character):/i, "").trim();
    if (!name) throw flowError("FLOW_INVALID_ARGUMENT", "Reference name is required.");
    return { name, kind: explicitCharacter ? "character" : value?.kind };
  }
  function exactOption(options, name, decorated = true) {
    const wanted = normalize(name);
    const matches = options.filter(option => {
      const names = [accessibleName(option), option.getAttribute("aria-label"), option.getAttribute("title")];
      for (const node of option.querySelectorAll("[aria-label],[title]")) names.push(node.getAttribute("aria-label"), node.getAttribute("title"));
      return names.some(value => normalize(value) === wanted || decorated && undecorate(value) === wanted);
    });
    if (matches.length > 1) throw flowError("FLOW_ASSET_AMBIGUOUS", `More than one reference is named "${name}". Select a unique name or use character:<name> for a character. Nothing was attached.`);
    return matches[0] || null;
  }
  function referenceOptionMediaId(option) {
    // Identity must come from this exact option's tile/attributes; a global
    // same-title tile elsewhere in the library is not proof for this category.
    const tile = (typeof root.flowQuery === "function" ? root.flowQuery("tiles.container", option, { checkVisible: false }) : null) ||
      option?.querySelector?.("flow-grid-tile-container");
    const tileId = tile && mediaId(tile);
    return (tileId && !tileId.startsWith("title:") ? tileId : null) || option?.getAttribute?.("data-media-id") ||
      option?.querySelector?.("[data-media-id]")?.getAttribute("data-media-id") || tileId || undefined;
  }
  function referenceOptionLabels(option) {
    const labels = [accessibleName(option), option.getAttribute("aria-label"), option.getAttribute("title")];
    for (const node of option.querySelectorAll("[aria-label],[title],img[alt],flow-grid-tile-container")) {
      labels.push(node.getAttribute("aria-label"), node.getAttribute("title"), node.getAttribute("alt"));
    }
    return labels.map(value => String(value || "").replace(/\s+/g, " ").trim()).filter(Boolean);
  }
  function referenceOptionIdentity(option, page, index) {
    for (const attr of ["data-index", "aria-posinset", "data-virtual-index"]) {
      const value = option.getAttribute(attr);
      if (value) return `${attr}:${value}`;
    }
    if (option.id) return `option:${option.id}`;
    return `page:${page}:option:${index}`;
  }
  function diagnosticLabelHash(value) {
    let hash = 2166136261;
    const text = normalize(value);
    for (let index = 0; index < text.length; index++) { hash ^= text.charCodeAt(index); hash = Math.imul(hash, 16777619); }
    return `h-${(hash >>> 0).toString(16).padStart(8, "0")}`;
  }
  function diagnosticOptionHashes(options) {
    return [...new Set(options.flatMap(referenceOptionLabels).map(diagnosticLabelHash))].slice(0, 60);
  }
  function diagnosticCategory(value) {
    return ["all", "characters", "voices", "uploads", "ingredients"].includes(value) ? value : "unknown";
  }
  function referenceScrollOwner(list) {
    const candidates = [];
    const addCandidate = (element, depth) => {
      const clientHeight = Number(element?.clientHeight) || 0;
      const scrollHeight = Number(element?.scrollHeight) || 0;
      if (!visible(element) || clientHeight <= 0 || scrollHeight <= clientHeight + 5) return;
      let overflowY = String(element?.style?.overflowY || "").toLowerCase();
      try { overflowY = String(globalThis.getComputedStyle?.(element)?.overflowY || overflowY).toLowerCase(); } catch {}
      if (!/^(?:auto|scroll|overlay)$/.test(overflowY)) return;
      if (!Number.isFinite(element.scrollTop)) return;
      if (!candidates.some(candidate => candidate.element === element)) candidates.push({ element, depth, clientHeight, scrollHeight });
    };
    // Descendant scroll viewports are within the listbox surface.
    for (const child of list.querySelectorAll("*")) addCandidate(child, 1);
    // Flow sometimes places the virtual viewport around, rather than inside,
    // the listbox. Walk only its own ancestor chain and stop at the picker
    // dialog or after five levels; never search a global document scroller.
    const boundary = list.closest?.('[role="dialog"]') || null;
    let current = list;
    for (let depth = 0; current && depth <= 5; depth++) {
      addCandidate(current, -depth);
      if (current === boundary) break;
      current = current.parentElement;
    }
    // A measured listbox with no overflow is a complete static list. Use it
    // only when there are no scrollable owners anywhere in the bounded surface.
    if (!candidates.length && Number(list.clientHeight) > 0 && Number(list.scrollHeight) > 0 && Number(list.scrollHeight) <= Number(list.clientHeight) + 5 && Number.isFinite(list.scrollTop)) {
      candidates.push({ element: list, depth: 0, clientHeight: Number(list.clientHeight), scrollHeight: Number(list.scrollHeight) });
    }
    const evidence = candidate => ({
      scrollOwnerCount: candidates.length,
      scrollOwnerDepth: candidate?.depth ?? null,
      scrollClientHeight: candidate?.clientHeight ?? 0,
      scrollHeight: candidate?.scrollHeight ?? 0,
      scrollTop: Number(candidate?.element?.scrollTop) || 0,
    });
    return { candidate: candidates.length === 1 ? candidates[0] : null, count: candidates.length, evidence: evidence(candidates.length === 1 ? candidates[0] : null) };
  }
  function referencePageSignature(list) {
    return JSON.stringify(listOptions(list).map((option, index) => ({
      labels: referenceOptionLabels(option).map(normalize).sort(),
      identity: referenceOptionIdentity(option, 0, index),
    })));
  }
  function referenceScanEvidence(patch = {}) {
    const language = String(document.documentElement?.lang || "").trim().toLowerCase().split(/[-_]/, 1)[0];
    return {
      locale: ["en", "vi"].includes(language) ? language : "unknown",
      searchLabelRecognized: lastReferenceActionDiagnostics.searchLabelRecognized === true,
      searchLabel: lastReferenceActionDiagnostics.searchLabel || null,
      searchResultsVerified: lastReferenceActionDiagnostics.searchResultsVerified === true,
      activeCategory: diagnosticCategory(lastReferenceActionDiagnostics.activeCategory),
      categoriesScanned: Array.isArray(lastReferenceActionDiagnostics.categoriesScanned)
        ? [...new Set(lastReferenceActionDiagnostics.categoriesScanned.filter(value => ["all", "uploads"].includes(value)))].slice(0, 2) : [],
      categorySelected: lastReferenceActionDiagnostics.categorySelected === true,
      optionCount: Number(lastReferenceActionDiagnostics.pickerOptionCount) || 0,
      pages: Number(lastReferenceActionDiagnostics.pickerScanPages) || 0,
      endReached: lastReferenceActionDiagnostics.pickerScanEndReached === true,
      optionLabelHashes: Array.isArray(lastReferenceActionDiagnostics.optionLabelHashes) ? lastReferenceActionDiagnostics.optionLabelHashes.slice(0, 60) : [],
      exactTargetFound: lastReferenceActionDiagnostics.exactTargetFound === true,
      scrollOwnerCount: Number(lastReferenceActionDiagnostics.scrollOwnerCount) || 0,
      scrollOwnerDepth: Number.isInteger(lastReferenceActionDiagnostics.scrollOwnerDepth) ? lastReferenceActionDiagnostics.scrollOwnerDepth : null,
      scrollClientHeight: Number(lastReferenceActionDiagnostics.scrollClientHeight) || 0,
      scrollHeight: Number(lastReferenceActionDiagnostics.scrollHeight) || 0,
      scrollTop: Number(lastReferenceActionDiagnostics.scrollTop) || 0,
      tileActionAttempted: lastReferenceActionDiagnostics.path === "uploaded_tile_context_menu",
      tileActionStep: ["queued", "menu_missing", "menu_owned", "action_clicked", "chip_confirmed"].includes(lastReferenceActionDiagnostics.tileActionStep)
        ? lastReferenceActionDiagnostics.tileActionStep : null,
      tileActionMenuObserved: lastReferenceActionDiagnostics.surfaceStatus === "unique_new_menu_and_action" || lastReferenceActionDiagnostics.surfaceStatus === "attached",
      ...patch,
    };
  }
  async function scanExactReferenceOption(name, decorated, deadline, signal) {
    let list = picker();
    if (!list) throw flowError("FLOW_ASSET_PICKER_LOADING", "Flow's reference picker closed before its options could be scanned.", true, false);
    const scrollOwner = referenceScrollOwner(list);
    const scroller = scrollOwner.candidate?.element || null;
    lastReferenceActionDiagnostics = { ...lastReferenceActionDiagnostics, ...scrollOwner.evidence };
    if (!scroller) {
      const code = scrollOwner.count > 1 ? "FLOW_REFERENCE_SCAN_SCROLL_OWNER_AMBIGUOUS" : "FLOW_REFERENCE_SCAN_SCROLL_OWNER_MISSING";
      const error = flowError(code, "Flow's active reference picker has no unique measurable scroll owner; no reference was selected.", true, false);
      error.diagnostics = referenceScanEvidence({ pages: 0, endReached: false, optionCount: options().length, errorCode: code, ...scrollOwner.evidence });
      throw error;
    }
    const seen = new Set();
    const exact = new Map();
    const labelHashes = new Set();
    let pages = 0;
    let reachedEnd = false;
    const addVisible = () => {
      list = picker();
      if (!list) return false;
      const current = listOptions(list);
      pages++;
      current.forEach((option, index) => {
        for (const hash of diagnosticOptionHashes([option])) labelHashes.add(hash);
        const key = referenceOptionIdentity(option, pages, index);
        if (seen.has(key)) return;
        seen.add(key);
        if (exactOption([option], name, decorated) && !exact.has(key)) exact.set(key, { option, scrollTop: scroller?.scrollTop || 0, key, page: pages });
      });
      return true;
    };
    try {
      if (scroller) scroller.scrollTop = 0;
      await boundedWait(120, deadline, "starting a bounded reference picker scan", false, signal);
      const maxPages = 60;
      for (let page = 0; page < maxPages; page++) {
        requireTime(deadline, "scanning Flow reference options", false, signal);
        if (!addVisible()) throw flowError("FLOW_REFERENCE_SCAN_INCOMPLETE", "Flow's reference picker disappeared during its bounded scan.", true, false);
        const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        if (scroller.scrollTop >= maxScroll - 2) { reachedEnd = true; break; }
        const previous = scroller.scrollTop;
        const previousSignature = referencePageSignature(list);
        const pageStep = Math.max(180, scroller.clientHeight * 0.8);
        // When the remaining overflow is smaller than one page, explicitly
        // request the exact bottom of this already-verified picker scroller.
        // A short final movement may not change the visible option signature.
        const targetTop = maxScroll - previous <= pageStep ? maxScroll : previous + pageStep;
        scroller.scrollTop = targetTop;
        if (scroller.scrollTop <= previous) break;
        const pageDeadline = Math.min(Date.now() + 1600, deadline);
        let pageChanged = false;
        let bottomReached = false;
        while (Date.now() < pageDeadline) {
          try { await boundedWait(120, pageDeadline, "waiting for the Flow reference picker page to change", false, signal); }
          catch (error) {
            if (error?.code === "FLOW_OPERATION_TIMEOUT" && Date.now() >= pageDeadline) break;
            throw error;
          }
          list = picker();
          if (!list) break;
          const signatureChanged = referencePageSignature(list) !== previousSignature;
          if (scroller.scrollTop >= targetTop - 2 && scroller.scrollTop >= maxScroll - 2) {
            // Re-read the bottom viewport if the short final scroll exposed a
            // different set of options. Identical labels are safe here because
            // reaching maxScroll on the unique owner proves the list end.
            if (signatureChanged && !addVisible()) break;
            reachedEnd = true;
            bottomReached = true;
            break;
          }
          if (scroller.scrollTop >= targetTop - 2 && signatureChanged) {
            pageChanged = true;
            break;
          }
        }
        if (bottomReached) break;
        if (!list || !pageChanged) {
          const error = flowError("FLOW_REFERENCE_SCAN_INCOMPLETE", "Flow's reference picker did not render a verifiably different page after scrolling; no reference was selected.", true, false);
          error.diagnostics = referenceScanEvidence({ pages, endReached: false, optionCount: options().length,
            errorCode: error.code, ...scrollOwner.evidence,
            scrollTop: Number(scroller.scrollTop) || 0 });
          throw error;
        }
      }
      lastReferenceActionDiagnostics = { ...lastReferenceActionDiagnostics, pickerScanPages: pages, pickerScanEndReached: reachedEnd,
        pickerOptionCount: seen.size, optionLabelHashes: [...labelHashes].slice(0, 60), exactTargetFound: exact.size > 0,
        scrollTop: Number(scroller.scrollTop) || 0 };
      if (!reachedEnd) {
        const error = flowError("FLOW_REFERENCE_SCAN_INCOMPLETE", "Flow's reference picker scan did not reach a verifiable end; no reference was selected.", true, false);
        error.diagnostics = referenceScanEvidence({ pages, endReached: false, optionCount: options().length, errorCode: error.code });
        throw error;
      }
      if (exact.size > 1) {
        const error = flowError("FLOW_ASSET_AMBIGUOUS", `More than one reference is named "${name}". Nothing was attached.`, false, false);
        error.diagnostics = referenceScanEvidence({ pages, endReached: true, optionCount: options().length, errorCode: error.code });
        throw error;
      }
      const match = exact.values().next().value || null;
      if (match && scroller && scroller.scrollTop !== match.scrollTop) {
        scroller.scrollTop = match.scrollTop;
        await boundedWait(180, deadline, "returning to the exact Flow reference option", false, signal);
        list = picker();
        const current = list && listOptions(list);
        const restored = current?.find((option, index) => referenceOptionIdentity(option, match.page, index) === match.key && exactOption([option], name, decorated));
        if (!restored) {
          const error = flowError("FLOW_REFERENCE_SCAN_INCOMPLETE", "Flow's exact reference option changed while restoring the picker position; nothing was attached.", true, false);
          error.diagnostics = referenceScanEvidence({ pages, endReached: true, optionCount: seen.size, errorCode: error.code });
          throw error;
        }
        match.option = restored;
      }
      return { option: match?.option || null, pages, reachedEnd, optionCount: seen.size };
    } catch (error) {
      lastReferenceActionDiagnostics = { ...lastReferenceActionDiagnostics, pickerScanPages: pages, pickerScanEndReached: reachedEnd,
        pickerOptionCount: seen.size, optionLabelHashes: [...labelHashes].slice(0, 60), exactTargetFound: exact.size > 0,
        scrollTop: Number(scroller.scrollTop) || 0 };
      if (!error?.diagnostics) error.diagnostics = referenceScanEvidence({ pages, endReached: reachedEnd, optionCount: options().length, errorCode: error?.code || "FLOW_REFERENCE_SCAN_ERROR" });
      throw error;
    } finally {
      if (scroller?.isConnected) scroller.scrollTop = 0;
    }
  }
  function listOptions(list, checkVis = true) {
    if (!list) return [];
    if (typeof root.flowQueryAll === "function") {
      const results = root.flowQueryAll("components.optionItem", list, { checkVisible: checkVis });
      if (results && results.length) return results;
    }
    const raw = [...(list.querySelectorAll?.('[role="option"]') || [])];
    return checkVis ? raw.filter(visible) : raw;
  }

  function referenceComposerScope() {
    const configuredEditors = typeof root.flowQueryAll === "function" ? root.flowQueryAll("editor", document, { checkVisible: false }) : [];
    const querySingleEditor = typeof root.flowQuery === "function" ? root.flowQuery("editor", document, { checkVisible: false }) : null;
    const singleEditor = querySingleEditor || document.querySelector?.(".ProseMirror[contenteditable='true'],.ProseMirror,flow-base-prompt-box [contenteditable='true']");
    const fallbackEditors = singleEditor ? [singleEditor] : [];
    const editors = [...new Set([
      ...(Array.isArray(configuredEditors) ? configuredEditors : configuredEditors ? [configuredEditors] : []),
      ...(document.querySelectorAll?.(".ProseMirror[contenteditable='true'],flow-base-prompt-box [contenteditable='true']") || []),
      ...fallbackEditors
    ])].filter(el => el && el.isContentEditable !== false && el.isConnected !== false && visible(el));
    const focused = document.activeElement;
    const editor = editors.includes(focused) ? focused : editors.length === 1 ? editors[0] : null;
    const composerSelector = "flow-base-prompt-box,.flow-composer,form,[class*='composer'],[class*='prompt-box'],[class*='prompt-container'],[data-testid*='composer']";
    let explicitComposer = editor?.closest?.(composerSelector);
    if (!explicitComposer && editor?.parentElement) {
      for (let node = editor.parentElement, depth = 0; node && node !== document.body && depth < 12; node = node.parentElement, depth++) {
        const tag = String(node.tagName || "").toLowerCase();
        const cls = String(node.className?.baseVal || node.className || "");
        if (tag === "flow-base-prompt-box" || tag === "form" || /composer|prompt/i.test(`${tag} ${cls}`)) {
          explicitComposer = node;
          break;
        }
      }
    }
    if (explicitComposer) return explicitComposer;
    if (!editor && editors.length > 1) throw flowError("FLOW_COMPOSER_AMBIGUOUS", "Flow has multiple visible prompt editors and none is active; reference chips could not be scoped safely.", true, false);
    const configuredComposers = typeof root.flowQueryAll === "function" ? root.flowQueryAll("composerRoot", document) : [];
    const querySingleComposer = typeof root.flowQuery === "function" ? root.flowQuery("composerRoot", document, { checkVisible: false }) : null;
    const composerList = [
      ...(Array.isArray(configuredComposers) ? configuredComposers : configuredComposers ? [configuredComposers] : []),
      ...(querySingleComposer ? [querySingleComposer] : []),
    ];
    const configuredComposer = composerList.length >= 1 ? composerList[0] : null;
    if (configuredComposer && (!editor || configuredComposer.contains?.(editor))) return configuredComposer;
    const domComposer = document.querySelector?.(composerSelector);
    if (domComposer && (!editor || domComposer.contains?.(editor))) return domComposer;
    if (editor) return editor;
    return document;
  }
  function referenceChipBoundary(button) {
    const explicit = button?.closest?.("flow-character-ingredient-chip,[data-chip],[data-ingredient-type='image'],[data-ingredient-type='video'],[data-ingredient-type='character'],[data-kind='image'],[data-kind='video'],[data-kind='character']");
    if (explicit) return explicit;
    const kindOwner = button?.closest?.("[data-kind='image'],[data-kind='character']");
    if (!kindOwner) return null;
    // data-kind can label a container in some Flow builds. Only use it as a
    // chip owner when it contains at most one thumbnail, otherwise separate
    // image chips inside the shared container would collapse into one.
    const thumbnails = kindOwner.querySelectorAll?.("img,[role='img']") || [];
    return thumbnails.length <= 1 ? kindOwner : null;
  }
  function normalizeChipLabel(value) {
    return String(value || "").toLocaleLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").replace(/\s+/g, " ").trim();
  }
  function chips() {
    const scope = referenceComposerScope();
    let configuredChips = (typeof root.flowQueryAll === "function" ? root.flowQueryAll("components.chips", scope, { checkVisible: false }) : null) ||
      [...(scope.querySelectorAll?.('button[aria-label="Ingredient"]') || [])];
    if (!configuredChips.length && scope !== document) {
      configuredChips = [...(document.querySelectorAll?.('button[aria-label="Ingredient"]') || [])];
    }
    let viChips = [...(scope.querySelectorAll?.('button[aria-label="Thành phần"],button[aria-label="Nguyên liệu"]') || [])];
    if (!viChips.length && scope !== document) {
      viChips = [...(document.querySelectorAll?.('button[aria-label="Thành phần"],button[aria-label="Nguyên liệu"]') || [])];
    }
    const dynamicButtons = (typeof root.flowQueryAll === "function" ? root.flowQueryAll("common.buttons", scope, { checkVisible: false }) : null) ||
      [...(scope.querySelectorAll?.('button,[role="button"]') || [])];
    let videoChips = (typeof root.flowQueryAll === "function" ? root.flowQueryAll("components.videoChip", scope, { checkVisible: false }) : null) ||
      [...(scope.querySelectorAll?.('[data-ingredient-type="video"],[data-kind="video"],[class*="ingredient-video" i],[class*="video-chip" i]') || [])];
    if (!videoChips.length && scope !== document) {
      videoChips = [...(document.querySelectorAll?.('[data-ingredient-type="video"],[data-kind="video"],[class*="ingredient-video" i],[class*="video-chip" i]') || [])];
    }
    const isIngredientChipControl = btn => {
      if (!visible(btn)) return false;
      // The shipped chips selector includes generic `button` and
      // `[role=button]` fallbacks. Being returned by that selector is not
      // evidence that a control is an ingredient chip.
      if (viChips.includes(btn)) return true;
      const aria = normalizeChipLabel(accessibleName(btn));
      const alt = normalizeChipLabel(btn.querySelector?.("img")?.alt || "");
      const isChipElement = Boolean(referenceChipBoundary(btn));
      if (isChipElement && /(?:remove|delete|close|xoa|dong)/i.test(aria)) return false;
      return isChipElement || /^(?:ingredient|thanh phan|nguyen lieu)(?:\b|$)/i.test(aria) ||
        /(?:^|\b)(?:ingredient|thanh phan|nguyen lieu)(?:\b|$)/i.test(alt);
    };
    // Selector fallbacks include generic buttons; count only actual ingredient controls.
    const candidates = [...new Set([...configuredChips, ...viChips, ...dynamicButtons, ...videoChips])].filter(isIngredientChipControl);
    const score = button => {
      const aria = (accessibleName(button) || button.getAttribute?.("aria-label") || "").toLowerCase();
      return (/(?:^|\b)(?:ingredient|thành phần|nguyên liệu)(?:\b|$)/i.test(aria) ? 100 : 0) +
        (button.querySelector?.("img") ? 20 : 0) -
        (/(?:remove|delete|close|xóa|đóng)/i.test(aria) ? 1000 : 0);
    };
    const logicalChips = new Map();
    for (const button of candidates) {
      const owner = referenceChipBoundary(button) || button;
      const previous = logicalChips.get(owner);
      if (!previous || score(button) > score(previous)) logicalChips.set(owner, button);
    }
    return [...logicalChips.values()].map(button => {
      const image = button.querySelector?.("img");
      const explicitKind = button.getAttribute?.("data-ingredient-type") || button.getAttribute?.("data-kind") ||
        button.closest?.("[data-ingredient-type], [data-kind]")?.getAttribute?.("data-ingredient-type") ||
        button.closest?.("[data-kind]")?.getAttribute?.("data-kind");
      const kindText = String(explicitKind || "").trim();
      const owner = referenceChipBoundary(button) || button;
      const videoEl = owner.querySelector?.("video,flow-video-tile");
      const isVideoElement = Boolean(videoEl && /video/i.test(String(videoEl.tagName || videoEl.className || "")));
      const kind = /voice|giọng/i.test(kindText) || /voice-chip|ingredient-voice/i.test(String(owner.className?.baseVal || owner.className || "")) ? "voice" :
        /video|clip/i.test(kindText) || /video-chip|ingredient-video/i.test(String(owner.className?.baseVal || owner.className || "")) || isVideoElement ? "video" :
        button.closest?.("flow-character-ingredient-chip") || /^(?:character|nhân vật)$/i.test(kindText) ? "character" : "image";
      return { element: button, owner, kind, source: identity(image?.getAttribute?.("src")), ...metadata.get(button) };
    });
  }
  function chipAttachEvidence(before, current, added, stage) {
    const describe = chip => {
      const element = chip?.element;
      const owner = chip?.owner || element;
      const mediaIds = chip ? chipMediaUuids(chip) : [];
      const rawMarker = owner?.tagName?.toLowerCase?.() === "flow-character-ingredient-chip" ? "character_chip" :
        owner?.getAttribute?.("data-chip") !== null && owner?.getAttribute?.("data-chip") !== undefined ? "data_chip" :
        owner?.getAttribute?.("data-ingredient-type") || owner?.getAttribute?.("data-kind") || null;
      const marker = ["character_chip", "data_chip", "image", "character", "voice"].includes(rawMarker) ? rawMarker : rawMarker ? "other" : null;
      return {
        kind: chip?.kind || "unknown",
        tag: element?.tagName?.toLowerCase?.() || null,
        ownerTag: owner?.tagName?.toLowerCase?.() || null,
        marker: typeof marker === "string" ? marker.slice(0, 24) : null,
        role: element?.getAttribute?.("role") || null,
        hasThumbnail: Boolean(element?.querySelector?.("img,[role='img']")),
        hasSource: Boolean(chip?.source),
        hasMediaUuid: mediaIds.length > 0,
        hasName: Boolean(chip?.name),
      };
    };
    return {
      stage,
      beforeCount: before.length,
      afterCount: current.length,
      countDelta: current.length - before.length,
      deltaCount: added.length,
      beforeKinds: before.slice(0, 8).map(chip => chip.kind),
      afterKinds: current.slice(0, 8).map(chip => chip.kind),
      deltaKinds: added.slice(0, 8).map(chip => chip.kind),
      chips: current.slice(0, 8).map(describe),
    };
  }
  const characterUuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  function explicitCharacterUuid(...nodes) {
    for (const node of nodes.filter(Boolean)) {
      for (const attr of ["data-character-id", "data-character-uuid"]) {
        const value = node.getAttribute?.(attr);
        if (typeof value === "string" && characterUuidPattern.test(value.trim())) return value.trim().toLowerCase();
      }
      for (const attr of ["[data-character-id]", "[data-character-uuid]"]) {
        const child = node.querySelector?.(attr);
        const value = child?.getAttribute?.(attr.slice(1, -1));
        if (typeof value === "string" && characterUuidPattern.test(value.trim())) return value.trim().toLowerCase();
      }
    }
    return undefined;
  }
  function picker() {
    return (typeof root.flowQueryVisible === "function" ? root.flowQueryVisible("components.listBox", document, { latestFirst: true }) : null) ||
      (typeof root.flowQuery === "function" ? root.flowQuery("components.listBox", document, { latestFirst: true }) : null) ||
      [...document.querySelectorAll('[role="listbox"]')].reverse().find(visible);
  }
  function isReferencePickerSurface(list = picker()) {
    if (!list || !visible(list)) return false;
    const surface = list.closest?.('[role="dialog"], mat-dialog-container, flow-dialog, .cdk-overlay-pane, [class*="picker"], [class*="surface"]') || list;
    const hasReferenceCategory = ["all", "uploads", "characters"].some(name => pickerCategoryTabs(name).length > 0);
    const hasReferenceSearch = Boolean(referenceSearchControl()?.element);
    const hasMediaTiles = Boolean(list.querySelector?.("flow-grid-tile-container, flow-image-tile, flow-video-tile"));
    const label = normalize(`${surface.getAttribute?.("aria-label") || ""} ${surface.innerText || surface.textContent || ""}`);
    const hasAssetBrowserLabel = /search assets|all media|tìm kiếm nội dung|tất cả nội dung/.test(label);
    return hasReferenceCategory || hasReferenceSearch || hasMediaTiles || hasAssetBrowserLabel;
  }
  function visiblePickerSurfaces() {
    const selectors = '[role="dialog"],[role="menu"],[role="listbox"],mat-menu,mat-select-panel';
    const clean = value => String(value || "").replace(/\s+/g, " ").trim().slice(0, 120);
    try {
      return [...new Set(document.querySelectorAll(selectors))].filter(visible).slice(0, 8).map(surface => {
        const labels = [...surface.querySelectorAll('button,[role="button"],[role="menuitem"],[role="option"],mat-option')]
          .filter(visible).slice(0, 12).map(item => clean(accessibleName(item) || item.getAttribute("aria-label") || item.getAttribute("title") || item.innerText || item.textContent));
        const role = surface.getAttribute("role") || (surface.tagName || "").toLowerCase() || null;
        return {
          role,
          tag: (surface.tagName || "").toLowerCase() || null,
          label: clean(accessibleName(surface) || surface.getAttribute("aria-label") || surface.getAttribute("aria-labelledby")),
          labels: labels.filter(Boolean),
        };
      });
    } catch { return []; }
  }
  function updateReferenceActionDiagnostics(patch = {}) {
    let chipList = [];
    try { chipList = chips().map(chip => ({ name: chip.name || null, kind: chip.kind, id: chip.mediaId || null })); } catch {}
    const activePicker = picker();
    let pickerOptionLabels = [];
    try {
      pickerOptionLabels = activePicker
        ? [...activePicker.querySelectorAll('[role="option"]')].slice(0, 20).map(option => ({
          accessibleName: (accessibleName(option) || "").replace(/\s+/g, " ").trim().slice(0, 160),
          ariaLabel: (option.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 160),
          title: (option.getAttribute("title") || "").replace(/\s+/g, " ").trim().slice(0, 160),
        }))
        : [];
    } catch {}
    let searchValue = null;
    try {
      const search = [...document.querySelectorAll('input,[role="textbox"]')].find(el => {
        if (!visible(el)) return false;
        const label = normalize(accessibleName(el));
        const placeholder = normalize(el.placeholder || "");
        return /^(?:search assets|tìm kiếm nội dung nghe nhìn|tìm kiếm|search)$/.test(label) ||
          /^(?:search assets|tìm kiếm nội dung nghe nhìn|tìm kiếm|search)$/.test(placeholder);
      });
      if (search) searchValue = String(search.value ?? search.innerText ?? "").slice(0, 200);
    } catch {}
    let categoryTabs = [];
    try {
      categoryTabs = [...document.querySelectorAll('[role="tab"]')].filter(visible).slice(0, 12).map(tab => ({
        label: (accessibleName(tab) || "").replace(/\s+/g, " ").trim().slice(0, 100),
        selected: tab.getAttribute("aria-selected") === "true",
      }));
    } catch {}
    lastReferenceActionDiagnostics = {
      ...lastReferenceActionDiagnostics,
      ...patch,
      pickerOpen: Boolean(activePicker),
      pickerRole: activePicker?.getAttribute("role") || null,
      pickerOptionCount: activePicker ? activePicker.querySelectorAll('[role="option"]').length : 0,
      pickerScanPages: Number(lastReferenceActionDiagnostics.pickerScanPages) || 0,
      pickerScanEndReached: lastReferenceActionDiagnostics.pickerScanEndReached === true,
      locale: ["en", "vi"].includes(String(document.documentElement?.lang || "").trim().toLowerCase().split(/[-_]/, 1)[0])
        ? String(document.documentElement.lang).trim().toLowerCase().split(/[-_]/, 1)[0] : "unknown",
      searchLabelRecognized: lastReferenceActionDiagnostics.searchLabelRecognized === true,
      searchLabel: lastReferenceActionDiagnostics.searchLabel || null,
      pickerOptionLabels,
      visibleSurfaces: visiblePickerSurfaces(),
      searchValue,
      categoryTabs,
      chipCount: chipList.length,
      chips: chipList,
      updatedAt: new Date().toISOString(),
    };
  }
  function referenceActionDiagnosticsSnapshot() {
    updateReferenceActionDiagnostics();
    return { ...lastReferenceActionDiagnostics, chips: [...(lastReferenceActionDiagnostics.chips || [])] };
  }
  function inspectReferenceActionDiagnostics() {
    const snapshot = referenceActionDiagnosticsSnapshot();
    const errorCode = String(snapshot.error || "").match(/^([A-Z0-9_]+)/i)?.[1] || null;
    const cleanupErrorCode = String(snapshot.cleanupError || "").match(/^([A-Z0-9_]+)/i)?.[1] || null;
    return {
      action: snapshot.action,
      phase: snapshot.phase,
      step: snapshot.step,
      errorCode,
      cleanupErrorCode,
      pickerOpen: snapshot.pickerOpen,
      pickerRole: snapshot.pickerRole,
      pickerOptionCount: snapshot.pickerOptionCount,
      locale: snapshot.locale || "unknown",
      searchLabelRecognized: snapshot.searchLabelRecognized === true,
      searchLabel: snapshot.searchLabel || null,
      searchResultsVerified: snapshot.searchResultsVerified === true,
      activeCategory: diagnosticCategory(snapshot.activeCategory),
      categoriesScanned: Array.isArray(snapshot.categoriesScanned)
        ? [...new Set(snapshot.categoriesScanned.filter(value => ["all", "uploads"].includes(value)))].slice(0, 2) : [],
      categorySelected: snapshot.categorySelected === true,
      pickerScanPages: Number(snapshot.pickerScanPages) || 0,
      pickerScanEndReached: snapshot.pickerScanEndReached === true,
      optionLabelHashes: Array.isArray(snapshot.optionLabelHashes) ? snapshot.optionLabelHashes.slice(0, 60) : [],
      exactTargetFound: snapshot.exactTargetFound === true,
      scrollOwnerCount: Number(snapshot.scrollOwnerCount) || 0,
      scrollOwnerDepth: Number.isInteger(snapshot.scrollOwnerDepth) ? snapshot.scrollOwnerDepth : null,
      scrollClientHeight: Number(snapshot.scrollClientHeight) || 0,
      scrollHeight: Number(snapshot.scrollHeight) || 0,
      scrollTop: Number(snapshot.scrollTop) || 0,
      visibleSurfaces: (snapshot.visibleSurfaces || []).map(surface => ({ role: surface.role, tag: surface.tag, labelCount: (surface.labels || []).length })),
      categoryTabs: (snapshot.categoryTabs || []).map(tab => ({ selected: tab.selected })),
      chipCount: snapshot.chipCount,
      chips: (snapshot.chips || []).map(chip => ({ kind: chip.kind })),
      chipAttachScan: snapshot.chipAttachScan ? {
        stage: snapshot.chipAttachScan.stage || null,
        confirmationMode: snapshot.chipAttachScan.confirmationMode || null,
        beforeCount: Number(snapshot.chipAttachScan.beforeCount) || 0,
        afterCount: Number(snapshot.chipAttachScan.afterCount) || 0,
        countDelta: Number(snapshot.chipAttachScan.countDelta) || 0,
        deltaCount: Number(snapshot.chipAttachScan.deltaCount) || 0,
        beforeKinds: (snapshot.chipAttachScan.beforeKinds || []).slice(0, 8),
        afterKinds: (snapshot.chipAttachScan.afterKinds || []).slice(0, 8),
        deltaKinds: (snapshot.chipAttachScan.deltaKinds || []).slice(0, 8),
        chips: (snapshot.chipAttachScan.chips || []).slice(0, 8).map(chip => ({
          kind: chip.kind || "unknown",
          tag: chip.tag || null,
          ownerTag: chip.ownerTag || null,
          marker: chip.marker || null,
          role: chip.role || null,
          hasThumbnail: chip.hasThumbnail === true,
          hasSource: chip.hasSource === true,
          hasMediaUuid: chip.hasMediaUuid === true,
          hasName: chip.hasName === true,
        })),
      } : null,
      pickerAddActionScan: snapshot.pickerAddActionScan ? {
        candidateCount: Number(snapshot.pickerAddActionScan.candidateCount) || 0,
        enabledCount: Number(snapshot.pickerAddActionScan.enabledCount) || 0,
        disabled: snapshot.pickerAddActionScan.disabled === true,
        method: snapshot.pickerAddActionScan.method || null,
        labels: (snapshot.pickerAddActionScan.labels || []).slice(0, 5),
      } : null,
      surfaceStatus: snapshot.surfaceStatus || null,
      path: snapshot.path || null,
      provenanceConfirmed: snapshot.provenanceConfirmed === true,
      chipUuidConfirmed: snapshot.chipUuidConfirmed === true,
      menuRelatedToTile: snapshot.menuRelatedToTile === true,
      menuNearTrigger: snapshot.menuNearTrigger === true,
      menuActionScan: snapshot.menuActionScan ? {
        scanAttempts: Number(snapshot.menuActionScan.scanAttempts) || 0,
        selectorMode: snapshot.menuActionScan.selectorMode || null,
        menuTag: snapshot.menuActionScan.menuTag || null,
        menuRole: snapshot.menuActionScan.menuRole || null,
        itemCount: Number(snapshot.menuActionScan.itemCount) || 0,
        matchCount: Number(snapshot.menuActionScan.matchCount) || 0,
        items: (snapshot.menuActionScan.items || []).slice(0, 20).map(item => ({
          index: Number(item.index) || 0,
          tag: item.tag || null,
          role: item.role || null,
          ariaLabel: item.ariaLabel || null,
          title: item.title || null,
          visibleText: item.visibleText || null,
          textContent: item.textContent || null,
          accessibleName: item.accessibleName || null,
          iconText: Array.isArray(item.iconText) ? item.iconText.slice(0, 4) : [],
          disabled: item.disabled === true,
          matched: item.matched === true,
          matchSource: item.matchSource || null,
          matchedAlias: item.matchedAlias || null,
        })),
      } : null,
      cleanup: snapshot.cleanup || null,
      updatedAt: snapshot.updatedAt,
      lastResult: snapshot.lastResult ? Object.fromEntries(Object.entries(snapshot.lastResult).filter(([key, value]) => ["count", "exactMatch", "selected", "confirmed", "reused", "slot", "chipUuidConfirmed", "provenanceConfirmed"].includes(key) && (typeof value === "boolean" || typeof value === "number" || key === "slot"))) : null,
    };
  }
  const addToPromptLabels = new Set(["add to prompt", "thêm vào câu lệnh", "thêm vào lời nhắc", "thêm vào lời nhắc văn bản", "thêm vào prompt"]);
  const normalizeContextActionText = value => normalize(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d");
  function contextMenuItemTextSources(item) {
    const sources = [];
    const add = (source, value) => {
      const text = String(value || "").replace(/\s+/g, " ").trim().slice(0, 180);
      if (text && !sources.some(entry => entry.source === source && entry.text === text)) sources.push({ source, text });
    };
    // Flow can expose the icon as the accessibility name ("add") while the
    // rendered action text is "Add to prompt". Keep each source independent.
    add("innerText", item?.innerText);
    add("textContent", item?.textContent);
    add("aria-label", item?.getAttribute?.("aria-label"));
    add("title", item?.getAttribute?.("title"));
    try { add("accessibleName", accessibleName(item)); } catch {}
    const icons = typeof root.flowQueryAll === "function"
      ? root.flowQueryAll("common.icons", item, { checkVisible: false })
      : (() => { try { return [...(item?.querySelectorAll?.("mat-icon,.mat-icon,.google-symbols,.material-symbols-outlined,i,svg") || [])]; } catch { return []; } })();
    icons.slice(0, 8).forEach((icon, index) => add(`icon${index + 1}`, icon.textContent));
    return sources;
  }
  function configuredContextActionValues(config, snakeCase, camelCase) {
    const value = config?.[snakeCase] ?? config?.[camelCase];
    return (Array.isArray(value) ? value : typeof value === "string" ? value.split("|") : [])
      .map(value => normalize(value)).filter(Boolean).slice(0, 20);
  }
  function addToPromptActionMatch(item) {
    const config = root.flowGetConfig?.("components.addToPromptMenuItem") || root.FlowSelectors?.components?.addToPromptMenuItem || {};
    let localizedAliases = [];
    try { localizedAliases = root.I18n?.getPatterns?.("add_to_prompt") || []; } catch {}
    const textAliases = [...new Set([
      ...addToPromptLabels,
      ...configuredContextActionValues(config, "text_match", "textMatch"),
      ...(Array.isArray(localizedAliases) ? localizedAliases : []),
    ].map(normalizeContextActionText).filter(Boolean))];
    const sources = contextMenuItemTextSources(item);
    for (const source of sources) {
      const text = normalizeContextActionText(source.text);
      const alias = textAliases.find(value => text === value || text.includes(value));
      if (alias) return { matched: true, source: source.source, alias };
    }
    const iconAliases = configuredContextActionValues(config, "icon_text", "iconText");
    if (iconAliases.length) {
      const icon = sources.find(entry => entry.source.startsWith("icon") && iconAliases.includes(normalize(entry.text)));
      if (icon) return { matched: true, source: icon.source, alias: normalize(icon.text) };
    }
    return { matched: false, source: null, alias: null };
  }
  function contextMenuActionSnapshot(menu, items, matches, scanAttempts = 1) {
    const isDisabled = item => Boolean(item?.disabled || item?.getAttribute?.("aria-disabled") === "true" ||
      item?.getAttribute?.("disabled") !== null && item?.getAttribute?.("disabled") !== undefined ||
      item?.getAttribute?.("data-disabled") === "true");
    return {
      scanAttempts,
      selectorMode: typeof root.flowQueryAll === "function" ? "flow_configured_plus_semantic_fallback" : "semantic_fallback",
      menuTag: String(menu?.tagName || "").toLowerCase() || null,
      menuRole: menu?.getAttribute?.("role") || null,
      itemCount: items.length,
      matchCount: matches.length,
      items: items.slice(0, 20).map((item, index) => {
        const sources = contextMenuItemTextSources(item);
        const match = matches.find(entry => entry.item === item)?.match;
        return {
          index,
          tag: String(item?.tagName || "").toLowerCase() || null,
          role: item?.getAttribute?.("role") || null,
          ariaLabel: sources.find(entry => entry.source === "aria-label")?.text || null,
          title: sources.find(entry => entry.source === "title")?.text || null,
          visibleText: sources.find(entry => entry.source === "innerText")?.text || null,
          textContent: sources.find(entry => entry.source === "textContent")?.text || null,
          accessibleName: sources.find(entry => entry.source === "accessibleName")?.text || null,
          iconText: sources.filter(entry => entry.source.startsWith("icon")).map(entry => entry.text).slice(0, 4),
          disabled: isDisabled(item),
          matched: Boolean(match),
          matchSource: match?.source || null,
          matchedAlias: match?.alias || null,
        };
      }),
    };
  }
  function contextMenuActionEvidenceText(snapshot) {
    const items = (snapshot?.items || []).slice(0, 6).map(item => {
      const label = item.visibleText || item.textContent || "";
      const aria = item.ariaLabel ? ` aria=${JSON.stringify(item.ariaLabel)}` : "";
      const accessible = item.accessibleName ? ` name=${JSON.stringify(item.accessibleName)}` : "";
      const icon = item.iconText?.length ? ` icon=${JSON.stringify(item.iconText.join(" "))}` : "";
      return `${item.tag || "?"}/${item.role || "no-role"} text=${JSON.stringify(label)}${aria}${accessible}${icon}${item.disabled ? " disabled" : ""}`;
    });
    return items.length ? ` Menu DOM: ${items.join(" | ").slice(0, 700)}.` : " Menu DOM: no visible action items found.";
  }
  function logContextMenuActionFailure(snapshot, reason, errorCode) {
    try {
      console.error("[FlowReferenceAction] Add-to-prompt menu action scan failed", JSON.stringify({ errorCode, reason, ...snapshot }));
    } catch {}
  }
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const asbIdentityPattern = /^asb:[A-Za-z0-9_-]{32,1024}$/;
  const sameImageReferenceIdentity = (left, right) => {
    const a = String(left || "");
    const b = String(right || "");
    return uuidPattern.test(a) && uuidPattern.test(b) ? a.toLowerCase() === b.toLowerCase() : a === b;
  };
  async function resolveImageReferenceIdentity(id) {
    const value = String(id || "");
    const resolvedUuid = await resolveNativeMediaUuid(value, "image");
    if (resolvedUuid) return resolvedUuid.toLowerCase();
    return asbIdentityPattern.test(value) ? value : undefined;
  }
  const exactTileTitle = (tile, name) => {
    const wanted = normalize(name);
    const aria = normalize(tile?.getAttribute?.("aria-label") || tile?.getAttribute?.("title"));
    if (aria === wanted || aria.startsWith(wanted) || aria.replace(/\s+(?:image|video|ảnh|hình ảnh)$/i, "") === wanted) return true;
    const txt = normalize(tile?.innerText || tile?.textContent);
    return txt === wanted || txt.startsWith(wanted) || txt.includes(wanted);
  };
  function contextMenuItems(menu) {
    const configured = typeof root.flowQueryAll === "function"
      ? [...root.flowQueryAll("components.addToPromptMenuItem", menu, { checkVisible: false }),
        ...root.flowQueryAll("components.actionMenuItems", menu, { checkVisible: false })]
      : [];
    const candidates = [...(configured || [])];
    const selectors = [
      '[role="menuitem"]', '[role="menuitemcheckbox"]', '[role="menuitemradio"]',
      "mat-menu-item", "button", '[role="button"]', 'a[role="menuitem"]',
      "[data-radix-collection-item]",
    ];
    for (const selector of selectors) {
      try { candidates.push(...(menu.querySelectorAll?.(selector) || [])); } catch {}
    }
    const unique = [...new Set(candidates)].filter(visible);
    // Prefer the menu's semantic action owners. Some Flow builds put a button
    // inside each menuitem; counting both would make one action ambiguous.
    const semantic = unique.filter(item => /^(?:menuitem|menuitemcheckbox|menuitemradio)$/.test(item.getAttribute?.("role") || "") ||
      String(item.tagName || "").toLowerCase() === "mat-menu-item" || item.hasAttribute?.("data-radix-collection-item"));
    return semantic.length ? semantic : unique;
  }
  function dispatchContextMenu(target, point) {
    const pointerInit = { bubbles: true, cancelable: true, button: 2, buttons: 2, clientX: point.x, clientY: point.y, pointerType: "mouse" };
    const mouseInit = { bubbles: true, cancelable: true, button: 2, buttons: 2, clientX: point.x, clientY: point.y };
    if (typeof PointerEvent === "function") target.dispatchEvent(new PointerEvent("pointerdown", pointerInit));
    target.dispatchEvent(new MouseEvent("mousedown", mouseInit));
    target.dispatchEvent(new MouseEvent("contextmenu", mouseInit));
    if (typeof PointerEvent === "function") target.dispatchEvent(new PointerEvent("pointerup", { ...pointerInit, buttons: 0 }));
    target.dispatchEvent(new MouseEvent("mouseup", { ...mouseInit, buttons: 0 }));
  }
  function contextMenus(scope = document, visibleOnly = true) {
    const configured = typeof root.flowQueryAll === "function"
      ? root.flowQueryAll("components.actionMenus", scope, { checkVisible: !visibleOnly })
      : null;
    const candidates = [...(configured || [
      ...scope.querySelectorAll('[role="menu"],mat-menu-panel'),
      ...scope.querySelectorAll(".cdk-overlay-pane"),
    ])]
      .filter(menu => !visibleOnly || visible(menu));
    // Flow renders a semantic menu inside a CDK overlay pane. Treat the pane
    // as its wrapper, not as a second independently opened menu.
    const isSemantic = menu => {
      if (typeof menu.matches === "function") return menu.matches('[role="menu"],mat-menu-panel');
      const role = menu.getAttribute?.("role");
      return role === "menu" || menu.tagName === "MAT-MENU-PANEL";
    };
    const semanticMenus = candidates.filter(isSemantic);
    if (semanticMenus.length) return semanticMenus;
    // `components.actionMenus` also includes generic CDK overlay panes in some
    // Flow selector profiles. Those panes host the asset picker and dialogs,
    // so treating every pane with buttons as a context menu makes an uploaded
    // reference fail with FLOW_REFERENCE_CONTEXT_MENU_BUSY while the picker is
    // visibly waiting for Add to prompt. Accept only overlays with explicit
    // menu semantics; generic dialog/listbox surfaces are never menus.
    return candidates.filter(menu => {
      const isOverlayPane = menu.matches?.(".cdk-overlay-pane") || String(menu.className || "").split(/\s+/).includes("cdk-overlay-pane");
      if (!isOverlayPane) return contextMenuItems(menu).length > 0;
      if (menu.querySelector?.('[role="dialog"],mat-dialog-container,flow-dialog,[role="listbox"],[role="tab"],input,[role="textbox"]')) return false;
      const explicitItems = menu.querySelector?.('[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],mat-menu-item,[data-radix-collection-item]');
      const menuClass = /(?:^|\s)(?:mat-mdc-menu-panel|mat-menu-panel|flow-context-menu)(?:\s|$)/i.test(String(menu.className || ""));
      return Boolean(explicitItems || menuClass);
    });
  }
  function contextMenuItemLabel(item) {
    const sources = contextMenuItemTextSources(item);
    return normalize(sources.find(entry => entry.source === "innerText")?.text ||
      sources.find(entry => entry.source === "textContent")?.text ||
      sources.find(entry => entry.source === "aria-label")?.text ||
      sources.find(entry => entry.source === "title")?.text ||
      sources.find(entry => entry.source === "accessibleName")?.text);
  }
  function hasExactContextMenuRelation(menu, trigger, tile) {
    if (tile?.contains?.(menu) || trigger?.contains?.(menu)) return true;
    const targetIds = new Set([trigger?.id, tile?.id].filter(Boolean));
    const menuId = menu?.id;
    const hasToken = (value, token) => Boolean(token && String(value || "").split(/\s+/).includes(token));
    if (menuId && [trigger, tile].some(el => hasToken(el?.getAttribute?.("aria-controls"), menuId) || hasToken(el?.getAttribute?.("aria-owns"), menuId))) return true;
    return ["aria-labelledby", "aria-describedby"].some(attr => String(menu?.getAttribute?.(attr) || "").split(/\s+/).some(id => targetIds.has(id)));
  }
  function contextMenuNearTrigger(menu, point) {
    const rect = menu?.getBoundingClientRect?.();
    if (!rect || !(rect.width > 0 && rect.height > 0) || !Number.isFinite(rect.left) || !Number.isFinite(rect.top)) return false;
    if (typeof window !== "undefined" && Number.isFinite(window.innerWidth) && Number.isFinite(window.innerHeight) &&
      (rect.left < 0 || rect.top < 0 || rect.right > window.innerWidth || rect.bottom > window.innerHeight)) return false;
    const right = Number.isFinite(rect.right) ? rect.right : rect.left + rect.width;
    const bottom = Number.isFinite(rect.bottom) ? rect.bottom : rect.top + rect.height;
    const dx = Math.max(rect.left - point.x, 0, point.x - right);
    const dy = Math.max(rect.top - point.y, 0, point.y - bottom);
    return Math.hypot(dx, dy) <= 240;
  }
  function isFlowActionDisabled(item) {
    return Boolean(item?.disabled || item?.getAttribute?.("aria-disabled") === "true" ||
      item?.getAttribute?.("disabled") !== null && item?.getAttribute?.("disabled") !== undefined ||
      item?.getAttribute?.("data-disabled") === "true");
  }
  function dispatchPrimaryClick(target) {
    if (!target) return false;
    const rect = target.getBoundingClientRect?.();
    if (!rect || !(rect.width > 0 && rect.height > 0)) {
      target.click?.();
      return true;
    }
    const point = { bubbles: true, cancelable: true, composed: true, button: 0,
      clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
    try { if (typeof PointerEvent === "function" && typeof target.dispatchEvent === "function") target.dispatchEvent(new PointerEvent("pointerdown", { ...point, pointerId: 1, pointerType: "mouse", buttons: 1 })); } catch {}
    try { if (typeof MouseEvent === "function" && typeof target.dispatchEvent === "function") target.dispatchEvent(new MouseEvent("mousedown", { ...point, buttons: 1 })); } catch {}
    try { if (typeof PointerEvent === "function" && typeof target.dispatchEvent === "function") target.dispatchEvent(new PointerEvent("pointerup", { ...point, pointerId: 1, pointerType: "mouse", buttons: 0 })); } catch {}
    try { if (typeof MouseEvent === "function" && typeof target.dispatchEvent === "function") target.dispatchEvent(new MouseEvent("mouseup", { ...point, buttons: 0 })); } catch {}
    try {
      if (typeof MouseEvent === "function" && typeof target.dispatchEvent === "function") target.dispatchEvent(new MouseEvent("click", { ...point, buttons: 0 }));
    } catch {}
    target.click?.();
    return true;
  }
  function findPickerAddToPromptButton() {
    const list = picker();
    if (!list) return null;
    const surface = pickerSurface();
    const scope = surface && typeof surface.querySelectorAll === "function" ? surface : list;
    const matchedCandidates = typeof scope.querySelectorAll === "function"
      ? [...new Set(scope.querySelectorAll('button,[role="button"],mat-button,[tabindex="0"]'))]
          .filter(item => visible(item) && addToPromptActionMatch(item).matched)
      : [];
    const candidates = matchedCandidates.filter(item => !isFlowActionDisabled(item));
    // Prefer the innermost actual control when Flow wraps one button with an
    // additional role=button container. This keeps one visible action from
    // being reported twice while still refusing genuinely ambiguous actions.
    const uniqueControls = candidates.filter(item => !candidates.some(other => other !== item && other.contains?.(item) &&
      (String(other.tagName || "").toLowerCase() === "button" || other.getAttribute?.("role") === "button")));
    const scan = { candidateCount: matchedCandidates.length, enabledCount: uniqueControls.length,
      disabled: matchedCandidates.length > 0 && candidates.length === 0,
      method: uniqueControls.length === 1 ? "semantic_scan" : uniqueControls.length > 1 ? "ambiguous" : "not_found",
      labels: matchedCandidates.slice(0, 5).map(item => String(item.innerText || item.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80)) };
    const signature = JSON.stringify(scan);
    if (findPickerAddToPromptButton.lastScanSignature !== signature) {
      findPickerAddToPromptButton.lastScanSignature = signature;
      updateReferenceActionDiagnostics({ pickerAddActionScan: scan });
    }
    if (uniqueControls.length === 1) return uniqueControls[0];
    if (uniqueControls.length === 0) {
      // Keep compatibility with Flow selector adapters that provide a
      // semantic button resolver while the test/runtime DOM wrapper omits
      // querySelectorAll results. In the live DOM the scan above takes priority.
      const resolved = root.flowButton?.("Add to prompt", scope) || root.flowButton?.("Add to prompt");
      if (resolved && visible(resolved) && !isFlowActionDisabled(resolved)) {
        const resolvedScan = { candidateCount: 1, enabledCount: 1, disabled: false, method: "configured_resolver", labels: [String(resolved.innerText || resolved.textContent || "Add to prompt").replace(/\s+/g, " ").trim().slice(0, 80)] };
        const resolvedSignature = JSON.stringify(resolvedScan);
        if (findPickerAddToPromptButton.lastScanSignature !== resolvedSignature) {
          findPickerAddToPromptButton.lastScanSignature = resolvedSignature;
          updateReferenceActionDiagnostics({ pickerAddActionScan: resolvedScan });
        }
        return resolved;
      }
    }
    return null;
  }
  function chipMediaUuids(chip) {
    const attrs = ["data-media-id", "data-asset-id", "data-file-id"];
    const nodes = [chip.element, chip.element?.querySelector?.("img"), ...(chip.element?.querySelectorAll?.("[data-media-id],[data-asset-id],[data-file-id]") || [])].filter(Boolean);
    return [...new Set(nodes.flatMap(node => attrs.map(attr => node.getAttribute?.(attr)).filter(value => uuidPattern.test(String(value || ""))).map(value => String(value).toLowerCase())))];
  }
  function addedReferenceChips(before, current) {
    const counts = new Map();
    const keyOf = chip => {
      const id = chip.mediaId || chipMediaUuids(chip)[0];
      if (id) return "id:" + String(id).toLowerCase();
      if (chip.source) return "src:" + String(chip.source);
      if (chip.name) return "name:" + normalize(chip.name);
      return null;
    };
    for (const chip of before) {
      const key = keyOf(chip);
      if (key) counts.set(key, (counts.get(key) || 0) + 1);
    }
    return current.filter(chip => {
      const key = keyOf(chip);
      // Consume the old-chip occurrence even when Flow kept the same DOM node.
      // Otherwise a newly added duplicate image with the same source/ID is
      // incorrectly consumed as the old chip and the second attachment is lost.
      if (before.some(old => old.element === chip.element)) {
        if (key) {
          const count = counts.get(key) || 0;
          if (count > 0) counts.set(key, count - 1);
        }
        return false;
      }
      if (!key) return true;
      const count = counts.get(key) || 0;
      if (count > 0) {
        counts.set(key, count - 1);
        return false;
      }
      return true;
    });
  }
  async function closeOwnedContextMenu(menu, deadline) {
    if (!menu || !visible(menu)) return { closed: true, method: "already_closed" };
    const close = contextMenuItems(menu).filter(item => ["close", "dismiss", "đóng"].includes(contextMenuItemLabel(item)) && !item.disabled && item.getAttribute("aria-disabled") !== "true");
    if (close.length === 1) {
      close[0].click();
    } else {
      menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true, cancelable: true, composed: true }));
    }
    const until = Math.min(Date.now() + 700, deadline);
    while (Date.now() < until && visible(menu)) await boundedWait(50, until, "closing the owned reference menu", false);
    return { closed: !visible(menu), method: close.length === 1 ? "owned_close_action" : "escape" };
  }
  async function attachUploadedImageFromTile(ref, expectedId, deadline, signal) {
    const prior = referenceContextMenuTail;
    let release;
    referenceContextMenuTail = new Promise(resolve => { release = resolve; });
    await prior;
    let ownedMenu = null;
      let diagnostic = { path: "uploaded_tile_context_menu", step: "queued", tileActionStep: "queued" };
    try {
      requireTime(deadline, "waiting for the serialized reference menu", false, signal);
      updateReferenceActionDiagnostics(diagnostic);
      const expectedIdentity = await resolveImageReferenceIdentity(expectedId);
      if (!expectedIdentity) throw flowError("FLOW_ASSET_ID_UNAVAILABLE", "The uploaded image has no verified Flow media identity for tile attachment. No reference was selected.", false, false);
      // Upload can leave Flow's own asset browser open with the new image
      // selected and its bottom Add to prompt action visible. Reuse that picker
      // through the normal exact-ID picker path below instead of treating the
      // picker overlay as a pre-existing image context menu.
      if (isReferencePickerSurface()) {
        updateReferenceActionDiagnostics({ ...diagnostic, step: "reusing_open_reference_picker", tileActionStep: "picker_reused", surfaceStatus: "reference_picker_already_open" });
        return null;
      }
      const attached = chips().find(chip => normalize(chip.name) === normalize(ref.name) && chip.kind === "image");
      if (attached) {
        const attachedRawIdentity = attached.mediaId || chipMediaUuids(attached)[0];
        const attachedIdentity = sameImageReferenceIdentity(attachedRawIdentity, expectedIdentity)
          ? attachedRawIdentity
          : await resolveImageReferenceIdentity(attachedRawIdentity);
        if (!sameImageReferenceIdentity(attachedIdentity, expectedIdentity)) throw flowError("FLOW_ASSET_ID_MISMATCH", "An image reference with this title is already attached, but its verified media provenance differs from the requested upload.", false, false);
        updateReferenceActionDiagnostics({ ...diagnostic, step: "serialized_existing_chip_reused", provenanceConfirmed: true, chipUuidConfirmed: attached.chipUuidConfirmed === true });
        return { name: ref.name, kind: "image", source: attached.source, id: expectedIdentity, idSource: attached.mediaIdSource || (asbIdentityPattern.test(expectedIdentity) ? "verified_asb_tile_action" : "verified_tile_action_provenance"), chipUuidConfirmed: attached.chipUuidConfirmed === true, confirmed: true, reused: true };
      }
      const alreadyOpen = contextMenus(document, true);
      if (alreadyOpen.length) throw flowError("FLOW_REFERENCE_CONTEXT_MENU_BUSY", "Flow already has a menu open; no reference menu action was attempted.", false, false);
      const tileById = await root.findFlowTileByMediaId?.(expectedIdentity, { deadline, signal });
      const tile = tileById || await root.findFlowTile?.(ref.name);
      if (!tile || (!tileById && !exactTileTitle(tile, ref.name))) {
        const state = tile ? "tile_title_mismatch" : "tile_missing";
        updateReferenceActionDiagnostics({ ...diagnostic, step: tile ? "tile_title_not_exact_picker_fallback" : "tile_missing_picker_fallback", tileActionStep: "menu_missing", surfaceStatus: state });
        return null;
      }
      const verifyTile = async () => {
        const currentRaw = String(mediaId(tile) || "");
        const current = currentRaw.toLowerCase() === expectedIdentity.toLowerCase()
          ? currentRaw
          : await resolveImageReferenceIdentity(currentRaw);
        const hasVideo = typeof root.flowQuery === "function" ? root.flowQuery("tiles.video", tile, { checkVisible: false }) : tile.querySelector("flow-video-tile,flow-scene-tile");
        return tile.isConnected && (tileById || exactTileTitle(tile, ref.name)) && sameImageReferenceIdentity(current, expectedIdentity) && !hasVideo;
      };
      if (!(await verifyTile())) throw flowError("FLOW_ASSET_ID_MISMATCH", "The exact image tile does not match the completed upload UUID and image type. No reference was selected.", false, false);
      const sameIdentity = [...((typeof root.flowQueryAll === "function" ? root.flowQueryAll("tiles.container", document, { checkVisible: false }) : null) || document.querySelectorAll("flow-grid-tile-container"))]
        .filter(candidate => sameImageReferenceIdentity(mediaId(candidate), expectedIdentity));
      const sameTitle = [...((typeof root.flowQueryAll === "function" ? root.flowQueryAll("tiles.container", document, { checkVisible: false }) : null) || document.querySelectorAll("flow-grid-tile-container"))]
        .filter(candidate => exactTileTitle(candidate, ref.name));
      const uniqueTarget = tileById ? sameIdentity.length === 1 && sameIdentity[0] === tile : sameTitle.length === 1 && sameTitle[0] === tile;
      if (!uniqueTarget) throw flowError("FLOW_ASSET_AMBIGUOUS", "Flow does not expose one unique tile for the requested image identity. No reference was selected.", false, false);
      tile.scrollIntoView?.({ behavior: "instant", block: "center" });
      await boundedWait(100, deadline, "settling the exact uploaded image tile", false, signal);
      if (!(await verifyTile())) throw flowError("FLOW_ASSET_CHANGED", "The uploaded image tile changed before its context menu opened. No reference was selected.", false, false);
      const target = (typeof root.flowQuery === "function" ? root.flowQuery("tiles.image", tile, { checkVisible: false }) : null) || tile.querySelector("img,[role='img']") || tile;
      const rect = target.getBoundingClientRect?.() || { left: 0, top: 0, width: 1, height: 1 };
      const contextPoint = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      let newMenus = [];
      for (let attempt = 0; attempt < 3 && !newMenus.length; attempt++) {
        if (!(await verifyTile())) throw flowError("FLOW_ASSET_CHANGED", "The verified image tile changed before its context menu opened. No reference was selected.", false, false);
        // Snapshot visible menus only. Flow keeps hidden CDK menu nodes mounted
        // and reuses them when opening the image context menu.
        const priorMenus = new Set(contextMenus(document, true));
        diagnostic = { ...diagnostic, step: "opening_context_menu", menuAttempt: attempt + 1 };
        updateReferenceActionDiagnostics(diagnostic);
        dispatchContextMenu(target, contextPoint);
        const menuDeadline = Math.min(Date.now() + 1200, deadline);
        while (Date.now() < menuDeadline) {
          newMenus = contextMenus(document, true).filter(menu => !priorMenus.has(menu));
          if (newMenus.length) break;
          try { await boundedWait(100, menuDeadline, "waiting for the uploaded image context menu", false, signal); }
          catch (error) {
            if (error?.code === "FLOW_OPERATION_TIMEOUT" && Date.now() >= menuDeadline) break;
            throw error;
          }
        }
        if (!newMenus.length && attempt < 2) await boundedWait(120, deadline, "retrying the image context menu", false, signal);
      }
      if (!newMenus.length) {
        updateReferenceActionDiagnostics({ ...diagnostic, step: "no_new_menu_picker_fallback", tileActionStep: "menu_missing", surfaceStatus: "no_new_owned_menu" });
        return null;
      }
      if (newMenus.length !== 1 || !(await verifyTile())) {
        updateReferenceActionDiagnostics({ ...diagnostic, step: "ambiguous_new_menu", surfaceStatus: "ambiguous" });
        throw flowError("FLOW_REFERENCE_CONTEXT_MENU_AMBIGUOUS", "Flow did not expose one new menu while the verified image tile remained stable. No reference was selected.", false, false);
      }
      const candidateMenu = newMenus[0];
      const related = hasExactContextMenuRelation(candidateMenu, target, tile);
      const nearTrigger = contextMenuNearTrigger(candidateMenu, contextPoint);
      ownedMenu = candidateMenu;
      // The menu was absent before the verified UUID tile action and is the
      // only newly visible menu. Flow portals it outside the tile DOM and may
      // position it at the viewport edge, so ARIA ancestry and pixel distance
      // are diagnostic only, not reasons to reject its actual menu action.
      updateReferenceActionDiagnostics({ ...diagnostic, step: "validating_new_menu", tileActionStep: "menu_owned", menuRelatedToTile: related, menuNearTrigger: nearTrigger });
      let actionItems = [];
      let actionMatches = [];
      let menuActionScan = null;
      let actionScanAttempts = 0;
      const actionScanDeadline = Math.min(Date.now() + 900, deadline);
      do {
        actionItems = contextMenuItems(ownedMenu);
        actionMatches = actionItems.map(item => ({ item, match: addToPromptActionMatch(item) })).filter(entry => entry.match.matched);
        actionScanAttempts++;
        menuActionScan = contextMenuActionSnapshot(ownedMenu, actionItems, actionMatches, actionScanAttempts);
        updateReferenceActionDiagnostics({ ...diagnostic, step: "scanning_add_to_prompt_action", menuActionScan });
        if (actionMatches.length || Date.now() >= actionScanDeadline) break;
        try { await boundedWait(100, actionScanDeadline, "waiting for Flow's Add to prompt menu action", false, signal); }
        catch (error) {
          if (error?.code === "FLOW_OPERATION_TIMEOUT" && Date.now() >= actionScanDeadline) break;
          throw error;
        }
      } while (Date.now() < actionScanDeadline);
      const isDisabled = item => Boolean(item?.disabled || item?.getAttribute?.("aria-disabled") === "true" ||
        item?.getAttribute?.("disabled") !== null && item?.getAttribute?.("disabled") !== undefined ||
        item?.getAttribute?.("data-disabled") === "true");
      if (actionMatches.length !== 1 || isDisabled(actionMatches[0]?.item)) {
        const reason = actionMatches.length === 0 ? "action_missing" : actionMatches.length > 1 ? "action_ambiguous" : "action_disabled";
        const code = actionMatches.length === 0 ? "FLOW_REFERENCE_CONTEXT_ACTION_MISSING" :
          actionMatches.length > 1 ? "FLOW_REFERENCE_CONTEXT_ACTION_AMBIGUOUS" : "FLOW_REFERENCE_CONTEXT_ACTION_DISABLED";
        const baseMessage = actionMatches.length === 0
          ? `Flow's new image menu exposed ${actionItems.length} candidate item(s), but no Add to prompt action matched. No reference was selected.`
          : actionMatches.length > 1
            ? `Flow's new image menu exposed ${actionMatches.length} Add to prompt matches; the action is ambiguous. No reference was selected.`
            : "Flow exposed the Add to prompt action, but it was disabled. No reference was selected.";
        const message = `${baseMessage}${contextMenuActionEvidenceText(menuActionScan)}`;
        updateReferenceActionDiagnostics({ ...diagnostic, step: reason, surfaceStatus: reason, menuActionScan });
        logContextMenuActionFailure(menuActionScan, reason, code);
        const error = flowError(code, message, false, false);
        error.diagnostics = { menuActionScan };
        throw error;
      }
      const action = actionMatches[0].item;
      if (!(await verifyTile())) throw flowError("FLOW_ASSET_ID_MISMATCH", "The uploaded image tile identity changed before Add to prompt. No reference was selected.", false, false);
      if (!ownedMenu.isConnected || !visible(ownedMenu)) {
        throw flowError("FLOW_REFERENCE_CONTEXT_MENU_OWNERSHIP_LOST", "Flow's newly opened reference menu closed before selection. No menu action was taken.", false, false);
      }
      const currentActions = contextMenuItems(ownedMenu).filter(item => addToPromptActionMatch(item).matched);
      if (currentActions.length !== 1 || currentActions[0] !== action || isDisabled(currentActions[0])) {
        throw flowError("FLOW_REFERENCE_CONTEXT_ACTION_CHANGED", "The unique Add to prompt action changed before selection. No menu action was taken.", false, false);
      }
      const before = chips();
      updateReferenceActionDiagnostics({ ...diagnostic, step: "clicking_exact_add_action", tileActionStep: "action_clicked", surfaceStatus: "unique_new_menu_and_action", menuActionScan });
      action.click();
      const attachDeadline = Math.min(Date.now() + 10_000, deadline);
      let previousScanSignature = null;
      let stableScanCount = 0;
      while (Date.now() < attachDeadline) {
        const current = chips();
        const added = addedReferenceChips(before, current);
        const scan = chipAttachEvidence(before, current, added, "waiting_for_exactly_one_image_chip");
        const signature = JSON.stringify({ afterCount: scan.afterCount, afterKinds: scan.afterKinds, deltaCount: scan.deltaCount, deltaKinds: scan.deltaKinds });
        stableScanCount = signature === previousScanSignature ? stableScanCount + 1 : 1;
        previousScanSignature = signature;

        // Flow may remount existing chips while adding another image. TobyFlow's
        // V2 path confirms this operation by a scoped +1 chip-count change and
        // then validates any exposed media UUID. Do the same here: a remount can
        // make element-by-element differencing report old chips as new even
        // though the composer gained exactly one image.
        const countDelta = current.length - before.length;
        const exactlyOneImageAdded = countDelta === 1 && current.length > 0 && current.every(chip => chip.kind === "image");
        if (exactlyOneImageAdded && stableScanCount >= 2) {
          const expectedIdentityChips = current.filter(chip => chipMediaUuids(chip).includes(String(expectedIdentity).toLowerCase()));
          const addedImage = added.length === 1 && added[0].kind === "image" ? added[0] :
            expectedIdentityChips.length === 1 ? expectedIdentityChips[0] : current[current.length - 1];
          const observedUuids = chipMediaUuids(addedImage);
          if (uuidPattern.test(expectedIdentity) && observedUuids.some(id => id !== expectedIdentity)) {
            scan.stage = "conflicting_chip_uuid";
            updateReferenceActionDiagnostics({ ...diagnostic, step: "reference_chip_uuid_mismatch", tileActionStep: "action_clicked", surfaceStatus: "chip_uuid_mismatch", chipAttachScan: scan });
            const error = flowError("FLOW_ASSET_ID_MISMATCH", "The new image chip exposes a UUID that conflicts with the selected upload. Inspect the composer before retrying.", false, true);
            error.diagnostics = { chipAttachScan: scan };
            console.error("[FlowReferenceAction] image reference chip UUID mismatch", JSON.stringify(scan));
            throw error;
          }
          // The tile/action pair proves an ASB identity even when Flow omits
          // a UUID on the chip. The generation observer marks it unverified.
          const idSource = asbIdentityPattern.test(expectedIdentity) ? "verified_asb_tile_action" : "verified_tile_action_provenance";
          metadata.set(addedImage.element, { name: ref.name, mediaId: expectedIdentity, mediaIdSource: idSource, chipUuidConfirmed: observedUuids.includes(expectedIdentity) });
          const confirmationMode = added.length === 1 ? "identity_delta" : "stable_composer_count_delta";
          scan.stage = "confirmed";
          scan.confirmationMode = confirmationMode;
          updateReferenceActionDiagnostics({ ...diagnostic, step: "exact_image_chip_confirmed", tileActionStep: "chip_confirmed", surfaceStatus: "attached", provenanceConfirmed: true, chipUuidConfirmed: observedUuids.includes(expectedIdentity), chipAttachScan: scan });
          return { name: ref.name, kind: "image", source: addedImage.source, id: expectedIdentity, idSource, chipUuidConfirmed: observedUuids.includes(expectedIdentity), confirmed: true };
        }

        const wrongTypeAdded = current.some(chip => chip.kind !== "image");
        const impossibleCount = countDelta > 1 || countDelta < 0;
        if ((wrongTypeAdded || impossibleCount) && stableScanCount >= 3) {
          scan.stage = wrongTypeAdded ? "stable_wrong_chip_type" : "stable_unexpected_chip_count";
          updateReferenceActionDiagnostics({ ...diagnostic, step: "reference_chip_delta_ambiguous", tileActionStep: "action_clicked", surfaceStatus: "chip_delta_ambiguous", chipAttachScan: scan });
          const message = `Flow's composer changed from ${before.length} to ${current.length} reference chip(s) (delta ${countDelta}; types ${scan.afterKinds.join(",") || "none"}). Inspect the composer before retrying.`;
          const error = flowError("FLOW_REFERENCE_ATTACH_AMBIGUOUS", message, false, true);
          error.diagnostics = { chipAttachScan: scan };
          console.error("[FlowReferenceAction] image reference chip delta failed", JSON.stringify(scan));
          throw error;
        }
        await boundedWait(150, attachDeadline, "confirming uploaded image reference", true, signal);
      }
      const current = chips();
      const added = addedReferenceChips(before, current);
      const scan = chipAttachEvidence(before, current, added, "attachment_unconfirmed");
      updateReferenceActionDiagnostics({ ...diagnostic, step: "reference_chip_unconfirmed", tileActionStep: "action_clicked", surfaceStatus: "chip_delta_unconfirmed", chipAttachScan: scan });
      const error = flowError("FLOW_REFERENCE_ATTACH_UNCONFIRMED", `Flow did not confirm one added image chip (before ${before.length}, after ${current.length}, delta ${current.length - before.length}). Inspect the composer before retrying.`, false, true);
      const pickerAddActionScan = lastReferenceActionDiagnostics.pickerAddActionScan || { candidateCount: 0, enabledCount: 0, disabled: false, method: "not_found", labels: [] };
      error.diagnostics = { chipAttachScan: scan, pickerAddActionScan };
      console.error("[FlowReferenceAction] image reference chip confirmation timed out", JSON.stringify({ chipAttachScan: scan, pickerAddActionScan }));
      throw error;
    } finally {
      if (ownedMenu && visible(ownedMenu)) {
        const cleanup = await closeOwnedContextMenu(ownedMenu, deadline).catch(() => ({ closed: false, method: "failed" }));
        updateReferenceActionDiagnostics({ ...diagnostic, cleanup: cleanup.method });
      }
      release();
    }
  }
  const options = () => [
    ...(((typeof root.flowQueryAll === "function" && picker()) ? root.flowQueryAll("components.optionItem", picker()) : null) ||
      (picker()?.querySelectorAll('[role="option"]') || []))
  ].filter(visible);
  function emptyPickerMessage() {
    return [...document.querySelectorAll('[role="dialog"],main,[role="listbox"]')].filter(visible)
      .some(el => /no (?:assets|characters) found|không tìm thấy (?:tài sản|nội dung|nhân vật|giọng nói|giọng|kết quả)(?: nào)?/i.test(el.innerText || el.textContent || ""));
  }
  async function settled(deadline, signal, listGetter = picker) {
    // Wait for both the picker and its loading state; an empty list is a valid settled state.
    const until = Math.min(Date.now() + 15_000, deadline);
    let stableAt = 0;
    let transientSurfaceAt = 0;
    while (Date.now() < until) {
      const list = listGetter();
      const loading = [...document.querySelectorAll('[role="progressbar"],[aria-busy="true"]')].some(visible);
      if (list && !loading) {
        transientSurfaceAt = 0;
        if (options().length || /No (?:assets|characters) found|không tìm thấy/i.test(list.innerText || "")) return list;
        if (!stableAt) stableAt = Date.now();
        if (Date.now() - stableAt >= 700) return list;
      } else if (!loading && emptyPickerMessage()) {
        transientSurfaceAt = 0;
        if (!stableAt) stableAt = Date.now();
        if (Date.now() - stableAt >= 700) return null;
      } else {
        stableAt = 0;
        if (!list) {
          const surfaces = visiblePickerSurfaces();
          const menus = surfaces.filter(surface => surface.role === "menu" || surface.tag === "mat-menu");
          if (surfaces.some(surface => surface.role === "dialog" || surface.role === "menu") || menus.length) {
            const ambiguous = surfaces.length !== 1;
            if (!transientSurfaceAt) transientSurfaceAt = Date.now();
            // Flow can briefly show its add menu while the component picker is
            // opening. Let that bounded transition settle; never click a menu
            // item by position or infer that it represents an asset option.
            if (Date.now() - transientSurfaceAt >= 1800) {
              const code = ambiguous ? "FLOW_ASSET_PICKER_SURFACE_AMBIGUOUS" : "FLOW_ASSET_PICKER_TRANSITION_UNSUPPORTED";
              const message = ambiguous
                ? "Flow opened multiple or ambiguous reference surfaces; no supported picker transition was identified, so nothing was selected."
                : `Flow left a ${menus.length ? "menu" : "dialog"} open instead of the component listbox; no menu item was selected.`;
              const error = flowError(code, message, false, false);
              error.diagnostics = { transitionWaitMs: Date.now() - transientSurfaceAt, visibleSurfaces: surfaces };
              updateReferenceActionDiagnostics({ surfaceStatus: ambiguous ? "ambiguous" : "menu_transition_timeout", transitionWaitMs: Date.now() - transientSurfaceAt, visibleSurfaces: surfaces });
              throw error;
            }
          } else {
            transientSurfaceAt = 0;
          }
        }
      }
      await boundedWait(150, deadline, "waiting for the reference picker", false, signal);
    }
    requireTime(deadline, "waiting for the reference picker");
    throw flowError("FLOW_ASSET_PICKER_LOADING", "Flow's reference picker did not finish loading. Nothing was selected.", true);
  }
  async function open(slot, deadline, signal) {
    requireTime(deadline, "opening the reference picker");
    const existing = picker();
    if (existing) {
      if (!isReferencePickerSurface(existing)) {
        throw flowError("FLOW_REFERENCE_PICKER_BUSY", "Flow has another listbox open, not the reference asset picker. It was left untouched; no image was selected.", false, false);
      }
      await settled(deadline, signal);
      return;
    }
    {
      const button = slot === "start" ? flowButton("Start") : slot === "end" ? flowButton("End") : await ensureAddMediaButton(deadline, signal);
      if (!button) throw flowError("FLOW_ASSET_PICKER_MISSING", `Flow's ${slot || "reference"} picker is unavailable.`, true);
      const priorLists = new Set([...document.querySelectorAll('[role="listbox"]')]);
      const controlledIds = [button.getAttribute?.("aria-controls"), button.getAttribute?.("aria-owns")].filter(Boolean).flatMap(value => String(value).split(/\s+/));
      button.click();
      const openedList = () => {
        const controlled = [...new Set(controlledIds.map(id => document.getElementById?.(id)).filter(list => list?.getAttribute?.("role") === "listbox" && visible(list)))];
        if (controlled.length === 1) return controlled[0];
        if (controlled.length > 1) return null;
        const added = [...document.querySelectorAll('[role="listbox"]')].filter(list => visible(list) && !priorLists.has(list));
        return added.length === 1 ? added[0] : null;
      };
      await settled(deadline, signal, openedList);
    }
  }
  const CATEGORY_SYNONYMS = {
    "characters": ["characters", "nhân vật", "nhan vat"],
    "voices": ["voices", "voice", "giọng nói", "giọng", "giong noi"],
    "all": ["all", "tất cả", "tat ca", "tất cả nội dung nghe nhìn", "tất cả nội dung nghệ thuật", "tất cả nội dung", "all media", "ingredients", "thành phần"],
    "ingredients": ["ingredients", "thành phần", "nguyên liệu", "all", "tất cả"],
    "uploads": ["uploads", "tải lên", "tai len", "upload", "nội dung tải lên", "noi dung tai len", "đã tải lên", "da tai len", "tệp tải lên", "tep tai len"]
  };
  function pickerSurface() {
    const list = picker();
    return list?.closest?.('[role="dialog"], mat-dialog-container, flow-dialog, .cdk-overlay-pane, [class*="dialog"], [class*="picker"], [class*="surface"]') ||
      document.querySelector?.('[role="dialog"], mat-dialog-container, flow-dialog, .cdk-overlay-pane') ||
      document;
  }
  function pickerCategoryTabs(name) {
    const norm = normalize(name);
    const synonyms = CATEGORY_SYNONYMS[norm] || [norm];
    const surface = pickerSurface();
    const queriedTabs = typeof root.flowQueryAll === "function" ? root.flowQueryAll("components.categoryTabs", surface) : null;
    const tabElements = queriedTabs && queriedTabs.length ? queriedTabs : [
      ...(surface?.querySelectorAll?.('[role="tab"],button,[role="button"],mat-chip,[class*="chip"]') || [])
    ];
    return [...new Set([
      ...tabElements,
      ...(surface?.querySelectorAll?.('[role="tab"],button,[role="button"]') || []),
      ...(picker()?.querySelectorAll?.('[role="tab"],button,[role="button"]') || []),
      ...(document?.querySelectorAll?.('[role="tab"]') || []),
    ])].filter(el => {
      if (!visible(el)) return false;
      const rawText = accessibleName(el) || el.innerText || el.textContent || "";
      const label = normalize(rawText).replace(/^(?:accessibility_new|dashboard|face|voice_selection|graphic_eq|record_voice_over|perm_media|video_library|grid_view|folder|collections)\s*/, "");
      const icon = normalize(el.querySelector?.("mat-icon,.mat-icon,.google-symbols,.material-symbols-outlined")?.textContent);
      return synonyms.includes(label) || synonyms.some(syn => label.includes(syn)) ||
        norm === "voices" && ["voice_selection", "graphic_eq", "record_voice_over"].includes(icon);
    });
  }
  function findPickerCategoryTab(name) {
    const matches = pickerCategoryTabs(name);
    if (matches.length > 1) throw flowError("FLOW_REFERENCE_CATEGORY_AMBIGUOUS", `Flow's ${name} picker category is ambiguous; no category was selected.`, false, false);
    return matches[0] || null;
  }
  async function category(name, deadline, signal) {
    requireTime(deadline, `selecting the ${name} picker category`);
    const norm = normalize(name);
    let tab = findPickerCategoryTab(norm);
    if (!tab) {
      if (norm === "all" || norm === "ingredients") {
        await settled(deadline, signal);
        const list = picker();
        const visibleOptions = list ? listOptions(list) : [];
        lastReferenceActionDiagnostics = {
          ...lastReferenceActionDiagnostics,
          activeCategory: diagnosticCategory(norm),
          categorySelected: true,
          pickerOptionCount: visibleOptions.length,
          optionLabelHashes: diagnosticOptionHashes(visibleOptions),
        };
        return;
      }
      throw flowError("FLOW_REFERENCE_CATEGORY_MISSING", `Flow's picker has no ${name} category.`, true);
    }
    if (tab.getAttribute("aria-selected") !== "true") {
      tab.click();
      const selectionDeadline = Math.min(Date.now() + 5000, deadline);
      while (Date.now() < selectionDeadline) {
        tab = findPickerCategoryTab(norm);
        if (tab?.getAttribute("aria-selected") === "true") break;
        await boundedWait(100, selectionDeadline, `selecting the ${name} picker category`, false, signal);
      }
      if (tab?.getAttribute("aria-selected") !== "true") throw flowError("FLOW_REFERENCE_CATEGORY_UNCONFIRMED", `Flow did not select the ${name} category.`, true);
    }
    await settled(deadline, signal);
    const list = picker();
    const visibleOptions = list ? listOptions(list) : [];
    lastReferenceActionDiagnostics = {
      ...lastReferenceActionDiagnostics,
      activeCategory: diagnosticCategory(norm),
      categorySelected: true,
      pickerOptionCount: visibleOptions.length,
      optionLabelHashes: diagnosticOptionHashes(visibleOptions),
    };
  }
  async function close(deadline = Date.now() + 3200, signal) {
    updateReferenceActionDiagnostics({ step: "closing picker" });
    const waitLocal = async (ms, localDeadline, operation) => {
      const remaining = Math.min(ms, localDeadline - Date.now());
      if (remaining <= 0) {
        requireTime(deadline, operation, false, signal);
        return;
      }
      // Local cleanup windows should advance to the dismiss fallback. Only the
      // caller's absolute deadline or signal should abort picker cleanup.
      await boundedWait(remaining, deadline, operation, false, signal);
    };
    const initialPicker = picker();
    const composer = initialPicker?.closest?.("flow-base-prompt-box, .base-prompt-box, .flow-composer, [class*='composer'], [class*='prompt-box']") ||
      document.querySelector?.("flow-base-prompt-box, .base-prompt-box, .flow-composer, [class*='composer'], [class*='prompt-box']") || null;
    const dialog = initialPicker?.closest?.('[role="dialog"]');
    const closeButton = (composer && (flowButton("Close", composer) || flowButton("Đóng", composer))) ||
      (dialog && (flowButton("Close", dialog) || flowButton("Đóng", dialog))) || null;
    if (initialPicker && closeButton) closeButton.click();
    else {
      const opener = flowButton("Add ingredients to the prompt box");
      if (initialPicker && opener) opener.click();
    }
    const firstDeadline = Math.min(Date.now() + 700, deadline);
    while (Date.now() < firstDeadline && picker()) await waitLocal(100, firstDeadline, "closing the Flow reference picker");
    if (picker()) {
      requireTime(deadline, "dismissing the Flow reference picker", false, signal);
      const list = picker();
      const activeDialog = list?.closest('[role="dialog"]');
      const activeComposer = list?.closest?.("flow-base-prompt-box, .base-prompt-box, .flow-composer, [class*='composer'], [class*='prompt-box']") ||
        document.querySelector?.("flow-base-prompt-box, .base-prompt-box, .flow-composer, [class*='composer'], [class*='prompt-box']") || null;
      const fallbackClose = (activeComposer && (flowButton("Close", activeComposer) || flowButton("Đóng", activeComposer))) ||
        (activeDialog && (flowButton("Close", activeDialog) || flowButton("Đóng", activeDialog)));
      if (fallbackClose) fallbackClose.click();
      else {
        document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      }
    }
    const closeDeadline = Math.min(Date.now() + 2500, deadline);
    while (Date.now() < closeDeadline && picker()) await waitLocal(100, closeDeadline, "closing the Flow reference picker");
    if (picker()) {
      const error = flowError("FLOW_ASSET_PICKER_CLOSE_FAILED", "Flow's reference picker stayed open and could not be dismissed.", true);
      updateReferenceActionDiagnostics({ step: "picker close failed", cleanupError: error.message });
      throw error;
    }
    updateReferenceActionDiagnostics({ step: "picker closed" });
  }
  async function closeAfterOperation(deadline, signal, operationError) {
    // A cancelled/expired picker operation must still get a short cleanup
    // window. Reusing its aborted signal or expired deadline skips the close
    // verification and can leave the picker mounted for the next queued job.
    return operationError ? close(Date.now() + 3200) : close(deadline, signal);
  }
  async function closePicker(config = {}) {
    const deadline = config.deadline || makeDeadline(config.command, 10_000, 2_000);
    const wasOpen = Boolean(picker());
    updateReferenceActionDiagnostics({ action: "close", phase: "running", step: wasOpen ? "closing picker" : "picker already closed", error: null, cleanupError: null });
    if (wasOpen) await close(deadline, config.signal);
    const closed = !picker();
    updateReferenceActionDiagnostics({ action: "close", phase: closed ? "completed" : "failed", step: closed ? "picker closed" : "picker remains open" });
    if (!closed) throw flowError("FLOW_ASSET_PICKER_CLOSE_FAILED", "Flow's reference picker stayed open; no prompt or library content was changed.", false);
    return { wasOpen, closed: true };
  }
  async function inspectPicker(value, config = {}) {
    const ref = parse(value);
    const deadline = config.deadline || makeDeadline(config.command, 20_000, 4_000);
    if (picker()) {
      const error = flowError("FLOW_REFERENCE_PICKER_ALREADY_OPEN", "Flow's reference picker was already open; inspection made no changes and left it open.", false, false);
      updateReferenceActionDiagnostics({ action: "inspect", phase: "failed", step: "pre-existing picker left unchanged", error: `${error.code}: ${error.message}` });
      throw error;
    }
    updateReferenceActionDiagnostics({ action: "inspect", phase: "running", step: "opening reference picker", error: null, cleanupError: null, lastResult: null });
    let operationError;
    let openedByOperation = false;
    try {
      requireTime(deadline, "inspecting the Flow reference picker", false, config.signal);
      openedByOperation = true;
      await open(undefined, deadline, config.signal);
      await category(ref.kind === "character" ? "Characters" : "All", deadline, config.signal);
      await search(ref.name, deadline, config.signal);
      const snapshot = referenceActionDiagnosticsSnapshot();
      const matched = exactOption(options(), ref.name, ref.kind !== "character");
      const matchedLabel = matched
        ? (accessibleName(matched) || matched.getAttribute("aria-label") || matched.getAttribute("title") || matched.innerText || matched.textContent || "").replace(/\s+/g, " ").trim()
        : null;
      const result = {
        reference: ref.name,
        kind: ref.kind || "image",
        search_value: snapshot.searchValue,
        category_tabs: snapshot.categoryTabs,
        option_count: snapshot.pickerOptionCount,
        option_labels: snapshot.pickerOptionLabels,
        exact_match: Boolean(matched),
        matched_label: matchedLabel,
        selected: false,
      };
      updateReferenceActionDiagnostics({ action: "inspect", phase: "completed", step: "picker inspected without selecting", lastResult: { exactMatch: result.exact_match, matchedLabel } });
      return result;
    } catch (error) {
      operationError = error;
      updateReferenceActionDiagnostics({ action: "inspect", phase: "failed", step: "picker inspection failed", error: `${error?.code || "FLOW_REFERENCE_INSPECT_ERROR"}: ${error?.message || String(error)}` });
      throw error;
    } finally {
      if (openedByOperation) {
        try { await closeAfterOperation(deadline, config.signal, operationError); }
        catch (cleanupError) {
          updateReferenceActionDiagnostics({ cleanupError: `${cleanupError?.code || "FLOW_PICKER_CLOSE_ERROR"}: ${cleanupError?.message || String(cleanupError)}` });
          if (!operationError) throw cleanupError;
        }
      }
    }
  }
  function referenceSearchControl() {
    const supported = ["search assets", "tìm kiếm nội dung nghe nhìn", "tìm kiếm nội dung", "tìm kiếm", "search"];
    let owner = picker();
    // Search controls are only trusted when owned by this picker surface. A
    // project-level/global search can have the same label and accept text while
    // leaving the reference list untouched.
    for (let depth = 0; owner && depth < 8; depth++, owner = owner.parentElement) {
      const controls = [...(owner.querySelectorAll?.('input,[role="textbox"]') || [])].filter(visible);
      if (!controls.length) continue;
      for (const el of controls) {
        const raw = accessibleName(el) || el.placeholder || "";
        const label = normalize(raw);
        const canonical = supported.find(value => label === value || value !== "search" && value !== "tìm kiếm" && label.startsWith(`${value} `));
        if (canonical) return { element: el, label: canonical };
      }
      // A nearer owner has controls but none has a supported search label;
      // widening the scope could select a decoy from a parent surface.
      return null;
    }
    return null;
  }
  async function search(name, deadline, signal) {
    requireTime(deadline, "searching Flow references");
    const control = referenceSearchControl();
    if (!control) {
      lastReferenceActionDiagnostics = { ...lastReferenceActionDiagnostics, searchLabelRecognized: false, searchLabel: null };
      return { recognized: false };
    }
    const input = control.element;
    lastReferenceActionDiagnostics = { ...lastReferenceActionDiagnostics, searchLabelRecognized: true, searchLabel: control.label };
    setEditable(input, name);
    const wanted = String(name || "");
    const searchDeadline = Math.min(Date.now() + 8000, deadline);
    while (Date.now() < searchDeadline) {
      const current = input.value !== undefined ? input.value : input.innerText;
      if (String(current || "").trim() === wanted.trim()) break;
      await boundedWait(100, searchDeadline, "waiting for Flow to accept the reference search", false, signal);
    }
    if (String(input.value ?? input.innerText ?? "").trim() !== wanted.trim()) {
      throw flowError("FLOW_REFERENCE_SEARCH_UNCONFIRMED", "Flow did not accept the reference search text.", true);
    }
    const wantedNorm = normalize(wanted);
    const resultDeadline = Math.min(Date.now() + 8000, deadline);
    let previousSignature = null;
    let stable = 0;
    while (Date.now() < resultDeadline) {
      const list = picker();
      const visibleOptions = list ? listOptions(list) : [];
      const names = visibleOptions.flatMap(referenceOptionLabels).map(normalize);
      const exact = visibleOptions.some(option => exactOption([option], wanted, true));
      const matchesQuery = names.length > 0 && names.every(label => label.includes(wantedNorm) || undecorate(label) === wantedNorm);
      const empty = Boolean(list && /(?:no (?:assets|characters) found|không tìm thấy)/i.test(list.innerText || list.textContent || ""));
      const signature = JSON.stringify(names.slice().sort());
      stable = signature === previousSignature ? stable + 1 : 0;
      previousSignature = signature;
      if (exact || empty || matchesQuery && stable >= 2) {
        await boundedWait(100, deadline, "settling Flow reference search results", false, signal);
        lastReferenceActionDiagnostics = { ...lastReferenceActionDiagnostics, searchResultsVerified: true };
        return { recognized: true, resultsVerified: true };
      }
      try { await boundedWait(150, resultDeadline, "waiting for Flow reference search results to match the query", false, signal); }
      catch (error) {
        if (error?.code === "FLOW_OPERATION_TIMEOUT" && Date.now() >= resultDeadline) break;
        throw error;
      }
    }
    // The picker-owned input accepted the query, but its current rows may be
    // stale. Clear and verify the query before scanning the full virtualized
    // list. The scanner will only select after it proves a unique match and
    // reaches the end.
    setEditable(input, "");
    const clearDeadline = Math.min(Date.now() + 2500, deadline);
    while (Date.now() < clearDeadline && String(input.value ?? input.innerText ?? "").trim() !== "") {
      await boundedWait(100, clearDeadline, "verifying cleared Flow reference search", false, signal);
    }
    if (String(input.value ?? input.innerText ?? "").trim() !== "") {
      const error = flowError("FLOW_REFERENCE_SEARCH_CLEAR_UNCONFIRMED", "Flow did not clear the stale reference search; no reference was selected.", true, false);
      error.diagnostics = referenceScanEvidence({ optionCount: options().length, pages: 0, endReached: false, errorCode: error.code });
      lastReferenceActionDiagnostics = { ...lastReferenceActionDiagnostics, searchResultsVerified: false, pickerScanPages: 0, pickerScanEndReached: false };
      throw error;
    }
    await boundedWait(180, deadline, "settling the cleared Flow reference search", false, signal);
    lastReferenceActionDiagnostics = { ...lastReferenceActionDiagnostics, searchResultsVerified: false, pickerScanPages: 0, pickerScanEndReached: false };
    return { recognized: true, resultsVerified: false, fallbackToScan: true };
  }
  async function returnToProjectComposer() {
    if (isNewCharacterRoute(location.pathname)) {
      const back = await waitForEnabledFlowButton("Go back", 3000);
      if (!back) throw flowError("FLOW_CHARACTER_BACK_MISSING", "Flow's New character page has no Go back control.", true, true);
      back.click();
      await waitForFlowRoute(path => !isNewCharacterRoute(path), 15_000, "Flow did not leave the New character page.");
    } else if (isCharacterEditorRoute(location.pathname)) {
      const done = await waitForEnabledFlowButton("Done", 3000) || await waitForEnabledFlowButton("Done editing", 1000);
      if (!done) throw flowError("FLOW_CHARACTER_SAVE_MISSING", "Flow's character editor has no Done control; its current state may be unsaved.", false, true);
      done.click();
      await waitForFlowRoute(path => !isCharacterRoute(path), 15_000, "Flow did not close the character editor.");
    }
    if (isCharacterRoute(location.pathname)) throw flowError("FLOW_CHARACTER_ROUTE_UNEXPECTED", "Flow is still on a character page; the character picker cannot be opened safely.", true, true);
    const agentMode = root.FlowAgent?.findNativeAgentModeControl?.();
    if (agentMode?.pressed === true || agentMode?.control?.getAttribute?.("aria-pressed") === "true" || root.FlowAgent?.isNativeAgentSessionOpen?.()) {
      throw flowError("FLOW_AGENT_COMPOSER_ACTIVE", "The Agent composer is active. Close or switch off Agent before opening the project character picker.", true, false);
    }
    const checkComposer = () => (typeof root.flowQuery === "function" && root.flowQuery("editor")) ||
      Boolean(document.querySelector?.(".ProseMirror[contenteditable='true'],.ProseMirror,flow-base-prompt-box [contenteditable='true']")) ||
      [...(document.querySelectorAll?.(".ProseMirror[contenteditable='true'],flow-base-prompt-box [contenteditable='true']") || [])].some(el => el.isContentEditable && visible(el));
    const hasComposer = checkComposer();
    if (!hasComposer) await ensureFlowLibrarySection("All media");
    const hasComposerAfter = checkComposer();
    if (!hasComposerAfter) throw flowError("FLOW_COMPOSER_MISSING", "Flow's project composer is not visible after returning from the character page.", true);
  }
  async function listCharacters(config = {}) {
    const deadline = config.deadline || (Date.now() + 45_000);
    updateReferenceActionDiagnostics({ action: "listCharacters", phase: "running", step: "opening character picker", error: null, cleanupError: null });
    let operationError;
    try {
      requireTime(deadline, "opening the character picker");
      await returnToProjectComposer();
      await open(undefined, deadline, config.signal);
      if (!picker() && emptyPickerMessage()) return [];
      try { await category("Characters", deadline, config.signal); }
      catch (error) {
        if (error?.code === "FLOW_REFERENCE_CATEGORY_MISSING" && emptyPickerMessage()) return [];
        throw error;
      }
      await search("", deadline, config.signal);
      const names = new Map(chips().filter(chip => chip.kind === "character" && chip.name).map(chip => [normalize(chip.name), chip.name]));
      let list = picker();
      const scroller = list && [list, ...list.querySelectorAll("*")].find(el => el.clientHeight > 0 && el.scrollHeight > el.clientHeight + 5);
      if (scroller) scroller.scrollTop = 0;
      let reachedEnd = !scroller;
      for (let page = 0; page < 120 && Date.now() < deadline; page++) {
        list = await settled(deadline, config.signal);
        for (const option of options()) {
          const name = (accessibleName(option) || option.innerText || option.textContent || "").replace(/\s+/g, " ").trim();
          if (name && !/^(?:characters?|no characters found)$/i.test(name)) names.set(normalize(name), name);
        }
        if (!scroller || scroller.scrollTop >= scroller.scrollHeight - scroller.clientHeight - 2) { reachedEnd = true; break; }
        const previous = scroller.scrollTop;
        scroller.scrollTop = Math.min(scroller.scrollHeight - scroller.clientHeight, previous + Math.max(120, scroller.clientHeight * 0.75));
        await boundedWait(250, deadline, "scanning Flow characters", false, config.signal);
        if (scroller.scrollTop <= previous) throw flowError("FLOW_CHARACTER_SCAN_INCOMPLETE", "Flow's character picker stopped scrolling before its end; no complete list was returned.", true);
      }
      requireTime(deadline, "scanning Flow characters");
      if (!reachedEnd) throw flowError("FLOW_CHARACTER_SCAN_LIMIT", "Flow's character picker exceeded the scan page limit; no partial list was returned.", true);
      const result = [...names.values()].filter(Boolean);
      updateReferenceActionDiagnostics({ phase: "completed", step: "characters listed", lastResult: { count: result.length } });
      return result;
    } catch (error) {
      operationError = error;
      updateReferenceActionDiagnostics({ phase: "failed", step: "character listing failed", error: `${error?.code || "FLOW_CHARACTER_LIST_ERROR"}: ${error?.message || String(error)}` });
      throw error;
    } finally {
      try { await closeAfterOperation(deadline, config.signal, operationError); }
      catch (cleanupError) {
        updateReferenceActionDiagnostics({ cleanupError: `${cleanupError?.code || "FLOW_PICKER_CLOSE_ERROR"}: ${cleanupError?.message || String(cleanupError)}` });
        if (!operationError) throw cleanupError;
      }
    }
  }
  async function attach(value, slot, config = {}) {
    const ref = parse(value);
    const deadline = config.deadline || makeDeadline(config.command, 45_000, 10_000);
    updateReferenceActionDiagnostics({ action: "attach", phase: "running", step: "preparing reference", error: null, cleanupError: null, lastResult: null,
      searchLabelRecognized: false, searchLabel: null, searchResultsVerified: false, pickerScanPages: 0, pickerScanEndReached: false,
      categoriesScanned: [], chipAttachScan: null, pickerAddActionScan: null });
    findPickerAddToPromptButton.lastScanSignature = null;
    let operationError;
    try {
      requireTime(deadline, "attaching a Flow reference", false, config.signal);
      // Flow excludes already attached characters from its picker. Check our
      // confirmed provenance first, before requiring the option to exist again.
      const reusableCandidates = chips().filter(chip => normalize(chip.name) === normalize(ref.name) && (!ref.kind || chip.kind === ref.kind));
      const requestedReusableId = config.expectedId && reusableCandidates.length
        ? (await resolveNativeMediaUuid(config.expectedId, "image") || String(config.expectedId).toLowerCase())
        : null;
      const reusable = reusableCandidates.find(chip => {
        if (!requestedReusableId) return true;
        const existingId = chip.kind === "character"
          ? explicitCharacterUuid(chip.element) || (chip.mediaIdSource === "character_identity_attribute" ? chip.mediaId : undefined)
          : chip.mediaId || chipMediaUuids(chip)[0];
        return String(existingId || "").toLowerCase() === requestedReusableId;
      });
      if (reusable) {
        const reusableId = reusable.kind === "character"
          ? explicitCharacterUuid(reusable.element) || (reusable.mediaIdSource === "character_identity_attribute" && characterUuidPattern.test(String(reusable.mediaId || "")) ? String(reusable.mediaId).toLowerCase() : undefined)
          : reusable.mediaId || chipMediaUuids(reusable)[0];
        if (reusable.kind === "character" && !reusableId) {
          throw flowError("FLOW_CHARACTER_ID_UNAVAILABLE", `Flow did not expose an explicit character identity for "${ref.name}". No selection or generation was submitted.`, false, false);
        }
        if (requestedReusableId && String(reusableId || "").toLowerCase() !== requestedReusableId) {
          throw flowError("FLOW_ASSET_ID_MISMATCH", `The already attached reference "${ref.name}" cannot be proven to match the uploaded media ID. No generation was submitted.`, false, false);
        }
        const result = { name: ref.name, kind: reusable.kind, source: reusable.source, ...(reusableId ? { id: reusableId } : {}), confirmed: true, reused: true };
        updateReferenceActionDiagnostics({ phase: "completed", step: "existing reference reused", lastResult: { name: result.name, id: result.id || null } });
        return result;
      }
      if (!slot && ref.kind !== "character" && config.expectedId) {
        const tileResult = await attachUploadedImageFromTile(ref, config.expectedId, deadline, config.signal);
        if (tileResult) {
          updateReferenceActionDiagnostics({ phase: "completed", lastResult: { confirmed: true, chipUuidConfirmed: tileResult.chipUuidConfirmed } });
          return tileResult;
        }
      }
      updateReferenceActionDiagnostics({ step: "opening reference picker" });
      await open(slot, deadline, config.signal);
      updateReferenceActionDiagnostics({ step: "selecting picker category" });
      await category(ref.kind === "character" ? "Characters" : "All", deadline, config.signal);
      const scanCategories = [ref.kind === "character" ? "characters" : "all"];
      if (!slot && ref.kind !== "character") {
        const uploadsTabs = pickerCategoryTabs("uploads");
        if (uploadsTabs.length > 1) throw flowError("FLOW_REFERENCE_CATEGORY_AMBIGUOUS", "Flow's Uploads picker category is ambiguous; no category was selected.", false, false);
        if (uploadsTabs.length === 1 && !scanCategories.includes("uploads")) scanCategories.push("uploads");
      }
      let scan = null;
      let option = null;
      let exactTitleWithWrongId = false;
      for (const scanCategory of scanCategories) {
        if (scanCategory !== (ref.kind === "character" ? "characters" : "all")) {
          await category(scanCategory, deadline, config.signal);
        }
        const categoriesScanned = [...new Set([...(lastReferenceActionDiagnostics.categoriesScanned || []), scanCategory])];
        updateReferenceActionDiagnostics({ categoriesScanned, step: `searching ${scanCategory} for exact reference` });
        await search(ref.name, deadline, config.signal);
        const categoryScan = await scanExactReferenceOption(ref.name, ref.kind !== "character", deadline, config.signal);
        scan = categoryScan;
        updateReferenceActionDiagnostics({ pickerScanPages: categoryScan.pages, pickerScanEndReached: categoryScan.reachedEnd, pickerOptionCount: categoryScan.optionCount });
        if (!categoryScan.option) continue;
        if (config.expectedId && ref.kind !== "character") {
          const candidateId = await resolveNativeMediaUuid(referenceOptionMediaId(categoryScan.option), "image") || referenceOptionMediaId(categoryScan.option);
          const expectedId = await resolveNativeMediaUuid(config.expectedId, "image") || config.expectedId;
          if (candidateId !== expectedId) {
            exactTitleWithWrongId = true;
            continue;
          }
        }
        option = categoryScan.option;
        break;
      }
      if (!option) {
        const error = exactTitleWithWrongId
          ? flowError("FLOW_ASSET_ID_MISMATCH", `Flow's reference picker did not expose the exact uploaded UUID for "${ref.name}" in the scanned categories. Nothing was attached.`, false, false)
          : flowError("FLOW_ASSET_NOT_FOUND", `No exact ${ref.kind || "reference"} named "${ref.name}" in the scanned project categories after complete picker scans. Nothing was attached.`, true, false);
        error.diagnostics = referenceScanEvidence({ pages: scan?.pages || 0, endReached: scan?.reachedEnd === true, optionCount: scan?.optionCount || 0, errorCode: error.code });
        throw error;
      }
      const tile = option.querySelector("flow-grid-tile-container") || [...document.querySelectorAll("flow-grid-tile-container")].find(el => normalize(el.getAttribute("aria-label")) === normalize(ref.name));
      const tileId = tile && mediaId(tile);
      const kind = ref.kind || (tile?.querySelector("flow-character-tile") || /\bCharacter$/i.test(accessibleName(option)) ? "character" : "image");
      // A character tile's generic mediaId is its portrait asset in some Flow
      // builds. Only character-specific identity attributes prove the entity.
      let selectedId = kind === "character"
        ? explicitCharacterUuid(option, tile)
        : referenceOptionMediaId(option);
      if (kind === "character" && !selectedId) {
        throw flowError("FLOW_CHARACTER_ID_UNAVAILABLE", `Flow did not expose an explicit character identity for "${ref.name}". No selection or generation was submitted.`, false, false);
      }
      let expectedId = config.expectedId;
      if (kind === "image") {
        selectedId = await resolveNativeMediaUuid(selectedId, "image") || selectedId;
        expectedId = await resolveNativeMediaUuid(expectedId, "image") || expectedId;
      }
      if (expectedId && selectedId !== expectedId) {
        throw flowError("FLOW_ASSET_ID_MISMATCH", `Flow's reference picker did not prove that "${ref.name}" matches the completed upload ID. No generation was submitted.`, false, false);
      }
      const before = chips();
      // A character thumbnail can be on flow-content.google while its chip is on
      // /asb/. Those are different representations, not interchangeable IDs.
      // Only reuse a chip whose selection provenance this driver recorded.
      const existing = before.find(chip => chip.name === ref.name && chip.kind === kind);
      if (existing) {
        const result = { name: ref.name, kind, source: existing.source, id: kind === "character" ? selectedId : existing.mediaId || selectedId, confirmed: true, reused: true };
        updateReferenceActionDiagnostics({ phase: "completed", step: "existing reference reused", lastResult: { name: result.name, id: result.id || null } });
        return result;
      }
      updateReferenceActionDiagnostics({ step: "selecting exact reference" });
      dispatchPrimaryClick(option);
      // Character options attach immediately; images may require Add to prompt.
      let confirmedClick = false;
      let addActionClickAt = 0;
      let addActionRetryUsed = false;
      const attachDeadline = Math.min(Date.now() + 10000, deadline);
      while (Date.now() < attachDeadline) {
        const currentChips = chips();
        const added = addedReferenceChips(before, currentChips);
        const chip = added.length === 1 && added[0].kind === kind ? added[0] : null;
        if (chip) {
          const result = { name: ref.name, kind: chip.kind, source: chip.source, id: selectedId, confirmed: true };
          metadata.set(chip.element, { name: ref.name, mediaId: selectedId, ...(kind === "character" ? { mediaIdSource: "character_identity_attribute" } : {}) });
          updateReferenceActionDiagnostics({ phase: "completed", step: "reference chip confirmed", lastResult: { name: result.name, id: result.id || null } });
          return result;
        }
        if (slot && !picker()) {
          const result = { name: ref.name, kind, confirmed: true, slot };
          updateReferenceActionDiagnostics({ phase: "completed", step: "frame slot confirmed", lastResult: { name: result.name, slot } });
          return result;
        }
        const add = findPickerAddToPromptButton();
        if (!confirmedClick && add && !isFlowActionDisabled(add) && picker()) {
          dispatchPrimaryClick(add);
          confirmedClick = true;
          addActionClickAt = Date.now();
          updateReferenceActionDiagnostics({ step: "clicked_picker_add_to_prompt", pickerAddActionScan: { candidateCount: 1, disabled: false, method: "pointer_sequence" } });
        } else if (confirmedClick && !addActionRetryUsed && add && !isFlowActionDisabled(add) && picker() && chips().length === before.length && Date.now() - addActionClickAt >= 1800) {
          // A few Flow builds ignore HTMLElement.click()/synthetic pointer
          // activation on the dialog's footer until the control is activated
          // through its normal click handler. Retry once only while the exact
          // picker remains open and the composer still has the original count.
          add.click();
          addActionRetryUsed = true;
          updateReferenceActionDiagnostics({ step: "retried_picker_add_to_prompt", pickerAddActionScan: { candidateCount: 1, disabled: false, method: "element_click_retry" } });
        }
        await boundedWait(150, attachDeadline, `confirming reference "${ref.name}"`, true, config.signal);
      }
      requireTime(deadline, `confirming reference "${ref.name}"`);
      throw flowError("FLOW_REFERENCE_ATTACH_UNCONFIRMED", `Flow did not show a matching ${ref.kind || "reference"} chip for "${ref.name}". The picker action may have been accepted; inspect the composer before retrying.`, false, true);
    } catch (error) {
      operationError = error;
      if (error?.outcome_unknown !== true && !error?.diagnostics) {
        error.diagnostics = referenceScanEvidence({ errorCode: String(error?.code || "FLOW_REFERENCE_ATTACH_ERROR").slice(0, 90) });
      }
      updateReferenceActionDiagnostics({ phase: "failed", step: "reference attachment failed", error: `${error?.code || "FLOW_REFERENCE_ATTACH_ERROR"}: ${error?.message || String(error)}` });
      throw error;
    } finally {
      try { await closeAfterOperation(deadline, config.signal, operationError); }
      catch (cleanupError) {
        updateReferenceActionDiagnostics({ cleanupError: `${cleanupError?.code || "FLOW_PICKER_CLOSE_ERROR"}: ${cleanupError?.message || String(cleanupError)}` });
        if (!operationError) throw cleanupError;
      }
    }
  }
  async function removeKind(kind, config = {}) {
    const normalizedKind = String(kind || "").trim().toLowerCase();
    if (!["image", "video", "character", "voice"].includes(normalizedKind)) {
      throw flowError("FLOW_INVALID_ARGUMENT", "Reference kind must be image, video, character, or voice.", false, false);
    }
    const deadline = Number.isFinite(config.deadline) ? config.deadline : makeDeadline(config.command, 20_000, 5_000);
    const composer = referenceComposerScope();
    const editor = root.getVisibleFlowPromptEditor?.();
    if (!editor || typeof root.getEditorUserText !== "function") {
      throw flowError("FLOW_PROMPT_PRESERVATION_UNVERIFIABLE", "Flow's prompt text could not be read, so reference removal was not started.", false, false);
    }
    const promptBefore = root.getEditorUserText(editor);
    const isVoice = normalizedKind === "voice";
    const list = () => isVoice
      ? root.FlowVoiceActions?.chips?.(composer) || []
      : chips().filter(chip => chip.kind === normalizedKind && composer.contains?.(chip.owner || chip.element));
    const countKind = kind => kind === "voice"
      ? (root.FlowVoiceActions?.chips?.(composer) || []).length
      : chips().filter(chip => chip.kind === kind && composer.contains?.(chip.owner || chip.element)).length;
    const otherKindsBefore = Object.fromEntries(["image", "video", "character", "voice"]
      .filter(kind => kind !== normalizedKind).map(kind => [kind, countKind(kind)]));
    const initial = list().length;
    let removed = 0;
    while (removed < initial) {
      root.FlowUiDeadline?.requireTime(deadline, `removing Flow ${normalizedKind} reference chips`, false, config.signal);
      const matches = list();
      if (!matches.length) break;
      const chip = matches[0];
      const owner = chip.owner || chip.element;
      const chipLabel = normalizeChipLabel(root.accessibleName?.(chip.element) || chip.element?.getAttribute?.("aria-label") || "");
      const directIngredientButton = chip.element?.matches?.("button") && /^(?:ingredient|thanh phan|nguyen lieu)(?:\b|$)/i.test(chipLabel);
      const removeKey = normalizedKind === "voice" ? "components.voiceRemoveButton" : "components.referenceRemoveButton";
      const configured = typeof root.flowQueryAll === "function" ? root.flowQueryAll(removeKey, owner, { checkVisible: false }) : [];
      const semanticIconRemove = typeof root.flowFindSemantic === "function"
        ? root.flowFindSemantic(removeKey, owner, { checkVisible: false, latestFirst: true, requireIcon: true })
        : null;
      const controls = [...new Set([...configured, ...(owner.matches?.('button,[role="button"]') ? [owner] : []), ...(owner.querySelectorAll?.('button,[role="button"]') || [])])].filter(root.visible);
      const labelsRemove = control => /(?:remove|delete|clear|close|xóa|gỡ|loại bỏ|bỏ khỏi)/i.test(root.accessibleName?.(control) || control.getAttribute?.("aria-label") || control.getAttribute?.("title") || control.innerText || control.textContent || "");
      const iconName = control => String(root.flowFindIcon?.(control)?.getAttribute?.("fonticon") || root.flowFindIcon?.(control)?.textContent || "").trim().toLowerCase();
      const iconRemove = semanticIconRemove && controls.includes(semanticIconRemove) ? semanticIconRemove :
        controls.find(control => ["close", "clear", "cancel"].includes(iconName(control)));
      const remove = directIngredientButton ? chip.element : controls.find(labelsRemove) || iconRemove;
      if (!remove || remove.disabled || remove.getAttribute("aria-disabled") === "true") {
        throw flowError("FLOW_REFERENCE_REMOVE_CONTROL_MISSING", `Flow's ${normalizedKind} reference chip has no verified remove control; no further chips were changed.`, false, false);
      }
      const beforeCount = matches.length;
      remove.click();
      const until = Math.min(Date.now() + 1_500, deadline);
      while (Date.now() < until && list().length >= beforeCount) {
        await (root.FlowUiDeadline?.boundedWait(100, deadline, `confirming removal of a Flow ${normalizedKind} chip`, false, config.signal) || root.wait?.(100));
      }
      const afterCount = list().length;
      if (afterCount >= beforeCount) throw flowError("FLOW_REFERENCE_REMOVE_UNCONFIRMED", `Flow did not confirm removal of a ${normalizedKind} reference chip; inspect the composer before retrying.`, false, false);
      removed += beforeCount - afterCount;
    }
    const remaining = list().length;
    const promptAfter = root.getEditorUserText(editor);
    if (promptAfter !== promptBefore) {
      throw flowError("FLOW_PROMPT_CHANGED_DURING_REFERENCE_REMOVE", "Flow's prompt text changed while reference chips were removed; inspect the composer before retrying.", false, false);
    }
    const otherKindsAfter = Object.fromEntries(Object.keys(otherKindsBefore).map(kind => [kind, countKind(kind)]));
    const otherKindsPreserved = Object.keys(otherKindsBefore).every(kind => otherKindsAfter[kind] === otherKindsBefore[kind]);
    if (!otherKindsPreserved) {
      throw flowError("FLOW_REFERENCE_KIND_SCOPE_CHANGED", "Flow changed another kind of reference chip during removal; inspect the composer before retrying.", false, false);
    }
    return { kind: normalizedKind, removed, remaining, confirmed: remaining === 0, prompt_preserved: promptAfter === promptBefore, other_kinds_preserved: otherKindsPreserved };
  }
  globalThis.FlowReferenceActions = Object.freeze({ attach, removeKind, listCharacters, chips, parse, exactOption, closePicker, inspectPicker, inspectDiagnostics: inspectReferenceActionDiagnostics });
  globalThis.FlowReferencePickerInternals = Object.freeze({ picker, open, category, closeAfterOperation, exactOption, options, findPickerCategoryTab });
  globalThis.listOptions = listOptions;
})();
