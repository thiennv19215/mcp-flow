(function (root) {
  "use strict";

  class BaseProviderDriver {
    constructor({ key, origin, context, operationHandler, operations = [] } = {}) {
      if (!key || !origin) throw new TypeError("BaseProviderDriver requires key and origin");
      this.key = key;
      this.origin = origin;
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
      if (operation !== "flow.state" && operation !== "flow.context" && operation !== "flow.projects.list" && operation !== "flow.project.create" && !this.context.projectId) {
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
      ];
      for (const [field, actual, code] of checks) {
        if (expected[field] != null && expected[field] !== actual) {
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
    "flow.generation.submit", "flow.generation.observe", "flow.references.attach", "flow.references.clear", "flow.voices.options", "flow.asset.download",
    "flow.asset.rename", "flow.asset.trash", "flow.character.create", "flow.character.edit",
    "flow.edit.run", "flow.agent.batch", "flow.continue.run",
  ]);

  root.BaseProviderDriver = BaseProviderDriver;
  root.FlowPageDriver = BaseProviderDriver; // Backward compatibility alias
})(globalThis);
