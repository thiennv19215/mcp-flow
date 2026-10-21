(function (root) {
  "use strict";

  function agentConfirmationOptionMatches(mode, label) {
    const value = String(label || "").replace(/\s+/g, " ").trim();
    if (mode === "Always") return /^(?:always(?:\s+(?:ask|confirm|prompt))?|ask (?:every|each) time|luôn(?: luôn)?(?:\s+hỏi)?)(?:\b|$)/i.test(value);
    if (mode === "Never") return /^(?:never(?:\s+(?:ask|confirm|prompt|auto[- ]?spend))?|do not ask|don't ask|không bao giờ(?:\s+hỏi)?|không hỏi)(?:\b|$)/i.test(value);
    return false;
  }

  const agentSettingsSurfaceSelector = '[role="dialog"],mat-dialog-container,.cdk-overlay-pane,flow-dialog,[role="menu"],mat-menu-panel';
  function agentSurfaceSummary(surface) {
    const text = String(surface?.innerText || surface?.textContent || "").replace(/\s+/g, " ").trim();
    const radios = [...(surface?.querySelectorAll?.('[role="radio"],mat-radio-button') || [])].filter(el => root.visible?.(el));
    const labels = radios.map(el => String(root.accessibleName?.(el) || el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 100));
    const saveButtons = [...(surface?.querySelectorAll?.('button,[role="button"]') || [])].filter(el => root.visible?.(el) && /^(?:save|done|apply|lưu|xong)$/i.test(String(root.accessibleName?.(el) || el.innerText || el.textContent || "").replace(/\s+/g, " ").trim()));
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
      const hasAlways = radios.some(el => agentConfirmationOptionMatches("Always", root.accessibleName?.(el) || el.innerText || el.textContent || ""));
      const hasSave = [...(surface.querySelectorAll?.('button,[role="button"]') || [])].some(el => root.visible?.(el) && /^(?:save|done|apply|lưu|xong)$/i.test(String(root.accessibleName?.(el) || el.innerText || el.textContent || "").replace(/\s+/g, " ").trim()));
      const heading = String(surface.innerText || surface.textContent || "");
      return hasAlways && hasSave && /agent|trợ lý/i.test(heading);
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
      return /^(?:settings|cài đặt)$/i.test(label) || icon === "tune" || icon === "settings" || icon === "settings_2";
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
      root.visible?.(el) && agentConfirmationOptionMatches(confirm, root.accessibleName?.(el) || el.innerText || el.textContent || ""));
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
    const saveButtons = [...(settingsSurface.querySelectorAll?.('button,[role="button"]') || [])].filter(el =>
      root.visible?.(el) && !el.disabled && el.getAttribute?.("aria-disabled") !== "true" && /^(?:save|done|apply|lưu|xong)$/i.test(String(root.accessibleName?.(el) || el.innerText || el.textContent || "").replace(/\s+/g, " ").trim()));
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
    const matchingDialogs = dialogs.filter(el => /\b(?:generate|create|confirm|credits?|tín dụng)\b|tạo|xác nhận/i.test(el.innerText || el.textContent || ""));
    // Material can expose the same one-run confirmation as nested overlay and
    // dialog nodes. Keep only the most specific matching surface; independent
    // matching dialogs remain ambiguous and are never clicked.
    const candidates = matchingDialogs.filter(surface => !matchingDialogs.some(other => other !== surface && surface.contains?.(other)));
    if (candidates.length === 0) return { state: "none", diagnostics: { visibleDialogCount: dialogs.length, confirmationSurfaceCount: 0 } };
    if (candidates.length !== 1) return { state: "blocked", reason: "confirmation_surface_ambiguous", diagnostics: { visibleDialogCount: dialogs.length, confirmationSurfaceCount: candidates.length } };
    const dialog = candidates[0];
    const text = String(dialog.innerText || dialog.textContent || "").replace(/\s+/g, " ").trim().slice(0, 500);
    const persistentSetting = /always\s+ask|never\s+(?:ask|auto[- ]?spend)|auto[- ]?spend|for future|account setting/i.test(text);
    const oneRun = /\b(?:generate|create)\s+(?:this|one|1|a|an)\s+(?:image|generation|request)\b|\b(?:this|one|1)\s+(?:image|generation|request)\b/i.test(text);
    const zeroCredits = /\b0\s+credits?\b/i.test(text);
    if (persistentSetting || !oneRun || !zeroCredits) {
      return { state: "blocked", reason: persistentSetting ? "persistent_setting_dialog" : !oneRun ? "not_a_one_run_confirmation" : "credit_quote_not_explicitly_zero", text,
        diagnostics: { visibleDialogCount: dialogs.length, confirmationSurfaceCount: 1, persistentSetting, oneRun, zeroCredits } };
    }
    const buttons = [...dialog.querySelectorAll('button,[role="button"]')].filter(el => root.visible?.(el) && !el.disabled && el.getAttribute("aria-disabled") !== "true");
    const confirms = buttons.filter(button => /^(?:generate|create|confirm|submit|continue|tạo|xác nhận|tiếp tục)(?:\s+(?:image|now))?(?:\s*\(?0\s+credits?\)?)?$/i.test(
      String(root.accessibleName?.(button) || button.innerText || button.textContent || "").replace(/\s+/g, " ").trim()));
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
    const controls = [...composer.querySelectorAll('button,[role="button"]')].filter(el => {
      if (!root.visible?.(el)) return false;
      const label = String(root.accessibleName?.(el) || el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
      const pressed = el.getAttribute?.("aria-pressed");
      return /^Agent$/i.test(label) && (pressed === "true" || pressed === "false");
    });
    return { control: controls.length === 1 ? controls[0] : null, count: controls.length, composerFound: true };
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
    const settingsDialog = [...document.querySelectorAll('[role="dialog"],mat-dialog-container,.cdk-overlay-pane')].find(el =>
      root.visible?.(el) && /Agent settings|cài đặt trợ lý/i.test(el.innerText || el.textContent || ""));
    const save = settingsDialog && root.flowButton?.("Save", settingsDialog);
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

  async function closeNativeAgentSession() {
    if (!root.flowButton?.("Start new session")) return;
    const close = root.flowButton?.("Close");
    if (close) close.click();
    await root.wait?.(700);
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
      const box = document.querySelector(".ProseMirror");
      if (box) root.replaceNativeEditableText?.(box, "");
    }
    await root.wait?.(350);
  }

  async function answerNativeAgentQuestion(answer) {
    const box = document.querySelector(".ProseMirror");
    if (!box || !root.replaceNativeEditableText?.(box, answer)) return false;
    await root.wait?.(200);
    const send = [...document.querySelectorAll("button,[role=button]")].find(el =>
      root.visible?.(el) && !el.disabled && /^(send|submit|continue|gửi|tiếp tục)$/i.test((root.accessibleName?.(el) || "").replace(/\s+/g, " ").trim()));
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
      const body = document.body?.innerText || "";
      if (/\d{1,3}%/.test(body)) return;
      if (!/Would you like to|which you prefer|I2V|R2V/i.test(body)) continue;
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
