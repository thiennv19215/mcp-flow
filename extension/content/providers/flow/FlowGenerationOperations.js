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
        await components.uploadStagedFlowMedia(file, kind, command);
        return { uploaded: true, name: assetName, kind, trustedGesture: false };
      }

      if (name === "flow.references.attach") {
        const references = payload.references;
        if (!Array.isArray(references) || !references.length || references.length > 3) throw this.error("FLOW_INVALID_ARGUMENT", "Provide one to three named references.");
        const attached = [];
        for (const ref of references) attached.push(await root.FlowReferenceActions.attach(ref));
        return { attached, submitted: false };
      }

      if (name === "flow.generation.submit") {
        await nav.ensureFlowProjectEditor();
        const state = menu.nativeRead("flowState");
        if (!state.signedIn || !state.inProject) throw this.error("FLOW_NOT_READY", state.hint || "Open a signed-in Flow project first.", true);
        await nav.dismissBlockingOverlays();
        const creditAlert = root.checkFlowCreditLimitAlert?.();
        if (creditAlert) throw this.error("FLOW_QUOTA_EXCEEDED", `Flow credit limit reached: "${creditAlert}". Generation aborted.`, false, false);
        await agent.closeNativeAgentSession();
        await nav.ensureFlowLibrarySection("All media");
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
        if (firstFrame === null || lastFrame === null || (!framesMode && attachments.some(item => {
          if (typeof item === "string") return !item.trim();
          if (!item || typeof item !== "object") return true;
          if (typeof item.assetName === "string") return !item.assetName.trim();
          return !root.validStagedLocalImage?.(item, /(?:ref[1-3]|attach[1-3])/);
        }))) throw this.error("NATIVE_CAPABILITY_UNSUPPORTED", "Native generation accepts project asset names or staged local image attachments only; nothing was submitted.", true, false);
        const referenceAttachments = framesMode ? [] : attachments;
        if (root.scrollContainer?.()) root.scrollContainer().scrollTop = 0;
        const before = tiles.collectNativeMedia().map(item => item.id || `title:${item.title}`);
        const activeAgent = root.flowButton?.("Agent");
        if (activeAgent?.getAttribute("aria-pressed") === "true") await agent.setNativeAgentMode(false);
        await (root.clearExistingIngredientChips?.() || components.clearExistingIngredientChips?.());

        const settingsCredits = payload.type === "image"
          ? await root.FlowImageActions.prepare(payload, variants)
          : await root.FlowVideoActions.prepare(payload, variants, framesMode);

        const uploadAndResolve = async (attachment, slot) => {
          if (!root.validStagedLocalImage?.(attachment, /(?:start|end|ref[1-3])/)) throw this.error("FLOW_UPLOAD_UNAVAILABLE", "Flow's staged image transfer is unavailable before file selection.", false, false);
          const file = root.stagedNativeFiles.get(attachment.transferId);
          if (!file) throw this.error("FLOW_TRANSFER_UNKNOWN", "The staged image is no longer available.", true);
          try {
            await components.uploadStagedFlowMedia(file, "image", command);
          } finally {
            if (framesMode && (slot === "start" || slot === "end")) await settings.restoreNativeFramesMode();
          }
          await components.chooseNativePickerAsset(attachment.name, slot);
        };

        const resolveValue = async (value, slot) => {
          if (!value) return;
          if (value.assetName) return components.chooseNativePickerAsset(value.assetName, slot);
          await uploadAndResolve(value, slot);
        };

        if (firstFrame) await resolveValue(firstFrame, "start");
        if (lastFrame) await resolveValue(lastFrame, "end");
        for (const item of referenceAttachments) {
          const attachment = typeof item === "string" ? { assetName: item.replace(/^asset:/i, "").trim() } : item;
          await resolveValue(attachment, undefined);
        }

        const expectedRefs = referenceAttachments.length;
        if (expectedRefs > 0) {
          const isRefChip = el => {
            if (!root.visible?.(el)) return false;
            const lbl = (root.accessibleName?.(el) || el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
            return /(?:Ingredient|Thành phần)/i.test(lbl) || /Xóa thành phần|Remove ingredient/i.test(lbl);
          };
          let attachedCount = 0;
          const countDeadline = Date.now() + 2500;
          while (Date.now() < countDeadline) {
            attachedCount = [...document.querySelectorAll("button,[role=button],[role=listitem],mat-chip,[data-chip]")].filter(isRefChip).length;
            if (attachedCount >= expectedRefs) break;
            await root.wait?.(250);
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

        const activeBox = await editor.preflightGenerationPrompt(payload, framesMode);
        const promptApplied = await editor.insertNativeFlowPrompt(activeBox, payload.prompt);
        if (!promptApplied) throw this.error("FLOW_PROMPT_INPUT_UNCONFIRMED", "Flow's composer did not confirm the full prompt text. Nothing was submitted.", true, false);

        const renderedCredits = await editor.waitForGenerationCreditQuote(Number.isFinite(settingsCredits) ? 1500 : 3000);
        const credits = Number.isFinite(renderedCredits) ? renderedCredits : (Number.isFinite(settingsCredits) ? settingsCredits : 0);
        if (payload.maxCredits !== undefined && credits > Number(payload.maxCredits)) throw this.error("FLOW_MAX_CREDITS_EXCEEDED", `Flow quotes ${credits} credits, above max_credits=${payload.maxCredits}. Nothing was submitted.`, false, false);

        const start = await editor.waitForGenerationSubmitButton(payload.prompt, 10000);
        if (!start) throw this.error("FLOW_SUBMIT_DISABLED", "Flow's Start generation button did not become ready within 10 seconds; nothing was submitted.", true);

        const errorsBeforeSubmit = new Set(editor.currentFlowSubmitErrors());
        const projectId = (root.ProviderRegistry || root.FlowDriverRegistry).describeUrl(location.href)?.projectId;
        const correlationAttemptId = !framesMode && referenceAttachments.length === 0
          ? await tiles.armNativeFlowCorrelation({ projectId, mediaType: payload.type === "image" ? "image" : "video", prompt: payload.prompt, expectedQuantity: variants })
          : null;

        let activation;
        try {
          activation = await editor.activateFlowSubmitButton(start, payload.prompt);
        } catch (error) {
          if (correlationAttemptId) tiles.disarmNativeFlowCorrelation(correlationAttemptId);
          throw error;
        }

        const submitDeadline = Date.now() + 30000;
        const submitStartedAt = Date.now();
        let acknowledged = false;
        let fallbackDispatched = false;
        let lastSubmitProgress = "";

        while (Date.now() < submitDeadline) {
          const newError = editor.currentFlowSubmitErrors().find(msg => !errorsBeforeSubmit.has(msg));
          if (newError) {
            if (correlationAttemptId) tiles.disarmNativeFlowCorrelation(correlationAttemptId);
            const classified = root.classifyFlowError?.(newError);
            if (classified) throw this.error(classified.code, classified.message, classified.retryable, false);
            throw this.error("FLOW_SUBMIT_REJECTED", `Flow rejected the submit: ${newError}`, false, false);
          }
          const correlationEntry = correlationAttemptId && tiles.nativeFlowCorrelationMap().get(correlationAttemptId);
          if (correlationEntry?.interfered) {
            tiles.disarmNativeFlowCorrelation(correlationAttemptId);
            throw this.error("FLOW_SUBMIT_INTERFERENCE", "A trusted interaction changed the Flow composer before the generation request was observed. The submit outcome is unknown; inspect Flow before retrying.", false, true);
          }
          const currentStart = editor.getFlowSubmitButton(payload.prompt) || root.flowButton?.("Start generation");
          const currentBox = document.querySelector(".ProseMirror");
          const freshMedia = tiles.collectNativeMedia().filter(item => !before.includes(item.id || `title:${item.title}`));

          const buttonDisabled = !currentStart || currentStart.disabled || currentStart.getAttribute("aria-disabled") === "true";
          const editorCleared = currentBox && !editor.getEditorUserText(currentBox);
          const tileAppeared = freshMedia.length > 0;

          if (buttonDisabled || editorCleared || tileAppeared) {
            acknowledged = true;
            break;
          }

          if (
            activation.allowEnterFallback &&
            !fallbackDispatched &&
            Date.now() - submitStartedAt >= 1200 &&
            currentBox &&
            editor.normalizeFlowPrompt(editor.getEditorUserText(currentBox)) === editor.normalizeFlowPrompt(payload.prompt) &&
            currentStart &&
            !currentStart.disabled &&
            currentStart.getAttribute("aria-disabled") !== "true"
          ) {
            try {
              editor.inspectFlowSubmitTarget(currentStart, payload.prompt);
              fallbackDispatched = true;
              editor.pressFlowEditorSubmit(currentBox);
            } catch {
              fallbackDispatched = true;
            }
          }

          const progress = freshMedia.some(item => item.busy) ? "Flow accepted the submit and is rendering" : "Waiting for Flow to accept the submit";
          if (progress !== lastSubmitProgress) {
            tiles.emitFlowProgress(command, progress);
            lastSubmitProgress = progress;
          }
          await root.wait?.(250);
        }

        if (!acknowledged && !activation.controlAccepted) {
          if (correlationAttemptId) tiles.disarmNativeFlowCorrelation(correlationAttemptId);
          const newError = editor.currentFlowSubmitErrors().find(msg => !errorsBeforeSubmit.has(msg));
          if (newError) {
            const classified = root.classifyFlowError?.(newError);
            if (classified) throw this.error(classified.code, classified.message, classified.retryable, false);
            throw this.error("FLOW_SUBMIT_REJECTED", `Flow rejected the submit: ${newError}`, false, false);
          }
          throw this.error("FLOW_SUBMIT_UNCONFIRMED", `Flow did not confirm the trusted submit within 30 seconds (click delivered: ${Boolean(activation.clickDelivered)}). No render wait or download was started.`, false, true);
        }

        return {
          submitted: true,
          before,
          type: payload.type === "image" ? "image" : "video",
          expectedCount: variants,
          credits,
          correlationAttemptId,
          activation: activation.strategy || "dom-click",
          acceptanceObserved: acknowledged || Boolean(activation.controlAccepted),
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
            if (correlationEntry && !correlationEntry.requestSeen && Date.now() - correlationEntry.armedAt >= 30000) {
              correlationEntry.useTilesFallback = true;
            }
            const strictCorrelation = correlationEntry && !correlationEntry.useTilesFallback;
            const receipt = correlationEntry ? tiles.nativeFlowCorrelationReceipt(correlationAttemptId) : null;
            const correlatedIds = new Set([
              ...(receipt?.mediaIds || []),
              ...(receipt?.children || []).flatMap(c => [c?.mediaId, c?.operationId]),
            ].filter(id => typeof id === "string").map(id => id.toLowerCase()));

            const allMedia = tiles.collectNativeMedia();
            const fresh = allMedia.filter(item =>
              !before.includes(item.id || `title:${item.title}`) &&
              !item.title.startsWith("fm-") &&
              (!kind || item.kind === kind) &&
              (!strictCorrelation || (item.id && correlatedIds.has(item.id.toLowerCase())))
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
