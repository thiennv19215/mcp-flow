(function (root) {
  class FlowGenerationOperations {
    constructor(driver) {
      this.driver = driver;
    }
    supports(operation) {
      return ["flow.generation.submit", "flow.generation.observe", "flow.generation.manual.confirm", "flow.generation.manual.cancel"].includes(operation);
    }
    error(...args) {
      return this.driver.error(...args);
    }
    frameValue(value) {
      if (typeof value === "string" && value.trim()) return { assetName: value.replace(/^asset:/i, "").trim() };
      if (!value || typeof value !== "object") return undefined;
      if (typeof value.assetName === "string" && value.assetName.trim()) {
        const kind = String(value.kind || "image").trim().toLowerCase();
        if (kind !== "image") return null;
        const expectedId = value.expectedId;
        const isUuid = typeof expectedId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(expectedId);
        const isAsb = typeof expectedId === "string" && expectedId.startsWith("asb:");
        if (expectedId !== undefined && !isUuid && !isAsb) return null;
        return { assetName: value.assetName.trim(), ...(value.kind ? { kind: value.kind } : {}), ...(expectedId ? { expectedId: isUuid ? String(expectedId).toLowerCase() : String(expectedId) } : {}) };
      }
      if (root.validStagedLocalImage?.(value, /(?:start|end)/)) return value;
      return null;
    }
    selectFrameAsset(components, value, slot, options) {
      const assetName = String(value.assetName || value || "").replace(/^asset:/i, "").trim();
      return components.chooseNativePickerAsset(assetName, slot, {
        ...options,
        ...(value.expectedId ? { expectedId: value.expectedId } : {}),
        ...(value.kind ? { kind: value.kind } : {}),
        ...(value.search_value ? { search_value: value.search_value } : {}),
      });
    }
    async execute(name, payload = {}, command = {}) {
      const nav = root.FlowNavigation;
      const editor = root.FlowEditor;
      const settings = root.FlowSettings;
      const components = root.FlowComponents;
      const tiles = root.FlowTiles;
      const menu = root.FlowMediaMenu;
      const agent = root.FlowAgent;
      if (name === "flow.generation.manual.confirm") {
        const attemptId = String(payload.attemptId || "");
        const entry = tiles.nativeFlowCorrelationMap().get(attemptId);
        if (!entry) throw this.error("FLOW_MANUAL_SUBMIT_SESSION_LOST", "The prepared Flow submit observer is no longer active. Check Flow for a submitted generation before retrying.", false, true);
        if (entry.interfered && !entry.requestSeen) {
          tiles.disarmNativeFlowCorrelation(attemptId);
          throw this.error("FLOW_MANUAL_SUBMIT_INTERFERENCE", "The Flow prompt changed during manual submit, so the request cannot be safely matched. Check the project before retrying.", false, true);
        }
        if (!entry.requestSeen) return { waitingForUser: true };
        const prepared = payload.prepared && typeof payload.prepared === "object" ? payload.prepared : {};
        const rawReceipt = [...entry.receipts].reverse().find(item => item?.stage === "request_seen");
        if (!rawReceipt) throw this.error("FLOW_MANUAL_SUBMIT_RECEIPT_MISSING", "Flow request activity was observed but its correlated submit receipt is incomplete. Check Flow before retrying.", false, true);
        const receipt = {
          stage: "request_seen",
          attemptId: entry.attemptId,
          requestOrdinal: Number.isInteger(rawReceipt.requestOrdinal) ? rawReceipt.requestOrdinal : null,
          requestCardinality: Number.isInteger(rawReceipt.requestCardinality) ? rawReceipt.requestCardinality : null,
          matchKind: typeof rawReceipt.matchKind === "string" ? rawReceipt.matchKind : null,
        };
        if (prepared.submitOnly === true) tiles.releaseSubmitOnlyCorrelation?.(attemptId, true);
        await tiles.emitFlowProgress(command, "Flow accepted the manual generation request; saved a recovery checkpoint.", {
          generationObservation: {
            before: Array.isArray(prepared.before) ? prepared.before : [],
            kind: prepared.type === "image" ? "image" : "video",
            expectedCount: Math.max(1, Math.min(4, Number(prepared.expectedCount) || 1)),
            correlationAttemptId: attemptId,
            credits: Number.isFinite(prepared.credits) ? prepared.credits : null,
            timeoutMs: prepared.type === "image" ? 300_000 : 600_000,
            submitOnly: prepared.submitOnly === true,
          },
        });
        return {
          submitted: true,
          before: Array.isArray(prepared.before) ? prepared.before : [],
          type: prepared.type === "image" ? "image" : "video",
          expectedCount: Math.max(1, Math.min(4, Number(prepared.expectedCount) || 1)),
          credits: Number.isFinite(prepared.credits) ? prepared.credits : null,
          correlationAttemptId: attemptId,
          requestDispatched: true,
          manualSubmit: true,
          correlationReceipt: receipt,
        };
      }
      if (name === "flow.generation.manual.cancel") {
        const attemptId = String(payload.attemptId || "");
        const entry = tiles.nativeFlowCorrelationMap().get(attemptId);
        if (!entry) throw this.error("FLOW_MANUAL_SUBMIT_SESSION_LOST", "The prepared Flow submit observer is no longer active. Check Flow before retrying.", false, true);
        if (entry?.requestSeen) throw this.error("FLOW_MANUAL_SUBMIT_ALREADY_DISPATCHED", "Flow already dispatched this manual submit; it cannot be cancelled. Check the project for its result.", false, true);
        let promptCleared = false;
        const editor = root.getVisibleFlowPromptEditor?.();
        if (!editor) throw this.error("FLOW_MANUAL_SUBMIT_STATE_UNKNOWN", "The Flow prompt editor is no longer visible. Check Flow before cancelling or retrying.", false, true);
        const currentPrompt = root.FlowEditor?.getEditorUserText?.(editor) ?? "";
        if (!currentPrompt && typeof payload.expectedPrompt === "string" && payload.expectedPrompt.length) {
          throw this.error("FLOW_MANUAL_SUBMIT_STATE_UNKNOWN", "The prompt is already empty, so Flow may have accepted the manual submit. Check Flow before retrying.", false, true);
        }
        if (typeof payload.expectedPrompt === "string" && currentPrompt === payload.expectedPrompt) {
          promptCleared = await root.FlowEditor.clearEditorTextPreservingChips(editor);
          if (!promptCleared) throw this.error("FLOW_MANUAL_SUBMIT_CANCEL_UNCONFIRMED", "Flow could not clear the exact prepared prompt, so the manual job remains active.", false, false);
        }
        if (entry.requestSeen) throw this.error("FLOW_MANUAL_SUBMIT_ALREADY_DISPATCHED", "Flow dispatched this manual submit while it was being cancelled; check the project for its result.", false, true);
        tiles.disarmNativeFlowCorrelation(attemptId);
        return { cancelled: true, promptCleared, promptPreserved: !promptCleared };
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
        const requireFlowTime = (operation, outcomeUnknown = false) => {
          if (command.signal?.aborted) {
            throw root.flowError("FLOW_OPERATION_CANCELLED", "The Flow queue stopped while " + operation + ". " + (outcomeUnknown ? "The submit outcome may be unknown; inspect Flow before retrying." : "No generation was submitted."), false, outcomeUnknown);
          }
          return root.FlowUiDeadline?.requireTime(flowDeadline, operation, outcomeUnknown, flowAbort.signal);
        };
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
          let onAbort;
          const cancelled = new Promise((_, reject) => {
            onAbort = () => {
              flowAbort.abort(command.signal?.reason);
              reject(root.flowError("FLOW_OPERATION_CANCELLED", "The Flow queue stopped during " + label + ". " + (outcomeUnknown ? "The submit outcome may be unknown; inspect Flow before retrying." : "No generation was submitted."), false, outcomeUnknown));
            };
            if (command.signal?.aborted) onAbort();
            else command.signal?.addEventListener("abort", onAbort, { once: true });
          });
          let result;
          try {
            result = await Promise.race([
              Promise.resolve().then(() => operation({ deadline: flowDeadline, signal: flowAbort.signal })),
              timeout,
              cancelled,
            ]);
          } catch (error) {
            if (flowAbort.signal.aborted && !["FLOW_OPERATION_TIMEOUT", "FLOW_OPERATION_CANCELLED"].includes(error?.code)) {
              throw root.flowError("FLOW_OPERATION_TIMEOUT", `Stopped waiting during Flow submit stage: ${label}. That page step may still be running; no later submit stage will start. Inspect Flow before retrying.`, false, outcomeUnknown);
            }
            throw error;
          } finally {
            clearTimeout(timer);
            command.signal?.removeEventListener("abort", onAbort);
          }
          requireFlowTime(label, outcomeUnknown);
          return result;
        };
        const initialScreen = root.FlowScreenState?.inspect?.();
        if (["signed_out", "project_error"].includes(initialScreen?.state)) {
          root.FlowScreenState.assertGenerationReady();
        }
        await runFlowStage("opening the project editor", ({ deadline, signal }) => nav.ensureFlowProjectEditor({ deadline, signal }));
        root.FlowScreenState?.assertGenerationReady?.();
        const state = menu.nativeRead("flowState");
        if (!state.signedIn || !state.inProject) throw this.error("FLOW_NOT_READY", state.hint || "Open a signed-in Flow project first.", true);
        await runFlowStage("checking blocking dialogs", ({ deadline, signal }) => nav.dismissBlockingOverlays({ deadline, signal }));
        const creditAlert = root.checkFlowCreditLimitAlert?.();
        if (creditAlert) {
          const classified = root.classifyFlowError?.(creditAlert);
          throw this.error(
            classified?.code || "FLOW_QUOTA_EXCEEDED",
            classified?.message || `Flow reports that the available credit limit has been reached: ${creditAlert}. No generation was submitted.`,
            false,
            false,
          );
        }
        await runFlowStage("closing any Agent session", ({ signal }) => agent.closeNativeAgentSession({ signal, deadline: flowDeadline }));
        await runFlowStage("opening All media", ({ deadline, signal }) => nav.ensureFlowLibrarySection("All media", { deadline, signal }));
        const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
        const variants = Math.max(1, Math.min(4, Number(payload.variants || payload.count || 1)));
        const firstFrame = this.frameValue(payload.firstFrame), lastFrame = this.frameValue(payload.lastFrame);
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
        let confirmedAttachmentCount = 0;
        await runFlowStage("stabilizing the Flow results grid before the generation baseline", ({ deadline, signal }) =>
          tiles.stabilizeFlowResultViewport?.({ deadline, signal }));
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
          let uploadError;
          try {
            uploadReceipt = await runFlowStage(`uploading ${attachment.name}`, ({ signal }) => components.uploadStagedFlowMedia(file, "image", command, { deadline: flowDeadline, signal }), true);
          } catch (error) {
            uploadError = error;
          }

          if (!flowAbort.signal.aborted && framesMode && (slot === "start" || slot === "end")) {
            try {
              await runFlowStage("restoring Frames mode after upload", ({ deadline, signal }) => settings.restoreNativeFramesMode({ deadline, signal }));
            } catch (restoreError) {
              if (!uploadError) uploadError = restoreError;
              else uploadError.diagnostics = { ...(uploadError.diagnostics || {}), framesRestoreErrorCode: restoreError?.code || "FLOW_FRAMES_RESTORE_FAILED" };
            }
          }

          // Local references upload inside this generation operation instead
          // of going through flow.media.upload. Close and verify the upload UI
          // here too, before opening the reference picker or inserting prompt
          // text. Give cleanup its own short window so an aborted upload stage
          // cannot leave Flow's popup blocking the next attempt.
          let popupCleanupError;
          try {
            tiles.emitFlowProgress(command, "Flow upload: closing and verifying the upload popup");
            if (typeof nav.prepareFlowOperation !== "function") {
              throw this.error("FLOW_OPERATION_PREFLIGHT_UNAVAILABLE", "Flow popup cleanup is unavailable after upload; no reference or prompt changes were made.", true, false);
            }
            await nav.prepareFlowOperation({ deadline: Date.now() + 4_000 });
          } catch (error) {
            popupCleanupError = error;
          }

          if (uploadError) {
            if (popupCleanupError) uploadError.diagnostics = {
              ...(uploadError.diagnostics || {}),
              uploadPopupCleanupErrorCode: popupCleanupError?.code || "FLOW_UPLOAD_POPUP_CLEANUP_FAILED",
            };
            throw uploadError;
          }
          if (popupCleanupError) throw popupCleanupError;
          return await runFlowStage(`selecting uploaded image ${attachment.name}`, ({ signal }) => components.chooseNativePickerAsset(attachment.name, slot, { deadline: flowDeadline, signal, command, expectedId: uploadReceipt?.id }), true);
        };

        const resolveValue = async (value, slot) => {
          if (!value) return;
          requireFlowTime("selecting Flow references", expectedVideoReferenceIds.length + expectedMediaReferenceIds.length + expectedCharacterIds.length > 0);
          if (value.assetName) {
            const assetName = String(value.assetName).replace(/^asset:/i, "");
            const isVideoReference = value.kind === "video" || /\.(mp4|mov|webm)$/i.test(assetName);
            if (isVideoReference) {
              if (typeof root.FlowReferenceActions?.attach === "function") {
                return runFlowStage(`selecting video reference ${assetName}`, ({ signal }) => root.FlowReferenceActions.attach(value, slot, {
                  deadline: flowDeadline, signal, command, expectedId: value.expectedId,
                }), true);
              }
              if (typeof components?.chooseNativePickerAsset === "function") {
                return runFlowStage(`selecting video reference ${assetName}`, ({ signal }) => this.selectFrameAsset(components, value, slot, { deadline: flowDeadline, signal, command }), true);
              }
              throw this.error("FLOW_REFERENCE_ATTACH_UNAVAILABLE", "Flow's video reference picker is unavailable; no generation was submitted.", false, false);
            }
            return runFlowStage(`selecting asset ${value.assetName}`, ({ signal }) => this.selectFrameAsset(components, value, slot, { deadline: flowDeadline, signal, command }), true);
          }
          return uploadAndResolve(value, slot);
        };

        const recordSelectedReference = selected => {
          if (framesMode) {
            if (selected?.id) expectedVideoReferenceIds.push(selected.id);
            return;
          }
          if (selected?.kind === "character") {
            if (selected.id) expectedCharacterIds.push(selected.id);
          } else if (selected?.kind === "video") {
            if (selected.id) expectedVideoReferenceIds.push(selected.id);
          } else if (selected?.id) expectedMediaReferenceIds.push(selected.id);
        };
        if (firstFrame) recordSelectedReference(await resolveValue(firstFrame, "start"));
        if (lastFrame) recordSelectedReference(await resolveValue(lastFrame, "end"));
        for (const item of referenceAttachments) {
          const attachment = typeof item === "string" ? { assetName: item.replace(/^asset:/i, "").trim() } : item;
          const selected = await resolveValue(attachment, undefined);
          if (!selected?.confirmed) {
            throw this.error("FLOW_REFERENCE_ATTACH_UNCONFIRMED", "Flow did not confirm every requested reference image in the composer; no generation was submitted.", false, true);
          }
          confirmedAttachmentCount += 1;
          recordSelectedReference(selected);
        }

        const requestedReferenceCount = framesMode
          ? Number(Boolean(firstFrame)) + Number(Boolean(lastFrame))
          : referenceAttachments.length;
        const isUuid = value => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
        const requestedVideoRefCount = referenceAttachments.filter(item =>
          (typeof item === "object" && item?.kind === "video") ||
          (typeof item === "string" && /\.(mp4|mov|webm)$/i.test(item))
        ).length;
        const validMediaUuids = expectedMediaReferenceIds.filter(isUuid);
        const validCharacterUuids = expectedCharacterIds.filter(isUuid);
        const validVideoUuids = expectedVideoReferenceIds.filter(isUuid);
        const requestedExactVideoIdCount = framesMode
          ? Number(Boolean(firstFrame)) + Number(Boolean(lastFrame))
          : requestedVideoRefCount;
        if (validVideoUuids.length !== expectedVideoReferenceIds.length || expectedVideoReferenceIds.length < requestedExactVideoIdCount) {
          throw this.error(
            "FLOW_SUBMIT_CORRELATION_REFERENCE_ID_UNAVAILABLE",
            "Flow selected a video or frame reference without a canonical backend UUID. Exact reference identity is required for submit correlation; no generation was submitted.",
            false,
            false
          );
        }
        const verifiedReferenceUuids = framesMode
          ? validVideoUuids
          : [...validMediaUuids, ...validCharacterUuids, ...validVideoUuids];
        const unverifiedUploadRefCount = requestedReferenceCount - verifiedReferenceUuids.length;

        if (expectedCharacterIds.length > 0 && expectedCharacterIds.some(id => !isUuid(id))) {
          throw this.error(
            "FLOW_SUBMIT_CORRELATION_REFERENCE_ID_UNAVAILABLE",
            "Flow selected character references, but their backend character IDs could not be verified for submit correlation. Inspect the composer before retrying.",
            false,
            false
          );
        }
        if (new Set(verifiedReferenceUuids.map(id => id.toLowerCase())).size !== verifiedReferenceUuids.length) {
          throw this.error(
            "FLOW_SUBMIT_CORRELATION_REFERENCE_ID_UNAVAILABLE",
            "Flow detected duplicate reference IDs for submit correlation. Inspect the composer before retrying.",
            false,
            false
          );
        }

        const expectedRefs = referenceAttachments.length;
        if (confirmedAttachmentCount !== expectedRefs) {
          throw this.error("FLOW_REFERENCE_ATTACH_UNCONFIRMED", "Flow confirmed fewer reference attachments than requested; no generation was submitted. Inspect the composer before retrying.", false, true);
        }

        if (!framesMode && (requestedVideoRefCount > 0 || expectedVideoReferenceIds.length > 0)) {
          const composer = (typeof root.flowQuery === "function" ? root.flowQuery("composerRoot") : null) ||
            document.querySelector?.(".flow-composer, .prompt-box, flow-prompt-box") || document;
          const videoChipSelector = '.ingredient_video_chip, [data-kind="video"], [data-ingredient-type="video"], [class*="ingredient-video" i], [class*="video-chip" i], flow-video-ingredient-chip';
          const composerVideoChips = [...(composer?.querySelectorAll?.(videoChipSelector) || [])].filter(root.visible || (() => true));
          const actionVideoChips = typeof root.FlowReferenceActions?.chips === "function"
            ? root.FlowReferenceActions.chips().filter(c => c.kind === "video")
            : [];
          if (composerVideoChips.length === 0 && actionVideoChips.length === 0) {
            throw this.error("FLOW_REFERENCE_ATTACH_UNCONFIRMED", "Flow did not confirm the requested video reference chip in the composer; no generation was submitted.", false, true);
          }
        }

        if (expectedCharacterIds.length > 0) {
          const composer = (typeof root.flowQuery === "function" ? root.flowQuery("composerRoot") : null) ||
            document.querySelector?.(".flow-composer, .prompt-box, flow-prompt-box") || document;
          const charChipSelector = 'flow-character-ingredient-chip, [data-kind="character"], [data-ingredient-type="character"], [class*="character-chip" i], [class*="ingredient-character" i], .ingredient_character_chip';
          const composerCharChips = [...(composer?.querySelectorAll?.(charChipSelector) || [])].filter(root.visible || (() => true));
          const actionCharChips = typeof root.FlowReferenceActions?.chips === "function"
            ? root.FlowReferenceActions.chips().filter(c => c.kind === "character")
            : [];
          if (composerCharChips.length === 0 && actionCharChips.length === 0) {
            throw this.error("FLOW_CHARACTER_SELECTION_UNCONFIRMED", "Flow did not confirm the character reference chip in the composer; no generation was submitted.", false, true);
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

          const composer = (typeof root.flowQuery === "function" ? root.flowQuery("composerRoot") : null) ||
            document.querySelector?.(".flow-composer, .prompt-box, flow-prompt-box") || document;
          const voiceChipSelector = '[data-ingredient-type="voice"], [data-kind="voice"], [class*="voice-chip" i], [class*="ingredient-voice" i], button[aria-label*="voice" i], button[aria-label*="giọng" i]';
          const composerVoiceChips = [...(composer?.querySelectorAll?.(voiceChipSelector) || [])].filter(root.visible || (() => true));
          const actionVoiceChips = typeof root.FlowVoiceActions?.chips === "function"
            ? root.FlowVoiceActions.chips(composer)
            : [];
          if (composerVoiceChips.length === 0 && actionVoiceChips.length === 0) {
            throw this.error("FLOW_VOICE_SELECTION_UNCONFIRMED", "Flow did not confirm the requested voice chip in the composer; no generation was submitted.", false, false);
          }
        }
        requireFlowTime("preparing the Flow submit request", expectedVideoReferenceIds.length + expectedMediaReferenceIds.length + expectedCharacterIds.length > 0);

        let credits;
        if (payload.type !== "image") {
          try {
            const renderedCredits = await runFlowStage("reading Flow's credit quote", ({ signal }) => editor.waitForGenerationCreditQuote(Number.isFinite(settingsCredits) ? 1000 : 2000, { deadline: flowDeadline, signal }));
            credits = Number.isFinite(renderedCredits)
              ? renderedCredits
              : Number.isFinite(settingsCredits)
                ? settingsCredits
                : undefined;
          } catch (_) {
            credits = Number.isFinite(settingsCredits) ? settingsCredits : undefined;
          }
          if (payload.maxCredits !== undefined && Number.isFinite(credits) && credits > Number(payload.maxCredits)) {
            throw this.error("FLOW_MAX_CREDITS_EXCEEDED", `Flow quotes ${credits} credits, above max_credits=${payload.maxCredits}. Nothing was submitted.`, false, false);
          }
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
          expectedReferenceIds: verifiedReferenceUuids,
          expectedMediaReferenceIds: payload.type === "image" ? validMediaUuids : [],
          expectedCharacterIds: payload.type === "image" ? validCharacterUuids : [],
          expectedVoiceCount: payload.voice ? 1 : 0,
          unverifiedMediaCount: unverifiedUploadRefCount,
        }));
        if (!correlationAttemptId || !tiles.nativeFlowCorrelationMap().has(correlationAttemptId)) {
          throw this.error(
            "FLOW_SUBMIT_CORRELATION_UNAVAILABLE",
            "Flow's request observer could not be armed, so the submit cannot be safely confirmed. No generation request was sent.",
            false,
            false
          );
        }
        if (payload.manualSubmit === true || payload.manual_submit === true) {
          tiles.emitFlowProgress(command, "Prompt and settings are ready in Flow. Click Create in Flow, then choose Continue in the extension queue.");
          return {
            submitted: false,
            preparedForManualSubmit: true,
            before,
            prompt: payload.prompt,
            type: payload.type === "image" ? "image" : "video",
            expectedCount: variants,
            credits: Number.isFinite(credits) ? credits : null,
            correlationAttemptId,
            submitOnly: payload.submitOnly === true || payload.submit_only === true,
          };
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
          requireFlowTime("waiting for Flow to dispatch the generation request", true);
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
          if (root.FlowUiDeadline?.boundedWait) await root.FlowUiDeadline.boundedWait(250, submitDeadline, "waiting for Flow request dispatch", true, command.signal);
          else await root.wait?.(250);
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

        const dispatchReceipt = payload.submitOnly === true
          ? tiles.releaseSubmitOnlyCorrelation?.(correlationAttemptId, acknowledged) || null
          : null;
        await tiles.emitFlowProgress(command, "Flow accepted the generation request; saved a recovery checkpoint.", {
          generationObservation: {
            before,
            kind: payload.type === "image" ? "image" : "video",
            expectedCount: variants,
            correlationAttemptId,
            credits: Number.isFinite(credits) ? credits : null,
            timeoutMs: payload.type === "video" ? 600_000 : 300_000,
            submitOnly: payload.submitOnly === true || payload.submit_only === true,
          },
        });
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
          ...(dispatchReceipt ? { correlationReceipt: dispatchReceipt } : {}),
        };
      }

      if (name === "flow.generation.observe") {
        const before = Array.isArray(payload.before) ? payload.before : [];
        const kind = payload.kind === "image" ? "image" : payload.kind === "video" ? "video" : undefined;
        const expected = Math.max(1, Math.min(20, Number(payload.expectedCount || payload.variants || 1)));
        const deadline = Date.now() + Math.max(1000, Math.min(15 * 60000, Number(payload.timeoutMs || 12 * 60000)));
        const correlationAttemptId = String(payload.correlationAttemptId || "");
        const correlationEntry = correlationAttemptId ? tiles.nativeFlowCorrelationMap().get(correlationAttemptId) : null;
        if (!correlationEntry) {
          throw this.error(
            "FLOW_GENERATION_CORRELATION_UNAVAILABLE",
            "Flow's task correlation receipt is missing, so the generated media cannot be safely matched to this task. The result was not selected or downloaded; inspect Flow before retrying.",
            false,
            true
          );
        }
        let priorProgress = "", lastTitleOnlyResult = "";
        let retriesLeft = Math.max(0, Math.min(3, Number(payload.retries ?? 1)));
        const retriedTiles = new Set();
        const observeStartedAt = Date.now();
        let renderObservedInFlight = false;
        let apiResultReceipt = correlationEntry?.receipts
          ? [...correlationEntry.receipts].reverse().find(receipt => receipt?.stage === "result_seen") || null
          : null;
        let resolveApiResult;
        const apiResultSignal = correlationEntry ? new Promise(resolve => { resolveApiResult = resolve; }) : null;
        const onApiResult = event => {
          const receipt = event?.detail;
          if (receipt?.schemaVersion !== 1 || receipt?.attemptId !== correlationAttemptId || receipt?.stage !== "result_seen") return;
          if (receipt.projectId !== correlationEntry?.projectId || receipt.mediaType !== correlationEntry?.mediaType) return;
          apiResultReceipt = receipt;
          resolveApiResult?.(receipt);
        };
        if (correlationEntry) {
          window.addEventListener("TOBY_FLOW_CORRELATION_RECEIPT", onApiResult);
          window.addEventListener("TOBY_FLOW_V2_CORRELATION_RECEIPT", onApiResult);
        }
        let lastMediaScanAt = 0;
        let allMedia = [];

        try {
          while (Date.now() < deadline) {
            if (command.signal?.aborted) throw this.error("FLOW_OPERATION_CANCELLED", "The Flow queue stopped while waiting for generation results. The generation was already submitted; inspect Flow before retrying.", false, true);
            if (correlationEntry?.interfered) {
              throw this.error("FLOW_GENERATION_INTERFERENCE", "A trusted interaction changed the Flow composer before this generation request was observed. The result cannot be safely attributed; inspect the project before retrying.", false, true);
            }

            const quotaAlert = root.checkFlowCreditLimitAlert?.();
            if (quotaAlert) {
              console.warn(`[FlowObserve] Quota alert observed: "${quotaAlert}".`);
            }

            const currentErrors = editor.currentFlowSubmitErrors();
            if (currentErrors.length > 0) {
              const failureText = currentErrors[0];
              const classified = root.classifyFlowError?.(failureText);
              if (classified) throw this.error(classified.code, classified.message, classified.retryable, false);
              throw this.error("FLOW_GENERATION_FAILED", `Flow hiển thị thông báo lỗi: "${failureText}".`, false, false);
            }

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

            const receiptMediaIds = [
              ...(receipt?.mediaIds || []),
              ...(receipt?.children || []).map(child => child?.mediaId),
            ].filter(id => typeof id === "string" && id.trim());
            if (apiResultReceipt && receiptMediaIds.length === 0) {
              throw this.error(
                "FLOW_GENERATION_MEDIA_ID_MISSING",
                "Flow completed this generation response without exposing a task-owned media ID. The extension did not guess from the gallery or download a file; inspect the Flow result manually.",
                false,
                true
              );
            }

            const correlatedIds = new Set(receiptMediaIds.map(id => id.toLowerCase()));
            if (correlatedIds.size > expected) {
              throw this.error(
                "FLOW_GENERATION_MEDIA_ID_AMBIGUOUS",
                `Flow correlated ${correlatedIds.size} media IDs to a task that requested ${expected} output(s). The extension did not choose a subset or download any file.`,
                false,
                true
              );
            }

            // Flow's main-world observer follows the submit and subsequent API
            // poll responses. Use its terminal receipt as the primary signal;
            // only rescan the media grid occasionally to resolve display names
            // and loaded media needed by the result/download path.
            const mediaScanInterval = apiResultReceipt ? 1_000 : 5_000;
            if (!lastMediaScanAt || Date.now() - lastMediaScanAt >= mediaScanInterval) {
              allMedia = tiles.collectNativeMedia();
              lastMediaScanAt = Date.now();
            }
            const fresh = allMedia.filter(item =>
              !before.includes(item.id || `title:${item.title}`) &&
              !item.title.startsWith("fm-") &&
              (!kind || item.kind === kind || item.failed) &&
              item.id && correlatedIds.has(item.id.toLowerCase())
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
              const retryable = failed.find(item => !retriedTiles.has(tiles.retryIdentity?.(item)));
              if (retryable && retriesLeft > 0 && await tiles.retryNativeErrorTile(retryable, {
                attempted: retriedTiles,
                deadline,
                timeoutMs: Math.min(5000, Math.max(250, deadline - Date.now())),
              })) {
                retriesLeft--;
                tiles.emitFlowProgress(command, `Flow thất bại render; đang thử lại (${Math.max(0, Number(payload.retries ?? 1) - retriesLeft)}/${Number(payload.retries ?? 1)})`);
                continue;
              }
              const details = failed.map(item => `${item.title}${item.failureReason ? `: ${item.failureReason}` : ""}`).join("; ");
              throw this.error("FLOW_GENERATION_FAILED", `Flow báo cáo ${failed.length} tile render thất bại: ${details}. Chưa bị trừ tín dụng cho render lỗi này.`, false, false);
            }

            if (Date.now() - observeStartedAt > 5000 && fresh.length === 0 && !renderObservedInFlight) {
              const composerBox = root.getVisibleFlowPromptEditor?.() || (typeof root.flowQuery === "function" ? root.flowQuery("editor") : null);
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
              const picked = [...correlatedIds].map(id => ready.find(item => item.id?.toLowerCase() === id)).filter(Boolean);
              if (picked.length < expected) {
                await root.wait?.(1000);
                continue;
              }
              const titleOnly = picked.some(item => !item.id || item.id.startsWith("title:"));
              const signature = picked.map(item => item.id || `title:${item.title}`).join("|");
              if (!titleOnly || signature === lastTitleOnlyResult) {
                const media = picked.map(({ id, title, kind: mediaKind }) => ({
                  id,
                  title,
                  // Flow reports generated video scenes as `scene`; normalize
                  // them so queue download and download-later treat them as video.
                  kind: mediaKind === "scene" ? "video" : mediaKind,
                }));
                await tiles.emitFlowProgress(command, kind === "video" ? "Tạo video hoàn tất 100%" : "Tạo ảnh hoàn tất 100%", {
                  generationResult: { media },
                });
                return { media };
              }
              lastTitleOnlyResult = signature;
              tiles.emitFlowProgress(command, "Flow đang cập nhật tiêu đề file...");
              await root.wait?.(1500);
              continue;
            }

            const waitMs = Math.min(apiResultReceipt ? 1_000 : 5_000, Math.max(1, deadline - Date.now()));
            if (apiResultSignal && !apiResultReceipt) {
              await Promise.race([apiResultSignal, root.wait?.(waitMs) || new Promise(resolve => setTimeout(resolve, waitMs))]);
            } else {
              await root.wait?.(waitMs);
            }
          }
          throw this.error("FLOW_GENERATION_TIMEOUT", "Hết thời gian chờ Flow render. Lệnh có thể đã được tiếp nhận; vui lòng kiểm tra giao diện Flow trước khi thử lại.", false, true);
        } finally {
          if (correlationEntry) {
            window.removeEventListener("TOBY_FLOW_CORRELATION_RECEIPT", onApiResult);
            window.removeEventListener("TOBY_FLOW_V2_CORRELATION_RECEIPT", onApiResult);
          }
          if (correlationAttemptId) tiles.disarmNativeFlowCorrelation(correlationAttemptId);
        }
      }

      return undefined;
    }
  }
  root.FlowGenerationOperations = FlowGenerationOperations;
})(globalThis);
