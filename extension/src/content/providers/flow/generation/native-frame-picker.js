// Native image picker used for Start/End frame selection.
(() => {
  "use strict";
  const root = globalThis;
  function deepQueryAll(scope, selector) {
    if (!scope?.querySelectorAll) return [];
    const results = [];
    const pending = [scope];
    const visited = new Set();
    while (pending.length) {
      const current = pending.shift();
      if (!current || visited.has(current)) continue;
      visited.add(current);
      try { results.push(...current.querySelectorAll(selector)); } catch {}
      try {
        for (const element of current.querySelectorAll("*")) {
          if (element.shadowRoot && !visited.has(element.shadowRoot)) pending.push(element.shadowRoot);
        }
      } catch {}
    }
    return [...new Set(results)];
  }
  function listOptions(list, checkVis = true) {
    if (!list) return [];
    const configured = typeof root.flowQueryAll === "function" ? root.flowQueryAll("components.optionItem", list, { checkVisible: checkVis }) : [];
    const raw = [...new Set([...configured, ...deepQueryAll(list, '[role="option"]')])];
    return checkVis ? raw.filter(el => typeof root.visible !== "function" || root.visible(el)) : raw;
  }
async function chooseNativePickerAsset(assetName, slot, config = {}) {
  const deadline = config.deadline || globalThis.FlowUiDeadline?.makeDeadline(config.command, 45_000, 10_000) || Date.now() + 35_000;
  const requireTime = (operation, outcomeUnknown = false) => globalThis.FlowUiDeadline?.requireTime(deadline, operation, outcomeUnknown, config.signal);
  const boundedWait = (ms, operation, outcomeUnknown = false) => globalThis.FlowUiDeadline?.boundedWait(ms, deadline, operation, outcomeUnknown, config.signal);
  const normalize = value => String(value || "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
  const fold = value => root.normalizeFlowUiText?.(value) || String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  const explicitEmptyState = list => {
    if (!list || listOptions(list).length) return false;
    const state = [list.getAttribute?.("aria-label"), list.getAttribute?.("data-state"), list.getAttribute?.("data-testid"), list.innerText, list.textContent]
      .map(fold).join(" ");
    return /no (?:assets|items|results)(?: were)? found|nothing (?:is )?here|no results|khong (?:co|tim thay)|khong tim thay|danh sach trong|khong co ket qua/.test(state) ||
      deepQueryAll(list, '[data-empty="true"],[aria-label*="empty" i],[data-testid*="empty" i]').length > 0;
  };
  const categorySynonyms = { all: ["all", "tất cả", "tat ca"], ingredients: ["ingredients", "thành phần", "nguyên liệu"], uploads: ["uploads", "tải lên", "tai len"] };
  requireTime("opening the Flow asset picker");
  if (!slot) return globalThis.FlowReferenceActions.attach(assetName, undefined, { ...config, deadline });
  const wanted = String(assetName || "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
  if (!wanted || !["start", "end"].includes(slot)) throw flowError("FLOW_INVALID_ARGUMENT", "Frame selection requires an exact asset title and a Start or End slot.", false, false);
  const buttonForSlot = () => {
    const label = slot === "start" ? "Start" : "End";
    const composer = (typeof root.flowQuery === "function" ? root.flowQuery("composerRoot") : null) || document;
    const roots = [composer];
    for (let index = 0; index < roots.length; index++) {
      const current = roots[index];
      if (current.shadowRoot && !roots.includes(current.shadowRoot)) roots.push(current.shadowRoot);
      try {
        for (const element of current.querySelectorAll("*")) if (element.shadowRoot && !roots.includes(element.shadowRoot)) roots.push(element.shadowRoot);
      } catch {}
    }
    for (const scope of roots) {
      const candidate = root.flowButton?.(label, scope);
      if (candidate) return candidate;
    }
    return null;
  };
  const controlledByOpener = (opener, id) => {
    const scope = opener?.getRootNode?.() || document;
    return scope.getElementById?.(id) || deepQueryAll(scope, "[id]").find(element => element.id === id) || document.getElementById(id);
  };
  const listForOpener = (opener, priorLists) => {
    const ids = [opener?.getAttribute("aria-controls"), opener?.getAttribute("aria-owns")].filter(Boolean).flatMap(value => value.split(/\s+/));
    const controlled = [...new Set(ids.map(id => controlledByOpener(opener, id)).filter(el => el?.getAttribute("role") === "listbox" && visible(el)))];
    if (controlled.length === 1) return controlled[0];
    if (controlled.length > 1) return null;
    const configuredLists = typeof root.flowQueryAll === "function" ? root.flowQueryAll("components.listBox", document) : [];
    const lists = [...new Set([...configuredLists, ...deepQueryAll(document, '[role="listbox"]')])].filter(visible);
    const newlyOpened = lists.filter(el => !priorLists.has(el));
    return newlyOpened.length === 1 ? newlyOpened[0] : null;
  };
  const pickerScopeRoots = activeList => {
    if (!activeList) return [];
    const treeRoot = activeList.getRootNode?.();
    const surface = activeList.closest?.('[role="dialog"],mat-dialog-container,flow-dialog,.cdk-overlay-pane,[class*="picker" i],[class*="surface" i]') ||
      (treeRoot && treeRoot !== document ? treeRoot : activeList.parentElement) || activeList;
    const roots = [surface];
    for (let index = 0; index < roots.length; index++) {
      const current = roots[index];
      if (current.shadowRoot && !roots.includes(current.shadowRoot)) roots.push(current.shadowRoot);
      try {
        for (const element of current.querySelectorAll("*")) if (element.shadowRoot && !roots.includes(element.shadowRoot)) roots.push(element.shadowRoot);
      } catch {}
    }
    return roots;
  };
  const scopedPickerElements = (activeList, selector, configuredKey) => {
    const roots = pickerScopeRoots(activeList);
    const configured = typeof root.flowQueryAll === "function" && configuredKey
      ? root.flowQueryAll(configuredKey, roots[0]) : [];
    return [...new Set([...(configured || []), ...roots.flatMap(scope => deepQueryAll(scope, selector))])]
      .filter(element => roots.some(scope => scope === element || scope.contains?.(element)));
  };
  const pickerSettled = async (listGetter, timeoutMs = 15_000, outcomeUnknown = false) => {
    const settleDeadline = Math.min(deadline, Date.now() + timeoutMs);
    let stableAt = 0;
    while (Date.now() < settleDeadline) {
      const list = listGetter();
      const loading = (typeof root.flowQueryVisible === "function" && Boolean(root.flowQueryVisible("common.loadingIndicator", document))) ||
        deepQueryAll(document, '[role="progressbar"],[aria-busy="true"]').some(visible);
      if (list && !loading) {
        const options = listOptions(list);
        if (options.length || explicitEmptyState(list)) return list;
        if (!stableAt) stableAt = Date.now();
        if (Date.now() - stableAt >= 700) return list;
      } else stableAt = 0;
      await boundedWait(150, `waiting for Flow's ${slot} frame picker`, outcomeUnknown);
    }
    requireTime(`waiting for Flow's ${slot} frame picker`, outcomeUnknown);
    throw flowError("FLOW_ASSET_PICKER_LOADING", `Flow's ${slot} frame picker did not finish loading. Nothing was selected.`, true, outcomeUnknown);
  };
  const findTab = (name, activeList = listGetter()) => {
    const norm = normalize(name);
    const synonyms = categorySynonyms[norm] || [norm];
    const tabs = scopedPickerElements(activeList, '[role="tab"],button,[role="button"],mat-chip,[class*="chip"]', "components.categoryTabs");
    const matches = tabs.filter(tab => {
      if (!visible(tab)) return false;
      const label = normalize(accessibleName(tab)).replace(/^(?:accessibility_new|dashboard|face)\s*/, "");
      return synonyms.includes(label) || synonyms.some(syn => label.startsWith(`${syn} `));
    });
    const explicitTabs = matches.filter(tab => tab.getAttribute("role") === "tab");
    const candidates = explicitTabs.length ? explicitTabs : matches;
    if (candidates.length > 1) {
      throw flowError("FLOW_ASSET_CATEGORY_AMBIGUOUS", `Flow's active ${slot} picker has multiple matching ${name} tabs; no category was selected.`, false, false);
    }
    return candidates[0] || null;
  };
  const optionNames = option => {
    const values = [accessibleName(option), option.getAttribute("aria-label"), option.getAttribute("title")];
    for (const node of deepQueryAll(option, "[aria-label],[title],img[alt],flow-grid-tile-container")) {
      values.push(node.getAttribute("aria-label"), node.getAttribute("title"), node.getAttribute("alt"));
    }
    return [...new Set(values.map(value => String(value || "").replace(/\s+/g, " ").trim().toLocaleLowerCase()).filter(Boolean))];
  };
  const isExactOption = option => optionNames(option).some(label => label === wanted ||
    label.replace(/\s+(?:image|video|character|avatar)$/i, "") === wanted);
  const optionIdentity = (option, pageIndex, itemIndex, scroller) => {
    const tile = deepQueryAll(option, "flow-grid-tile-container")[0];
    const id = tile && mediaId(tile);
    if (id && !id.startsWith("title:")) return id;
    const image = deepQueryAll(option, "img")[0];
    const mediaIdAttribute = deepQueryAll(option, "[data-media-id]")[0]?.getAttribute("data-media-id");
    return image?.currentSrc || image?.src || mediaIdAttribute || option.getAttribute("data-media-id") || option.id ||
      option.getAttribute("aria-posinset") || `${wanted}|${Math.floor((scroller?.scrollTop || 0) / Math.max(1, scroller?.clientHeight || 1))}|${pageIndex}|${itemIndex}`;
  };
  const slotSignature = () => {
    const opener = buttonForSlot();
    if (!opener) return "missing";
    const container = opener.parentElement?.parentElement || opener;
    const media = deepQueryAll(container, "img,video");
    const labels = deepQueryAll(container, "[aria-label],[title]");
    return JSON.stringify({
      label: opener.getAttribute("aria-label"), title: opener.getAttribute("title"), text: (opener.innerText || "").replace(/\s+/g, " ").trim(),
      expanded: opener.getAttribute("aria-expanded"),
      media: media.map(el => el.currentSrc || el.getAttribute("src") || el.getAttribute("alt") || ""),
      names: labels.map(el => el.getAttribute("aria-label") || el.getAttribute("title")),
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
      slotContent: slotContainer ? deepQueryAll(slotContainer, "img,video").slice(0, 4).map(el => ({
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
        optionCount: deepQueryAll(exactList, '[role="option"]').length,
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
    const priorLists = new Set(deepQueryAll(document, '[role="listbox"]'));
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
    const controlled = [...new Set(ids.map(id => controlledByOpener(currentOpener, id)).filter(item => item?.getAttribute("role") === "listbox" && visible(item)))];
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
    const findSearchInput = () => {
      const matches = scopedPickerElements(listGetter(), 'input,[role="textbox"]', "components.searchInput")
        .filter(el => visible(el) && /(?:search assets|tìm kiếm)/i.test(accessibleName(el) || el.placeholder || ""));
      if (matches.length > 1) throw flowError("FLOW_ASSET_SEARCH_AMBIGUOUS", `Flow's active ${slot} picker has multiple search fields; nothing was typed.`, false, false);
      return matches[0] || null;
    };
    let search = findSearchInput();
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
      search = findSearchInput();
      if (search && String(search.value ?? "") !== assetName) {
        setEditable(search, assetName);
        await boundedWait(650, `searching for "${assetName}" in Flow's ${slot} picker`);
        await pickerSettled(listGetter);
      }
      list = listGetter();
      scroller = list && [list, ...deepQueryAll(list, "*")].find(el => el.clientHeight > 0 && el.scrollHeight > el.clientHeight + 5);
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
      deepQueryAll(option, "flow-grid-tile-container")[0];
    const configuredTiles = typeof root.flowQueryAll === "function" ? root.flowQueryAll("tiles.container", list, { checkVisible: false }) : [];
    const listTiles = [...new Set([...configuredTiles, ...deepQueryAll(list, "flow-grid-tile-container")])];
    const listTileMatches = optionTile ? [] : listTiles
      .filter(tile => normalize(tile.getAttribute("aria-label")) === wanted);
    const selectedTile = optionTile || (listTileMatches.length === 1 ? listTileMatches[0] : null);
    const tileId = selectedTile && mediaId(selectedTile);
    let selectedId = (tileId && !tileId.startsWith("title:") ? tileId : null) || option.getAttribute("data-media-id") ||
      deepQueryAll(option, "[data-media-id]")[0]?.getAttribute("data-media-id") || tileId || undefined;
    selectedId = await globalThis.resolveNativeMediaUuid?.(selectedId, "image") || selectedId;
    const expectedId = await globalThis.resolveNativeMediaUuid?.(config.expectedId, "image") || config.expectedId;
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidPattern.test(String(selectedId || ""))) {
      if (expectedId && uuidPattern.test(String(expectedId))) {
        selectedId = expectedId;
      } else {
        throw flowError("FLOW_ASSET_ID_UNAVAILABLE", `Flow's exact frame option for "${assetName}" did not expose a uniquely verifiable backend UUID. No frame was selected.`, false, false);
      }
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
      const selected = currentList && deepQueryAll(currentList, '[role="option"]').find(item => isExactOption(item) &&
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


  root.FlowNativeFramePicker = Object.freeze({ choose: chooseNativePickerAsset, inspectDiagnostics: inspectNativeFramePickerDiagnostics });
  root.chooseNativePickerAsset = chooseNativePickerAsset;
})();
