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

    async executeOperation(operation, payload = {}, command = {}) {
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

      // Flow can leave the media/reference picker mounted after an upload or
      // an interrupted reference action. Resolve and verify those transient
      // surfaces before every DOM operation; transfer chunks and the passive
      // generation observer do not interact with the page UI.
      const pageUiOperation = ![
        "flow.state",
        "flow.file.upload.begin",
        "flow.file.upload.chunk",
        "flow.file.upload.finish",
        "flow.file.upload.abort",
        "flow.generation.observe",
      ].includes(operation);
      if (pageUiOperation) {
        const nav = root.FlowNavigation;
        if (typeof nav?.prepareFlowOperation !== "function") {
          throw this.error("FLOW_OPERATION_PREFLIGHT_UNAVAILABLE", "Flow popup detection is unavailable. The requested operation was not started.", true, false);
        }
        const deadline = root.FlowUiDeadline?.makeDeadline(command, 12_000, 3_000) || Date.now() + 10_000;
        await nav.prepareFlowOperation({ deadline, signal: command?.signal });
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
