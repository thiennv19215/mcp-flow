(function (root) {
  class FlowGenerationOperations {
    constructor(driver) {
      this.driver = driver;
    }
    supports(operation) {
      return [
        "flow.generation.upload.preflight",
        "flow.file.upload.begin",
        "flow.file.upload.chunk",
        "flow.file.upload.finish",
        "flow.file.upload.abort",
        "flow.media.upload",
        "flow.references.attach",
        "flow.references.clear",
        "flow.voices.options",
        "flow.generation.submit",
        "flow.generation.observe",
      ].includes(operation);
    }
    error(...args) {
      return this.driver.error(...args);
    }
    async execute(name, payload = {}, command = {}) {
      const nav = root.FlowNavigation;
      const editor = root.FlowEditor;
      const settings = root.FlowSettings;
      const components = root.FlowComponents;
      const tiles = root.FlowTiles;
      const menu = root.FlowMediaMenu;
      const agent = root.FlowAgent;
      if (name === "flow.generation.upload.preflight") {
        await nav.ensureFlowProjectEditor();
        const state = menu.nativeRead("flowState");
        if (!state.signedIn || !state.inProject) throw this.error("FLOW_NOT_READY", state.hint || "Open a signed-in Flow project first.", true);
        const fileInputs = [...document.querySelectorAll('input[type="file"]')];
        return {
          ready: true,
          trustedFileSelection: false,
          hasComposer: Boolean(document.querySelector(".ProseMirror")),
          hasUploadButton: Boolean(components.findAddMediaButton()),
          fileInputCount: fileInputs.length,
        };
      }

      if (name === "flow.references.clear") {
        const clearReferences = typeof root.clearExistingIngredientChips === "function"
          ? root.clearExistingIngredientChips
          : components.clearExistingIngredientChips;
        if (typeof clearReferences !== "function") {
          throw this.error("FLOW_REFERENCE_CLEAR_UNAVAILABLE", "Flow's reference-chip cleanup is unavailable; no prompt content was changed.", false, false);
        }
        const deadline = root.FlowUiDeadline?.makeDeadline(command, 20_000, 5_000) || Date.now() + 15_000;
        const promptEditor = (typeof root.flowQuery === "function" ? root.flowQuery("editor") : null) ||
          document.querySelector(".ProseMirror[contenteditable='true'], flow-base-prompt-box [contenteditable='true'], textarea[aria-label*='prompt' i]");
        if (!promptEditor || typeof editor?.getEditorUserText !== "function") {
          throw this.error("FLOW_PROMPT_PRESERVATION_UNVERIFIABLE", "Flow's prompt text could not be read, so reference cleanup was not started.", false, false);
        }
        const promptBefore = editor.getEditorUserText(promptEditor);
        const closePicker = components.FlowReferenceActions?.closePicker;
        if (typeof closePicker === "function") await closePicker({ deadline, signal: command.signal, command });
        else if (components.FlowReferenceActions?.inspectDiagnostics?.().pickerOpen) {
          throw this.error("FLOW_ASSET_PICKER_CLOSE_UNAVAILABLE", "Flow's reference picker is open but its safe close operation is unavailable; no prompt content was changed.", false, false);
        }
        const inspectReferences = components.FlowReferenceActions?.inspectDiagnostics;
        const result = await clearReferences({ deadline, signal: command.signal });
        if (!result || result.remaining !== 0) {
          throw this.error("FLOW_REFERENCE_CLEAR_UNCONFIRMED", "Flow did not confirm that all reference chips were removed; inspect the prompt before retrying.", false, false);
        }
        const referencesAfter = typeof inspectReferences === "function" ? inspectReferences() : null;
        if (!referencesAfter || !Number.isInteger(referencesAfter.chipCount) || referencesAfter.chipCount !== 0) {
          const remaining = Number.isInteger(referencesAfter?.chipCount) ? referencesAfter.chipCount : "unknown";
          throw this.error("FLOW_REFERENCE_CLEAR_UNCONFIRMED", `Flow still reports ${remaining} attached reference chip(s) after cleanup; inspect the prompt before retrying.`, false, false);
        }
        const promptAfter = editor.getEditorUserText(promptEditor);
        if (promptAfter !== promptBefore) {
          throw this.error("FLOW_PROMPT_CHANGED_DURING_REFERENCE_CLEAR", "Flow's prompt text changed while reference chips were cleared; inspect the composer before retrying.", false, false);
        }
        return { cleared: Number(result.cleared) || 0, remaining: 0, confirmed: true, picker_closed: true, prompt_preserved: true, prompt_text: promptAfter };
      }

      if (name === "flow.voices.options") {
        if (typeof components.listNativeFlowVoiceOptions !== "function") {
          throw this.error("FLOW_VOICE_PICKER_UNAVAILABLE", "Flow's v2 voice picker inspection is unavailable.", false, false);
        }
        const deadline = root.FlowUiDeadline?.makeDeadline(command, 30_000, 5_000) || Date.now() + 25_000;
        return components.listNativeFlowVoiceOptions({ deadline, signal: command.signal, command });
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
        const receipt = await components.uploadStagedFlowMedia(file, kind, command, { deadline });
        return { ...receipt, uploaded: true, name: assetName, kind, trustedGesture: false };
      }

      if (name === "flow.references.attach") {
        const references = payload.references;
        if (!Array.isArray(references) || !references.length || references.length > 3) throw this.error("FLOW_INVALID_ARGUMENT", "Provide one to three named references.");
        const deadline = root.FlowUiDeadline?.makeDeadline(command, 45_000, 10_000) || Date.now() + 35_000;
        if (payload.inspectOnly === true || payload.inspect_only === true) {
          if (references.length !== 1) throw this.error("FLOW_INVALID_ARGUMENT", "Reference picker inspection accepts exactly one reference.");
          const inspectPicker = root.FlowReferenceActions?.inspectPicker;
          if (typeof inspectPicker !== "function") throw this.error("FLOW_REFERENCE_INSPECT_UNAVAILABLE", "The reference picker inspector is unavailable; no item was selected.", false, false);
          return await inspectPicker(references[0], { deadline, command });
        }
        const attached = [];
        for (const ref of references) {
          root.FlowUiDeadline?.requireTime(deadline, "attaching Flow references", attached.length > 0);
          attached.push(await root.FlowReferenceActions.attach(ref, undefined, { deadline, command }));
        }
        return { attached, submitted: false };
      }

      if (name === "flow.generation.submit") {
        if (payload.voice && (payload.type !== "video" || payload.firstFrame || payload.lastFrame)) {
          throw this.error("FLOW_VOICE_MODE_UNSUPPORTED", "Flow voice chips are available for text-to-video generation only; no composer changes were made.", false, false);
        }
        const flowDeadline = root.FlowUiDeadline?.makeDeadline(command, 105_000, 15_000) || Date.now() + 90_000;
        const flowAbort = new AbortController();
        const unknownSubmitError = async (code, message, retryable = false) => {
          const error = this.error(code, message, retryable, true);
          error.diagnostics = {
            clickDelivered: true,
            observerReady: false,
            xhrHookActive: false,
            fetchHookActive: false,
            requestDiagnostics: { version: 1, count: 0, events: [] },
          };
          try {
            const observer = await tiles.readNativeFlowCorrelationHealth?.();
            if (observer) error.diagnostics = {
              clickDelivered: true,
              observerReady: observer.ready === true,
              xhrHookActive: observer.xhrHookActive === true,
              fetchHookActive: observer.fetchHookActive === true,
              requestDiagnostics: observer.requestDiagnostics || { version: 1, count: 0, events: [] },
            };
          } catch {}
          return error;
        };
        const requireFlowTime = (operation, outcomeUnknown = false) => root.FlowUiDeadline?.requireTime(flowDeadline, operation, outcomeUnknown, flowAbort.signal);
        const runFlowStage = async (label, operation, outcomeUnknown = false) => {
          requireFlowTime(label, outcomeUnknown);
          tiles.emitFlowProgress(command, `Flow submit: ${label}`);
          const remaining = flowDeadline - Date.now();
          let timer;
          const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => {
              flowAbort.abort();
              reject(root.flowError("FLOW_OPERATION_TIMEOUT", `Stopped waiting during Flow submit stage: ${label}. That page step may still be running; no later submit stage will start. Inspect Flow before retrying.`, false, outcomeUnknown));
            }, Math.max(1, remaining));
          });
          let result;
          try {
            result = await Promise.race([
              Promise.resolve().then(() => operation({ deadline: flowDeadline, signal: flowAbort.signal })),
              timeout,
            ]);
          } catch (error) {
            if (flowAbort.signal.aborted && error?.code !== "FLOW_OPERATION_TIMEOUT") {
              throw root.flowError("FLOW_OPERATION_TIMEOUT", `Stopped waiting during Flow submit stage: ${label}. That page step may still be running; no later submit stage will start. Inspect Flow before retrying.`, false, outcomeUnknown);
            }
            throw error;
          } finally { clearTimeout(timer); }
          requireFlowTime(label, outcomeUnknown);
          return result;
        };
        await runFlowStage("opening the project editor", ({ deadline, signal }) => nav.ensureFlowProjectEditor({ deadline, signal }));
        const state = menu.nativeRead("flowState");
        if (!state.signedIn || !state.inProject) throw this.error("FLOW_NOT_READY", state.hint || "Open a signed-in Flow project first.", true);
        await runFlowStage("checking blocking dialogs", ({ deadline, signal }) => nav.dismissBlockingOverlays({ deadline, signal }));
        const creditAlert = root.checkFlowCreditLimitAlert?.();
        if (creditAlert) throw this.error("FLOW_QUOTA_EXCEEDED", `Flow credit limit reached: "${creditAlert}". Generation aborted.`, false, false);
        await runFlowStage("closing any Agent session", ({ signal }) => agent.closeNativeAgentSession({ signal, deadline: flowDeadline }));
        await runFlowStage("opening All media", ({ deadline, signal }) => nav.ensureFlowLibrarySection("All media", { deadline, signal }));
        const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
        const variants = Math.max(1, Math.min(4, Number(payload.variants || payload.count || 1)));
        const frameValue = value => {
          if (typeof value === "string" && value.trim()) return { assetName: value.replace(/^asset:/i, "").trim() };
          if (!value || typeof value !== "object") return undefined;
          if (typeof value.assetName === "string" && value.assetName.trim()) return { assetName: value.assetName.trim() };
          if (root.validStagedLocalImage?.(value, /(?:start|end)/)) return value;
          return null;
        };
        const firstFrame = frameValue(payload.firstFrame), lastFrame = frameValue(payload.lastFrame);
        const framesMode = payload.type === "video" && Boolean(firstFrame || lastFrame);
        if (framesMode && attachments.length) {
          throw this.error("FLOW_FRAMES_INPUT_CONFLICT", "Flow Frames mode accepts firstFrame and lastFrame inputs only; remove ingredients attachments. Nothing was submitted.", false, false);
        }
        if (firstFrame === null || lastFrame === null || (!framesMode && attachments.some(item => {
          if (typeof item === "string") return !item.trim();
          if (!item || typeof item !== "object") return true;
          if (typeof item.assetName === "string") return !item.assetName.trim();
          return !root.validStagedLocalImage?.(item, /(?:ref[1-3]|attach[1-3])/);
        }))) throw this.error("NATIVE_CAPABILITY_UNSUPPORTED", "Native generation accepts project asset names or staged local image attachments only; nothing was submitted.", true, false);
        const referenceAttachments = framesMode ? [] : attachments;
        const expectedMediaReferenceIds = [];
        const expectedCharacterIds = [];
        const expectedVideoReferenceIds = [];
        if (root.scrollContainer?.()) root.scrollContainer().scrollTop = 0;
        const before = tiles.collectNativeMedia().map(item => item.id || `title:${item.title}`);
        const activeAgent = root.flowButton?.("Agent");
        if (activeAgent?.getAttribute("aria-pressed") === "true") await runFlowStage("switching Agent mode off", ({ signal }) => agent.setNativeAgentMode(false, { signal, deadline: flowDeadline }));
        const clearReferenceChips = typeof root.clearExistingIngredientChips === "function"
          ? root.clearExistingIngredientChips
          : components.clearExistingIngredientChips;
        if (typeof clearReferenceChips !== "function") throw this.error("FLOW_REFERENCE_CLEAR_UNAVAILABLE", "Flow's reference-chip cleanup is unavailable; nothing was submitted.", false, false);
        await runFlowStage("clearing old reference chips", ({ deadline, signal }) => clearReferenceChips({ deadline, signal }));

        const settingsCredits = payload.type === "image"
          ? (await runFlowStage("preparing image settings", ({ signal }) => root.FlowImageActions.prepare(payload, variants, { deadline: flowDeadline, signal, command })), undefined)
          : await runFlowStage("preparing video settings", ({ signal }) => root.FlowVideoActions.prepare(payload, variants, framesMode, { deadline: flowDeadline, signal, command }));

        const uploadAndResolve = async (attachment, slot) => {
          requireFlowTime("uploading and selecting Flow reference images", expectedVideoReferenceIds.length + expectedMediaReferenceIds.length + expectedCharacterIds.length > 0);
          if (!root.validStagedLocalImage?.(attachment, /(?:start|end|ref[1-3])/)) throw this.error("FLOW_UPLOAD_UNAVAILABLE", "Flow's staged image transfer is unavailable before file selection.", false, false);
          const file = root.stagedNativeFiles.get(attachment.transferId);
          if (!file) throw this.error("FLOW_TRANSFER_UNKNOWN", "The staged image is no longer available.", true);
          let uploadReceipt;
          try {
            uploadReceipt = await runFlowStage(`uploading ${attachment.name}`, ({ signal }) => components.uploadStagedFlowMedia(file, "image", command, { deadline: flowDeadline, signal }), true);
          } finally {
            if (!flowAbort.signal.aborted && framesMode && (slot === "start" || slot === "end")) {
              await runFlowStage("restoring Frames mode after upload", ({ deadline, signal }) => settings.restoreNativeFramesMode({ deadline, signal }));
            }
          }
          return await runFlowStage(`selecting uploaded image ${attachment.name}`, ({ signal }) => components.chooseNativePickerAsset(attachment.name, slot, { deadline: flowDeadline, signal, command, expectedId: uploadReceipt?.id }), true);
        };

        const resolveValue = async (value, slot) => {
          if (!value) return;
          requireFlowTime("selecting Flow references", expectedVideoReferenceIds.length + expectedMediaReferenceIds.length + expectedCharacterIds.length > 0);
          if (value.assetName) return runFlowStage(`selecting asset ${value.assetName}`, ({ signal }) => components.chooseNativePickerAsset(value.assetName, slot, { deadline: flowDeadline, signal, command }), true);
          return uploadAndResolve(value, slot);
        };

        const recordSelectedReference = selected => {
          if (framesMode) {
            if (selected?.id) expectedVideoReferenceIds.push(selected.id);
            return;
          }
          if (selected?.kind === "character") {
            if (selected.id) expectedCharacterIds.push(selected.id);
          } else if (selected?.id) expectedMediaReferenceIds.push(selected.id);
        };
        if (firstFrame) recordSelectedReference(await resolveValue(firstFrame, "start"));
        if (lastFrame) recordSelectedReference(await resolveValue(lastFrame, "end"));
        for (const item of referenceAttachments) {
          const attachment = typeof item === "string" ? { assetName: item.replace(/^asset:/i, "").trim() } : item;
          recordSelectedReference(await resolveValue(attachment, undefined));
        }

        const correlationReferenceIds = framesMode
          ? [...expectedVideoReferenceIds]
          : [...expectedMediaReferenceIds, ...expectedCharacterIds];
        const requestedReferenceCount = framesMode
          ? Number(Boolean(firstFrame)) + Number(Boolean(lastFrame))
          : referenceAttachments.length;
        const isUuid = value => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
        if (correlationReferenceIds.length !== requestedReferenceCount || correlationReferenceIds.some(id => !isUuid(id)) || new Set(correlationReferenceIds.map(id => id.toLowerCase())).size !== correlationReferenceIds.length) {
          throw this.error(
            "FLOW_SUBMIT_CORRELATION_REFERENCE_ID_UNAVAILABLE",
            "Flow selected the requested references, but their exact backend IDs could not be verified for submit correlation. No generation request was sent; inspect the composer before retrying.",
            false,
            false
          );
        }

        const expectedRefs = referenceAttachments.length;
        if (expectedRefs > 0) {
          const isRefChip = el => {
            if (!root.visible?.(el)) return false;
            const lbl = (root.accessibleName?.(el) || el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
            return /(?:Ingredient|Thành phần)/i.test(lbl) || /Xóa thành phần|Remove ingredient/i.test(lbl);
          };
          let attachedCount = 0;
          const countDeadline = Math.min(Date.now() + 2500, flowDeadline);
          while (Date.now() < countDeadline) {
            attachedCount = [...document.querySelectorAll("button,[role=button],[role=listitem],mat-chip,[data-chip]")].filter(isRefChip).length;
            if (attachedCount >= expectedRefs) break;
            await root.FlowUiDeadline?.boundedWait(250, countDeadline, "confirming attached Flow reference chips", true, flowAbort.signal);
          }
          if (attachedCount < expectedRefs) {
            const composerRoot = document.querySelector(".ProseMirror")?.closest(".flow-composer, [class*='composer'], form") || document.body;
            const chipsInComposer = [...composerRoot.querySelectorAll("img, button, [role=button]")].filter(el => {
              if (!root.visible?.(el)) return false;
              const lbl = (root.accessibleName?.(el) || el.getAttribute("alt") || el.getAttribute("title") || "").toLowerCase();
              return /(?:ingredient|thành phần)/i.test(lbl);
            });
            const finalCount = Math.max(attachedCount, chipsInComposer.length);
            if (finalCount < expectedRefs) {
              throw this.error("FLOW_REFERENCE_ATTACH_UNCONFIRMED", `Flow shows ${finalCount} of ${expectedRefs} reference attachment(s); no generation was submitted. Inspect Flow before retrying.`, false, true);
            }
          }
        }

        const activeBox = await runFlowStage("finding the prompt editor", () => editor.preflightGenerationPrompt(payload, framesMode));
        const promptApplied = await runFlowStage("entering the prompt", () => editor.insertNativeFlowPrompt(activeBox, payload.prompt));
        if (!promptApplied) throw this.error("FLOW_PROMPT_INPUT_UNCONFIRMED", "Flow's composer did not confirm the full prompt text. Nothing was submitted.", true, false);
        if (payload.voice) {
          if (typeof components.selectNativeFlowVoice !== "function") {
            throw this.error("FLOW_VOICE_PICKER_UNAVAILABLE", "Flow's v2 voice picker is unavailable; no generation was submitted.", false, false);
          }
          const selectedVoice = await runFlowStage("selecting the requested Flow voice", ({ deadline, signal }) => components.selectNativeFlowVoice(payload.voice, { deadline, signal, command }));
          if (!selectedVoice?.confirmed) throw this.error("FLOW_VOICE_SELECTION_UNCONFIRMED", "Flow did not confirm the requested voice chip; no generation was submitted.", false, false);
          const promptAfterVoice = editor.getEditorUserText?.(activeBox);
          if (promptAfterVoice !== payload.prompt) throw this.error("FLOW_PROMPT_CHANGED_DURING_VOICE_SELECTION", "Flow's prompt changed while the voice chip was selected; inspect the composer before retrying.", false, false);
        }
        requireFlowTime("preparing the Flow submit request", expectedVideoReferenceIds.length + expectedMediaReferenceIds.length + expectedCharacterIds.length > 0);

        let credits;
        if (payload.type !== "image") {
          const renderedCredits = await runFlowStage("reading Flow's credit quote", ({ signal }) => editor.waitForGenerationCreditQuote(Number.isFinite(settingsCredits) ? 1500 : 3000, { deadline: flowDeadline, signal }));
          credits = Number.isFinite(renderedCredits)
            ? renderedCredits
            : Number.isFinite(settingsCredits)
              ? settingsCredits
              : undefined;
          if (!Number.isFinite(credits)) {
            const error = this.error("FLOW_CREDIT_QUOTE_UNAVAILABLE", "Flow did not show a verifiable credit quote; nothing was submitted.", true, false);
            error.diagnostics = { quoteDiagnostics: settings?.safeCreditQuoteDiagnostics?.() || null };
            throw error;
          }
          if (payload.maxCredits !== undefined && credits > Number(payload.maxCredits)) throw this.error("FLOW_MAX_CREDITS_EXCEEDED", `Flow quotes ${credits} credits, above max_credits=${payload.maxCredits}. Nothing was submitted.`, false, false);
        }

        const start = await runFlowStage("finding the submit button", () => editor.waitForGenerationSubmitButton(payload.prompt, 15000));
        if (!start) throw this.error("FLOW_SUBMIT_BUTTON_MISSING", "Flow's Start generation button was not found; nothing was submitted.", true);
        if (start.disabled || start.getAttribute("aria-disabled") === "true") {
          throw this.error("FLOW_SUBMIT_DISABLED", "Flow's Start generation button is disabled; nothing was submitted.", true);
        }

        const errorsBeforeSubmit = new Set(editor.currentFlowSubmitErrors());
        const projectId = (root.ProviderRegistry || root.FlowDriverRegistry).describeUrl(location.href)?.projectId;
        const correlationAttemptId = await runFlowStage("arming the request observer", () => tiles.armNativeFlowCorrelation({
          projectId,
          mediaType: payload.type === "image" ? "image" : "video",
          prompt: payload.prompt,
          expectedQuantity: variants,
          expectedReferenceIds: correlationReferenceIds,
          expectedMediaReferenceIds: payload.type === "image" ? expectedMediaReferenceIds : [],
          expectedCharacterIds: payload.type === "image" ? expectedCharacterIds : [],
          expectedVoiceCount: payload.voice ? 1 : 0,
        }));
        if (!correlationAttemptId || !tiles.nativeFlowCorrelationMap().has(correlationAttemptId)) {
          throw this.error(
            "FLOW_SUBMIT_CORRELATION_UNAVAILABLE",
            "Flow's request observer could not be armed, so the submit cannot be safely confirmed. No generation request was sent.",
            false,
            false
          );
        }
        try { requireFlowTime("activating the Flow submit button"); }
        catch (error) {
          if (correlationAttemptId) tiles.disarmNativeFlowCorrelation(correlationAttemptId);
          throw error;
        }

        let activation;
        try {
          activation = await runFlowStage("activating the submit button", () => editor.activateFlowSubmitButton(start, payload.prompt), true);
        } catch (error) {
          if (correlationAttemptId) tiles.disarmNativeFlowCorrelation(correlationAttemptId);
          throw error?.outcome_unknown === false
            ? error
            : await unknownSubmitError(error?.code || "FLOW_SUBMIT_ACTIVATION_UNKNOWN", error?.message || "Flow submit activation outcome is unknown; inspect Flow before retrying.", error?.retryable === true);
        }
        if (!activation.clickDelivered) {
          if (correlationAttemptId) tiles.disarmNativeFlowCorrelation(correlationAttemptId);
          throw this.error(
            "FLOW_SUBMIT_CLICK_NOT_DELIVERED",
            "Flow did not receive a submit click; the button changed state before activation completed.",
            false,
            false
          );
        }

        const submitDeadline = Math.min(Date.now() + 30000, flowDeadline);
        let acknowledged = false;
        let lastSubmitProgress = "";

        while (Date.now() < submitDeadline) {
          const correlationEntry = correlationAttemptId && tiles.nativeFlowCorrelationMap().get(correlationAttemptId);
          if (!correlationEntry) {
            tiles.disarmNativeFlowCorrelation(correlationAttemptId);
            throw await unknownSubmitError("FLOW_SUBMIT_CORRELATION_LOST", "Flow's request observer stopped tracking this submit before a request was observed. Inspect Flow before retrying.");
          }
          if (correlationEntry?.interfered) {
            tiles.disarmNativeFlowCorrelation(correlationAttemptId);
            throw await unknownSubmitError("FLOW_SUBMIT_INTERFERENCE", "A trusted interaction changed the Flow composer before the generation request was observed. The submit outcome is unknown; inspect Flow before retrying.");
          }
          if (correlationEntry.requestSeen) {
            acknowledged = true;
            break;
          }

          const newError = editor.currentFlowSubmitErrors().find(msg => !errorsBeforeSubmit.has(msg));
          if (newError) {
            tiles.disarmNativeFlowCorrelation(correlationAttemptId);
            const classified = root.classifyFlowError?.(newError);
            if (classified) throw await unknownSubmitError(classified.code, classified.message, classified.retryable);
            throw await unknownSubmitError("FLOW_SUBMIT_REJECTED", `Flow displayed an error before a correlated generation request was observed: ${newError}. Inspect Flow before retrying.`);
          }

          const progress = "Waiting for Flow to dispatch the generation request";
          if (progress !== lastSubmitProgress) {
            tiles.emitFlowProgress(command, progress);
            lastSubmitProgress = progress;
          }
          await root.wait?.(250);
        }

        if (!acknowledged) {
          const latestEntry = tiles.nativeFlowCorrelationMap().get(correlationAttemptId);
          if (latestEntry?.requestSeen) acknowledged = true;
          else {
            tiles.disarmNativeFlowCorrelation(correlationAttemptId);
            const newError = editor.currentFlowSubmitErrors().find(msg => !errorsBeforeSubmit.has(msg));
            if (newError) {
              const classified = root.classifyFlowError?.(newError);
              if (classified) throw await unknownSubmitError(classified.code, classified.message, classified.retryable);
              throw await unknownSubmitError("FLOW_SUBMIT_REJECTED", `Flow displayed an error before a correlated generation request was observed: ${newError}. Inspect Flow before retrying.`);
            }
            throw await unknownSubmitError("FLOW_SUBMIT_UNCONFIRMED", `Flow did not emit a correlated generation request within the submit budget (click delivered: ${Boolean(activation.clickDelivered)}). The outcome is unknown; inspect Flow before retrying.`);
          }
        }

        return {
          submitted: true,
          before,
          type: payload.type === "image" ? "image" : "video",
          expectedCount: variants,
          credits: Number.isFinite(credits) ? credits : null,
          correlationAttemptId,
          activation: activation.strategy || "dom-click",
          requestDispatched: acknowledged,
          serverAcceptanceObserved: false,
        };
      }

      if (name === "flow.generation.observe") {
        const before = Array.isArray(payload.before) ? payload.before : [];
        const kind = payload.kind === "image" ? "image" : payload.kind === "video" ? "video" : undefined;
        const expected = Math.max(1, Math.min(20, Number(payload.expectedCount || payload.variants || 1)));
        const deadline = Date.now() + Math.max(1000, Math.min(15 * 60000, Number(payload.timeoutMs || 12 * 60000)));
        const correlationAttemptId = String(payload.correlationAttemptId || "");
        const correlationEntry = correlationAttemptId ? tiles.nativeFlowCorrelationMap().get(correlationAttemptId) : null;
        let priorProgress = "", lastTitleOnlyResult = "";
        let retriesLeft = Math.max(0, Math.min(3, Number(payload.retries ?? 1)));
        const observeStartedAt = Date.now();
        let renderObservedInFlight = false;

        try {
          while (Date.now() < deadline) {
            if (correlationEntry?.interfered) {
              throw this.error("FLOW_GENERATION_INTERFERENCE", "A trusted interaction changed the Flow composer before this generation request was observed. The result cannot be safely attributed; inspect the project before retrying.", false, true);
            }

            const quotaAlert = root.checkFlowCreditLimitAlert?.();
            if (quotaAlert) {
              throw this.error("FLOW_QUOTA_EXCEEDED", `Flow credit limit reached: "${quotaAlert}".`, false, false);
            }

            const currentErrors = editor.currentFlowSubmitErrors();
            if (currentErrors.length > 0) {
              const failureText = currentErrors[0];
              const classified = root.classifyFlowError?.(failureText);
              if (classified) throw this.error(classified.code, classified.message, classified.retryable, false);
              throw this.error("FLOW_GENERATION_FAILED", `Flow hiển thị thông báo lỗi: "${failureText}".`, false, false);
            }

            if (correlationEntry && !correlationEntry.requestSeen && Date.now() - correlationEntry.armedAt >= 30000) {
              correlationEntry.useTilesFallback = true;
            }
            const strictCorrelation = correlationEntry && !correlationEntry.useTilesFallback;
            const receipt = correlationEntry ? tiles.nativeFlowCorrelationReceipt(correlationAttemptId) : null;
            if (receipt?.error) {
              const classified = root.classifyFlowError?.(receipt.error);
              if (classified) throw this.error(classified.code, classified.message, classified.retryable, false);
              throw this.error("FLOW_GENERATION_FAILED", `Flow báo cáo lỗi tạo: ${receipt.error}`, false, false);
            }
            const failedChild = receipt?.children?.find(c => c?.status === "failed" || c?.error);
            if (failedChild) {
              const errText = failedChild.error || failedChild.statusReason || "Generation failed";
              const classified = root.classifyFlowError?.(errText);
              if (classified) throw this.error(classified.code, classified.message, classified.retryable, false);
              throw this.error("FLOW_GENERATION_FAILED", `Flow báo cáo lỗi: ${errText}`, false, false);
            }

            const correlatedIds = new Set([
              ...(receipt?.mediaIds || []),
              ...(receipt?.children || []).flatMap(c => [c?.mediaId, c?.operationId]),
            ].filter(id => typeof id === "string").map(id => id.toLowerCase()));

            const allMedia = tiles.collectNativeMedia();
            const fresh = allMedia.filter(item =>
              !before.includes(item.id || `title:${item.title}`) &&
              !item.title.startsWith("fm-") &&
              (!kind || item.kind === kind || item.failed) &&
              (!strictCorrelation || item.failed || (item.id && correlatedIds.has(item.id.toLowerCase())))
            );

            const failed = fresh.filter(item => item.failed);
            if (failed.length) {
              const failureDetails = failed[0]?.failureReason || "";
              const classified = root.classifyFlowError?.(failureDetails);
              if (classified?.category === "rate_limit") {
                throw this.error(classified.code, classified.message, true, false);
              }
              if (classified && !classified.retryable) {
                throw this.error(classified.code, classified.message, false, false);
              }
              const retryable = failed.find(item => item);
              if (retryable && retriesLeft > 0 && await tiles.retryNativeErrorTile(retryable)) {
                retriesLeft--;
                tiles.emitFlowProgress(command, `Flow thất bại render; đang thử lại (${Math.max(0, Number(payload.retries ?? 1) - retriesLeft)}/${Number(payload.retries ?? 1)})`);
                continue;
              }
              const details = failed.map(item => `${item.title}${item.failureReason ? `: ${item.failureReason}` : ""}`).join("; ");
              throw this.error("FLOW_GENERATION_FAILED", `Flow báo cáo ${failed.length} tile render thất bại: ${details}. Chưa bị trừ tín dụng cho render lỗi này.`, false, false);
            }

            if (Date.now() - observeStartedAt > 5000 && fresh.length === 0 && !renderObservedInFlight) {
              const composerBox = (typeof root.flowQuery === "function" ? root.flowQuery("editor") : null) || document.querySelector(".ProseMirror");
              const submitBtn = editor.getFlowSubmitButton() || root.flowButton?.("Start generation");
              const hasText = composerBox && Boolean(editor.getEditorUserText(composerBox));
              const buttonReady = submitBtn && !submitBtn.disabled && submitBtn.getAttribute("aria-disabled") !== "true";
              if (hasText && buttonReady) {
                throw this.error("FLOW_SUBMIT_REJECTED", "Flow không tiếp nhận yêu cầu tạo ảnh/video (câu lệnh vẫn còn trong ô nhập và nút Tạo đã mở lại). Vui lòng kiểm tra lại câu lệnh hoặc hạn mức tài khoản.", false, false);
              }
            }

            const busyTiles = fresh.filter(item => item.busy);
            if (busyTiles.length > 0 || (correlationEntry && correlationEntry.requestSeen)) {
              renderObservedInFlight = true;
            }

            // Extract highest percentage or progress status
            const percentages = allMedia.slice(0, 8).map(t => (t.element?.innerText || "").match(/(\d{1,3})\s*%/)?.[0] || t.progress).filter(Boolean);
            const currentPct = percentages.find(p => /^\d{1,3}%$/.test(p.replace(/\s+/g, "")));
            let progress = "";
            if (currentPct) {
              progress = `Đang render (${currentPct.replace(/\s+/g, "")})`;
            } else if (busyTiles.length > 0) {
              progress = kind === "video" ? "Flow đang render video..." : "Flow đang render ảnh...";
            } else if (renderObservedInFlight) {
              progress = "Flow đang xử lý và hoàn tất kết quả...";
            } else {
              progress = "Đang chờ Flow bắt đầu render...";
            }

            if (progress !== priorProgress) {
              tiles.emitFlowProgress(command, progress);
              priorProgress = progress;
            }

            // A tile is ready ONLY if !item.busy AND item.mediaReady (loaded image or video!)
            const ready = fresh.filter(item => item.mediaReady && !item.busy && !item.failed);
            const isEarly = Date.now() - observeStartedAt < 2000 && !renderObservedInFlight;

            if (!isEarly && ready.length >= expected) {
              const picked = strictCorrelation
                ? [...correlatedIds].map(id => ready.find(item => item.id?.toLowerCase() === id)).filter(Boolean).slice(0, expected)
                : ready.slice(0, expected);
              if (picked.length < expected) {
                await root.wait?.(1000);
                continue;
              }
              const titleOnly = picked.some(item => !item.id || item.id.startsWith("title:"));
              const signature = picked.map(item => item.id || `title:${item.title}`).join("|");
              if (!titleOnly || signature === lastTitleOnlyResult) {
                tiles.emitFlowProgress(command, kind === "video" ? "Tạo video hoàn tất 100%" : "Tạo ảnh hoàn tất 100%");
                return { media: picked.map(({ id, title, kind: mediaKind }) => ({ id, title, kind: mediaKind })) };
              }
              lastTitleOnlyResult = signature;
              tiles.emitFlowProgress(command, "Flow đang cập nhật tiêu đề file...");
              await root.wait?.(1500);
              continue;
            }

            await root.wait?.(2000);
          }
          throw this.error("FLOW_GENERATION_TIMEOUT", "Hết thời gian chờ Flow render. Lệnh có thể đã được tiếp nhận; vui lòng kiểm tra giao diện Flow trước khi thử lại.", false, true);
        } finally {
          if (correlationAttemptId) tiles.disarmNativeFlowCorrelation(correlationAttemptId);
        }
      }

      return undefined;
    }
  }
  root.FlowGenerationOperations = FlowGenerationOperations;
})(globalThis);
