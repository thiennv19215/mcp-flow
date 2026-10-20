(function (root) {
  "use strict";

  async function flowOperation(name, payload = {}, command = {}) {
    const registry = root.ProviderRegistry || root.FlowDriverRegistry;
    const resolved = registry.resolveForUrl(location.href);
    if (!resolved?.driver) {
      throw (root.flowError
        ? root.flowError("FLOW_UNSUPPORTED_ROUTE", "This page route is not supported by any registered provider driver.", true)
        : new Error("This page route is not supported by any registered provider driver."));
    }
    return resolved.driver.invoke(name, payload, command);
  }

  async function execute(c) {
    if (c.op === "flowOperation") return flowOperation(c.name, c.payload || {}, c);
    throw (root.flowError
      ? root.flowError("NATIVE_CAPABILITY_UNSUPPORTED", `Unsupported native command: ${String(c.op || "unknown")}`, true)
      : new Error(`Unsupported native command: ${String(c.op || "unknown")}`));
  }

  if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message, _sender, respond) => {
      if (message?.type !== "flow-mcp:execute") return false;
      let responded = false;
      const safeRespond = data => {
        if (responded) return;
        responded = true;
        try { respond(data); } catch (_) {}
      };

      (async () => {
        try {
          const result = await execute(message.command);
          safeRespond({ ok: true, value: result });
        } catch (error) {
          safeRespond({
            ok: false,
            error: {
              code: error?.code || "FLOW_DOM_FAILED",
              message: String(error?.message || error),
              retryable: Boolean(error?.retryable),
              outcome_unknown: Boolean(error?.outcome_unknown),
            },
          });
        }
      })();

      return true;
    });
  }

  root.execute = execute;
  root.flowOperation = flowOperation;
})(globalThis);
