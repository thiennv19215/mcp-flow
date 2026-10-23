(function () {
  "use strict";

  let cachedStatus = null;
  const logs = [];
  let currentCharacters = [];
  let flowProjects = [];
  let flowAssets = [];
  let flowPhotosVisibleLimit = 30;
  let flowPhotosScanned = false;
  let localUiHistory = [];
  let savedPrompts = [];
  let flowModelCapabilities = null;
  let flowModelCapabilitiesPromise = null;
  let lastFlowVideoModel = null;
  let lastVideoChainEnabled = false;
  let lastVideoFramesMode = false;
  const flowVideoModelSelections = new Map();

  const UI_HISTORY_KEY = "flowMcpUiHistory";
  const SAVED_PROMPTS_KEY = "flowMcpSavedPrompts";

  async function dispatchFlowOperation(operation, payload = {}) {
    const response = await chrome.runtime.sendMessage({ type: "flow-mcp:dispatch", operation, payload });
    if (!response?.ok) throw new Error(response?.error?.message || `Flow operation failed: ${operation}`);
    return response.value;
  }

  async function assertQueueIdleForDirectAction() {
    const response = await chrome.runtime.sendMessage({ type: "flow-queue:get" });
    const jobs = response?.snapshot?.jobs || response?.jobs || [];
    if (!response?.ok || response.isRunning || jobs.some(job => ["running", "queued", "pending"].includes(job.status))) {
      throw new Error("Hãy đợi hàng đợi Flow trống trước khi thực hiện thao tác này.");
    }
  }

  function showLibraryResult(value) {
    const output = document.querySelector("#flowLibraryResult");
    if (output) output.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  }

  function fillSelect(select, items, getValue, getLabel, placeholder) {
    if (!select) return;
    const previous = select.value;
    select.replaceChildren();
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = placeholder;
    select.appendChild(empty);
    for (const item of items) {
      const value = String(getValue(item) || "");
      if (!value) continue;
      const option = document.createElement("option");
      option.value = value;
      option.textContent = String(getLabel(item) || value);
      select.appendChild(option);
    }
    if ([...select.options].some(option => option.value === previous)) select.value = previous;
  }

  async function runLibraryAction(button, action) {
    if (button) button.disabled = true;
    try {
      const result = await action();
      showLibraryResult(result ?? "Hoàn tất.");
      setFeedback("Thao tác Flow hoàn tất.", true);
      return result;
    } catch (error) {
      showLibraryResult(error.message || String(error));
      setFeedback(error.message || String(error), false);
      return null;
    } finally {
      if (button) button.disabled = false;
    }
  }

  function t(key, params) {
    return typeof I18n !== "undefined" ? I18n.t(key, params) : key;
  }

  function confirmImageGeneration({ prompts, model, aspectRatio, count, references, character, submitButton }) {
    const dialog = document.querySelector("#imageConfirmDialog");
    const ratioSelect = document.querySelector("#imageConfirmRatio");
    const countSelect = document.querySelector("#imageConfirmCount");
    const sourceRatio = document.querySelector("#selectRatioImage");
    const sourceCount = document.querySelector("#selectQtyImage");
    if (!dialog || typeof dialog.showModal !== "function" || !ratioSelect || !countSelect || !sourceRatio || !sourceCount) {
      throw new Error("Không thể mở bước xác nhận tạo ảnh trong extension.");
    }
    if (dialog.open) return Promise.resolve(null);

    ratioSelect.replaceChildren(...[...sourceRatio.options].map(option => option.cloneNode(true)));
    countSelect.replaceChildren(...[...sourceCount.options].map(option => option.cloneNode(true)));
    ratioSelect.value = aspectRatio;
    countSelect.value = String(count);

    const promptCount = Array.isArray(prompts) ? prompts.length : 0;
    const promptSummary = document.querySelector("#imageConfirmPromptCount");
    const modelSummary = document.querySelector("#imageConfirmModel");
    const quantitySummary = document.querySelector("#imageConfirmQuantity");
    const referencesSummary = document.querySelector("#imageConfirmReferences");
    const characterSummary = document.querySelector("#imageConfirmCharacter");
    const updateQuantitySummary = () => {
      const perPrompt = Math.max(1, Number(countSelect.value) || 1);
      if (quantitySummary) quantitySummary.textContent = t("sidebar.imageConfirmQuantityDetail", { total: promptCount * perPrompt, count: perPrompt });
    };
    if (promptSummary) promptSummary.textContent = promptCount === 1
      ? t("sidebar.imageConfirmSinglePrompt")
      : t("sidebar.imageConfirmBatchPrompts", { count: promptCount });
    if (modelSummary) modelSummary.textContent = document.querySelector("#selectModelImage")?.selectedOptions?.[0]?.textContent?.trim() || model;
    if (referencesSummary) referencesSummary.textContent = String(Array.isArray(references) ? references.length : 0);
    if (characterSummary) characterSummary.textContent = character
      ? document.querySelector("#selectCharImage")?.selectedOptions?.[0]?.textContent?.trim() || character
      : t("sidebar.imageConfirmNone");
    updateQuantitySummary();

    return new Promise((resolve, reject) => {
      const cleanup = () => {
        dialog.removeEventListener("close", onClose);
        dialog.removeEventListener("click", onDialogClick);
        document.querySelector("#imageConfirmCancel")?.removeEventListener("click", onCancel);
        document.querySelector("#imageConfirmRun")?.removeEventListener("click", onConfirm);
        countSelect.removeEventListener("change", updateQuantitySummary);
      };
      const onClose = () => {
        const result = dialog.returnValue === "confirm"
          ? { aspect_ratio: ratioSelect.value, count: Math.max(1, Number(countSelect.value) || 1) }
          : null;
        cleanup();
        submitButton?.focus();
        resolve(result);
      };
      const onDialogClick = event => {
        if (event.target === dialog) dialog.close("cancel");
      };
      const onCancel = () => dialog.close("cancel");
      const onConfirm = () => dialog.close("confirm");
      dialog.returnValue = "";
      dialog.addEventListener("close", onClose, { once: true });
      dialog.addEventListener("click", onDialogClick);
      document.querySelector("#imageConfirmCancel")?.addEventListener("click", onCancel);
      document.querySelector("#imageConfirmRun")?.addEventListener("click", onConfirm);
      countSelect.addEventListener("change", updateQuantitySummary);
      try {
        dialog.showModal();
        document.querySelector("#imageConfirmCancel")?.focus();
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  }

  function updateVideoFrameInputs() {
    const framesMode = document.querySelector("#selectModeVideo")?.value === "frames";
    const group = document.querySelector("#videoFrameNamesGroup");
    if (group) group.hidden = !framesMode;
    for (const selector of ["#videoReferenceOptionsGroup", "#videoReferenceSection", "#videoCharacterGroup"]) {
      const control = document.querySelector(selector);
      if (control) control.hidden = framesMode;
    }
    const voiceGroup = document.querySelector("#flowVoicePickerGroup");
    if (voiceGroup) voiceGroup.hidden = framesMode;
    if (framesMode && !lastVideoFramesMode) {
      const voiceSelect = document.querySelector("#flowVoiceSelect");
      if (voiceSelect) voiceSelect.value = "";
    }
    lastVideoFramesMode = framesMode;
    updateVideoChainUI();
  }

  function updateVideoChainUI() {
    const multiPrompt = document.querySelector("#multiPromptVideo")?.checked === true;
    const enabled = document.querySelector("#chainVideoFromPrevious")?.checked === true;
    const option = document.querySelector("#videoChainOption");
    const hint = document.querySelector("#videoChainHint");
    const label = document.querySelector("#videoChainLabel");
    if (option) option.hidden = !multiPrompt;
    if (hint) {
      hint.hidden = !multiPrompt || !enabled;
      hint.textContent = t("sidebar.videoChainHint");
    }
    if (label) label.textContent = t("sidebar.videoChainToggle");
    if (enabled && !lastVideoChainEnabled) {
      const model = document.querySelector("#selectModelVideo")?.value;
      rememberVideoQuantity(model, getFlowModelRule("video", model), document.querySelector("#selectCountVideo")?.value);
    }
    applyVideoChainQuantityState(enabled, !enabled && lastVideoChainEnabled);
    lastVideoChainEnabled = enabled;
    if (enabled && document.querySelector("#selectModeVideo")?.value === "frames") renderVideoFrameAssignments();
  }

  function normalizeModelValue(value) {
    return String(value || "").normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
  }

  function isTieredVeo31Model(value) {
    const normalized = normalizeModelValue(value).replace(/[^\p{L}\p{N}.]+/gu, " ").replace(/\s+/g, " ").trim();
    return /^veo\s+3\.1(?:\s|$)/.test(normalized) && /\b(lite|fast|quality)\b/.test(normalized);
  }

  function getFlowModelRule(type, model) {
    const normalized = normalizeModelValue(model);
    const tieredVeo31 = isTieredVeo31Model(normalized);
    return flowModelCapabilities?.models?.find(rule => rule.types?.includes(type) && rule.match?.some(alias => {
      const normalizedAlias = normalizeModelValue(alias);
      if (tieredVeo31 && normalizedAlias === "veo 3.1") return false;
      return normalized.includes(normalizedAlias);
    })) || null;
  }

  function getValidVideoQuantities(rule) {
    if (!Array.isArray(rule?.quantities)) return [];
    return [...new Set(rule.quantities.map(Number).filter(value => Number.isInteger(value) && value >= 1 && value <= 4))];
  }

  function getVideoQuantity(rule, selectedValue) {
    const quantities = getValidVideoQuantities(rule);
    const selected = Number(selectedValue);
    if (quantities.includes(selected)) return selected;
    const defaultQuantity = Number(rule?.defaultQuantity);
    if (quantities.includes(defaultQuantity)) return defaultQuantity;
    return 1;
  }

  function rememberVideoQuantity(model, rule, value) {
    if (!model) return false;
    const quantity = Number(value);
    if (!getValidVideoQuantities(rule).includes(quantity)) return false;
    const remembered = flowVideoModelSelections.get(model) || {};
    flowVideoModelSelections.set(model, { ...remembered, quantity });
    return true;
  }

  function getValidVideoQuantitySelection(rule, preferredValue) {
    const quantities = getValidVideoQuantities(rule);
    const preferred = Number(preferredValue);
    if (quantities.includes(preferred)) return preferred;
    const defaultQuantity = Number(rule?.defaultQuantity);
    if (quantities.includes(defaultQuantity)) return defaultQuantity;
    return quantities.includes(1) ? 1 : (quantities[0] ?? 1);
  }

  function applyVideoChainQuantityState(enabled, restoreSelection = false) {
    const quantitySelect = document.querySelector("#selectCountVideo");
    if (!quantitySelect) return;
    const model = document.querySelector("#selectModelVideo")?.value;
    const rule = getFlowModelRule("video", model);
    const quantities = getValidVideoQuantities(rule);
    if (enabled) {
      quantitySelect.value = quantities.includes(1) ? "1" : "";
      quantitySelect.disabled = true;
      return;
    }
    if (restoreSelection && quantities.length) {
      const remembered = flowVideoModelSelections.get(model)?.quantity;
      const restored = getValidVideoQuantitySelection(rule, remembered ?? rule?.defaultQuantity ?? 1);
      quantitySelect.value = String(restored);
    } else if (!quantities.length) {
      quantitySelect.value = "";
    }
    quantitySelect.disabled = quantities.length === 0;
  }

  function replaceSelectOptions(select, values, labelForValue, preferredValue, preferPreferredValue = false) {
    if (!select) return "";
    const previous = select.value;
    select.replaceChildren();
    for (const value of values) {
      const option = document.createElement("option");
      option.value = String(value);
      option.textContent = labelForValue(value);
      select.appendChild(option);
    }
    const allowed = values.map(String);
    const selected = preferPreferredValue && allowed.includes(String(preferredValue)) ? String(preferredValue)
      : allowed.includes(previous) ? previous
        : allowed.includes(String(preferredValue)) ? String(preferredValue)
        : (allowed[0] || "");
    select.value = selected;
    return selected;
  }

  function applyFlowModelControls() {
    const registry = flowModelCapabilities;
    if (!registry) return;
    const locale = typeof I18n !== "undefined" ? I18n.getLocale() : "vi";
    for (const type of ["image", "video"]) {
      const select = document.querySelector(type === "image" ? "#selectModelImage" : "#selectModelVideo");
      const tobySelect = document.querySelector(type === "image" ? "#imageModel" : "#videoModel");
      const models = registry.uiModels?.[type];
      if (!Array.isArray(models) || !models.length) continue;
      const previous = select?.value || tobySelect?.value || "";
      if (select) select.replaceChildren();
      if (tobySelect) tobySelect.replaceChildren();
      for (const model of models) {
        if (!model?.value) continue;
        const opt = document.createElement("option");
        opt.value = String(model.value);
        opt.textContent = String(model.labels?.[locale] || model.label || model.value);
        if (select) select.appendChild(opt);
        if (tobySelect) tobySelect.appendChild(opt.cloneNode(true));
      }
      const chosen = models.some(model => String(model.value) === previous)
        ? previous : String(models[0]?.value || "");
      if (select) select.value = chosen;
      if (tobySelect) tobySelect.value = chosen;
    }

    const imageModel = document.querySelector("#selectModelImage")?.value;
    const imageRule = getFlowModelRule("image", imageModel);
    if (imageRule?.aspectRatios?.length) {
      replaceSelectOptions(document.querySelector("#selectRatioImage"), imageRule.aspectRatios, value => value, "9:16");
      replaceSelectOptions(document.querySelector("#aspectRatio"), imageRule.aspectRatios, value => value, "9:16");
    }

    const videoModelSelect = document.querySelector("#selectModelVideo");
    const videoModel = videoModelSelect?.value;
    const durationSelect = document.querySelector("#selectDurationVideo");
    const tobyDurationSelect = document.querySelector("#flowVideoDuration");
    const resolutionSelect = document.querySelector("#selectResolutionVideo");
    const tobyResolutionSelect = document.querySelector("#flowVideoResolution");
    const ratioSelect = document.querySelector("#selectRatioVideo");
    const quantitySelect = document.querySelector("#selectCountVideo");
    const chainEnabled = document.querySelector("#chainVideoFromPrevious")?.checked === true;
    const videoModelChanged = Boolean(lastFlowVideoModel && lastFlowVideoModel !== videoModel);
    if (videoModelChanged) {
      const previousSelection = flowVideoModelSelections.get(lastFlowVideoModel) || {};
      flowVideoModelSelections.set(lastFlowVideoModel, {
        ...previousSelection,
        duration: durationSelect?.value,
        resolution: resolutionSelect?.value,
        aspectRatio: ratioSelect?.value,
      });
      if (!chainEnabled) rememberVideoQuantity(lastFlowVideoModel, getFlowModelRule("video", lastFlowVideoModel), quantitySelect?.value);
    }
    const rememberedSelection = videoModelChanged ? (flowVideoModelSelections.get(videoModel) || {}) : {};
    lastFlowVideoModel = videoModel || null;
    const videoRule = getFlowModelRule("video", videoModel);
    if (!videoRule) return;
    const durationGroup = document.querySelector("#videoDurationGroup");
    const durationLabel = document.querySelector("#lblDurationVideo");
    const fixedDuration = Number.isFinite(Number(videoRule.fixedDuration)) ? Number(videoRule.fixedDuration) : null;
    const durations = fixedDuration !== null ? [fixedDuration] : (videoRule.durations || []);
    const durationDefault = fixedDuration ?? videoRule.defaultDuration ?? durations[0];
    if (durationGroup) durationGroup.hidden = !durations.length;
    if (durationLabel) durationLabel.textContent = fixedDuration !== null
      ? `${t("sidebar.videoDurationFixed", { seconds: fixedDuration })}:`
      : `${t("sidebar.videoDuration")}:`;
    replaceSelectOptions(durationSelect, durations, value => `${value} ${locale === "en" ? "seconds" : "giây"}`, rememberedSelection.duration ?? durationDefault, videoModelChanged);
    replaceSelectOptions(tobyDurationSelect, durations, value => `${value}s`, rememberedSelection.duration ?? durationDefault, videoModelChanged);
    if (durationSelect) durationSelect.disabled = fixedDuration !== null;
    if (tobyDurationSelect) tobyDurationSelect.disabled = fixedDuration !== null;

    const resolutionGroup = document.querySelector("#videoResolutionGroup");
    const resolutions = Array.isArray(videoRule.resolutions) ? videoRule.resolutions : [];
    if (resolutionGroup) resolutionGroup.hidden = resolutions.length === 0;
    if (resolutionGroup && !resolutions.length) {
      resolutionGroup.querySelector("#lblResolutionVideo").textContent = `${t("sidebar.videoResolution")}:`;
    }
    replaceSelectOptions(resolutionSelect, resolutions, value => String(value), rememberedSelection.resolution ?? videoRule.defaultResolution, videoModelChanged);
    replaceSelectOptions(tobyResolutionSelect, resolutions, value => String(value), rememberedSelection.resolution ?? videoRule.defaultResolution, videoModelChanged);
    if (resolutionSelect) resolutionSelect.disabled = resolutions.length === 0;
    if (tobyResolutionSelect) tobyResolutionSelect.disabled = resolutions.length === 0;

    const quantityGroup = document.querySelector("#videoCountGroup");
    const quantities = getValidVideoQuantities(videoRule);
    if (quantityGroup) quantityGroup.hidden = quantities.length === 0;
    const quantityDefault = getValidVideoQuantitySelection(videoRule, rememberedSelection.quantity ?? videoRule.defaultQuantity);
    replaceSelectOptions(quantitySelect, quantities, value => String(value), quantityDefault, videoModelChanged);

    if (videoRule.aspectRatios?.length) {
      replaceSelectOptions(ratioSelect, videoRule.aspectRatios, value => value, rememberedSelection.aspectRatio ?? "9:16", videoModelChanged);
      replaceSelectOptions(document.querySelector("#aspectRatio"), videoRule.aspectRatios, value => value, rememberedSelection.aspectRatio ?? "9:16", videoModelChanged);
    }
    const framesOption = document.querySelector('#selectModeVideo option[value="frames"]');
    const compactFramesOption = document.querySelector('#videoInputType option[value="frames"]');
    if (framesOption) {
      framesOption.disabled = videoRule.supportsFrames !== true;
      if (compactFramesOption) compactFramesOption.disabled = framesOption.disabled;
      if (framesOption.disabled && document.querySelector("#selectModeVideo")?.value === "frames") {
        document.querySelector("#selectModeVideo").value = "ingredients";
        const compactMode = document.querySelector("#videoInputType");
        if (compactMode) compactMode.value = "ingredients";
        updateVideoFrameInputs();
      }
    }
    updateVideoChainUI();
  }

  async function loadFlowModelCapabilities() {
    if (flowModelCapabilities) return flowModelCapabilities;
    if (!flowModelCapabilitiesPromise) {
      flowModelCapabilitiesPromise = fetch(chrome.runtime.getURL("flow-model-capabilities.json"))
        .then(response => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.json();
        })
        .then(registry => {
          if (!Array.isArray(registry?.models) || !registry?.uiModels) throw new Error("The local model capability file is invalid.");
          flowModelCapabilities = registry;
          applyFlowModelControls();
          return registry;
        })
        .catch(error => {
          flowModelCapabilitiesPromise = null;
          console.warn("[Flow UI] local model capabilities could not be loaded:", error?.message || error);
          return null;
        });
    }
    return flowModelCapabilitiesPromise;
  }

  function setText(selector, text) {
    const el = document.querySelector(selector);
    if (el) el.textContent = text;
  }

  function setPlaceholder(selector, text) {
    const el = document.querySelector(selector);
    if (el) el.placeholder = text;
  }

  function applyLanguage() {
    const cur = typeof I18n !== "undefined" ? I18n.getLocale() : "vi";
    document.documentElement.lang = cur;
    if (typeof I18n !== "undefined") I18n.applyTranslations(document);
    flowQueuePanel?.setLocale?.(cur);
    setText("#langSwitchLabel", cur.toUpperCase());

    // Tabs
    setText("#tabCreateLabel", t("sidebar.tabGen"));
    setText("#tabPromptsLabel", t("sidebar.tabPrompts"));
    setText("#tabLibraryLabel", t("sidebar.tabLibrary"));
    setText("#tabTasksLabel", t("sidebar.tabTasks"));
    setText("#tabHistoryLabel", t("sidebar.tabHistory"));
    setText("#tabStatusLabel", t("sidebar.tabStatus"));
    setText("#tabLogsLabel", t("sidebar.tabLogs"));
    setText("#tabSettingsLabel", t("sidebar.tabSettings"));
    for (const [id, key] of [
      ["viewCreateTitle", "viewCreateTitle"], ["viewCreateSubtitle", "viewCreateSubtitle"],
      ["viewPromptsTitle", "viewPromptsTitle"], ["viewPromptsSubtitle", "viewPromptsSubtitle"],
      ["viewLibraryTitle", "viewLibraryTitle"], ["viewLibrarySubtitle", "viewLibrarySubtitle"],
      ["viewTasksTitle", "viewTasksTitle"], ["viewTasksSubtitle", "viewTasksSubtitle"],
      ["viewHistoryTitle", "viewHistoryTitle"], ["viewHistorySubtitle", "viewHistorySubtitle"],
      ["viewStatusTitle", "viewStatusTitle"], ["viewStatusSubtitle", "viewStatusSubtitle"],
      ["viewLogsTitle", "viewLogsTitle"], ["viewLogsSubtitle", "viewLogsSubtitle"],
      ["viewSettingsTitle", "viewSettingsTitle"], ["viewSettingsSubtitle", "viewSettingsSubtitle"],
    ]) setText(`#${id}`, t(`sidebar.${key}`));

    setText("#lblPromptName", t("sidebar.promptName"));
    setText("#lblPromptDraft", t("sidebar.promptLabel"));
    setPlaceholder("#promptDraft", t("sidebar.promptPlaceholder"));
    setPlaceholder("#promptName", t("sidebar.promptNamePlaceholder"));
    setText("#txtSavePrompt", t("sidebar.promptSave"));
    setText("#btnRefreshHistory", t("sidebar.historyRefresh"));
    setText("#btnClearHistory", t("sidebar.historyClear"));
    setText("#savedPromptsEmpty", t("sidebar.promptEmpty"));
    setText("#flowHistoryEmpty", t("sidebar.historyEmpty"));
    setText("#flowHistoryActivity", t("sidebar.historyActivity"));

    // Form Image
    setText("#lblPromptImage", t("sidebar.promptLabel") + ":");
    setPlaceholder("#inputPromptImage", t("sidebar.promptPlaceholder"));
    setText("#lblRatioImage", t("sidebar.aspectRatio") + ":");
    setText("#lblModelImage", t("sidebar.imageModel") + ":");
    setText("#lblQtyImage", t("sidebar.quantity") + ":");
    setText("#lblCharImage", t("sidebar.characterSelect") + ":");
    setText("#btnImportPromptsImage", t("sidebar.multiPromptImport"));
    setText("#promptBatchHintImage", t("sidebar.multiPromptHint"));
    setText("#txtBtnSubmitImage", t("sidebar.btnGenerateImage"));

    // Form Video
    setText("#lblPromptVideo", t("sidebar.promptLabel") + ":");
    setPlaceholder("#inputPromptVideo", t("sidebar.promptPlaceholderVideo"));
    setText("#btnImportPromptsVideo", t("sidebar.multiPromptImport"));
    setText("#promptBatchHintVideo", t("sidebar.multiPromptHint"));
    setText("#lblRatioVideo", t("sidebar.aspectRatio") + ":");
    setText("#lblDurationVideo", t("sidebar.videoDuration") + ":");
    setText("#lblModelVideo", t("sidebar.videoModel") + ":");
    setText("#lblQtyVideo", t("sidebar.quantity") + ":");
    setText("#lblResolutionVideo", t("sidebar.videoResolution") + ":");
    setText("#lblModeVideo", t("sidebar.videoMode") + ":");
    setText("#lblCharVideo", t("sidebar.characterSelect") + ":");
    setText("#videoFrameNamesHint", t("sidebar.videoFrameNamesHint"));
    updateVideoChainUI();
    renderVideoFrameSources();
    renderVideoFrameAssignments();
    updateVideoFrameInputs();
    applyFlowModelControls();
    setText("#txtBtnSubmitVideo", t("sidebar.btnGenerateVideo"));
    updatePromptFormFeedback("image");
    updatePromptFormFeedback("video");

    // Form Character
    setText("#lblCharName", t("sidebar.charNameLabel") + ":");
    setPlaceholder("#inputCharName", t("sidebar.charNamePlaceholder"));
    setText("#lblCharDesc", t("sidebar.charDescLabel") + ":");
    setPlaceholder("#inputCharDesc", t("sidebar.charDescPlaceholder"));
    setText("#txtBtnSubmitChar", t("sidebar.btnCreateCharacter"));

    // Status pane
    setText("#lblFlowTabs", t("popup.flowTabs"));
    setText("#lblSelectedTab", t("popup.selectedTab"));
    setText("#lblQuickActions", t("sidebar.quickActions"));
    setText("#txtBtnReconnect", t("sidebar.btnReconnect"));
    setText("#txtBtnPreview", t("sidebar.btnPreview"));
    setText("#txtBtnOpenFlow", t("sidebar.btnOpenFlow"));

    // Logs pane
    setText("#lblLogsTitle", t("sidebar.tabLogs"));
    setText("#btnClearLogs", t("sidebar.clearLogs"));
    const emptyEl = document.querySelector("#logsEmpty");
    if (emptyEl) emptyEl.textContent = t("sidebar.logsEmpty");

    // Settings pane
    setText("#txtSaveSettings", t("sidebar.saveSettings"));

    if (cachedStatus) renderStatus(cachedStatus);
    else setText("#wsText", t("popup.checking"));
    renderSavedPrompts();
    renderHistory();
  }

  function renderStatus(s) {
    cachedStatus = s;
    const wsBadge = document.querySelector("#wsBadge");
    const wsText = document.querySelector("#wsText");
    const valFlowTabs = document.querySelector("#valFlowTabs");
    const valSelectedTab = document.querySelector("#valSelectedTab");
    const bridgeSummary = document.querySelector("#bridgeSummary");

    if (s.wsConnected) {
      wsBadge.className = "status-badge connected";
      wsText.textContent = t("popup.wsConnected");
    } else {
      wsBadge.className = "status-badge disconnected";
      wsText.textContent = t("popup.wsDisconnected");
    }

    const count = s.flowTabs ?? 0;
    valFlowTabs.textContent = count > 0 ? t("popup.tabsCount", count) : t("popup.tabsNone");
    valSelectedTab.textContent = s.selectedTabId ? `Tab #${s.selectedTabId}` : t("popup.tabNone");

    if (s.bridge) {
      try {
        const u = new URL(s.bridge);
        bridgeSummary.textContent = u.host || s.bridge;
      } catch {
        bridgeSummary.textContent = s.bridge;
      }
      const bridgeInput = document.querySelector("#inputBridgeUrl");
      if (bridgeInput && !bridgeInput.matches(":focus")) {
        bridgeInput.value = s.bridge;
      }
    }
  }

  function setFeedback(msg, isSuccess = true) {
    const el = document.querySelector("#feedbackBox");
    if (!el) return;
    el.textContent = msg;
    el.style.color = isSuccess ? "#4ade80" : "#f87171";
  }

  async function readUiStorage(key, fallback) {
    try {
      const value = await chrome.storage.local.get(key);
      return value?.[key] ?? fallback;
    } catch {
      return fallback;
    }
  }

  async function writeUiStorage(key, value) {
    try { await chrome.storage.local.set({ [key]: value }); } catch (_) {}
  }

  function escapeHtml(value) {
    const div = document.createElement("div");
    div.textContent = String(value ?? "");
    return div.innerHTML;
  }

  function renderHistory() {
    const list = document.querySelector("#flowHistoryList");
    const empty = document.querySelector("#flowHistoryEmpty");
    if (!list || !empty) return;
    list.replaceChildren();
    empty.hidden = localUiHistory.length > 0;
    for (const item of localUiHistory.slice(0, 80)) {
      const row = document.createElement("article");
      row.className = "flow-history-item";
      row.innerHTML = `<div class="flow-history-item__body"><div class="flow-history-item__title">${escapeHtml(item.name)}</div><div class="flow-history-item__detail">${escapeHtml(item.detail)}</div></div><time class="flow-history-item__time">${escapeHtml(item.time)}</time>`;
      list.appendChild(row);
    }
  }

  async function recordUiHistory(name, detail) {
    localUiHistory.unshift({ name, detail, time: new Date().toLocaleString() });
    localUiHistory = localUiHistory.slice(0, 80);
    await writeUiStorage(UI_HISTORY_KEY, localUiHistory);
    renderHistory();
  }

  function renderSavedPrompts() {
    const list = document.querySelector("#savedPromptsList");
    const empty = document.querySelector("#savedPromptsEmpty");
    if (!list || !empty) return;
    list.replaceChildren();
    empty.hidden = savedPrompts.length > 0;
    for (const item of savedPrompts) {
      const row = document.createElement("article");
      row.className = "flow-saved-prompt";
      row.innerHTML = `<div class="flow-saved-prompt__body"><div class="flow-saved-prompt__title">${escapeHtml(item.name)}</div><div class="flow-saved-prompt__text">${escapeHtml(item.prompt)}</div></div><div class="flow-saved-prompt__actions"><button type="button" class="btn btn-secondary" data-prompt-use="${escapeHtml(item.id)}">${escapeHtml(t("sidebar.promptUse"))}</button><button type="button" class="btn btn-secondary" data-prompt-delete="${escapeHtml(item.id)}">${escapeHtml(t("sidebar.promptDelete"))}</button></div>`;
      list.appendChild(row);
    }
  }

  async function loadLocalUiState() {
    const history = await readUiStorage(UI_HISTORY_KEY, []);
    const prompts = await readUiStorage(SAVED_PROMPTS_KEY, []);
    localUiHistory = Array.isArray(history) ? history : [];
    savedPrompts = Array.isArray(prompts) ? prompts : [];
    renderHistory();
    renderSavedPrompts();
  }

  function addLog(name, detail, isOk = true) {
    const container = document.querySelector("#logsContainer");
    const empty = document.querySelector("#logsEmpty");
    if (empty) empty.style.display = "none";

    const time = new Date().toLocaleTimeString();
    const entry = document.createElement("div");
    entry.className = `log-entry ${isOk ? "ok" : "error"}`;
    entry.innerHTML = `
      <div class="log-head">
        <span>${name}</span>
        <span class="log-time">${time}</span>
      </div>
      <div class="log-detail">${detail}</div>
    `;
    container.insertBefore(entry, container.firstChild);
    logs.push({ name, detail, isOk, time });
    void recordUiHistory(name, detail);
  }

  async function fetchStatus() {
    try {
      const s = await chrome.runtime.sendMessage({ type: "flow-mcp:status" });
      if (s) renderStatus(s);
    } catch (err) {
      renderStatus({
        wsConnected: false,
        flowTabs: 0,
        selectedTabId: null,
        bridge: "http://127.0.0.1:18899",
        error: err.message
      });
    }
  }

  async function loadFlowCharacters() {
    try {
      const res = await chrome.runtime.sendMessage({
        type: "flow-mcp:dispatch",
        operation: "flow.characters.list",
        payload: {}
      });
      if (res?.ok && Array.isArray(res.value)) {
        currentCharacters = res.value;
        populateCharacterSelects();
      }
    } catch (_) {}
  }

  function findCharacterMentionInPrompt(promptText, characters) {
    if (!promptText || !Array.isArray(characters) || !characters.length) return null;
    const pattern = /@(?:\[([^\]]+)\]|([\p{L}\p{N}_]+))/gu;
    const normalize = val => String(val || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[đĐ]/g, "d").trim().toLowerCase();

    const charMap = new Map();
    for (const c of characters) {
      const name = typeof c === "string" ? c : c?.name;
      if (!name) continue;
      const key = normalize(name);
      charMap.set(key, c);
      charMap.set(key.replace(/_/g, " "), c);
      charMap.set(key.replace(/\s+/g, "_"), c);
    }

    let match;
    while ((match = pattern.exec(promptText)) !== null) {
      if (promptText[pattern.lastIndex] === ":") continue;
      const raw = String(match[1] || match[2] || "").trim();
      const key = normalize(raw);
      const found = charMap.get(key) || charMap.get(key.replace(/_/g, " ")) || charMap.get(key.replace(/\s+/g, "_"));
      if (found) {
        const name = typeof found === "string" ? found : found.name;
        const uuid = typeof found === "object" && typeof found.uuid === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(found.uuid.trim())
          ? found.uuid.trim().toLowerCase() : "";
        return {
          name,
          attachment: {
            assetName: `character:${name}`,
            kind: "character",
            ...(uuid ? { expectedId: uuid } : {}),
          },
        };
      }
    }
    return null;
  }

  function updateCharacterUiState(charObj) {
    const label = document.querySelector("#genCharacterLabel");
    const thumb = document.querySelector("#genCharacterTriggerThumb");
    const genSelect = document.querySelector("#genCharacterSelect");
    const imgSelect = document.querySelector("#selectCharImage");
    const vidSelect = document.querySelector("#selectCharVideo");
    if (!label) return;

    if (!charObj) {
      label.textContent = t("character.none") || "Character";
      if (thumb) {
        thumb.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"></circle><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"></path></svg>`;
      }
      if (genSelect) genSelect.value = "";
      if (imgSelect) imgSelect.value = "";
      if (vidSelect) vidSelect.value = "";
      return;
    }

    const name = typeof charObj === "string" ? charObj : charObj.name;
    const uuid = typeof charObj === "object" && charObj.uuid ? charObj.uuid.toLowerCase() : "";
    const val = uuid ? `flow-character:${uuid}` : `flow-character-name:${name}`;

    label.textContent = name;
    const avatar = typeof charObj === "object" ? (charObj.avatarUrl || charObj.thumbnailUrl || charObj.image) : null;
    if (thumb) {
      if (avatar && typeof avatar === "string" && avatar.startsWith("http")) {
        thumb.innerHTML = `<img src="${avatar}" style="width:14px;height:14px;border-radius:50%;object-fit:cover;" alt="" />`;
      } else {
        thumb.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"></circle><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"></path></svg>`;
      }
    }
    if (genSelect) genSelect.value = val;
    if (imgSelect) imgSelect.value = val;
    if (vidSelect) vidSelect.value = val;
  }

  function updateVoiceUiState(voiceName) {
    const label = document.querySelector("#genVideoVoiceLabel");
    const genVoiceSelect = document.querySelector("#genVideoVoiceSelect");
    const flowVoiceSelect = document.querySelector("#flowVoiceSelect");
    const name = String(voiceName || "").trim();
    if (label) label.textContent = name || (t("voice.random") || "Random voice");
    if (genVoiceSelect) genVoiceSelect.value = name;
    if (flowVoiceSelect) flowVoiceSelect.value = name;
  }

  function populateCharacterSelects() {
    const selects = [document.querySelector("#selectCharImage"), document.querySelector("#selectCharVideo"), document.querySelector("#genCharacterSelect")].filter(Boolean);
    selects.forEach(sel => {
      if (sel.tagName === "INPUT") return;
      const currentVal = sel.value;
      const currentName = sel.selectedOptions?.[0]?.dataset?.characterName || sel.selectedOptions?.[0]?.textContent?.replace(/^👤\s*/, "").trim() || "";
      const restoreLegacyName = Boolean(currentVal && !currentVal.startsWith("flow-character:") && !currentVal.startsWith("flow-character-name:") && currentName);
      let legacySelectionRestored = false;
      sel.innerHTML = `<option value="">${t("sidebar.characterNone")}</option>`;
      currentCharacters.forEach(c => {
        const name = typeof c === "string" ? c : c.name;
        if (!name) return;
        const opt = document.createElement("option");
        const uuid = typeof c === "object" && typeof c.uuid === "string" ? c.uuid.trim().toLowerCase() : "";
        // Preserve the selected Flow character entity, not just its display
        // name. Names can be duplicated or renamed between list refreshes.
        opt.value = uuid ? `flow-character:${uuid}` : `flow-character-name:${name}`;
        opt.dataset.characterName = name;
        if (uuid) opt.dataset.characterUuid = uuid;
        opt.textContent = `👤 ${name}`;
        const restoreByIdentity = opt.value === currentVal;
        const restoreByLegacyName = restoreLegacyName && !legacySelectionRestored && name === currentName;
        if (restoreByIdentity || restoreByLegacyName) {
          opt.selected = true;
          if (restoreByLegacyName) legacySelectionRestored = true;
        }
        sel.appendChild(opt);
      });
    });

    // Sync UI trigger state with current selection
    const activeVal = document.querySelector("#genCharacterSelect")?.value || document.querySelector("#selectCharVideo")?.value || document.querySelector("#selectCharImage")?.value || "";
    if (activeVal) {
      const found = currentCharacters.find(c => {
        const u = c?.uuid ? `flow-character:${c.uuid.toLowerCase()}` : `flow-character-name:${c?.name}`;
        return u === activeVal || c?.name === activeVal;
      });
      if (found) updateCharacterUiState(found);
    }
  }

  function selectedFlowCharacter(select) {
    const sel = select || document.querySelector("#genCharacterSelect") || document.querySelector("#selectCharVideo") || document.querySelector("#selectCharImage");
    if (!sel) return null;
    let name = "";
    let uuid = "";
    if (sel.tagName === "INPUT") {
      const val = sel.value || "";
      if (val.startsWith("flow-character:")) {
        uuid = val.replace("flow-character:", "").trim();
        const found = currentCharacters.find(c => typeof c === "object" && c?.uuid?.toLowerCase() === uuid.toLowerCase());
        name = found?.name || "";
      } else if (val.startsWith("flow-character-name:")) {
        name = val.replace("flow-character-name:", "").trim();
      } else if (val) {
        name = val;
      }
    } else {
      const option = sel.selectedOptions?.[0];
      name = String(option?.dataset?.characterName || "").trim();
      if (!name && option?.value && !option.value.startsWith("flow-character")) {
        name = option.textContent?.replace(/^👤\s*/, "").trim();
      }
      const id = String(option?.dataset?.characterUuid || "").trim();
      uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) ? id.toLowerCase() : "";
      if (!uuid && option?.value?.startsWith?.("flow-character:")) {
        const parsed = option.value.replace("flow-character:", "").trim();
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed)) uuid = parsed.toLowerCase();
      }
    }
    if (!name || (sel.tagName !== "INPUT" && !sel.value)) return null;
    return {
      name,
      attachment: {
        assetName: `character:${name}`,
        kind: "character",
        ...(uuid ? { expectedId: uuid } : {}),
      },
    };
  }

  document.querySelector("#flowVoiceSelect")?.addEventListener("change", event => {
    updateVoiceUiState(event.target.value);
  });

  // Toby-style views with roving focus for keyboard users.
  const tabs = [...document.querySelectorAll(".tobyflow-tab")];
  const activateTab = tab => {
      if (!tab) return;
      document.querySelectorAll(".tobyflow-tab").forEach(t => t.classList.remove("active"));
      document.querySelectorAll(".tab-pane").forEach(p => p.classList.remove("active"));
      tab.classList.add("active");
      tabs.forEach(t => {
        const selected = t === tab;
        t.setAttribute("aria-selected", String(selected));
        t.tabIndex = selected ? 0 : -1;
      });
      const targetId = tab.getAttribute("data-tab");
      document.getElementById(targetId)?.classList.add("active");
      if ((targetId === "tab-library" || targetId === "tab-photos") && !flowPhotosScanned) {
        void runLibraryAction(null, refreshFlowPhotos);
      }
  };
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => activateTab(tab));
    tab.addEventListener("keydown", event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
        : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      tabs[nextIndex].focus();
      activateTab(tabs[nextIndex]);
    });
  });

  document.querySelector("#btnSavePrompt")?.addEventListener("click", async () => {
    const name = document.querySelector("#promptName")?.value.trim();
    const prompt = document.querySelector("#promptDraft")?.value.trim();
    if (!prompt) { setFeedback(t("sidebar.promptSaveError"), false); return; }
    const item = { id: crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`, name: name || prompt.slice(0, 36), prompt, createdAt: Date.now() };
    savedPrompts = [item, ...savedPrompts.filter(existing => existing.prompt !== prompt)].slice(0, 100);
    await writeUiStorage(SAVED_PROMPTS_KEY, savedPrompts);
    renderSavedPrompts();
    setFeedback(t("sidebar.promptSaved"), true);
    addLog("flow.prompt.save", item.name, true);
    document.querySelector("#promptName").value = "";
    document.querySelector("#promptDraft").value = "";
  });

  document.querySelector("#savedPromptsList")?.addEventListener("click", async event => {
    const useId = event.target.closest("[data-prompt-use]")?.dataset.promptUse;
    const deleteId = event.target.closest("[data-prompt-delete]")?.dataset.promptDelete;
    if (useId) {
      const item = savedPrompts.find(prompt => prompt.id === useId);
      if (item) {
        const editor = document.querySelector("#promptsArea");
        if (editor) {
          editor.value = item.prompt;
          editor.dispatchEvent(new Event("input", { bubbles: true }));
        }
        document.querySelector("#navGen")?.click();
        setFeedback(t("sidebar.promptUse"), true);
      }
      return;
    }
    if (deleteId) {
      savedPrompts = savedPrompts.filter(prompt => prompt.id !== deleteId);
      await writeUiStorage(SAVED_PROMPTS_KEY, savedPrompts);
      renderSavedPrompts();
    }
  });

  document.querySelector("#btnRefreshHistory")?.addEventListener("click", () => { renderHistory(); void loadLocalUiState(); });
  document.querySelector("#btnClearHistory")?.addEventListener("click", async () => { localUiHistory = []; await writeUiStorage(UI_HISTORY_KEY, []); renderHistory(); });

  let isGenerating = false;
  let flowQueuePanel = null;
  const submittedQueueJobIds = new Set();
  const handledFinishedQueueJobIds = new Set();

  function rememberSubmittedQueueJob(result) {
    const id = result?.job?.id;
    if (id) submittedQueueJobIds.add(String(id));
    for (const job of Array.isArray(result?.addedJobs) ? result.addedJobs : []) {
      if (job?.id) submittedQueueJobIds.add(String(job.id));
    }
  }

  function queueJobType(job) {
    const payload = job?.payload || job?.data?.payload || {};
    const params = payload?.params || {};
    const raw = String(payload?.type || params?.type || job?.operation || "").toLowerCase();
    if (raw.includes("video") || raw.includes("edit") || raw.includes("continue")) return "video";
    if (raw.includes("character")) return "character";
    return "image";
  }

  // Listen for real-time progress broadcast from background/Flow
  chrome.runtime.onMessage.addListener(msg => {
    if (msg?.type === "flow-queue:changed") {
      const jobs = msg.snapshot?.jobs || msg.snapshot?.items || [];
      const active = jobs.find(job => job.status === "running");
      if (active?.progress?.message) setFeedback(`⏳ ${active.progress.message}`, true);
      if (msg.reason === "job-finished") {
        const finished = [...jobs]
          .filter(job => submittedQueueJobIds.has(String(job.id))
            && !handledFinishedQueueJobIds.has(String(job.id))
            && (job.status === "completed" || job.status === "failed"))
          .sort((a, b) => Number(a.finishedAt || 0) - Number(b.finishedAt || 0))
          .pop();
        if (finished) handledFinishedQueueJobIds.add(String(finished.id));
        if (finished?.status === "completed") {
          const isCharacter = finished.operation === "flow.character.create" || finished.operation === "flow.character.edit";
          const type = queueJobType(finished);
          const result = finished.result?.result || finished.result || {};
          const downloads = Array.isArray(result?.browserDownloads)
            ? result.browserDownloads
            : Array.isArray(result?.result?.browserDownloads) ? result.result.browserDownloads : [];
          const downloadSummary = downloads.length
            ? ` Đã tải về ${downloads.length} tệp${downloads[0]?.filename ? `: ${String(downloads[0].filename).split(/[\\/]/).pop()}` : "."}`
            : "";
          setFeedback(isCharacter
            ? "✅ Đã hoàn tất thao tác nhân vật trong Flow."
            : `✅ ${type === "video" ? "Tạo video" : "Tạo ảnh"} thành công.${downloadSummary}`, true);
          addLog(isCharacter ? "flow.character.create" : "flow.operation.complete", finished.label || finished.name || "Flow job", true);
          if (isCharacter) void loadFlowCharacters();
        } else if (finished?.status === "failed") {
          setFeedback(`❌ ${finished.error || "Tác vụ Flow thất bại."}`, false);
          addLog("flow.generation.failed", finished.error || "Flow job failed", false);
        }
      }
      return;
    }
    if (msg?.type === "flow-mcp:progress-broadcast" && msg.progress) {
      setFeedback(`⏳ ${msg.progress}`, true);
      addLog("Tiến trình", msg.progress, true);
      if (isGenerating) {
        const isImage = document.querySelector("#formImage")?.style.display !== "none";
        const btnTextEl = isImage
          ? document.querySelector("#txtBtnSubmitImage")
          : document.querySelector("#txtBtnSubmitVideo");
        if (btnTextEl) btnTextEl.textContent = msg.progress;
      }
    }
  });

  async function executeGenerationTask({ type, prompt, prompts, aspect_ratio, count = 1, model, attachments = [], attachmentsPerPrompt, firstFramesPerPrompt, lastFramesPerPrompt, video_settings, chainVideo = false, btn, btnTextEl, defaultTextKey }) {
    if (isGenerating) {
      setFeedback("Đang có tác vụ đang chạy, vui lòng đợi!", false);
      return;
    }
    isGenerating = true;
    if (btn) btn.disabled = true;

    try {
      const promptList = Array.isArray(prompts) && prompts.length ? prompts : [prompt];
      chainVideo = type === "video" && chainVideo;
      const chainIds = chainVideo ? promptList.map(() => `flow-video-chain-${crypto.randomUUID()}`) : [];
      const jobs = promptList.map((itemPrompt, index) => {
        const itemAttachments = attachmentsPerPrompt?.[index] || attachments;
        const refMediaTypeMap = {};
        for (const att of itemAttachments) {
          if (att && typeof att === "object") {
            const key = att.assetName || att.id || att.expectedId;
            if (key && att.kind) {
              refMediaTypeMap[key] = att.kind;
              if (att.expectedId) refMediaTypeMap[att.expectedId] = att.kind;
              if (att.assetName) refMediaTypeMap[att.assetName.replace(/^(?:asset|character):/i, "")] = att.kind;
            }
          }
        }
        return {
          ...(chainVideo ? { id: chainIds[index] } : {}),
          ...(chainVideo && index > 0 ? { metadata: { dependsOnId: chainIds[index - 1], dependencyType: "chain_previous" } } : {}),
          operation: "flow.generation.submit",
          payload: {
            type,
            prompt: itemPrompt,
            ...(model ? { model } : {}),
            aspectRatio: aspect_ratio,
            aspect_ratio,
            variants: count,
            count,
            attachments: itemAttachments,
            ...(Object.keys(refMediaTypeMap).length > 0 ? { refMediaTypeMap } : {}),
            ...((!chainVideo || index === 0) && firstFramesPerPrompt?.[index] ? { firstFrame: typeof firstFramesPerPrompt[index] === "string" ? { assetName: firstFramesPerPrompt[index] } : firstFramesPerPrompt[index] } : {}),
            ...(!chainVideo && lastFramesPerPrompt?.[index] ? { lastFrame: typeof lastFramesPerPrompt[index] === "string" ? { assetName: lastFramesPerPrompt[index] } : lastFramesPerPrompt[index] } : {}),
            ...(video_settings || {})
          },
          label: `[${type.toUpperCase()}] ${itemPrompt.slice(0, 96)}`,
        };
      });
      const addResult = await chrome.runtime.sendMessage(jobs.length > 1
        ? { type: "flow-queue:add-batch", jobs, batchLabel: `${type === "video" ? "Video" : "Image"} batch` }
        : { type: "flow-queue:add", job: jobs[0] });
      if (!addResult?.ok) throw new Error(addResult?.error?.message || "Không thể thêm tác vụ vào hàng đợi Flow");
      rememberSubmittedQueueJob(addResult);
      setFeedback(t("sidebar.workflowQueued"), true);
      addLog("flow.queue.add", `${jobs.length > 1 ? t("sidebar.multiPromptQueued", { count: jobs.length }) : `[${type.toUpperCase()}] ${prompt.slice(0, 96)}`}`, true);
      return true;
    } catch (err) {
      setFeedback(`❌ ${err.message}`, false);
      addLog("flow.queue.error", err.message, false);
      return false;
    } finally {
      isGenerating = false;
      if (btn) btn.disabled = false;
      if (btnTextEl && defaultTextKey) btnTextEl.textContent = t(defaultTextKey);
    }
  }

  const referencePicker = window.createFlowReferencePicker({ dispatchFlowOperation, setFeedback });
  let videoFrameSources = referencePicker.getFrameSources();
  let videoFrameAssignments = [];
  let activeVideoFrameSlot = null;

  function currentVideoPromptsForFrames() {
    const prompt = document.querySelector("#inputPromptVideo")?.value.trim() || "";
    if (!prompt) return [];
    try { return promptsForGeneration(prompt, document.querySelector("#multiPromptVideo")?.checked === true); }
    catch { return []; }
  }

  function renderVideoFrameSources() {
    const grid = document.querySelector("#videoFrameSourceGrid");
    const summary = document.querySelector("#videoFrameSourceSummary");
    if (!grid) return;
    grid.replaceChildren();
    if (summary) summary.textContent = t("sidebar.frameSourceCount", { count: videoFrameSources.length });
    for (const source of videoFrameSources) {
      const card = document.createElement("div");
      card.className = "video-frame-source-card";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "video-frame-source";
      button.title = t("sidebar.frameAssignSourceTitle", { name: source.name || source.file?.name || "" });
      const imageUrl = source.source === "flow" ? source.thumbnailUrl : source.previewUrl;
      if (imageUrl) {
        const image = document.createElement("img");
        image.src = imageUrl;
        image.alt = "";
        image.loading = "lazy";
        image.onerror = () => image.remove();
        button.append(image);
      } else {
        const placeholder = document.createElement("span");
        placeholder.className = "video-frame-source__placeholder";
        placeholder.textContent = "▧";
        button.append(placeholder);
      }
      const name = document.createElement("span");
      name.className = "video-frame-source__name";
      name.textContent = source.name || source.file?.name || t("sidebar.frameImage");
      button.append(name);
      button.onclick = () => {
        if (!activeVideoFrameSlot || !videoFrameAssignments[activeVideoFrameSlot.index]) {
          setFeedback(t("sidebar.frameChooseSlot"), false);
          return;
        }
        videoFrameAssignments[activeVideoFrameSlot.index][activeVideoFrameSlot.key] = source;
        activeVideoFrameSlot = null;
        renderVideoFrameAssignments();
      };
      const actions = document.createElement("div");
      actions.className = "video-frame-source-actions";
      const makeSourceAction = (labelKey, symbol, action) => {
        const control = document.createElement("button");
        control.type = "button";
        control.className = "video-frame-source-action";
        control.title = t(labelKey);
        control.setAttribute("aria-label", t(labelKey));
        control.textContent = symbol;
        control.onclick = event => {
          event.stopPropagation();
          action();
        };
        return control;
      };
      const sourceIndex = videoFrameSources.indexOf(source);
      actions.append(
        makeSourceAction("sidebar.frameMoveSourceUp", "↑", () => {
          videoFrameSources = referencePicker.moveFrameSource(source, -1);
          renderVideoFrameSources();
        }),
        makeSourceAction("sidebar.frameMoveSourceDown", "↓", () => {
          videoFrameSources = referencePicker.moveFrameSource(source, 1);
          renderVideoFrameSources();
        }),
        makeSourceAction("sidebar.frameRemoveSource", "×", () => {
          videoFrameSources = referencePicker.removeFrameSource(source);
          videoFrameAssignments.forEach(assignment => {
            if (assignment.first === source) assignment.first = null;
            if (assignment.last === source) assignment.last = null;
          });
          renderVideoFrameSources();
          renderVideoFrameAssignments();
        }),
      );
      actions.children[0].disabled = sourceIndex <= 0;
      actions.children[1].disabled = sourceIndex < 0 || sourceIndex >= videoFrameSources.length - 1;
      card.append(button, actions);
      grid.append(card);
    }
  }

  function syncVideoFrameAssignmentCount() {
    const prompts = currentVideoPromptsForFrames();
    while (videoFrameAssignments.length < prompts.length) videoFrameAssignments.push({ first: null, last: null });
    if (activeVideoFrameSlot && activeVideoFrameSlot.index >= prompts.length) activeVideoFrameSlot = null;
    renderVideoFrameAssignments();
  }

  function renderVideoFrameAssignments() {
    const container = document.querySelector("#videoFrameAssignments");
    if (!container) return;
    const prompts = currentVideoPromptsForFrames();
    container.replaceChildren();
    while (videoFrameAssignments.length < prompts.length) videoFrameAssignments.push({ first: null, last: null });
    const chainVideo = document.querySelector("#chainVideoFromPrevious")?.checked === true &&
      document.querySelector("#selectModeVideo")?.value === "frames";
    prompts.forEach((prompt, index) => {
      if (chainVideo && index > 0) return;
      const row = document.createElement("section");
      row.className = "video-frame-assignment";
      const promptLabel = document.createElement("div");
      promptLabel.className = "video-frame-assignment__prompt";
      promptLabel.textContent = t("sidebar.framePromptLabel", { index: index + 1, prompt: prompt.replace(/\s+/g, " ").slice(0, 72) });
      const slots = document.createElement("div");
      slots.className = "video-frame-assignment__slots";
      const slotsToRender = chainVideo ? [["first", "sidebar.frameStart"]] : [["first", "sidebar.frameStart"], ["last", "sidebar.frameEnd"]];
      for (const [key, labelKey] of slotsToRender) {
        const wrap = document.createElement("div");
        wrap.className = "video-frame-slot-wrap";
        const source = videoFrameAssignments[index]?.[key] || null;
        const slot = document.createElement("button");
        slot.type = "button";
        slot.className = `video-frame-slot${activeVideoFrameSlot?.index === index && activeVideoFrameSlot?.key === key ? " is-active" : ""}`;
        slot.title = source?.name || source?.file?.name || t(labelKey);
        if (source?.thumbnailUrl || source?.previewUrl) {
          const image = document.createElement("img");
          image.src = source.thumbnailUrl || source.previewUrl;
          image.alt = "";
          slot.append(image);
        } else {
          const empty = document.createElement("span");
          empty.className = "video-frame-slot__empty";
          empty.textContent = "▧";
          slot.append(empty);
        }
        const slotLabel = document.createElement("span");
        slotLabel.className = "video-frame-slot__label";
        slotLabel.textContent = source?.name || source?.file?.name || t(labelKey);
        slot.append(slotLabel);
        slot.onclick = () => {
          activeVideoFrameSlot = { index, key };
          renderVideoFrameAssignments();
        };
        wrap.append(slot);
        if (source) {
          const clear = document.createElement("button");
          clear.type = "button";
          clear.className = "video-frame-slot-clear";
          clear.title = t("sidebar.frameClearSlot");
          clear.setAttribute("aria-label", t("sidebar.frameClearSlot"));
          clear.textContent = "×";
          clear.onclick = () => {
            videoFrameAssignments[index][key] = null;
            renderVideoFrameAssignments();
          };
          wrap.append(clear);
        }
        slots.append(wrap);
      }
      row.append(promptLabel, slots);
      container.append(row);
    });
  }

  function applyVideoFrameAssignment(mode) {
    const prompts = currentVideoPromptsForFrames();
    while (videoFrameAssignments.length < prompts.length) videoFrameAssignments.push({ first: null, last: null });
    if (mode === "clear") {
      for (let index = 0; index < prompts.length; index++) videoFrameAssignments[index] = { first: null, last: null };
      activeVideoFrameSlot = null;
      renderVideoFrameAssignments();
      return;
    }
    prompts.forEach((_, index) => {
      const assignment = videoFrameAssignments[index];
      if (mode === "start" && videoFrameSources[index] && !assignment.first) assignment.first = videoFrameSources[index];
      if (mode === "chain") {
        if (videoFrameSources[index] && !assignment.first) assignment.first = videoFrameSources[index];
        if (videoFrameSources[index + 1] && !assignment.last) assignment.last = videoFrameSources[index + 1];
      }
      if (mode === "pairs") {
        if (videoFrameSources[index * 2] && !assignment.first) assignment.first = videoFrameSources[index * 2];
        if (videoFrameSources[index * 2 + 1] && !assignment.last) assignment.last = videoFrameSources[index * 2 + 1];
      }
    });
    activeVideoFrameSlot = null;
    renderVideoFrameAssignments();
  }

  document.querySelector("#btnChooseVideoFrameSources")?.addEventListener("click", () => {
    referencePicker.openFrames(sources => {
      videoFrameSources = sources;
      renderVideoFrameSources();
    });
  });
  document.querySelector("#btnAssignVideoFrames")?.addEventListener("click", () => {
    applyVideoFrameAssignment(document.querySelector("#videoFrameAssignmentMode")?.value || "start");
  });
  document.querySelector("#inputPromptVideo")?.addEventListener("input", syncVideoFrameAssignmentCount);
  document.querySelector("#multiPromptVideo")?.addEventListener("change", () => {
    if (!document.querySelector("#multiPromptVideo")?.checked) {
      const chainToggle = document.querySelector("#chainVideoFromPrevious");
      if (chainToggle) chainToggle.checked = false;
    }
    syncVideoFrameAssignmentCount();
    updateVideoChainUI();
  });
  document.querySelector("#chainVideoFromPrevious")?.addEventListener("change", () => {
    updateVideoChainUI();
    renderVideoFrameAssignments();
  });
  renderVideoFrameSources();
  renderVideoFrameAssignments();

  document.querySelector("#selectModeVideo")?.addEventListener("change", updateVideoFrameInputs);
  document.querySelector("#selectModelImage")?.addEventListener("change", applyFlowModelControls);
  document.querySelector("#selectModelVideo")?.addEventListener("change", applyFlowModelControls);

  function promptsForGeneration(prompt, enabled) {
    const prompts = enabled ? prompt.split(/\n\s*\n/).map(value => value.trim()).filter(Boolean) : [prompt];
    if (prompts.length > 100) throw new Error(t("sidebar.multiPromptLimit"));
    return prompts;
  }

  function updatePromptFormFeedback(type) {
    const prompt = document.querySelector(type === "image" ? "#inputPromptImage" : "#inputPromptVideo");
    const enabled = document.querySelector(type === "image" ? "#multiPromptImage" : "#multiPromptVideo")?.checked === true;
    const countElement = document.querySelector(type === "image" ? "#promptCountImage" : "#promptCountVideo");
    const hint = document.querySelector(type === "image" ? "#promptBatchHintImage" : "#promptBatchHintVideo");
    if (!prompt) return;
    const value = prompt.value.trim();
    const count = value ? (enabled ? value.split(/\n\s*\n/).map(item => item.trim()).filter(Boolean).length : 1) : 0;
    if (countElement) countElement.textContent = t("sidebar.multiPromptCount", { count });
    if (hint) hint.hidden = !enabled;
  }

  function bindPromptImport(type) {
    const prompt = document.querySelector(type === "image" ? "#inputPromptImage" : "#inputPromptVideo");
    const multi = document.querySelector(type === "image" ? "#multiPromptImage" : "#multiPromptVideo");
    const button = document.querySelector(type === "image" ? "#btnImportPromptsImage" : "#btnImportPromptsVideo");
    const fileInput = document.querySelector(type === "image" ? "#inputImportPromptsImage" : "#inputImportPromptsVideo");
    if (!prompt || !multi || !button || !fileInput) return;
    prompt.addEventListener("input", () => updatePromptFormFeedback(type));
    multi.addEventListener("change", () => updatePromptFormFeedback(type));
    button.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", async () => {
      const file = fileInput.files?.[0];
      fileInput.value = "";
      if (!file) return;
      try {
        const lines = (await file.text()).split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith("#"));
        if (!lines.length) throw new Error(t("sidebar.multiPromptEmptyFile"));
        const imported = lines.join("\n\n");
        prompt.value = prompt.value.trim() ? `${prompt.value.trim()}\n\n${imported}` : imported;
        if (lines.length > 1) multi.checked = true;
        prompt.dispatchEvent(new Event("input", { bubbles: true }));
        updatePromptFormFeedback(type);
      } catch (error) {
        setFeedback(error.message || t("sidebar.multiPromptImportFailed"), false);
      }
    });
  }

  bindPromptImport("image");
  bindPromptImport("video");

  function assignBatchReferences(prompts, mode, common, selectedReferences, referencesPerPrompt = 1) {
    if (mode === "none") return prompts.map(() => [...common]);
    if (prompts.length < 2 || mode !== "sequential") {
      const attachments = [...common, ...selectedReferences];
      return prompts.map(() => attachments);
    }
    const count = Math.max(1, Math.min(3, Number(referencesPerPrompt) || 1));
    if (selectedReferences.length < prompts.length * count) throw new Error(t("sidebar.multiPromptRefsMissing"));
    return prompts.map((_, index) => [...common, ...selectedReferences.slice(index * count, (index + 1) * count)]);
  }

  function resolveMentionReferences(prompts, selectedReferences) {
    const normalizeName = value => String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[đĐ]/g, "d").trim().toLowerCase();
    const aliases = new Map();
    const addAlias = (value, reference) => {
      const clean = String(value || "").replace(/^asset:/i, "").trim();
      if (!clean) return;
      const names = [clean, clean.replace(/\.[^.]+$/, "")];
      for (const name of names) {
        const key = normalizeName(name);
        if (!key) continue;
        if (!aliases.has(key)) aliases.set(key, new Set());
        aliases.get(key).add(reference);
      }
    };
    for (const reference of selectedReferences) {
      addAlias(reference.name, reference);
      addAlias(reference.file?.name, reference);
      addAlias(reference.assetName, reference);
    }

    const assignments = [];
    const unresolvedNames = new Set();
    const pattern = /@(?:\[([^\]]+)\]|([\p{L}\p{N}_]+))/gu;
    for (const prompt of prompts) {
      const assigned = [];
      const seen = new Set();
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(prompt)) !== null) {
        // Namespaced tokens such as @voice:soft belong to other Flow controls.
        if (prompt[pattern.lastIndex] === ":") continue;
        const name = String(match[1] || match[2] || "").trim();
        const key = normalizeName(name);
        if (!key) continue;
        const matches = [...(aliases.get(key) || [])];
        if (matches.length > 1) throw new Error(t("sidebar.multiPromptMentionAmbiguous", { name }));
        if (matches.length === 0) {
          const isCharacter = Array.isArray(currentCharacters) && currentCharacters.some(c => {
            const cName = normalizeName(typeof c === "string" ? c : c?.name);
            return cName === key || cName.replace(/_/g, " ") === key.replace(/_/g, " ") || cName.replace(/\s+/g, "_") === key;
          });
          if (!isCharacter) {
            unresolvedNames.add(name);
          }
          continue;
        }
        const reference = matches[0];
        if (!seen.has(reference)) {
          seen.add(reference);
          assigned.push(reference);
        }
      }
      assignments.push(assigned);
    }
    const usedReferences = [...new Set(assignments.flat())];
    return { assignments, usedReferences, unresolvedNames: [...unresolvedNames] };
  }

  function showUnresolvedMentionWarning(type, names, queued) {
    if (!names?.length) return;
    const warning = t("sidebar.multiPromptMentionUnresolved", { names: names.map(name => `@${name}`).join(", ") });
    addLog("flow.reference.mention.unresolved", warning, true);
    if (queued) setFeedback(`${t("sidebar.workflowQueued")} · ${warning}`, true);
    console.warn(`[Flow ${type}] unresolved reference mentions:`, names);
  }

  async function uploadReferenceImage(file, onProgress, referenceIndex) {
    if (window.FlowUploadClient) {
      return await window.FlowUploadClient.upload(file, { onProgress, kind: "image", referenceIndex });
    }
    throw new Error("Dịch vụ tải ảnh lên Flow chưa được khởi tạo");
  }

  async function assertQueueIdleForReferenceUpload() {
    const state = await chrome.runtime.sendMessage({ type: "flow-queue:get" });
    if (!state?.ok || state.isRunning || Number(state.waitingForUser) > 0) {
      throw new Error(t("sidebar.referenceUploadQueueBusy"));
    }
  }

  // SUBMIT TẠO ẢNH (GENERATE IMAGE)
  document.querySelector("#btnSubmitImage").onclick = async () => {
    const refFilesImage = referencePicker.getReferences("image");
    const btn = document.querySelector("#btnSubmitImage");
    const btnTextEl = document.querySelector("#txtBtnSubmitImage");
    const prompt = document.querySelector("#inputPromptImage").value.trim();
    if (!prompt) {
      setFeedback("Vui lòng nhập câu lệnh prompt cho ảnh!", false);
      return;
    }
    let aspect_ratio = document.querySelector("#selectRatioImage").value;
    let count = Number(document.querySelector("#selectQtyImage").value) || 1;
    const model = document.querySelector("#selectModelImage")?.value || "nano banana";
    let prompts;
    try { prompts = promptsForGeneration(prompt, document.querySelector("#multiPromptImage")?.checked === true); }
    catch (error) { setFeedback(error.message, false); return; }
    const referenceMode = document.querySelector("#multiRefModeImage")?.value || "all";
    const referencesPerPrompt = Number(document.querySelector("#multiRefCountImage")?.value) || 1;
    let mentionResolution = null;
    if (referenceMode === "mention") {
      try { mentionResolution = resolveMentionReferences(prompts, refFilesImage); }
      catch (error) { setFeedback(error.message, false); return; }
    }
    if (prompts.length > 1 && referenceMode === "sequential" && refFilesImage.length < prompts.length * referencesPerPrompt) {
      setFeedback(t("sidebar.multiPromptRefsMissing"), false);
      return;
    }
    const selectedCharacter = selectedFlowCharacter(document.querySelector("#selectCharImage") || document.querySelector("#genCharacterSelect"));
    const character = selectedCharacter?.name || "";

    const commonAttachments = [];
    const referenceAttachments = [];
    const activeImageReferences = referenceMode === "none" ? []
      : referenceMode === "mention" ? mentionResolution.usedReferences
        : refFilesImage;
    if (selectedCharacter) commonAttachments.push(selectedCharacter.attachment);

    try {
      if (btn) btn.disabled = true;
      const confirmation = await confirmImageGeneration({
        prompts,
        model,
        aspectRatio: aspect_ratio,
        count,
        references: activeImageReferences,
        character,
        submitButton: btn,
      });
      if (!confirmation) return;
      aspect_ratio = confirmation.aspect_ratio;
      count = confirmation.count;
      document.querySelector("#selectRatioImage").value = aspect_ratio;
      document.querySelector("#selectQtyImage").value = String(count);
      // Reuse selected Flow media IDs; only newly chosen local files are uploaded.
      const attachmentByReference = new Map();
      const localImageReferences = activeImageReferences.filter(reference => reference.source === "local");
      if (localImageReferences.length > 0) {
        try { await assertQueueIdleForReferenceUpload(); }
        catch (error) { setFeedback(error.message, false); return; }
      }
      let uploadedImageCount = 0;
      for (let i = 0; i < activeImageReferences.length; i++) {
        const reference = activeImageReferences[i];
        if (reference.source === "flow") {
          const attachment = {
            assetName: reference.assetName,
            expectedId: reference.expectedId,
            kind: reference.kind || "image",
          };
          referenceAttachments.push(attachment);
          attachmentByReference.set(reference, attachment);
          continue;
        }
        uploadedImageCount++;
        setFeedback(`Đang tải ảnh tham chiếu ${uploadedImageCount}/${localImageReferences.length} lên Flow...`, true);
        const uploaded = await uploadReferenceImage(reference.file, undefined, i + 1);
        const uploadedName = typeof uploaded === "string" ? uploaded : (uploaded?.name || uploaded?.title || String(uploaded));
        const uploadedId = typeof uploaded === "object" ? (uploaded?.id || uploaded?.mediaId) : undefined;
        const attachment = {
          assetName: `asset:${uploadedName}`,
          ...(uploadedId ? { expectedId: uploadedId } : {}),
          kind: reference.kind || "image",
        };
        referenceAttachments.push(attachment);
        attachmentByReference.set(reference, attachment);
      }

      const baseBatchAttachments = assignBatchReferences(prompts, referenceMode, [], referenceAttachments, referencesPerPrompt);
      const attachmentsPerPrompt = prompts.map((itemPrompt, idx) => {
        const itemChar = findCharacterMentionInPrompt(itemPrompt, currentCharacters) || selectedCharacter;
        const charAtts = itemChar ? [itemChar.attachment] : [];
        if (referenceMode === "mention") {
          const refs = mentionResolution.assignments[idx].map(reference => attachmentByReference.get(reference)).filter(Boolean);
          return [...charAtts, ...refs];
        }
        return [...charAtts, ...(baseBatchAttachments[idx] || [])];
      });
      const queued = await executeGenerationTask({
        type: "image",
        prompt,
        prompts,
        aspect_ratio,
        count,
        model,
        attachmentsPerPrompt,
        btn,
        btnTextEl,
        defaultTextKey: "sidebar.btnGenerateImage"
      });
      showUnresolvedMentionWarning("image", mentionResolution?.unresolvedNames, queued);
    } catch (err) {
      setFeedback(`❌ ${err.message}`, false);
    } finally {
      if (btn) btn.disabled = false;
      if (btnTextEl) btnTextEl.textContent = t("sidebar.btnGenerateImage");
    }
  };

  // SUBMIT TẠO VIDEO (GENERATE VIDEO)
  document.querySelector("#btnSubmitVideo").onclick = async () => {
    const refFilesVideo = referencePicker.getReferences("video");
    const btn = document.querySelector("#btnSubmitVideo");
    const btnTextEl = document.querySelector("#txtBtnSubmitVideo");
    const prompt = document.querySelector("#inputPromptVideo").value.trim();
    if (!prompt) {
      setFeedback("Vui lòng nhập câu lệnh prompt cho video!", false);
      return;
    }
    const capabilityRegistry = await loadFlowModelCapabilities();
    if (!capabilityRegistry) {
      setFeedback("Không đọc được cấu hình model cục bộ của extension. Hãy tải lại extension rồi thử lại.", false);
      return;
    }
    const aspect_ratio = document.querySelector("#selectRatioVideo").value;
    const model = document.querySelector("#selectModelVideo")?.value || "veo 3.1";
    const modelRule = getFlowModelRule("video", model);
    if (!modelRule) {
      setFeedback("Model video chưa có capability DOM được xác nhận trong cấu hình local.", false);
      return;
    }
    const duration = Number(modelRule.fixedDuration ?? document.querySelector("#selectDurationVideo").value) || undefined;
    const resolution = modelRule.resolutions?.includes(document.querySelector("#selectResolutionVideo")?.value)
      ? document.querySelector("#selectResolutionVideo").value : undefined;
    const count = getVideoQuantity(modelRule, document.querySelector("#selectCountVideo")?.value);
    const mode = document.querySelector("#selectModeVideo").value || "ingredients";
    const selectedCharacter = mode === "frames" ? null : selectedFlowCharacter(document.querySelector("#genCharacterSelect") || document.querySelector("#selectCharVideo"));
    const character = selectedCharacter?.name || "";
    const chainVideo = document.querySelector("#chainVideoFromPrevious")?.checked === true;
    if (chainVideo && count !== 1) {
      setFeedback(t("sidebar.videoChainNeedsSingleVariant"), false);
      return;
    }
    let prompts;
    try { prompts = promptsForGeneration(prompt, document.querySelector("#multiPromptVideo")?.checked === true); }
    catch (error) { setFeedback(error.message, false); return; }
    const selectedReferenceMode = document.querySelector("#multiRefModeVideo")?.value || "all";
    const referenceMode = mode === "frames" ? "none" : selectedReferenceMode;
    const referencesPerPrompt = Number(document.querySelector("#multiRefCountVideo")?.value) || 1;
    syncVideoFrameAssignmentCount();
    const hasFrames = mode === "frames";
    const selectedFrameAssignments = videoFrameAssignments.slice(0, prompts.length);
    if (chainVideo && prompts.length < 2) {
      setFeedback(t("sidebar.videoChainNeedsPrompts"), false);
      return;
    }
    const selectedVoice = document.querySelector("#genVideoVoiceSelect")?.value || document.querySelector("#flowVoiceSelect")?.value || "";
    if (chainVideo && mode !== "frames" && (refFilesVideo.length > 0 || character || selectedVoice)) {
      setFeedback(t("sidebar.videoChainReferencesConflict"), false);
      return;
    }
    if (hasFrames && !videoFrameSources.length) {
      setFeedback(t("sidebar.videoFramesNeedInput"), false);
      return;
    }
    if (hasFrames && selectedFrameAssignments.slice(0, chainVideo ? 1 : prompts.length).some(assignment => !assignment?.first)) {
      setFeedback(chainVideo ? t("sidebar.videoChainNeedsStart") : t("sidebar.videoFramesNeedStart"), false);
      return;
    }
    if (!hasFrames && prompts.length > 1 && referenceMode === "sequential" && refFilesVideo.length < prompts.length * referencesPerPrompt) {
      setFeedback(t("sidebar.multiPromptRefsMissing"), false);
      return;
    }
    let mentionResolution = null;
    if (referenceMode === "mention") {
      try { mentionResolution = resolveMentionReferences(prompts, refFilesVideo); }
      catch (error) { setFeedback(error.message, false); return; }
    }

    const commonAttachments = [];
    const referenceAttachments = [];
    if (selectedCharacter) commonAttachments.push(selectedCharacter.attachment);

    try {
      if (btn) btn.disabled = true;
      // Reuse selected Flow media IDs; only newly chosen local files are uploaded.
      const activeVideoReferences = referenceMode === "none" || hasFrames ? []
        : referenceMode === "mention" ? mentionResolution.usedReferences
          : refFilesVideo;
      const attachmentByReference = new Map();
      const localVideoReferences = activeVideoReferences.filter(reference => reference.source === "local");
      if (localVideoReferences.length > 0) {
        try { await assertQueueIdleForReferenceUpload(); }
        catch (error) { setFeedback(error.message, false); return; }
      }
      let uploadedVideoCount = 0;
      for (let i = 0; i < activeVideoReferences.length; i++) {
        const reference = activeVideoReferences[i];
        if (reference.source === "flow") {
          const attachment = {
            assetName: reference.assetName,
            expectedId: reference.expectedId,
            kind: reference.kind || "video",
          };
          referenceAttachments.push(attachment);
          attachmentByReference.set(reference, attachment);
          continue;
        }
        uploadedVideoCount++;
        setFeedback(`Đang tải media tham chiếu ${uploadedVideoCount}/${localVideoReferences.length} lên Flow...`, true);
        const uploaded = await uploadReferenceImage(reference.file, undefined, i + 1);
        const uploadedName = typeof uploaded === "string" ? uploaded : (uploaded?.name || uploaded?.title || String(uploaded));
        const uploadedId = typeof uploaded === "object" ? (uploaded?.id || uploaded?.mediaId) : undefined;
        const attachment = {
          assetName: `asset:${uploadedName}`,
          ...(uploadedId ? { expectedId: uploadedId } : {}),
          kind: reference.kind || "video",
        };
        referenceAttachments.push(attachment);
        attachmentByReference.set(reference, attachment);
      }

      const firstFramesPerPrompt = [];
      const lastFramesPerPrompt = [];
      if (hasFrames) {
        const usedFrameAssignments = chainVideo
          ? selectedFrameAssignments.slice(0, 1).map(assignment => ({ first: assignment?.first || null, last: null }))
          : selectedFrameAssignments;
        const usedFrameSources = [...new Set(usedFrameAssignments.flatMap(assignment => [assignment?.first, assignment?.last]).filter(Boolean))];
        const localFrameSources = usedFrameSources.filter(source => source.source === "local");
        if (localFrameSources.length) {
          try { await assertQueueIdleForReferenceUpload(); }
          catch (error) { setFeedback(error.message, false); return; }
        }
        let uploadedFrameCount = 0;
        for (const source of usedFrameSources) {
          if (source.source === "flow") {
            attachmentByReference.set(source, { assetName: source.assetName, expectedId: source.expectedId });
            continue;
          }
          uploadedFrameCount++;
          setFeedback(t("sidebar.frameUploading", { n: uploadedFrameCount, total: localFrameSources.length, name: source.name || source.file?.name || "" }), true);
          const uploaded = await uploadReferenceImage(source.file, undefined, uploadedFrameCount);
          const uploadedName = typeof uploaded === "string" ? uploaded : (uploaded?.name || uploaded?.title || String(uploaded));
          const uploadedId = typeof uploaded === "object" ? (uploaded?.id || uploaded?.mediaId) : undefined;
          attachmentByReference.set(source, { assetName: `asset:${uploadedName}`, ...(uploadedId ? { expectedId: uploadedId } : {}) });
        }
        for (let index = 0; index < selectedFrameAssignments.length; index++) {
          const assignment = selectedFrameAssignments[index];
          firstFramesPerPrompt.push((!chainVideo || index === 0) && assignment.first ? attachmentByReference.get(assignment.first) : null);
          lastFramesPerPrompt.push(!chainVideo && assignment.last ? attachmentByReference.get(assignment.last) : null);
        }
      }

      const baseBatchAttachments = assignBatchReferences(prompts, referenceMode, [], referenceAttachments, referencesPerPrompt);
      const attachmentsPerPrompt = hasFrames
        ? prompts.map(() => [])
        : prompts.map((itemPrompt, idx) => {
            const itemChar = findCharacterMentionInPrompt(itemPrompt, currentCharacters) || selectedCharacter;
            const charAtts = itemChar ? [itemChar.attachment] : [];
            if (referenceMode === "mention") {
              const refs = mentionResolution.assignments[idx].map(reference => attachmentByReference.get(reference)).filter(Boolean);
              return [...charAtts, ...refs];
            }
            return [...charAtts, ...(baseBatchAttachments[idx] || [])];
          });
      const queued = await executeGenerationTask({
        type: "video",
        prompt,
        prompts,
        aspect_ratio,
        count,
        video_settings: {
          mode,
          model,
          ...(duration != null ? { duration } : {}),
          ...(resolution ? { resolution } : {}),
          ...(mode !== "frames" && selectedVoice ? { voice: selectedVoice } : {})
        },
        attachmentsPerPrompt,
        ...(hasFrames ? { firstFramesPerPrompt, lastFramesPerPrompt } : {}),
        chainVideo,
        btn,
        btnTextEl,
        defaultTextKey: "sidebar.btnGenerateVideo"
      });
      showUnresolvedMentionWarning("video", mentionResolution?.unresolvedNames, queued);
    } catch (err) {
      setFeedback(`❌ ${err.message}`, false);
    } finally {
      if (btn) btn.disabled = false;
      if (btnTextEl) btnTextEl.textContent = t("sidebar.btnGenerateVideo");
    }
  };

  // SUBMIT TẠO NHÂN VẬT (CREATE CHARACTER)
  document.querySelector("#btnSubmitCharacter").onclick = async () => {
    const name = document.querySelector("#inputCharName").value.trim();
    if (!name) {
      setFeedback("Vui lòng nhập tên nhân vật!", false);
      return;
    }
    const description = document.querySelector("#inputCharDesc").value.trim();

    setFeedback(t("sidebar.creatingChar"), true);
    addLog("flow.queue.add", `Tạo nhân vật: ${name}`, true);

    try {
      const res = await chrome.runtime.sendMessage({
        type: "flow-queue:add",
        job: { operation: "flow.character.create", payload: { name, describe: description }, label: `Nhân vật: ${name}` }
      });
      if (!res?.ok) throw new Error(res?.error?.message || "Không thể thêm tác vụ tạo nhân vật vào hàng đợi");
      rememberSubmittedQueueJob(res);
      setFeedback(t("sidebar.workflowQueued"), true);
      document.querySelector("#inputCharName").value = "";
      document.querySelector("#inputCharDesc").value = "";
    } catch (err) {
      setFeedback(err.message, false);
      addLog("flow.character.create.error", err.message, false);
    }
  };

  document.querySelector("#btnRefreshProjects").onclick = event => runLibraryAction(event.currentTarget, async () => {
    const result = await dispatchFlowOperation("flow.projects.list");
    flowProjects = Array.isArray(result) ? result : (result?.projects || []);
    fillSelect(document.querySelector("#flowProjectSelect"), flowProjects,
      project => project.id || project.projectId || project.project_id,
      project => project.name || project.title || project.id || project.projectId,
      t("sidebar.librarySelectProject"));
    return { projects: flowProjects.length };
  });

  document.querySelector("#btnCreateProject").onclick = event => runLibraryAction(event.currentTarget, async () => {
    await assertQueueIdleForDirectAction();
    const result = await dispatchFlowOperation("flow.project.create");
    await dispatchFlowOperation("flow.projects.list").then(items => {
      flowProjects = Array.isArray(items) ? items : (items?.projects || []);
      fillSelect(document.querySelector("#flowProjectSelect"), flowProjects,
        project => project.id || project.projectId || project.project_id,
        project => project.name || project.title || project.id || project.projectId,
        t("sidebar.librarySelectProject"));
    }).catch(() => {});
    return result;
  });

  document.querySelector("#btnOpenProject").onclick = event => runLibraryAction(event.currentTarget, async () => {
    const projectId = document.querySelector("#flowProjectSelect").value;
    if (!projectId) throw new Error("Hãy chọn một dự án.");
    await assertQueueIdleForDirectAction();
    return dispatchFlowOperation("flow.project.open", { projectId });
  });

  document.querySelector("#btnRefreshAssets").onclick = event => runLibraryAction(event.currentTarget, async () => {
    const result = await dispatchFlowOperation("flow.assets.list");
    flowAssets = Array.isArray(result) ? result : (result?.assets || []);
    flowPhotosScanned = true;
    flowPhotosVisibleLimit = 30;
    renderFlowPhotos();
    fillSelect(document.querySelector("#flowAssetSelect"), flowAssets,
      (asset, index) => asset.id || asset.name || String(index),
      asset => asset.name || asset.title || asset.id,
      t("sidebar.librarySelectAsset"));
    return { assets: flowAssets.length };
  });

  function renderFlowPhotos() {
    const grid = document.querySelector("#flowPhotosGrid");
    const empty = document.querySelector("#flowPhotosEmpty");
    const summary = document.querySelector("#flowPhotosSummary");
    const more = document.querySelector("#btnMorePhotos");
    const query = document.querySelector("#flowPhotosSearch")?.value?.trim().toLocaleLowerCase() || "";
    const kind = document.querySelector("#flowPhotosKind")?.value || "all";
    if (!grid || !empty) return;
    const matches = flowAssets.filter(asset => {
      const type = asset.kind === "scene" ? "video" : asset.kind;
      return ["image", "video"].includes(type) && (kind === "all" || kind === type) &&
        (!query || String(asset.name || "").toLocaleLowerCase().includes(query));
    });
    const shown = matches.slice(0, flowPhotosVisibleLimit);
    grid.replaceChildren();
    for (const asset of shown) {
      const card = document.createElement("article");
      card.className = "flow-photo-card";
      const thumbUrl = (() => {
        try { const parsed = new URL(String(asset.thumbnailUrl || ""), location.href); return parsed.protocol === "https:" ? parsed.href : ""; }
        catch { return ""; }
      })();
      const playbackUrl = (() => {
        try { const parsed = new URL(String(asset.videoUrl || asset.video_url || ""), location.href); return parsed.protocol === "https:" ? parsed.href : ""; }
        catch { return ""; }
      })();
      const isVideoAsset = asset.kind === "video" || asset.kind === "scene";
      const preview = document.createElement("button");
      preview.type = "button";
      preview.className = "flow-photo-thumb";
      preview.disabled = !thumbUrl && !(isVideoAsset && playbackUrl);
      preview.title = t("sidebar.photosPreview");
      if (thumbUrl) {
        const image = document.createElement("img");
        image.src = thumbUrl;
        image.alt = "";
        image.loading = "lazy";
        image.onerror = () => image.remove();
        preview.appendChild(image);
      } else {
        const placeholder = document.createElement("span");
        placeholder.textContent = asset.kind === "video" || asset.kind === "scene" ? "▶" : "▧";
        preview.appendChild(placeholder);
      }
      preview.onclick = () => {
        const dialog = document.querySelector("#flowPhotoPreview");
        const image = document.querySelector("#flowPhotoPreviewImage");
        const video = document.querySelector("#flowPhotoPreviewVideo");
        const title = document.querySelector("#flowPhotoPreviewName");
        const note = document.querySelector("#flowPhotoPreviewNote");
        if (!dialog || !image) return;
        const videoUrl = playbackUrl;
        const isVideo = isVideoAsset;
        if (video) {
          video.pause();
          video.removeAttribute("src");
          video.onerror = null;
          video.hidden = !(isVideo && videoUrl);
          if (isVideo && videoUrl) {
            video.poster = thumbUrl;
            video.src = videoUrl;
            video.onerror = () => {
              video.pause();
              video.removeAttribute("src");
              video.load();
              video.hidden = true;
              image.hidden = !thumbUrl;
              if (note) { note.textContent = t("sidebar.photosVideoUnavailable"); note.hidden = false; }
            };
            video.load();
          }
        }
        image.hidden = Boolean(isVideo && videoUrl);
        image.src = thumbUrl;
        image.alt = asset.name || "";
        if (title) title.textContent = asset.name || "";
        if (note) {
          note.textContent = isVideo && !videoUrl ? t("sidebar.photosVideoUnavailable") : "";
          note.hidden = !(isVideo && !videoUrl);
        }
        dialog.showModal();
      };
      const label = document.createElement("div");
      label.className = "flow-photo-label";
      label.textContent = asset.name || "";
      label.title = asset.name || "";
      const kindLabel = document.createElement("span");
      kindLabel.className = "flow-photo-kind";
      kindLabel.textContent = (asset.kind === "image" ? t("sidebar.photosImages") : t("sidebar.photosVideos"));
      const actions = document.createElement("div");
      actions.className = "flow-photo-actions";
      const addAction = (text, title, run, className = "") => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `btn btn-secondary ${className}`.trim();
        button.textContent = text;
        button.title = title;
        button.onclick = event => runLibraryAction(event.currentTarget, run);
        actions.appendChild(button);
      };
      if (asset.kind === "image") addAction(t("sidebar.photosUseReference"), t("sidebar.photosUseReference"), async () => {
        await assertQueueIdleForDirectAction();
        return dispatchFlowOperation("flow.references.attach", { references: [`asset:${asset.name}`] });
      });
      addAction(t("sidebar.photosDownload"), t("sidebar.photosDownload"), async () => {
        await assertQueueIdleForDirectAction();
        return dispatchFlowOperation("flow.asset.download", { name: asset.name, id: asset.id, quality: "original" });
      });
      card.append(preview, label, kindLabel, actions);
      grid.appendChild(card);
    }
    empty.hidden = shown.length > 0;
    empty.textContent = !flowPhotosScanned ? t("sidebar.photosEmpty") : matches.length ? "" : t("sidebar.photosNoResults");
    if (summary) summary.textContent = flowPhotosScanned
      ? t("sidebar.photosCount", { shown: shown.length, total: matches.length })
      : t("sidebar.photosSummary");
    if (more) more.hidden = matches.length <= shown.length;
  }

  async function refreshFlowPhotos() {
    await assertQueueIdleForDirectAction();
    const result = await dispatchFlowOperation("flow.gallery.scan", { deep: true });
    flowAssets = Array.isArray(result) ? result : (result?.tiles || result?.assets || []);
    flowPhotosScanned = true;
    flowPhotosVisibleLimit = 30;
    fillSelect(document.querySelector("#flowAssetSelect"), flowAssets,
      (asset, index) => asset.id || asset.name || String(index),
      asset => asset.name || asset.title || asset.id,
      t("sidebar.librarySelectAsset"));
    renderFlowPhotos();
    return { assets: flowAssets.length };
  }

  const triggerPhotosRefresh = event => runLibraryAction(event.currentTarget, refreshFlowPhotos);
  const btnRefPhotos = document.querySelector("#btnRefreshPhotos");
  if (btnRefPhotos) btnRefPhotos.onclick = triggerPhotosRefresh;
  const btnRefFlowImages = document.querySelector("#refreshFlowImagesBtn");
  if (btnRefFlowImages) btnRefFlowImages.onclick = triggerPhotosRefresh;
  document.querySelector("#flowPhotosSearch").oninput = () => { flowPhotosVisibleLimit = 30; renderFlowPhotos(); };
  document.querySelector("#flowPhotosKind").onchange = () => { flowPhotosVisibleLimit = 30; renderFlowPhotos(); };
  document.querySelector("#btnMorePhotos").onclick = () => { flowPhotosVisibleLimit += 30; renderFlowPhotos(); };
  document.querySelector("#flowPhotoPreview").addEventListener("click", event => {
    if (event.target === event.currentTarget) event.currentTarget.close();
  });
  document.querySelector("#flowPhotoPreview").addEventListener("close", () => {
    const video = document.querySelector("#flowPhotoPreviewVideo");
    if (!video) return;
    video.pause();
    video.removeAttribute("src");
    video.load();
    video.onerror = null;
    video.hidden = true;
    const image = document.querySelector("#flowPhotoPreviewImage");
    if (image) image.hidden = false;
    const note = document.querySelector("#flowPhotoPreviewNote");
    if (note) note.hidden = true;
  });

  function selectedFlowAsset() {
    const value = document.querySelector("#flowAssetSelect").value;
    return flowAssets.find((asset, index) => String(asset.id || asset.name || index) === value) || null;
  }

  document.querySelector("#btnDownloadAsset").onclick = event => runLibraryAction(event.currentTarget, async () => {
    const asset = selectedFlowAsset();
    if (!asset) throw new Error("Hãy chọn một tài sản.");
    await assertQueueIdleForDirectAction();
    return dispatchFlowOperation("flow.asset.download", { name: asset.name || asset.title, id: asset.id, quality: "original" });
  });

  document.querySelector("#btnRenameAsset").onclick = event => runLibraryAction(event.currentTarget, async () => {
    const asset = selectedFlowAsset();
    const newName = document.querySelector("#flowAssetNewName").value.trim();
    if (!asset || !newName) throw new Error("Chọn tài sản và nhập tên mới.");
    await assertQueueIdleForDirectAction();
    const result = await dispatchFlowOperation("flow.asset.rename", { name: asset.name || asset.title, id: asset.id, newName });
    document.querySelector("#flowAssetNewName").value = "";
    return result;
  });

  document.querySelector("#btnTrashAsset").onclick = event => runLibraryAction(event.currentTarget, async () => {
    const asset = selectedFlowAsset();
    if (!asset) throw new Error("Hãy chọn một tài sản.");
    if (!window.confirm(`Chuyển “${asset.name || asset.title}” vào thùng rác Flow?`)) return "Đã hủy.";
    await assertQueueIdleForDirectAction();
    const result = await dispatchFlowOperation("flow.asset.trash", { name: asset.name || asset.title, id: asset.id });
    return result;
  });

  document.querySelector("#btnRefreshLibraryCharacters").onclick = event => runLibraryAction(event.currentTarget, async () => {
    const result = await dispatchFlowOperation("flow.characters.list");
    currentCharacters = Array.isArray(result) ? result : (result?.characters || []);
    populateCharacterSelects();
    fillSelect(document.querySelector("#flowLibraryCharacterSelect"), currentCharacters,
      character => typeof character === "string" ? character : character.name,
      character => typeof character === "string" ? character : character.name,
      t("sidebar.librarySelectCharacter"));
    return { characters: currentCharacters.length };
  });

  document.querySelector("#btnEditCharacter").onclick = async event => {
    const selected = document.querySelector("#flowLibraryCharacterSelect").value;
    const rename = document.querySelector("#flowCharacterNewName").value.trim();
    const change = document.querySelector("#flowCharacterChange").value.trim();
    if (!selected || (!rename && !change)) {
      setFeedback("Chọn nhân vật và nhập tên mới hoặc mô tả thay đổi.", false);
      return;
    }
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const response = await chrome.runtime.sendMessage({ type: "flow-queue:add", job: {
        operation: "flow.character.edit", payload: { name: selected, ...(rename ? { rename } : {}), ...(change ? { change } : {}) },
        label: `Chỉnh sửa nhân vật: ${selected}`
      }});
      if (!response?.ok) throw new Error(response?.error?.message || "Không thể thêm chỉnh sửa vào hàng đợi.");
      rememberSubmittedQueueJob(response);
      document.querySelector("#flowCharacterNewName").value = "";
      document.querySelector("#flowCharacterChange").value = "";
      setFeedback("Đã đưa chỉnh sửa nhân vật vào hàng đợi Flow.", true);
      showLibraryResult({ queued: true, operation: "flow.character.edit", name: selected });
    } catch (error) { setFeedback(error.message, false); showLibraryResult(error.message); }
    finally { button.disabled = false; }
  };

  const attachReferencesButton = document.querySelector("#btnAttachReferences");
  const referenceInput = document.querySelector("#flowReferenceInput");
  if (attachReferencesButton && referenceInput) {
    attachReferencesButton.addEventListener("click", event => runLibraryAction(event.currentTarget, async () => {
      const references = referenceInput.value.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
      if (!references.length) throw new Error("Nhập ít nhất một tham chiếu.");
      await assertQueueIdleForDirectAction();
      return dispatchFlowOperation("flow.references.attach", { references });
    }));
  }

  document.querySelector("#btnClearReferences")?.addEventListener("click", event => runLibraryAction(event.currentTarget, async () => {
    await assertQueueIdleForDirectAction();
    return dispatchFlowOperation("flow.references.clear", {});
  }));

  document.querySelector("#btnRemoveReferenceKind")?.addEventListener("click", event => runLibraryAction(event.currentTarget, async () => {
    await assertQueueIdleForDirectAction();
    const kind = document.querySelector("#flowReferenceKindToRemove")?.value;
    if (!kind) throw new Error("Chọn loại tham chiếu cần gỡ.");
    return dispatchFlowOperation("flow.references.remove", { kind });
  }));

  document.querySelector("#btnUploadMedia").onclick = event => runLibraryAction(event.currentTarget, async () => {
    const file = document.querySelector("#flowUploadFile").files?.[0];
    if (!file) throw new Error("Chọn một tệp ảnh hoặc video.");
    if (!window.FlowUploadClient) throw new Error("Dịch vụ tải media lên chưa sẵn sàng.");
    await assertQueueIdleForDirectAction();
    const kind = file.type.startsWith("video/") ? "video" : "image";
    const uploaded = await window.FlowUploadClient.upload(file, { kind, onProgress: progress => setFeedback(`Đang tải tệp lên Flow: ${progress}%`, true) });
    document.querySelector("#flowUploadFile").value = "";
    return uploaded;
  });

  document.querySelector("#btnLoadVoices")?.addEventListener("click", event => runLibraryAction(event.currentTarget, async () => {
    const result = await dispatchFlowOperation("flow.voices.options");
    const voices = Array.isArray(result?.voices) ? result.voices : [];
    fillSelect(document.querySelector("#flowVoiceSelect"), voices,
      voice => typeof voice === "string" ? voice : voice.name,
      voice => typeof voice === "string" ? voice : voice.name,
      "Không dùng giọng nói");
    return result;
  }));

  // Language switch
  document.querySelector("#langSwitchBtn").onclick = async () => {
    if (typeof I18n === "undefined") return;
    const next = I18n.getLocale() === "vi" ? "en" : "vi";
    await I18n.setLocale(next);
    applyLanguage();
    renderFlowPhotos();
    populateCharacterSelects();
  };

  // Reload status
  document.querySelector("#reloadBtn").onclick = () => {
    fetchStatus();
    loadFlowCharacters();
    setFeedback("Đã làm mới dữ liệu", true);
    setTimeout(() => setFeedback(""), 2000);
  };

  // Connect button
  document.querySelector("#btnReconnect").onclick = async () => {
    setFeedback(t("popup.reconnecting"), true);
    addLog("flow.reconnect", "Yêu cầu kết nối lại Flow tab", true);
    try {
      await chrome.runtime.sendMessage({ type: "flow-mcp:connect" });
      setTimeout(async () => {
        await fetchStatus();
        await loadFlowCharacters();
        setFeedback("");
      }, 700);
    } catch (err) {
      setFeedback(err.message, false);
      addLog("flow.reconnect", err.message, false);
    }
  };

  // Preview button
  document.querySelector("#btnPreview").onclick = async () => {
    setFeedback(t("popup.previewTriggered"), true);
    addLog("flow.preview", "Kích hoạt viền xanh 5s", true);
    try {
      const res = await chrome.runtime.sendMessage({ type: "flow-mcp:preview" });
      if (res?.error) throw new Error(res.error);
    } catch (err) {
      setFeedback(err.message, false);
      addLog("flow.preview", err.message, false);
    }
  };

  // Open Flow
  document.querySelector("#btnOpenFlow").onclick = async () => {
    const tabs = await chrome.tabs.query({ url: "https://flow.google.com/*" });
    if (tabs.length > 0) {
      await chrome.tabs.update(tabs[0].id, { active: true });
      if (tabs[0].windowId) await chrome.windows.update(tabs[0].windowId, { focused: true });
    } else {
      await chrome.tabs.create({ url: "https://flow.google.com/" });
    }
  };

  // Clear logs
  document.querySelector("#btnClearLogs").onclick = () => {
    const container = document.querySelector("#logsContainer");
    container.innerHTML = `<div class="logs-empty" id="logsEmpty">${t("sidebar.logsEmpty")}</div>`;
    logs.length = 0;
  };

  document.querySelector("#btnPairSettings").onclick = () => chrome.runtime.openOptionsPage();

  // ==========================================
  // TOBYFLOW ENHANCED UI CONTROLS & WIRING
  // ==========================================

  // 1. Theme Management (Light / Dark)
  function initTheme() {
    const updateThemeUI = isDark => {
      const sunIcon = document.querySelector("#themeIconSun");
      const moonIcon = document.querySelector("#themeIconMoon");
      const label = document.querySelector("#themeToggleLabel");
      if (sunIcon) sunIcon.classList.toggle("hidden", isDark);
      if (moonIcon) moonIcon.classList.toggle("hidden", !isDark);
      if (label) label.textContent = isDark ? (t("header.lightMode") || "Light Mode") : (t("header.darkMode") || "Dark Mode");
    };

    chrome.storage.local.get(["af_settings"]).then(res => {
      const theme = res?.af_settings?.theme || "dark";
      const root = document.querySelector("#flow-auto-sidebar-root");
      if (root) {
        root.classList.remove("theme-light", "theme-dark");
        root.classList.add(`theme-${theme}`);
      }
      updateThemeUI(theme === "dark");
    }).catch(() => {});

    document.querySelector("#themeToggleBtn")?.addEventListener("click", async () => {
      const root = document.querySelector("#flow-auto-sidebar-root");
      const isCurrentlyLight = root?.classList.contains("theme-light");
      const newTheme = isCurrentlyLight ? "dark" : "light";
      if (root) {
        root.classList.remove("theme-light", "theme-dark");
        root.classList.add(`theme-${newTheme}`);
      }
      updateThemeUI(newTheme === "dark");
      try {
        const stored = await chrome.storage.local.get(["af_settings"]);
        await chrome.storage.local.set({
          af_settings: { ...(stored?.af_settings || {}), theme: newTheme }
        });
      } catch (_) {}
    });
  }

  // 2. Header and Settings Menu
  function initSettingsAndHeader() {
    const dropdown = document.querySelector("#settingsDropdown");
    const dropdownBtn = document.querySelector("#settingsDropdownBtn");
    const popup = document.querySelector("#settingsPopup");
    const closeMenu = () => dropdown?.classList.remove("open");

    dropdownBtn?.addEventListener("click", e => {
      e.stopPropagation();
      dropdown?.classList.toggle("open");
    });

    document.addEventListener("click", e => {
      if (dropdown && !dropdown.contains(e.target)) closeMenu();
    });
    dropdown?.addEventListener("click", e => {
      if (e.target.closest?.(".tobyflow-settings-menu-item")) closeMenu();
    });

    document.querySelector("#openSettingsBtn")?.addEventListener("click", () => {
      closeMenu();
      popup?.classList.remove("hidden");
    });

    document.querySelector("#closeSettingsPopupBtn")?.addEventListener("click", () => {
      popup?.classList.add("hidden");
    });
    document.querySelector("#saveSettingsBtn")?.addEventListener("click", () => {
      popup?.classList.add("hidden");
    });

    // Language button
    document.querySelector("#languageBtn")?.addEventListener("click", () => {
      document.querySelector("#langSwitchBtn")?.click();
    });

    // Tip coffee & changelog
    document.querySelector("#tipCoffeeBtn")?.addEventListener("click", () => {
      setFeedback("☕ Cảm ơn bạn đã đồng hành và ủng hộ Toby Flow Studio!", true);
    });
    document.querySelector("#changelogBtn")?.addEventListener("click", () => {
      setFeedback("Toby Flow Studio v1.3.103 · Hỗ trợ tạo ảnh, tạo video, tham chiếu, frames & đa tác vụ", true);
    });

    // Extension reload button
    document.querySelector("#extensionLinkBtn")?.addEventListener("click", () => {
      closeMenu();
      document.querySelector("#reloadBtn")?.click();
    });
  }

  // 3. Screen capture
  function initScreenCapture() {
    const triggerCapture = async () => {
      try {
        setFeedback("Đang chụp ảnh màn hình tab hiện tại...", true);
        const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: "png" });
        if (!dataUrl) throw new Error("Trình duyệt không trả về dữ liệu ảnh màn hình.");
        const res = await fetch(dataUrl);
        const blob = await res.blob();
        const file = new File([blob], `screenshot-${Date.now()}.png`, { type: "image/png" });
        const currentGenType = document.querySelector("#genType")?.value || "image";
        referencePicker.addLocalFilesToReferences(currentGenType, [file]);
        setFeedback("Đã chụp ảnh màn hình và thêm vào danh sách tham chiếu!", true);
      } catch (err) {
        setFeedback(`Chụp màn hình thất bại: ${err.message}`, false);
      }
    };

    document.querySelector("#headerCaptureBtn")?.addEventListener("click", triggerCapture);
    document.querySelector("#screenCaptureBtn")?.addEventListener("click", triggerCapture);
  }

  // 4. Subtab switching for Templates and Photos
  function initSubtabs() {
    document.querySelectorAll("[data-subtab]").forEach(btn => {
      btn.addEventListener("click", () => {
        const subtab = btn.getAttribute("data-subtab");
        const parentPane = btn.closest(".tab-pane");
        if (!parentPane) return;
        parentPane.querySelectorAll("[data-subtab]").forEach(b => b.classList.toggle("active", b === btn));
        parentPane.querySelectorAll(".subtab-pane, .prompts-subtab-pane, .photos-subtab-pane").forEach(pane => {
          pane.classList.toggle("active", pane.id === subtab);
        });
        if (subtab === "photos-flow-images" && !flowPhotosScanned) {
          void runLibraryAction(null, refreshFlowPhotos);
        }
      });
    });
  }

  // 5. Gen Tab Controls
  function initTobyGenControls() {
    const promptsArea = document.querySelector("#promptsArea");
    const multiPromptCheck = document.querySelector("#multiPromptCheck");
    const promptCharCount = document.querySelector("#promptCharCount");
    const promptCountBadge = document.querySelector("#promptCount");
    const multiPromptHint = document.querySelector("#multiPromptHint");

    function updatePromptsMetrics() {
      if (!promptsArea) return;
      const val = promptsArea.value;
      if (promptCharCount) promptCharCount.textContent = `${val.length} ký tự`;
      const isMulti = multiPromptCheck?.checked === true;
      if (multiPromptHint) multiPromptHint.classList.toggle("hidden", !isMulti);
      const count = val.trim() ? (isMulti ? val.trim().split(/\n\s*\n/).filter(Boolean).length : 1) : 0;
      if (promptCountBadge) promptCountBadge.textContent = `${count} prompt${count > 1 ? "s" : ""}`;

      // Sync to legacy inputs
      const inputPromptImage = document.querySelector("#inputPromptImage");
      const inputPromptVideo = document.querySelector("#inputPromptVideo");
      if (inputPromptImage && inputPromptImage.value !== val) {
        inputPromptImage.value = val;
        inputPromptImage.dispatchEvent(new Event("input", { bubbles: true }));
      }
      if (inputPromptVideo && inputPromptVideo.value !== val) {
        inputPromptVideo.value = val;
        inputPromptVideo.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }

    promptsArea?.addEventListener("input", updatePromptsMetrics);
    multiPromptCheck?.addEventListener("change", () => {
      const isMulti = multiPromptCheck.checked;
      const multiPromptImage = document.querySelector("#multiPromptImage");
      const multiPromptVideo = document.querySelector("#multiPromptVideo");
      if (multiPromptImage) multiPromptImage.checked = isMulti;
      if (multiPromptVideo) multiPromptVideo.checked = isMulti;
      updatePromptsMetrics();
    });

    // Keyboard shortcut Ctrl+Enter / Cmd+Enter
    promptsArea?.addEventListener("keydown", e => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        document.querySelector("#genSubmitBtn")?.click();
      }
    });

    // Import TXT file into promptsArea
    const importTxtBtn = document.querySelector("#importTxtBtn");
    if (importTxtBtn) {
      const txtInput = document.createElement("input");
      txtInput.type = "file";
      txtInput.accept = ".txt";
      txtInput.hidden = true;
      document.body.appendChild(txtInput);
      importTxtBtn.addEventListener("click", () => txtInput.click());
      txtInput.addEventListener("change", async () => {
        const file = txtInput.files?.[0];
        txtInput.value = "";
        if (!file) return;
        try {
          const text = await file.text();
          const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith("#"));
          if (!lines.length) throw new Error("Tệp không có dòng văn bản hợp lệ.");
          const imported = lines.join("\n\n");
          promptsArea.value = promptsArea.value.trim() ? `${promptsArea.value.trim()}\n\n${imported}` : imported;
          if (lines.length > 1 && multiPromptCheck) multiPromptCheck.checked = true;
          updatePromptsMetrics();
          setFeedback(`Đã nhập ${lines.length} câu lệnh từ file!`, true);
        } catch (err) {
          setFeedback(`Lỗi nhập tệp: ${err.message}`, false);
        }
      });
    }

    // Save prompt button
    document.querySelector("#promptSaveBtn")?.addEventListener("click", async () => {
      const val = promptsArea?.value.trim();
      if (!val) { setFeedback("Vui lòng nhập câu lệnh để lưu!", false); return; }
      const item = { id: crypto.randomUUID?.() || `${Date.now()}`, name: val.slice(0, 36), prompt: val, createdAt: Date.now() };
      savedPrompts = [item, ...savedPrompts.filter(p => p.prompt !== val)].slice(0, 100);
      await writeUiStorage(SAVED_PROMPTS_KEY, savedPrompts);
      renderSavedPrompts();
      setFeedback("Đã lưu câu lệnh vào thư viện Prompts!", true);
    });

    // Provider Tabs
    document.querySelectorAll("#genProviderTabs .provider-tab").forEach(tab => {
      tab.addEventListener("click", () => {
        document.querySelectorAll("#genProviderTabs .provider-tab").forEach(button => {
          const selected = button === tab;
          button.classList.toggle("provider-tab--active", selected);
          button.setAttribute("aria-selected", String(selected));
        });
        const provider = tab.getAttribute("data-provider") || "flow";
        const hiddenProvider = document.querySelector("#genProvider");
        if (hiddenProvider) hiddenProvider.value = provider;
        if (provider !== "flow") {
          setFeedback(`Provider: ${provider.toUpperCase()} (Tự động thực thi qua Flow MCP Studio)`, true);
        } else {
          setFeedback("Google Flow Provider đang hoạt động", true);
        }
      });
    });

    // Gen Type Toggle
    function setGenType(type = "image") {
      const normalizedType = String(type).toLowerCase() === "video" ? "video" : "image";
      const compactBar = document.querySelector("#genCompactBar");
      if (compactBar) compactBar.dataset.genMode = normalizedType;
      document.querySelectorAll("#genTypeToggle .gen-type-btn").forEach(btn => {
        const buttonType = String(btn.dataset.value || "").toLowerCase();
        const active = buttonType === normalizedType;
        const locale = typeof I18n !== "undefined" ? I18n.getLocale() : "vi";
        btn.classList.toggle("active", active);
        btn.setAttribute("aria-pressed", String(active));
        btn.setAttribute("aria-label", locale === "en"
          ? buttonType === "video" ? "Create video" : "Create image"
          : buttonType === "video" ? "Tạo video" : "Tạo ảnh");
      });
      const hiddenGenType = document.querySelector("#genType");
      if (hiddenGenType && hiddenGenType.value !== normalizedType) hiddenGenType.value = normalizedType;

      const isImage = normalizedType === "image";
      document.querySelector("#imageModelContainer")?.classList.toggle("hidden", !isImage);
      document.querySelector("#videoModelContainer")?.classList.toggle("hidden", isImage);
      document.querySelector("#videoInputTypeContainer")?.classList.toggle("hidden", isImage);
      document.querySelector("#flowVideoDurationContainer")?.classList.toggle("hidden", isImage);
      document.querySelector("#flowVideoResolutionContainer")?.classList.toggle("hidden", isImage);
      document.querySelector("#genVideoVoiceContainer")?.classList.toggle("hidden", isImage);

      const isFrames = String(document.querySelector("#videoInputType")?.value || "").toLowerCase() === "frames";
      document.querySelector("#videoFramesSection")?.classList.toggle("hidden", isImage || !isFrames);

      const submitText = document.querySelector("#genSubmitBtnText");
      if (submitText) submitText.textContent = isImage ? t("sidebar.btnGenerateImage", "Tạo ảnh") : t("sidebar.btnGenerateVideo", "Tạo video");

      referencePicker.renderReferenceCards?.(normalizedType);
    }

    document.querySelectorAll("#genTypeToggle .gen-type-btn").forEach(btn => {
      btn.addEventListener("click", () => setGenType(btn.dataset.value || "image"));
    });
    const hiddenGenType = document.querySelector("#genType");
    hiddenGenType?.addEventListener("change", () => setGenType(hiddenGenType.value));
    setGenType(hiddenGenType?.value || document.querySelector("#genTypeToggle .gen-type-btn.active")?.dataset.value || "image");

    // Model selects synchronization
    document.querySelector("#imageModel")?.addEventListener("change", function () {
      const sel = document.querySelector("#selectModelImage");
      if (sel && sel.value !== this.value) {
        sel.value = this.value;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });

    document.querySelector("#videoModel")?.addEventListener("change", function () {
      const sel = document.querySelector("#selectModelVideo");
      if (sel && sel.value !== this.value) {
        sel.value = this.value;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });

    // Aspect ratio synchronization
    document.querySelector("#aspectRatio")?.addEventListener("change", function () {
      const val = this.value;
      const ratioImage = document.querySelector("#selectRatioImage");
      const ratioVideo = document.querySelector("#selectRatioVideo");
      if (ratioImage) ratioImage.value = val;
      if (ratioVideo) ratioVideo.value = val;
    });

    // Quantity controls
    const quantityInput = document.querySelector("#quantitySelect");
    const qtyMinus = document.querySelector("#genQtyMinus");
    const qtyPlus = document.querySelector("#genQtyPlus");

    function setQuantity(val) {
      const clamped = Math.max(1, Math.min(4, Number(val) || 1));
      if (quantityInput) quantityInput.value = String(clamped);
      const selectQtyImage = document.querySelector("#selectQtyImage");
      const selectCountVideo = document.querySelector("#selectCountVideo");
      if (selectQtyImage) selectQtyImage.value = String(clamped);
      if (selectCountVideo) selectCountVideo.value = String(clamped);
    }

    qtyMinus?.addEventListener("click", () => setQuantity((Number(quantityInput?.value) || 1) - 1));
    qtyPlus?.addEventListener("click", () => setQuantity((Number(quantityInput?.value) || 1) + 1));
    quantityInput?.addEventListener("change", e => setQuantity(e.target.value));

    // Video frames and inputs
    document.querySelector("#videoInputType")?.addEventListener("change", function () {
      const mode = String(this.value || "ingredients").toLowerCase();
      const selectModeVideo = document.querySelector("#selectModeVideo");
      if (selectModeVideo) {
        selectModeVideo.value = mode;
        selectModeVideo.dispatchEvent(new Event("change", { bubbles: true }));
      }
      const framesSection = document.querySelector("#videoFramesSection");
      if (framesSection) framesSection.classList.toggle("hidden", mode !== "frames");
      document.querySelector("#genVideoVoiceContainer")?.classList.toggle("hidden", mode === "frames");
    });

    document.querySelector("#genTabFrame1Slot")?.addEventListener("click", () => {
      referencePicker.openFrames(sources => {
        videoFrameSources = sources;
        renderVideoFrameSources();
        if (sources[0]) {
          applyVideoFrameAssignment("start");
          const img = document.querySelector("#genTabFrame1Slot img") || document.createElement("img");
          img.src = sources[0].source === "flow" ? sources[0].thumbnailUrl : sources[0].previewUrl;
          document.querySelector("#genTabFrame1Slot")?.replaceChildren(img);
        }
      });
    });

    document.querySelector("#genTabFrame2Slot")?.addEventListener("click", () => {
      referencePicker.openFrames(sources => {
        videoFrameSources = sources;
        renderVideoFrameSources();
        if (sources[1]) {
          if (!videoFrameAssignments[0]) videoFrameAssignments[0] = { first: null, last: null };
          videoFrameAssignments[0].last = sources[1];
          const img = document.querySelector("#genTabFrame2Slot img") || document.createElement("img");
          img.src = sources[1].source === "flow" ? sources[1].thumbnailUrl : sources[1].previewUrl;
          document.querySelector("#genTabFrame2Slot")?.replaceChildren(img);
        }
      });
    });

    // Reference images buttons
    document.querySelector("#openImagePickerBtn")?.addEventListener("click", () => {
      const currentGenType = document.querySelector("#genType")?.value || "image";
      referencePicker.open(currentGenType);
    });

    document.querySelector("#clearAllGenRefsBtn")?.addEventListener("click", () => {
      const currentGenType = document.querySelector("#genType")?.value || "image";
      const list = referencePicker.getReferences(currentGenType);
      list.splice(0, list.length);
      referencePicker.renderReferenceCards(currentGenType);
    });

    document.querySelector("#refImageMode")?.addEventListener("change", function () {
      const val = this.value;
      const multiRefModeImage = document.querySelector("#multiRefModeImage");
      const multiRefModeVideo = document.querySelector("#multiRefModeVideo");
      if (multiRefModeImage) multiRefModeImage.value = val;
      if (multiRefModeVideo) multiRefModeVideo.value = val;
    });

    // Submit & Stop
    document.querySelector("#genSubmitBtn")?.addEventListener("click", () => {
      const isImage = (document.querySelector("#genType")?.value || "image") === "image";
      const pArea = document.querySelector("#promptsArea");
      if (pArea) {
        const val = pArea.value.trim();
        const targetInput = document.querySelector(isImage ? "#inputPromptImage" : "#inputPromptVideo");
        if (targetInput) {
          targetInput.value = val;
          targetInput.dispatchEvent(new Event("input", { bubbles: true }));
        }
      }
      const targetSubmit = document.querySelector(isImage ? "#btnSubmitImage" : "#btnSubmitVideo");
      targetSubmit?.click();
    });

    document.querySelector("#startBtn")?.addEventListener("click", () => {
      document.querySelector("#genSubmitBtn")?.click();
    });

    document.querySelector("#genStopBtn")?.addEventListener("click", async () => {
      try {
        await chrome.runtime.sendMessage({ type: "flow-queue:pause" });
        setFeedback("Đã gửi yêu cầu tạm dừng hàng đợi Flow.", true);
      } catch (err) {
        setFeedback(`Không thể dừng hàng đợi: ${err.message}`, false);
      }
    });

  }

  // 6. Style dropdown
  function initStyleDropdown() {
    const STYLES = [
      { label: "Mặc định (Không phong cách)", value: "" },
      { label: "Photorealistic 8K", value: ", photorealistic, 8k resolution, highly detailed, realistic lighting" },
      { label: "Cinematic Film 35mm", value: ", cinematic lighting, 35mm film photograph, dramatic atmosphere" },
      { label: "Anime Makoto Shinkai", value: ", anime style, vibrant skies, emotional lighting, Makoto Shinkai aesthetic" },
      { label: "3D Pixar Animation", value: ", 3D animated character, Pixar render style, smooth textures, expressive" },
      { label: "Cyberpunk Neon", value: ", cyberpunk, glowing neon lights, futuristic city rain, high contrast" },
      { label: "Watercolor Art", value: ", watercolor painting, soft color bleeding, textured paper background" },
      { label: "Vintage 1970s Retro", value: ", vintage 1970s photo, grainy film, warm muted tones, nostalgic" },
      { label: "Studio Portrait Lighting", value: ", professional studio portrait, softbox rim lighting, sharp focus" },
      { label: "Dark Fantasy Oil Painting", value: ", dark fantasy, oil on canvas, rich brush strokes, ominous lighting" }
    ];

    const trigger = document.querySelector("#addonPromptTrigger");
    const popup = document.querySelector("#addonPromptPopup");
    const search = document.querySelector("#addonPromptSearch");
    const list = document.querySelector("#addonPromptList");
    const label = document.querySelector("#addonPromptLabel");

    if (!trigger || !popup || !list) return;

    function renderStyles(query = "") {
      list.replaceChildren();
      const filtered = STYLES.filter(s => !query || s.label.toLowerCase().includes(query.toLowerCase()));
      for (const s of filtered) {
        const item = document.createElement("div");
        item.className = "addon-prompt-item";
        item.textContent = s.label;
        item.onclick = () => {
          if (label) label.textContent = s.value ? s.label.split(" ")[0] : "Style";
          popup.classList.add("hidden");
          const promptsArea = document.querySelector("#promptsArea");
          if (s.value && promptsArea) {
            promptsArea.value = promptsArea.value.trim() ? `${promptsArea.value.trim()}${s.value}` : s.value.replace(/^,\s*/, "");
            promptsArea.dispatchEvent(new Event("input", { bubbles: true }));
          }
        };
        list.appendChild(item);
      }
    }

    trigger.onclick = e => {
      e.stopPropagation();
      popup.classList.toggle("hidden");
      if (!popup.classList.contains("hidden")) renderStyles();
    };

    search?.addEventListener("input", e => renderStyles(e.target.value));

    document.addEventListener("click", e => {
      if (!popup.contains(e.target) && !trigger.contains(e.target)) {
        popup.classList.add("hidden");
      }
    });
  }

  // 7. Enhanced Character & Voice Modals
  function initCharacterAndVoiceModals() {
    async function openCharacterModal() {
      const container = document.querySelector("#characterSelectModalContainer");
      if (!container) return;
      if (!currentCharacters.length) {
        setFeedback("Đang tải danh sách nhân vật từ Flow...", true);
        await loadFlowCharacters();
      }
      const currentVal = document.querySelector("#genCharacterSelect")?.value || "";

      const itemsHtml = [
        `<div class="style-modal-item none-option ${!currentVal ? "selected" : ""}" data-val="">
          <div class="style-modal-item-icon">👤</div>
          <div class="voice-modal-item-info">
            <span class="style-modal-item-name">Không chọn</span>
            <span class="voice-modal-item-desc">Tạo ảnh/video không chỉ định nhân vật</span>
          </div>
        </div>`,
        ...currentCharacters.map(c => {
          const name = typeof c === "string" ? c : c.name;
          const uuid = typeof c === "object" && c.uuid ? c.uuid : "";
          const val = uuid ? `flow-character:${uuid}` : `flow-character-name:${name}`;
          const isSelected = val === currentVal || name === currentVal;
          return `
            <div class="style-modal-item ${isSelected ? "selected" : ""}" data-val="${escapeHtml(val)}" data-name="${escapeHtml(name)}">
              <div class="style-modal-item-icon">👤</div>
              <div class="voice-modal-item-info">
                <span class="style-modal-item-name">${escapeHtml(name)}</span>
              </div>
              ${isSelected ? '<svg class="style-modal-item-check" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>' : ''}
            </div>
          `;
        })
      ].join("");

      container.innerHTML = `
        <div class="style-modal-overlay" id="characterSelectModalOverlay">
          <div class="style-modal-backdrop"></div>
          <div class="style-modal-content">
            <div class="style-modal-header">
              <h3 class="style-modal-title">Chọn nhân vật Flow</h3>
              <div class="voice-modal-header-actions">
                <button type="button" class="voice-modal-sync-btn" id="characterModalSyncBtn" title="Đồng bộ từ Flow">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>
                </button>
                <button type="button" class="style-modal-close" id="characterModalClose">×</button>
              </div>
            </div>
            <div class="style-modal-search">
              <input type="text" id="characterModalSearch" placeholder="Tìm nhân vật..." />
            </div>
            <div class="style-modal-list" id="characterModalList">${itemsHtml}</div>
          </div>
        </div>
      `;

      const overlay = container.querySelector("#characterSelectModalOverlay");
      const close = () => overlay?.remove();
      overlay?.querySelector(".style-modal-backdrop")?.addEventListener("click", close);
      overlay?.querySelector("#characterModalClose")?.addEventListener("click", close);

      overlay?.querySelector("#characterModalSyncBtn")?.addEventListener("click", async () => {
        setFeedback("Đang tải danh sách nhân vật từ Flow...", true);
        await loadFlowCharacters();
        openCharacterModal();
      });

      overlay?.querySelector("#characterModalSearch")?.addEventListener("input", e => {
        const q = e.target.value.toLowerCase().trim();
        overlay.querySelectorAll(".style-modal-item").forEach(item => {
          const text = item.textContent.toLowerCase();
          item.style.display = !q || text.includes(q) ? "flex" : "none";
        });
      });

      overlay?.querySelectorAll(".style-modal-item").forEach(item => {
        item.addEventListener("click", () => {
          const val = item.dataset.val || "";
          const name = item.dataset.name || "";
          const charSelect = document.querySelector("#genCharacterSelect");
          const charLabel = document.querySelector("#genCharacterLabel");
          if (charSelect) charSelect.value = val;
          if (charLabel) charLabel.textContent = name || "Character";

          const selectCharImage = document.querySelector("#selectCharImage");
          const selectCharVideo = document.querySelector("#selectCharVideo");
          if (selectCharImage) selectCharImage.value = val;
          if (selectCharVideo) selectCharVideo.value = val;
          close();
        });
      });
    }

    async function openVoiceModal() {
      const container = document.querySelector("#voiceSelectModalContainer");
      if (!container) return;
      const currentVal = document.querySelector("#genVideoVoiceSelect")?.value || "";

      let voices = [];
      try {
        const res = await dispatchFlowOperation("flow.voices.options");
        voices = Array.isArray(res?.voices) ? res.voices : (Array.isArray(res) ? res : []);
      } catch (_) {}

      const itemsHtml = [
        `<div class="style-modal-item ${!currentVal ? "selected" : ""}" data-val="">
          <div class="voice-modal-item-info">
            <span class="style-modal-item-name">Random voice</span>
            <span class="voice-modal-item-desc">Tự động chọn giọng nói</span>
          </div>
        </div>`,
        ...voices.map(v => {
          const name = typeof v === "string" ? v : v.name;
          const isSelected = name === currentVal;
          return `
            <div class="style-modal-item ${isSelected ? "selected" : ""}" data-val="${escapeHtml(name)}">
              <div class="voice-modal-item-info">
                <span class="style-modal-item-name">${escapeHtml(name)}</span>
              </div>
              ${isSelected ? '<svg class="style-modal-item-check" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>' : ''}
            </div>
          `;
        })
      ].join("");

      container.innerHTML = `
        <div class="style-modal-overlay" id="voiceSelectModalOverlay">
          <div class="style-modal-backdrop"></div>
          <div class="style-modal-content">
            <div class="style-modal-header">
              <h3 class="style-modal-title">Chọn giọng nói Flow</h3>
              <button type="button" class="style-modal-close" id="voiceModalClose">×</button>
            </div>
            <div class="style-modal-list">${itemsHtml}</div>
          </div>
        </div>
      `;

      const overlay = container.querySelector("#voiceSelectModalOverlay");
      const close = () => overlay?.remove();
      overlay?.querySelector(".style-modal-backdrop")?.addEventListener("click", close);
      overlay?.querySelector("#voiceModalClose")?.addEventListener("click", close);

      overlay?.querySelectorAll(".style-modal-item").forEach(item => {
        item.addEventListener("click", () => {
          const val = item.dataset.val || "";
          const voiceSelect = document.querySelector("#genVideoVoiceSelect");
          const voiceLabel = document.querySelector("#genVideoVoiceLabel");
          const flowVoiceSelect = document.querySelector("#flowVoiceSelect");
          if (voiceSelect) voiceSelect.value = val;
          if (voiceLabel) voiceLabel.textContent = val || "Random voice";
          if (flowVoiceSelect) flowVoiceSelect.value = val;
          close();
        });
      });
    }

    document.querySelector("#genCharacterTrigger")?.addEventListener("click", openCharacterModal);
    document.querySelector("#genVideoVoiceTrigger")?.addEventListener("click", openVoiceModal);
  }

  // Initialize
  const initLocale = typeof I18n !== "undefined" ? I18n.init() : Promise.resolve();
  const queueContainer = document.querySelector("#flowQueuePanel");
  const queuePage = document.querySelector("#queuePage");
  if (queueContainer && queuePage) queuePage.append(queueContainer);
  const libraryTools = document.querySelector("#flowLibraryTools");
  const libraryPage = document.querySelector("#libraryPage");
  if (libraryTools && libraryPage) {
    libraryTools.open = true;
    libraryPage.append(libraryTools);
  }
  if (queueContainer && window.FlowQueuePanel) flowQueuePanel = new window.FlowQueuePanel(queueContainer).mount();
  initLocale.then(async () => {
    initTheme();
    initSettingsAndHeader();
    initScreenCapture();
    initSubtabs();
    initTobyGenControls();
    initStyleDropdown();
    initCharacterAndVoiceModals();
    await loadFlowModelCapabilities();
    applyLanguage();
    return loadLocalUiState();
  }).then(() => {
    return fetchStatus();
  }).then(() => {
    return loadFlowCharacters();
  });

  // Auto poll status periodically
  setInterval(fetchStatus, 3000);
})();
