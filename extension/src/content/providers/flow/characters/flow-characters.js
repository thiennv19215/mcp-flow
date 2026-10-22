// Flow character workflows. Shared DOM helpers are provided by dom-actions.js.
(() => {
  "use strict";

  const root = typeof globalThis !== "undefined" ? globalThis : (typeof window !== "undefined" ? window : self);
  const characterRoute = path => /\/character(?:\/|$)/i.test(path || "");
  const newCharacterRoute = path => /\/character\/?$/i.test(path || "");
  const characterEditorRoute = path => /\/character\/[0-9a-f-]{36}(?:\/|$)/i.test(path || "");
  const normalize = value => String(value || "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
  const exactEditable = (el, value) => {
    const current = el?.value !== undefined ? el.value : el?.innerText ?? el?.textContent;
    return String(current || "").replace(/\s+/g, " ").trim() === String(value || "").replace(/\s+/g, " ").trim();
  };
  let lastCharacterNameDiagnostics = null;
  function characterNameSnapshot(input, stage, requested) {
    const value = input?.value ?? input?.innerText ?? input?.textContent ?? "";
    const form = input?.closest?.("form") || null;
    const headingElements = typeof document === "undefined" ? [] : ((typeof root.flowQueryAll === "function" ? root.flowQueryAll("common.headings", document, { checkVisible: false }) : null) || [...document.querySelectorAll("h1,h2,[role=heading]")]);
    const headings = headingElements
      .filter(el => visible(el)).map(el => normalize(el.innerText || el.textContent)).filter(Boolean).slice(0, 4);
    return {
      stage,
      route: typeof location === "undefined" ? null : location.pathname,
      requested: String(requested || "").slice(0, 60),
      field: input ? {
        tag: input.tagName?.toLowerCase() || null,
        type: input.type || null,
        id: input.id || null,
        name: input.name || null,
        ariaLabel: input.getAttribute?.("aria-label") || null,
        placeholder: input.getAttribute?.("placeholder") || null,
        value: String(value).slice(0, 80),
        defaultValue: String(input.defaultValue || "").slice(0, 80),
        connected: input.isConnected === true,
        invalid: input.getAttribute?.("aria-invalid") || null,
        formText: form ? normalize(form.innerText || form.textContent).slice(0, 180) : null,
      } : null,
      headings,
    };
  }
  function attachCharacterNameDiagnostics(error, diagnostics = lastCharacterNameDiagnostics) {
    if (error && diagnostics) error.diagnostics = redactCharacterNameDiagnostics(diagnostics);
    return error;
  }
  function safeMatchCount(value) {
    return Number.isInteger(value) && value >= 0 ? value : null;
  }
  function characterNameLibraryEvidence(requestedMatches, previousMatches, scanComplete = true) {
    const requested = safeMatchCount(requestedMatches);
    const previous = safeMatchCount(previousMatches);
    const complete = scanComplete === true && requested !== null && previous !== null;
    return {
      scan_complete: complete,
      requested_name_matches: requested,
      previous_name_matches: previous,
      confirmed: complete && requested === 1 && previous === 0,
    };
  }
  function redactCharacterNameDiagnostics(diagnostics = {}) {
    const save = diagnostics.save_response || {};
    const library = diagnostics.library_result || save.library_scan || null;
    const entryConfirmed = diagnostics.field_value_confirmed === true;
    const clickSent = diagnostics.save_clicked === true || save.click_sent === true;
    const routeExited = diagnostics.route_exited === true || save.route_exited === true;
    const requested = safeMatchCount(library?.requested_matches ?? library?.requested_name_matches);
    const previous = safeMatchCount(library?.original_matches ?? library?.previous_name_matches);
    return {
      stage: library ? "post_save_library_verification" : entryConfirmed ? "name_entry_confirmed" : "name_entry",
      name_entry_confirmed: entryConfirmed,
      save_clicked: clickSent,
      route_exited: routeExited,
      library_scan: library ? {
        scan_complete: library.scan_complete !== false && requested !== null && previous !== null,
        requested_name_matches: requested,
        previous_name_matches: previous,
        confirmed: library.confirmed === true,
      } : null,
    };
  }
  function recordCharacterNameSaveResponse(response) {
    const scan = response?.library_scan || null;
    lastCharacterNameDiagnostics = {
      ...(lastCharacterNameDiagnostics || {}),
      save_clicked: response?.click_sent === true || lastCharacterNameDiagnostics?.save_clicked === true,
      route_exited: response?.route_exited === true || lastCharacterNameDiagnostics?.route_exited === true,
      library_result: scan ? {
        scan_complete: scan.scan_complete !== false,
        requested_matches: safeMatchCount(scan.requested_matches),
        original_matches: safeMatchCount(scan.original_matches),
        confirmed: scan.confirmed === true,
      } : lastCharacterNameDiagnostics?.library_result,
      save_response: {
        control_present: Boolean(response?.control_label),
        click_sent: response?.click_sent === true,
        route_exited: response?.route_exited === true,
        library_scan: scan ? {
          scan_complete: scan.scan_complete !== false,
          requested_matches: safeMatchCount(scan.requested_matches),
          original_matches: safeMatchCount(scan.original_matches),
          confirmed: scan.confirmed === true,
        } : null,
      },
    };
    return redactCharacterNameDiagnostics(lastCharacterNameDiagnostics);
  }
  async function commitCharacterName(input, value) {
    const diagnostics = { before: characterNameSnapshot(input, "before_input", value) };
    setEditable(input, value);
    diagnostics.after_input = characterNameSnapshot(input, "after_input", value);
    input.blur?.();
    await wait(800);
    diagnostics.after_blur = characterNameSnapshot(input, "after_blur", value);
    diagnostics.field_value_confirmed = exactEditable(input, value);
    lastCharacterNameDiagnostics = diagnostics;
    if (!diagnostics.field_value_confirmed || input.isConnected === false || input.getAttribute?.("aria-invalid") === "true") {
      const error = flowError("FLOW_CHARACTER_NAME_UNCONFIRMED", "Flow did not confirm the requested name in its character editor before save; the character name was not saved.", false, false);
      throw attachCharacterNameDiagnostics(error, diagnostics);
    }
    return true;
  }
  const visibleOptions = list => {
    const options = (typeof root.flowQueryAll === "function" ? root.flowQueryAll("components.optionItem", list) : null) ||
      [...(list?.querySelectorAll('[role="option"]') || [])];
    return options.filter(visible);
  };
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
      const loading = (typeof root.flowQueryVisible === "function" && Boolean(root.flowQueryVisible("common.loadingIndicator", document))) ||
        [...document.querySelectorAll('[role="progressbar"],[aria-busy="true"]')].some(visible);
      if (list && !loading) {
        if (visibleOptions(list).length || /no (?:assets|voices) found|(?:không tìm thấy|không có) (?:tài sản|nội dung|giọng nói|giọng|kết quả)(?: nào)?/i.test(list.innerText || "")) return list;
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
      const customTiles = (typeof root.flowQueryAll === "function" ? root.flowQueryAll("characters.createTile", document, { checkVisible: false }) : null) ||
        document.querySelectorAll("flow-custom-tile");
      for (const tile of customTiles) {
        if (!visible(tile)) continue;
        const icons = (typeof root.flowQueryAll === "function" ? root.flowQueryAll("common.icons", tile, { checkVisible: false }) : null) ||
          [...tile.querySelectorAll("mat-icon")];
        const hasAddIcon = icons.some(icon => normalize(icon.innerText || icon.textContent) === "add");
        const tileText = normalize(cleanCharacterName(tile.innerText || tile.textContent || ""));
        if (!hasAddIcon || !/(?:new character|nhân vật mới|tạo nhân vật)/i.test(tileText)) continue;
        const button = [...tile.querySelectorAll('button,[role="button"],a[href]')].find(enabled);
        if (button) return button;
      }
      return null;
    };
    const isCreateAction = el => {
      const label = normalize(cleanCharacterName(accessibleName(el).replace(/\s+/g, " ").trim()))
        .replace(/^add\s+(?=new character$)/, "");
      return /^(?:new character|create character|create new character|add character|add a character|nhân vật mới|tạo nhân vật|thêm nhân vật)$/.test(label);
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
    const search = (typeof root.flowQueryVisible === "function" ? root.flowQueryVisible("characters.searchInput", document) : null) ||
      [...document.querySelectorAll('input,[role="textbox"]')]
        .find(el => visible(el) && /search (?:assets|voices)|tìm kiếm/i.test(accessibleName(el) || el.placeholder || ""));
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
      await leaveNewCharacterPage();
    } else if (characterEditorRoute(location.pathname)) {
      const done = await waitForEnabledFlowButton("Done", 3000) || await waitForEnabledFlowButton("Done editing", 1000);
      if (!done) throw flowError("FLOW_CHARACTER_SAVE_MISSING", "Flow's character editor has no save/close control; the character may be partially saved.", false, true);
      done.click();
      await waitForFlowRoute(path => !characterRoute(path), 15_000, "Flow did not close the character editor.");
    }
  }

  async function leaveNewCharacterPage() {
    const back = await waitForEnabledFlowButton("Go back", 3000) ||
      await waitForEnabledFlowButton("Back", 1000) ||
      await waitForEnabledFlowButton("Quay lại", 1000);
    if (back) {
      back.click();
      if (await waitForFlowRoute(path => !newCharacterRoute(path), 5000, "Flow did not leave the New character page.").catch(() => false)) return true;
    }
    // Flow sometimes renders the route before its button; its navigation helper can recover through project root.
    await root.FlowNavigation?.leaveFlowDetailView?.().catch(() => {});
    if (newCharacterRoute(location.pathname)) {
      await root.FlowNavigation?.ensureFlowProjectEditor?.().catch(() => {});
    }
    if (newCharacterRoute(location.pathname)) {
      throw flowError("FLOW_CHARACTER_BACK_MISSING", "Flow's New character page did not leave after Go back or project navigation recovery.", true, true);
    }
    return true;
  }

  async function ensureCharacterLibrary({ allowNewCharacterPage = false } = {}) {
    await closeCurrentCharacterRoute();
    await ensureFlowLibrarySection("Characters");
    if (newCharacterRoute(location.pathname) && allowNewCharacterPage &&
        (flowButton("Add from project") || flowButton("Upload"))) {
      return { newCharacterPage: true };
    }
    if (newCharacterRoute(location.pathname)) {
      await leaveNewCharacterPage();
      await ensureFlowLibrarySection("Characters");
    }
    if (characterRoute(location.pathname)) {
      throw flowError("FLOW_CHARACTER_ROUTE_UNEXPECTED", "Flow is still on a character form or editor instead of the Characters library.", true, true);
    }
    return { newCharacterPage: false };
  }

  function characterLibraryScrollContainer() {
    const fallback = document.scrollingElement || document.documentElement;
    const canScroll = element => {
      if (!element || element === document.body || element === document.documentElement) return false;
      if (element.scrollHeight - element.clientHeight < 50) return false;
      try {
        const overflowY = getComputedStyle(element).overflowY;
        return overflowY === "auto" || overflowY === "scroll";
      } catch {
        return false;
      }
    };
    const tiles = (typeof root.flowQueryAll === "function" ? root.flowQueryAll("characters.characterTile", document, { checkVisible: false }) : null) ||
      [...document.querySelectorAll("flow-character-tile")];
    for (const tile of tiles) {
      for (let parent = tile?.parentElement, hop = 0; parent && hop < 30; parent = parent.parentElement, hop++) {
        if (canScroll(parent)) return parent;
      }
    }
    let best = null;
    for (const element of document.querySelectorAll("div,main,section")) {
      if (canScroll(element) && (!best || element.scrollHeight > best.scrollHeight)) best = element;
    }
    if (best) return best;
    return fallback && fallback.scrollHeight - fallback.clientHeight >= 50 ? fallback : null;
  }

  async function findCharacterTiles(name, timeoutMs = 45_000) {
    const wanted = normalize(cleanCharacterName(name));
    if (!wanted) throw flowError("FLOW_INVALID_ARGUMENT", "Character name is required for an exact library lookup.");
    const found = new Map();
    const scroller = characterLibraryScrollContainer();
    if (!scroller || !Number.isFinite(scroller.scrollTop) || !Number.isFinite(scroller.scrollHeight) || !Number.isFinite(scroller.clientHeight) || scroller.clientHeight <= 0) {
      throw flowError("FLOW_CHARACTER_SCAN_INCOMPLETE", "Flow's Characters library does not expose measurable scrolling state, so the full list cannot be confirmed; no character was selected.", true);
    }
    const originalTop = scroller?.scrollTop ?? 0;
    if (scroller) scroller.scrollTop = 0;
    const deadline = Date.now() + timeoutMs;
    const readyDeadline = Math.min(deadline, Date.now() + 15_000);
    let stableAt = 0;
    let reachedEnd = false;
    let librarySettled = false;
    try {
      while (Date.now() < readyDeadline) {
        const loading = (typeof root.flowQueryVisible === "function" && Boolean(root.flowQueryVisible("common.loadingIndicator", document))) ||
          [...document.querySelectorAll('[role="progressbar"],[aria-busy="true"]')].some(visible);
        const hasTiles = (typeof root.flowQueryVisible === "function" && Boolean(root.flowQueryVisible("characters.characterTile", document))) ||
          [...document.querySelectorAll("flow-character-tile")].some(visible);
        if (hasTiles && !loading) { librarySettled = true; break; }
        if (!loading && !hasTiles) {
          if (!stableAt) stableAt = Date.now();
          if (Date.now() - stableAt >= 700) { librarySettled = true; break; }
        } else stableAt = 0;
        await wait(Math.min(150, Math.max(1, readyDeadline - Date.now())));
      }
      if (!librarySettled) throw flowError("FLOW_CHARACTER_LIBRARY_LOADING", "Flow's Characters library did not settle before the lookup deadline; no character was selected.", true);
      for (let page = 0; page < 120 && Date.now() < deadline; page++) {
        const characterTiles = (typeof root.flowQueryAll === "function" ? root.flowQueryAll("characters.characterTile", document, { checkVisible: false }) : null) ||
          document.querySelectorAll("flow-character-tile");
        for (const tile of characterTiles) {
          if (!visible(tile)) continue;
          const actual = normalize(cleanCharacterName((tile.innerText || "").split("\n")[0] || tile.getAttribute("aria-label") || ""));
          if (actual === wanted) found.set(tile.getAttribute("data-id") || tile.id || actual + "|" + (tile.querySelector("img")?.src || ""), tile);
        }
        if (scroller.scrollTop >= scroller.scrollHeight - scroller.clientHeight - 2) { reachedEnd = true; break; }
        const previous = scroller.scrollTop;
        scroller.scrollTop = Math.min(scroller.scrollHeight - scroller.clientHeight, previous + Math.max(120, scroller.clientHeight * 0.75));
        await wait(Math.min(200, Math.max(1, deadline - Date.now())));
        if (scroller.scrollTop <= previous) {
          throw flowError("FLOW_CHARACTER_SCAN_INCOMPLETE", "Flow's character library stopped scrolling before its end; no character was selected.", true);
        }
      }
      if (Date.now() >= deadline || !reachedEnd) {
        throw flowError("FLOW_CHARACTER_SCAN_INCOMPLETE", "Flow's character library could not be fully scanned before the lookup deadline; no character was selected.", true);
      }
      return [...found.values()];
    } finally {
      scroller.scrollTop = originalTop;
    }
  }

  async function waitForCharacterTiles(name, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const matches = await findCharacterTiles(name, Math.min(3000, Math.max(1000, deadline - Date.now())));
      if (matches.length) return matches;
      await wait(Math.min(400, Math.max(1, deadline - Date.now())));
    }
    return [];
  }

  globalThis.FlowCharacterActions = Object.freeze({
    commitName: commitCharacterName,
    waitForPicker,
    inspectNameDiagnostics: () => lastCharacterNameDiagnostics ? redactCharacterNameDiagnostics(lastCharacterNameDiagnostics) : null,
    verifyNameLibrary: characterNameLibraryEvidence,
    recordNameSaveResponse: recordCharacterNameSaveResponse,
    findCharacterTiles,
    characterLibraryScrollContainer,
    create: async (payload = {}, command = {}) => {
      const c = payload.character || payload.job?.params || payload;
      if (!String(c.name || "").trim()) throw flowError("FLOW_INVALID_ARGUMENT", "Character name is required.");
      const characterName = String(c.name).trim();
      const localImage = c.image && typeof c.image === "object" ? c.image : null;
      if (c.image && !localImage && !String(c.image).startsWith("asset:")) throw flowError("FLOW_INVALID_ARGUMENT", "Character image must be a project asset or a staged local image.");
      if (!c.image && !c.describe) throw flowError("FLOW_INVALID_ARGUMENT", "Pass an existing project image with image='asset:<title>' or provide describe.");
      let sourceTitle = c.image && !localImage ? String(c.image).replace(/^asset:/, "").trim() : "";
      if (c.image && !localImage && !sourceTitle) throw flowError("FLOW_INVALID_ARGUMENT", "Character image asset title is empty.");
      let portraitMedia;
      await closeNativeAgentSession();
      await closeCurrentCharacterRoute();
      const activeAgent = flowButton("Agent");
      if (activeAgent?.getAttribute("aria-pressed") === "true") await setNativeAgentMode(false);
      if (localImage) {
        if (!validStagedLocalImage(localImage, /character/)) throw flowError("FLOW_TRANSFER_UNKNOWN", "The local character image transfer is invalid or no longer staged.", true);
        const file = stagedNativeFiles.get(localImage.transferId);
        if (!file) throw flowError("FLOW_TRANSFER_UNKNOWN", "The staged character image is no longer available.", true);
      }
      const characterEntry = await ensureCharacterLibrary({ allowNewCharacterPage: true });
      let newPageReady = characterEntry.newCharacterPage;
      if (!newPageReady) {
        const existing = await findCharacterTiles(characterName);
        if (existing.length > 1) throw flowError("FLOW_CHARACTER_AMBIGUOUS", `More than one character is already named "${characterName}"; no new character was created.`, true);
        if (existing.length === 1) throw flowError("FLOW_CHARACTER_EXISTS", `A character named "${characterName}" already exists; no new character was created.`, true);
      }
      if (!c.image) {
        await ensureFlowLibrarySection("All media");
        newPageReady = false;
        const editorBox = root.getVisibleFlowPromptEditor?.() || (typeof root.flowQuery === "function" ? root.flowQuery("editor", document) : null);
        if (!editorBox) throw flowError("NATIVE_CAPABILITY_UNSUPPORTED", "Flow's image composer is unavailable for description-based character creation.", true);
        await root.FlowTiles?.stabilizeFlowResultViewport?.({ deadline: Date.now() + 5_000, signal: command.signal });
        const before = collectNativeMedia().map(item => item.id || `title:${item.title}`);
        const variants = Math.max(1, Math.min(4, Number(c.variants || 1)));
        const clear = flowButton("Clear prompt"); if (clear) clear.click();
        await globalThis.FlowImageActions.prepareCharacterPortrait(c, variants);
        const box = root.getVisibleFlowPromptEditor?.() || (typeof root.flowQuery === "function" ? root.flowQuery("editor", document) : null);
        if (!box || !(await insertNativeFlowPrompt(box, String(c.describe)))) throw flowError("FLOW_PROMPT_INPUT_UNCONFIRMED", "Flow's portrait prompt was not accepted. Nothing was submitted.", true);
        const start = await waitForGenerationSubmitButton(String(c.describe), 8000);
        if (!start) throw flowError("FLOW_SUBMIT_DISABLED", "Flow's portrait generation button did not become ready within 8 seconds; nothing was submitted.", true);
        await activateFlowSubmitButton(start, String(c.describe));
        const generated = await waitForProgressResult(command, before, variants, "image", Number(payload.timeoutMs || 180000), "main");
        if (!generated.length) throw flowError("FLOW_CHARACTER_PORTRAIT_MISSING", "Flow did not return a portrait image for character creation.", false, true);
        sourceTitle = generated[0].title;
        portraitMedia = generated[0];
      }

      let characterUrl = "";
      let enteredEditor = false;
      let completedResult;
      try {
        if (!newPageReady) await ensureFlowLibrarySection("Characters");
        let newPage = newPageReady || newCharacterRoute(location.pathname);
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
          const listGetter = () => (typeof root.flowQueryVisible === "function" ? root.flowQueryVisible("components.listBox", document) : null) || [...document.querySelectorAll('[role="listbox"]')].find(visible);
          let list = await waitForPicker(listGetter, "project asset");
          const exactTitle = value => normalize(value) === normalize(sourceTitle);
          let matches = await findPickerMatches(listGetter, sourceTitle, "project asset", exactTitle);
          if (!matches.length) {
            const tabs = (typeof root.flowQueryAll === "function" ? root.flowQueryAll("components.categoryTabs", document, { checkVisible: false }) : null) || [...document.querySelectorAll('[role="tab"]')];
            const uploads = tabs.find(el => visible(el) && /^(?:uploads|tải lên|nội dung tải lên)$/i.test(normalize(accessibleName(el))));
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

        const nameInput = (typeof root.flowFindSemantic === "function" ? root.flowFindSemantic("characters.nameInput", document) : null) ||
          [...document.querySelectorAll('input,[role="textbox"]')].find(el => visible(el) && /(?:Character name|Tên nhân vật)/i.test(accessibleName(el) || el.placeholder || ""));
        if (!nameInput) throw flowError("FLOW_CHARACTER_FORM_MISSING", "Flow's character name field is not visible; the character may be partially created.", false, true);
        const initialCharacterName = String(nameInput.value ?? nameInput.innerText ?? nameInput.textContent ?? "").replace(/\s+/g, " ").trim();
        await commitCharacterName(nameInput, characterName);

        if (c.personality) {
          const personality = (typeof root.flowFindSemantic === "function" ? root.flowFindSemantic("characters.personalityInput", document) : null) ||
            [...document.querySelectorAll('textarea,input,[role="textbox"]')].find(el => visible(el) && /(?:Character personality|Tính cách nhân vật|Mô tả nhân vật)/i.test(accessibleName(el) || el.placeholder || ""));
          if (!personality) throw flowError("FLOW_CHARACTER_PERSONALITY_MISSING", "Flow's character personality field is unavailable; the character may be partially created.", false, true);
          setEditable(personality, c.personality);
          const deadline = Date.now() + 5000;
          while (Date.now() < deadline && !exactEditable(personality, c.personality)) await wait(100);
          if (!exactEditable(personality, c.personality)) throw flowError("FLOW_CHARACTER_PERSONALITY_UNCONFIRMED", "Flow did not accept the requested character personality; the character may be partially created.", false, true);
        }

        if (c.voice) {
          const selectVoice = flowButton("Select a voice") || flowButton("Chọn giọng nói") || flowButton("Giọng nói");
          if (!selectVoice) throw flowError("FLOW_VOICE_SELECTOR_MISSING", "The character editor does not show Select a voice; the character may be partially created.", false, true);
          selectVoice.click();
          const voicesGetter = () => (typeof root.flowQueryVisible === "function" ? root.flowQueryVisible("components.listBox", document) : null) || [...document.querySelectorAll('[role="listbox"]')].find(visible);
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
          const addVoice = await waitForEnabledFlowButton("Add to character", 8000) || await waitForEnabledFlowButton("Thêm vào nhân vật", 2000);
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
        lastCharacterNameDiagnostics = { ...lastCharacterNameDiagnostics, save_clicked: true };
        await waitForFlowRoute(path => !characterRoute(path), 15_000, "Flow did not save and close the character editor.");
        lastCharacterNameDiagnostics = { ...lastCharacterNameDiagnostics, route_exited: true };
        enteredEditor = false;
        await ensureFlowLibrarySection("Characters");
        let saved = [];
        let previousNameMatches = [];
        let libraryScanComplete = true;
        try { saved = await waitForCharacterTiles(characterName); }
        catch { libraryScanComplete = false; }
        if (initialCharacterName && normalize(initialCharacterName) !== normalize(characterName)) {
          try { previousNameMatches = await findCharacterTiles(initialCharacterName, 5000); }
          catch { libraryScanComplete = false; }
        }
        const libraryEvidence = characterNameLibraryEvidence(saved.length, previousNameMatches.length, libraryScanComplete);
        lastCharacterNameDiagnostics = {
          ...lastCharacterNameDiagnostics,
          library_result: {
            requested_matches: libraryEvidence.requested_name_matches,
            original_matches: libraryEvidence.previous_name_matches,
            scan_complete: libraryEvidence.scan_complete,
            confirmed: libraryEvidence.confirmed,
          },
        };
        recordCharacterNameSaveResponse({ control_label: "Done", click_sent: true, route_exited: true,
          library_scan: { requested_matches: saved.length, original_matches: previousNameMatches.length,
            scan_complete: libraryScanComplete, confirmed: libraryEvidence.confirmed } });
        if (!libraryEvidence.confirmed) {
          const error = flowError("FLOW_CHARACTER_SAVE_UNCONFIRMED", "Flow closed the character editor, but the Characters library did not confirm a unique saved name. Check Flow before retrying.", false, true);
          throw attachCharacterNameDiagnostics(error);
        }
        const clear = flowButton("Clear prompt"); if (clear) clear.click();
        completedResult = { name: characterName, url: characterUrl || location.href, portraitMedia, trustedGesture: false };
        return completedResult;
      } finally {
        try {
          if (newCharacterRoute(location.pathname)) await leaveNewCharacterPage();
          else if (enteredEditor && characterEditorRoute(location.pathname)) await closeCurrentCharacterRoute();
          await ensureFlowLibrarySection("All media");
          if (characterRoute(location.pathname)) throw flowError("FLOW_CHARACTER_CLEANUP_INCOMPLETE", "Flow remained on a character page after the create workflow cleanup.", true, true);
        } catch (error) {
          if (completedResult) completedResult.cleanupWarning = String(error?.message || error).slice(0, 300);
        }
      }
    },

    edit: async (payload = {}, command = {}) => {
      const characterName = String(payload.name || "");
      if (!characterName.trim()) throw flowError("FLOW_INVALID_ARGUMENT", "Character name is required for editing.");
      const renameTo = String(payload.rename || "").replace(/\s+/g, " ").trim();
      if (renameTo.length > 60) throw flowError("FLOW_INVALID_ARGUMENT", "A character name must contain at most 60 characters.");
      if (renameTo && normalize(renameTo) === normalize(characterName)) throw flowError("FLOW_INVALID_ARGUMENT", "The new character name must differ from the current name.");
      await closeNativeAgentSession();
      await ensureCharacterLibrary();
      const activeAgent = flowButton("Agent");
      if (activeAgent?.getAttribute("aria-pressed") === "true") await setNativeAgentMode(false);
      const matches = await findCharacterTiles(characterName.trim());
      if (matches.length > 1) throw flowError("FLOW_CHARACTER_AMBIGUOUS", `More than one character is named "${characterName}". No character was opened.`);
      const target = matches[0];
      if (!target) throw flowError("FLOW_CHARACTER_NOT_FOUND", `No character called "${characterName}". Use flow_characters to list them.`, true);
      target.scrollIntoView({ block: "center" }); target.click();
      await waitForFlowRoute(path => characterEditorRoute(path), 20_000, `Flow did not open character "${characterName}".`);
      await wait(500);
      let completedResult;
      try {
        let portrait = (typeof root.flowQuery === "function" ? root.flowQuery("characters.portrait", document) : null) ||
          document.querySelector('img[aria-label="Generated character image"], img[aria-label="Ảnh nhân vật đã tạo"], img[aria-label*="nhân vật"]');
        if (renameTo) {
          const nameInput = (typeof root.flowFindSemantic === "function" ? root.flowFindSemantic("characters.nameInput", document) : null) ||
            [...document.querySelectorAll('input,[role="textbox"]')].find(el => visible(el) && /(?:Character name|Tên nhân vật)/i.test(accessibleName(el) || el.placeholder || ""));
          if (!nameInput) throw flowError("FLOW_CHARACTER_FORM_MISSING", "Flow's character name field is not visible; the character name was not changed.", true, false);
          await commitCharacterName(nameInput, renameTo);
        }
        if (payload.change) {
          const box = root.getVisibleFlowPromptEditor?.();
          if (!box) throw flowError("FLOW_CHARACTER_EDITOR_MISSING", "Character editor prompt is not visible.", true);
          const beforeSrc = portrait?.getAttribute("src");
          const change = String(payload.change).replace(/\s*\n+\s*/g, " ").trim().replace(/[.\s]*$/, ".");
          const prompt = `${change} Exactly one ${characterName} in the picture: never add copies of ${characterName} or extra poses side by side.`;
          if (!await root.insertNativeFlowPrompt?.(box, prompt)) throw flowError("FLOW_PROMPT_INPUT_UNCONFIRMED", "Flow did not accept the character edit prompt. Nothing was submitted.", true);
          const start = await waitForGenerationSubmitButton(prompt, 8000);
          if (!start) throw flowError("FLOW_SUBMIT_DISABLED", "Flow's character edit button is disabled.", true);
          await activateFlowSubmitButton(start, prompt);
          const deadline = Date.now() + Number(payload.timeoutMs || 4 * 60_000);
          while (Date.now() < deadline) {
            await wait(2500); portrait = (typeof root.flowQuery === "function" ? root.flowQuery("characters.portrait", document) : null) ||
              document.querySelector('img[aria-label="Generated character image"], img[aria-label="Ảnh nhân vật đã tạo"], img[aria-label*="nhân vật"]');
            const pct = (document.querySelector("main")?.innerText || "").match(/\d+%/)?.[0];
            emitFlowProgress(command, pct || "Waiting for character portrait");
            if (portrait?.getAttribute("src") && portrait.getAttribute("src") !== beforeSrc && !pct) break;
          }
          if (!portrait?.getAttribute("src") || portrait.getAttribute("src") === beforeSrc) throw flowError("FLOW_CHARACTER_EDIT_TIMEOUT", "Timed out waiting for Flow to redraw the character. Check Flow before retrying.", false, true);
        }
        let downloadTriggered = false;
        const picture = (typeof root.flowQuery === "function" ? root.flowQuery("characters.portrait", document) : null) ||
          document.querySelector('img[aria-label="Generated character image"], img[aria-label="Ảnh nhân vật đã tạo"], img[aria-label*="nhân vật"]');
        if (picture && !renameTo) {
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
        const saveControlLabel = String(accessibleName(done) || done.innerText || done.textContent || "").replace(/\s+/g, " ").trim();
        if (renameTo) {
          lastCharacterNameDiagnostics = {
            ...lastCharacterNameDiagnostics,
            pre_save: characterNameSnapshot((typeof root.flowFindSemantic === "function" ? root.flowFindSemantic("characters.nameInput", document) : null) ||
              [...document.querySelectorAll('input,[role="textbox"]')].find(el => visible(el) && /(?:Character name|Tên nhân vật)/i.test(accessibleName(el) || el.placeholder || "")), "pre_save", renameTo),
            save_control: {
              label: String(accessibleName(done) || done.innerText || done.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80),
              disabled: Boolean(done.disabled || done.getAttribute("aria-disabled") === "true"),
              tag: done.tagName?.toLowerCase() || null,
            },
          };
        }
        done.click();
        if (renameTo) {
          lastCharacterNameDiagnostics = { ...lastCharacterNameDiagnostics, save_clicked: true };
          recordCharacterNameSaveResponse({ control_label: saveControlLabel, click_sent: true });
        }
        await waitForFlowRoute(path => !characterRoute(path), 15_000, "Flow did not close the character editor.");
        if (renameTo) {
          lastCharacterNameDiagnostics = { ...lastCharacterNameDiagnostics, route_exited: true, post_save_route: location.pathname };
          recordCharacterNameSaveResponse({ control_label: saveControlLabel, click_sent: true, route_exited: true, post_save_route: location.pathname });
        }
        let savedName = characterName;
        if (renameTo) {
          await ensureFlowLibrarySection("Characters");
          let renamed = [];
          let originalMatches = [];
          let libraryScanComplete = true;
          try { renamed = await waitForCharacterTiles(renameTo); }
          catch { libraryScanComplete = false; }
          try { originalMatches = await findCharacterTiles(characterName.trim(), 5000); }
          catch { libraryScanComplete = false; }
          const libraryEvidence = characterNameLibraryEvidence(renamed.length, originalMatches.length, libraryScanComplete);
          lastCharacterNameDiagnostics = {
            ...lastCharacterNameDiagnostics,
            library_result: {
              requested_matches: libraryEvidence.requested_name_matches,
              original_matches: libraryEvidence.previous_name_matches,
              scan_complete: libraryEvidence.scan_complete,
              confirmed: libraryEvidence.confirmed,
            },
          };
          recordCharacterNameSaveResponse({ control_label: saveControlLabel, click_sent: true, route_exited: true, post_save_route: location.pathname,
            library_scan: { requested_matches: renamed.length, original_matches: originalMatches.length,
              scan_complete: libraryScanComplete, confirmed: libraryEvidence.confirmed } });
          if (!libraryEvidence.confirmed) {
            const error = flowError("FLOW_CHARACTER_RENAME_UNCONFIRMED", "Flow closed the editor, but the Characters library did not confirm that the new name is unique and the old name is gone.", false, true);
            throw attachCharacterNameDiagnostics(error);
          }
          savedName = renameTo;
        }
        completedResult = { name: savedName, downloadTriggered, note: downloadTriggered ? undefined : "The character was saved in Flow, but its portrait download button was unavailable.", trustedGesture: false };
        return completedResult;
      } finally {
        try {
          if (characterRoute(location.pathname)) await closeCurrentCharacterRoute();
          await ensureFlowLibrarySection("All media");
          if (characterRoute(location.pathname)) throw flowError("FLOW_CHARACTER_CLEANUP_INCOMPLETE", "Flow remained on a character page after the edit workflow cleanup.", true, true);
        } catch (error) {
          if (completedResult) completedResult.cleanupWarning = String(error?.message || error).slice(0, 300);
        }
        const clear = flowButton("Clear prompt"); if (clear) clear.click();
      }
    },
  });
  globalThis.FlowCharacters = globalThis.FlowCharacterActions;
})();
