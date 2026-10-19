// Flow character workflows. Shared DOM helpers are provided by dom-actions.js.
(() => {
  "use strict";

  const characterRoute = path => /\/character(?:\/|$)/i.test(path || "");
  const newCharacterRoute = path => /\/character\/?$/i.test(path || "");
  const characterEditorRoute = path => /\/character\/[0-9a-f-]{36}(?:\/|$)/i.test(path || "");
  const normalize = value => String(value || "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
  const exactEditable = (el, value) => {
    const current = el?.value !== undefined ? el.value : el?.innerText ?? el?.textContent;
    return String(current || "").replace(/\s+/g, " ").trim() === String(value || "").replace(/\s+/g, " ").trim();
  };
  const visibleOptions = list => [...(list?.querySelectorAll('[role="option"]') || [])].filter(visible);
  function clickFlowControl(element) {
    const rect = element?.getBoundingClientRect();
    if (!rect?.width || !rect.height) return false;
    const point = { bubbles: true, cancelable: true, composed: true, button: 0, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
    element.dispatchEvent(new PointerEvent("pointerdown", { ...point, pointerId: 1, pointerType: "mouse" }));
    element.dispatchEvent(new MouseEvent("mousedown", point));
    element.dispatchEvent(new PointerEvent("pointerup", { ...point, pointerId: 1, pointerType: "mouse" }));
    element.dispatchEvent(new MouseEvent("mouseup", point));
    element.dispatchEvent(new MouseEvent("click", point));
    return true;
  }

  async function waitForPicker(listGetter, label, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    let stableAt = 0;
    while (Date.now() < deadline) {
      const list = listGetter();
      const loading = [...document.querySelectorAll('[role="progressbar"],[aria-busy="true"]')].some(visible);
      if (list && !loading) {
        if (visibleOptions(list).length || /no (?:assets|voices) found/i.test(list.innerText || "")) return list;
        if (!stableAt) stableAt = Date.now();
        if (Date.now() - stableAt >= 700) return list;
      } else stableAt = 0;
      await wait(150);
    }
    throw flowError("FLOW_PICKER_LOADING", `Flow's ${label} picker did not finish loading. Nothing was selected.`, true);
  }

  async function waitForCharacterCreateButton(timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    const enabled = el => visible(el) && !el.disabled && el.getAttribute("aria-disabled") !== "true";
    const semanticCreateButton = () => {
      for (const tile of document.querySelectorAll("flow-custom-tile")) {
        if (!visible(tile)) continue;
        const hasAddIcon = [...tile.querySelectorAll("mat-icon")].some(icon => normalize(icon.innerText || icon.textContent) === "add");
        const tileText = normalize(cleanCharacterName(tile.innerText || tile.textContent || ""));
        if (!hasAddIcon || !/(?:new character|nhân vật mới)/i.test(tileText)) continue;
        const button = [...tile.querySelectorAll('button,[role="button"],a[href]')].find(enabled);
        if (button) return button;
      }
      return null;
    };
    const isCreateAction = el => {
      const label = normalize(cleanCharacterName(accessibleName(el).replace(/\s+/g, " ").trim()))
        .replace(/^add\s+(?=new character$)/, "");
      return /^(?:new character|create character|create new character|add character|add a character|nhân vật mới)$/.test(label);
    };
    while (Date.now() < deadline) {
      const button = semanticCreateButton() || [...document.querySelectorAll('button,[role="button"],a[href]')].find(el => enabled(el) && isCreateAction(el));
      if (button) return button;
      await wait(150);
    }
    return null;
  }

  function pickerScroller(list) {
    return [list, ...list.querySelectorAll("*")].find(el => el.clientHeight > 0 && el.scrollHeight > el.clientHeight + 5) || null;
  }

  function optionNames(option) {
    const nodes = [...option.querySelectorAll("[aria-label],[title],img[alt],flow-grid-tile-container")];
    return [accessibleName(option), option.getAttribute("aria-label"), option.getAttribute("title"),
      ...nodes.flatMap(node => [node.getAttribute("aria-label"), node.getAttribute("title"), node.getAttribute("alt")])]
      .map(value => String(value || "").replace(/\s+/g, " ").trim()).filter(Boolean);
  }

  function optionKey(option) {
    const media = option.querySelector("flow-grid-tile-container,[data-media-id],[data-id]");
    const image = option.querySelector("img");
    return media?.getAttribute("data-media-id") || media?.getAttribute("data-id") || media?.id || image?.currentSrc || image?.src ||
      `${normalize(accessibleName(option))}|${normalize(option.innerText)}`;
  }

  async function findPickerMatches(listGetter, title, label, match = value => normalize(value) === normalize(title)) {
    let list = await waitForPicker(listGetter, label);
    const search = [...document.querySelectorAll('input,[role="textbox"]')]
      .find(el => visible(el) && /search (?:assets|voices)/i.test(accessibleName(el)));
    if (search) {
      setEditable(search, title);
      await wait(550);
      list = await waitForPicker(listGetter, label);
    }

    const matches = new Map();
    const scroller = pickerScroller(list);
    const maxPages = scroller ? 120 : 1;
    for (let page = 0; page < maxPages; page++) {
      list = await waitForPicker(listGetter, label, 5000);
      for (const option of visibleOptions(list)) {
        if (optionNames(option).some(match)) matches.set(optionKey(option), option);
      }
      if (!scroller || scroller.scrollTop >= scroller.scrollHeight - scroller.clientHeight - 2) break;
      const previous = scroller.scrollTop;
      scroller.scrollTop = Math.min(scroller.scrollHeight - scroller.clientHeight, previous + Math.max(120, scroller.clientHeight * 0.75));
      await wait(200);
      if (scroller.scrollTop === previous) break;
    }
    return [...matches.values()];
  }

  async function closeCurrentCharacterRoute() {
    if (newCharacterRoute(location.pathname)) {
      const back = await waitForEnabledFlowButton("Go back", 3000);
      if (!back) throw flowError("FLOW_CHARACTER_BACK_MISSING", "Flow's New character page has no Go back control; the current character form remains open.", true, true);
      back.click();
      await waitForFlowRoute(path => !newCharacterRoute(path), 15_000, "Flow did not leave the New character page.");
    } else if (characterEditorRoute(location.pathname)) {
      const done = await waitForEnabledFlowButton("Done", 3000) || await waitForEnabledFlowButton("Done editing", 1000);
      if (!done) throw flowError("FLOW_CHARACTER_SAVE_MISSING", "Flow's character editor has no save/close control; the character may be partially saved.", false, true);
      done.click();
      await waitForFlowRoute(path => !characterRoute(path), 15_000, "Flow did not close the character editor.");
    }
  }

  async function ensureCharacterLibrary() {
    await closeCurrentCharacterRoute();
    await ensureFlowLibrarySection("Characters");
    if (characterRoute(location.pathname)) {
      throw flowError("FLOW_CHARACTER_ROUTE_UNEXPECTED", "Flow is still on a character form or editor instead of the Characters library.", true, true);
    }
  }

  async function findCharacterTiles(name) {
    const wanted = normalize(cleanCharacterName(name));
    const found = new Map();
    const scroller = scrollContainer();
    if (scroller) scroller.scrollTop = 0;
    const readyDeadline = Date.now() + 15_000;
    let stableAt = 0;
    while (Date.now() < readyDeadline) {
      const loading = [...document.querySelectorAll('[role="progressbar"],[aria-busy="true"]')].some(visible);
      const hasTiles = [...document.querySelectorAll("flow-character-tile")].some(visible);
      if (hasTiles && !loading) break;
      if (!loading && !hasTiles) {
        if (!stableAt) stableAt = Date.now();
        if (Date.now() - stableAt >= 700) break;
      } else stableAt = 0;
      await wait(150);
    }
    for (let page = 0; page < 120; page++) {
      for (const tile of document.querySelectorAll("flow-character-tile")) {
        if (!visible(tile)) continue;
        const actual = normalize(cleanCharacterName((tile.innerText || "").split("\n")[0] || tile.getAttribute("aria-label") || ""));
        if (actual === wanted) found.set(tile.getAttribute("data-id") || tile.id || actual + "|" + (tile.querySelector("img")?.src || ""), tile);
      }
      if (!scroller || scroller.scrollTop >= scroller.scrollHeight - scroller.clientHeight - 2) break;
      const previous = scroller.scrollTop;
      scroller.scrollTop = Math.min(scroller.scrollHeight - scroller.clientHeight, previous + Math.max(120, scroller.clientHeight * 0.75));
      await wait(200);
      if (scroller.scrollTop === previous) break;
    }
    return [...found.values()];
  }

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
      await closeCurrentCharacterRoute();
      const activeAgent = flowButton("Agent");
      if (activeAgent?.getAttribute("aria-pressed") === "true") await setNativeAgentMode(false);
      if (localImage) {
        if (!validStagedLocalImage(localImage, /character/)) throw flowError("FLOW_TRANSFER_UNKNOWN", "The local character image transfer is invalid or no longer staged.", true);
        const file = stagedNativeFiles.get(localImage.transferId);
        if (!file) throw flowError("FLOW_TRANSFER_UNKNOWN", "The staged character image is no longer available.", true);
      } else {
        await ensureFlowLibrarySection("All media");
      }
      if (!c.image) {
        if (!document.querySelector(".ProseMirror")) throw flowError("NATIVE_CAPABILITY_UNSUPPORTED", "Flow's image composer is unavailable for description-based character creation.", true);
        if (scrollContainer()) scrollContainer().scrollTop = 0;
        const before = collectNativeMedia().map(item => item.id || `title:${item.title}`);
        const variants = Math.max(1, Math.min(4, Number(c.variants || 1)));
        const clear = flowButton("Clear prompt"); if (clear) clear.click();
        const settingsCreditCost = await globalThis.FlowImageActions.prepareCharacterPortrait(c, variants);
        const box = document.querySelector(".ProseMirror");
        if (!box || !(await insertNativeFlowPrompt(box, String(c.describe)))) throw flowError("FLOW_PROMPT_INPUT_UNCONFIRMED", "Flow's portrait prompt was not accepted. Nothing was submitted.", true);
        await wait(300);
        const renderedCreditCost = await waitForGenerationCreditQuote(Number.isFinite(settingsCreditCost) ? 1500 : 8000);
        const creditCost = Number.isFinite(renderedCreditCost) ? renderedCreditCost : settingsCreditCost;
        if (!Number.isFinite(creditCost)) throw flowError("FLOW_CREDIT_QUOTE_UNAVAILABLE", "Flow did not show the portrait's credit quote after the prompt was prepared. Nothing was submitted.", true);
        if (creditCost > 0) throw flowError("NATIVE_CAPABILITY_UNSUPPORTED", `Flow quotes ${creditCost} credits for the portrait; character creation only proceeds when it is free. Nothing was submitted.`, true);
        const start = await waitForEnabledFlowButton("Start generation", 8000);
        if (!start) throw flowError("FLOW_SUBMIT_DISABLED", "Flow's portrait generation button did not become ready within 8 seconds; nothing was submitted.", true);
        await activateFlowSubmitButton(start);
        const generated = await waitForProgressResult(command, before, variants, "image", Number(payload.timeoutMs || 180000), "main");
        if (!generated.length) throw flowError("FLOW_CHARACTER_PORTRAIT_MISSING", "Flow did not return a portrait image for character creation.", false, true);
        sourceTitle = generated[0].title;
        portraitMedia = generated[0];
      }

      let characterUrl = "";
      let enteredEditor = false;
      try {
        await ensureFlowLibrarySection("Characters");
        let newPage = newCharacterRoute(location.pathname);
        if (!newPage) {
          const create = await waitForCharacterCreateButton(10_000);
          if (!create) throw flowError("FLOW_CHARACTER_CREATE_MISSING", "Flow's Characters library does not show New character.", true);
          create.click();
          await waitForFlowRoute(path => newCharacterRoute(path), 15_000, "Flow did not open the New character page.");
          newPage = true;
        }
        if (!newPage) throw flowError("FLOW_CHARACTER_ROUTE_UNEXPECTED", "Flow did not reach the New character page.", true, true);

        if (localImage) {
          const file = stagedNativeFiles.get(localImage.transferId);
          const upload = await waitForEnabledFlowButton("Upload", 15_000);
          if (!upload) throw flowError("FLOW_CHARACTER_UPLOAD_MISSING", "Flow's New character page does not show Upload. Nothing was selected.", true, false);
          try {
            await FlowNativeFileTransfer.selectFileThroughPicker(file, async () => {
              const currentUpload = await waitForEnabledFlowButton("Upload", 4000);
              return currentUpload ? clickFlowControl(currentUpload) : false;
            });
          } catch (error) {
            throw flowError("FLOW_CHARACTER_UPLOAD_FAILED", `Flow did not accept the staged character image: ${String(error?.message || error)}. Nothing was submitted.`, true, false);
          }
          await waitForFlowRoute(path => characterEditorRoute(path), 90_000, "Flow did not open the character editor after the image upload.");
        } else {
          const add = await waitForEnabledFlowButton("Add from project", 15_000);
          if (!add) throw flowError("FLOW_CHARACTER_CREATE_MISSING", "Flow's New character page is not ready.", true);
          add.click();
          const listGetter = () => [...document.querySelectorAll('[role="listbox"]')].find(visible);
          let list = await waitForPicker(listGetter, "project asset");
          const exactTitle = value => normalize(value) === normalize(sourceTitle);
          let matches = await findPickerMatches(listGetter, sourceTitle, "project asset", exactTitle);
          if (!matches.length) {
            const uploads = [...document.querySelectorAll('[role="tab"]')].find(el => visible(el) && normalize(accessibleName(el)) === "uploads");
            if (uploads) {
              uploads.click();
              list = await waitForPicker(listGetter, "uploaded asset");
              matches = await findPickerMatches(listGetter, sourceTitle, "uploaded asset", exactTitle);
            }
          }
          if (matches.length > 1) throw flowError("FLOW_ASSET_AMBIGUOUS", `More than one project image is titled "${sourceTitle}"; no image was selected.`);
          if (!matches.length) throw flowError("FLOW_ASSET_NOT_FOUND", `No exact project image titled "${sourceTitle}" is available for the character; no image was selected.`);
          matches[0].click();
          const addMedia = await waitForEnabledFlowButton("Add media", 10_000);
          if (!addMedia) throw flowError("FLOW_ADD_MEDIA_MISSING", "Flow did not show Add media for the selected portrait.", true);
          addMedia.click();
          await waitForFlowRoute(path => characterEditorRoute(path), 90_000, "Flow did not open the character editor.");
        }
        enteredEditor = true;
        characterUrl = location.href;

        const nameInput = [...document.querySelectorAll('input,[role="textbox"]')].find(el => visible(el) && /Character name/i.test(accessibleName(el)));
        if (!nameInput) throw flowError("FLOW_CHARACTER_FORM_MISSING", "Flow's character name field is not visible; the character may be partially created.", false, true);
        setEditable(nameInput, c.name);
        nameInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        const nameDeadline = Date.now() + 5000;
        while (Date.now() < nameDeadline && !exactEditable(nameInput, c.name)) await wait(100);
        if (!exactEditable(nameInput, c.name)) throw flowError("FLOW_CHARACTER_NAME_UNCONFIRMED", "Flow did not accept the requested character name; the character may be partially created.", false, true);

        if (c.personality) {
          const personality = [...document.querySelectorAll('textarea,input,[role="textbox"]')].find(el => visible(el) && /Character personality/i.test(accessibleName(el)));
          if (!personality) throw flowError("FLOW_CHARACTER_PERSONALITY_MISSING", "Flow's character personality field is unavailable; the character may be partially created.", false, true);
          setEditable(personality, c.personality);
          const deadline = Date.now() + 5000;
          while (Date.now() < deadline && !exactEditable(personality, c.personality)) await wait(100);
          if (!exactEditable(personality, c.personality)) throw flowError("FLOW_CHARACTER_PERSONALITY_UNCONFIRMED", "Flow did not accept the requested character personality; the character may be partially created.", false, true);
        }

        if (c.voice) {
          const selectVoice = flowButton("Select a voice");
          if (!selectVoice) throw flowError("FLOW_VOICE_SELECTOR_MISSING", "The character editor does not show Select a voice; the character may be partially created.", false, true);
          selectVoice.click();
          const voicesGetter = () => [...document.querySelectorAll('[role="listbox"]')].find(visible);
          await waitForPicker(voicesGetter, "voice");
          const voiceMatch = value => {
            const actual = normalize(value), wanted = normalize(c.voice);
            return actual === wanted || actual.startsWith(`${wanted} (`) || actual.startsWith(`${wanted} `);
          };
          const voiceOptions = await findPickerMatches(voicesGetter, String(c.voice), "voice", voiceMatch);
          if (voiceOptions.length > 1) throw flowError("FLOW_VOICE_AMBIGUOUS", `More than one voice matches "${c.voice}"; the character may be partially created.`, false, true);
          if (!voiceOptions.length) {
            const available = visibleOptions(voicesGetter()).map(el => accessibleName(el).replace(/\s+/g, " ").trim());
            throw flowError("FLOW_VOICE_NOT_FOUND", `Voice "${c.voice}" not found. Character may be partially created. Visible voices: ${available.join("; ")}`, false, true);
          }
          voiceOptions[0].click();
          const addVoice = await waitForEnabledFlowButton("Add to character", 8000);
          if (!addVoice) throw flowError("FLOW_VOICE_ADD_MISSING", "Flow did not show Add to character; the character may be partially created.", false, true);
          addVoice.click();
          const voiceDeadline = Date.now() + 5000;
          let voiceConfirmed = false;
          while (Date.now() < voiceDeadline) {
            const selectedText = [...document.querySelectorAll("button,[role=button],[role=status], [aria-label]")]
              .filter(visible).map(el => `${accessibleName(el)} ${el.innerText || ""}`);
            voiceConfirmed = selectedText.some(value => normalize(value).includes(normalize(c.voice))) && !flowButton("Add to character");
            if (voiceConfirmed) break;
            await wait(150);
          }
          if (!voiceConfirmed) throw flowError("FLOW_VOICE_UNCONFIRMED", `Flow did not confirm voice "${c.voice}" on the character; the character may be partially created.`, false, true);
        }

        const done = await waitForEnabledFlowButton("Done", 10_000) || await waitForEnabledFlowButton("Done editing", 1000);
        if (!done) throw flowError("FLOW_CHARACTER_SAVE_MISSING", "Flow has not presented a Done button; character may be partially created.", false, true);
        done.click();
        await waitForFlowRoute(path => !characterRoute(path), 15_000, "Flow did not save and close the character editor.");
        enteredEditor = false;
        await ensureFlowLibrarySection("Characters");
        const saved = await findCharacterTiles(c.name);
        if (saved.length > 1) throw flowError("FLOW_CHARACTER_AMBIGUOUS", `Flow saved more than one character named "${c.name}"; verify the Characters library.`, false, true);
        if (!saved.length) throw flowError("FLOW_CHARACTER_SAVE_UNCONFIRMED", `Flow closed the editor but the Characters library does not show "${c.name}". Check Flow before retrying.`, false, true);
        const clear = flowButton("Clear prompt"); if (clear) clear.click();
        return { name: c.name, url: characterUrl || location.href, portraitMedia, trustedGesture: false };
      } finally {
        if (newCharacterRoute(location.pathname)) {
          const back = flowButton("Go back");
          if (back) { back.click(); await wait(500); }
        } else if (enteredEditor && characterEditorRoute(location.pathname)) {
          const done = flowButton("Done") || flowButton("Done editing");
          if (done) { done.click(); await wait(500); }
        }
        await ensureFlowLibrarySection("All media").catch(() => {});
      }
    },

    edit: async (payload = {}, command = {}) => {
      const characterName = String(payload.name || "");
      await closeNativeAgentSession();
      await ensureCharacterLibrary();
      const activeAgent = flowButton("Agent");
      if (activeAgent?.getAttribute("aria-pressed") === "true") await setNativeAgentMode(false);
      const matches = await findCharacterTiles(characterName);
      if (matches.length > 1) throw flowError("FLOW_CHARACTER_AMBIGUOUS", `More than one character is named "${characterName}". No character was opened.`);
      const target = matches[0];
      if (!target) throw flowError("FLOW_CHARACTER_NOT_FOUND", `No character called "${characterName}". Use flow_characters to list them.`, true);
      target.scrollIntoView({ block: "center" }); target.click();
      await waitForFlowRoute(path => characterEditorRoute(path), 20_000, `Flow did not open character "${characterName}".`);
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
        if (!done) throw flowError("FLOW_CHARACTER_SAVE_MISSING", "Flow's character editor has no Done control; the character may be partially saved.", false, true);
        done.click();
        await waitForFlowRoute(path => !characterRoute(path), 15_000, "Flow did not close the character editor.");
        return { name: characterName, downloadTriggered, note: downloadTriggered ? undefined : "The character was saved in Flow, but its portrait download button was unavailable.", trustedGesture: false };
      } finally {
        if (characterEditorRoute(location.pathname)) {
          const done = flowButton("Done") || flowButton("Done editing");
          if (done) done.click();
          await wait(500);
        }
        await ensureFlowLibrarySection("All media").catch(() => {});
        const clear = flowButton("Clear prompt"); if (clear) clear.click();
      }
    },
  });
})();
