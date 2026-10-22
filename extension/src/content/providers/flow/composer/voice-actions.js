// Flow voice-chip selection and complete voice picker enumeration.
(() => {
  "use strict";
  const root = globalThis;
  const normalize = value => String(value || "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
  const pickerApi = root.FlowReferencePickerInternals;
  const picker = () => pickerApi?.picker?.() || null;
  const open = (...args) => pickerApi.open(...args);
  const category = (...args) => pickerApi.category(...args);
  const closeAfterOperation = (...args) => pickerApi.closeAfterOperation(...args);
  const exactOption = (...args) => pickerApi.exactOption(...args);
  const options = () => pickerApi.options();
  const findPickerCategoryTab = (...args) => pickerApi.findPickerCategoryTab(...args);
  const makeDeadline = (...args) => root.FlowUiDeadline.makeDeadline(...args);
  const requireTime = (...args) => root.FlowUiDeadline.requireTime(...args);
  const boundedWait = (...args) => root.FlowUiDeadline.boundedWait(...args);
  function voiceChipNodes(composer) {
    if (!composer) return [];
    const configured = typeof root.flowQueryAll === "function" ? root.flowQueryAll("components.voiceChip", composer) : [];
    const candidates = [...new Set([
      ...configured,
      ...composer.querySelectorAll('[data-ingredient-type="voice"],[data-kind="voice"],[class*="voice-chip" i],button[aria-label*="voice" i],button[aria-label*="giọng" i]'),
    ])];
    return candidates.filter(node => {
      if (!visible(node)) return false;
      const label = normalize(accessibleName(node) || node.getAttribute?.("aria-label") || node.getAttribute?.("title") || node.innerText || node.textContent);
      return /voice|giọng/.test(label) || /voice-chip|ingredient-voice/i.test(String(node.className?.baseVal || node.className || ""));
    });
  }
  const voiceChipLabel = chip => normalize(accessibleName(chip) || chip.getAttribute?.("aria-label") || chip.getAttribute?.("title") || chip.innerText || chip.textContent)
    .replace(/^(?:voice|giọng nói|giọng)\s*[:\-]\s*/, "")
    .replace(/\s+(?:remove|delete|clear|close|xóa|gỡ)(?:\s+(?:voice|giọng nói|giọng))?$/, "")
    .trim();
  const inspectVoiceChips = composer => voiceChipNodes(composer).map(element => ({ element, owner: element, kind: "voice" }));
  async function selectNativeFlowVoice(name, config = {}) {
    const wanted = String(name || "").replace(/\s+/g, " ").trim();
    if (!wanted || wanted.length > 120) throw flowError("FLOW_INVALID_ARGUMENT", "An exact Flow voice name is required.", false, false);
    const deadline = config.deadline || makeDeadline(config.command, 20_000, 4_000);
    const composer = (typeof root.flowQuery === "function" ? root.flowQuery("composerRoot") : null) ||
      (typeof root.flowQuery === "function" ? root.flowQuery("editor")?.closest?.(".flow-composer,flow-base-prompt-box,form[class*='composer'],[class*='composer']") : null) ||
      document.querySelector(".flow-composer,flow-base-prompt-box,form[class*='composer'],[class*='composer']");
    if (!composer) throw flowError("FLOW_VOICE_COMPOSER_MISSING", "Flow's composer could not be identified; no voice was selected.", false, false);
    const oldChips = voiceChipNodes(composer);
    for (const chip of oldChips) {
      requireTime(deadline, "replacing the selected Flow voice", false, config.signal);
      const configuredRemovers = typeof root.flowQueryAll === "function" ? root.flowQueryAll("components.voiceRemoveButton", chip) : [];
      const controls = [...new Set([...configuredRemovers, ...chip.querySelectorAll('button,[role="button"]')])].filter(visible);
      const remove = controls.find(control => /(?:remove|delete|clear|close|xóa|gỡ)/i.test(normalize(accessibleName(control) || control.getAttribute?.("aria-label") || control.getAttribute?.("title"))));
      if (!remove || remove.disabled || remove.getAttribute("aria-disabled") === "true") {
        throw flowError("FLOW_VOICE_REMOVE_UNAVAILABLE", "An existing Flow voice chip has no verified remove control; no new voice was selected.", false, false);
      }
      const before = voiceChipNodes(composer).length;
      remove.click();
      const until = Math.min(Date.now() + 1500, deadline);
      while (Date.now() < until && voiceChipNodes(composer).length >= before) await boundedWait(100, deadline, "confirming the previous Flow voice was removed", false, config.signal);
      if (voiceChipNodes(composer).length >= before) throw flowError("FLOW_VOICE_REMOVE_UNCONFIRMED", "Flow did not confirm removal of the previous voice chip; no new voice was selected.", false, false);
    }

    let operationError;
    try {
      await open(undefined, deadline, config.signal);
      await category("voices", deadline, config.signal);
      const option = exactOption(options(), wanted, false);
      if (!option) throw flowError("FLOW_VOICE_NOT_FOUND", "The requested Flow voice was not available in the voice picker; no voice was selected.", false, false);
      const before = voiceChipNodes(composer);
      option.click();
      let applyClicked = false;
      const verifyUntil = Math.min(Date.now() + 5000, deadline);
      while (Date.now() < verifyUntil) {
        const matching = voiceChipNodes(composer).filter(chip => voiceChipLabel(chip) === normalize(wanted));
        if (matching.length === 1) return { selected: true, confirmed: true };
        if (matching.length > 1) throw flowError("FLOW_VOICE_SELECTION_AMBIGUOUS", "Flow showed multiple matching voice chips; inspect the composer before submitting.", false, false);
        const pickerRoot = picker()?.closest('[role="dialog"]') || picker();
        const apply = pickerRoot && (flowButton("Add to prompt", pickerRoot) || flowButton("Thêm vào câu lệnh", pickerRoot));
        if (!applyClicked && apply && !apply.disabled && apply.getAttribute("aria-disabled") !== "true") { apply.click(); applyClicked = true; }
        await boundedWait(100, deadline, "confirming the selected Flow voice", true, config.signal);
      }
      throw flowError("FLOW_VOICE_SELECTION_UNCONFIRMED", "Flow did not confirm the requested voice chip; no generation was submitted.", false, false);
    } catch (error) {
      operationError = error;
      throw error;
    } finally {
      if (picker()) {
        try { await closeAfterOperation(deadline, config.signal, operationError); }
        catch (cleanupError) { if (!operationError) throw cleanupError; }
      }
    }
  }
  async function listNativeFlowVoiceOptions(config = {}) {
    const deadline = config.deadline || makeDeadline(config.command, 25_000, 5_000);
    const wasOpen = Boolean(picker());
    let ownsPicker = false;
    let operationError;
    try {
      if (wasOpen) {
        const tab = findPickerCategoryTab("voices");
        if (!tab || tab.getAttribute("aria-selected") !== "true") {
          throw flowError("FLOW_VOICE_PICKER_ALREADY_OPEN", "Flow already has a different picker open; it was left unchanged.", false, false);
        }
      } else {
        await open(undefined, deadline, config.signal);
        ownsPicker = true;
        await category("voices", deadline, config.signal);
      }
      const list = picker();
      if (!list) throw flowError("FLOW_VOICE_PICKER_UNAVAILABLE", "Flow's voice picker list was not available.", false, false);
      const labels = [];
      const seen = new Set();
      let stableAtBottom = 0;
      let completed = false;
      let scanReason = "step_limit";
      let scrollMoves = 0;
      let optionCount = 0;
      let steps = 0;
      for (let step = 0; step < 60 && labels.length < 250; step++) {
        steps++;
        requireTime(deadline, "reading Flow voice options", false, config.signal);
        const currentList = picker();
        if (!currentList) throw flowError("FLOW_VOICE_PICKER_CLOSED", "Flow's voice picker closed during inspection; the result is incomplete.", false, false);
        const currentOptions = options();
        optionCount = Math.max(optionCount, currentOptions.length);
        for (const option of currentOptions) {
          const rawLabel = accessibleName(option) || option.getAttribute?.("aria-label") || option.getAttribute?.("title") || option.innerText || option.textContent || "";
          const label = String(rawLabel).replace(/\s+/g, " ").trim();
          if (!label) throw flowError("FLOW_VOICE_LABEL_UNAVAILABLE", "A visible Flow voice option had no readable label; no partial list was returned.", false, false);
          const key = normalize(label);
          if (seen.has(key)) continue;
          seen.add(key);
          labels.push(label);
        }
        // Flow's role=listbox often wraps a separate virtual-scroll viewport.
        // Scroll the actual overflowing descendant, not the listbox shell.
        const scroller = [currentList, ...currentList.querySelectorAll("*")]
          .find(element => Number(element.clientHeight) > 0 && Number(element.scrollHeight) > Number(element.clientHeight) + 2);
        if (!scroller) {
          scanReason = "no_scroll_container";
          stableAtBottom++;
          if (stableAtBottom >= 2) { completed = true; break; }
        } else {
          const top = Number(scroller.scrollTop) || 0;
          const height = Number(scroller.clientHeight) || 0;
          const scrollHeight = Number(scroller.scrollHeight) || 0;
          if (top + height >= scrollHeight - 2) {
            scanReason = "bottom_reached";
            stableAtBottom++;
            if (stableAtBottom >= 2) { completed = true; break; }
            await boundedWait(180, deadline, "confirming the end of Flow voice options", false, config.signal);
            continue;
          }
          stableAtBottom = 0;
          const nextTop = Math.min(scrollHeight - height, top + Math.max(240, height * 0.8));
          scroller.scrollTop = nextTop;
          await boundedWait(180, deadline, "loading the next Flow voice options", false, config.signal);
          if ((Number(scroller.scrollTop) || 0) <= top) {
            scanReason = "scroll_no_progress";
            break;
          }
          scrollMoves++;
        }
      }
      if (!completed) {
        const reason = labels.length >= 250 ? "option_limit" : scanReason;
        const error = flowError(
          reason === "scroll_no_progress" ? "FLOW_VOICE_SCAN_NO_PROGRESS" : reason === "option_limit" ? "FLOW_VOICE_OPTIONS_LIMIT" : "FLOW_VOICE_SCAN_INCOMPLETE",
          reason === "scroll_no_progress"
            ? "Flow's voice options stopped scrolling before the list end; no partial list was returned."
            : reason === "option_limit"
              ? "Flow's voice picker exceeded the bounded 250-option scan; no partial list was returned."
              : "Flow's voice options could not be enumerated completely within the bounded scan; no partial list was returned.",
          false, false,
        );
        // Counts and fixed reason codes are safe to log; option names and DOM text are intentionally omitted.
        error.diagnostics = { reason, steps, labelsRead: labels.length, visibleOptions: optionCount, scrollMoves };
        throw error;
      }
      if (labels.length >= 250) throw flowError("FLOW_VOICE_OPTIONS_LIMIT", "Flow's voice picker exceeded the bounded 250-option scan; no partial list was returned.", false, false);
      return { voices: labels, count: labels.length, source: "flow_v2_picker", readOnly: true };
    } catch (error) {
      operationError = error;
      throw error;
    } finally {
      if (ownsPicker && picker()) {
        try { await closeAfterOperation(deadline, config.signal, operationError); }
        catch (cleanupError) { if (!operationError) throw cleanupError; }
      }
    }
  }
  root.FlowVoiceActions = Object.freeze({ select: selectNativeFlowVoice, listOptions: listNativeFlowVoiceOptions, chips: inspectVoiceChips });
  root.selectNativeFlowVoice = selectNativeFlowVoice;
  root.listNativeFlowVoiceOptions = listNativeFlowVoiceOptions;
})();
