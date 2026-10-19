function flowSettingsPanelVisible() {
  const hasTypeOption = Boolean(flowRadio("Image") || flowOption("Image")) && Boolean(flowRadio("Video") || flowOption("Video"));
  const hasVariantOption = [1, 2, 3, 4].some(count => flowRadio(`x${count}`) || flowOption(`x${count}`));
  return hasTypeOption && hasVariantOption;
}

async function openFlowSettings() {
  if (flowSettingsPanelVisible()) return true;
  const trigger = flowButton("Settings trigger");
  if (!trigger) throw flowError("FLOW_SETTINGS_UNAVAILABLE", "Flow's settings panel cannot be opened; no generation was submitted.", true);
  trigger.click();
  await wait(400);
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (flowSettingsPanelVisible()) return true;
    await wait(100);
  }
  throw flowError("FLOW_SETTINGS_OPEN_FAILED", "Flow's settings panel did not open; no generation was submitted.", true);
}

async function chooseRadio(name) {
  let radio = flowRadio(name);
  if (!radio) {
    await openFlowSettings();
    const findOption = () => flowRadio(name) || flowOption(name);
    const openedBy = Date.now() + 2500;
    while (Date.now() < openedBy && !radio) { await wait(100); radio = findOption(); }
  }
  if (!radio) {
    const options = [...document.querySelectorAll('[role="radio"],mat-radio-button,[role="tab"],[role="option"],button,[role="button"]')]
      .filter(visible).map(el => accessibleName(el).replace(/\s+/g, " ").trim()).filter(Boolean);
    throw flowError("FLOW_OPTION_NOT_FOUND", `Flow has no visible "${name}" option for the current settings. Visible options: ${[...new Set(options)].slice(0, 30).join(", ") || "none"}.`);
  }
  if (!nativeRadioSelected(radio)) radio.click();
  await wait(400);
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const current = flowRadio(name) || (flowSettingsPanelVisible() && flowOption(name));
    if (nativeRadioSelected(current)) return;
    // Some Flow versions close the settings popover immediately after accepting a radio.
    if (!current && (!radio.isConnected || !visible(radio))) return;
    await wait(100);
  }
  // Retry the same radio once only while it is still visible and unselected.
  // This is safe before submit and helps when Flow drops a click during a slow repaint.
  radio = flowRadio(name) || (flowSettingsPanelVisible() && flowOption(name));
  if (radio && !nativeRadioSelected(radio)) {
    radio.click();
    const retryDeadline = Date.now() + 2500;
    while (Date.now() < retryDeadline) {
      const current = flowRadio(name) || (flowSettingsPanelVisible() && flowOption(name));
      if (nativeRadioSelected(current) || (!current && (!radio.isConnected || !visible(radio)))) return;
      await wait(100);
    }
  }
  throw flowError("FLOW_OPTION_SELECTION_FAILED", `Flow did not confirm that "${name}" was selected. Nothing was submitted.`, true);
}

async function chooseNativeVariantCount(count) {
  const variants = Math.max(1, Math.min(4, Number(count) || 1));
  const name = `x${variants}`;
  await openFlowSettings();
  let option = flowRadio(name) || flowOption(name);
  if (!option) throw flowError("FLOW_VARIANT_OPTION_MISSING", `Flow did not show the ${name} output option. Nothing was submitted.`, true);
  // Explicitly re-apply the requested count on every job, even when Flow shows it selected already.
  option.click();
  await wait(450);

  const summaryConfirms = () => {
    const trigger = flowButton("Settings trigger");
    const summary = (trigger?.innerText || trigger?.textContent || "").replace(/\s+/g, " ").trim();
    return new RegExp(`(?:^|\\s)${name}(?:\\s|$)`, "i").test(summary);
  };
  const deadline = Date.now() + 5000;
  let stableSelectionChecks = 0;
  let stableSummaryChecks = 0;
  while (Date.now() < deadline) {
    option = flowRadio(name) || flowOption(name);
    if (summaryConfirms()) {
      if (++stableSummaryChecks >= 2) { await wait(300); return variants; }
    } else stableSummaryChecks = 0;
    if (option && nativeRadioSelected(option)) {
      if (++stableSelectionChecks >= 2) { await wait(300); return variants; }
    } else {
      stableSelectionChecks = 0;
      // If Flow closes the panel after selection, accept only its updated xN summary.
      if ((!option || !option.isConnected || !visible(option)) && summaryConfirms()) {
        await wait(300);
        return variants;
      }
    }
    await wait(200);
  }
  throw flowError("FLOW_VARIANT_SELECTION_UNCONFIRMED", `Flow did not confirm the requested ${name} output count. Nothing was submitted.`, true);
}

async function closeFlowSettings() {
  const isOpen = () => flowSettingsPanelVisible();
  if (!isOpen()) return;
  // Flow can ignore a synthetic Escape, so use its own settings toggle and confirm the
  // quantity controls are actually gone before allowing the submit action to continue.
  const trigger = flowButton("Settings trigger");
  if (trigger) {
    trigger.click();
    const closeDeadline = Date.now() + 2500;
    while (Date.now() < closeDeadline && isOpen()) await wait(100);
  }
  if (isOpen()) {
    document.querySelector(".ProseMirror")?.click();
    const closeDeadline = Date.now() + 2000;
    while (Date.now() < closeDeadline && isOpen()) await wait(100);
  }
  if (isOpen()) throw flowError("FLOW_SETTINGS_CLOSE_FAILED", "Flow's settings panel stayed open after choosing the quantity. Nothing was submitted.", true);
}

function findRenderedSetting(name) {
  const normalized = String(name || "").replace(/\s+/g, " ").trim().toLowerCase();
  const candidates = [...document.querySelectorAll('[role="radio"],mat-radio-button,[role="tab"],[role="option"],button,[role="button"]')]
    .filter(el => visible(el) && !isFlowProjectNavigationControl(el));
  const exact = candidates.find(el => {
    const label = accessibleName(el).replace(/\s+/g, " ").trim().toLowerCase();
    return label === normalized || label.endsWith(` ${normalized}`);
  });
  if (exact) return exact;
  const seconds = /^(\d+)s$/.exec(normalized);
  if (seconds) return candidates.find(el => new RegExp(`(?:^|\\s)${seconds[1]}\\s*seconds?(?:\\s|$)`, "i").test(accessibleName(el).replace(/\s+/g, " ").trim()));
  return null;
}

async function preflightGenerationPrompt(payload, framesMode) {
  if (flowSettingsPanelVisible()) {
    await closeFlowSettings();
  }
  const deadline = Date.now() + 5000;
  let promptBox = null;
  while (Date.now() < deadline) {
    promptBox = [...document.querySelectorAll(".ProseMirror")].find(el => visible(el) && el.isContentEditable);
    if (promptBox) return promptBox;
    await wait(100);
  }
  throw flowError("FLOW_PROMPT_COMPOSER_NOT_READY", "Flow's prompt editor is not visible after closing settings. Nothing was submitted.", true, false);
}

async function restoreNativeFramesMode() {
  await openFlowSettings();
  const findFrames = () => [...document.querySelectorAll('[role="radio"],mat-radio-button,[role="tab"],[role="option"],button,[role="button"]')]
    .find(el => visible(el) && !isFlowProjectNavigationControl(el) &&
      accessibleName(el).replace(/^(?:accessibility_new|dashboard|face)\s*/i, "").replace(/\s+/g, " ").trim().toLocaleLowerCase() === "frames");
  let frames = findFrames();
  if (!frames) throw flowError("FLOW_FRAMES_MODE_UNAVAILABLE", "Flow does not show a Frames mode control after local frame upload. Nothing was submitted.", true, false);
  if (!nativeRadioSelected(frames) && frames.getAttribute("aria-selected") !== "true") frames.click();
  const hasFrameControls = () => Boolean(flowButton("Start") && flowButton("End"));
  const deadline = Date.now() + 5000;
  let confirmed = false;
  while (Date.now() < deadline) {
    frames = findFrames();
    if (frames && (nativeRadioSelected(frames) || frames.getAttribute("aria-selected") === "true" || hasFrameControls())) { confirmed = true; break; }
    if (!flowSettingsPanelVisible()) await openFlowSettings();
    await wait(100);
  }
  if (!confirmed) throw flowError("FLOW_FRAMES_MODE_UNCONFIRMED", "Flow did not confirm Frames mode after local frame upload. Nothing was submitted.", true, false);
  await closeFlowSettings();
  const controlsDeadline = Date.now() + 4000;
  while (Date.now() < controlsDeadline && !(flowButton("Start") && flowButton("End"))) await wait(100);
  if (!flowButton("Start") || !flowButton("End")) {
    throw flowError("FLOW_FRAMES_CONTROLS_UNAVAILABLE", "Flow selected Frames but did not restore both Start and End frame controls. Nothing was submitted.", true, false);
  }
}

async function chooseNativeModel(model, type) {
  if (!model) return;
  const legacyImage = type === "image" && /^\s*(nano banana( 2)?|latest)?\s*$/i.test(model);
  let button = flowButton("Select model family") || flowButton("Model");
  if (!button) {
    await openFlowSettings();
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline && !button) {
      button = flowButton("Select model family") || flowButton("Model");
      if (!button) await wait(100);
    }
  }
  if (!button) throw flowError("NATIVE_CAPABILITY_UNSUPPORTED", "Flow's model selector is unavailable; nothing was submitted.", true);
  // Open the model list and re-apply the requested model for each job instead of trusting
  // a value left selected by the previous operation or by the user's earlier session.
  button.click();
  await wait(450);
  let items = [];
  const menuDeadline = Date.now() + 4000;
  while (Date.now() < menuDeadline) {
    items = [...document.querySelectorAll('[role="menuitem"]')].filter(visible);
    if (items.length) break;
    await wait(100);
  }
  const names = items.map(accessibleName).map(name => name.replace(/\s+/g, " ").trim());
  let index = legacyImage ? names.reduce((best, name, i) => {
    const match = /nano banana\s+(\d+(?:\.\d+)*)(?!.*\blite\b)/i.exec(name);
    if (!match || /\blite\b/i.test(name)) return best;
    const version = match[1].split(".").map(Number);
    const score = version.reduce((value, part) => value * 1000 + part, 0);
    return score > best.score ? { index: i, score } : best;
  }, { index: -1, score: -1 }).index : names.findIndex(name => name.toLowerCase().includes(model.toLowerCase()));
  if (index < 0) {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    throw flowError("FLOW_MODEL_NOT_FOUND", `Model "${model}" was not found in Flow. Available: ${names.join(", ")}`, true);
  }
  const chosenName = names[index];
  items[index].click();
  await wait(500);
  const summaryConfirms = () => {
    const trigger = flowButton("Settings trigger");
    const settingSummary = (trigger?.innerText || trigger?.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
    return legacyImage
      ? /nano banana\s+\d/i.test(settingSummary) && !/\blite\b/i.test(settingSummary)
      : settingSummary.includes(model.toLowerCase());
  };
  const selectDeadline = Date.now() + 4000;
  while (Date.now() < selectDeadline && !summaryConfirms()) await wait(100);
  let selectionConfirmed = summaryConfirms();
  if (!selectionConfirmed) {
    // Some Flow versions omit the selected model from the settings summary. Reopen
    // the model menu and require its requested item to expose a selected state.
    button = flowButton("Select model family") || flowButton("Model");
    if (!button) {
      await openFlowSettings();
      button = flowButton("Select model family") || flowButton("Model");
    }
    if (button) {
      button.click();
      const verifyDeadline = Date.now() + 4000;
      let verifyItems = [];
      while (Date.now() < verifyDeadline) {
        verifyItems = [...document.querySelectorAll('[role="menuitem"]')].filter(visible);
        if (verifyItems.length) break;
        await wait(100);
      }
      const wantedName = chosenName.replace(/\s+/g, " ").trim().toLowerCase();
      const chosen = verifyItems.find(item => {
        const label = accessibleName(item).replace(/\s+/g, " ").trim().toLowerCase();
        return label === wantedName || label.includes(wantedName);
      });
      const itemSelected = item => {
        if (!item) return false;
        if (["aria-selected", "aria-checked", "aria-pressed", "aria-current", "data-selected", "data-state"]
          .some(attribute => ["true", "checked", "selected", "page"].includes((item.getAttribute(attribute) || "").toLowerCase()))) return true;
        if (["selected", "active", "checked"].some(className => item.classList.contains(className))) return true;
        if (item.querySelector('input[type="radio"]:checked,input[type="checkbox"]:checked,[aria-checked="true"],[aria-selected="true"],[data-state="checked"]')) return true;
        return [...item.querySelectorAll("mat-icon")].some(icon => /^(?:check|check_circle|done|radio_button_checked)$/i.test((icon.innerText || icon.textContent || "").trim()));
      };
      selectionConfirmed = itemSelected(chosen);
      // The verification menu is only an observation step. Close it before the
      // caller continues applying settings or attempts to submit the video.
      if (chosen?.isConnected && visible(chosen)) {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await wait(200);
        if (chosen.isConnected && visible(chosen) && button?.isConnected && visible(button)) {
          button.click();
          await wait(200);
        }
      }
    }
  }
  if (!selectionConfirmed) throw flowError("FLOW_MODEL_SELECTION_FAILED", `Flow did not confirm model "${model}" in its settings summary or selected model menu item. Nothing was submitted.`, true);
  await wait(350);
}

async function pickNativeAgentImageModel() {
  const root = document.querySelector("flow-agent-panel") || document;
  const button = flowButton("Image generation default model", root);
  if (!button) return;
  button.click();
  let items = [];
  const menuDeadline = Date.now() + 4000;
  while (Date.now() < menuDeadline) {
    items = [...document.querySelectorAll('[role="menuitem"]')].filter(visible);
    if (items.length) break;
    await wait(100);
  }
  const candidates = items.map((el, index) => ({ el, index, name: accessibleName(el).replace(/\s+/g, " ").trim() }))
    .filter(item => /nano banana\s+\d/i.test(item.name) && !/\blite\b/i.test(item.name));
  const version = item => /nano banana\s+(\d+(?:\.\d+)*)/i.exec(item.name)?.[1].split(".").map(Number) || [];
  candidates.sort((a, b) => {
    const av = version(a), bv = version(b);
    for (let i = 0; i < Math.max(av.length, bv.length); i++) if ((av[i] || 0) !== (bv[i] || 0)) return (bv[i] || 0) - (av[i] || 0);
    return a.index - b.index;
  });
  if (candidates.length) candidates[0].el.click();
  else document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await wait(350);
}
