(function (root) {
  "use strict";

  const isNavControl = el => {
    if (!el || typeof el.closest !== "function") return false;
    // Flow hosts the project editor and settings overlays inside this Material
    // content wrapper. It is not itself a navigation drawer.
    if (el.closest("mat-sidenav-content, mat-drawer-content, .mat-sidenav-content, .mat-drawer-content, main, [role='main']")) return false;
    if (root.isFlowProjectNavigationControl?.(el)) return true;
    if (el.closest('nav, [role="navigation"], header, [role="banner"], mat-toolbar, aside, mat-sidenav, mat-drawer, .mat-sidenav, .mat-drawer, flow-navigation, [class*="sidebar"], flow-library, [class*="media-gallery"], [class*="media-list"]')) return true;
    return false;
  };
  const foldLabel = value => root.normalizeFlowUiText?.(value) || String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  function checkPreparation(options = {}, operation = "preparing Flow settings") {
    root.FlowUiDeadline?.requireTime(Number.isFinite(options.deadline) ? options.deadline : Infinity, operation, false, options.signal);
  }
  let imagePreparationDiagnostics = { phase: "idle", step: "idle", startedAt: null, updatedAt: null, lastResult: null, error: null };
  let videoPreparationDiagnostics = { phase: "idle", step: "idle", startedAt: null, updatedAt: null, lastResult: null, error: null };
  function emitImagePreparationProgress(options = {}, step) {
    const isVideo = options.videoPreparation === true;
    const diagnostics = isVideo ? videoPreparationDiagnostics : imagePreparationDiagnostics;
    if (options.imagePreparation === true) {
      const now = new Date().toISOString();
      imagePreparationDiagnostics = {
        ...imagePreparationDiagnostics,
        phase: "running",
        step,
        startedAt: imagePreparationDiagnostics.phase === "running" ? imagePreparationDiagnostics.startedAt : now,
        updatedAt: now,
        lastResult: null,
        error: null,
      };
    }
    if (isVideo) {
      const now = new Date().toISOString();
      videoPreparationDiagnostics = {
        ...diagnostics,
        phase: "running",
        step,
        startedAt: diagnostics.phase === "running" ? diagnostics.startedAt : now,
        updatedAt: now,
        lastResult: null,
        error: null,
      };
    }
    try { root.FlowTiles?.emitFlowProgress?.(options.command, `Flow ${isVideo ? "video" : "image"} settings: ${step}`); } catch {}
  }
  function finishImagePreparationDiagnostics(phase, details = {}) {
    const now = new Date().toISOString();
    imagePreparationDiagnostics = {
      ...imagePreparationDiagnostics,
      phase,
      updatedAt: now,
      ...(phase === "completed" ? { lastResult: details.result ?? null, error: null } : {}),
      ...(phase === "failed" ? { lastResult: null, error: details.error ?? "Unknown settings error", quoteDiagnostics: details.quoteDiagnostics ?? null } : {}),
    };
  }
  function inspectImagePreparationDiagnostics() {
    return { ...imagePreparationDiagnostics };
  }
  function finishVideoPreparationDiagnostics(phase, details = {}) {
    const now = new Date().toISOString();
    videoPreparationDiagnostics = {
      ...videoPreparationDiagnostics,
      phase,
      updatedAt: now,
      ...(phase === "completed" ? { lastResult: details.result ?? null, error: null } : {}),
      ...(phase === "failed" ? { lastResult: null, error: details.error ?? "Unknown video settings error", quoteDiagnostics: details.quoteDiagnostics ?? null } : {}),
    };
  }
  function inspectVideoPreparationDiagnostics() {
    return { ...videoPreparationDiagnostics };
  }
  async function closeOwnedSettingsSurface(owned, options = {}) {
    if (!owned || !flowSettingsPanelVisible()) return;
    try { await closeFlowSettings(options); } catch { /* Preserve the primary preparation result. */ }
  }
  function safeCreditQuoteDiagnostics() {
    const inspection = root.FlowEditor?.inspectGenerationCreditQuote?.();
    if (!inspection) return null;
    const candidates = Array.isArray(inspection.candidates) ? inspection.candidates : [];
    const reasonCodes = new Set();
    for (const candidate of candidates) {
      const text = String(candidate || "");
      if (/(?:will\s+use|uses?)\s+\d[\d,.]*\s+credits?/i.test(text)) reasonCodes.add("english_will_use");
      else if (/(?:sẽ\s+(?:dùng|sử\s+dụng)|tiêu\s+tốn)\s*\d[\d,.]*\s*tín\s*dụng/i.test(text)) reasonCodes.add("vietnamese_use");
      else reasonCodes.add("unrecognized_credit_text");
    }
    if (!candidates.length) reasonCodes.add("no_candidate");
    return {
      candidateCount: candidates.length,
      reasonCodes: [...reasonCodes],
    };
  }
  async function waitPreparation(options = {}, ms, operation = "preparing Flow settings") {
    if (root.FlowUiDeadline?.boundedWait && Number.isFinite(options.deadline)) {
      await root.FlowUiDeadline.boundedWait(ms, options.deadline, operation, false, options.signal);
      return;
    }
    checkPreparation(options, operation);
    await root.wait?.(ms);
    checkPreparation(options, operation);
  }

  function flowSettingsTrigger() {
    const composer = flowComposerRoot();
    const submit = composer && root.FlowEditor?.getFlowSubmitButton?.();
    const adjacent = submit?.previousElementSibling;
    if (adjacent && composer.contains(adjacent) && /^(?:button|mat-button|div)$/i.test(adjacent.tagName) && root.visible?.(adjacent)) {
      const label = (root.accessibleName?.(adjacent) || adjacent.innerText || adjacent.textContent || "").replace(/\s+/g, " ").trim();
      const icon = (root.flowFindIcon ? root.flowFindIcon(adjacent) : adjacent.querySelector?.("mat-icon,.mat-icon,.google-symbols"))?.textContent?.trim()?.toLowerCase();
      if (/(?:settings?|cài đặt|aspect ratio|tỷ lệ)/i.test(label) || ["tune", "settings", "settings_2", "crop_square", "crop_16_9"].includes(icon)) return adjacent;
    }
    const composerTrigger = composer && root.flowButton?.("Settings trigger", composer);
    if (composerTrigger) return composerTrigger;

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
      (typeof root.flowQueryVisible === "function" ? root.flowQueryVisible("composerRoot", document) : null) ||
      [...document.querySelectorAll("flow-base-prompt-box, .flow-composer, [class*='composer']")].find(el => root.visible?.(el)) || null;
  }

  const OPTION_ALIASES = {
    video: ["video", "clip"],
    image: ["image", "hình ảnh", "ảnh", "photo"],
    ingredients: ["ingredients", "thành phần", "nguyên liệu", "ingredient"],
    frames: ["frames", "khung hình", "khung ảnh", "khung", "frame"],
  };

  function flowRadio(name, scope) {
    const wanted = foldLabel(name);
    const normalizedWanted = root.normalizeAspectRatio?.(wanted) || wanted;
    const aliases = OPTION_ALIASES[wanted] || (normalizedWanted ? [wanted, normalizedWanted] : [wanted]);
    
    const variantMatch = wanted.match(/^x([1-4])$/);
    const variantNum = variantMatch ? variantMatch[1] : null;

    const findIn = rootEl => {
      const candidates = (typeof root.flowQueryAll === "function" ? root.flowQueryAll("settings.options", rootEl, { checkVisible: false }) : null) ||
        [...rootEl.querySelectorAll('[role="radio"],mat-radio-button,[role="tab"]')];
      return candidates.find(el => {
        if (!root.visible?.(el) || isNavControl(el)) return false;
        const label = foldLabel(root.accessibleName?.(el));
        const inner = foldLabel(el.innerText || el.textContent || "");

        if (aliases.some(alias => {
          const a = foldLabel(alias);
          return [label, inner].some(value => value === a || value.endsWith(` ${a}`) || value.startsWith(`${a} `));
        })) return true;
        if (normalizedWanted && (label === normalizedWanted || inner === normalizedWanted || label.includes(normalizedWanted) || inner.includes(normalizedWanted))) return true;

        if (variantNum) {
          if (label === `x${variantNum}` || inner === `x${variantNum}` || label === variantNum || inner === variantNum) return true;
          if (label.includes(`${variantNum} ket qua`) || inner.includes(`${variantNum} ket qua`)) return true;
          if (label.includes(`${variantNum} bien the`) || inner.includes(`${variantNum} bien the`)) return true;
          if (label.includes(`${variantNum} anh`) || inner.includes(`${variantNum} anh`)) return true;
          if (label.includes(`${variantNum} hinh anh`) || inner.includes(`${variantNum} hinh anh`)) return true;
          if (label.includes(`${variantNum} video`) || inner.includes(`${variantNum} video`)) return true;
        }

        return root.matchesName?.(label, name, null, true) || root.matchesName?.(inner, name, null, true);
      });
    };

    if (scope) return findIn(scope);

    // Prioritize settings panel / dialog overlay / composer container
    const panel = (typeof root.flowQuery === "function" ? root.flowQuery("settings.panel", document, { checkVisible: false }) : null) ||
      document.querySelector('[role="menu"], [role="dialog"], mat-dialog-container, flow-dialog, .cdk-overlay-pane, mat-menu-panel');
    const composer = flowComposerRoot();
    if (panel) {
      const match = findIn(panel);
      if (match) return match;
    }
    if (composer) {
      const match = findIn(composer);
      if (match) return match;
    }
    return findIn(document);
  }

  function flowOption(name, scope) {
    const expected = foldLabel(name);
    const normalizedExpected = root.normalizeAspectRatio?.(expected) || expected;
    const aliases = OPTION_ALIASES[expected] || (normalizedExpected ? [expected, normalizedExpected] : [expected]);
    const settingsTrigger = flowSettingsTrigger();

    const variantMatch = expected.match(/^x([1-4])$/);
    const variantNum = variantMatch ? variantMatch[1] : null;

    const findIn = rootEl => {
      const candidates = (typeof root.flowQueryAll === "function" ? root.flowQueryAll("settings.optionCandidates", rootEl, { checkVisible: false }) : null) ||
        [...rootEl.querySelectorAll('[role="radio"],mat-radio-button,[role="tab"],[role="option"],button,[role="button"]')];
      return candidates.find(el => {
        const label = foldLabel(root.accessibleName?.(el));
        const inner = foldLabel(el.innerText || el.textContent || "");
        if (!root.visible?.(el) || el === settingsTrigger || isNavControl(el)) return false;

        if (aliases.some(alias => {
          const a = foldLabel(alias);
          return [label, inner].some(value => value === a || value.endsWith(` ${a}`) || value.startsWith(`${a} `));
        })) return true;
        if (normalizedExpected && (label === normalizedExpected || inner === normalizedExpected || label.includes(normalizedExpected) || inner.includes(normalizedExpected))) return true;

        if (variantNum) {
          if (label === `x${variantNum}` || inner === `x${variantNum}` || label === variantNum || inner === variantNum) return true;
          if (label.includes(`${variantNum} ket qua`) || inner.includes(`${variantNum} ket qua`)) return true;
          if (label.includes(`${variantNum} bien the`) || inner.includes(`${variantNum} bien the`)) return true;
          if (label.includes(`${variantNum} anh`) || inner.includes(`${variantNum} anh`)) return true;
          if (label.includes(`${variantNum} hinh anh`) || inner.includes(`${variantNum} hinh anh`)) return true;
          if (label.includes(`${variantNum} video`) || inner.includes(`${variantNum} video`)) return true;
        }

        return false;
      });
    };

    if (scope) return findIn(scope);

    const panel = (typeof root.flowQuery === "function" ? root.flowQuery("settings.panel", document, { checkVisible: false }) : null) ||
      document.querySelector('[role="menu"], [role="dialog"], mat-dialog-container, flow-dialog, .cdk-overlay-pane, mat-menu-panel');
    const composer = flowComposerRoot();
    if (panel) {
      const match = findIn(panel);
      if (match) return match;
    }
    if (composer) {
      const match = findIn(composer);
      if (match) return match;
    }
    return findIn(document);
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
      [...(control.classList || [])].some(className => /(?:^|[-_])(?:checked|selected|active|activated)(?:$|[-_])/i.test(className))
    ) || Boolean(stateControl.querySelector('input[type="radio"]:checked,input[type="checkbox"]:checked,[aria-checked="true"],[aria-pressed="true"],[aria-selected="true"],[data-state="checked"]'));
  }

  function getVisibleFlowSettingsPanel() {
    // A Flow project-navigation overlay can also contain “Image” and “Video”.
    // Inspect each overlay and require settings-specific controls before treating it as open.
    const panelCandidates = (typeof root.flowQueryAll === "function" ? root.flowQueryAll("settings.panel", document, { checkVisible: false }) : null) ||
      [...document.querySelectorAll('[role="dialog"], [role="menu"], mat-dialog-container, flow-dialog, .cdk-overlay-pane')];
    const openPanels = panelCandidates
      .filter(el => root.visible?.(el) && !isNavControl(el) &&
        el.querySelector?.('[role="radio"], mat-radio-button, button[id*="-trigger-"]'));
    for (const openPanel of openPanels) {
      const controls = (typeof root.flowQueryAll === "function" ? root.flowQueryAll("settings.optionCandidates", openPanel, { checkVisible: false }) : null) ||
        [...openPanel.querySelectorAll('[role="radio"], mat-radio-button, [role="tab"], button')];
      const names = controls.filter(r => root.visible?.(r)).map(r => {
        const name = root.accessibleName?.(r) || r.innerText || r.textContent || "";
        return foldLabel(String(name).replace(/\b(accessibility_new|person|movie|image|videocam|mic|dashboard)\b/gi, " "));
      });
      const hasOption = option => {
        const aliases = OPTION_ALIASES[option] || [option];
        return names.some(name => aliases.some(alias => {
          const folded = foldLabel(alias);
          return name === folded || name.startsWith(`${folded} `) || name.endsWith(` ${folded}`);
        }));
      };
      const hasVariants = [1, 2, 3, 4].some(count => names.some(name =>
        name === `x${count}` || name === String(count) ||
        new RegExp(`(?:^|\\s)${count}\\s*(?:ket qua|bien the|anh|hinh anh|video)(?:$|\\s)`, "i").test(name)));
      const hasAspectRatio = names.some(name => /(?:^|\s)(?:9:16|16:9|1:1|4:3|3:4)(?:$|\s)/.test(name));
      const looksLikeProjectNavigation = names.some(name => /^(?:all media|tat ca noi dung nghe nhin|tat ca phuong tien)$/.test(name)) &&
        names.some(name => /^(?:characters|nhan vat)$/.test(name)) &&
        names.some(name => /^(?:upload|uploads|tep tai len|tai len)$/.test(name));
      const hasSettingsContent = !looksLikeProjectNavigation &&
        ((hasOption("image") && hasOption("video")) || hasVariants || hasAspectRatio);
      if (hasSettingsContent) return openPanel;
    }

    const hasTypeOption = Boolean(flowRadio("Image") || flowOption("Image")) && Boolean(flowRadio("Video") || flowOption("Video"));
    const hasVariantOption = [1, 2, 3, 4].some(count => flowRadio(`x${count}`) || flowOption(`x${count}`));
    return hasTypeOption && hasVariantOption ? document : null;
  }

  function flowSettingsPanelVisible() {
    return Boolean(getVisibleFlowSettingsPanel());
  }

  async function openFlowSettings(options = {}) {
    checkPreparation(options, "opening Flow settings");
    if (flowSettingsPanelVisible()) return true;
    const trigger = flowSettingsTrigger();
    if (!trigger) throw root.flowError("FLOW_SETTINGS_UNAVAILABLE", "Flow's settings panel cannot be opened; no generation was submitted.", true);
    trigger.click();
    await waitPreparation(options, 400, "opening Flow settings");
    if (flowSettingsPanelVisible()) {
      try { options.onSettingsOpened?.(); } catch {}
      return true;
    }
    const deadline = Math.min(Date.now() + 4000, Number.isFinite(options.deadline) ? options.deadline : Infinity);
    while (Date.now() < deadline) {
      checkPreparation(options, "opening Flow settings");
      if (flowSettingsPanelVisible()) {
        try { options.onSettingsOpened?.(); } catch {}
        return true;
      }
      await waitPreparation(options, 100, "opening Flow settings");
    }
    throw root.flowError("FLOW_SETTINGS_OPEN_FAILED", "Flow's settings panel did not open; no generation was submitted.", true);
  }

  async function closeFlowSettings(options = {}) {
    checkPreparation(options, "closing Flow settings");
    const isOpen = () => flowSettingsPanelVisible();
    if (!isOpen()) return;

    for (let attempt = 0; attempt < 2 && isOpen(); attempt++) {
      root.dispatchEscapeKey?.();
      await waitPreparation(options, 150, "closing Flow settings");
    }
    if (!isOpen()) return;

    const trigger = flowSettingsTrigger();
    if (trigger) {
      trigger.click();
      const closeDeadline = Date.now() + 2000;
      while (Date.now() < Math.min(closeDeadline, Number.isFinite(options.deadline) ? options.deadline : Infinity) && isOpen()) await waitPreparation(options, 100, "closing Flow settings");
    }
    if (!isOpen()) return;

    if (isOpen()) {
      ((typeof root.flowQuery === "function" ? root.flowQuery("editor") : null) || document.querySelector(".ProseMirror"))?.click();
      const closeDeadline = Date.now() + 1500;
      while (Date.now() < Math.min(closeDeadline, Number.isFinite(options.deadline) ? options.deadline : Infinity) && isOpen()) await waitPreparation(options, 100, "closing Flow settings");
    }
  }

  async function chooseDuration(duration, options = {}) {
    if (!duration) return;
    const num = parseInt(String(duration), 10);
    if (isNaN(num)) return;
    const str = `${num}s`;

    await openFlowSettings(options);
    const panel = flowSettingsPanelVisible() ? ((typeof root.flowQuery === "function" ? root.flowQuery("settings.panel", document, { checkVisible: false }) : null) || document.querySelector('[role="menu"], [role="dialog"], mat-dialog-container, flow-dialog, .cdk-overlay-pane') || document) : document;

    const tryClickDuration = () => {
      const idBtn = panel.querySelector(`button[id$="-trigger-${num}"]`);
      if (idBtn && root.visible?.(idBtn)) {
        if (!nativeRadioSelected(idBtn) && idBtn.getAttribute("aria-selected") !== "true" && idBtn.getAttribute("data-state") !== "active") {
          idBtn.click();
        }
        return true;
      }
      const candidates = [...((typeof root.flowQueryAll === "function" ? root.flowQueryAll("settings.optionCandidates", panel, { checkVisible: false }) : null) || panel.querySelectorAll('button[role="tab"], [role="radio"], mat-radio-button, button'))].filter(el => root.visible?.(el) && !isNavControl(el));
      const match = candidates.find(el => {
        const txt = foldLabel(el.innerText || el.textContent || "");
        const aria = foldLabel(root.accessibleName?.(el));
        if (txt === foldLabel(str) || aria === foldLabel(str) || txt === String(num) || aria === String(num)) return true;
        if (txt === `${num} giay` || aria === `${num} giay` || txt.includes(`${num} giay`) || aria.includes(`${num} giay`)) return true;
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
      if (attempt > 0) await waitPreparation(options, 300, "selecting Flow video duration");
      durationClicked = tryClickDuration();
    }
    if (durationClicked) await waitPreparation(options, 300, "confirming Flow video duration");
  }

  async function chooseAspectRatio(aspectRatio, options = {}) {
    if (!aspectRatio) return;
    const normalized = root.normalizeAspectRatio?.(aspectRatio) || String(aspectRatio).trim();
    await openFlowSettings(options);
    const panel = flowSettingsPanelVisible() ? ((typeof root.flowQuery === "function" ? root.flowQuery("settings.panel", document, { checkVisible: false }) : null) || document.querySelector('[role="menu"], [role="dialog"], mat-dialog-container, flow-dialog, .cdk-overlay-pane') || document) : document;

    const candidates = [...((typeof root.flowQueryAll === "function" ? root.flowQueryAll("settings.optionCandidates", panel, { checkVisible: false }) : null) || panel.querySelectorAll('[role="radio"], mat-radio-button, [role="tab"], [role="option"], button, [role="button"]'))].filter(el => root.visible?.(el) && !isNavControl(el));
    const match = candidates.find(el => {
      const label = foldLabel(root.accessibleName?.(el));
      const txt = foldLabel(el.innerText || el.textContent || "");

      if (label === normalized || txt === normalized || label.endsWith(` ${normalized}`) || txt.endsWith(` ${normalized}`)) return true;
      if (label.includes(normalized) || txt.includes(normalized)) return true;

      // Hỗ trợ từ khóa định dạng tiếng Việt
      if (normalized === "9:16" && (/^(?:doc|portrait|vertical)$/i.test(label) || /^(?:doc|portrait|vertical)$/i.test(txt))) return true;
      if (normalized === "16:9" && (/^(?:ngang|landscape|horizontal|widescreen)$/i.test(label) || /^(?:ngang|landscape|horizontal|widescreen)$/i.test(txt))) return true;
      if (normalized === "1:1" && (/^(?:vuong|square)$/i.test(label) || /^(?:vuong|square)$/i.test(txt))) return true;

      return false;
    });

    if (match) {
      if (!nativeRadioSelected(match) && match.getAttribute("aria-selected") !== "true" && match.getAttribute("data-state") !== "active") {
        match.click();
        await waitPreparation(options, 300, "selecting Flow aspect ratio");
      }
    }
  }

  async function chooseResolution(resolution, options = {}) {
    if (!resolution) return;
    const wanted = String(resolution).trim().toLowerCase().replace(/\s+/g, "");
    await openFlowSettings(options);
    const panel = flowSettingsPanelVisible() ? ((typeof root.flowQuery === "function" ? root.flowQuery("settings.panel", document, { checkVisible: false }) : null) || document.querySelector('[role="menu"], [role="dialog"], mat-dialog-container, flow-dialog') || document) : document;

    const candidates = [...((typeof root.flowQueryAll === "function" ? root.flowQueryAll("settings.optionCandidates", panel, { checkVisible: false }) : null) || panel.querySelectorAll('button[role="tab"], [role="radio"], mat-radio-button, button'))].filter(el => root.visible?.(el) && !isNavControl(el));
    const match = candidates.find(el => {
      const txt = (el.innerText || el.textContent || "").trim().toLowerCase().replace(/\s+/g, "");
      return txt === wanted || txt === `${wanted}p` || `${txt}p` === wanted;
    });

    if (match) {
      if (!nativeRadioSelected(match) && match.getAttribute("aria-selected") !== "true" && match.getAttribute("data-state") !== "active") {
        match.click();
        await waitPreparation(options, 300, "selecting Flow resolution");
      }
    }
  }

  async function chooseVideoOption(kind, requested, options = {}) {
    if (requested == null || requested === "") return;
    const wanted = String(requested).trim();
    const normalizeCompact = value => foldLabel(value).replace(/\s+/g, "");
    const number = Number.parseInt(wanted, 10);
    const matches = element => {
      const label = root.accessibleName?.(element) || "";
      const text = element.innerText || element.textContent || "";
      const candidates = [label, text].map(foldLabel).filter(Boolean);
      if (kind === "duration") {
        return Number.isFinite(number) && candidates.some(value => {
          const match = value.match(/(?:^|\s)(\d{1,2})\s*(?:s|sec(?:ond)?s?|giay)?(?:$|\s)/i) || value.match(/^(\d{1,2})$/);
          return Boolean(match && Number(match[1]) === number);
        });
      }
      if (kind === "ratio") {
        const ratio = root.normalizeAspectRatio?.(wanted) || wanted;
        return candidates.some(value => value === foldLabel(ratio) || value.includes(foldLabel(ratio)));
      }
      return candidates.some(value => normalizeCompact(value) === normalizeCompact(wanted) ||
        (kind === "resolution" && normalizeCompact(value) === `${normalizeCompact(wanted)}p`));
    };
    const find = () => {
      // Multiple overlays may be open (for example, an unrelated Add menu and
      // the settings panel). Only search the panel whose controls prove that it
      // is Flow's settings panel; never let an earlier global overlay mask it.
      const panel = getVisibleFlowSettingsPanel() || document;
      const candidates = (typeof root.flowQueryAll === "function" ? root.flowQueryAll("settings.optionCandidates", panel, { checkVisible: false }) : null) ||
        [...panel.querySelectorAll('[role="radio"],mat-radio-button,[role="tab"],[role="option"],button,[role="button"]')];
      return candidates
        .find(element => root.visible?.(element) && !isNavControl(element) && matches(element)) || null;
    };
    const codePrefix = kind === "duration" ? "DURATION" : kind === "resolution" ? "RESOLUTION" : "ASPECT_RATIO";
    await openFlowSettings(options);
    let target = find();
    if (!target && options.allowAbsent === true) return { selected: false, modelFixed: true };
    if (!target) {
      const deadline = Math.min(Date.now() + 2000, Number.isFinite(options.deadline) ? options.deadline : Infinity);
      while (Date.now() < deadline && !target) {
        await waitPreparation(options, 100, `finding requested video ${kind}`);
        target = find();
      }
    }
    if (!target) {
      throw root.flowError(`FLOW_VIDEO_${codePrefix}_UNAVAILABLE`, `Flow does not expose the requested video ${kind} (${wanted}). Nothing was submitted.`, true, false);
    }
    if (!nativeRadioSelected(target)) target.click();
    const verifyDeadline = Math.min(Date.now() + 2500, Number.isFinite(options.deadline) ? options.deadline : Infinity);
    let selected = false;
    while (Date.now() < verifyDeadline) {
      checkPreparation(options, `confirming requested video ${kind}`);
      const current = find();
      if (current && nativeRadioSelected(current)) { selected = true; break; }
      await waitPreparation(options, 100, `confirming requested video ${kind}`);
    }
    if (!selected) {
      throw root.flowError(`FLOW_VIDEO_${codePrefix}_UNCONFIRMED`, `Flow did not confirm the requested video ${kind} (${wanted}). Nothing was submitted.`, true, false);
    }
  }

  async function chooseRadio(name, options = {}) {
    checkPreparation(options, `selecting Flow ${name} mode`);
    if (!flowSettingsPanelVisible()) {
      await openFlowSettings(options);
    }
    let radio = flowRadio(name);
    if (!radio) {
      await openFlowSettings(options);
      const findOption = () => flowRadio(name) || flowOption(name);
      const openedBy = Date.now() + 2500;
      while (Date.now() < Math.min(openedBy, Number.isFinite(options.deadline) ? options.deadline : Infinity) && !radio) { await waitPreparation(options, 100, `finding Flow ${name} mode`); radio = findOption(); }
    }
    if (!radio) {
      const optionElements = (typeof root.flowQueryAll === "function" ? root.flowQueryAll("settings.optionCandidates", document, { checkVisible: false }) : null) ||
        [...document.querySelectorAll('[role="radio"],mat-radio-button,[role="tab"],[role="option"],button,[role="button"]')];
      const options = optionElements
        .filter(el => root.visible?.(el)).map(el => (root.accessibleName?.(el) || "").replace(/\s+/g, " ").trim()).filter(Boolean);
      throw root.flowError("FLOW_OPTION_NOT_FOUND", `Flow has no visible "${name}" option for the current settings. Visible options: ${[...new Set(options)].slice(0, 30).join(", ") || "none"}.`);
    }
    if (!nativeRadioSelected(radio)) radio.click();
    await waitPreparation(options, 400, `selecting Flow ${name} mode`);
    const deadline = Math.min(Date.now() + 3000, Number.isFinite(options.deadline) ? options.deadline : Infinity);
    while (Date.now() < deadline) {
      checkPreparation(options, `confirming Flow ${name} mode`);
      const current = flowRadio(name) || (flowSettingsPanelVisible() && flowOption(name));
      if (nativeRadioSelected(current)) return;
      if (!current && (!radio.isConnected || !root.visible?.(radio))) return;
      await waitPreparation(options, 100, `confirming Flow ${name} mode`);
    }
    radio = flowRadio(name) || (flowSettingsPanelVisible() && flowOption(name));
    if (radio && !nativeRadioSelected(radio)) {
      radio.click();
      const retryDeadline = Math.min(Date.now() + 2500, Number.isFinite(options.deadline) ? options.deadline : Infinity);
      while (Date.now() < retryDeadline) {
        checkPreparation(options, `confirming Flow ${name} mode`);
        const current = flowRadio(name) || (flowSettingsPanelVisible() && flowOption(name));
        if (nativeRadioSelected(current) || (!current && (!radio.isConnected || !root.visible?.(radio)))) return;
        await waitPreparation(options, 100, `confirming Flow ${name} mode`);
      }
    }
    throw root.flowError("FLOW_OPTION_SELECTION_FAILED", `Flow did not confirm that "${name}" was selected. Nothing was submitted.", true`);
  }

  async function chooseNativeVariantCount(count, options = {}) {
    checkPreparation(options, "selecting Flow output count");
    const variants = Math.max(1, Math.min(4, Number(count) || 1));
    const name = `x${variants}`;
    const composer = options.composerOnly ? flowComposerRoot() : null;
    if (composer) {
      const modelButton = findModelPickerButton(composer);
      const currentName = normalizeModelLabel(modelButton?.innerText || modelButton?.textContent || root.accessibleName?.(modelButton) || "");
      const currentCount = currentName.match(/(?:^|\s)x([1-4])(?:\s|$)/)?.[1];
      if (currentCount === String(variants)) return variants;
      const composerCandidates = (typeof root.flowQueryAll === "function" ? root.flowQueryAll("settings.optionCandidates", composer, { checkVisible: false }) : null) ||
        [...composer.querySelectorAll('[role="radio"],[role="option"],[role="tab"],button,[role="button"]')];
      const countControl = composerCandidates
        .find(el => root.visible?.(el) && !isNavControl(el) &&
          new RegExp(`^(?:x${variants}|${variants}|${variants}\\s+(?:anh|hinh anh|video|ket qua))$`, "i")
            .test(normalizeModelLabel(root.accessibleName?.(el) || el.innerText || el.textContent || "")));
      if (!countControl) {
        throw root.flowError("FLOW_VARIANT_OPTION_MISSING", `Flow's composer does not expose ${name}; no generation was submitted.`, true);
      }
      countControl.click();
      await waitPreparation(options, 350, "confirming Flow output count");
      const updatedName = normalizeModelLabel(modelButton?.innerText || modelButton?.textContent || root.accessibleName?.(modelButton) || "");
      if (!new RegExp(`(?:^|\\s)x${variants}(?:\\s|$)`).test(updatedName) && !nativeRadioSelected(countControl)) {
        throw root.flowError("FLOW_VARIANT_SELECTION_UNCONFIRMED", `Flow did not confirm ${name} in its composer. Nothing was submitted.`, true);
      }
      return variants;
    }
    await openFlowSettings(options);
    let option = flowRadio(name) || flowOption(name);
    if (!option) throw root.flowError("FLOW_VARIANT_OPTION_MISSING", `Flow did not show the ${name} output option. Nothing was submitted.`, true);
    option.click();
    await waitPreparation(options, 450, "selecting Flow output count");

    const summaryConfirms = () => {
      const trigger = flowSettingsTrigger();
      const summary = (trigger?.innerText || trigger?.textContent || "").replace(/\s+/g, " ").trim();
      return new RegExp(`(?:^|\\s)${name}(?:\\s|$)`, "i").test(summary);
    };
    const deadline = Math.min(Date.now() + 5000, Number.isFinite(options.deadline) ? options.deadline : Infinity);
    let stableSelectionChecks = 0;
    let stableSummaryChecks = 0;
    while (Date.now() < deadline) {
      checkPreparation(options, "confirming Flow output count");
      option = flowRadio(name) || flowOption(name);
      if (summaryConfirms()) {
        if (++stableSummaryChecks >= 2) { await waitPreparation(options, 300, "confirming Flow output count"); return variants; }
      } else stableSummaryChecks = 0;
      if (option && nativeRadioSelected(option)) {
        if (++stableSelectionChecks >= 2) { await waitPreparation(options, 300, "confirming Flow output count"); return variants; }
      } else {
        stableSelectionChecks = 0;
        if ((!option || !option.isConnected || !root.visible?.(option)) && summaryConfirms()) {
          await waitPreparation(options, 300, "confirming Flow output count");
          return variants;
        }
      }
      await waitPreparation(options, 200, "confirming Flow output count");
    }
    throw root.flowError("FLOW_VARIANT_SELECTION_UNCONFIRMED", `Flow did not confirm the requested ${name} output count. Nothing was submitted.`, true);
  }

  function normalizeModelLabel(value) {
    const label = String(value || "")
      .normalize("NFKC")
      .replace(/^[\u{1F000}-\u{1FFFF}]\s*/u, "")
      .replace(/^[^\p{L}\p{N}]+/u, "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
    return foldLabel(label);
  }

  let capabilityRegistryPromise;
  async function assertNativeModelCapabilities(payload, type, framesMode = false, options = {}) {
    if (!capabilityRegistryPromise) {
      emitImagePreparationProgress(options, "reading model capability registry");
      const deadline = Number.isFinite(options.deadline) ? options.deadline : Date.now() + 5_000;
      const timeoutMs = Math.min(5_000, deadline - Date.now());
      if (timeoutMs <= 0) {
        throw root.flowError("FLOW_OPERATION_TIMEOUT", "Timed out before reading Flow's model capability registry. Nothing was submitted.", false, false);
      }
      const controller = new AbortController();
      const abortCapabilityFetch = () => controller.abort();
      options.signal?.addEventListener("abort", abortCapabilityFetch, { once: true });
      let timeout;
      const timeoutPromise = new Promise((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(root.flowError("FLOW_OPERATION_TIMEOUT", "Timed out while reading Flow's model capability registry. Nothing was submitted.", false, false));
        }, timeoutMs);
      });
      capabilityRegistryPromise = Promise.race([
        fetch(chrome.runtime.getURL("flow-model-capabilities.json"), { signal: controller.signal })
          .then(response => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return response.json();
          }),
        timeoutPromise,
      ]).finally(() => {
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", abortCapabilityFetch);
      });
    }
    let registry;
    try { registry = await capabilityRegistryPromise; }
    catch (error) {
      capabilityRegistryPromise = null;
      if (error?.code === "FLOW_OPERATION_TIMEOUT") throw error;
      throw root.flowError("FLOW_CAPABILITY_REGISTRY_UNAVAILABLE", `Flow model capability registry could not be read: ${error?.message || error}. Nothing was submitted.`, false, false);
    }
    emitImagePreparationProgress(options, "validating model capabilities");
    const ratios = type === "video" ? registry.defaults.videoAspectRatios : registry.defaults.imageAspectRatios;
    if (payload.aspectRatio && !ratios.includes(payload.aspectRatio)) {
      throw root.flowError("FLOW_MODEL_UNSUPPORTED", `${type} aspect ratio ${payload.aspectRatio} is not supported. Allowed: ${ratios.join(", ")}. Nothing was submitted.`, false, false);
    }
    if (type === "image" && (payload.duration != null || payload.resolution != null)) {
      throw root.flowError("FLOW_MODEL_UNSUPPORTED", "Duration and video resolution settings are only supported for video generation. Nothing was submitted.", false, false);
    }
    const selectedModel = payload.model || (findModelPickerButton()?.innerText || findModelPickerButton()?.textContent || "");
    const normalized = normalizeModelLabel(selectedModel);
    const rule = registry.models.find(item => item.match.some(alias => normalized.includes(normalizeModelLabel(alias))));
    const referenceCount = Array.isArray(payload.attachments) ? payload.attachments.length : 0;
    const maxReferences = rule?.maxReferences ?? registry.defaults.maxReferences;
    if (referenceCount > maxReferences) {
      throw root.flowError("FLOW_MODEL_UNSUPPORTED", `Flow accepts at most ${maxReferences} references for this model. Nothing was submitted.`, false, false);
    }
    if (framesMode && rule && !rule.supportsFrames) {
      throw root.flowError("FLOW_MODEL_UNSUPPORTED", `Model "${selectedModel}" does not support first/last frame inputs. Nothing was submitted.`, false, false);
    }
    if (!rule) return null;
    if (!rule.types.includes(type)) {
      throw root.flowError("FLOW_MODEL_UNSUPPORTED", `Model "${selectedModel}" does not support ${type} generation. Nothing was submitted.`, false, false);
    }
    if (payload.aspectRatio && !rule.aspectRatios.includes(payload.aspectRatio)) {
      throw root.flowError("FLOW_MODEL_UNSUPPORTED", `Model "${selectedModel}" does not support ${payload.aspectRatio}. Nothing was submitted.`, false, false);
    }
    if (payload.duration != null && !rule.durations.includes(Number(payload.duration))) {
      const supported = rule.fixedDuration ? `fixed at ${rule.fixedDuration} seconds` : `supports ${rule.durations.join(", ")} seconds`;
      throw root.flowError("FLOW_MODEL_UNSUPPORTED", `Model "${selectedModel}" ${supported}. Nothing was submitted.`, false, false);
    }
    if (payload.resolution != null && !rule.resolutions.includes(String(payload.resolution))) {
      const options = rule.resolutions.length ? ` Allowed: ${rule.resolutions.join(", ")}.` : "";
      throw root.flowError("FLOW_MODEL_UNSUPPORTED", `Model "${selectedModel}" does not offer ${payload.resolution} resolution.${options} Nothing was submitted.`, false, false);
    }
    return rule;
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
      ? ((typeof root.flowQuery === "function" ? root.flowQuery("settings.panel", document, { checkVisible: false }) : null) || document.querySelector('[role="menu"], [role="dialog"], mat-dialog-container, flow-dialog, .cdk-overlay-pane') || document)
      : scope;
    const candidates = [...((typeof root.flowQueryAll === "function" ? root.flowQueryAll("common.buttons", panel, { checkVisible: false }) : null) || panel.querySelectorAll('button, [role="button"], [role="combobox"]'))].filter(el => root.visible?.(el) && !isNavControl(el));

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

  async function chooseNativeModel(model, type, options = {}) {
    checkPreparation(options, "selecting the Flow model");
    if (!model) return;
    emitImagePreparationProgress(options, "locating model selector");
    const legacyImage = type === "image" && /^\s*(nano banana( 2)?|latest)?\s*$/i.test(model);
    const aliases = getModelAliases(model);

    let button = findModelPickerButton();
    if (!button) {
      await openFlowSettings(options);
      button = findModelPickerButton();
    }
    if (!button) {
      const deadline = Math.min(Date.now() + 2500, Number.isFinite(options.deadline) ? options.deadline : Infinity);
      while (Date.now() < deadline && !button) {
        checkPreparation(options, "finding the Flow model selector");
        button = findModelPickerButton();
        if (!button) await waitPreparation(options, 100, "finding the Flow model selector");
      }
    }

    if (button) {
      const currentModelText = normalizeModelLabel(button.innerText || button.textContent || root.accessibleName?.(button) || "");
      const alreadyApplied = aliases.some(alias => currentModelText === alias || (alias.length >= 3 && currentModelText.includes(alias)));
      if (alreadyApplied) { emitImagePreparationProgress(options, "requested model already selected"); return; }
    }

    if (!button) return;

    emitImagePreparationProgress(options, "opening model selector");
    button.click();
    await waitPreparation(options, 450, "opening the Flow model selector");

    let items = [];
    const menuDeadline = Math.min(Date.now() + 4000, Number.isFinite(options.deadline) ? options.deadline : Infinity);
    while (Date.now() < menuDeadline) {
      checkPreparation(options, "loading Flow model choices");
      items = [...((typeof root.flowQueryAll === "function" ? root.flowQueryAll("settings.dropdownItems", document, { checkVisible: false }) : null) || document.querySelectorAll('[role="menuitem"], [role="menuitemradio"], mat-option, [role="option"]'))].filter(el => root.visible?.(el));
      if (!items.length) {
        const activeMenu = (typeof root.flowQuery === "function" ? root.flowQuery("settings.activeMenu", document, { checkVisible: false }) : null) ||
          document.querySelector('[role="menu"]:last-of-type, [data-radix-popper-content-wrapper]:last-of-type, .cdk-overlay-pane:last-of-type');
        if (activeMenu) items = [...((typeof root.flowQueryAll === "function" ? root.flowQueryAll("common.buttons", activeMenu, { checkVisible: false }) : null) || activeMenu.querySelectorAll('button, [role="menuitem"], [role="menuitemradio"]'))].filter(el => root.visible?.(el));
      }
      if (items.length) break;
      await waitPreparation(options, 100, "loading Flow model choices");
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
      emitImagePreparationProgress(options, "requested model option unavailable");
      return;
    }

    const chosenItem = items[index];
    emitImagePreparationProgress(options, "selecting requested model");
    chosenItem.click();
    await waitPreparation(options, 500, "selecting the Flow model");

    if (chosenItem.isConnected && root.visible?.(chosenItem)) {
      root.dispatchEscapeKey?.();
      await waitPreparation(options, 200, "closing the Flow model selector");
    }
    emitImagePreparationProgress(options, "model selection settled");
  }

  async function restoreNativeFramesMode(options = {}) {
    await openFlowSettings(options);
    const findFrames = () => {
      const candidates = (typeof root.flowQueryAll === "function" ? root.flowQueryAll("settings.optionCandidates", document, { checkVisible: false }) : null) ||
        [...document.querySelectorAll('[role="radio"],mat-radio-button,[role="tab"],[role="option"],button,[role="button"]')];
      return candidates.find(el => root.visible?.(el) && !isNavControl(el) &&
        /^(?:frames|khung hinh|khung|khung anh)$/.test(foldLabel((root.accessibleName?.(el) || "").replace(/^(?:accessibility_new|dashboard|face)\s*/i, ""))));
    };
    let frames = findFrames();
    if (!frames) throw root.flowError("FLOW_FRAMES_MODE_UNAVAILABLE", "Flow does not show a Frames mode control after local frame upload. Nothing was submitted.", true, false);
    if (!nativeRadioSelected(frames) && frames.getAttribute("aria-selected") !== "true") frames.click();
    const hasFrameControls = () => Boolean(root.flowButton?.("Start") && root.flowButton?.("End"));
    const deadline = Math.min(Date.now() + 5000, Number.isFinite(options.deadline) ? options.deadline : Infinity);
    let confirmed = false;
    while (Date.now() < deadline) {
      checkPreparation(options, "restoring Flow Frames mode after upload");
      frames = findFrames();
      if (frames && (nativeRadioSelected(frames) || frames.getAttribute("aria-selected") === "true" || hasFrameControls())) { confirmed = true; break; }
      if (!flowSettingsPanelVisible()) await openFlowSettings(options);
      await waitPreparation(options, 100, "restoring Flow Frames mode after upload");
    }
    if (!confirmed) throw root.flowError("FLOW_FRAMES_MODE_UNCONFIRMED", "Flow did not confirm Frames mode after local frame upload. Nothing was submitted.", true, false);
    await closeFlowSettings(options);
    const controlsDeadline = Math.min(Date.now() + 4000, Number.isFinite(options.deadline) ? options.deadline : Infinity);
    while (Date.now() < controlsDeadline && !hasFrameControls()) await waitPreparation(options, 100, "waiting for Flow frame controls after upload");
    if (!root.flowButton?.("Start") || !root.flowButton?.("End")) {
      throw root.flowError("FLOW_FRAMES_CONTROLS_UNAVAILABLE", "Flow selected Frames but did not restore both Start and End frame controls. Nothing was submitted.", true, false);
    }
  }

  const FlowSettings = Object.freeze({
    checkPreparation,
    emitImagePreparationProgress,
    waitPreparation,
    finishImagePreparationDiagnostics,
    finishVideoPreparationDiagnostics,
    assertNativeModelCapabilities,
    openFlowSettings,
    closeFlowSettings,
    inspectImagePreparationDiagnostics,
    inspectVideoPreparationDiagnostics,
    safeCreditQuoteDiagnostics,
    closeOwnedSettingsSurface,
    flowSettingsPanelVisible,
    flowRadio,
    flowOption,
    nativeRadioSelected,
    isNavControl,
    foldLabel,
    chooseRadio,
    chooseAspectRatio,
    chooseDuration,
    chooseResolution,
    chooseVideoOption,
    chooseNativeVariantCount,
    chooseNativeModel,
    findModelPickerButton,
    getModelAliases,
    normalizeModelLabel,
    restoreNativeFramesMode,
  });

  root.FlowSettings = FlowSettings;
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
