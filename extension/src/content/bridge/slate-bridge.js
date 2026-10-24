(function () {
  "use strict";

  var priorClickRegistry = window.__tobyFlowClickListenerRegistry;
  if (window.__flowAutoSlateBridgeCleanup) {
    try { window.__flowAutoSlateBridgeCleanup(); } catch (e) {}
  }

  var clickRegistry = priorClickRegistry instanceof WeakMap ? priorClickRegistry : new WeakMap();
  var nativeAddEventListener = EventTarget.prototype.addEventListener;
  var nativeRemoveEventListener = EventTarget.prototype.removeEventListener;

  var captureOf = function (options) {
    return options === true || !!(options && options.capture);
  };

  // Intercept all click listeners registered on buttons and interactive controls
  EventTarget.prototype.addEventListener = function (type, listener, options) {
    if (
      type === "click" &&
      listener &&
      (this instanceof HTMLButtonElement ||
        (this instanceof Element && (this.tagName === "BUTTON" || this.getAttribute?.("role") === "button" || this.type === "submit")))
    ) {
      var list = clickRegistry.get(this) || [];
      var capture = captureOf(options);
      if (
        !list.some(function (entry) {
          var storedCapture = entry.capture == null ? captureOf(entry.options) : entry.capture;
          return entry.listener === listener && storedCapture === capture;
        })
      ) {
        list.push({ listener: listener, capture: capture });
        clickRegistry.set(this, list);
      }
    }
    return Reflect.apply(nativeAddEventListener, this, arguments);
  };

  EventTarget.prototype.removeEventListener = function (type, listener, options) {
    if (type === "click" && this instanceof Element) {
      var list = clickRegistry.get(this);
      var capture = captureOf(options);
      if (list) {
        clickRegistry.set(
          this,
          list.filter(function (entry) {
            var storedCapture = entry.capture == null ? captureOf(entry.options) : entry.capture;
            return entry.listener !== listener || storedCapture !== capture;
          })
        );
      }
    }
    return Reflect.apply(nativeRemoveEventListener, this, arguments);
  };

  var patchedAddEventListener = EventTarget.prototype.addEventListener;
  var patchedRemoveEventListener = EventTarget.prototype.removeEventListener;
  window.__tobyFlowClickListenerRegistry = clickRegistry;

  function _angularClickListeners(target) {
    var found = [];
    try {
      if (window.ng && typeof window.ng.getListeners === "function") {
        for (var entry of window.ng.getListeners(target) || []) {
          if ((entry.name || entry.eventName) === "click" && typeof entry.callback === "function") {
            found.push({ callback: entry.callback, owner: target, tier: "ng.getListeners" });
          }
        }
      }
    } catch (_) {}

    if (found.length === 0) {
      var searchNodes = [
        target,
        target.parentElement,
        target.closest?.('button, [role="button"], form'),
        ...Array.from(target.querySelectorAll?.("mat-icon, svg, span, div, i") || [])
      ].filter(Boolean);

      for (var node of searchNodes) {
        for (var registered of clickRegistry.get(node) || []) {
          var callback =
            typeof registered.listener === "function"
              ? registered.listener
              : registered.listener && typeof registered.listener.handleEvent === "function"
                ? registered.listener.handleEvent.bind(registered.listener)
                : null;
          if (callback) {
            found.push({ callback: callback, owner: node, tier: "event-registry" });
          }
        }
      }
    }

    var seen = new Set();
    return found.filter(function (entry2) {
      if (seen.has(entry2.callback)) return false;
      seen.add(entry2.callback);
      return true;
    });
  }

  function _activateV2Submit(target) {
    var listeners = _angularClickListeners(target);
    var invoked = 0;
    var errors = 0;
    var tiers = new Set();

    for (var entry of listeners) {
      var nativeEvent = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        button: 0,
      });

      // Crucial: Proxy isTrusted: true so Angular/Zone.js processes the click as real user input
      var event = new Proxy(nativeEvent, {
        get: function (source, key) {
          if (key === "isTrusted") return true;
          if (key === "target") return target;
          if (key === "currentTarget") return entry.owner;
          if (key === "composedPath") {
            return function () {
              return [target, target.parentElement].filter(Boolean);
            };
          }
          var value = Reflect.get(source, key, source);
          return typeof value === "function" ? value.bind(source) : value;
        },
      });

      invoked++;
      tiers.add(entry.tier);
      try {
        var returned = entry.callback.call(entry.owner, event);
        if (returned && typeof returned.then === "function") {
          returned.catch(function (error) {
            console.warn("[FlowAuto Bridge] async Angular click listener failed:", error?.message || error);
          });
        }
      } catch (error) {
        errors++;
        console.warn("[FlowAuto Bridge] Angular click listener failed:", error?.message || error);
      }
    }

    return {
      success: invoked > 0 && errors < invoked,
      invoked: invoked,
      listeners: listeners.length,
      errors: errors,
      tiers: Array.from(tiers),
      ngAvailable: typeof window.ng?.getListeners === "function",
    };
  }

  function _slateBridgeHandler(e) {
    if (e.source !== window) return;
    if (!e.data || e.data.source !== "flow-auto-slate") return;
    var action = e.data.action;
    var rid = e.data.requestId;

    if (action === "activateV2Submit") {
      var token = String(e.data.submitToken || "");
      if (!/^[0-9a-f-]{36}$/i.test(token)) {
        window.postMessage({ source: "flow-auto-slate-result", requestId: rid, success: false, error: "V2_SUBMIT_TOKEN_INVALID" }, window.location.origin);
        return;
      }
      var target = document.querySelector('[data-tobyflow-submit-token="' + token + '"]');
      if (!target || !(target instanceof HTMLElement)) {
        window.postMessage({ source: "flow-auto-slate-result", requestId: rid, success: false, error: "V2_SUBMIT_TARGET_NOT_FOUND" }, window.location.origin);
        return;
      }
      var activation = _activateV2Submit(target);
      window.postMessage({ source: "flow-auto-slate-result", requestId: rid, ...activation }, window.location.origin);
    }
  }

  window.addEventListener("message", _slateBridgeHandler);

  window.__flowAutoSlateBridgeCleanup = function () {
    window.removeEventListener("message", _slateBridgeHandler);
    if (EventTarget.prototype.addEventListener === patchedAddEventListener) {
      EventTarget.prototype.addEventListener = nativeAddEventListener;
    }
    if (EventTarget.prototype.removeEventListener === patchedRemoveEventListener) {
      EventTarget.prototype.removeEventListener = nativeRemoveEventListener;
    }
  };

  console.log("[FlowAuto] Flow submit bridge loaded (main world)");
})();
