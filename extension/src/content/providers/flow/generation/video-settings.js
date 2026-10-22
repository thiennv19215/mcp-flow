// Video-generation settings strategy, including Ingredients/Frames mode selection.
(() => {
  "use strict";
  const root = globalThis;
  const settings = root.FlowSettings;
  const finishVideoPreparationDiagnostics = typeof settings?.finishVideoPreparationDiagnostics === "function"
    ? settings.finishVideoPreparationDiagnostics
    : () => console.warn("[FlowVideoSettings] Video preparation diagnostics are unavailable in this content-script build.");
  const { emitImagePreparationProgress, assertNativeModelCapabilities, flowSettingsPanelVisible, openFlowSettings, chooseRadio, chooseVideoOption, chooseNativeModel, findModelPickerButton, normalizeModelLabel, chooseNativeVariantCount, nativeRadioSelected, closeOwnedSettingsSurface, safeCreditQuoteDiagnostics, checkPreparation, waitPreparation, isNavControl, foldLabel } = settings || {};
  const modelLabelMatchesRequest = settings?.modelLabelMatchesRequest || root.modelLabelMatchesRequest;
  const MODE_ALIASES = {
    ingredients: ["ingredients", "thành phần", "nguyên liệu", "ingredient"],
    frames: ["frames", "khung hình", "khung", "frame"],
  };

  function exactModeControl(name) {
    const rawWanted = foldLabel(name);
    const aliases = (MODE_ALIASES[rawWanted] || [rawWanted]).map(foldLabel);
    const candidates = (typeof root.flowQueryAll === "function" ? root.flowQueryAll("settings.optionCandidates", document, { checkVisible: false }) : null) ||
      [...document.querySelectorAll('[role="radio"],mat-radio-button,[role="tab"],[role="option"],button,[role="button"]')];
    return candidates
      .find(element => {
        if (!root.visible?.(element) || isNavControl(element)) return false;
        const cName = foldLabel(String(root.accessibleName?.(element) || "").replace(/^(?:accessibility_new|dashboard|face)\s*/i, ""));
        return aliases.includes(cName) || aliases.some(a => cName.endsWith(` ${a}`));
      });
  }

  function isDisabledModeControl(control) {
    return Boolean(control && (control.disabled === true || control.hasAttribute?.("disabled") || control.getAttribute?.("aria-disabled") === "true"));
  }

  async function selectAndConfirmMode(name, framesMode, options = {}) {
    checkPreparation(options, `selecting Flow ${name} mode`);
    const unavailableCode = framesMode ? "FLOW_FRAMES_MODE_UNAVAILABLE" : "FLOW_VIDEO_MODE_UNAVAILABLE";
    const unavailableError = message => root.flowError(unavailableCode, message, true, false);
    let control = exactModeControl(name);
    if (isDisabledModeControl(control)) {
      throw unavailableError(`Flow's exact ${name} mode control is visible but disabled. Nothing was submitted.`);
    }
    if (!control) {
      const hasFrameControls = () => Boolean(root.flowButton?.("Start") && root.flowButton?.("End"));
      if (framesMode && hasFrameControls()) return;
      throw unavailableError(`Flow does not offer the exact ${name} mode for the selected model. Nothing was submitted.`);
    }
    if (!nativeRadioSelected(control) && control.getAttribute("aria-selected") !== "true") control.click();
    const hasFrameControls = () => Boolean(root.flowButton?.("Start") && root.flowButton?.("End"));
    const deadline = Math.min(Date.now() + 5000, Number.isFinite(options.deadline) ? options.deadline : Infinity);
    let confirmed = false;
    while (Date.now() < deadline) {
      checkPreparation(options, `confirming Flow ${name} mode`);
      control = exactModeControl(name);
      if (isDisabledModeControl(control)) {
        throw unavailableError(`Flow's exact ${name} mode control became disabled before selection could be confirmed. Nothing was submitted.`);
      }
      if (control && (nativeRadioSelected(control) || control.getAttribute("aria-selected") === "true" || (framesMode && hasFrameControls()))) { confirmed = true; break; }
      if (!flowSettingsPanelVisible()) await openFlowSettings(options);
      await waitPreparation(options, 100, `confirming Flow ${name} mode`);
    }
    if (!confirmed) {
      control = exactModeControl(name);
      if (isDisabledModeControl(control)) {
        throw unavailableError(`Flow's exact ${name} mode control is disabled. Nothing was submitted.`);
      }
      if (framesMode && hasFrameControls()) confirmed = true;
      else {
        const code = framesMode ? "FLOW_FRAMES_MODE_UNCONFIRMED" : "FLOW_VIDEO_MODE_UNCONFIRMED";
        throw root.flowError(code, `Flow did not confirm that ${name} mode is selected. Nothing was submitted.`, true, false);
      }
    }
    if (framesMode) {
      const controlsDeadline = Math.min(Date.now() + 4000, Number.isFinite(options.deadline) ? options.deadline : Infinity);
      while (Date.now() < controlsDeadline && !hasFrameControls()) await waitPreparation(options, 100, "waiting for Flow frame controls");
      if (!hasFrameControls()) {
        throw root.flowError("FLOW_FRAMES_CONTROLS_UNAVAILABLE", "Flow selected Frames but did not show both Start and End frame controls. Nothing was submitted.", true, false);
      }
    }
  }

  async function prepareNativeVideoSettings(payload, variants, framesMode, options = {}) {
    if (!settings || typeof emitImagePreparationProgress !== "function" || typeof openFlowSettings !== "function" || typeof chooseRadio !== "function") {
      throw root.flowError("FLOW_SETTINGS_UNAVAILABLE", "Flow's video settings module was not initialized in this tab. Reload the Flow tab before creating video.", true, false);
    }
    let ownsSettingsSurface = false;
    options = { ...options, videoPreparation: true, onSettingsOpened: () => { ownsSettingsSurface = true; } };
    emitImagePreparationProgress(options, "validating requested settings");
    const ensureSettingsSurface = async () => {
      const wasVisible = flowSettingsPanelVisible();
      await openFlowSettings(options);
      if (!wasVisible && flowSettingsPanelVisible()) ownsSettingsSurface = true;
    };
    try {
    const type = payload.type || "video";
    const requestedModel = payload.model || payload.video_settings?.model;
    const modeName = framesMode ? "Frames" : "Ingredients";
    const aspectRatio = payload.aspectRatio ?? payload.aspect_ratio ?? payload.video_settings?.aspectRatio ?? payload.video_settings?.aspect_ratio;
    const duration = payload.duration ?? payload.video_settings?.duration;
    const resolution = payload.resolution ?? payload.video_settings?.resolution;
    const modelCapabilities = await assertNativeModelCapabilities({
      ...payload,
      ...(requestedModel ? { model: requestedModel } : {}),
      ...(aspectRatio ? { aspectRatio } : {}),
      ...(duration != null ? { duration } : {}),
      ...(resolution != null ? { resolution } : {}),
    }, "video", framesMode, options);

    emitImagePreparationProgress(options, "selecting Video mode");
    await ensureSettingsSurface();
    await chooseRadio("Video", options);
    if (aspectRatio) await chooseVideoOption("ratio", aspectRatio, options);

    if (requestedModel) {
      emitImagePreparationProgress(options, "selecting requested model");
      await chooseNativeModel(requestedModel, type, options);
      const selectedModel = findModelPickerButton();
      const selectedModelName = normalizeModelLabel(selectedModel?.innerText || selectedModel?.textContent || root.accessibleName?.(selectedModel) || "");
      const requestedModelMatched = typeof modelLabelMatchesRequest === "function" &&
        modelLabelMatchesRequest(requestedModel, selectedModelName);
      if (!requestedModelMatched) {
        throw root.flowError("FLOW_VIDEO_MODEL_UNCONFIRMED", `Flow did not confirm requested video model "${requestedModel}" (current: ${selectedModelName || "unknown"}). Nothing was submitted.`, true, false);
      }
      await ensureSettingsSurface();
      await chooseRadio("Video", options);
      if (aspectRatio) await chooseVideoOption("ratio", aspectRatio, options);
    }

    if (duration != null) {
      emitImagePreparationProgress(options, "selecting video duration");
      const modelFixedDuration = Number.isFinite(Number(modelCapabilities?.fixedDuration)) && Number(duration) === Number(modelCapabilities.fixedDuration);
      await chooseVideoOption("duration", duration, { ...options, allowAbsent: modelFixedDuration });
    }
    if (resolution != null) {
      emitImagePreparationProgress(options, "selecting video resolution");
      await chooseVideoOption("resolution", resolution, options);
    }
    emitImagePreparationProgress(options, "selecting output count");
    await chooseNativeVariantCount(variants, options);

    emitImagePreparationProgress(options, `selecting ${modeName} input mode`);
    await ensureSettingsSurface();
    await selectAndConfirmMode(modeName, Boolean(framesMode), options);
    emitImagePreparationProgress(options, "reading generation credit quote");
    const settingsCredits = await (root.FlowEditor?.waitForGenerationCreditQuote?.(Math.min(2000, Number.isFinite(options.deadline) ? Math.max(1, options.deadline - Date.now()) : 2000), options) || root.waitForGenerationCreditQuote?.(2000));
    finishVideoPreparationDiagnostics("completed", { result: { creditQuote: Number.isFinite(settingsCredits) ? settingsCredits : "unknown", framesMode, model: requestedModel || null, aspectRatio: aspectRatio || null, duration: duration ?? null, resolution: resolution || null, variants } });
    return settingsCredits;
    } catch (error) {
      finishVideoPreparationDiagnostics("failed", {
        error: `${error?.code || "FLOW_VIDEO_SETTINGS_ERROR"}: ${error?.message || String(error)}`,
        quoteDiagnostics: safeCreditQuoteDiagnostics(),
      });
      throw error;
    } finally {
      await closeOwnedSettingsSurface(ownsSettingsSurface, options);
    }
  }

  const FlowVideoActions = Object.freeze({
    prepare: (payload, variants, framesMode, options) => prepareNativeVideoSettings(payload, variants, framesMode, options),
  });
  root.FlowVideoActions = FlowVideoActions;
  root.FlowSettings = Object.freeze({ ...root.FlowSettings, prepareNativeVideoSettings, selectAndConfirmMode });
})();
