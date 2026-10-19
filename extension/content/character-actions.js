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
      const box = document.querySelector(".ProseMirror");
      if (!box) throw flowError("NATIVE_CAPABILITY_UNSUPPORTED", "Flow's image composer is unavailable for description-based character creation.", true);
      const before = collectNativeMedia().map(item => item.id || `title:${item.title}`);
      const variants = Math.max(1, Math.min(4, Number(c.variants || 1)));
      const agent = flowButton("Agent"); if (agent?.getAttribute("aria-pressed") === "true") agent.click();
      if (flowButton("Clear prompt")) flowButton("Clear prompt").click();
      const settingsCreditCost = await globalThis.FlowImageActions.prepareCharacterPortrait(c, variants);
      setEditable(box, String(c.describe)); await wait(300);
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
    const nav = clickFlowNavigation("Characters"); if (!nav && !document.querySelector("flow-character-tile")) throw flowError("FLOW_NAV_UNAVAILABLE", "Flow's Characters navigation is unavailable.", true);
    await wait(700);
    const create = flowButton("New character"); if (create) create.click();
    await wait(800);
    const add = flowButton("Add from project"); if (!add) throw flowError("FLOW_CHARACTER_CREATE_MISSING", "Flow's new character page is not ready.", true);
    add.click(); await wait(300);
    const list = document.querySelector('[role="listbox"]');
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
      const uploads = [...document.querySelectorAll('[role="tab"]')].find(el => accessibleName(el).trim() === "Uploads");
      if (uploads) { uploads.click(); await wait(300); option = findExactOption(); }
    }
    if (!option) throw flowError("FLOW_ASSET_NOT_FOUND", `No exact project image titled "${title}" is available for the character; no image was selected.`);
    option.click(); await wait(250);
    const addMedia = flowButton("Add media"); if (!addMedia) throw flowError("FLOW_ADD_MEDIA_MISSING", "Flow did not show Add media.", true);
    addMedia.click(); await wait(900);
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
      const voices = document.querySelector('[role="listbox"]');
      if (!visible(voices)) throw flowError("FLOW_VOICE_PICKER_MISSING", "Flow's voice picker did not open; character may be partially created.", false, true);
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
    const done = [...document.querySelectorAll("button,[role=button]")].find(el => visible(el) && /^Done( editing)?$/i.test(accessibleName(el).trim()));
    if (!done) throw flowError("FLOW_CHARACTER_SAVE_MISSING", "Flow has not presented a Done button; character may be partially created.", false, true);
    done.click(); await wait(700);
    return { name: c.name, url: location.href, portraitMedia, trustedGesture: false };
  },
  edit: async (payload = {}, command = {}) => {
    const characterName = String(payload.name || "");
    const card = [...document.querySelectorAll("flow-character-tile")].find(el => visible(el) && (el.innerText || "").includes(characterName));
    if (!card) { clickFlowNavigation("Characters"); await wait(600); }
    const target = card || [...document.querySelectorAll("flow-character-tile")].find(el => visible(el) && (el.innerText || "").includes(characterName));
    if (!target) throw flowError("FLOW_CHARACTER_NOT_FOUND", `No visible character named "${characterName}".`, true);
    target.click(); await wait(800);
    let portrait = document.querySelector('img[aria-label="Generated character image"]');
    if (payload.change) {
      const box = [...document.querySelectorAll(".ProseMirror")].at(-1);
      if (!box) throw flowError("FLOW_CHARACTER_EDITOR_MISSING", "Character editor prompt is not visible.", true);
      const beforeSrc = portrait?.getAttribute("src");
      const prompt = `${String(payload.change).replace(/[.\s]*$/, ".")} Exactly one ${characterName} in the picture; never add copies or extra poses side by side.`;
      setEditable(box, prompt); const start = flowButton("Start generation");
      if (!start || start.disabled) throw flowError("FLOW_SUBMIT_DISABLED", "Flow's character edit button is disabled.", true);
      await activateFlowSubmitButton(start);
      const deadline = Date.now() + Number(payload.timeoutMs || 300000);
      while (Date.now() < deadline) {
        await wait(2500); portrait = document.querySelector('img[aria-label="Generated character image"]');
        const pct = (document.querySelector("main")?.innerText || "").match(/\d+%/)?.[0];
        emitFlowProgress(command, pct || "Waiting for character portrait");
        if (portrait?.getAttribute("src") && portrait.getAttribute("src") !== beforeSrc && !pct) break;
      }
      if (!portrait?.getAttribute("src") || portrait.getAttribute("src") === beforeSrc) throw flowError("FLOW_CHARACTER_EDIT_TIMEOUT", "Timed out waiting for the character portrait. Check Flow before retrying.", false, true);
    }
    let downloadTriggered = false;
    const picture = document.querySelector('img[aria-label="Generated character image"]');
    if (picture) {
      picture.scrollIntoView({ block: "center" });
      picture.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); await wait(250);
      const download = flowButton("Download image");
      if (download) { download.click(); downloadTriggered = true; }
    }
    const done = [...document.querySelectorAll("button,[role=button]")].find(el => visible(el) && /^Done( editing)?$/i.test(accessibleName(el).trim()));
    if (done) done.click();
    return { name: characterName, downloadTriggered, note: downloadTriggered ? undefined : "The character was saved in Flow, but its portrait download button was unavailable.", trustedGesture: false };
  },
});
