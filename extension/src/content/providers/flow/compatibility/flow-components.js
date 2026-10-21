// Stable compatibility facade. Business logic lives in focused Flow modules.
(() => {
  "use strict";
  const root = globalThis;
  const uploadStagedFlowMedia = (...args) => root.FlowUploader.upload(...args);
  const chooseNativePickerAsset = (...args) => root.FlowNativeFramePicker.choose(...args);
  const resolveUniqueUploadTarget = (candidates, code, actionLabel) => {
    if (candidates.length > 1) throw flowError(code, `Flow shows multiple matching ${actionLabel} controls. No control was selected.`, false, false);
    return candidates[0] || null;
  };
  const FlowComponents = Object.freeze({
    clearExistingIngredientChips: root.clearExistingIngredientChips,
    uploadStagedFlowMedia,
    chooseNativePickerAsset,
    confirmVideoUploadIfPrompted: (...args) => root.FlowUploader.confirmVideoUpload(...args),
    resolveUniqueUploadTarget,
    selectNativeFlowVoice: root.selectNativeFlowVoice,
    listNativeFlowVoiceOptions: root.listNativeFlowVoiceOptions,
    resolveNativeMediaUuid: root.resolveNativeMediaUuid,
    findAddMediaButton: () => root.FlowUploader.findAddMediaButton(),
    ensureAddMediaButton: (...args) => root.FlowUploader.ensureAddMediaButton(...args),
    inspectUploadTrigger: () => root.FlowUploader.inspectUiState(),
    inspectFramePickerDiagnostics: () => root.FlowNativeFramePicker.inspectDiagnostics(),
    FlowReferenceActions: root.FlowReferenceActions,
  });
  root.FlowComponents = FlowComponents;
  root.uploadStagedFlowMedia = uploadStagedFlowMedia;
  root.chooseNativePickerAsset = chooseNativePickerAsset;
  root.findAddMediaButton = FlowComponents.findAddMediaButton;
  root.ensureAddMediaButton = FlowComponents.ensureAddMediaButton;
  root.confirmFlowVideoUploadIfPrompted = (...args) => root.FlowUploader.confirmVideoUpload(...args);
  root.matchesFlowTile = (...args) => root.FlowUploader.matchesTile(...args);
  root.flowUploadNameMatches = (...args) => root.FlowUploader.flowUploadNameMatches(...args);
  root.waitForNativeMediaTile = (...args) => root.FlowUploader.waitForNativeMediaTile(...args);
})();
