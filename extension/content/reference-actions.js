(() => {
  "use strict";
  const normalize = value => String(value || "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
  const undecorate = value => normalize(value).replace(/\s+(?:image|video|character|avatar|ảnh|nhân vật)$/i, "");
  const identity = value => String(value || "").replace(/=(?:s\d+(?:-[a-z]+)*|mm,\d+,\d+)$/, "");
  const isCharacterRoute = path => /\/character(?:\/|$)/i.test(path || "");
  const isNewCharacterRoute = path => /\/character\/?$/i.test(path || "");
  const isCharacterEditorRoute = path => /\/character\/[0-9a-f-]{36}(?:\/|$)/i.test(path || "");
  const metadata = new WeakMap();
  function parse(value) {
    const text = typeof value === "string" ? value : value?.assetName;
    const explicitCharacter = /^character:/i.test(text || "");
    const name = String(text || "").replace(/^(?:asset|character):/i, "").trim();
    if (!name) throw flowError("FLOW_INVALID_ARGUMENT", "Reference name is required.");
    return { name, kind: explicitCharacter ? "character" : value?.kind };
  }
  function exactOption(options, name, decorated = true) {
    const wanted = normalize(name);
    const matches = options.filter(option => {
      const names = [accessibleName(option), option.getAttribute("aria-label"), option.getAttribute("title")];
      for (const node of option.querySelectorAll("[aria-label],[title]")) names.push(node.getAttribute("aria-label"), node.getAttribute("title"));
      return names.some(value => normalize(value) === wanted || decorated && undecorate(value) === wanted);
    });
    if (matches.length > 1) throw flowError("FLOW_ASSET_AMBIGUOUS", `More than one reference is named "${name}". Select a unique name or use character:<name> for a character. Nothing was attached.`);
    return matches[0] || null;
  }
  function chips() {
    return [...document.querySelectorAll('button[aria-label="Ingredient"]')].filter(visible).map(button => {
      const image = button.querySelector("img");
      const kind = button.closest("flow-character-ingredient-chip") || /character/i.test(image?.alt || "") ? "character" : "image";
      return { element: button, kind, source: identity(image?.getAttribute("src")), ...metadata.get(button) };
    });
  }
  function picker() { return [...document.querySelectorAll('[role="listbox"]')].find(visible); }
  const options = () => [...(picker()?.querySelectorAll('[role="option"]') || [])].filter(visible);
  function emptyPickerMessage() {
    return [...document.querySelectorAll('[role="dialog"],main,[role="listbox"]')].filter(visible)
      .some(el => /no (?:assets|characters) found/i.test(el.innerText || el.textContent || ""));
  }
  async function settled() {
    // Wait for both the picker and its loading state; an empty list is a valid settled state.
    const until = Date.now() + 15_000;
    let stableAt = 0;
    while (Date.now() < until) {
      const list = picker();
      const loading = [...document.querySelectorAll('[role="progressbar"],[aria-busy="true"]')].some(visible);
      if (list && !loading) {
        if (options().length || /No (?:assets|characters) found/i.test(list.innerText || "")) return list;
        if (!stableAt) stableAt = Date.now();
        if (Date.now() - stableAt >= 700) return list;
      } else if (!loading && emptyPickerMessage()) {
        if (!stableAt) stableAt = Date.now();
        if (Date.now() - stableAt >= 700) return null;
      } else stableAt = 0;
      await wait(150);
    }
    throw flowError("FLOW_ASSET_PICKER_LOADING", "Flow's reference picker did not finish loading. Nothing was selected.", true);
  }
  async function open(slot) {
    if (!picker()) {
      const button = slot === "start" ? flowButton("Start") : slot === "end" ? flowButton("End") : flowButton("Add ingredients to the prompt box");
      if (!button) throw flowError("FLOW_ASSET_PICKER_MISSING", `Flow's ${slot || "reference"} picker is unavailable.`, true);
      button.click();
    }
    await settled();
  }
  async function category(name) {
    const findTab = () => [...document.querySelectorAll('[role="tab"]')].find(el => visible(el) && normalize(accessibleName(el)).replace(/^(?:accessibility_new|dashboard|face)\s*/, "") === normalize(name));
    let tab = findTab();
    if (!tab) throw flowError("FLOW_REFERENCE_CATEGORY_MISSING", `Flow's picker has no ${name} category.`, true);
    if (tab.getAttribute("aria-selected") !== "true") {
      tab.click();
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        tab = findTab();
        if (tab?.getAttribute("aria-selected") === "true") break;
        await wait(100);
      }
      if (tab?.getAttribute("aria-selected") !== "true") throw flowError("FLOW_REFERENCE_CATEGORY_UNCONFIRMED", `Flow did not select the ${name} category.`, true);
    }
    await settled();
  }
  async function close() {
    const opener = flowButton("Add ingredients to the prompt box");
    if (picker() && opener) opener.click();
    const firstDeadline = Date.now() + 700;
    while (Date.now() < firstDeadline && picker()) await wait(100);
    if (picker()) {
      const list = picker();
      const dialog = list?.closest('[role="dialog"]');
      const closeButton = dialog && flowButton("Close", dialog);
      if (closeButton) closeButton.click();
      else {
        document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      }
    }
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline && picker()) await wait(100);
    if (picker()) throw flowError("FLOW_ASSET_PICKER_CLOSE_FAILED", "Flow's reference picker stayed open and could not be dismissed.", true);
  }
  async function search(name) {
    const input = [...document.querySelectorAll('input,[role="textbox"]')].find(el => visible(el) && /^Search assets$/i.test(accessibleName(el).trim()));
    if (!input) return;
    setEditable(input, name);
    // Search is debounced by Flow; wait before accepting a possibly stale option.
    const wanted = String(name || "");
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const current = input.value !== undefined ? input.value : input.innerText;
      if (String(current || "").trim() === wanted.trim()) break;
      await wait(100);
    }
    if (String(input.value ?? input.innerText ?? "").trim() !== wanted.trim()) {
      throw flowError("FLOW_REFERENCE_SEARCH_UNCONFIRMED", "Flow did not accept the reference search text.", true);
    }
    await wait(650);
    await settled();
  }
  async function returnToProjectComposer() {
    if (isNewCharacterRoute(location.pathname)) {
      const back = await waitForEnabledFlowButton("Go back", 3000);
      if (!back) throw flowError("FLOW_CHARACTER_BACK_MISSING", "Flow's New character page has no Go back control.", true, true);
      back.click();
      await waitForFlowRoute(path => !isNewCharacterRoute(path), 15_000, "Flow did not leave the New character page.");
    } else if (isCharacterEditorRoute(location.pathname)) {
      const done = await waitForEnabledFlowButton("Done", 3000) || await waitForEnabledFlowButton("Done editing", 1000);
      if (!done) throw flowError("FLOW_CHARACTER_SAVE_MISSING", "Flow's character editor has no Done control; its current state may be unsaved.", false, true);
      done.click();
      await waitForFlowRoute(path => !isCharacterRoute(path), 15_000, "Flow did not close the character editor.");
    }
    if (isCharacterRoute(location.pathname)) throw flowError("FLOW_CHARACTER_ROUTE_UNEXPECTED", "Flow is still on a character page; the character picker cannot be opened safely.", true, true);
    if (!document.querySelector(".ProseMirror")) await ensureFlowLibrarySection("All media");
    if (!document.querySelector(".ProseMirror")) throw flowError("FLOW_COMPOSER_MISSING", "Flow's project composer is not visible after returning from the character page.", true);
  }
  async function listCharacters() {
    try {
      await returnToProjectComposer();
      await open();
      if (!picker() && emptyPickerMessage()) return [];
      try { await category("Characters"); }
      catch (error) {
        if (error?.code === "FLOW_REFERENCE_CATEGORY_MISSING" && emptyPickerMessage()) return [];
        throw error;
      }
      await search("");
      const names = new Map(chips().filter(chip => chip.kind === "character" && chip.name).map(chip => [normalize(chip.name), chip.name]));
      let list = picker();
      const scroller = list && [list, ...list.querySelectorAll("*")].find(el => el.clientHeight > 0 && el.scrollHeight > el.clientHeight + 5);
      if (scroller) scroller.scrollTop = 0;
      for (let page = 0; page < 120; page++) {
        list = await settled();
        for (const option of options()) {
          const name = (accessibleName(option) || option.innerText || option.textContent || "").replace(/\s+/g, " ").trim();
          if (name && !/^(?:characters?|no characters found)$/i.test(name)) names.set(normalize(name), name);
        }
        if (!scroller || scroller.scrollTop >= scroller.scrollHeight - scroller.clientHeight - 2) break;
        const previous = scroller.scrollTop;
        scroller.scrollTop = Math.min(scroller.scrollHeight - scroller.clientHeight, previous + Math.max(120, scroller.clientHeight * 0.75));
        await wait(250);
        if (scroller.scrollTop === previous) break;
      }
      return [...names.values()].filter(Boolean);
    } finally { await close(); }
  }
  async function attach(value, slot) {
    const ref = parse(value);
    try {
      // Flow excludes already attached characters from its picker. Check our
      // confirmed provenance first, before requiring the option to exist again.
      const reusable = chips().find(chip => normalize(chip.name) === normalize(ref.name) && (!ref.kind || chip.kind === ref.kind));
      if (reusable) return { name: ref.name, kind: reusable.kind, source: reusable.source, confirmed: true, reused: true };
      await open(slot);
      await category(ref.kind === "character" ? "Characters" : "All");
      await search(ref.name);
      const option = exactOption(options(), ref.name, ref.kind !== "character");
      if (!option) throw flowError("FLOW_ASSET_NOT_FOUND", `No exact ${ref.kind || "reference"} named "${ref.name}" in the selected project. Nothing was attached.`, true);
      const tile = [...document.querySelectorAll("flow-grid-tile-container")].find(el => normalize(el.getAttribute("aria-label")) === normalize(ref.name));
      const kind = ref.kind || (tile?.querySelector("flow-character-tile") || /\bCharacter$/i.test(accessibleName(option)) ? "character" : "image");
      const before = chips();
      // A character thumbnail can be on flow-content.google while its chip is on
      // /asb/. Those are different representations, not interchangeable IDs.
      // Only reuse a chip whose selection provenance this driver recorded.
      const existing = before.find(chip => chip.name === ref.name && chip.kind === kind);
      if (existing) return { name: ref.name, kind, source: existing.source, confirmed: true, reused: true };
      option.click();
      // Character options attach immediately; images may require Add to prompt.
      let confirmedClick = false;
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const added = chips().filter(chip => !before.some(old => old.element === chip.element));
        const chip = added.length === 1 && added[0].kind === kind ? added[0] : null;
        if (chip) {
          const result = { name: ref.name, kind: chip.kind, source: chip.source, confirmed: true };
          metadata.set(chip.element, { name: ref.name });
          return result;
        }
        if (slot && !picker()) return { name: ref.name, kind, confirmed: true, slot };
        const add = flowButton("Add to prompt");
        if (!confirmedClick && add && !add.disabled && picker()) { add.click(); confirmedClick = true; }
        await wait(150);
      }
      throw flowError("FLOW_REFERENCE_ATTACH_UNCONFIRMED", `Flow did not show a matching ${ref.kind || "reference"} chip for "${ref.name}". Nothing was submitted.`, false, false);
    } finally { await close(); }
  }
  globalThis.FlowReferenceActions = Object.freeze({ attach, listCharacters, chips, parse, exactOption });
})();
