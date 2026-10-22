(function (root) {
  "use strict";

  // This group is the small, explicit DOM contract shared by the native Flow
  // driver.  The older operation groups still own the business workflows;
  // these methods expose the same page primitives Toby keeps behind
  // FlowPageDriver so callers do not have to reach into a submit workflow.
  class FlowDomOperations {
    constructor(driver) { this.driver = driver; }
    supports(operation) {
      return [
        "flow.editor.get",
        "flow.editor.clear",
        "flow.prompt.insert",
        "flow.generation.settings.apply",
        "flow.page.settings.apply",
        "flow.tiles.enumerate",
        "flow.tiles.status",
        "flow.generation.wait",
        "flow.gallery.scan",
        "flow.components.list",
        "flow.components.select",
        "flow.generation.preflight",
      ].includes(operation);
    }
    error(...args) { return this.driver.error(...args); }

    deadline(command, fallback = 15_000) {
      return root.FlowUiDeadline?.makeDeadline(command, fallback, Math.min(5_000, fallback)) || Date.now() + fallback;
    }

    editorSnapshot(editor) {
      if (!editor) return { found: false, text: "", chipCount: 0 };
      const flowEditor = root.FlowEditor;
      const text = typeof flowEditor?.getEditorUserText === "function"
        ? flowEditor.getEditorUserText(editor)
        : String(editor.innerText || editor.textContent || "").replace(/\s+/g, " ").trim();
      const chipCount = typeof flowEditor?.countInlineChips === "function"
        ? flowEditor.countInlineChips(editor)
        : editor.querySelectorAll?.('[contenteditable="false"]').length || 0;
      return {
        found: true,
        text,
        chipCount,
        contentEditable: editor.isContentEditable === true,
        connected: editor.isConnected !== false,
      };
    }

    tileSnapshot(items) {
      return (Array.isArray(items) ? items : []).map(item => ({
        ...(item?.id ? { id: item.id } : {}),
        ...(item?.persistentMediaId ? { persistentMediaId: item.persistentMediaId } : {}),
        ...(item?.persistentMediaId ? { persistent_media_id: item.persistentMediaId } : {}),
        ...(item?.projectId ? { projectId: item.projectId, project_id: item.projectId } : {}),
        ...(item?.operationId ? { operationId: item.operationId } : {}),
        title: item?.title || "",
        displayName: item?.displayName || item?.title || "",
        ...(item?.fileName ? { fileName: item.fileName, file_name: item.fileName } : {}),
        ...(item?.id ? { fileId: item.id, file_id: item.id } : {}),
        kind: item?.kind || "image",
        type: item?.type || item?.kind || "image",
        busy: Boolean(item?.busy),
        mediaReady: Boolean(item?.mediaReady),
        failed: Boolean(item?.failed),
        ...(item?.failureReason ? { failureReason: item.failureReason } : {}),
        ...(item?.progress ? { progress: item.progress } : {}),
        ...(item?.thumbnail ? { thumbnail: item.thumbnail, thumbnailUrl: item.thumbnailUrl || item.thumbnail } : {}),
        ...(item?.src ? { src: item.src } : {}),
        ...(item?.videoUrl ? { videoUrl: item.videoUrl, video_url: item.video_url || item.videoUrl } : {}),
        ...(item?.identityDurability ? { identityDurability: item.identityDurability, identity_durability: item.identityDurability } : {}),
      }));
    }

    componentSnapshot(chips) {
      return (Array.isArray(chips) ? chips : []).map(chip => ({
        name: chip?.name || "",
        kind: chip?.kind || "image",
        ...(chip?.mediaId ? { id: chip.mediaId } : {}),
        ...(chip?.source ? { source: chip.source } : {}),
      }));
    }

    async execute(name, payload = {}, command = {}) {
      const editor = root.FlowEditor;
      const tiles = root.FlowTiles;
      const settings = root.FlowSettings;
      const components = root.FlowComponents;
      const mediaMenu = root.FlowMediaMenu;
      const deadline = this.deadline(command, Number(payload.timeoutMs) || 15_000);

      if (command?.signal?.aborted) {
        throw this.error("FLOW_OPERATION_CANCELLED", "The Flow DOM operation was cancelled before it started.", false, false);
      }

      if (name === "flow.editor.get") {
        const node = editor?.getVisibleFlowPromptEditor?.();
        if (!node) throw this.error("FLOW_PROMPT_CONTROL_UNAVAILABLE", "Flow's visible prompt editor was not found.", false, false);
        return this.editorSnapshot(node);
      }

      if (name === "flow.editor.clear") {
        const node = editor?.getVisibleFlowPromptEditor?.();
        if (!node || typeof editor?.clearEditorTextPreservingChips !== "function") {
          throw this.error("FLOW_PROMPT_CLEAR_UNAVAILABLE", "Flow's prompt editor could not be verified; nothing was changed.", false, false);
        }
        const expected = typeof payload.expectedPrompt === "string" ? payload.expectedPrompt : null;
        const before = this.editorSnapshot(node);
        if (expected !== null && before.text !== expected) {
          throw this.error("FLOW_PROMPT_CLEAR_TEXT_MISMATCH", "The visible Flow prompt no longer matches expected_prompt; nothing was changed.", false, false);
        }
        root.FlowUiDeadline?.requireTime(deadline, "clearing the Flow prompt", false, command.signal);
        const cleared = await editor.clearEditorTextPreservingChips(node);
        const after = this.editorSnapshot(node);
        if (!cleared || after.text !== "") {
          throw this.error("FLOW_PROMPT_CLEAR_UNCONFIRMED", "Flow did not confirm that the prompt is blank; inspect the composer before retrying.", false, true);
        }
        return { cleared: true, confirmed: true, before, after, references_preserved: after.chipCount === before.chipCount };
      }

      if (name === "flow.prompt.insert") {
        if (typeof editor?.insertNativeFlowPrompt !== "function") {
          throw this.error("FLOW_PROMPT_INPUT_UNAVAILABLE", "Flow's prompt insertion helper is unavailable; nothing was changed.", false, false);
        }
        const text = typeof payload.text === "string" ? payload.text : typeof payload.prompt === "string" ? payload.prompt : "";
        if (!text.trim()) throw this.error("FLOW_INVALID_ARGUMENT", "A non-empty prompt text is required.", false, false);
        root.FlowUiDeadline?.requireTime(deadline, "inserting the Flow prompt", false, command.signal);
        const node = editor.getVisibleFlowPromptEditor?.();
        const inserted = await editor.insertNativeFlowPrompt(node, text);
        if (!inserted) throw this.error("FLOW_PROMPT_INPUT_UNCONFIRMED", "Flow did not confirm the full prompt text.", true, false);
        return { inserted: true, confirmed: true, prompt: editor.getEditorUserText?.(editor.getVisibleFlowPromptEditor?.()) || text };
      }

      if (name === "flow.generation.settings.apply") {
        const kind = String(payload.type || payload.kind || "image").toLowerCase() === "video" ? "video" : "image";
        const variants = Math.max(1, Math.min(4, Number(payload.variants || payload.count || 1)));
        const options = { deadline, signal: command.signal, command, ...(kind === "video" ? { videoPreparation: true } : { imagePreparation: true }) };
        const action = kind === "video" ? root.FlowVideoActions : root.FlowImageActions;
        if (typeof action?.prepare !== "function") {
          throw this.error("FLOW_SETTINGS_UNAVAILABLE", `Flow's ${kind} settings helper is unavailable; no generation was submitted.`, true, false);
        }
        const result = kind === "video"
          ? await action.prepare(payload, variants, Boolean(payload.firstFrame || payload.lastFrame), options)
          : await action.prepare(payload, variants, options);
        return { applied: true, confirmed: true, type: kind, variants, ...(Number.isFinite(result) ? { credits: result } : {}) };
      }

      if (name === "flow.page.settings.apply") {
        if (typeof root.FlowPageSettings?.ensureApplied !== "function") {
          throw this.error("FLOW_PAGE_SETTINGS_UNAVAILABLE", "Flow's page settings helper is unavailable.", true, false);
        }
        return root.FlowPageSettings.ensureApplied({ timeoutMs: Number(payload.timeoutMs) || 5_000, deadline, signal: command.signal });
      }

      if (name === "flow.tiles.enumerate" || name === "flow.tiles.status") {
        if (typeof tiles?.collectNativeMedia !== "function") throw this.error("FLOW_TILES_UNAVAILABLE", "Flow's tile DOM is unavailable.", true, false);
        const result = this.tileSnapshot(tiles.collectNativeMedia({ operationId: payload.operationId || command.operationId }));
        return { tiles: result, count: result.length, source: "flow_dom" };
      }

      if (name === "flow.gallery.scan") {
        if (typeof mediaMenu?.scanGalleryTiles !== "function") {
          throw this.error("FLOW_GALLERY_SCAN_UNAVAILABLE", "Flow's gallery scanner is unavailable.", true, false);
        }
        return mediaMenu.scanGalleryTiles({
          ...payload,
          deep: payload.deep === true,
          deadline,
          signal: command.signal,
        });
      }

      if (name === "flow.generation.wait") {
        if (typeof tiles?.waitForProgressResult !== "function") throw this.error("FLOW_TILE_WAIT_UNAVAILABLE", "Flow's tile wait helper is unavailable.", true, false);
        const before = Array.isArray(payload.before) ? payload.before.map(item => typeof item === "string" ? item : item?.id || `title:${item?.title || ""}`) : [];
        const expected = Math.max(1, Number(payload.expected || payload.count || payload.maxQuantity || 1));
        const kind = payload.kind || payload.type || undefined;
        const timeoutMs = Math.max(1_000, Math.min(15 * 60_000, Number(payload.timeoutMs) || 10 * 60_000));
        const waitDeadline = Number.isFinite(command?.deadline)
          ? Math.min(Number(command.deadline), Date.now() + timeoutMs)
          : Date.now() + timeoutMs;
        const result = await tiles.waitForProgressResult(
          command,
          before,
          expected,
          kind,
          Math.max(1, waitDeadline - Date.now()),
          payload.selector || "flow-grid-tile-container",
          Boolean(payload.allowConfirmedPartial),
          {
            operationId: payload.operationId || command.operationId || null,
            preFileNames: payload.preFileNames || payload.pre_file_names,
            expectedMediaType: payload.expectedMediaType || payload.expected_media_type || kind,
          },
        );
        return { completed: true, confirmed: true, tiles: this.tileSnapshot(result) };
      }

      if (name === "flow.components.list") {
        const kind = String(payload.kind || "").trim().toLowerCase();
        if (kind === "voice") {
          if (typeof root.FlowVoiceActions?.listOptions !== "function") throw this.error("FLOW_VOICE_PICKER_UNAVAILABLE", "Flow's voice picker inspection is unavailable.", false, false);
          return root.FlowVoiceActions.listOptions({ deadline, signal: command.signal, command });
        }
        if (kind === "character") {
          if (typeof root.FlowReferenceActions?.listCharacters !== "function") throw this.error("FLOW_CHARACTER_PICKER_UNAVAILABLE", "Flow's character picker inspection is unavailable.", false, false);
          const names = await root.FlowReferenceActions.listCharacters({ deadline, signal: command.signal, command });
          return { components: names.map(name => ({ name, kind: "character" })), count: names.length, source: "flow_dom_picker", readOnly: true };
        }
        const composer = editor?.getVisibleFlowPromptEditor?.()?.closest?.(".flow-composer,flow-base-prompt-box,form,[class*='composer']") || document;
        const chips = root.FlowReferenceActions?.chips?.(composer) || [];
        return { components: this.componentSnapshot(chips), count: chips.length, source: "flow_dom_composer", readOnly: true };
      }

      if (name === "flow.components.select") {
        const kind = String(payload.kind || "image").trim().toLowerCase();
        const normalizeReference = (value, referenceKind) => {
          const source = typeof value === "object" && value !== null ? value : null;
          const assetName = source ? (source.assetName ?? source.name ?? "") : String(value ?? "");
          return { ...(source || {}), assetName, kind: source?.kind || referenceKind };
        };
        const resolveExpectedId = (explicitExpectedId, reference) => {
          const nestedExpectedId = reference?.expectedId;
          if (explicitExpectedId != null && nestedExpectedId != null) {
            const explicitId = String(explicitExpectedId).trim();
            const nestedId = String(nestedExpectedId).trim();
            const isUuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
            const matches = isUuid(explicitId) && isUuid(nestedId)
              ? explicitId.toLowerCase() === nestedId.toLowerCase()
              : explicitId === nestedId;
            if (!matches) throw this.error("FLOW_INVALID_ARGUMENT", "Conflicting expected IDs were provided for the Flow reference.", false, false);
          }
          return explicitExpectedId ?? nestedExpectedId;
        };
        const selections = Array.isArray(payload.selections) ? payload.selections : null;
        if (selections) {
          if (!selections.length || selections.length > 3) throw this.error("FLOW_INVALID_ARGUMENT", "Provide one to three component selections.", false, false);
          const selected = [];
          for (const selection of selections) {
            const value = selection?.reference || selection?.name || selection?.component || selection;
            if (!value) throw this.error("FLOW_INVALID_ARGUMENT", "Each component selection needs a name or reference.", false, false);
            if (String(selection?.kind || kind).toLowerCase() === "voice") {
              if (typeof root.FlowVoiceActions?.select !== "function") throw this.error("FLOW_VOICE_PICKER_UNAVAILABLE", "Flow's voice picker is unavailable.", false, false);
              selected.push(await root.FlowVoiceActions.select(String(value), { deadline, signal: command.signal, command }));
            } else {
              if (typeof root.FlowReferenceActions?.attach !== "function") throw this.error("FLOW_REFERENCE_ATTACH_UNAVAILABLE", "Flow's reference picker is unavailable.", false, false);
              const reference = normalizeReference(value, selection?.kind || kind);
              const expectedId = resolveExpectedId(selection?.expectedId, reference);
              selected.push(await root.FlowReferenceActions.attach(reference, selection?.slot, { deadline, signal: command.signal, command, expectedId }));
            }
          }
          return { selected, count: selected.length, submitted: false };
        }
        const value = payload.reference || payload.name || payload.component;
        if (!value) throw this.error("FLOW_INVALID_ARGUMENT", "A component name or reference is required.", false, false);
        if (kind === "voice") {
          if (typeof root.FlowVoiceActions?.select !== "function") throw this.error("FLOW_VOICE_PICKER_UNAVAILABLE", "Flow's voice picker is unavailable.", false, false);
          return root.FlowVoiceActions.select(String(value), { deadline, signal: command.signal, command });
        }
        if (typeof root.FlowReferenceActions?.attach !== "function") throw this.error("FLOW_REFERENCE_ATTACH_UNAVAILABLE", "Flow's reference picker is unavailable.", false, false);
        const reference = normalizeReference(value, kind);
        const expectedId = resolveExpectedId(payload.expectedId, reference);
        return root.FlowReferenceActions.attach(reference, payload.slot, { deadline, signal: command.signal, command, expectedId });
      }

      if (name === "flow.generation.preflight") {
        root.FlowScreenState?.assertGenerationReady?.();
        const prompt = editor?.getVisibleFlowPromptEditor?.();
        if (!prompt) throw this.error("FLOW_PROMPT_COMPOSER_NOT_READY", "Flow's prompt editor is not visible; generation cannot start.", true, false);
        return { ready: true, confirmed: true, project: (root.ProviderRegistry || root.FlowDriverRegistry)?.describeUrl?.(location.href) || null, editor: this.editorSnapshot(prompt) };
      }

      return undefined;
    }
  }

  root.FlowDomOperations = FlowDomOperations;
})(globalThis);
