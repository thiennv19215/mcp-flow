(function (root) {
  "use strict";

  class FlowDriver extends (root.BaseProviderDriver || root.FlowPageDriver) {
    constructor(context = {}) {
      super({
        ...context,
        context,
        key: "flow",
        origin: (root.ProviderRegistry || root.FlowDriverRegistry).ORIGINS.flow,
        operations: (root.BaseProviderDriver || root.FlowPageDriver).OPERATIONS,
      });
    }

    async invoke(operation, payload = {}, command = {}) {
      if (operation === "flow.context") {
        const registry = root.ProviderRegistry || root.FlowDriverRegistry;
        const live = registry.describeUrl(location.href);
        if (live && !live.isProjectEditor && live.projectId) {
          await (root.FlowNavigation?.ensureFlowProjectEditor?.() || root.ensureFlowProjectEditor?.());
          const refreshed = registry.describeUrl(location.href);
          if (refreshed) this.context = Object.freeze({ ...refreshed });
        }
        const mismatch = this.targetMismatch(command?._flowTarget || command?.flowTarget || command?._target || command?.target);
        if (mismatch) return Promise.reject(this.error(mismatch.error, mismatch.message, false, false, mismatch.details));
        return Promise.resolve({ success: true, ...this.context });
      }

      return this.executeOperation(operation, payload, command);
    }

    async executeOperation(name, payload = {}, command = {}) {
      const nav = root.FlowNavigation;
      const editor = root.FlowEditor;
      const settings = root.FlowSettings;
      const components = root.FlowComponents;
      const tiles = root.FlowTiles;
      const menu = root.FlowMediaMenu;
      const agent = root.FlowAgent;

      if (name === "flow.projects.list") {
        if (/\/project\/[0-9a-f-]{36}(?:\/|$)/i.test(location.pathname)) {
          throw this.error("FLOW_HOMEPAGE_REQUIRED", "Project discovery needs the Flow home page. The connector should open a temporary home tab.", true);
        }
        return menu.scanNativeProjects();
      }

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

      if (name === "flow.asset.download") {
        const prefix = String(payload.name || "").toLowerCase();
        if (!prefix && !payload.id) throw this.error("FLOW_INVALID_ARGUMENT", "Asset name or media id is required.");
        if (payload.id) return menu.triggerFlowDownload(String(payload.name || ""), payload.quality, String(payload.id));
        const assets = await menu.scanNativeAssets();
        const candidates = assets.filter(a => a.name.toLowerCase().startsWith(prefix));
        const matches = [];
        for (const a of candidates) {
          const count = await tiles.countFlowTitleAcrossGrid(a.name);
          for (let i = 0; i < count; i++) matches.push(a);
          if (matches.length > 1) break;
        }
        if (!matches.length) throw this.error("FLOW_ASSET_NOT_FOUND", `No asset title begins with "${payload.name}".`, true);
        if (matches.length > 1) throw this.error("FLOW_AMBIGUOUS_ASSET", `${matches.length} assets begin with "${payload.name}"; no download was started.`, true);
        return menu.triggerFlowDownload(matches[0].name, payload.quality);
      }

      if (name === "flow.character.create") return root.FlowCharacterActions.create(payload, command);
      if (name === "flow.character.edit") return root.FlowCharacterActions.edit(payload, command);

      if (name === "flow.edit.run") {
        const params = payload.job?.params || payload.params || {};
        const source = String(params.edit_asset || "").trim();
        if (!source) throw this.error("FLOW_INVALID_ARGUMENT", "Video title is required.");
        await agent.closeNativeAgentSession();
        const activeAgent = root.flowButton?.("Agent");
        if (activeAgent?.getAttribute("aria-pressed") === "true") await agent.setNativeAgentMode(false);
        await nav.ensureFlowLibrarySection("All media");
        const assets = await menu.scanNativeAssets();
        const matches = assets.filter(a => a.kind === "video" && a.name.toLowerCase().startsWith(source.toLowerCase()));
        if (matches.length > 1) throw this.error("FLOW_AMBIGUOUS_ASSET", `${matches.length} videos begin with "${source}"; no edit was started. Use the full title from flow_assets.`, true, false);
        const found = matches[0];
        if (!found) throw this.error("FLOW_VIDEO_NOT_FOUND", `No video beginning "${source}" exists in the project. Use flow_assets to list titles.`, true);
        if (root.scrollContainer?.()) root.scrollContainer().scrollTop = 0;
        const before = tiles.collectNativeMedia().map(item => item.id || `title:${item.title}`);
        const tile = await tiles.findFlowTile(found.name);
        if (!tile || !tile.querySelector("flow-video-tile")) throw this.error("FLOW_VIDEO_NOT_FOUND", `Video "${found.name}" is no longer visible in the project.`, true);
        tile.scrollIntoView({ block: "center" }); tile.click();
        await nav.waitForFlowRoute(path => /\/edit\//i.test(path), 30000, "Flow did not open the video editor.");
        const boxes = [...document.querySelectorAll(".ProseMirror")];
        if (!boxes.length) throw this.error("FLOW_COMPOSER_MISSING", "Flow's edit prompt is not visible.", true);
        const prompt = String(params.prompt || "").replace(/\s*\n+\s*/g, " ").trim();
        if (!root.replaceNativeEditableText?.(boxes[boxes.length - 1], prompt)) throw this.error("FLOW_PROMPT_INPUT_UNCONFIRMED", "Flow did not accept the video edit prompt. Nothing was submitted.", true);
        await root.wait?.(500);
        const start = await editor.waitForGenerationSubmitButton(prompt, 8000);
        if (!start) throw this.error("FLOW_SUBMIT_DISABLED", "Flow's edit action is unavailable; nothing was submitted.", true);
        let submitted = false;
        try {
          await editor.activateFlowSubmitButton(start, prompt);
          submitted = true;
          await tiles.waitForNativeEditorCompletion(command, Number(params.timeout_ms || 10 * 60000), "video edit");
          const back = root.flowButton?.("Back button to go to previous page");
          if (!back) throw this.error("FLOW_EDIT_BACK_MISSING", "Flow finished the video edit, but its Back control is unavailable. The result remains in Flow.", true, true);
          back.click();
          await nav.waitForFlowRoute(path => !/\/edit(?:\/|$)/i.test(path), 20000, "Flow finished the edit but did not return to the project.");
          await nav.ensureFlowLibrarySection("All media");
          if (root.scrollContainer?.()) root.scrollContainer().scrollTop = 0;
          const results = await tiles.waitForProgressResult(command, before, 1, "video", 90000);
          return { media: results, trustedGesture: false };
        } catch (error) {
          if (submitted && error && typeof error === "object") error.outcome_unknown = true;
          throw error;
        }
      }

      if (name === "flow.agent.batch") {
        const params = payload.job?.params || payload.params || {};
        const scenes = params.agent_scenes || [];
        if (!scenes.length) throw this.error("FLOW_INVALID_ARGUMENT", "agent_scenes is required.");
        await agent.closeNativeAgentSession();
        await nav.ensureFlowLibrarySection("All media");
        const before = tiles.collectNativeMedia().map(item => item.id || `title:${item.title}`);
        let submitted = false;
        let outcomeUnknown = false;
        try {
          await agent.setNativeAgentMode(true);
          await agent.setNativeAgentSettings("Never", params.aspect_ratio || "16:9");
          await root.FlowSettings?.chooseNativeModel?.("Nano Banana", "image");
          const box = document.querySelector(".ProseMirror");
          if (!box) throw this.error("FLOW_AGENT_COMPOSER_MISSING", "Flow's Agent composer is not visible.", true);
          const sceneText = scenes.map((scene, index) => `Scene ${index + 1}: ${String(scene).replace(/\s+/g, " ").trim()}`).join("\n");
          const script = `Generate exactly ${scenes.length} separate images: one image for each scene below, in the listed scene order. Do not combine scenes into a collage or a single image. Images only, never video. ${params.aspect_ratio || "16:9"} aspect ratio. Do not ask questions; generate them now.\n${sceneText}`;
          root.setEditable?.(box, script); await root.wait?.(300);
          const start = await editor.waitForGenerationSubmitButton(script, 8000);
          if (!start) throw this.error("FLOW_SUBMIT_DISABLED", "Flow's Agent Start generation button is disabled or is not in the composer containing the prompt; nothing was submitted.", true);
          await editor.activateFlowSubmitButton(start, script);
          submitted = true;
          let media;
          let partialFailure = false;
          let failedMedia = [];
          try {
            media = await tiles.waitForProgressResult(command, before, scenes.length, "image", Number(params.timeout_ms || 1800000), "flow-grid-tile-container", true);
          } catch (error) {
            if (error?.code !== "FLOW_GENERATION_FAILED" || error?.outcome_unknown !== false
              || !Array.isArray(error.partialMedia) || !Array.isArray(error.failedMedia)) throw error;
            media = error.partialMedia;
            failedMedia = error.failedMedia;
            partialFailure = true;
          }
          const prompts = [];
          for (const item of media) {
            const scroller = root.scrollContainer?.();
            if (scroller) scroller.scrollTop = 0;
            await root.wait?.(250);
            let targetTile;
            for (let step = 0; step < 160 && !targetTile; step++) {
              targetTile = [...document.querySelectorAll("flow-grid-tile-container")].find(c =>
                item.id && !item.id.startsWith("title:") ? root.mediaId?.(c) === item.id : c.getAttribute("aria-label") === item.title);
              if (!targetTile && scroller) {
                const top = scroller.scrollTop, max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
                if (top >= max - 2) break;
                scroller.scrollTop = Math.min(max, top + Math.max(200, scroller.clientHeight * 0.78)); await root.wait?.(250);
              }
            }
            if (!targetTile) { prompts.push(""); continue; }
            targetTile.scrollIntoView({ block: "center" }); targetTile.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); await root.wait?.(250);
            const reuse = root.flowButton?.("Reuse prompt", targetTile);
            if (!reuse) { prompts.push(""); continue; }
            reuse.click(); await root.wait?.(550);
            prompts.push(document.querySelector(".ProseMirror")?.innerText || "");
            const close = root.flowButton?.("Close");
            if (close && root.flowButton?.("Start new session")) { close.click(); await root.wait?.(350); }
          }
          const clear = root.flowButton?.("Clear prompt"); if (clear) clear.click();
          return { media, prompts, ...(partialFailure ? { partial: true, failedMedia } : {}), trustedGesture: false };
        } catch (error) {
          outcomeUnknown = Boolean(error?.outcome_unknown) || submitted;
          throw error;
        } finally {
          if (!outcomeUnknown) {
            const session = root.flowButton?.("Start new session");
            if (session) { const close = root.flowButton?.("Close"); if (close) { close.click(); await root.wait?.(500); } }
            try { await agent.setNativeAgentSettings("Always"); } catch {}
            await agent.setNativeAgentMode(false).catch(() => {});
            const clear = root.flowButton?.("Clear prompt"); if (clear) clear.click();
          }
        }
      }

      if (name === "flow.continue.run") {
        const params = payload.job?.params || payload.params || {};
        const sourcePrefix = String(params.continue_from || "").trim();
        if (!sourcePrefix) throw this.error("FLOW_INVALID_ARGUMENT", "Video title is required.");
        const likeness = params.continue_mode === "likeness";
        if (likeness && (!Array.isArray(params.attach) || !params.attach.length)) throw this.error("FLOW_INVALID_ARGUMENT", "Likeness continuation requires at least one character or avatar attachment.", true);
        await agent.closeNativeAgentSession();
        const activeAgent = root.flowButton?.("Agent");
        if (activeAgent?.getAttribute("aria-pressed") === "true") await agent.setNativeAgentMode(false);
        await nav.ensureFlowLibrarySection("All media");
        const assets = await menu.scanNativeAssets();
        const matches = assets.filter(a => a.kind === "video" && a.name.toLowerCase().startsWith(sourcePrefix.toLowerCase()));
        if (matches.length > 1) throw this.error("FLOW_AMBIGUOUS_ASSET", `${matches.length} videos begin with "${sourcePrefix}"; no continuation was started. Use the full title from flow_assets.`, true, false);
        const source = matches[0];
        if (!source) throw this.error("FLOW_VIDEO_NOT_FOUND", `No video beginning "${sourcePrefix}" exists in the project. Use flow_assets to list titles.`, true);
        if (root.scrollContainer?.()) root.scrollContainer().scrollTop = 0;
        const before = tiles.collectNativeMedia().map(item => item.id || `title:${item.title}`);
        let submitted = false;
        try {
          const tile = await tiles.findFlowTile(source.name);
          if (!tile || !tile.querySelector("flow-video-tile")) throw this.error("FLOW_VIDEO_NOT_FOUND", `Video "${source.name}" is no longer visible in the project.`, true);
          tile.scrollIntoView({ block: "center" }); tile.click();
          await nav.waitForFlowRoute(path => /\/edit\//i.test(path), 30000, "Flow did not open the source video editor.");
          await root.waitForEnabledFlowButton?.("Skip to next clip", 30000).then(btn => {
            if (!btn) throw this.error("FLOW_TIMELINE_MISSING", "The source video timeline is not ready.", true);
            btn.click();
          });
          await root.wait?.(1800);
          const save = await root.waitForEnabledFlowButton?.("Save frame", 10000);
          if (!save) throw this.error("FLOW_SAVE_FRAME_MISSING", "Flow did not show Save frame.", true);
          save.click(); await root.wait?.(2500);
          const back = root.flowButton?.("Back button to go to previous page");
          if (!back) throw this.error("FLOW_EDIT_BACK_MISSING", "Flow saved the frame, but its Back control is unavailable.", true, true);
          back.click();
          await nav.waitForFlowRoute(path => !/\/edit(?:\/|$)/i.test(path), 20000, "Flow did not return to the project after saving the last frame.");
          await nav.ensureFlowLibrarySection("All media");
          if (root.scrollContainer?.()) root.scrollContainer().scrollTop = 0;

          const frameTitle = `Saved frame from ${source.name}`;
          const frame = await tiles.findFlowTile(frameTitle, 200);
          if (!frame) throw this.error("FLOW_FRAME_NOT_FOUND", `Flow did not add the saved frame "${frameTitle}".`, false, true);
          frame.scrollIntoView({ block: "center" });
          frame.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); await root.wait?.(250);
          const more = root.flowButton?.("More options", frame);
          if (!more) throw this.error("FLOW_TILE_MENU_MISSING", "Could not open the saved frame menu.", true);
          more.click(); await root.wait?.(350);
          const animate = [...document.querySelectorAll('[role="menuitem"]')].find(el => root.visible?.(el) && /^(?:Animate|Tạo hiệu ứng động|Làm chuyển động)$/i.test((root.accessibleName?.(el) || el.innerText || "").trim()));
          if (!animate) throw this.error("FLOW_ANIMATE_MISSING", "Flow did not show Animate for the saved frame.", true);
          animate.click();
          await root.waitForEnabledFlowButton?.("Start generation", 15000);
          const box = document.querySelector(".ProseMirror");
          if (!box) throw this.error("FLOW_COMPOSER_MISSING", "Flow's continuation composer is not visible.", true);

          await agent.setNativeAgentMode(true);
          if (likeness) {
            for (const reference of params.attach || []) {
              const value = String(reference || "").replace(/^asset:/i, "").trim();
              if (!value) throw this.error("FLOW_INVALID_ARGUMENT", "Likeness continuation contains an empty attachment; nothing was submitted.", true);
              await components.chooseNativePickerAsset(value, undefined);
            }
          }
          await agent.setNativeAgentSettings("Never", params.aspect_ratio || "16:9");
          const cast = (params.attach || []).join(" and ");
          const exact = !likeness;
          const prompt = `${exact
            ? `Use I2V, Flow's first frame animation tool. The attached frame is the FIRST FRAME of this clip: begin exactly on it, with the same framing, lighting, colours, wardrobe and set, and continue from there with no cut, as an unbroken continuation of the shot it came from. Do not use any other reference.`
            : `Use R2V, reference-to-video, with the attached frame and ${cast || "the attached reference"} both as references, so the look and the person stay consistent through the clip. Open as close to the attached frame as you can.`} ${params.prompt || ""}`;
          const activeBox = document.querySelector(".ProseMirror");
          if (!activeBox || !root.replaceNativeEditableText?.(activeBox, prompt)) throw this.error("FLOW_PROMPT_INPUT_UNCONFIRMED", "Flow did not accept the continuation prompt. Nothing was submitted.", true);
          const start = await editor.waitForGenerationSubmitButton(prompt, 10000);
          if (!start) throw this.error("FLOW_SUBMIT_DISABLED", "Flow's continuation Start generation button is disabled.", true);
          await editor.activateFlowSubmitButton(start, prompt);
          submitted = true;
          await agent.resolveNativeAgentQuestion(command, exact
            ? "Use I2V, first frame animation. Start exactly on that frame and continue from it with no cut. Do not use the other reference."
            : "Use R2V, reference-to-video, using both attached references so the person stays consistent.");
          const resultMedia = await tiles.waitForProgressResult(command, before, 1, "video", Number(params.timeout_ms || 720000));
          return { media: resultMedia, trustedGesture: false };
        } catch (error) {
          if (submitted) error.outcome_unknown = true;
          throw error;
        } finally {
          await agent.resetNativeAgentWorkflow().catch(() => {});
        }
      }

      if (name === "flow.state") {
        const state = menu.nativeRead("flowState");
        const settingsButton = root.flowButton?.("Settings trigger");
        if (settingsButton) state.composer = (settingsButton.innerText || root.accessibleName?.(settingsButton)).replace(/\s+/g, " ").trim();
        if (payload.detailed && state.signedIn) {
          const account = root.flowButton?.("Account details");
          if (account) {
            account.click(); await root.wait?.(500);
            const creditLink = [...document.querySelectorAll("a")].find(a => /(?:Google Flow credits|credits?|tín dụng)/i.test(root.accessibleName?.(a) || a.innerText || "") && root.visible?.(a));
            const creditText = creditLink ? (root.accessibleName?.(creditLink) || creditLink.innerText || "") : "";
            const n = Number(creditText.replace(/[^\d]/g, ""));
            state.credits_remaining = Number.isFinite(n) && creditText ? n : undefined;
            state.plan = [...document.querySelectorAll("button")].find(b => /(?:Account details|Chi tiết tài khoản|Tài khoản)/i.test(root.accessibleName?.(b) || b.innerText || ""))?.innerText?.split("\n")[0];
            const close = root.flowButton?.("Close account panel"); if (close) close.click();
          }
        }
        return state;
      }

      if (name === "flow.assets.list") return menu.scanNativeAssets();
      if (name === "flow.characters.list") return menu.scanNativeCharacters();

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
        const variants = Math.max(1, Math.min(4, Number(payload.variants || 1)));
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
        const expected = Math.max(1, Math.min(20, Number(payload.expectedCount || 1)));
        const deadline = Date.now() + Math.max(1000, Math.min(15 * 60000, Number(payload.timeoutMs || 12 * 60000)));
        const correlationAttemptId = String(payload.correlationAttemptId || "");
        const correlationEntry = correlationAttemptId ? tiles.nativeFlowCorrelationMap().get(correlationAttemptId) : null;
        let priorProgress = "", lastTitleOnlyResult = "";
        let retriesLeft = Math.max(0, Math.min(3, Number(payload.retries ?? 1)));

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

            const fresh = tiles.collectNativeMedia().filter(item =>
              !before.includes(item.id || `title:${item.title}`) &&
              !item.title.startsWith("fm-") &&
              (!kind || item.kind === kind) &&
              (!strictCorrelation || (item.id && correlatedIds.has(item.id.toLowerCase())))
            );

            const failed = fresh.filter(item => item.failed);
            if (failed.length) {
              const failureDetails = failed[0]?.failureReason || "";
              const classified = root.classifyFlowError?.(failureDetails);
              if (classified && !classified.retryable) {
                throw this.error(classified.code, classified.message, false, false);
              }
              const retryable = failed.find(item => item);
              if (retryable && retriesLeft > 0 && await tiles.retryNativeErrorTile(retryable)) {
                retriesLeft--;
                tiles.emitFlowProgress(command, `Flow failed this render; retrying (${Math.max(0, Number(payload.retries ?? 1) - retriesLeft)}/${Number(payload.retries ?? 1)})`);
                continue;
              }
              const details = failed.map(item => `${item.title}${item.failureReason ? `: ${item.failureReason}` : ""}`).join("; ");
              throw this.error("FLOW_GENERATION_FAILED", `Flow reported ${failed.length} failed generation tile(s): ${details}. Nothing was charged for the failed render.`, false, false);
            }

            const ready = fresh.filter(item => !item.busy);
            if (ready.length >= expected) {
              const picked = strictCorrelation
                ? [...correlatedIds].map(id => ready.find(item => item.id?.toLowerCase() === id)).filter(Boolean).slice(0, expected)
                : ready.slice(0, expected);
              if (picked.length < expected) {
                await root.wait?.(1000);
                continue;
              }
              const titleOnly = picked.some(item => !item.id || item.id.startsWith("title:"));
              const signature = picked.map(item => item.id || `title:${item.title}`).join("|");
              if (!titleOnly || signature === lastTitleOnlyResult) return { media: picked.map(({ id, title, kind: mediaKind }) => ({ id, title, kind: mediaKind })) };
              lastTitleOnlyResult = signature;
              tiles.emitFlowProgress(command, "Flow is finishing the video title");
              await root.wait?.(1500);
              continue;
            }

            const percentages = [...document.querySelectorAll("flow-grid-tile-container")].slice(0, 8).map(t => (t.innerText || "").match(/\d+%/)?.[0]).filter(Boolean);
            const progress = percentages.join(", ") || (fresh.length ? "Flow is finishing the result" : "Waiting for Flow to start rendering");
            if (progress !== priorProgress) { tiles.emitFlowProgress(command, progress); priorProgress = progress; }
            await root.wait?.(2000);
          }
          throw this.error("FLOW_GENERATION_TIMEOUT", "Timed out waiting for Flow. The command may have been accepted; inspect the project before retrying.", false, true);
        } finally {
          if (correlationAttemptId) tiles.disarmNativeFlowCorrelation(correlationAttemptId);
        }
      }

      if (name === "flow.asset.rename" || name === "flow.asset.trash") {
        const title = String(payload.name || "");
        if (!title) throw this.error("FLOW_INVALID_ARGUMENT", "Asset name is required.");
        const copies = await tiles.countFlowTitleAcrossGrid(title);
        if (copies !== 1) throw this.error(copies > 1 ? "FLOW_AMBIGUOUS_ASSET" : "FLOW_ASSET_NOT_FOUND", copies > 1 ? `${copies} assets are named "${title}"; no mutation was performed.` : `Could not find asset "${title}".`, true);
        const tile = await tiles.findFlowTile(title);
        if (!tile) throw this.error("FLOW_ASSET_NOT_FOUND", `Could not find asset "${title}" after scanning the project grid.`, true);
        tile.scrollIntoView({ block: "center" }); await root.wait?.(150);
        const more = root.flowButton?.("More options", tile); if (!more) throw this.error("FLOW_TILE_MENU_MISSING", `Could not open options for "${title}".`, true);
        more.click(); await root.wait?.(200);
        const actionPatterns = name === "flow.asset.trash"
          ? /^(?:Move to trash|Chuyển vào thùng rác|Xóa)$/i
          : /^(?:Rename|Đổi tên)$/i;
        const menuEl = [...document.querySelectorAll('[role="menuitem"]')].find(item => {
          if (!root.visible?.(item)) return false;
          const label = (root.accessibleName?.(item) || item.innerText || item.textContent || "").trim();
          return actionPatterns.test(label);
        });
        if (!menuEl) throw this.error("FLOW_MENU_ITEM_MISSING", `Flow did not show "${name === "flow.asset.trash" ? "Move to trash" : "Rename"}" for "${title}".`, true);
        menuEl.click(); await root.wait?.(250);
        if (name === "flow.asset.trash") return { trashed: title };
        const input = [...document.querySelectorAll('input:not([type="file"]),[contenteditable="true"]')].find(el => root.visible?.(el));
        if (!input) throw this.error("FLOW_RENAME_INPUT_MISSING", "Flow opened rename but no editable title field is visible.", false, true);
        const newName = String(payload.newName || "");
        if (!newName) throw this.error("FLOW_INVALID_ARGUMENT", "newName is required.");
        if (input.isContentEditable) input.textContent = newName;
        else { input.value = newName; input.dispatchEvent(new Event("input", { bubbles: true })); }
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
        await root.wait?.(400);
        return { renamed: title, name: newName };
      }

      throw this.error("NATIVE_CAPABILITY_UNSUPPORTED", `Native Flow operation "${name}" is not implemented.`, true);
    }
  }

  // Register driver with ProviderRegistry (both "flow" and backward compatible "flow_v2")
  (root.ProviderRegistry || root.FlowDriverRegistry).register("flow", context => new FlowDriver(context));
  (root.ProviderRegistry || root.FlowDriverRegistry).register("flow_v2", context => new FlowDriver(context));

  root.FlowDriver = FlowDriver;
  root.FlowV2Driver = FlowDriver; // Backward compatibility alias
})(globalThis);
