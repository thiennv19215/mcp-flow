async function setNativeAgentSettings(confirm, aspect) {
  const composer = document.querySelector("flow-base-prompt-box");
  const settings = composer && [...composer.querySelectorAll('button,[role="button"]')].find(el =>
    visible(el) && accessibleName(el).replace(/\s+/g, " ").trim() === "Settings");
  if (!settings) throw flowError("NATIVE_CAPABILITY_UNSUPPORTED", "Flow Agent settings are not available in this view; nothing was submitted.", true);
  settings.click(); await wait(350);
  const confirmRadio = nativeRadioMatching(name => new RegExp(`^${confirm}(?:\\b|\\s)`, "i").test(name));
  if (!confirmRadio) throw flowError("NATIVE_CAPABILITY_UNSUPPORTED", "Flow Agent confirmation settings are unavailable; nothing was submitted.", true);
  if (!nativeRadioSelected(confirmRadio)) confirmRadio.click();
  if (aspect) {
    const aspectRadio = flowRadio(aspect);
    const variantRadio = flowRadio("x1");
    if (!aspectRadio || !variantRadio) throw flowError("NATIVE_CAPABILITY_UNSUPPORTED", "Flow Agent aspect or variant settings are unavailable; nothing was submitted.", true);
    if (!nativeRadioSelected(aspectRadio)) aspectRadio.click();
    if (!nativeRadioSelected(variantRadio)) variantRadio.click();
  }
  await wait(250);
  const save = flowButton("Save");
  if (!save) throw flowError("NATIVE_CAPABILITY_UNSUPPORTED", "Flow Agent settings could not be saved; nothing was submitted.", true);
  save.click(); await wait(700);
}

async function setNativeAgentMode(on) {
  const modeIs = () => {
    const agent = flowButton("Agent");
    return Boolean(agent) && (agent.getAttribute("aria-pressed") === "true") === on;
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    if (modeIs()) return;
    const settingsDialog = [...document.querySelectorAll('[role="dialog"],mat-dialog-container,.cdk-overlay-pane')].find(el =>
      visible(el) && /Agent settings/i.test(el.innerText || el.textContent || ""));
    const save = settingsDialog && flowButton("Save", settingsDialog);
    if (save) { save.click(); await wait(400); }
    const focused = document.activeElement;
    if (focused?.closest?.("mat-sidenav,[role=navigation]")) focused.blur();
    const agent = flowButton("Agent");
    if (!agent) {
      await closeNativeAgentSession();
      if (modeIs()) return;
      await wait(250);
      continue;
    }
    agent.click();
    await wait(700);
  }
  if (!modeIs()) throw flowError("FLOW_AGENT_MODE_FAILED", `Could not switch Flow Agent mode ${on ? "on" : "off"}.`, true);
}

async function closeNativeAgentSession() {
  if (!flowButton("Start new session")) return;
  const close = flowButton("Close");
  if (close) close.click();
  await wait(700);
}

async function resetNativeAgentWorkflow() {
  await closeNativeAgentSession();
  if (/\/edit(?:\/|$)/i.test(location.pathname)) {
    const back = flowButton("Back button to go to previous page");
    if (back) back.click();
    await waitForFlowRoute(path => !/\/edit(?:\/|$)/i.test(path), 20_000, "Flow did not leave the Agent video editor.");
  }
  if (!document.querySelector("flow-grid-tile-container")) await ensureFlowLibrarySection("All media").catch(() => {});
  try { await setNativeAgentSettings("Always"); } catch {}
  try { await setNativeAgentMode(false); } catch {}
  const clear = flowButton("Clear prompt");
  if (clear) clear.click();
  else {
    const box = document.querySelector(".ProseMirror");
    if (box) replaceNativeEditableText(box, "");
  }
  await wait(350);
}

async function answerNativeAgentQuestion(answer) {
  const box = document.querySelector(".ProseMirror");
  if (!box || !replaceNativeEditableText(box, answer)) return false;
  await wait(200);
  const send = [...document.querySelectorAll("button,[role=button]")].find(el =>
    visible(el) && !el.disabled && /^(send|submit|continue)$/i.test(accessibleName(el).replace(/\s+/g, " ").trim()));
  if (send) send.click();
  else {
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
    box.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true }));
  }
  return true;
}

async function resolveNativeAgentQuestion(command, answer) {
  for (let attempt = 0; attempt < 12; attempt++) {
    await wait(5000);
    const body = document.body?.innerText || "";
    if (/\d{1,3}%/.test(body)) return;
    if (!/Would you like to|which you prefer|I2V|R2V/i.test(body)) continue;
    emitFlowProgress(command, "Answering Flow Agent's video method question");
    if (await answerNativeAgentQuestion(answer)) {
      await wait(6000);
      return;
    }
  }
}
