(() => {
  "use strict";

  const prior = window.__flowMcpSubmitBridge;
  if (prior?.version === 3) return;

  const clickListeners = new WeakMap();
  let capturedClickRegistrations = 0;
  const installedReadyState = document.readyState;
  const nativeAdd = EventTarget.prototype.addEventListener;
  const nativeRemove = EventTarget.prototype.removeEventListener;
  const captureOption = options => options === true || Boolean(options && options.capture);

  EventTarget.prototype.addEventListener = function(type, listener, options) {
    if (type === "click" && (this instanceof Element || this === document || this === window) && listener) {
      const entries = clickListeners.get(this) || [];
      const capture = captureOption(options);
      if (!entries.some(entry => entry.listener === listener && entry.capture === capture)) {
        entries.push({ listener, capture });
        clickListeners.set(this, entries);
        capturedClickRegistrations++;
      }
    }
    return Reflect.apply(nativeAdd, this, arguments);
  };

  EventTarget.prototype.removeEventListener = function(type, listener, options) {
    if (type === "click" && (this instanceof Element || this === document || this === window)) {
      const entries = clickListeners.get(this) || [];
      const capture = captureOption(options);
      clickListeners.set(this, entries.filter(entry => entry.listener !== listener || entry.capture !== capture));
    }
    return Reflect.apply(nativeRemove, this, arguments);
  };

  function listenersFor(button) {
    const found = [];
    try {
      if (typeof window.ng?.getListeners === "function") {
        for (const entry of window.ng.getListeners(button) || []) {
          if ((entry.name || entry.eventName) === "click" && typeof entry.callback === "function") {
            found.push({ callback: entry.callback, owner: button, tier: "angular-debug-api" });
          }
        }
      }
    } catch { /* Angular's debug API is unavailable in production builds. */ }

    if (!found.length) {
      for (let owner = button, depth = 0; owner && depth < 10; owner = owner.parentElement, depth++) {
        for (const entry of clickListeners.get(owner) || []) {
          const callback = typeof entry.listener === "function"
            ? entry.listener
            : typeof entry.listener?.handleEvent === "function"
              ? entry.listener.handleEvent.bind(entry.listener)
              : null;
          if (callback) found.push({ callback, owner, tier: "registered-listener" });
        }
      }
      if (!found.length) {
        for (const owner of [document, window]) {
          for (const entry of clickListeners.get(owner) || []) {
            const callback = typeof entry.listener === "function"
              ? entry.listener
              : typeof entry.listener?.handleEvent === "function"
                ? entry.listener.handleEvent.bind(entry.listener)
                : null;
            if (callback) found.push({ callback, owner, tier: "delegated-listener" });
          }
        }
      }
    }

    const seen = new Set();
    return found.filter(entry => {
      if (seen.has(entry.callback)) return false;
      seen.add(entry.callback);
      return true;
    });
  }

  async function activate(button) {
    const rect = button.getBoundingClientRect();
    if (!rect.width || !rect.height || button.disabled || button.getAttribute("aria-disabled") === "true") {
      return { success: false, invoked: 0, error: "Submit button is hidden or disabled." };
    }

    const eventOptions = {
      bubbles: true,
      cancelable: true,
      composed: true,
      button: 0,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      pointerType: "mouse",
      view: window,
    };
    let controlAccepted = false;
    const observeRoot = button.parentElement || button;
    const acceptanceObserver = new MutationObserver(() => {
      const live = button.isConnected ? button : document.querySelector("button[data-flow-mcp-submit-token]");
      if (!live || live.disabled || live.getAttribute("aria-disabled") === "true") controlAccepted = true;
    });
    acceptanceObserver.observe(observeRoot, { attributes: true, childList: true, subtree: true, attributeFilter: ["disabled", "aria-disabled", "class"] });
    button.dispatchEvent(new PointerEvent("pointerdown", { ...eventOptions, buttons: 1 }));
    button.dispatchEvent(new MouseEvent("mousedown", { ...eventOptions, buttons: 1 }));
    button.focus({ preventScroll: true });
    await Promise.all([
      new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      new Promise(resolve => setTimeout(resolve, 120)),
    ]);
    if (!button.isConnected || button.disabled || button.getAttribute("aria-disabled") === "true") {
      acceptanceObserver.disconnect();
      return { success: false, invoked: 0, error: "Submit button changed state before activation.", controlAccepted };
    }
    button.dispatchEvent(new PointerEvent("pointerup", { ...eventOptions, buttons: 0 }));
    button.dispatchEvent(new MouseEvent("mouseup", { ...eventOptions, buttons: 0 }));

    const listeners = listenersFor(button);
    let invoked = 0;
    let errors = 0;
    const path = [];
    for (let node = button; node && path.length < 12; node = node.parentElement) path.push(node);
    path.push(document, window);
    for (const entry of listeners) {
      const owner = entry.owner;
      const nativeEvent = new MouseEvent("click", { bubbles: true, cancelable: true, composed: true, view: window, button: 0 });
      const event = new Proxy(nativeEvent, {
        get(source, key) {
          if (key === "isTrusted") return true;
          if (key === "target") return button;
          if (key === "currentTarget") return owner;
          if (key === "composedPath") return () => path;
          const value = Reflect.get(source, key, source);
          return typeof value === "function" ? value.bind(source) : value;
        },
      });
      invoked++;
      try {
        const result = entry.callback.call(owner, event);
        if (result && typeof result.then === "function") result.catch(error => console.warn("[Flow MCP submit] Flow click listener failed:", error?.message || error));
      } catch (error) {
        errors++;
        console.warn("[Flow MCP submit] Flow click listener failed:", error?.message || error);
      }
    }

    const strategy = listeners.length ? "flow-main-world-listener" : "dom-click-fallback";
    let clickDelivered = false;
    if (!listeners.length) {
      const markDelivered = () => { clickDelivered = true; };
      button.addEventListener("click", markDelivered, { capture: true, once: true });
      button.click();
      button.removeEventListener("click", markDelivered, { capture: true });
    }
    await new Promise(resolve => setTimeout(resolve, 180));
    acceptanceObserver.disconnect();
    if (!button.isConnected || button.disabled || button.getAttribute("aria-disabled") === "true") controlAccepted = true;
    return {
      success: invoked > 0 || controlAccepted,
      invoked,
      errors,
      strategy,
      controlAccepted,
      clickDelivered,
      bridgeReadyState: installedReadyState,
      capturedClickRegistrations,
      angularDebugApi: typeof window.ng?.getListeners === "function",
    };
  }

  const pending = new WeakSet();
  const observer = new MutationObserver(records => {
    const buttons = new Set();
    for (const record of records) {
      const button = record.target instanceof HTMLButtonElement
        ? record.target
        : record.target.querySelector?.("button[data-flow-mcp-submit-request]");
      if (button?.hasAttribute("data-flow-mcp-submit-request")) buttons.add(button);
    }
    for (const button of buttons) {
      const token = button.getAttribute("data-flow-mcp-submit-request");
      if (!/^[0-9a-f-]{36}$/i.test(token || "") || pending.has(button)) continue;
      pending.add(button);
      button.removeAttribute("data-flow-mcp-submit-request");
      void activate(button).then(result => {
        button.setAttribute("data-flow-mcp-submit-result", JSON.stringify({ token, ...result }));
      }).catch(error => {
        button.setAttribute("data-flow-mcp-submit-result", JSON.stringify({
          token, success: false, invoked: 0, error: String(error?.message || error),
        }));
      }).finally(() => pending.delete(button));
    }
  });
  observer.observe(document, { attributes: true, attributeFilter: ["data-flow-mcp-submit-request"], subtree: true });
  window.__flowMcpSubmitBridge = {
    version: 3,
    observer,
    installedReadyState,
    capturedClickRegistrations: () => capturedClickRegistrations,
    angularDebugApi: () => typeof window.ng?.getListeners === "function",
  };
})();
