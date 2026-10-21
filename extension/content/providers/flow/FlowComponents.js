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

  function chips() {
    const enChips = (typeof root.flowQueryAll === "function" ? root.flowQueryAll("components.chips", document, { checkVisible: false }) : null) ||
      [...document.querySelectorAll('button[aria-label="Ingredient"]')];
    const viChips = [...document.querySelectorAll('button[aria-label="Thành phần"],button[aria-label="Nguyên liệu"]')];
    const dynamicButtons = (typeof root.flowQueryAll === "function" ? root.flowQueryAll("common.buttons", document, { checkVisible: false }) : null) ||
      [...document.querySelectorAll('button,[role="button"]')];
    const dynamicChips = dynamicButtons.filter(btn => {
      if (!visible(btn)) return false;
      const aria = (accessibleName(btn) || "").toLowerCase();
      const alt = (btn.querySelector?.("img")?.alt || "").toLowerCase();
      const isChipElement = Boolean(btn.closest?.("flow-character-ingredient-chip, [data-chip]"));
      return isChipElement ||
        aria.startsWith("thành phần") || aria.startsWith("nguyên liệu") ||
        alt.startsWith("thành phần") || alt.startsWith("nguyên liệu");
    });
    const all = [...new Set([...enChips, ...viChips, ...dynamicChips])];
    return all.filter(visible).map(button => {
      const image = button.querySelector?.("img");
      const kind = button.closest?.("flow-character-ingredient-chip") || /character|nhân vật/i.test(image?.alt || "") ? "character" : "image";
      return { element: button, kind, source: identity(image?.getAttribute?.("src")), ...metadata.get(button) };
    });
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
    return (typeof root.flowQueryVisible === "function" ? root.flowQueryVisible("components.listBox", document) : null) ||
      (typeof root.flowQuery === "function" ? root.flowQuery("components.listBox") : null) ||
      [...document.querySelectorAll('[role="listbox"]')].find(visible);
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
      surfaceStatus: snapshot.surfaceStatus || null,
      path: snapshot.path || null,
      provenanceConfirmed: snapshot.provenanceConfirmed === true,
      chipUuidConfirmed: snapshot.chipUuidConfirmed === true,
      menuRelatedToTile: snapshot.menuRelatedToTile === true,
      menuNearTrigger: snapshot.menuNearTrigger === true,
      cleanup: snapshot.cleanup || null,
      updatedAt: snapshot.updatedAt,
      lastResult: snapshot.lastResult ? Object.fromEntries(Object.entries(snapshot.lastResult).filter(([key, value]) => ["count", "exactMatch", "selected", "confirmed", "reused", "slot", "chipUuidConfirmed", "provenanceConfirmed"].includes(key) && (typeof value === "boolean" || typeof value === "number" || key === "slot"))) : null,
    };
  }
  const addToPromptLabels = new Set(["add to prompt", "thêm vào câu lệnh", "thêm vào lời nhắc", "thêm vào lời nhắc văn bản", "thêm vào prompt"]);
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const exactTileTitle = (tile, name) => normalize(tile?.getAttribute?.("aria-label") || tile?.getAttribute?.("title")) === normalize(name);
  function contextMenuItems(menu) {
    return [...menu.querySelectorAll('[role="menuitem"],button,[role="button"]')].filter(visible);
  }
  function contextMenuItemLabel(item) {
    return normalize(accessibleName(item) || item.getAttribute?.("aria-label") || item.getAttribute?.("title") || item.innerText || item.textContent);
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
  function chipMediaUuids(chip) {
    const attrs = ["data-media-id", "data-asset-id", "data-file-id"];
    const nodes = [chip.element, chip.element?.querySelector?.("img"), ...(chip.element?.querySelectorAll?.("[data-media-id],[data-asset-id],[data-file-id]") || [])].filter(Boolean);
    return [...new Set(nodes.flatMap(node => attrs.map(attr => node.getAttribute?.(attr)).filter(value => uuidPattern.test(String(value || ""))).map(value => String(value).toLowerCase())))];
  }
  async function closeOwnedContextMenu(menu, deadline) {
    if (!menu || !visible(menu)) return { closed: true, method: "already_closed" };
    const close = contextMenuItems(menu).filter(item => ["close", "dismiss", "đóng"].includes(contextMenuItemLabel(item)) && !item.disabled && item.getAttribute("aria-disabled") !== "true");
    if (close.length === 1) {
      close[0].click();
    } else {
      return { closed: false, method: "cleanup_pending_no_owned_close_affordance" };
    }
    const until = Math.min(Date.now() + 700, deadline);
    while (Date.now() < until && visible(menu)) await boundedWait(50, until, "closing the owned reference menu", false);
    return { closed: !visible(menu), method: "owned_close_action" };
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
      const expectedUuid = (await resolveNativeMediaUuid(expectedId, "image"))?.toLowerCase();
      if (!expectedUuid) throw flowError("FLOW_ASSET_ID_UNAVAILABLE", "The uploaded image has no verified media UUID for tile attachment. No reference was selected.", false, false);
      const attached = chips().find(chip => normalize(chip.name) === normalize(ref.name) && chip.kind === "image");
      if (attached) {
        if (attached.mediaId !== expectedUuid) throw flowError("FLOW_ASSET_ID_MISMATCH", "An image reference with this title is already attached, but its verified media provenance differs from the requested upload.", false, false);
        updateReferenceActionDiagnostics({ ...diagnostic, step: "serialized_existing_chip_reused", provenanceConfirmed: true, chipUuidConfirmed: attached.chipUuidConfirmed === true });
        return { name: ref.name, kind: "image", source: attached.source, id: expectedUuid, idSource: attached.mediaIdSource || "verified_tile_action_provenance", chipUuidConfirmed: attached.chipUuidConfirmed === true, confirmed: true, reused: true };
      }
      const alreadyOpen = [...((typeof root.flowQueryAll === "function" ? root.flowQueryAll("components.actionMenus", document) : null) || document.querySelectorAll('[role="menu"],mat-menu-panel'))].filter(visible);
      if (alreadyOpen.length) throw flowError("FLOW_REFERENCE_CONTEXT_MENU_BUSY", "Flow already has a menu open; no reference menu action was attempted.", false, false);
      const tile = await root.findFlowTile?.(ref.name);
      if (!tile || !exactTileTitle(tile, ref.name)) {
        updateReferenceActionDiagnostics({ ...diagnostic, step: "tile_missing_picker_fallback", tileActionStep: "menu_missing", surfaceStatus: "tile_missing" });
        return null;
      }
      const verifyTile = async () => {
        const current = (await resolveNativeMediaUuid(mediaId(tile), "image"))?.toLowerCase();
        const hasVideo = typeof root.flowQuery === "function" ? root.flowQuery("tiles.video", tile, { checkVisible: false }) : tile.querySelector("flow-video-tile,flow-scene-tile");
        return tile.isConnected && exactTileTitle(tile, ref.name) && current === expectedUuid && !hasVideo;
      };
      if (!(await verifyTile())) throw flowError("FLOW_ASSET_ID_MISMATCH", "The exact image tile does not match the completed upload UUID and image type. No reference was selected.", false, false);
      const sameTitle = [...((typeof root.flowQueryAll === "function" ? root.flowQueryAll("tiles.container", document, { checkVisible: false }) : null) || document.querySelectorAll("flow-grid-tile-container"))].filter(candidate => exactTileTitle(candidate, ref.name));
      if (sameTitle.length !== 1 || sameTitle[0] !== tile) throw flowError("FLOW_ASSET_AMBIGUOUS", "Flow does not expose one unique exact-title image tile. No reference was selected.", false, false);
      tile.scrollIntoView?.({ behavior: "instant", block: "center" });
      await boundedWait(100, deadline, "settling the exact uploaded image tile", false, signal);
      if (!(await verifyTile())) throw flowError("FLOW_ASSET_CHANGED", "The uploaded image tile changed before its context menu opened. No reference was selected.", false, false);
      const target = (typeof root.flowQuery === "function" ? root.flowQuery("tiles.image", tile, { checkVisible: false }) : null) || tile.querySelector("img,[role='img']") || tile;
      const rect = target.getBoundingClientRect?.() || { left: 0, top: 0, width: 1, height: 1 };
      const contextPoint = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      const priorMenus = new Set((typeof root.flowQueryAll === "function" ? root.flowQueryAll("components.actionMenus", document, { checkVisible: false }) : null) || document.querySelectorAll('[role="menu"],mat-menu-panel'));
      target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: contextPoint.x, clientY: contextPoint.y, button: 2 }));
      diagnostic = { ...diagnostic, step: "waiting_for_new_menu" };
      updateReferenceActionDiagnostics(diagnostic);
      const menuDeadline = Math.min(Date.now() + 2200, deadline);
      let newMenus = [];
      while (Date.now() < menuDeadline) {
        newMenus = [...((typeof root.flowQueryAll === "function" ? root.flowQueryAll("components.actionMenus", document) : null) || document.querySelectorAll('[role="menu"],mat-menu-panel'))].filter(menu => visible(menu) && !priorMenus.has(menu));
        if (newMenus.length) break;
        try { await boundedWait(100, menuDeadline, "waiting for the uploaded image context menu", false, signal); }
        catch (error) {
          if (error?.code === "FLOW_OPERATION_TIMEOUT" && Date.now() >= menuDeadline) break;
          throw error;
        }
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
      updateReferenceActionDiagnostics({ ...diagnostic, step: "validating_menu_ownership", ...(related && nearTrigger ? { tileActionStep: "menu_owned" } : {}), menuRelatedToTile: related, menuNearTrigger: nearTrigger });
      if (!related) throw flowError("FLOW_REFERENCE_CONTEXT_MENU_UNOWNED", "Flow opened a menu, but its DOM does not link it to the selected image tile. No menu action was taken.", false, false);
      if (!nearTrigger) throw flowError("FLOW_REFERENCE_CONTEXT_MENU_POSITION_UNVERIFIED", "Flow's new menu is outside the bounded position of the selected image. No menu action was taken.", false, false);
      ownedMenu = candidateMenu;
      const actions = contextMenuItems(ownedMenu).filter(item => addToPromptLabels.has(contextMenuItemLabel(item)));
      if (actions.length !== 1 || actions[0].disabled || actions[0].getAttribute("aria-disabled") === "true") {
        updateReferenceActionDiagnostics({ ...diagnostic, step: "add_action_ambiguous", surfaceStatus: "action_ambiguous" });
        throw flowError("FLOW_REFERENCE_CONTEXT_ACTION_AMBIGUOUS", "The new image menu does not expose one enabled exact Add to prompt action. No reference was selected.", false, false);
      }
      if (!(await verifyTile())) throw flowError("FLOW_ASSET_ID_MISMATCH", "The uploaded image tile identity changed before Add to prompt. No reference was selected.", false, false);
      if (!ownedMenu.isConnected || !visible(ownedMenu) || !hasExactContextMenuRelation(ownedMenu, target, tile) || !contextMenuNearTrigger(ownedMenu, contextPoint)) {
        throw flowError("FLOW_REFERENCE_CONTEXT_MENU_OWNERSHIP_LOST", "Flow's reference menu lost its exact tile relation or position before selection. No menu action was taken.", false, false);
      }
      const currentActions = contextMenuItems(ownedMenu).filter(item => addToPromptLabels.has(contextMenuItemLabel(item)));
      if (currentActions.length !== 1 || currentActions[0] !== actions[0] || currentActions[0].disabled || currentActions[0].getAttribute("aria-disabled") === "true") {
        throw flowError("FLOW_REFERENCE_CONTEXT_ACTION_CHANGED", "The unique Add to prompt action changed before selection. No menu action was taken.", false, false);
      }
      const before = chips();
      updateReferenceActionDiagnostics({ ...diagnostic, step: "clicking_exact_add_action", tileActionStep: "action_clicked", surfaceStatus: "unique_new_menu_and_action" });
      actions[0].click();
      const attachDeadline = Math.min(Date.now() + 10_000, deadline);
      while (Date.now() < attachDeadline) {
        const added = chips().filter(chip => !before.some(old => old.element === chip.element));
        if (added.length > 1 || added.some(chip => chip.kind !== "image")) throw flowError("FLOW_REFERENCE_ATTACH_AMBIGUOUS", "Flow added an unexpected number or type of reference chips. Inspect the composer before retrying.", false, true);
        if (added.length === 1) {
          const observedUuids = chipMediaUuids(added[0]);
          if (observedUuids.some(id => id !== expectedUuid)) throw flowError("FLOW_ASSET_ID_MISMATCH", "The new image chip exposes a UUID that conflicts with the selected upload. Inspect the composer before retrying.", false, true);
          // This records the verified tile/action provenance. chipUuidConfirmed
          // remains false when Flow does not expose a UUID on the chip itself.
          metadata.set(added[0].element, { name: ref.name, mediaId: expectedUuid, mediaIdSource: "verified_tile_action_provenance", chipUuidConfirmed: observedUuids.includes(expectedUuid) });
          updateReferenceActionDiagnostics({ ...diagnostic, step: "exact_image_chip_confirmed", tileActionStep: "chip_confirmed", surfaceStatus: "attached", provenanceConfirmed: true, chipUuidConfirmed: observedUuids.includes(expectedUuid) });
          return { name: ref.name, kind: "image", source: added[0].source, id: expectedUuid, idSource: "verified_tile_action_provenance", chipUuidConfirmed: observedUuids.includes(expectedUuid), confirmed: true };
        }
        await boundedWait(150, attachDeadline, "confirming uploaded image reference", true, signal);
      }
      throw flowError("FLOW_REFERENCE_ATTACH_UNCONFIRMED", "Flow did not add exactly one image ingredient chip after Add to prompt. Inspect the composer before retrying.", false, true);
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
    "all": ["all", "tất cả", "tat ca"],
    "ingredients": ["ingredients", "thành phần", "nguyên liệu"],
    "uploads": ["uploads", "tải lên", "tai len"]
  };
  function pickerCategoryTabs(name) {
    const norm = normalize(name);
    const synonyms = CATEGORY_SYNONYMS[norm] || [norm];
    return [...new Set([
      ...document.querySelectorAll('[role="tab"]'),
      ...(norm === "voices" ? (picker()?.querySelectorAll('button,[role="button"]') || []) : []),
    ])].filter(el => {
      if (!visible(el)) return false;
      const label = normalize(accessibleName(el)).replace(/^(?:accessibility_new|dashboard|face|voice_selection|graphic_eq|record_voice_over)\s*/, "");
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
    if (!tab) throw flowError("FLOW_REFERENCE_CATEGORY_MISSING", `Flow's picker has no ${name} category.`, true);
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
    const hasComposer = (typeof root.flowQuery === "function" && root.flowQuery("editor")) || document.querySelector(".ProseMirror");
    if (!hasComposer) await ensureFlowLibrarySection("All media");
    const hasComposerAfter = (typeof root.flowQuery === "function" && root.flowQuery("editor")) || document.querySelector(".ProseMirror");
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
      categoriesScanned: [] });
    let operationError;
    try {
      requireTime(deadline, "attaching a Flow reference", false, config.signal);
      // Flow excludes already attached characters from its picker. Check our
      // confirmed provenance first, before requiring the option to exist again.
      const reusable = chips().find(chip => normalize(chip.name) === normalize(ref.name) && (!ref.kind || chip.kind === ref.kind));
      if (reusable) {
        const reusableId = reusable.kind === "character"
          ? explicitCharacterUuid(reusable.element) || (reusable.mediaIdSource === "character_identity_attribute" && characterUuidPattern.test(String(reusable.mediaId || "")) ? String(reusable.mediaId).toLowerCase() : undefined)
          : reusable.mediaId;
        if (reusable.kind === "character" && !reusableId) {
          throw flowError("FLOW_CHARACTER_ID_UNAVAILABLE", `Flow did not expose an explicit character identity for "${ref.name}". No selection or generation was submitted.`, false, false);
        }
        if (config.expectedId && reusableId !== config.expectedId) {
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
      if (!slot && ref.kind !== "character" && config.expectedId) {
        const uploadsTabs = pickerCategoryTabs("uploads");
        if (uploadsTabs.length > 1) throw flowError("FLOW_REFERENCE_CATEGORY_AMBIGUOUS", "Flow's Uploads picker category is ambiguous; no category was selected.", false, false);
        if (uploadsTabs.length === 1) scanCategories.push("uploads");
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
      option.click();
      // Character options attach immediately; images may require Add to prompt.
      let confirmedClick = false;
      const attachDeadline = Math.min(Date.now() + 10000, deadline);
      while (Date.now() < attachDeadline) {
        const added = chips().filter(chip => !before.some(old => old.element === chip.element));
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
        const add = (picker() && flowButton("Add to prompt", picker().closest('[role="dialog"]') || picker())) || flowButton("Add to prompt");
        if (!confirmedClick && add && !add.disabled && picker()) { add.click(); confirmedClick = true; }
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
  function voiceChipNodes(composer) {
    if (!composer) return [];
    const configured = typeof root.flowQueryAll === "function" ? root.flowQueryAll("components.voiceChip", composer) : [];
    const candidates = [...new Set([
      ...configured,
      ...composer.querySelectorAll('[data-ingredient-type="voice"],[data-kind="voice"],[class*="voice-chip" i],button[aria-label*="voice" i],button[aria-label*="giọng" i]'),
    ])];
    return candidates.filter(node => {
      if (!visible(node)) return false;
      const label = normalize(accessibleName(node) || node.getAttribute?.("aria-label") || node.getAttribute?.("title") || node.innerText || node.textContent);
      return /voice|giọng/.test(label) || /voice-chip|ingredient-voice/i.test(String(node.className?.baseVal || node.className || ""));
    });
  }
  const voiceChipLabel = chip => normalize(accessibleName(chip) || chip.getAttribute?.("aria-label") || chip.getAttribute?.("title") || chip.innerText || chip.textContent)
    .replace(/^(?:voice|giọng nói|giọng)\s*[:\-]\s*/, "")
    .replace(/\s+(?:remove|delete|clear|close|xóa|gỡ)(?:\s+(?:voice|giọng nói|giọng))?$/, "")
    .trim();
  async function selectNativeFlowVoice(name, config = {}) {
    const wanted = String(name || "").replace(/\s+/g, " ").trim();
    if (!wanted || wanted.length > 120) throw flowError("FLOW_INVALID_ARGUMENT", "An exact Flow voice name is required.", false, false);
    const deadline = config.deadline || makeDeadline(config.command, 20_000, 4_000);
    const composer = (typeof root.flowQuery === "function" ? root.flowQuery("composerRoot") : null) || flowComposerForUpload();
    if (!composer) throw flowError("FLOW_VOICE_COMPOSER_MISSING", "Flow's composer could not be identified; no voice was selected.", false, false);
    const oldChips = voiceChipNodes(composer);
    for (const chip of oldChips) {
      requireTime(deadline, "replacing the selected Flow voice", false, config.signal);
      const configuredRemovers = typeof root.flowQueryAll === "function" ? root.flowQueryAll("components.voiceRemoveButton", chip) : [];
      const controls = [...new Set([...configuredRemovers, ...chip.querySelectorAll('button,[role="button"]')])].filter(visible);
      const remove = controls.find(control => /(?:remove|delete|clear|close|xóa|gỡ)/i.test(normalize(accessibleName(control) || control.getAttribute?.("aria-label") || control.getAttribute?.("title"))));
      if (!remove || remove.disabled || remove.getAttribute("aria-disabled") === "true") {
        throw flowError("FLOW_VOICE_REMOVE_UNAVAILABLE", "An existing Flow voice chip has no verified remove control; no new voice was selected.", false, false);
      }
      const before = voiceChipNodes(composer).length;
      remove.click();
      const until = Math.min(Date.now() + 1500, deadline);
      while (Date.now() < until && voiceChipNodes(composer).length >= before) await boundedWait(100, deadline, "confirming the previous Flow voice was removed", false, config.signal);
      if (voiceChipNodes(composer).length >= before) throw flowError("FLOW_VOICE_REMOVE_UNCONFIRMED", "Flow did not confirm removal of the previous voice chip; no new voice was selected.", false, false);
    }

    let operationError;
    try {
      await open(undefined, deadline, config.signal);
      await category("voices", deadline, config.signal);
      const option = exactOption(options(), wanted, false);
      if (!option) throw flowError("FLOW_VOICE_NOT_FOUND", "The requested Flow voice was not available in the voice picker; no voice was selected.", false, false);
      const before = voiceChipNodes(composer);
      option.click();
      let applyClicked = false;
      const verifyUntil = Math.min(Date.now() + 5000, deadline);
      while (Date.now() < verifyUntil) {
        const matching = voiceChipNodes(composer).filter(chip => voiceChipLabel(chip) === normalize(wanted));
        if (matching.length === 1) return { selected: true, confirmed: true };
        if (matching.length > 1) throw flowError("FLOW_VOICE_SELECTION_AMBIGUOUS", "Flow showed multiple matching voice chips; inspect the composer before submitting.", false, false);
        const pickerRoot = picker()?.closest('[role="dialog"]') || picker();
        const apply = pickerRoot && (flowButton("Add to prompt", pickerRoot) || flowButton("Thêm vào câu lệnh", pickerRoot));
        if (!applyClicked && apply && !apply.disabled && apply.getAttribute("aria-disabled") !== "true") { apply.click(); applyClicked = true; }
        await boundedWait(100, deadline, "confirming the selected Flow voice", true, config.signal);
      }
      throw flowError("FLOW_VOICE_SELECTION_UNCONFIRMED", "Flow did not confirm the requested voice chip; no generation was submitted.", false, false);
    } catch (error) {
      operationError = error;
      throw error;
    } finally {
      if (picker()) {
        try { await closeAfterOperation(deadline, config.signal, operationError); }
        catch (cleanupError) { if (!operationError) throw cleanupError; }
      }
    }
  }
  async function listNativeFlowVoiceOptions(config = {}) {
    const deadline = config.deadline || makeDeadline(config.command, 25_000, 5_000);
    const wasOpen = Boolean(picker());
    let ownsPicker = false;
    let operationError;
    try {
      if (wasOpen) {
        const tab = findPickerCategoryTab("voices");
        if (!tab || tab.getAttribute("aria-selected") !== "true") {
          throw flowError("FLOW_VOICE_PICKER_ALREADY_OPEN", "Flow already has a different picker open; it was left unchanged.", false, false);
        }
      } else {
        await open(undefined, deadline, config.signal);
        ownsPicker = true;
        await category("voices", deadline, config.signal);
      }
      const list = picker();
      if (!list) throw flowError("FLOW_VOICE_PICKER_UNAVAILABLE", "Flow's voice picker list was not available.", false, false);
      const labels = [];
      const seen = new Set();
      let stableAtBottom = 0;
      let completed = false;
      let scanReason = "step_limit";
      let scrollMoves = 0;
      let optionCount = 0;
      let steps = 0;
      for (let step = 0; step < 60 && labels.length < 250; step++) {
        steps++;
        requireTime(deadline, "reading Flow voice options", false, config.signal);
        const currentList = picker();
        if (!currentList) throw flowError("FLOW_VOICE_PICKER_CLOSED", "Flow's voice picker closed during inspection; the result is incomplete.", false, false);
        const currentOptions = options();
        optionCount = Math.max(optionCount, currentOptions.length);
        for (const option of currentOptions) {
          const rawLabel = accessibleName(option) || option.getAttribute?.("aria-label") || option.getAttribute?.("title") || option.innerText || option.textContent || "";
          const label = String(rawLabel).replace(/\s+/g, " ").trim();
          if (!label) throw flowError("FLOW_VOICE_LABEL_UNAVAILABLE", "A visible Flow voice option had no readable label; no partial list was returned.", false, false);
          const key = normalize(label);
          if (seen.has(key)) continue;
          seen.add(key);
          labels.push(label);
        }
        // Flow's role=listbox often wraps a separate virtual-scroll viewport.
        // Scroll the actual overflowing descendant, not the listbox shell.
        const scroller = [currentList, ...currentList.querySelectorAll("*")]
          .find(element => Number(element.clientHeight) > 0 && Number(element.scrollHeight) > Number(element.clientHeight) + 2);
        if (!scroller) {
          scanReason = "no_scroll_container";
          stableAtBottom++;
          if (stableAtBottom >= 2) { completed = true; break; }
        } else {
          const top = Number(scroller.scrollTop) || 0;
          const height = Number(scroller.clientHeight) || 0;
          const scrollHeight = Number(scroller.scrollHeight) || 0;
          if (top + height >= scrollHeight - 2) {
            scanReason = "bottom_reached";
            stableAtBottom++;
            if (stableAtBottom >= 2) { completed = true; break; }
            await boundedWait(180, deadline, "confirming the end of Flow voice options", false, config.signal);
            continue;
          }
          stableAtBottom = 0;
          const nextTop = Math.min(scrollHeight - height, top + Math.max(240, height * 0.8));
          scroller.scrollTop = nextTop;
          await boundedWait(180, deadline, "loading the next Flow voice options", false, config.signal);
          if ((Number(scroller.scrollTop) || 0) <= top) {
            scanReason = "scroll_no_progress";
            break;
          }
          scrollMoves++;
        }
      }
      if (!completed) {
        const reason = labels.length >= 250 ? "option_limit" : scanReason;
        const error = flowError(
          reason === "scroll_no_progress" ? "FLOW_VOICE_SCAN_NO_PROGRESS" : reason === "option_limit" ? "FLOW_VOICE_OPTIONS_LIMIT" : "FLOW_VOICE_SCAN_INCOMPLETE",
          reason === "scroll_no_progress"
            ? "Flow's voice options stopped scrolling before the list end; no partial list was returned."
            : reason === "option_limit"
              ? "Flow's voice picker exceeded the bounded 250-option scan; no partial list was returned."
              : "Flow's voice options could not be enumerated completely within the bounded scan; no partial list was returned.",
          false, false,
        );
        // Counts and fixed reason codes are safe to log; option names and DOM text are intentionally omitted.
        error.diagnostics = { reason, steps, labelsRead: labels.length, visibleOptions: optionCount, scrollMoves };
        throw error;
      }
      if (labels.length >= 250) throw flowError("FLOW_VOICE_OPTIONS_LIMIT", "Flow's voice picker exceeded the bounded 250-option scan; no partial list was returned.", false, false);
      return { voices: labels, count: labels.length, source: "flow_v2_picker", readOnly: true };
    } catch (error) {
      operationError = error;
      throw error;
    } finally {
      if (ownsPicker && picker()) {
        try { await closeAfterOperation(deadline, config.signal, operationError); }
        catch (cleanupError) { if (!operationError) throw cleanupError; }
      }
    }
  }
  globalThis.FlowReferenceActions = Object.freeze({ attach, listCharacters, chips, parse, exactOption, closePicker, inspectPicker, inspectDiagnostics: inspectReferenceActionDiagnostics });
  globalThis.selectNativeFlowVoice = selectNativeFlowVoice;
  globalThis.listNativeFlowVoiceOptions = listNativeFlowVoiceOptions;
  globalThis.listOptions = listOptions;
})();
var root = typeof globalThis !== "undefined" ? globalThis : (typeof window !== "undefined" ? window : self);
var nativeUploadAssemblers = new Map();
var stagedNativeFiles = new Map();

function listOptions(list, checkVis = true) {
  if (!list) return [];
  if (typeof root.flowQueryAll === "function") {
    const results = root.flowQueryAll("components.optionItem", list, { checkVisible: checkVis });
    if (results && results.length) return results;
  }
  const raw = [...(list.querySelectorAll?.('[role="option"]') || [])];
  const isVis = typeof visible === "function" ? visible : (typeof root.visible === "function" ? root.visible : (() => true));
  return checkVis ? raw.filter(isVis) : raw;
}

function validStagedLocalImage(value, suffixPattern) {
  return Boolean(value && typeof value.transferId === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value.transferId) && stagedNativeFiles.has(value.transferId) &&
    typeof value.name === "string" && new RegExp(`^fm-[A-Za-z0-9_-]{1,32}-${suffixPattern.source}\\.(?:png|jpe?g|webp|gif|heic|heif|avif)$`, "i").test(value.name));
}

function flowComposerForUpload() {
  const editor = (typeof flowQuery === "function" ? flowQuery("editor") : null) ||
    document.querySelector(".ProseMirror[contenteditable='true']");
  const submit = globalThis.FlowEditor?.getFlowSubmitButton?.() || globalThis.getFlowSubmitButton?.();
  if (!editor || !submit) return null;
  // Flow V2 may put the editable prompt in a nested composer child while the
  // plus/submit controls live in a sibling toolbar. Use the lowest shared
  // composer ancestor that contains both; an editor-only wrapper hides the
  // actual Upload trigger and was the source of the preselection failure.
  for (let node = editor.parentElement, depth = 0; node && node !== document.body && depth < 12; node = node.parentElement, depth++) {
    if (node.contains(submit) && /composer|prompt|form/i.test(`${node.tagName} ${String(node.className?.baseVal || node.className || "")}`)) return node;
  }
  const configured = (typeof flowQuery === "function" ? flowQuery("composerRoot") : null);
  if (configured?.contains(editor) && configured.contains(submit)) return configured;
  // As a last semantic scope, retain only the lowest common ancestor of the
  // prompt editor and Flow's recognized submit button, never document-wide DOM.
  for (let node = editor.parentElement, depth = 0; node && node !== document.body && depth < 12; node = node.parentElement, depth++) {
    if (node.contains(submit)) return node;
  }
  return null;
}

function uploadControlDiagnostics(composer = flowComposerForUpload()) {
  const scope = composer || document;
  return [...scope.querySelectorAll('button,[role="button"],mat-button,[tabindex="0"]')]
    .filter(visible).slice(0, 30).map(el => ({
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role"),
      aria: accessibleName(el).replace(/\s+/g, " ").trim().slice(0, 80),
      title: (el.getAttribute("title") || "").slice(0, 80),
      text: String(el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80),
      ariaPressed: el.getAttribute("aria-pressed"),
      ariaSelected: el.getAttribute("aria-selected"),
      dataState: el.getAttribute("data-state"),
      checked: typeof el.checked === "boolean" ? el.checked : null,
      disabled: Boolean(el.disabled || el.getAttribute("aria-disabled") === "true"),
      icon: el.querySelector("mat-icon,.mat-icon,.google-symbols,.material-symbols-outlined,svg")?.textContent?.trim().slice(0, 40) || "",
      className: String(el.className?.baseVal || el.className || "").slice(0, 100),
    }));
}

function findAddMediaButton() {
  const composer = flowComposerForUpload();
  if (!composer) return null;
  const sharedResolver = flowButton("Add ingredients to the prompt box", composer);
  if (sharedResolver && composer.contains(sharedResolver)) return sharedResolver;
  const candidates = [...composer.querySelectorAll('button,[role="button"],mat-button,[tabindex="0"]')]
    .filter(visible);
  const names = new Set([
    "add media menu", "add media", "add to prompt", "add to prompt box", "add component",
    "add ingredients to the prompt box", "add ingredient", "add content", "add", "+",
    "thêm nội dung nghe nhìn", "thêm tệp", "thêm vào lời nhắc", "thêm thành phần",
    "thêm thành phần vào hộp lời nhắc", "thêm thành phần vào hộp câu lệnh", "thêm vào hộp lời nhắc",
    "thêm phương tiện", "thêm ảnh", "thêm video", "thêm hình ảnh", "thêm",
  ]);
  const clean = value => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  const labelOf = el => [accessibleName(el), el.getAttribute("aria-label"), el.getAttribute("title"), el.innerText, el.textContent]
    .map(clean).filter(Boolean);
  // This is TobyFlow's configured V2 trigger name. Since the search is already
  // restricted to the lowest shared composer ancestor, accept the exact named
  // button even if broader page-navigation heuristics classify its wrapper.
  const exact = candidates.find(el => labelOf(el).some(label => {
    if (names.has(label)) return true;
    const norm = typeof normalizeFlowUiText === "function" ? normalizeFlowUiText(label) : label;
    for (const name of names) {
      if ((typeof normalizeFlowUiText === "function" ? normalizeFlowUiText(name) : name) === norm) return true;
    }
    return false;
  }));
  if (exact) return exact;
  const addIcons = new Set(["add", "add_circle", "add_2", "add_circle_outline", "add_box", "add_rounded"]);
  const iconCandidates = candidates.filter(el => {
    if (isFlowProjectNavigationControl(el)) return false;
    const icon = clean(el.querySelector("mat-icon,.mat-icon,.google-symbols,.material-symbols-outlined,svg")?.textContent);
    return addIcons.has(icon);
  });
  // The composer add-menu trigger sits immediately before Submit in the V2
  // layout. Use that relation only as a tie-breaker among exact add ligatures.
  const submit = globalThis.FlowEditor?.getFlowSubmitButton?.();
  const adjacent = submit?.previousElementSibling;
  return adjacent && candidates.includes(adjacent) && iconCandidates.includes(adjacent) ? adjacent : iconCandidates[0] || null;
}

function inspectFlowUploadTrigger() {
  const composer = flowComposerForUpload();
  const editor = (typeof flowQuery === "function" ? flowQuery("editor") : null) || document.querySelector(".ProseMirror[contenteditable='true']");
  const submit = globalThis.FlowEditor?.getFlowSubmitButton?.() || globalThis.getFlowSubmitButton?.();
  const describe = element => element ? ({
    tag: element.tagName?.toLowerCase() || null,
    aria: accessibleName(element).replace(/\s+/g, " ").trim().slice(0, 100),
    text: String(element.innerText || element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 100),
    icon: element.querySelector("mat-icon,.mat-icon,.google-symbols,.material-symbols-outlined,svg")?.textContent?.trim().slice(0, 40) || "",
    className: String(element.className?.baseVal || element.className || "").slice(0, 120),
    disabled: Boolean(element.disabled || element.getAttribute("aria-disabled") === "true"),
    connected: element.isConnected === true,
  }) : null;
  const direct = composer ? flowButton("Add ingredients to the prompt box", composer) : null;
  const resolved = findAddMediaButton();
  return {
    bundle: "flow-components-upload-trigger-diag-20261021a",
    composer: describe(composer),
    containsEditor: Boolean(composer && editor && composer.contains(editor)),
    containsSubmit: Boolean(composer && submit && composer.contains(submit)),
    promptDiagnostics: editor ? {
      contentEditable: editor.isContentEditable === true,
      characterCount: String(globalThis.FlowEditor?.getEditorUserText?.(editor) || "").length,
      chipCount: globalThis.FlowEditor?.countInlineChips?.(editor) ?? null,
    } : null,
    directResolver: describe(direct),
    componentResolver: describe(resolved),
    visibleComposerControls: uploadControlDiagnostics(composer),
  };
}

async function ensureAddMediaButton(deadline = Date.now() + 10_000, signal) {
  const requireTime = operation => globalThis.FlowUiDeadline?.requireTime(deadline, operation, false, signal);
  const boundedWait = (ms, operation) => globalThis.FlowUiDeadline?.boundedWait(ms, deadline, operation, false, signal);
  requireTime("finding Flow's upload control");
  let button = findAddMediaButton();
  if (button) return button;

  // TobyFlow only leaves Video Frames when the V2 '+' control is absent. Do
  // the same guarded transition: inspect the selected mode, switch only from
  // Frames, confirm Ingredients, close settings, then reacquire the trigger.
  const settings = globalThis.FlowSettings;
  const settingsTrigger = flowButton("Settings trigger", flowComposerForUpload() || document);
  if (settingsTrigger && settings) {
    await settings.openFlowSettings({ deadline, signal });
    requireTime("inspecting Flow's current video mode");
    const framesOption = settings.flowRadio("Frames");
    const framesSelected = settings.nativeRadioSelected(framesOption) ||
      framesOption?.getAttribute("aria-selected") === "true" || framesOption?.getAttribute("data-state") === "active";
    if (framesSelected) {
      await settings.chooseRadio("Ingredients", { deadline, signal });
      const ingredients = settings.flowRadio("Ingredients");
      if (!settings.nativeRadioSelected(ingredients) && ingredients?.getAttribute("aria-selected") !== "true" && ingredients?.getAttribute("data-state") !== "active") {
        throw flowError("FLOW_UPLOAD_MODE_SWITCH_UNCONFIRMED", "Flow did not confirm Ingredients mode; no file was selected.", true, false);
      }
    }
    await settings.closeFlowSettings({ deadline, signal });
    const triggerDeadline = Math.min(Date.now() + 2500, deadline);
    while (Date.now() < triggerDeadline && !(button = findAddMediaButton())) await boundedWait(80, "waiting for Flow's composer Upload control");
  }
  return button;
}

function cleanFlowMediaCandidateName(str) {
  if (!str) return "";
  let clean = String(str).replace(/\s+/g, " ").trim().toLowerCase();
  // Strip tiền tố ở đầu (prefix): "hình ảnh ", "ảnh ", "video ", "nội dung nghe nhìn ", "tệp ", "nhân vật ", "image ", "media "
  clean = clean.replace(/^(?:h\u00ECnh\s+\u1EA3nh|\u1EA3nh|video|n\u1ED9i\s+dung(?:\s+nghe\s+nh\u00ECn)?|t\u1EC7p|nh\u00E2n\s+v\u1EADt|image|media)\s+/i, "");
  // Strip hậu tố ở cuối (suffix): " hình ảnh", " ảnh", " video", " nhân vật", " avatar", " nội dung nghe nhìn", " image"
  clean = clean.replace(/\s+(?:h\u00ECnh\s+\u1EA3nh|\u1EA3nh|video|nh\u00E2n\s+v\u1EADt|avatar|n\u1ED9i\s+dung(?:\s+nghe\s+nh\u00ECn)?|image)$/i, "");
  return clean.trim();
}

function matchesFlowTile(tile, assetName) {
  if (!tile || !assetName) return false;
  const norm = s => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
  const full = norm(assetName);
  const stem = norm(assetName.replace(/\.(?:png|jpe?g|webp|gif|heic|heif|avif|mp4|m4v|mov|webm|avi|mkv|3gp)$/i, ""));

  const label = norm(tile.getAttribute("aria-label"));
  const title = norm(tile.getAttribute("title"));
  const dataName = norm(tile.getAttribute("data-tile-name"));
  const imgAlt = norm(tile.querySelector("img")?.getAttribute("alt"));
  const imgAria = norm(tile.querySelector("img")?.getAttribute("aria-label"));
  const text = norm(tile.innerText || tile.textContent);

  const candidates = [label, title, dataName, imgAlt, imgAria, text].filter(Boolean);
  return candidates.some(candidate => {
    const rawClean = cleanFlowMediaCandidateName(candidate);
    if (rawClean === full || rawClean === stem) return true;
    const normClean = typeof normalizeFlowUiText === "function" ? normalizeFlowUiText(rawClean) : rawClean;
    const normFull = typeof normalizeFlowUiText === "function" ? normalizeFlowUiText(full) : full;
    const normStem = typeof normalizeFlowUiText === "function" ? normalizeFlowUiText(stem) : stem;
    return Boolean(normClean && (normClean === normFull || normClean === normStem));
  });
}

function normalizeFlowUploadName(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function flowUploadNameMatches(value, assetName) {
  if (!value || !assetName) return false;
  const name = cleanFlowMediaCandidateName(normalizeFlowUploadName(value));
  const full = normalizeFlowUploadName(assetName);
  const stem = normalizeFlowUploadName(String(assetName || "").replace(/\.(?:png|jpe?g|webp|gif|heic|heif|avif|mp4|m4v|mov|webm|avi|mkv|3gp)$/i, ""));
  if (name && (name === full || name === stem)) return true;
  const normName = typeof normalizeFlowUiText === "function" ? normalizeFlowUiText(name) : name;
  const normFull = typeof normalizeFlowUiText === "function" ? normalizeFlowUiText(full) : full;
  const normStem = typeof normalizeFlowUiText === "function" ? normalizeFlowUiText(stem) : stem;
  return Boolean(normName && (normName === normFull || normName === normStem));
}

function flowUploadTileKind(tile) {
  if (!tile) return null;
  if (tile.querySelector("flow-scene-tile")) return "scene";
  if (tile.querySelector("flow-video-tile,video")) return "video";
  if (tile.querySelector("flow-image-tile,img")) return "image";
  return null;
}

function flowUploadKindMatches(expectedKind, actualKind) {
  return expectedKind === "video" ? actualKind === "video" || actualKind === "scene" : actualKind === expectedKind;
}

function resolveUniqueUploadTarget(candidates, code, actionLabel) {
  if (candidates.length > 1) throw flowError(code, `Flow shows multiple matching ${actionLabel} controls. No control was selected.`, false, false);
  return candidates[0] || null;
}

function assertReusableFlowUploadKind(tile, assetName, expectedKind) {
  const actualKind = flowUploadTileKind(tile);
  if (actualKind && !flowUploadKindMatches(expectedKind, actualKind)) {
    throw flowError("FLOW_UPLOAD_KIND_MISMATCH", `Flow already has a ${actualKind} tile named "${assetName}", not the requested ${expectedKind}. No upload was started.`, false, false);
  }
  return actualKind;
}

function flowUploadTileNames(tile) {
  if (!tile) return [];
  return [tile.getAttribute("aria-label"), tile.getAttribute("title"), tile.getAttribute("data-tile-name"),
    tile.querySelector("img")?.getAttribute("alt"), tile.querySelector("img")?.getAttribute("aria-label")]
    .map(value => String(value || "").trim()).filter(Boolean);
}

function safeFlowPickerMethod(value) {
  return ["input-capture", "input.click", "showOpenFilePicker", "input-assign", "drop"].includes(value) ? value : "unknown";
}

function safeFlowPickerType(value) {
  const type = String(value || "").toLowerCase();
  return /^(?:image|video)\/[a-z0-9.+-]{1,80}$/.test(type) ? type : "unknown";
}

function inspectFlowUploadUiState() {
  const visibleElements = selector => [...document.querySelectorAll(selector)].filter(visible).slice(0, 100);
  const dialogs = visibleElements('[role="dialog"],mat-dialog-container').filter(el =>
    /video|upload/i.test(String(el.innerText || el.textContent || "").slice(0, 1200)));
  const progress = visibleElements('[role="progressbar"],[aria-busy="true"],mat-progress-bar,.mat-mdc-progress-bar,[data-state="loading"]');
  const errorTiles = visibleElements("flow-error-tile");
  const textErrors = visibleElements('[role="alert"],[aria-live="assertive"],.error,.warning,[data-testid*="error"]')
    .some(el => /upload|video|file/i.test(String(el.innerText || el.textContent || "").slice(0, 240)) &&
      /reject|unsupported|invalid|failed|error|too large|không hỗ trợ|không thể tải/i.test(String(el.innerText || el.textContent || "").slice(0, 240)));
  return {
    confirmationDialogVisible: dialogs.length > 0,
    visibleProgressIndicatorCount: progress.length,
    visibleErrorTileCount: errorTiles.length,
    visibleUploadRejection: Boolean(errorTiles.length || textErrors),
  };
}

async function waitForNativeMediaTile(assetName, command, kind, options = {}) {
  const deadline = Math.min(options.deadline || Infinity, Date.now() + (kind === "video" ? 60_000 : 90_000));
  const startedAt = Date.now();
  let nextLibraryScanAt = startedAt + 1_500;
  let libraryScans = 0;
  const maxLibraryScans = Number.isInteger(options.maxLibraryScans) ? Math.max(0, options.maxLibraryScans) : 3;
  const baselineIds = new Set((options.baselineIds || []).map(String));
  const requireNewOwner = options.requireNewOwner === true;
  let ownerId = options.ownerId ? String(options.ownerId) : null;
  let priorProgress = "";
  let lastScan = null;
  let lastScanErrorCode = null;
  let exactTileObserved = false;
  while (Date.now() < deadline) {
    const exactMatches = [...document.querySelectorAll("flow-grid-tile-container")]
      .filter(item => matchesFlowTile(item, assetName));
    if (exactMatches.length) exactTileObserved = true;
    if (exactMatches.length > 1) {
      throw flowError("FLOW_UPLOAD_TILE_AMBIGUOUS", `More than one Flow tile exactly matches uploaded ${kind} "${assetName}". Inspect the library before retrying.`, false, true);
    }
    const tile = exactMatches[0] || null;
    if (tile) {
      if (tile.querySelector("flow-error-tile")) {
        throw flowError("FLOW_UPLOAD_REJECTED", `Flow rejected uploaded ${kind} "${assetName}".`, false, true);
      }
      const media = kind === "video" ? tile.querySelector("video, img[data-media-id], flow-video-tile") : tile.querySelector("img[data-media-id], flow-image-tile img");
      const loadedImage = media instanceof HTMLImageElement && media.complete && media.naturalWidth > 0;
      const loadedVideo = media instanceof HTMLVideoElement && (media.readyState >= 1 || Boolean(media.currentSrc || media.src));
      const identity = mediaId(tile);
      const hasPersistentIdentity = identity && !identity.startsWith("title:");
      const isNewOwner = hasPersistentIdentity && !baselineIds.has(String(identity));
      const actualKind = flowUploadTileKind(tile);
      if (requireNewOwner && isNewOwner) {
        if (ownerId && ownerId !== String(identity)) {
          throw flowError("FLOW_UPLOAD_TILE_AMBIGUOUS", `A second new Flow media ID appeared while confirming uploaded ${kind} "${assetName}". Inspect the library before retrying.`, false, true);
        }
        ownerId = String(identity);
      }
      const identityMatchesOwner = !requireNewOwner || Boolean(ownerId && hasPersistentIdentity && String(identity) === ownerId && isNewOwner);
      const kindMatches = flowUploadKindMatches(kind, actualKind);
      const ready = globalThis.FlowTiles?.isTileMediaReady?.(tile) ?? !globalThis.isTileBusy?.(tile);
      if (requireNewOwner && hasPersistentIdentity && !isNewOwner) {
        // An exact title with a baseline ID is a pre-existing tile, not proof that
        // this upload created/attached a new media object.
      } else if (ready && kindMatches && identityMatchesOwner && hasPersistentIdentity && flowUploadTileNames(tile).some(name => flowUploadNameMatches(name, assetName))) {
        return { name: flowUploadTileNames(tile).find(name => flowUploadNameMatches(name, assetName)) || assetName, id: identity, kind };
      }
    }
    // Flow may accept an uploaded file into the project while its tile is outside
    // the currently mounted viewport. TobyFlow scans the full library for the
    // upload receipt; do the same bounded scan before reporting a false timeout.
    if (libraryScans < maxLibraryScans && Date.now() >= nextLibraryScanAt && globalThis.FlowMediaMenu?.scanNativeAssets) {
      libraryScans++;
      nextLibraryScanAt = Date.now() + 2_000;
      emitFlowProgress(command, `Upload confirmation scan ${libraryScans}/${maxLibraryScans}: baseline IDs ${baselineIds.size}, owner ${ownerId || "not latched"}`);
      try {
        const assets = await globalThis.FlowMediaMenu.scanNativeAssets({
          deadline: Math.min(deadline, Date.now() + 8_000),
          maxDurationMs: 8_000,
          exactName: assetName,
          kind,
          includeIncomplete: true,
          ...(requireNewOwner ? { baselineIds: [...baselineIds], ownerKind: kind } : {}),
          keepPositionOnMatch: true,
          onDiagnostics: diagnostics => {
            lastScan = { steps: Number(diagnostics.steps) || 0, uniqueTiles: Number(diagnostics.uniqueTiles) || 0,
              reachedEnd: diagnostics.reachedEnd === true, exactMatchCount: Number(diagnostics.exactMatchCount) || 0 };
            emitFlowProgress(command, `Upload confirmation scan ${libraryScans}: ${lastScan.uniqueTiles} unique tiles across ${lastScan.steps} pages; baseline ${baselineIds.size}, owner ${ownerId || "not latched"}`);
          },
        });
        const confirmedAssets = assets.filter(asset => flowUploadNameMatches(asset?.name, assetName) && asset?.id);
        if (confirmedAssets.length > 1) throw flowError("FLOW_UPLOAD_TILE_AMBIGUOUS", `More than one Flow library tile exactly matches uploaded ${kind} "${assetName}". Inspect the library before retrying.`, false, true);
        if (confirmedAssets.length === 1) {
          const asset = confirmedAssets[0];
          if (asset.error) throw flowError("FLOW_UPLOAD_REJECTED", `Flow rejected uploaded ${kind} "${assetName}".`, false, true);
          const isNewOwner = !requireNewOwner || (asset.newSinceBaseline === true && !baselineIds.has(String(asset.id)));
          if (requireNewOwner && !isNewOwner) {
            // Exact title was found, but its identity predates this upload baseline.
          } else {
            if (ownerId && ownerId !== String(asset.id)) throw flowError("FLOW_UPLOAD_TILE_AMBIGUOUS", `Flow reported a different new media ID while confirming "${assetName}". Inspect the library before retrying.`, false, true);
            ownerId = String(asset.id);
            const kindMatches = flowUploadKindMatches(kind, asset.kind);
            const kindUnknown = !asset.kind;
            if (!kindMatches && !kindUnknown) throw flowError("FLOW_UPLOAD_KIND_MISMATCH", `Flow's new media ID for "${assetName}" hydrated as ${asset.kind}, not ${kind}. Inspect it before retrying.`, false, true);
            if (kindMatches && asset.ready === true && asset.busy === false) return { name: asset.name, id: asset.id, kind };
          }
        }
      } catch (error) {
        lastScanErrorCode = typeof error?.code === "string" ? error.code : "SCAN_FAILED";
        if (["FLOW_UPLOAD_TILE_AMBIGUOUS", "FLOW_ASSET_AMBIGUOUS", "FLOW_UPLOAD_REJECTED", "FLOW_UPLOAD_KIND_MISMATCH"].includes(error?.code)) throw error;
        // A scan may end before Flow has hydrated the title/type. Repeat only
        // bounded scans inside this upload's existing deadline; never start a
        // second upload or claim success from partial metadata.
      }
    }
    const typeName = kind === "video" ? "video" : "image";
    const progress = tile ? `Flow is processing uploaded ${typeName} ${assetName}` : `Waiting for Flow to receive uploaded ${typeName} ${assetName}`;
    if (progress !== priorProgress) { emitFlowProgress(command, progress); priorProgress = progress; }
    try {
      if (globalThis.FlowUiDeadline?.boundedWait) {
        await globalThis.FlowUiDeadline.boundedWait(500, deadline, `waiting for uploaded ${kind} "${assetName}"`, true, options.signal);
      } else {
        await wait(Math.min(500, Math.max(1, deadline - Date.now())));
      }
    } catch (error) {
      if (options.signal?.aborted || error?.code !== "FLOW_OPERATION_TIMEOUT") throw error;
      break;
    }
  }
  const selection = options.selectionDiagnostics || {};
  const diagnostics = {
    filePickerSelectionConfirmed: selection.filePickerSelectionConfirmed === true,
    pickerMethod: safeFlowPickerMethod(selection.pickerMethod),
    pickerType: safeFlowPickerType(selection.pickerType),
    dropAttempted: selection.dropAttempted === true,
    dropReceiptConfirmed: selection.dropReceiptConfirmed === true,
    confirmationDialogSeen: selection.confirmationDialogSeen === true,
    confirmationButtonClicked: selection.confirmationButtonClicked === true,
    confirmationDialogUnrecognized: selection.confirmationDialogUnrecognized === true,
    exactTileObserved,
    baselineIdCount: baselineIds.size,
    newOwnerIdLatched: Boolean(ownerId),
    scansAttempted: libraryScans,
    lastScan,
    lastScanErrorCode,
    uploadUi: inspectFlowUploadUiState(),
  };
  const error = flowError("FLOW_UPLOAD_TIMEOUT", `Flow did not confirm an exact ${kind} library tile for "${assetName}" before the bounded deadline. Picker selection confirmed: ${diagnostics.filePickerSelectionConfirmed}; method: ${diagnostics.pickerMethod}; type: ${diagnostics.pickerType}; full-library scans: ${libraryScans}; last scan: ${lastScan ? `${lastScan.uniqueTiles} tiles, ${lastScan.steps} pages, reached end ${lastScan.reachedEnd}` : "no scan diagnostics"}. Visible rejection: ${diagnostics.uploadUi.visibleUploadRejection}; progress indicators: ${diagnostics.uploadUi.visibleProgressIndicatorCount}. Inspect Flow before retrying.`, false, true);
  error.diagnostics = diagnostics;
  throw error;
}

async function uploadStagedFlowMedia(file, kind, command, options = {}) {
  const deadline = options.deadline || globalThis.FlowUiDeadline?.makeDeadline(command, 75_000, 15_000) || Date.now() + 60_000;
  const checkTime = (operation, outcomeUnknown = false) => globalThis.FlowUiDeadline?.requireTime(deadline, operation, outcomeUnknown, options.signal);
  checkTime("starting the Flow media upload");
  // Stabilize viewport to keep composer controls visible
  const scroller = scrollContainer();
  if (scroller && scroller.scrollTop > 5) {
    scroller.scrollTop = 0;
    await globalThis.FlowUiDeadline?.boundedWait(150, deadline, "scrolling to the Flow composer", false, options.signal);
  }

  // Reuse a completed exact tile. A matching pending/error tile must settle before
  // another upload can start, preventing concurrent duplicates on caller timeout.
  const existingTiles = [...document.querySelectorAll("flow-grid-tile-container")].filter(item => matchesFlowTile(item, file.name));
  if (existingTiles.length > 1) {
    throw flowError("FLOW_UPLOAD_TILE_AMBIGUOUS", `More than one Flow tile exactly matches "${file.name}". Inspect the library before retrying.`, false, true);
  }
  if (existingTiles.length === 1) {
    if (existingTiles[0].querySelector("flow-error-tile")) {
      throw flowError("FLOW_UPLOAD_REJECTED", `Flow already has an error tile for "${file.name}". Inspect it before retrying.`, false, true);
    }
    const id = mediaId(existingTiles[0]);
    const ready = globalThis.FlowTiles?.isTileMediaReady?.(existingTiles[0]) ?? !globalThis.isTileBusy?.(existingTiles[0]);
    const actualKind = assertReusableFlowUploadKind(existingTiles[0], file.name, kind);
    if (ready && id && !id.startsWith("title:") && flowUploadKindMatches(kind, actualKind)) {
      return { uploaded: true, name: file.name, kind, id, reused: true };
    }
    const confirmed = await waitForNativeMediaTile(file.name, command, kind, { deadline, signal: options.signal });
    return { uploaded: true, name: file.name, kind, id: confirmed.id, reused: true };
  }

  // Capture durable identities before opening the picker or dispatching the
  // file. The title is random per transfer, but the ID baseline prevents an old
  // tile from being mistaken for the upload receipt while Flow hydrates metadata.
  const baselineAssets = globalThis.FlowMediaMenu?.collectAssets?.({ includeIncomplete: true });
  if (!Array.isArray(baselineAssets)) {
    throw flowError("FLOW_UPLOAD_BASELINE_UNAVAILABLE", "Could not capture Flow media IDs before upload. No file was selected; inspect the project before retrying.", false, false);
  }
  const baselineIds = [...new Set(baselineAssets.map(asset => asset?.id).filter(Boolean).map(String))];

  const uploadButton = await ensureAddMediaButton(deadline, options.signal);
  const normalize = value => String(value || "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
  const uploadNames = new Set([
    "upload", "upload media", "upload file", "upload from computer", "upload from device", "uploads",
    "tải lên", "tải tệp", "tải tệp lên", "tải lên tệp", "tải ảnh lên", "tải hình ảnh lên",
    "tải nội dung nghe nhìn lên", "tải phương tiện lên", "nội dung tải lên", "tệp tải lên",
    "tải lên từ máy tính", "tải lên từ thiết bị", "tải tệp từ thiết bị", "chọn tệp để tải lên",
    "tải nội dung lên", "tải phương tiện",
  ]);
  const normUploadNames = new Set([...uploadNames].map(name => typeof normalizeFlowUiText === "function" ? normalizeFlowUiText(name) : name));
  const labelOf = el => {
    const labels = [accessibleName(el), el.getAttribute("aria-label"), el.getAttribute("title"), el.innerText, el.textContent];
    // Material icon ligatures are exposed as text in some Flow builds (for example,
    // "upload Upload"). Ignore decorative icon text when resolving the menu row.
    try {
      const clone = el.cloneNode(true);
      clone.querySelectorAll('mat-icon,.mat-icon,.google-symbols,svg,[aria-hidden="true"]').forEach(icon => icon.remove());
      labels.push(clone.innerText || clone.textContent);
    } catch {}
    return labels.map(normalize);
  };
  const isUploadLabel = el => {
    const icon = el.querySelector("mat-icon,.mat-icon,.google-symbols,.material-symbols-outlined,svg")?.textContent?.trim() || "";
    if (["upload", "file_upload", "upload_file", "cloud_upload"].includes(icon)) return true;
    return labelOf(el).some(label => {
      if (uploadNames.has(label)) return true;
      const stripped = label.replace(/^(?:upload|upload_file|file_upload|arrow_upward)\s+/, "");
      if (uploadNames.has(stripped)) return true;
      const folded = typeof normalizeFlowUiText === "function" ? normalizeFlowUiText(label) : label;
      return normUploadNames.has(folded);
    });
  };
  const isUploadAction = el => {
    if (el.matches('[role="tab"]') || el.getAttribute("aria-selected") !== null) return false;
    const icon = el.querySelector("mat-icon,.mat-icon,.google-symbols,.material-symbols-outlined,svg")?.textContent?.trim() || "";
    if (["file_upload", "upload_file", "cloud_upload", "upload"].includes(icon)) return true;
    const actionNames = new Set([
      "upload", "upload media", "upload file", "upload from computer", "upload from device",
      "tải lên", "tải tệp", "tải tệp lên", "tải lên tệp", "tải ảnh lên", "tải hình ảnh lên",
      "tải nội dung nghe nhìn lên", "tải phương tiện lên", "tải lên từ máy tính", "tải lên từ thiết bị",
      "tải tệp từ thiết bị", "chọn tệp để tải lên", "tải nội dung lên",
    ]);
    const normActionNames = new Set([...actionNames].map(a => typeof normalizeFlowUiText === "function" ? normalizeFlowUiText(a) : a));
    return labelOf(el).some(label => {
      if (actionNames.has(label)) return true;
      const folded = typeof normalizeFlowUiText === "function" ? normalizeFlowUiText(label) : label;
      if (normActionNames.has(folded)) return true;
      // Cho phép substring match tương tự TobyFlow: "tải nội dung nghe nhìn lên" hoặc "tải lên từ máy tính"
      return folded.includes("tai len") || folded.includes("tai tep") || folded.includes("tai noi dung") ||
        label.includes("upload media") || label.includes("upload file") || label.includes("upload from");
    });
  };
  const menuRoots = () => [...document.querySelectorAll('[role="menu"],mat-menu-panel,[role="dialog"],.cdk-overlay-pane,[data-state="open"]')]
    .filter(root => visible(root) && [...root.querySelectorAll('[role="tab"],button,[role="button"],[role="menuitem"],a,[tabindex],mat-icon,.mat-icon,.google-symbols,.material-symbols-outlined')].some(isUploadLabel));

  const switchUploadCategoryTab = async roots => {
    // Ưu tiên chỉ tìm trong [role="tab"] thực sự để không bị nhầm lẫn với button upload bên dưới
    const allRoleTabs = roots.flatMap(root => [...root.querySelectorAll('[role="tab"]')]);
    const tabCandidates = allRoleTabs.length > 0 ? allRoleTabs : roots.flatMap(root => [...root.querySelectorAll('button')]);
    const validTabs = [...new Set(tabCandidates)].filter(tab => {
      if (!visible(tab) || tab.disabled || tab.getAttribute("aria-disabled") === "true") return false;
      const icon = tab.querySelector("mat-icon,.mat-icon,.google-symbols,.material-symbols-outlined,svg")?.textContent?.trim() || "";
      const label = accessibleName(tab).replace(/\s+/g, " ").trim().toLowerCase();
      const folded = typeof normalizeFlowUiText === "function" ? normalizeFlowUiText(label) : label;
      return ["upload", "file_upload", "upload_file", "cloud_upload"].includes(icon) ||
        ["upload", "uploads", "upload file", "tải lên", "nội dung tải lên", "tệp tải lên", "các tệp tải lên", "tải tệp", "tải tệp lên", "tải lên tệp", "tải ảnh lên", "tải hình ảnh lên"].includes(label) ||
        ["upload", "uploads", "tai len", "noi dung tai len", "tep tai len", "cac tep tai len", "tai tep", "tai tep len", "tai len tep"].includes(folded);
    });
    const tab = resolveUniqueUploadTarget(validTabs, "FLOW_UPLOAD_CATEGORY_AMBIGUOUS", "Upload category");
    if (!tab) return false;
    const isSelected = tab.getAttribute("aria-selected") === "true" || tab.getAttribute("data-state") === "active";
    if (!isSelected) {
      if (!clickFlowControl(tab)) throw flowError("FLOW_UPLOAD_CATEGORY_CLICK_FAILED", "Flow's Upload category could not be clicked. No file was selected.", true, false);
      await globalThis.FlowUiDeadline?.boundedWait(350, deadline, "switching Flow's upload category");
    }
    return true;
  };

  const findUploadItem = () => {
    const activeMenus = menuRoots();
    // Scope to the visible Flow add-media overlay. Never fall back to a page-wide
    // control search, which can select a hidden input/menu item from another surface.
    const roots = activeMenus;
    const semantic = [...new Set(roots.flatMap(root => [...root.querySelectorAll('button,[role="button"],[role="menuitem"],a,[tabindex]')]))]
      .filter(el => visible(el) && !el.disabled && el.getAttribute("aria-disabled") !== "true" && isUploadAction(el));
    const semanticTarget = resolveUniqueUploadTarget(semantic, "FLOW_UPLOAD_MENU_ITEM_AMBIGUOUS", "Upload action");
    if (semanticTarget) return semanticTarget;
    // Some Flow builds render menu rows as clickable divs without ARIA roles.
    const candidates = new Set();
    for (const root of roots) {
      const textLeaves = [...root.querySelectorAll("*")].filter(el => visible(el) && isUploadAction(el));
      for (const leaf of textLeaves) {
        for (let candidate = leaf; candidate && candidate !== root; candidate = candidate.parentElement) {
          if (visible(candidate) && !candidate.matches('[role="tab"]') && candidate.getAttribute("aria-selected") === null &&
              (candidate.matches('button,[role="button"],[role="menuitem"],a,[tabindex]') || candidate.getAttribute("tabindex") === "0" || getComputedStyle(candidate).cursor === "pointer")) {
            candidates.add(candidate);
            break;
          }
        }
      }
    }
    return resolveUniqueUploadTarget([...candidates], "FLOW_UPLOAD_MENU_ITEM_AMBIGUOUS", "Upload action");
  };
  const clickFlowControl = element => {
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    const point = { bubbles: true, cancelable: true, composed: true, button: 0, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
    element.dispatchEvent(new PointerEvent("pointerdown", { ...point, pointerId: 1, pointerType: "mouse" }));
    element.dispatchEvent(new MouseEvent("mousedown", point));
    element.dispatchEvent(new PointerEvent("pointerup", { ...point, pointerId: 1, pointerType: "mouse" }));
    element.dispatchEvent(new MouseEvent("mouseup", point));
    element.dispatchEvent(new MouseEvent("click", point));
    return true;
  };
  const selectionDiagnostics = { filePickerSelectionConfirmed: false, pickerMethod: "unknown", pickerType: "unknown", dropAttempted: false, dropReceiptConfirmed: false,
    confirmationDialogSeen: false, confirmationButtonClicked: false, confirmationDialogUnrecognized: false };
  // Always open Flow's own Upload row first. A page-wide file input may belong
  // to another mounted surface and is not proof that Flow accepted this upload.
  if (!uploadButton) {
    const controls = uploadControlDiagnostics();
    emitFlowProgress(command, `Upload trigger unavailable; composer controls: ${JSON.stringify(controls).slice(0, 2200)}`);
    throw flowError("FLOW_UPLOAD_CONTROL_MISSING", `Flow's project Upload control is unavailable. No file was selected. Visible composer controls: ${JSON.stringify(controls).slice(0, 2200)}`, true, false);
  } else if (uploadButton.disabled || uploadButton.getAttribute("aria-disabled") === "true") {
    throw flowError("FLOW_UPLOAD_CONTROL_DISABLED", "Flow's composer add-menu trigger is disabled. No file was selected.", true, false);
  } else {
      if (!clickFlowControl(uploadButton)) throw flowError("FLOW_UPLOAD_CONTROL_CLICK_FAILED", "Flow's project Upload control could not be clicked. No file was selected.", true, false);
      emitFlowProgress(command, "Opening Flow's scoped Upload menu and arming its file picker");
      const menuDeadline = Math.min(Date.now() + 2500, deadline);
      let uploadItem = null;
      while (Date.now() < menuDeadline && !uploadItem) {
        checkTime("opening Flow's upload menu");
        const activeMenus = menuRoots();
        if (activeMenus.length) {
          await switchUploadCategoryTab(activeMenus);
          checkTime("selecting the upload category");
        }
        uploadItem = findUploadItem();
        if (!uploadItem) await globalThis.FlowUiDeadline?.boundedWait(100, deadline, "waiting for Flow's upload menu", false, options.signal);
      }
      if (!uploadItem) {
        throw flowError("FLOW_UPLOAD_MENU_ITEM_MISSING", "Flow's visible Upload menu item did not appear. No file was selected.", true, false);
      } else {
        try {
          const pickerReceipt = await FlowNativeFileTransfer.selectFileThroughPicker(file, async () => {
            // Arming the MAIN-world picker trap is asynchronous. Flow can replace
            // its menu DOM during that round trip, so reacquire the live row just
            // before the click (TobyFlow performs this same detached-node check).
            checkTime("opening Flow's file picker");
            if (!uploadItem?.isConnected || !visible(uploadItem)) {
              await switchUploadCategoryTab(menuRoots());
              uploadItem = findUploadItem();
            }
            if (!uploadItem?.isConnected || !visible(uploadItem)) return false;
            return clickFlowControl(uploadItem);
          }, { deadline });
          selectionDiagnostics.filePickerSelectionConfirmed = pickerReceipt?.selected === true;
          selectionDiagnostics.pickerMethod = safeFlowPickerMethod(pickerReceipt?.method);
          selectionDiagnostics.pickerType = safeFlowPickerType(pickerReceipt?.type);
          emitFlowProgress(command, `Flow's scoped Upload picker confirmed ${file.name} via ${pickerReceipt.method || "Flow file input"}`);
        } catch (error) {
          // The upload row may already have opened Flow's picker. Do not start a
          // second upload by dropping the same file when that result is unknown.
          if (error?.outcome_unknown || error?.code === "FLOW_UPLOAD_PICKER_OUTCOME_UNKNOWN") throw error;
          if (error?.code === "FLOW_OPERATION_TIMEOUT") throw error;
          console.warn(`[Flow MCP upload] File-picker trap failed before selection (${String(error?.message || error)}); falling back to drag-and-drop for ${kind} "${file.name}".`);
          selectionDiagnostics.dropAttempted = true;
          const dropReceipt = await FlowNativeFileTransfer.dropFileToFlow(file);
          selectionDiagnostics.dropReceiptConfirmed = dropReceipt?.dropped === true || dropReceipt?.accepted === true;
        }
      }
  }
  checkTime("confirming the Flow media upload", true);
  if (kind === "video") Object.assign(selectionDiagnostics, await confirmFlowVideoUploadIfPrompted(deadline, options.signal, selectionDiagnostics));
  const confirmed = await waitForNativeMediaTile(file.name, command, kind, { deadline, signal: options.signal, baselineIds, requireNewOwner: true, selectionDiagnostics });
  return { ...confirmed, uploaded: true, name: file.name, kind };
}

async function confirmFlowVideoUploadIfPrompted(deadline = Date.now() + 10_000, signal, selection = {}) {
  const result = { confirmationDialogSeen: false, confirmationButtonClicked: false, confirmationDialogUnrecognized: false };
  const ambiguous = (reason, dialogCount, controlCount) => {
    const error = flowError("FLOW_UPLOAD_CONFIRMATION_AMBIGUOUS", `Flow displayed an ambiguous video upload confirmation (${reason}); no confirmation control was clicked. Inspect Flow before retrying.`, false, true);
    error.diagnostics = {
      ...result,
      confirmationDialogCandidateCount: dialogCount,
      enabledConfirmationControlCount: controlCount,
      filePickerSelectionConfirmed: selection.filePickerSelectionConfirmed === true,
      pickerMethod: safeFlowPickerMethod(selection.pickerMethod),
      pickerType: safeFlowPickerType(selection.pickerType),
      uploadUi: inspectFlowUploadUiState(),
    };
    throw error;
  };
  for (let attempt = 0; attempt < 24; attempt++) {
    if (Date.now() >= deadline) throw flowError("FLOW_OPERATION_TIMEOUT", "Timed out while confirming Flow's video upload. Inspect Flow before retrying.", false, true);
    const matchingDialogs = [...document.querySelectorAll('[role="dialog"],mat-dialog-container')].filter(el =>
      visible(el) && /video|upload|tải lên|tải video|tải tệp/i.test(String(el.innerText || el.textContent || "").slice(0, 1200)));
    // Flow sometimes nests its actual dialog inside a presentation wrapper.
    // Keep only the deepest matching surfaces, then require that surface to be unique.
    const specificDialogs = matchingDialogs.filter(dialog =>
      !matchingDialogs.some(other => other !== dialog && dialog.contains?.(other)));
    if (!specificDialogs.length) {
      // The video consent dialog may mount after Flow has accepted the file
      // picker event. Match TobyFlow's bounded polling window instead of
      // treating the first empty DOM snapshot as proof that no dialog will show.
      await globalThis.FlowUiDeadline?.boundedWait(300, deadline, "waiting for Flow's video upload confirmation", true, signal);
      continue;
    }
    result.confirmationDialogSeen = true;
    if (specificDialogs.length !== 1) ambiguous("multiple visible dialogs", specificDialogs.length, 0);
    const dialog = specificDialogs[0];
    const confirms = [...dialog.querySelectorAll("button,[role=button]")].filter(el =>
      visible(el) && !el.disabled && el.getAttribute("aria-disabled") !== "true" &&
      /^(?:upload|continue|confirm|agree|accept|tải lên|tiếp tục|xác nhận|đồng ý|chấp nhận|tải video|tải video lên)(?:\s+(?:và\s+)?(?:tiếp tục|upload|tải lên))?$/i.test(accessibleName(el).replace(/\s+/g, " ").trim()));
    if (confirms.length > 1) ambiguous("multiple enabled confirmation controls", 1, confirms.length);
    const confirm = confirms[0];
    if (confirm) { confirm.click(); result.confirmationButtonClicked = true; await globalThis.FlowUiDeadline?.boundedWait(250, deadline, "confirming Flow's video upload", true, signal); return result; }
    await globalThis.FlowUiDeadline?.boundedWait(300, deadline, "waiting for Flow's video upload confirmation", true, signal);
  }
  result.confirmationDialogUnrecognized = true;
  const error = flowError("FLOW_UPLOAD_CONFIRMATION_UNRECOGNIZED", "Flow displayed a video upload confirmation dialog, but no recognized Upload, Continue, or Confirm control appeared. No further upload actions were started; inspect Flow before retrying.", false, true);
  error.diagnostics = {
    ...result,
    filePickerSelectionConfirmed: selection.filePickerSelectionConfirmed === true,
    pickerMethod: safeFlowPickerMethod(selection.pickerMethod),
    pickerType: safeFlowPickerType(selection.pickerType),
    dropAttempted: selection.dropAttempted === true,
    dropReceiptConfirmed: selection.dropReceiptConfirmed === true,
    uploadUi: inspectFlowUploadUiState(),
  };
  throw error;
}

async function chooseNativePickerAsset(assetName, slot, config = {}) {
  const deadline = config.deadline || globalThis.FlowUiDeadline?.makeDeadline(config.command, 45_000, 10_000) || Date.now() + 35_000;
  const requireTime = (operation, outcomeUnknown = false) => globalThis.FlowUiDeadline?.requireTime(deadline, operation, outcomeUnknown, config.signal);
  const boundedWait = (ms, operation, outcomeUnknown = false) => globalThis.FlowUiDeadline?.boundedWait(ms, deadline, operation, outcomeUnknown, config.signal);
  const normalize = value => String(value || "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
  const categorySynonyms = { all: ["all", "tất cả", "tat ca"], ingredients: ["ingredients", "thành phần", "nguyên liệu"], uploads: ["uploads", "tải lên", "tai len"] };
  requireTime("opening the Flow asset picker");
  if (!slot) return globalThis.FlowReferenceActions.attach(assetName, undefined, { ...config, deadline });
  const wanted = String(assetName || "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
  if (!wanted || !["start", "end"].includes(slot)) throw flowError("FLOW_INVALID_ARGUMENT", "Frame selection requires an exact asset title and a Start or End slot.", false, false);
  const buttonForSlot = () => flowButton(slot === "start" ? "Start" : "End");
  const listForOpener = (opener, priorLists) => {
    const ids = [opener?.getAttribute("aria-controls"), opener?.getAttribute("aria-owns")].filter(Boolean).flatMap(value => value.split(/\s+/));
    const controlled = [...new Set(ids.map(id => document.getElementById(id)).filter(el => el?.getAttribute("role") === "listbox" && visible(el)))];
    if (controlled.length === 1) return controlled[0];
    if (controlled.length > 1) return null;
    const lists = [...((typeof root.flowQueryAll === "function" ? root.flowQueryAll("components.listBox", document) : null) || document.querySelectorAll('[role="listbox"]'))].filter(visible);
    const newlyOpened = lists.filter(el => !priorLists.has(el));
    return newlyOpened.length === 1 ? newlyOpened[0] : null;
  };
  const pickerSettled = async (listGetter, timeoutMs = 15_000, outcomeUnknown = false) => {
    const settleDeadline = Math.min(deadline, Date.now() + timeoutMs);
    let stableAt = 0;
    while (Date.now() < settleDeadline) {
      const list = listGetter();
      const loading = (typeof root.flowQueryVisible === "function" && Boolean(root.flowQueryVisible("common.loadingIndicator", document))) ||
        [...document.querySelectorAll('[role="progressbar"],[aria-busy="true"]')].some(visible);
      if (list && !loading) {
        const options = listOptions(list);
        if (options.length || /no (?:assets|items) found/i.test(list.innerText || "")) return list;
        if (!stableAt) stableAt = Date.now();
        if (Date.now() - stableAt >= 700) return list;
      } else stableAt = 0;
      await boundedWait(150, `waiting for Flow's ${slot} frame picker`, outcomeUnknown);
    }
    requireTime(`waiting for Flow's ${slot} frame picker`, outcomeUnknown);
    throw flowError("FLOW_ASSET_PICKER_LOADING", `Flow's ${slot} frame picker did not finish loading. Nothing was selected.`, true, outcomeUnknown);
  };
  const findTab = name => {
    const norm = normalize(name);
    const synonyms = categorySynonyms[norm] || [norm];
    const tabs = (typeof root.flowQueryAll === "function" ? root.flowQueryAll("components.categoryTabs", document) : null) ||
      [...document.querySelectorAll('[role="tab"]')];
    return tabs.find(tab => {
      if (!visible(tab)) return false;
      const label = normalize(accessibleName(tab)).replace(/^(?:accessibility_new|dashboard|face)\s*/, "");
      return synonyms.includes(label) || synonyms.some(syn => label.includes(syn));
    });
  };
  const optionNames = option => {
    const values = [accessibleName(option), option.getAttribute("aria-label"), option.getAttribute("title")];
    for (const node of option.querySelectorAll("[aria-label],[title],img[alt],flow-grid-tile-container")) {
      values.push(node.getAttribute("aria-label"), node.getAttribute("title"), node.getAttribute("alt"));
    }
    return [...new Set(values.map(value => String(value || "").replace(/\s+/g, " ").trim().toLocaleLowerCase()).filter(Boolean))];
  };
  const isExactOption = option => optionNames(option).some(label => label === wanted ||
    label.replace(/\s+(?:image|video|character|avatar)$/i, "") === wanted);
  const optionIdentity = (option, pageIndex, itemIndex, scroller) => {
    const tile = option.querySelector("flow-grid-tile-container");
    const id = tile && mediaId(tile);
    if (id && !id.startsWith("title:")) return id;
    const image = option.querySelector("img");
    return image?.currentSrc || image?.src || option.getAttribute("data-media-id") || option.id ||
      option.getAttribute("aria-posinset") || `${wanted}|${Math.floor((scroller?.scrollTop || 0) / Math.max(1, scroller?.clientHeight || 1))}|${pageIndex}|${itemIndex}`;
  };
  const slotSignature = () => {
    const opener = buttonForSlot();
    if (!opener) return "missing";
    const container = opener.parentElement?.parentElement || opener;
    return JSON.stringify({
      label: opener.getAttribute("aria-label"), title: opener.getAttribute("title"), text: (opener.innerText || "").replace(/\s+/g, " ").trim(),
      expanded: opener.getAttribute("aria-expanded"),
      media: [...container.querySelectorAll("img,video")].map(el => el.currentSrc || el.getAttribute("src") || el.getAttribute("alt") || ""),
      names: [...container.querySelectorAll("[aria-label],[title]")].map(el => el.getAttribute("aria-label") || el.getAttribute("title")),
    });
  };
  const sanitizeFrameDiagnosticUrl = value => {
    if (!value) return null;
    try {
      const parsed = new URL(String(value), location.href);
      if (["data:", "blob:", "javascript:"].includes(parsed.protocol)) return `${parsed.protocol}<redacted>`;
      return `${parsed.origin}${parsed.pathname}`;
    } catch {
      return String(value).replace(/[?#].*$/, "").slice(0, 240);
    }
  };
  const diagnosticSlotSignature = () => {
    try {
      const signature = JSON.parse(slotSignature());
      signature.media = (signature.media || []).map(value => sanitizeFrameDiagnosticUrl(value) || value);
      return signature;
    } catch { return null; }
  };
  const recordFramePickerDiagnostics = (phase, exactList, extra = {}) => {
    const opener = buttonForSlot();
    const slotContainer = opener?.parentElement?.parentElement || opener;
    const options = exactList ? listOptions(exactList, false).slice(0, 12) : [];
    const previous = globalThis.__flowNativeFramePickerDiagnostics || {};
    const diagnostics = {
      ...previous,
      slot,
      assetName,
      phase,
      updatedAt: new Date().toISOString(),
      opener: opener ? {
        ariaLabel: accessibleName(opener) || opener.getAttribute("aria-label") || null,
        title: opener.getAttribute("title") || null,
        ariaExpanded: opener.getAttribute("aria-expanded"),
        ariaControls: opener.getAttribute("aria-controls"),
        ariaOwns: opener.getAttribute("aria-owns"),
        disabled: Boolean(opener.disabled || opener.getAttribute("aria-disabled") === "true"),
        className: String(opener.className?.baseVal || opener.className || "").slice(0, 100),
      } : null,
      slotContent: slotContainer ? [...slotContainer.querySelectorAll("img,video")].slice(0, 4).map(el => ({
        alt: el.getAttribute("alt") || null,
        title: el.getAttribute("title") || null,
        src: sanitizeFrameDiagnosticUrl(el.currentSrc || el.getAttribute("src")),
      })) : [],
      exactFrameList: exactList ? {
        present: true,
        connected: exactList.isConnected !== false,
        id: exactList.id || null,
        role: exactList.getAttribute("role"),
        ariaLabel: exactList.getAttribute("aria-label") || null,
        optionCount: exactList.querySelectorAll('[role="option"]').length,
        options: options.map(option => ({
          label: accessibleName(option) || option.getAttribute("aria-label") || option.getAttribute("title") || null,
          ariaSelected: option.getAttribute("aria-selected"),
          ariaChecked: option.getAttribute("aria-checked"),
          dataState: option.getAttribute("data-state"),
        })),
      } : { present: false },
      slotSignature: diagnosticSlotSignature(),
      ...extra,
    };
    globalThis.__flowNativeFramePickerDiagnostics = diagnostics;
    return diagnostics;
  };
  recordFramePickerDiagnostics("opening");

  let opener = buttonForSlot();
  if (!opener) throw flowError("FLOW_FRAMES_CONTROLS_UNAVAILABLE", `Flow's ${slot} frame picker is unavailable. Nothing was submitted.`, true, false);
  const beforeSlot = slotSignature();
  let list;
  let frameControlledIds = [];
  for (let attempt = 0; attempt < 3 && Date.now() < deadline; attempt++) {
    requireTime(`opening Flow's ${slot} frame picker`);
    opener = buttonForSlot();
    if (!opener) break;
    const priorLists = new Set(document.querySelectorAll('[role="listbox"]'));
    const controlledIds = [opener.getAttribute("aria-controls"), opener.getAttribute("aria-owns")].filter(Boolean).flatMap(value => value.split(/\s+/));
    frameControlledIds = controlledIds;
    opener.click();
    const listGetter = () => {
      return listForOpener(buttonForSlot(), priorLists);
    };
    try { list = await pickerSettled(listGetter, 5000); } catch (error) {
      if (attempt === 2) throw error;
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await boundedWait(250, `reopening Flow's ${slot} frame picker`);
      continue;
    }
    if (list) break;
  }
  if (!list || !visible(list)) throw flowError("FLOW_ASSET_PICKER_MISSING", `Flow's ${slot} frame picker did not open. Nothing was submitted.`, true, false);
  const listGetter = () => {
    const currentOpener = buttonForSlot();
    const currentIds = [currentOpener?.getAttribute("aria-controls"), currentOpener?.getAttribute("aria-owns")]
      .filter(Boolean).flatMap(value => value.split(/\s+/));
    const ids = [...new Set([...frameControlledIds, ...currentIds])];
    const controlled = [...new Set(ids.map(id => document.getElementById(id)).filter(item => item?.getAttribute("role") === "listbox" && visible(item)))];
    if (controlled.length === 1) return controlled[0];
    if (controlled.length > 1) return null;
    return list?.isConnected !== false && visible(list) ? list : null;
  };
  recordFramePickerDiagnostics("picker_open", list);

  const categories = ["All", "Tất cả", "Ingredients", "Thành phần", "Uploads", "Tải lên"];
  let matches = new Map();
  let scroller = null;
  let pageIndex = 0;
  let operationError;
  try {
    let search = (typeof root.flowQueryVisible === "function" ? root.flowQueryVisible("components.searchInput", document) : null) ||
      [...document.querySelectorAll('input,[role="textbox"]')].find(el => visible(el) && /(?:search assets|tìm kiếm)/i.test(accessibleName(el) || el.placeholder || ""));
    if (search) {
      setEditable(search, assetName);
      await boundedWait(650, `searching for "${assetName}" in Flow's ${slot} picker`);
      await pickerSettled(listGetter);
    }
    for (const category of categories) {
      requireTime(`searching Flow's ${slot} picker`);
      const tab = findTab(category);
      if (tab && tab.getAttribute("aria-selected") !== "true") {
        tab.click();
        const tabDeadline = Math.min(Date.now() + 5000, deadline);
        while (Date.now() < tabDeadline) {
          const current = findTab(category);
          if (current?.getAttribute("aria-selected") === "true") break;
          await boundedWait(100, `selecting ${category} in Flow's ${slot} picker`);
        }
        if (findTab(category)?.getAttribute("aria-selected") !== "true") throw flowError("FLOW_ASSET_CATEGORY_UNCONFIRMED", `Flow did not select the ${category} picker category. Nothing was submitted.`, true, false);
        await pickerSettled(listGetter);
      }
      list = listGetter();
      if (!list) continue;
      search = (typeof root.flowQueryVisible === "function" ? root.flowQueryVisible("components.searchInput", document) : null) ||
        [...document.querySelectorAll('input,[role="textbox"]')].find(el => visible(el) && /(?:search assets|tìm kiếm)/i.test(accessibleName(el) || el.placeholder || ""));
      if (search && String(search.value ?? "") !== assetName) {
        setEditable(search, assetName);
        await boundedWait(650, `searching for "${assetName}" in Flow's ${slot} picker`);
        await pickerSettled(listGetter);
      }
      list = listGetter();
      scroller = list && [list, ...list.querySelectorAll("*")].find(el => el.clientHeight > 0 && el.scrollHeight > el.clientHeight + 5);
      if (scroller) scroller.scrollTop = 0;
      matches = new Map();
      for (pageIndex = 0; pageIndex < (scroller ? 150 : 1) && Date.now() < deadline; pageIndex++) {
        list = await pickerSettled(listGetter, 15_000);
        if (!list) break;
        const visibleOptions = listOptions(list);
        visibleOptions.forEach((option, itemIndex) => {
          if (isExactOption(option)) matches.set(optionIdentity(option, pageIndex, itemIndex, scroller), option);
        });
        if (matches.size > 1) break;
        if (!scroller || scroller.scrollTop >= scroller.scrollHeight - scroller.clientHeight - 2) break;
        const previous = scroller.scrollTop;
        scroller.scrollTop = Math.min(scroller.scrollHeight - scroller.clientHeight, previous + Math.max(120, scroller.clientHeight * 0.75));
        await boundedWait(250, `scanning Flow's ${slot} picker`);
        if (scroller.scrollTop === previous) break;
      }
      if (matches.size) break;
    }
    if (matches.size > 1) throw flowError("FLOW_AMBIGUOUS_ASSET", `More than one project image is titled "${assetName}"; no frame was selected.`, false, false);
    if (!matches.size) {
      const visibleNames = (list ? listOptions(list) : []).slice(0, 12).map(option => optionNames(option).slice(0, 3).join(" / ")).filter(Boolean);
      throw flowError("FLOW_ASSET_NOT_FOUND", `Flow's ${slot} frame picker has no exact asset titled "${assetName}". Visible entries: ${visibleNames.join("; ") || "none"}. Nothing was selected.`, true, false);
    }
    const option = [...matches.values()][0];
    requireTime(`selecting "${assetName}" for the ${slot} frame`);
    // Some Flow picker versions render the grid tile beside the role=option
    // wrapper instead of inside it. Match only one exact title in this picker
    // list (the reference-chip picker uses the same scoped fallback).
    const optionTile = (typeof root.flowQuery === "function" ? root.flowQuery("tiles.container", option, { checkVisible: false }) : null) ||
      option.querySelector("flow-grid-tile-container");
    const listTiles = (typeof root.flowQueryAll === "function" ? root.flowQueryAll("tiles.container", list, { checkVisible: false }) : null) ||
      [...(list?.querySelectorAll("flow-grid-tile-container") || [])];
    const listTileMatches = optionTile ? [] : listTiles
      .filter(tile => normalize(tile.getAttribute("aria-label")) === wanted);
    const selectedTile = optionTile || (listTileMatches.length === 1 ? listTileMatches[0] : null);
    const tileId = selectedTile && mediaId(selectedTile);
    let selectedId = (tileId && !tileId.startsWith("title:") ? tileId : null) || option.getAttribute("data-media-id") || option.querySelector("[data-media-id]")?.getAttribute("data-media-id") || tileId || undefined;
    selectedId = await globalThis.resolveNativeMediaUuid?.(selectedId, "image") || selectedId;
    const expectedId = await globalThis.resolveNativeMediaUuid?.(config.expectedId, "image") || config.expectedId;
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidPattern.test(String(selectedId || ""))) {
      throw flowError("FLOW_ASSET_ID_UNAVAILABLE", `Flow's exact frame option for "${assetName}" did not expose a uniquely verifiable backend UUID. No frame was selected.`, false, false);
    }
    if (expectedId && selectedId.toLowerCase() !== String(expectedId).toLowerCase()) {
      throw flowError("FLOW_ASSET_ID_MISMATCH", `Flow's picker selected a different media ID than the completed upload for "${assetName}". No frame was selected.`, false, false);
    }
    recordFramePickerDiagnostics("selection_identity_verified", list, { selectedMediaId: selectedId.toLowerCase(), expectedMediaId: expectedId || null });
    option.click();
    recordFramePickerDiagnostics("option_clicked", list, { selectedMediaId: selectedId.toLowerCase() });
    const selectionDeadline = Math.min(Date.now() + 5000, deadline);
    let attached = false;
    while (Date.now() < selectionDeadline) {
      const currentList = listGetter();
      const selected = currentList && [...currentList.querySelectorAll('[role="option"]')].find(item => isExactOption(item) &&
        (item.getAttribute("aria-selected") === "true" || item.getAttribute("aria-checked") === "true" || item.getAttribute("data-state") === "checked"));
      const slotChanged = slotSignature() !== beforeSlot;
      if (selected || (slotChanged && !currentList)) {
        attached = true;
        recordFramePickerDiagnostics("selection_confirmed", currentList, {
          selectedMediaId: selectedId.toLowerCase(),
          confirmation: selected ? "exact_option_selected_state" : "slot_signature_changed_and_exact_list_disappeared",
          slotChanged,
        });
        break;
      }
      recordFramePickerDiagnostics("waiting_for_selection_confirmation", currentList, { selectedMediaId: selectedId.toLowerCase(), slotChanged });
      await boundedWait(150, `confirming "${assetName}" for the ${slot} frame`, true);
    }
    if (!attached) throw flowError("FLOW_FRAME_ATTACH_UNCONFIRMED", `Flow did not confirm that "${assetName}" was selected for the ${slot} frame. The picker action may have been accepted; inspect the composer before retrying.`, false, true);
    return { name: assetName, kind: "image", slot, id: selectedId.toLowerCase(), confirmed: true };
  } catch (error) {
    operationError = error;
    recordFramePickerDiagnostics("selection_failed", listGetter(), {
      operationErrorCode: error?.code || "FLOW_FRAME_SELECTION_ERROR",
      operationOutcomeUnknown: error?.outcome_unknown === true,
    });
    throw error;
  } finally {
    const reportCleanupFailure = (message, diagnostics) => {
      const cleanupError = flowError("FLOW_ASSET_PICKER_CLOSE_FAILED", message, true, false);
      recordFramePickerDiagnostics("cleanup_unverified", null, {
        cleanupErrorCode: cleanupError.code,
        operationErrorCode: operationError?.code || null,
        ...(diagnostics || {}),
      });
      if (!operationError) throw cleanupError;
      operationError.cleanupError = { code: cleanupError.code, message: cleanupError.message };
    };
    const framePickerState = () => {
      const currentList = listGetter();
      if (currentList && visible(currentList)) {
        recordFramePickerDiagnostics("cleanup_check", currentList, { pickerState: "open", stateSource: "exact_frame_list" });
        return { open: true, list: currentList, source: "exact_frame_list" };
      }
      const expanded = buttonForSlot()?.getAttribute("aria-expanded");
      if (expanded === "true") {
        recordFramePickerDiagnostics("cleanup_check", null, { pickerState: "open", stateSource: "frame_opener_aria_expanded" });
        return { open: true, list: null, source: "frame_opener_aria_expanded" };
      }
      if (expanded === "false") {
        recordFramePickerDiagnostics("cleanup_check", null, { pickerState: "closed", stateSource: "frame_opener_aria_expanded" });
        return { open: false, list: null, source: "frame_opener_aria_expanded" };
      }
      recordFramePickerDiagnostics("cleanup_check", null, { pickerState: "unknown", stateSource: "no_exact_list_or_expanded_state" });
      return { open: null, list: null, source: "no_exact_list_or_expanded_state" };
    };
    let state = framePickerState();
    if (state.open === null) {
      reportCleanupFailure(`Flow's ${slot} frame picker could not be identified after selection; no other listbox was inspected or toggled. Diagnostics: ${JSON.stringify(inspectNativeFramePickerDiagnostics()).slice(0, 1500)}`, { cleanupStateSource: state.source });
    } else if (state.open) {
      const closeButton = state.list && flowButton("Close", state.list.closest('[role="dialog"]') || document);
      if (closeButton) closeButton.click();
      else document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      const waitForPickerClose = async () => {
        const closeDeadline = Date.now() + 750;
        while (Date.now() < closeDeadline) {
          state = framePickerState();
          if (state.open === false) return true;
          if (state.open === null) return false;
          await wait(100);
        }
        state = framePickerState();
        return state.open === false;
      };
      let closed = await waitForPickerClose();
      // Flow's frame picker sometimes ignores Escape and has no dialog Close
      // button. When the exact Start/End list is still open, toggle that same
      // opener once, then verify the list actually disappeared. Never click an
      // option or change the selected frame during cleanup.
      if (!closed && state.open === true) {
        const slotOpener = buttonForSlot();
        if (slotOpener) {
          slotOpener.click();
          closed = await waitForPickerClose();
        }
      }
      if (!closed || state.open !== false) {
        reportCleanupFailure(`Flow's ${slot} frame picker stayed open or became unidentifiable after the bounded close attempts.`, { cleanupStateSource: state.source });
      }
    }
    if (state.open === false) recordFramePickerDiagnostics("picker_closed", null, { pickerState: "closed", closeMethod: state.source || "no_picker_open" });
  }
}

function inspectNativeFramePickerDiagnostics() {
  const diagnostics = globalThis.__flowNativeFramePickerDiagnostics;
  return diagnostics ? JSON.parse(JSON.stringify(diagnostics)) : null;
}

const FlowComponents = Object.freeze({ clearExistingIngredientChips: globalThis.clearExistingIngredientChips, uploadStagedFlowMedia, chooseNativePickerAsset, confirmVideoUploadIfPrompted: confirmFlowVideoUploadIfPrompted, resolveUniqueUploadTarget, selectNativeFlowVoice: globalThis.selectNativeFlowVoice, listNativeFlowVoiceOptions: globalThis.listNativeFlowVoiceOptions, resolveNativeMediaUuid: globalThis.resolveNativeMediaUuid, findAddMediaButton, ensureAddMediaButton, inspectUploadTrigger: inspectFlowUploadTrigger, inspectFramePickerDiagnostics: inspectNativeFramePickerDiagnostics, FlowReferenceActions: globalThis.FlowReferenceActions }); globalThis.FlowComponents = FlowComponents; globalThis.uploadStagedFlowMedia = uploadStagedFlowMedia; globalThis.chooseNativePickerAsset = chooseNativePickerAsset; globalThis.findAddMediaButton = findAddMediaButton; globalThis.ensureAddMediaButton = ensureAddMediaButton;
