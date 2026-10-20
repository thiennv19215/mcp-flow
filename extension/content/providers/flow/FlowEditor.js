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
      const allowedIcons = config?.icons || ["arrow_forward", "arrow_upward", "send", "sparkle", "auto_awesome", "play_arrow", "north", "east"];
      if (allowedIcons.some(act => act.toLowerCase() === iconText.toLowerCase())) return true;
    }
    if (el.getAttribute?.("type") === "submit") return true;
    if (el.getAttribute?.("data-action") === "submit" || el.getAttribute?.("data-action") === "generate") return true;
    return false;
  }

  function getFlowComposerContainer() {
    const editor = (typeof root.flowQuery === "function" ? root.flowQuery("editor") : null) ||
      document.querySelector(".ProseMirror[contenteditable='true']") ||
      document.querySelector(".ProseMirror");
    if (editor) {
      const explicit = editor.closest(".flow-composer, flow-base-prompt-box, form, [class*='composer'], [class*='prompt-box'], [class*='prompt-container']");
      if (explicit) return explicit;
      let parent = editor.parentElement;
      for (let i = 0; i < 6 && parent && parent !== document.body; i++) {
        if (parent.querySelector('button, [role="button"]')) return parent;
        parent = parent.parentElement;
      }
    }
    return (typeof root.flowQuery === "function" ? root.flowQuery("composerRoot") : null) ||
      document.querySelector(".flow-composer, flow-base-prompt-box, [class*='composer']");
  }

  function getFlowSubmitButton(expectedPrompt) {
    // 1. ƯU TIÊN TUYỆT ĐỐI: Tìm nút Submit TRONG Composer Container trước!
    // Tránh click nhầm vào các nút ở Header, Sidebar, Navigation khi giao diện là tiếng Việt.
    const composer = getFlowComposerContainer();
    if (composer) {
      const composerButtons = [...composer.querySelectorAll('button,[role="button"]')].filter(el =>
        root.visible?.(el) && !root.isFlowProjectNavigationControl?.(el));

      // 1.1 Tìm nút có icon đặc thù của Submit trong Google Flow (KHÔNG loại trừ disabled để nhận diện đúng nút)
      const submitConfig = root.FlowSelectors?.submitButton;
      const allowedIcons = submitConfig?.icons || ["arrow_forward", "arrow_upward", "send", "sparkle", "auto_awesome", "play_arrow", "north", "east"];
      const submitIconBtn = composerButtons.find(b => {
        const icon = root.flowFindIcon ? root.flowFindIcon(b) : b.querySelector?.("mat-icon, .mat-icon, .google-symbols, i, svg");
        const iconTxt = (icon?.textContent || "").trim().toLowerCase();
        return allowedIcons.includes(iconTxt);
      });
      if (submitIconBtn) return submitIconBtn;

      // 1.2 Tìm nút match pattern submit trong composer
      const submitMatchedBtn = composerButtons.find(b => isSubmitButtonElement(b));
      if (submitMatchedBtn) return submitMatchedBtn;

      // 1.3 Nút type="submit" hoặc data-action="submit"
      const typeSubmitBtn = composerButtons.find(b => b.getAttribute?.("type") === "submit" || b.getAttribute?.("data-action") === "submit");
      if (typeSubmitBtn) return typeSubmitBtn;

      // 1.4 Nút có text submit
      const submitTextBtn = composerButtons.find(b => {
        const txt = (b.innerText || b.textContent || "").trim();
        return /^(?:start generation|generate|bắt đầu tạo|tạo video|tạo ảnh|tạo hình ảnh|tạo|create)$/i.test(txt);
      });
      if (submitTextBtn) return submitTextBtn;

      // 1.5 Fallback trong composer: Nút cuối cùng không phải settings hay clear hay add
      const excludedIcons = submitConfig?.excludedComposerIcons || ["tune", "settings", "close", "clear", "add", "add_circle"];
      const excludedAria = submitConfig?.excludedComposerAria || /setting|cài đặt|clear|xóa|thành phần|ingredient|add media/i;
      const candidateButtons = composerButtons.filter(b => {
        const aria = (root.accessibleName?.(b) || "").toLowerCase();
        const icon = (root.flowFindIcon ? root.flowFindIcon(b) : b.querySelector?.("mat-icon, .mat-icon, .google-symbols"))?.textContent?.trim()?.toLowerCase() || "";
        if (excludedIcons.includes(icon) || excludedAria.test(aria)) return false;
        return true;
      });
      if (candidateButtons.length > 0) {
        return candidateButtons[candidateButtons.length - 1];
      }
    }

    // 2. Fallback tìm trên toàn trang (chỉ khi không có composer DOM thông thường)
    const allButtons = [...document.querySelectorAll('button,[role="button"]')].filter(el => {
      if (!root.visible?.(el)) return false;
      if (root.isFlowProjectNavigationControl?.(el)) return false;
      if (el.closest?.('nav, [role="navigation"], mat-sidenav, header, mat-toolbar, [role="banner"]')) return false;
      return isSubmitButtonElement(el);
    });

    return allButtons[0] || null;
  }

  function inspectFlowSubmitTarget(button, expectedPrompt) {
    if (!button || !button.isConnected || !root.visible?.(button)) {
      return { prompt: normalizeFlowPrompt(expectedPrompt) };
    }
    if (button.disabled || button.getAttribute("aria-disabled") === "true") {
      throw root.flowError("FLOW_SUBMIT_DISABLED", "Flow's Start generation button is disabled; nothing was submitted.", true);
    }
    try { button.scrollIntoView?.({ behavior: "instant", block: "center" }); } catch {}
    const wanted = normalizeFlowPrompt(expectedPrompt);
    const editors = (typeof root.flowQueryAll === "function" ? root.flowQueryAll("editor") : null) ||
      [...document.querySelectorAll(".ProseMirror[contenteditable='true']")].filter(el => root.visible?.(el));
    const promptBox = editors.find(editor => {
      const actual = normalizeFlowPrompt(editor.innerText || editor.textContent);
      return wanted ? (actual.includes(wanted) || actual.endsWith(wanted)) : Boolean(actual);
    }) || editors[0];
    const rect = button.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    return { x, y, prompt: promptBox ? normalizeFlowPrompt(promptBox.innerText || promptBox.textContent) : wanted };
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

      const baseOptions = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true };

      // 1. Mod+Enter (Ctrl+Enter for Windows/Linux, Cmd+Enter for Mac)
      editor.dispatchEvent(new KeyboardEvent("keydown", { ...baseOptions, ctrlKey: true }));
      editor.dispatchEvent(new KeyboardEvent("keypress", { ...baseOptions, ctrlKey: true }));
      editor.dispatchEvent(new KeyboardEvent("keyup", { ...baseOptions, ctrlKey: true }));

      editor.dispatchEvent(new KeyboardEvent("keydown", { ...baseOptions, metaKey: true }));
      editor.dispatchEvent(new KeyboardEvent("keypress", { ...baseOptions, metaKey: true }));
      editor.dispatchEvent(new KeyboardEvent("keyup", { ...baseOptions, metaKey: true }));

      // 2. Direct ProseMirror View handleKeyDown
      try {
        const pmView = editor.pmViewDesc?.view;
        if (pmView && typeof pmView.someProp === "function") {
          const ctrlEnter = new KeyboardEvent("keydown", { ...baseOptions, ctrlKey: true });
          pmView.someProp("handleKeyDown", f => f(pmView, ctrlEnter));
        }
      } catch (_) {}

      // 3. Plain Enter fallback
      editor.dispatchEvent(new KeyboardEvent("keydown", baseOptions));
      editor.dispatchEvent(new KeyboardEvent("keypress", baseOptions));
      editor.dispatchEvent(new KeyboardEvent("keyup", baseOptions));
      return true;
    } catch (err) {
      console.warn("[FlowEditor] editor Enter press failed:", err);
      return false;
    }
  }

  async function activateFlowSubmitButton(button, expectedPrompt) {
    const targetButton = button || (expectedPrompt ? getFlowSubmitButton(expectedPrompt) : null);
    if (!targetButton || !targetButton.isConnected) {
      throw root.flowError("FLOW_SUBMIT_BUTTON_MISSING", "Flow's Start generation button disappeared before activation.", true);
    }
    if (targetButton.disabled || targetButton.getAttribute("aria-disabled") === "true") {
      throw root.flowError("FLOW_SUBMIT_DISABLED", "Flow's Start generation button is disabled; nothing was submitted.", true);
    }

    try { targetButton.scrollIntoView?.({ behavior: "instant", block: "center" }); } catch {}
    const rect = targetButton.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const eventOptions = {
      bubbles: true,
      cancelable: true,
      composed: true,
      button: 0,
      clientX: x,
      clientY: y,
      pointerType: "mouse",
      view: window,
    };

    let clickDelivered = false;
    let controlAccepted = false;
    const markDelivered = () => { clickDelivered = true; };
    targetButton.addEventListener("click", markDelivered, { capture: true, once: true });

    const observeRoot = targetButton.parentElement || targetButton;
    const acceptanceObserver = new MutationObserver(() => {
      if (targetButton.disabled || targetButton.getAttribute("aria-disabled") === "true") {
        controlAccepted = true;
      }
    });
    try {
      acceptanceObserver.observe(observeRoot, {
        attributes: true,
        childList: true,
        subtree: true,
        attributeFilter: ["disabled", "aria-disabled", "class"],
      });
    } catch (_) {}

    let mainActivation = null;
    try {
      // 1. Gesture sequence with exact 120ms hold delay (TobyFlow pattern)
      targetButton.dispatchEvent(new PointerEvent("pointerdown", eventOptions));
      targetButton.dispatchEvent(new MouseEvent("mousedown", eventOptions));
      try { targetButton.focus({ preventScroll: true }); } catch {}

      await Promise.all([
        new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        new Promise(resolve => setTimeout(resolve, 120))
      ]);

      if (!targetButton.isConnected || targetButton.disabled || targetButton.getAttribute("aria-disabled") === "true") {
        controlAccepted = true;
      }

      targetButton.dispatchEvent(new PointerEvent("pointerup", eventOptions));
      targetButton.dispatchEvent(new MouseEvent("mouseup", eventOptions));

      // 2. Invoke Main-world Angular Listener via Proxy (isTrusted: true)
      const submitToken = crypto.randomUUID();
      targetButton.setAttribute("data-tobyflow-submit-token", submitToken);
      try {
        mainActivation = await new Promise(resolve => {
          let resolved = false;
          const handler = ev => {
            if (ev.source !== window || ev.origin !== location.origin) return;
            if (ev.data?.source === "flow-auto-slate-result" && ev.data?.requestId === submitToken) {
              resolved = true;
              clearTimeout(timer);
              window.removeEventListener("message", handler);
              resolve(ev.data);
            }
          };
          const timer = setTimeout(() => {
            if (!resolved) {
              window.removeEventListener("message", handler);
              resolve({ success: false, error: "Bridge timeout" });
            }
          }, 3000);
          window.addEventListener("message", handler);
          window.postMessage({
            source: "flow-auto-slate",
            action: "activateV2Submit",
            submitToken,
            requestId: submitToken,
          }, location.origin);
        });
      } finally {
        targetButton.removeAttribute("data-tobyflow-submit-token");
      }

      const mainListenerInvoked = mainActivation?.success === true && Number(mainActivation?.invoked) > 0;
      if (!mainListenerInvoked) {
        // Fallback: direct click and inner icon click
        targetButton.click();
        const inner = targetButton.querySelector("mat-icon, .mat-icon, .google-symbols, svg");
        if (inner) {
          try { inner.dispatchEvent(new MouseEvent("click", eventOptions)); } catch {}
        }
        const form = targetButton.form || targetButton.closest("form");
        if (form && typeof form.requestSubmit === "function") {
          try { form.requestSubmit(targetButton); } catch {}
        }
        const editor = (typeof root.flowQuery === "function" ? root.flowQuery("editor") : null) || document.querySelector(".ProseMirror");
        if (editor) {
          pressFlowEditorSubmit(editor);
        }
      }

      await new Promise(resolve => setTimeout(resolve, 180));
    } catch (err) {
      console.warn("[FlowEditor] activateFlowSubmitButton failed:", err);
    } finally {
      try { acceptanceObserver.disconnect(); } catch (_) {}
      try { targetButton.removeEventListener("click", markDelivered, { capture: true }); } catch (_) {}
    }

    const mainListenerInvoked = mainActivation?.success === true && Number(mainActivation?.invoked) > 0;
    return {
      clickDelivered: clickDelivered || mainListenerInvoked || controlAccepted,
      controlAccepted,
      mainListenerInvoked,
      strategy: mainListenerInvoked ? "angular_main_proxy" : "native_click_fallback",
    };
  }

  async function waitForGenerationSubmitButton(expectedPrompt, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const button = getFlowSubmitButton(expectedPrompt);
      if (button) {
        const isDisabled = button.disabled || button.getAttribute("aria-disabled") === "true";
        if (!isDisabled) {
          return button;
        }
      }
      await root.wait?.(200);
    }
    return getFlowSubmitButton(expectedPrompt);
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
