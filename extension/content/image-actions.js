// Flow image generation settings. Submission and result tracking stay in dom-actions.js.
(() => {
  "use strict";

  async function prepareNativeImageSettings(payload, variants) {
    const aspectRatio = payload?.aspectRatio;
    const requestedModel = payload?.model || "Nano Banana";

    await openFlowSettings();
    await chooseRadio("Image");
    if (aspectRatio) await chooseAspectRatio(aspectRatio);

    // Flow may dismiss the settings popover as soon as a model is selected.
    // Apply the model before the settings that depend on it, then reopen and
    // reapply those settings against the model's actual controls.
    if (requestedModel) {
      await chooseNativeModel(requestedModel, "image");
      await openFlowSettings();
      await chooseRadio("Image");
      if (aspectRatio) await chooseAspectRatio(aspectRatio);
    }

    await chooseNativeVariantCount(variants);
    const settingsCredits = await waitForGenerationCreditQuote(2000);
    await closeFlowSettings();
    return settingsCredits;
  }

  globalThis.FlowImageActions = Object.freeze({
    prepare: async (payload, variants) => prepareNativeImageSettings(payload, variants),
    prepareCharacterPortrait: async (character, variants) =>
      prepareNativeImageSettings({ aspectRatio: character.aspect_ratio || "3:4", model: character.model || "Nano Banana" }, variants),
  });
})();
