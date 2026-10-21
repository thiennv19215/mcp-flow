(function (root) {
  class FlowReferenceOperations {
    constructor(driver) { this.driver = driver; }
    supports(operation) { return ['flow.references.clear', 'flow.voices.options', 'flow.references.attach'].includes(operation); }
    error(...args) { return this.driver.error(...args); }
    async execute(name, payload = {}, command = {}) {
      const editor = root.FlowEditor;
      const components = root.FlowComponents;
      const nav = root.FlowNavigation;
      const menu = root.FlowMediaMenu;
      const tiles = root.FlowTiles;
      const agent = root.FlowAgent;
      if (name === "flow.references.clear") {
        const clearReferences = typeof root.clearExistingIngredientChips === "function"
          ? root.clearExistingIngredientChips
          : components.clearExistingIngredientChips;
        if (typeof clearReferences !== "function") {
          throw this.error("FLOW_REFERENCE_CLEAR_UNAVAILABLE", "Flow's reference-chip cleanup is unavailable; no prompt content was changed.", false, false);
        }
        const deadline = root.FlowUiDeadline?.makeDeadline(command, 20_000, 5_000) || Date.now() + 15_000;
        const promptEditor = (typeof root.flowQuery === "function" ? root.flowQuery("editor") : null) ||
          document.querySelector(".ProseMirror[contenteditable='true'], flow-base-prompt-box [contenteditable='true'], textarea[aria-label*='prompt' i]");
        if (!promptEditor || typeof editor?.getEditorUserText !== "function") {
          throw this.error("FLOW_PROMPT_PRESERVATION_UNVERIFIABLE", "Flow's prompt text could not be read, so reference cleanup was not started.", false, false);
        }
        const promptBefore = editor.getEditorUserText(promptEditor);
        const closePicker = components.FlowReferenceActions?.closePicker;
        if (typeof closePicker === "function") await closePicker({ deadline, signal: command.signal, command });
        else if (components.FlowReferenceActions?.inspectDiagnostics?.().pickerOpen) {
          throw this.error("FLOW_ASSET_PICKER_CLOSE_UNAVAILABLE", "Flow's reference picker is open but its safe close operation is unavailable; no prompt content was changed.", false, false);
        }
        const inspectReferences = components.FlowReferenceActions?.inspectDiagnostics;
        const result = await clearReferences({ deadline, signal: command.signal });
        if (!result || result.remaining !== 0) {
          throw this.error("FLOW_REFERENCE_CLEAR_UNCONFIRMED", "Flow did not confirm that all reference chips were removed; inspect the prompt before retrying.", false, false);
        }
        const referencesAfter = typeof inspectReferences === "function" ? inspectReferences() : null;
        if (!referencesAfter || !Number.isInteger(referencesAfter.chipCount) || referencesAfter.chipCount !== 0) {
          const remaining = Number.isInteger(referencesAfter?.chipCount) ? referencesAfter.chipCount : "unknown";
          throw this.error("FLOW_REFERENCE_CLEAR_UNCONFIRMED", `Flow still reports ${remaining} attached reference chip(s) after cleanup; inspect the prompt before retrying.`, false, false);
        }
        const promptAfter = editor.getEditorUserText(promptEditor);
        if (promptAfter !== promptBefore) {
          throw this.error("FLOW_PROMPT_CHANGED_DURING_REFERENCE_CLEAR", "Flow's prompt text changed while reference chips were cleared; inspect the composer before retrying.", false, false);
        }
        return { cleared: Number(result.cleared) || 0, remaining: 0, confirmed: true, picker_closed: true, prompt_preserved: true, prompt_text: promptAfter };
      }

      if (name === "flow.voices.options") {
        if (typeof components.listNativeFlowVoiceOptions !== "function") {
          throw this.error("FLOW_VOICE_PICKER_UNAVAILABLE", "Flow's v2 voice picker inspection is unavailable.", false, false);
        }
        const deadline = root.FlowUiDeadline?.makeDeadline(command, 30_000, 5_000) || Date.now() + 25_000;
        return components.listNativeFlowVoiceOptions({ deadline, signal: command.signal, command });
      }

      if (name === "flow.references.attach") {
        const references = payload.references;
        if (!Array.isArray(references) || !references.length || references.length > 3) throw this.error("FLOW_INVALID_ARGUMENT", "Provide one to three named references.");
        const deadline = root.FlowUiDeadline?.makeDeadline(command, 45_000, 10_000) || Date.now() + 35_000;
        if (payload.inspectOnly === true || payload.inspect_only === true) {
          if (references.length !== 1) throw this.error("FLOW_INVALID_ARGUMENT", "Reference picker inspection accepts exactly one reference.");
          const inspectPicker = root.FlowReferenceActions?.inspectPicker;
          if (typeof inspectPicker !== "function") throw this.error("FLOW_REFERENCE_INSPECT_UNAVAILABLE", "The reference picker inspector is unavailable; no item was selected.", false, false);
          return await inspectPicker(references[0], { deadline, command });
        }
        const attached = [];
        for (const ref of references) {
          root.FlowUiDeadline?.requireTime(deadline, "attaching Flow references", attached.length > 0);
          attached.push(await root.FlowReferenceActions.attach(ref, undefined, { deadline, command }));
        }
        return { attached, submitted: false };
      }

      return undefined;
    }
  }
  root.FlowReferenceOperations = FlowReferenceOperations;
})(globalThis);
