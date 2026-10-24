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

  function exactModeControl(name) {
    const rawWanted = foldLabel(name);
    const aliases = (MODE_ALIASES[rawWanted] || [rawWanted]).map(foldLabel);
    const configured = typeof root.flowQueryAll === "function" ? root.flowQueryAll("settings.optionCandidates", document, { checkVisible: false }) : [];
    const candidates = [...new Set([...configured, ...deepQueryAll(document, '[role="radio"],mat-radio-button,[role="tab"],[role="option"],button[id*="-trigger-"],button,[role="button"]')])];
    const visibleCandidates = [...new Set(candidates)].filter(element => root.visible?.(element) && !isNavControl(element));
    const suffix = rawWanted === "frames" ? "VIDEO_FRAMES" : rawWanted === "ingredients" ? "VIDEO_REFERENCES" : "";
    if (suffix) {
      const byId = visibleCandidates.find(element => String(element.id || "").includes(`-trigger-${suffix}`));
      if (byId) return byId;
      const byPanel = visibleCandidates.find(element => String(element.getAttribute?.("aria-controls") || "").includes(suffix));
      if (byPanel) return byPanel;
    }
    const iconName = rawWanted === "frames" ? "movie_edit" : rawWanted === "ingredients" ? "interests" : "";
    if (iconName) {
      const byIcon = visibleCandidates.find(element => {
        const icon = (root.flowFindIcon ? root.flowFindIcon(element) : element.querySelector?.("mat-icon,.mat-icon,.google-symbols"))?.textContent?.trim()?.toLowerCase();
        return icon === iconName;
      });
      if (byIcon) return byIcon;
    }
    return visibleCandidates.find(element => {
      const cName = foldLabel(String(root.accessibleName?.(element) || "").replace(/^(?:accessibility_new|dashboard|face)\s*/i, ""));
      return aliases.includes(cName) || aliases.some(a => cName.endsWith(` ${a}`));
    });
  }

  function modeControlSelected(control) {
    return Boolean(control && (nativeRadioSelected(control) || control.getAttribute("aria-selected") === "true" ||
      control.getAttribute("data-state") === "active"));
  }

  function isDisabledModeControl(control) {
    return Boolean(control && (control.disabled === true || control.hasAttribute?.("disabled") || control.getAttribute?.("aria-disabled") === "true"));
  }

  async function selectAndConfirmMode(name, framesMode, options = {}) {
  // Review round 3, S3: optional mode branches used to console.warn
  // and continue, so the user and the panel never saw that the video
  // might not be in the requested mode. The warning now also goes into
  // an options.modeWarnings collector when the caller supplies one, so
  // prepareNativeVideoSettings can surface it in the job diagnostics.
  // Callers without a collector keep exactly the old console behavior.
  const noteModeWarning = message => {
    if (Array.isArray(options.modeWarnings)) options.modeWarnings.push(message);
    console.warn(`[FlowVideoSettings] ${message}`);
  };
    checkPreparation(options, `selecting Flow ${name} mode`);
    const unavailableCode = framesMode ? "FLOW_FRAMES_MODE_UNAVAILABLE" : "FLOW_VIDEO_MODE_UNAVAILABLE";
    const unavailableError = message => root.flowError(unavailableCode, message, true, false);
    let control = exactModeControl(name);
    if (isDisabledModeControl(control)) {
      if (options.optional === true) {
        noteModeWarning(`${name} mode control is disabled; continuing with current Flow settings.`);
        return;
      }
      throw unavailableError(`Flow's exact ${name} mode control is visible but disabled. Nothing was submitted.`);
    }
    if (!control) {
      if (options.optional === true) {
        noteModeWarning(`Flow does not display an explicit ${name} control for this model; continuing with current Flow settings.`);
        return;
      }
      throw unavailableError(`Flow does not offer the exact ${name} mode for the selected model. Nothing was submitted.`);
    }
    if (modeControlSelected(control)) return;
    control.click();
    const deadline = Math.min(Date.now() + 5000, Number.isFinite(options.deadline) ? options.deadline : Infinity);
    let confirmed = false;
    while (Date.now() < deadline) {
      checkPreparation(options, `confirming Flow ${name} mode`);
      control = exactModeControl(name);
      if (isDisabledModeControl(control)) {
        if (options.optional === true) {
          noteModeWarning(`${name} mode control became disabled before selection could be confirmed; continuing with current Flow settings.`);
          return;
        }
        throw unavailableError(`Flow's exact ${name} mode control became disabled before selection could be confirmed. Nothing was submitted.`);
      }
      if (modeControlSelected(control)) { confirmed = true; break; }
      if (!flowSettingsPanelVisible()) await openFlowSettings(options);
      await waitPreparation(options, 100, `confirming Flow ${name} mode`);
    }
    if (!confirmed) {
      control = exactModeControl(name);
      if (isDisabledModeControl(control)) {
        if (options.optional === true) return;
        throw unavailableError(`Flow's exact ${name} mode control is disabled. Nothing was submitted.`);
      }
      if (options.optional === true) {
        noteModeWarning(`Flow did not confirm ${name} mode selection; proceeding without blocking.`);
        return;
      }
      const code = framesMode ? "FLOW_FRAMES_MODE_UNCONFIRMED" : "FLOW_VIDEO_MODE_UNCONFIRMED";
      throw root.flowError(code, `Flow did not confirm that ${name} mode is selected. Nothing was submitted.`, true, false);
    }
    if (framesMode) {
      const hasFrameControls = () => Boolean(root.flowButton?.("Start") && root.flowButton?.("End"));
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
    // Review round 3, S3: collects the optional Ingredients-mode warnings
    // above so they surface in the completed diagnostics result.
    const modeWarnings = [];
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
    if (aspectRatio) await chooseVideoOption("ratio", aspectRatio, { ...options, allowAbsent: true });

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
      if (aspectRatio) await chooseVideoOption("ratio", aspectRatio, { ...options, allowAbsent: true });
    }

    if (duration != null) {
      emitImagePreparationProgress(options, "selecting video duration");
      await chooseVideoOption("duration", duration, { ...options, allowAbsent: true });
    }
    if (resolution != null) {
      emitImagePreparationProgress(options, "selecting video resolution");
      await chooseVideoOption("resolution", resolution, { ...options, allowAbsent: true });
    }
    emitImagePreparationProgress(options, "selecting output count");
    await chooseNativeVariantCount(variants, options);

    if (framesMode) {
      emitImagePreparationProgress(options, "selecting Frames input mode");
      await ensureSettingsSurface();
      await selectAndConfirmMode("Frames", true, options);
    } else if (payload.video_settings?.mode === "ingredients" || (Array.isArray(payload.attachments) && payload.attachments.length > 0)) {
      emitImagePreparationProgress(options, "checking Ingredients input mode");
      await ensureSettingsSurface();
      await selectAndConfirmMode("Ingredients", false, { ...options, optional: true, modeWarnings });
    }
    emitImagePreparationProgress(options, "reading generation credit quote");
    const settingsCredits = await (root.FlowEditor?.waitForGenerationCreditQuote?.(Math.min(2000, Number.isFinite(options.deadline) ? Math.max(1, options.deadline - Date.now()) : 2000), options) || root.waitForGenerationCreditQuote?.(2000));
    finishVideoPreparationDiagnostics("completed", { result: { creditQuote: Number.isFinite(settingsCredits) ? settingsCredits : "unknown", framesMode, model: requestedModel || null, aspectRatio: aspectRatio || null, duration: duration ?? null, resolution: resolution || null, variants, ...(modeWarnings.length ? { modeWarnings } : {}) } });
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
  root.FlowSettings = Object.freeze({ ...root.FlowSettings, prepareNativeVideoSettings, selectAndConfirmMode, exactModeControl, modeControlSelected });
})();
