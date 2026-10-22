(function (root) {
  "use strict";
  const activeFlowCommands = new Map();
  const cancelledFlowCommands = new Map();

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
      if (message?.type === "flow-mcp:cancel") {
        const requestId = String(message.requestId || "");
        if (!requestId) { respond({ ok: false, error: "A Flow request id is required." }); return false; }
        const controller = activeFlowCommands.get(requestId);
        if (controller) controller.abort(Object.assign(new Error("The Flow operation was stopped by the extension queue."), { code: "FLOW_OPERATION_CANCELLED" }));
        else cancelledFlowCommands.set(requestId, Date.now() + 30_000);
        respond({ ok: true, cancelled: Boolean(controller) });
        return false;
      }
      if (message?.type !== "flow-mcp:execute") return false;
      let responded = false;
      const safeRespond = data => {
        if (responded) return;
        responded = true;
        try { respond(data); } catch (_) {}
      };

      (async () => {
        const sourceCommand = message.command && typeof message.command === "object" ? message.command : {};
        const requestId = String(sourceCommand.requestId || sourceCommand.request_id || sourceCommand.id || "");
        const controller = new AbortController();
        if (requestId) {
          for (const [id, expiresAt] of cancelledFlowCommands) if (expiresAt <= Date.now()) cancelledFlowCommands.delete(id);
          activeFlowCommands.set(requestId, controller);
          if (cancelledFlowCommands.has(requestId)) {
            cancelledFlowCommands.delete(requestId);
            controller.abort(Object.assign(new Error("The Flow operation was stopped before it started."), { code: "FLOW_OPERATION_CANCELLED" }));
          }
        }
        try {
          const result = await execute({ ...sourceCommand, ...(requestId ? { id: requestId } : {}), signal: controller.signal });
          safeRespond({ ok: true, value: result });
        } catch (error) {
          safeRespond({
            ok: false,
            error: {
              code: error?.code || "FLOW_DOM_FAILED",
              message: String(error?.message || error),
              retryable: Boolean(error?.retryable),
              outcome_unknown: Boolean(error?.outcome_unknown),
              ...(error?.diagnostics ? { diagnostics: error.diagnostics } : {}),
            },
          });
        } finally {
          if (requestId && activeFlowCommands.get(requestId) === controller) activeFlowCommands.delete(requestId);
        }
      })();

      return true;
    });
  }

  root.execute = execute;
  root.flowOperation = flowOperation;
})(globalThis);
