(function (root) {
  class FlowPromptOperations {
    constructor(driver) { this.driver = driver; }
    supports(operation) { return ['flow.prompt.clear'].includes(operation); }
    error(...args) { return this.driver.error(...args); }
    async execute(name, payload = {}, command = {}) {
      const editor = root.FlowEditor;
      const components = root.FlowComponents;
      const nav = root.FlowNavigation;
      const menu = root.FlowMediaMenu;
      const tiles = root.FlowTiles;
      const agent = root.FlowAgent;
      if (name === "flow.prompt.clear") {
        const expectedPrompt = typeof payload.expectedPrompt === "string" ? payload.expectedPrompt : "";
        if (!expectedPrompt) {
          throw this.error("FLOW_PROMPT_CLEAR_EXPECTED_TEXT_REQUIRED", "The exact expected prompt text is required; nothing was changed.", false, false);
        }
        const registry = root.ProviderRegistry || root.FlowDriverRegistry;
        const described = registry?.describeUrl?.(location.href) || null;
        const state = menu?.nativeRead?.("flowState") || null;
        const targetProjectId = command?._flowTarget?.projectId || command?.flowTarget?.projectId || null;
        if (!described?.projectId || described.isProjectEditor !== true || !state?.signedIn || !state.inProject || !state?.isProjectEditor ||
            state.projectId !== described.projectId || (targetProjectId && targetProjectId !== described.projectId)) {
          throw this.error("FLOW_PROMPT_CLEAR_PROJECT_UNVERIFIED", "The active Flow project could not be verified consistently; the prompt was left unchanged.", false, false);
        }
        if (typeof root.visible !== "function" || typeof document.querySelectorAll !== "function") {
          throw this.error("FLOW_PROMPT_CONTROL_UNVERIFIABLE", "Flow's visible prompt controls could not be verified; the prompt was left unchanged.", false, false);
        }
        const promptControls = [...new Set(document.querySelectorAll(
          ".ProseMirror[contenteditable='true'], flow-base-prompt-box [contenteditable='true']"
        ))].filter(control => root.visible(control) === true);
        if (promptControls.length !== 1) {
          throw this.error("FLOW_PROMPT_CONTROL_AMBIGUOUS", `Expected one visible Flow prompt control, found ${promptControls.length}; nothing was changed.`, false, false);
        }
        if (typeof editor?.getEditorUserText !== "function" || typeof editor?.clearEditorTextPreservingChips !== "function") {
          throw this.error("FLOW_PROMPT_CLEAR_UNAVAILABLE", "Flow's chip-preserving prompt clear helper is unavailable; nothing was changed.", false, false);
        }
        const promptControl = promptControls[0];
        const promptBefore = editor.getEditorUserText(promptControl);
        if (promptBefore !== expectedPrompt) {
          throw this.error("FLOW_PROMPT_CLEAR_TEXT_MISMATCH", "The visible Flow prompt no longer matches expected_prompt; nothing was changed.", false, false);
        }
        const inspectReferences = components?.FlowReferenceActions?.inspectDiagnostics;
        const readReferenceChips = components?.FlowReferenceActions?.chips;
        const referenceState = typeof inspectReferences === "function" ? inspectReferences() : null;
        const chipIdentitySnapshot = (state, rawChips) => {
          if (!state || typeof state.pickerOpen !== "boolean" || !Number.isInteger(state.chipCount) ||
              typeof readReferenceChips !== "function" || !Array.isArray(rawChips) || rawChips.length !== state.chipCount) return null;
          const identities = rawChips.map(chip => {
            const kind = chip?.kind === "image" || chip?.kind === "character" ? chip.kind : null;
            const id = typeof chip?.mediaId === "string" ? chip.mediaId.trim().toLowerCase() : "";
            const name = typeof chip?.name === "string" ? chip.name.trim().replace(/\s+/g, " ").toLowerCase() : "";
            if (!kind) return null;
            if (id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) return `${kind}:id:${id}`;
            return name ? `${kind}:name:${name}` : null;
          });
          if (identities.some(identity => !identity) || new Set(identities).size !== identities.length) return null;
          return JSON.stringify({ pickerOpen: state.pickerOpen, identities: [...identities].sort() });
        };
        const preservedState = chipIdentitySnapshot(referenceState, typeof readReferenceChips === "function" ? readReferenceChips() : null);
        if (preservedState === null) {
          throw this.error("FLOW_PROMPT_CLEAR_STATE_UNVERIFIABLE", "Flow's current reference and picker state could not be verified; the prompt was left unchanged.", false, false);
        }
        await editor.clearEditorTextPreservingChips(promptControl);
        const promptAfter = editor.getEditorUserText(promptControl);
        const referenceStateAfter = inspectReferences();
        const preservedStateAfter = chipIdentitySnapshot(referenceStateAfter, typeof readReferenceChips === "function" ? readReferenceChips() : null);
        if (promptAfter !== "") {
          throw this.error("FLOW_PROMPT_CLEAR_UNCONFIRMED", "Flow did not confirm that the prompt is blank; inspect the composer before retrying.", false, true);
        }
        if (preservedStateAfter !== preservedState) {
          throw this.error("FLOW_PROMPT_CLEAR_STATE_CHANGED", "The prompt cleared, but Flow's reference or picker state changed unexpectedly; inspect the composer.", false, true);
        }
        return { cleared: true, confirmed: true, projectId: described.projectId, references_preserved: true, picker_state_preserved: true };
      }

      return undefined;
    }
  }
  root.FlowPromptOperations = FlowPromptOperations;
})(globalThis);
