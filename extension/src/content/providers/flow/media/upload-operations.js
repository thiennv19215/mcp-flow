(function (root) {
  class FlowUploadOperations {
    constructor(driver) { this.driver = driver; }
    supports(operation) { return ['flow.generation.upload.preflight', 'flow.file.upload.begin', 'flow.file.upload.chunk', 'flow.file.upload.finish', 'flow.file.upload.abort', 'flow.media.upload'].includes(operation); }
    error(...args) { return this.driver.error(...args); }
    async execute(name, payload = {}, command = {}) {
      const editor = root.FlowEditor;
      const components = root.FlowComponents;
      const nav = root.FlowNavigation;
      const menu = root.FlowMediaMenu;
      const tiles = root.FlowTiles;
      const agent = root.FlowAgent;
      if (name === "flow.generation.upload.preflight") {
        const deadline = root.FlowUiDeadline?.makeDeadline(command, 20_000, 5_000) || Date.now() + 15_000;
        await nav.ensureFlowProjectEditor({ deadline, signal: command.signal });
        if (typeof root.FlowScreenState?.assertOperationReady !== "function") {
          throw this.error("FLOW_SCREEN_PREFLIGHT_UNAVAILABLE", "Flow screen detection is unavailable. Upload was not started.", false, false);
        }
        root.FlowScreenState.assertOperationReady();
        const state = menu.nativeRead("flowState");
        if (!state.signedIn || !state.inProject) throw this.error("FLOW_NOT_READY", state.hint || "Open a signed-in Flow project first.", true);
        const fileInputs = [...document.querySelectorAll('input[type="file"]')];
        return {
          ready: true,
          trustedFileSelection: false,
          hasComposer: Boolean(root.getVisibleFlowPromptEditor?.()),
          hasUploadButton: Boolean(components.findAddMediaButton()),
          fileInputCount: fileInputs.length,
        };
      }

      if (name === "flow.file.upload.begin") {
        const t = payload.transfer;
        if (!t || typeof t !== "object") throw this.error("FLOW_INVALID_ARGUMENT", "Upload metadata is required.");
        const isVideo = String(t.type || "").startsWith("video/");
        const assembler = new root.FlowNativeFileTransfer.UploadAssembler(t, { maxBytes: isVideo ? 200 * 1024 * 1024 : 25 * 1024 * 1024, chunkBytes: 256 * 1024, maxChunks: isVideo ? 800 : 100 });
        if (root.stagedNativeFiles.has(assembler.transferId)) throw this.error("FLOW_TRANSFER_DUPLICATE", "Upload transfer id is already staged.");
        root.nativeUploadAssemblers.set(assembler.transferId, assembler);
        return { transferId: assembler.transferId, ready: true };
      }

      if (name === "flow.file.upload.chunk") {
        const chunks = Array.isArray(payload.chunks) ? payload.chunks : [payload.chunk];
        const transferId = chunks[0]?.transferId;
        const assembler = root.nativeUploadAssemblers.get(transferId);
        if (!assembler) throw this.error("FLOW_TRANSFER_UNKNOWN", "Upload transfer is not active.");
        if (!chunks.length || chunks.length > 4 || chunks.some(c => c?.transferId !== transferId)) throw this.error("FLOW_INVALID_ARGUMENT", "Upload chunk batch is empty, too large, or mixes transfer ids.");
        try {
          let result;
          for (const c of chunks) result = await assembler.accept(c);
          return result;
        } catch (error) { root.nativeUploadAssemblers.delete(transferId); throw error; }
      }

      if (name === "flow.file.upload.finish") {
        const transferId = String(payload.transferId || "");
        const assembler = root.nativeUploadAssemblers.get(transferId);
        if (!assembler) throw this.error("FLOW_TRANSFER_UNKNOWN", "Upload transfer is not active.");
        try {
          const file = await assembler.finish();
          root.nativeUploadAssemblers.delete(transferId);
          root.stagedNativeFiles.set(transferId, file);
          return { transferId, staged: true, size: file.size, trustedGesture: false };
        } catch (error) { root.nativeUploadAssemblers.delete(transferId); throw error; }
      }

      if (name === "flow.file.upload.abort") {
        const transferId = String(payload.transferId || "");
        root.nativeUploadAssemblers.get(transferId)?.abort();
        root.nativeUploadAssemblers.delete(transferId);
        root.stagedNativeFiles.delete(transferId);
        return { transferId, aborted: true };
      }

      if (name === "flow.media.upload") {
        const transferId = String(payload.transferId || "");
        const file = root.stagedNativeFiles.get(transferId);
        const assetName = String(payload.name || "");
        const kind = payload.kind === "video" ? "video" : "image";
        if (!file || file.name !== assetName) throw this.error("FLOW_TRANSFER_UNKNOWN", "The staged media file is missing or its name does not match.", true);
        const deadline = root.FlowUiDeadline?.makeDeadline(command, 75_000, 15_000) || Date.now() + 60_000;
        // IMG-01: a caller may pin the upload identity to its own reference
        // key; without one the uploader derives the identity key from the
        // staged file's original name. The receipt keeps name = assetName
        // (the original) and gains the content-derived uploadName.
        const callerKey = payload.callerKey ?? payload.uploadKey ?? undefined;
        // IMG-09b: forward the caller's per-upload request id so a cancel
        // by id (FlowUploader.cancelUpload) reaches the in-page upload.
        // Without it the id stopped at the client layer: the uploader
        // never registered a canceller, and an already-dispatched
        // confirmation loop could not be aborted from the sidebar.
        const requestId = payload.requestId ?? payload.uploadRequestId ?? undefined;
        // IMG-05b: the 75 s deadline above remains the budget for every
        // upload phase (navigation, baseline, menu, picker dispatch).
        // Only the post-dispatch tile confirmation may extend past it
        // while Flow is still processing the latched tile — bounded by
        // the uploader's hard caps (image 240 s, video 480 s) and by this
        // command's own timeout, which the uploader derives from the
        // command itself. confirmExtendable opts this call into that
        // extension; all other upload callers keep the absolute deadline.
        const receipt = await components.uploadStagedFlowMedia(file, kind, command, { deadline, signal: command.signal, callerKey, requestId, confirmExtendable: true });
        // Upload can leave Flow's asset picker or upload menu mounted while
        // the media tile finishes rendering. Close and verify it before the
        // caller starts image/video generation or another DOM operation.
        const popupState = await nav.prepareFlowOperation({ deadline: Date.now() + 4_000, signal: command?.signal });
        return {
          ...receipt,
          uploaded: true,
          name: assetName,
          kind,
          popupClear: popupState.ready === true,
          popupDismissed: popupState.popupDismissed === true,
          trustedGesture: false,
        };
      }

      return undefined;
    }
  }
  root.FlowUploadOperations = FlowUploadOperations;
})(globalThis);
