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
      return undefined;
    }
  }
  root.FlowWorkflowOperations = FlowWorkflowOperations;
})(globalThis);
