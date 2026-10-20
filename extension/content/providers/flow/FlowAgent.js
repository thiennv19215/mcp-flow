(function (root) {
  "use strict";

  async function setNativeAgentSettings(confirm, aspect) {
    const composer = (typeof root.flowQuery === "function" ? root.flowQuery("composerRoot") : null) ||
      document.querySelector("flow-base-prompt-box");
    const settings = composer && [...composer.querySelectorAll('button,[role="button"]')].find(el => {
      if (!root.visible?.(el)) return false;
      const label = (root.accessibleName?.(el) || el.innerText || "").replace(/\s+/g, " ").trim().toLowerCase();
      const icon = (root.flowFindIcon ? root.flowFindIcon(el) : el.querySelector?.("mat-icon, .mat-icon, .google-symbols"))?.textContent?.trim().toLowerCase();
      return /^(?:settings|cài đặt)$/i.test(label) || icon === "tune" || icon === "settings";
    });
    if (!settings) throw root.flowError("NATIVE_CAPABILITY_UNSUPPORTED", "Flow Agent settings are not available in this view; nothing was submitted.", true);
    settings.click();
    await root.wait?.(350);
    const confirmPatterns = confirm === "Never"
      ? /^(?:never|không bao giờ)/i
      : /^(?:always|luôn luôn)/i;
    const confirmRadio = ((typeof root.flowQueryAll === "function" ? root.flowQueryAll("settings.options") : null) ||
      [...document.querySelectorAll('[role="radio"],mat-radio-button')]).find(el =>
      root.visible?.(el) && confirmPatterns.test((root.accessibleName?.(el) || el.innerText || "").replace(/\s+/g, " ").trim()));
    if (!confirmRadio) throw root.flowError("NATIVE_CAPABILITY_UNSUPPORTED", "Flow Agent confirmation settings are unavailable; nothing was submitted.", true);
    if (!root.FlowSettings?.nativeRadioSelected?.(confirmRadio)) confirmRadio.click();
    if (aspect) {
      const aspectRadio = root.FlowSettings?.flowRadio?.(aspect);
      const variantRadio = root.FlowSettings?.flowRadio?.("x1");
      if (!aspectRadio || !variantRadio) throw root.flowError("NATIVE_CAPABILITY_UNSUPPORTED", "Flow Agent aspect or variant settings are unavailable; nothing was submitted.", true);
      if (!root.FlowSettings?.nativeRadioSelected?.(aspectRadio)) aspectRadio.click();
      if (!root.FlowSettings?.nativeRadioSelected?.(variantRadio)) variantRadio.click();
    }
    await root.wait?.(250);
    const save = root.flowButton?.("Save");
    if (!save) throw root.flowError("NATIVE_CAPABILITY_UNSUPPORTED", "Flow Agent settings could not be saved; nothing was submitted.", true);
    save.click();
    await root.wait?.(700);
  }

  async function setNativeAgentMode(on) {
    const modeIs = () => {
      const agent = root.flowButton?.("Agent");
      return Boolean(agent) && (agent.getAttribute("aria-pressed") === "true") === on;
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      if (modeIs()) return;
      const settingsDialog = [...document.querySelectorAll('[role="dialog"],mat-dialog-container,.cdk-overlay-pane')].find(el =>
        root.visible?.(el) && /Agent settings|cài đặt trợ lý/i.test(el.innerText || el.textContent || ""));
      const save = settingsDialog && root.flowButton?.("Save", settingsDialog);
      if (save) { save.click(); await root.wait?.(400); }
      const focused = document.activeElement;
      if (focused?.closest?.("mat-sidenav,[role=navigation]")) focused.blur();
      const agent = root.flowButton?.("Agent");
      if (!agent) {
        await closeNativeAgentSession();
        if (modeIs()) return;
        await root.wait?.(250);
        continue;
      }
      agent.click();
      await root.wait?.(700);
    }
    if (!modeIs()) throw root.flowError("FLOW_AGENT_MODE_FAILED", `Could not switch Flow Agent mode ${on ? "on" : "off"}.`, true);
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
    setNativeAgentSettings,
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
