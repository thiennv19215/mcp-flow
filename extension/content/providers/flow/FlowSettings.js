(function (root) {
  "use strict";

  const isNavControl = el => root.isFlowProjectNavigationControl?.(el) || false;

  function flowSettingsTrigger() {
    const tune = [...document.querySelectorAll('button,[role="button"]')].find(el => {
      if (!root.visible?.(el) || isNavControl(el)) return false;
      const icon = (root.flowFindIcon ? root.flowFindIcon(el) : el.querySelector?.("mat-icon,.mat-icon,.google-symbols"))?.textContent?.trim()?.toLowerCase();
      return icon === (root.FlowSelectors?.settings?.triggerButton?.icon || "tune");
    });
    return tune || root.flowButton?.("Settings trigger");
  }

  function flowComposerRoot() {
    const editor = (typeof root.flowQuery === "function" ? root.flowQuery("editor") : null) ||
      document.querySelector(".ProseMirror[contenteditable='true']");
    return editor?.closest("flow-base-prompt-box, .flow-composer, form, [class*='composer']") ||
      (typeof root.flowQuery === "function" ? root.flowQuery("composerRoot") : null) ||
      [...document.querySelectorAll("flow-base-prompt-box, .flow-composer, [class*='composer']")].find(el => root.visible?.(el)) || null;
  }

  const OPTION_ALIASES = {
    video: ["video", "clip"],
    image: ["image", "hình ảnh", "ảnh", "photo"],
    ingredients: ["ingredients", "thành phần", "nguyên liệu", "ingredient"],
    frames: ["frames", "khung hình", "khung ảnh", "khung", "frame"],
  };

  function flowRadio(name) {
    const wanted = String(name || "").trim().toLowerCase();
    const normalizedWanted = root.normalizeAspectRatio?.(wanted) || wanted;
    const aliases = OPTION_ALIASES[wanted] || (normalizedWanted ? [wanted, normalizedWanted] : [wanted]);
    
    const variantMatch = wanted.match(/^x([1-4])$/);
    const variantNum = variantMatch ? variantMatch[1] : null;

    return [...document.querySelectorAll('[role="radio"],mat-radio-button,[role="tab"]')].find(el => {
      if (!root.visible?.(el) || isNavControl(el)) return false;
      const label = (root.accessibleName?.(el) || "").replace(/\s+/g, " ").trim().toLowerCase();
      const inner = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();

      if (aliases.some(a => label === a || inner === a || label.endsWith(` ${a}`) || inner.endsWith(` ${a}`) || label.startsWith(`${a} `) || inner.startsWith(`${a} `))) return true;
      if (normalizedWanted && (label === normalizedWanted || inner === normalizedWanted || label.includes(normalizedWanted) || inner.includes(normalizedWanted))) return true;

      if (variantNum) {
        if (label === `x${variantNum}` || inner === `x${variantNum}` || label === variantNum || inner === variantNum) return true;
        if (label.includes(`${variantNum} kết quả`) || inner.includes(`${variantNum} kết quả`)) return true;
        if (label.includes(`${variantNum} biến thể`) || inner.includes(`${variantNum} biến thể`)) return true;
        if (label.includes(`${variantNum} ảnh`) || inner.includes(`${variantNum} ảnh`)) return true;
        if (label.includes(`${variantNum} hình ảnh`) || inner.includes(`${variantNum} hình ảnh`)) return true;
        if (label.includes(`${variantNum} video`) || inner.includes(`${variantNum} video`)) return true;
      }

      return root.matchesName?.(label, name, null, true) || root.matchesName?.(inner, name, null, true);
    });
  }

  function flowOption(name) {
    const expected = String(name).replace(/\s+/g, " ").trim().toLowerCase();
    const normalizedExpected = root.normalizeAspectRatio?.(expected) || expected;
    const aliases = OPTION_ALIASES[expected] || (normalizedExpected ? [expected, normalizedExpected] : [expected]);
    const settingsTrigger = flowSettingsTrigger();

    const variantMatch = expected.match(/^x([1-4])$/);
    const variantNum = variantMatch ? variantMatch[1] : null;

    return [...document.querySelectorAll('[role="radio"],mat-radio-button,[role="tab"],[role="option"],button,[role="button"]')].find(el => {
      const label = (root.accessibleName?.(el) || "").replace(/\s+/g, " ").trim().toLowerCase();
      const inner = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      if (!root.visible?.(el) || el === settingsTrigger || isNavControl(el)) return false;

      if (aliases.some(a => label === a || inner === a || label.endsWith(` ${a}`) || inner.endsWith(` ${a}`) || label.startsWith(`${a} `) || inner.startsWith(`${a} `))) return true;
      if (normalizedExpected && (label === normalizedExpected || inner === normalizedExpected || label.includes(normalizedExpected) || inner.includes(normalizedExpected))) return true;

      if (variantNum) {
        if (label === `x${variantNum}` || inner === `x${variantNum}` || label === variantNum || inner === variantNum) return true;
        if (label.includes(`${variantNum} kết quả`) || inner.includes(`${variantNum} kết quả`)) return true;
        if (label.includes(`${variantNum} biến thể`) || inner.includes(`${variantNum} biến thể`)) return true;
        if (label.includes(`${variantNum} ảnh`) || inner.includes(`${variantNum} ảnh`)) return true;
        if (label.includes(`${variantNum} hình ảnh`) || inner.includes(`${variantNum} hình ảnh`)) return true;
        if (label.includes(`${variantNum} video`) || inner.includes(`${variantNum} video`)) return true;
      }

      return false;
    });
  }

  function nativeRadioSelected(radio) {
    if (!radio) return false;
    const stateControl = radio.closest('[role="radio"],[role="tab"],[role="option"],[aria-checked],[aria-pressed],[aria-selected],mat-radio-button,mat-button-toggle') || radio;
    const controls = stateControl === radio ? [radio] : [radio, stateControl];
    return controls.some(control =>
      control.getAttribute("aria-checked") === "true" ||
      control.getAttribute("aria-pressed") === "true" ||
      control.getAttribute("aria-selected") === "true" ||
      control.getAttribute("data-selected") === "true" ||
      control.getAttribute("data-state") === "checked" ||
      control.getAttribute("data-state") === "active" ||
      [...control.classList].some(className => /(?:^|[-_])(?:checked|selected|active|activated)(?:$|[-_])/i.test(className))
    ) || Boolean(stateControl.querySelector('input[type="radio"]:checked,input[type="checkbox"]:checked,[aria-checked="true"],[aria-pressed="true"],[aria-selected="true"],[data-state="checked"]'));
  }

  function flowSettingsPanelVisible() {
    // A Flow project-navigation overlay can also contain “Image” and “Video”.
    // Inspect each overlay and require settings-specific controls before treating it as open.
    const openPanels = [...document.querySelectorAll('[role="dialog"], [role="menu"], mat-dialog-container, flow-dialog, .cdk-overlay-pane')]
      .filter(el => root.visible?.(el) && !isNavControl(el) &&
        el.querySelector?.('[role="radio"], mat-radio-button, button[id*="-trigger-"]'));
    for (const openPanel of openPanels) {
      const controls = [...openPanel.querySelectorAll('[role="radio"], mat-radio-button, [role="tab"], button')];
      const names = controls.filter(r => root.visible?.(r)).map(r => {
        const name = root.accessibleName?.(r) || r.innerText || r.textContent || "";
        return String(name).replace(/\b(accessibility_new|person|movie|image|videocam|mic|dashboard)\b/gi, " ")
          .replace(/\s+/g, " ").trim().toLocaleLowerCase("vi");
      });
      const hasOption = option => {
        const aliases = OPTION_ALIASES[option] || [option];
        return names.some(name => aliases.some(alias =>
          name === alias || name.startsWith(`${alias} `) || name.endsWith(` ${alias}`)));
      };
      const hasVariants = [1, 2, 3, 4].some(count => names.some(name =>
        name === `x${count}` || name === String(count) ||
        new RegExp(`(?:^|\\s)${count}\\s*(?:kết quả|biến thể|ảnh|hình ảnh|video)(?:$|\\s)`, "i").test(name)));
      const hasAspectRatio = names.some(name => /(?:^|\s)(?:9:16|16:9|1:1|4:3|3:4)(?:$|\s)/.test(name));
      const looksLikeProjectNavigation = names.some(name => /^(?:all media|tất cả nội dung nghe nhìn|tất cả phương tiện)$/.test(name)) &&
        names.some(name => /^(?:characters|nhân vật)$/.test(name)) &&
        names.some(name => /^(?:upload|uploads|tệp tải lên|tải lên)$/.test(name));
      const hasSettingsContent = !looksLikeProjectNavigation &&
        ((hasOption("image") && hasOption("video")) || hasVariants || hasAspectRatio);
      if (hasSettingsContent) return true;
    }

    const hasTypeOption = Boolean(flowRadio("Image") || flowOption("Image")) && Boolean(flowRadio("Video") || flowOption("Video"));
    const hasVariantOption = [1, 2, 3, 4].some(count => flowRadio(`x${count}`) || flowOption(`x${count}`));
    return hasTypeOption && hasVariantOption;
  }

  async function openFlowSettings() {
    if (flowSettingsPanelVisible()) return true;
    const trigger = flowSettingsTrigger();
    if (!trigger) throw root.flowError("FLOW_SETTINGS_UNAVAILABLE", "Flow's settings panel cannot be opened; no generation was submitted.", true);
    trigger.click();
    await root.wait?.(400);
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      if (flowSettingsPanelVisible()) return true;
      await root.wait?.(100);
    }
    throw root.flowError("FLOW_SETTINGS_OPEN_FAILED", "Flow's settings panel did not open; no generation was submitted.", true);
  }

  async function closeFlowSettings() {
    const isOpen = () => flowSettingsPanelVisible();
    if (!isOpen()) return;

    for (let attempt = 0; attempt < 2 && isOpen(); attempt++) {
      root.dispatchEscapeKey?.();
      await root.wait?.(150);
    }
    if (!isOpen()) return;

    const trigger = flowSettingsTrigger();
    if (trigger) {
      trigger.click();
      const closeDeadline = Date.now() + 2000;
      while (Date.now() < closeDeadline && isOpen()) await root.wait?.(100);
    }
    if (!isOpen()) return;

    if (isOpen()) {
      ((typeof root.flowQuery === "function" ? root.flowQuery("editor") : null) || document.querySelector(".ProseMirror"))?.click();
      const closeDeadline = Date.now() + 1500;
      while (Date.now() < closeDeadline && isOpen()) await root.wait?.(100);
    }
  }

  async function chooseDuration(duration) {
    if (!duration) return;
    const num = parseInt(String(duration), 10);
    if (isNaN(num)) return;
    const str = `${num}s`;

    await openFlowSettings();
    const panel = flowSettingsPanelVisible() ? (document.querySelector('[role="menu"], [role="dialog"], mat-dialog-container, flow-dialog, .cdk-overlay-pane') || document) : document;

    const tryClickDuration = () => {
      const idBtn = panel.querySelector(`button[id$="-trigger-${num}"]`);
      if (idBtn && root.visible?.(idBtn)) {
        if (!nativeRadioSelected(idBtn) && idBtn.getAttribute("aria-selected") !== "true" && idBtn.getAttribute("data-state") !== "active") {
          idBtn.click();
        }
        return true;
      }
      const candidates = [...panel.querySelectorAll('button[role="tab"], [role="radio"], mat-radio-button, button')].filter(el => root.visible?.(el) && !isNavControl(el));
      const match = candidates.find(el => {
        const txt = (el.innerText || el.textContent || "").trim().toLowerCase();
        const aria = (root.accessibleName?.(el) || "").trim().toLowerCase();
        if (txt === str || aria === str || txt === String(num) || aria === String(num)) return true;
        if (txt === `${num} giây` || aria === `${num} giây` || txt.includes(`${num} giây`) || aria.includes(`${num} giây`)) return true;
        if (txt === `${num}s` || aria === `${num}s`) return true;
        const m = txt.match(/^(\d{1,2})[\p{L}\p{M}.]*$/u) || aria.match(/^(\d{1,2})[\p{L}\p{M}.]*$/u);
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
      if (attempt > 0) await root.wait?.(300);
      durationClicked = tryClickDuration();
    }
    if (durationClicked) await root.wait?.(300);
  }

  async function chooseAspectRatio(aspectRatio) {
    if (!aspectRatio) return;
    const normalized = root.normalizeAspectRatio?.(aspectRatio) || String(aspectRatio).trim();
    await openFlowSettings();
    const panel = flowSettingsPanelVisible() ? (document.querySelector('[role="menu"], [role="dialog"], mat-dialog-container, flow-dialog, .cdk-overlay-pane') || document) : document;

    const candidates = [...panel.querySelectorAll('[role="radio"], mat-radio-button, [role="tab"], [role="option"], button, [role="button"]')].filter(el => root.visible?.(el) && !isNavControl(el));
    const match = candidates.find(el => {
      const label = (root.accessibleName?.(el) || "").replace(/\s+/g, " ").trim().toLowerCase();
      const txt = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();

      if (label === normalized || txt === normalized || label.endsWith(` ${normalized}`) || txt.endsWith(` ${normalized}`)) return true;
      if (label.includes(normalized) || txt.includes(normalized)) return true;

      // Hỗ trợ từ khóa định dạng tiếng Việt
      if (normalized === "9:16" && (/^(?:dọc|portrait|vertical)$/i.test(label) || /^(?:dọc|portrait|vertical)$/i.test(txt))) return true;
      if (normalized === "16:9" && (/^(?:ngang|landscape|horizontal|widescreen)$/i.test(label) || /^(?:ngang|landscape|horizontal|widescreen)$/i.test(txt))) return true;
      if (normalized === "1:1" && (/^(?:vuông|square)$/i.test(label) || /^(?:vuông|square)$/i.test(txt))) return true;

      return false;
    });

    if (match) {
      if (!nativeRadioSelected(match) && match.getAttribute("aria-selected") !== "true" && match.getAttribute("data-state") !== "active") {
        match.click();
        await root.wait?.(300);
      }
    }
  }

  async function chooseResolution(resolution) {
    if (!resolution) return;
    const wanted = String(resolution).trim().toLowerCase().replace(/\s+/g, "");
    await openFlowSettings();
    const panel = flowSettingsPanelVisible() ? (document.querySelector('[role="menu"], [role="dialog"], mat-dialog-container, flow-dialog') || document) : document;

    const candidates = [...panel.querySelectorAll('button[role="tab"], [role="radio"], mat-radio-button, button')].filter(el => root.visible?.(el) && !isNavControl(el));
    const match = candidates.find(el => {
      const txt = (el.innerText || el.textContent || "").trim().toLowerCase().replace(/\s+/g, "");
      return txt === wanted || txt === `${wanted}p` || `${txt}p` === wanted;
    });

    if (match) {
      if (!nativeRadioSelected(match) && match.getAttribute("aria-selected") !== "true" && match.getAttribute("data-state") !== "active") {
        match.click();
        await root.wait?.(300);
      }
    }
  }

  async function chooseRadio(name) {
    let radio = flowRadio(name);
    if (!radio) {
      await openFlowSettings();
      const findOption = () => flowRadio(name) || flowOption(name);
      const openedBy = Date.now() + 2500;
      while (Date.now() < openedBy && !radio) { await root.wait?.(100); radio = findOption(); }
    }
    if (!radio) {
      const options = [...document.querySelectorAll('[role="radio"],mat-radio-button,[role="tab"],[role="option"],button,[role="button"]')]
        .filter(el => root.visible?.(el)).map(el => (root.accessibleName?.(el) || "").replace(/\s+/g, " ").trim()).filter(Boolean);
      throw root.flowError("FLOW_OPTION_NOT_FOUND", `Flow has no visible "${name}" option for the current settings. Visible options: ${[...new Set(options)].slice(0, 30).join(", ") || "none"}.`);
    }
    if (!nativeRadioSelected(radio)) radio.click();
    await root.wait?.(400);
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const current = flowRadio(name) || (flowSettingsPanelVisible() && flowOption(name));
      if (nativeRadioSelected(current)) return;
      if (!current && (!radio.isConnected || !root.visible?.(radio))) return;
      await root.wait?.(100);
    }
    radio = flowRadio(name) || (flowSettingsPanelVisible() && flowOption(name));
    if (radio && !nativeRadioSelected(radio)) {
      radio.click();
      const retryDeadline = Date.now() + 2500;
      while (Date.now() < retryDeadline) {
        const current = flowRadio(name) || (flowSettingsPanelVisible() && flowOption(name));
        if (nativeRadioSelected(current) || (!current && (!radio.isConnected || !root.visible?.(radio)))) return;
        await root.wait?.(100);
      }
    }
    throw root.flowError("FLOW_OPTION_SELECTION_FAILED", `Flow did not confirm that "${name}" was selected. Nothing was submitted.", true`);
  }

  async function chooseNativeVariantCount(count, options = {}) {
    const variants = Math.max(1, Math.min(4, Number(count) || 1));
    const name = `x${variants}`;
    const composer = options.composerOnly ? flowComposerRoot() : null;
    if (composer) {
      const modelButton = findModelPickerButton(composer);
      const currentName = normalizeModelLabel(modelButton?.innerText || modelButton?.textContent || root.accessibleName?.(modelButton) || "");
      const currentCount = currentName.match(/(?:^|\s)x([1-4])(?:\s|$)/)?.[1];
      if (currentCount === String(variants)) return variants;
      const countControl = [...composer.querySelectorAll('[role="radio"],[role="option"],[role="tab"],button,[role="button"]')]
        .find(el => root.visible?.(el) && !isNavControl(el) &&
          new RegExp(`^(?:x${variants}|${variants}|${variants}\\s+(?:ảnh|hình ảnh|video|kết quả))$`, "i")
            .test(normalizeModelLabel(root.accessibleName?.(el) || el.innerText || el.textContent || "")));
      if (!countControl) {
        throw root.flowError("FLOW_VARIANT_OPTION_MISSING", `Flow's composer does not expose ${name}; no generation was submitted.`, true);
      }
      countControl.click();
      await root.wait?.(350);
      const updatedName = normalizeModelLabel(modelButton?.innerText || modelButton?.textContent || root.accessibleName?.(modelButton) || "");
      if (!new RegExp(`(?:^|\\s)x${variants}(?:\\s|$)`).test(updatedName) && !nativeRadioSelected(countControl)) {
        throw root.flowError("FLOW_VARIANT_SELECTION_UNCONFIRMED", `Flow did not confirm ${name} in its composer. Nothing was submitted.`, true);
      }
      return variants;
    }
    await openFlowSettings();
    let option = flowRadio(name) || flowOption(name);
    if (!option) throw root.flowError("FLOW_VARIANT_OPTION_MISSING", `Flow did not show the ${name} output option. Nothing was submitted.`, true);
    option.click();
    await root.wait?.(450);

    const summaryConfirms = () => {
      const trigger = flowSettingsTrigger();
      const summary = (trigger?.innerText || trigger?.textContent || "").replace(/\s+/g, " ").trim();
      return new RegExp(`(?:^|\\s)${name}(?:\\s|$)`, "i").test(summary);
    };
    const deadline = Date.now() + 5000;
    let stableSelectionChecks = 0;
    let stableSummaryChecks = 0;
    while (Date.now() < deadline) {
      option = flowRadio(name) || flowOption(name);
      if (summaryConfirms()) {
        if (++stableSummaryChecks >= 2) { await root.wait?.(300); return variants; }
      } else stableSummaryChecks = 0;
      if (option && nativeRadioSelected(option)) {
        if (++stableSelectionChecks >= 2) { await root.wait?.(300); return variants; }
      } else {
        stableSelectionChecks = 0;
        if ((!option || !option.isConnected || !root.visible?.(option)) && summaryConfirms()) {
          await root.wait?.(300);
          return variants;
        }
      }
      await root.wait?.(200);
    }
    throw root.flowError("FLOW_VARIANT_SELECTION_UNCONFIRMED", `Flow did not confirm the requested ${name} output count. Nothing was submitted.`, true);
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

  function findModelPickerButton(scope = document) {
    let button = root.flowButton?.("Select model family", scope) || root.flowButton?.("Model", scope) || root.flowButton?.("Model family", scope) ||
      root.flowButton?.("Chọn dòng mô hình", scope) || root.flowButton?.("Chọn mô hình", scope) || root.flowButton?.("Dòng mô hình", scope) || root.flowButton?.("Mô hình", scope);
    if (button) return button;

    const panel = scope === document && flowSettingsPanelVisible()
      ? (document.querySelector('[role="menu"], [role="dialog"], mat-dialog-container, flow-dialog, .cdk-overlay-pane') || document)
      : scope;
    const candidates = [...panel.querySelectorAll('button, [role="button"], [role="combobox"]')].filter(el => root.visible?.(el) && !isNavControl(el));

    const isExcluded = el => {
      const txt = (el.innerText || el.textContent || "").trim().toLowerCase();
      const aria = (root.accessibleName?.(el) || "").toLowerCase();
      if (/^(?:image|video|frames|ingredients|thành phần|khung hình|hình ảnh|ảnh|nguyên liệu)$/i.test(txt)) return true;
      if (/^\d+:\d+$/.test(txt) || /^x\d+$/i.test(txt) || /^\d+\s*s$/i.test(txt) || /^\d+\s*giây$/i.test(txt) || /^\d{3,4}p$/i.test(txt)) return true;
      if (/settings trigger|start generation|clear prompt|add media|back button|cài đặt|bắt đầu tạo|xóa câu lệnh|thêm nội dung|nút quay lại/i.test(aria)) return true;
      return false;
    };

    button = candidates.find(el => {
      if (isExcluded(el)) return false;
      const txt = (el.innerText || el.textContent || "").trim().toLowerCase();
      const aria = (root.accessibleName?.(el) || "").toLowerCase();
      return /select model|model family|model picker|chọn dòng mô hình|chọn mô hình|dòng mô hình|mô hình/i.test(aria) || /veo|imagen|nano banana/i.test(txt) || /veo|imagen|nano banana/i.test(aria);
    });
    return button || null;
  }

  async function chooseNativeModel(model, type) {
    if (!model) return;
    const legacyImage = type === "image" && /^\s*(nano banana( 2)?|latest)?\s*$/i.test(model);
    const aliases = getModelAliases(model);

    let button = findModelPickerButton();
    if (!button) {
      await openFlowSettings();
      button = findModelPickerButton();
    }
    if (!button) {
      const deadline = Date.now() + 2500;
      while (Date.now() < deadline && !button) {
        button = findModelPickerButton();
        if (!button) await root.wait?.(100);
      }
    }

    if (button) {
      const currentModelText = normalizeModelLabel(button.innerText || button.textContent || root.accessibleName?.(button) || "");
      const alreadyApplied = aliases.some(alias => currentModelText === alias || (alias.length >= 3 && currentModelText.includes(alias)));
      if (alreadyApplied) return;
    }

    if (!button) return;

    button.click();
    await root.wait?.(450);

    let items = [];
    const menuDeadline = Date.now() + 4000;
    while (Date.now() < menuDeadline) {
      items = [...document.querySelectorAll('[role="menuitem"], [role="menuitemradio"], mat-option, [role="option"]')].filter(el => root.visible?.(el));
      if (!items.length) {
        const activeMenu = document.querySelector('[role="menu"]:last-of-type, [data-radix-popper-content-wrapper]:last-of-type, .cdk-overlay-pane:last-of-type');
        if (activeMenu) items = [...activeMenu.querySelectorAll('button, [role="menuitem"], [role="menuitemradio"]')].filter(el => root.visible?.(el));
      }
      if (items.length) break;
      await root.wait?.(100);
    }

    const names = items.map(el => root.accessibleName?.(el)).map(normalizeModelLabel);
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
      index = items.findIndex((item, i) => {
        const label = names[i] || normalizeModelLabel(item.textContent);
        return aliases.includes(label);
      });
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
      root.dispatchEscapeKey?.();
      return;
    }

    const chosenItem = items[index];
    chosenItem.click();
    await root.wait?.(500);

    if (chosenItem.isConnected && root.visible?.(chosenItem)) {
      root.dispatchEscapeKey?.();
      await root.wait?.(200);
    }
  }

  async function restoreNativeFramesMode() {
    await openFlowSettings();
    const findFrames = () => [...document.querySelectorAll('[role="radio"],mat-radio-button,[role="tab"],[role="option"],button,[role="button"]')]
      .find(el => root.visible?.(el) && !isNavControl(el) &&
        /^(?:frames|khung hình|khung|khung ảnh)$/i.test((root.accessibleName?.(el) || "").replace(/^(?:accessibility_new|dashboard|face)\s*/i, "").replace(/\s+/g, " ").trim()));
    let frames = findFrames();
    if (!frames) throw root.flowError("FLOW_FRAMES_MODE_UNAVAILABLE", "Flow does not show a Frames mode control after local frame upload. Nothing was submitted.", true, false);
    if (!nativeRadioSelected(frames) && frames.getAttribute("aria-selected") !== "true") frames.click();
    const hasFrameControls = () => Boolean(root.flowButton?.("Start") && root.flowButton?.("End"));
    const deadline = Date.now() + 5000;
    let confirmed = false;
    while (Date.now() < deadline) {
      frames = findFrames();
      if (frames && (nativeRadioSelected(frames) || frames.getAttribute("aria-selected") === "true" || hasFrameControls())) { confirmed = true; break; }
      if (!flowSettingsPanelVisible()) await openFlowSettings();
      await root.wait?.(100);
    }
    if (!confirmed) throw root.flowError("FLOW_FRAMES_MODE_UNCONFIRMED", "Flow did not confirm Frames mode after local frame upload. Nothing was submitted.", true, false);
    await closeFlowSettings();
    const controlsDeadline = Date.now() + 4000;
    while (Date.now() < controlsDeadline && !hasFrameControls()) await root.wait?.(100);
    if (!root.flowButton?.("Start") || !root.flowButton?.("End")) {
      throw root.flowError("FLOW_FRAMES_CONTROLS_UNAVAILABLE", "Flow selected Frames but did not restore both Start and End frame controls. Nothing was submitted.", true, false);
    }
  }

  async function prepareNativeImageSettings(payload, variants) {
    const aspectRatio = payload?.aspectRatio || payload?.aspect_ratio;
    const requestedModel = payload?.model || "Nano Banana";
    const composer = flowComposerRoot();
    const composerModel = composer && findModelPickerButton(composer);
    const modernComposer = Boolean(composer && composerModel);

    if (!modernComposer) {
      await openFlowSettings();
      await chooseRadio("Image");
      if (aspectRatio) await chooseAspectRatio(aspectRatio);
    }

    if (requestedModel) {
      await chooseNativeModel(requestedModel, "image");
      if (!modernComposer) {
        await openFlowSettings();
        await chooseRadio("Image");
        if (aspectRatio) await chooseAspectRatio(aspectRatio);
      }
    }

    if (modernComposer && aspectRatio && root.normalizeAspectRatio?.(aspectRatio) !== "16:9") {
      throw root.flowError("FLOW_ASPECT_RATIO_UNAVAILABLE", "This Flow composer does not expose aspect-ratio controls yet. Choose 16:9 or use the standard Flow settings page. Nothing was submitted.", true);
    }
    await chooseNativeVariantCount(variants, { composerOnly: modernComposer });
    const settingsCredits = await (root.FlowEditor?.waitForGenerationCreditQuote?.(2000) || root.waitForGenerationCreditQuote?.(2000));
    if (!modernComposer) await closeFlowSettings();
    return settingsCredits;
  }

  const MODE_ALIASES = {
    ingredients: ["ingredients", "thành phần", "nguyên liệu", "ingredient"],
    frames: ["frames", "khung hình", "khung", "frame"],
  };

  function exactModeControl(name) {
    const rawWanted = String(name || "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
    const aliases = MODE_ALIASES[rawWanted] || [rawWanted];
    return [...document.querySelectorAll('[role="radio"],mat-radio-button,[role="tab"],[role="option"],button,[role="button"]')]
      .find(element => {
        if (!root.visible?.(element) || isNavControl(element)) return false;
        const cName = String(root.accessibleName?.(element) || "").replace(/^(?:accessibility_new|dashboard|face)\s*/i, "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
        return aliases.includes(cName) || aliases.some(a => cName.endsWith(` ${a}`));
      });
  }

  async function selectAndConfirmMode(name, framesMode) {
    let control = exactModeControl(name);
    if (!control) {
      const hasFrameControls = () => Boolean(root.flowButton?.("Start") && root.flowButton?.("End"));
      if (framesMode && hasFrameControls()) return;
      const code = framesMode ? "FLOW_FRAMES_MODE_UNAVAILABLE" : "FLOW_VIDEO_MODE_UNAVAILABLE";
      throw root.flowError(code, `Flow does not offer the exact ${name} mode for the selected model. Nothing was submitted.`, true, false);
    }
    if (!nativeRadioSelected(control) && control.getAttribute("aria-selected") !== "true") control.click();
    const hasFrameControls = () => Boolean(root.flowButton?.("Start") && root.flowButton?.("End"));
    const deadline = Date.now() + 5000;
    let confirmed = false;
    while (Date.now() < deadline) {
      control = exactModeControl(name);
      if (control && (nativeRadioSelected(control) || control.getAttribute("aria-selected") === "true" || (framesMode && hasFrameControls()))) { confirmed = true; break; }
      if (!flowSettingsPanelVisible()) await openFlowSettings();
      await root.wait?.(100);
    }
    if (!confirmed) {
      if (framesMode && hasFrameControls()) confirmed = true;
      else {
        const code = framesMode ? "FLOW_FRAMES_MODE_UNCONFIRMED" : "FLOW_VIDEO_MODE_UNCONFIRMED";
        throw root.flowError(code, `Flow did not confirm that ${name} mode is selected. Nothing was submitted.`, true, false);
      }
    }
    if (framesMode) {
      const controlsDeadline = Date.now() + 4000;
      while (Date.now() < controlsDeadline && !hasFrameControls()) await root.wait?.(100);
      if (!hasFrameControls()) {
        throw root.flowError("FLOW_FRAMES_CONTROLS_UNAVAILABLE", "Flow selected Frames but did not show both Start and End frame controls. Nothing was submitted.", true, false);
      }
    }
  }

  async function prepareNativeVideoSettings(payload, variants, framesMode) {
    const type = payload.type || "video";
    const requestedModel = payload.model || payload.video_settings?.model;
    const modeName = framesMode ? "Frames" : "Ingredients";
    const aspectRatio = payload.aspectRatio || payload.aspect_ratio;
    const duration = payload.duration || payload.video_settings?.duration;
    const resolution = payload.resolution || payload.video_settings?.resolution;

    await openFlowSettings();
    await chooseRadio("Video");
    if (aspectRatio) await chooseAspectRatio(aspectRatio);

    if (requestedModel) {
      await chooseNativeModel(requestedModel, type);
      await openFlowSettings();
      await chooseRadio("Video");
      if (aspectRatio) await chooseAspectRatio(aspectRatio);
    }

    if (duration) await chooseDuration(duration);
    if (resolution) await chooseResolution(resolution);
    await chooseNativeVariantCount(variants);

    await openFlowSettings();
    await selectAndConfirmMode(modeName, Boolean(framesMode));
    const settingsCredits = await (root.FlowEditor?.waitForGenerationCreditQuote?.(2000) || root.waitForGenerationCreditQuote?.(2000));
    await closeFlowSettings();
    return settingsCredits;
  }

  const FlowImageActions = Object.freeze({
    prepare: async (payload, variants) => prepareNativeImageSettings(payload, variants),
    prepareCharacterPortrait: async (character, variants) =>
      prepareNativeImageSettings({ aspectRatio: character.aspect_ratio || "3:4", model: character.model || "Nano Banana" }, variants),
  });

  const FlowVideoActions = Object.freeze({
    prepare: async (payload, variants, framesMode) => prepareNativeVideoSettings(payload, variants, framesMode),
  });

  const FlowSettings = Object.freeze({
    openFlowSettings,
    closeFlowSettings,
    flowSettingsPanelVisible,
    flowRadio,
    flowOption,
    nativeRadioSelected,
    chooseRadio,
    chooseAspectRatio,
    chooseDuration,
    chooseResolution,
    chooseNativeVariantCount,
    chooseNativeModel,
    findModelPickerButton,
    getModelAliases,
    normalizeModelLabel,
    restoreNativeFramesMode,
    prepareNativeImageSettings,
    prepareNativeVideoSettings,
    selectAndConfirmMode,
  });

  root.FlowSettings = FlowSettings;
  root.FlowImageActions = FlowImageActions;
  root.FlowVideoActions = FlowVideoActions;
  root.openFlowSettings = openFlowSettings;
  root.closeFlowSettings = closeFlowSettings;
  root.flowSettingsPanelVisible = flowSettingsPanelVisible;
  root.chooseRadio = chooseRadio;
  root.chooseAspectRatio = chooseAspectRatio;
  root.chooseDuration = chooseDuration;
  root.chooseResolution = chooseResolution;
  root.chooseNativeVariantCount = chooseNativeVariantCount;
  root.chooseNativeModel = chooseNativeModel;
  root.restoreNativeFramesMode = restoreNativeFramesMode;
  root.flowRadio = flowRadio;
  root.flowOption = flowOption;
  root.nativeRadioSelected = nativeRadioSelected;
})(globalThis);
