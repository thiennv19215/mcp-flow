(function (root) {
  "use strict";

  const foldFlowText = value => {
    const norm = root.normalizeFlowUiText?.(value) || value;
    return String(norm || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").replace(/\s+/g, " ").trim().toLowerCase();
  };

  function matchesLocalizedAction(el, ...keys) {
    const values = [root.accessibleName?.(el), el?.getAttribute?.("aria-label"), el?.getAttribute?.("title"), el?.innerText, el?.textContent]
      .map(value => foldFlowText(value)).filter(Boolean);
    const aliases = keys.flatMap(key => {
      const patterns = root.I18n?.getPatterns?.(key) || [];
      return patterns.length ? patterns : [key];
    });
    const wanted = aliases.map(foldFlowText);
    return values.some(value => wanted.some(alias => alias && value === alias));
  }

  function agentSaveControls(surface, enabledOnly = false) {
    const hook = root.flowButton?.("Save", surface) || root.flowButton?.("Done", surface) || root.flowButton?.("Apply", surface);
    const queried = [...(surface?.querySelectorAll?.('button,[role="button"]') || [])]
      .filter(el => root.visible?.(el) && (!enabledOnly || (!el.disabled && el.getAttribute?.("aria-disabled") !== "true")) &&
        matchesLocalizedAction(el, "Save", "Done", "Apply"));
    if (hook && !queried.includes(hook)) queried.unshift(hook);
    return queried;
  }

  function isRunConfirmationAction(button) {
    const label = foldFlowText(root.accessibleName?.(button) || button?.innerText || button?.textContent || "");
    const explicit = /^(?:generate|create|confirm|submit|continue|tao|xac nhan|tiep tuc|dong y)(?:\s+(?:image|video|anh|hinh anh|ngay))?(?:\s*\(?0\s+(?:credits?|tin dung|diem(?: tin dung)?)\)?)?$/i.test(label);
    const semanticAttribute = ["data-testid", "data-action", "data-purpose", "formaction"]
      .map(name => foldFlowText(button?.getAttribute?.(name))).join(" ");
    return explicit || /(?:^|[\s_-])(?:generate|create|confirm|submit)(?:$|[\s_-])/.test(semanticAttribute) ||
      ["Generate", "Create", "Confirm", "Submit", "Continue"].some(key => matchesLocalizedAction(button, key));
  }

  function hasExplicitZeroQuote(surface) {
    const quoteNodes = [...(surface?.querySelectorAll?.('[data-testid*="credit" i],[data-testid*="cost" i],[data-testid*="price" i],[aria-label*="credit" i],[class*="credit" i],[class*="cost" i],[class*="price" i],[data-cost],[data-credit-cost]') || [])];
    const values = [surface?.innerText, ...quoteNodes.map(node => `${node.getAttribute?.("aria-label") || ""} ${node.innerText || node.textContent || ""}`)]
      .map(foldFlowText).filter(Boolean);
    const structuredZero = quoteNodes.some(node => ["data-cost", "data-credit-cost", "aria-valuenow", "data-value"]
      .some(name => /^(?:0|0\.0+)$/.test(String(node.getAttribute?.(name) || "").trim())));
    return structuredZero || values.some(value => /(?:^|\D)0(?:\.0+)?\s*(?:credits?|tokens?|points?|tin dung|diem(?: tin dung)?)(?:\b|$)/i.test(value) ||
      /(?:credits?|tokens?|points?|tin dung|diem(?: tin dung)?)[^\d]{0,12}0(?:\.0+)?(?:\b|$)/i.test(value));
  }

  function agentConfirmationOptionMatches(mode, label) {
    const value = foldFlowText(typeof label === "string" ? label :
      root.accessibleName?.(label) || label?.innerText || label?.textContent || "");
    const semanticState = typeof label === "string" ? "" : ["data-value", "value", "data-mode", "data-testid", "aria-label"]
      .map(name => foldFlowText(label?.getAttribute?.(name))).join(" ");
    if (mode === "Always" && /(?:^|[\s_-])(?:always|ask_each|ask_every|each_run|per_request)(?:$|[\s_-])/.test(semanticState)) return true;
    if (mode === "Never" && /(?:^|[\s_-])(?:never|auto_spend|no_confirmation)(?:$|[\s_-])/.test(semanticState)) return true;
    if (mode === "Always") return /^(?:always(?:\s+(?:ask|confirm|prompt))?|ask (?:every|each) time|luon(?:\s+luon)?(?:\s+(?:hoi|xac nhan))?|hoi moi lan)(?:\b|$)/i.test(value);
    if (mode === "Never") return /^(?:never(?:\s+(?:ask|confirm|prompt|auto[- ]?spend))?|do not ask|don't ask|khong bao gio(?:\s+hoi)?|khong hoi)(?:\b|$)/i.test(value);
    return false;
  }

  const agentSettingsSurfaceSelector = '[role="dialog"],mat-dialog-container,.cdk-overlay-pane,flow-dialog,[role="menu"],mat-menu-panel';
  function agentSurfaceSummary(surface) {
    const text = String(surface?.innerText || surface?.textContent || "").replace(/\s+/g, " ").trim();
    const radios = [...(surface?.querySelectorAll?.('[role="radio"],mat-radio-button') || [])].filter(el => root.visible?.(el));
    const labels = radios.map(el => String(root.accessibleName?.(el) || el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 100));
    const saveButtons = agentSaveControls(surface);
    return {
      role: surface?.getAttribute?.("role") || surface?.tagName?.toLowerCase?.() || null,
      heading: text.slice(0, 120),
      confirmationOptions: labels.slice(0, 12),
      saveControlCount: saveButtons.length,
    };
  }
  function visibleAgentSettingsSurfaces() {
    try {
      return [...new Set(document.querySelectorAll(agentSettingsSurfaceSelector))].filter(el => root.visible?.(el));
    } catch { return []; }
  }
  function exactAgentSettingsSurfaces() {
    const matches = visibleAgentSettingsSurfaces().filter(surface => {
      const radios = [...(surface.querySelectorAll?.('[role="radio"],mat-radio-button') || [])].filter(el => root.visible?.(el));
      const hasAlways = radios.some(el => agentConfirmationOptionMatches("Always", el));
      const hasSave = agentSaveControls(surface).length > 0;
      // A localized heading is not required: the visible confirmation radio
      // and localized save action identify this settings surface structurally.
      return hasAlways && hasSave;
    });
    return matches.filter(surface => !matches.some(other => other !== surface && surface.contains?.(other)));
  }
  function agentDiagnosticError(code, message, diagnostics, retryable = false) {
    const error = root.flowError(code, message, retryable, false);
    error.diagnostics = diagnostics;
    return error;
  }
  function inspectNativeAgentSettings() {
    const surfaces = visibleAgentSettingsSurfaces();
    const candidates = exactAgentSettingsSurfaces();
    return {
      state: candidates.length === 1 ? "verified" : "unverified",
      reason: candidates.length === 1 ? null : candidates.length ? "multiple_agent_settings_surfaces" : "agent_settings_surface_missing_exact_controls",
      visibleSurfaceCount: surfaces.length,
      surfaces: surfaces.slice(0, 6).map(agentSurfaceSummary),
      matchingSurfaceCount: candidates.length,
    };
  }

  async function setNativeAgentSettings(confirm, aspect) {
    if (confirm !== "Always") {
      throw root.flowError("FLOW_AGENT_AUTOSPEND_BLOCKED", "Agent settings may only preserve or select Always ask; automatic spending is disabled.", false, false);
    }
    const composer = (typeof root.flowQuery === "function" ? root.flowQuery("composerRoot") : null) ||
      document.querySelector("flow-base-prompt-box");
    const settingsControls = composer && [...composer.querySelectorAll('button,[role="button"]')].filter(el => {
      if (!root.visible?.(el)) return false;
      const label = (root.accessibleName?.(el) || el.innerText || "").replace(/\s+/g, " ").trim().toLowerCase();
      const icon = (root.flowFindIcon ? root.flowFindIcon(el) : el.querySelector?.("mat-icon, .mat-icon, .google-symbols"))?.textContent?.trim().toLowerCase();
      return matchesLocalizedAction(el, "Settings trigger", "Settings") || /^(?:settings|cài đặt)$/i.test(label) ||
        icon === "tune" || icon === "settings" || icon === "settings_2";
    });
    const initial = { triggerCount: settingsControls?.length || 0, currentSurfaces: visibleAgentSettingsSurfaces().slice(0, 6).map(agentSurfaceSummary) };
    if (settingsControls?.length !== 1) throw agentDiagnosticError("FLOW_AGENT_SETTINGS_TRIGGER_UNVERIFIED", "Flow Agent settings need one unique settings trigger inside the composer; nothing was submitted.", initial, true);
    settingsControls[0].click();
    await root.wait?.(350);
    const settingsInspection = inspectNativeAgentSettings();
    const settingsSurfaces = exactAgentSettingsSurfaces();
    if (settingsSurfaces.length !== 1) throw agentDiagnosticError("FLOW_AGENT_SETTINGS_SURFACE_UNVERIFIED", "Flow did not expose one Agent settings surface with an Always ask option and a save control; nothing was submitted.", settingsInspection, true);
    const settingsSurface = settingsSurfaces[0];
    const getConfirmRadio = () => [...(settingsSurface.querySelectorAll?.('[role="radio"],mat-radio-button') || [])].find(el =>
      root.visible?.(el) && agentConfirmationOptionMatches(confirm, el));
    let confirmRadio = getConfirmRadio();
    if (!confirmRadio) throw agentDiagnosticError("FLOW_AGENT_CONFIRMATION_OPTION_UNAVAILABLE", "Flow Agent settings did not expose the exact Always ask option on the verified settings surface; nothing was submitted.", settingsInspection, true);
    const confirmationChanged = !root.FlowSettings?.nativeRadioSelected?.(confirmRadio);
    if (confirmationChanged) confirmRadio.click();
    await root.wait?.(150);
    confirmRadio = getConfirmRadio();
    if (!confirmRadio || !root.FlowSettings?.nativeRadioSelected?.(confirmRadio)) {
      throw agentDiagnosticError("FLOW_AGENT_CONFIRMATION_SETTING_UNCONFIRMED", "Flow did not confirm the persistent Always ask preference on the verified Agent settings surface; nothing was submitted.", { ...settingsInspection, alwaysAskSelected: Boolean(confirmRadio && root.FlowSettings?.nativeRadioSelected?.(confirmRadio)) });
    }
    const confirmationLabel = String(root.accessibleName?.(confirmRadio) || confirmRadio.innerText || confirmRadio.textContent || "").replace(/\s+/g, " ").trim();
    if (aspect) {
      const aspectRadio = root.FlowSettings?.flowRadio?.(aspect, settingsSurface);
      const variantRadio = root.FlowSettings?.flowRadio?.("x1", settingsSurface);
      if (!aspectRadio || !variantRadio) throw agentDiagnosticError("FLOW_AGENT_ASPECT_SETTINGS_UNAVAILABLE", "Flow Agent aspect or one-variant settings are unavailable on the verified settings surface; nothing was submitted.", { ...settingsInspection, aspectOptionFound: Boolean(aspectRadio), singleVariantOptionFound: Boolean(variantRadio) }, true);
      if (!root.FlowSettings?.nativeRadioSelected?.(aspectRadio)) aspectRadio.click();
      if (!root.FlowSettings?.nativeRadioSelected?.(variantRadio)) variantRadio.click();
      if (!root.FlowSettings?.nativeRadioSelected?.(aspectRadio) || !root.FlowSettings?.nativeRadioSelected?.(variantRadio)) {
        throw agentDiagnosticError("FLOW_AGENT_ASPECT_SETTINGS_UNCONFIRMED", "Flow did not confirm the requested aspect and one-variant setting; nothing was submitted.", { ...settingsInspection, aspectSelected: Boolean(root.FlowSettings?.nativeRadioSelected?.(aspectRadio)), singleVariantSelected: Boolean(root.FlowSettings?.nativeRadioSelected?.(variantRadio)) });
      }
    }
    await root.wait?.(250);
    const saveButtons = agentSaveControls(settingsSurface, true);
    if (saveButtons.length !== 1) throw agentDiagnosticError("FLOW_AGENT_SETTINGS_SAVE_UNVERIFIED", "Flow Agent settings did not expose one enabled Save control on the verified settings surface; nothing was submitted.", { ...settingsInspection, saveControlCount: saveButtons.length }, true);
    const save = saveButtons[0];
    save.click();
    const closeDeadline = Date.now() + 1500;
    while (Date.now() < closeDeadline && root.visible?.(settingsSurface)) await root.wait?.(100);
    if (root.visible?.(settingsSurface)) throw agentDiagnosticError("FLOW_AGENT_SETTINGS_SAVE_UNCONFIRMED", "Flow did not close the verified Agent settings surface after Save; nothing was submitted.", { ...settingsInspection, alwaysAskSelected: true, aspectSelected: aspect ? true : undefined, saveClicked: true });
    return { confirmation_mode: "Always", confirmation_label: confirmationLabel, confirmation_changed: confirmationChanged, aspect: aspect || null, variants: aspect ? 1 : null, settingsSurfaceVerified: true, settingsSaveConfirmed: true };
  }

  function inspectAgentRunConfirmation() {
    const dialogs = [...document.querySelectorAll('[role="dialog"],mat-dialog-container,.cdk-overlay-pane')].filter(el => root.visible?.(el));
    const matchingDialogs = dialogs.filter(el => {
      const hasAction = [...(el.querySelectorAll?.('button,[role="button"]') || [])].some(button => root.visible?.(button) && isRunConfirmationAction(button));
      const textEvidence = /\b(?:generate|create|confirm|credits?|tin dung|cost|price)\b|tao|xac nhan|chi phi|gia tien/i.test(foldFlowText(el.innerText || el.textContent || ""));
      return textEvidence || (hasAction && hasExplicitZeroQuote(el));
    });
    // Material can expose the same one-run confirmation as nested overlay and
    // dialog nodes. Keep only the most specific matching surface; independent
    // matching dialogs remain ambiguous and are never clicked.
    const candidates = matchingDialogs.filter(surface => !matchingDialogs.some(other => other !== surface && surface.contains?.(other)));
    if (candidates.length === 0) return { state: "none", diagnostics: { visibleDialogCount: dialogs.length, confirmationSurfaceCount: 0 } };
    if (candidates.length !== 1) return { state: "blocked", reason: "confirmation_surface_ambiguous", diagnostics: { visibleDialogCount: dialogs.length, confirmationSurfaceCount: candidates.length } };
    const dialog = candidates[0];
    const text = String(dialog.innerText || dialog.textContent || "").replace(/\s+/g, " ").trim().slice(0, 500);
    const foldedText = foldFlowText(text);
    const persistentSetting = /always\s+ask|never\s+(?:ask|auto[- ]?spend)|auto[- ]?spend|for future|account setting|luon(?:\s+luon)? hoi|hoi moi lan|khong hoi nua|cho cac lan tiep theo|cai dat tai khoan/i.test(foldedText);
    const oneRun = /\b(?:generate|create)\s+(?:this|one|1|a|an)\s+(?:image|video|generation|request)\b|\b(?:this|one|1)\s+(?:image|video|generation|request)\b|\btao\s+(?:(?:one|mot|1)\s+)?(?:image|video|anh|hinh anh|generation|request|yeu cau|lan tao)\b/i.test(foldedText);
    const zeroCredits = /(?:^|\D)0(?:\.0+)?\s*(?:credits?|tokens?|points?|tin dung|diem(?: tin dung)?)(?:\b|$)/i.test(foldedText) ||
      /(?:credits?|tokens?|points?|tin dung|diem(?: tin dung)?)[^\d]{0,12}0(?:\.0+)?(?:\b|$)/i.test(foldedText) || hasExplicitZeroQuote(dialog);
    const buttons = [...dialog.querySelectorAll('button,[role="button"]')].filter(el => root.visible?.(el) && !el.disabled && el.getAttribute("aria-disabled") !== "true");
    const runActions = buttons.filter(isRunConfirmationAction);
    if (persistentSetting || !oneRun || !zeroCredits) {
      const structuralOneRun = zeroCredits && runActions.length === 1;
      if (!persistentSetting && structuralOneRun) {
        // A single explicit run action scoped to a zero-cost confirmation dialog
        // is reliable even when the localized explanatory sentence changes.
      } else {
      return { state: "blocked", reason: persistentSetting ? "persistent_setting_dialog" : !oneRun ? "not_a_one_run_confirmation" : "credit_quote_not_explicitly_zero", text,
        diagnostics: { visibleDialogCount: dialogs.length, confirmationSurfaceCount: 1, persistentSetting, oneRun, zeroCredits, structuralRunActionCount: runActions.length } };
      }
    }
    const confirms = runActions;
    if (confirms.length !== 1) return { state: "blocked", reason: "one_run_confirm_control_not_unique", text, matching_controls: confirms.length,
      diagnostics: { visibleDialogCount: dialogs.length, confirmationSurfaceCount: 1, persistentSetting, oneRun, zeroCredits, matchingConfirmControls: confirms.length } };
    const button = confirms[0];
    const label = String(root.accessibleName?.(button) || button.innerText || button.textContent || "").replace(/\s+/g, " ").trim();
    button.click();
    return { state: "confirmed", credits: 0, one_run: true, label, text,
      diagnostics: { visibleDialogCount: dialogs.length, confirmationSurfaceCount: 1, persistentSetting: false, oneRun: true, zeroCredits: true, matchingConfirmControls: 1 } };
  }

  function findNativeAgentModeControl() {
    const composer = (typeof root.flowQuery === "function" ? root.flowQuery("composerRoot") : null) ||
      document.querySelector("flow-base-prompt-box,.flow-composer");
    if (!composer?.querySelectorAll) return { control: null, count: 0, composerFound: false };
    const configured = root.flowQueryAll?.("agent.toggleButton", composer) || [];
    const controls = [...new Set([...configured, ...composer.querySelectorAll('button,[role="button"]')])].filter(el => {
      if (!root.visible?.(el)) return false;
      const label = String(root.accessibleName?.(el) || el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
      const foldedLabel = foldFlowText(label);
      const aliases = [...(root.I18n?.getPatterns?.("agent") || []), "Agent", "Assistant", "Trợ lý", "Trợ lý AI"];
      const semanticLabel = aliases.some(alias => {
        const foldedAlias = foldFlowText(alias);
        return foldedLabel === foldedAlias || foldedLabel.startsWith(`${foldedAlias} `) || foldedLabel.endsWith(` ${foldedAlias}`);
      });
      const semanticAttribute = ["data-testid", "data-test-id", "data-mode", "aria-controls", "aria-label"]
        .map(name => foldFlowText(el.getAttribute?.(name)))
        .some(value => /(?:^|[\s_-])(?:agent|assistant)(?:$|[\s_-])/.test(value));
      const pressed = el.getAttribute?.("aria-pressed");
      return (semanticLabel || semanticAttribute) && (pressed === "true" || pressed === "false");
    });
    const active = controls.filter(el => el.getAttribute?.("aria-pressed") === "true");
    return { control: controls.length === 1 ? controls[0] : null, count: controls.length, activeCount: active.length, composerFound: true };
  }

  function getNativeAgentPromptEditor() {
    const composer = (typeof root.flowQuery === "function" ? root.flowQuery("composerRoot") : null) ||
      document.querySelector("flow-base-prompt-box,.flow-composer");
    const editor = root.FlowEditor?.getVisibleFlowPromptEditor?.(composer || document);
    if (editor) return editor;
    const candidates = [...(composer?.querySelectorAll?.(".ProseMirror[contenteditable='true'],[contenteditable='true']") || [])]
      .filter(el => el.isContentEditable && root.visible?.(el));
    return candidates.length === 1 ? candidates[0] : null;
  }

  async function waitForAgentModeState(expected, attempts = 25) {
    let pressed = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const resolved = findNativeAgentModeControl();
      const value = resolved.control?.getAttribute("aria-pressed");
      pressed = value === "true" ? true : value === "false" ? false : null;
      if (pressed === expected) return { ...resolved, pressed };
      await root.wait?.(100);
    }
    return { ...findNativeAgentModeControl(), pressed };
  }

  async function setNativeAgentMode(on) {
    const settingsDialog = exactAgentSettingsSurfaces()[0];
    const saveControls = settingsDialog ? agentSaveControls(settingsDialog, true) : [];
    const save = saveControls.length === 1 ? saveControls[0] : null;
    if (save) { save.click(); await root.wait?.(400); }

    const focused = document.activeElement;
    if (focused?.closest?.("mat-sidenav,[role=navigation]")) focused.blur();

    let resolved = findNativeAgentModeControl();
    let value = resolved.control?.getAttribute("aria-pressed");
    if (!resolved.control || (value !== "true" && value !== "false")) {
      throw root.flowError("FLOW_AGENT_MODE_FAILED", `Could not identify the Flow Agent mode toggle in the composer (matches: ${resolved.count}).`, true, false);
    }
    if ((value === "true") === on) return;

    resolved.control.click();
    resolved = await waitForAgentModeState(on);
    if (!resolved.control || resolved.pressed !== on) {
      throw root.flowError("FLOW_AGENT_MODE_FAILED", `Could not switch Flow Agent mode ${on ? "on" : "off"} (pressed: ${resolved.pressed === null ? "unknown" : resolved.pressed}, matches: ${resolved.count}).`, true, false);
    }
  }

  function visibleAgentPanelOwners() {
    const config = root.flowGetConfig?.("agent_panel_owner") || root.FlowSelectors?.agent_panel_owner || {};
    const selectors = Array.isArray(config.selectors) && config.selectors.length
      ? config.selectors
      : ["flow-chat-agent-panel", "flow-agent-panel", "[data-testid*='agent-panel' i]", "[aria-label*='agent panel' i]"];
    const ownerTextPattern = config.textRegex || config.text_regex;
    const ownerRegex = ownerTextPattern instanceof RegExp
      ? ownerTextPattern
      : ownerTextPattern ? new RegExp(String(ownerTextPattern), "i") : null;
    const owners = [];
    for (const selector of selectors) {
      try { for (const element of document.querySelectorAll(selector)) if (!owners.includes(element)) owners.push(element); } catch {}
    }
    return owners.filter(owner => {
      if (!root.visible?.(owner)) return false;
      const text = String(root.accessibleName?.(owner) || owner.getAttribute?.("aria-label") || owner.innerText || owner.textContent || "").replace(/\s+/g, " ").trim();
      return !ownerRegex || (root.matchesFlowUiRegex?.(text, ownerRegex) ?? ownerRegex.test(text));
    }).filter(owner => !owners.some(other => other !== owner && owner.contains?.(other)));
  }

  function agentPanelCloseControls(panel) {
    const config = root.flowGetConfig?.("agent_panel_close") || root.FlowSelectors?.agent_panel_close || {};
    const selectors = Array.isArray(config.selectors) ? config.selectors : ['button', '[role="button"]'];
    const closeRegex = config.textRegex instanceof RegExp
      ? config.textRegex
      : config.textRegex ? new RegExp(String(config.textRegex), "i") : /^(?:close|dismiss|đóng|thoát)$/i;
    const configuredCloseLabels = [
      ...(Array.isArray(config.textMatch) ? config.textMatch : config.textMatch ? [config.textMatch] : []),
      ...(Array.isArray(config.text_match) ? config.text_match : config.text_match ? [config.text_match] : []),
    ].map(foldFlowText).filter(Boolean);
    const candidates = [];
    for (const selector of selectors) {
      try { for (const element of panel.querySelectorAll(selector)) if (!candidates.includes(element)) candidates.push(element); } catch {}
    }
    return candidates.filter(element => {
      if (!root.visible?.(element) || element.disabled || element.getAttribute?.("aria-disabled") === "true") return false;
      const icon = root.flowFindIcon?.(element)?.textContent?.trim().toLowerCase() || "";
      const label = String(root.accessibleName?.(element) || element.getAttribute?.("aria-label") || element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
      const foldedLabel = foldFlowText(label);
      const textMatch = root.matchesFlowUiRegex?.(label, closeRegex) ?? closeRegex.test(label);
      return textMatch || configuredCloseLabels.includes(foldedLabel) || matchesLocalizedAction(element, "Close", "Dismiss") || icon === String(config.icon || "close").toLowerCase();
    });
  }

  async function closeNativeAgentSession(options = {}) {
    if (!isNativeAgentSessionOpen()) return { wasOpen: false, closed: true };
    const panelOwners = visibleAgentPanelOwners();
    let close = null;
    if (panelOwners.length > 1) {
      throw root.flowError("FLOW_AGENT_PANEL_AMBIGUOUS", "Multiple Agent panel owners are visible; no panel was closed.", false, false);
    }
    if (panelOwners.length === 1) {
      const controls = agentPanelCloseControls(panelOwners[0]);
      if (controls.length !== 1) {
        throw root.flowError(controls.length ? "FLOW_AGENT_PANEL_CLOSE_AMBIGUOUS" : "FLOW_AGENT_PANEL_CLOSE_UNAVAILABLE", `Flow's Agent panel exposed ${controls.length} matching close controls; no panel was closed.`, false, false);
      }
      close = controls[0];
    } else {
      const start = root.flowButton?.("Start new session");
      let owner = start?.parentElement || null;
      for (let depth = 0; owner && depth < 10; depth++, owner = owner.parentElement) {
        const configured = root.flowQueryAll?.("agent.closeButton", owner) || [];
        const descendants = owner.querySelectorAll?.('button,[role="button"]') || [];
        const candidates = [...new Set([...configured, ...descendants])].filter(el => {
          if (!root.visible?.(el) || el.disabled || el.getAttribute?.("aria-disabled") === "true") return false;
          const icon = root.flowFindIcon?.(el)?.textContent?.trim().toLowerCase() || "";
          return matchesLocalizedAction(el, "Close", "Dismiss") || icon === "close";
        });
        if (candidates.length === 1) { close = candidates[0]; break; }
        if (candidates.length > 1) break;
      }
    }
    if (!close) throw root.flowError("FLOW_AGENT_SESSION_CLOSE_UNAVAILABLE", "Flow's Agent session is open, but its Close control could not be identified. No generation was submitted.", false, false);
    close.click();
    const deadline = Number.isFinite(options.deadline) ? options.deadline : Date.now() + 2_000;
    while (Date.now() < deadline) {
      root.FlowUiDeadline?.requireTime(deadline, "closing the Flow Agent session", false, options.signal);
      if (!isNativeAgentSessionOpen()) return { wasOpen: true, closed: true };
      const waitMs = Math.min(100, Math.max(1, deadline - Date.now()));
      if (root.FlowUiDeadline?.boundedWait) await root.FlowUiDeadline.boundedWait(waitMs, deadline, "closing the Flow Agent session", false, options.signal);
      else await root.wait?.(waitMs);
    }
    throw root.flowError("FLOW_AGENT_SESSION_CLOSE_UNCONFIRMED", "Flow did not confirm that the Agent session closed. No generation was submitted.", true, false);
  }

  function isNativeAgentSessionOpen() {
    return Boolean(root.flowButton?.("Start new session") || visibleAgentPanelOwners().length);
  }

  function visibleAgentInstructionDialogs() {
    const config = root.flowGetConfig?.("agent_instruction_dialog") || root.FlowSelectors?.agent_instruction_dialog || {};
    const selectors = Array.isArray(config.selectors) ? config.selectors : ['[role="dialog"]', "mat-dialog-container", "flow-dialog", '[aria-modal="true"]'];
    const ownerRegex = config.textRegex instanceof RegExp
      ? config.textRegex
      : config.textRegex ? new RegExp(String(config.textRegex), "i")
        : /(?:agent|assistant|trợ lý).{0,160}(?:instruction|instructions|welcome|hướng dẫn|chỉ dẫn)|(?:instruction|instructions|hướng dẫn).{0,160}(?:agent|assistant|trợ lý)/i;
    const dialogs = [];
    for (const selector of selectors) {
      try { for (const element of document.querySelectorAll(selector)) if (!dialogs.includes(element)) dialogs.push(element); } catch {}
    }
    return dialogs.filter(surface => {
      if (!root.visible?.(surface)) return false;
      const text = String(root.accessibleName?.(surface) || surface.innerText || surface.textContent || "").replace(/\s+/g, " ").trim();
      return root.matchesFlowUiRegex?.(text, ownerRegex) ?? ownerRegex.test(text);
    }).filter(surface => !dialogs.some(other => other !== surface && surface.contains?.(other)));
  }

  async function ensureReadyForProjectOperation(options = {}) {
    const deadline = Number.isFinite(options.deadline) ? options.deadline : Date.now() + 6_000;
    const instructionDialogs = visibleAgentInstructionDialogs();
    if (instructionDialogs.length > 1) {
      throw root.flowError("FLOW_AGENT_INSTRUCTION_AMBIGUOUS", "More than one Agent instruction dialog is visible; no dialog was dismissed.", false, false);
    }
    if (instructionDialogs.length === 1) {
      const done = root.flowFindSemantic?.("agent_instruction_done", instructionDialogs[0]) || null;
      if (!done || !root.visible?.(done) || done.disabled || done.getAttribute?.("aria-disabled") === "true") {
        throw root.flowError("FLOW_AGENT_INSTRUCTION_DISMISS_UNAVAILABLE", "Flow's Agent instruction dialog is open, but its Done control could not be identified safely.", false, false);
      }
      done.click();
      while (Date.now() < deadline && visibleAgentInstructionDialogs().length) {
        root.FlowUiDeadline?.requireTime(deadline, "closing Flow's Agent instruction dialog", false, options.signal);
        await (root.FlowUiDeadline?.boundedWait
          ? root.FlowUiDeadline.boundedWait(100, deadline, "closing Flow's Agent instruction dialog", false, options.signal)
          : root.wait?.(100));
      }
      if (visibleAgentInstructionDialogs().length) {
        throw root.flowError("FLOW_AGENT_INSTRUCTION_DISMISS_UNCONFIRMED", "Flow did not confirm that its Agent instruction dialog closed.", false, false);
      }
    }

    const sessionClosed = isNativeAgentSessionOpen() ? await closeNativeAgentSession({ deadline, signal: options.signal }) : { wasOpen: false, closed: true };
    let mode = findNativeAgentModeControl();
    if (mode.activeCount > 0) {
      if (mode.activeCount !== 1 || !mode.control) {
        throw root.flowError("FLOW_AGENT_MODE_AMBIGUOUS", `Flow has ${mode.activeCount} active Agent mode controls; no toggle was clicked.`, false, false);
      }
      await setNativeAgentMode(false);
    }
    mode = findNativeAgentModeControl();
    if (isNativeAgentSessionOpen() || mode.activeCount > 0 || visibleAgentInstructionDialogs().length) {
      throw root.flowError("FLOW_AGENT_PREFLIGHT_UNCONFIRMED", "Flow's Agent interface is still active; the requested project operation was not started.", false, false);
    }
    return { success: true, instructionClosed: instructionDialogs.length === 1, sessionClosed: sessionClosed.wasOpen, agentModeOff: true };
  }

  async function resetNativeAgentWorkflow() {
    await closeNativeAgentSession();
    if (/\/edit(?:\/|$)/i.test(location.pathname)) {
      const back = root.flowButton?.("Back button to go to previous page");
      if (back) back.click();
      await root.waitForFlowRoute?.(path => !/\/edit(?:\/|$)/i.test(path), 20000, "Flow did not leave the Agent video editor.");
    }
    if (!document.querySelector("flow-grid-tile-container")) await root.ensureFlowLibrarySection?.("All media").catch(() => {});
    try { await setNativeAgentSettings("Always"); } catch {}
    try { await setNativeAgentMode(false); } catch {}
    const clear = root.flowButton?.("Clear prompt");
    if (clear) clear.click();
    else {
      const box = getNativeAgentPromptEditor();
      if (box) root.replaceNativeEditableText?.(box, "");
    }
    await root.wait?.(350);
  }

  async function answerNativeAgentQuestion(answer) {
    const box = getNativeAgentPromptEditor();
    if (!box || !root.replaceNativeEditableText?.(box, answer)) return false;
    await root.wait?.(200);
    const composer = box.closest?.("flow-base-prompt-box,.flow-composer,form,[class*='composer']") || box.parentElement;
    const controls = [...(composer?.querySelectorAll?.("button,[role=button]") || [])].filter(el => root.visible?.(el) && !el.disabled && el.getAttribute?.("aria-disabled") !== "true");
    const sendMatches = controls.filter(el => matchesLocalizedAction(el, "Send", "Submit", "Continue") ||
      /(?:^|[\s_-])(?:send|submit|continue)(?:$|[\s_-])/i.test(["data-testid", "data-action", "aria-label", "title"].map(key => el.getAttribute?.(key) || "").join(" ")) ||
      ["send", "arrow_forward", "arrow_upward"].includes((root.flowFindIcon?.(el)?.textContent || "").trim().toLowerCase()));
    const send = sendMatches.length === 1 ? sendMatches[0] : null;
    if (send) send.click();
    else {
      box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
      box.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true }));
    }
    return true;
  }

  async function resolveNativeAgentQuestion(command, answer) {
    for (let attempt = 0; attempt < 12; attempt++) {
      await root.wait?.(5000);
      const composer = (typeof root.flowQuery === "function" ? root.flowQuery("composerRoot") : null) || document.querySelector("flow-base-prompt-box,.flow-composer");
      const editor = getNativeAgentPromptEditor();
      const visibleChoices = [...document.querySelectorAll('[role="radio"],[role="option"],[role="button"],button')]
        .filter(el => root.visible?.(el))
        .map(el => foldFlowText([root.accessibleName?.(el), el.innerText, el.textContent, ...["data-method", "data-mode", "data-value", "data-testid", "aria-label"].map(name => el.getAttribute?.(name))].filter(Boolean).join(" ")))
        .filter(Boolean);
      const methodChoices = visibleChoices.some(label => /(?:image|video)\s*(?:to|->|→|sang|thanh)\s*(?:video|image)|\b(?:i2v|r2v|image.to.video|reference.to.video)\b|(?:anh|hinh anh)\s*(?:sang|thanh)\s*video/i.test(label));
      // Detect a method-choice state from the visible choice controls themselves;
      // prose and heading language can vary independently with the UI locale.
      if (!editor || !methodChoices || /\d{1,3}%/.test(composer?.innerText || "")) continue;
      root.emitFlowProgress?.(command, "Answering Flow Agent's video method question");
      if (await answerNativeAgentQuestion(answer)) {
        await root.wait?.(6000);
        return;
      }
    }
  }

  const FlowAgent = Object.freeze({
    agentConfirmationOptionMatches,
    inspectNativeAgentSettings,
    setNativeAgentSettings,
    inspectAgentRunConfirmation,
    findNativeAgentModeControl,
    getNativeAgentPromptEditor,
    isNativeAgentSessionOpen,
    visibleAgentPanelOwners,
    visibleAgentInstructionDialogs,
    ensureReadyForProjectOperation,
    setNativeAgentMode,
    closeNativeAgentSession,
    resetNativeAgentWorkflow,
    answerNativeAgentQuestion,
    resolveNativeAgentQuestion,
  });

  root.FlowAgent = FlowAgent;
  root.setNativeAgentSettings = setNativeAgentSettings;
  root.setNativeAgentMode = setNativeAgentMode;
  root.closeNativeAgentSession = closeNativeAgentSession;
  root.resetNativeAgentWorkflow = resetNativeAgentWorkflow;
  root.resolveNativeAgentQuestion = resolveNativeAgentQuestion;
})(globalThis);
