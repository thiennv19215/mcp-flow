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
        new root.FlowDomOperations(this),
        new root.FlowPromptOperations(this),
        new root.FlowReferenceOperations(this),
        new root.FlowUploadOperations(this),
        new root.FlowGenerationOperations(this),
        new root.FlowLibraryOperations(this),
        new root.FlowWorkflowOperations(this),
      ];
      this.agentWorkflowDepth = 0;
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
      if (this.context?.isProjectEditor && typeof root.FlowPageSettings?.ensureApplied === "function") {
        try {
          const pageSettings = await root.FlowPageSettings.ensureApplied({ timeoutMs: 3500 });
          if (pageSettings?.applied !== true) console.debug("[FlowPageSettings] Layout preference setup skipped or unverified:", pageSettings?.reason || "verification_failed");
        } catch (error) {
          // Layout preferences are a best-effort page setup step; do not block
          // project context or generation when the Flow UI changes its menu.
          console.debug("[FlowPageSettings] Layout preference setup failed:", error?.message || error);
        }
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
      const selectorCursor = root.flowSelectorDiagnosticCursor?.() || 0;
      const attachSelectorDiagnostics = error => {
        const attempts = root.flowGetSelectorDiagnostics?.({ after: selectorCursor, limit: 12 }) || [];
        if (attempts.length && error && typeof error === "object") {
          error.diagnostics = { ...(error.diagnostics || {}), selectorAttempts: attempts };
        }
        return error;
      };

      try {
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
        if (this.agentWorkflowDepth === 0 && operation !== "flow.projects.list") {
          if (typeof root.FlowAgent?.ensureReadyForProjectOperation !== "function") {
            throw this.error("FLOW_AGENT_PREFLIGHT_UNAVAILABLE", "Flow Agent state detection is unavailable. The requested operation was not started.", false, false);
          }
          await root.FlowAgent.ensureReadyForProjectOperation({ deadline, signal: command?.signal });
        }
        await nav.prepareFlowOperation({ deadline, signal: command?.signal });
        // Project-scoped DOM operations share the same screen preflight as
        // generation. Without this guard, a stale project URL could leave
        // prompt/reference/library actions targeting a sign-in or viewer UI.
        if (!new Set([
          "flow.projects.list",
          "flow.project.create",
          // These operations navigate to the project editor before interacting
          // with it, then run their own screen assertion after navigation.
          "flow.generation.submit",
          "flow.generation.upload.preflight",
        ]).has(operation)) {
          if (typeof root.FlowScreenState?.assertOperationReady !== "function") {
            throw this.error("FLOW_SCREEN_PREFLIGHT_UNAVAILABLE", "Flow screen detection is unavailable. The requested operation was not started.", false, false);
          }
          root.FlowScreenState.assertOperationReady();
        }
      }
      const startsAgentWorkflow = operation === "flow.agent.batch";
      if (startsAgentWorkflow) this.agentWorkflowDepth += 1;
      try {
        return await group.execute(operation, payload, command);
      } finally {
        if (startsAgentWorkflow) this.agentWorkflowDepth = Math.max(0, this.agentWorkflowDepth - 1);
      }
      } catch (error) {
        throw attachSelectorDiagnostics(error);
      }
    }
  }

  const registry = root.ProviderRegistry || root.FlowDriverRegistry;
  registry.register("flow", (context) => new FlowDriver(context));
  registry.register("flow_v2", (context) => new FlowDriver(context));

  root.FlowDriver = FlowDriver;
  root.FlowV2Driver = FlowDriver;
})(globalThis);
