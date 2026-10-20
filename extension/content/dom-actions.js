async function executeFlowOperation(name, payload = {}, command = {}) {
  if (name === "flow.projects.list") {
    if (/\/project\/[0-9a-f-]{36}(?:\/|$)/i.test(location.pathname)) {
      throw flowError("FLOW_HOMEPAGE_REQUIRED", "Project discovery needs the Flow home page. The connector should open a temporary home tab.", true);
    }
    return scanNativeProjects();
  }
  if (name === "flow.generation.upload.preflight") {
    const state = nativeRead("flowState");
    if (!state.signedIn || !state.inProject) throw flowError("FLOW_NOT_READY", state.hint || "Open a signed-in Flow project first.", true);
    // Flow creates/replaces file inputs when its upload menu opens. Do not require
    // the composer controls or an input to exist before we stage the file.
    const fileInputs = [...document.querySelectorAll('input[type="file"]')];
    return {
      ready: true,
      trustedFileSelection: false,
      hasComposer: Boolean(document.querySelector(".ProseMirror")),
      hasUploadButton: Boolean(findAddMediaButton()),
      fileInputCount: fileInputs.length,
    };
  }
  if (name === "flow.file.upload.begin") {
    const t = payload.transfer;
    if (!t || typeof t !== "object") throw flowError("FLOW_INVALID_ARGUMENT", "Upload metadata is required.");
    const isVideo = String(t.type || "").startsWith("video/");
    const assembler = new FlowNativeFileTransfer.UploadAssembler(t, { maxBytes: isVideo ? 200 * 1024 * 1024 : 25 * 1024 * 1024, chunkBytes: 256 * 1024, maxChunks: isVideo ? 800 : 100 });
    if (stagedNativeFiles.has(assembler.transferId)) throw flowError("FLOW_TRANSFER_DUPLICATE", "Upload transfer id is already staged.");
    nativeUploadAssemblers.set(assembler.transferId, assembler);
    return { transferId: assembler.transferId, ready: true };
  }
  if (name === "flow.file.upload.chunk") {
    const chunks = Array.isArray(payload.chunks) ? payload.chunks : [payload.chunk];
    const transferId = chunks[0]?.transferId;
    const assembler = nativeUploadAssemblers.get(transferId);
    if (!assembler) throw flowError("FLOW_TRANSFER_UNKNOWN", "Upload transfer is not active.");
    if (!chunks.length || chunks.length > 4 || chunks.some(chunk => chunk?.transferId !== transferId)) throw flowError("FLOW_INVALID_ARGUMENT", "Upload chunk batch is empty, too large, or mixes transfer ids.");
    try {
      let result;
      for (const chunk of chunks) result = await assembler.accept(chunk);
      return result;
    } catch (error) { nativeUploadAssemblers.delete(transferId); throw error; }
  }
  if (name === "flow.file.upload.finish") {
    const transferId = String(payload.transferId || "");
    const assembler = nativeUploadAssemblers.get(transferId);
    if (!assembler) throw flowError("FLOW_TRANSFER_UNKNOWN", "Upload transfer is not active.");
    try {
      const file = await assembler.finish();
      nativeUploadAssemblers.delete(transferId);
      stagedNativeFiles.set(transferId, file);
      return { transferId, staged: true, size: file.size, trustedGesture: false };
    } catch (error) { nativeUploadAssemblers.delete(transferId); throw error; }
  }
  if (name === "flow.file.upload.abort") {
    const transferId = String(payload.transferId || "");
    nativeUploadAssemblers.get(transferId)?.abort();
    nativeUploadAssemblers.delete(transferId);
    stagedNativeFiles.delete(transferId);
    return { transferId, aborted: true };
  }
  if (name === "flow.media.upload") {
    const transferId = String(payload.transferId || "");
    const file = stagedNativeFiles.get(transferId);
    const name = String(payload.name || "");
    const kind = payload.kind === "video" ? "video" : "image";
    if (!file || file.name !== name) throw flowError("FLOW_TRANSFER_UNKNOWN", "The staged media file is missing or its name does not match.", true);
    await uploadStagedFlowMedia(file, kind, command);
    return { uploaded: true, name, kind, trustedGesture: false };
  }
  if (name === "flow.asset.download") {
    const prefix = String(payload.name || "").toLowerCase();
    if (!prefix && !payload.id) throw flowError("FLOW_INVALID_ARGUMENT", "Asset name or media id is required.");
    if (payload.id) return triggerFlowDownload(String(payload.name || ""), payload.quality, String(payload.id));
    const assets = await scanNativeAssets();
    const candidates = assets.filter(asset => asset.name.toLowerCase().startsWith(prefix));
    const matches = [];
    for (const asset of candidates) {
      const count = await countFlowTitleAcrossGrid(asset.name);
      for (let i = 0; i < count; i++) matches.push(asset);
      if (matches.length > 1) break;
    }
    if (!matches.length) throw flowError("FLOW_ASSET_NOT_FOUND", `No asset title begins with "${payload.name}".`, true);
    if (matches.length > 1) throw flowError("FLOW_AMBIGUOUS_ASSET", `${matches.length} assets begin with "${payload.name}"; no download was started.`, true);
    return triggerFlowDownload(matches[0].name, payload.quality);
  }
  if (name === "flow.character.create") return globalThis.FlowCharacterActions.create(payload, command);
  if (name === "flow.character.edit") return globalThis.FlowCharacterActions.edit(payload, command);
  if (name === "flow.edit.run") {
    const params = payload.job?.params || payload.params || {};
    const source = String(params.edit_asset || "").trim();
    if (!source) throw flowError("FLOW_INVALID_ARGUMENT", "Video title is required.");
    await closeNativeAgentSession();
    const activeAgent = flowButton("Agent");
    if (activeAgent?.getAttribute("aria-pressed") === "true") await setNativeAgentMode(false);
    await ensureFlowLibrarySection("All media");
    const assets = await scanNativeAssets();
    const matches = assets.filter(asset => asset.kind === "video" && asset.name.toLowerCase().startsWith(source.toLowerCase()));
    if (matches.length > 1) throw flowError("FLOW_AMBIGUOUS_ASSET", `${matches.length} videos begin with "${source}"; no edit was started. Use the full title from flow_assets.`, true, false);
    const found = matches[0];
    if (!found) throw flowError("FLOW_VIDEO_NOT_FOUND", `No video beginning "${source}" exists in the project. Use flow_assets to list titles.`, true);
    if (scrollContainer()) scrollContainer().scrollTop = 0;
    const before = collectNativeMedia().map(item => item.id || `title:${item.title}`);
    const tile = await findFlowTile(found.name);
    if (!tile || !tile.querySelector("flow-video-tile")) throw flowError("FLOW_VIDEO_NOT_FOUND", `Video "${found.name}" is no longer visible in the project.`, true);
    tile.scrollIntoView({ block: "center" }); tile.click();
    await waitForFlowRoute(path => /\/edit\//i.test(path), 30_000, "Flow did not open the video editor.");
    const boxes = [...document.querySelectorAll(".ProseMirror")];
    if (!boxes.length) throw flowError("FLOW_COMPOSER_MISSING", "Flow's edit prompt is not visible.", true);
    const prompt = String(params.prompt || "").replace(/\s*\n+\s*/g, " ").trim();
    if (!replaceNativeEditableText(boxes[boxes.length - 1], prompt)) throw flowError("FLOW_PROMPT_INPUT_UNCONFIRMED", "Flow did not accept the video edit prompt. Nothing was submitted.", true);
    await wait(500);
    const start = await waitForGenerationSubmitButton(prompt, 8000);
    if (!start) throw flowError("FLOW_SUBMIT_DISABLED", "Flow's edit action is unavailable; nothing was submitted.", true);
    let submitted = false;
    try {
      await activateFlowSubmitButton(start, prompt);
      submitted = true;
      await waitForNativeEditorCompletion(command, Number(params.timeout_ms || 10 * 60_000), "video edit");
      const back = flowButton("Back button to go to previous page");
      if (!back) throw flowError("FLOW_EDIT_BACK_MISSING", "Flow finished the video edit, but its Back control is unavailable. The result remains in Flow.", true, true);
      back.click();
      await waitForFlowRoute(path => !/\/edit(?:\/|$)/i.test(path), 20_000, "Flow finished the edit but did not return to the project.");
      await ensureFlowLibrarySection("All media");
      if (scrollContainer()) scrollContainer().scrollTop = 0;
      const results = await waitForProgressResult(command, before, 1, "video", 90_000);
      return { media: results, trustedGesture: false };
    } catch (error) {
      if (submitted && error && typeof error === "object") error.outcome_unknown = true;
      throw error;
    }
  }
  if (name === "flow.agent.batch") {
    const params = payload.job?.params || payload.params || {};
    const scenes = params.agent_scenes || [];
    if (!scenes.length) throw flowError("FLOW_INVALID_ARGUMENT", "agent_scenes is required.");
    await closeNativeAgentSession();
    await ensureFlowLibrarySection("All media");
    const before = collectNativeMedia().map(item => item.id || `title:${item.title}`);
    let submitted = false;
    let outcomeUnknown = false;
    try {
      await setNativeAgentMode(true);
      await setNativeAgentSettings("Never", params.aspect_ratio || "16:9");
      await pickNativeAgentImageModel();
      const box = document.querySelector(".ProseMirror");
      if (!box) throw flowError("FLOW_AGENT_COMPOSER_MISSING", "Flow's Agent composer is not visible.", true);
      const sceneText = scenes.map((scene, index) => `Scene ${index + 1}: ${String(scene).replace(/\s+/g, " ").trim()}`).join("\n");
      const script = `Generate exactly ${scenes.length} separate images: one image for each scene below, in the listed scene order. Do not combine scenes into a collage or a single image. Images only, never video. ${params.aspect_ratio || "16:9"} aspect ratio. Do not ask questions; generate them now.\n${sceneText}`;
      setEditable(box, script); await wait(300);
      const start = await waitForGenerationSubmitButton(script, 8000);
      if (!start) throw flowError("FLOW_SUBMIT_DISABLED", "Flow's Agent Start generation button is disabled or is not in the composer containing the prompt; nothing was submitted.", true);
      await activateFlowSubmitButton(start, script);
      submitted = true;
      let media;
      let partialFailure = false;
      let failedMedia = [];
      try {
        media = await waitForProgressResult(command, before, scenes.length, "image", Number(params.timeout_ms || 1800000), "main", true);
      } catch (error) {
        if (error?.code !== "FLOW_GENERATION_FAILED" || error?.outcome_unknown !== false
          || !Array.isArray(error.partialMedia) || !Array.isArray(error.failedMedia)) throw error;
        media = error.partialMedia;
        failedMedia = error.failedMedia;
        partialFailure = true;
      }
      const prompts = [];
      for (const item of media) {
        const scroller = scrollContainer();
        if (scroller) scroller.scrollTop = 0;
        await wait(250);
        let tile;
        for (let step = 0; step < 160 && !tile; step++) {
          tile = [...document.querySelectorAll("flow-grid-tile-container")].find(candidate =>
            item.id && !item.id.startsWith("title:")
              ? mediaId(candidate) === item.id
              : candidate.getAttribute("aria-label") === item.title);
          if (!tile && scroller) {
            const top = scroller.scrollTop, max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
            if (top >= max - 2) break;
            scroller.scrollTop = Math.min(max, top + Math.max(200, scroller.clientHeight * 0.78)); await wait(250);
          }
        }
        if (!tile) { prompts.push(""); continue; }
        tile.scrollIntoView({ block: "center" }); tile.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); await wait(250);
        const reuse = flowButton("Reuse prompt", tile);
        if (!reuse) { prompts.push(""); continue; }
        reuse.click(); await wait(550);
        prompts.push(document.querySelector(".ProseMirror")?.innerText || "");
        const close = flowButton("Close");
        if (close && flowButton("Start new session")) { close.click(); await wait(350); }
      }
      const clear = flowButton("Clear prompt"); if (clear) clear.click();
      return { media, prompts, ...(partialFailure ? { partial: true, failedMedia } : {}), trustedGesture: false };
    } catch (error) {
      outcomeUnknown = Boolean(error?.outcome_unknown) || submitted;
      throw error;
    } finally {
      // Do not alter a potentially still-running task after an uncertain result.
      if (!outcomeUnknown) {
        const session = flowButton("Start new session");
        if (session) { const close = flowButton("Close"); if (close) { close.click(); await wait(500); } }
        try { await setNativeAgentSettings("Always"); } catch {}
        await setNativeAgentMode(false).catch(() => {});
        const clear = flowButton("Clear prompt"); if (clear) clear.click();
      }
    }
  }
  if (name === "flow.continue.run") {
    const params = payload.job?.params || payload.params || {};
    const sourcePrefix = String(params.continue_from || "").trim();
    if (!sourcePrefix) throw flowError("FLOW_INVALID_ARGUMENT", "Video title is required.");
    const likeness = params.continue_mode === "likeness";
    if (likeness && (!Array.isArray(params.attach) || !params.attach.length)) throw flowError("FLOW_INVALID_ARGUMENT", "Likeness continuation requires at least one character or avatar attachment.", true);
    await closeNativeAgentSession();
    const activeAgent = flowButton("Agent");
    if (activeAgent?.getAttribute("aria-pressed") === "true") await setNativeAgentMode(false);
    await ensureFlowLibrarySection("All media");
    const assets = await scanNativeAssets();
    const matches = assets.filter(asset => asset.kind === "video" && asset.name.toLowerCase().startsWith(sourcePrefix.toLowerCase()));
    if (matches.length > 1) throw flowError("FLOW_AMBIGUOUS_ASSET", `${matches.length} videos begin with "${sourcePrefix}"; no continuation was started. Use the full title from flow_assets.`, true, false);
    const source = matches[0];
    if (!source) throw flowError("FLOW_VIDEO_NOT_FOUND", `No video beginning "${sourcePrefix}" exists in the project. Use flow_assets to list titles.`, true);
    if (scrollContainer()) scrollContainer().scrollTop = 0;
    const before = collectNativeMedia().map(item => item.id || `title:${item.title}`);
    let submitted = false;
    try {
      const tile = await findFlowTile(source.name);
      if (!tile || !tile.querySelector("flow-video-tile")) throw flowError("FLOW_VIDEO_NOT_FOUND", `Video "${source.name}" is no longer visible in the project.`, true);
      tile.scrollIntoView({ block: "center" }); tile.click();
      await waitForFlowRoute(path => /\/edit\//i.test(path), 30_000, "Flow did not open the source video editor.");
      await waitForEnabledFlowButton("Skip to next clip", 30_000).then(button => {
        if (!button) throw flowError("FLOW_TIMELINE_MISSING", "The source video timeline is not ready.", true);
        button.click();
      });
      await wait(1800);
      const save = await waitForEnabledFlowButton("Save frame", 10_000);
      if (!save) throw flowError("FLOW_SAVE_FRAME_MISSING", "Flow did not show Save frame.", true);
      save.click(); await wait(2500);
      const back = flowButton("Back button to go to previous page");
      if (!back) throw flowError("FLOW_EDIT_BACK_MISSING", "Flow saved the frame, but its Back control is unavailable.", true, true);
      back.click();
      await waitForFlowRoute(path => !/\/edit(?:\/|$)/i.test(path), 20_000, "Flow did not return to the project after saving the last frame.");
      await ensureFlowLibrarySection("All media");
      if (scrollContainer()) scrollContainer().scrollTop = 0;

      const frameTitle = `Saved frame from ${source.name}`;
      const frame = await findFlowTile(frameTitle, 200);
      if (!frame) throw flowError("FLOW_FRAME_NOT_FOUND", `Flow did not add the saved frame "${frameTitle}".`, false, true);
      frame.scrollIntoView({ block: "center" });
      frame.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); await wait(250);
      const more = flowButton("More options", frame);
      if (!more) throw flowError("FLOW_TILE_MENU_MISSING", "Could not open the saved frame menu.", true);
      more.click(); await wait(350);
      const animate = [...document.querySelectorAll('[role="menuitem"]')].find(el => visible(el) && accessibleName(el).trim() === "Animate");
      if (!animate) throw flowError("FLOW_ANIMATE_MISSING", "Flow did not show Animate for the saved frame.", true);
      animate.click();
      await waitForEnabledFlowButton("Start generation", 15_000);
      const box = document.querySelector(".ProseMirror");
      if (!box) throw flowError("FLOW_COMPOSER_MISSING", "Flow's continuation composer is not visible.", true);

      // Animate enters Flow Agent mode, which can use the saved frame and a character
      // together. Keep the old flow's order: attach the cast before setting Agent policy.
      await setNativeAgentMode(true);
      if (likeness) {
        for (const reference of params.attach || []) {
          const value = String(reference || "").replace(/^asset:/i, "").trim();
          if (!value) throw flowError("FLOW_INVALID_ARGUMENT", "Likeness continuation contains an empty attachment; nothing was submitted.", true);
          await chooseNativePickerAsset(value, undefined);
        }
      }
      await setNativeAgentSettings("Never", params.aspect_ratio || "16:9");
      const cast = (params.attach || []).join(" and ");
      const exact = !likeness;
      const prompt = `${exact
        ? `Use I2V, Flow's first frame animation tool. The attached frame is the FIRST FRAME of this clip: begin exactly on it, with the same framing, lighting, colours, wardrobe and set, and continue from there with no cut, as an unbroken continuation of the shot it came from. Do not use any other reference.`
        : `Use R2V, reference-to-video, with the attached frame and ${cast || "the attached reference"} both as references, so the look and the person stay consistent through the clip. Open as close to the attached frame as you can.`} ${params.prompt || ""}`;
      const activeBox = document.querySelector(".ProseMirror");
      if (!activeBox || !replaceNativeEditableText(activeBox, prompt)) throw flowError("FLOW_PROMPT_INPUT_UNCONFIRMED", "Flow did not accept the continuation prompt. Nothing was submitted.", true);
      const start = await waitForGenerationSubmitButton(prompt, 10_000);
      if (!start) throw flowError("FLOW_SUBMIT_DISABLED", "Flow's continuation Start generation button is disabled.", true);
      await activateFlowSubmitButton(start, prompt);
      submitted = true;
      await resolveNativeAgentQuestion(command, exact
        ? "Use I2V, first frame animation. Start exactly on that frame and continue from it with no cut. Do not use the other reference."
        : "Use R2V, reference-to-video, using both attached references so the person stays consistent.");
      const media = await waitForProgressResult(command, before, 1, "video", Number(params.timeout_ms || 720000), "main");
      return { media, trustedGesture: false };
    } catch (error) {
      if (submitted) error.outcome_unknown = true;
      throw error;
    } finally {
      // Restore the plain project composer after both success and failure so the next
      // generation or character operation does not inherit a hidden Agent session.
      await resetNativeAgentWorkflow().catch(() => {});
    }
  }
  if (name === "flow.state") {
    const state = nativeRead("flowState");
    const settingsButton = flowButton("Settings trigger");
    if (settingsButton) state.composer = (settingsButton.innerText || accessibleName(settingsButton)).replace(/\s+/g, " ").trim();
    if (payload.detailed && state.signedIn) {
      const account = flowButton("Account details");
      if (account) {
        account.click(); await wait(500);
        const creditLink = [...document.querySelectorAll("a")].find(a => /Google Flow credits/i.test(accessibleName(a)) && visible(a));
        const creditText = creditLink ? accessibleName(creditLink) : "";
        const n = Number(creditText.replace(/[^\d]/g, ""));
        state.credits_remaining = Number.isFinite(n) && creditText ? n : undefined;
        state.plan = [...document.querySelectorAll("button")].find(b => /Account details/i.test(accessibleName(b)))?.innerText?.split("\n")[0];
        const close = flowButton("Close account panel"); if (close) close.click();
      }
    }
    return state;
  }
  if (name === "flow.assets.list") return scanNativeAssets();
  if (name === "flow.characters.list") return scanNativeCharacters();
  if (name === "flow.references.attach") {
    const references = payload.references;
    if (!Array.isArray(references) || !references.length || references.length > 3) throw flowError("FLOW_INVALID_ARGUMENT", "Provide one to three named references.");
    const attached = [];
    for (const reference of references) attached.push(await globalThis.FlowReferenceActions.attach(reference));
    return { attached, submitted: false };
  }
  if (name === "flow.generation.submit") {
    const state = nativeRead("flowState");
    if (!state.signedIn || !state.inProject) throw flowError("FLOW_NOT_READY", state.hint || "Open a signed-in Flow project first.", true);
    await closeNativeAgentSession();
    await ensureFlowLibrarySection("All media");
    const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
    const variants = Math.max(1, Math.min(4, Number(payload.variants || 1)));
    const frameValue = value => {
      if (typeof value === "string" && value.trim()) return { assetName: value.replace(/^asset:/i, "").trim() };
      if (!value || typeof value !== "object") return undefined;
      if (typeof value.assetName === "string" && value.assetName.trim()) return { assetName: value.assetName.trim() };
      if (validStagedLocalImage(value, /(?:start|end)/)) return value;
      return null;
    };
    const firstFrame = frameValue(payload.firstFrame), lastFrame = frameValue(payload.lastFrame);
    const framesMode = payload.type === "video" && Boolean(firstFrame || lastFrame);
    if (firstFrame === null || lastFrame === null || (!framesMode && attachments.some(item => {
      if (typeof item === "string") return !item.trim();
      if (!item || typeof item !== "object") return true;
      if (typeof item.assetName === "string") return !item.assetName.trim();
      return !validStagedLocalImage(item, /(?:ref[1-3]|attach[1-3])/);
    }))) throw flowError("NATIVE_CAPABILITY_UNSUPPORTED", "Native generation accepts project asset names or staged local image attachments only; nothing was submitted.", true, false);
    const referenceAttachments = framesMode ? [] : attachments;
    if (scrollContainer()) scrollContainer().scrollTop = 0;
    const before = collectNativeMedia().map(item => item.id || `title:${item.title}`);
    const agent = flowButton("Agent");
    if (agent?.getAttribute("aria-pressed") === "true") {
      await setNativeAgentMode(false);
    }
    const clear = flowButton("Clear prompt"); if (clear) clear.click();
    const settingsCredits = payload.type === "image"
      ? await globalThis.FlowImageActions.prepare(payload, variants)
      : await globalThis.FlowVideoActions.prepare(payload, variants, framesMode);

    const uploadAndResolve = async (attachment, slot) => {
      if (!validStagedLocalImage(attachment, /(?:start|end|ref[1-3])/)) throw flowError("FLOW_UPLOAD_UNAVAILABLE", "Flow's staged image transfer is unavailable before file selection.", false, false);
      const file = stagedNativeFiles.get(attachment.transferId);
      if (!file) throw flowError("FLOW_TRANSFER_UNKNOWN", "The staged image is no longer available.", true);
      try {
          await uploadStagedFlowMedia(file, "image", command);
      } finally {
        // Uploading from Flow V2's Frames composer temporarily switches to Ingredients
        // when the + menu is hidden. Restore Frames before using Start/End pickers.
        if (framesMode && (slot === "start" || slot === "end")) await restoreNativeFramesMode();
      }
      await chooseNativePickerAsset(attachment.name, slot);
    };
    const resolveValue = async (value, slot) => {
      if (!value) return;
      if (value.assetName) return chooseNativePickerAsset(value.assetName, slot);
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
        if (!visible(el)) return false;
        const name = (accessibleName(el) || el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
        return /(?:Ingredient|Thành phần)/i.test(name) || /Xóa thành phần|Remove ingredient/i.test(name);
      };
      let attachedCount = 0;
      const countDeadline = Date.now() + 2500;
      while (Date.now() < countDeadline) {
        attachedCount = [...document.querySelectorAll("button,[role=button],[role=listitem],mat-chip,[data-chip]")].filter(isRefChip).length;
        if (attachedCount >= expectedRefs) break;
        await wait(250);
      }
      if (attachedCount < expectedRefs) {
        const composerRoot = document.querySelector(".ProseMirror")?.closest(".flow-composer, [class*='composer'], form") || document.body;
        const chipsInComposer = [...composerRoot.querySelectorAll("img, button, [role=button]")].filter(el => {
          if (!visible(el)) return false;
          const label = (accessibleName(el) || el.getAttribute("alt") || el.getAttribute("title") || "").toLowerCase();
          return /(?:ingredient|thành phần)/i.test(label);
        });
        const finalCount = Math.max(attachedCount, chipsInComposer.length);
        if (finalCount < expectedRefs) {
          throw flowError("FLOW_REFERENCE_ATTACH_UNCONFIRMED", `Flow shows ${finalCount} of ${expectedRefs} reference attachment(s); no generation was submitted. Inspect Flow before retrying.`, false, true);
        }
      }
    }
    const activeBox = await preflightGenerationPrompt(payload, framesMode);
    const promptApplied = await insertNativeFlowPrompt(activeBox, payload.prompt);
    if (!promptApplied) throw flowError("FLOW_PROMPT_INPUT_UNCONFIRMED", "Flow's composer did not confirm the full prompt text. Nothing was submitted.", true, false);
    // Flow may not calculate/render its usage quote until settings, references and prompt are applied.
    // Read it at the last safe point, immediately before activating submit.
    const renderedCredits = await waitForGenerationCreditQuote(Number.isFinite(settingsCredits) ? 1500 : 3000);
    const credits = Number.isFinite(renderedCredits) ? renderedCredits : (Number.isFinite(settingsCredits) ? settingsCredits : 0);
    if (payload.maxCredits !== undefined && credits > Number(payload.maxCredits)) throw flowError("FLOW_MAX_CREDITS_EXCEEDED", `Flow quotes ${credits} credits, above max_credits=${payload.maxCredits}. Nothing was submitted.`, false, false);
    const start = await waitForGenerationSubmitButton(payload.prompt, 10_000);
    if (!start) throw flowError("FLOW_SUBMIT_DISABLED", "Flow's Start generation button did not become ready within 10 seconds; nothing was submitted.", true);
    const errorsBeforeSubmit = new Set(currentFlowSubmitErrors());
    const activation = await activateFlowSubmitButton(start, payload.prompt);

    // Follow TobyFlow's submit contract: a delivered click is only an attempt.
    // Require a changed control/editor or a new tile before starting the render wait.
    const submitDeadline = Date.now() + 30_000;
    let acknowledged = false;
    let lastSubmitProgress = "";
    while (Date.now() < submitDeadline) {
      const newError = currentFlowSubmitErrors().find(message => !errorsBeforeSubmit.has(message));
      if (newError) throw flowError("FLOW_SUBMIT_REJECTED", `Flow rejected the submit: ${newError}`, false, false);
      const currentStart = getFlowSubmitButton(payload.prompt) || flowButton("Start generation");
      const currentBox = document.querySelector(".ProseMirror");
      const freshMedia = collectNativeMedia().filter(item => !before.includes(item.id || `title:${item.title}`));
      if (!currentStart || currentStart.disabled || currentStart.getAttribute("aria-disabled") === "true" ||
          currentBox?.textContent?.trim() !== String(payload.prompt || "").trim() || freshMedia.length) {
        acknowledged = true;
        break;
      }
      // If after 1s the submit hasn't triggered, try TobyFlow's Enter press fallback on editor
      if (Date.now() - (submitDeadline - 30_000) > 1000 && !acknowledged && currentBox) {
        pressFlowEditorSubmit(currentBox);
      }
      const progress = freshMedia.some(item => item.busy) ? "Flow accepted the submit and is rendering" : "Waiting for Flow to accept the submit";
      if (progress !== lastSubmitProgress) {
        emitFlowProgress(command, progress);
        lastSubmitProgress = progress;
      }
      await wait(250);
    }
    if (!acknowledged && !activation.controlAccepted) {
      const newError = currentFlowSubmitErrors().find(message => !errorsBeforeSubmit.has(message));
      if (newError) throw flowError("FLOW_SUBMIT_REJECTED", `Flow rejected the submit: ${newError}`, false, false);
      throw flowError("FLOW_SUBMIT_UNCONFIRMED", `Flow did not confirm the trusted submit within 30 seconds (click delivered: ${Boolean(activation.clickDelivered)}). No render wait or download was started.`, false, true);
    }
    return {
      submitted: true,
      before,
      type: payload.type === "image" ? "image" : "video",
      expectedCount: variants,
      credits,
      activation: activation.strategy || "dom-click",
      acceptanceObserved: acknowledged || Boolean(activation.controlAccepted),
    };
  }
  if (name === "flow.generation.observe") {
    const before = Array.isArray(payload.before) ? payload.before : [];
    const kind = payload.kind === "image" ? "image" : payload.kind === "video" ? "video" : undefined;
    const expected = Math.max(1, Math.min(20, Number(payload.expectedCount || 1)));
    const deadline = Date.now() + Math.max(1000, Math.min(15 * 60_000, Number(payload.timeoutMs || 12 * 60_000)));
    let priorProgress = "", lastTitleOnlyResult = "";
    let retriesLeft = Math.max(0, Math.min(3, Number(payload.retries ?? 1)));
    while (Date.now() < deadline) {
      const fresh = collectNativeMedia().filter(item => !before.includes(item.id || `title:${item.title}`) && !item.title.startsWith("fm-") && (!kind || item.kind === kind));
      const failed = fresh.filter(item => item.failed);
      if (failed.length) {
        const retryable = failed.find(item => item);
        if (retryable && retriesLeft > 0 && await retryNativeErrorTile(retryable)) {
          retriesLeft--;
          emitFlowProgress(command, `Flow failed this render; retrying (${Math.max(0, Number(payload.retries ?? 1) - retriesLeft)}/${Number(payload.retries ?? 1)})`);
          continue;
        }
        const details = failed.map(item => `${item.title}${item.failureReason ? `: ${item.failureReason}` : ""}`).join("; ");
        throw flowError("FLOW_GENERATION_FAILED", `Flow reported ${failed.length} failed generation tile(s): ${details}. Nothing was charged for the failed render.`, false, false);
      }
      const ready = fresh.filter(item => !item.busy);
      if (ready.length >= expected) {
        const picked = ready.slice(0, expected);
        const titleOnly = picked.some(item => !item.id || item.id.startsWith("title:"));
        const signature = picked.map(item => item.id || `title:${item.title}`).join("|");
        if (!titleOnly || signature === lastTitleOnlyResult) return { media: picked.map(({ id, title, kind: mediaKind }) => ({ id, title, kind: mediaKind })) };
        lastTitleOnlyResult = signature;
        emitFlowProgress(command, "Flow is finishing the video title");
        await wait(1500);
        continue;
      }
      const percentages = [...document.querySelectorAll("flow-grid-tile-container")].slice(0, 8).map(tile => (tile.innerText || "").match(/\d+%/)?.[0]).filter(Boolean);
      const progress = percentages.join(", ") || (fresh.length ? "Flow is finishing the result" : "Waiting for Flow to start rendering");
      if (progress !== priorProgress) { emitFlowProgress(command, progress); priorProgress = progress; }
      await wait(2000);
    }
    throw flowError("FLOW_GENERATION_TIMEOUT", "Timed out waiting for Flow. The command may have been accepted; inspect the project before retrying.", false, true);
  }
  if (name === "flow.asset.rename" || name === "flow.asset.trash") {
    const title = String(payload.name || "");
    if (!title) throw flowError("FLOW_INVALID_ARGUMENT", "Asset name is required.");
    const copies = await countFlowTitleAcrossGrid(title);
    if (copies !== 1) throw flowError(copies > 1 ? "FLOW_AMBIGUOUS_ASSET" : "FLOW_ASSET_NOT_FOUND", copies > 1 ? `${copies} assets are named "${title}"; no mutation was performed.` : `Could not find asset "${title}".`, true);
    const tile = await findFlowTile(title);
    if (!tile) throw flowError("FLOW_ASSET_NOT_FOUND", `Could not find asset "${title}" after scanning the project grid.`, true);
    tile.scrollIntoView({ block: "center" }); await wait(150);
    const more = flowButton("More options", tile); if (!more) throw flowError("FLOW_TILE_MENU_MISSING", `Could not open options for "${title}".`, true);
    more.click(); await wait(200);
    const action = name === "flow.asset.trash" ? "Move to trash" : "Rename";
    const menu = [...document.querySelectorAll('[role="menuitem"]')].find(item => visible(item) && accessibleName(item).trim() === action);
    if (!menu) throw flowError("FLOW_MENU_ITEM_MISSING", `Flow did not show "${action}" for "${title}".`, true);
    menu.click(); await wait(250);
    if (name === "flow.asset.trash") return { trashed: title };
    const input = [...document.querySelectorAll('input:not([type="file"]),[contenteditable="true"]')].find(el => visible(el));
    if (!input) throw flowError("FLOW_RENAME_INPUT_MISSING", "Flow opened rename but no editable title field is visible.", false, true);
    const newName = String(payload.newName || "");
    if (!newName) throw flowError("FLOW_INVALID_ARGUMENT", "newName is required.");
    if (input.isContentEditable) input.textContent = newName;
    else { input.value = newName; input.dispatchEvent(new Event("input", { bubbles: true })); }
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
    await wait(400);
    return { renamed: title, name: newName };
  }
  throw flowError("NATIVE_CAPABILITY_UNSUPPORTED", `Native Flow operation "${name}" is not implemented.`, true);
}

async function flowOperation(name, payload = {}, command = {}) {
  const operation = name;
  const resolved = FlowDriverRegistry.resolveForUrl(location.href, { operationHandler: executeFlowOperation });
  if (!resolved?.driver) {
    throw flowError("FLOW_UNSUPPORTED_ROUTE", "This Flow page route is not supported by the installed Flow driver.", true);
  }
  return resolved.driver.invoke(operation, payload, command);
}

async function execute(c) {
  if (c.op === "flowOperation") return flowOperation(c.name, c.payload || {}, c);
  throw flowError("NATIVE_CAPABILITY_UNSUPPORTED", `Unsupported native Flow command: ${String(c.op || "unknown")}`, true);
}

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.type !== "flow-mcp:execute") return;
  execute(message.command).then(result => respond({ ok:true, value:result }), error => respond({ ok:false, error:{ code:error?.code || "FLOW_DOM_FAILED", message:String(error?.message || error), retryable:Boolean(error?.retryable), outcome_unknown:Boolean(error?.outcome_unknown) } }));
  return true;
});
