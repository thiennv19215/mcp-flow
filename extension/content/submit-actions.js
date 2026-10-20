function normalizeFlowPrompt(value) {
  return String(value || "").replace(/[\u200B\u200C\u200D\uFEFF]/g, "").replace(/\s+/g, " ").trim();
}

function isSubmitButtonElement(el) {
  if (!el || !visible(el) || isFlowProjectNavigationControl(el)) return false;
  // Check aria-label and accessible name
  const name = (accessibleName(el) || "").replace(/\s+/g, " ").trim().toLowerCase();
  const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
  const submitPatterns = /^(?:start generation|generate|create|bắt đầu tạo|tạo video|tạo|bắt đầu)$/i;
  if (submitPatterns.test(name) || submitPatterns.test(text)) return true;
  if (name.includes("start generation") || name.includes("bắt đầu tạo")) return true;

  // Check icon in button (like TobyFlow: arrow_forward, send, sparkle, auto_awesome)
  const icon = el.querySelector("mat-icon, .mat-icon, .google-symbols, i, svg");
  if (icon) {
    const iconText = (icon.textContent || "").trim();
    if (/^(?:arrow_forward|send|sparkle|auto_awesome|play_arrow)$/i.test(iconText)) return true;
  }
  // Check type="submit" or data attributes
  if (el.getAttribute("type") === "submit") return true;
  if (el.getAttribute("data-action") === "submit" || el.getAttribute("data-action") === "generate") return true;
  return false;
}

function inspectFlowSubmitTarget(button, expectedPrompt) {
  if (!button || !button.isConnected || !visible(button)) {
    throw flowError("FLOW_SUBMIT_BUTTON_MISSING", "Flow's Start generation button disappeared before activation.", true);
  }
  if (button.disabled || button.getAttribute("aria-disabled") === "true") {
    throw flowError("FLOW_SUBMIT_DISABLED", "Flow's Start generation button is disabled; nothing was submitted.", true);
  }
  const wanted = normalizeFlowPrompt(expectedPrompt);
  const editors = [...document.querySelectorAll(".ProseMirror[contenteditable='true']")].filter(visible);
  const promptBox = editors.find(editor => {
    const actual = normalizeFlowPrompt(editor.innerText || editor.textContent);
    return wanted ? (actual.includes(wanted) || actual.endsWith(wanted)) : Boolean(actual);
  }) || editors[0];
  if (!promptBox) {
    throw flowError("FLOW_SUBMIT_PROMPT_NOT_READY", "The visible Flow composer does not contain the prompt prepared for this request. Nothing was submitted.", true, false);
  }
  const rect = button.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  if (!Number.isFinite(x) || !Number.isFinite(y) || rect.width < 4 || rect.height < 4 ||
      x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) {
    throw flowError("FLOW_SUBMIT_TARGET_OUT_OF_VIEW", "Flow's submit button is not fully available in the visible viewport. Nothing was submitted.", true, false);
  }
  const hit = document.elementFromPoint(x, y);
  // Like TobyFlow, allow button, any descendant of button, or ripple/touch targets
  if (hit && hit !== button && !button.contains(hit) && !hit.closest("button")?.isSameNode(button)) {
    // If occluded by a transient overlay or something outside the composer, log warning but don't hard abort if button is visible
    console.warn("[FlowSubmit] hit element differs from button:", hit);
  }
  return { x, y, prompt: normalizeFlowPrompt(promptBox.innerText || promptBox.textContent) };
}

function getFlowSubmitButton(expectedPrompt) {
  // 1. Scan for button with explicit icon or text
  const allButtons = [...document.querySelectorAll('button,[role="button"]')].filter(visible);
  const matched = allButtons.find(isSubmitButtonElement);
  if (matched && !matched.disabled && matched.getAttribute("aria-disabled") !== "true") return matched;

  // 2. Scan composer container directly (where .ProseMirror lives)
  const composer = document.querySelector(".ProseMirror")?.closest(".flow-composer, [class*='composer'], form") ||
    document.querySelector(".flow-composer, [class*='composer']");
  if (composer) {
    const composerButtons = [...composer.querySelectorAll('button,[role="button"]')].filter(visible);
    // Find button containing arrow_forward, send, or circular submit shape
    const submitBtn = composerButtons.find(b => {
      if (b.disabled || b.getAttribute("aria-disabled") === "true") return false;
      const icon = b.querySelector("mat-icon, .mat-icon, .google-symbols, i, svg");
      const iconTxt = (icon?.textContent || "").trim();
      return /arrow_forward|send|sparkle|auto_awesome|play_arrow/i.test(iconTxt);
    });
    if (submitBtn) return submitBtn;

    // TobyFlow positional match: the last enabled button in composer is almost always the submit button
    const enabledButtons = composerButtons.filter(b => !b.disabled && b.getAttribute("aria-disabled") !== "true" && !isFlowProjectNavigationControl(b));
    if (enabledButtons.length > 0) {
      const lastBtn = enabledButtons[enabledButtons.length - 1];
      // Verify it's not the settings trigger or clear button
      const label = (accessibleName(lastBtn) || "").toLowerCase();
      if (!label.includes("setting") && !label.includes("clear") && !label.includes("cài đặt")) {
        return lastBtn;
      }
    }
  }

  // 3. Fallback to matched even if disabled check needed later
  return matched || null;
}

function pressFlowEditorSubmit(editor) {
  if (!editor || !(editor instanceof HTMLElement) || !editor.isConnected) return false;
  try {
    editor.focus({ preventScroll: true });
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(range);
    const options = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true };
    editor.dispatchEvent(new KeyboardEvent("keydown", options));
    editor.dispatchEvent(new KeyboardEvent("keypress", options));
    editor.dispatchEvent(new KeyboardEvent("keyup", options));
    return true;
  } catch (err) {
    console.warn("[FlowSubmit] editor Enter press failed:", err);
    return false;
  }
}

async function activateFlowSubmitButton(button, expectedPrompt) {
  let target = null;
  try {
    target = inspectFlowSubmitTarget(button, expectedPrompt);
  } catch (e) {
    console.warn("[FlowSubmit] inspect target warning, continuing with bounding rect:", e?.message);
    const rect = button.getBoundingClientRect();
    target = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }
  try {
    const point = { bubbles: true, cancelable: true, composed: true, button: 0, clientX: target.x, clientY: target.y, pointerType: "mouse", view: window };
    button.dispatchEvent(new PointerEvent("pointerover", { ...point, pointerId: 1 }));
    button.dispatchEvent(new MouseEvent("mouseover", point));
    button.dispatchEvent(new PointerEvent("pointerdown", { ...point, pointerId: 1 }));
    button.dispatchEvent(new MouseEvent("mousedown", point));
    if (typeof button.focus === "function") button.focus({ preventScroll: true });
    await wait(60);
    button.dispatchEvent(new PointerEvent("pointerup", { ...point, pointerId: 1 }));
    button.dispatchEvent(new MouseEvent("mouseup", point));
    button.dispatchEvent(new MouseEvent("click", point));
    button.click();

    // TobyFlow: If button has child elements (icon, span), click child as well
    const innerIcon = button.querySelector("mat-icon, i, svg, span");
    if (innerIcon) {
      innerIcon.dispatchEvent(new MouseEvent("click", point));
    }

    // Call TobyFlow's slate-bridge in MAIN world to directly execute Angular click listener with isTrusted proxy
    const submitToken = crypto.randomUUID();
    button.setAttribute("data-tobyflow-submit-token", submitToken);
    try {
      await new Promise(resolve => {
        const handler = ev => {
          if (ev.data?.source === "flow-auto-slate-result") {
            window.removeEventListener("message", handler);
            resolve();
          }
        };
        window.addEventListener("message", handler);
        window.postMessage({ source: "flow-auto-slate", action: "activateV2Submit", submitToken, requestId: submitToken }, location.origin);
        setTimeout(resolve, 300);
      });
    } finally {
      button.removeAttribute("data-tobyflow-submit-token");
    }
  } catch (error) {
    if (error?.code) throw error;
    throw flowError("FLOW_SUBMIT_ACTIVATION_FAILED", `Flow's validated DOM click raised an error (${String(error?.message || error)}). No submit was confirmed.`, true, false);
  }
  return { clickDelivered: true, controlAccepted: false, strategy: "validated-dom-click" };
}

async function waitForGenerationSubmitButton(expectedPrompt, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const button = getFlowSubmitButton(expectedPrompt);
    if (button) {
      try {
        inspectFlowSubmitTarget(button, expectedPrompt);
        return button;
      } catch (err) {
        // If it's valid and enabled, return it
        if (!button.disabled && button.getAttribute("aria-disabled") !== "true") {
          return button;
        }
      }
    }
    await wait(150);
  }
  return null;
}

function currentFlowSubmitErrors() {
  const errorWords = /(?:error|failed|could not|couldn't|unable|insufficient|not enough|quota|credit limit|try again)/i;
  return [...document.querySelectorAll('[role="alert"], [aria-live="assertive"], mat-error, .mat-mdc-form-field-error')]
    .filter(visible)
    .map(el => (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim())
    .filter(text => text && errorWords.test(text));
}

function emitFlowProgress(command, progress) {
  try { chrome.runtime.sendMessage({ type: "flow-mcp:progress", commandId: command.id || command.commandId, jobId: command.job_id || command.jobId, progress }).catch(() => {}); } catch {}
}

function descriptor(item) {
  return { id: item.id, title: item.title, kind: item.kind };
}

async function retryNativeErrorTile(item) {
  let tile = [...document.querySelectorAll("flow-grid-tile-container")].find(candidate =>
    item.id && !item.id.startsWith("title:") ? mediaId(candidate) === item.id : candidate.getAttribute("aria-label") === item.title);
  if (!tile) return false;
  tile.scrollIntoView({ block: "center" });
  const rect = tile.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  tile.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, clientX: x, clientY: y, pointerId: 1, pointerType: "mouse" }));
  tile.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, clientX: x, clientY: y }));
  await wait(250);
  const retry = [...tile.querySelectorAll("button,[role=button]")].find(el => {
    if (!visible(el) || el.disabled || el.getAttribute("aria-disabled") === "true") return false;
    const label = accessibleName(el).replace(/\s+/g, " ").trim().toLowerCase();
    const icon = el.querySelector("mat-icon,.mat-icon,.google-symbols,.material-symbols-outlined,svg")?.textContent?.trim() || "";
    return /^(retry|try again|thử lại)$/i.test(label) || /refresh|replay|retry/i.test(icon);
  });
  if (!retry) return false;
  const retryRect = retry.getBoundingClientRect();
  const rx = retryRect.left + retryRect.width / 2;
  const ry = retryRect.top + retryRect.height / 2;
  const point = { bubbles: true, cancelable: true, composed: true, button: 0, clientX: rx, clientY: ry };
  retry.dispatchEvent(new PointerEvent("pointerover", { ...point, pointerId: 1, pointerType: "mouse" }));
  retry.dispatchEvent(new MouseEvent("mouseover", point));
  retry.dispatchEvent(new PointerEvent("pointerdown", { ...point, pointerId: 1, pointerType: "mouse" }));
  retry.dispatchEvent(new MouseEvent("mousedown", point));
  retry.dispatchEvent(new PointerEvent("pointerup", { ...point, pointerId: 1, pointerType: "mouse" }));
  retry.dispatchEvent(new MouseEvent("mouseup", point));
  retry.dispatchEvent(new MouseEvent("click", point));
  retry.click();
  await wait(2000);
  if (scrollContainer()) scrollContainer().scrollTop = 0;
  return true;
}

async function waitForProgressResult(command, before, expected, kind, timeoutMs, selector = "flow-grid-tile-container", allowConfirmedPartial = false) {
  const until = Date.now() + timeoutMs;
  let hadProgress = false, last = "", lastTitleOnlyResult = "", retriesLeft = Math.max(1, Number(command?.retries ?? 2));
  while (Date.now() < until) {
    const fresh = collectNativeMedia().filter(item => !before.includes(item.id || `title:${item.title}`) && (!kind || item.kind === kind));
    const failed = fresh.filter(item => item.failed);
    if (failed.length) {
      if (retriesLeft > 0 && await retryNativeErrorTile(failed[0])) {
        retriesLeft--;
        emitFlowProgress(command, `Flow failed this render; retrying its failed tile (${retriesLeft} retries remaining)`);
        continue;
      }
      if (!allowConfirmedPartial || fresh.filter(item => !item.busy).length >= expected) {
        const ready = fresh.filter(item => !item.busy && !item.failed);
        const failure = failed[0];
        const error = flowError("FLOW_GENERATION_FAILED", `Flow failed while processing "${failure.title}"${failure.failureReason ? `: ${failure.failureReason}` : ""}. Nothing was charged for the failed render.`, false, false);
        if (allowConfirmedPartial && ready.length + failed.length >= expected) {
          error.partialMedia = ready.map(descriptor);
          error.failedMedia = failed.map(descriptor);
        }
        throw error;
      }
    }
    const ready = fresh.filter(item => !item.busy && !item.failed);
    if (ready.length >= expected) {
      const picked = ready.slice(0, expected);
      const titleOnly = picked.some(item => !item.id || item.id.startsWith("title:"));
      const signature = picked.map(item => item.id || `title:${item.title}`).join("|");
      if (!titleOnly || signature === lastTitleOnlyResult) return picked.map(descriptor);
      lastTitleOnlyResult = signature;
      emitFlowProgress(command, "Flow is finishing the video title");
      await wait(1500);
      continue;
    }
    const pct = [...document.querySelectorAll(selector)].slice(0, 10).map(el => (el.innerText || "").match(/\d+%/)?.[0]).filter(Boolean);
    if (pct.length) hadProgress = true;
    const text = pct.join(", ") || (hadProgress ? "Flow is finishing the result" : "Waiting for Flow");
    if (text !== last) { emitFlowProgress(command, text); last = text; }
    await wait(2500);
  }
  throw flowError("FLOW_OPERATION_TIMEOUT", "Timed out waiting for Flow. The operation may have completed; inspect Flow before retrying.", false, true);
}

async function waitForNativeEditorCompletion(command, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  let seenProgress = false;
  let previous = "";
  while (Date.now() < deadline) {
    const text = document.querySelector("main")?.innerText || document.body?.innerText || "";
    const progress = text.match(/\d{1,3}%/)?.[0];
    if (progress) {
      seenProgress = true;
      if (progress !== previous) emitFlowProgress(command, progress);
      previous = progress;
    } else if (seenProgress) {
      return true;
    }
    const failure = text.split("\n").map(line => line.trim()).find(line =>
      /(?:failed to generate|generation failed|could not generate|something went wrong|try again)/i.test(line));
    if (failure) throw flowError("FLOW_GENERATION_FAILED", `Flow reported a failed ${description}: ${failure.slice(0, 300)}`, false, true);
    await wait(2500);
  }
  throw flowError("FLOW_OPERATION_TIMEOUT", `Timed out waiting for Flow to finish the ${description}. Inspect Flow before retrying.`, false, true);
}
