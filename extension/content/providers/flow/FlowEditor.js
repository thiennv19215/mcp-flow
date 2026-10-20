(function (root) {
  "use strict";

  function normalizeFlowPrompt(value) {
    return String(value || "").replace(/[\u200B\u200C\u200D\uFEFF]/g, "").replace(/\s+/g, " ").trim();
  }

  function getEditorUserText(editor) {
    if (!editor) return "";
    if (!editor.isContentEditable) {
      return String(editor.value || editor.textContent || "").replace(/[\u200B\u200C\u200D\uFEFF]/g, "").replace(/\s+/g, " ").trim();
    }
    const chunks = [];
    const blockTags = new Set(["P", "DIV", "LI", "UL", "OL", "BLOCKQUOTE", "PRE"]);
    const visit = node => {
      if (node.nodeType === 3 /* TEXT_NODE */) {
        chunks.push(node.nodeValue || "");
        return;
      }
      if (node.nodeType !== 1 /* ELEMENT_NODE */) return;
      const element = node;
      // Bỏ qua các inline chip nhân vật, tham chiếu, mention có contenteditable="false"
      if (element.getAttribute?.("contenteditable") === "false") return;
      if (element.tagName === "BR") {
        chunks.push("\n");
        return;
      }
      const isBlock = blockTags.has(element.tagName);
      if (isBlock && chunks.length && !String(chunks[chunks.length - 1]).endsWith("\n")) chunks.push("\n");
      for (const child of element.childNodes || []) visit(child);
      if (isBlock && !String(chunks[chunks.length - 1] || "").endsWith("\n")) chunks.push("\n");
    };
    visit(editor);
    return chunks.join("").replace(/[\u200B\u200C\u200D\uFEFF]/g, "").replace(/\s+/g, " ").trim();
  }

  function countInlineChips(editor) {
    if (!editor || !editor.querySelectorAll) return 0;
    return editor.querySelectorAll('[contenteditable="false"]').length;
  }

  async function clearEditorTextPreservingChips(editor) {
    if (!editor?.isContentEditable) return false;

    const chipCount = countInlineChips(editor);
    const currentText = getEditorUserText(editor);
    if (!currentText) return true;

    editor.focus?.();
    const selection = typeof window !== "undefined" ? window.getSelection?.() : null;

    if (chipCount === 0) {
      try {
        const range = document.createRange();
        range.selectNodeContents(editor);
        selection?.removeAllRanges();
        selection?.addRange(range);
        document.execCommand("delete", false);
        selection?.removeAllRanges();
      } catch {}
      await root.wait?.(50);
      if (getEditorUserText(editor)) {
        try {
          document.execCommand("selectAll", false);
          document.execCommand("delete", false);
        } catch {}
        await root.wait?.(50);
      }
      return !getEditorUserText(editor);
    }

    // Khi có chips: xóa các text node tự do mà giữ nguyên các thẻ chip [contenteditable="false"]
    const textNodesToDelete = [];
    const SHOW_TEXT = typeof NodeFilter !== "undefined" ? NodeFilter.SHOW_TEXT : 4;
    const FILTER_ACCEPT = typeof NodeFilter !== "undefined" ? NodeFilter.FILTER_ACCEPT : 1;
    const FILTER_REJECT = typeof NodeFilter !== "undefined" ? NodeFilter.FILTER_REJECT : 2;
    const FILTER_SKIP = typeof NodeFilter !== "undefined" ? NodeFilter.FILTER_SKIP : 3;

    if (typeof document.createTreeWalker === "function") {
      try {
        const walker = document.createTreeWalker(editor, SHOW_TEXT, {
          acceptNode: node => {
            if (node.parentElement?.closest?.('[contenteditable="false"]')) return FILTER_REJECT;
            if ((node.nodeValue || "").replace(/[\u200B\u200C\u200D\uFEFF]/g, "").trim().length > 0) {
              return FILTER_ACCEPT;
            }
            return FILTER_SKIP;
          }
        });
        while (walker.nextNode()) textNodesToDelete.push(walker.currentNode);
      } catch {}
    }

    if (!textNodesToDelete.length) {
      const collectTextNodes = node => {
        if (!node) return;
        if (node.nodeType === 3) {
          if (!node.parentElement?.closest?.('[contenteditable="false"]')) textNodesToDelete.push(node);
          return;
        }
        if (node.getAttribute?.("contenteditable") === "false") return;
        for (const child of node.childNodes || []) collectTextNodes(child);
      };
      collectTextNodes(editor);
    }

    for (const textNode of textNodesToDelete) {
      try {
        const range = document.createRange();
        range.selectNode(textNode);
        selection?.removeAllRanges?.();
        selection?.addRange?.(range);
        document.execCommand?.("delete", false);
      } catch {}
      textNode.nodeValue = "";
    }

    selection?.removeAllRanges?.();
    await root.wait?.(50);
    try {
      editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
    } catch {}
    return !getEditorUserText(editor);
  }

  async function insertNativeFlowPrompt(el, value) {
    const text = String(value || "");
    const expected = normalizeFlowPrompt(text);
    if (!el?.isContentEditable) return false;

    // Xóa sạch prompt cũ nhưng bảo toàn các chip reference
    await clearEditorTextPreservingChips(el);

    el.focus();
    const selection = window.getSelection?.();
    const range = document.createRange?.();
    range?.selectNodeContents(el);
    range?.collapse(false);
    selection?.removeAllRanges?.();
    if (range) selection?.addRange?.(range);

    let inserted = false;
    if (expected && typeof DataTransfer === "function" && typeof ClipboardEvent === "function") {
      try {
        const clipboard = new DataTransfer();
        clipboard.setData("text/plain", text);
        const paste = new ClipboardEvent("paste", { clipboardData: clipboard, bubbles: true, cancelable: true });
        el.dispatchEvent(paste);
        inserted = paste.defaultPrevented || normalizeFlowPrompt(getEditorUserText(el)) === expected;
      } catch {}
    }
    if (expected && !inserted) {
      try { document.execCommand?.("insertText", false, text); } catch {}
    }
    await root.wait?.(150);
    const actual = normalizeFlowPrompt(getEditorUserText(el));
    return !expected || actual === expected || actual.endsWith(expected);
  }

  async function preflightGenerationPrompt(payload, framesMode) {
    if (root.FlowSettings?.flowSettingsPanelVisible?.()) {
      await root.FlowSettings.closeFlowSettings();
    }
    await (root.FlowNavigation?.dismissBlockingOverlays?.() || root.dismissBlockingOverlays?.());
    const deadline = Date.now() + 5000;
    let promptBox = null;
    while (Date.now() < deadline) {
      promptBox = (typeof root.flowQuery === "function" ? root.flowQuery("editor") : null) ||
        [...document.querySelectorAll(".ProseMirror")].find(el => root.visible?.(el) && el.isContentEditable);
      if (promptBox) return promptBox;
      await root.wait?.(100);
    }
    throw root.flowError("FLOW_PROMPT_COMPOSER_NOT_READY", "Flow's prompt editor is not visible after closing settings. Nothing was submitted.", true, false);
  }

  function isSubmitButtonElement(el) {
    if (!el || !root.visible?.(el) || root.isFlowProjectNavigationControl?.(el)) return false;
    if (el.closest?.('nav, [role="navigation"], mat-sidenav, header, mat-toolbar, [role="banner"]')) return false;

    const name = (root.accessibleName?.(el) || "").replace(/\s+/g, " ").trim().toLowerCase();
    const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();

    const config = root.FlowSelectors?.submitButton;
    const excludedPatterns = config?.excludedTextRegex || /(?:project|dự án|character|nhân vật|folder|thư mục|settings|cài đặt|tune|clear prompt|xóa câu lệnh|xóa văn bản|quay lại|back|upload|tải lên)/i;
    if (root.matchesFlowUiRegex?.(name, excludedPatterns) || root.matchesFlowUiRegex?.(text, excludedPatterns)) return false;

    const submitPatterns = config?.textRegex || /^(?:start generation|generate|bắt đầu tạo|tạo video|tạo ảnh|tạo hình ảnh)$/i;
    if (root.matchesFlowUiRegex?.(name, submitPatterns) || root.matchesFlowUiRegex?.(text, submitPatterns)) return true;
    if (name.includes("start generation") || name.includes("bắt đầu tạo")) return true;

    // Nếu nhãn là từ đơn "tạo" hoặc "create", CHỈ chấp nhận khi nó thuộc hoặc nằm cạnh composer / ProseMirror
    const nearComposerRegex = config?.nearComposerTextRegex || /^(?:create|tạo)$/i;
    if (root.matchesFlowUiRegex?.(name, nearComposerRegex) || root.matchesFlowUiRegex?.(text, nearComposerRegex)) {
      const isNearComposer = Boolean(el.closest?.(".flow-composer, flow-base-prompt-box, form, [class*='composer']")) ||
        Boolean(el.parentElement?.querySelector?.(".ProseMirror"));
      if (isNearComposer) return true;
    }

    const icon = root.flowFindIcon ? root.flowFindIcon(el) : el.querySelector?.("mat-icon, .mat-icon, .google-symbols, i, svg");
    if (icon) {
      const iconText = (icon.textContent || "").trim();
      const allowedIcons = config?.icons || ["arrow_forward", "send", "sparkle", "auto_awesome", "play_arrow"];
      if (allowedIcons.some(act => act.toLowerCase() === iconText.toLowerCase())) return true;
    }
    if (el.getAttribute?.("type") === "submit") return true;
    if (el.getAttribute?.("data-action") === "submit" || el.getAttribute?.("data-action") === "generate") return true;
    return false;
  }

  function getFlowSubmitButton(expectedPrompt) {
    // 1. ƯU TIÊN TUYỆT ĐỐI: Tìm nút Submit TRONG Composer Container trước!
    // Tránh click nhầm vào các nút ở Header, Sidebar, Navigation khi giao diện là tiếng Việt.
    const composer = (typeof root.flowQuery === "function" ? root.flowQuery("composerRoot") : null) ||
      document.querySelector(".ProseMirror")?.closest(".flow-composer, flow-base-prompt-box, form, [class*='composer']") ||
      document.querySelector(".flow-composer, flow-base-prompt-box, [class*='composer']");
    if (composer) {
      const composerButtons = [...composer.querySelectorAll('button,[role="button"]')].filter(el =>
        root.visible?.(el) && !root.isFlowProjectNavigationControl?.(el));

      // 1.1 Tìm nút có icon đặc thù của Submit trong Google Flow
      const submitConfig = root.FlowSelectors?.submitButton;
      const allowedIcons = submitConfig?.icons || ["arrow_forward", "send", "sparkle", "auto_awesome", "play_arrow"];
      const submitIconBtn = composerButtons.find(b => {
        if (b.disabled || b.getAttribute("aria-disabled") === "true") return false;
        const icon = root.flowFindIcon ? root.flowFindIcon(b) : b.querySelector?.("mat-icon, .mat-icon, .google-symbols, i, svg");
        const iconTxt = (icon?.textContent || "").trim().toLowerCase();
        return allowedIcons.includes(iconTxt);
      });
      if (submitIconBtn) return submitIconBtn;

      // 1.2 Tìm nút match pattern submit trong composer
      const submitMatchedBtn = composerButtons.find(b => {
        if (b.disabled || b.getAttribute("aria-disabled") === "true") return false;
        return isSubmitButtonElement(b);
      });
      if (submitMatchedBtn) return submitMatchedBtn;

      // 1.3 Nút type="submit" hoặc data-action="submit"
      const typeSubmitBtn = composerButtons.find(b => {
        if (b.disabled || b.getAttribute("aria-disabled") === "true") return false;
        return b.getAttribute?.("type") === "submit" || b.getAttribute?.("data-action") === "submit";
      });
      if (typeSubmitBtn) return typeSubmitBtn;

      // 1.4 Fallback trong composer: Nút cuối cùng không phải settings hay clear hay add
      const excludedIcons = submitConfig?.excludedComposerIcons || ["tune", "settings", "close", "clear", "add", "add_circle"];
      const excludedAria = submitConfig?.excludedComposerAria || /setting|cài đặt|clear|xóa|thành phần|ingredient|add media/i;
      const enabledComposerButtons = composerButtons.filter(b => {
        if (b.disabled || b.getAttribute("aria-disabled") === "true") return false;
        const aria = (root.accessibleName?.(b) || "").toLowerCase();
        const icon = (root.flowFindIcon ? root.flowFindIcon(b) : b.querySelector?.("mat-icon, .mat-icon, .google-symbols"))?.textContent?.trim()?.toLowerCase() || "";
        if (excludedIcons.includes(icon) || excludedAria.test(aria)) return false;
        return true;
      });
      if (enabledComposerButtons.length > 0) {
        return enabledComposerButtons[enabledComposerButtons.length - 1];
      }
    }

    // 2. Fallback tìm trên toàn trang (chỉ khi không có composer DOM thông thường)
    // Loại trừ triệt để header, navigation, sidebar và các nút tạo dự án / nhân vật
    const allButtons = [...document.querySelectorAll('button,[role="button"]')].filter(el => {
      if (!root.visible?.(el) || el.disabled || el.getAttribute("aria-disabled") === "true") return false;
      if (root.isFlowProjectNavigationControl?.(el)) return false;
      if (el.closest?.('nav, [role="navigation"], mat-sidenav, header, mat-toolbar, [role="banner"]')) return false;
      return isSubmitButtonElement(el);
    });

    return allButtons[0] || null;
  }

  function inspectFlowSubmitTarget(button, expectedPrompt) {
    if (!button || !button.isConnected || !root.visible?.(button)) {
      throw root.flowError("FLOW_SUBMIT_BUTTON_MISSING", "Flow's Start generation button disappeared before activation.", true);
    }
    if (button.disabled || button.getAttribute("aria-disabled") === "true") {
      throw root.flowError("FLOW_SUBMIT_DISABLED", "Flow's Start generation button is disabled; nothing was submitted.", true);
    }
    const wanted = normalizeFlowPrompt(expectedPrompt);
    const editors = (typeof root.flowQueryAll === "function" ? root.flowQueryAll("editor") : null) ||
      [...document.querySelectorAll(".ProseMirror[contenteditable='true']")].filter(el => root.visible?.(el));
    const promptBox = editors.find(editor => {
      const actual = normalizeFlowPrompt(editor.innerText || editor.textContent);
      return wanted ? (actual.includes(wanted) || actual.endsWith(wanted)) : Boolean(actual);
    }) || editors[0];
    if (!promptBox) {
      throw root.flowError("FLOW_SUBMIT_PROMPT_NOT_READY", "The visible Flow composer does not contain the prompt prepared for this request. Nothing was submitted.", true, false);
    }
    const rect = button.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    if (!Number.isFinite(x) || !Number.isFinite(y) || rect.width < 4 || rect.height < 4 ||
        x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) {
      throw root.flowError("FLOW_SUBMIT_TARGET_OUT_OF_VIEW", "Flow's submit button is not fully available in the visible viewport. Nothing was submitted.", true, false);
    }
    return { x, y, prompt: normalizeFlowPrompt(promptBox.innerText || promptBox.textContent) };
  }

  function pressFlowEditorSubmit(editor) {
    if (!editor || !(editor instanceof HTMLElement) || !editor.isConnected) return false;
    try {
      editor.focus({ preventScroll: true });
      const selection = window.getSelection?.();
      const range = document.createRange?.();
      range?.selectNodeContents(editor);
      range?.collapse(false);
      selection?.removeAllRanges?.();
      if (range) selection?.addRange?.(range);
      const options = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true };
      editor.dispatchEvent(new KeyboardEvent("keydown", options));
      editor.dispatchEvent(new KeyboardEvent("keypress", options));
      editor.dispatchEvent(new KeyboardEvent("keyup", options));
      return true;
    } catch (err) {
      console.warn("[FlowEditor] editor Enter press failed:", err);
      return false;
    }
  }

  async function activateFlowSubmitButton(button, expectedPrompt) {
    inspectFlowSubmitTarget(button, expectedPrompt);
    const editor = (typeof root.flowQuery === "function" ? root.flowQuery("editor") : null) || document.querySelector(".ProseMirror");
    if (!editor || normalizeFlowPrompt(getEditorUserText(editor)) !== normalizeFlowPrompt(expectedPrompt)) {
      throw root.flowError("FLOW_PRESUBMIT_STALE", "The Flow prompt changed before submit activation; nothing was submitted.", true, false);
    }
    const submitToken = crypto.randomUUID();
    button.setAttribute("data-tobyflow-submit-token", submitToken);
    let bridgeResult = null;
    let bridgeTimedOut = false;
    try {
      bridgeResult = await new Promise(resolve => {
        let settled = false;
        const finish = value => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          window.removeEventListener("message", handler);
          resolve(value);
        };
        const handler = ev => {
          if (ev.source !== window || ev.origin !== location.origin) return;
          if (ev.data?.source !== "flow-auto-slate-result" || ev.data?.requestId !== submitToken) return;
          finish(ev.data);
        };
        const timer = setTimeout(() => {
          bridgeTimedOut = true;
          finish(null);
        }, 500);
        window.addEventListener("message", handler);
        window.postMessage({
          source: "flow-auto-slate",
          action: "activateV2Submit",
          submitToken,
          requestId: submitToken,
        }, location.origin);
      });
    } catch (error) {
      if (error?.code) throw error;
      throw root.flowError("FLOW_SUBMIT_ACTIVATION_FAILED", `Flow's submit bridge failed (${String(error?.message || error)}). No retry was sent.`, true, true);
    } finally {
      button.removeAttribute("data-tobyflow-submit-token");
    }

    const invoked = Math.max(0, Number(bridgeResult?.invoked) || 0);
    if (invoked > 0) {
      return {
        clickDelivered: true,
        mainListenerInvoked: true,
        allowEnterFallback: false,
        bridgeResult,
        strategy: "main-world-listener",
      };
    }

    return {
      clickDelivered: false,
      mainListenerInvoked: false,
      allowEnterFallback: !bridgeTimedOut && Boolean(bridgeResult),
      bridgeResult,
      strategy: bridgeTimedOut ? "main-world-timeout" : "enter-fallback",
    };
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
          if (!button.disabled && button.getAttribute("aria-disabled") !== "true") {
            return button;
          }
        }
      }
      await root.wait?.(150);
    }
    return null;
  }

  function currentFlowSubmitErrors() {
    const errorWords = /(?:error|failed|could not|couldn't|unable|insufficient|not enough|quota|credit limit|daily limit|try again|unusual activity|suspicious activity|safety guidelines|policy violation|blocked|something went wrong|lỗi|không thể|thất bại|không đủ|hết hạn mức|hạn mức|hạn ngạch|thử lại|hoạt động bất thường|nguyên tắc an toàn|chính sách|đã bị chặn|đã xảy ra lỗi|đã xảy ra sự cố|sự cố|vui lòng thử lại|không an toàn|từ chối)/i;
    const selectors = [
      '[role="alert"]',
      '[role="status"]',
      '[aria-live="assertive"]',
      '[aria-live="polite"]',
      'mat-error',
      '.mat-mdc-form-field-error',
      'mat-snack-bar-container',
      '.mat-mdc-snack-bar-container',
      '.mat-mdc-snack-bar-label',
      'simple-snack-bar',
      'flow-banner',
      'flow-toast',
      'flow-credit-limit-alert',
      '[class*="snackbar"]',
      '[class*="toast"]',
      '[class*="banner"]',
      '.cdk-overlay-pane [class*="error"]',
      '.cdk-overlay-pane [class*="alert"]',
      '.cdk-overlay-pane mat-snack-bar-container',
      '.cdk-overlay-pane'
    ];
    return [...document.querySelectorAll(selectors.join(","))]
      .filter(el => root.visible?.(el))
      .map(el => (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim())
      .filter(text => text && text.length < 500 && errorWords.test(text));
  }

  const FLOW_CREDIT_QUOTE_REGEX = /(?:\b(?:generating\s+)?will\s+use\s+([\d,]+(?:\.\d+)?)\s+credits?\b|(?:quá trình tạo\s+)?(?:sẽ\s+dùng|sẽ\s+sử\s+dụng|tiêu\s+tốn)\s+([\d,]+(?:\.\d+)?)\s+(?:tín\s+dụng|điểm\s+tín\s+dụng|credits?))/i;
  const FLOW_CREDIT_BARE_REGEX = /^([\d,]+(?:\.\d+)?)\s+(?:credits?|tín\s+dụng|điểm\s+tín\s+dụng)$/i;

  function readGenerationCreditQuote() {
    const pageText = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
    const pageUsage = pageText.match(FLOW_CREDIT_QUOTE_REGEX);
    if (pageUsage) return Number((pageUsage[1] || pageUsage[2]).replace(/,/g, ""));
    const candidates = [...document.querySelectorAll("a,button,[role],p,span")]
      .filter(el => root.visible?.(el))
      .map(el => (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim())
      .filter(Boolean);
    const usage = candidates.map(text => ({ text, match: text.match(FLOW_CREDIT_QUOTE_REGEX) }))
      .filter(item => item.match)
      .sort((a, b) => a.text.length - b.text.length)[0];
    if (usage) return Number((usage.match[1] || usage.match[2]).replace(/,/g, ""));
    const bare = candidates.map(text => ({ text, match: text.match(FLOW_CREDIT_BARE_REGEX) }))
      .filter(item => item.match)
      .sort((a, b) => a.text.length - b.text.length)[0];
    return bare ? Number(bare.match[1].replace(/,/g, "")) : undefined;
  }

  async function waitForGenerationCreditQuote(timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const quote = readGenerationCreditQuote();
      if (Number.isFinite(quote)) return quote;
      await root.wait?.(200);
    }
    return readGenerationCreditQuote();
  }

  const FlowEditor = Object.freeze({
    normalizeFlowPrompt,
    getEditorUserText,
    countInlineChips,
    clearEditorTextPreservingChips,
    insertNativeFlowPrompt,
    preflightGenerationPrompt,
    isSubmitButtonElement,
    getFlowSubmitButton,
    waitForGenerationSubmitButton,
    inspectFlowSubmitTarget,
    pressFlowEditorSubmit,
    activateFlowSubmitButton,
    currentFlowSubmitErrors,
    readGenerationCreditQuote,
    waitForGenerationCreditQuote,
  });

  root.FlowEditor = FlowEditor;
  root.getEditorUserText = getEditorUserText;
  root.countInlineChips = countInlineChips;
  root.clearEditorTextPreservingChips = clearEditorTextPreservingChips;
  root.insertNativeFlowPrompt = insertNativeFlowPrompt;
  root.preflightGenerationPrompt = preflightGenerationPrompt;
  root.getFlowSubmitButton = getFlowSubmitButton;
  root.waitForGenerationSubmitButton = waitForGenerationSubmitButton;
  root.activateFlowSubmitButton = activateFlowSubmitButton;
  root.inspectFlowSubmitTarget = inspectFlowSubmitTarget;
  root.pressFlowEditorSubmit = pressFlowEditorSubmit;
  root.currentFlowSubmitErrors = currentFlowSubmitErrors;
  root.waitForGenerationCreditQuote = waitForGenerationCreditQuote;
  root.normalizeFlowPrompt = normalizeFlowPrompt;
})(globalThis);
