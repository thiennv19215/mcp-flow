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

async function chooseDuration(duration) {
  if (!duration) return;
  const num = parseInt(String(duration), 10);
  if (isNaN(num)) return;
  const str = `${num}s`;

  await openFlowSettings();
  const panel = flowSettingsPanelVisible() ? (document.querySelector('[role="menu"], [role="dialog"], mat-dialog-container, flow-dialog') || document) : document;

  const tryClickDuration = () => {
    // 1. Check ID suffix: button[id$="-trigger-X"] (e.g. -trigger-5)
    const idBtn = panel.querySelector(`button[id$="-trigger-${num}"]`);
    if (idBtn && visible(idBtn)) {
      if (!nativeRadioSelected(idBtn) && idBtn.getAttribute("aria-selected") !== "true" && idBtn.getAttribute("data-state") !== "active") {
        idBtn.click();
      }
      return true;
    }

    // 2. Check tab / radio button matching exact seconds (e.g. "5s", "5", "5 giây", "5 seconds")
    const candidates = [...panel.querySelectorAll('button[role="tab"], [role="radio"], mat-radio-button, button')].filter(visible).filter(el => !isFlowProjectNavigationControl(el));
    const match = candidates.find(el => {
      const txt = (el.innerText || el.textContent || "").trim().toLowerCase();
      if (txt === str || txt === String(num)) return true;
      const m = txt.match(/^(\d{1,2})[\p{L}\p{M}.]*$/u);
      return m && Number(m[1]) === num;
    });

    if (match) {
      if (!nativeRadioSelected(match) && match.getAttribute("aria-selected") !== "true" && match.getAttribute("data-state") !== "active") {
        match.click();
      }
      return true;
    }
    return false;
  };

  let durationClicked = false;
  for (let attempt = 0; attempt < 3 && !durationClicked; attempt++) {
    if (attempt > 0) await wait(300);
    durationClicked = tryClickDuration();
  }

  if (durationClicked) {
    await wait(300);
  } else {
    const avail = [];
    panel.querySelectorAll('button[role="tab"], button[id*="-trigger-"]').forEach(b => {
      const t = (b.innerText || b.textContent || "").trim();
      if (/^\d+\s*s$/i.test(t) || /-trigger-\d+$/.test(b.id || "")) avail.push(t || b.id);
    });
    console.warn(`[FlowSettings] duration ${duration} (${num}s) not found in panel (available: ${avail.join(", ") || "none"}), keeping current Flow default`);
  }
}

async function chooseAspectRatio(aspectRatio) {
  if (!aspectRatio) return;
  const normalized = normalizeAspectRatio(aspectRatio) || String(aspectRatio).trim();
  await openFlowSettings();
  const panel = flowSettingsPanelVisible() ? (document.querySelector('[role="menu"], [role="dialog"], mat-dialog-container, flow-dialog') || document) : document;

  const candidates = [...panel.querySelectorAll('[role="radio"], mat-radio-button, [role="tab"], [role="option"], button, [role="button"]')].filter(visible).filter(el => !isFlowProjectNavigationControl(el));
  const match = candidates.find(el => {
    const label = accessibleName(el).replace(/\s+/g, " ").trim().toLowerCase();
    const txt = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
    return label === normalized || txt === normalized || label.endsWith(` ${normalized}`) || txt.endsWith(` ${normalized}`);
  });

  if (match) {
    if (!nativeRadioSelected(match) && match.getAttribute("aria-selected") !== "true" && match.getAttribute("data-state") !== "active") {
      match.click();
      await wait(300);
    }
    return;
  }
  console.warn(`[FlowSettings] Aspect ratio "${aspectRatio}" (${normalized}) not found in panel, keeping current Flow default`);
}

async function chooseResolution(resolution) {
  if (!resolution) return;
  const wanted = String(resolution).trim().toLowerCase().replace(/\s+/g, "");
  await openFlowSettings();
  const panel = flowSettingsPanelVisible() ? (document.querySelector('[role="menu"], [role="dialog"], mat-dialog-container, flow-dialog') || document) : document;

  const candidates = [...panel.querySelectorAll('button[role="tab"], [role="radio"], mat-radio-button, button')].filter(visible).filter(el => !isFlowProjectNavigationControl(el));
  const match = candidates.find(el => {
    const txt = (el.innerText || el.textContent || "").trim().toLowerCase().replace(/\s+/g, "");
    return txt === wanted || txt === `${wanted}p` || `${txt}p` === wanted;
  });

  if (match) {
    if (!nativeRadioSelected(match) && match.getAttribute("aria-selected") !== "true" && match.getAttribute("data-state") !== "active") {
      match.click();
      await wait(300);
    }
    return;
  }
  console.warn(`[FlowSettings] resolution "${resolution}" not found in panel, keeping current Flow default`);
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

  // 1. Try Escape dispatch (TobyFlow style)
  for (let attempt = 0; attempt < 2 && isOpen(); attempt++) {
    const esc = () => new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true, cancelable: true, composed: true });
    try { document.dispatchEvent(esc()); } catch (_) {}
    try { document.body.dispatchEvent(esc()); } catch (_) {}
    await wait(150);
  }
  if (!isOpen()) return;

  // 2. Toggle settings trigger
  const trigger = flowButton("Settings trigger");
  if (trigger) {
    trigger.click();
    const closeDeadline = Date.now() + 2000;
    while (Date.now() < closeDeadline && isOpen()) await wait(100);
  }
  if (!isOpen()) return;

  // 3. Fallback: Click composer
  if (isOpen()) {
    document.querySelector(".ProseMirror")?.click();
    const closeDeadline = Date.now() + 1500;
    while (Date.now() < closeDeadline && isOpen()) await wait(100);
  }
  if (isOpen()) {
    console.warn("[FlowSettings] settings panel remained visible after close attempts; proceeding with generation.");
  }
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
  await dismissBlockingOverlays();
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

function normalizeModelLabel(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/^[\u{1F000}-\u{1FFFF}]\s*/u, "")
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function getModelAliases(model) {
  if (!model) return [];
  const norm = normalizeModelLabel(model);
  const list = [norm];
  if (/veo/i.test(norm)) {
    list.push("veo", "veo 2", "veo-2", "veo 2.0", "veo 2 (fast)", "veo 2 (quality)", "veo (fast)", "veo (quality)", "veo fast", "veo quality");
    if (norm.includes("fast")) list.unshift("veo 2 (fast)", "veo (fast)", "veo fast");
    if (norm.includes("quality")) list.unshift("veo 2 (quality)", "veo (quality)", "veo quality");
  } else if (/imagen/i.test(norm)) {
    list.push("imagen", "imagen 3", "imagen-3", "imagen 3.0", "imagen 3 (fast)", "imagen 3 (quality)");
  } else if (/banana/i.test(norm)) {
    list.push("nano banana", "nano banana 2", "nano banana 2.1");
  }
  return [...new Set(list)];
}

function findModelPickerButton() {
  let button = flowButton("Select model family") || flowButton("Model") || flowButton("Model family");
  if (button) return button;

  const panel = flowSettingsPanelVisible() ? (document.querySelector('[role="menu"], [role="dialog"], mat-dialog-container, flow-dialog') || document) : document;
  const candidates = [...panel.querySelectorAll('button, [role="button"], [role="combobox"]')].filter(visible).filter(el => !isFlowProjectNavigationControl(el));

  const isExcluded = el => {
    const txt = (el.innerText || el.textContent || "").trim().toLowerCase();
    const aria = (accessibleName(el) || "").toLowerCase();
    if (/^(?:image|video|frames|ingredients|thành phần|khung hình)$/i.test(txt)) return true;
    if (/^\d+:\d+$/.test(txt) || /^x\d+$/i.test(txt) || /^\d+\s*s$/i.test(txt) || /^\d{3,4}p$/i.test(txt)) return true;
    if (/settings trigger|start generation|clear prompt|add media|back button/i.test(aria)) return true;
    return false;
  };

  button = candidates.find(el => {
    if (isExcluded(el)) return false;
    const txt = (el.innerText || el.textContent || "").trim().toLowerCase();
    const aria = (accessibleName(el) || "").toLowerCase();
    return /select model|model family|model picker/i.test(aria) || /veo|imagen|nano banana/i.test(txt) || /veo|imagen|nano banana/i.test(aria);
  });
  return button || null;
}

async function chooseNativeModel(model, type) {
  if (!model) return;
  const legacyImage = type === "image" && /^\s*(nano banana( 2)?|latest)?\s*$/i.test(model);
  const aliases = getModelAliases(model);

  await openFlowSettings();
  let button = findModelPickerButton();
  if (!button) {
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline && !button) {
      button = findModelPickerButton();
      if (!button) await wait(100);
    }
  }

  if (button) {
    const currentModelText = normalizeModelLabel(button.innerText || button.textContent || accessibleName(button) || "");
    const alreadyApplied = aliases.some(alias => currentModelText === alias || (alias.length >= 3 && currentModelText.includes(alias)));
    if (alreadyApplied) {
      console.log(`[FlowSettings] Model "${model}" already active ("${currentModelText}"), skipping dropdown.`);
      return;
    }
  }

  if (!button) {
    console.warn(`[FlowSettings] Model picker button not found for "${model}", keeping current Flow model.`);
    return;
  }

  button.click();
  await wait(450);

  let items = [];
  const menuDeadline = Date.now() + 4000;
  while (Date.now() < menuDeadline) {
    items = [...document.querySelectorAll('[role="menuitem"], [role="menuitemradio"], mat-option, [role="option"]')].filter(visible);
    if (!items.length) {
      const activeMenu = document.querySelector('[role="menu"]:last-of-type, [data-radix-popper-content-wrapper]:last-of-type, .cdk-overlay-pane:last-of-type');
      if (activeMenu) items = [...activeMenu.querySelectorAll('button, [role="menuitem"], [role="menuitemradio"]')].filter(visible);
    }
    if (items.length) break;
    await wait(100);
  }

  const names = items.map(accessibleName).map(normalizeModelLabel);
  let index = -1;

  if (legacyImage) {
    index = names.reduce((best, name, i) => {
      const match = /nano banana\s+(\d+(?:\.\d+)*)(?!.*\blite\b)/i.exec(name);
      if (!match || /\blite\b/i.test(name)) return best;
      const version = match[1].split(".").map(Number);
      const score = version.reduce((value, part) => value * 1000 + part, 0);
      return score > best.score ? { index: i, score } : best;
    }, { index: -1, score: -1 }).index;
    if (index < 0) {
      index = names.findIndex(name => /nano banana/i.test(name) && !/\blite\b/i.test(name));
    }
  } else {
    // 1. Try exact alias match
    index = items.findIndex((item, i) => {
      const label = names[i] || normalizeModelLabel(item.textContent);
      return aliases.includes(label);
    });

    // 2. Try partial match respecting fast vs quality
    if (index < 0) {
      index = items.findIndex((item, i) => {
        const domText = names[i] || normalizeModelLabel(item.textContent);
        const matched = aliases.find(a => domText.includes(a));
        if (!matched) return false;
        if (matched.includes("veo") && domText.includes("veo")) {
          if (matched.includes("fast") && !domText.includes("fast")) return false;
          if (matched.includes("quality") && !domText.includes("quality")) return false;
        }
        if (matched.includes("imagen") && domText.includes("imagen")) {
          if (matched.includes("fast") && !domText.includes("fast")) return false;
          if (matched.includes("quality") && !domText.includes("quality")) return false;
        }
        return true;
      });
    }
  }

  if (index < 0) {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    console.warn(`[FlowSettings] Model "${model}" was not found in dropdown. Available: [${names.join(", ")}]. Keeping Flow default.`);
    return;
  }

  const chosenItem = items[index];
  chosenItem.click();
  await wait(500);

  if (chosenItem.isConnected && visible(chosenItem)) {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await wait(200);
  }
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
