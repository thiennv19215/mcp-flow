// Flow video generation settings. Submission and result tracking stay in dom-actions.js.
(() => {
  "use strict";

  const normalize = value => String(value || "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
  const cleanControlName = element => normalize(accessibleName(element).replace(/^(?:accessibility_new|dashboard|face)\s*/i, ""));
  const isSelected = element => nativeRadioSelected(element) || element?.getAttribute("aria-selected") === "true";
  function exactModeControl(name) {
    const wanted = normalize(name);
    return [...document.querySelectorAll('[role="radio"],mat-radio-button,[role="tab"],[role="option"],button,[role="button"]')]
      .find(element => visible(element) && cleanControlName(element) === wanted);
  }

  async function selectAndConfirmMode(name, framesMode) {
    let control = exactModeControl(name);
    if (!control) {
      const code = framesMode ? "FLOW_FRAMES_MODE_UNAVAILABLE" : "FLOW_VIDEO_MODE_UNAVAILABLE";
      throw flowError(code, `Flow does not offer the exact ${name} mode for the selected model. Nothing was submitted.`, true, false);
    }
    if (!isSelected(control)) control.click();
    const deadline = Date.now() + 5000;
    let confirmed = false;
    while (Date.now() < deadline) {
      control = exactModeControl(name);
      if (control && isSelected(control)) { confirmed = true; break; }
      if (!flowSettingsPanelVisible()) await openFlowSettings();
      await wait(100);
    }
    if (!confirmed) {
      const code = framesMode ? "FLOW_FRAMES_MODE_UNCONFIRMED" : "FLOW_VIDEO_MODE_UNCONFIRMED";
      throw flowError(code, `Flow did not confirm that ${name} mode is selected. Nothing was submitted.`, true, false);
    }
    if (framesMode) {
      const controlsDeadline = Date.now() + 4000;
      while (Date.now() < controlsDeadline && !(flowButton("Start") && flowButton("End"))) await wait(100);
      if (!flowButton("Start") || !flowButton("End")) {
        throw flowError("FLOW_FRAMES_CONTROLS_UNAVAILABLE", "Flow selected Frames but did not show both Start and End frame controls. Nothing was submitted.", true, false);
      }
    }
  }

  globalThis.FlowVideoActions = Object.freeze({
    prepare: async (payload, variants, framesMode) => {
      const type = payload.type || "video";
      const requestedModel = payload.model;
      const modeName = framesMode ? "Frames" : "Ingredients";

      await openFlowSettings();
      await chooseRadio("Video");
      if (payload.aspectRatio) await chooseRadio(payload.aspectRatio);

      // Flow may dismiss the settings popover as soon as a model is selected.
      // Apply the model before the settings that depend on it, then reopen and
      // reapply those settings against the model's actual controls.
      await chooseNativeModel(requestedModel, type);
      await openFlowSettings();
      await chooseRadio("Video");
      if (payload.aspectRatio) await chooseRadio(payload.aspectRatio);
      if (payload.duration) await chooseRadio(`${payload.duration}s`);
      if (payload.resolution) await chooseRadio(String(payload.resolution));
      await chooseNativeVariantCount(variants);

      // Mode must be the final model-dependent setting. Confirm the selected
      // control itself; payload intent alone does not prove Flow accepted it.
      await openFlowSettings();
      await selectAndConfirmMode(modeName, Boolean(framesMode));
      const settingsCredits = await waitForGenerationCreditQuote(2000);
      await closeFlowSettings();
      return settingsCredits;
    },
  });
})();
