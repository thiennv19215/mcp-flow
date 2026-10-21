(function (root) {
  "use strict";

  const BaseDriver = root.BaseProviderDriver || root.FlowPageDriver;

  class FlowDriver extends BaseDriver {
    constructor(context = {}) {
      super({
        ...context,
        context,
        key: "flow",
        origin: (root.ProviderRegistry || root.FlowDriverRegistry).ORIGINS.flow,
        operations: BaseDriver.OPERATIONS,
      });

      this.operationGroups = [
        new root.FlowPromptOperations(this),
        new root.FlowReferenceOperations(this),
        new root.FlowUploadOperations(this),
        new root.FlowGenerationOperations(this),
        new root.FlowLibraryOperations(this),
        new root.FlowWorkflowOperations(this),
      ];
      this.operationHandler = (operation, payload, command) =>
        this.executeOperation(operation, payload, command);
    }

    async invoke(operation, payload = {}, command = {}) {
      if (operation !== "flow.context") {
        return super.invoke(operation, payload, command);
      }

      const registry = root.ProviderRegistry || root.FlowDriverRegistry;
      const live = registry.describeUrl(location.href);
      if (live && !live.isProjectEditor && live.projectId) {
        await (root.FlowNavigation?.ensureFlowProjectEditor?.() ||
          root.ensureFlowProjectEditor?.());
        const refreshed = registry.describeUrl(location.href);
        if (refreshed) this.context = Object.freeze({ ...refreshed });
      }

      const expected =
        command?._flowTarget ||
        command?.flowTarget ||
        command?._target ||
        command?.target;
      const mismatch = this.targetMismatch(expected);
      if (mismatch) {
        return Promise.reject(
          this.error(
            mismatch.error,
            mismatch.message,
            false,
            false,
            mismatch.details,
          ),
        );
      }
      return { success: true, ...this.context };
    }

    executeOperation(operation, payload = {}, command = {}) {
      const group = this.operationGroups.find((candidate) =>
        candidate.supports(operation),
      );
      if (!group) {
        throw this.error(
          "NATIVE_CAPABILITY_UNSUPPORTED",
          `Native Flow operation "${operation}" is not implemented.`,
          true,
        );
      }
      return group.execute(operation, payload, command);
    }
  }

  const registry = root.ProviderRegistry || root.FlowDriverRegistry;
  registry.register("flow", (context) => new FlowDriver(context));
  registry.register("flow_v2", (context) => new FlowDriver(context));

  root.FlowDriver = FlowDriver;
  root.FlowV2Driver = FlowDriver;
})(globalThis);
