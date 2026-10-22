(function (root) {
  class FlowWorkflowOperations {
    constructor(driver) {
      this.driver = driver;
    }
    supports(operation) {
      return [
        "flow.character.create",
        "flow.character.edit",
        "flow.edit.run",
        "flow.agent.batch",
        "flow.continue.run",
        "flow.frame.extract_last",
      ].includes(operation);
    }
    error(...args) {
      return this.driver.error(...args);
    }
    workflowDeadline(command, fallbackMs = 120_000) {
      return root.FlowUiDeadline?.makeDeadline(command, fallbackMs, 15_000) || Date.now() + fallbackMs;
    }
    requireWorkflowTime(deadline, operation, outcomeUnknown = false, signal) {
      root.FlowUiDeadline?.requireTime(deadline, operation, outcomeUnknown, signal);
      if (Date.now() >= deadline) {
        throw this.error("FLOW_OPERATION_TIMEOUT", `Timed out ${operation}. Inspect Flow before retrying.`, false, outcomeUnknown);
      }
    }
    async waitWorkflow(deadline, ms, operation, outcomeUnknown = false, signal) {
      if (root.FlowUiDeadline?.boundedWait) {
        await root.FlowUiDeadline.boundedWait(ms, deadline, operation, outcomeUnknown, signal);
      } else {
        this.requireWorkflowTime(deadline, operation, outcomeUnknown, signal);
        await root.wait?.(Math.min(ms, Math.max(1, deadline - Date.now())));
        this.requireWorkflowTime(deadline, operation, outcomeUnknown, signal);
      }
    }
    validateContinuationReferenceIds(frameId, characterReferenceIds = [], expectedCharacterCount = 0) {
      const isUuid = value => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
      if (!isUuid(frameId)) {
        throw this.error("FLOW_SUBMIT_CORRELATION_REFERENCE_ID_UNAVAILABLE", "Flow's saved continuation frame did not expose a verifiable media UUID. Nothing was submitted.", false, false);
      }
      if (!Array.isArray(characterReferenceIds) || characterReferenceIds.length !== expectedCharacterCount || characterReferenceIds.some(id => !isUuid(id))) {
        throw this.error("FLOW_SUBMIT_CORRELATION_REFERENCE_ID_UNAVAILABLE", "Flow did not expose a verifiable media UUID for every requested continuation reference. Nothing was submitted.", false, false);
      }
      const ids = [frameId, ...characterReferenceIds].map(id => id.toLowerCase());
      if (new Set(ids).size !== ids.length) {
        throw this.error("FLOW_SUBMIT_CORRELATION_REFERENCE_ID_UNAVAILABLE", "Flow returned duplicate media UUIDs for continuation references. Nothing was submitted.", false, false);
      }
      return ids;
    }
    verifyAgentBatchPreflight({ editor, box, prompt }) {
      const agentControl = root.flowButton?.("Agent");
      const actualPrompt = editor.getEditorUserText?.(box) || "";
      const normalizePrompt = editor.normalizeFlowPrompt || (value => String(value || "").replace(/\s+/g, " ").trim());
      const submit = editor.getFlowSubmitButton?.();
      if (agentControl?.getAttribute("aria-pressed") !== "true") {
        throw this.error("FLOW_AGENT_MODE_UNCONFIRMED", "Flow's Agent mode was not visibly active; nothing was submitted.", false, false);
      }
      if (normalizePrompt(actualPrompt) !== normalizePrompt(prompt)) {
        throw this.error("FLOW_PROMPT_INPUT_UNCONFIRMED", "Flow's Agent prompt did not match the requested scene; nothing was submitted.", false, false);
      }
      if (!submit || submit.disabled || submit.getAttribute("aria-disabled") === "true") {
        throw this.error("FLOW_SUBMIT_DISABLED", "Flow's Agent submit button was not enabled after the prompt was entered; nothing was submitted.", false, false);
      }
      return { agent_mode: true, prompt_characters: actualPrompt.length, submit_enabled: true };
    }
    agentSceneMatches(scenes, prompts) {
      const stopWords = new Set("the and with from into over under that this then than are was for her his its their onto next near across wide shot close scene image".split(" "));
      const words = text => new Set(String(text || "").toLowerCase().match(/[a-z0-9']{3,}/g)?.filter(word => !stopWords.has(word)) || []);
      const sceneWords = scenes.map(words);
      const pairs = [];
      prompts.forEach((prompt, tile) => {
        const have = words(prompt);
        sceneWords.forEach((want, scene) => {
          const hit = [...want].filter(word => have.has(word)).length;
          pairs.push({ scene, tile, score: want.size ? hit / want.size : 0 });
        });
      });
      pairs.sort((a, b) => b.score - a.score);
      const result = scenes.map(() => []);
      const usedTiles = new Set();
      for (const firstPass of [true, false]) for (const { scene, tile, score } of pairs) {
        if (score < 0.5 || usedTiles.has(tile) || (firstPass && result[scene].length)) continue;
        result[scene].push(tile);
        usedTiles.add(tile);
      }
      return result;
    }
    async submitAndConfirmDispatch({ editor, tiles, command, prompt, mediaType = "video", expectedQuantity = 1, expectedReferenceIds = [], expectedMediaReferenceIds = [], expectedCharacterIds = [], deadline, afterClick, checkConfirmation }) {
      this.requireWorkflowTime(deadline, "arming the Flow request observer", false, command?.signal);
      const projectId = (root.ProviderRegistry || root.FlowDriverRegistry).describeUrl(location.href)?.projectId;
      const attemptId = await tiles.armNativeFlowCorrelation({
        projectId, mediaType, prompt, expectedQuantity,
        expectedReferenceIds, expectedMediaReferenceIds, expectedCharacterIds,
      });
      if (!attemptId || !tiles.nativeFlowCorrelationMap().has(attemptId)) {
        throw this.error("FLOW_SUBMIT_CORRELATION_UNAVAILABLE", "Flow's request observer could not be armed; nothing was submitted.", false, false);
      }
      let dispatched = false;
      let clickDelivered = false;
      const beforeErrors = new Set(editor.currentFlowSubmitErrors?.() || []);
      try {
        this.requireWorkflowTime(deadline, "activating the Flow submit button", false, command?.signal);
        const submit = await editor.waitForGenerationSubmitButton(prompt, Math.min(15_000, Math.max(1, deadline - Date.now())));
        if (!submit || submit.disabled || submit.getAttribute("aria-disabled") === "true") {
          throw this.error("FLOW_SUBMIT_DISABLED", "Flow's Start generation button is unavailable; nothing was submitted.", true, false);
        }
        const activation = await editor.activateFlowSubmitButton(submit, prompt);
        clickDelivered = activation?.clickDelivered === true;
        if (!clickDelivered) throw this.error("FLOW_SUBMIT_CLICK_NOT_DELIVERED", "Flow did not receive the submit click; nothing was submitted.", false, false);
        if (afterClick) {
          const remaining = Math.max(1, deadline - Date.now());
          let timer;
          try {
            await Promise.race([
              afterClick(),
              new Promise((_, reject) => { timer = setTimeout(() => reject(this.error("FLOW_OPERATION_TIMEOUT", "Timed out resolving Flow Agent's video method question after submit. The outcome is unknown; inspect Flow before retrying.", false, true)), remaining); }),
            ]);
          } finally { clearTimeout(timer); }
        }

        const dispatchDeadline = Math.min(deadline, Date.now() + 30_000);
      let confirmationEvidence;
        while (Date.now() < dispatchDeadline) {
          this.requireWorkflowTime(dispatchDeadline, "waiting for Flow to dispatch the generation request", true, command?.signal);
          const entry = tiles.nativeFlowCorrelationMap().get(attemptId);
          if (!entry) throw this.error("FLOW_SUBMIT_CORRELATION_LOST", "Flow's request observer lost this submit before dispatch was observed. Inspect Flow before retrying.", false, true);
          if (entry.interfered) throw this.error("FLOW_SUBMIT_INTERFERENCE", "The composer changed before Flow's generation request was observed. The outcome is unknown; inspect Flow before retrying.", false, true);
          if (entry.requestSeen) { dispatched = true; break; }
        if (checkConfirmation) {
          const confirmation = await checkConfirmation();
          if (confirmation?.state === "blocked") {
            throw this.error("FLOW_AGENT_CONFIRMATION_UNVERIFIED", `Flow showed a confirmation that could not be proven to be one free image run: ${confirmation.reason}. Nothing was confirmed.`, false, false, confirmation);
          }
          if (confirmation?.state === "confirmed") confirmationEvidence = confirmation;
        }
          const message = editor.currentFlowSubmitErrors?.().find(item => !beforeErrors.has(item));
          if (message) {
            const classified = root.classifyFlowError?.(message);
            throw this.error(classified?.code || "FLOW_SUBMIT_REJECTED", classified?.message || `Flow reported an error before dispatch was observed: ${message}. Inspect Flow before retrying.`, false, true);
          }
          tiles.emitFlowProgress?.(command, "Waiting for Flow to dispatch the generation request");
          await this.waitWorkflow(dispatchDeadline, 250, "waiting for Flow request dispatch", true, command?.signal);
        }
        if (!dispatched) {
          dispatched = tiles.nativeFlowCorrelationMap().get(attemptId)?.requestSeen === true;
          if (!dispatched) throw this.error("FLOW_SUBMIT_UNCONFIRMED", `Flow did not emit a correlated generation request within the dispatch budget (click delivered: ${clickDelivered}). The outcome is unknown; inspect Flow before retrying.`, false, true);
        }
        return { requestDispatched: true, serverAcceptanceObserved: false, correlationAttemptId: attemptId, activation: activation?.strategy || "dom-click",
          ...(confirmationEvidence ? { per_run_confirmation: confirmationEvidence } : {}) };
      } catch (error) {
        if (clickDelivered && error && typeof error === "object" && error.outcome_unknown !== false) error.outcome_unknown = true;
        throw error;
      } finally {
        tiles.disarmNativeFlowCorrelation(attemptId);
      }
    }
    async execute(name, payload = {}, command = {}) {
      const nav = root.FlowNavigation;
      const editor = root.FlowEditor;
      const settings = root.FlowSettings;
      const components = root.FlowComponents;
      const tiles = root.FlowTiles;
      const menu = root.FlowMediaMenu;
      const agent = root.FlowAgent;
      if (name === "flow.frame.extract_last") {
        const sourcePrefix = String(payload.assetName || payload.name || "").trim();
        if (!sourcePrefix) throw this.error("FLOW_INVALID_ARGUMENT", "Video title is required to extract a chain frame.");
        const deadline = this.workflowDeadline(command, 90_000);
        await agent.closeNativeAgentSession();
        const activeAgent = root.flowButton?.("Agent");
        if (activeAgent?.getAttribute("aria-pressed") === "true") await agent.setNativeAgentMode(false);
        await nav.ensureFlowLibrarySection("All media", { deadline });
        const assets = await menu.scanNativeAssets({ deadline });
        const matches = assets.filter(asset => asset.kind === "video" && asset.name.toLowerCase().startsWith(sourcePrefix.toLowerCase()));
        if (matches.length > 1) throw this.error("FLOW_AMBIGUOUS_ASSET", `${matches.length} videos begin with "${sourcePrefix}". Use the exact title.`, false, false);
        const source = matches[0];
        if (!source) throw this.error("FLOW_VIDEO_NOT_FOUND", `No video beginning "${sourcePrefix}" exists in the project.`, false, false);
        const tile = await tiles.findFlowTile(source.name);
        if (!tile || !tile.querySelector("flow-video-tile")) throw this.error("FLOW_VIDEO_NOT_FOUND", `Video "${source.name}" is no longer visible.`, false, false);
        tile.scrollIntoView({ block: "center" }); tile.click();
        await nav.waitForFlowRoute(path => /\/edit\//i.test(path), Math.min(30_000, Math.max(1, deadline - Date.now())), "Flow did not open the source video editor.");
        const seek = await root.waitForEnabledFlowButton?.("Skip to next clip", Math.min(30_000, Math.max(1, deadline - Date.now())));
        if (!seek) throw this.error("FLOW_TIMELINE_MISSING", "The source video timeline is not ready.", false, false);
        seek.click();
        await this.waitWorkflow(deadline, 1800, "seeking to the source clip's final frame");
        const save = await root.waitForEnabledFlowButton?.("Save frame", Math.min(10_000, Math.max(1, deadline - Date.now())));
        if (!save) throw this.error("FLOW_SAVE_FRAME_MISSING", "Flow did not show Save frame.", false, false);
        save.click();
        await this.waitWorkflow(deadline, 2500, "saving the source clip's final frame");
        const back = root.flowButton?.("Back button to go to previous page");
        if (!back) throw this.error("FLOW_EDIT_BACK_MISSING", "Flow saved the frame, but its Back control is unavailable.", false, true);
        back.click();
        await nav.waitForFlowRoute(path => !/\/edit(?:\/|$)/i.test(path), Math.min(20_000, Math.max(1, deadline - Date.now())), "Flow did not return to the project after saving the last frame.", { deadline });
        await nav.ensureFlowLibrarySection("All media", { deadline });
        const title = `Saved frame from ${source.name}`;
        const frame = await tiles.findFlowTile(title, 200);
        if (!frame) throw this.error("FLOW_FRAME_NOT_FOUND", `Flow did not add the saved frame "${title}".`, false, true);
        const rawId = root.mediaId?.(frame);
        const id = await root.resolveNativeMediaUuid?.(rawId, "image") || rawId;
        this.validateContinuationReferenceIds(id);
        return { title, id, source: source.name, kind: "image" };
      }
      if (name === "flow.character.create") {
        if (typeof root.FlowCharacterActions?.create !== "function") throw this.error("NATIVE_CAPABILITY_UNSUPPORTED", "Flow character creation actions are not loaded in this tab. Reload the extension and Flow tab, then retry.", true);
        return root.FlowCharacterActions.create(payload, command);
      }
      if (name === "flow.character.edit") {
        if (typeof root.FlowCharacterActions?.edit !== "function") throw this.error("NATIVE_CAPABILITY_UNSUPPORTED", "Flow character editing actions are not loaded in this tab. Reload the extension and Flow tab, then retry.", true);
        return root.FlowCharacterActions.edit(payload, command);
      }

      if (name === "flow.edit.run") {
        const params = payload.job?.params || payload.params || {};
        const deadline = this.workflowDeadline(command, params.submit_only ? 120_000 : 12 * 60_000);
        const source = String(params.edit_asset || "").trim();
        if (!source) throw this.error("FLOW_INVALID_ARGUMENT", "Video title is required.");
        await agent.closeNativeAgentSession();
        const activeAgent = root.flowButton?.("Agent");
        if (activeAgent?.getAttribute("aria-pressed") === "true") await agent.setNativeAgentMode(false);
        await nav.ensureFlowLibrarySection("All media", { deadline });
        const assets = await menu.scanNativeAssets({ deadline });
        const matches = assets.filter(a => a.kind === "video" && a.name.toLowerCase().startsWith(source.toLowerCase()));
        if (matches.length > 1) throw this.error("FLOW_AMBIGUOUS_ASSET", `${matches.length} videos begin with "${source}"; no edit was started. Use the full title from flow_assets.`, true, false);
        const found = matches[0];
        if (!found) throw this.error("FLOW_VIDEO_NOT_FOUND", `No video beginning "${source}" exists in the project. Use flow_assets to list titles.`, true);
        await tiles.stabilizeFlowResultViewport({ deadline, signal: command.signal });
        const before = tiles.collectNativeMedia().map(item => item.id || `title:${item.title}`);
        const tile = await tiles.findFlowTile(found.name);
        if (!tile || !tile.querySelector("flow-video-tile")) throw this.error("FLOW_VIDEO_NOT_FOUND", `Video "${found.name}" is no longer visible in the project.`, true);
        tile.scrollIntoView({ block: "center" }); tile.click();
        await nav.waitForFlowRoute(path => /\/edit\//i.test(path), Math.min(30_000, Math.max(1, deadline - Date.now())), "Flow did not open the video editor.");
        const box = await editor.preflightGenerationPrompt(params, false);
        if (!box) throw this.error("FLOW_COMPOSER_MISSING", "Flow's edit prompt is not visible.", true);
        const prompt = String(params.prompt || "").replace(/\s*\n+\s*/g, " ").trim();
        if (!await editor.insertNativeFlowPrompt(box, prompt)) throw this.error("FLOW_PROMPT_INPUT_UNCONFIRMED", "Flow did not accept the video edit prompt. Nothing was submitted.", true);
        await this.waitWorkflow(deadline, 500, "preparing the Flow edit prompt");
        let submitted = false;
        try {
          const evidence = await this.submitAndConfirmDispatch({
            editor, tiles, command, prompt, expectedQuantity: 1,
            expectedReferenceIds: found.id && /^[0-9a-f-]{36}$/i.test(found.id) ? [found.id] : [],
            deadline,
          });
          submitted = true;
          if (params.submit_only === true) return { ...evidence, submitted: true, before, type: "video", expectedCount: 1, media: [], trustedGesture: false };
          await tiles.waitForNativeEditorCompletion(command, Number(params.timeout_ms || 10 * 60000), "video edit");
          const back = root.flowButton?.("Back button to go to previous page");
          if (!back) throw this.error("FLOW_EDIT_BACK_MISSING", "Flow finished the video edit, but its Back control is unavailable. The result remains in Flow.", true, true);
          back.click();
          await nav.waitForFlowRoute(path => !/\/edit(?:\/|$)/i.test(path), 20000, "Flow finished the edit but did not return to the project.");
          await nav.ensureFlowLibrarySection("All media");
          await tiles.stabilizeFlowResultViewport({ deadline, signal: command.signal });
          const results = await tiles.waitForProgressResult(command, before, 1, "video", 90000);
          return { media: results, trustedGesture: false, ...evidence };
        } catch (error) {
          if (submitted && error && typeof error === "object") error.outcome_unknown = true;
          throw error;
        }
      }

      if (name === "flow.agent.batch") {
        const runAgentBatchPass = async (params, command, deadline, before) => {
      const nav = root.FlowNavigation, editor = root.FlowEditor, tiles = root.FlowTiles, agent = root.FlowAgent;
      let submitted = false, outcomeUnknown = false, submitOnlyDispatched = false;
      try {
        await agent.closeNativeAgentSession();
        const activeAgent = root.flowButton?.("Agent");
        if (activeAgent?.getAttribute("aria-pressed") === "true") await agent.setNativeAgentMode(false);
        await nav.ensureFlowLibrarySection("All media", { deadline });
        await agent.setNativeAgentMode(true);
        const agentSettingsEvidence = await agent.setNativeAgentSettings("Always", params.aspect_ratio || "16:9");
        await root.FlowSettings?.chooseNativeModel?.("Nano Banana", "image", { deadline });
        const box = agent.getNativeAgentPromptEditor();
        if (!box) throw this.error("FLOW_AGENT_COMPOSER_MISSING", "Flow's Agent composer is not visible.", true);
        const scenes = params.agent_scenes || [];
        const sceneText = scenes.map((scene, index) => `Scene ${index + 1}: ${String(scene).replace(/\s+/g, " ").trim()}`).join("\n");
        const script = `Generate exactly ${scenes.length} separate images: one image for each scene below, in the listed scene order. Do not combine scenes into a collage or a single image. Images only, never video. ${params.aspect_ratio || "16:9"} aspect ratio. Do not ask questions; generate them now.\n${sceneText}`;
        root.setEditable?.(box, script);
        await this.waitWorkflow(deadline, 300, "entering the Flow Agent batch prompt");
        const preflight = { ...this.verifyAgentBatchPreflight({ editor, box, prompt: script }), agent_settings: agentSettingsEvidence };
        const evidence = await this.submitAndConfirmDispatch({
          editor, tiles, command, prompt: script, mediaType: "image", expectedQuantity: scenes.length, deadline,
          checkConfirmation: () => agent.inspectAgentRunConfirmation(),
        });
        submitted = true;
        if (params.submit_only === true) {
          submitOnlyDispatched = true;
          return { ...evidence, preflight, submitted: true, before, type: "image", expectedCount: scenes.length, media: [], prompts: [], trustedGesture: false };
        }
        let media, partialFailure = false, failedMedia = [];
        try {
          const remaining = Math.max(1, Math.min(Number(params.timeout_ms || 1800000), deadline - Date.now()));
          media = await tiles.waitForProgressResult(command, before, scenes.length, "image", remaining, "flow-grid-tile-container", true);
        } catch (error) {
          if (error?.code !== "FLOW_GENERATION_FAILED" || error?.outcome_unknown !== false
            || !Array.isArray(error.partialMedia) || !Array.isArray(error.failedMedia)) throw error;
          media = error.partialMedia;
          failedMedia = error.failedMedia;
          partialFailure = true;
        }
        const prompts = [];
        for (const item of media) {
          const scroller = tiles.flowMediaGridScrollContainer?.();
          if (scroller) scroller.scrollTop = 0;
          await root.wait?.(250);
          let targetTile;
          for (let step = 0; step < 160 && !targetTile; step++) {
            targetTile = [...document.querySelectorAll("flow-grid-tile-container")].find(c =>
              item.id && !item.id.startsWith("title:") ? root.mediaId?.(c) === item.id : c.getAttribute("aria-label") === item.title);
            if (!targetTile && scroller) {
              const top = scroller.scrollTop, max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
              if (top >= max - 2) break;
              scroller.scrollTop = Math.min(max, top + Math.max(200, scroller.clientHeight * 0.78));
              await root.wait?.(250);
            }
          }
          if (!targetTile) { prompts.push(""); continue; }
          targetTile.scrollIntoView({ block: "center" });
          targetTile.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
          await root.wait?.(250);
          const reuse = root.flowButton?.("Reuse prompt", targetTile);
          if (!reuse) { prompts.push(""); continue; }
          reuse.click();
          await root.wait?.(550);
          prompts.push(agent.getNativeAgentPromptEditor()?.innerText || "");
          const close = root.flowButton?.("Close");
          if (close && root.flowButton?.("Start new session")) { close.click(); await root.wait?.(350); }
        }
        const clear = root.flowButton?.("Clear prompt");
        if (clear) clear.click();
        return { ...evidence, preflight, before, type: "image", expectedCount: scenes.length, media, prompts, ...(partialFailure ? { partial: true, failedMedia } : {}), trustedGesture: false };
      } catch (error) {
        outcomeUnknown = Boolean(error?.outcome_unknown) || submitted;
        throw error;
      } finally {
        if (!outcomeUnknown && !submitOnlyDispatched) {
          const session = root.flowButton?.("Start new session");
          if (session) { const close = root.flowButton?.("Close"); if (close) { close.click(); await root.wait?.(500); } }
          try { await agent.setNativeAgentSettings("Always"); } catch {}
          await agent.setNativeAgentMode(false).catch(() => {});
          const clear = root.flowButton?.("Clear prompt"); if (clear) clear.click();
        }
      }
    }

        const params = payload.job?.params || payload.params || {};
        const deadline = this.workflowDeadline(command, params.submit_only ? 120_000 : 32 * 60_000);
        const scenes = params.agent_scenes || [];
        if (!scenes.length) throw this.error("FLOW_INVALID_ARGUMENT", "agent_scenes is required.");
        const baseScene = Number(String(params.file_stem || "scene-01").match(/\d+/)?.[0] || 1);
        const sceneNumbers = Array.isArray(params.agent_numbers) && params.agent_numbers.length === scenes.length
          ? params.agent_numbers.map(Number)
          : scenes.map((_, index) => baseScene + index);
        const sceneMedia = new Map();
        let pending = scenes.map((_, index) => index);
        await tiles.stabilizeFlowResultViewport({ deadline, signal: command.signal });
        let before = tiles.collectNativeMedia().map(item => item.id || `title:${item.title}`);
        let dispatchEvidence = {};
        let latestPreflight;
        let failedMedia = [];

        for (let pass = 0; pass < 3 && pending.length; pass++) {
          const requested = pending.slice();
          const passParams = {
            ...params,
            agent_scenes: requested.map(index => scenes[index]),
            agent_numbers: requested.map(index => sceneNumbers[index]),
          };
          const result = await this.runAgentBatchPass(passParams, command, deadline, before);
          dispatchEvidence = result;
          latestPreflight = result.preflight;
          if (params.submit_only === true) {
            return {
              ...result,
              before,
              type: "image",
              expectedCount: scenes.length,
              media: [], prompts: [],
              sceneNumbers: [],
              requestedSceneNumbers: sceneNumbers,
              failedScenes: [],
              trustedGesture: false,
            };
          }
          const media = Array.isArray(result.media) ? result.media : [];
          const prompts = Array.isArray(result.prompts) ? result.prompts : [];
          if (media.length > requested.length || media.some(item => item?.kind !== "image")) {
            throw this.error("FLOW_AGENT_RESULT_INVALID", "Flow Agent returned invalid image results. Check the project before retrying.", false, true);
          }
          if (media.length < requested.length && (result.partial !== true || !Array.isArray(result.failedMedia)
            || result.failedMedia.length < requested.length - media.length)) {
            throw this.error("FLOW_AGENT_RESULT_INVALID", "Flow Agent returned an incomplete result without a confirmed failure. Check the project before retrying.", false, true);
          }
          failedMedia = result.failedMedia || [];

          const matches = prompts.length === media.length
            ? this.agentSceneMatches(requested.map(index => scenes[index]), prompts)
            : requested.map(() => []);
          const mediaScenes = new Map();
          const usedScenes = new Set();
          matches.forEach((mediaIndexes, localSceneIndex) => {
            const mediaIndex = mediaIndexes.find(index => !mediaScenes.has(index));
            if (mediaIndex !== undefined) {
              mediaScenes.set(mediaIndex, localSceneIndex);
              usedScenes.add(localSceneIndex);
            }
          });
          for (let mediaIndex = 0; mediaIndex < media.length; mediaIndex++) {
            if (mediaScenes.has(mediaIndex)) continue;
            const localSceneIndex = requested.findIndex((_, index) => !usedScenes.has(index));
            if (localSceneIndex >= 0) {
              mediaScenes.set(mediaIndex, localSceneIndex);
              usedScenes.add(localSceneIndex);
            }
          }
          for (const [mediaIndex, localSceneIndex] of mediaScenes) {
            const sceneIndex = requested[localSceneIndex];
            if (sceneIndex !== undefined && !sceneMedia.has(sceneIndex)) sceneMedia.set(sceneIndex, media[mediaIndex]);
          }
          pending = scenes.map((_, index) => index).filter(index => !sceneMedia.has(index));
          if (pending.length && result.partial !== true) {
            throw this.error("FLOW_AGENT_RESULT_INVALID", "Flow Agent did not confirm that remaining scenes failed safely. Inspect the project before retrying.", false, true);
          }
          if (pending.length && pass < 2) {
            tiles.emitFlowProgress?.(command, `Flow Agent confirmed partial failure; retrying ${pending.length} unmatched scene(s), pass ${pass + 2}/3`);
            await tiles.stabilizeFlowResultViewport({ deadline, signal: command.signal });
            before = tiles.collectNativeMedia().map(item => item.id || `title:${item.title}`);
          }
        }

        // Preserve the legacy per-scene fallback only after Flow Agent has
        // explicitly confirmed partial failures for all three bounded passes.
        // The normal submit/observe operations provide a fresh media snapshot
        // and request-correlation receipt for every fallback image.
        const confirmedFallbackFailures = [];
        if (pending.length && params.submit_only !== true) {
          await agent.closeNativeAgentSession();
          const activeAgent = root.flowButton?.("Agent");
          if (activeAgent?.getAttribute("aria-pressed") === "true") await agent.setNativeAgentMode(false);

          for (const sceneIndex of pending) {
            let generated = false;
            for (let attempt = 0; attempt < 2; attempt++) {
              this.requireWorkflowTime(deadline, `generating fallback for scene ${sceneNumbers[sceneIndex]}`);
              tiles.emitFlowProgress?.(command, `Flow Agent missed scene ${sceneNumbers[sceneIndex]}; using standard image generation (attempt ${attempt + 1}/2)`);
              try {
                const submit = await this.driver.executeOperation("flow.generation.submit", {
                  type: "image",
                  prompt: scenes[sceneIndex],
                  model: "Nano Banana",
                  aspectRatio: params.aspect_ratio || "16:9",
                  variants: 1,
                  maxCredits: 0,
                  submitOnly: false,
                }, command);
                if (submit?.requestDispatched !== true || !submit.correlationAttemptId || !Array.isArray(submit.before)) {
                  throw this.error("FLOW_SUBMIT_UNCONFIRMED", "Flow did not return a correlated dispatch receipt for the fallback image. Inspect Flow before retrying.", false, true);
                }
                const observed = await this.driver.executeOperation("flow.generation.observe", {
                  before: submit.before,
                  kind: "image",
                  expectedCount: 1,
                  correlationAttemptId: submit.correlationAttemptId,
                  timeoutMs: Math.max(1000, Math.min(Number(params.timeout_ms || 12 * 60_000), deadline - Date.now())),
                  retries: 0,
                }, command);
                const fallbackMedia = Array.isArray(observed?.media) ? observed.media : [];
                if (fallbackMedia.length !== 1 || fallbackMedia[0]?.kind !== "image") {
                  throw this.error("FLOW_GENERATION_RESULT_INVALID", "Flow did not return exactly one correlated fallback image. Inspect the project before retrying.", false, true);
                }
                sceneMedia.set(sceneIndex, fallbackMedia[0]);
                generated = true;
                break;
              } catch (error) {
                const confirmedFailure = error?.code === "FLOW_GENERATION_FAILED" && error?.outcome_unknown === false;
                if (!confirmedFailure) throw error;
                if (attempt === 1) confirmedFallbackFailures.push(sceneIndex);
              }
            }
            if (generated) {
              tiles.emitFlowProgress?.(command, `Fallback image completed for scene ${sceneNumbers[sceneIndex]}`);
            }
          }
        }

        const ordered = [...sceneMedia.entries()].sort((a, b) => a[0] - b[0]);
        const media = ordered.map(([, item]) => item);
        const mediaSceneNumbers = ordered.map(([sceneIndex]) => sceneNumbers[sceneIndex]);
        const mediaPrompts = ordered.map(([sceneIndex]) => scenes[sceneIndex]);
        const remainingFailures = pending.filter(index => confirmedFallbackFailures.includes(index));
        return {
          ...dispatchEvidence,
          preflight: latestPreflight,
          before,
          type: "image",
          expectedCount: scenes.length,
          media,
          prompts: mediaPrompts,
          sceneNumbers: mediaSceneNumbers,
          requestedSceneNumbers: sceneNumbers,
          ...(remainingFailures.length ? { partial: true, failedMedia, failedScenes: remainingFailures.map(index => sceneNumbers[index]) } : { failedScenes: [] }),
          trustedGesture: false,
        };
      }

      if (name === "flow.continue.run") {
        const params = payload.job?.params || payload.params || {};
        const deadline = this.workflowDeadline(command, params.submit_only ? 120_000 : 15 * 60_000);
        const sourcePrefix = String(params.continue_from || "").trim();
        if (!sourcePrefix) throw this.error("FLOW_INVALID_ARGUMENT", "Video title is required.");
        const likeness = params.continue_mode === "likeness";
        if (likeness && (!Array.isArray(params.attach) || !params.attach.length)) throw this.error("FLOW_INVALID_ARGUMENT", "Likeness continuation requires at least one character or avatar attachment.", true);
        await agent.closeNativeAgentSession();
        const activeAgent = root.flowButton?.("Agent");
        if (activeAgent?.getAttribute("aria-pressed") === "true") await agent.setNativeAgentMode(false);
        await nav.ensureFlowLibrarySection("All media", { deadline });
        const assets = await menu.scanNativeAssets({ deadline });
        const matches = assets.filter(a => a.kind === "video" && a.name.toLowerCase().startsWith(sourcePrefix.toLowerCase()));
        if (matches.length > 1) throw this.error("FLOW_AMBIGUOUS_ASSET", `${matches.length} videos begin with "${sourcePrefix}"; no continuation was started. Use the full title from flow_assets.`, true, false);
        const source = matches[0];
        if (!source) throw this.error("FLOW_VIDEO_NOT_FOUND", `No video beginning "${sourcePrefix}" exists in the project. Use flow_assets to list titles.`, true);
        await tiles.stabilizeFlowResultViewport({ deadline, signal: command.signal });
        const before = tiles.collectNativeMedia().map(item => item.id || `title:${item.title}`);
        let submitted = false;
        let outcomeUnknown = false;
        let submitOnlyDispatched = false;
        try {
          const tile = await tiles.findFlowTile(source.name);
          if (!tile || !tile.querySelector("flow-video-tile")) throw this.error("FLOW_VIDEO_NOT_FOUND", `Video "${source.name}" is no longer visible in the project.`, true);
          tile.scrollIntoView({ block: "center" }); tile.click();
          await nav.waitForFlowRoute(path => /\/edit\//i.test(path), Math.min(30_000, Math.max(1, deadline - Date.now())), "Flow did not open the source video editor.");
          await root.waitForEnabledFlowButton?.("Skip to next clip", Math.min(30_000, Math.max(1, deadline - Date.now()))).then(btn => {
            if (!btn) throw this.error("FLOW_TIMELINE_MISSING", "The source video timeline is not ready.", true);
            btn.click();
          });
          await this.waitWorkflow(deadline, 1800, "seeking to the source clip's final frame");
          const save = await root.waitForEnabledFlowButton?.("Save frame", Math.min(10_000, Math.max(1, deadline - Date.now())));
          if (!save) throw this.error("FLOW_SAVE_FRAME_MISSING", "Flow did not show Save frame.", true);
          save.click(); await this.waitWorkflow(deadline, 2500, "saving the source clip's final frame");
          const back = root.flowButton?.("Back button to go to previous page");
          if (!back) throw this.error("FLOW_EDIT_BACK_MISSING", "Flow saved the frame, but its Back control is unavailable.", true, true);
          back.click();
          await nav.waitForFlowRoute(path => !/\/edit(?:\/|$)/i.test(path), Math.min(20_000, Math.max(1, deadline - Date.now())), "Flow did not return to the project after saving the last frame.", { deadline });
          await nav.ensureFlowLibrarySection("All media", { deadline });
          await tiles.stabilizeFlowResultViewport({ deadline, signal: command.signal });

          const frameTitle = `Saved frame from ${source.name}`;
          const frame = await tiles.findFlowTile(frameTitle, 200);
          if (!frame) throw this.error("FLOW_FRAME_NOT_FOUND", `Flow did not add the saved frame "${frameTitle}".`, false, true);
          const rawFrameId = root.mediaId?.(frame);
          const frameId = await root.resolveNativeMediaUuid?.(rawFrameId, "image") || rawFrameId;
          this.validateContinuationReferenceIds(frameId);
          frame.scrollIntoView({ block: "center" });
          frame.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); await root.wait?.(250);
          const more = root.flowButton?.("More options", frame);
          if (!more) throw this.error("FLOW_TILE_MENU_MISSING", "Could not open the saved frame menu.", true);
          more.click(); await root.wait?.(350);
          const animateAliases = root.I18n?.getPatterns?.("animate") || ["Animate", "Tạo hiệu ứng động", "Làm chuyển động"];
          const animateOptions = [...document.querySelectorAll('[role="menuitem"],button,[role="button"]')].filter(el => {
            if (!root.visible?.(el) || el.disabled || el.getAttribute?.("aria-disabled") === "true") return false;
            const label = root.normalizeFlowUiText?.(root.accessibleName?.(el) || el.innerText || el.textContent || "") || "";
            return animateAliases.some(alias => label === (root.normalizeFlowUiText?.(alias) || String(alias).toLowerCase()));
          });
          if (animateOptions.length !== 1) throw this.error(animateOptions.length ? "FLOW_ANIMATE_AMBIGUOUS" : "FLOW_ANIMATE_MISSING", "Flow did not show one unique Animate action for the saved frame.", true);
          const animate = animateOptions[0];
          animate.click();
          const generationButton = await root.waitForEnabledFlowButton?.("Start generation", 15000);
          if (!generationButton) throw this.error("FLOW_CONTINUATION_COMPOSER_NOT_READY", "Flow did not show its generation control after opening Animate for the saved frame.", true);
          const box = agent.getNativeAgentPromptEditor();
          if (!box) throw this.error("FLOW_COMPOSER_MISSING", "Flow's continuation composer is not visible.", true);

          await agent.setNativeAgentMode(true);
          const selectedReferenceIds = [];
          if (likeness) {
            for (const reference of params.attach || []) {
              const value = String(reference || "").replace(/^asset:/i, "").trim();
              if (!value) throw this.error("FLOW_INVALID_ARGUMENT", "Likeness continuation contains an empty attachment; nothing was submitted.", true);
              const selected = await components.chooseNativePickerAsset(value, undefined, { deadline });
              if (selected?.id && /^[0-9a-f-]{36}$/i.test(selected.id)) selectedReferenceIds.push(selected.id);
            }
          }
          await agent.setNativeAgentSettings("Always", params.aspect_ratio || "16:9");
          const cast = (params.attach || []).join(" and ");
          const exact = !likeness;
          const prompt = `${exact
            ? `Use I2V, Flow's first frame animation tool. The attached frame is the FIRST FRAME of this clip: begin exactly on it, with the same framing, lighting, colours, wardrobe and set, and continue from there with no cut, as an unbroken continuation of the shot it came from. Do not use any other reference.`
            : `Use R2V, reference-to-video, with the attached frame and ${cast || "the attached reference"} both as references, so the look and the person stay consistent through the clip. Open as close to the attached frame as you can.`} ${params.prompt || ""}`;
          const activeBox = agent.getNativeAgentPromptEditor();
          if (!activeBox || !root.replaceNativeEditableText?.(activeBox, prompt)) throw this.error("FLOW_PROMPT_INPUT_UNCONFIRMED", "Flow did not accept the continuation prompt. Nothing was submitted.", true);
          const expectedReferenceIds = this.validateContinuationReferenceIds(frameId, selectedReferenceIds, likeness ? (params.attach || []).length : 0);
          const evidence = await this.submitAndConfirmDispatch({
            editor, tiles, command, prompt, expectedQuantity: 1,
            expectedReferenceIds,
            deadline,
            afterClick: () => agent.resolveNativeAgentQuestion(command, exact
              ? "Use I2V, first frame animation. Start exactly on that frame and continue from it with no cut. Do not use the other reference."
              : "Use R2V, reference-to-video, using both attached references so the person stays consistent."),
          });
          submitted = true;
          if (params.submit_only === true) {
            submitOnlyDispatched = true;
            return { ...evidence, submitted: true, before, type: "video", expectedCount: 1, media: [], trustedGesture: false };
          }
          const resultMedia = await tiles.waitForProgressResult(command, before, 1, "video", Number(params.timeout_ms || 720000));
          return { media: resultMedia, trustedGesture: false, ...evidence };
        } catch (error) {
          outcomeUnknown = Boolean(error?.outcome_unknown) || submitted;
          if (submitted && error && typeof error === "object") error.outcome_unknown = true;
          throw error;
        } finally {
          if (!outcomeUnknown && !submitOnlyDispatched) await agent.resetNativeAgentWorkflow().catch(() => {});
        }
      }
      return undefined;
    }
  }
  root.FlowWorkflowOperations = FlowWorkflowOperations;
})(globalThis);
