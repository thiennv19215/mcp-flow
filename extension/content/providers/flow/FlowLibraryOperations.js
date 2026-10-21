(function (root) {
  class FlowLibraryOperations {
    constructor(driver) {
      this.driver = driver;
    }
    supports(operation) {
      return [
        "flow.projects.list",
        "flow.project.create",
        "flow.asset.download",
        "flow.state",
        "flow.assets.list",
        "flow.characters.list",
        "flow.asset.rename",
        "flow.asset.trash",
      ].includes(operation);
    }
    error(...args) {
      return this.driver.error(...args);
    }
    async execute(name, payload = {}, command = {}) {
      const tiles = root.FlowTiles;
      const menu = root.FlowMediaMenu;
      if (name === "flow.projects.list") {
        if (/\/project\/[0-9a-f-]{36}(?:\/|$)/i.test(location.pathname)) {
          throw this.error("FLOW_HOMEPAGE_REQUIRED", "Project discovery needs the Flow home page. The connector should open a temporary home tab.", true);
        }
        return menu.scanNativeProjects();
      }

      if (name === "flow.project.create") {
        const registry = root.ProviderRegistry || root.FlowDriverRegistry;
        const current = registry?.describeUrl?.(location.href);
        if (!current || current.projectId) {
          throw this.error("FLOW_HOMEPAGE_REQUIRED", "Create a Flow project from the Flow home page.", true);
        }

        const config = root.FlowSelectors?.navigation?.newProjectButton;
        const labelPattern = config?.textRegex || /new project|tạo dự án|dự án mới|create project/i;
        const selector = (Array.isArray(config?.selectors) && config.selectors.length ? config.selectors : ["button", "a[role='button']"]).join(",");
        const candidates = [...document.querySelectorAll(selector)].filter(button => {
          if (!root.visible?.(button)) return false;
          const label = (root.accessibleName?.(button) || button.innerText || button.textContent || "").trim();
          const hasAddIcon = [...button.querySelectorAll("mat-icon")].some(icon => /add|create|new/i.test((icon.innerText || icon.textContent || "").trim()));
          return (root.matchesFlowUiRegex?.(label, labelPattern) || labelPattern.test(label)) ||
            (hasAddIcon && /project|dự án/i.test(label));
        });
        if (candidates.length !== 1) {
          throw this.error(candidates.length ? "FLOW_CREATE_PROJECT_AMBIGUOUS" : "FLOW_CREATE_PROJECT_CONTROL_MISSING",
            candidates.length ? `Found ${candidates.length} possible New project controls; no project was created.` : "Flow did not show a New project control; no project was created.", true);
        }

        candidates[0].click();
        const deadline = Date.now() + Math.min(20_000, Number(command.timeoutMs) || 20_000);
        let created = null;
        while (Date.now() < deadline) {
          const described = registry?.describeUrl?.(location.href);
          const id = String(described?.projectId || "");
          if (described?.isProjectEditor && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
            created = { id, url: location.href };
            break;
          }
          await root.wait?.(250);
        }
        if (!created) {
          throw this.error("FLOW_CREATE_PROJECT_RESULT_UNKNOWN", "Flow accepted the New project click, but a new project ID could not be confirmed. Check the project list before retrying.", false, true);
        }
        const title = [...document.querySelectorAll("h1,[role=heading]")].find(el => root.visible?.(el));
        const name = String(title?.innerText || title?.textContent || "").trim() || "Untitled project";
        return { project: { ...created, name }, created: true };
      }

      if (name === "flow.asset.download") {
        const prefix = String(payload.name || "").toLowerCase();
        if (!prefix && !payload.id) throw this.error("FLOW_INVALID_ARGUMENT", "Asset name or media id is required.");
        if (payload.id) return menu.triggerFlowDownload(String(payload.name || ""), payload.quality, String(payload.id));
        const assets = await menu.scanNativeAssets();
        const candidates = assets.filter(a => a.name.toLowerCase().startsWith(prefix));
        const matches = [];
        for (const a of candidates) {
          const count = await tiles.countFlowTitleAcrossGrid(a.name);
          for (let i = 0; i < count; i++) matches.push(a);
          if (matches.length > 1) break;
        }
        if (!matches.length) throw this.error("FLOW_ASSET_NOT_FOUND", `No asset title begins with "${payload.name}".`, true);
        if (matches.length > 1) throw this.error("FLOW_AMBIGUOUS_ASSET", `${matches.length} assets begin with "${payload.name}"; no download was started.`, true);
        return menu.triggerFlowDownload(matches[0].name, payload.quality);
      }

      if (name === "flow.state") {
        const state = menu.nativeRead("flowState");
        if (payload.progressDiagnosticsPing) await tiles.emitFlowProgress(command, "Flow progress telemetry check");
        const settingsButton = root.flowButton?.("Settings trigger");
        if (settingsButton) state.composer = (settingsButton.innerText || root.accessibleName?.(settingsButton)).replace(/\s+/g, " ").trim();
        const quoteInspection = root.FlowEditor?.inspectGenerationCreditQuote?.();
        if (quoteInspection) {
          state.generation_credit_quote = quoteInspection.quote;
          state.generation_credit_quote_candidates = quoteInspection.candidates;
        }
        if (payload.detailed && state.signedIn) {
          const account = root.flowButton?.("Account details");
          if (account) {
            account.click(); await root.wait?.(500);
            const creditLink = [...document.querySelectorAll("a")].find(a => /(?:Google Flow credits|credits?|tín dụng)/i.test(root.accessibleName?.(a) || a.innerText || "") && root.visible?.(a));
            const creditText = creditLink ? (root.accessibleName?.(creditLink) || creditLink.innerText || "") : "";
            const n = Number(creditText.replace(/[^\d]/g, ""));
            state.credits_remaining = Number.isFinite(n) && creditText ? n : undefined;
            state.plan = [...document.querySelectorAll("button")].find(b => /(?:Account details|Chi tiết tài khoản|Tài khoản)/i.test(root.accessibleName?.(b) || b.innerText || ""))?.innerText?.split("\n")[0];
            const close = root.flowButton?.("Close account panel"); if (close) close.click();
          }
        }
        if (payload.includeProgressDiagnostics && chrome.runtime?.sendMessage) {
          const progress = await chrome.runtime.sendMessage({ type: "flow-mcp:progress-diagnostics" }).catch(() => null);
          state.progress_diagnostics = progress?.diagnostic || null;
        }
        if (typeof tiles.inspectNativeFlowCorrelationObserver === "function") {
          state.correlation_observer_diagnostics = await tiles.inspectNativeFlowCorrelationObserver().catch(error => ({
            pageProjectId: null,
            observer: null,
            projectMatch: false,
            armPreflight: { result: "diagnostic_error", reason: String(error?.message || error).slice(0, 240) },
          }));
        }
        return state;
      }

      if (name === "flow.assets.list") return menu.scanNativeAssets();
      if (name === "flow.characters.list") {
        if (typeof menu?.scanNativeCharacters !== "function") {
          throw this.error("NATIVE_CAPABILITY_UNSUPPORTED", "Flow's character library scanner is unavailable in this extension context. Reload the extension and Flow tab, then retry.", true);
        }
        const deadline = root.FlowUiDeadline?.makeDeadline(command, 45_000, 10_000) || Date.now() + 35_000;
        const characters = await menu.scanNativeCharacters({ deadline, signal: command.signal });
        if (!Array.isArray(characters) || characters.some(character => !character || typeof character.name !== "string" || !character.name.trim() || (character.uuid !== undefined && typeof character.uuid !== "string"))) {
          throw this.error("FLOW_CHARACTER_SCAN_INVALID_RESULT", "Flow's character library scan returned an invalid list; no partial list was returned.", true);
        }
        return characters;
      }

      if (name === "flow.asset.rename" || name === "flow.asset.trash") {
        const title = String(payload.name || "");
        if (!title) throw this.error("FLOW_INVALID_ARGUMENT", "Asset name is required.");
        const copies = await tiles.countFlowTitleAcrossGrid(title);
        if (copies !== 1) throw this.error(copies > 1 ? "FLOW_AMBIGUOUS_ASSET" : "FLOW_ASSET_NOT_FOUND", copies > 1 ? `${copies} assets are named "${title}"; no mutation was performed.` : `Could not find asset "${title}".`, true);
        const tile = await tiles.findFlowTile(title);
        if (!tile) throw this.error("FLOW_ASSET_NOT_FOUND", `Could not find asset "${title}" after scanning the project grid.`, true);
        tile.scrollIntoView({ block: "center" }); await root.wait?.(150);
        const more = root.flowButton?.("More options", tile); if (!more) throw this.error("FLOW_TILE_MENU_MISSING", `Could not open options for "${title}".`, true);
        more.click(); await root.wait?.(200);
        const actionPatterns = name === "flow.asset.trash"
          ? /^(?:Move to trash|Chuyển vào thùng rác|Xóa|Xóa tệp|Xóa nội dung)$/i
          : /^(?:Rename|Đổi tên)$/i;
        const menuEl = [...document.querySelectorAll('[role="menuitem"]')].find(item => {
          if (!root.visible?.(item)) return false;
          const label = (root.accessibleName?.(item) || item.innerText || item.textContent || "").trim();
          return actionPatterns.test(label);
        });
        if (!menuEl) throw this.error("FLOW_MENU_ITEM_MISSING", `Flow did not show "${name === "flow.asset.trash" ? "Move to trash" : "Rename"}" for "${title}".`, true);
        menuEl.click(); await root.wait?.(250);
        if (name === "flow.asset.trash") return { trashed: title };
        const input = [...document.querySelectorAll('input:not([type="file"]),[contenteditable="true"]')].find(el => root.visible?.(el));
        if (!input) throw this.error("FLOW_RENAME_INPUT_MISSING", "Flow opened rename but no editable title field is visible.", false, true);
        const newName = String(payload.newName || "");
        if (!newName) throw this.error("FLOW_INVALID_ARGUMENT", "newName is required.");
        if (input.isContentEditable) input.textContent = newName;
        else { input.value = newName; input.dispatchEvent(new Event("input", { bubbles: true })); }
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
        await root.wait?.(400);
        return { renamed: title, name: newName };
      }

      return undefined;
    }
  }
  root.FlowLibraryOperations = FlowLibraryOperations;
})(globalThis);
