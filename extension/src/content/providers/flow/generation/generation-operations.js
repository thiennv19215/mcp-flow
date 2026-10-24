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
        // VID-02: this confirm is the submit acknowledgement for a manual
        // dispatch — stamp the dispatch moment for the observation
        // checkpoint exactly like the automatic submit path, so a resumed
        // observe anchors its render deadline here.
        const dispatchedAt = Date.now();
        await tiles.emitFlowProgress(command, "Flow accepted the manual generation request; saved a recovery checkpoint.", {
          generationObservation: {
            before: Array.isArray(prepared.before) ? prepared.before : [],
            kind: prepared.type === "image" ? "image" : "video",
            expectedCount: Math.max(1, Math.min(4, Number(prepared.expectedCount) || 1)),
            correlationAttemptId: attemptId,
            dispatchedAt,
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
          dispatchedAt,
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
          // Videofix M-E: the slate-bridge ambiguity flag is wired here
          // instead of staying dead metadata on the activation. It records
          // one real diagnostic fact — the click landed but the bridge's
          // reply was lost — for every submit error that carries observer
          // diagnostics. It is NOT a "dispatched, ambiguous" state: no
          // code treats the submit as dispatched on this flag alone; the
          // dispatch wait's correlation / DOM signals own the verdict.
          const submitBridgeAmbiguous = activation?.mainActivationAmbiguous === true;
          error.diagnostics = {
            clickDelivered: true,
            submitBridgeAmbiguous,
            observerReady: false,
            xhrHookActive: false,
            fetchHookActive: false,
            requestDiagnostics: { version: 1, count: 0, events: [] },
          };
          try {
            const observer = await tiles.readNativeFlowCorrelationHealth?.();
            if (observer) error.diagnostics = {
              clickDelivered: true,
              submitBridgeAmbiguous,
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
        const requestedVideoMode = String(payload.video_settings?.mode || payload.mode || "").trim().toLowerCase();
        const framesMode = payload.type === "video" && (requestedVideoMode === "frames" || Boolean(firstFrame || lastFrame));
        if (framesMode && !firstFrame && !lastFrame) {
          throw this.error("FLOW_FRAMES_INPUT_MISSING", "Frames mode requires a Start frame or End frame; nothing was submitted.", false, false);
        }
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
        // IMG-04: pre-generation reference revalidation (the content-side
        // run of the flow-ref-preflight contract; the background module of
        // the same name is the canonical implementation the queue hook
        // uses). References were resolved when this job was created, but a
        // queued job can run much later — a referenced library tile may
        // have been deleted, or an uploaded asset may have vanished.
        // Revalidate BEFORE any settings/prompt work: the IMG-03 catalog is
        // consulted first, then a targeted existence check for the specific
        // asset; an uploaded ref whose staged bytes are still retained is
        // re-uploaded and the expectedId the attach stages below use is
        // rewritten. A missing library ref fails here with the distinct
        // preflight code instead of surfacing as a mid-submit attach
        // error. Existence here only proves presence (by id or by name);
        // the attach stages still verify identity exactly as before.
        const refChecks = [];
        const addRefCheck = (assetName, expectedId, kind, applyId) => {
          const name = typeof assetName === "string" ? assetName.replace(/^asset:/i, "").trim() : "";
          if (!name) return;
          refChecks.push({ assetName: name, expectedId: typeof expectedId === "string" && expectedId ? expectedId : undefined, kind, applyId: applyId || null });
        };
        for (const item of referenceAttachments) {
          if (typeof item === "string") addRefCheck(item, undefined, undefined, null);
          else if (item && typeof item === "object" && typeof item.assetName === "string") {
            addRefCheck(item.assetName, item.expectedId, item.kind, newId => { item.expectedId = newId; });
          }
          // Staged local attachments (transferId) carry their own bytes
          // into this submit and are uploaded by uploadAndResolve; skip.
        }
        if (firstFrame) addRefCheck(firstFrame.assetName, firstFrame.expectedId, firstFrame.kind, newId => {
          firstFrame.expectedId = newId;
          if (payload.firstFrame && typeof payload.firstFrame === "object") payload.firstFrame.expectedId = newId;
        });
        if (lastFrame) addRefCheck(lastFrame.assetName, lastFrame.expectedId, lastFrame.kind, newId => {
          lastFrame.expectedId = newId;
          if (payload.lastFrame && typeof payload.lastFrame === "object") payload.lastFrame.expectedId = newId;
        });
        if (refChecks.length) {
          const catalogProjectId = (() => {
            try { return root.location?.pathname?.match(/\/project\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i)?.[1]?.toLowerCase() || null; } catch { return null; }
          })();
          const lookupRefCatalog = async ref => {
            if (!catalogProjectId) return null;
            try {
              const sendMessage = root.chrome?.runtime?.sendMessage;
              if (typeof sendMessage !== "function") return null;
              const response = await sendMessage.call(root.chrome.runtime, {
                type: "flow-media-catalog:lookup",
                query: { projectId: catalogProjectId, ...(ref.expectedId ? { mediaId: ref.expectedId } : {}), name: ref.assetName },
              });
              return response?.ok ? response.entry || null : null;
            } catch { return null; }
          };
          // M-A: provenance-graded reference trust. A name-only match
          // used to pass whenever ANY tile's computed name equalled the
          // ref name — including a tile whose name exists only because
          // its aria-label is a UI action string ("Request for text
          // translation"). That let a poisoned action label pass
          // revalidation and reach the frame picker as a real asset.
          // Now a name match only counts when the tile's name came from
          // a dedicated attribute (see collectAssets nameSource); a
          // fallback-only name without an id is untrusted and fails
          // here, before anything is submitted. "unknown" keeps the old
          // degrade discipline: an unavailable scan cannot prove
          // absence, so the attach stages below remain the authority.
          const refNameTrust = (ref, entry) => {
            if (typeof menu.collectAssets !== "function") return "unknown";
            let assets;
            try { assets = menu.collectAssets({ includeIncomplete: true }); } catch { return "unknown"; }
            const ids = new Set([ref.expectedId, entry?.mediaId, entry?.uuid].filter(value => typeof value === "string" && value));
            if (ids.size > 0 && assets.some(asset => ids.has(asset?.id) || ids.has(asset?.persistentMediaId))) return "id";
            const named = assets.filter(asset => String(asset?.name || "").trim() === ref.assetName);
            if (named.some(asset => asset?.nameSource === "dedicated")) return "dedicated";
            if (named.length > 0) return "fallback-only";
            return "absent";
          };
          // (No separate refAssetExists helper: the loop below reads the
          // trust grade directly so it can report the fallback-only
          // cause distinctly instead of a generic "missing".)
          const retainedRefFile = entry => {
            const wanted = [entry?.originalName, entry?.uploadName].filter(value => typeof value === "string" && value);
            if (!wanted.length || !root.stagedNativeFiles) return null;
            const matches = [...root.stagedNativeFiles.values()].filter(file => file && wanted.includes(file.name));
            // A name shared by several staged files cannot prove which
            // bytes belong to this asset — treat it as not retained.
            return matches.length === 1 ? matches[0] : null;
          };
          await runFlowStage("revalidating queued references", async ({ signal }) => {
            const missing = [];
            const missingFallback = [];
            for (const ref of refChecks) {
              const entry = await lookupRefCatalog(ref);
              const trust = refNameTrust(ref, entry);
              if (trust === "unknown" || trust === "id" || trust === "dedicated") continue;
              let restoredId = null;
              if (entry?.uploadName) {
                const file = retainedRefFile(entry);
                if (file) {
                  // Review round 1, S1: the confirmation may extend up to
                  // the submit budget itself while the owner tile
                  // processes (see the uploadAndResolve call below).
                  const receipt = await components.uploadStagedFlowMedia(file, ref.kind === "video" ? "video" : "image", command, { deadline: flowDeadline, extendableTo: flowDeadline, signal });
                  if (typeof receipt?.id === "string" && receipt.id) restoredId = receipt.id;
                }
              }
              if (restoredId) {
                ref.applyId?.(restoredId);
                continue;
              }
              if (trust === "fallback-only") missingFallback.push(ref.assetName);
              else missing.push(ref.assetName);
            }
            if (missing.length || missingFallback.length) {
              throw this.error(
                "FLOW_QUEUE_PREFLIGHT_REFERENCE_MISSING",
                [
                  ...(missing.length ? [`Flow reference${missing.length === 1 ? "" : "s"} missing before generation: ${missing.join(", ")}. The referenced asset is no longer in the Flow project library, and no retained upload bytes are available to restore it.`] : []),
                  ...(missingFallback.length ? [`The following reference name${missingFallback.length === 1 ? "" : "s"} ${missingFallback.length === 1 ? "was" : "were"} found only as a UI label (such as a tile aria-label), not as an asset file name, so ${missingFallback.length === 1 ? "it" : "they"} cannot be trusted as asset titles: ${missingFallback.join(", ")}. Re-attach ${missingFallback.length === 1 ? "it" : "them"} from the Flow library so ${missingFallback.length === 1 ? "it carries" : "they carry"} an asset ID, or remove ${missingFallback.length === 1 ? "it" : "them"} from the job.`] : []),
                  "Nothing was submitted.",
                ].join(" "),
                false,
                false,
              );
            }
          });
        }
        const expectedMediaReferenceIds = [];
        const expectedCharacterIds = [];
        const expectedVideoReferenceIds = [];
        let confirmedAttachmentCount = 0;
        await runFlowStage("stabilizing the Flow results grid before the generation baseline", ({ deadline, signal }) =>
          tiles.stabilizeFlowResultViewport?.({ deadline, signal }));
        const before = tiles.collectNativeMedia().map(item => tiles.tileSnapshotKey?.(item) || item.id || `title:${item.title}`);
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
          // Review round 1, S2: staged bytes live only in page memory,
          // so a lost transfer can never be recovered by retrying this
          // job — only by re-attaching the file and creating a new job.
          // Non-retryable, outcome known (nothing was submitted).
          if (!file) throw this.error("FLOW_TRANSFER_UNKNOWN", "The staged image is no longer available (the tab was reloaded or the transfer expired). Re-attach the file and create a new job — retrying this job cannot restore it.", false, false);
          let uploadReceipt;
          let uploadError;
          try {
            // Review round 1, S1: pass the submit budget as the
            // confirmation extension ceiling — a tile finishing past the
            // 90 s base cap but inside the budget confirms instead of
            // timing out, while the budget itself is never exceeded.
            uploadReceipt = await runFlowStage(`uploading ${attachment.name}`, ({ signal }) => components.uploadStagedFlowMedia(file, "image", command, { deadline: flowDeadline, extendableTo: flowDeadline, signal }), true);
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
          // M-B: the dispatched tile bears the uploader's digest-derived
          // uploadName, not the client's safeName — pass uploadName (the
          // same precedence the sidebar's uploadedAssetAttachment uses)
          // so the picker's title leg can match the tile it just made.
          const pickerTitle = uploadReceipt?.uploadName || uploadReceipt?.name || attachment.name;
          return await runFlowStage(`selecting uploaded image ${attachment.name}`, ({ signal }) => components.chooseNativePickerAsset(pickerTitle, slot, { deadline: flowDeadline, signal, command, expectedId: uploadReceipt?.id }), true);
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
            return runFlowStage(`selecting asset ${assetName}`, ({ signal }) => this.selectFrameAsset(components, value, slot, { deadline: flowDeadline, signal, command }), true);
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
        const maxCredits = payload.maxCredits ?? payload.max_credits ?? payload.params?.maxCredits ?? payload.params?.max_credits;
        // The credit-quote gate guards every generation type, not just
        // video: whenever a maxCredits cap is set, the composer's quote must
        // be read and enforced before submit, failing closed when no quote
        // can be read. Video jobs also read the quote without a cap because
        // the submit result reports the charged credits; uncapped image jobs
        // keep the historical behavior and skip the read entirely.
        if (payload.type !== "image" || maxCredits !== undefined) {
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
          if (maxCredits !== undefined && !Number.isFinite(credits)) {
            throw this.error("FLOW_CREDIT_QUOTE_UNAVAILABLE", `Flow did not show a verifiable credit quote. Because maxCredits is set, no ${payload.type === "image" ? "image" : "video"} request was submitted.`, false, false);
          }
          if (maxCredits !== undefined && credits > Number(maxCredits)) {
            throw this.error("FLOW_MAX_CREDITS_EXCEEDED", `Flow quotes ${credits} credits, above max_credits=${maxCredits}. Nothing was submitted.`, false, false);
          }
        }

        const start = await runFlowStage("finding the submit button", () => editor.waitForGenerationSubmitButton(payload.prompt, 15000));
        if (!start) throw this.error("FLOW_SUBMIT_BUTTON_MISSING", "Flow's Start generation button was not found; nothing was submitted.", true);
        if (start.disabled || start.getAttribute("aria-disabled") === "true") {
          throw this.error("FLOW_SUBMIT_DISABLED", "Flow's Start generation button is disabled; nothing was submitted.", true);
        }

        const errorsBeforeSubmit = new Set(editor.currentFlowSubmitErrors());
        const projectId = (root.ProviderRegistry || root.FlowDriverRegistry).describeUrl(location.href)?.projectId;
        // VID-03: a caller that already knows the wire model key / ratio
        // enum supplies them on the payload (top level or the params bag,
        // the same convention as maxCredits) and they are forwarded as
        // correlation expectations. The submit path itself only knows UI
        // labels (payload.model) and aspect strings ("16:9"); no
        // label-to-wire-key or aspect-to-enum mapping exists in this repo,
        // so those are deliberately NOT converted into expectations —
        // absent expectations keep attribution exactly as before.
        const expectedVideoModelKey = payload.expectedVideoModelKey ?? payload.params?.expectedVideoModelKey;
        const expectedVideoRatioEnum = payload.expectedVideoRatioEnum ?? payload.params?.expectedVideoRatioEnum;
        const expectedImageModelKey = payload.expectedImageModelKey ?? payload.params?.expectedImageModelKey;
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
          ...(expectedVideoModelKey !== undefined ? { expectedVideoModelKey } : {}),
          ...(expectedVideoRatioEnum !== undefined ? { expectedVideoRatioEnum } : {}),
          ...(expectedImageModelKey !== undefined ? { expectedImageModelKey } : {}),
        }));
        if (!correlationAttemptId || !tiles.nativeFlowCorrelationMap().has(correlationAttemptId)) {
          // M-D: when the arm failed on a retired conflict, say so and
          // say how to clear it (tab reload clears the hold immediately;
          // the hold also expires after the observer TTL). The generic
          // message hid this remedy and made the failure look permanent.
          const armReason = root.__flowNativeCorrelationArmDiagnostics?.receipt?.reason;
          throw this.error(
            "FLOW_SUBMIT_CORRELATION_UNAVAILABLE",
            armReason === "ambiguous_retired_request"
              ? "Flow's request observer refused a new attempt because a previous identical submit ended without a confirmed dispatch, so retrying now could double-generate. Reload the Flow tab (which clears the hold) or wait up to 15 minutes, then retry. No generation request was sent."
              : "Flow's request observer could not be armed, so the submit cannot be safely confirmed. No generation request was sent.",
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
          // M-D: no click was attempted yet, so nothing can be in flight.
          if (correlationAttemptId) tiles.disarmNativeFlowCorrelation(correlationAttemptId, { dispatchOutcome: "none" });
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
          // M-D: the button never received the click, so nothing can be
          // in flight and the identical retry must not be retired.
          if (correlationAttemptId) tiles.disarmNativeFlowCorrelation(correlationAttemptId, { dispatchOutcome: "none" });
          throw this.error(
            "FLOW_SUBMIT_CLICK_NOT_DELIVERED",
            "Flow did not receive a submit click; the button changed state before activation completed.",
            false,
            false
          );
        }

        const submitDeadline = Math.min(Date.now() + 30000, flowDeadline);
        // DOM acceptance downgrade (TobyFlow semantics): when Flow's own
        // submit control accepted the click — activateFlowSubmitButton saw
        // it disable — the submit counts as acknowledged after a short
        // grace window even if the correlation observer never matches a
        // request payload. A payload layout the observer cannot decode yet
        // (e.g. a new video model's reference rows) must not kill a submit
        // Flow itself accepted. The 5 s grace stays well under the 30 s
        // dispatch budget, so a genuinely correlated request still wins
        // whenever it is observable, and this exit deliberately does NOT
        // disarm the correlation attempt: the observe phase keeps reading
        // the live entry, so a late requestSeen is still recorded and
        // ownership tracking continues exactly as on the requestSeen path.
        const domAcceptanceDeadline = activation.controlAccepted === true
          ? Math.min(Date.now() + 5_000, submitDeadline)
          : null;
        // Live DOM acceptance (audit cluster B): the activation-time
        // acceptance observer disconnects ~180 ms after activation, so a
        // submit control Flow disables LATER (async Angular handling) is
        // invisible to the snapshot above. The loop below re-checks three
        // live signals every iteration, using only flow-editor's own
        // finders — no new selector is invented here: the current submit
        // button is disabled, the editor that held text at submit time is
        // now empty, or a tile appeared that was not in the `before`
        // snapshot. Any signal first resolves exactly like the snapshot
        // grace exit: the correlation attempt is NOT disarmed, so a late
        // requestSeen is still recorded. The editor-empty signal is only
        // armed when the editor held text at submit time, so a blank
        // prompt never "accepts" itself.
        const submitEditorElement = typeof editor.getVisibleFlowPromptEditor === 'function'
          ? editor.getVisibleFlowPromptEditor()
          : (typeof root.getVisibleFlowPromptEditor === 'function' ? root.getVisibleFlowPromptEditor() : null);
        // Videofix M-F: Flow may re-render the composer mid-wait, which
        // detaches the submit-time element while it still holds the old
        // prompt text. Reading that stale element forever would miss the
        // acceptance and time out. Resolve the live editor on every read
        // instead: the module's own current-editor finder keeps the
        // submit-time element while it is still connected and falls back
        // to the live visible editor once it detaches; a detached element
        // is never read at all.
        const resolveLiveEditor = () => {
          try {
            if (typeof editor.currentFlowPromptEditor === 'function') {
              const current = editor.currentFlowPromptEditor(submitEditorElement);
              if (current) return current;
            }
          } catch (_) { /* fall through to the plain finder */ }
          return typeof editor.getVisibleFlowPromptEditor === 'function'
            ? editor.getVisibleFlowPromptEditor()
            : (typeof root.getVisibleFlowPromptEditor === 'function' ? root.getVisibleFlowPromptEditor() : null);
        };
        const readEditorText = (element) => {
          const target = element === undefined ? resolveLiveEditor() : element;
          if (!target || target.isConnected === false) return null;
          if (typeof editor.getEditorUserText === 'function') return String(editor.getEditorUserText(target) || '');
          if (typeof root.getEditorUserText === 'function') return String(root.getEditorUserText(target) || '');
          return null;
        };
        const editorTextAtSubmit = readEditorText(submitEditorElement);
        const editorHadTextAtSubmit = editorTextAtSubmit !== null && editorTextAtSubmit.trim() !== '';
        const liveTileBaseline = before.slice();
        const liveDomAccepted = () => {
          try {
            const liveButton = typeof editor.getFlowSubmitButton === 'function'
              ? editor.getFlowSubmitButton()
              : (typeof root.getFlowSubmitButton === 'function' ? root.getFlowSubmitButton() : null);
            if (liveButton && (liveButton.disabled || liveButton.getAttribute?.('aria-disabled') === 'true')) return true;
          } catch (_) { /* a transient finder failure is not acceptance */ }
          try {
            const currentText = readEditorText();
            if (editorHadTextAtSubmit && currentText !== null && currentText.trim() === '') return true;
          } catch (_) { /* a transient read failure is not acceptance */ }
          try {
            const liveTiles = tiles.collectNativeMedia?.() || [];
            const seen = new Set(liveTileBaseline);
            if (liveTiles.some((item) => !seen.has(tiles.tileSnapshotKey?.(item) || item.id || `title:${item.title}`))) return true;
          } catch (_) { /* a transient scan failure is not acceptance */ }
          return false;
        };
        // Videofix M-E, design decision (fail-as-designed, not observe):
        // a no-signal dispatch timeout has ZERO positive evidence — no
        // request (even weak), no Flow error, no button disable, no
        // editor-empty, no new tile. Moving such a job into observe would
        // break the invariant every other acceptance path keeps (a
        // positive signal is required: requestSeen, DOM acceptance, or
        // the M-G domAccepted fallback) and could claim another job's
        // tile after burning the full observe budget on a submit Flow
        // most likely dropped. So the timeout stays a failure with
        // outcome_unknown=true — which is what blocks queue retry and
        // auto-retry for this record, correctly, while a possibly-late
        // Flow dispatch is still possible. The recovery is therefore
        // spelled out in the error itself: inspect Flow first, and only
        // recreate the job (a fresh submit in the same tab arms cleanly
        // since M-D removed the retired-conflict lock) when nothing
        // appeared. There is no "dispatched, ambiguous" state in code
        // and no comment below may claim one.
        const dispatchTimeoutGuidance = " The outcome is unknown: Flow may still dispatch this submit late. Check the Flow project first — if a tile for this prompt appears there, Flow did dispatch it and this job cannot be retried from the queue. Only if nothing appears, create the job again; a fresh submit in the same tab is not blocked.";
        let acknowledged = false;
        let domAccepted = false;
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
            // M-D: Flow displayed an error, so the submit was rejected
            // and nothing is in flight; the retry must not be retired.
            tiles.disarmNativeFlowCorrelation(correlationAttemptId, { dispatchOutcome: "rejected" });
            const classified = root.classifyFlowError?.(newError);
            if (classified) throw await unknownSubmitError(classified.code, classified.message, classified.retryable);
            throw await unknownSubmitError("FLOW_SUBMIT_REJECTED", `Flow displayed an error before a correlated generation request was observed: ${newError}. Inspect Flow before retrying.`);
          }

          // Live DOM acceptance: re-checked every iteration, AFTER the
          // error check above so a Flow rejection still wins over a
          // disabled button. Resolves exactly like the snapshot grace
          // exit and likewise does NOT disarm the correlation attempt.
          if (liveDomAccepted()) {
            acknowledged = true;
            domAccepted = true;
            break;
          }

          if (domAcceptanceDeadline !== null && Date.now() >= domAcceptanceDeadline) {
            acknowledged = true;
            domAccepted = true;
            break;
          }

          const progress = "Waiting for Flow to dispatch the generation request";
          if (progress !== lastSubmitProgress) {
            tiles.emitFlowProgress(command, progress);
            lastSubmitProgress = progress;
          }
          try {
            if (root.FlowUiDeadline?.boundedWait) await root.FlowUiDeadline.boundedWait(250, submitDeadline, "waiting for Flow request dispatch", true, command.signal);
            else await root.wait?.(250);
          } catch (error) {
            // The boundedWait timeout is the live "Timed out while waiting
            // for Flow request dispatch" failure: the click was delivered
            // but no generation request was ever observed. Convert it
            // through unknownSubmitError so it carries the same observer
            // diagnostics as every sibling submit exit instead of dying
            // unexplained; code, message and retryable are preserved.
            if (error?.code !== "FLOW_OPERATION_TIMEOUT") throw error;
            // M-D: at this point the iteration already checked requestSeen
            // (false), a new Flow error (none) and live DOM acceptance
            // (false) — the click produced zero signal, so nothing is
            // known to be in flight and the retry must not be retired.
            // Exposure accepted deliberately: a request that arrives late
            // after this timeout is attributed to the retry attempt, the
            // same exposure a reload-and-retry has today.
            tiles.disarmNativeFlowCorrelation(correlationAttemptId, { dispatchOutcome: "none" });
            throw await unknownSubmitError(error.code, (error.message || "Timed out while waiting for Flow request dispatch.") + dispatchTimeoutGuidance, error.retryable === true);
          }
        }

        if (!acknowledged) {
          const latestEntry = tiles.nativeFlowCorrelationMap().get(correlationAttemptId);
          if (latestEntry?.requestSeen) acknowledged = true;
          else {
            // M-D: check the rejection first so the disarm can carry the
            // observed outcome (rejected vs no-signal) instead of the
            // legacy ambiguous disarm. Throw behavior below is unchanged.
            const newError = editor.currentFlowSubmitErrors().find(msg => !errorsBeforeSubmit.has(msg));
            tiles.disarmNativeFlowCorrelation(correlationAttemptId, { dispatchOutcome: newError ? "rejected" : "none" });
            if (newError) {
              const classified = root.classifyFlowError?.(newError);
              if (classified) throw await unknownSubmitError(classified.code, classified.message, classified.retryable);
              throw await unknownSubmitError("FLOW_SUBMIT_REJECTED", `Flow displayed an error before a correlated generation request was observed: ${newError}. Inspect Flow before retrying.`);
            }
            throw await unknownSubmitError("FLOW_SUBMIT_UNCONFIRMED", `Flow did not emit a correlated generation request within the submit budget (click delivered: ${Boolean(activation.clickDelivered)}).` + dispatchTimeoutGuidance);
          }
        }

        // VID-02: stamp the dispatch moment once, at submit acknowledgement.
        // The observation checkpoint persists this stamp so a resumed
        // observe computes its render deadline from here instead of
        // restarting the clock after a service-worker restart.
        const dispatchedAt = Date.now();
        // VID-06: serverAcceptanceObserved reflects THIS attempt's own
        // correlation receipts at acknowledgement time — true only when an
        // accepted/result stage (response_seen/result_seen) was recorded
        // for the attempt; request_seen alone means the request merely
        // left the browser. Read it before the submit-only release below
        // deletes the entry. A missing entry or helper keeps the
        // historical false, and the flag never affects the submit verdict.
        const serverAcceptanceObserved = tiles.nativeFlowCorrelationAcceptanceObserved?.(correlationAttemptId) === true;
        const dispatchReceipt = payload.submitOnly === true
          ? tiles.releaseSubmitOnlyCorrelation?.(correlationAttemptId, acknowledged) || null
          : null;
        await tiles.emitFlowProgress(command, "Flow accepted the generation request; saved a recovery checkpoint.", {
          generationObservation: {
            before,
            kind: payload.type === "image" ? "image" : "video",
            expectedCount: variants,
            correlationAttemptId,
            dispatchedAt,
            credits: Number.isFinite(credits) ? credits : null,
            timeoutMs: payload.type === "video" ? 600_000 : 300_000,
            submitOnly: payload.submitOnly === true || payload.submit_only === true,
            // M-G: carry the DOM-accept flag through the checkpoint so a
            // service-worker restart resumes observe with the fallback.
            ...(domAccepted ? { domAccepted: true } : {}),
          },
        });
        return {
          submitted: true,
          before,
          type: payload.type === "image" ? "image" : "video",
          expectedCount: variants,
          credits: Number.isFinite(credits) ? credits : null,
          correlationAttemptId,
          dispatchedAt,
          activation: activation.strategy || "dom-click",
          requestDispatched: acknowledged,
          ...(domAccepted ? { confirmationSignal: "dom_acceptance", matchKind: "dom_acceptance" } : {}),
          serverAcceptanceObserved,
          ...(dispatchReceipt ? { correlationReceipt: dispatchReceipt } : {}),
        };
      }

      if (name === "flow.generation.observe") {
        const before = Array.isArray(payload.before) ? payload.before : [];
        const kind = payload.kind === "image" ? "image" : payload.kind === "video" ? "video" : undefined;
        const expected = Math.max(1, Math.min(20, Number(payload.expectedCount || payload.variants || 1)));
        const timeoutMs = Math.max(1000, Math.min(15 * 60000, Number(payload.timeoutMs || 12 * 60000)));
        // VID-08: virtualization recovery sweep tuning. If neither fresh
        // media nor receipt progress is seen for the quiet window, observe
        // runs a bounded number of full-library scans (the media-menu scan
        // machinery) filtered by the correlated id set, recovering results
        // whose tiles Flow virtualized out of the grid instead of idling
        // to the deadline. The sweep lives entirely inside the render
        // deadline — it never extends it.
        const OBSERVE_RECOVERY_SWEEP_QUIET_MS = 30_000;
        const OBSERVE_RECOVERY_SWEEP_MAX = 3;
        const OBSERVE_RECOVERY_SWEEP_SCAN_MS = 25_000;
        // VID-04: maintain a structured evidence bundle for the whole
        // observation so every terminal observe error can carry it as
        // `diagnostics` — live triage must be able to distinguish "Flow
        // never started" (requestSeen false, zeroed tallies) from
        // "rendered but unmatched" (request seen, correlated ids known,
        // tiles still busy at the deadline). The counters are refreshed
        // from each poll below and the snapshot is taken at throw time,
        // so the bundle always reflects the final observed state.
        // Diagnostics are additive metadata only: verdicts, deadlines
        // (VID-02) and retry classification are unchanged, and success /
        // VID-01 partial resolutions never gain the bundle.
        const evidenceStartedAt = Date.now();
        const evidence = {
          requestSeen: false,
          lastReceiptStage: null,
          correlatedMediaIds: [],
          readyCount: 0,
          busyCount: 0,
          failedCount: 0,
          recoverySweeps: 0,
        };
        const observeError = (code, message, retryable, outcomeUnknown) => {
          const error = this.error(code, message, retryable, outcomeUnknown);
          error.diagnostics = {
            requestSeen: evidence.requestSeen,
            lastReceiptStage: evidence.lastReceiptStage,
            correlatedMediaIds: [...evidence.correlatedMediaIds],
            readyCount: evidence.readyCount,
            busyCount: evidence.busyCount,
            failedCount: evidence.failedCount,
            recoverySweeps: evidence.recoverySweeps,
            elapsedMs: Math.max(0, Date.now() - evidenceStartedAt),
          };
          return error;
        };
        // VID-02: anchor the render deadline at dispatch when the caller
        // carries the submit-acknowledgement stamp (persisted in the
        // observation checkpoint): a service-worker restart resumes with the
        // remaining budget instead of a fresh full window, and a window that
        // already expired while the worker was down times out immediately
        // via the loop exit below. Legacy payloads without a valid stamp
        // keep the historical behavior — a fresh window from observe entry.
        const dispatchedAt = Number(payload.dispatchedAt);
        const deadline = Number.isFinite(dispatchedAt) && dispatchedAt > 0
          ? dispatchedAt + timeoutMs
          : Date.now() + timeoutMs;
        const correlationAttemptId = String(payload.correlationAttemptId || "");
        const correlationEntry = correlationAttemptId ? tiles.nativeFlowCorrelationMap().get(correlationAttemptId) : null;
        if (!correlationEntry) {
          throw observeError(
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
        // VID-08 sweep state: when a poll last showed progress (the
        // receipt stage / correlated set moved, or the fresh media set's
        // observable state changed), how many recovery sweeps have run
        // (mirrored into the VID-04 evidence bundle), and the library
        // records recovered by those sweeps, keyed by lowercased media id.
        let lastProgressAt = observeStartedAt;
        let lastProgressSignature = null;
        const recoveredById = new Map();
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
        // Snapshot the page errors that already exist when observation
        // starts. A lingering toast from a previous job or an unrelated
        // alert predates this generation and is not evidence about it;
        // mirror the submit path (errorsBeforeSubmit) and only react to
        // errors that appear after this snapshot.
        const errorsBeforeObserve = new Set(editor.currentFlowSubmitErrors());

        try {
          while (Date.now() < deadline) {
            if (command.signal?.aborted) throw observeError("FLOW_OPERATION_CANCELLED", "The Flow queue stopped while waiting for generation results. The generation was already submitted; inspect Flow before retrying.", false, true);
            if (correlationEntry?.interfered) {
              throw observeError("FLOW_GENERATION_INTERFERENCE", "A trusted interaction changed the Flow composer before this generation request was observed. The result cannot be safely attributed; inspect the project before retrying.", false, true);
            }

            const quotaAlert = root.checkFlowCreditLimitAlert?.();
            if (quotaAlert) {
              console.warn(`[FlowObserve] Quota alert observed: "${quotaAlert}".`);
            }

            const receipt = correlationEntry ? tiles.nativeFlowCorrelationReceipt(correlationAttemptId) : null;
            // VID-04: refresh the request evidence from this poll before
            // any terminal branch below can throw, so receipt-stage errors
            // carry the same bundle as the timeout path. The stage prefers
            // this poll's terminal receipt, then the API result receipt,
            // then the correlation entry's latest recorded stage.
            if (correlationEntry?.requestSeen || receipt) evidence.requestSeen = true;
            const pollStage = typeof receipt?.stage === "string" && receipt.stage
              ? receipt.stage
              : typeof apiResultReceipt?.stage === "string" && apiResultReceipt.stage
                ? apiResultReceipt.stage
                : null;
            if (pollStage) evidence.lastReceiptStage = pollStage;
            else if (Array.isArray(correlationEntry?.receipts) && correlationEntry.receipts.length) {
              const entryStage = correlationEntry.receipts[correlationEntry.receipts.length - 1]?.stage;
              if (typeof entryStage === "string" && entryStage) evidence.lastReceiptStage = entryStage;
            }
            if (evidence.requestSeen && !evidence.lastReceiptStage) evidence.lastReceiptStage = "request_seen";
            if (receipt?.error) {
              const classified = root.classifyFlowError?.(receipt.error);
              if (classified) throw observeError(classified.code, classified.message, classified.retryable, false);
              throw observeError("FLOW_GENERATION_FAILED", `Flow báo cáo lỗi tạo: ${receipt.error}`, false, false);
            }
            const failedChild = receipt?.children?.find(c => c?.status === "failed" || c?.error);
            if (failedChild) {
              const errText = failedChild.error || failedChild.statusReason || "Generation failed";
              const classified = root.classifyFlowError?.(errText);
              if (classified) throw observeError(classified.code, classified.message, classified.retryable, false);
              throw observeError("FLOW_GENERATION_FAILED", `Flow báo cáo lỗi: ${errText}`, false, false);
            }

            const receiptMediaIds = [
              ...(receipt?.mediaIds || []),
              ...(receipt?.children || []).map(child => child?.mediaId),
            ].filter(id => typeof id === "string" && id.trim());
            if (apiResultReceipt && receiptMediaIds.length === 0) {
              throw observeError(
                "FLOW_GENERATION_MEDIA_ID_MISSING",
                "Flow completed this generation response without exposing a task-owned media ID. The extension did not guess from the gallery or download a file; inspect the Flow result manually.",
                false,
                true
              );
            }

            const correlatedIds = new Set(receiptMediaIds.map(id => id.toLowerCase()));
            // VID-04: the correlated id set is part of the evidence
            // bundle — record it before the ambiguity guard can throw.
            evidence.correlatedMediaIds = [...correlatedIds];
            if (correlatedIds.size > expected) {
              throw observeError(
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
            let fresh = allMedia.filter(item =>
              !before.includes(tiles.tileSnapshotKey?.(item) || item.id || `title:${item.title}`) &&
              !item.title.startsWith("fm-") &&
              (!kind || item.kind === kind || (kind === "video" && item.kind === "scene") || item.failed) &&
              item.id && correlatedIds.has(item.id.toLowerCase())
            );
            // VID-08: fold media recovered by earlier recovery sweeps into
            // this poll's fresh set, so recovered results resolve through
            // exactly the same success / VID-01 partial paths below as
            // grid-observed media. A settled library record (ready or
            // failed) replaces an unsettled grid entry for the same
            // correlated id (a stale ghost tile); a grid entry that is
            // itself settled is live DOM truth and always wins.
            if (recoveredById.size) {
              for (const recovered of recoveredById.values()) {
                const index = fresh.findIndex(item => item.id?.toLowerCase() === recovered.id.toLowerCase());
                if (index === -1) { fresh.push(recovered); continue; }
                const current = fresh[index];
                if (!(current.mediaReady || current.failed) && (recovered.mediaReady || recovered.failed)) fresh[index] = recovered;
              }
            }
            // M-G: DOM-accepted fallback candidates. When the submit was
            // accepted by Flow's own controls but the observer never
            // correlated a request, the correlated set is empty forever
            // and the loop below would wait out the full deadline despite
            // a rendered tile. Only when NO correlation exists at all
            // (empty set, no request ever seen) may new, ready,
            // kind-matched tiles outside `before` stand in — and only
            // when their count is EXACTLY the expected count, so an extra
            // stray tile keeps the loop waiting instead of misattributing
            // a result. The verdict itself is rendered below, next to the
            // normal ready path, under the same isEarly guard.
            const domFallbackActive = payload.domAccepted === true && correlatedIds.size === 0 && !evidence.requestSeen;
            const domFallbackCandidates = domFallbackActive ? allMedia.filter(item =>
              !before.includes(tiles.tileSnapshotKey?.(item) || item.id || `title:${item.title}`) &&
              !item.title.startsWith("fm-") &&
              (!kind || item.kind === kind || (kind === "video" && item.kind === "scene") || item.failed) &&
              item.id
            ) : [];
            const domFallbackReady = domFallbackCandidates.filter(item => item.mediaReady && !item.busy && !item.failed);
            const domFallbackSettled = domFallbackCandidates.filter(item => (item.mediaReady && !item.busy) || item.failed);
            // VID-08: progress, for quiet-window purposes, is the receipt
            // stage or correlated id set moving, or the fresh set's
            // observable state changing (including a busy tile's render
            // percentage advancing). Anything else is quiet time.
            const progressSignature = [
              evidence.lastReceiptStage || "",
              [...correlatedIds].join(","),
              fresh.map(item => `${item.id}|${item.busy ? 1 : 0}|${item.mediaReady ? 1 : 0}|${item.failed ? 1 : 0}|${item.progress || ""}`).join(";"),
            ].join("#");
            if (progressSignature !== lastProgressSignature) {
              lastProgressSignature = progressSignature;
              lastProgressAt = Date.now();
            }

            const failed = fresh.filter(item => item.failed);
            // VID-04: refresh the ready/busy/failed tallies from this
            // poll's fresh set, so any terminal throw below (and the
            // timeout thrown after the loop) reports the final observed
            // state rather than a stale snapshot.
            evidence.readyCount = fresh.filter(item => item.mediaReady && !item.busy && !item.failed).length;
            evidence.busyCount = fresh.filter(item => item.busy && !item.failed).length;
            evidence.failedCount = failed.length;
            if (failed.length) {
              const failureDetails = failed[0]?.failureReason || "";
              const classified = root.classifyFlowError?.(failureDetails);
              if (classified?.category === "rate_limit") {
                throw observeError(classified.code, classified.message, true, false);
              }
              // VID-01: a terminally failed tile must not discard outputs
              // that already rendered. The failed set is judged only once
              // no sibling is still processing — a busy output is not a
              // failure, and while one remains the loop keeps waiting
              // (deadline semantics unchanged) so the sibling can still
              // join the ready set or the failed set. When the set has
              // settled with at least one ready output, resolve with the
              // ready media plus a structured failedOutputs list; the
              // queue records a partial state instead of failing the job.
              const readySettled = [...correlatedIds]
                .map(id => fresh.find(item => item.id?.toLowerCase() === id && item.mediaReady && !item.busy && !item.failed))
                .filter(Boolean);
              const stillProcessing = fresh.some(item => item.busy && !item.failed);
              const partialResult = async () => {
                const media = readySettled.map(({ id, title, kind: mediaKind }) => ({
                  id,
                  title,
                  // Same scene→video normalization as the full-success path.
                  kind: mediaKind === "scene" ? "video" : mediaKind,
                }));
                const failedOutputs = failed.map(item => ({
                  title: item.title,
                  code: root.classifyFlowError?.(item.failureReason || "")?.code || "FLOW_GENERATION_FAILED",
                }));
                await tiles.emitFlowProgress(command, `Tạo ${kind === "video" ? "video" : "ảnh"} hoàn tất một phần: ${media.length}/${expected} kết quả, ${failedOutputs.length} tile lỗi`, {
                  generationResult: { media },
                });
                return { media, failedOutputs, partial: true };
              };
              if (classified && !classified.retryable) {
                // A classified non-retryable failure is terminal (never
                // retried in place). With a ready sibling and nothing
                // still processing, resolve partially; with no ready
                // output the classified throw is unchanged.
                if (!stillProcessing) {
                  if (readySettled.length >= 1) return await partialResult();
                  throw observeError(classified.code, classified.message, false, false);
                }
              } else {
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
                if (!stillProcessing) {
                  if (readySettled.length >= 1) return await partialResult();
                  const details = failed.map(item => `${item.title}${item.failureReason ? `: ${item.failureReason}` : ""}`).join("; ");
                  throw observeError("FLOW_GENERATION_FAILED", `Flow báo cáo ${failed.length} tile render thất bại: ${details}. Chưa bị trừ tín dụng cho render lỗi này.`, false, false);
                }
              }
            }

            if (Date.now() - observeStartedAt > 5000 && fresh.length === 0 && !renderObservedInFlight) {
              const composerBox = root.getVisibleFlowPromptEditor?.() || (typeof root.flowQuery === "function" ? root.flowQuery("editor") : null);
              const submitBtn = editor.getFlowSubmitButton() || root.flowButton?.("Start generation");
              const hasText = composerBox && Boolean(editor.getEditorUserText(composerBox));
              const buttonReady = submitBtn && !submitBtn.disabled && submitBtn.getAttribute("aria-disabled") !== "true";
              if (hasText && buttonReady) {
                throw observeError("FLOW_SUBMIT_REJECTED", "Flow không tiếp nhận yêu cầu tạo ảnh/video (câu lệnh vẫn còn trong ô nhập và nút Tạo đã mở lại). Vui lòng kiểm tra lại câu lệnh hoặc hạn mức tài khoản.", false, false);
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

            // M-G fallback verdict: an exact-count ready set is accepted
            // as this job's media (marked, so the queue can tell it apart
            // from a correlated success); an exact-count settled set that
            // is not all ready fails fast with a diagnosis instead of
            // idling to the deadline. Any other count keeps waiting.
            if (domFallbackActive && !isEarly) {
              if (domFallbackReady.length === expected) {
                const media = domFallbackReady.map(({ id, title, kind: mediaKind }) => ({
                  id,
                  title,
                  kind: mediaKind === "scene" ? "video" : mediaKind,
                }));
                await tiles.emitFlowProgress(command, kind === "video" ? "Tạo video hoàn tất 100%" : "Tạo ảnh hoàn tất 100%", {
                  generationResult: { media },
                });
                return { media, domAcceptedFallback: true };
              }
              if (domFallbackSettled.length === expected && domFallbackReady.length < expected) {
                evidence.readyCount = domFallbackReady.length;
                evidence.failedCount = domFallbackCandidates.filter(item => item.failed).length;
                evidence.busyCount = domFallbackCandidates.filter(item => item.busy && !item.failed).length;
                const failedDetails = domFallbackCandidates.filter(item => item.failed).map(item => `${item.title}${item.failureReason ? `: ${item.failureReason}` : ""}`).join("; ");
                throw observeError("FLOW_GENERATION_FAILED", `Flow báo cáo ${domFallbackCandidates.filter(item => item.failed).length} tile render thất bại: ${failedDetails}. Chưa bị trừ tín dụng cho render lỗi này.`, false, false);
              }
            }

            if (!isEarly && ready.length >= expected) {
              const picked = [...correlatedIds].map(id => ready.find(item => item.id?.toLowerCase() === id)).filter(Boolean);
              if (picked.length < expected) {
                await root.wait?.(1000);
                continue;
              }
              const titleOnly = picked.some(item => !item.id || item.id.startsWith("title:"));
              const signature = picked.map(item => tiles.tileSnapshotKey?.(item) || item.id || `title:${item.title}`).join("|");
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

            // Page-level error banners are unscoped evidence: check them
            // only after this task's correlated receipt and media state
            // (above), and only when the error is new since observation
            // began — a pre-existing banner must never fail a generation
            // that already dispatched or already succeeded.
            const newPageError = editor.currentFlowSubmitErrors().find(message => !errorsBeforeObserve.has(message));
            if (newPageError) {
              const classified = root.classifyFlowError?.(newPageError);
              if (classified) throw observeError(classified.code, classified.message, classified.retryable, false);
              throw observeError("FLOW_GENERATION_FAILED", `Flow hiển thị thông báo lỗi: "${newPageError}".`, false, false);
            }

            // VID-08: virtualization recovery sweep. Reaching this point
            // means the poll resolved nothing and threw nothing — observe
            // is still waiting. If a full quiet window passed with no
            // fresh media and no receipt progress, and sweeps remain in
            // the bound, scan the whole library once for this attempt's
            // correlated ids: Flow may have virtualized the claimed tile
            // out of the grid while its result finished elsewhere in the
            // library. Recovered records join the fresh set from the next
            // poll. The scan is clamped to the render deadline, so the
            // sweep can never extend it; a failed scan is a loss of
            // observability, never a generation failure — the normal
            // wait and timeout continue.
            if (typeof menu?.scanNativeAssets === "function"
              && correlatedIds.size > 0
              && evidence.recoverySweeps < OBSERVE_RECOVERY_SWEEP_MAX
              && Date.now() - lastProgressAt >= OBSERVE_RECOVERY_SWEEP_QUIET_MS
              && Date.now() < deadline) {
              evidence.recoverySweeps++;
              // Space any further sweep by another full quiet window.
              lastProgressAt = Date.now();
              try {
                const assets = await menu.scanNativeAssets({
                  includeIncomplete: true,
                  deadline: Math.min(deadline, Date.now() + OBSERVE_RECOVERY_SWEEP_SCAN_MS),
                  maxDurationMs: OBSERVE_RECOVERY_SWEEP_SCAN_MS,
                  signal: command.signal,
                  keepPositionOnMatch: true,
                });
                let recoveredNow = 0;
                for (const asset of Array.isArray(assets) ? assets : []) {
                  const id = typeof asset?.id === "string" ? asset.id : "";
                  // Attribution discipline (VID-03/VID-06): only this
                  // attempt's correlated ids are evidence. Anything else
                  // the scan saw belongs to another task.
                  if (!id || !correlatedIds.has(id.toLowerCase())) continue;
                  const failedAsset = asset.error === true;
                  const assetKind = typeof asset.kind === "string" && asset.kind ? asset.kind : kind;
                  if (kind && !(assetKind === kind || (kind === "video" && assetKind === "scene") || failedAsset)) continue;
                  recoveredById.set(id.toLowerCase(), {
                    id,
                    title: asset.name || asset.displayName || "",
                    kind: assetKind,
                    busy: asset.busy === true,
                    mediaReady: asset.ready === true && asset.busy !== true && !failedAsset,
                    failed: failedAsset,
                    ...(failedAsset ? { failureReason: "Flow generation failed" } : {}),
                    recovered: true,
                  });
                  recoveredNow++;
                }
                if (recoveredNow > 0) {
                  tiles.emitFlowProgress(command, `Đã quét lại toàn bộ thư viện Flow: tìm thấy ${recoveredNow} kết quả thuộc tác vụ này`);
                }
              } catch {
                // The library could not be scanned (grid not mounted,
                // scan deadline, cancellation). Cancellation and the
                // render deadline are re-evaluated at the top of the loop.
              }
            }

            const waitMs = Math.min(apiResultReceipt ? 1_000 : 5_000, Math.max(1, deadline - Date.now()));
            if (apiResultSignal && !apiResultReceipt) {
              await Promise.race([apiResultSignal, root.wait?.(waitMs) || new Promise(resolve => setTimeout(resolve, waitMs))]);
            } else {
              await root.wait?.(waitMs);
            }
          }
          throw observeError("FLOW_GENERATION_TIMEOUT", "Hết thời gian chờ Flow render. Lệnh có thể đã được tiếp nhận; vui lòng kiểm tra giao diện Flow trước khi thử lại.", false, true);
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
