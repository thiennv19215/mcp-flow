// Flow video generation settings. Submission and result tracking stay in dom-actions.js.
globalThis.FlowVideoActions = Object.freeze({
  prepare: async (payload, variants, framesMode) => {
    await openFlowSettings();
    if (payload.type) await chooseRadio("Video");
    if (payload.type === "video") await chooseRadio(framesMode ? "Frames" : "Ingredients");
    if (payload.aspectRatio) await chooseRadio(payload.aspectRatio);
    if (payload.duration && payload.type === "video") await chooseRadio(`${payload.duration}s`);
    if (payload.resolution && payload.type === "video") await chooseRadio(String(payload.resolution));
    const requestedModel = payload.model;
    await chooseNativeModel(requestedModel, payload.type);
    if (requestedModel) {
      // Flow can close the settings popover after model selection; confirm the remaining video settings again.
      if (payload.duration && payload.type === "video") await chooseRadio(`${payload.duration}s`);
      if (payload.resolution && payload.type === "video") await chooseRadio(String(payload.resolution));
    }
    await chooseNativeVariantCount(variants);
    const settingsCredits = await waitForGenerationCreditQuote(2000);
    await closeFlowSettings();
    return settingsCredits;
  },
});
