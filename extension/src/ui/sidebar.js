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
      const models = registry.uiModels?.[type];
      if (!select || !Array.isArray(models) || !models.length) continue;
      const previous = select.value;
      select.replaceChildren();
      for (const model of models) {
        if (!model?.value) continue;
        const option = document.createElement("option");
        option.value = String(model.value);
        option.textContent = String(model.labels?.[locale] || model.label || model.value);
        select.appendChild(option);
      }
      select.value = models.some(model => String(model.value) === previous)
        ? previous : String(models[0]?.value || "");
    }

    const imageModel = document.querySelector("#selectModelImage")?.value;
    const imageRule = getFlowModelRule("image", imageModel);
    if (imageRule?.aspectRatios?.length) {
      replaceSelectOptions(document.querySelector("#selectRatioImage"), imageRule.aspectRatios, value => value, "9:16");
    }

    const videoModelSelect = document.querySelector("#selectModelVideo");
    const videoModel = videoModelSelect?.value;
    const durationSelect = document.querySelector("#selectDurationVideo");
    const resolutionSelect = document.querySelector("#selectResolutionVideo");
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
    if (durationSelect) durationSelect.disabled = fixedDuration !== null;

    const resolutionGroup = document.querySelector("#videoResolutionGroup");
    const resolutions = Array.isArray(videoRule.resolutions) ? videoRule.resolutions : [];
    if (resolutionGroup) resolutionGroup.hidden = resolutions.length === 0;
    if (resolutionGroup && !resolutions.length) {
      resolutionGroup.querySelector("#lblResolutionVideo").textContent = `${t("sidebar.videoResolution")}:`;
    }
    replaceSelectOptions(resolutionSelect, resolutions, value => String(value), rememberedSelection.resolution ?? videoRule.defaultResolution, videoModelChanged);
    if (resolutionSelect) resolutionSelect.disabled = resolutions.length === 0;

    const quantityGroup = document.querySelector("#videoCountGroup");
    const quantities = getValidVideoQuantities(videoRule);
    if (quantityGroup) quantityGroup.hidden = quantities.length === 0;
    const quantityDefault = getValidVideoQuantitySelection(videoRule, rememberedSelection.quantity ?? videoRule.defaultQuantity);
    replaceSelectOptions(quantitySelect, quantities, value => String(value), quantityDefault, videoModelChanged);

    if (videoRule.aspectRatios?.length) {
      replaceSelectOptions(ratioSelect, videoRule.aspectRatios, value => value, rememberedSelection.aspectRatio ?? "9:16", videoModelChanged);
    }
    const framesOption = document.querySelector('#selectModeVideo option[value="frames"]');
    if (framesOption) {
      framesOption.disabled = videoRule.supportsFrames !== true;
      if (framesOption.disabled && document.querySelector("#selectModeVideo")?.value === "frames") {
        document.querySelector("#selectModeVideo").value = "ingredients";
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

  function applyLanguage() {
    const cur = typeof I18n !== "undefined" ? I18n.getLocale() : "vi";
    document.documentElement.lang = cur;
    if (typeof I18n !== "undefined") I18n.applyTranslations(document);
    flowQueuePanel?.setLocale?.(cur);
    document.querySelector("#langSwitchLabel").textContent = cur.toUpperCase();

    // Tabs
    document.querySelector("#tabCreateLabel").textContent = t("sidebar.tabGen");
    document.querySelector("#tabWorkflowLabel").textContent = t("sidebar.tabWorkflow");
    document.querySelector("#tabPromptsLabel").textContent = t("sidebar.tabPrompts");
    document.querySelector("#tabLibraryLabel").textContent = t("sidebar.tabLibrary");
    document.querySelector("#tabTasksLabel").textContent = t("sidebar.tabTasks");
    document.querySelector("#tabHistoryLabel").textContent = t("sidebar.tabHistory");
    document.querySelector("#tabStatusLabel").textContent = t("sidebar.tabStatus");
    document.querySelector("#tabLogsLabel").textContent = t("sidebar.tabLogs");
    document.querySelector("#tabSettingsLabel").textContent = t("sidebar.tabSettings");
    for (const [id, key] of [
      ["viewCreateTitle", "viewCreateTitle"], ["viewCreateSubtitle", "viewCreateSubtitle"],
      ["viewWorkflowTitle", "viewWorkflowTitle"], ["viewWorkflowSubtitle", "viewWorkflowSubtitle"],
      ["viewPromptsTitle", "viewPromptsTitle"], ["viewPromptsSubtitle", "viewPromptsSubtitle"],
      ["viewLibraryTitle", "viewLibraryTitle"], ["viewLibrarySubtitle", "viewLibrarySubtitle"],
      ["viewTasksTitle", "viewTasksTitle"], ["viewTasksSubtitle", "viewTasksSubtitle"],
      ["viewHistoryTitle", "viewHistoryTitle"], ["viewHistorySubtitle", "viewHistorySubtitle"],
      ["viewStatusTitle", "viewStatusTitle"], ["viewStatusSubtitle", "viewStatusSubtitle"],
      ["viewLogsTitle", "viewLogsTitle"], ["viewLogsSubtitle", "viewLogsSubtitle"],
      ["viewSettingsTitle", "viewSettingsTitle"], ["viewSettingsSubtitle", "viewSettingsSubtitle"],
    ]) document.querySelector(`#${id}`).textContent = t(`sidebar.${key}`);

    // Mode Segments
    document.querySelector("#txtModeImage").textContent = t("sidebar.typeImage");
    document.querySelector("#txtModeVideo").textContent = t("sidebar.typeVideo");
    document.querySelector("#txtModeCharacter").textContent = t("sidebar.typeCharacter");

    document.querySelector("#lblWorkflowType").textContent = t("sidebar.workflowType");
    document.querySelector("#optWorkflowAgent").textContent = t("sidebar.workflowAgent");
    document.querySelector("#optWorkflowEdit").textContent = t("sidebar.workflowEdit");
    document.querySelector("#optWorkflowContinue").textContent = t("sidebar.workflowContinue");
    document.querySelector("#lblWorkflowScenes").textContent = t("sidebar.workflowScenes");
    document.querySelector("#workflowScenes").placeholder = t("sidebar.workflowScenesPlaceholder");
    document.querySelector("#lblWorkflowAsset").textContent = t("sidebar.workflowAsset");
    document.querySelector("#workflowAsset").placeholder = t("sidebar.workflowAssetPlaceholder");
    document.querySelector("#lblWorkflowAspect").textContent = t("sidebar.workflowAspect");
    document.querySelector("#lblWorkflowExtra").textContent = t("sidebar.workflowExtra");
    document.querySelector("#workflowPromptExtra").placeholder = t("sidebar.workflowOptional");
    document.querySelector("#txtRunWorkflow").textContent = t("sidebar.workflowRun");
    document.querySelector("#workflowScopeNote").textContent = cur === "vi"
      ? "Extension chỉ gửi lệnh vào hàng đợi; thao tác DOM diễn ra trong tab Flow."
      : "The extension only queues the request; DOM actions run inside the Flow tab.";
    document.querySelector("#lblPromptName").textContent = t("sidebar.promptName");
    document.querySelector("#lblPromptDraft").textContent = t("sidebar.promptLabel");
    document.querySelector("#promptDraft").placeholder = t("sidebar.promptPlaceholder");
    document.querySelector("#promptName").placeholder = t("sidebar.promptNamePlaceholder");
    document.querySelector("#txtSavePrompt").textContent = t("sidebar.promptSave");
    document.querySelector("#btnRefreshHistory").textContent = t("sidebar.historyRefresh");
    document.querySelector("#btnClearHistory").textContent = t("sidebar.historyClear");
    document.querySelector("#savedPromptsEmpty").textContent = t("sidebar.promptEmpty");
    document.querySelector("#flowHistoryEmpty").textContent = t("sidebar.historyEmpty");
    document.querySelector("#flowHistoryActivity").textContent = t("sidebar.historyActivity");

    // Form Image
    document.querySelector("#lblPromptImage").textContent = t("sidebar.promptLabel") + ":";
    document.querySelector("#inputPromptImage").placeholder = t("sidebar.promptPlaceholder");
    document.querySelector("#lblRatioImage").textContent = t("sidebar.aspectRatio") + ":";
    document.querySelector("#lblModelImage").textContent = t("sidebar.imageModel") + ":";
    document.querySelector("#lblQtyImage").textContent = t("sidebar.quantity") + ":";
    document.querySelector("#lblCharImage").textContent = t("sidebar.characterSelect") + ":";
    document.querySelector("#btnImportPromptsImage").textContent = t("sidebar.multiPromptImport");
    document.querySelector("#promptBatchHintImage").textContent = t("sidebar.multiPromptHint");
    document.querySelector("#txtBtnSubmitImage").textContent = t("sidebar.btnGenerateImage");

    // Form Video
    document.querySelector("#lblPromptVideo").textContent = t("sidebar.promptLabel") + ":";
    document.querySelector("#inputPromptVideo").placeholder = t("sidebar.promptPlaceholderVideo");
    document.querySelector("#btnImportPromptsVideo").textContent = t("sidebar.multiPromptImport");
    document.querySelector("#promptBatchHintVideo").textContent = t("sidebar.multiPromptHint");
    document.querySelector("#lblRatioVideo").textContent = t("sidebar.aspectRatio") + ":";
    document.querySelector("#lblDurationVideo").textContent = t("sidebar.videoDuration") + ":";
    document.querySelector("#lblModelVideo").textContent = t("sidebar.videoModel") + ":";
    document.querySelector("#lblQtyVideo").textContent = t("sidebar.quantity") + ":";
    document.querySelector("#lblResolutionVideo").textContent = t("sidebar.videoResolution") + ":";
    document.querySelector("#lblModeVideo").textContent = t("sidebar.videoMode") + ":";
    document.querySelector("#lblCharVideo").textContent = t("sidebar.characterSelect") + ":";
    document.querySelector("#videoFrameNamesHint").textContent = t("sidebar.videoFrameNamesHint");
    updateVideoChainUI();
    renderVideoFrameSources();
    renderVideoFrameAssignments();
    updateVideoFrameInputs();
    applyFlowModelControls();
    document.querySelector("#txtBtnSubmitVideo").textContent = t("sidebar.btnGenerateVideo");
    updatePromptFormFeedback("image");
    updatePromptFormFeedback("video");

    // Form Character
    document.querySelector("#lblCharName").textContent = t("sidebar.charNameLabel") + ":";
    document.querySelector("#inputCharName").placeholder = t("sidebar.charNamePlaceholder");
    document.querySelector("#lblCharDesc").textContent = t("sidebar.charDescLabel") + ":";
    document.querySelector("#inputCharDesc").placeholder = t("sidebar.charDescPlaceholder");
    document.querySelector("#txtBtnSubmitChar").textContent = t("sidebar.btnCreateCharacter");

    // Status pane
    document.querySelector("#lblFlowTabs").textContent = t("popup.flowTabs");
    document.querySelector("#lblSelectedTab").textContent = t("popup.selectedTab");
    document.querySelector("#lblQuickActions").textContent = t("sidebar.quickActions");
    document.querySelector("#txtBtnReconnect").textContent = t("sidebar.btnReconnect");
    document.querySelector("#txtBtnPreview").textContent = t("sidebar.btnPreview");
    document.querySelector("#txtBtnOpenFlow").textContent = t("sidebar.btnOpenFlow");

    // Logs pane
    document.querySelector("#lblLogsTitle").textContent = t("sidebar.tabLogs");
    document.querySelector("#btnClearLogs").textContent = t("sidebar.clearLogs");
    const emptyEl = document.querySelector("#logsEmpty");
    if (emptyEl) emptyEl.textContent = t("sidebar.logsEmpty");

    // Settings pane
    const saveSettingsLabel = document.querySelector("#txtSaveSettings");
    if (saveSettingsLabel) saveSettingsLabel.textContent = t("sidebar.saveSettings");

    if (cachedStatus) renderStatus(cachedStatus);
    else document.querySelector("#wsText").textContent = t("popup.checking");
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

  function populateCharacterSelects() {
    const selects = [document.querySelector("#selectCharImage"), document.querySelector("#selectCharVideo")];
    selects.forEach(sel => {
      if (!sel) return;
      const currentVal = sel.value;
      sel.innerHTML = `<option value="">${t("sidebar.characterNone")}</option>`;
      currentCharacters.forEach(c => {
        const name = typeof c === "string" ? c : c.name;
        if (!name) return;
        const opt = document.createElement("option");
        opt.value = name;
        opt.textContent = `👤 ${name}`;
        if (opt.value === currentVal) opt.selected = true;
        sel.appendChild(opt);
      });
    });
  }

  // Toby-style views with roving focus for keyboard users.
  const tabs = [...document.querySelectorAll(".tobyflow-tab")];
  const activateTab = tab => {
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
      if (targetId === "tab-library" && !flowPhotosScanned) {
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

  // Mode Segments switching (Image / Video / Character)
  function selectCreationMode(mode = "image") {
    const selected = document.querySelector(`.mode-segment-btn[data-mode="${mode}"]`);
    if (!selected) return;
    document.querySelectorAll(".mode-segment-btn").forEach(button => button.classList.toggle("active", button === selected));
    document.querySelector("#formImage").style.display = mode === "image" ? "flex" : "none";
    document.querySelector("#formVideo").style.display = mode === "video" ? "flex" : "none";
    document.querySelector("#formCharacter").style.display = mode === "character" ? "flex" : "none";
    setFeedback("");
  }
  document.querySelectorAll(".mode-segment-btn").forEach(btn => {
    btn.addEventListener("click", () => selectCreationMode(btn.getAttribute("data-mode")));
  });
  const resetCreationView = () => {
    const createTab = document.querySelector("#navCreate");
    if (createTab) activateTab(createTab);
    selectCreationMode("image");
  };
  resetCreationView();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") resetCreationView();
  });

  function syncWorkflowFields() {
    const type = document.querySelector("#workflowType")?.value || "agent";
    const scenesGroup = document.querySelector("#workflowScenesGroup");
    const assetGroup = document.querySelector("#workflowAssetGroup");
    if (scenesGroup) scenesGroup.hidden = type !== "agent";
    if (assetGroup) assetGroup.hidden = type === "agent";
  }

  async function queueLocalWorkflow() {
    const type = document.querySelector("#workflowType")?.value || "agent";
    const scenes = document.querySelector("#workflowScenes")?.value.split(/\r?\n/).map(item => item.trim()).filter(Boolean) || [];
    const asset = document.querySelector("#workflowAsset")?.value.trim() || "";
    const extra = document.querySelector("#workflowPromptExtra")?.value.trim() || "";
    const aspectRatio = document.querySelector("#workflowAspect")?.value || "16:9";
    let operation;
    let payload;
    let label;
    if (type === "agent") {
      if (!scenes.length) throw new Error(t("sidebar.workflowNeedScenes"));
      operation = "flow.agent.batch";
      payload = { params: { agent_scenes: scenes.map(scene => extra ? `${scene} ${extra}` : scene), aspect_ratio: aspectRatio, type: "image" } };
      label = `Agent batch: ${scenes.length} scenes`;
    } else {
      if (!asset) throw new Error(t("sidebar.workflowNeedAsset"));
      const prompt = extra || (scenes[0] || "");
      if (!prompt) throw new Error(t("sidebar.workflowNeedScenes"));
      operation = type === "edit" ? "flow.edit.run" : "flow.continue.run";
      payload = { params: type === "edit"
        ? { edit_asset: asset, prompt, type: "video" }
        : { continue_from: asset, prompt, continue_mode: "exact", aspect_ratio: aspectRatio, type: "video" } };
      label = `${type === "edit" ? "Edit" : "Continue"}: ${asset}`;
    }
    const result = await chrome.runtime.sendMessage({ type: "flow-queue:add", job: { operation, payload, label } });
    if (!result?.ok) throw new Error(result?.error?.message || "Could not add workflow to the Flow queue.");
    rememberSubmittedQueueJob(result);
    setFeedback(t("sidebar.workflowQueued"), true);
    addLog(operation, label, true);
    document.querySelector("#workflowScenes").value = "";
    document.querySelector("#workflowAsset").value = "";
    document.querySelector("#workflowPromptExtra").value = "";
  }

  document.querySelector("#workflowType")?.addEventListener("change", syncWorkflowFields);
  document.querySelector("#btnRunWorkflow")?.addEventListener("click", async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try { await queueLocalWorkflow(); }
    catch (error) { setFeedback(error.message || String(error), false); addLog("flow.workflow.error", error.message || String(error), false); }
    finally { button.disabled = false; }
  });
  syncWorkflowFields();

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
      if (item) { document.querySelector("#inputPromptImage").value = item.prompt; document.querySelector("#inputPromptVideo").value = item.prompt; document.querySelector("#navCreate")?.click(); setFeedback(t("sidebar.promptUse"), true); }
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
      const jobs = promptList.map((itemPrompt, index) => ({
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
          attachments: attachmentsPerPrompt?.[index] || attachments,
          ...((!chainVideo || index === 0) && firstFramesPerPrompt?.[index] ? { firstFrame: typeof firstFramesPerPrompt[index] === "string" ? { assetName: firstFramesPerPrompt[index] } : firstFramesPerPrompt[index] } : {}),
          ...(!chainVideo && lastFramesPerPrompt?.[index] ? { lastFrame: typeof lastFramesPerPrompt[index] === "string" ? { assetName: lastFramesPerPrompt[index] } : lastFramesPerPrompt[index] } : {}),
          ...(video_settings || {})
        },
        label: `[${type.toUpperCase()}] ${itemPrompt.slice(0, 96)}`,
      }));
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
          unresolvedNames.add(name);
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
    const character = document.querySelector("#selectCharImage").value;

    const commonAttachments = [];
    const referenceAttachments = [];
    const activeImageReferences = referenceMode === "none" ? []
      : referenceMode === "mention" ? mentionResolution.usedReferences
        : refFilesImage;
    if (character) {
      commonAttachments.push({ assetName: `character:${character}` });
    }

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
          const attachment = { assetName: reference.assetName, expectedId: reference.expectedId };
          referenceAttachments.push(attachment);
          attachmentByReference.set(reference, attachment);
          continue;
        }
        uploadedImageCount++;
        setFeedback(`Đang tải ảnh tham chiếu ${uploadedImageCount}/${localImageReferences.length} lên Flow...`, true);
        const uploaded = await uploadReferenceImage(reference.file, undefined, i + 1);
        const uploadedName = typeof uploaded === "string" ? uploaded : (uploaded?.name || uploaded?.title || String(uploaded));
        const uploadedId = typeof uploaded === "object" ? (uploaded?.id || uploaded?.mediaId) : undefined;
        const attachment = { assetName: `asset:${uploadedName}`, ...(uploadedId ? { expectedId: uploadedId } : {}) };
        referenceAttachments.push(attachment);
        attachmentByReference.set(reference, attachment);
      }

      const attachmentsPerPrompt = referenceMode === "mention"
        ? mentionResolution.assignments.map(references => [...commonAttachments, ...references.map(reference => attachmentByReference.get(reference)).filter(Boolean)])
        : assignBatchReferences(prompts, referenceMode, commonAttachments, referenceAttachments, referencesPerPrompt);
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
    const selectedCharacter = document.querySelector("#selectCharVideo").value;
    const character = mode === "frames" ? "" : selectedCharacter;
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
    const selectedVoice = document.querySelector("#flowVoiceSelect")?.value || "";
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
    if (character) {
      commonAttachments.push({ assetName: `character:${character}` });
    }

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
          const attachment = { assetName: reference.assetName, expectedId: reference.expectedId };
          referenceAttachments.push(attachment);
          attachmentByReference.set(reference, attachment);
          continue;
        }
        uploadedVideoCount++;
        setFeedback(`Đang tải ảnh tham chiếu ${uploadedVideoCount}/${localVideoReferences.length} lên Flow...`, true);
        const uploaded = await uploadReferenceImage(reference.file, undefined, i + 1);
        const uploadedName = typeof uploaded === "string" ? uploaded : (uploaded?.name || uploaded?.title || String(uploaded));
        const uploadedId = typeof uploaded === "object" ? (uploaded?.id || uploaded?.mediaId) : undefined;
        const attachment = { assetName: `asset:${uploadedName}`, ...(uploadedId ? { expectedId: uploadedId } : {}) };
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

      const attachmentsPerPrompt = hasFrames
        ? prompts.map(() => [])
        : referenceMode === "mention"
          ? mentionResolution.assignments.map(references => [...commonAttachments, ...references.map(reference => attachmentByReference.get(reference)).filter(Boolean)])
          : assignBatchReferences(prompts, referenceMode, commonAttachments, referenceAttachments, referencesPerPrompt);
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

  document.querySelector("#btnRefreshPhotos").onclick = event => runLibraryAction(event.currentTarget, refreshFlowPhotos);
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

  document.querySelector("#btnAttachReferences").onclick = event => runLibraryAction(event.currentTarget, async () => {
    const references = document.querySelector("#flowReferenceInput").value.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    if (!references.length) throw new Error("Nhập ít nhất một tham chiếu.");
    await assertQueueIdleForDirectAction();
    return dispatchFlowOperation("flow.references.attach", { references });
  });

  document.querySelector("#btnClearReferences").onclick = event => runLibraryAction(event.currentTarget, async () => {
    await assertQueueIdleForDirectAction();
    return dispatchFlowOperation("flow.references.clear", {});
  });

  document.querySelector("#btnRemoveReferenceKind").onclick = event => runLibraryAction(event.currentTarget, async () => {
    await assertQueueIdleForDirectAction();
    const kind = document.querySelector("#flowReferenceKindToRemove").value;
    return dispatchFlowOperation("flow.references.remove", { kind });
  });

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

  document.querySelector("#btnLoadVoices").onclick = event => runLibraryAction(event.currentTarget, async () => {
    const result = await dispatchFlowOperation("flow.voices.options");
    const voices = Array.isArray(result?.voices) ? result.voices : [];
    fillSelect(document.querySelector("#flowVoiceSelect"), voices,
      voice => typeof voice === "string" ? voice : voice.name,
      voice => typeof voice === "string" ? voice : voice.name,
      "Không dùng giọng nói");
    return result;
  });

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
