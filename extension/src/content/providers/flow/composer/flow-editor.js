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

  function visibleFlowPromptEditors(scope = document) {
    const configured = typeof root.flowQueryAll === "function"
      ? root.flowQueryAll("editor", scope, { checkVisible: false }) : [];
    const candidates = [...new Set([...(configured || []), ...scope.querySelectorAll?.(".ProseMirror,[contenteditable='true']") || []])];
    return candidates.filter(editor => editor?.isContentEditable && editor.isConnected !== false && root.visible?.(editor));
  }

  function getVisibleFlowPromptEditor(scope = document) {
    const candidates = visibleFlowPromptEditors(scope);
    const focused = document.activeElement;
    if (candidates.includes(focused)) return focused;
    return candidates.length === 1 ? candidates[0] : null;
  }

  function currentFlowPromptEditor(preferred, scope = document) {
    if (preferred?.isContentEditable && preferred.isConnected !== false && root.visible?.(preferred) && (scope === document || scope === preferred || scope.contains?.(preferred))) return preferred;
    return getVisibleFlowPromptEditor(scope);
  }

  async function clearEditorTextPreservingChipsOnce(editor) {
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

  async function clearEditorTextPreservingChips(editor) {
    if (!editor?.isContentEditable) return false;
    const initialText = getEditorUserText(editor);
    const initialChipCount = countInlineChips(editor);
    if (!initialText) return true;

    const cleared = await clearEditorTextPreservingChipsOnce(editor);
    let current = currentFlowPromptEditor(editor);
    if (current === editor && editor.isConnected !== false) {
      return cleared && !getEditorUserText(editor) && countInlineChips(editor) === initialChipCount;
    }
    if (!current) return false;

    const replacementText = getEditorUserText(current);
    if (!replacementText) return countInlineChips(current) === initialChipCount;
    // Flow can replace the composer while clearing. Retry only while the new
    // editor still contains the same prompt; preserve any changed user text.
    if (replacementText !== initialText || countInlineChips(current) !== initialChipCount) return false;
    const retried = await clearEditorTextPreservingChipsOnce(current);
    current = currentFlowPromptEditor(current);
    return retried && current && !getEditorUserText(current) && countInlineChips(current) === initialChipCount;
  }

  async function insertNativeFlowPrompt(el, value) {
    const text = String(value || "");
    const expected = normalizeFlowPrompt(text);
    let editor = currentFlowPromptEditor(el);
    if (!editor) return false;

    const insertOnce = async target => {
      if (!target?.isContentEditable || target.isConnected === false || !root.visible?.(target)) return false;
      if (normalizeFlowPrompt(getEditorUserText(target)) === expected) return true;
      // Xóa sạch prompt cũ nhưng bảo toàn các chip reference. Never append a
      // replacement prompt when Flow failed to clear the previous text.
      if (!await clearEditorTextPreservingChips(target)) return false;
      if (target.isConnected === false || !root.visible?.(target)) return false;

      target.focus();
      const selection = window.getSelection?.();
      const range = document.createRange?.();
      range?.selectNodeContents(target);
      range?.collapse(false);
      selection?.removeAllRanges?.();
      if (range) selection?.addRange?.(range);

      let inserted = false;
      if (expected && typeof DataTransfer === "function" && typeof ClipboardEvent === "function") {
        try {
          const clipboard = new DataTransfer();
          clipboard.setData("text/plain", text);
          const paste = new ClipboardEvent("paste", { clipboardData: clipboard, bubbles: true, cancelable: true });
          target.dispatchEvent(paste);
          inserted = paste.defaultPrevented || normalizeFlowPrompt(getEditorUserText(target)) === expected;
        } catch {}
      }
      if (expected && !inserted) {
        try { document.execCommand?.("insertText", false, text); } catch {}
      }
      await root.wait?.(150);
      return normalizeFlowPrompt(getEditorUserText(target)) === expected;
    };

    if (await insertOnce(editor)) return true;

    // Flow can replace the contenteditable during a render. Reacquire once and
    // retry only if the replacement is uniquely visible and still empty; this
    // prevents duplicate or destructive insertion into a changed composer.
    const replacement = currentFlowPromptEditor(editor);
    if (!replacement || replacement === editor) return false;
    const replacementText = normalizeFlowPrompt(getEditorUserText(replacement));
    if (replacementText === expected) return true;
    if (replacementText !== "") return false;
    editor = replacement;
    return insertOnce(editor);
  }

  async function preflightGenerationPrompt(payload, framesMode) {
    if (root.FlowSettings?.flowSettingsPanelVisible?.()) {
      await root.FlowSettings.closeFlowSettings();
    }
    await (root.FlowNavigation?.dismissBlockingOverlays?.() || root.dismissBlockingOverlays?.());
    const deadline = Date.now() + 5000;
    let promptBox = null;
    while (Date.now() < deadline) {
      promptBox = getVisibleFlowPromptEditor();
      if (promptBox) return promptBox;
      await root.wait?.(100);
    }
    throw root.flowError("FLOW_PROMPT_COMPOSER_NOT_READY", "Flow's prompt editor is not visible after closing settings. Nothing was submitted.", true, false);
  }

  const SUBMIT_ICONS = ["arrow_forward", "arrow_upward", "send", "sparkle", "auto_awesome", "play_arrow", "north", "east"];
  const SUBMIT_TEXTS = ["start generation", "bắt đầu tạo", "generate", "tạo video", "tạo ảnh", "tạo hình ảnh", "tạo prompt"];

  function getElementIconName(el) {
    if (!el || typeof el.querySelector !== "function") return "";
    const iconEl = el.matches?.("mat-icon, .mat-icon, .google-symbols, i, svg")
      ? el
      : (root.flowFindIcon ? root.flowFindIcon(el) : el.querySelector?.("mat-icon, .mat-icon, .google-symbols, i, svg"));
    if (!iconEl) return "";
    const fontIcon = iconEl.getAttribute?.("fonticon") || iconEl.getAttribute?.("data-mat-icon-name") || "";
    if (fontIcon.trim()) return fontIcon.trim().toLowerCase();
    const ariaLabel = iconEl.getAttribute?.("aria-label") || "";
    if (ariaLabel.trim()) return ariaLabel.trim().toLowerCase();
    const text = (iconEl.textContent || "").trim().toLowerCase();
    if (text) return text;
    const svgUse = iconEl.querySelector?.("use")?.getAttribute?.("href") || iconEl.querySelector?.("use")?.getAttribute?.("xlink:href") || "";
    if (svgUse) {
      const match = svgUse.match(/#([a-zA-Z0-9_-]+)$/);
      if (match) return match[1].toLowerCase();
    }
    return "";
  }

  function isExcludedSubmitButton(el) {
    if (!el || typeof el.getAttribute !== "function") return true;
    const inComposer = Boolean(el.closest?.('flow-base-prompt-box, .flow-composer, form, [class*="composer"], [class*="prompt-box"], [class*="prompt-container"], [data-testid*="composer"]'));
    if (!inComposer && root.isFlowProjectNavigationControl?.(el)) return true;
    if (!inComposer && el.closest?.('nav, [role="navigation"], mat-sidenav, mat-drawer, .mat-sidenav, .mat-drawer, header, mat-toolbar, [role="banner"], flow-navigation, [class*="sidebar"], flow-library, [class*="media-gallery"], [class*="media-list"]')) return true;

    const name = (root.accessibleName?.(el) || "").toLowerCase();
    const text = (el.innerText || el.textContent || "").toLowerCase();
    const icon = getElementIconName(el);

    const excludedIcons = ["tune", "settings", "close", "clear", "delete", "add", "add_circle", "help", "info", "more_vert", "more_horiz", "aspect_ratio", "crop", "download", "share", "fullscreen", "undo", "redo", "history"];
    if (excludedIcons.includes(icon)) return true;

    const excludedPatterns = /(?:project|dự án|character|nhân vật|folder|thư mục|settings|cài đặt|tune|clear prompt|xóa câu lệnh|xóa văn bản|quay lại|back|upload|tải lên|aspect ratio|tỷ lệ|resolution|độ phân giải|duration|thời lượng|download|tải xuống|share|chia sẻ|ingredient|thành phần)/i;
    if (excludedPatterns.test(name) || excludedPatterns.test(text)) return true;

    return false;
  }

  function isSubmitButtonElement(el) {
    if (!el || !root.visible?.(el) || isExcludedSubmitButton(el)) return false;

    // 1. Icon match (includes Angular Material fonticon / data-mat-icon-name)
    const icon = getElementIconName(el);
    if (SUBMIT_ICONS.includes(icon)) return true;

    // 2. Specific submit text (substring match, not exact anchor)
    const name = (root.accessibleName?.(el) || "").toLowerCase();
    const text = (el.innerText || el.textContent || "").toLowerCase();
    if (SUBMIT_TEXTS.some(t => name.includes(t) || text.includes(t))) return true;

    // 3. Submit type or data-action
    if (el.getAttribute?.("type") === "submit") return true;
    if (el.getAttribute?.("data-action") === "submit" || el.getAttribute?.("data-action") === "generate") return true;

    // 4. Short "tạo" or "create" near composer or with credits
    if (name.includes("tạo") || text.includes("tạo") || name.includes("create") || text.includes("create")) {
      const isNearComposer = Boolean(el.closest?.(".flow-composer, flow-base-prompt-box, form, [class*='composer']")) ||
        Boolean(getVisibleFlowPromptEditor());
      if (isNearComposer) return true;
    }

    return false;
  }

  function getFlowComposerContainer() {
    const editor = getVisibleFlowPromptEditor();
    if (editor) {
      const explicit = editor.closest(".flow-composer, flow-base-prompt-box, form, [class*='composer'], [class*='prompt-box'], [class*='prompt-container'], [data-testid*='composer']");
      if (explicit) return explicit;
      let parent = editor.parentElement;
      for (let i = 0; i < 6 && parent && parent !== document.body; i++) {
        if (parent.tagName.toLowerCase().includes("composer") ||
            (parent.className && typeof parent.className === "string" && /composer|prompt/i.test(parent.className))) {
          return parent;
        }
        const hasSubmitIcon = [...parent.querySelectorAll("mat-icon, .mat-icon, .google-symbols, svg")].some(ic =>
          SUBMIT_ICONS.includes(getElementIconName(ic))
        );
        if (hasSubmitIcon) return parent;
        parent = parent.parentElement;
      }
    }
    return (typeof root.flowQuery === "function" ? root.flowQuery("composerRoot") : null) ||
      document.querySelector(".flow-composer, flow-base-prompt-box, [class*='composer']");
  }

  function getFlowSubmitButton(expectedPrompt) {
    // 1. Try finding in composer container first if one is identified
    const composer = getFlowComposerContainer();
    if (composer) {
      // Keep the repository's action-name resolver scoped to the actual composer.
      // Flow currently renders its submit control inside mat-sidenav-content, so
      // broad navigation filters can mistake that wrapper for the project drawer.
      const scopedFlowButton = root.flowButton?.("Start generation", composer);
      if (scopedFlowButton && composer.contains(scopedFlowButton)) return scopedFlowButton;

      const rawComposerButtons = [...composer.querySelectorAll('button, [role="button"]')].filter(el => root.visible?.(el));
      const semanticSubmitButton = rawComposerButtons.find(button => {
        const icon = getElementIconName(button);
        const name = (root.accessibleName?.(button) || "").toLowerCase();
        const text = (button.innerText || button.textContent || "").toLowerCase();
        const explicitSubmit = button.getAttribute?.("type") === "submit" || button.getAttribute?.("data-action") === "submit" || button.getAttribute?.("data-action") === "generate";
        return explicitSubmit && (SUBMIT_ICONS.includes(icon) || SUBMIT_TEXTS.some(value => name.includes(value) || text.includes(value)));
      });
      if (semanticSubmitButton) return semanticSubmitButton;

      const composerButtons = [...composer.querySelectorAll('button, [role="button"]')].filter(el =>
        root.visible?.(el) && !isExcludedSubmitButton(el));

      // 1.1 Match by submit icon
      const submitIconBtn = composerButtons.find(b => SUBMIT_ICONS.includes(getElementIconName(b)));
      if (submitIconBtn) return submitIconBtn;

      // 1.2 Match by submit text (Vietnamese / English substring)
      const submitTextBtn = composerButtons.find(b => {
        const name = (root.accessibleName?.(b) || "").toLowerCase();
        const text = (b.innerText || b.textContent || "").toLowerCase();
        return SUBMIT_TEXTS.some(t => name.includes(t) || text.includes(t));
      });
      if (submitTextBtn) return submitTextBtn;

      // 1.3 Match type="submit" or data-action="submit"
      const typeSubmitBtn = composerButtons.find(b => b.getAttribute?.("type") === "submit" || b.getAttribute?.("data-action") === "submit" || b.getAttribute?.("data-action") === "generate");
      if (typeSubmitBtn) return typeSubmitBtn;

      // 1.4 Match short "tạo" or "create"
      const shortTextBtn = composerButtons.find(b => {
        const name = (root.accessibleName?.(b) || "").toLowerCase();
        const text = (b.innerText || b.textContent || "").toLowerCase();
        return name.includes("tạo") || text.includes("tạo") || name.includes("create") || text.includes("create");
      });
      if (shortTextBtn) return shortTextBtn;
      // Note: Never blindly fallback to candidateButtons[last] - that clicks aspect ratio or chips!
    }

    // 2. Global search across the document (TobyFlow content.js lines 2974-3000 pattern)
    const allButtons = [...document.querySelectorAll('button, [role="button"]')].filter(el =>
      root.visible?.(el) && !isExcludedSubmitButton(el));

    // 2.1 By submit icon
    const docIconBtn = allButtons.find(b => SUBMIT_ICONS.includes(getElementIconName(b)));
    if (docIconBtn) return docIconBtn;

    // 2.2 By submit text
    const docTextBtn = allButtons.find(b => {
      const name = (root.accessibleName?.(b) || "").toLowerCase();
      const text = (b.innerText || b.textContent || "").toLowerCase();
      return SUBMIT_TEXTS.some(t => name.includes(t) || text.includes(t));
    });
    if (docTextBtn) return docTextBtn;

    // 2.3 By type="submit"
    const docTypeSubmit = allButtons.find(b => b.getAttribute?.("type") === "submit" || b.getAttribute?.("data-action") === "submit" || b.getAttribute?.("data-action") === "generate");
    if (docTypeSubmit) return docTypeSubmit;

    // 2.4 By short "tạo" or "create" near ProseMirror
    const editor = getVisibleFlowPromptEditor();
    if (editor) {
      const eRect = editor.getBoundingClientRect();
      const docShortBtn = allButtons.find(b => {
        const name = (root.accessibleName?.(b) || "").toLowerCase();
        const text = (b.innerText || b.textContent || "").toLowerCase();
        if (name.includes("tạo") || text.includes("tạo") || name.includes("create") || text.includes("create")) {
          const bRect = b.getBoundingClientRect();
          return Math.abs(bRect.top - eRect.top) < 400;
        }
        return false;
      });
      if (docShortBtn) return docShortBtn;
    }

    return null;
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

      // Keep this as a single, plain Enter fallback after Flow's click path.
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
      } else if (!targetButton.isConnected) {
        const liveButton = getFlowSubmitButton(expectedPrompt);
        if (liveButton && (liveButton.disabled || liveButton.getAttribute("aria-disabled") === "true")) {
          controlAccepted = true;
        }
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
        new Promise(resolve => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(fallback);
            resolve();
          };
          const fallback = setTimeout(finish, 250);
          try { requestAnimationFrame(() => requestAnimationFrame(finish)); }
          catch { finish(); }
        }),
        new Promise(resolve => setTimeout(resolve, 120))
      ]);

      if (!targetButton.isConnected || targetButton.disabled || targetButton.getAttribute("aria-disabled") === "true") {
        throw root.flowError(
          "FLOW_SUBMIT_CLICK_NOT_DELIVERED",
          "Flow replaced or disabled the submit button before the click was released; no submit click was delivered.",
          false,
          false
        );
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
      if (mainActivation?.error === "Bridge timeout") {
        throw root.flowError("FLOW_SUBMIT_BRIDGE_TIMEOUT", "Flow's submit bridge timed out. The request outcome is unknown; inspect the project before retrying.", false, true);
      }
      if (!mainListenerInvoked) {
        // The bridge replied but found no page listener. Try one DOM click; the
        // generation observer owns the later single Enter fallback if needed.
        targetButton.click();
      }

      await new Promise(resolve => setTimeout(resolve, 180));
    } catch (err) {
      console.warn("[FlowEditor] activateFlowSubmitButton failed:", err);
      throw err;
    } finally {
      try { acceptanceObserver.disconnect(); } catch (_) {}
      try { targetButton.removeEventListener("click", markDelivered, { capture: true }); } catch (_) {}
    }

    const mainListenerInvoked = mainActivation?.success === true && Number(mainActivation?.invoked) > 0;
    return {
      clickDelivered: clickDelivered || mainListenerInvoked,
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
    const errorWords = /(?:error|failed|could not|couldn't|unable|insufficient|not enough|quota|credit limit|daily limit|try again|unusual activity|suspicious activity|safety guidelines|policy violation|blocked|something went wrong|lỗi|không thể|thất bại|không đủ|hết hạn mức|hạn mức|hạn ngạch|thử lại|hoạt động bất thường|nguyên tắc an toàn|chính sách|đã bị chặn|đã xảy ra lỗi|đã xảy ra sự cố|sự cố|vui lòng thử lại|không an toàn|từ chối|vi phạm|không thành công|bị từ chối)/i;
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
      'flow-error-tile',
      '[class*="error-tile"]',
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

  function visibleCreditQuoteCandidates() {
    const roots = [document];
    const visited = new Set(roots);
    const candidates = [];
    let scanned = 0;
    const editor = document.querySelector(".ProseMirror[contenteditable='true'], [contenteditable='true']");
    // Flow renders some composer controls inside open component shadow roots. Walk
    // those roots too, while keeping a strict cap so status/quote reads stay cheap.
    for (let rootIndex = 0; rootIndex < roots.length && roots.length < 40; rootIndex++) {
      const domRoot = roots[rootIndex];
      let elements = [];
      try { elements = [...domRoot.querySelectorAll("*")].slice(0, Math.min(2500, Math.max(0, 5000 - scanned))); } catch {}
      for (const element of elements) {
        scanned++;
        if (element.shadowRoot && !visited.has(element.shadowRoot)) {
          visited.add(element.shadowRoot);
          roots.push(element.shadowRoot);
        }
        if (candidates.length >= 500 || !root.visible?.(element)) continue;
        // Never accept prompt text or a wrapper containing the editable prompt as a price quote.
        if (editor && (element === editor || element.contains?.(editor) || editor.contains?.(element))) continue;
        if (!element.matches?.("a,button,[role],p,span,[aria-label],[title],[class*='credit'],[data-testid*='credit']")) continue;
        const text = (element.innerText || element.textContent || root.accessibleName?.(element) || "").replace(/\s+/g, " ").trim();
        if (!text || text.length > 300 || !/(?:credit|tín\s+dụng|will\s+use|sẽ\s+dùng|sẽ\s+sử\s+dụng|tiêu\s+tốn)/i.test(text)) continue;
        candidates.push(text);
      }
    }
    return [...new Set(candidates)].slice(0, 40);
  }

  function readGenerationCreditQuote() {
    const candidates = visibleCreditQuoteCandidates();
    const usage = candidates.map(text => ({ text, match: text.match(FLOW_CREDIT_QUOTE_REGEX) }))
      .filter(item => item.match)
      .sort((a, b) => a.text.length - b.text.length)[0];
    if (usage) return Number((usage.match[1] || usage.match[2]).replace(/,/g, ""));
    return undefined;
  }

  function inspectGenerationCreditQuote() {
    const candidates = visibleCreditQuoteCandidates();
    return {
      quote: readGenerationCreditQuote(),
      candidates: candidates.slice(0, 20),
    };
  }

  async function waitForGenerationCreditQuote(timeoutMs = 8000, options = {}) {
    const callerDeadline = Number.isFinite(options.deadline) ? options.deadline : Infinity;
    const quoteDeadline = Math.min(Date.now() + Math.max(0, Number(timeoutMs) || 0), callerDeadline);
    while (Date.now() < quoteDeadline) {
      root.FlowUiDeadline?.requireTime(callerDeadline, "reading Flow's credit quote", false, options.signal);
      const quote = readGenerationCreditQuote();
      if (Number.isFinite(quote)) return quote;
      const remaining = quoteDeadline - Date.now();
      if (remaining <= 0) break;
      const waitMs = Math.min(200, remaining);
      if (root.FlowUiDeadline?.boundedWait) await root.FlowUiDeadline.boundedWait(waitMs, callerDeadline, "reading Flow's credit quote", false, options.signal);
      else await root.wait?.(waitMs);
    }
    // The local quote observation window may expire without a quote. That is
    // an unknown quote, not an expired Flow operation; callers can apply their
    // fail-closed policy while the shared absolute deadline remains available.
    root.FlowUiDeadline?.requireTime(callerDeadline, "reading Flow's credit quote", false, options.signal);
    return readGenerationCreditQuote();
  }

  const FlowEditor = Object.freeze({
    normalizeFlowPrompt,
    getEditorUserText,
    countInlineChips,
    visibleFlowPromptEditors,
    clearEditorTextPreservingChips,
    insertNativeFlowPrompt,
    getVisibleFlowPromptEditor,
    preflightGenerationPrompt,
    isSubmitButtonElement,
    getFlowSubmitButton,
    waitForGenerationSubmitButton,
    inspectFlowSubmitTarget,
    pressFlowEditorSubmit,
    activateFlowSubmitButton,
    currentFlowSubmitErrors,
    readGenerationCreditQuote,
    inspectGenerationCreditQuote,
    waitForGenerationCreditQuote,
  });

  root.FlowEditor = FlowEditor;
  root.getEditorUserText = getEditorUserText;
  root.countInlineChips = countInlineChips;
  root.clearEditorTextPreservingChips = clearEditorTextPreservingChips;
  root.insertNativeFlowPrompt = insertNativeFlowPrompt;
  root.getVisibleFlowPromptEditor = getVisibleFlowPromptEditor;
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
