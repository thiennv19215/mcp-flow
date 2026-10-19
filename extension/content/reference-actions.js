(() => {
  "use strict";
  const normalize = value => String(value || "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
  const undecorate = value => normalize(value).replace(/\s+(?:image|video|character|avatar|ảnh|nhân vật)$/i, "");
  const identity = value => String(value || "").replace(/=(?:s\d+(?:-[a-z]+)*|mm,\d+,\d+)$/, "");
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
  async function settled() {
    // Do not inspect the previous category's options while the new category loads.
    const until = Date.now() + 10000;
    await wait(200);
    while (Date.now() < until) {
      const loading = [...document.querySelectorAll('[role="progressbar"]')].some(visible);
      if (!loading && (picker() || /No assets found/i.test(document.body.innerText))) return;
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
    const tab = [...document.querySelectorAll('[role="tab"]')].find(el => visible(el) && normalize(accessibleName(el)).replace(/^(?:accessibility_new|dashboard|face)\s*/, "") === normalize(name));
    if (!tab) throw flowError("FLOW_REFERENCE_CATEGORY_MISSING", `Flow's picker has no ${name} category.`, true);
    if (tab.getAttribute("aria-selected") !== "true") { tab.click(); await settled(); }
  }
  function close() {
    const opener = flowButton("Add ingredients to the prompt box");
    if (opener?.getAttribute("aria-expanded") === "true") opener.click();
  }
  async function search(name) {
    const input = [...document.querySelectorAll('input,[role="textbox"]')].find(el => visible(el) && accessibleName(el) === "Search assets");
    if (!input) return;
    setEditable(input, name);
    // Search is debounced by Flow; wait before accepting a possibly stale option.
    await wait(650);
    await settled();
  }
  async function listCharacters() {
    try {
      await open(); await category("Characters"); await search("");
      const names = new Set(chips().filter(chip => chip.kind === "character" && chip.name).map(chip => chip.name));
      const list = picker();
      const scroller = list && [list, ...list.querySelectorAll("*")].find(el => el.clientHeight > 0 && el.scrollHeight > el.clientHeight + 5);
      for (let page = 0; page < 100; page++) {
        for (const option of options()) names.add(accessibleName(option).trim());
        if (!scroller || scroller.scrollTop >= scroller.scrollHeight - scroller.clientHeight - 2) break;
        scroller.scrollTop += scroller.clientHeight * .8; await wait(250);
      }
      return [...names].filter(Boolean);
    } finally { close(); }
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
    } finally { close(); }
  }
  globalThis.FlowReferenceActions = Object.freeze({ attach, listCharacters, chips, parse, exactOption });
})();
