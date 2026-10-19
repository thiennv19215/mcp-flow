// Flow image generation settings. Submission and result tracking stay in dom-actions.js.
async function prepareNativeImageSettings(aspectRatio, model, variants) {
  await openFlowSettings();
  await chooseRadio("Image");
  if (aspectRatio) await chooseRadio(aspectRatio);
  await chooseNativeModel(model, "image");
  await chooseNativeVariantCount(variants);
  const settingsCredits = await waitForGenerationCreditQuote(2000);
  await closeFlowSettings();
  return settingsCredits;
}
globalThis.FlowImageActions = Object.freeze({
  prepare: async (payload, variants) => prepareNativeImageSettings(payload.aspectRatio, payload.model || "Nano Banana", variants),
  prepareCharacterPortrait: async (character, variants) => prepareNativeImageSettings(character.aspect_ratio || "3:4", "Nano Banana", variants),
});
