// Image-generation settings strategy. Shared DOM primitives stay in core/settings.js.
(() => {
  "use strict";
  const root = globalThis;
  const { emitImagePreparationProgress, assertNativeModelCapabilities, flowSettingsPanelVisible, openFlowSettings, chooseRadio, chooseAspectRatio, chooseNativeModel, chooseNativeVariantCount, finishImagePreparationDiagnostics, safeCreditQuoteDiagnostics, closeOwnedSettingsSurface } = root.FlowSettings;
  async function prepareNativeImageSettings(payload, variants, options = {}) {
    let ownsSettingsSurface = false;
    options = {
      ...options,
      imagePreparation: true,
      onSettingsOpened: () => { ownsSettingsSurface = true; },
    };
    const ensureSettingsSurface = async () => {
      const wasVisible = flowSettingsPanelVisible();
      await openFlowSettings(options);
      if (!wasVisible && flowSettingsPanelVisible()) ownsSettingsSurface = true;
    };
    try {
      emitImagePreparationProgress(options, "validating requested settings");
      await assertNativeModelCapabilities(payload, "image", false, options);
      emitImagePreparationProgress(options, "reading composer controls");
      const aspectRatio = payload?.aspectRatio || payload?.aspect_ratio;
      const requestedModel = payload?.model || "Nano Banana";

      emitImagePreparationProgress(options, "selecting image mode");
      await ensureSettingsSurface();
      await chooseRadio("Image", options);
      if (aspectRatio) await chooseAspectRatio(aspectRatio, options);

      if (requestedModel) {
        emitImagePreparationProgress(options, "selecting requested model");
        await chooseNativeModel(requestedModel, "image", options);
        await ensureSettingsSurface();
        await chooseRadio("Image", options);
        if (aspectRatio) await chooseAspectRatio(aspectRatio, options);
      }

      emitImagePreparationProgress(options, "selecting output count");
      await chooseNativeVariantCount(variants, options);

      finishImagePreparationDiagnostics("completed", { result: { model: requestedModel, aspectRatio, variants } });
      return undefined;
    } catch (error) {
      finishImagePreparationDiagnostics("failed", {
        error: `${error?.code || "FLOW_SETTINGS_ERROR"}: ${error?.message || String(error)}`,
        quoteDiagnostics: safeCreditQuoteDiagnostics(),
      });
      throw error;
    } finally {
      await closeOwnedSettingsSurface(ownsSettingsSurface, options);
    }
  }

  const FlowImageActions = Object.freeze({
    prepare: (payload, variants, options) => prepareNativeImageSettings(payload, variants, options),
    prepareCharacterPortrait: (character, variants, options) => prepareNativeImageSettings({ aspectRatio: character.aspect_ratio || "3:4", model: character.model || "Nano Banana" }, variants, options),
  });
  root.FlowImageActions = FlowImageActions;
  root.FlowSettings = Object.freeze({ ...root.FlowSettings, prepareNativeImageSettings });
})();
