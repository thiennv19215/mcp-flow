(function (root) {
  "use strict";

  class BaseProviderDriver {
    constructor({ key, origin, context, operationHandler, operations = [], requiresProject = true } = {}) {
      if (!key || !origin) throw new TypeError("BaseProviderDriver requires key and origin");
      this.key = key;
      this.origin = origin;
      // Per-provider definition, not a per-call option: providers without a
      // project concept (ChatGPT) construct with requiresProject:false and
      // address work by conversationId instead. Only an explicit false opts
      // out; every other value keeps the Flow default.
      this.requiresProject = requiresProject !== false;
      this.context = Object.freeze({ ...(context || {}) });
      this.operationHandler = operationHandler;
      this.operations = new Set(operations);
    }

    supports(operation) {
      return this.operations.has(operation) && typeof this.operationHandler === "function";
    }

    invoke(operation, payload = {}, command = {}) {
      if (!this.supports(operation)) {
        return Promise.reject(this.error("UNSUPPORTED_OPERATION", `${this.key} does not implement ${operation}.`));
      }
      if (command?.signal?.aborted) {
        return Promise.reject(this.error("FLOW_OPERATION_CANCELLED", "The Flow operation was cancelled before it started.", false, false));
      }
      if (this.requiresProject && operation !== "flow.state" && operation !== "flow.context" && operation !== "flow.projects.list" && operation !== "flow.project.create" && !this.context.projectId) {
        return Promise.reject(this.error("FLOW_PROJECT_REQUIRED", "Open a project before running this operation.", true));
      }
      const expected = command?._flowTarget || command?.flowTarget || command?._target || command?.target;
      const mismatch = this.targetMismatch(expected);
      if (mismatch) return Promise.reject(this.error(mismatch.error, mismatch.message, false, false, mismatch.details));
      return Promise.resolve().then(() => this.operationHandler(operation, payload, command));
    }

    targetMismatch(expected) {
      if (!expected || typeof expected !== "object") return null;
      const checks = [
        ["driverKey", this.key, "FLOW_DRIVER_MISMATCH"],
        ["origin", this.origin, "FLOW_ORIGIN_MISMATCH"],
        ["projectId", this.context.projectId || null, "FLOW_PROJECT_MISMATCH"],
        ["routePrefix", this.context.routePrefix || "", "FLOW_ROUTE_MISMATCH"],
        ["conversationId", this.context.conversationId || null, "FLOW_CONVERSATION_MISMATCH"],
      ];
      for (const [field, actual, code] of checks) {
        const shouldCheck = field === "projectId" || field === "conversationId"
          ? Object.prototype.hasOwnProperty.call(expected, field)
          : expected[field] != null;
        if (shouldCheck && expected[field] !== actual) {
          // Allow "flow" and "flow_v2" compatibility
          if (field === "driverKey" && ((expected[field] === "flow_v2" && actual === "flow") || (expected[field] === "flow" && actual === "flow_v2"))) {
            continue;
          }
          return this.failure(code, `${this.key} ${field} changed before the operation could run.`, {
            expected: expected[field], actual,
          });
        }
      }
      return null;
    }

    failure(code, message, details = null) {
      return { success: false, error: code, message, driverKey: this.key, details };
    }

    error(code, message, retryable = false, outcomeUnknown = false, details = null) {
      const error = new Error(message);
      error.code = code;
      error.retryable = retryable;
      error.outcome_unknown = outcomeUnknown;
      if (details) error.details = details;
      return error;
    }
  }

  BaseProviderDriver.OPERATIONS = Object.freeze([
    "flow.context", "flow.state", "flow.projects.list", "flow.project.create", "flow.assets.list", "flow.characters.list",
    "flow.generation.upload.preflight", "flow.file.upload.begin", "flow.file.upload.chunk",
    "flow.file.upload.finish", "flow.file.upload.abort", "flow.media.upload",
    "flow.generation.submit", "flow.generation.observe", "flow.generation.manual.confirm", "flow.generation.manual.cancel", "flow.references.attach", "flow.references.clear", "flow.references.remove", "flow.prompt.clear", "flow.voices.options", "flow.asset.download",
    "flow.asset.rename", "flow.asset.trash", "flow.character.create", "flow.character.edit",
    "flow.edit.run", "flow.agent.batch", "flow.continue.run", "flow.frame.extract_last",
    // Explicit Toby-compatible DOM primitives. Workflow operations compose
    // these helpers, while callers can also inspect or drive one page step.
    "flow.editor.get", "flow.editor.clear", "flow.prompt.insert",
    "flow.generation.settings.apply", "flow.page.settings.apply",
    "flow.tiles.enumerate", "flow.tiles.status", "flow.generation.wait",
    "flow.gallery.scan",
    "flow.components.list", "flow.components.select", "flow.generation.preflight",
  ]);

  root.BaseProviderDriver = BaseProviderDriver;
  root.FlowPageDriver = BaseProviderDriver; // Backward compatibility alias
})(globalThis);
