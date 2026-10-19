// Flow character workflows. Shared DOM helpers are provided by dom-actions.js.
globalThis.FlowCharacterActions = Object.freeze({
  create: async (payload = {}, command = {}) => {
    const c = payload.character || payload.job?.params || payload;
    if (!c.name) throw flowError("FLOW_INVALID_ARGUMENT", "Character name is required.");
    const localImage = c.image && typeof c.image === "object" ? c.image : null;
    if (c.image && !localImage && !String(c.image).startsWith("asset:")) throw flowError("FLOW_INVALID_ARGUMENT", "Character image must be a project asset or a staged local image.");
    if (!c.image && !c.describe) throw flowError("FLOW_INVALID_ARGUMENT", "Pass an existing project image with image='asset:<title>' or provide describe.");
    let sourceTitle = c.image && !localImage ? String(c.image).replace(/^asset:/, "").trim() : "";
    let portraitMedia;
    await closeNativeAgentSession();
    await ensureFlowLibrarySection("All media");
    const activeAgent = flowButton("Agent");
    if (activeAgent?.getAttribute("aria-pressed") === "true") await setNativeAgentMode(false);
    if (localImage) {
      if (!validStagedLocalImage(localImage, /character/)) throw flowError("FLOW_TRANSFER_UNKNOWN", "The local character image transfer is invalid or no longer staged.", true);
      const file = stagedNativeFiles.get(localImage.transferId);
      if (!file) throw flowError("FLOW_TRANSFER_UNKNOWN", "The staged character image is no longer available.", true);
      await uploadStagedFlowMedia(file, "image", command);
      sourceTitle = localImage.name;
    }
    if (!c.image) {
      // Match the backend's description-first behavior: make one portrait image, then
      // use that project asset to create the reusable character. Require a zero-credit
      // quote because the existing flow_character contract treats this portrait as free.
      if (!document.querySelector(".ProseMirror")) throw flowError("NATIVE_CAPABILITY_UNSUPPORTED", "Flow's image composer is unavailable for description-based character creation.", true);
      if (scrollContainer()) scrollContainer().scrollTop = 0;
      const before = collectNativeMedia().map(item => item.id || `title:${item.title}`);
      const variants = Math.max(1, Math.min(4, Number(c.variants || 1)));
      if (flowButton("Clear prompt")) flowButton("Clear prompt").click();
      const settingsCreditCost = await globalThis.FlowImageActions.prepareCharacterPortrait(c, variants);
      const box = document.querySelector(".ProseMirror");
      if (!box || !(await insertNativeFlowPrompt(box, String(c.describe)))) throw flowError("FLOW_PROMPT_INPUT_UNCONFIRMED", "Flow's portrait prompt was not accepted. Nothing was submitted.", true);
      await wait(300);
      const renderedCreditCost = await waitForGenerationCreditQuote(Number.isFinite(settingsCreditCost) ? 1500 : 8000);
      const creditCost = Number.isFinite(renderedCreditCost) ? renderedCreditCost : settingsCreditCost;
      if (!Number.isFinite(creditCost)) throw flowError("FLOW_CREDIT_QUOTE_UNAVAILABLE", "Flow did not show the portrait's credit quote after the prompt was prepared. Nothing was submitted.", true);
      if (creditCost > 0) throw flowError("NATIVE_CAPABILITY_UNSUPPORTED", `Flow quotes ${creditCost} credits for the portrait; the established character workflow only proceeds when it is free. Nothing was submitted.`, true);
      const start = await waitForEnabledFlowButton("Start generation", 8000);
      if (!start) throw flowError("FLOW_SUBMIT_DISABLED", "Flow's portrait generation button did not become ready within 8 seconds; nothing was submitted.", true);
      await activateFlowSubmitButton(start);
      const generated = await waitForProgressResult(command, before, variants, "image", Number(payload.timeoutMs || 180000), "main");
      sourceTitle = generated[0].title;
      portraitMedia = generated[0];
    }
    let characterUrl = "";
    try {
      await ensureFlowLibrarySection("Characters");
      const create = await waitForEnabledFlowButton("New character", 10_000);
      if (create) {
        create.click();
        await waitForFlowRoute(path => /\/character\/?$/i.test(path), 15_000, "Flow did not open the new character page.");
      }
      const add = await waitForEnabledFlowButton("Add from project", 15_000);
      if (!add) throw flowError("FLOW_CHARACTER_CREATE_MISSING", "Flow's new character page is not ready.", true);
      add.click(); await wait(300);
      const list = [...document.querySelectorAll('[role="listbox"]')].find(visible);
      if (!list) throw flowError("FLOW_ASSET_PICKER_MISSING", "Flow's project asset picker did not open.", true);
      const title = sourceTitle;
      const findExactOption = () => {
        const matches = [...list.querySelectorAll('[role="option"]')].filter(el => {
          if (!visible(el)) return false;
          const names = [accessibleName(el), el.getAttribute("aria-label"), el.getAttribute("title"),
            ...[...el.querySelectorAll("[aria-label],[title],img[alt],flow-grid-tile-container")].flatMap(node => [node.getAttribute("aria-label"), node.getAttribute("title"), node.getAttribute("alt")])];
          return names.some(value => String(value || "").replace(/\s+/g, " ").trim().toLocaleLowerCase() === title.toLocaleLowerCase());
        });
        if (matches.length > 1) throw flowError("FLOW_ASSET_AMBIGUOUS", `More than one exact match for project image "${title}"; no image was selected.`);
        return matches[0] || null;
      };
      let option = findExactOption();
      if (!option) {
        const uploads = [...document.querySelectorAll('[role="tab"]')].find(el => visible(el) && accessibleName(el).trim() === "Uploads");
        if (uploads) { uploads.click(); await wait(300); option = findExactOption(); }
      }
      if (!option) throw flowError("FLOW_ASSET_NOT_FOUND", `No exact project image titled "${title}" is available for the character; no image was selected.`);
      option.click(); await wait(250);
      const addMedia = await waitForEnabledFlowButton("Add media", 8000);
      if (!addMedia) throw flowError("FLOW_ADD_MEDIA_MISSING", "Flow did not show Add media.", true);
      addMedia.click();
      await waitForFlowRoute(path => /\/character\/[0-9a-f-]{36}(?:\/|$)/i.test(path), 90_000, "Flow did not open the character editor.");
      characterUrl = location.href;
      const nameInput = [...document.querySelectorAll('input,[role="textbox"]')].find(el => visible(el) && /Character name/i.test(accessibleName(el)));
      if (!nameInput) throw flowError("FLOW_CHARACTER_FORM_MISSING", "Flow's character name field is not visible.", false, true);
      setEditable(nameInput, c.name); nameInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      if (c.personality) {
        const personality = [...document.querySelectorAll('textarea,input,[role="textbox"]')].find(el => visible(el) && /Character personality/i.test(accessibleName(el)));
        if (personality) setEditable(personality, c.personality);
      }
      if (c.voice) {
        const selectVoice = flowButton("Select a voice");
        if (!selectVoice) throw flowError("FLOW_VOICE_SELECTOR_MISSING", "The character editor does not show Select a voice; character may be partially created.", false, true);
        selectVoice.click(); await wait(350);
        const voices = [...document.querySelectorAll('[role="listbox"]')].find(visible);
        if (!voices) throw flowError("FLOW_VOICE_PICKER_MISSING", "Flow's voice picker did not open; character may be partially created.", false, true);
        const voiceOption = [...voices.querySelectorAll('[role="option"]')].find(el => visible(el) && accessibleName(el).toLowerCase().startsWith(String(c.voice).toLowerCase()));
        if (!voiceOption) {
          const available = [...voices.querySelectorAll('[role="option"]')].filter(visible).map(el => accessibleName(el).replace(/\s+/g, " ").trim());
          const close = [...document.querySelectorAll('[role="dialog"] button')].find(el => visible(el) && accessibleName(el).trim() === "Close");
          if (close) close.click();
          throw flowError("FLOW_VOICE_NOT_FOUND", `Voice "${c.voice}" not found. Character may be created without a voice. Available: ${available.join("; ")}`, false, true);
        }
        voiceOption.click(); await wait(250);
        const addVoice = flowButton("Add to character");
        if (!addVoice) throw flowError("FLOW_VOICE_ADD_MISSING", "Flow did not show Add to character; character may be partially created.", false, true);
        addVoice.click(); await wait(500);
      }
      const done = await waitForEnabledFlowButton("Done", 10_000) || await waitForEnabledFlowButton("Done editing", 1000);
      if (!done) throw flowError("FLOW_CHARACTER_SAVE_MISSING", "Flow has not presented a Done button; character may be partially created.", false, true);
      done.click();
      await waitForFlowRoute(path => !/\/character(?:\/|$)/i.test(path), 15_000, "Flow did not save and close the character editor.");
      await wait(500);
      const clear = flowButton("Clear prompt"); if (clear) clear.click();
      return { name: c.name, url: characterUrl || location.href, portraitMedia, trustedGesture: false };
    } finally {
      if (/\/character(?:\/|$)/i.test(location.pathname)) {
        const done = flowButton("Done") || flowButton("Done editing");
        if (done) done.click();
        await wait(500);
      }
      await ensureFlowLibrarySection("All media").catch(() => {});
    }
  },
  edit: async (payload = {}, command = {}) => {
    const characterName = String(payload.name || "");
    const normalize = value => cleanCharacterName(String(value || "")).toLocaleLowerCase();
    const tileName = tile => normalize((tile.innerText || "").split("\n")[0] || tile.getAttribute("aria-label") || "");
    await closeNativeAgentSession();
    await ensureFlowLibrarySection("Characters");
    const activeAgent = flowButton("Agent");
    if (activeAgent?.getAttribute("aria-pressed") === "true") await setNativeAgentMode(false);
    const findTarget = () => [...document.querySelectorAll("flow-character-tile")].filter(el => visible(el) && tileName(el) === normalize(characterName));
    let matches = findTarget();
    if (matches.length > 1) throw flowError("FLOW_CHARACTER_AMBIGUOUS", `More than one character is named "${characterName}". No character was opened.`);
    const target = matches[0];
    if (!target) throw flowError("FLOW_CHARACTER_NOT_FOUND", `No character called "${characterName}". Use flow_characters to list them.`, true);
    target.scrollIntoView({ block: "center" }); target.click();
    await waitForFlowRoute(path => /\/character\/[0-9a-f-]{36}(?:\/|$)/i.test(path), 20_000, `Flow did not open character "${characterName}".`);
    await wait(500);
    try {
      let portrait = document.querySelector('img[aria-label="Generated character image"]');
      if (payload.change) {
        const box = [...document.querySelectorAll(".ProseMirror")].at(-1);
        if (!box) throw flowError("FLOW_CHARACTER_EDITOR_MISSING", "Character editor prompt is not visible.", true);
        const beforeSrc = portrait?.getAttribute("src");
        const change = String(payload.change).replace(/\s*\n+\s*/g, " ").trim().replace(/[.\s]*$/, ".");
        const prompt = `${change} Exactly one ${characterName} in the picture: never add copies of ${characterName} or extra poses side by side.`;
        if (!replaceNativeEditableText(box, prompt)) throw flowError("FLOW_PROMPT_INPUT_UNCONFIRMED", "Flow did not accept the character edit prompt. Nothing was submitted.", true);
        const start = await waitForEnabledFlowButton("Start generation", 8000);
        if (!start) throw flowError("FLOW_SUBMIT_DISABLED", "Flow's character edit button is disabled.", true);
        await activateFlowSubmitButton(start);
        const deadline = Date.now() + Number(payload.timeoutMs || 4 * 60_000);
        while (Date.now() < deadline) {
          await wait(2500); portrait = document.querySelector('img[aria-label="Generated character image"]');
          const pct = (document.querySelector("main")?.innerText || "").match(/\d+%/)?.[0];
          emitFlowProgress(command, pct || "Waiting for character portrait");
          if (portrait?.getAttribute("src") && portrait.getAttribute("src") !== beforeSrc && !pct) break;
        }
        if (!portrait?.getAttribute("src") || portrait.getAttribute("src") === beforeSrc) throw flowError("FLOW_CHARACTER_EDIT_TIMEOUT", "Timed out waiting for Flow to redraw the character. Check Flow before retrying.", false, true);
      }
      let downloadTriggered = false;
      const picture = document.querySelector('img[aria-label="Generated character image"]');
      if (picture) {
        picture.scrollIntoView({ block: "center" });
        const rect = picture.getBoundingClientRect();
        for (let attempt = 0; attempt < 3 && !downloadTriggered; attempt++) {
          picture.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, pointerId: 1, pointerType: "mouse" }));
          picture.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }));
          await wait(300);
          const download = flowButton("Download image");
          if (download) { download.click(); downloadTriggered = true; }
        }
      }
      const done = flowButton("Done") || flowButton("Done editing");
      if (done) done.click();
      await waitForFlowRoute(path => !/\/character(?:\/|$)/i.test(path), 15_000, "Flow did not close the character editor.");
      return { name: characterName, downloadTriggered, note: downloadTriggered ? undefined : "The character was saved in Flow, but its portrait download button was unavailable.", trustedGesture: false };
    } finally {
      if (/\/character(?:\/|$)/i.test(location.pathname)) {
        const done = flowButton("Done") || flowButton("Done editing");
        if (done) done.click();
        await wait(500);
      }
      await ensureFlowLibrarySection("All media").catch(() => {});
      const clear = flowButton("Clear prompt"); if (clear) clear.click();
    }
  },
});
